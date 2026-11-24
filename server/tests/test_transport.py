import asyncio
import subprocess

import httpx
import pytest

from papertown.paseo import Paseo, PaseoError
from papertown.tui.client import Api, ApiError


@pytest.mark.parametrize(('host', 'listen', 'expected'), [
    ('', '127.0.0.1:7777', 'ws://127.0.0.1:7777/ws'),
    ('ws://localhost:8888/ws', '127.0.0.1:6767', 'ws://localhost:8888/ws'),
    ('tcp://localhost:8888', None, 'ws://localhost:8888/ws'),
    ('wss://example.test/ws', None, 'wss://example.test/ws'),
])
def test_sdk_uses_the_configured_daemon_endpoint(monkeypatch, tmp_path, host, listen, expected):
    import papertown.paseo as module

    (tmp_path / 'node_modules/@getpaseo/client').mkdir(parents=True)
    monkeypatch.setattr(module, 'LINK', tmp_path)
    monkeypatch.setattr(module, '_node', lambda explicit='': ['node'])
    p = Paseo('/bin/echo', host=host)
    monkeypatch.setattr(p, 'status', lambda: {'ok': True, 'listen': listen})
    def run(args, **kwargs):
        assert kwargs['env']['PASEO_WS'] == expected
        return subprocess.CompletedProcess(args, 0, '[]', '')
    monkeypatch.setattr(subprocess, 'run', run)
    assert p._link('list') == []


@pytest.mark.parametrize('payload', ['', 'not json', '{"error":{"message":"failed"}}'])
def test_paseo_does_not_accept_empty_malformed_or_error_responses(monkeypatch, payload):
    p = Paseo('/bin/echo')
    monkeypatch.setattr(subprocess, 'run', lambda *args, **kwargs: subprocess.CompletedProcess(args, 0, payload, ''))
    with pytest.raises(PaseoError):
        p._cli('status')


def test_tui_reports_transport_and_invalid_json_failures():
    async def run():
        async def broken(request):
            raise httpx.ConnectError('connection lost')
        api = Api('http://local', httpx.MockTransport(broken))
        try:
            with pytest.raises(ApiError, match='connection lost'):
                await api.get('/api/world')
        finally:
            await api.close()
        api = Api('http://local', httpx.MockTransport(lambda request: httpx.Response(200, text='broken')))
        try:
            with pytest.raises(ApiError, match='JSON'):
                await api.get('/api/world')
        finally:
            await api.close()
    asyncio.run(run())


def test_one_provider_without_models_leaves_the_others_and_is_asked_again(monkeypatch):
    p = Paseo('/bin/echo')
    calls = []

    def cli(*args, timeout=30):
        calls.append(args)
        if args == ('provider', 'ls'):
            return [{'provider': 'claude', 'status': 'available'}, {'provider': 'codex', 'status': 'available'}]
        if args == ('provider', 'models', 'codex'):
            raise PaseoError('paseo provider 超时')
        return [{'id': 'm1', 'model': 'Model 1'}]
    monkeypatch.setattr(p, '_cli', cli)
    rows = {r['id']: r for r in p.providers()}
    assert [m['id'] for m in rows['claude']['models']] == ['m1'] and rows['claude']['error'] is None
    assert rows['codex']['models'] == [] and '超时' in rows['codex']['error']
    p.providers()
    assert calls.count(('provider', 'ls')) == 2  # not kept while a provider failed


@pytest.mark.parametrize(('stderr', 'fails'), [
    ('', False),  # idle, or stopped
    ('Warning: Failed to stop agent pa-1: daemon refused', True),
])
def test_a_stop_paseo_could_not_do_is_a_failure(monkeypatch, stderr, fails):
    p = Paseo('/bin/echo')
    monkeypatch.setattr(subprocess, 'run', lambda args, **kw: subprocess.CompletedProcess(args, 0, '{"stoppedCount": 0, "agentIds": []}', stderr))
    if fails:
        with pytest.raises(PaseoError, match='daemon refused'):
            p.interrupt('pa-1')
    else:
        p.interrupt('pa-1')
