"""The research loop's blocks: the parts of the research flow in four rows, what belongs to each, how a block grows
with what is in it, a loop from the lanes."""
import itertools
import json

from papertown.canvas import BGAP, HEAD, INFO, INFO_MOD, PAD, _frames

from .test_canvas_agents import flow, node, task  # noqa: F401 - flow is the fixture
from .test_canvas_order import link_tasks

ORDER = ['overview', 'survey', 'code', 'exp', 'data', 'paper', 'agents']
ROWS = [['overview', 'agents'], ['survey'], ['code', 'exp', 'data'], ['paper']]


def view(client, lid):
    return client.get(f'/api/lines/{lid}/canvas').json()


def slots(client, lid):
    return {b['key']: b for b in view(client, lid)['blocks']}


def spots(client, lid):
    return {n['id']: (n['x'], n['y']) for n in view(client, lid)['nodes']}


def move(client, lid, at, **more):
    r = client.post(f'/api/lines/{lid}/canvas/move', json={'at': at, **more})
    assert r.status_code == 200, r.text
    return r.json()


def add(client, lid, **body):
    r = client.post(f'/api/lines/{lid}/canvas/nodes', json={'kind': 'task', 'to': 'coder', **body})
    assert r.status_code == 200, r.text
    return r.json()['added']


def in_rows(town, lid):
    """Every row the whole width, its blocks side by side and equally tall, each row under the one before; no frame
    on another; every node inside its block's slot."""
    d = town.canvas._load(lid)
    s, stage_of = d['blocks'], town.canvas._stage_of(lid)
    wide = max(s[row[-1]]['x'] + s[row[-1]]['w'] for row in ROWS)
    y = 0
    for row in ROWS:
        assert s[row[0]]['x'] == 0 and s[row[-1]]['x'] + s[row[-1]]['w'] == wide
        assert {(s[m]['y'], s[m]['h']) for m in row} == {(y, s[row[0]]['h'])}
        assert all(s[b]['x'] == s[a]['x'] + s[a]['w'] + 2 * PAD + BGAP for a, b in zip(row, row[1:]))
        y += s[row[0]]['h'] + HEAD + PAD + BGAP
    fr = _frames(d)
    assert not any(a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3] for a, b in itertools.combinations(fr.values(), 2))
    for n in view_nodes(town, lid):
        b = s[n['mod']]
        assert b['x'] <= n['x'] and b['y'] <= n['y'] and n['x'] + n['w'] <= b['x'] + b['w'] and n['y'] + n['h'] <= b['y'] + b['h'], n['id']
    return True


def view_nodes(town, lid):
    from papertown.canvas import _mod, _size
    d = town.canvas._load(lid)
    stage_of = town.canvas._stage_of(lid)
    return [{'id': n['id'], 'x': n['x'], 'y': n['y'], 'w': _size(n)[0], 'h': _size(n)[1], 'mod': _mod(n, stage_of)} for n in d['nodes']]


