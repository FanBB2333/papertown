"""Subscription accounting uses temporary logs and fake quota readers only."""

import json
import os
import subprocess
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from papertown.api import create_app
from papertown.pricing import token_cost, PRICES
from papertown.project_dirs import owner, project_roots
from papertown.town import Town
from papertown.usage import Usage, budget_state, week_start
from papertown.usage_logs import metadata
from papertown.usage_readers import Readers, UsageError, agy_report, iso, paseo_reports

from .conftest import make_settings

START = 1_795_276_800.0
SID = "a94a0700-4c05-464f-85dd-5f3a3334d847"


class Clock:
    def __init__(self):
        self.at = START

    def __call__(self):
        return self.at


def entry(provider, clock, used=10, reset=None):
    return {"id": f"{provider}-account", "sourceId": f"{provider}-usage", "sourceLabel": provider,
            "account": {"label": "sample"}, "fetchedAt": iso(clock()), "successfulAt": iso(clock()),
            "report": {"status": "available", "planLabel": "Sample plan", "windows": [
                {"id": "weekly", "label": "Weekly", "usedPct": used, "remainingPct": 100 - used,
                 "resetsAt": iso(reset or START + 7 * 86400)},
                {"id": "five_hour", "label": "5h", "usedPct": 2, "resetsAt": iso(clock() + 18000)}],
                "balances": [{"id": "credits", "label": "Credits", "unit": "credits", "remaining": 12}]}}


def agy(clock, used=10):
    return {"status": "SUCCESS", "num_turns": 0, "usage": {"total_tokens": 0}, "command": {"name": "usage", "data": {
        "groups": [{"name": group, "buckets": [
            {"id": f"{key}-weekly", "name": "Weekly Limit Remaining", "window": "weekly", "remaining_fraction": 1-used/100,
             "reset_time": iso(START + 7 * 86400)},
            {"id": f"{key}-5h", "name": "Five Hour Limit Remaining", "window": "5h", "remaining_fraction": 1,
             "reset_time": "1970-01-01T00:00:00Z"}]} for group, key in [("Gemini Models", "gemini"), ("Claude and GPT models", "3p")]]}}}


class FakeReaders:
    def __init__(self, clock):
        self.clock, self.used, self.reset = clock, 10, None
        self.calls = []
        self.fail = False

    def paseo(self, force):
        self.calls.append(("paseo", force))
        if self.fail:
            raise UsageError("Paseo 用量读取超时")
        return paseo_reports([entry(p, self.clock, self.used, self.reset) for p in ("claude", "codex")])

    def agy(self, at):
        self.calls.append(("agy", False))
        return [agy_report(agy(self.clock, self.used), at)]


@pytest.fixture
def usage(tmp_path):
    town = Town(make_settings(tmp_path))
    clock = Clock()
    readers = FakeReaders(clock)
    town.usage = service = Usage(town, readers=readers, clock=clock)
    for i, lid in enumerate(("a", "b"), 1):
        town.db.insert("lines", {"id": lid, "seq": i, "title": lid, "idea": "sample", "status": "running", "created_at": iso(START - 40 * 86400)})
    return service, clock, readers


