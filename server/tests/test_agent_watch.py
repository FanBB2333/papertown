"""Agent attention, queued delivery and live snapshots, using only fake hosts."""

import json
import io
import sqlite3
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from papertown.db import DB
from papertown.paseo import Feed, PaseoError
from .test_canvas_agents import bind, flow, node
from .conftest import wait_for


def snapshot(town, link, agent, **fields):
    conv = next(c for c in link.convs if c['id'] == agent['ext_id'])
    conv.update(fields)
    town.agents._feed_line({'t': 'agent', 'agent': dict(conv)})


def watch(client, agent):
    return client.get(f"/api/agents/{agent['id']}").json()['agent']['watch']


@pytest.mark.parametrize('kind, why', [('tool', 'permission'), ('question', 'question'), ('plan', 'question')])
def test_permissions_take_priority_and_keep_the_native_kind(flow, kind, why):
    c, town, link, lid = flow
    a = bind(c, lid, node(c, lid))
    permission = {'id': 'req', 'name': 'Bash', 'title': 'Approval', 'arg': 'pytest -q', 'kind': kind}
    snapshot(town, link, a, status='error', permissions=[permission], attention_at='2026-11-01T01:00:00Z')
    w = watch(c, a)
    assert (w['bucket'], w['why']) == ('needs', why)
    assert w['permissions'] == [permission] and w['doing']['text'] == 'Approval pytest -q'
    assert w['since'] == '2026-11-01T01:00:00Z'


def test_asks_errors_work_review_seen_and_off(flow, monkeypatch):
    c, town, link, lid = flow
    a = bind(c, lid, node(c, lid))
    assert watch(c, a)['bucket'] == 'working'
    ask = town.leads.ask(a['id'], 'Continue?', ['Yes', 'No'])
    snapshot(town, link, a, status='error')
    assert (watch(c, a)['bucket'], watch(c, a)['why']) == ('needs', 'ask')
    assert watch(c, a)['asks'] == [ask]
    town.db.update('reports', {'id': ask['id']}, data=ask['data'] | {'open': False})
    assert (watch(c, a)['bucket'], watch(c, a)['why']) == ('failed', 'error')
    snapshot(town, link, a, status='idle', attention=True, attention_reason='finished', attention_at='2026-11-01T02:00:00.123Z')
    assert (watch(c, a)['bucket'], watch(c, a)['why'], watch(c, a)['unread']) == ('review', 'finished', True)
    assert c.post(f"/api/agents/{a['id']}/seen").json()['watch']['bucket'] == 'idle'
    assert town.agents.get(a['id'])['seen_at']
    town.db.update('agents', {'id': a['id']}, seen_at=None)
    snapshot(town, link, a, attention=False)
    assert watch(c, a)['bucket'] == 'idle'
    snapshot(town, link, a, status='running', turn_started='2026-11-01T03:00:00Z')
    before = watch(c, a)
    snapshot(town, link, a, updated='2026-11-01T03:01:00Z', model='other-model')
    assert watch(c, a)['since'] == before['since'] and watch(c, a)['turn'] == '2026-11-01T03:00:00Z'
    monkeypatch.setattr(town.agents.paseo, 'status', lambda: {'ok': False, 'note': 'Unavailable'})
    assert watch(c, a)['bucket'] == 'off'


def test_pi_held_messages_are_counted_and_controls_reach_the_bridge(flow, monkeypatch):
    c, town, _, lid = flow
    a = town.agents.ensure(lid, 'coder')
    town.agents.ingest(a['id'], [{'t': 'hello'}, {'t': 'start'}])
    monkeypatch.setattr(town.agents, 'alive', lambda a: True)
    first = town.agents.say(a['id'], 'Next', 'queue')
    second = town.agents.say(a['id'], 'Retract', 'queue')
    assert watch(c, a)['queued'] == 2
    town.agents.queue_now(a['id'], first['id'])
    town.agents.queue_drop(a['id'], second['id'])
    inbox = town.agents.take(a['id'])
    assert [(m['kind'], m['mid']) for m in inbox[2:]] == [('queue_now', first['data']['mid']), ('queue_drop', second['data']['mid'])]
    town.agents.ingest(a['id'], [{'t': 'queued', 'ids': [first['data']['mid'], second['data']['mid']]}])
    assert watch(c, a)['queued'] == 0
    third = town.agents.say(a['id'], 'Automatic delivery', 'queue')
    town.agents.ingest(a['id'], [{'t': 'delivered', 'ids': [third['data']['mid']]}])
    assert watch(c, a)['queued'] == 0


