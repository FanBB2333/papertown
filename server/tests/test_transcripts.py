"""Synthetic session logs only; never use developer CLI homes or hosts."""
import json
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from papertown import transcripts as tr
from papertown.api import create_app
from .conftest import make_settings
from .test_backends import memory_employee, tmux, employee, status  # noqa: F401
from .test_terminals import setup, eventually  # noqa: F401

SID = 'synthetic-session-123'
TS = '2026-11-22T01:02:03+00:00'


def write(settings, provider, records, sid=SID, full=True, day='2026/11/22'):
    home = Path(getattr(settings, provider + '_home'))
    relative = {'claude': f'projects/project/{sid}.jsonl',
                'codex': f'sessions/{day}/rollout-2026-11-22T01-02-03-{sid}.jsonl',
                'antigravity': f'brain/{sid}/.system_generated/logs/transcript{"_full" if full else ""}.jsonl'}[provider]
    path = home / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('\n'.join(json.dumps(r) for r in records) + '\n')
    return path


def claude(kind, content, **kw):
    return {'type': kind, 'timestamp': TS, 'uuid': 'synthetic-record', 'message': {'content': content}, **kw}


def codex(kind, **item):
    return {'type': 'event_msg', 'timestamp': TS, 'payload': {'type': kind, 'item': item}}


def agy(kind, index, **kw):
    return {'step_index': index, 'source': 'USER_EXPLICIT' if kind == 'USER_INPUT' else 'MODEL',
            'type': kind, 'status': 'DONE', 'created_at': TS, **kw}


def test_claude_blocks_results_interrupt_and_filtering(tmp_path):
    s = make_settings(tmp_path)
    records = [claude('user', 'Synthetic request'), claude('user', 'hidden sidechain', isSidechain=True),
        claude('user', 'hidden meta', isMeta=True), claude('system', 'hidden system'),
        claude('assistant', [{'type': 'thinking', 'thinking': 'hidden reasoning'}, {'type': 'text', 'text': 'Synthetic answer'},
                            {'type': 'tool_use', 'id': 'c1', 'name': 'Bash', 'input': {'command': 'echo\n synthetic', 'path': '/ignored'}},
                            {'type': 'tool_use', 'id': 'c2', 'name': 'Read', 'input': {'file_path': '/synthetic/file'}}]),
        claude('user', [{'type': 'tool_result', 'tool_use_id': 'c1', 'content': 'hidden output', 'is_error': False},
                        {'type': 'tool_result', 'tool_use_id': 'c2', 'content': 'hidden error', 'is_error': True}]),
        claude('user', '[Request interrupted by user for tool use]')]
    path = write(s, 'claude', records)
    result = tr.read(s, 'claude', SID)
    assert result['transcript'] == {'ok': True, 'note': None}
    items = result['items']
    assert [r['kind'] for r in items] == ['user', 'assistant', 'tool', 'tool', 'note']
    assert items[2] == {'ts': TS, 'kind': 'tool', 'id': 'c1', 'name': 'Bash', 'arg': 'echo synthetic', 'status': 'completed', 'error': None}
    assert items[3]['status'] == 'failed' and items[3]['error']
    assert items[-1]['text'] == tr.INTERRUPTED
    assert 'hidden' not in json.dumps(result)
    assert tr.read(s, 'claude', SID, limit=2)['items'] == items[-2:]
    with path.open('a') as f:
        f.write(json.dumps(claude('user', 'Read on every request')) + '\n')
    assert tr.read(s, 'claude', SID)['items'][-1]['text'] == 'Read on every request'


def test_claude_text_blocks_and_harness_records(tmp_path):
    # a message with something attached arrives as blocks, as does the interruption marker
    s = make_settings(tmp_path)
    write(s, 'claude', [
        claude('user', [{'type': 'text', 'text': 'Synthetic request with a picture'}, {'type': 'image', 'source': {'data': 'hidden bytes'}}]),
        claude('user', '<command-name>/model</command-name>\n<command-args>hidden</command-args>'),
        claude('user', '<local-command-stdout>hidden output</local-command-stdout>'),
        claude('user', '<task-notification>hidden notice</task-notification>'),
        claude('user', '<p>typed markup stays</p>'),
        claude('user', [{'type': 'text', 'text': '[Request interrupted by user]'}])])
    result = tr.read(s, 'claude', SID)
    assert [(r['kind'], r['text']) for r in result['items']] == [
        ('user', 'Synthetic request with a picture'), ('user', '<p>typed markup stays</p>'), ('note', tr.INTERRUPTED)]
    assert 'hidden' not in json.dumps(result)


