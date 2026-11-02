import time
from pathlib import Path

from fastapi.testclient import TestClient

from papertown.api import create_app

from .conftest import make_settings, wait_for
from .test_farm_agents import IDEA

# a Paseo whose agents each get an id of their own, all idle
FAKE_PASEO = r"""#!/bin/sh
d="$(dirname "$0")"
echo "$@" >> "$d/calls.log"
case "$1" in
  status) echo '{"localDaemon": "running", "connectedDaemon": "reachable", "serverId": "srv_test", "daemonVersion": "0.13.2"}' ;;
  run) n=$(($(cat "$d/n" 2>/dev/null || echo 0) + 1)); echo $n > "$d/n"; echo "{\"agentId\": \"pa-$n\", \"status\": \"running\", \"provider\": \"codex\"}" ;;
  ls) n=$(cat "$d/n" 2>/dev/null || echo 0); printf '['; i=1
      while [ $i -le $n ]; do [ $i -gt 1 ] && printf ','; printf '{"id": "pa-%s", "status": "idle", "provider": "codex"}' $i; i=$((i+1)); done; echo ']' ;;
  *) echo '{}' ;;
esac
"""


def started(tmp_path):
    fake = tmp_path / "bin" / "paseo"
    fake.parent.mkdir()
    fake.write_text(FAKE_PASEO)
    fake.chmod(0o755)
    # the check-ins are driven by hand here: no ticking in the background
    return create_app(make_settings(tmp_path, paseo_bin=str(fake), lead_tick=3600, lead_gap=0)), fake.parent / "calls.log"


def test_a_lead_urges_its_workers_reports_and_asks_within_its_bounds(tmp_path):
    app, calls = started(tmp_path)
    with TestClient(app) as c:
        town = app.state.town
        lid = c.post("/api/ideas", json={"text": IDEA}).json()["id"]
        wait_for(town, lid, {"waiting"})
        lead = c.post("/api/agents", json={"line_id": lid, "role": "lead"}).json()
        assert lead["id"] == f"lead-{lid}" and lead["status"] == "stopped" and lead["name"] == "项目负责人"
        assert c.post(f"/api/agents/{lead['id']}/start", json={"runtime": "pi"}).status_code == 400  # Paseo only
        c.post(f"/api/agents/{lead['id']}/start", json={"runtime": "paseo", "provider": "codex", "model": "gpt-6.1-terra", "thinking": "high"})
        home = Path(town.agents.get(lead["id"])["cwd"])
        assert home == town.s.projects_dir / lid / "lead" and "# Papertown · 项目负责人" in (home / "AGENTS.md").read_text()
        assert (home / ".papertown" / "q").is_dir()  # Codex's sandbox reaches the town by files
        assert "--title Papertown #1 项目负责人" in calls.read_text() and "这个项目的 agent：" in calls.read_text()

        coder = c.post("/api/agents", json={"line_id": lid, "role": "coder"}).json()
        c.post(f"/api/agents/{coder['id']}/start", json={"runtime": "paseo", "provider": "codex"})
        assert "pt tell lead" in (Path(town.agents.get(coder["id"])["cwd"]) / "AGENTS.md").read_text()
        hl = {"x-papertown-token": town.agents.get(lead["id"])["token"]}
        hc = {"x-papertown-token": town.agents.get(coder["id"])["token"]}

        status = c.get(f"/api/bridge/{lead['id']}/status", headers=hl).json()["text"]
        assert "项目负责人：paseo · codex/gpt-6.1-terra" in status and "写作员工：还没有启动" in status

        # it urges a worker: the message waits for the worker to finish what it is doing
        r = c.post(f"/api/bridge/{lead['id']}/tell", json={"to": "coder", "text": "先把测试跑通"}, headers=hl).json()
        assert "等它做完" in r["text"]
        got = town.agents.events(coder["id"])[-1]
        assert got["data"]["origin"] == lead["id"] and got["data"]["held"] and got["data"]["text"].startswith('<msg from="#1 的项目负责人">')
        assert town.agents.events(lead["id"])[-1]["kind"] == "sent"
        assert c.post(f"/api/bridge/{lead['id']}/tell", json={"to": "writer", "text": "x"}, headers=hl).status_code == 400  # not started
        assert c.post(f"/api/bridge/{coder['id']}/tell", json={"to": "writer", "text": "x"}, headers=hc).status_code == 400  # a worker tells its lead
        assert c.post(f"/api/bridge/{coder['id']}/tell", json={"to": "lead", "text": "测试过了"}, headers=hc).status_code == 200

        # it reports to you; a worker asks you in the project, and your answer goes back to it
        assert c.post(f"/api/bridge/{coder['id']}/report", json={"text": "x"}, headers=hc).status_code == 403
        c.post(f"/api/bridge/{lead['id']}/report", json={"text": "基线复现完了，差 0.3", "key": True}, headers=hl)
        q = c.post(f"/api/bridge/{coder['id']}/ask", json={"question": "用哪个数据集？", "choices": ["A", "B"]}, headers=hc).json()
        v = c.get(f"/api/lines/{lid}/lead").json()
        assert v["reports"][0]["data"] == {"text": "基线复现完了，差 0.3", "key": True, "who": "项目负责人"} and v["asks"][0]["data"]["choices"] == ["A", "B"]
        assert v["settings"] == {"supervise": True, "every": 60}
        ask = v["asks"][0]
        assert str(ask["id"]) in q["text"]
        c.post(f"/api/reports/{ask['id']}/answer", json={"text": "B"})
        assert c.get(f"/api/lines/{lid}/lead").json()["asks"] == []
        assert any("<answer>" in e["data"]["text"] and "用户回答：B" in e["data"]["text"] for e in town.agents.events(coder["id"]) if e["kind"] == "user")
        assert c.post(f"/api/reports/{ask['id']}/answer", json={"text": "A"}).status_code == 400  # answered already
        assert "基线复现完了" in c.get(f"/api/bridge/{lead['id']}/reports", headers=hl).json()["text"]

        # its boundaries: telling a worker now waits for you, and the coder may not submit jobs
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
        assert c.post(f"/api/bridge/{coder['id']}/tell", json={"to": "lead", "text": "好"}, headers=hc).status_code == 200  # 不继承: the lead's only

        c.post(f"/api/lines/{lid}/lead", json={"every": 30})
        assert c.get(f"/api/lines/{lid}/lead").json()["settings"]["every"] == 30


