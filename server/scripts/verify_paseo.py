"""Opt-in live smoke test: two native Paseo agents exchange a nonce and close canvas tasks.

Run from server/: .venv/bin/python scripts/verify_paseo.py --provider codex [--model ...]
Uses a temporary Papertown project; archives only the Paseo project it created on exit.
"""
import argparse
import json
import socket
import tempfile
import threading
import time
import uuid
from pathlib import Path

import httpx
import uvicorn

from papertown.api import create_app
from papertown.config import Settings
from papertown.paseo import APP_CLI


def main():
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument('--provider', required=True)
    args.add_argument('--model')
    args.add_argument('--timeout', type=int, default=240)
    opts = args.parse_args()
    root = Path(tempfile.mkdtemp(prefix='papertown-live-paseo-'))
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    settings = Settings(lead_resident=False, data_dir=root, samples=False, arxiv_port=False, compile_tex=False,
                        paseo_bin=APP_CLI, paseo_watch=0, lead_tick=3600, url=f'http://127.0.0.1:{port}',
                        nvidb_bin=str(root/'no-nvidb'), skim_bin=str(root/'no-skim'), pi_bin=str(root/'no-pi'),
                        claude_home=str(root/'no-claude'), codex_home=str(root/'no-codex'))
    app = create_app(settings)
    town = app.state.town
    server = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=port, log_level='warning'))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    while not server.started:
        time.sleep(.05)
    lid = None
    report = {'root': str(root), 'url': settings.url, 'provider': opts.provider, 'model': opts.model, 'passed': False}
    print(json.dumps(report), flush=True)
    try:
        with httpx.Client(base_url=settings.url, timeout=120) as client:
            def post(path, data=None):
                r = client.post(path, json=data)
                r.raise_for_status()
                return r.json()
            lid = post('/api/ideas', {'text': 'Paseo 节点通信连通性验证。不做研究，不修改代码，不运行实验'})['id']
            base = f'/api/lines/{lid}/canvas/nodes'
            first = post(base, {'kind': 'task', 'title': '传递验证信息', 'to': 'coder'})['added']
            second = post(base, {'kind': 'task', 'title': '确认验证信息', 'to': 'coder'})['added']
            agents = []
            for nid in (first, second):
                view = post(f'{base}/{nid}/agent', {'provider': opts.provider, 'model': opts.model})
                agents.append(next(n['agent'] for n in view['nodes'] if n['id'] == nid))
            nonce = 'PASEO_FLOW_' + uuid.uuid4().hex
            instructions = [
                f'这是一次连通性测试，不做其他工作。用任务末尾给你的 pt 命令执行 tell task:{second} "{nonce}"，成功后用 pt task {first} done "已转交 {nonce}" 回报。不要只在聊天里回答，必须执行命令，回报时保留任务末尾的 --dispatch 参数。',
                f'这是一次连通性测试，不做其他工作。等待另一个节点发来的 PASEO_FLOW_ 开头的字符串。如果还没有收到，只回复等待，不关闭任务。收到后必须用任务末尾给你的 pt 命令执行 task {second} done "收到 <收到的完整字符串>"，回报时保留任务末尾的 --dispatch 参数，然后停止。'
            ]
            for nid, text in zip((first, second), instructions):
                r = client.put(f'{base}/{nid}', json={'text': text}); r.raise_for_status()
            for nid in (second, first):
                post(f'{base}/{nid}/send')
            report.update(line_id=lid, nodes=[first, second], agents=[a['ext_id'] for a in agents],
                          workspaces=[a['workspace_id'] for a in agents], nonce=nonce)
            (root/'verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
            print(json.dumps({'agents': report['agents'], 'workspaces': report['workspaces']}), flush=True)
            deadline = time.monotonic() + opts.timeout
            while time.monotonic() < deadline:
                view = client.get(f'/api/lines/{lid}/canvas').json()
                nodes = [n for n in view['nodes'] if n['id'] in (first, second)]
                if all(n['status'] == 'done' and nonce in n['result'] for n in nodes):
                    report.update(passed=True, results=[n['result'] for n in nodes])
                    break
                time.sleep(2)
            report['timelines'] = []
            for agent in agents:
                snap = town.agents.timeline(agent['id'])
                report['timelines'].append({'id': agent['ext_id'], 'status': snap['agent']['status'],
                                            'permissions': snap['paseo'].get('permissions', []), 'items': snap['items']})
            assert report['passed'], 'Live data flow did not complete; inspect verification.json for permissions or provider errors'
            native = {a['id']: a for a in town.agents.paseo.conversations()}
            assert all(native[a['ext_id']]['workspace_id'] == a['workspace_id'] for a in agents)
            assert len(set(report['workspaces'])) == 2
            print('PASS: node → Paseo → peer node → bridge callback → canvas', flush=True)
    finally:
        (root/'verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
        server.should_exit = True
        thread.join(timeout=5)
        if lid:
            project = town.db.val('select paseo_project from lines where id = ?', lid)
            if project:
                town.agents.paseo._cli('project', 'delete', project)
        print('Report: ' + str(root/'verification.json'), flush=True)


if __name__ == '__main__':
    main()