def test_codex_events_tools_and_duplicates(tmp_path):
    s = make_settings(tmp_path)
    rows = [codex('item_completed', type='UserMessage', content=[{'type': 'text', 'text': 'Synthetic request'}]),
        codex('item_completed', type='AgentMessage', phase='commentary', content=[{'type': 'Text', 'text': 'Synthetic progress'}]),
        codex('item_started', type='CommandExecution', id='cmd-1', command=['echo', 'synthetic']),
        codex('item_completed', type='CommandExecution', id='cmd-1', command=['echo', 'synthetic'], status='completed', exit_code=0),
        codex('item_completed', type='CommandExecution', id='cmd-2', parsed_cmd=[{'cmd': 'false'}], status='completed', exit_code=1),
        codex('item_started', type='CommandExecution', id='cmd-3', command=['sleep', '1']),
        codex('item_completed', type='AgentMessage', phase='final_answer', content=[{'type': 'Text', 'text': 'Synthetic final'}]),
        codex('turn_aborted'), {'type': 'response_item', 'timestamp': TS, 'payload': {'text': 'hidden duplicate'}},
        {'type': 'turn_context', 'timestamp': TS, 'payload': {'instructions': 'hidden'}}]
    write(s, 'codex', rows)
    result = tr.read(s, 'codex', SID, started='2026-11-22T00:00:00Z')
    assert [r['kind'] for r in result['items']] == ['user', 'assistant', 'tool', 'tool', 'tool', 'assistant', 'note']
    tools = [r for r in result['items'] if r['kind'] == 'tool']
    assert [r['status'] for r in tools] == ['completed', 'failed', 'running']
    assert [r['arg'] for r in tools] == ['echo synthetic', 'false', 'sleep 1']
    assert all(r['name'] == 'shell' for r in tools)
    assert 'hidden' not in json.dumps(result)


def test_antigravity_wrappers_tools_and_fallback(tmp_path):
    s = make_settings(tmp_path)
    rows = [agy('USER_INPUT', 0, content='<USER_REQUEST>\nSynthetic request\n</USER_REQUEST>\n<ADDITIONAL_METADATA>hidden</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>hidden</USER_SETTINGS_CHANGE>'),
        agy('SYSTEM_MESSAGE', 1, source='SYSTEM', content='hidden system'),
        agy('PLANNER_RESPONSE', 2, content='Synthetic answer', thinking='hidden reasoning', tool_calls=[
            {'name': 'run', 'args': {'CommandLine': 'echo synthetic'}}, {'name': 'read', 'args': {'Path': '/synthetic'}}]),
        agy('GENERIC', 3, status='RUNNING', content='hidden output')]
    path = write(s, 'antigravity', rows, full=False)
    items = tr.read(s, 'antigravity', SID)['items']
    assert items[0]['text'] == 'Synthetic request'
    assert [r['id'] for r in items if r['kind'] == 'tool'] == ['2:0', '2:1']
    assert [r['status'] for r in items if r['kind'] == 'tool'] == ['running', 'running']
    rows += [agy('GENERIC', 3, content='hidden result'), agy('PLANNER_RESPONSE', 4, tool_calls=[{'name': 'search', 'args': {'Query': 'synthetic'}}])]
    write(s, 'antigravity', rows)
    items = tr.read(s, 'antigravity', SID)['items']
    assert [r['status'] for r in items if r['kind'] == 'tool'] == ['completed', 'completed', 'running']
    assert 'hidden' not in json.dumps(items)
    assert path.exists()