def test_sending_interrupts_marks_seen_and_controls_held_messages(flow):
    c, town, link, lid = flow
    a = bind(c, lid, node(c, lid))
    url = f"/api/agents/{a['id']}"
    event = c.post(url + '/say', json={'text': 'Replace the task', 'mode': 'interrupt'}).json()
    assert event['data']['interrupted'] is True and event['data']['steered'] is False
    assert link.behaviors == ['interrupt'] and town.agents.get(a['id'])['seen_at']
    one = c.post(url + '/say', json={'text': 'Next', 'mode': 'queue'}).json()
    two = c.post(url + '/say', json={'text': 'Retract', 'mode': 'queue'}).json()
    assert watch(c, a)['queued'] == 2
    delivered = c.post(url + f"/queue/{one['id']}", json={'what': 'now'}).json()
    assert delivered['id'] == one['id'] and delivered['data']['delivered'] and delivered['data']['steered']
    assert not delivered['data']['held'] and link.behaviors[-1] == 'steer'
    dropped = c.post(url + f"/queue/{two['id']}", json={'what': 'drop'}).json()
    assert not dropped['data']['held'] and dropped['data']['dropped'] and dropped['data']['text'] == 'Retract'
    assert watch(c, a)['queued'] == 0
    assert c.post(url + f"/queue/{one['id']}", json={'what': 'now'}).status_code == 400
    assert c.post(url + f"/queue/{two['id']}", json={'what': 'bad'}).status_code == 422
    held = town.agents.say(a['id'], 'When idle', 'queue')
    town.agents._set(a['id'], status='idle')
    assert not town.agents.queue_now(a['id'], held['id'])['data']['steered']


def test_queue_ownership_failures_and_session_guards(flow, monkeypatch):
    c, town, link, lid = flow
    a, b = [bind(c, lid, node(c, lid)) for _ in range(2)]
    held = town.agents.say(a['id'], 'Keep this', 'queue')
    assert c.post(f"/api/agents/{b['id']}/queue/{held['id']}", json={'what': 'drop'}).status_code == 400
    def fail(*args):
        raise PaseoError('Unavailable')
    monkeypatch.setattr(town.agents.paseo, 'send', fail)
    assert c.post(f"/api/agents/{a['id']}/queue/{held['id']}", json={'what': 'now'}).status_code == 400
    assert watch(c, a)['queued'] == 1
    town.agents._set(a['id'], ext_id='different')
    assert c.post(f"/api/agents/{a['id']}/queue/{held['id']}", json={'what': 'now'}).status_code == 400


