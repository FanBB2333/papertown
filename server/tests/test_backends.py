"""Hosted employees: real isolated tmux + fake CLI, and protocol-22 FakeHerdr."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from papertown.agents import AgentError, PT
from papertown.paseo_models import PASEO_OFF, ModelError
from papertown.api import create_app
from papertown.backends import binary
from papertown.hosted import Hosted
from papertown.town import Town
from .conftest import make_settings
from .test_terminals import FakeHerdr, eventually


def employee(town, role='coder', node=None):
    # Small project fixture: no pipeline threads or external research.
    lid = 'line-hosted'
    if not town.db.one('select id from lines where id = ?', lid):
        town.db.insert('lines', {'id': lid, 'seq': 91, 'title': 'Hosted test', 'status': 'active', 'stage': 'idea',
                                 'created_at': '2026-11-22T00:00:00Z', 'updated_at': '2026-11-22T00:00:00Z'})
    a = town.agents.ensure(lid, role, node)
    # Reuse guide/tool generation, keep the project's brief offline and deterministic.
    town.brief = lambda *args: 'Offline project brief'
    return a


@pytest.fixture(params=['tmux', 'headless'])
def tmux(tmp_path, request):
    """An isolated terminal host with the fake CLI: a private tmux server, or Papertown's own background terminals."""
    executable = shutil.which('tmux')
    if not executable and request.param == 'tmux':
        pytest.skip('tmux is not installed')
    fake = tmp_path / 'claude'
    fake.write_text('#!' + sys.executable + '\n' + Path(__file__).with_name('fake_terminal_cli.py').read_text().split('\n', 1)[1])
    fake.chmod(0o755)
    town = Town(make_settings(tmp_path, tmux_bin=executable, tmux_socket="pt-test-" + __import__("uuid").uuid4().hex[:12], claude_bin=str(fake),
                              terminal_still=.5, terminal_startup=2, terminal_ready=.15))
    hosted = town.agents.hosted
    hosted.watch = lambda: None  # Tests advance reconciliation explicitly.
    bodies = []
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            bodies.append(body)
            aid = self.path.split('/')[-2]
            town.agents.check(aid, self.headers.get('x-papertown-token'))
            hosted.hook(aid, body['provider'], body['data'])
            self.send_response(200); self.end_headers(); self.wfile.write(b'{}')
        def log_message(self, *args):
            pass
    http = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=http.serve_forever, daemon=True); thread.start()
    town.s.url = 'http://127.0.0.1:' + str(http.server_port)
    hosted.rt = request.param
    try:
        yield town, hosted, bodies
    finally:
        # This socket belongs only to this test. Never run an unqualified tmux command.
        if executable:
            subprocess.run([executable, '-L', town.s.tmux_socket, 'kill-server'], capture_output=True)
        stop_ptyd(hosted)
        http.shutdown(); http.server_close(); thread.join(2)
        town.agents.shutdown()


def stop_ptyd(hosted):
    """End this test's own background terminal daemon, if it started one."""
    from papertown.backends import Stopped
    try:
        pid = hosted.backends['headless']._call('ping')['pid']
    except Stopped:
        return
    os.kill(pid, 15)
    eventually(lambda: not hosted.backends['headless'].path.exists())


def status(h, aid):
    return h.refresh(aid)['term']['status']


