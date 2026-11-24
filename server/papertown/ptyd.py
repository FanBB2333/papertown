"""Papertown's own background terminals: one daemon holds a pseudo-terminal for each headless agent CLI.

Each CLI runs its real interactive interface in a pseudo-terminal. The daemon keeps that terminal's screen with a small
emulator (vt.py) and types into it the way a keyboard and a terminal would: text arrives as a bracketed paste when the
CLI has asked for one, keys as the bytes a terminal sends for them. Nothing reaches the CLI any other way.

The server talks to the daemon over a Unix socket, one JSON request and one JSON answer per connection. The daemon
runs in its own session, so agents keep running while the server restarts, and it leaves once it has held no
terminal for a while.

    python -m papertown.ptyd <socket> [--log FILE]
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import pty
import selectors
import signal
import socket
import struct
import sys
import termios
import time
from uuid import uuid4

from .vt import Screen

KEYS = {'enter': '\r', 'esc': '\x1b', 'ctrl+c': '\x03', 'tab': '\t', 'backspace': '\x7f', 'space': ' '}
ARROWS = {'up': 'A', 'down': 'B', 'right': 'C', 'left': 'D'}
PASTE_GAP = .1   # between a paste and its Enter, as a person would leave
KEY_GAP = .03    # between keys, so a CLI reads them one at a time
IDLE_EXIT = 600  # seconds without any terminal before the daemon leaves
MAX_REQUEST = 8 << 20


class Gone(Exception):
    pass


class Term:
    def __init__(self, spec: dict):
        self.id = uuid4().hex
        self.name = str(spec.get('name') or '')
        self.cols, self.rows = int(spec.get('cols') or 160), int(spec.get('rows') or 48)
        self.out = bytearray()
        self.screen = Screen(self.cols, self.rows, reply=lambda s: self.out.extend(s.encode()))
        self.timed: list[tuple[float, bytes]] = []
        self.started = self.output_at = time.time()
        self.bytes, self.code, self.alive, self.reading = 0, None, True, True
        argv, cwd = [str(a) for a in spec['argv']], str(spec.get('cwd') or os.path.expanduser('~'))
        env = {str(k): str(v) for k, v in (spec.get('env') or os.environ).items()}
        size = struct.pack('HHHH', self.rows, self.cols, 0, 0)
        pid, fd = pty.fork()
        if pid == 0:  # the child: a fresh session whose controlling terminal is the pseudo-terminal
            try:
                for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM, signal.SIGPIPE, signal.SIGCHLD, signal.SIGXFSZ):
                    signal.signal(sig, signal.SIG_DFL)
                fcntl.ioctl(0, termios.TIOCSWINSZ, size)
                os.closerange(3, 1 << 16)
                os.chdir(cwd)
                os.execvpe(argv[0], argv, env)
            except BaseException as e:  # noqa: BLE001 - the reason is shown on the terminal itself
                os.write(2, f'Papertown 无法启动 {argv[0]}：{e}\r\n'.encode())
            os._exit(127)
        self.pid, self.fd = pid, fd
        os.set_blocking(fd, False)

    def state(self) -> dict:
        return {'id': self.id, 'name': self.name, 'pid': self.pid, 'alive': self.alive, 'code': self.code,
                'started': self.started, 'output_at': self.output_at, 'bytes': self.bytes,
                'bracketed': 2004 in self.screen.modes, 'title': self.screen.title}

    def read(self) -> bool:
        """Take what the CLI wrote. False once nothing will come any more."""
        try:
            data = os.read(self.fd, 65536)
        except BlockingIOError:
            return True
        except OSError:  # EIO: every process holding the other side has closed it
            return False
        if not data:
            return False
        self.got(data)
        return True

    def got(self, data: bytes) -> None:
        self.bytes += len(data)
        self.output_at = time.time()
        self.screen.feed(data)

    def flush(self) -> None:
        now = time.monotonic()
        while self.timed and self.timed[0][0] <= now:
            self.out.extend(self.timed.pop(0)[1])
        while self.out and self.alive:
            try:
                n = os.write(self.fd, self.out)
            except BlockingIOError:
                return
            except OSError:
                self.out.clear()
                return
            del self.out[:n]

    def schedule(self, chunks: list[bytes], gap: float) -> None:
        start = max(time.monotonic(), self.timed[-1][0] + gap if self.timed else 0)
        self.timed.extend((start + i * gap, c) for i, c in enumerate(chunks))

    def paste(self, text: str, enter: bool) -> None:
        if not self.alive:
            raise Gone('终端会话已退出')
        body = text.replace('\r\n', '\n')  # line feeds stay line feeds, as with `tmux paste-buffer -r`
        data = ('\x1b[200~' + body.replace('\x1b[201~', '') + '\x1b[201~') if 2004 in self.screen.modes else body
        self.schedule([data.encode()] + ([b'\r'] if enter else []), PASTE_GAP)

    def keys(self, keys: list[str]) -> None:
        if not self.alive:
            raise Gone('终端会话已退出')
        app = 1 in self.screen.modes  # application cursor keys
        chunks = []
        for k in keys:
            if k in ARROWS:
                chunks.append((('\x1bO' if app else '\x1b[') + ARROWS[k]).encode())
            elif k in KEYS:
                chunks.append(KEYS[k].encode())
            elif len(k) == 1 and k.isprintable():
                chunks.append(k.encode())
            else:
                raise ValueError(f'不支持的按键：{k}')
        self.schedule(chunks, KEY_GAP)

    def poll(self) -> None:
        if not self.alive:
            return
        try:
            pid, status = os.waitpid(self.pid, os.WNOHANG)
        except ChildProcessError:
            pid, status = self.pid, 0
        if pid:
            for _ in range(64):  # what it wrote just before it ended; a process it left behind may still hold the terminal
                try:
                    data = os.read(self.fd, 65536) if self.reading else b''
                except OSError:
                    break
                if not data:
                    break
                self.got(data)
            self.alive, self.code = False, os.waitstatus_to_exitcode(status) if status else 0
            self.screen.feed(f'\r\n[进程已退出，退出码 {self.code}]\r\n'.encode())

    def signal(self, sig: int) -> None:
        kill(self.pid, sig)


def kill(pgid: int, sig: int) -> None:
    try:
        os.killpg(pgid, sig)
    except (ProcessLookupError, PermissionError):
        pass


class Daemon:
    def __init__(self, path: str):
        self.path = path
        self.terms: dict[str, Term] = {}
        self.sel = selectors.DefaultSelector()
        self.kills: list[tuple[float, int]] = []  # closed terminals' process groups, killed if still there by then
        self.stop = False
        self.idle = time.monotonic()

    def serve(self) -> int:
        lock = open(self.path + '.lock', 'w')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0  # another daemon already serves this socket
        try:
            os.unlink(self.path)
        except FileNotFoundError:
            pass
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(self.path)
        os.chmod(self.path, 0o600)
        server.listen(16)
        server.setblocking(False)
        self.sel.register(server, selectors.EVENT_READ, None)
        signal.signal(signal.SIGTERM, lambda *_: setattr(self, 'stop', True))
        for sig in (signal.SIGHUP, signal.SIGINT):
            signal.signal(sig, signal.SIG_IGN)
        try:
            while not self.stop:
                busy = any(t.out or t.timed for t in self.terms.values())
                for key, _ in self.sel.select(.02 if busy else .5):
                    if key.data is None:
                        self.accept(server)
                    elif not key.data.read():
                        key.data.reading = False
                        self.sel.unregister(key.fileobj)
                for t in list(self.terms.values()):
                    t.flush()
                    t.poll()
                    if not t.alive and t.reading:
                        t.reading = False
                        self.sel.unregister(t.fd)
                now = time.monotonic()
                for at, pid in list(self.kills):
                    try:
                        done = os.waitpid(pid, os.WNOHANG)[0]
                    except ChildProcessError:
                        done = pid
                    if done or at <= now:
                        if not done:
                            kill(pid, signal.SIGKILL)
                        self.kills.remove((at, pid))
                if self.terms:
                    self.idle = now
                elif now - self.idle > IDLE_EXIT and not self.kills:
                    break
        finally:
            for t in self.terms.values():
                t.signal(signal.SIGHUP)
            try:
                os.unlink(self.path)
            except FileNotFoundError:
                pass
            server.close()
        return 0

    def accept(self, server: socket.socket) -> None:
        try:
            conn, _ = server.accept()
        except BlockingIOError:
            return
        with conn:
            conn.settimeout(3)
            data = b''
            try:
                while not data.endswith(b'\n') and len(data) < MAX_REQUEST:
                    chunk = conn.recv(65536)
                    if not chunk:
                        break
                    data += chunk
                try:
                    answer = {'ok': True} | self.handle(json.loads(data))
                except Gone as e:
                    answer = {'ok': False, 'gone': True, 'message': str(e)}
                except Exception as e:  # noqa: BLE001 - every failure goes back to the caller as text
                    answer = {'ok': False, 'message': str(e) or type(e).__name__}
                conn.sendall(json.dumps(answer, ensure_ascii=False).encode() + b'\n')
            except OSError:
                pass

    def term(self, req: dict) -> Term:
        t = self.terms.get(str(req.get('id')))
        if not t:
            raise Gone('终端会话已退出')
        return t

    def handle(self, req: dict) -> dict:
        op = req.get('op')
        if op == 'ping':
            return {'pid': os.getpid(), 'terms': len(self.terms)}
        if op == 'open':
            t = Term(req)
            self.terms[t.id] = t
            self.sel.register(t.fd, selectors.EVENT_READ, t)
            return t.state()
        if op == 'list':
            return {'terms': [t.state() for t in self.terms.values()]}
        t = self.term(req)
        if op == 'state':
            return t.state()
        if op == 'screen':
            return t.state() | {'text': t.screen.text(history=bool(req.get('history')), colours=bool(req.get('colours')))}
        if op == 'paste':
            t.paste(str(req.get('text') or ''), bool(req.get('enter')))
            return {}
        if op == 'keys':
            t.keys([str(k) for k in req.get('keys') or []])
            return {}
        if op == 'close':
            # Like closing a terminal window: the CLI's process group hears a hangup, and anything left a moment later is killed.
            t.signal(signal.SIGHUP)
            if t.alive:
                self.kills.append((time.monotonic() + 3, t.pid))
            if t.reading:
                t.reading = False
                self.sel.unregister(t.fd)
            os.close(t.fd)
            t.alive = False
            del self.terms[t.id]
            return {}
        raise ValueError(f'没有这种操作：{op}')


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog='python -m papertown.ptyd')
    p.add_argument('socket')
    p.add_argument('--log')
    p.add_argument('--foreground', action='store_true')
    a = p.parse_args(argv)
    if not a.foreground and os.fork():
        os._exit(0)  # the launcher returns at once; the daemon is nobody's child to wait for
    os.umask(0o077)
    os.chdir('/')
    out = os.open(a.log or os.devnull, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    os.dup2(out, 1)
    os.dup2(out, 2)
    return Daemon(a.socket).serve()


if __name__ == '__main__':
    sys.exit(main())
