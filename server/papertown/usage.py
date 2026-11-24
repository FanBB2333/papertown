"""Subscription snapshots, session billing statistics and advisory USD budgets."""

from __future__ import annotations

import copy
import json
import math
import threading
import time
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Callable

from .db import read_json, write_json
from .usage_logs import COUNTS, Ownership, Scanner
from .pricing import extend as extend_prices, token_cost
from .usage_readers import LABELS, Readers, UsageError, iso, stamp

if TYPE_CHECKING:
    from .town import Town


def budget_value(value: object) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise UsageError("Agent 用量预算须为大于 0 的美元金额，留空表示不设预算")
    return float(value)


def week_start(at: float) -> float:
    """Monday 00:00 in the machine's own time zone."""
    day = datetime.fromtimestamp(at).astimezone()
    return (day - timedelta(days=day.weekday())).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()


def totals(rows: list[dict]) -> dict:
    tokens = {k: sum(r[k] for r in rows) for k in COUNTS}
    return {"cost": sum(token_cost(r["model"], r)[0] for r in rows), "tokens": tokens}


def unpriced(rows: list[dict]) -> list[str]:
    return sorted({r["model"] for r in rows if not token_cost(r["model"], r)[1]})


def budget_state(used: float, budget: float | None) -> str:
    return "none" if budget is None else "over" if used >= budget else "near" if used >= budget * .8 else "ok"