def test_tmux_lifecycle_queue_hooks_resume(tmux):
    t, h, bodies = tmux
    a = employee(t); aid = a['id']
    started = t.agents.start(aid, h.rt, 'claude', 'fake-model', 'high')
    eventually(lambda: status(h, aid) in ('idle', 'done'))
    home = t.agents.home(a)
    argv = json.loads((home / '.papertown/argv.json').read_text())
    assert argv[argv.index('--model') + 1] == 'fake-model'
    assert argv[argv.index('--effort') + 1] == 'high'
    assert '\n' not in argv[-1] and 'intro.md' in argv[-1]
    assert 'Offline project brief' in (home / '.papertown/intro.md').read_text()
    assert (home / 'CLAUDE.md').exists()
    hooks = json.loads((home / '.papertown/claude-settings.json').read_text())['hooks']
    assert set(hooks) == {'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Notification', 'Stop'}
    sid = t.agents.get(aid)['session_id']
    assert t.db.one('select * from agent_sessions where session_id = ?', sid)['agent_id'] == aid
    assert t.s.tmux_socket in started['attach'] if h.rt == 'tmux' else started['attach'] is None
    assert 'handle' not in started['term'] and 'token' not in json.dumps(started['term'])
    t.agents.say(aid, 'hello\nworld')
    eventually(lambda: '⏺ reply hello|world' in h.screen(aid)['text'])
    assert status(h, aid) == 'done'
    assert t.agents.public(t.agents.get(aid))['watch']['bucket'] == 'review'
    assert t.agents.seen(aid)['watch']['bucket'] == 'idle'
    t.agents.say(aid, 'work')
    eventually(lambda: any(x['data'].get('hook_event_name') == 'PreToolUse' for x in bodies))
    q1 = t.agents.say(aid, 'queued-one', 'queue')
    q2 = t.agents.say(aid, 'queued-two', 'queue')
    assert t.agents.public(t.agents.get(aid))['watch']['queued'] == 2
    eventually(lambda: '⏺ reply queued-two' in h.screen(aid)['text'], 6)
    text = h.screen(aid)['text']
    assert text.index('⏺ reply queued-one') < text.index('⏺ reply queued-two')
    assert not t.db.one('select * from agent_events where id = ?', q1['id'])['data']['held']
    assert not t.db.one('select * from agent_events where id = ?', q2['id'])['data']['held']
    assert all('prompt' not in x['data'] and 'tool_input' not in x['data'] for x in bodies)
    t.agents.say(aid, 'work'); eventually(lambda: status(h, aid) == 'working')
    ev = t.agents.say(aid, 'interrupt-reply', 'interrupt')
    assert ev['data']['interrupted']
    eventually(lambda: '⏺ reply interrupt-reply' in h.screen(aid)['text'])
    h.close(aid)
    assert t.agents.public(t.agents.get(aid))['watch']['bucket'] == 'off'
    t.agents.start(aid)
    eventually(lambda: status(h, aid) in ('idle', 'done'))
    argv = json.loads((home / '.papertown/argv.json').read_text())
    assert argv[argv.index('--resume') + 1] == sid
    # Server restart finds the same live pane; shutdown never closes it.
    h2 = Hosted(t.agents); h2.watch = lambda: None
    h2.reconcile()
    assert status(h2, aid) in ('idle', 'done')
    t.agents.say(aid, 'exit')
    eventually(lambda: status(h, aid) == 'exited')


def test_tmux_still_dialog_stop_and_queue_actions(tmux):
    t, h, _ = tmux
    aid = employee(t)['id']
    t.agents.start(aid, h.rt, 'claude')
    eventually(lambda: status(h, aid) in ('idle', 'done'))
    t.agents.say(aid, 'dialog')
    eventually(lambda: status(h, aid) == 'blocked')
    watch = t.agents.public(t.agents.get(aid))['watch']
    assert (watch['bucket'], watch['why']) == ('needs', 'terminal')
    # typed text and Enter would answer the dialog: a message waits for it to be dealt with
    with pytest.raises(AgentError):
        t.agents.say(aid, 'typed into the dialog')
    q = t.agents.say(aid, 'drop', 'queue')
    t.agents.queue_drop(aid, q['id'])
    assert not t.agents.public(t.agents.get(aid))['watch']['queued']
    t.agents.stop(aid)
    eventually(lambda: status(h, aid) == 'done')
    t.agents.say(aid, 'work')
    # Timer ticks prevent a false still-screen block.
    end = time.monotonic() + .8
    while time.monotonic() < end:
        assert status(h, aid) == 'working'
        time.sleep(.08)
    q = t.agents.say(aid, 'now', 'queue')
    t.agents.queue_now(aid, q['id'])
    eventually(lambda: '⏺ reply now' in h.screen(aid)['text'])
    with pytest.raises(AgentError):
        h.keys(aid, ['C-z'])
    h.keys(aid, ['tab', 'left', 'right', 'space', 'backspace'])


def test_tmux_interrupt_timeout_does_not_send(tmux):
    t, h, _ = tmux
    aid = employee(t)['id']; t.agents.start(aid, h.rt, 'claude')
    eventually(lambda: status(h, aid) in ('idle', 'done'))
    t.agents.say(aid, 'ignore')
    eventually(lambda: 'working timer' in h.screen(aid)['text'])
    h.interrupt_timeout = .25
    with pytest.raises(AgentError, match='消息未发送'):
        t.agents.say(aid, 'must-not-send', 'interrupt')
    assert 'must-not-send' not in h.screen(aid)['text']


@pytest.fixture
def herdr(tmp_path):
    with tempfile.TemporaryDirectory(prefix='pt-herdr-', dir='/private/tmp') as folder:
        host = FakeHerdr(Path(folder) / 'fake.sock')
        app = create_app(make_settings(tmp_path, herdr_socket=str(host.server_address), claude_bin=sys.executable))
        t = app.state.town; t.agents.hosted.watch = lambda: None
        with TestClient(app) as client:
            yield t, t.agents.hosted, host, client
        host.close()


