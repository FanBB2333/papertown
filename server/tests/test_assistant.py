import json
import os
import subprocess
import sys
import time
from pathlib import Path

from fastapi.testclient import TestClient

from papertown.api import create_app

from .conftest import make_settings, wait_for
from .test_farm_agents import FAKE_PASEO, IDEA

PAGE = {"line": {"id": "", "seq": 0, "title": ""}, "mod": "exp", "mod_name": "实验",
        "state": {"时间范围": "7 天", "任务排法": "看板", "搜索": ""},
        "focus": {"ref": "job:nvidb-4860", "label": "任务 #4860 train-x", "where": "时间线", "text": "train-x 在跑 78%"},
        "refs": [{"ref": "job:nvidb-4860", "label": "任务 #4860 train-x"}], "text": "在跑 2 · 排队 0\n先看这里"}


def started(tmp_path):
    fake = tmp_path / "bin" / "paseo"
    fake.parent.mkdir()
    fake.write_text(FAKE_PASEO)
    fake.chmod(0o755)
    app = create_app(make_settings(tmp_path, paseo_bin=str(fake)))
    return app, fake.parent / "calls.log"


def test_the_assistant_reads_the_page_and_asks_before_it_acts(tmp_path):
    app, calls = started(tmp_path)
    with TestClient(app) as c:
        town = app.state.town
        line = c.post("/api/ideas", json={"text": IDEA}).json()
        wait_for(town, line["id"], {"waiting"})
        v = c.get("/api/assistant").json()
        assert v["agent"]["role"] == "assistant" and not v["agent"]["started"] and "job.cancel" in v["actions"]
        assert c.post("/api/assistant/say", json={"text": "这是什么"}).status_code == 400  # not started yet

        a = c.post("/api/agents/assistant/start", json={"runtime": "paseo", "provider": "pi"}).json()
        assert a["runtime"] == "paseo" and a["line_id"] is None
        home = town.assistant.dir
        assert "<page>" in (home / "AGENTS.md").read_text() and (home / ".papertown" / "pt").exists()
        assert (home / ".papertown" / "q").is_dir() and "job.submit" in (home / ".papertown" / "actions.md").read_text()
        assert "--title Papertown · 小助手" in calls.read_text()

        # a message carries the page it was written on; page.md says where the panel's data comes from
        page = PAGE | {"line": {"id": line["id"], "seq": line["seq"], "title": line["title"]}}
        c.post("/api/assistant/say", json={"text": "这个任务怎么了", "page": page})
        said = town.agents.events("assistant")[-1]["data"]["text"]
        assert said.startswith("<page>\n在看：#") and "指着：任务 #4860 train-x〔job:nvidb-4860〕，在「时间线」里" in said
        assert said.endswith("这个任务怎么了") and "搜索" not in said
        md = (home / ".papertown" / "page.md").read_text()
        assert f"/api/jobs?line_id={line['id']}" in md and "nvidb job show" in md and "`job:nvidb-4860`" in md and "先看这里" in md

        # its own bridge: the page, a question for you, something to show you
        h = {"x-papertown-token": town.agents.get("assistant")["token"]}
        assert c.get("/api/bridge/assistant/page").status_code == 403
        assert "nvidb job show" in c.get("/api/bridge/assistant/page", headers=h).json()["text"]
        assert line["title"] in c.get("/api/bridge/assistant/brief", headers=h).json()["text"]  # the project on your screen
        c.post("/api/bridge/assistant/ask", json={"question": "你指的是哪个任务？", "choices": ["#4860", "#4899"], "point": True}, headers=h)
        assert c.get("/api/assistant").json()["asks"][0]["data"]["choices"] == ["#4860", "#4899"]
        c.post("/api/assistant/say", json={"text": "第一个", "page": page})
        assert c.get("/api/assistant").json()["asks"] == []
        shown = []
        publish = town.bus.publish
        town.bus.publish = lambda type, **d: (shown.append((type, d)), publish(type, **d))
        assert c.post("/api/bridge/assistant/show", json={"mod": "exp", "line": f"#{line['seq']}", "job": "nvidb-4860"}, headers=h).status_code == 200
        assert ("assistant_show", {"target": {"mod": "exp", "line": line["id"], "job": "nvidb-4860"}}) in shown
        assert c.post("/api/bridge/assistant/show", json={"mod": "nowhere"}, headers=h).status_code == 400

        # doing: a card you allow or deny; the outcome goes back to the assistant
        job = town.farm.submit(line["id"], "long", "sleep 30")
        assert c.post("/api/bridge/assistant/act", json={"action": "job.cancel", "args": {"job": "nvidb-4860"}}, headers=h).status_code == 400
        assert c.post("/api/bridge/assistant/act", json={"action": "job.fly", "args": {}}, headers=h).status_code == 400
        r = c.post("/api/bridge/assistant/act", json={"action": "job.cancel", "args": {"job": job["id"]}, "why": "用户要停"}, headers=h).json()
        card = c.get("/api/assistant").json()["acts"][-1]
        assert card["id"] == r["id"] and card["data"]["status"] == "pending" and job["id"] in card["data"]["title"]
        assert town.farm.get(job["id"])["status"] in ("queued", "running")  # nothing happens before you allow it
        done = c.post(f"/api/assistant/acts/{r['id']}", json={"allow": True}).json()
        assert done["data"]["status"] == "done" and town.farm.get(job["id"])["status"] == "cancelled"
        assert town.agents.events("assistant")[-1]["data"]["text"].startswith("<event>\n用户允许了")
        assert c.post(f"/api/assistant/acts/{r['id']}", json={"allow": True}).status_code == 400  # once only
        r = c.post("/api/bridge/assistant/act", json={"action": "idea.submit", "args": {"text": "另一个想法"}}, headers=h).json()
        assert c.post(f"/api/assistant/acts/{r['id']}", json={"allow": False}).json()["data"]["status"] == "denied"
        assert len(town.pipeline.lines()) == 1

        # a new conversation sets Paseo's aside; the next start makes another
        assert c.post("/api/assistant/new").json()["started"] is False