class Usage:
    def __init__(self, town: Town, *, readers: Readers | None = None, clock: Callable[[], float] = time.time):
        self.town, self.db, self.s = town, town.db, town.s
        extend_prices(self.s.prices)
        self.clock, self.readers = clock, readers or Readers(town)
        self.scanner = Scanner(town)
        self._lock = threading.RLock()
        self._halt, self._wake = threading.Event(), threading.Event()
        self._thread: threading.Thread | None = None
        self._path = self.s.data_dir / "usage.json"
        self._state = json.loads(self.db.get_meta("usage_state") or "{}")

    def settings(self) -> dict:
        saved = read_json(self._path, {})
        return {"default_budget": saved.get("default_budget"), "poll": saved.get("poll", self.s.usage_poll),
                "logs": saved.get("logs", self.s.usage_logs)}

    def set_settings(self, values: dict) -> dict:
        with self._lock:
            settings = self.settings()
            if "default_budget" in values:
                settings["default_budget"] = budget_value(values["default_budget"])
            if "poll" in values:
                poll = values["poll"]
                if isinstance(poll, bool) or not isinstance(poll, (int, float)) or not math.isfinite(poll) or not 60 <= poll <= 86400:
                    raise UsageError("用量轮询间隔须为 60 至 86400 秒")
                settings["poll"] = float(poll)
            if "logs" in values:
                if not isinstance(values["logs"], bool):
                    raise UsageError("会话日志开关须为布尔值")
                settings["logs"] = values["logs"]
            write_json(self._path, settings)
            self._wake.set()
            self.town.bus.publish("usage")
            return settings

    def set_budget(self, line_id: str, usd: float | None) -> dict:
        with self._lock:
            if not self.db.one("select id from lines where id = ?", line_id):
                raise UsageError("没有这个项目")
            budget = budget_value(usd)
            self.db.update("lines", {"id": line_id}, usage_budget=budget)
            self._alerts(line_id)
            self.town.bus.publish("usage", line_id=line_id)
            return self.line(line_id)

    def poll(self, force: bool = False) -> dict:
        with self._lock:
            at = self.clock()
            state = copy.deepcopy(self._state)
            forced = state.setdefault("forced", {})
            eligible = {p for p in LABELS if not force or at - forced.get(p, -1e20) >= 60}
            if force and not eligible:
                return self.snapshot()
            # Reserve before I/O, including failed attempts and process restarts.
            if force:
                for p in eligible:
                    forced[p] = at
                self.db.set_meta("usage_state", json.dumps(state))
                self._state = copy.deepcopy(state)
            result: dict[str, list[dict]] = {}
            errors = {}
            if {"claude", "codex"} & eligible:
                # The SDK refreshes both accounts in one connection, so throttle them together.
                if not force or {"claude", "codex"} <= eligible:
                    try:
                        result.update(self.readers.paseo(force))
                    except Exception as e:
                        errors.update({p: str(e) if isinstance(e, UsageError) else "订阅用量读取失败，请检查登录状态或稍后重试"
                                       for p in ("claude", "codex")})
            if "antigravity" in eligible:
                try:
                    result["antigravity"] = self.readers.agy(at)
                except Exception as e:
                    errors["antigravity"] = str(e) if isinstance(e, UsageError) else "订阅用量读取失败，请检查登录状态或稍后重试"
            settings = self.settings()
            scan_error = None
            if settings["logs"]:
                try:
                    self.scanner.scan(at)
                except Exception:
                    scan_error = "本机会话用量读取失败，将在下次轮询重试"
            providers = state.setdefault("providers", {})
            samples = []
            for p in eligible:
                old = providers.get(p, {"accounts": {}})
                entries = result.get(p) or []
                accounts = old["accounts"]
                reasons = [errors[p]] if p in errors else []
                notes = []
                if not entries and not reasons:
                    reasons.append("订阅尚未提供用量报告")
                # Paseo may list several logins for one provider. A stale login is a note
                # while another one still reads fine.
                readable = any(e.get("windows") and not e.get("error") for e in entries)
                for entry in entries:
                    if entry.get("error"):
                        (notes if readable else reasons).append(entry["error"])
                    if not entry.get("windows"):
                        continue
                    account = entry["account"]
                    current = copy.deepcopy(entry)
                    sampled = stamp(current.get("fetched_at"))
                    if sampled is None:
                        reasons.append("订阅用量报告格式无效")
                        continue
                    # Retain every reading, including cached reports, with its original freshness.
                    samples.extend((at, p, account, w["id"], w["used"], w["resets_at"], current.get("plan"),
                                    json.dumps(w | {"fetched_at": current["fetched_at"]})) for w in current["windows"])
                    before = accounts.get(account)
                    if not before or sampled > (stamp(before.get("fetched_at")) or 0):
                        accounts[account] = current
                # A login Paseo no longer lists (signed out, or listed under a new id) goes, so one
                # account is not shown twice. One it lists but cannot read keeps its last reading.
                if entries:
                    listed = {e["account"] for e in entries}
                    accounts = {a: r for a, r in accounts.items() if a in listed}
                providers[p] = {"accounts": accounts, "error": " · ".join(dict.fromkeys(reasons)) or None,
                                "notes": list(dict.fromkeys(notes)),
                                "attempted_at": iso(at)}
            state.update(polled_at=at, scan_error=scan_error)
            # Samples and freshness commit together, including recovery after a crash.
            with self.db.lock:
                conn = self.db.conn
                try:
                    conn.executemany("insert into usage_samples(ts, provider, account, window, used, resets_at, plan, data) values (?, ?, ?, ?, ?, ?, ?, ?)", samples)
                    conn.execute("delete from usage_samples where ts < ?", (at - 35 * 86400,))
                    conn.execute("insert into meta values ('usage_state', ?) on conflict(k) do update set v=excluded.v", (json.dumps(state),))
                    conn.commit()
                except Exception:
                    conn.rollback()
                    raise
            self._state = state
            self._alerts()
            self.town.bus.publish("usage", polled_at=iso(at))
            return self.snapshot()

    def _windows(self, provider: str) -> list[dict]:
        accounts = self._state.get("providers", {}).get(provider, {}).get("accounts", {})
        # Whitelist also strips obsolete fields from a prototype's saved readings.
        return [{k: w.get(k) for k in ("id", "label", "group", "used", "left", "resets_at")} |
                {"account": account, "key": f"{account}/{w['id']}"}
                for account, report in accounts.items() for w in report["windows"]]

    def snapshot(self) -> dict:
        state, settings = self._state, self.settings()
        providers, at = [], self.clock()
        rows = self.db.q("select * from usage_tokens where minute between ? and ?", int(week_start(at) // 60), int(at // 60))
        for p, label in LABELS.items():
            saved = state.get("providers", {}).get(p, {})
            accounts = list(saved.get("accounts", {}).values())
            fetched = min((stamp(a.get("fetched_at")) or 0 for a in accounts), default=0)
            error = saved.get("error")
            local = [r for r in rows if r["provider"] == p]
            providers.append({"id": p, "label": label, "plan": " / ".join(dict.fromkeys(a["plan"] for a in accounts if a.get("plan"))) or None,
                              "status": "stale" if accounts and (error or at - fetched > max(600, settings["poll"] * 2)) else "available" if accounts else "unavailable",
                              "error": error, "notes": saved.get("notes") or [],
                              "fetched_at": iso(fetched) if fetched else None, "windows": self._windows(p),
                              "balances": [b for a in accounts for b in a.get("balances", [])],
                              "week": totals(local) | {"projects": totals([r for r in local if r["line_id"]])["cost"],
                                                       "unpriced": unpriced(local)}})
        polled = state.get("polled_at")
        return {"polled_at": iso(polled), "next_at": iso(polled + settings["poll"]) if polled is not None and settings["poll"] else None,
                "providers": providers, "logs": settings["logs"], "log_error": state.get("scan_error")}

    def tokens(self, provider: str, since: float, until: float, line_id: str | None = None) -> dict:
        where, args = "provider = ? and minute between ? and ?", [provider, int(since // 60), int(until // 60)]
        if line_id is not None:
            where += " and line_id = ?"
            args.append(line_id)
        return self.db.one("select " + ", ".join(f"coalesce(sum({k}), 0) as {k}" for k in COUNTS) + " from usage_tokens where " + where, *args)

    def _agent_name(self, agent_id: str) -> str:
        a = self.db.one("select * from agents where id = ?", agent_id)
        if not a:
            return agent_id
        if a.get("node_id") and a.get("line_id"):
            canvas = read_json(self.town.canvas._path(a["line_id"]), {})
            task = next((n for n in canvas.get("nodes", []) if n.get("id") == a["node_id"] and n.get("kind") == "task"), {})
            if task.get("title"):
                return task["title"]
        return {"coder": "代码员工", "writer": "写作员工", "monitor": "看田员", "lead": "项目负责人", "assistant": "小助手"}.get(a["role"], agent_id)

    def _rows(self, line: dict, at: float) -> list[dict]:
        return self.db.q("select * from usage_tokens where line_id = ? and first_at >= ? and minute <= ?",
                         line["id"], stamp(line["created_at"]) or 0, int(at // 60))

    def line(self, line_id: str) -> dict:
        line = self.db.one("select id, usage_budget, created_at from lines where id = ?", line_id)
        if line is None:
            raise UsageError("没有这个项目")
        budget, at = line["usage_budget"], self.clock()
        budget = float(budget) if budget is not None else None
        rows = self._rows(line, at)
        providers, models, sessions = [], [], []
        for p in LABELS:
            local = [r for r in rows if r["provider"] == p]
            if local:
                providers.append({"id": p, **totals(local)})
            for model in sorted({r["model"] for r in local}):
                matching = [r for r in local if r["model"] == model]
                models.append({"provider": p, "model": model, **totals(matching), "priced": token_cost(model, matching[0])[1]})
        ownership = Ownership(self.town)
        for p, session in sorted({(r["provider"], r["session_id"]) for r in rows}):
            matching = [r for r in rows if r["provider"] == p and r["session_id"] == session]
            last = max(matching, key=lambda r: r["last_at"])
            _, who = ownership.resolve(p, session, last["cwd"], last["last_at"])
            if who["kind"] == "agent":
                who["name"] = self._agent_name(who["id"])
            sessions.append({"session": session, "provider": p, "owner": who, "cwd": last["cwd"],
                             **totals(matching), "last_at": iso(last["last_at"])})
        spent = totals(rows)["cost"]
        return {"budget": budget, "spent": spent, "state": budget_state(spent, budget), "since": line["created_at"],
                "week": totals([r for r in rows if r["minute"] >= int(week_start(at) // 60)])["cost"],
                "providers": providers, "models": models, "sessions": sorted(sessions, key=lambda r: r["last_at"], reverse=True),
                "logs": self.settings()["logs"]}

    def marker(self, line_id: str) -> str:
        line = self.db.one("select id, usage_budget, created_at from lines where id = ?", line_id)
        if not line or line["usage_budget"] is None:
            return "none"
        return budget_state(totals(self._rows(line, self.clock()))["cost"], float(line["usage_budget"]))

    def _alerts(self, only: str | None = None) -> None:
        if not self.settings()["logs"]:
            return
        for line in self.db.q("select id, usage_budget from lines" + (" where id = ?" if only else ""), *([only] if only else [])):
            if line["usage_budget"] is None:
                continue
            usage = self.line(line["id"])
            used, budget = usage["spent"], usage["budget"]
            for threshold in (80, 100):
                if used < budget * threshold / 100:
                    continue
                with self.db.lock:
                    conn = self.db.conn
                    try:
                        cur = conn.execute("insert or ignore into usage_alerts values (?, ?, ?)", (line["id"], budget, threshold))
                        if not cur.rowcount:
                            conn.commit()
                            continue
                        text = f"Agent 用量预算提醒：累计折合 ${used:.2f}，预算 ${budget:g}，已达到 {threshold}% 档位。"
                        data = {"text": text, "spent": used, "budget": budget, "threshold": threshold, "key": True, "who": "用量与预算"}
                        row = {"line_id": line["id"], "agent_id": None, "ts": iso(self.clock()), "kind": "usage", "data": data}
                        cur = conn.execute("insert into reports(line_id, agent_id, ts, kind, data) values (?, ?, ?, ?, ?)",
                                           (line["id"], None, row["ts"], "usage", json.dumps(data, ensure_ascii=False)))
                        row["id"] = cur.lastrowid
                        conn.commit()
                    except Exception:
                        conn.rollback()
                        raise
                self.town.bus.publish("report", report=row)

    def brief(self, line_id: str) -> list[str]:
        usage = self.line(line_id)
        states = {"none": "未设预算", "ok": "正常", "near": "接近预算", "over": "超出预算"}
        budget = f"${usage['budget']:g}" if usage["budget"] is not None else "未设置"
        out = ["", f"Agent 用量：${usage['spent']:.2f} / 预算 {budget}（{states[usage['state']]}）",
               f"本周 Agent 用量：${usage['week']:.2f}（按 API 价格折算，本周从周一零点起算）"]
        if not usage["logs"]:
            out.append("本机会话日志读取已关闭，项目用量统计已暂停。")
        return out

    def due(self) -> bool:
        poll = self.settings()["poll"]
        return bool(poll and self.clock() >= self._state.get("polled_at", -1e20) + poll)

    def tick(self) -> None:
        if self.due():
            self.poll()

    def start(self) -> None:
        if self._thread or not self.settings()["poll"]:
            return
        self._halt.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="usage-poll")
        self._thread.start()

    def _loop(self) -> None:
        try:
            while not self._halt.is_set():
                self._wake.clear()
                try:
                    self.tick()
                except Exception:
                    pass  # Retry after a bounded wait without exposing transcript data in traces.
                self._wake.wait(min(30, max(1, self.settings()["poll"])))
        finally:
            self.db.conn.close()

    def stop(self) -> None:
        self._halt.set()
        self._wake.set()
        if self._thread:
            self._thread.join(timeout=65)
        self._thread = None