def test_the_loop_is_framed_by_the_parts_of_the_research_flow_in_four_rows(flow):
    c, town, link, lid = flow
    v = view(c, lid)
    by = {n['id']: n for n in v['nodes']}
    assert [b['key'] for b in v['blocks']] == ORDER and [b['title'] for b in v['blocks']][:3] == ['概览', '调研', '代码仓库']
    assert v['rows'] == ROWS and in_rows(town, lid)
    # one table says where a stage's work is: the console's panels and the loop's blocks read the same
    line = c.get(f'/api/lines/{lid}').json()
    assert {n['ref']: n['mod'] for n in v['nodes'] if n['kind'] == 'stage'} == {s['key']: s['mod'] for s in line['stages']}
    assert [by[k]['mod'] for k in ('stage:idea', 'stage:method', 'stage:team', 'stage:exp', 'stage:ship')] == ['survey', 'survey', 'agents', 'exp', 'paper']
    # a gate and the sentinels go with their stage; what bears on the whole project is in the overview
    assert by['gate:hatch']['mod'] == 'survey' and by['gate:exp']['mod'] == 'exp' and by['check:design']['mod'] == 'exp'
    assert {by[k]['mod'] for k in ('spec', 'clamp', 'human')} == {'overview'}
    assert by['check:design']['y'] < by['stage:exp']['y']
    # every block shows what the project has there: its cards, each as big as the view says, left of its stages
    assert {n['ref']: n['mod'] for n in v['nodes'] if n['kind'] == 'info'} == INFO_MOD and v['spare'] == []
    assert by['info:card']['w'] == 300 and by['info:agent:lead']['h'] == 76
    assert by['info:survey']['x'] < by['info:method']['x'] < by['stage:idea']['x'] and by['info:results']['x'] < by['stage:exp']['x']
    assert by['info:code']['mod'] == 'code' and by['info:datasets']['mod'] == 'data' and by['info:paper']['x'] < by['stage:write']['x']
    # the agents' stage is under their cards, next to the survey's row, where it sits in the flow
    assert by['info:agent:lead']['y'] < by['stage:team']['y'] < by['stage:method']['y']
    # a run's result comes from the code: the first layout says so with a line
    assert any((e['source'], e['target'], e.get('label')) == ('info:code', 'info:results', '跑出') for e in v['edges'])
    text = c.get(f'/api/lines/{lid}/canvas/outline').json()['text']
    assert text.index('【调研】') < text.index('- stage:idea') < text.index('【实验】') < text.index('- stage:exp') < text.index('【论文】')
    assert '- info:datasets · 资料卡 · 数据集' in text


def test_a_task_is_in_the_block_it_is_put_in_and_changes_block_when_dropped_in_another(flow):
    c, town, link, lid = flow
    slot = slots(c, lid)
    one = add(c, lid, title='写数据加载', x=slot['code']['x'] + 10, y=slot['code']['y'] + 10)
    far = add(c, lid, title='没有着落', x=slot['paper']['x'], y=slot['paper']['y'] + 5000)  # outside every frame: the nearest
    assert [task(c, lid, n)['mod'] for n in (one, far)] == ['code', 'paper']
    slot = slots(c, lid)
    # just under a block's nodes, in the gap or on the next frame's header: still the upper block, as its next row
    under = add(c, lid, title='补一组实验', x=slot['exp']['x'] + 10, y=slot['exp']['y'] + slot['exp']['h'] + 30)
    assert task(c, lid, under)['mod'] == 'exp'
    note = c.post(f'/api/lines/{lid}/canvas/nodes', json={'kind': 'note', 'text': '备注', 'x': slot['data']['x'], 'y': slot['data']['y']}).json()['added']
    assert task(c, lid, note)['mod'] == 'data'

    write = task(c, lid, 'stage:write')
    r = move(c, lid, {one: [write['x'], write['y'] + 150]})
    assert r['mods'] == {one: 'paper'} and task(c, lid, one)['mod'] == 'paper'
    write = task(c, lid, 'stage:write')
    assert move(c, lid, {one: [write['x'] + 5, write['y'] + 150]})['mods'] == {}

    # a correction goes with the sentinel that asked for it, wherever it is dragged: its block reaches to it
    fix = add(c, lid, title='补消融', x=write['x'], y=write['y'] + 300, link='check:design')
    assert task(c, lid, fix)['loop'] == 'soft' and task(c, lid, fix)['mod'] == 'exp'
    assert move(c, lid, {fix: [write['x'] + 400, write['y'] + 150]})['mods'] == {} and task(c, lid, fix)['mod'] == 'exp'
    assert in_rows(town, lid)


