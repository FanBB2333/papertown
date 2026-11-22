import threading

import pytest

from papertown.agents import AgentError
from papertown.leads import LeadError, RETRY
from .test_backends import tmux  # Reuse the dedicated socket and fake CLI fixture.


def project(town, monkeypatch):
    monkeypatch.setattr(town.leads, "wake", lambda _: None)
    return town.pipeline.create("A resident lead research project")["id"]


def fake_start(town, monkeypatch):
    calls = []
    def start(aid, runtime=None, provider=None, model=None, thinking=None):
        calls.append((aid, runtime, provider, model, thinking))
        town.agents._set(aid, runtime="paseo", ext_id="fake-" + aid, status="idle", model=model)
        return town.agents.get(aid)
    monkeypatch.setattr(town.agents, "start", start)
    monkeypatch.setattr(town.agents, "down", lambda _: "")
    return calls


def test_default_switches(town, monkeypatch):
    lid = project(town, monkeypatch)
    assert town.leads.settings(lid)["on"]
    town.db.update("lines", {"id": lid}, sample=1)
    assert not town.leads.settings(lid)["on"]
    town.db.update("lines", {"id": lid}, sample=0, status="done")
    assert not town.leads.settings(lid)["on"] and town.leads.resident(lid)["state"] == "ended"
    town.db.update("lines", {"id": lid}, status="linked")
    assert town.leads.settings(lid)["on"]


def test_ensure_respects_global_setting_and_force(town, monkeypatch):
    lid = project(town, monkeypatch)
    calls = fake_start(town, monkeypatch)
    town.leads.ensure(lid)
    assert calls == []
    town.leads.ensure(lid, force=True)
    assert len(calls) == 1 and town.leads.resident(lid)["state"] == "running"
    town.leads.ensure(lid, force=True)
    assert len(calls) == 1


def test_create_wake_respects_global_setting(town, monkeypatch):
    attempted = threading.Event()
    monkeypatch.setattr(town.agents, "start", lambda *a, **k: attempted.set())
    town.pipeline.create("A project with automatic startup disabled")
    assert not attempted.wait(.1)


def test_failed_start_is_blocked_and_retried(town, monkeypatch):
    lid = project(town, monkeypatch)
    town.s.lead_resident = True
    clock = [1000.0]
    monkeypatch.setattr("papertown.leads.time.time", lambda: clock[0])
    calls = []
    def fail(*args):
        calls.append(args)
        raise AgentError("本机 CLI 尚未安装")
    monkeypatch.setattr(town.agents, "start", fail)
    town.leads.ensure(lid)
    resident = town.leads.resident(lid)
    assert resident["state"] == "blocked" and "CLI" in resident["note"]
    town.leads.ensure(lid)
    assert len(calls) == 1
    clock[0] += RETRY
    town.leads.ensure(lid)
    assert len(calls) == 2


@pytest.mark.parametrize("runtime", ["paseo", "tmux", "herdr"])
def test_switch_off_stops_session(town, monkeypatch, runtime):
    lid = project(town, monkeypatch)
    a = town.agents.ensure(lid, "lead")
    town.agents._set(a["id"], runtime=runtime, ext_id="fake", term={"status": "working"})
    closed, aborted = [], []
    monkeypatch.setattr(town.agents.hosted, "close", closed.append)
    monkeypatch.setattr(town.agents, "abort", aborted.append)
    town.leads.configure(lid, on=False)
    assert (aborted if runtime == "paseo" else closed) == [a["id"]]
    assert town.leads.resident(lid)["state"] == "off"


