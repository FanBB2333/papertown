"""Task routing through native Paseo sessions, including identity and failure paths."""
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from papertown.api import create_app
from papertown.paseo import PaseoError
from papertown.town import Town
from .conftest import make_settings, wait_for
from .test_farm_agents import FakeLink, IDEA


class Sessions(FakeLink):
    def __init__(self):
        super().__init__()
        self.sent, self.projects, self.workspaces = [], [], []

    def project(self, path):
        self.projects.append(path)
        return f"prj-{len(self.projects)}"

    def workspace(self, project_id, path, title):
        self.workspaces.append((project_id, path, title))
        return f"wks-{len(self.workspaces)}"

    def label(self, agent_id, labels):
        super().label(agent_id, labels)
        next(c for c in self.convs if c['id'] == agent_id)['labels'] = labels

    def send(self, agent_id, text):
        self.sent.append((agent_id, text))
        next(c for c in self.convs if c['id'] == agent_id)['status'] = 'running'

    def timeline(self, agent_id, limit):
        return {"agent": next(c for c in self.convs if c['id'] == agent_id),
                "items": [{"kind": "user", "text": t} for aid, t in self.sent if aid == agent_id]}

    def idle(self):
        for conv in self.convs:
            conv['status'] = 'idle'


@pytest.fixture
def flow(tmp_path, monkeypatch):
    app = create_app(make_settings(tmp_path))
    link, town = Sessions(), app.state.town
    for name in ('project', 'workspace', 'create', 'send', 'label', 'timeline', 'permit', 'list', 'status', 'conversations', 'interrupt'):
        monkeypatch.setattr(town.agents.paseo, name, getattr(link, name))
    monkeypatch.setattr(town.agents, 'watch', lambda: None)
    with TestClient(app) as client:
        lid = client.post('/api/ideas', json={'text': IDEA}).json()['id']
        wait_for(town, lid, {'waiting'})
        yield client, town, link, lid


def node(client, lid, title='任务', role='coder'):
    response = client.post(f'/api/lines/{lid}/canvas/nodes', json={'kind': 'task', 'title': title, 'to': role})
    assert response.status_code == 200, response.text
    return response.json()['added']


def bind(client, lid, nid, **options):
    response = client.post(f'/api/lines/{lid}/canvas/nodes/{nid}/agent', json=options or {'provider': 'codex', 'model': 'test-model'})
    assert response.status_code == 200, response.text
    return next(n['agent'] for n in response.json()['nodes'] if n['id'] == nid)


def bridge(client, town, agent, path, data):
    if path == "task" and "dispatch" not in data:
        data = data | {"dispatch": task(client, agent["line_id"], data["id"])["dispatch"]}
    return client.post(f"/api/bridge/{agent['id']}/{path}", json=data,
                       headers={'x-papertown-token': town.agents.get(agent['id'])['token']})


def task(client, lid, nid):
    return next(n for n in client.get(f'/api/lines/{lid}/canvas').json()['nodes'] if n['id'] == nid)


