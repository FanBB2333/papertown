"""Terminal transports. They never start or shut down a terminal host."""
from __future__ import annotations

import hashlib
import json
import os
import shlex
import socket
import subprocess
import sys
import tempfile
import threading
import time
from abc import ABC, abstractmethod
from pathlib import Path
from uuid import uuid4

from .herdr import Herdr, HerdrError


# lines of scrollback a terminal's screen is read with
HISTORY = 1500

class BackendError(Exception):
    pass


def binary(name: str, explicit: str = "") -> str | None:
    """Resolve real executables, excluding terminal applications' CLI shims."""
    def usable(p: Path) -> bool:
        paths = (str(p).lower(), str(p.resolve()).lower())
        return (p.is_file() and os.access(p, os.X_OK)
                and not any('.app/' in s or 'cmux-cli-shims' in s for s in paths))
    if explicit:
        candidates = [Path(explicit).expanduser()] if '/' in explicit else [Path(d) / explicit for d in os.get_exec_path()]
    else:
        candidates = [Path(d) / name for d in os.get_exec_path()]
        candidates += [Path('/opt/homebrew/bin') / name, Path('/usr/local/bin') / name]
    return next((str(p.absolute()) for p in candidates if usable(p)), None)


class TerminalBackend(ABC):
    @abstractmethod
    def open(self, spec: dict) -> dict: ...
    @abstractmethod
    def alive(self, handle: dict) -> bool: ...
    @abstractmethod
    def screen(self, handle: dict, colours: bool = False) -> str:
        """The screen with the lines that scrolled off it; with `colours`, as ANSI text (see ansi.render)."""
    @abstractmethod
    def glance(self, handle: dict) -> str: ...
    @abstractmethod
    def submit(self, handle: dict, text: str) -> None: ...
    @abstractmethod
    def keys(self, handle: dict, keys: list[str]) -> None: ...
    def type(self, handle: dict, text: str, paste: bool = False) -> None:
        """Text as it is typed, with no Enter; `paste` puts it in as one paste. Only Papertown's own terminals take it."""
        raise BackendError('这个终端不接受直接输入')
    @abstractmethod
    def state(self, handle: dict) -> dict: ...
    @abstractmethod
    def close(self, handle: dict) -> None: ...


# tmux's names for the keys a terminal takes (terminals.KEYS); a single character is sent as itself
TMUX_KEYS = {'enter': 'Enter', 'esc': 'Escape', 'tab': 'Tab', 'shift+tab': 'BTab', 'space': 'Space', 'backspace': 'BSpace',
             'up': 'Up', 'down': 'Down', 'left': 'Left', 'right': 'Right', 'pageup': 'PPage', 'pagedown': 'NPage',
             'ctrl+c': 'C-c', 'ctrl+d': 'C-d', 'ctrl+o': 'C-o', 'ctrl+t': 'C-t'}