def test_herdr_protocol_queue_exclusion_and_hook(herdr):
    t, h, host, c = herdr
    a = employee(t); aid = a['id']; url = '/api/agents/' + aid
    assert c.post(url + '/start', json={'runtime': 'herdr', 'provider': 'claude'}).status_code == 200
    a = h.refresh(aid); handle = a['term']['handle']; ident = handle['terminal']
    assert host.calls[-1][0] in ('agent.read', 'agent.get')
    start = next(p for m, p in host.calls if m == 'agent.start')
    assert start['pane_id'] == handle['pane'] and '\n' not in start['args'][-1]
    assert len(start['name']) <= 32
    t.terminals.refresh()
    groups, others = t.terminals.grouped(t.db.q('select * from lines'), t.db.q('select * from agents'))
    assert all(x['pane_id'] != handle['pane'] for x in others + [x for g in groups.values() for x in g])
    host.emit(id=ident, agent_status='working')
    h.refresh(aid)
    q1 = t.agents.say(aid, 'one', 'queue'); t.agents.say(aid, 'two', 'queue')
    host.emit(id=ident, agent_status='done', completion_seq=1)
    h.refresh(aid); h.refresh(aid)
    assert [p['text'] for m, p in host.calls if m == 'agent.prompt'] == ['one']
    host.emit(id=ident, agent_status='working'); h.refresh(aid)
    host.emit(id=ident, agent_status='done', completion_seq=2); h.refresh(aid)
    assert [p['text'] for m, p in host.calls if m == 'agent.prompt'] == ['one', 'two']
    assert not t.db.one('select * from agent_events where id = ?', q1['id'])['data']['held']
    token = {'x-papertown-token': a['token']}
    assert c.post(url + '/hook', json={'provider': 'claude', 'data': {}}, headers={'x-papertown-token': 'wrong'}).status_code == 403
    assert c.post(url + '/hook', json={'provider': 'claude', 'data': {'session_id': 'herdr-sid', 'hook_event_name': 'Stop'}}, headers=token).status_code == 200
    assert t.agents.get(aid)['term']['status'] == 'working'  # hooks only attribute herdr sessions
    assert t.db.one('select * from agent_sessions where session_id = ?', 'herdr-sid')
    assert c.post(url + '/keys', json={'keys': ['esc']}).status_code == 200
    assert c.post(url + '/keys', json={'keys': ['bad']}).status_code == 400
    assert c.get(url + '/screen').status_code == 200
    assert c.post(url + '/close').json()['term']['status'] == 'exited'
    # Workspace is reused for another employee.
    b = employee(t, node='task-2'); t.agents.start(b['id'], 'herdr', 'claude')
    assert len([1 for m, _ in host.calls if m == 'workspace.create']) == 1


def test_cli_args_hook_whitelist_and_defaults(tmp_path):
    t = Town(make_settings(tmp_path)); h = t.agents.hosted; a = employee(t)
    t.agents._tools(a)
    for provider in ('claude', 'codex', 'antigravity'):
        argv, sid = h.argv(a, provider, '/fake/' + provider, 'model', 'high', 'session-123')
        assert 'session-123' in argv and all('\n' not in x for x in argv)
        # the only thing let past is Codex's review of hooks: approvals and the sandbox stay as configured
        assert not any(('bypass' in x or 'trust' in x) and x != '--dangerously-bypass-hook-trust' for x in argv)
        assert ('--dangerously-bypass-hook-trust' in argv) == (provider == 'codex')
        if provider == 'codex':
            assert argv[argv.index('--add-dir') + 1] == str(t.agents.home(a))
            assert json.loads(next(x.removeprefix('notify=') for x in argv if x.startswith('notify='))) == [str(t.agents.pt(a)), 'hook', 'codex']
        if provider == 'antigravity':
            assert json.loads(argv[argv.index('--settings') + 1])['statusLine']['stack_with_default']
    t.s.codex_bypass_hook_trust = False
    assert '--dangerously-bypass-hook-trust' not in h.argv(a, 'codex', '/fake/codex', 'model', 'high', None)[0]
    spec = importlib.util.spec_from_file_location('pt_hook_test', PT); pt = importlib.util.module_from_spec(spec); spec.loader.exec_module(pt)
    payload = {'type': 'agent-turn-complete', 'thread-id': 'id', 'prompt': 'secret', 'last-assistant-message': 'secret',
               'tool_input': {'x': 'secret'}, 'tool_name': {'nested': 'secret'}}
    requests = []
    class Response:
        def __enter__(self): return self
        def __exit__(self, *args): pass
    def opened(req, timeout):
        requests.append(json.loads(req.data)); assert timeout == 2; return Response()
    with patch.object(pt, 'link', return_value=('http://local', a['id'], 'token')), patch.object(pt, 'OPEN', opened):
        pt.hook('codex', [json.dumps(payload)])
    assert requests == [{'provider': 'codex', 'data': {'type': 'agent-turn-complete', 'thread-id': 'id'}}]
    t.paseo_models.set_runtime('tmux')
    assert t.paseo_models.runtime() == 'tmux'
    with pytest.raises(Exception): t.paseo_models.set_runtime('invalid')


