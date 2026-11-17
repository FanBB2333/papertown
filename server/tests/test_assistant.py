import json
import os
import subprocess
import sys
import time
from pathlib import Path

from fastapi.testclient import TestClient

from .conftest import wait_for
from .test_farm_agents import IDEA, with_paseo

PAGE = {"line": {"id": "", "seq": 0, "title": ""}, "mod": "exp", "mod_name": "实验",
        "state": {"时间范围": "7 天", "任务排法": "看板", "搜索": ""},
        "focus": {"ref": "job:nvidb-4860", "label": "任务 #4860 train-x", "where": "时间线", "text": "train-x 在跑 78%"},
        "refs": [{"ref": "job:nvidb-4860", "label": "任务 #4860 train-x"}], "text": "在跑 2 · 排队 0\n先看这里"}


def test_the_assistant_reads_the_page_and_asks_before_it_acts(tmp_path):
    app, calls = with_paseo(tmp_path)
    with TestClient(app) as c:
        town = app.state.town
        line = c.post("/api/ideas", json={"text": IDEA}).json()
        wait_for(town, line["id"], {"waiting"})
        v = c.get("/api/assistant").json()
        assert v["agent"]["role"] == "assistant" and not v["agent"]["started"] and "job.cancel" in v["actions"]
        assert c.post("/api/assistant/say", json={"text": "这是什么"}).status_code == 400

        a = c.post("/api/agents/assistant/start", json={"runtime": "paseo", "provider": "pi"}).json()
        assert a["runtime"] == "paseo" and a["line_id"] is None
        home = town.assistant.dir
        assert "<page>" in (home / "AGENTS.md").read_text() and (home / ".papertown" / "pt").exists()
        assert (home / ".papertown" / "q").is_dir() and "job.submit" in (home / ".papertown" / "actions.md").read_text()
        assert "--title Papertown · 小助手" in calls.read_text()

        page = PAGE | {"line": {"id": line["id"], "seq": line["seq"], "title": line["title"]}}
        c.post("/api/assistant/say", json={"text": "这个任务怎么了", "page": page})
        said = town.agents.events("assistant")[-1]["data"]["text"]
        assert said.startswith("<page>\n在看：#") and "指着：任务 #4860 train-x〔job:nvidb-4860〕，在「时间线」里" in said
        assert said.endswith("这个任务怎么了") and "搜索" not in said
        md = (home / ".papertown" / "page.md").read_text()
        assert f"/api/jobs?line_id={line['id']}" in md and "nvidb job show" in md and "`job:nvidb-4860`" in md and "先看这里" in md

        h = {"x-papertown-token": town.agents.get("assistant")["token"]}
        assert c.get("/api/bridge/assistant/page").status_code == 403
        assert "nvidb job show" in c.get("/api/bridge/assistant/page", headers=h).json()["text"]
        assert line["title"] in c.get("/api/bridge/assistant/brief", headers=h).json()["text"]
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

        job = town.farm.submit(line["id"], "long", "sleep 30")
        assert c.post("/api/bridge/assistant/act", json={"action": "job.cancel", "args": {"job": "nvidb-4860"}}, headers=h).status_code == 400
        assert c.post("/api/bridge/assistant/act", json={"action": "job.fly", "args": {}}, headers=h).status_code == 400
        r = c.post("/api/bridge/assistant/act", json={"action": "job.cancel", "args": {"job": job["id"]}, "why": "用户要停"}, headers=h).json()
        card = c.get("/api/assistant").json()["acts"][-1]
        assert card["id"] == r["id"] and card["data"]["status"] == "pending" and job["id"] in card["data"]["title"]
        assert town.farm.get(job["id"])["status"] in ("queued", "running")
        done = c.post(f"/api/assistant/acts/{r['id']}", json={"allow": True}).json()
        assert done["data"]["status"] == "done" and town.farm.get(job["id"])["status"] == "cancelled"
        assert town.agents.events("assistant")[-1]["data"]["text"].startswith("<event>\n用户允许了")
        assert c.post(f"/api/assistant/acts/{r['id']}", json={"allow": True}).status_code == 400

        # the project's canvas: read as an outline, edited at once through canvas.* actions, removing waits for a yes
        lid, act = line["id"], lambda action, **args: c.post("/api/bridge/assistant/act", json={"action": action, "args": {"line": line["id"], **args}}, headers=h)
        text = c.get(f"/api/lines/{lid}/canvas/outline").json()["text"]
        assert "- stage:exp · 工序 · 实验" in text and "- check:design · 软巡检 · 实验设计" in text and "- gate:write · 硬卡口 · 写作排版 · " in text
        assert "- check:design — stage:exp（巡检）" in text
        r = act("canvas.add", kind="task", title="补消融", text="三个模块各去掉一次", to="coder", near="design").json()
        assert r["text"].startswith("已经做了") and "连着「实验设计」" in r["text"]
        tid = r["text"].split("编号 ")[1]
        v = c.get(f"/api/lines/{lid}/canvas").json()
        task = next(n for n in v["nodes"] if n["id"] == tid)
        assert (task["to"], task["status"]) == ("coder", "draft") and {"source": "check:design", "target": tid} in [{k: e[k] for k in ("source", "target")} for e in v["edges"]]
        assert act("canvas.edit", node=tid, title="补三个消融", x=40, y=900).json()["text"].endswith("改好了")
        assert act("canvas.edit", node="check:hyphens", max=20, gate="block").json()["text"].endswith("改好了")
        assert act("canvas.edit", node="gate:write", auto="true", rounds=3).json()["text"].endswith("改好了")
        assert act("canvas.link", a=tid, b="exp", label="结果进主表").json()["text"].endswith("连上了，线上写着「结果进主表」")
        v = c.get(f"/api/lines/{lid}/canvas").json()
        task = next(n for n in v["nodes"] if n["id"] == tid)
        assert (task["title"], task["x"], task["y"]) == ("补三个消融", 40, 900)
        hy = next(x for x in c.get(f"/api/lines/{lid}/checks").json()["checks"] if x["id"] == "hyphens")
        assert (hy["max"], hy["gate"]) == (20, "block")
        assert next(n for n in v["nodes"] if n["id"] == "gate:write")["gate"]["policy"] == {"auto": True, "rounds": 3}
        assert next(e for e in v["edges"] if {e["source"], e["target"]} == {tid, "stage:exp"})["label"] == "结果进主表"
        assert act("canvas.link", a=tid, b="exp", cut="true").json()["text"].endswith("断开了")
        assert act("canvas.add", kind="tree").status_code == 400 and act("canvas.edit", node="nowhere", title="x").status_code == 400
        assert act("canvas.send", node=tid).status_code == 400  # the coder has not been started
        r = act("canvas.remove", node=tid).json()
        assert "请用户确认" in r["text"] and tid in {n["id"] for n in c.get(f"/api/lines/{lid}/canvas").json()["nodes"]}
        assert c.post(f"/api/assistant/acts/{r['id']}", json={"allow": True}).json()["data"]["status"] == "done"
        assert tid not in {n["id"] for n in c.get(f"/api/lines/{lid}/canvas").json()["nodes"]}
        assert "ref node:check:design" in c.post("/api/bridge/assistant/show", json={"line": lid, "ref": "node:design"}, headers=h).json()["text"]
        assert ("assistant_show", {"target": {"line": lid, "ref": "node:check:design"}}) in shown
        town.assistant.set_page({"mod": "canvas", "line": {"id": lid, "seq": line["seq"], "title": "x"}})
        assert "canvas/outline" in town.assistant.page_text() and "面板：研究回路" in town.assistant.page_text()
        r = c.post("/api/bridge/assistant/act", json={"action": "idea.submit", "args": {"text": "另一个想法"}}, headers=h).json()
        assert c.post(f"/api/assistant/acts/{r['id']}", json={"allow": False}).json()["data"]["status"] == "denied"
        assert len(town.pipeline.lines()) == 1

        at = {"label": "已取消 11", "ref": "count:cancelled", "text": "11\n已取消"}
        c.post("/api/assistant/say", json={"text": "这段对吗", "page": page | {"selection": "loss = a + b\nreturn loss", "selection_at": at}})
        said, md = town.agents.events("assistant")[-1]["data"]["text"], (home / ".papertown" / "page.md").read_text()
        assert "选中：「loss = a + b return loss」（2 行" in said and "选中的地方：已取消 11〔count:cancelled〕" in said
        assert "return loss\n```" in md and "那一块写着：11 已取消" in md

        first = town.agents.get("assistant")["ext_id"]
        assert c.post("/api/assistant/new").json()["started"] is False

        convs = [{"id": first, "provider": "pi", "model": "m1", "status": "idle", "labels": {"papertown.agent": "assistant", "papertown.role": "assistant"}, "last_user": "2026-10-31T10:00:00Z"},
                 {"id": "other", "provider": "codex", "model": "m2", "status": "idle", "labels": {"papertown.agent": "coder-line_1", "papertown.role": "coder"}, "last_user": "2026-10-31T11:00:00Z"}]
        town.agents.paseo.conversations = lambda: convs
        h = c.get("/api/assistant/history").json()["conversations"]
        assert [x["id"] for x in h] == [first] and h[0]["title"] == "这个任务怎么了" and not h[0]["current"]
        assert c.post("/api/assistant/resume", json={"id": "other"}).status_code == 400
        back = c.post("/api/assistant/resume", json={"id": first}).json()
        assert back["ext_id"] == first and back["runtime"] == "paseo" and back["model"] == "pi/m1"
        assert c.get("/api/assistant/history").json()["conversations"][0]["current"]


def test_pt_goes_through_files_when_the_sandbox_has_no_network(tmp_path):
    app, _ = with_paseo(tmp_path)
    with TestClient(app) as c:
        town = app.state.town
        c.get("/api/assistant")
        c.post("/api/agents/assistant/start", json={"runtime": "paseo", "provider": "pi"})
        town.relay._fetch = lambda method, path, body, token: (lambda r: {"status": r.status_code, "body": r.json()})(
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
        assert not list((tools / "q").iterdir()) and not list((tools / "a").iterdir())
        t0 = time.time()
        bad = tools / "q" / "x.json"
        bad.write_text(json.dumps({"method": "POST", "path": "/api/ideas", "body": {"text": "x"}}))
        while not (tools / "a" / "x.json").exists() and time.time() - t0 < 5:
            time.sleep(0.05)
        assert json.loads((tools / "a" / "x.json").read_text())["status"] == 400
        assert Path(town.assistant.dir).is_dir()