def log(path: Path, records, at=START, append=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a" if append else "w") as f:
        for record in records:
            f.write(json.dumps(record) + "\n")
    os.utime(path, (at, at))
    return path


def claude(cwd, key, at=START, inp=100):
    return {"type": "assistant", "sessionId": "session-one", "cwd": str(cwd), "timestamp": iso(at),
            "message": {"id": key, "model": "claude-sonnet-5-5", "content": [{"text": "PRIVATE CONVERSATION"}],
                        "usage": {"input_tokens": inp, "cache_creation_input_tokens": 10, "cache_read_input_tokens": 20, "output_tokens": 30}}}


def claude_path(service):
    return Path(service.s.claude_home) / "projects/project/session.jsonl"


def test_paseo_schema_last_good_and_agy_groups():
    clock = Clock()
    sample = entry("claude", clock)
    parsed = paseo_reports([sample])["claude"][0]
    assert [w["id"] for w in parsed["windows"]] == ["weekly", "five_hour"]
    assert all("budget" not in w for w in parsed["windows"])
    assert parsed["balances"][0]["remaining"] == 12
    sample["lastSuccessful"] = {"report": sample["report"], "fetchedAt": iso(clock())}
    sample["report"] = {"status": "unavailable", "problem": {"kind": "login_required"}}
    fallback = paseo_reports([sample])["claude"][0]
    assert fallback["windows"] == parsed["windows"] and "登录" in fallback["error"]
    windows = agy_report(agy(clock), clock())["windows"]
    assert len(windows) == 4 and windows[1]["resets_at"] is None
    assert windows[0]["used"] == pytest.approx(10)
    assert {w["group"] for w in windows} == {"Gemini Models", "Claude and GPT models"}


def test_claude_incremental_dedup_rotation_and_privacy(usage):
    service, clock, _ = usage
    cwd = service.s.projects_dir / "a/code"
    record = claude(cwd, "message-one")
    path = log(claude_path(service), [record, record])
    log(path.parent / "session/subagents/child.jsonl", [record])
    log(path.parent / "old.jsonl", [claude(cwd, "old")], at=START - 36 * 86400)
    service.scanner.scan(clock())
    service.scanner.scan(clock())
    assert service.tokens("claude", START - 100, START, "a") == {"input": 100, "cache_write": 10, "cache_write_1h": 0, "cache_read": 20, "output": 30}
    new = claude(cwd, "message-two")
    with path.open("ab") as f:
        f.write(json.dumps(new).encode())
    service.scanner.scan(clock())
    assert service.tokens("claude", START - 100, START)["input"] == 100
    with path.open("ab") as f:
        f.write(b"\n")
    service.scanner.scan(clock())
    log(path, [record, new, claude(cwd, "message-three")])
    restarted = Usage(service.town, readers=service.readers, clock=clock)
    restarted.scanner.scan(clock())
    assert service.tokens("claude", START - 100, START)["input"] == 300
    assert "PRIVATE CONVERSATION" not in "\n".join(service.db.conn.iterdump())


def test_codex_cumulative_deltas_and_copied_rollouts(usage):
    service, clock, _ = usage
    path = Path(service.s.codex_home) / "sessions/2026/11/21/rollout-one.jsonl"
    def total(i, cache, out):
        return {"type": "event_msg", "timestamp": iso(clock()), "payload": {"type": "token_count", "info": {
            "total_token_usage": {"input_tokens": i, "cached_input_tokens": cache, "output_tokens": out, "reasoning_output_tokens": out//2}}}}
    records = [{"type": "session_meta", "payload": {"id": "codex-one", "cwd": str(service.s.projects_dir / "b/code")}},
               {"type": "turn_context", "payload": {"model": "gpt-5.1-codex"}}, total(100, 20, 10), total(100, 20, 10), total(160, 40, 20)]
    log(path, records)
    log(path.with_name("rollout-copy.jsonl"), records)
    service.scanner.scan(clock())
    assert service.tokens("codex", START-60, START, "b") == {"input": 120, "cache_write": 0, "cache_write_1h": 0, "cache_read": 40, "output": 20}
    log(path, [total(200, 50, 30)], append=True)
    service.scanner.scan(clock())
    assert service.tokens("codex", START-60, START)["input"] == 150


def test_antigravity_step_dedup_models_and_workspace(usage):
    service, clock, _ = usage
    home = Path(service.s.antigravity_home)
    metadata = home / "cache/conversation_metadata.json"
    metadata.parent.mkdir(parents=True)
    metadata.write_text(json.dumps({"conversations": {SID: {"summary": {"WorkspaceURIs": [(service.s.projects_dir / "a/code").as_uri()], "title": "PRIVATE CONVERSATION"}}}}))
    record = {"step_index": 1, "model": "gemini-4-neon", "input_tokens": 100, "cache_read_tokens": 50, "output_tokens": 20, "text": "PRIVATE CONVERSATION"}
    path = log(home / f"brain/{SID}/.system_generated/logs/transcript.jsonl", [record, record, record | {"step_index": 2, "model": "claude-sonnet-5-5"}])
    log(path.with_name("transcript_full.jsonl"), [record])
    service.scanner.scan(clock())
    assert service.tokens("antigravity", START-60, START, "a")["input"] == 200
    assert {r["model"] for r in service.line("a")["models"]} == {"gemini-4-neon", "claude-sonnet-5-5"}
    assert service.line("a")["sessions"][0]["session"] == SID
    assert "PRIVATE CONVERSATION" not in "\n".join(service.db.conn.iterdump())


def test_shared_directory_ownership(usage, tmp_path):
    service, _, _ = usage
    town = service.town
    root = tmp_path / "repository"
    town.db.update("lines", {"id": "a"}, linked={"key": "repo", "code": str(root)})
    town.db.update("lines", {"id": "b"}, linked={"key": "nested", "paper": str(root / "nested")})
    town.db.insert("agents", {"id": "worker", "line_id": "a", "cwd": str(tmp_path / "worktree")})
    town.s.projects_file.write_text(json.dumps({"projects": [{"key": "repo", "code": str(tmp_path / "registered")}]}))
    roots = project_roots(town)
    assert owner(str(root / "nested/file"), roots) == "b"
    assert owner(str(root / "src"), roots) == "a"
    assert owner(str(tmp_path / "repository-other"), roots) is None
    assert owner(str(tmp_path / "registered/src"), roots) == "a"
    assert owner(str(tmp_path / "worktree"), roots) == "a"
    town.terminals._raw = {"one": {"terminal_id": "one", "pane_id": "pane", "cwd": str(root / "nested")}}
    groups, other = town.terminals.grouped(town.db.q("select id from lines"), town.db.q("select * from agents"))
    assert len(groups["b"]) == 1 and not other


def test_failures_preserve_values_and_force_limit_uses_fake_clock(usage):
    service, clock, readers = usage
    service.set_settings({"poll": 300})
    service.tick()
    service.tick()
    assert len(readers.calls) == 2
    service.poll(force=True)
    assert len(readers.calls) == 4
    clock.at += 59
    service.poll(force=True)
    assert len(readers.calls) == 4
    restarted = Usage(service.town, readers=readers, clock=clock)
    restarted.poll(force=True)
    assert len(readers.calls) == 4
    clock.at += 1
    readers.fail = True
    snapshot = service.poll(force=True)
    assert len(readers.calls) == 6
    assert snapshot["providers"][0]["status"] == "stale" and snapshot["providers"][0]["windows"][0]["used"] == 10
    assert snapshot["providers"][0]["fetched_at"] == iso(START)
    assert snapshot["providers"][2]["error"] is None
    clock.at += 299
    service.tick()
    assert len(readers.calls) == 6
    clock.at += 1
    service.tick()
    assert len(readers.calls) == 8


def test_log_switch_persistence_and_sample_retention(usage, monkeypatch):
    service, clock, readers = usage
    log(claude_path(service), [claude(service.s.projects_dir / "a/code", "one")])
    service.poll()
    spent = service.line("a")["spent"]
    assert spent > 0
    service.set_settings({"logs": False, "default_budget": 20, "poll": 600})
    monkeypatch.setattr(service.scanner, "scan", lambda _: pytest.fail("logs disabled"))
    service.db.insert("usage_samples", {"ts": START-36*86400})
    service.poll()
    clock.at += 60
    readers.used = 30
    service.poll()
    assert service.line("a")["spent"] == spent
    assert not service.line("a")["logs"]
    assert service.db.val("select min(ts) from usage_samples") >= START
    assert Usage(service.town).settings() == {"logs": False, "default_budget": 20, "poll": 600}


@pytest.mark.parametrize("used,budget,state", [(0, None, "none"), (7.99, 10, "ok"), (8, 10, "near"), (10, 10, "over")])
def test_budget_states(used, budget, state):
    assert budget_state(used, budget) == state


def test_prices_unknown_models_and_overrides(monkeypatch):
    tokens = {"input": 100, "cache_write": 20, "cache_read": 40, "output": 10}
    assert token_cost("gpt-5.1-codex", tokens) == (pytest.approx((1.25 * 129 + 100)/1e6), True)
    assert token_cost("future-model", tokens) == (0, False)
    assert token_cost("Claude Sonnet 5.5", tokens) == token_cost("claude-sonnet-5-5", tokens)
    monkeypatch.setitem(PRICES, "future-model", (4, 20))
    assert token_cost("future-model", tokens) == (pytest.approx((4 * 129 + 200)/1e6), True)
    # gpt-6.2-sol lists its own cache read price, $0.10 instead of a tenth of $2.
    assert token_cost("gpt-6.2-sol", tokens)[0] == pytest.approx((2 * 125 + 0.10 * 40 + 100)/1e6)



def test_model_cache_read_price_and_hour_long_writes():
    from papertown.usage_logs import counts
    usage = {"input_tokens": 100, "cache_creation_input_tokens": 50, "cache_read_input_tokens": 1000, "output_tokens": 10,
             "cache_creation": {"ephemeral_5m_input_tokens": 20, "ephemeral_1h_input_tokens": 30}}
    tokens = counts(usage, "claude")
    assert (tokens["cache_write"], tokens["cache_write_1h"]) == (50, 30)
    # Fable 5.2: $8 in, $40 out, $0.20 cache reads, five-minute writes at 1.25x and hour-long writes at 2x.
    assert token_cost("claude-fable-5-2", tokens)[0] == pytest.approx((8 * (100 + 1.25 * 20 + 2 * 30) + 0.2 * 1000 + 40 * 10) / 1e6)
    assert token_cost("claude-sonnet-5-5", tokens)[0] == pytest.approx((2 * (100 + 1.25 * 20 + 2 * 30) + 0.1 * 1000 + 10 * 10) / 1e6)


def test_metadata_discards_prose_even_in_container_fields():
    record = metadata(json.dumps({"payload": {"message": "PRIVATE", "summary": "PRIVATE", "type": "agent_message"}}))
    assert record == {"payload": {"type": "agent_message"}}


def test_concurrent_force_requests_share_one_refresh(usage):
    service, _, readers = usage
    gate = threading.Barrier(3)
    results = []
    def refresh():
        gate.wait(timeout=5)
        try:
            results.append(service.poll(force=True))
        finally:
            service.db.conn.close()
    workers = [threading.Thread(target=refresh) for _ in range(2)]
    for worker in workers:
        worker.start()
    gate.wait(timeout=5)
    for worker in workers:
        worker.join(timeout=5)
        assert not worker.is_alive()
    assert len(results) == 2 and readers.calls == [("paseo", True), ("agy", False)]


def test_readers_use_only_quota_commands_and_redact_failures(usage, monkeypatch):
    service, clock, _ = usage
    readers = Readers(service.town)
    def run(cmd, **kw):
        assert cmd == [service.s.agy_bin, "-p", "/usage", "--output-format", "json"] and kw["timeout"] == 30
        return subprocess.CompletedProcess(cmd, 0, json.dumps(agy(clock)), "")
    monkeypatch.setattr(subprocess, "run", run)
    assert readers.agy(clock())[0]["windows"]
    monkeypatch.setattr(subprocess, "run", lambda cmd, **kw: subprocess.CompletedProcess(cmd, 1, "PRIVATE CONVERSATION", "secret"))
    with pytest.raises(UsageError, match="Antigravity") as caught:
        readers.agy(clock())
    assert "secret" not in str(caught.value)
    def timeout(*args, **kw):
        raise subprocess.TimeoutExpired("agy", 30)
    monkeypatch.setattr(subprocess, "run", timeout)
    with pytest.raises(UsageError, match="超时"):
        readers.agy(clock())


def test_api_usage_budget_settings_and_shapes(tmp_path, monkeypatch):
    app = create_app(make_settings(tmp_path))
    town = app.state.town
    clock = Clock()
    town.usage = Usage(town, readers=FakeReaders(clock), clock=clock)
    with TestClient(app) as c:
        for i, lid in enumerate(("test", "blank"), 1):
            town.db.insert("lines", {"id": lid, "seq": i, "title": "sample", "idea": "sample", "status": "running",
                                     "created_at": iso(START - 100)})
        assert c.put("/api/lines/test/usage_budget", json={"usd": 250}).status_code == 200
        assert town.db.one("select usage_budget from lines where id = 'test'")["usage_budget"] == 250
        assert c.put("/api/lines/blank/usage_budget", json={"usd": None}).status_code == 200
        assert c.get("/api/lines/blank/usage").json()["budget"] is None
        detail = c.get("/api/lines/test/usage").json()
        assert {"budget", "spent", "state", "since", "week", "providers", "models", "sessions"} <= detail.keys()
        assert detail["budget"] == 250 and detail["state"] == "ok"
        view = c.post("/api/usage/refresh").json()
        assert {"polled_at", "next_at", "providers", "logs"} <= view.keys()
        assert {"id", "label", "plan", "status", "error", "notes", "fetched_at", "windows", "balances", "week"} == view["providers"][0].keys()
        assert {"cost", "projects", "tokens", "unpriced"} == view["providers"][0]["week"].keys()
        assert c.get("/api/usage").json()["providers"] == view["providers"]
        for value in (-1, 0, True, "10", {}, []):
            assert c.put("/api/lines/test/usage_budget", json={"usd": value}).status_code == 400
        assert c.put("/api/lines/test/usage_budget", json={"claude": 10}).status_code == 400
        assert c.put("/api/lines/test/usage_budget", json={"usd": None}).json()["budget"] is None
        assert c.put("/api/usage/settings", json={"poll": 59}).status_code == 400
        assert c.put("/api/usage/settings", json={"default_budget": 30, "logs": False, "poll": 600}).json()["poll"] == 600
        assert c.get("/api/usage/settings").json()["default_budget"] == 30
        assert c.get("/api/lines/missing/usage").status_code == 400


def test_session_ownership_overrides_directory_and_keeps_past_sessions(usage, monkeypatch):
    service, clock, _ = usage
    town = service.town
    town.db.insert("agents", {"id": "coder", "line_id": "a", "role": "coder", "runtime": "paseo", "ext_id": "ext",
                              "model": "claude/claude-sonnet-5-5", "status": "working"})
    monkeypatch.setattr(town.agents, "_publish", lambda *a: None)
    for sid in ("old-session", "new-session"):
        town.agents._apply_snapshot(town.agents.get("coder"), {"id": "ext", "status": "running", "provider": "claude", "model": "claude-sonnet-5-5", "session_id": sid})
    assert town.db.val("select session_id from agents where id = 'coder'") == "new-session"
    assert town.db.val("select count(*) from agent_sessions") == 2
    records = [claude(service.s.projects_dir / "b/code", sid) | {"sessionId": sid} for sid in ("old-session", "new-session")]
    log(claude_path(service), records)
    service.scanner.scan(clock())
    result = service.line("a")
    assert len(result["sessions"]) == 2 and service.line("b")["spent"] == 0
    assert all(r["owner"] == {"kind": "agent", "id": "coder", "name": "代码员工"} for r in result["sessions"])
    assert {r["session_id"] for r in service.db.q("select * from usage_tokens")} == {"old-session", "new-session"}
    town.db.update("agents", {"id": "coder"}, node_id="task")
    town.canvas._path("a").parent.mkdir(parents=True, exist_ok=True)
    town.canvas._path("a").write_text(json.dumps({"nodes": [{"id": "task", "kind": "task", "title": "复现实验"}]}))
    assert service.line("a")["sessions"][0]["owner"]["name"] == "复现实验"


def test_terminal_id_ownership_and_directory_fallback(usage):
    service, clock, _ = usage
    cwd = service.s.projects_dir / "a/code"
    service.town.terminals._raw = {
        "one": {"terminal_id": "one", "pane_id": "p1", "agent": "claude", "name": "实验终端", "cwd": str(cwd), "agent_session": {"kind": "id", "value": "terminal-session"}},
        "two": {"terminal_id": "two", "pane_id": "p2", "agent": "claude", "name": "其他终端", "cwd": str(cwd), "agent_session": {"kind": "path", "value": "directory-session"}},
    }
    log(claude_path(service), [claude(cwd, "one") | {"sessionId": "terminal-session"}, claude(cwd, "two") | {"sessionId": "directory-session"}])
    service.scanner.scan(clock())
    sessions = {r["session"]: r for r in service.line("a")["sessions"]}
    assert sessions["terminal-session"]["owner"] == {"kind": "terminal", "id": "herdr:one", "name": "实验终端"}
    assert sessions["directory-session"]["owner"]["kind"] == "dir"
    service.town.terminals._raw.clear()
    assert {r["session"]: r for r in service.line("a")["sessions"]}["terminal-session"]["owner"]["name"] == "实验终端"


def test_creation_cutoff_week_costs_models_and_local_totals(usage):
    service, clock, _ = usage
    service.db.update("lines", {"id": "a"}, created_at=iso(START - 10))
    cwd = service.s.projects_dir / "a/code"
    records = [claude(cwd, "before", START-11), claude(cwd, "after", START-9), claude('/unrelated', "local"), claude(cwd, "unpriced")]
    records[-1]["message"]["model"] = "future-model"
    log(claude_path(service), records)
    log(claude_path(service).with_name('history.jsonl'), [claude(service.s.projects_dir / "b/code", "history", START-20*86400)], at=START-20*86400)
    service.poll()
    result = service.line("a")
    expected = token_cost("claude-sonnet-5-5", {"input": 100, "cache_write": 10, "cache_write_1h": 0, "cache_read": 20, "output": 30})[0]
    assert result["spent"] == pytest.approx(expected) and result["week"] == result["spent"]
    assert result["providers"][0]["tokens"]["input"] == 200
    assert next(m for m in result["models"] if m["model"] == "future-model")["priced"] is False
    assert service.line("b")["spent"] == pytest.approx(expected) and service.line("b")["week"] == 0
    week = service.snapshot()["providers"][0]["week"]
    assert week["cost"] == pytest.approx(3 * expected) and week["projects"] == pytest.approx(expected)
    assert week["tokens"]["input"] == 400


def test_usd_alerts_once_per_budget_and_persist_across_restart(usage):
    service, clock, readers = usage
    log(claude_path(service), [claude(service.s.projects_dir / "a/code", "one", inp=1_000_000)])
    service.poll()
    service.set_budget("a", 2.5)
    assert service.line("a")["state"] == "near"
    assert service.db.val("select count(*) from reports where kind = 'usage'") == 1
    service.set_budget("a", 2)
    assert service.line("a")["state"] == "over"
    assert service.db.val("select count(*) from reports where kind = 'usage'") == 3
    service.set_budget("a", 2)
    restarted = Usage(service.town, readers=readers, clock=clock)
    restarted.poll()
    assert service.db.val("select count(*) from reports where kind = 'usage'") == 3
    service.set_budget("a", 1)
    assert service.db.val("select count(*) from reports where kind = 'usage'") == 5
    service.set_budget("a", None)
    service.set_budget("a", 2)
    assert service.db.val("select count(*) from reports where kind = 'usage'") == 5
    brief = "\n".join(service.brief("a"))
    assert "Agent 用量：$2.00 / 预算 $2（超出预算）" in brief and "本周 Agent 用量" in brief
    before = service.line("a")["spent"]
    clock.at += 8*86400
    readers.used, readers.reset = 0, clock() + 7*86400
    service.poll()
    assert service.line("a")["spent"] == before and service.line("a")["week"] == 0


def test_late_snapshot_reassigns_unchanged_logs(usage):
    service, clock, _ = usage
    service.db.update('lines', {'id': 'a'}, created_at=iso(START-10))
    log(claude_path(service), [claude('/external', 'before', START-11), claude('/external', 'after', START-9)])
    service.scanner.scan(clock())
    assert service.line("a")["spent"] == 0
    service.db.insert("agent_sessions", {"session_id": "session-one", "agent_id": "coder", "line_id": "a", "provider": "claude"})
    service.scanner.scan(clock())
    assert service.line("a")["providers"][0]["tokens"]["input"] == 100


def test_week_starts_on_local_monday(monkeypatch):
    import time as clock
    from papertown.usage_readers import stamp
    monkeypatch.setenv("TZ", "Asia/Shanghai")
    clock.tzset()
    try:
        # Sunday 23:59 and Monday 00:00 in Shanghai are 15:59 and 16:00 UTC.
        assert week_start(stamp("2026-11-22T15:59:59Z")) == stamp("2026-11-15T16:00:00Z")
        assert week_start(stamp("2026-11-22T16:00:00Z")) == stamp("2026-11-22T16:00:00Z")
    finally:
        monkeypatch.delenv("TZ")
        clock.tzset()


def test_a_stale_second_login_is_a_note(usage):
    service, clock, readers = usage
    fresh = readers.paseo
    stale = {"id": "codex:old", "sourceId": "codex", "fetchedAt": iso(clock()), "report": {"status": "failed", "problem": {"kind": "expired"}}}
    readers.paseo = lambda force: {**fresh(force), "codex": fresh(force)["codex"] + paseo_reports([stale])["codex"]}
    codex = next(p for p in service.poll()["providers"] if p["id"] == "codex")
    assert codex["status"] == "available" and codex["error"] is None
    assert codex["notes"] == ["订阅登录已失效，请重新登录"]
    readers.paseo = lambda force: paseo_reports([stale])
    clock.at += 600
    codex = next(p for p in service.poll()["providers"] if p["id"] == "codex")
    assert codex["error"] == "订阅登录已失效，请重新登录" and codex["notes"] == []


def test_price_overrides_from_the_settings(tmp_path, monkeypatch):
    from papertown import pricing
    monkeypatch.setattr(pricing, "PRICES", dict(PRICES))
    monkeypatch.setenv("PAPERTOWN_PRICES", '{"custom": [3, 7]}')
    pricing.extend(make_settings(tmp_path).prices)
    assert token_cost("custom", dict(input=1000000, cache_write=0, cache_read=0, output=1000000)) == (10.0, True)
    pricing.extend("not json")  # changes nothing
    assert pricing.PRICES["custom"] == (3, 7)


def test_prototype_migration_rebuilds_session_cache_and_preserves_windows(tmp_path):
    from papertown.db import DB
    import sqlite3
    path = tmp_path / "old.db"
    conn = sqlite3.connect(path)
    conn.executescript("""
        create table lines(id text primary key, seq integer, usage_budget text);
        insert into lines values ('old', 1, '{"claude": 25}');
        create table usage_tokens(minute integer, provider text, model text, grp text, line_id text,
          input integer, cache_write integer, cache_read integer, output integer, weight real);
        create table usage_files(path text primary key, offset integer, mtime real, data text);
        insert into usage_files values ('sample', 123, 0, '{}');
        create table usage_alerts(line_id text, provider text, account text, window text, epoch text, threshold integer);
        create table usage_share(provider text);
        create table usage_samples(id integer primary key, ts real, provider text, account text, window text, used real,
          resets_at text, plan text, data text);
        insert into usage_samples values (1, 0, 'claude', 'account', 'weekly', 25, null, 'plan', '{}');
    """)
    conn.close()
    db = DB(path)
    assert db.val("select used from usage_samples") == 25
    assert db.val("select usage_budget from lines") is None
    assert db.val("select count(*) from usage_files") == 0
    columns = {r[1]: r[2] for r in db.conn.execute("pragma table_info(usage_tokens)")}
    assert "session_id" in columns and "weight" not in columns
    assert db.val("select count(*) from sqlite_master where name='usage_share'") == 0
    db.update("lines", {"id": "old"}, usage_budget=123.5)
    assert db.val("select typeof(usage_budget) from lines") == "real"
    db.conn.close()


def test_logins_paseo_stops_listing_are_dropped(usage):
    service, clock, readers = usage
    renamed = entry("claude", clock, used=40) | {"id": "claude-old-id"}
    signed_out = entry("claude", clock) | {"id": "claude-signed-out", "report": {"status": "unavailable"}}
    readers.paseo = lambda force: paseo_reports([renamed, entry("codex", clock)])
    service.poll(force=True)
    readers.paseo = lambda force: paseo_reports([entry("claude", clock, used=41), signed_out, entry("codex", clock)])
    clock.at += 60
    snapshot = service.poll(force=True)
    claude = snapshot["providers"][0]
    # the same login under a new id shows once, and a listed login that cannot be read adds a note only
    assert {w["account"] for w in claude["windows"]} == {"claude-account"}
    assert [w["used"] for w in claude["windows"] if w["id"] == "weekly"] == [41]
    assert claude["status"] == "available" and claude["notes"]
    # Paseo listing nothing, or failing outright, keeps the last readings
    readers.paseo = lambda force: paseo_reports([])
    clock.at += 60
    assert service.poll(force=True)["providers"][0]["windows"]
    readers.paseo = lambda force: (_ for _ in ()).throw(UsageError("Paseo 用量读取超时"))
    clock.at += 60
    assert service.poll(force=True)["providers"][0]["windows"]