def test_binary_skips_wrappers(tmp_path, monkeypatch):
    shim = tmp_path / 'cmux.app/Contents/bin'; shim.mkdir(parents=True)
    real = tmp_path / 'real'; real.mkdir()
    for folder in (shim, real):
        f = folder / 'agy'; f.write_text('#!/bin/sh\nexit 0\n'); f.chmod(0o755)
    monkeypatch.setenv('PATH', str(shim) + os.pathsep + str(real))
    assert binary('agy') == str(real / 'agy')
    assert binary('agy', str(shim / 'agy')) is None


class MemoryTerminal:
    def __init__(self):
        self.text, self.live, self.sent, self.closed = 'ready', True, [], False
    def state(self, handle): return {'status': None if self.live else 'exited', 'seq': None, 'since': None}
    def screen(self, handle, colours=False): return self.text
    def glance(self, handle): return self.text
    def submit(self, handle, text): self.sent.append(text)
    def keys(self, handle, keys): pass
    def close(self, handle): self.live = False; self.closed = True
    def attach(self, handle): return 'isolated'


def memory_employee(tmp_path, provider='claude'):
    t = Town(make_settings(tmp_path, terminal_still=.1, terminal_startup=.2, terminal_ready=.05, terminal_settle=.05))
    h = t.agents.hosted; h.watch = lambda: None
    a = employee(t)
    backend = MemoryTerminal(); h.backends['tmux'] = backend
    t.agents._set(a['id'], runtime='tmux', term={'backend': 'tmux', 'provider': provider, 'handle': {'test': True},
        'generation': 'gen1', 'status': 'starting', 'seq': 0, 'seen_seq': 0, 'since': '2026-11-22T00:00:00Z',
        'started': time.time() - 1, 'screen_at': time.time() - 1})
    return t, h, backend, a['id']


def test_state_machine_signals_startup_and_read_receipts(tmp_path):
    t, h, b, aid = memory_employee(tmp_path)
    # A start whose screen stays still is held by a dialog.
    assert status(h, aid) == 'starting'; time.sleep(.06)
    assert status(h, aid) == 'blocked'
    assert t.agents.public(t.agents.get(aid))['watch']['why'] == 'terminal'
    h.hook(aid, 'claude', {'hook_event_name': 'SessionStart', 'session_id': 'main'})
    # Readiness leaves a start as it is: the first message on the command line is the first turn.
    assert t.agents.get(aid)['session_id'] == 'main' and status(h, aid) == 'blocked'
    h.hook(aid, 'claude', {'hook_event_name': 'Stop', 'agent_id': 'child', 'session_id': 'child'})
    assert t.agents.get(aid)['session_id'] == 'main' and status(h, aid) == 'blocked'
    for event in ('UserPromptSubmit', 'PreToolUse'):
        h.hook(aid, 'claude', {'hook_event_name': event, 'tool_name': 'Read'})
        assert t.agents.get(aid)['term']['status'] == 'working'
    for data in ({'hook_event_name': 'PermissionRequest'},
                 {'hook_event_name': 'Notification', 'notification_type': 'permission_prompt'},
                 {'hook_event_name': 'Notification', 'notification_type': 'elicitation_dialog'}):
        h.hook(aid, 'claude', data)
        assert t.agents.get(aid)['term']['status'] == 'blocked'
    h.hook(aid, 'claude', {'hook_event_name': 'Stop'})
    h.hook(aid, 'claude', {'hook_event_name': 'Stop'})
    assert t.agents.get(aid)['term']['seq'] == 1
    assert t.agents.public(t.agents.get(aid))['watch']['bucket'] == 'review'
    assert t.agents.seen(aid)['term']['seen_seq'] == 1
    t.agents.say(aid, 'working')
    term = t.agents.get(aid)['term']; term['screen_at'] = time.time() - 1
    t.db.update('agents', {'id': aid}, term=term)
    assert status(h, aid) == 'blocked'
    b.text = 'timer moved'
    assert status(h, aid) == 'working'
    assert t.agents.public(t.agents.get(aid))['watch']['doing'] is None
    b.live = False
    assert status(h, aid) == 'exited'
    assert t.agents.public(t.agents.get(aid))['watch']['bucket'] == 'off'