class TmuxBackend(TerminalBackend):
    def __init__(self, executable: str | None, socket: str, runner=None):
        self.executable, self.socket, self.runner = executable, socket, runner

    def call(self, *args: str, input: str | None = None, check=True):
        if not self.executable:
            raise BackendError('本机没有找到 tmux')
        # Agents supplies its existing private-server runner; standalone transports use an empty config.
        r = self.runner(*args, input=input) if self.runner else subprocess.run(
            [self.executable, '-L', self.socket, '-f', '/dev/null', *args],
            input=input, capture_output=True, text=True, timeout=10)
        if check and r.returncode:
            raise BackendError(f'tmux 操作失败：{r.stderr.strip()}')
        return r

    def open(self, spec):
        session = spec['session']
        exists = self.call('has-session', '-t', '=' + session, check=False).returncode == 0
        args = ['new-window', '-t', session + ':'] if exists else ['new-session', '-s', session, '-x', '160', '-y', '48']
        args += ['-d', '-n', spec['name'], '-P', '-F', '#{window_id} #{pane_id}', '-c', spec['cwd']]
        env = [arg for k, v in spec['env'].items() for arg in ('-e', f'{k}={v}')]
        args += env
        # Create an empty pane first, set remain-on-exit, then exec the CLI. Even an immediate failure stays visible.
        window, pane = self.call(*args, '/bin/sleep', '60').stdout.strip().split()
        handle = {'session': session, 'window': window, 'pane': pane, 'identity': uuid4().hex}
        try:
            self.call('set-option', '-p', '-t', pane, '@papertown_id', handle['identity'])
            self.call('set-window-option', '-t', window, 'remain-on-exit', 'on')
            # A respawn otherwise inherits the session's first employee, including its bridge identity.
            self.call('respawn-pane', '-k', '-t', pane, '-c', spec['cwd'], *env, *spec['argv'])
        except Exception:
            self.call('kill-window', '-t', window, check=False)
            raise
        return handle

    def identity(self, handle):
        r = self.call('display-message', '-p', '-t', handle['pane'],
                      '#{pane_dead} #{window_id} #{session_name} #{@papertown_id}', check=False)
        values = r.stdout.strip().split()
        expected = [handle['window'], handle['session'], handle['identity']]
        return values[0] if r.returncode == 0 and values[1:] == expected else None

    def alive(self, handle):
        return self.identity(handle) == '0'

    def screen(self, handle, colours=False):
        if self.identity(handle) is None:
            raise BackendError('终端会话已退出')
        # with the lines that scrolled off it: the conversation as the CLI drew it
        return self.call('capture-pane', '-p', '-J', *(['-e'] if colours else []), '-S', f'-{HISTORY}', '-t', handle['pane']).stdout

    def glance(self, handle):
        """The visible screen, for telling whether it still changes."""
        if self.identity(handle) is None:
            raise BackendError('终端会话已退出')
        return self.call('capture-pane', '-p', '-J', '-t', handle['pane']).stdout

    def submit(self, handle, text):
        if not self.alive(handle):
            raise BackendError('终端会话已退出')
        name = 'pt-' + uuid4().hex
        self.call('load-buffer', '-b', name, '-', input=text)
        try:
            self.call('paste-buffer', '-p', '-r', '-d', '-b', name, '-t', handle['pane'])
            self.call('send-keys', '-t', handle['pane'], 'Enter')
        finally:
            self.call('delete-buffer', '-b', name, check=False)

    def keys(self, handle, keys):
        if not self.alive(handle):
            raise BackendError('终端会话已退出')
        self.call('send-keys', '-t', handle['pane'], *[TMUX_KEYS.get(k, k) for k in keys])

    def type(self, handle, text, paste=False):
        if not self.alive(handle):
            raise BackendError('终端会话已退出')
        if not paste:
            self.call('send-keys', '-t', handle['pane'], '-l', '--', text)
            return
        name = 'pt-' + uuid4().hex
        self.call('load-buffer', '-b', name, '-', input=text)
        try:
            self.call('paste-buffer', '-p', '-r', '-d', '-b', name, '-t', handle['pane'])
        finally:
            self.call('delete-buffer', '-b', name, check=False)

    def state(self, handle):
        return {'status': None if self.alive(handle) else 'exited', 'seq': None, 'since': None}

    def close(self, handle):
        if self.identity(handle) is None:
            return
        r = self.call('kill-window', '-t', handle['window'], check=False)
        if r.returncode and self.alive(handle):
            raise BackendError(r.stderr.strip())

    def attach(self, handle):
        return shlex.join(['tmux', '-L', self.socket, 'attach', '-t', f"{handle['session']}:{handle['window']}"])


