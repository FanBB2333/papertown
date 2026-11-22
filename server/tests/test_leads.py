import time
from pathlib import Path

from fastapi.testclient import TestClient

from .test_farm_agents import IDEA, wait_job, with_paseo

# a Paseo whose agents each get an id of their own, all idle
FAKE_PASEO = r"""#!/bin/sh
d="$(dirname "$0")"
echo "$@" >> "$d/calls.log"
case "$1" in
  status) echo '{"localDaemon": "running", "connectedDaemon": "reachable", "serverId": "srv_test", "daemonVersion": "0.13.2"}' ;;
  project) echo '{"projectId":"prj-test"}' ;;
  workspace) echo '{"workspaceId":"wks-test"}' ;;
  run) n=$(($(cat "$d/n" 2>/dev/null || echo 0) + 1)); echo $n > "$d/n"; echo "{\"agentId\": \"pa-$n\", \"status\": \"running\", \"provider\": \"codex\"}" ;;
  ls) n=$(cat "$d/n" 2>/dev/null || echo 0); printf '['; i=1
      while [ $i -le $n ]; do [ $i -gt 1 ] && printf ','; printf '{"id": "pa-%s", "status": "idle", "provider": "codex"}' $i; i=$((i+1)); done; echo ']' ;;
  *) echo '{}' ;;
esac
"""


def started(tmp_path):
    # the check-ins are driven by hand here: no ticking in the background
    return with_paseo(tmp_path, FAKE_PASEO, lead_tick=3600, lead_gap=0)