def test_a_turn_cut_short_with_esc_settles_on_a_still_screen(tmp_path):
    # Claude Code runs no Stop hook and Codex sends no notify for an interrupted turn.
    t, h, b, aid = memory_employee(tmp_path, 'codex')
    t.agents.say(aid, 'long task')
    assert status(h, aid) == 'working'
    h.stop(aid)
    b.text = 'Conversation interrupted'
    assert status(h, aid) == 'working'
    time.sleep(.08)
    assert status(h, aid) == 'idle' and t.agents.get(aid)['term'].get('seq') == 0
    t.agents.say(aid, 'next')
    assert t.agents.get(aid)['term'].get('escaped_at') is None and status(h, aid) == 'working'


def test_codex_ready_notify_and_metadata_fallback(tmp_path):
    t, h, b, aid = memory_employee(tmp_path, 'codex')
    term = t.agents.get(aid)['term']; term['started'] = time.time()
    t.db.update('agents', {'id': aid}, term=term)
    h.refresh(aid); time.sleep(.06)
    # Every launch carries its first message: a start whose screen stays still is waiting on a dialog.
    assert status(h, aid) == 'blocked' and t.agents.get(aid)['term']['reason'] == 'startup'
    from datetime import datetime, timezone
    root = Path(t.s.codex_home) / 'sessions' / datetime.fromtimestamp(term['started']).strftime('%Y/%m/%d'); root.mkdir(parents=True)
    timestamp = datetime.fromtimestamp(term['started'], timezone.utc).isoformat()
    (root / 'rollout-session.jsonl').write_text(json.dumps({'type': 'session_meta', 'timestamp': timestamp,
        'payload': {'id': 'from-log', 'cwd': t.agents.get(aid)['cwd']}}) + '\n' + 'SECRET CONVERSATION')
    h._session_scan.clear(); h.refresh(aid)
    assert t.db.one('select * from agent_sessions where session_id = ?', 'from-log')['provider'] == 'codex'
    # a message waits until the screen moves on from what held the start
    with pytest.raises(AgentError):
        t.agents.say(aid, 'test')
    b.text = 'codex ready'; h.refresh(aid)
    t.agents.say(aid, 'test')
    h.hook(aid, 'codex', {'type': 'agent-turn-complete', 'thread-id': 'from-notify'})
    assert t.agents.get(aid)['term']['seq'] == 1
    assert t.db.one('select * from agent_sessions where session_id = ?', 'from-notify')['agent_id'] == aid


def test_agy_status_dedup_and_session_attribution(tmp_path, capsys):
    t, h, b, aid = memory_employee(tmp_path, 'antigravity')
    # Idle while starting leaves the start as it is (a trust dialog reports idle), the first turn then shows as work.
    for state, pending, expected in [('idle', False, 'starting'), ('working', False, 'working'),
                                     ('tool_use', False, 'working'), ('idle', True, 'blocked'), ('idle', False, 'done')]:
        h.hook(aid, 'agy', {'agent_state': state, 'tool_confirmation_pending': pending, 'conversation_id': 'agy-session'})
        assert t.agents.get(aid)['term']['status'] == expected
    assert t.db.one('select * from agent_sessions where session_id = ?', 'agy-session')['provider'] == 'antigravity'
    spec = importlib.util.spec_from_file_location('pt_agy_test', PT); pt = importlib.util.module_from_spec(spec); spec.loader.exec_module(pt)
    from io import StringIO
    requests = []
    class Response:
        def __enter__(self): return self
        def __exit__(self, *args): pass
    def opened(req, timeout): requests.append(json.loads(req.data)); return Response()
    with patch.object(pt, 'HERE', str(tmp_path)), patch.object(pt, 'link', return_value=('http://local', aid, 'token')), patch.object(pt, 'OPEN', opened):
        for state in ('working', 'working', 'idle'):
            with patch.object(pt.sys, 'stdin', StringIO(json.dumps({'agent_state': state, 'reply': 'secret'}))):
                pt.hook('agy', [])
    assert len(requests) == 2 and 'secret' not in json.dumps(requests)
    assert capsys.readouterr().out == 'Papertown\nPapertown\nPapertown\n'
    with patch.object(pt.sys, 'stdin', StringIO('invalid')):
        pt.main(['hook', 'claude'])


def test_asks_queue_generation_and_retire(tmp_path):
    t, h, b, aid = memory_employee(tmp_path)
    h.hook(aid, 'claude', {'hook_event_name': 'UserPromptSubmit'})
    q = t.agents.say(aid, 'queued', 'queue')
    assert t.agents.public(t.agents.get(aid))['watch']['queued'] == 1
    t.db.insert('reports', {'agent_id': aid, 'line_id': 'line-hosted', 'kind': 'ask', 'ts': '2026-11-22', 'data': {'open': True, 'question': 'Which?'}})
    assert t.agents.public(t.agents.get(aid))['watch']['why'] == 'ask'
    term = t.agents.get(aid)['term'] | {'generation': 'gen2'}
    t.db.update('agents', {'id': aid}, term=term)
    with pytest.raises(AgentError, match='会话已改变'):
        t.agents.queue_now(aid, q['id'])
    assert b.sent == []
    old = t.agents.get(aid)['token']
    t.agents.retire(aid, 'Task removed')
    assert b.closed and t.agents.get(aid)['token'] != old
    assert not t.db.one('select * from agent_events where id = ?', q['id'])['data']['held']


