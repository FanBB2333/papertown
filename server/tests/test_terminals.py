"""Protocol and terminal behavior against a local fake, never a running agent host."""

import json
import socket
import socketserver
import tempfile
import threading
import time
from copy import deepcopy
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from papertown.api import create_app
from papertown.herdr import Feed, Herdr, HerdrError
from papertown.terminals import KEYS
from .conftest import make_settings


def eventually(check, timeout=3):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if check():
            return
        time.sleep(0.01)
    assert check()


def agent(id='t1', **fields):
    return dict(terminal_id=id, pane_id=f'w1:{id}', workspace_id='w1', tab_id='tab1',
                agent='codex', name='Reviewer', title='检查测试', cwd='/unrelated', foreground_cwd=None,
                agent_status='working', completion_seq=None, state_change_seq=1, focused=False, revision=1) | fields


class FakeHerdr(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True

    def __init__(self, path):
        super().__init__(str(path), Handler)
        self.agents = {'t1': agent()}
        self.calls, self.streams = [], []
        self.lock = threading.RLock()
        self.stopped = threading.Event()
        self.fail_prompt = False
        self.thread = threading.Thread(target=self.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
        self.thread.start()

    def emit(self, event='pane.agent_status_changed', id='t1', **fields):
        with self.lock:
            a = self.agents[id]
            a.update(fields)
            a['state_change_seq'] += 1
            data = {'pane_id': a['pane_id'], 'agent_status': a['agent_status']}
            for handler, subscriptions in list(self.streams):
                if any(s['type'] == event and s.get('pane_id', a['pane_id']) == a['pane_id'] for s in subscriptions):
                    try:
                        handler.send({'event': event, 'data': data})
                    except OSError:
                        self.streams.remove((handler, subscriptions))

    def close(self):
        self.stopped.set()
        with self.lock:
            for handler, _ in self.streams:
                try:
                    handler.request.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
        self.shutdown()
        self.server_close()
        self.thread.join(1)


class Handler(socketserver.StreamRequestHandler):
    def send(self, value):
        wire = (json.dumps(value, ensure_ascii=False) + '\n').encode()
        # Fragment JSON and UTF-8 so clients cannot assume recv() returns a whole frame.
        for offset in range(0, len(wire), 7):
            self.request.sendall(wire[offset:offset + 7])

    def handle(self):
        try:
            request = json.loads(self.rfile.readline())
            method, p = request['method'], request['params']
            host = self.server
            with host.lock:
                host.calls.append((method, deepcopy(p)))
                # Protocol 22 resolves agent targets by pane ID or assigned name, never terminal ID.
                a = next((a for a in host.agents.values() if p.get('target') in (a['pane_id'], a.get('name'))), None)
                error = None
                if method == 'events.subscribe':
                    subs = p['subscriptions']
                    assert all('pane_id' in s for s in subs if s['type'] == 'pane.agent_status_changed')
                    self.send({'id': request['id'], 'result': {'type': 'subscription_started'}})
                    host.streams.append((self, subs))
                    result = None
                elif method == 'agent.list':
                    result = {'type': 'agent_list', 'agents': list(host.agents.values())}
                elif a is None:
                    error = 'agent_not_found'
                elif method == 'agent.get':
                    result = {'type': 'agent_info', 'agent': a}
                elif method == 'agent.read':
                    assert p['source'] == 'recent_unwrapped'
                    result = {'type': 'pane_read', 'read': {'text': '第一行\n处理完成 ✓\n'}}
                elif method == 'agent.prompt':
                    if a['agent_status'] == 'blocked':
                        error = 'agent_blocked'
                    elif host.fail_prompt:
                        return
                    else:
                        result = {'type': 'agent_prompted', 'agent': a}
                elif method == 'agent.send_keys':
                    result = {'type': 'ok'}
                else:
                    raise AssertionError(method)
                if method != 'events.subscribe':
                    self.send({'id': request['id'], 'error': {'code': error, 'message': 'Host error'}} if error
                              else {'id': request['id'], 'result': result})
            if method == 'events.subscribe':
                host.stopped.wait(10)
        except (BrokenPipeError, ConnectionResetError):
            pass


@pytest.fixture
def setup(tmp_path):
    # macOS limits Unix socket paths to 104 bytes.
    with tempfile.TemporaryDirectory(prefix='pt-herdr-', dir='/private/tmp') as folder:
        host = FakeHerdr(Path(folder) / 'test.sock')
        app = create_app(make_settings(tmp_path, herdr_socket=str(host.server_address)))
        town = app.state.town
        town.terminals.refresh()
        with TestClient(app) as client:
            yield client, town, host
        host.close()


def test_buckets_seen_text_and_status(setup):
    client, town, host = setup
    t = town.terminals
    url = '/api/terminals/herdr:t1'
    for status, seq, bucket, why in [('blocked', 8, 'needs', 'terminal'), ('working', 8, 'working', None),
                                   ('done', 8, 'review', 'finished'), ('idle', 8, 'review', 'finished'),
                                   ('unknown', 9, 'idle', 'unknown')]:
        host.emit(agent_status=status, completion_seq=seq)
        t.refresh()
        w = t.all()[0]['watch']
        assert (w['bucket'], w['why']) == (bucket, why)
        assert w['permissions'] == [] and w['asks'] == []
        assert w['doing'] == {'kind': 'title', 'text': '检查测试'}
    host.emit(agent_status='done', completion_seq=10)
    t.refresh()
    assert client.post(url + '/seen').json()['watch']['bucket'] == 'idle'
    assert town.db.one('select * from terminal_seen')['seq'] == 10
    host.emit(agent_status='done', completion_seq=11)
    t.refresh()
    detail = client.get(url).json()
    assert detail['terminal']['watch']['unread'] and detail['text'] == '第一行\n处理完成 ✓\n'
    assert detail['queued'] == []
    assert client.get('/api/herdr').json()['socket'] == host.server_address
    assert client.get('/api/herdr').json()['count'] == 1
    assert not any('focus' in method or 'seen' in method for method, _ in host.calls)


def test_queue_releases_one_on_idle_event_and_controls(setup):
    client, town, host = setup
    url = '/api/terminals/herdr:t1'
    first, second = [client.post(url + '/say', json={'text': text, 'mode': 'queue'}).json() for text in ('First', 'Second')]
    assert town.terminals.all()[0]['watch']['queued'] == 2
    eventually(lambda: any(any(s.get('pane_id') == 'w1:t1' for s in subs) for _, subs in host.streams))
    host.emit(agent_status='idle', completion_seq=1)
    eventually(lambda: any(p.get('text') == 'First' for method, p in host.calls if method == 'agent.prompt'))
    town.terminals.refresh()
    assert [p['text'] for m, p in host.calls if m == 'agent.prompt'] == ['First']
    assert client.post(url + f"/queue/{first['id']}", json={'what': 'now'}).status_code == 400
    assert client.post(url + f"/queue/{second['id']}", json={'what': 'drop'}).json()['text'] == 'Second'
    host.emit(agent_status='working')
    town.terminals.refresh()
    third = client.post(url + '/say', json={'text': 'Now', 'mode': 'queue'}).json()
    assert client.post('/api/terminals/herdr:wrong/queue/' + str(third['id']), json={'what': 'now'}).status_code == 400
    assert client.post(url + f"/queue/{third['id']}", json={'what': 'now'}).json()['state'] == 'sent'
    assert town.terminals.all()[0]['watch']['queued'] == 0


def test_interrupt_waits_for_agent_after_escape(setup):
    client, town, host = setup
    result = []
    thread = threading.Thread(target=lambda: result.append(client.post('/api/terminals/herdr:t1/say', json={'text': 'Replacement', 'mode': 'interrupt'})))
    thread.start()
    eventually(lambda: ('agent.send_keys', {'target': 'w1:t1', 'keys': ['esc']}) in host.calls)
    eventually(lambda: sum(m == 'agent.get' for m, _ in host.calls) >= 3)
    assert not any(m == 'agent.prompt' for m, _ in host.calls)
    host.emit(agent_status='idle', completion_seq=1)
    thread.join(3)
    assert not thread.is_alive() and result[0].status_code == 200
    methods = [m for m, _ in host.calls]
    esc = methods.index('agent.send_keys')
    assert esc < methods.index('agent.get', esc) < methods.index('agent.prompt')


def test_blocked_and_key_whitelist(setup):
    client, town, host = setup
    host.emit(agent_status='blocked')
    town.terminals.refresh()
    url = '/api/terminals/herdr:t1'
    assert client.post(url + '/say', json={'text': 'Do not type into dialog'}).json()['detail'] == '它在等你处理终端里的对话框'
    for key in sorted(KEYS):
        assert client.post(url + '/keys', json={'keys': [key]}).status_code == 200
    before = sum(m == 'agent.send_keys' for m, _ in host.calls)
    for keys in (['enter', 'rm -rf'], ['tab'], ['CTRL+C'], ['\x03'], []):
        assert client.post(url + '/keys', json={'keys': keys}).status_code in (400, 422)
    assert sum(m == 'agent.send_keys' for m, _ in host.calls) == before


def test_grouping_counts_and_cached_overview(setup, tmp_path, monkeypatch):
    client, town, host = setup
    town.db.insert('lines', {'id': 'project', 'seq': 1, 'title': 'Test', 'status': 'waiting',
                            'linked': {'code': str(tmp_path / 'code'), 'paper': str(tmp_path / 'paper')}})
    town.db.insert('agents', {'id': 'owned', 'line_id': 'project', 'cwd': str(tmp_path / 'employee')})
    host.agents = {f't{i}': agent(f't{i}', agent_status='idle', cwd=str(tmp_path / cwd))
                   for i, cwd in enumerate(['code', 'paper/child', 'employee/work', 'code-other'])}
    host.agents['foreground'] = agent('foreground', foreground_cwd=str(tmp_path / 'code/sub'), cwd='/elsewhere', agent_status='blocked')
    town.terminals.refresh()
    town.terminals.shutdown()
    monkeypatch.setattr(town.terminals.client, 'agents', lambda: pytest.fail('Overview must use the cache'))
    data = client.get('/api/agents/overview').json()
    assert len(data['groups']) == 1 and len(data['groups'][0]['terminals']) == 4
    assert [t['id'] for t in data['others']] == ['herdr:t3']
    assert data['counts']['needs'] == 1 and data['counts']['idle'] == 4
    assert data['herdr']['ok']


def test_missing_socket_and_disabled_are_quiet(tmp_path):
    app = create_app(make_settings(tmp_path))
    town = app.state.town
    town.terminals.start()
    try:
        town.terminals.refresh()
        start = time.monotonic()
        assert town.terminals.all() == []
        assert town.terminals.status() == {'ok': False, 'note': 'herdr 没有运行', 'live': False}
        assert time.monotonic() - start < 0.1
        with pytest.raises(HerdrError, match='herdr 没有运行'):
            town.terminals.client.agents()
    finally:
        feed = town.terminals._feed
        town.terminals.shutdown()
    assert not feed._thread.is_alive()
    disabled = Herdr(make_settings(tmp_path, herdr=False))
    with pytest.raises(HerdrError, match='herdr 接入已关闭'):
        disabled.agents()


def test_lost_prompt_response_never_retries_automatically(setup):
    client, town, host = setup
    client.post('/api/terminals/herdr:t1/say', json={'text': 'Once', 'mode': 'queue'})
    host.fail_prompt = True
    host.emit(agent_status='done', completion_seq=1)
    town.terminals.refresh()
    town.terminals.refresh()
    assert [p['text'] for m, p in host.calls if m == 'agent.prompt'] == ['Once']
    assert town.db.one('select * from terminal_queue')['state'] == 'failed'


def test_feed_reconnects_and_follows_new_panes(setup):
    _, town, host = setup
    feed = town.terminals._feed
    eventually(lambda: feed.live)
    host.agents['t2'] = agent('t2')
    host.emit('pane.agent_detected', 't2')
    eventually(lambda: any(any(s.get('pane_id') == 'w1:t2' for s in subs) for _, subs in host.streams))
    host.emit(id='t2', agent_status='blocked')
    eventually(lambda: any(t['id'] == 'herdr:t2' and t['watch']['bucket'] == 'needs' for t in town.terminals.all()))
    del host.agents['t2']
    host.emit('pane.closed')
    eventually(lambda: len(town.terminals.all()) == 1)


def test_pane_reuse_cannot_redirect_input(setup):
    client, town, host = setup
    town.terminals.shutdown()
    host.agents = {'replacement': agent('replacement', pane_id='w1:t1')}
    for path, body in [('say', {'text': 'For the original agent'}), ('keys', {'keys': ['enter']})]:
        response = client.post('/api/terminals/herdr:t1/' + path, json=body)
        assert response.status_code == 400 and response.json()['detail'] == '终端会话已变更，请重新选择'
    assert not any(m in ('agent.prompt', 'agent.send_keys') for m, _ in host.calls)


def test_interrupt_timeout_never_prompts(setup, monkeypatch):
    client, _, host = setup
    monkeypatch.setattr('papertown.terminals.INTERRUPT_TIMEOUT', 0.15)
    response = client.post('/api/terminals/herdr:t1/say', json={'text': 'Replacement', 'mode': 'interrupt'})
    assert response.status_code == 400 and response.json()['detail'] == '终端里的 agent 尚未停止，消息未发送'
    assert not any(m == 'agent.prompt' for m, _ in host.calls)


def test_read_marks_and_queue_survive_service_restart(setup):
    client, town, host = setup
    from papertown.terminals import Terminals
    host.emit(agent_status='done', completion_seq=4)
    town.terminals.refresh()
    client.post('/api/terminals/herdr:t1/seen')
    host.emit(agent_status='working')
    town.terminals.refresh()
    held = client.post('/api/terminals/herdr:t1/say', json={'text': 'After restart', 'mode': 'queue'}).json()
    town.terminals.shutdown()
    town.terminals = Terminals(town)
    town.terminals.refresh()
    assert town.terminals.all()[0]['watch']['queued'] == 1
    host.emit(agent_status='idle', completion_seq=4)
    town.terminals.refresh()
    assert town.terminals.all()[0]['watch']['bucket'] == 'idle'
    assert town.db.one('select * from terminal_queue where id = ?', held['id'])['state'] == 'sent'


def test_completion_releases_once_despite_presentation_changes(setup):
    client, town, host = setup
    for text in ('First', 'Second'):
        client.post('/api/terminals/herdr:t1/say', json={'text': text, 'mode': 'queue'})
    host.emit(agent_status='done', completion_seq=5)
    town.terminals.refresh()
    host.emit(agent_status='idle', completion_seq=5, title='Focused elsewhere')
    town.terminals.refresh()
    assert [p['text'] for m, p in host.calls if m == 'agent.prompt'] == ['First']
    host.emit(agent_status='done', completion_seq=6)
    town.terminals.refresh()
    assert [p['text'] for m, p in host.calls if m == 'agent.prompt'] == ['First', 'Second']


@pytest.mark.parametrize('restart', [False, True])
def test_feed_backoff_caps_at_thirty_seconds(tmp_path, restart):
    waits = []
    class Halt:
        calls = 0
        def is_set(self):
            self.calls += 1
            return len(waits) >= 7 or self.calls > 20
        def wait(self, seconds):
            waits.append(seconds)
            return self.is_set()
    feed = Feed.__new__(Feed)
    feed.client = Herdr(make_settings(tmp_path))
    feed.callback = lambda _: pytest.fail('A missing socket has no events')
    feed._halt, feed._lock = Halt(), threading.Lock()
    feed._panes, feed._stream, feed._live, feed._restart = set(), None, False, restart
    feed._run()
    assert waits == [1, 2, 4, 8, 16, 30, 30] and not feed.live


def test_periodic_refresh_and_bus_payload(setup, monkeypatch):
    _, town, host = setup
    service = town.terminals
    service.shutdown()
    service._halt.clear()
    waits, events = [], []
    class Wake:
        def clear(self):
            pass
        def wait(self, seconds):
            waits.append(seconds)
            if len(waits) == 1:
                host.agents['t1']['agent_status'] = 'blocked'
            else:
                service._halt.set()
    monkeypatch.setattr(town.bus, 'publish', lambda kind, **data: events.append((kind, data)))
    with monkeypatch.context() as patch:
        patch.setattr(service, '_wake', Wake())
        service._run()
    assert waits == [10, 10]
    assert service.all()[0]['watch']['why'] == 'terminal'
    assert ('terminal', {'id': 'herdr:t1'}) in events


def test_disconnected_host_clears_cache_without_blocking_overview(setup, monkeypatch):
    client, town, host = setup
    town.terminals.shutdown()
    # An absent socket simulates the host disappearing without starting or stopping any real host.
    town.terminals.client.path = Path(host.server_address).with_name('missing.sock')
    town.terminals.refresh()
    assert town.terminals.all() == [] and not town.terminals.status()['ok']
    monkeypatch.setattr(town.terminals.client, 'agents', lambda: pytest.fail('Cached overview called the host'))
    overview = client.get('/api/agents/overview').json()
    assert overview['others'] == [] and sum(overview['counts'].values()) == 0
    assert client.get('/api/terminals/herdr:t1').status_code == 400