def test_a_lead_hears_when_its_project_moves(tmp_path):
    app, _ = started(tmp_path)
    with TestClient(app) as c:
        town = app.state.town
        lid = c.post("/api/ideas", json={"text": IDEA}).json()["id"]
        wait_for(town, lid, {"waiting"})
        for role in ("lead", "coder"):
            a = c.post("/api/agents", json={"line_id": lid, "role": role}).json()
            c.post(f"/api/agents/{a['id']}/start", json={"runtime": "paseo", "provider": "codex"})
        lead, leads = f"lead-{lid}", town.leads

        def look():
            town.agents._set(lead, status="idle")
            leads.look(town.agents.get(lead))

        def checkins():
            return [e["data"]["text"] for e in town.agents.events(lead) if e["kind"] == "user" and e["data"].get("origin") == "town"]

        look()  # where changes count from
        town.agents._set(f"coder-{lid}", status="working")
        look()
        assert checkins() == []  # a worker starting is no news
        town.agents._set(f"coder-{lid}", status="idle")
        job = town.farm.submit(lid, "train", "exit 3")
        t0 = time.time()
        while town.farm.get(job["id"])["status"] != "failed" and time.time() - t0 < 20:
            time.sleep(0.1)
        look()
        said = checkins()
        assert len(said) == 1 and said[0].startswith("<checkin>") and "代码员工结束了一轮" in said[0]
        assert f"任务 {job['id']} train" in said[0] and "→ 失败" in said[0] and "现在的情况：" in said[0]

        # an unfinished project sitting still gets a check-in now and then, a few in a row at most
        town.db.update("lines", {"id": lid}, status="running")
        look()
        assert len(checkins()) == 2  # its status changed
        for _ in range(5):
            leads._last[lid] = time.time() - 61 * 60
            look()
        assert len(checkins()) == 2 + 3 and "没有新动静" in checkins()[-1]
        c.post(f"/api/lines/{lid}/lead", json={"supervise": False})
        town.farm.submit(lid, "again", "exit 3")
        time.sleep(0.5)
        look()
        assert len(checkins()) == 5  # switched off