def test_herdr_start_waits_for_the_shell_and_a_dialog_held_start_is_not_idle(herdr):
    # herdr reports Codex's hooks review as idle. Every launch carries its first message, so idle before any turn is a dialog.
    t, h, host, c = herdr
    host.busy_starts = 2
    aid = employee(t)['id']; t.agents.start(aid, 'herdr', 'claude')
    assert [m for m, _ in host.calls].count('agent.start') == 3
    assert status(h, aid) == 'starting'
    t.s.terminal_ready = 0
    a = h.refresh(aid)
    assert a['term']['status'] == 'blocked' and a['term']['reason'] == 'startup'
    assert t.agents.public(a)['watch']['why'] == 'terminal'
    assert status(h, aid) == 'blocked'
    ident = a['term']['handle']['terminal']
    host.emit(id=ident, agent_status='working'); assert status(h, aid) == 'working'
    host.emit(id=ident, agent_status='idle', completion_seq=1); assert status(h, aid) == 'idle'


def test_herdr_project_workspace_has_no_empty_tab_and_closes_with_its_last_employee(herdr):
    t, h, host, c = herdr
    coder, writer = employee(t)['id'], employee(t, 'writer')['id']
    t.agents.start(coder, 'herdr', 'claude'); t.agents.start(writer, 'herdr', 'claude')
    first, second = (t.agents.get(x)['term']['handle'] for x in (coder, writer))
    assert first['workspace'] == second['workspace'] and len(host.workspaces) == 1
    assert [m for m, _ in host.calls].count('tab.create') == 1
    assert [p for m, p in host.calls if m == 'tab.rename'] == [{'tab_id': first['tab'], 'label': next(
        p['name'] for m, p in host.calls if m == 'agent.start' and p['pane_id'] == first['pane'])}]
    assert {x['workspace_id'] for x in host.tabs.values()} == {first['workspace']} and len(host.tabs) == 2
    h.close(coder); h.close(writer)
    assert not host.tabs and not host.workspaces


def test_herdr_blocked_native_session_exit_and_reconcile(herdr):
    t, h, host, c = herdr
    host.hosted_ready = False
    aid = employee(t)['id']; t.agents.start(aid, 'herdr', 'claude')
    a = h.refresh(aid); handle = a['term']['handle']; ident = handle['terminal']
    assert a['term']['status'] == 'blocked'
    host.emit(id=ident, agent_status='done', completion_seq=4, interactive_ready=True,
              agent_session={'kind': 'id', 'value': 'native-session'})
    a = h.refresh(aid)
    assert a['session_id'] == 'native-session' and a['term']['seq'] == 4
    assert t.agents.seen(aid)['watch']['bucket'] == 'idle'
    h2 = Hosted(t.agents); h2.watch = lambda: None; h2.reconcile()
    assert h2.backends['herdr'].workspaces[handle['session']] == handle['workspace']
    host.agents.pop(ident)
    assert status(h, aid) == 'exited'
    assert c.get('/api/backends').json()['herdr']['ok']
    assert c.post('/api/agents/runtime', json={'runtime': 'tmux'}).json() == {'runtime': 'tmux'}
    assert c.get('/api/agents/runtime').json() == {'runtime': 'tmux', 'paseo_chat': True}
    assert c.post('/api/agents/runtime', json={'runtime': 'pi'}).status_code == 400