def test_a_block_is_as_tall_as_what_is_in_it_and_the_rows_under_it_make_room(flow):
    c, town, link, lid = flow
    first, slot = spots(c, lid), slots(c, lid)
    # a task put under the survey's stages: the survey grows by a row, and everything under it goes down by as much
    one = add(c, lid, title='补一篇综述', x=slot['survey']['x'], y=slot['survey']['y'] + slot['survey']['h'] + 20)
    now, grown = spots(c, lid), slots(c, lid)
    step = grown['survey']['h'] - slot['survey']['h']
    assert task(c, lid, one)['mod'] == 'survey' and step > 100
    assert now['stage:idea'] == first['stage:idea'] and now['info:card'] == first['info:card']
    assert all(now[k] == (first[k][0], first[k][1] + step) for k in ('stage:exp', 'info:code', 'info:datasets', 'stage:write', 'gate:ship'))
    assert grown['paper']['y'] == slot['paper']['y'] + step and in_rows(town, lid)
    # dragged further down: the answer says where the blocks now are and which other nodes went with them
    r = move(c, lid, {one: [now[one][0], now[one][1] + 60]})
    assert r['mods'] == {} and r['blocks']['survey'][3] == grown['survey']['h'] + 60 and one not in r['at']
    assert r['at']['stage:exp'] == [now['stage:exp'][0], now['stage:exp'][1] + 60] and 'stage:idea' not in r['at']
    # taken off again: the blocks are as they started
    assert c.delete(f'/api/lines/{lid}/canvas/nodes/{one}').status_code == 200
    assert spots(c, lid) == first and slots(c, lid) == slot

    # a stage dragged up out of its block stays its block's: the block starts there, and the row is that much taller
    r = move(c, lid, {'stage:exp': [first['stage:exp'][0], first['stage:exp'][1] - 300]})
    after = slots(c, lid)
    assert task(c, lid, 'stage:exp')['mod'] == 'exp' and task(c, lid, 'stage:exp')['y'] == after['exp']['y'] == slot['exp']['y']
    assert after['exp']['h'] > slot['exp']['h'] and after['code']['h'] == after['exp']['h'] and r['at']['gate:exp'][1] > first['gate:exp'][1]
    # a block that needs more room sideways takes it from the row, and the row from the others when it has none to spare
    c.post(f'/api/lines/{lid}/canvas/tidy')
    assert spots(c, lid) == first
    move(c, lid, {'stage:ship': [first['gate:ship'][0] + 1200, first['stage:ship'][1]]})
    wide = slots(c, lid)
    assert wide['paper']['w'] > slot['paper']['w'] and wide['survey']['w'] == wide['paper']['w'] and wide['data']['x'] > slot['data']['x']
    assert in_rows(town, lid)


def test_a_layout_is_put_back_whole(flow):
    c, town, link, lid = flow
    slot = slots(c, lid)
    one = add(c, lid, title='写数据加载', x=slot['code']['x'] + 10, y=slot['code']['y'] + slot['code']['h'] + 20)
    was, kept = spots(c, lid), slots(c, lid)
    write = task(c, lid, 'stage:write')
    assert move(c, lid, {one: [write['x'], write['y'] + 150]})['mods'] == {one: 'paper'}
    assert spots(c, lid)['stage:write'] != was['stage:write']  # the code's row is shorter without it
    r = move(c, lid, {k: list(xy) for k, xy in was.items()}, blocks={k: [b['x'], b['y'], b['w'], b['h']] for k, b in kept.items()})
    assert r['mods'] == {one: 'code'} and r['at'] == {} and spots(c, lid) == was and slots(c, lid) == kept