@pytest.mark.parametrize('provider', ['claude', 'codex', 'antigravity'])
def test_bad_records_never_fail_and_caps(tmp_path, provider):
    s = make_settings(tmp_path)
    rows = {'claude': [claude('user', 'x' * 21000), claude('assistant', [{'type': 'tool_use', 'id': 'x', 'name': 'test', 'input': {'prompt': 'y\n' * 300}}])],
        'codex': [codex('item_completed', type='AgentMessage', content=[{'type': 'Text', 'text': 'x' * 21000}]), codex('item_completed', type='CommandExecution', id='x', command=['y\n' * 300], exit_code=0)],
        'antigravity': [agy('PLANNER_RESPONSE', 0, content='x' * 21000, tool_calls=[{'name': 'test', 'args': {'Path': 'y\n' * 300}}])]}[provider]
    path = write(s, provider, rows)
    with path.open('ab') as f:
        f.write(b'bad json\n[]\nnull\n{"timestamp": 99}\n{"timestamp":"bad"}\n\xff\n')
        f.write(json.dumps({'timestamp': TS, 'type': 'assistant', 'message': 1}).encode() + b'\n')
    items = tr.read(s, provider, SID)['items']
    assert len(items) == 2 and len(items[0]['text']) == 20000 and items[0]['text'].endswith('…')
    assert len(items[1]['arg']) == 160 and '\n' not in items[1]['arg']


def test_tail_bound_and_partial_line(tmp_path):
    s = make_settings(tmp_path)
    path = write(s, 'claude', [])
    path.write_bytes(json.dumps(claude('user', 'old')).encode() + b'\n' + b'x' * tr.MAX_BYTES + b'\n' + json.dumps(claude('user', 'new')).encode() + b'\n')
    assert tr.read(s, 'claude', SID)['items'] == [{'ts': TS, 'kind': 'user', 'text': 'new'}]
    assert sum(map(len, tr.tail(path, Path(s.claude_home)))) < tr.MAX_BYTES


@pytest.mark.parametrize('sid', ['../escape', 'short', 'a' * 129, '/tmp/abcdefgh', 'abc.defgh', 'abcdefg\n', 'abcdefg/', 'abcdefgh\x00'])
def test_invalid_session_ids(tmp_path, sid, monkeypatch):
    s = make_settings(tmp_path)
    monkeypatch.setattr(tr, 'locate', lambda *args: pytest.fail('invalid session reached disk'))
    assert tr.read(s, 'claude', sid) == {'items': [], 'transcript': {'ok': False, 'note': tr.MISSING}}


def test_missing_disabled_unreadable_and_symlinks(tmp_path, monkeypatch):
    s = make_settings(tmp_path)
    assert tr.read(s, 'claude', None)['transcript']['note'] == tr.UNESTABLISHED
    assert tr.read(s, 'claude', SID)['transcript']['note'] == tr.MISSING
    s.transcripts = False
    assert tr.read(s, 'claude', SID)['transcript']['note'] == tr.DISABLED
    s.transcripts = True
    path = write(s, 'claude', [claude('user', 'synthetic')])
    target = path.with_name('elsewhere.jsonl')
    path.rename(target)
    path.symlink_to(target)
    assert not tr.read(s, 'claude', SID)['transcript']['ok']
    path.unlink()
    target.rename(path)
    folder = path.parent
    real = tmp_path / 'outside-cli-home'; folder.rename(real); folder.symlink_to(real, target_is_directory=True)
    assert not tr.read(s, 'claude', SID)['transcript']['ok']
    folder.unlink(); real.rename(folder)
    with monkeypatch.context() as m:
        m.setattr(tr, 'tail', lambda *a: (_ for _ in ()).throw(PermissionError()))
        assert not tr.read(s, 'claude', SID)['transcript']['ok']
    # A symlink swapped in after discovery is refused by descriptor-relative opening.
    path.rename(target); path.symlink_to(target)
    with pytest.raises(OSError):
        tr.tail(path, Path(s.claude_home))


