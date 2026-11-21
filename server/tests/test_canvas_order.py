"""The order of tasks, kept in code: order lines, the queue, relay, a stuck task, redone work, one task per directory."""
import json

from .test_canvas_agents import bind, bridge, flow, node, task  # noqa: F401 - flow is the fixture


def link_tasks(client, lid, source, target):
    r = client.post(f'/api/lines/{lid}/canvas/edges', json={'source': source, 'target': target})
    assert r.status_code == 200, r.text
    return next(e for e in r.json()['edges'] if {e['source'], e['target']} == {source, target})


def send(client, lid, nid, **body):
    r = client.post(f'/api/lines/{lid}/canvas/nodes/{nid}/send', json=body or None)
    assert r.status_code == 200, r.text
    return r.json()


def flush(town, link):
    """The sessions finish their turn, and what was held for them goes out."""
    link.idle()
    town.agents.sync_paseo()


def chain(client, lid, n=3):
    ids = [node(client, lid, f'第 {i + 1} 步') for i in range(n)]
    agents = [bind(client, lid, nid) for nid in ids]
    for a, b in zip(ids, ids[1:]):
        assert link_tasks(client, lid, a, b)['kind'] == 'order'
    return ids, agents


def done(client, town, agent, nid, text='做完了'):
    r = bridge(client, town, agent, 'task', {'id': nid, 'status': 'done', 'text': text})
    assert r.status_code == 200, r.text


def test_tasks_go_out_in_the_order_the_lines_set(flow):
    c, town, link, lid = flow
    (one, two, three), (a, b, x) = chain(c, lid)
    view = send(c, lid, one, chain=True)
    assert [task(c, lid, n)['status'] for n in (one, two, three)] == ['sent', 'queued', 'queued']
    assert view['tasks']['queued'] == 2
    assert [w['id'] for w in task(c, lid, two)['waits']] == [one] and task(c, lid, two)['waits'][0]['kind'] == 'after'
    flush(town, link)
    assert [ext for ext, _ in link.sent] == [a['ext_id']]
    assert '后续任务' in link.sent[0][1] and f'{two}「第 2 步」（给代码员工，排队中）' in link.sent[0][1]
    late = bridge(c, town, b, 'task', {'id': two, 'status': 'done', 'text': '抢跑', 'dispatch': None})
    assert late.status_code == 400 and task(c, lid, two)['status'] == 'queued'

    done(c, town, a, one, '产出写在 out/step1.md')
    assert [task(c, lid, n)['status'] for n in (one, two, three)] == ['done', 'sent', 'queued']
    flush(town, link)
    assert link.sent[-1][0] == b['ext_id']
    assert '前序任务' in link.sent[-1][1] and '产出写在 out/step1.md' in link.sent[-1][1]
    assert any(e['kind'] == 'relay' for e in task(c, lid, two)['log'])

    done(c, town, b, two)
    flush(town, link)
    assert link.sent[-1][0] == x['ext_id'] and task(c, lid, three)['status'] == 'sent'
    done(c, town, x, three)
    assert [task(c, lid, n)['status'] for n in (one, two, three)] == ['done', 'done', 'done']
    assert len(link.sent) == 3


def test_a_chain_is_not_started_with_an_agent_missing(flow):
    c, town, link, lid = flow
    one, two = node(c, lid, '有 Agent'), node(c, lid, '还没有 Agent')
    bind(c, lid, one)
    link_tasks(c, lid, one, two)
    r = c.post(f'/api/lines/{lid}/canvas/nodes/{one}/send', json={'chain': True})
    assert r.status_code == 400 and two in r.json()['detail']
    assert [task(c, lid, n)['status'] for n in (one, two)] == ['draft', 'draft']


def test_a_stuck_task_holds_what_follows_and_says_so(flow):
    c, town, link, lid = flow
    (one, two), (a, b) = chain(c, lid, 2)
    send(c, lid, two)
    assert task(c, lid, two)['status'] == 'queued'
    send(c, lid, one)
    flush(town, link)
    assert bridge(c, town, a, 'task', {'id': one, 'status': 'blocked', 'text': '缺数据'}).status_code == 200
    assert task(c, lid, two)['status'] == 'queued' and task(c, lid, two)['waits'][0]['status'] == 'blocked'
    report = json.loads(town.db.val('select data from reports order by id desc limit 1'))
    assert '第 2 步' in json.dumps(report, ensure_ascii=False)
    assert c.post(f'/api/lines/{lid}/canvas/nodes/{one}/back', json={'text': '数据在 data/ 里'}).status_code == 200
    assert task(c, lid, one)['status'] == 'sent'
    flush(town, link)
    done(c, town, a, one)
    assert task(c, lid, two)['status'] == 'sent'


def test_redone_work_marks_what_ran_after_it_and_holds_its_followers(flow):
    c, town, link, lid = flow
    (one, two, three), (a, b, x) = chain(c, lid)
    send(c, lid, one, chain=True)
    flush(town, link)
    done(c, town, a, one)
    flush(town, link)
    done(c, town, b, two)
    flush(town, link)
    assert task(c, lid, three)['status'] == 'sent'
    assert c.post(f'/api/lines/{lid}/canvas/nodes/{one}/back', json={'text': '口径错了，重算'}).status_code == 200
    assert one in task(c, lid, two)['stale'] and task(c, lid, two)['status'] == 'done'
    assert task(c, lid, three)['stale'] and task(c, lid, three)['status'] == 'sent'
    human = next(n for n in c.get(f'/api/lines/{lid}/canvas').json()['nodes'] if n['kind'] == 'human')
    assert [i['id'] for i in human['items'] if i['kind'] == 'stale'] == [two]

    four = node(c, lid, '第 4 步')
    bind(c, lid, four)
    link_tasks(c, lid, two, four)
    flush(town, link)
    done(c, town, a, one, '重算好了')
    send(c, lid, four)
    wait = task(c, lid, four)
    assert wait['status'] == 'queued' and wait['waits'][0]['id'] == two and wait['waits'][0]['stale']
    assert c.put(f'/api/lines/{lid}/canvas/nodes/{two}', json={'stale': False}).status_code == 200
    assert not task(c, lid, two)['stale'] and task(c, lid, four)['status'] == 'sent'
    assert any(e['kind'] == 'kept' for e in task(c, lid, two)['log'])