def test_pt_goes_through_files_when_the_sandbox_has_no_network(tmp_path):
    app, _ = started(tmp_path)
    with TestClient(app) as c:
        town = app.state.town
        c.get("/api/assistant")
        c.post("/api/agents/assistant/start", json={"runtime": "paseo", "provider": "pi"})
        # the relay sends each request on to the server as pt would have; here that is the test client
        town.assistant._fetch = lambda method, path, body, token: (lambda r: {"status": r.status_code, "body": r.json()})(
            c.request(method, path, json=body, headers={"x-papertown-token": token}))
        tools = town.assistant.dir / ".papertown"
        env = {"PATH": os.environ["PATH"], "PAPERTOWN_URL": "http://127.0.0.1:9", "PAPERTOWN_AGENT": "assistant",
               "PAPERTOWN_AGENT_TOKEN": town.agents.get("assistant")["token"]}  # nothing listens there: like a sandbox

        def pt(*args):
            return subprocess.run([sys.executable, str(tools / "pt"), *args], capture_output=True, text=True, env=env, timeout=30)

        assert json.loads(pt("get", "/api/assistant").stdout)["agent"]["id"] == "assistant"
        r = pt("ask", "哪一张卡？", "--choice", "406 GPU0", "--point")
        assert r.returncode == 0 and "侧边栏" in r.stdout and c.get("/api/assistant").json()["asks"][0]["data"]["point"] is True
        r = pt("do", "job.cancel", "job=nvidb-1")
        assert r.returncode == 1 and "只读" in r.stderr
        assert "还没在侧边栏" in pt("page").stdout and "mcp.toggle" in pt("actions").stdout
        assert not list((tools / "q").iterdir()) and not list((tools / "a").iterdir())  # nothing left behind
        t0 = time.time()
        bad = tools / "q" / "x.json"
        bad.write_text(json.dumps({"method": "POST", "path": "/api/ideas", "body": {"text": "x"}}))
        while not (tools / "a" / "x.json").exists() and time.time() - t0 < 5:
            time.sleep(0.05)
        assert json.loads((tools / "a" / "x.json").read_text())["status"] == 400  # only reads and its own bridge go through
        assert Path(town.assistant.dir).is_dir()