def test_codex_near_day_then_cached_fallback(tmp_path, monkeypatch):
    s = make_settings(tmp_path)
    write(s, 'codex', [codex('turn_aborted')], day='2026/11/21')
    original, calls = Path.glob, []
    def glob(path, pattern):
        calls.append(pattern)
        return original(path, pattern)
    monkeypatch.setattr(Path, 'glob', glob)
    assert tr.read(s, 'codex', SID, started='2026-11-22T00:00:00Z')['transcript']['ok']
    assert not any('*/*/*/' in c for c in calls)
    calls.clear()
    assert tr.read(s, 'codex', SID)['transcript']['ok'] and not calls
    write(s, 'codex', [codex('turn_aborted')], sid='distant-session', day='2020/01/01')
    assert tr.read(s, 'codex', 'distant-session')['transcript']['ok']
    assert sum('*/*/*/' in c for c in calls) == 1
    calls.clear()
    assert tr.read(s, 'codex', 'distant-session')['transcript']['ok'] and not calls


@pytest.mark.parametrize('runtime', ['tmux', 'herdr'])
def test_employee_timeline_endpoint_and_no_persistence(tmp_path, monkeypatch, runtime):
    town, hosted, backend, aid = memory_employee(tmp_path)
    hosted.backends[runtime] = backend
    town.agents._set(aid, runtime=runtime)
    town.agents._remember_session(town.agents.get(aid), {'provider': 'claude', 'session_id': SID})
    write(town.s, 'claude', [claude('user', 'synthetic-private-request'), claude('assistant', [{'type': 'text', 'text': 'synthetic-private-answer'}])])
    held = town.agents.record(aid, 'user', {'held': True, 'text': 'held synthetic request'})
    events = []
    monkeypatch.setattr(town.bus, 'publish', lambda *a, **kw: events.append((a, kw)))
    monkeypatch.setattr(town, 'trace', lambda *a, **kw: events.append((a, kw)))
    with patch('papertown.api.Town', return_value=town):
        app = create_app()
    client = TestClient(app)
    data = client.get(f'/api/agents/{aid}/timeline?limit=1').json()
    assert set(data) == {'agent', 'items', 'queued', 'paseo', 'transcript'}
    assert data['queued'] == [held] and data['paseo'] == {}
    assert data['items'] == [{'ts': TS, 'kind': 'assistant', 'text': 'synthetic-private-answer'}]
    assert data['transcript'] == {'ok': True, 'note': None}
    assert data['agent']['term']['status'] == hosted.refresh(aid)['term']['status']
    assert 'synthetic-private' not in json.dumps(events)
    assert 'synthetic-private' not in '\n'.join(town.db.conn.iterdump())
    town.agents.shutdown()


def test_isolated_tmux_timeline(tmux):
    town, hosted, _ = tmux
    aid = employee(town)['id']
    town.agents.start(aid, 'tmux', 'claude')
    eventually(lambda: status(hosted, aid) in ('idle', 'done'))
    sid = town.agents.get(aid)['session_id']
    write(town.s, 'claude', [claude('user', 'Synthetic tmux log')], sid=sid)
    with patch('papertown.api.Town', return_value=town):
        app = create_app()
    data = TestClient(app).get(f'/api/agents/{aid}/timeline').json()
    assert data['items'][0]['text'] == 'Synthetic tmux log'
    assert data['agent']['runtime'] == 'tmux' and data['transcript']['ok']


@pytest.mark.parametrize('saved_id', ['herdr:t1', 't1'])
def test_herdr_terminal_timeline_and_session_fallback(setup, saved_id):
    client, town, host = setup
    url = '/api/terminals/herdr:t1/timeline'
    assert client.get(url).json()['transcript']['note'] == tr.NO_TERMINAL
    host.emit(agent='agy', agent_session={'kind': 'id', 'value': SID})
    town.terminals.refresh()
    write(town.s, 'antigravity', [agy('USER_INPUT', 0, content='Synthetic terminal request')])
    result = client.get(url).json()
    assert set(result) == {'terminal', 'items', 'transcript'}
    assert result['terminal'] == client.get('/api/terminals/herdr:t1').json()['terminal']
    assert result['items'][0]['text'] == 'Synthetic terminal request'
    assert result['transcript'] == {'ok': True, 'note': None}
    town.db.x('insert into terminal_sessions values (?, ?, ?, ?, ?)', SID, 'antigravity', saved_id, 'Synthetic terminal', '/synthetic')
    host.emit(agent_session={'kind': 'unknown'})
    town.terminals.refresh()
    assert client.get(url).json()['items'] == result['items']
    host.emit(agent_session={'kind': 'id', 'value': 'another-session'})
    town.terminals.refresh()
    assert client.get(url).json()['transcript']['note'] == tr.MISSING
    assert 'Synthetic terminal request' not in '\n'.join(town.db.conn.iterdump())


