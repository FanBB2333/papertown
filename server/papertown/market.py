"""The talent market: research workers with a role, a level and a ROI history, compiled into the smallest
sufficient team under a budget and promoted or demoted on ROI afterwards (Capitalist's organization compiler).
Lv.3 and up run on the strong model.
"""

from __future__ import annotations

from .db import DB, now
from .events import EventBus

ROLES = {
    "hatcher": ("孵化员", "H"), "scout": ("调研员", "R"), "designer": ("方法设计师", "D"),
    "experimenter": ("实验员", "E"), "writer": ("写手", "W"), "reviewer": ("审稿人", "V"), "keeper": ("仓管员", "K"),
}
# (role, number, level) of the founding staff
ROSTER = [("hatcher", 1, 2), ("hatcher", 2, 1), ("scout", 7, 2), ("scout", 3, 1), ("designer", 3, 2), ("designer", 5, 1),
          ("experimenter", 2, 2), ("experimenter", 4, 1), ("writer", 4, 2), ("writer", 1, 1),
          ("reviewer", 1, 2), ("reviewer", 2, 1), ("reviewer", 5, 3), ("keeper", 1, 1)]
STRONG_LEVEL = 3
ALLOC = {"method": 0.22, "exp": 0.12, "write": 0.30, "review": 0.26, "reserve": 0.10}


def clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, v))


def title(w: dict) -> str:
    return f"{ROLES[w['role']][0]} {w['code']}"


class Market:
    def __init__(self, db: DB, bus: EventBus):
        self.db = db
        self.bus = bus
        if not db.val("select count(*) from workers"):
            for role, num, lv in ROSTER:
                code = f"{ROLES[role][1]}-{num:02d}"
                db.insert("workers", {"id": code, "code": code, "role": role, "level": lv, "status": "active", "runs": 0,
                                      "trailing_roi": 0.0, "history": [], "created_at": now()})

    def get(self, wid: str) -> dict:
        return self.db.one("select * from workers where id = ?", wid)

    def all(self) -> list[dict]:
        return self.db.q("select * from workers order by role, code")

    def best(self, role: str, n: int = 1, exclude: set[str] | None = None, cheap: bool = False) -> list[dict]:
        ws = [w for w in self.db.q("select * from workers where role = ? and status != 'frozen'", role)
              if w["id"] not in (exclude or set())]
        if cheap:
            ws.sort(key=lambda w: (w["level"] >= STRONG_LEVEL, -w["trailing_roi"], -w["level"]))
        else:
            ws.sort(key=lambda w: (-w["trailing_roi"], -w["level"]))
        return ws[:n]

    @staticmethod
    def triage(idea: str, report: dict, budget: float) -> dict:
        sims = [s.get("similarity", 0) for s in report.get("similar", [])]
        top = max(sims, default=0.0)
        adjust = report.get("verdict") == "需调整"
        complexity = clamp(0.3 + 0.4 * top + (0.1 if adjust else 0) + min(len(idea) / 400, 0.2))
        review_need = clamp(0.3 + 0.5 * top + (0.1 if adjust else 0))
        return {"complexity": round(complexity, 2), "review_need": round(review_need, 2), "closest": round(top, 2),
                "budget": budget}

    def compile_team(self, idea: str, report: dict, budget: float) -> dict:
        t = self.triage(idea, report, budget)
        cheap = budget < 0.6
        used: set[str] = set()

        def take(role: str, n: int = 1) -> list[str]:
            ws = self.best(role, n, used, cheap)
            used.update(w["id"] for w in ws)
            return [w["id"] for w in ws]

        reviewers = 1 + (t["review_need"] > 0.5) + (budget >= 1.5)
        team = {
            "method": take("designer") + (take("scout") if t["complexity"] >= 0.45 else []),
            "exp": take("experimenter"),
            "write": take("writer"),
            "review": take("reviewer", reviewers),
        }
        reason = (f"复杂度 {t['complexity']}，最相近工作相似度 {t['closest']}。"
                  f"{'方法设计加一名调研员，' if len(team['method']) > 1 else ''}审稿人 {len(team['review'])} 名。"
                  f"{'预算偏紧，优先用低级别员工（便宜模型）' if cheap else '按 ROI 选人'}")
        return {"triage": t, "team": team, "alloc": ALLOC, "reason": reason, "size": len(used)}

    def settle(self, line_id: str, quality: dict[str, float]) -> list[dict]:
        """Settle each worker's ROI from quality (worker id -> 0..1 for this line), then promote or demote
        against the role's average. Returns the level changes."""
        changes = []
        for wid, q in quality.items():
            w = self.get(wid)
            if not w:
                continue
            spent = self.db.val("select coalesce(sum(cost), 0.0) from runs where line_id = ? and worker_id = ?", line_id, wid)
            roi = q / (spent + 0.02)
            trailing = roi if w["runs"] == 0 else 0.6 * w["trailing_roi"] + 0.4 * roi
            hist = (w["history"] or []) + [{"line": line_id, "quality": round(q, 2), "cost": round(spent, 4), "roi": round(roi, 2)}]
            self.db.update("workers", {"id": wid}, runs=w["runs"] + 1, trailing_roi=round(trailing, 3), history=hist[-20:])
            changes.append({"worker": wid, "quality": q, "roi": roi, "trailing": trailing})

        out = []
        for c in changes:
            w = self.get(c["worker"])
            peers = [p["trailing_roi"] for p in self.db.q("select trailing_roi from workers where role = ? and runs > 0", w["role"])]
            avg = sum(peers) / len(peers)
            new, why = w["level"], ""
            if c["quality"] >= 0.75 and w["runs"] >= 2 and c["trailing"] >= avg and w["level"] < 5:
                new, why = w["level"] + 1, "升"
            elif (c["quality"] < 0.45 or c["trailing"] < 0.6 * avg) and w["level"] > 1:
                new, why = w["level"] - 1, "降"
            if new != w["level"]:
                self.db.update("workers", {"id": w["id"]}, level=new)
                note = f"{title(w)} {why}为 Lv.{new}（本单质量 {c['quality']:.2f}，ROI {c['roi']:.1f}）"
                self.db.insert("worker_events", {"ts": now(), "worker_id": w["id"], "change": why, "note": note})
                out.append({"worker": w["id"], "from": w["level"], "to": new, "note": note})
        if out:
            self.bus.publish("workers", changes=out)
        return out

    def events(self, n: int = 10) -> list[dict]:
        return self.db.q("select * from worker_events order by id desc limit ?", n)
