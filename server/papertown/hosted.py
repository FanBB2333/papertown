"""Employee terminal lifecycle, local queue, and metadata-only CLI signals."""
from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import shlex
import threading
import time
from pathlib import Path
from uuid import uuid4

from .backends import BackendError, HeadlessBackend, HerdrBackend, TmuxBackend, binary
from .db import now, write_json
from .herdr import Herdr, HerdrError
from .terminals import KEYS
from . import ansi, prompts

RUNTIMES = ('herdr', 'tmux', 'headless')
IN_RUNTIMES = "runtime in ('herdr', 'tmux', 'headless')"


def native(a) -> bool:
    """Whether herdr's own status and turn count drive this employee. Without herdr's integration installed, herdr
    sees Antigravity work and stop but never counts a finished turn, so Antigravity follows its status line there too."""
    return a['runtime'] == 'herdr' and (a.get('term') or {}).get('provider') != 'antigravity'
PUBLIC = ('backend', 'provider', 'status', 'seq', 'seen_seq', 'since', 'tool', 'model', 'thinking', 'note')


class Hosted:
    def __init__(self, agents):
        self.a, self.town, self.db, self.s = agents, agents.town, agents.db, agents.s
        self.backends = {'tmux': TmuxBackend(agents.tmux, self.s.tmux_socket, agents._tmux),
                         'herdr': HerdrBackend(Herdr(self.s), self.s.terminal_startup),
                         'headless': HeadlessBackend(self.s.data_dir)}
        self.lock = agents._delivery_lock
        self._halt = threading.Event()
        self._thread = None
        self.interrupt_timeout = 10
        self._interrupting: set[str] = set()
        self._session_scan: dict[str, float] = {}
        self._prompts: dict[str, dict] = {}

    def error(self, text):
        from .agents import AgentError
        return AgentError(str(text))

    def require(self, id):
        a = self.a.get(id)
        if not a or a.get('runtime') not in RUNTIMES or not a.get('term'):
            raise self.error('这个员工没有终端')
        return a

    def clis(self):
        return {p: binary(n, getattr(self.s, n + '_bin')) for p, n in
                [('claude', 'claude'), ('codex', 'codex'), ('antigravity', 'agy')]}

    def available(self):
        try:
            self.backends['herdr'].client.agents()
            herdr = {'ok': True, 'note': ''}
        except HerdrError as e:
            herdr = {'ok': False, 'note': str(e)}
        st = self.a.paseo.status()
        return {'paseo': {k: st[k] for k in ('ok', 'note')}, 'herdr': herdr,
                'tmux': {'ok': bool(self.a.tmux), 'note': '' if self.a.tmux else '本机没有找到 tmux'},
                'headless': {'ok': hasattr(os, 'forkpty'), 'note': '' if hasattr(os, 'forkpty') else '本系统不支持伪终端'},
                'clis': self.clis()}

    def public(self, a):
        term = a.get('term') or {}
        return {k: term.get(k) for k in PUBLIC}

    def attach(self, a):
        handle = (a.get('term') or {}).get('handle')
        return self.backends[a['runtime']].attach(handle) if handle else None

    def save(self, a, term):
        if term == a.get('term'):
            return
        status = {'done': 'idle', 'blocked': 'working', 'exited': 'stopped'}.get(term['status'], term['status'])
        self.a._set(a['id'], term=term, status=status)

    @staticmethod
    def transition(term, status, reason=None):
        if term['status'] != status or term.get('reason') != reason:
            if status == 'done' and term['status'] != 'done':
                term['seq'] += 1
            term.update(status=status, since=now(), reason=reason)

    def argv(self, a, provider, executable, model, thinking, resume, quiet=False):
        """`quiet`: open the CLI on its session with no first message, to wait for the next one (after a change of model)."""
        home, pt = self.a.home(a), self.a.pt(a)
        prompt = None if quiet else (f'Papertown 重新接上了这个会话。工作说明和项目简报在 {home}/.papertown/intro.md，如有更新请重新阅读，然后继续之前的工作。'
                  if resume else f'请先完整阅读 {home}/.papertown/intro.md，其中是你在 Papertown 的工作说明和项目简报。读完后说说你打算怎么开始。')
        first = [prompt] if prompt else []
        argv = [executable]
        sid = resume
        if provider == 'claude':
            sid = resume or str(uuid4())
            argv += ['--resume' if resume else '--session-id', sid]
            hooks = {event: [{'hooks': [{'type': 'command', 'command': shlex.join([str(pt), 'hook', 'claude']), 'timeout': 2}]}]
                     for event in ('SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Notification', 'Stop')}
            config = home / '.papertown/claude-settings.json'
            write_json(config, {'hooks': hooks})
            argv += ['--settings', str(config), '--add-dir', str(home)]
            if model:
                argv += ['--model', model]
            if thinking in ('low', 'medium', 'high', 'xhigh', 'max'):
                argv += ['--effort', thinking]
            argv += first
        elif provider == 'codex':
            if resume:
                argv += ['resume', resume]
            if model:
                argv += ['-m', model]
            if thinking and thinking != 'off':
                argv += ['-c', 'model_reasoning_effort=' + json.dumps(thinking)]
            # pt writes its requests under the agent's home when the sandbox keeps it off the network, and a coder
            # works in its project's repository, so the home has to be writable too
            argv += ['--add-dir', str(home)]
            if self.s.codex_bypass_hook_trust:
                # no one is at the keyboard to answer Codex's review of new hooks, so it would wait there
                argv += ['--dangerously-bypass-hook-trust']
            argv += ['-c', 'notify=' + json.dumps([str(pt), 'hook', 'codex'])] + first
        else:
            if resume:
                argv += ['--conversation', resume]
            if model:
                argv += ['--model', model]
            argv += ['--add-dir', str(home), '--settings', json.dumps({'statusLine': {
                'type': 'command', 'command': shlex.join([str(pt), 'hook', 'agy']), 'stack_with_default': True}})] + (['-i', prompt] if prompt else [])
        return argv, sid

    def start(self, a, runtime, provider=None, model=None, thinking=None, quiet=False):
        """`quiet`: a resumed launch opens with no first message and waits for the next one (after a change of model).
        A launch that starts a new session always carries one: the instructions to read."""
        old = a.get('term') or {}
        if a.get('runtime') in RUNTIMES and old.get('status') != 'exited' and old.get('handle'):
            try:
                if self.backends[a['runtime']].alive(old['handle']):
                    if runtime != a['runtime']:
                        raise self.error('请先关闭当前终端后再切换后端')
                    return self.a.public(a)
            except (HerdrError, BackendError) as e:
                raise self.error(e) from e
        default = self.town.paseo_models.default(a['role'])
        provider = provider or old.get('provider') or default['provider']
        model = model if model is not None else old.get('model') or default['model']
        thinking = thinking if thinking is not None else old.get('thinking') or default['thinking']
        executable = self.clis().get(provider)
        if not executable:
            raise self.error('请选择本机已安装的 Claude Code、Codex 或 Antigravity')
        # Old processes must not report a late Stop into the next launch.
        a = a | {'token': secrets.token_urlsafe(18)}
        self.db.update('agents', {'id': a['id']}, token=a['token'])
        _, intro = self.a._paseo_intro(a)
        home = self.a.home(a)
        (home / '.papertown/hook-agy.json').unlink(missing_ok=True)
        (home / '.papertown/intro.md').write_text(intro, encoding='utf-8')
        resume = a.get('session_id') if provider == old.get('provider') else None
        quiet = bool(quiet and resume)
        argv, sid = self.argv(a, provider, executable, model, thinking, resume, quiet)
        line = self.db.one('select seq, title from lines where id = ?', a['line_id']) if a['line_id'] else None
        seq = str(line['seq']) if line else 'assistant'
        name = re.sub('[^a-z0-9_-]', '-', f"pt{seq}-{a.get('node_id') or a['role']}".lower())
        if len(name) > 32:
            name = name[:23] + '-' + hashlib.sha256(a['id'].encode()).hexdigest()[:8]
        kind = 'agy' if provider == 'antigravity' else provider
        bindir = home / '.papertown/bin'
        bindir.mkdir(exist_ok=True)
        link = bindir / kind
        if link.is_symlink():
            link.unlink()
        if not link.exists():
            link.symlink_to(executable)
        env = {'PAPERTOWN_URL': self.s.url, 'PAPERTOWN_AGENT': a['id'], 'PAPERTOWN_AGENT_TOKEN': a['token'],
               'PAPERTOWN_AGENT_ROLE': a['role'], 'PATH': str(bindir) + os.pathsep + os.environ.get('PATH', '')}
        term = {'backend': runtime, 'provider': provider, 'model': model, 'thinking': thinking, 'status': 'starting',
                'seq': old.get('seq', 0), 'seen_seq': old.get('seen_seq', 0), 'since': now(), 'started': time.time(),
                'screen_at': time.time(), 'generation': uuid4().hex, 'handle': None, 'quiet': quiet}
        self.a._set(a['id'], runtime=runtime, ext_id=None, term=term, session_id=sid, status='starting',
                    model='/'.join(x for x in (provider, model) if x))
        if sid:
            self.remember(a, provider, sid)
        try:
            if old.get('handle') and a.get('runtime') in RUNTIMES:
                self.backends[a['runtime']].close(old['handle'])
            handle = self.backends[runtime].open({'session': 'pt-' + seq, 'name': name, 'cwd': a['cwd'], 'kind': kind,
                'workspace': f"Papertown #{seq} {line['title']}" if line else 'Papertown', 'argv': argv, 'env': env})
        except (BackendError, HerdrError, OSError) as e:
            term.update(status='exited', note=str(e))
            self.save(self.a.get(a['id']), term)
            raise self.error(e) from e
        term['handle'] = handle
        self.save(self.a.get(a['id']), term)
        self.watch()
        return self.a.public(self.a.get(a['id']))

    def remember(self, a, provider, sid):
        if isinstance(sid, str) and sid and len(sid) <= 256:
            self.a._remember_session(a, {'provider': provider, 'session_id': sid})
            if a.get('session_id') != sid:
                self.a._publish(a['id'])

    def hook(self, id, provider, data):
        with self.lock:
            a = self.require(id)
            term = dict(a['term'])
            provider = 'antigravity' if provider == 'agy' else provider
            if provider != term['provider'] or data.get('agent_id') or term['status'] == 'exited':
                return
            sid = data.get('session_id') or data.get('thread-id') or data.get('conversation_id')
            self.remember(a, provider, sid)
            if native(a):
                self.a._publish(id)
                return
            event = data.get('hook_event_name') or data.get('type') or data.get('event')
            status = None
            # Every launch carries its first message, so a start ends in work, never in idle. Until then a still screen
            # means a dialog (refresh shows it as waiting on you), and readiness signals leave the start as it is.
            held = term['status'] == 'starting' or term['status'] == 'blocked' and term.get('reason') == 'startup'
            if provider == 'claude':
                if event in ('UserPromptSubmit', 'PreToolUse'):
                    status = 'working'
                elif event == 'PermissionRequest' or event == 'Notification' and data.get('notification_type') in ('permission_prompt', 'elicitation_dialog'):
                    status = 'blocked'
                elif event == 'Stop':
                    status = 'done'
            elif provider == 'codex' and event == 'agent-turn-complete':
                status = 'done'
            elif provider == 'antigravity':
                state = data.get('agent_state')
                if data.get('tool_confirmation_pending'):
                    status = 'blocked'
                elif state in ('working', 'tool_use'):
                    status = 'working'
                elif state == 'idle' and not held:
                    status = 'done' if term['status'] in ('working', 'blocked') else 'idle'
            if status:
                self.transition(term, status)
            if isinstance(data.get('tool_name'), str):
                term['tool'] = data['tool_name'][:160]
            self.save(a, term)
            self.release(id)

    def discover_codex(self, a):
        """Only the first metadata record is read, and ambiguous shared-cwd sessions wait for notify."""
        at = time.time()
        if a.get('session_id') or a['term']['provider'] != 'codex' or at - self._session_scan.get(a['id'], 0) < 5:
            return
        self._session_scan[a['id']] = at
        candidates = []
        from .usage_readers import stamp
        from datetime import datetime
        from .usage_logs import metadata
        root = Path(self.s.codex_home).expanduser() / 'sessions'
        # Rollouts are filed by local start date: look at the launch day and the day before, not the whole history.
        days = {datetime.fromtimestamp(a['term']['started'] - d).strftime('%Y/%m/%d') for d in (0, 86400)}
        for path in (p for day in sorted(days) for p in (root / day).glob('rollout-*.jsonl')):
            try:
                if path.is_symlink() or path.stat().st_mtime < a['term']['started'] - 1:
                    continue
                with path.open('rb') as stream:
                    row = metadata(stream.readline())
                payload = row.get('payload') or {}
                created = stamp(payload.get('timestamp') or row.get('timestamp'))
                sid = payload.get('id')
                if (row.get('type') == 'session_meta' and payload.get('cwd') == a['cwd'] and created
                        and a['term']['started'] - 1 <= created <= a['term']['started'] + self.s.terminal_startup
                        and sid and not self.db.val('select 1 from agent_sessions where session_id = ? and agent_id != ?', sid, a['id'])):
                    candidates.append(sid)
            except (OSError, ValueError, TypeError):
                continue
        siblings = self.db.val("select count(*) from agents where id != ? and cwd = ? and " + IN_RUNTIMES + " "
                               "and session_id is null and json_extract(term, '$.provider') = 'codex' "
                               "and json_extract(term, '$.status') != 'exited'", a['id'], a['cwd'])
        if len(set(candidates)) == 1 and not siblings:
            self.remember(a, 'codex', candidates[0])
            self.a._publish(a['id'])

    def refresh(self, id, release=True):
        a = self.require(id)
        if a['term']['status'] == 'exited' or not a['term'].get('handle'):
            return a
        backend, handle, generation = self.backends[a['runtime']], a['term']['handle'], a['term'].get('generation')
        self.discover_codex(a)
        # Read the terminal before taking the lock. herdr can take seconds to answer, and hooks reporting in meanwhile
        # wait on the lock: a status line call held past its 2-second limit is dropped.
        try:
            state = backend.state(handle)
            text = backend.glance(handle) if state['status'] != 'exited' else ''
            error = None
        except (HerdrError, BackendError, OSError) as e:
            state, text, error = None, '', str(e)
        with self.lock:
            a = self.require(id)
            term = dict(a['term'])
            # Closed or started again while the terminal was read: this reading belongs to the previous launch.
            if term['status'] == 'exited' or term.get('generation') != generation:
                return a
            try:
                if error:
                    raise BackendError(error)
                if state['status'] == 'exited':
                    self.transition(term, 'exited')
                else:
                    digest, at = hashlib.sha256(text.encode()).hexdigest(), time.time()
                    changed = digest != term.get('screen_hash')
                    if changed:
                        term.update(screen_hash=digest, screen_at=at)
                    if a['runtime'] == 'herdr':
                        session = state.get('session') or {}
                        if session.get('kind') == 'id':
                            self.remember(a, term['provider'], session.get('value'))
                        term['handle'] = term['handle'] | {'terminal': state.get('terminal')}
                    if native(a):
                        status = state['status']
                        if status == 'unknown' and state.get('ready'):
                            status = 'idle'
                        if status == 'working' and term.get('reason') == 'still' and not changed:
                            status = 'blocked'
                        old = term.get('native_seq', 0)
                        seq = max(old, state['seq'] or 0)
                        pending = term.get('pending_seq')
                        # Old idle snapshots after a send must not drain the next queued message.
                        if pending is not None and status in ('idle', 'done') and seq <= pending:
                            status = term['status']
                        else:
                            term.pop('pending_seq', None)
                        term['seq'] += max(0, seq - old)
                        term['native_seq'] = seq
                        # Every launch carries its first message, so idle before any turn has begun or ended means a dialog
                        # holds it: herdr reports Codex's hooks review as idle. The still-screen rule below shows it as waiting.
                        if (status in ('idle', 'done') and seq <= old and (term['status'] == 'starting'
                                or term['status'] == 'blocked' and term.get('reason') == 'startup')):
                            status = None
                        if status in ('working', 'blocked', 'idle', 'done'):
                            # Native completion_seq, not transitions, counts herdr turns.
                            count = term['seq']
                            self.transition(term, status, term.get('reason') if status == 'blocked' and term.get('reason') == 'still' and not changed else None)
                            term['seq'] = count
                    # A launch with its first message shows a timer or spinner at once, so a start that stays still is
                    # waiting on a dialog: trusting the folder, signing in, reviewing hooks. A quiet launch (a change of
                    # model) has no first message: a still screen there is the CLI ready for one, unless it shows a dialog.
                    if term['status'] == 'starting' and text.strip() and at - term['screen_at'] >= self.s.terminal_ready:
                        if term.get('quiet') and not prompts.parse(text):
                            self.transition(term, 'idle')
                        else:
                            self.transition(term, 'blocked', 'startup')
                    elif (term['status'] == 'working' and term.get('escaped_at') and at - term['escaped_at'] >= self.s.terminal_settle
                          and at - term['screen_at'] >= self.s.terminal_settle):
                        # Claude Code runs no Stop hook and Codex sends no notify for a turn cut short with Esc.
                        self.transition(term, 'idle')
                    elif term['status'] == 'working' and at - term['screen_at'] >= self.s.terminal_still:
                        self.transition(term, 'blocked', 'still')
                    elif term['status'] == 'blocked' and term.get('reason') in ('still', 'startup') and changed:
                        self.transition(term, 'starting' if term['reason'] == 'startup' else 'working')
                term.pop('note', None)
            except BackendError as e:
                term['note'] = str(e)
            prompt = prompts.parse(text) if term['status'] in ('blocked', 'starting') else None
            if prompt:
                self._prompts[id] = prompt
            else:
                self._prompts.pop(id, None)
            self.save(a, term)
        if release:
            self.release(id)
        return self.a.get(id)

    def screen(self, id, styled=False):
        """The terminal's screen with its scrollback; `styled` adds its colours (see ansi.render)."""
        a = self.refresh(id)
        try:
            text = self.backends[a['runtime']].screen(a['term']['handle'], colours=styled) if a['term'].get('handle') else ''
        except (HerdrError, BackendError) as e:
            if a['term']['status'] != 'exited':
                raise self.error(e) from e
            text = ''
        prompt = self._prompts.get(id) if a['term']['status'] in ('blocked', 'starting') else None
        return (ansi.render(text) if styled else {'text': text}) | {'term': self.public(a), 'prompt': prompt}

    def prompt(self, id, digest, option):
        with self.lock:
            a = self.require(id)
            backend, handle = self.backends[a['runtime']], a['term'].get('handle')
            live = bool(handle) and a['term']['status'] != 'exited'
        # like refresh, read the terminal outside the lock: herdr can take seconds, and hooks report in meanwhile
        try:
            keys = prompts.answer(prompts.parse(backend.glance(handle)) if live else None, digest, option)
            backend.keys(handle, keys)
        except (HerdrError, BackendError) as e:
            raise self.error(e) from e
        return {'ok': True}

    def keys(self, id, keys):
        if not keys or any(k not in KEYS for k in keys):
            raise self.error('不支持这个按键')
        with self.lock:
            a = self.require(id)
            if a['term']['status'] == 'exited':
                raise self.error('终端会话已退出')
            try:
                self.backends[a['runtime']].keys(a['term']['handle'], keys)
            except (HerdrError, BackendError) as e:
                raise self.error(e) from e

    def stop(self, id):
        self.keys(id, ['esc'])
        with self.lock:
            a = self.require(id)
            self.save(a, a['term'] | {'escaped_at': time.time()})
        return self.a.public(self.a.get(id))

    def interrupt(self, id):
        self.stop(id)
        end = time.monotonic() + self.interrupt_timeout
        while time.monotonic() < end:
            a = self.refresh(id, release=False)
            # Only an actual settled signal permits delivery, never the screen-still heuristic.
            if a['term']['status'] in ('idle', 'done'):
                return
            if self._halt.wait(.1):
                break
        raise self.error('终端里的 agent 尚未停止，消息未发送')

    def submit(self, a, text):
        term = dict(a['term'])
        if term['status'] == 'exited':
            raise self.error('终端会话已退出，请先启动')
        try:
            self.backends[a['runtime']].submit(term['handle'], text)
        except (HerdrError, BackendError) as e:
            raise self.error(e) from e
        if native(a):
            term['pending_seq'] = term.get('native_seq', 0)
        term.update(screen_at=time.time(), tool=None, escaped_at=None)
        self.transition(term, 'working')
        self.save(a, term)

    def say(self, id, text, mode=None, origin='web'):
        text = text.strip()
        if not text or mode not in (None, 'queue', 'steer', 'interrupt'):
            raise self.error('请输入消息并选择有效的发送方式')
        interrupted = False
        if mode == 'interrupt':
            with self.lock:
                if id in self._interrupting:
                    raise self.error('终端正在等待打断完成')
                self._interrupting.add(id)
            try:
                self.interrupt(id)
                interrupted = True
                with self.lock:
                    return self._say(id, text, mode, origin, interrupted)
            finally:
                with self.lock:
                    self._interrupting.discard(id)
        with self.lock:
            if id in self._interrupting:
                raise self.error('终端正在等待打断完成')
            return self._say(id, text, mode, origin, interrupted)

    def _say(self, id, text, mode, origin, interrupted):
        a = self.require(id)
        held = mode == 'queue'
        # A dialog holds the screen (a hook review, a menu): typed text and Enter would answer it, not reach the agent.
        if not held and not interrupted and a['term']['status'] == 'blocked':
            raise self.error('终端停在一个需要你处理的界面上，消息没有发送。请先在终端中处理')
        if not held:
            self.submit(a, text)
        event = self.a.record(id, 'user', {'text': text, 'origin': origin, 'held': held, 'queued': held,
            'delivered': not held, 'generation': a['term']['generation'],
            'steered': not held and not interrupted and a['term']['status'] == 'working', 'interrupted': interrupted})
        self.a._publish(id)
        if held:
            self.release(id)
        return event

    def release(self, id):
        with self.lock:
            a = self.require(id)
            if id in self._interrupting or a['term']['status'] not in ('idle', 'done'):
                return
            row = self.db.one("select * from agent_events where agent_id = ? and kind = 'user' and json_extract(data, '$.held') = 1 order by id limit 1", id)
            if row and not row['data'].get('error') and not row['data'].get('sending'):
                try:
                    self.queue_now(id, row['id'])
                except Exception as e:
                    self.a.amend(row['id'], row['data'] | {'error': str(e)})

    def queue_now(self, id, event_id):
        with self.lock:
            a, row = self.a._held(id, event_id)
            if row['data'].get('generation') != a['term']['generation']:
                raise self.error('目标会话已改变，消息未发送')
            if id in self._interrupting:
                raise self.error('终端正在等待打断完成')
            # Persist an uncertain delivery before transport I/O. A restart never resends it automatically.
            self.a.amend(event_id, row['data'] | {'sending': True})
            try:
                self.submit(a, row['data']['text'])
            except Exception as e:
                self.a.amend(event_id, row['data'] | {'sending': False, 'error': str(e)})
                raise
            event = self.a.amend(event_id, row['data'] | {'held': False, 'delivered': True, 'sending': False, 'error': None})
            self.a._publish(id)
            return event

    def queue_drop(self, id, event_id):
        with self.lock:
            _, row = self.a._held(id, event_id)
            event = self.a.amend(event_id, row['data'] | {'held': False, 'dropped': True})
            self.a._publish(id)
            return event

    def switch_model(self, id, model, thinking):
        """The same conversation on another model: the CLI is closed and resumed on its session with the new one. An
        empty model or thinking leaves the choice to the CLI."""
        a = self.require(id)
        t = a['term']
        if t['status'] in ('working', 'starting'):
            raise self.error('正在工作，先停下再换模型')
        if not a.get('session_id'):
            raise self.error('还没认出这个终端的会话，现在换模型会丢掉上下文，请稍后再试')
        if (t.get('model') or '', t.get('thinking') or '') == (model or '', thinking or ''):
            return self.a.public(a)
        if t['status'] != 'exited':
            self.close(id)
        return self.start(self.a.get(id), a['runtime'], t.get('provider'), model or '', thinking or '', quiet=True)

    def close(self, id):
        with self.lock:
            a = self.require(id)
            if a['term'].get('handle'):
                try:
                    self.backends[a['runtime']].close(a['term']['handle'])
                except (HerdrError, BackendError) as e:
                    raise self.error(e) from e
            term = dict(a['term'])
            self.transition(term, 'exited')
            self.save(a, term)
            return self.a.public(self.a.get(id))

    def seen(self, a):
        with self.lock:
            a = self.require(a['id'])
            self.save(a, a['term'] | {'seen_seq': a['term']['seq']})

    def watch_of(self, a):
        t = a['term'] or {}
        asks = self.db.q("select * from reports where agent_id = ? and kind = 'ask' and json_extract(data, '$.open') = 1 order by id", a['id'])
        queued = self.db.val("select count(*) from agent_events where agent_id = ? and kind = 'user' and json_extract(data, '$.held') = 1", a['id'])
        unread = t.get('seq', 0) > t.get('seen_seq', 0)
        bucket, why = 'idle', None
        if t.get('status') == 'exited':
            bucket, unread = 'off', False
        elif t.get('status') == 'blocked':
            bucket, why = 'needs', 'terminal'
        elif asks:
            bucket, why = 'needs', 'ask'
        elif unread:
            bucket, why = 'review', 'finished'
        elif t.get('status') in ('starting', 'working'):
            bucket = 'working'
        doing = {'kind': 'tool', 'text': t['tool']} if t.get('tool') else None
        if t.get('status') == 'blocked' and (prompt := self._prompts.get(a['id'])):
            doing = {'kind': 'prompt', 'text': prompt['title'][:120]}
        if why == 'ask':
            doing = {'kind': 'ask', 'text': asks[0]['data']['question'][:200]}
        prompt = self._prompts.get(a['id']) if t.get('status') in ('blocked', 'starting') else None
        return {'bucket': bucket, 'why': why, 'since': t.get('since'), 'turn': t.get('since') if bucket == 'working' else None,
                'doing': doing, 'queued': queued, 'unread': unread, 'permissions': [], 'asks': asks, 'prompt': prompt}

    def reconcile(self):
        for a in self.db.q("select * from agents where " + IN_RUNTIMES):
            h = (a.get('term') or {}).get('handle')
            if a['runtime'] == 'herdr' and h:
                self.backends['herdr'].workspaces[h['session']] = h['workspace']
            self.refresh(a['id'])
        if self.db.val("select 1 from agents where " + IN_RUNTIMES):
            self.watch()

    def watch(self):
        if self._thread:
            return
        self._halt.clear()
        self._thread = threading.Thread(target=self._run, name='hosted-watch', daemon=True)
        self._thread.start()

    def _run(self):
        while not self._halt.wait(1):
            for a in self.db.q("select id from agents where " + IN_RUNTIMES):
                try:
                    self.refresh(a['id'])
                except Exception as e:
                    self.town.trace('TERMINAL', '终端同步失败', str(e))

    def shutdown(self):
        self._halt.set()
        if self._thread:
            self._thread.join(timeout=3)
        self._thread = None