def test_default_runtime_for_lead_and_canvas(tmp_path, monkeypatch):
    t = Town(make_settings(tmp_path)); employee(t)
    t.paseo_models.set_runtime('tmux')
    calls = []
    def start(a, runtime, provider, model, thinking):
        calls.append((a['id'], runtime, provider, model, thinking))
        t.agents._set(a['id'], runtime=runtime, status='idle', model='claude/default', term={
            'backend': runtime, 'provider': 'claude', 'status': 'idle', 'seq': 0, 'seen_seq': 0, 'since': 'now'})
        return t.agents.public(t.agents.get(a['id']))
    monkeypatch.setattr(t.agents.hosted, 'start', start)
    lead = employee(t, 'lead'); t.agents.start(lead['id'])
    assert calls[-1][1] == 'tmux'
    data = {'nodes': [{'id': 'task-default', 'kind': 'task', 'status': 'draft', 'to': 'coder', 'title': 'Task'}]}
    monkeypatch.setattr(t.canvas, '_load', lambda lid: data)
    monkeypatch.setattr(t.canvas, '_save', lambda *args: None)
    monkeypatch.setattr(t.canvas, '_changed', lambda *args: None)
    monkeypatch.setattr(t.canvas, 'view', lambda lid: data)
    t.canvas.bind('line-hosted', 'task-default', 'claude', 'chosen-model', 'high')
    assert calls[-1][1:] == ('tmux', 'claude', 'chosen-model', 'high')
    assert data['nodes'][0]['agent_id'] == calls[-1][0]
    data['nodes'].append({'id': 'task-explicit', 'kind': 'task', 'status': 'draft', 'to': 'writer', 'title': 'Task 2'})
    t.canvas.bind('line-hosted', 'task-explicit', 'codex', 'm2', 'low', runtime='headless')
    assert calls[-1][1:] == ('headless', 'codex', 'm2', 'low')
    assert data['nodes'][1]['agent_id'] == calls[-1][0]
    with pytest.raises(Exception):
        t.canvas.bind('line-hosted', 'task-explicit', 'claude', runtime='pi')
    # switching an off lead from an older Paseo session to a terminal backend detaches cleanly
    t.agents._set(lead['id'], runtime='paseo', ext_id='old-conv', status='idle', term=None)
    t.leads.configure('line-hosted', on=False)
    t.agents.start(lead['id'], 'herdr', 'claude', 'chosen-model', 'medium')
    assert calls[-1][1:] == ('herdr', 'claude', 'chosen-model', 'medium')


def test_hook_auth_independent_of_browser_login(tmp_path):
    app = create_app(make_settings(tmp_path))
    t = app.state.town; a = employee(t)
    t.agents._set(a['id'], runtime='tmux', term={'backend': 'tmux', 'provider': 'codex', 'status': 'working',
        'seq': 0, 'seen_seq': 0, 'since': 'now'})
    url = '/api/agents/' + a['id']
    with TestClient(app, client=('198.51.100.1', 1234)) as c:
        # an address outside the allowed sources: the API is shut, the agent's own hook is not
        assert c.get(url + '/screen').status_code == 403
        payload = {'provider': 'codex', 'data': {'type': 'agent-turn-complete', 'thread-id': 'remote-hook'}}
        assert c.post(url + '/hook', json=payload).status_code == 403
        assert c.post(url + '/hook', json=payload, headers={'x-papertown-token': a['token']}).status_code == 200
        assert t.agents.get(a['id'])['term']['status'] == 'done'


def test_switching_model_resumes_the_same_session(tmp_path, monkeypatch):
    t, h, b, aid = memory_employee(tmp_path, 'codex')
    opened = []
    b.open = lambda spec: opened.append(spec) or {'test': True}
    monkeypatch.setattr(h, 'clis', lambda: {'codex': '/bin/echo', 'claude': None, 'antigravity': None})
    t.agents._set(aid, session_id='sess-1')
    term = t.agents.get(aid)['term'] | {'status': 'working', 'model': 'm1', 'thinking': 'high'}
    t.db.update('agents', {'id': aid}, term=term)
    with pytest.raises(AgentError):  # not in the middle of a turn
        t.agents.switch_model(aid, 'm2', 'low')
    t.db.update('agents', {'id': aid}, term=term | {'status': 'idle'})
    t.agents.switch_model(aid, 'm2', 'low')
    argv = opened[-1]['argv']
    assert argv[argv.index('resume') + 1] == 'sess-1'
    assert argv[argv.index('-m') + 1] == 'm2' and 'model_reasoning_effort="low"' in argv
    # no first message: the CLI opens on its session and waits for the next one
    assert argv[-2] == '-c' and argv[-1].startswith('notify=')
    assert b.closed
    assert t.agents.models(aid)['current'] == {'provider': 'codex', 'model': 'm2', 'thinking': 'low'}
    assert t.agents.get(aid)['term']['quiet']


def test_a_quiet_start_is_ready_when_still_unless_a_dialog_shows(tmp_path):
    t, h, b, aid = memory_employee(tmp_path, 'codex')
    term = t.agents.get(aid)['term'] | {'quiet': True}
    t.db.update('agents', {'id': aid}, term=term)
    b.text = '› Ask Codex to do anything'
    assert status(h, aid) == 'starting'; time.sleep(.06)
    assert status(h, aid) == 'idle' and t.agents.get(aid)['term']['seq'] == 0
    t.db.update('agents', {'id': aid}, term=term | {'screen_hash': None})
    b.text = 'Resume this session?\n› 1. Resume from summary\n  2. Resume full session as-is'
    h.refresh(aid); time.sleep(.06)
    assert status(h, aid) == 'blocked' and t.agents.get(aid)['term']['reason'] == 'startup'