def test_project_nodes_have_isolated_sessions_and_complete_the_loop(flow):
    c, town, link, lid = flow
    one, two = node(c, lid, '分析'), node(c, lid, '验证')
    a, b = bind(c, lid, one), bind(c, lid, two, provider='claude', model='review-model')
    assert a['id'] != b['id'] and a['ext_id'] != b['ext_id']
    assert len(link.projects) == 1 and len(link.workspaces) == 2
    assert {w[0] for w in link.workspaces} == {'prj-1'}
    assert a['workspace_id'] != b['workspace_id']
    assert link.made[0]['labels']['papertown.node'] == one
    assert 'token' not in a and 'token' not in b
    homes = [town.agents.pt(town.agents.get(x['id'])).parent for x in (a, b)]
    assert homes[0] != homes[1]
    assert [json.loads((h/'link.json').read_text())['agent'] for h in homes] == [a['id'], b['id']]
    assert not (Path(a['cwd']) / 'AGENTS.md').exists()
    assert town.agents.roster('coder')[0]['agent'] is None
    for nid in (one, two):
        assert c.post(f'/api/lines/{lid}/canvas/nodes/{nid}/send').status_code == 200
    assert not link.sent
    link.idle(); town.agents.sync_paseo()
    assert [aid for aid, _ in link.sent] == [a['ext_id'], b['ext_id']]
    assert str(homes[0] / 'pt') in link.sent[0][1]
    assert f'<task id="{one}">' in link.sent[0][1]
    wrong = bridge(c, town, b, 'task', {'id': one, 'status': 'done', 'text': '冒领'})
    assert wrong.status_code == 400 and task(c, lid, one)['status'] == 'sent'
    done = {'id': one, 'status': 'done', 'text': '分析结果 A'}
    assert bridge(c, town, a, 'task', done).status_code == 200
    reports = town.db.val('select count(*) from reports')
    assert bridge(c, town, a, 'task', done).status_code == 200
    assert town.db.val('select count(*) from reports') == reports
    assert task(c, lid, one)['result'] == '分析结果 A'
    previous_dispatch = task(c, lid, one)['dispatch']
    link.idle(); town.agents.sync_paseo()
    response = bridge(c, town, a, 'tell', {'to': f'task:{two}', 'text': '请核对分析结果 A'})
    assert response.status_code == 200, response.text
    assert link.sent[-1][0] == b['ext_id'] and '请核对分析结果 A' in link.sent[-1][1]
    assert f'节点 {one}' in link.sent[-1][1]
    assert task(c, lid, two)['status'] == 'sent'
    assert c.post(f'/api/lines/{lid}/canvas/nodes/{one}/back', json={'text': '补充依据'}).status_code == 200
    assert link.sent[-1][0] == a['ext_id'] and '分析结果 A' in link.sent[-1][1]
    assert task(c, lid, one)['status'] == 'sent'
    assert bridge(c, town, a, 'task', done | {'dispatch': previous_dispatch}).status_code == 400
    assert task(c, lid, one)['status'] == 'sent'
    assert any('请核对分析结果 A' in i['text'] for i in c.get(f"/api/agents/{b['id']}/timeline").json()['items'])
    assert c.post(f"/api/agents/{a['id']}/conversations/new").status_code == 400
    restarted = Town(town.s)
    restarted.agents.paseo.status = link.status
    assert restarted.canvas.assignee(lid, task(c, lid, one))['ext_id'] == a['ext_id']
    assert restarted.agents.get(b['id'])['workspace_id'] == b['workspace_id']


def test_import_preserves_native_location_and_rejects_other_owners(flow, tmp_path):
    c, town, link, lid = flow
    external = tmp_path / 'existing repo'
    external.mkdir()
    (external / 'AGENTS.md').write_text('Keep my guide')
    link.conv.update(cwd=str(external), workspace_id='external-workspace')
    one, two = node(c, lid), node(c, lid)
    a = bind(c, lid, one, ext_id='conv-1')
    assert a['cwd'] == str(external) and a['workspace_id'] == 'external-workspace'
    assert not link.projects and (external / 'AGENTS.md').read_text() == 'Keep my guide'
    assert c.post(f'/api/lines/{lid}/canvas/nodes/{two}/agent', json={'ext_id': 'conv-1'}).status_code == 400
    town.db.update('agents', {'id': a['id']}, ext_id='different-session')
    assert c.post(f'/api/lines/{lid}/canvas/nodes/{two}/agent', json={'ext_id': 'conv-1'}).status_code == 400
    assert task(c, lid, two)['agent_id'] is None


def test_queue_failures_retry_without_duplicate_or_cross_session_delivery(flow, monkeypatch):
    c, town, link, lid = flow
    a = bind(c, lid, node(c, lid))
    town.agents.say(a['id'], 'one', 'queue')
    town.agents.say(a['id'], 'two', 'queue')
    def fail(*args):
        raise PaseoError('connection lost')
    monkeypatch.setattr(town.agents.paseo, 'send', fail)
    link.idle(); town.agents.sync_paseo()
    queued = c.get(f"/api/agents/{a['id']}/timeline").json()['queued']
    assert len(queued) == 2 and queued[0]['data']['error'] == 'connection lost'
    monkeypatch.setattr(town.agents.paseo, 'send', link.send)
    with ThreadPoolExecutor(2) as pool:
        list(pool.map(town.agents.release, [a['id'], a['id']]))
    assert link.sent == [(a['ext_id'], 'one')]
    link.idle(); town.agents.sync_paseo()
    assert link.sent[-1] == (a['ext_id'], 'two')
    town.agents.say(a['id'], 'stale', 'queue')
    town.agents._set(a['id'], ext_id='replacement', status='idle')
    town.agents.release(a['id'])
    assert all(text != 'stale' for _, text in link.sent)
    assert any(e['data'].get('error') == '目标会话已改变，消息未发送' for e in town.agents.events(a['id']))