def test_paseo_contract_keeps_existing_items_even_when_file_reads_disabled(tmp_path, monkeypatch):
    town, _, _, aid = memory_employee(tmp_path)
    town.agents._set(aid, runtime='paseo', ext_id='synthetic-paseo', term=None)
    town.s.transcripts = False
    snapshot = {'id': 'synthetic-paseo', 'provider': 'claude', 'status': 'idle', 'updated': TS}
    items = [{'ts': TS, 'kind': 'user', 'text': 'Synthetic Paseo request'}]
    monkeypatch.setattr(town.agents.paseo, 'status', lambda: {'ok': True, 'note': ''})
    monkeypatch.setattr(town.agents.paseo, 'timeline', lambda ext, limit: {'agent': snapshot, 'items': items})
    data = town.agents.timeline(aid)
    assert data == {'agent': town.agents.public(town.agents.get(aid)), 'items': items, 'queued': [],
                    'paseo': snapshot, 'transcript': {'ok': True, 'note': None}}
    town.agents.shutdown()


def test_transcripts_setting_environment(tmp_path, monkeypatch):
    monkeypatch.delenv('PAPERTOWN_TRANSCRIPTS', raising=False)
    assert make_settings(tmp_path).transcripts
    monkeypatch.setenv('PAPERTOWN_TRANSCRIPTS', '0')
    assert not make_settings(tmp_path).transcripts


def test_missing_codex_log_retries_without_polling_entire_history(tmp_path, monkeypatch):
    s = make_settings(tmp_path)
    original, calls = Path.glob, []
    def glob(path, pattern):
        calls.append(pattern)
        return original(path, pattern)
    monkeypatch.setattr(Path, 'glob', glob)
    assert not tr.read(s, 'codex', SID)['transcript']['ok']
    assert sum('*/*/*/' in c for c in calls) == 1
    calls.clear()
    assert not tr.read(s, 'codex', SID)['transcript']['ok'] and not calls
    write(s, 'codex', [codex('turn_aborted')])
    original_clock = tr.time.monotonic
    monkeypatch.setattr(tr.time, 'monotonic', lambda: original_clock() + 6)
    assert tr.read(s, 'codex', SID)['transcript']['ok']


@pytest.mark.parametrize('provider', ['claude', 'codex', 'antigravity'])
def test_outside_symlink_and_nonregular_file_refused(tmp_path, provider):
    s = make_settings(tmp_path)
    path = write(s, provider, [])
    target = tmp_path / 'outside.jsonl'
    path.rename(target)
    path.symlink_to(target)
    assert not tr.read(s, provider, SID)['transcript']['ok']
    path.unlink()
    path.mkdir()
    assert not tr.read(s, provider, SID)['transcript']['ok']


def test_timestamp_order_and_claude_argument_priority(tmp_path):
    s = make_settings(tmp_path)
    rows = [claude('user', 'Later', timestamp='2026-11-22T11:00:00+08:00'),
            claude('user', 'Earlier', timestamp='2026-11-22T02:00:00Z')]
    for n, key in enumerate(('command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt')):
        rows.append(claude('assistant', [{'type': 'tool_use', 'id': f'tool-{n}', 'name': 'SyntheticTool', 'input': {key: key}}]))
    rows.append(claude('assistant', [{'type': 'tool_use', 'id': 'fallback', 'name': 'SyntheticTool', 'input': {'value': 1}}]))
    write(s, 'claude', rows)
    items = tr.read(s, 'claude', SID)['items']
    assert [i['text'] for i in items if i['kind'] == 'user'] == ['Earlier', 'Later']
    assert [i['arg'] for i in items if i['kind'] == 'tool'] == ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt', '{"value":1}']