def test_hire_starts_once_and_obeys_bounds(town, monkeypatch):
    lid = project(town, monkeypatch)
    lead = town.agents.ensure(lid, "lead")
    calls = fake_start(town, monkeypatch)
    assert "启动了" in town.leads.hire(lead["id"], "coder")
    assert "已经在运行" in town.leads.hire(lead["id"], "coder")
    assert len(calls) == 1
    kind = ["never"]
    monkeypatch.setattr(town.bounds, "policy", lambda *a: (kind[0], {"text": "先确认"}))
    with pytest.raises(LeadError):
        town.leads.hire(lead["id"], "writer")
    kind[0] = "ask"
    town.leads.hire(lead["id"], "writer")
    assert len(calls) == 1
    ask = town.leads.asks(lid)[0]
    assert ask["data"]["act"]["action"] == "agent.start"
    town.leads.answer(ask["id"], "可以")
    assert len(calls) == 2 and town.agents.get(f"writer-{lid}")["runtime"] == "paseo"


def test_hire_in_a_linked_repository_asks_first(town, monkeypatch):
    lid = project(town, monkeypatch)
    lead = town.agents.ensure(lid, "lead")
    calls = fake_start(town, monkeypatch)
    monkeypatch.setattr(town.linked, "workdir", lambda line_id, role: "/repos/proj" if role == "coder" else None)
    assert "先问用户" in town.leads.hire(lead["id"], "coder")
    assert not calls
    ask = town.leads.asks(lid)[0]
    assert "/repos/proj" in ask["data"]["question"] and ask["data"]["act"]["role"] == "coder"
    town.leads.answer(ask["id"], "可以")
    assert len(calls) == 1
    assert "已经在运行" in town.leads.hire(lead["id"], "coder") and not town.leads.asks(lid)


@pytest.mark.parametrize("status", ["run", "done", "todo"])
def test_stage_obeys_ask_and_never(town, monkeypatch, status):
    lid = project(town, monkeypatch)
    a = town.agents.ensure(lid, "lead")
    kind = ["never"]
    monkeypatch.setattr(town.bounds, "policy", lambda *args: (kind[0], {"text": "先确认"}))
    with pytest.raises(LeadError):
        town.leads.stage(a["id"], "team", status)
    kind[0] = "ask"
    town.leads.stage(a["id"], "team", status)
    assert town.pipeline.snapshot(lid)["stages"][2]["status"] == "todo"
    q = town.leads.asks(lid)[0]
    town.leads.answer(q["id"], "可以")
    assert town.pipeline.snapshot(lid)["stages"][2]["status"] == status


def test_loop_ensures_live_projects_only(town, monkeypatch):
    town.leads.stop()
    lid = project(town, monkeypatch)
    other = town.pipeline.create("Another linked project")["id"]
    ended = town.pipeline.create("A finished project")["id"]
    town.db.update("lines", {"id": other}, status="linked")
    town.db.update("lines", {"id": ended}, status="done")
    calls = []
    waits = iter([False, True])
    monkeypatch.setattr(town.leads._halt, "wait", lambda _: next(waits))
    monkeypatch.setattr(town.leads, "ensure", calls.append)
    town.leads._loop()
    assert calls == [lid, other]


def test_resident_lead_and_hired_worker_on_isolated_tmux(tmux):
    from .test_terminals import eventually
    town, hosted, _ = tmux
    town.s.lead_resident = True
    town.s.agent_runtime = "tmux"
    town.s.lead_model = "claude/fake-model@high"
    lid = town.pipeline.create("A resident lead on an isolated terminal")["id"]
    aid = f"lead-{lid}"
    eventually(lambda: town.agents.get(aid) and town.agents.get(aid).get("term"))
    eventually(lambda: hosted.refresh(aid)["term"]["status"] in ("idle", "done"))
    assert town.leads.resident(lid)["state"] == "running"
    town.leads.hire(aid, "coder")
    coder = f"coder-{lid}"
    eventually(lambda: hosted.refresh(coder)["term"]["status"] in ("idle", "done"))
    assert {a["role"] for a in town.pipeline.agents(lid)} == {"lead", "coder"}
    town.leads.configure(lid, on=False)
    assert town.agents.get(aid)["term"]["status"] == "exited"
    town.leads.configure(lid, on=True)
    eventually(lambda: hosted.refresh(aid)["term"]["status"] in ("idle", "done"))
    assert town.leads.resident(lid)["state"] == "running"
    town.leads.configure(lid, on=False)
    hosted.close(coder)