class HerdrBackend(TerminalBackend):
    def __init__(self, client: Herdr, ready_timeout=20):
        self.client, self.ready_timeout = client, ready_timeout
        self.workspaces: dict[str, str] = {}

    def open(self, spec):
        workspace = self.workspaces.get(spec['session'])
        common = {'cwd': spec['cwd'], 'env': spec['env'], 'focus': False}
        if not workspace:
            # A new workspace comes with a tab of its own. The project's first employee takes it, so closing the
            # project's last employee closes the workspace too and leaves no empty shell behind.
            r = self.client.call('workspace.create', common | {'label': spec['workspace']})
            workspace = r['workspace']['workspace_id']
            self.workspaces[spec['session']] = workspace
            self.client.call('tab.rename', {'tab_id': r['tab']['tab_id'], 'label': spec['name']})
        else:
            try:
                r = self.client.call('tab.create', common | {'workspace_id': workspace, 'label': spec['name']})
            except HerdrError as e:
                if e.code != 'workspace_not_found':
                    raise
                self.workspaces.pop(spec['session'], None)
                return self.open(spec)
        handle = {'workspace': workspace, 'tab': r['tab']['tab_id'], 'pane': r['root_pane']['pane_id'], 'session': spec['session']}
        try:
            end = time.monotonic() + self.ready_timeout
            while True:
                try:
                    started = self.client.call('agent.start', {'name': spec['name'], 'kind': spec['kind'], 'pane_id': handle['pane'],
                                                             'args': spec['argv'][1:], 'timeout_ms': 4000}, timeout=6)
                    handle['terminal'] = started['agent']['terminal_id']
                    break
                except HerdrError as e:
                    # A new tab's shell may still be loading its profile, and herdr starts agents only at a shell prompt.
                    if e.code in ('agent_pane_busy', 'agent_pane_unavailable') and time.monotonic() < end:
                        time.sleep(.3)
                        continue
                    if e.code not in ('timeout', 'agent_not_ready', 'agent_blocked'):
                        raise
                    break
            # Readiness is the watcher's job. Wait only until herdr names the terminal the agent runs in.
            while not handle.get('terminal') and time.monotonic() < end:
                try:
                    handle['terminal'] = self.client.get(handle['pane'])['terminal_id']
                except HerdrError as e:
                    if e.code != 'agent_not_found':
                        raise
                    time.sleep(.1)
        except Exception:
            self.close(handle)
            raise
        return handle

    def state(self, handle):
        try:
            a = self.client.get(handle['pane'])
        except HerdrError as e:
            if e.code in ('agent_not_found', 'pane_not_found'):
                return {'status': 'exited', 'seq': None, 'since': None}
            raise  # A host outage is not a process exit.
        if handle.get('terminal') and handle['terminal'] != a['terminal_id']:
            return {'status': 'exited', 'seq': None, 'since': None}
        return {'status': a['agent_status'], 'seq': a.get('completion_seq') or 0, 'since': None,
                'session': a.get('agent_session'), 'ready': a.get('interactive_ready'), 'terminal': a['terminal_id']}

    def alive(self, handle):
        return self.state(handle)['status'] != 'exited'

    def screen(self, handle, colours=False):
        return self.client.read(handle['pane'], colours=colours)

    def glance(self, handle):
        # Reading history makes herdr scroll an idle full-screen agent and restore it. The once-a-second
        # check reads only what is on screen, so the user's herdr view is left alone.
        read = self.client.call('agent.read', {'target': handle['pane'], 'source': 'visible'}).get('read')
        if not isinstance(read, dict) or not isinstance(read.get('text'), str):
            raise HerdrError('herdr 返回了无效数据')
        return read['text']

    def submit(self, handle, text):
        if not self.alive(handle):
            raise BackendError('终端会话已退出')
        self.client.prompt(handle['pane'], text)

    def keys(self, handle, keys):
        if not self.alive(handle):
            raise BackendError('终端会话已退出')
        self.client.keys(handle['pane'], keys)

    def close(self, handle):
        try:
            self.client.call('tab.close', {'tab_id': handle['tab']})
        except HerdrError as e:
            if e.code != 'tab_not_found':
                raise

    def attach(self, handle):
        return f"herdr · {handle['workspace']} / {handle['tab']}"


# What a background terminal leaves out of the server's environment: the multiplexer and terminal application the
# server itself was started from. A CLI that sees them would talk to that application instead of this terminal.
FOREIGN = ('TMUX', 'TERM_PROGRAM', 'TERM_SESSION_ID', 'ITERM_', 'KITTY_', 'WEZTERM_', 'ALACRITTY_', 'GHOSTTY_',
           'VTE_VERSION', 'CMUX_', 'HERDR_', 'WINDOWID', 'COLUMNS', 'LINES')


def ptyd_socket(data_dir: Path) -> Path:
    """The daemon's socket beside the data, or in the temporary folder when that path is too long for a socket."""
    path = Path(data_dir).absolute() / 'ptyd.sock'
    if len(str(path)) < 100:
        return path
    short = Path(tempfile.gettempdir()) / f'papertown-{os.getuid()}'
    short.mkdir(mode=0o700, exist_ok=True)
    return short / (hashlib.sha256(str(path).encode()).hexdigest()[:16] + '.sock')


