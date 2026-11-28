"""Synthetic dialogs and isolated transports only."""
import json
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from papertown.api import create_app
from teletty.prompts import parse
from .test_backends import memory_employee
from .test_terminals import setup  # noqa: F401

CLAUDE = """ Accessing workspace:
 /private/var/folders/x/T/project/code
 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not,
 take a moment to review what's in this folder first.
 Claude Code'll be able to read, edit, and execute files here.
 Security guide
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel"""
HOOKS = """  Hooks need review
  1 hook is new or changed.
  Hooks can run outside the sandbox after you trust them.
› 1. Review hooks
  2. Trust all and continue
  3. Continue without trusting (hooks won't run)
  enter confirm · esc skip"""
AGY = """Accessing workspace:
/private/var/folders/x/T/project/code
Do you trust the contents of this project?
Antigravity CLI requires permission to read, edit, and execute
files here.
> Yes, I trust this folder
  No, exit
  ↑/↓ Navigate · enter Confirm"""


@pytest.mark.parametrize('screen,choice,expected', [(HOOKS, 2, ['3']), (CLAUDE, 1, ['down', 'enter']),
    (CLAUDE.replace(' ❯ No', '   No').replace('   Yes', ' ❯ Yes'), 0, ['up', 'enter']),
    ('Choose?\n' + '\n'.join(f'{n}. Choice {n}' for n in range(1, 10)), 8, ['9']),
    (CLAUDE, 0, ['enter'])])
def test_employee_answers_and_stale_screen(tmp_path, screen, choice, expected, monkeypatch):
    town, hosted, backend, aid = memory_employee(tmp_path)
    backend.text = screen
    sent = []
    monkeypatch.setattr(backend, 'keys', lambda handle, keys: sent.append(keys))
    with patch('papertown.api.Town', return_value=town):
        app = create_app()
    client = TestClient(app)
    url = f'/api/agents/{aid}'
    shown = client.get(url + '/screen').json()
    assert shown['prompt'] == parse(screen)
    body = {'digest': shown['prompt']['digest'], 'option': choice}
    assert client.post(url + '/prompt', json=body).json() == {'ok': True}
    assert sent == [expected]
    assert client.post(url + '/prompt', json=body | {'option': -1}).status_code == 400
    assert client.post(url + '/prompt', json=body | {'option': 99}).status_code == 400
    backend.text = screen.replace('Yes', 'Allow').replace('Review hooks', 'Inspect hooks').replace('Choose?', 'Select?')
    result = client.post(url + '/prompt', json=body)
    assert result.status_code == 409 and result.json() == {'detail': '终端画面已变化，请重新查看。'}
    backend.text = 'ready\n> '
    assert client.post(url + '/prompt', json=body).status_code == 409
    assert len(sent) == 1
    town.agents.shutdown()


def test_watch_prompt_is_memory_only_and_visible_screen(tmp_path, monkeypatch):
    town, hosted, backend, aid = memory_employee(tmp_path)
    backend.text = AGY
    hosted.refresh(aid)
    a = town.agents.get(aid)
    hosted.save(a, a['term'] | {'status': 'blocked', 'reason': 'permission'})
    monkeypatch.setattr(backend, 'screen', lambda _, colours=False: 'History contains a different dialog')
    assert hosted.screen(aid)['prompt'] == parse(AGY)
    assert town.agents.public(town.agents.get(aid))['watch']['doing'] == {'kind': 'prompt', 'text': parse(AGY)['title']}
    assert 'Do you trust' not in json.dumps(town.db.q('select * from agents'))
    assert not town.db.q('select * from agent_events')
    a = town.agents.get(aid)
    hosted.save(a, a['term'] | {'status': 'idle'})
    assert hosted.screen(aid)['prompt'] is None
    assert town.agents.public(town.agents.get(aid))['watch']['doing'] is None
    town.agents.shutdown()


@pytest.mark.parametrize('screen,choice,keys', [(HOOKS, 2, ['3']), (CLAUDE, 1, ['down', 'enter']),
    (CLAUDE.replace(' ❯ No', '   No').replace('   Yes', ' ❯ Yes'), 0, ['up', 'enter'])])
def test_terminal_answers(setup, monkeypatch, screen, choice, keys):
    client, town, host = setup
    host.emit(agent_status='blocked')
    town.terminals.refresh()
    original = town.terminals.client.call
    visible = [screen]
    def call(method, params=None, *args, **kw):
        if method == 'agent.read' and params.get('source') == 'visible':
            return {'read': {'text': visible[0]}}
        return original(method, params, *args, **kw)
    monkeypatch.setattr(town.terminals.client, 'call', call)
    url = '/api/terminals/herdr:t1'
    prompt = client.get(url).json()['prompt']
    assert prompt == parse(screen)
    body = {'digest': prompt['digest'], 'option': choice}
    assert client.post(url + '/prompt', json=body).json() == {'ok': True}
    assert [p['keys'] for m, p in host.calls if m == 'agent.send_keys'] == [keys]
    assert client.post(url + '/prompt', json=body | {'option': 100}).status_code == 400
    visible[0] = 'Idle'
    assert client.post(url + '/prompt', json=body).status_code == 409
    host.emit(agent_status='idle')
    town.terminals.refresh()
    assert client.get(url).json()['prompt'] is None