def test_feed_snapshot_delivery_activity_and_gone(flow, monkeypatch):
    c, town, link, lid = flow
    a = bind(c, lid, node(c, lid, 'Verify'))
    events = []
    monkeypatch.setattr(town.bus, 'publish', lambda kind, **data: events.append((kind, data)))
    held = town.agents.say(a['id'], 'Queued', 'queue')
    town.agents.say(a['id'], 'Still queued', 'queue')
    snapshot(town, link, a, status='idle', model='new-model')
    snapshot(town, link, a, status='idle', model='new-model')
    assert link.sent == [(a['ext_id'], 'Queued')]
    assert town.agents.get(a['id'])['model'] == 'codex/new-model'
    assert town.db.one('select * from agent_events where id = ?', held['id'])['data']['delivered']
    line = {'t': 'doing', 'id': a['ext_id'], 'doing': {'kind': 'tool', 'text': 'Bash pytest -q'}, 'at': '2026-11-01T03:00:00Z'}
    town.agents._feed_line(line)
    town.agents._feed_line(line)
    assert watch(c, a)['doing'] == line['doing']
    assert not [data for kind, data in events if kind == 'agent_live']
    town.agents._feed_line({'t': 'live', 'id': a['ext_id']})
    assert [data for kind, data in events if kind == 'agent_live'] == [{'agent_id': a['id']}]
    assert all('watch' in data['agent'] for kind, data in events if kind == 'agent')
    snapshot(town, link, a, status='running', permissions=[{'id': 'p', 'kind': 'plan'}], attention=True)
    def sparse(labels):
        return [{'id': a['ext_id'], 'status': 'running', 'provider': 'codex', 'model': 'new-model'}]
    monkeypatch.setattr(town.agents.paseo, 'list', sparse)
    town.agents.sync_paseo()
    assert watch(c, a)['why'] == 'question'
    town.agents._feed_line({'t': 'gone', 'id': a['ext_id']})
    assert watch(c, a)['bucket'] == 'off' and not watch(c, a)['permissions']


def test_timeline_fills_watch_and_task_reads_do_not_rewrite_the_canvas(flow, monkeypatch):
    c, town, link, lid = flow
    nid = node(c, lid, 'Read-only task')
    a = bind(c, lid, nid)
    path = town.canvas._path(lid)
    before = path.read_bytes()
    def timeline(ext, limit):
        return {'agent': next(x for x in link.convs if x['id'] == ext) | {'status': 'idle', 'attention': True,
                'attention_reason': 'finished', 'attention_at': '2026-11-01T00:00:00Z'},
                'items': [{'kind': 'assistant', 'text': 'Finished'}], 'doing': {'kind': 'say', 'text': 'Finished'}}
    monkeypatch.setattr(town.agents.paseo, 'timeline', timeline)
    data = c.get(f"/api/agents/{a['id']}/timeline").json()
    assert data['agent']['watch']['bucket'] == 'review' and data['agent']['watch']['doing']['text'] == 'Finished'
    assert data['agent']['task'] == {'id': nid, 'title': 'Read-only task', 'status': 'draft'}
    assert path.read_bytes() == before


def test_pi_buckets_activity_and_interrupt_order(flow, monkeypatch):
    c, town, link, lid = flow
    a = town.agents.ensure(lid, 'writer')
    assert watch(c, a)['bucket'] == 'off'
    town.agents.ingest(a['id'], [{'t': 'hello'}, {'t': 'start'}, {'t': 'tool_start', 'id': 'tool', 'name': 'bash', 'args': {'command': 'pytest'}}])
    assert watch(c, a)['bucket'] == 'working' and watch(c, a)['turn']
    assert watch(c, a)['doing'] == {'kind': 'tool', 'text': 'bash pytest'}
    town.agents.ingest(a['id'], [{'t': 'tool_end', 'id': 'tool'}, {'t': 'assistant', 'text': 'All done'}, {'t': 'settled'}])
    assert watch(c, a)['bucket'] == 'review' and watch(c, a)['doing']['text'] == 'All done'
    assert c.post(f"/api/agents/{a['id']}/seen").json()['watch']['bucket'] == 'idle'
    town.agents.ingest(a['id'], [{'t': 'assistant', 'text': 'One more detail'}])
    assert watch(c, a)['bucket'] == 'review'
    monkeypatch.setattr(town.agents, 'alive', lambda a: True)
    # an idle agent has nothing to stop: the message goes in as an ordinary one
    result = c.post(f"/api/agents/{a['id']}/say", json={'text': 'While idle', 'mode': 'interrupt'}).json()
    assert 'interrupted' not in result['data']
    assert [m.get('kind') for m in town.agents.take(a['id'])] == [None]
    town.agents.ingest(a['id'], [{'t': 'start'}])
    result = c.post(f"/api/agents/{a['id']}/say", json={'text': 'New task', 'mode': 'interrupt'}).json()
    assert result['data']['interrupted']
    inbox = town.agents.take(a['id'])
    assert inbox[0]['kind'] == 'abort' and inbox[1]['mode'] == 'queue' and inbox[1]['text'] == 'New task'
    town.agents._set(a['id'], status='error')
    assert watch(c, a)['bucket'] == 'failed'
    town.agents.ingest(a['id'], [{'t': 'bye'}])
    assert watch(c, a)['bucket'] == 'off'