class HeadlessBackend(TerminalBackend):
    """Terminals Papertown keeps itself in the background (ptyd.py): no tmux, no herdr, no window.

    The CLI runs its real interactive interface in a pseudo-terminal. Text goes in as a bracketed paste and an Enter,
    keys as the bytes a terminal sends, and the screen comes back as text, just as with the tmux backend."""

    def __init__(self, data_dir: Path, cols=160, rows=48):
        self.data_dir, self.cols, self.rows = Path(data_dir), cols, rows
        self.path = ptyd_socket(self.data_dir)
        self._spawn = threading.Lock()

    def _call(self, op, timeout=5, **kw):
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
                s.settimeout(timeout)
                s.connect(str(self.path))
                s.sendall(json.dumps({'op': op, **kw}).encode() + b'\n')
                data = b''
                while not data.endswith(b'\n'):
                    chunk = s.recv(1 << 16)
                    if not chunk:
                        break
                    data += chunk
        except (FileNotFoundError, ConnectionRefusedError) as e:
            raise Stopped('后台终端服务未运行') from e
        except (socket.timeout, OSError) as e:
            raise BackendError(f'后台终端服务无响应：{e}') from e
        try:
            r = json.loads(data)
        except ValueError:
            raise BackendError('后台终端服务返回了无效数据') from None
        if not r.get('ok'):
            raise (Stopped if r.get('gone') else BackendError)(r.get('message') or '后台终端操作失败')
        return r

    def ensure(self):
        """Start the daemon when it is not running. It outlives the server, so agents keep running across restarts."""
        with self._spawn:
            try:
                return self._call('ping')
            except Stopped:
                pass
            self.data_dir.mkdir(parents=True, exist_ok=True)
            subprocess.run([sys.executable, '-m', 'papertown.ptyd', str(self.path), '--log', str(self.data_dir / 'ptyd.log')],
                           start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, cwd='/', timeout=10, check=False)
            end = time.monotonic() + 5
            while True:
                try:
                    return self._call('ping')
                except Stopped:
                    if time.monotonic() > end:
                        raise BackendError(f"后台终端服务无法启动，详见 {self.data_dir / 'ptyd.log'}") from None
                    time.sleep(.05)

    def open(self, spec):
        self.ensure()
        env = {k: v for k, v in os.environ.items() if not k.startswith(FOREIGN)}
        env |= {'TERM': 'xterm-256color', 'COLORTERM': 'truecolor'} | spec['env']
        r = self._call('open', argv=spec['argv'], cwd=spec['cwd'], env=env, name=spec['name'], cols=self.cols, rows=self.rows)
        return {'id': r['id'], 'pid': r['pid'], 'session': spec['session'], 'name': spec['name']}

    def state(self, handle):
        try:
            r = self._call('state', id=handle['id'])
        except Stopped:  # the daemon or the terminal is gone, and the CLI with it
            return {'status': 'exited', 'seq': None, 'since': None}
        return {'status': None if r['alive'] else 'exited', 'seq': None, 'since': None}

    def alive(self, handle):
        return self.state(handle)['status'] != 'exited'

    def screen(self, handle, colours=False):
        return self._screen(handle, True, colours)

    def glance(self, handle):
        return self._screen(handle, False)

    def _screen(self, handle, history, colours=False):
        try:
            return self._call('screen', id=handle['id'], history=history, colours=colours)['text']
        except Stopped as e:
            raise BackendError('终端会话已退出') from e

    def submit(self, handle, text):
        try:
            self._call('paste', id=handle['id'], text=text, enter=True)
        except Stopped as e:
            raise BackendError('终端会话已退出') from e

    def keys(self, handle, keys):
        try:
            self._call('keys', id=handle['id'], keys=keys)
        except Stopped as e:
            raise BackendError('终端会话已退出') from e

    def type(self, handle, text, paste=False):
        # a few typed characters go in one by one, as keys; a paste, or anything a key cannot carry, as one paste
        try:
            if not paste and len(text) <= 64 and all(c.isprintable() for c in text):
                self._call('keys', id=handle['id'], keys=list(text))
            else:
                self._call('paste', id=handle['id'], text=text, enter=False)
        except Stopped as e:
            raise BackendError('终端会话已退出') from e

    def close(self, handle):
        try:
            self._call('close', id=handle['id'])
        except Stopped:
            pass

    def attach(self, handle):
        return None


class Stopped(BackendError):
    """The daemon is not running, or no longer holds the terminal."""