def test_a_lead_urges_its_workers_reports_and_asks_within_its_bounds(tmp_path):
    app, calls = started(tmp_path)
    with TestClient(app) as c:
        town = app.state.town
        lid = c.post("/api/ideas", json={"text": IDEA}).json()["id"]

        lead = c.post("/api/agents", json={"line_id": lid, "role": "lead"}).json()
        assert lead["id"] == f"lead-{lid}" and lead["status"] == "stopped" and lead["name"] == "项目负责人"
        assert c.post(f"/api/agents/{lead['id']}/start", json={"runtime": "pi"}).status_code == 400
        c.post(f"/api/agents/{lead['id']}/start", json={"runtime": "paseo", "provider": "codex", "model": "gpt-6.1-terra", "thinking": "high"})
        home = Path(town.agents.get(lead["id"])["cwd"])
        assert home == town.s.projects_dir / lid / "lead" and "# Papertown · 项目负责人" in (home / "AGENTS.md").read_text()
        assert (home / ".papertown" / "q").is_dir()
        assert "--title Papertown #1 项目负责人" in calls.read_text() and "这个项目的 agent：" in calls.read_text()

        coder = c.post("/api/agents", json={"line_id": lid, "role": "coder"}).json()
        c.post(f"/api/agents/{coder['id']}/start", json={"runtime": "paseo", "provider": "codex"})
        assert "pt tell lead" in (Path(town.agents.get(coder["id"])["cwd"]) / "AGENTS.md").read_text()
        hl = {"x-papertown-token": town.agents.get(lead["id"])["token"]}
        hc = {"x-papertown-token": town.agents.get(coder["id"])["token"]}

        status = c.get(f"/api/bridge/{lead['id']}/status", headers=hl).json()["text"]
        assert "项目负责人：paseo · codex/gpt-6.1-terra" in status and "写作员工：还没有启动" in status

        r = c.post(f"/api/bridge/{lead['id']}/tell", json={"to": "coder", "text": "先把测试跑通"}, headers=hl).json()
        assert "等它做完" in r["text"]
        got = town.agents.events(coder["id"])[-1]
        assert got["data"]["origin"] == lead["id"] and got["data"]["held"] and got["data"]["text"].startswith('<msg from="#1 的项目负责人">')
        assert town.agents.events(lead["id"])[-1]["kind"] == "sent"
        assert c.post(f"/api/bridge/{lead['id']}/tell", json={"to": "writer", "text": "x"}, headers=hl).status_code == 400
        assert c.post(f"/api/bridge/{coder['id']}/tell", json={"to": "writer", "text": "x"}, headers=hc).status_code == 400
        assert c.post(f"/api/bridge/{coder['id']}/tell", json={"to": "lead", "text": "测试过了"}, headers=hc).status_code == 200

        assert c.post(f"/api/bridge/{coder['id']}/report", json={"text": "x"}, headers=hc).status_code == 403
        c.post(f"/api/bridge/{lead['id']}/report", json={"text": "基线复现完了，差 0.3", "key": True}, headers=hl)
        q = c.post(f"/api/bridge/{coder['id']}/ask", json={"question": "用哪个数据集？", "choices": ["A", "B"]}, headers=hc).json()
        v = c.get(f"/api/lines/{lid}/lead").json()
        assert v["reports"][0]["data"] == {"text": "基线复现完了，差 0.3", "key": True, "who": "项目负责人"} and v["asks"][0]["data"]["choices"] == ["A", "B"]
        assert v["settings"] == {"supervise": True, "every": 60, "on": True}
        ask = v["asks"][0]
        assert str(ask["id"]) in q["text"]
        c.post(f"/api/reports/{ask['id']}/answer", json={"text": "B"})
        assert c.get(f"/api/lines/{lid}/lead").json()["asks"] == []
        assert any("<answer>" in e["data"]["text"] and "用户回答：B" in e["data"]["text"] for e in town.agents.events(coder["id"]) if e["kind"] == "user")
        assert c.post(f"/api/reports/{ask['id']}/answer", json={"text": "A"}).status_code == 400
        assert "基线复现完了" in c.get(f"/api/bridge/{lead['id']}/reports", headers=hl).json()["text"]

        c.put("/api/bounds", json={"line_id": lid, "rules": [
            {"kind": "ask", "text": "给员工派活前问我", "inherit": "no", "action": "tell"},
            {"kind": "never", "text": "不要自己提交实验", "inherit": "yes", "action": "job.submit"}]})
        r = c.post(f"/api/bridge/{lead['id']}/tell", json={"to": "coder", "text": "改用数据集 B"}, headers=hl).json()
        assert "要先问用户" in r["text"]
        held = c.get(f"/api/lines/{lid}/lead").json()["asks"][-1]
        assert held["data"]["act"]["action"] == "tell" and "改用数据集 B" in held["data"]["question"]
        before = len(town.agents.events(coder["id"]))
        c.post(f"/api/reports/{held['id']}/answer", json={"text": "可以"})
        assert any("改用数据集 B" in e["data"]["text"] for e in town.agents.events(coder["id"])[before:] if e["kind"] == "user")
        assert c.post(f"/api/bridge/{coder['id']}/jobs", json={"name": "x", "command": "true"}, headers=hc).status_code == 403
        assert c.post(f"/api/bridge/{coder['id']}/tell", json={"to": "lead", "text": "好"}, headers=hc).status_code == 200

        c.post(f"/api/lines/{lid}/lead", json={"every": 30})
        assert c.get(f"/api/lines/{lid}/lead").json()["settings"]["every"] == 30


def test_a_lead_hears_when_its_project_moves(tmp_path):
    app, _ = started(tmp_path)
    with TestClient(app) as c:
        town = app.state.town
        lid = c.post("/api/ideas", json={"text": IDEA}).json()["id"]

        for role in ("lead", "coder"):
            a = c.post("/api/agents", json={"line_id": lid, "role": role}).json()
            c.post(f"/api/agents/{a['id']}/start", json={"runtime": "paseo", "provider": "codex"})
        lead, leads = f"lead-{lid}", town.leads

        def look():
            town.agents._set(lead, status="idle")
            leads.look(town.agents.get(lead))

        def checkins():
            return [e["data"]["text"] for e in town.agents.events(lead) if e["kind"] == "user" and e["data"].get("origin") == "town"]

        look()
        town.agents._set(f"coder-{lid}", status="working")
        look()
        assert checkins() == []
        town.agents._set(f"coder-{lid}", status="idle")
        job = town.farm.submit(lid, "train", "exit 3")
        wait_job(town, job["id"])
        look()
        said = checkins()
        assert len(said) == 1 and said[0].startswith("<checkin>") and "代码员工结束了一轮" in said[0]
        assert f"任务 {job['id']} train" in said[0] and "→ 失败" in said[0] and "现在的情况：" in said[0]

        town.db.update("stages", {"line_id": lid, "key": "method"}, status="run")
        look()
        assert len(checkins()) == 2
        for _ in range(5):
            leads._last[lid] = time.time() - 61 * 60
            look()
        assert len(checkins()) == 2 + 3 and "没有新动静" in checkins()[-1]
        c.post(f"/api/lines/{lid}/lead", json={"supervise": False})
        town.farm.submit(lid, "again", "exit 3")
        time.sleep(0.5)
        look()
        assert len(checkins()) == 5