def test_overview_groups_counts_and_loose_sessions_survive_an_outage(flow, monkeypatch):
    c, town, link, lid = flow
    a = bind(c, lid, node(c, lid))
    newer = c.post('/api/ideas', json={'text': 'Another research project'}).json()['id']
    wait_for(town, newer, {'waiting'})
    b = bind(c, newer, node(c, newer))
    town.agents.ensure(lid, 'writer')
    assistant = town.assistant.row()
    town.agents._set(assistant['id'], runtime='pi', status='idle')
    snapshot(town, link, a, status='error')
    base = {'title': 'Loose', 'provider': 'codex', 'model': 'test', 'status': 'idle', 'updated': '2026-11-01T00:00:00Z'}
    for ext, cwd, labels in [('equal', a['cwd'], {}), ('child', str(Path(a['cwd']) / 'child'), {}),
                              ('prefix', a['cwd'] + '-other', {}), ('assistant-old', a['cwd'], {'papertown.role': 'assistant'}),
                              ('owned', a['cwd'], {'papertown.agent': 'former-owner'})]:
        link.convs.append(base | {'id': ext, 'cwd': cwd, 'labels': labels})
    result = c.get('/api/agents/overview').json()
    assert [g['line']['id'] if g['line'] else None for g in result['groups']] == [None, newer, lid]
    assert result['counts'] == {'needs': 0, 'failed': 1, 'review': 0, 'working': 1, 'idle': 1, 'off': 0}
    assert {x['id'] for x in result['groups'][-1]['loose']} == {'equal', 'child'}
    assert result['paseo'] == {'ok': True, 'note': '', 'live': False}
    def unavailable():
        raise PaseoError('Unavailable')
    monkeypatch.setattr(town.agents.paseo, 'conversations', unavailable)
    result = c.get('/api/agents/overview').json()
    assert not result['paseo']['ok'] and result['paseo']['note'] == 'Unavailable'
    assert result['counts']['off'] == 2 and result['counts']['idle'] == 1
    assert all(not g['loose'] for g in result['groups'])
    monkeypatch.setattr(town.agents.paseo, 'status', unavailable)
    assert c.get('/api/agents/overview').json()['counts']['off'] == 2


def test_seen_migrates_existing_databases_and_compares_timestamps(tmp_path):
    path = tmp_path / 'old.sqlite'
    with sqlite3.connect(path) as connection:
        connection.execute('create table agents(id text primary key)')
    db = DB(path)
    assert 'seen_at' in {row['name'] for row in db.q('pragma table_info(agents)')}
    from papertown.agents import Agents
    assert not Agents._after('2026-11-01T08:00:00Z', '2026-11-01T16:00:00+08:00')
    assert Agents._after('2026-11-01T08:00:00.123Z', '2026-11-01T08:00:00+00:00')


