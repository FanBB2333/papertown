"""Terminal transports. They never start or shut down a terminal host."""
from __future__ import annotations

import os
import shlex
import subprocess
import time
from abc import ABC, abstractmethod
from pathlib import Path
from uuid import uuid4

from .herdr import Herdr, HerdrError


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
    def screen(self, handle: dict) -> str: ...
    @abstractmethod
    def glance(self, handle: dict) -> str: ...
    @abstractmethod
    def submit(self, handle: dict, text: str) -> None: ...
    @abstractmethod
    def keys(self, handle: dict, keys: list[str]) -> None: ...
    @abstractmethod
    def state(self, handle: dict) -> dict: ...
    @abstractmethod
    def close(self, handle: dict) -> None: ...


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

    def screen(self, handle):
        if self.identity(handle) is None:
            raise BackendError('终端会话已退出')
        return self.call('capture-pane', '-p', '-J', '-t', handle['pane']).stdout

    def glance(self, handle):
        """The visible screen, for telling whether it still changes."""
        return self.screen(handle)

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
        mapping = {'enter': 'Enter', 'esc': 'Escape', 'up': 'Up', 'down': 'Down', 'ctrl+c': 'C-c'}
        self.call('send-keys', '-t', handle['pane'], *[mapping.get(k, k) for k in keys])

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

    def screen(self, handle):
        return self.client.read(handle['pane'])

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