def test_the_assistant_speaks_for_you_to_the_projects(tmp_path):
    app, calls = started(tmp_path)
    with TestClient(app) as c:
        town = app.state.town
        line = c.post("/api/ideas", json={"text": IDEA}).json()
        lid = line["id"]

        assert c.get("/api/paseo").json()["defaults"]["assistant"] == {"provider": "codex", "model": "gpt-6.1-terra", "thinking": "xhigh", "set": False}
        c.get("/api/assistant")
        c.post("/api/agents/assistant/start", json={"runtime": "paseo"})
        c.post("/api/agents", json={"line_id": lid, "role": "lead"})
        c.post(f"/api/agents/lead-{lid}/start", json={"runtime": "paseo"})
        runs = [x for x in calls.read_text().splitlines() if x.startswith("run")]
        assert "--provider codex" in runs[0] and "--model gpt-6.1-terra --thinking xhigh" in runs[0]
        assert "--model gpt-6.1-terra --thinking high" in runs[1]
        home = town.assistant.dir
        assert "也是用户的代理人" in (home / "AGENTS.md").read_text() and "## 你和项目" in (home / "AGENTS.md").read_text()
        h = {"x-papertown-token": town.agents.get("assistant")["token"]}
        assert "tell（line text [role] [now]）" in (home / ".papertown" / "actions.md").read_text()
        assert "〔直接做〕" in town.assistant.actions_text() and "job.cancel（job）：" in town.assistant.actions_text()

        c.post("/api/assistant/say", json={"text": f"#{line['seq']} 现在怎么样了？"})
        said = town.agents.events("assistant")[-1]["data"]["text"]
        assert said.startswith("<projects>\n") and f"项目 #{line['seq']}" in said and said.endswith("现在怎么样了？")

        r = c.post("/api/bridge/assistant/tell", json={"to": f"#{line['seq']}", "text": "先把基线复现出来"}, headers=h).json()
        assert r["text"].startswith("已经做了：给#1 的项目负责人发消息")
        got = town.agents.events(f"lead-{lid}")[-1]["data"]
        assert got["origin"] == "assistant" and got["text"].startswith('<msg from="小助手">')
        card = c.get("/api/assistant").json()["acts"][-1]["data"]
        assert card["status"] == "done" and card["auto"]
        assert c.post("/api/bridge/assistant/tell", json={"to": f"#{line['seq']} coder", "text": "x"}, headers=h).status_code == 400

        q = town.leads.ask(f"lead-{lid}", "先做哪个数据集？", ["A", "B"])
        c.post("/api/bridge/assistant/answer", json={"id": str(q["id"]), "text": "先做 A"}, headers=h)
        assert town.leads.asks(lid) == [] and "用户（经小助手转达）回答：先做 A" in town.agents.events(f"lead-{lid}")[-1]["data"]["text"]

        c.put("/api/bounds", json={"rules": [{"kind": "ask", "text": "给项目下命令前问我", "inherit": "no", "action": "tell"}]})
        assert "〔要他在侧边栏点「允许」：给项目下命令前问我〕" in (home / ".papertown" / "actions.md").read_text()
        before = len(town.agents.events(f"lead-{lid}"))
        r = c.post("/api/bridge/assistant/tell", json={"to": lid, "text": "停一下"}, headers=h).json()
        assert "按你的工作边界：给项目下命令前问我" in r["text"] and len(town.agents.events(f"lead-{lid}")) == before
        c.post(f"/api/assistant/acts/{r['id']}", json={"allow": True})
        assert town.agents.events(f"lead-{lid}")[-1]["data"]["text"].endswith("停一下\n</msg>")
        c.put("/api/bounds", json={"rules": [{"kind": "never", "text": "别动项目", "inherit": "no", "action": "tell"}]})
        assert c.post("/api/bridge/assistant/tell", json={"to": lid, "text": "x"}, headers=h).status_code == 400