def test_a_loop_laid_out_in_lanes_moves_into_blocks_once(flow):
    c, town, link, lid = flow
    alone, written, after = node(c, lid, '跑基线'), node(c, lid, '改写引言', 'writer'), node(c, lid, '核对数字', 'writer')
    led = node(c, lid, '定方向', 'lead')
    link_tasks(c, lid, 'stage:write', written)
    assert link_tasks(c, lid, written, after)['kind'] == 'order'
    note = c.post(f'/api/lines/{lid}/canvas/nodes', json={'kind': 'note', 'text': '注意口径'}).json()['added']
    link_tasks(c, lid, note, alone)
    path = town.s.projects_dir / lid / 'canvas.json'
    d = json.loads(path.read_text())
    d['nodes'] = [n for n in d['nodes'] if n['kind'] != 'info']  # as the lanes had it: no blocks, no cards, the user's nodes along the bottom
    for i, n in enumerate(d['nodes']):
        n.pop('mod', None)
        if n['kind'] in ('task', 'note'):
            n['x'], n['y'] = i * 40, 980
    path.write_text(json.dumps({**{k: x for k, x in d.items() if k != 'blocks'}, 'v': 2}))

    v = view(c, lid)
    by = {n['id']: n for n in v['nodes']}
    assert json.loads(path.read_text())['v'] == 3 and json.loads(path.with_name('canvas.before-blocks.json').read_text())['v'] == 2
    # wired to a stage: its block; after a task that has one: the same; nothing to go by: whom it is for
    assert [by[n]['mod'] for n in (written, after, alone, led, note)] == ['paper', 'paper', 'code', 'overview', 'code']
    assert next(e for e in v['edges'] if e['source'] == written and e['target'] == after)['kind'] == 'order'
    # every block has its cards now
    assert {n['ref'] for n in v['nodes'] if n['kind'] == 'info'} == set(INFO)
    # under the paper's stages, in the order the line sets
    assert by[written]['y'] == by[after]['y'] > by['gate:write']['y'] + 96 and by[written]['x'] < by[after]['x']
    assert in_rows(town, lid)
    move(c, lid, {alone: [by[alone]['x'] + 7, by[alone]['y']]})
    assert task(c, lid, alone)['x'] == by[alone]['x'] + 7  # moved over once: the next load leaves it be


def test_tidying_puts_each_block_back_with_its_tasks_in_order(flow):
    c, town, link, lid = flow
    slot, first = slots(c, lid), spots(c, lid)
    ids = [add(c, lid, title=f'第 {i + 1} 步', x=slot['code']['x'] + 10, y=slot['code']['y'] + 10 + i * 5) for i in range(3)]
    for a, b in ((ids[2], ids[0]), (ids[0], ids[1])):  # the lines say 3, 1, 2
        link_tasks(c, lid, a, b)
    move(c, lid, {'stage:exp': [5, 5], ids[0]: [slot['code']['x'] + 400, slot['code']['y'] + 90], 'info:paper': [900, 2400]})
    assert c.delete(f'/api/lines/{lid}/canvas/nodes/info:method').status_code == 200  # a card taken off stays off
    v = c.post(f'/api/lines/{lid}/canvas/tidy').json()
    by = {n['id']: n for n in v['nodes']}
    assert all((by[k]['x'], by[k]['y']) == first[k] for k in ('stage:team', 'spec', 'human', 'info:card', 'info:survey', 'info:agent:writer'))
    assert 'info:method' not in by and [g['id'] for g in v['spare']] == ['info:method'] and by['stage:idea']['x'] < first['stage:idea'][0]
    assert [by[n]['mod'] for n in ids] == ['code'] * 3
    row = sorted(ids, key=lambda n: (by[n]['y'], by[n]['x']))
    # under the code's card, two to a row, in the order the lines set; the experiments' row is as tall as the code now
    assert row == [ids[2], ids[0], ids[1]] and by[ids[2]]['y'] > by['info:code']['y'] + by['info:code']['h'] and by[ids[0]]['y'] == by[ids[2]]['y'] < by[ids[1]]['y']
    assert (by['stage:exp']['x'], by['stage:exp']['y']) == first['stage:exp'] and (by['info:paper']['x'], by['info:paper']['y'] > first['info:paper'][1]) == (first['info:paper'][0], True)
    assert in_rows(town, lid)