def test_paseo_chat_off_runs_agents_in_a_terminal(tmp_path, monkeypatch):
    t = Town(make_settings(tmp_path, paseo_chat=False, agent_runtime='tmux'))
    assert t.paseo_models.runtime() == 'tmux'
    with pytest.raises(ModelError):
        t.paseo_models.set_runtime('paseo')
    calls = []
    def start(a, runtime, provider=None, model=None, thinking=None, note=None):
        calls.append((a['id'], runtime))
        t.agents._set(a['id'], runtime=runtime, ext_id=None, status='idle', term={
            'backend': runtime, 'provider': 'claude', 'status': 'idle', 'seq': 0, 'seen_seq': 0, 'since': 'now'})
        return t.agents.public(t.agents.get(a['id']))
    monkeypatch.setattr(t.agents.hosted, 'start', start)
    a = employee(t)
    t.agents.start(a['id'], 'paseo', 'claude', 'm', 'high')
    assert calls[-1] == (a['id'], 'tmux')
    # one left in Paseo reads as down, takes no messages, and starts again in a terminal
    w = employee(t, 'writer')
    t.agents._set(w['id'], runtime='paseo', ext_id='conv', status='idle', term=None)
    assert t.agents.down(t.agents.get(w['id'])) == PASEO_OFF
    with pytest.raises(AgentError):
        t.agents.say(w['id'], 'hello')
    with pytest.raises(AgentError):
        t.agents.import_session(w['id'], 'other')
    t.agents.start(w['id'])
    assert calls[-1] == (w['id'], 'tmux') and not t.agents.get(w['id'])['ext_id']


def test_screen_with_its_colours_comes_styled_and_packed(tmp_path):
    t, h, b, aid = memory_employee(tmp_path)
    b.text = '\x1b[1;32mdone\x1b[0m ' + 'x' * 5000
    with patch('papertown.api.Town', return_value=t):
        c = TestClient(create_app())
    url = f'/api/agents/{aid}/screen'
    plain = c.get(url).json()
    assert 'lines' not in plain and plain['text'].startswith('\x1b[1;32m')
    r = c.get(url + '?styled=1', headers={'Accept-Encoding': 'gzip'})
    assert r.headers.get('content-encoding') == 'gzip'
    styled = r.json()
    assert styled['text'] == 'done ' + 'x' * 5000 and styled['theme'] == {'fg': '#cccccc', 'bg': '#1e1e1e'}
    run, style = styled['lines'][0][0]
    assert run == 'done' and styled['styles'][style] == {'fg': '#0dbc79', 'b': True}


def test_files_go_with_a_message_by_path(tmp_path, monkeypatch):
    t, h, b, aid = memory_employee(tmp_path)
    said = []
    monkeypatch.setattr(t.agents, 'say', lambda agent_id, text, mode=None: said.append(text) or {'ok': True})
    with patch('papertown.api.Town', return_value=t):
        c = TestClient(create_app())
    url = f'/api/agents/{aid}'
    up = c.post(url + '/uploads?name=../shot 1.PNG', content=b'\x89PNG data').json()
    assert up['kind'] == 'image' and up['name'] == 'shot_1.PNG'
    assert Path(up['path']).parent == t.agents.home(t.agents.get(aid)) / 'uploads' and Path(up['path']).read_bytes() == b'\x89PNG data'
    doc = c.post(url + '/uploads?name=notes.pdf', content=b'%PDF').json()
    assert doc['kind'] == 'file'
    assert c.post(url + '/say', json={'text': 'look ', 'attachments': [up['id'], doc['id']]}).status_code == 200
    assert said[-1] == f"look\n\n附件：\n- 图片 {up['path']}\n- 文件 {doc['path']}"
    assert c.post(url + '/say', json={'attachments': [up['id']]}).status_code == 200
    assert said[-1] == f"附件：\n- 图片 {up['path']}"
    assert c.post(url + '/say', json={'text': 'x', 'attachments': ['../../etc/passwd']}).status_code == 400
    assert c.post(url + '/say', json={'text': ' '}).status_code == 422
    assert c.post(url + '/uploads?name=empty', content=b'').status_code == 400
    assert len(said) == 2


def test_every_terminal_key_reaches_each_backend():
    from papertown import backends, ptyd
    from papertown.terminals import KEYS
    for k in KEYS:
        single = len(k) == 1 and k.isprintable()
        assert k in backends.TMUX_KEYS or single, k
        assert k in ptyd.KEYS or k in ptyd.ARROWS or single, k