def test_feed_reads_fake_process_and_closes_without_a_daemon(flow, monkeypatch):
    _, town, _, _ = flow
    received, ready = [], threading.Event()
    class Process:
        def __init__(self, *args, **kwargs):
            assert args[0] == ['fake-node', 'watch'] and kwargs['env'] == {'PASEO_WS': 'fake'}
            self.stdout = self
            self.stopped = threading.Event()
        def __iter__(self):
            yield 'invalid\n'
            yield json.dumps({'t': 'ready'})
            yield json.dumps({'t': 'agent', 'agent': {'id': 'fake'}})
            ready.set()
            self.stopped.wait(3)
        def poll(self):
            return 0 if self.stopped.is_set() else None
        def terminate(self):
            self.stopped.set()
        def wait(self, timeout):
            assert self.stopped.wait(timeout)
        def close(self):
            pass
    monkeypatch.setattr(town.agents.paseo, '_link_command', lambda cmd: (['fake-node', cmd], {'PASEO_WS': 'fake'}))
    monkeypatch.setattr('papertown.paseo.subprocess.Popen', Process)
    feed = Feed(town.agents.paseo, received.append)
    try:
        assert ready.wait(2) and feed.live
        assert [line['t'] for line in received] == ['ready', 'agent']
        feed._beat -= 41
        assert not feed.live
        feed._line('{"t":"beat"}')
        assert feed.live
    finally:
        feed.close()
    assert not feed.live and not feed._thread.is_alive()


def test_feed_restarts_with_capped_backoff_without_a_real_process(flow, monkeypatch):
    _, town, _, _ = flow
    waits, processes = [], []
    class Halt:
        def is_set(self):
            return len(waits) >= 7
        def wait(self, seconds):
            waits.append(seconds)
            return self.is_set()
    class Process:
        def __init__(self, *args, **kwargs):
            self.stdout = io.StringIO('{"t":"ready"}\n')
            processes.append(self)
        def poll(self):
            return 1
        def wait(self, timeout):
            return 1
    monkeypatch.setattr(town.agents.paseo, '_link_command', lambda cmd: (['fake-node', cmd], {}))
    monkeypatch.setattr('papertown.paseo.subprocess.Popen', Process)
    feed = Feed.__new__(Feed)
    feed.paseo, feed.callback = town.agents.paseo, lambda line: None
    feed._halt, feed._lock, feed._beat, feed._process = Halt(), threading.Lock(), None, None
    feed._run()
    assert waits == [1, 2, 4, 8, 16, 30, 30]
    assert len(processes) == 7 and all(p.stdout.closed for p in processes)
    assert not feed.live


def test_sdk_endpoint_environment_and_send_behavior_use_no_real_host(flow, monkeypatch):
    _, town, _, _ = flow
    paseo = town.agents.paseo
    paseo.bin, paseo.host = 'fake-paseo', 'tcp://example.invalid:1234'
    monkeypatch.setattr('papertown.paseo._node', lambda: ['fake-node'])
    monkeypatch.setenv('PASEO_PASSWORD', 'test-password')
    cmd, env = paseo._link_command('watch')
    assert cmd[0] == 'fake-node' and cmd[-1] == 'watch'
    assert env['PASEO_WS'] == 'ws://example.invalid:1234/ws'
    assert env['PASEO_PASSWORD'] == 'test-password' and env['ELECTRON_RUN_AS_NODE'] == '1'
    calls = []
    def cli(*args, **kwargs):
        path = Path(args[args.index('--prompt-file') + 1])
        calls.append((args[args.index('--behavior') + 1], path.read_text(), path))
    monkeypatch.setattr(paseo, '_cli', cli)
    from papertown.paseo import Paseo
    Paseo.send(paseo, 'fake', 'Steer')
    Paseo.send(paseo, 'fake', 'Interrupt', 'interrupt')
    assert [(behavior, text) for behavior, text, path in calls] == [('steer', 'Steer'), ('interrupt', 'Interrupt')]
    assert all(not path.exists() for behavior, text, path in calls)


def test_live_feed_slows_reconciliation_and_fallback_restores_it(flow, monkeypatch):
    _, town, _, _ = flow
    waits = []
    feed = SimpleNamespace(live=True)
    class Halt:
        def wait(self, seconds):
            waits.append(seconds)
            return len(waits) == 2
    with monkeypatch.context() as patch:
        patch.setattr(town.agents, '_feed', feed)
        patch.setattr(town.agents, '_halt', Halt())
        patch.setattr(town.agents, 'sync_paseo', lambda: setattr(feed, 'live', False))
        town.agents._watch_paseo()
    assert waits == [20, 6]