def test_order_lines_cannot_close_a_ring_and_can_be_turned_or_made_plain(flow):
    c, town, link, lid = flow
    (one, two, three), _ = chain(c, lid)
    back = link_tasks(c, lid, three, one)
    assert back.get('kind') is None  # drawn, but plain: it would close the ring
    r = c.put(f"/api/lines/{lid}/canvas/edges/{back['id']}", json={'order': True})
    assert r.status_code == 400 and '环' in r.json()['detail']
    first = next(e for e in c.get(f'/api/lines/{lid}/canvas').json()['edges'] if e['source'] == one and e['target'] == two)
    turned = c.put(f"/api/lines/{lid}/canvas/edges/{first['id']}", json={'flip': True}).json()
    e = next(x for x in turned['edges'] if x['id'] == first['id'])
    assert (e['source'], e['target'], e['kind']) == (two, one, 'order')
    plain = c.put(f"/api/lines/{lid}/canvas/edges/{first['id']}", json={'order': False, 'label': '只是参考'}).json()
    e = next(x for x in plain['edges'] if x['id'] == first['id'])
    assert e.get('kind') is None and e['label'] == '只是参考'
    note = c.post(f'/api/lines/{lid}/canvas/nodes', json={'kind': 'note', 'text': '备注'}).json()['added']
    loose = link_tasks(c, lid, one, note)
    assert loose.get('kind') is None
    assert c.put(f"/api/lines/{lid}/canvas/edges/{loose['id']}", json={'order': True}).status_code == 400


def test_a_plain_line_or_a_cut_one_lets_the_queued_task_go(flow):
    c, town, link, lid = flow
    (one, two), _ = chain(c, lid, 2)
    send(c, lid, two)
    assert task(c, lid, two)['status'] == 'queued'
    edge = next(e for e in c.get(f'/api/lines/{lid}/canvas').json()['edges'] if e.get('kind') == 'order')
    assert c.put(f"/api/lines/{lid}/canvas/edges/{edge['id']}", json={'order': False}).status_code == 200
    assert task(c, lid, two)['status'] == 'sent'


def test_a_queued_task_can_be_taken_out_of_the_queue(flow):
    c, town, link, lid = flow
    (one, two), (a, b) = chain(c, lid, 2)
    send(c, lid, one, chain=True)
    assert c.put(f'/api/lines/{lid}/canvas/nodes/{two}', json={'status': 'draft'}).status_code == 200
    assert task(c, lid, two)['status'] == 'draft'
    flush(town, link)
    done(c, town, a, one)
    assert task(c, lid, two)['status'] == 'draft' and len(link.sent) == 1


def test_one_task_per_working_directory_when_the_project_asks(flow):
    c, town, link, lid = flow
    one, two = node(c, lid, '甲'), node(c, lid, '乙')
    a, b = bind(c, lid, one), bind(c, lid, two)
    assert a['cwd'] == b['cwd']
    view = c.put(f'/api/lines/{lid}/canvas/rules', json={'exclusive': True}).json()
    assert view['rules'] == {'exclusive': True}
    send(c, lid, one)
    send(c, lid, two)
    wait = task(c, lid, two)
    assert wait['status'] == 'queued' and wait['waits'] == [{'kind': 'dir', 'id': one, 'title': '甲', 'status': 'sent', 'stale': False}]
    flush(town, link)
    done(c, town, a, one)
    assert task(c, lid, two)['status'] == 'sent'
    three = node(c, lid, '丙')
    bind(c, lid, three)
    send(c, lid, three)
    assert task(c, lid, three)['status'] == 'queued'
    assert c.put(f'/api/lines/{lid}/canvas/rules', json={'exclusive': False}).status_code == 200
    assert task(c, lid, three)['status'] == 'sent'


def test_a_task_drawn_from_a_task_follows_it_and_the_outline_says_so(flow):
    c, town, link, lid = flow
    one = node(c, lid, '先做')
    r = c.post(f'/api/lines/{lid}/canvas/nodes', json={'kind': 'task', 'title': '后做', 'to': 'coder', 'link': one})
    two = r.json()['added']
    edge = next(e for e in r.json()['edges'] if e['source'] == one and e['target'] == two)
    assert edge['kind'] == 'order'
    assert f'{one} → {two}（先后顺序）' in c.get(f'/api/lines/{lid}/canvas/outline').json()['text']


def test_a_chain_sent_from_a_finished_task_still_waits_for_it(flow):
    c, town, link, lid = flow
    one, two = node(c, lid, '已经做过'), node(c, lid, '后来加的')
    a, b = bind(c, lid, one), bind(c, lid, two)
    send(c, lid, one)
    flush(town, link)
    done(c, town, a, one, '第一版')
    link_tasks(c, lid, one, two)
    send(c, lid, one, chain=True)  # done again, with what follows queued behind it
    assert [task(c, lid, n)['status'] for n in (one, two)] == ['sent', 'queued']
    flush(town, link)
    assert [ext for ext, _ in link.sent] == [a['ext_id'], a['ext_id']]
    done(c, town, a, one, '第二版')
    flush(town, link)
    assert task(c, lid, two)['status'] == 'sent' and '第二版' in link.sent[-1][1]
