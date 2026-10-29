"""The HUD numbers and the status page (the town paper, minus the town)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

from .library import expand, tokens
from .pipeline import NAMES

if TYPE_CHECKING:
    from .town import Town

ACTIVE = ("hatching", "waiting", "running", "paused")
KINDS = [("RAG", "检索"), ("MCP", "外部工具"), ("SKILL", "加载 skill"), ("SCRIPT", "skill 脚本"), ("GRAPH", "图谱扩展"),
         ("TOOL", "内部工具"), ("LLM", "模型调用")]


def _week() -> str:
    return (datetime.now(timezone.utc) - timedelta(days=7)).isoformat(timespec="seconds")


def hud(town: "Town") -> dict:
    lines = town.db.q("select status from lines")
    first = town.db.val("select min(created_at) from lines")
    day = (datetime.now(timezone.utc) - datetime.fromisoformat(first)).days + 1 if first else 1
    return {"day": day, "bank": town.bank.summary(), "plant": town.plant.status(),
            "lines": {"running": sum(1 for r in lines if r["status"] in ("running", "hatching")),
                      "waiting": sum(1 for r in lines if r["status"] == "waiting"), "total": len(lines)},
            "library": town.library.count(), "provider": town.provider.name, "offline": town.s.offline,
            "model": town.s.model_strong, "ports": town.mcp.status}


def running(town: "Town") -> list[dict]:
    out = []
    for ln in town.db.q(f"select id from lines where status in ({','.join('?' * len(ACTIVE))}) order by seq desc", *ACTIVE):
        snap = town.pipeline.snapshot(ln["id"])
        cur = snap["current"] or next((s for s in reversed(snap["stages"]) if s["status"] == "done"), snap["stages"][0])
        out.append({"id": snap["id"], "seq": snap["seq"], "title": snap["title"], "status": snap["status"],
                    "stage": cur["name"], "building": cur["building"], "pct": snap["pct"], "mill_id": snap["mill_id"]})
    return out


def status(town: "Town") -> dict:
    db = town.db
    projects = [{k: s[k] for k in ("id", "seq", "title", "status", "pct", "spent", "budget", "verdict", "mill_id")}
                | {"stage": NAMES.get(s["stage"], s["stage"]), "files": s["files"]} for s in town.pipeline.lines()]
    ideas = [r["idea"] for r in db.q(f"select idea from lines where status in ({','.join('?' * len(ACTIVE))})", *ACTIVE)]
    terms = [list(dict.fromkeys(tokens(expand(i)))) for i in ideas]
    papers = []
    for p in db.q("select * from papers order by id desc limit 40"):
        rel = max((town.library.coverage(t, f"{p['title']} {p['abstract']}")[0] for t in terms), default=0.0)
        papers.append(town.library.card(p) | {"relevance": round(rel, 2), "source": p["source"], "added_at": p["added_at"]})
    papers.sort(key=lambda p: -p["relevance"])  # stable: ties stay newest first
    counts = {r["kind"]: r["c"] for r in db.q("select kind, count(*) as c from trace where ts >= ? group by kind", _week())}
    top = max(counts.values(), default=1)
    calls = [{"kind": k, "name": name, "count": counts.get(k, 0), "pct": round(100 * counts.get(k, 0) / top)} for k, name in KINDS]
    news = [m["body"].get("text", "") for m in db.q("select body from messages where kind in ('report', 'team', 'paper') order by id desc limit 4")]
    return {
        "projects": projects, "papers": papers[:6], "workers": town.market.events(6), "calls": calls,
        "bank": town.bank.summary(), "models": town.bank.by_model(), "plant": town.plant.status(),
        "skills": [s.summary() for s in town.skills.all()], "headline": news, "hud": hud(town),
        "library": {"total": town.library.count(), "arxiv": db.val("select count(*) from papers where source = 'arxiv'") or 0,
                    "graph": town.genealogy.stats()},
    }
