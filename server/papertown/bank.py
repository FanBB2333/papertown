"""The bank: every LLM call is priced and booked here, per run and per line."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from .db import DB, now
from .events import EventBus
from .llm import Usage, cost


class Bank:
    def __init__(self, db: DB, bus: EventBus, weekly_budget: float):
        self.db = db
        self.bus = bus
        self.weekly_budget = weekly_budget

    def charge(self, run_id: str | None, line_id: str | None, provider: str, model: str, usage: Usage) -> float:
        c = cost(model, usage)
        self.db.insert("ledger", {"ts": now(), "run_id": run_id, "line_id": line_id, "provider": provider, "model": model,
                                  "tokens_in": usage.input_tokens, "tokens_out": usage.output_tokens, "cost": c})
        if run_id:
            self.db.x("update runs set tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, cost = cost + ? where id = ?",
                      usage.input_tokens, usage.output_tokens, c, run_id)
        if line_id:
            self.db.x("update lines set spent = spent + ? where id = ?", c, line_id)
        self.bus.publish("bank", **self.summary())
        return c

    def line_spent(self, line_id: str) -> float:
        return self.db.val("select coalesce(sum(cost), 0) from ledger where line_id = ?", line_id) or 0.0

    def summary(self) -> dict:
        since = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat(timespec="seconds")
        r = self.db.one("select count(*) as calls, coalesce(sum(cost), 0) as spent, coalesce(sum(tokens_in), 0) as tin,"
                        " coalesce(sum(tokens_out), 0) as tout from ledger where ts >= ?", since)
        return {"week": round(r["spent"], 4), "budget": self.weekly_budget, "calls": r["calls"],
                "tokens_in": r["tin"], "tokens_out": r["tout"]}

    def by_model(self) -> list[dict]:
        return self.db.q("select provider, model, count(*) as calls, sum(tokens_in) as tokens_in, sum(tokens_out) as tokens_out,"
                         " round(sum(cost), 4) as cost from ledger group by provider, model order by cost desc")