def test_starting_a_lead_does_not_deadlock_canvas_delivery(flow, monkeypatch):
    c, town, link, lid = flow
    a = bind(c, lid, node(c, lid))
    lead = town.agents.ensure(lid, 'lead')
    ready, starting = threading.Event(), threading.Event()
    entered, errors = threading.Event(), []
    original = town.agents._start_paseo
    def start(*args, **kwargs):
        entered.set()
        return original(*args, **kwargs)
    monkeypatch.setattr(town.agents, '_start_paseo', start)
    def deliver():
        try:
            with town.canvas._lock:
                ready.set()
                assert starting.wait(2)
                entered.wait(.2)
                town.agents.say(a['id'], 'concurrent canvas delivery')
        except Exception as e:
            errors.append(e)
    def launch():
        try:
            assert ready.wait(2)
            starting.set()
            town.agents.start(lead['id'], 'paseo', 'codex', 'test-model')
        except Exception as e:
            errors.append(e)
    threads = [threading.Thread(target=fn, daemon=True) for fn in (deliver, launch)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(3)
    assert not any(thread.is_alive() for thread in threads), 'Session creation and canvas delivery deadlocked'
    assert not errors
    assert link.sent[-1] == (a['ext_id'], 'concurrent canvas delivery')
    assert town.agents.get(lead['id'])['ext_id']


def test_session_errors_and_stale_status_cannot_fake_success(flow, monkeypatch):
    c, town, link, lid = flow
    nid = node(c, lid)
    a = bind(c, lid, nid)
    link.idle(); town.agents.sync_paseo()
    def stale(labels):
        snapshot = [dict(conv) for conv in link.convs]
        town.agents.say(a['id'], 'new turn')
        return snapshot
    monkeypatch.setattr(town.agents.paseo, 'list', stale)
    town.agents.sync_paseo()
    assert town.agents.get(a['id'])['status'] == 'working'
    def switched(agent_id, limit):
        snapshot = link.timeline(agent_id, limit)
        town.agents._set(a['id'], ext_id='replacement')
        return snapshot
    monkeypatch.setattr(town.agents.paseo, 'timeline', switched)
    response = c.get(f"/api/agents/{a['id']}/timeline")
    assert response.status_code == 400 and '会话已切换' in response.json()['detail']
    def fail():
        raise PaseoError('daemon unavailable')
    monkeypatch.setattr(town.agents.paseo, 'conversations', fail)
    assert c.get(f"/api/agents/{a['id']}/conversations").status_code == 400
    assert c.post(f'/api/lines/{lid}/canvas/nodes/{nid}/agent', json={'provider': 'claude'}).status_code == 400
    assert c.put(f'/api/lines/{lid}/canvas/nodes/{nid}', json={'to': 'writer'}).status_code == 400
    assert bridge(c, town, a, 'task', {'id': nid, 'status': 'done', 'text': 'not dispatched'}).status_code == 400


def test_failed_send_does_not_mark_task_sent_and_corrupt_canvas_is_preserved(flow, monkeypatch):
    c, town, link, lid = flow
    nid = node(c, lid)
    bind(c, lid, nid)
    link.idle(); town.agents.sync_paseo()
    def fail(*args):
        raise PaseoError('disconnected')
    monkeypatch.setattr(town.agents.paseo, 'send', fail)
    assert c.post(f'/api/lines/{lid}/canvas/nodes/{nid}/send').status_code == 400
    assert task(c, lid, nid)['status'] == 'draft'
    path = town.canvas._path(lid)
    for damaged in ('{broken', '[]', '{}'):
        path.write_text(damaged)
        response = c.get(f'/api/lines/{lid}/canvas')
        assert response.status_code == 400
        assert path.read_text() == damaged


def test_role_session_cannot_switch_with_active_tasks_or_on_failed_creation(flow, monkeypatch):
    c, town, link, lid = flow
    role = town.agents.ensure(lid, 'coder')
    a = town.agents.start(role['id'], 'paseo', 'codex', 'model')
    nid = node(c, lid)
    assert c.post(f'/api/lines/{lid}/canvas/nodes/{nid}/send').status_code == 200
    assert c.post(f"/api/agents/{a['id']}/conversations/new").status_code == 400
    link.idle(); town.agents.sync_paseo()
    bridge(c, town, a, 'task', {'id': nid, 'status': 'done', 'text': 'complete'})
    def fail(**kwargs):
        raise PaseoError('cannot create session')
    monkeypatch.setattr(town.agents.paseo, 'create', fail)
    assert c.post(f"/api/agents/{a['id']}/conversations/new").status_code == 400
    assert town.agents.get(a['id'])['ext_id'] == a['ext_id']


def test_a_session_still_starting_shows_as_starting(flow):
    c, town, link, lid = flow
    a = bind(c, lid, node(c, lid))
    next(x for x in link.convs if x['id'] == a['ext_id'])['status'] = 'initializing'
    assert c.get(f"/api/agents/{a['id']}/timeline").json()['agent']['status'] == 'starting'


def test_removing_a_bound_task_stops_its_agent_and_cuts_its_access(flow, monkeypatch):
    c, town, link, lid = flow
    nid = node(c, lid)
    a = bind(c, lid, nid)
    stopped = []
    monkeypatch.setattr(town.agents.paseo, 'interrupt', stopped.append)
    old = town.agents.get(a['id'])
    assert old['status'] == 'working'
    assert c.delete(f'/api/lines/{lid}/canvas/nodes/{nid}').status_code == 200
    assert stopped == [a['ext_id']]
    after = town.agents.get(a['id'])
    assert after['runtime'] is None and after['ext_id'] is None and after['token'] != old['token']
    denied = c.post(f"/api/bridge/{a['id']}/task", json={'id': nid, 'status': 'done', 'text': '迟到的结果'},
                    headers={'x-papertown-token': old['token']})
    assert denied.status_code == 403


def test_a_bound_task_stays_when_its_agent_cannot_be_stopped(flow, monkeypatch):
    c, town, link, lid = flow
    nid = node(c, lid)
    bind(c, lid, nid)

    def fail(ext_id):
        raise PaseoError('daemon busy')
    monkeypatch.setattr(town.agents.paseo, 'interrupt', fail)
    response = c.delete(f'/api/lines/{lid}/canvas/nodes/{nid}')
    assert response.status_code == 400 and 'daemon busy' in response.json()['detail']
    assert task(c, lid, nid)['agent']['runtime'] == 'paseo'


@pytest.mark.parametrize('args, text, dispatch', [
    (['t3', 'done', '修好了', '--dispatch', 'abc'], '修好了', 'abc'),
    (['t3', 'blocked', '--model 参数无效', '--dispatch', 'abc'], '--model 参数无效', 'abc'),
    (['t3', 'done', '用', '--seed', '3', '重跑通过', '--dispatch', 'abc'], '用 --seed 3 重跑通过', 'abc'),
    (['t3', 'done', '没有带编号'], '没有带编号', None),
])
def test_pt_task_keeps_dashes_in_the_result(args, text, dispatch):
    import importlib.util
    spec = importlib.util.spec_from_file_location('pt_cli', Path(__file__).parents[1] / 'papertown' / 'pi' / 'pt.py')
    pt = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(pt)
    rest, got = pt.task_args(args)
    assert ' '.join(rest[2:]) == text and got == dispatch


def test_the_canvas_stays_readable_while_paseo_makes_a_session(flow, monkeypatch):
    c, town, link, lid = flow
    one, two = node(c, lid, '慢的'), node(c, lid, '另一个')
    inside, go = threading.Event(), threading.Event()
    original = link.create
    def slow(**kwargs):
        inside.set()
        assert go.wait(5)
        return original(**kwargs)
    monkeypatch.setattr(town.agents.paseo, 'create', slow)
    with ThreadPoolExecutor(1) as pool:
        bound = pool.submit(bind, c, lid, one)
        assert inside.wait(5)
        assert task(c, lid, two)['status'] == 'draft'  # read while the session is being made
        same = c.post(f'/api/lines/{lid}/canvas/nodes/{one}/agent', json={'provider': 'codex'})
        assert same.status_code == 400 and '正在安排' in same.json()['detail']
        go.set()
        assert bound.result(5)['ext_id']


def test_a_task_removed_while_its_session_is_made_leaves_it_stopped(flow, monkeypatch):
    c, town, link, lid = flow
    nid = node(c, lid)
    original = link.create
    def remove_first(**kwargs):
        made = original(**kwargs)
        assert c.delete(f'/api/lines/{lid}/canvas/nodes/{nid}').status_code == 200
        return made
    monkeypatch.setattr(town.agents.paseo, 'create', remove_first)
    response = c.post(f'/api/lines/{lid}/canvas/nodes/{nid}/agent', json={'provider': 'codex'})
    assert response.status_code == 400 and '删掉' in response.json()['detail']
    agent = town.db.one('select * from agents where node_id = ?', nid)
    assert agent['ext_id'] is None and agent['status'] == 'stopped'
