import re
import shlex
import subprocess
import sys
import time
from pathlib import Path

from fastapi.testclient import TestClient

from papertown.api import create_app

from .conftest import make_settings

IDEA = "用检索增强做论文的新颖性评估"


def wait_job(town, job_id, timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        j = town.farm.get(job_id)
        if j["status"] not in ("queued", "running"):
            return j
        time.sleep(0.05)
    raise TimeoutError(job_id)


def test_local_job_reports_progress_and_result(town):
    line = town.pipeline.create(IDEA)
    cmd = "echo PROGRESS 30; echo PROGRESS 70; echo 'RESULT {\"acc\": 0.91}'"
    j = wait_job(town, town.farm.submit(line["id"], "main", cmd)["id"])
    assert j["status"] == "done" and j["result"] == {"acc": 0.91} and j["progress"] == 100
    assert "PROGRESS 70" in town.farm.log(j["id"])
    notes = [e["data"]["text"] for e in town.agents.events(f"monitor-{line['id']}")]
    assert any("排进" in n for n in notes) and any("过半" in n for n in notes) and "acc 0.91" in notes[-1]

    bad = wait_job(town, town.farm.submit(line["id"], "bad", "echo oops; exit 3")["id"])
    assert bad["status"] == "failed" and "3" in bad["note"]


def test_bridge_mirrors_a_pi_session(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as c:
        town = app.state.town
        line_id = c.post("/api/ideas", json={"text": IDEA}).json()["id"]

        a = c.post("/api/agents", json={"line_id": line_id, "role": "coder"}).json()
        assert a["status"] == "stopped" and "token" not in a and a["attach"].startswith("tmux -L papertown")
        assert c.post(f"/api/agents/{a['id']}/say", json={"text": "hi"}).status_code == 400

        token = town.agents.get(a["id"])["token"]
        assert c.post(f"/api/bridge/{a['id']}/events", json={"events": []}).status_code == 403
        h = {"x-papertown-token": token}
        events = [{"t": "hello", "model": "test/model", "idle": True},
                  {"t": "input", "text": "写个测试", "source": "interactive"},
                  {"t": "start"},
                  {"t": "assistant", "text": "好的", "tools": [], "usage": {"input": 10, "output": 2, "cost": 0.001}},
                  {"t": "tool_start", "id": "t1", "name": "bash", "args": {"command": "pytest"}},
                  {"t": "tool_end", "id": "t1", "name": "bash", "error": False, "result": "1 passed"},
                  {"t": "settled", "aborted": False}]
        assert c.post(f"/api/bridge/{a['id']}/events", json={"events": events}, headers=h).status_code == 200
        got = c.get(f"/api/agents/{a['id']}").json()
        assert got["agent"]["status"] == "idle" and got["agent"]["model"] == "test/model"
        kinds = [(e["kind"], e["data"].get("origin")) for e in got["events"]]
        assert ("user", "terminal") in kinds and ("assistant", None) in kinds and ("tool_end", None) in kinds
        assert town.db.val("select cost from agents where id = ?", a["id"]) > 0

        town.agents._inbox[a["id"]] = [{"id": 1, "text": "from web"}]
        assert c.get(f"/api/bridge/{a['id']}/inbox?wait=0", headers=h).json()["messages"][0]["text"] == "from web"
        assert "项目 #1" in c.get(f"/api/bridge/{a['id']}/brief", headers=h).json()["text"]
        j = c.post(f"/api/bridge/{a['id']}/jobs", json={"name": "smoke", "command": "echo PROGRESS 100"}, headers=h).json()
        assert j["line_id"] == line_id and j["submitted_by"] == a["id"]
        assert wait_job(town, j["id"])["status"] == "done"
        assert c.get("/api/agents?role=coder").json()["roster"][0]["agent"]["id"] == a["id"]


def test_bridge_reports_state_and_runs_commands(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as c:
        town = app.state.town
        line_id = c.post("/api/ideas", json={"text": IDEA}).json()["id"]

        a = c.post("/api/agents", json={"line_id": line_id, "role": "writer"}).json()
        h = {"x-papertown-token": town.agents.get(a["id"])["token"]}
        state = {"t": "state", "model": {"provider": "p", "id": "m1"}, "thinking": "high", "levels": ["off", "high"],
                 "models": [{"provider": "p", "id": "m1"}, {"provider": "p", "id": "m2"}], "commands": [{"name": "review", "source": "prompt"}]}
        c.post(f"/api/bridge/{a['id']}/events", json={"events": [{"t": "hello", "idle": True}, state,
                                                                    {"t": "state", "model": {"provider": "p", "id": "m2"}, "thinking": "off"},
                                                                    {"t": "note", "text": "模型换成 p/m2。"}]}, headers=h)
        got = c.get(f"/api/agents/{a['id']}").json()
        st = got["agent"]["state"]
        assert st["model"]["id"] == "m2" and st["thinking"] == "off" and len(st["models"]) == 2 and got["agent"]["model"] == "p/m2"
        assert got["events"][-1]["data"]["text"] == "模型换成 p/m2。"

        town.agents.alive = lambda _a: True
        ev = c.post(f"/api/agents/{a['id']}/say", json={"text": "/model p/m1"}).json()
        assert ev["data"]["cmd"] and town.agents.take(a["id"]) == [{"id": ev["data"]["mid"], "kind": "cmd", "name": "model", "args": "p/m1"}]
        typed = []
        town.agents._tmux = lambda *args: typed.append(args)
        c.post(f"/api/agents/{a['id']}/say", json={"text": "/settings"})
        assert ("send-keys", "-t", f"pt-{a['id']}", "-l", "/settings") in typed and not town.agents.take(a["id"])


def test_pi_start_uses_node_entrypoint_and_resumes_session(town, tmp_path, monkeypatch):
    bin_dir = tmp_path / "pi bin"
    bin_dir.mkdir()
    entry = bin_dir / "cli.js"
    entry.touch()
    (bin_dir / "node").touch()
    pi = bin_dir / "pi"
    pi.symlink_to(entry)
    agents = town.agents
    agents.pi, agents.tmux = str(pi), "tmux"
    monkeypatch.setattr(agents, "_watch_start", lambda _: None)
    calls = []

    def tmux(*args):
        calls.append(args)
        return subprocess.CompletedProcess(args, int(args[0] == "has-session"), "", "")

    monkeypatch.setattr(agents, "_tmux", tmux)
    line = town.pipeline.create(IDEA)

    agent = agents.ensure(line["id"], "coder")
    started = agents.start(agent["id"], runtime="pi")
    assert started["status"] == "starting" and started["runtime"] == "pi"
    launch = next(args for args in calls if args[0] == "new-session")
    argv = shlex.split(launch[-1].split("; code=$?", 1)[0])
    assert argv[:2] == [str(bin_dir / "node"), str(entry)]
    assert Path(argv[argv.index("-e") + 1]).name == "bridge.ts"
    assert "--continue" not in argv
    sessions = Path(argv[argv.index("--session-dir") + 1])
    (sessions / "previous.jsonl").touch()
    calls.clear()
    agents.start(agent["id"], runtime="pi")
    launch = next(args for args in calls if args[0] == "new-session")
    assert "--continue" in shlex.split(launch[-1].split("; code=$?", 1)[0])


FAKE_PASEO = r"""#!/bin/sh
echo "$@" >> "$(dirname "$0")/calls.log"
case "$1" in
  status) echo '{"localDaemon": "running", "connectedDaemon": "reachable", "serverId": "srv_test", "daemonVersion": "0.13.2"}' ;;
  project) echo '{"projectId":"prj-test"}' ;;
  workspace) echo '{"workspaceId":"wks-test"}' ;;
  run) echo '{"agentId": "pa-1", "status": "running", "provider": "pi", "cwd": "/tmp", "title": "t"}' ;;
  ls) echo '[{"id": "pa-1", "status": "idle", "provider": "pi/openai-codex/gpt-5.6-luna"}]' ;;
  provider) if [ "$2" = ls ]; then echo '[{"provider": "pi", "label": "Pi", "status": "available"}, {"provider": "omp", "status": "unavailable"}]';
            else echo '[{"model": "Luna", "id": "openai-codex/gpt-5.6-luna", "thinkingOptionIds": ["off", "high"], "defaultThinkingOptionId": "high"}]'; fi ;;
  *) echo '{}' ;;
esac
"""


def with_paseo(tmp_path, script=FAKE_PASEO, **kw):
    """An app whose paseo is the fake `script`, and the log of how it was called."""
    fake = tmp_path / "bin" / "paseo"
    fake.parent.mkdir()
    fake.write_text(script)
    fake.chmod(0o755)
    return create_app(make_settings(tmp_path, paseo_bin=str(fake), **kw)), fake.parent / "calls.log"


def test_paseo_agents_are_created_driven_and_followed(tmp_path):
    app, calls = with_paseo(tmp_path)
    with TestClient(app) as c:
        town = app.state.town
        line_id = c.post("/api/ideas", json={"text": IDEA}).json()["id"]

        info = c.get("/api/paseo").json()
        assert info["status"]["ok"] and [p["id"] for p in info["providers"]] == ["pi"] and info["providers"][0]["models"][0]["thinking"] == ["off", "high"]

        a = c.post("/api/agents", json={"line_id": line_id, "role": "coder"}).json()
        r = c.post(f"/api/agents/{a['id']}/start", json={"runtime": "paseo", "provider": "pi", "model": "openai-codex/gpt-5.6-luna", "thinking": "high"}).json()
        assert r["runtime"] == "paseo" and r["ext_id"] == "pa-1" and r["attach"] is None
        cwd = town.agents.get(a["id"])["cwd"]
        assert ".papertown/pt" in (Path(cwd) / "AGENTS.md").read_text() and (Path(cwd) / ".papertown" / "pt").exists()
        run = next(l for l in calls.read_text().splitlines() if l.startswith("run"))
        assert "--provider pi" in run and "--model openai-codex/gpt-5.6-luna" in run and "papertown.agent=" + a["id"] in run and "PAPERTOWN_AGENT_TOKEN=" in run

        assert c.post(f"/api/agents/{a['id']}/say", json={"text": "先跑测试"}).json()["data"]["steered"] is True
        held = c.post(f"/api/agents/{a['id']}/say", json={"text": "再补文档", "mode": "queue"}).json()
        assert held["data"]["held"] and not held["data"]["delivered"]
        c.post(f"/api/agents/{a['id']}/abort")
        log = calls.read_text()
        assert log.count("send pa-1 --no-wait --prompt-file") == 1 and "stop pa-1" in log

        t0 = time.time()
        while town.db.val("select json_extract(data, '$.held') from agent_events where id = ?", held["id"]) and time.time() - t0 < 15:
            time.sleep(0.2)
        assert calls.read_text().count("send pa-1 --no-wait --prompt-file") == 2
        while town.agents.get(a["id"])["status"] != "idle" and time.time() - t0 < 25:
            time.sleep(0.2)
        assert town.agents.get(a["id"])["status"] == "idle"


class FakeLink:
    """Stands in for Paseo: one conversation of its own and its timeline, and the ones Papertown makes."""

    def __init__(self):
        self.labels, self.permits, self.made = {}, [], []
        self.conv = {"id": "conv-1", "title": "旧对话", "provider": "claude", "model": "claude-haiku-5-5", "cwd": None,
                     "status": "idle", "updated": "2026-10-29T00:00:00Z", "last_user": None}
        self.convs = [self.conv]

    def conversations(self):
        return self.convs

    def status(self, fresh=False):
        return {"ok": True, "note": ""}

    def project(self, path):
        return "prj-" + path.name

    def workspace(self, project_id, path, title):
        return f"wks-{len(self.made) + 1}"

    def create(self, **kw):
        self.made.append(kw)
        ext = f"pa-{len(self.made)}"
        self.convs.insert(0, {"id": ext, "provider": kw["provider"], "model": kw["model"], "thinking": kw["thinking"], "status": "running",
                              "labels": kw["labels"], "cwd": str(kw["cwd"]), "workspace_id": kw.get("workspace_id"), "updated": f"2026-11-0{len(self.made)}T00:00:00Z", "last_user": None})
        return {"agentId": ext}

    def send(self, agent_id, text, behavior="steer"):
        pass

    def interrupt(self, agent_id):
        pass

    def label(self, agent_id, labels):
        self.labels[agent_id] = labels

    def timeline(self, agent_id, limit):
        return {"agent": self.conv | {"status": "permission", "permissions": [{"id": "req-1", "name": "Bash", "title": None, "arg": "ls"}]},
                "items": [{"kind": "user", "text": "hi"}, {"kind": "tool", "name": "Bash", "status": "completed", "arg": "ls"}]}

    def permit(self, agent_id, request_id, allow):
        self.permits.append((agent_id, request_id, allow))

    def list(self, labels):
        return self.convs


def test_paseo_conversations_are_imported_read_and_answered(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as c:
        town = app.state.town
        link = FakeLink()
        own = tmp_path / "their-repo"
        own.mkdir()
        link.conv["cwd"] = str(own)
        for name in ("conversations", "label", "timeline", "permit", "list", "status"):
            setattr(town.agents.paseo, name, getattr(link, name))
        first = c.post("/api/ideas", json={"text": IDEA}).json()["id"]
        second = c.post("/api/ideas", json={"text": "用小模型给论文图表自动写说明文字"}).json()["id"]



        a = c.post("/api/agents/import", json={"line_id": first, "role": "coder", "ext_id": "conv-1"}).json()
        assert a["runtime"] == "paseo" and a["ext_id"] == "conv-1" and a["model"] == "claude/claude-haiku-5-5"
        assert town.agents.get(a["id"])["cwd"] == str(own)
        assert not any(own.iterdir())
        assert link.labels["conv-1"]["papertown.agent"] == a["id"]

        sent = []
        town.agents.paseo.send = lambda ext, text, behavior="steer": sent.append(text)
        c.post(f"/api/agents/{a['id']}/brief")
        pt = Path(re.search(r"`(\S+/pt) brief`", sent[0]).group(1))
        assert pt.parent.parent == Path(town.agents._workdir(first, "coder"))
        r = subprocess.run([sys.executable, "-c", "import runpy, sys; print(*runpy.run_path(sys.argv[1])['link']())", str(pt)],
                           capture_output=True, text=True, env={"PATH": "/usr/bin:/bin"})
        url, agent_id, token = r.stdout.split()
        assert url == town.s.url and agent_id == a["id"]
        job = c.post(f"/api/bridge/{a['id']}/jobs", json={"name": "smoke", "command": "echo PROGRESS 100"},
                     headers={"x-papertown-token": token}).json()
        assert job["cwd"] == str(own)

        seq = town.pipeline.line(first)["seq"]
        convs = c.get("/api/paseo/conversations").json()["conversations"]
        assert convs[0]["linked"] == f"#{seq} 的代码员工"
        taken = c.post("/api/agents/import", json={"line_id": second, "role": "coder", "ext_id": "conv-1"})
        assert taken.status_code == 400 and f"#{seq} 的代码员工" in taken.json()["detail"]
        assert c.post("/api/agents/import", json={"line_id": first, "role": "coder", "ext_id": "nope"}).status_code == 400

        t = c.get(f"/api/agents/{a['id']}/timeline").json()
        assert [i["kind"] for i in t["items"]] == ["user", "tool"] and t["paseo"]["permissions"][0]["id"] == "req-1"
        assert t["agent"]["status"] == "working"
        # while the daemon is down it shows as unreachable, keeping what it was doing for when Paseo is back
        town.agents.paseo.status = lambda fresh=False: {"ok": False, "note": "Paseo 守护进程没有运行：paseo daemon start"}
        shown = c.get(f"/api/agents/{a['id']}").json()["agent"]
        assert shown["status"] == "offline" and "paseo daemon start" in shown["down"] and town.agents.get(a["id"])["status"] == "working"
        town.agents.paseo.status = link.status

        assert c.post(f"/api/agents/{a['id']}/permit", json={"request_id": "req-1", "allow": True}).json() == {"ok": True}
        assert link.permits == [("conv-1", "req-1", True)]


def test_a_leads_conversations_are_listed_renewed_and_resumed(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as c:
        town = app.state.town
        link = FakeLink()
        for name in ("conversations", "status", "create", "send", "interrupt", "list", "project", "workspace"):
            setattr(town.agents.paseo, name, getattr(link, name))
        lid = c.post("/api/ideas", json={"text": IDEA}).json()["id"]

        lead = c.post("/api/agents", json={"line_id": lid, "role": "lead"}).json()["id"]
        c.post(f"/api/agents/{lead}/start", json={"runtime": "paseo", "provider": "claude", "model": "claude-opus-5-5", "thinking": "high"})
        c.post(f"/api/agents/{lead}/brief")
        for text in ("主表什么时候能好？", "再问一句"):
            c.post(f"/api/agents/{lead}/say", json={"text": text})
        convs = c.get(f"/api/agents/{lead}/conversations").json()["conversations"]
        assert [(x["id"], x["title"], x["model"], x["current"]) for x in convs] == [("pa-1", "主表什么时候能好？", "claude/claude-opus-5-5", True)]

        new = c.post(f"/api/agents/{lead}/conversations/new").json()
        assert new["ext_id"] == "pa-2" and new["status"] == "working"
        assert {k: link.made[-1][k] for k in ("provider", "model", "thinking")} == {"provider": "claude", "model": "claude-opus-5-5", "thinking": "high"}
        convs = c.get(f"/api/agents/{lead}/conversations").json()["conversations"]
        assert [(x["id"], x["title"], x["current"]) for x in convs] == [("pa-2", None, True), ("pa-1", "主表什么时候能好？", False)]

        assert c.post(f"/api/agents/{lead}/conversations/pa-1").json()["ext_id"] == "pa-1"
        assert c.post(f"/api/agents/{lead}/conversations/conv-1").status_code == 400
        assert c.get("/api/agents/nobody/conversations").status_code == 404


def test_pi_usage_updates_agent_without_executor_ledger(town):
    lid = town.pipeline.create(IDEA)["id"]
    a = town.agents.ensure(lid, "coder")
    town.agents._charge(a["id"], "local-test", {"cost": .25, "input": 100, "output": 20})
    assert town.agents.get(a["id"])["cost"] == .25
    assert town.db.val("select count(*) from ledger") == 0
    assert town.pipeline.line(lid)["spent"] == 0


def test_historical_sim_jobs_still_list(town):
    from papertown.db import now
    town.db.insert("jobs", {"id": "old-sim", "name": "Historical", "backend": "sim", "status": "done", "created_at": now()})
    assert town.farm.list()[0]["backend"] == "sim"
    assert "sim" not in {b["id"] for b in town.farm.backends()}
