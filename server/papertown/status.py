"""The HUD numbers and the status page (the town paper, minus the town)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING

from .db import week_ago
from .library import terms_of
from .pipeline import LIVE, NAMES

if TYPE_CHECKING:
    from .town import Town

ACTIVE = LIVE
# the departments the chat shows, in the order a paper passes through them, and where the staff agents work
DEPARTMENTS = ("hatchery", "market", "mill", "depot", "farm", "power", "press", "qa", "library")
STAFF = {"coder": "depot", "writer": "press"}
KINDS = [("RAG", "检索"), ("MCP", "外部工具"), ("SKILL", "加载 skill"), ("SCRIPT", "skill 脚本"), ("GRAPH", "图谱扩展"),
         ("TOOL", "内部工具")]


def hud(town: "Town") -> dict:
    lines = town.db.q("select id, status from lines")
    first = town.db.val("select min(created_at) from lines")
    day = (datetime.now(timezone.utc) - datetime.fromisoformat(first)).days + 1 if first else 1
    leads = [town.leads.resident(r["id"]) for r in lines if r["status"] in LIVE]
    return {"day": day, "lines": {"running": len(leads), "total": len(lines)},
            "leads": {"on": sum(r["on"] for r in leads), "running": sum(r["state"] == "running" for r in leads)},
            "library": town.library.count(), "ports": town.mcp.status}


def running(town: "Town") -> list[dict]:
    out = []
    for ln in town.db.q(f"select id from lines where status in ({','.join('?' * len(ACTIVE))}) order by seq desc", *ACTIVE):
        snap = town.pipeline.snapshot(ln["id"])
        cur = snap["current"] or next((s for s in reversed(snap["stages"]) if s["status"] == "done"), snap["stages"][0])
        out.append({"id": snap["id"], "seq": snap["seq"], "title": snap["title"], "status": snap["status"],
                    "stage": cur["name"], "building": cur["building"], "pct": snap["pct"], "mill_id": snap["mill_id"]})
    return out


def departments(town: "Town") -> list[dict]:
    """What each department is doing: its projects, staff agents and jobs, and who answers when you ask it."""
    at: dict[str, dict[str, dict]] = {}
    for r in running(town):
        at.setdefault(r["building"], {})[r["id"]] = {k: r[k] for k in ("id", "seq", "title", "status", "stage", "pct")}
    # a linked project can be at work at several stages at once
    for s in town.db.q("select s.building, s.key, s.status as st, s.pct, l.id, l.seq, l.title, l.status from stages s"
                       " join lines l on l.id = s.line_id where s.status = 'run' and l.status in ('running', 'linked')"):
        at.setdefault(s["building"], {}).setdefault(s["id"], {"id": s["id"], "seq": s["seq"], "title": s["title"], "stage": NAMES.get(s["key"], s["key"]),
                                                             "status": s["status"], "pct": s["pct"]})
    staff: dict[str, list[dict]] = {}
    seqs = {r["id"]: r["seq"] for r in town.db.q("select id, seq from lines")}
    for a in town.db.q("select * from agents where role in ('coder', 'writer') and runtime is not null order by updated_at desc"):
        p = town.agents.public(a)
        last = p["last"] or {}
        staff.setdefault(STAFF[a["role"]], []).append(
            {k: p[k] for k in ("id", "role", "name", "status", "runtime", "line_id", "model", "started", "cost", "updated_at")}
            | {"seq": seqs.get(a["line_id"]), "last": {"kind": last.get("kind"), "text": str((last.get("data") or {}).get("text") or "")[:200]} if last else None})
    jobs = [j for j in town.linked.farm_jobs() + town.farm.list(limit=100) if j["status"] in ("queued", "running")]
    nv = town.nvidb.status()
    gpus_running = nv["counts"].get("running", 0)
    out = []
    for t in DEPARTMENTS:
        b = town.world.get(t)
        if not b:
            continue
        lines = sorted(at.get(t, {}).values(), key=lambda x: -x["seq"])
        agents = sorted(staff.get(t, []), key=lambda x: x["status"] != "working")
        mine = [{k: j[k] for k in ("id", "name", "status", "progress", "line_id", "backend")} for j in jobs] if t == "farm" else []
        busy = (b["status"] == "busy" or any(x["status"] in LIVE for x in lines)
                or any(x["status"] in ("working", "starting") for x in agents) or any(j["status"] == "running" for j in mine)
                or (t == "power" and nv["ok"] and gpus_running > 0))
        state = ("busy" if busy
                 else "off" if t == "power" and not nv["ok"] else "idle")
        meta = town.world.types[t]
        d = town.world.districts[meta["district"]]
        sm = nv["summary"] if t == "power" and nv["ok"] else None
        out.append({"id": b["id"], "type": t, "name": town.world.name(b), "district": d["name"], "color": d["color"],
                    "state": state, "job": town.world.job(b), "lines": lines, "agents": agents, "jobs": mine,
                    "gpus": {"total": sm["gpus"], "idle": sm["idle"], "running": gpus_running} if sm else None})
    return out


def fresh_papers(town: "Town", n: int = 6) -> list[dict]:
    """The newest papers in the library, the ones closest to a project in progress first."""
    db = town.db
    terms = [terms_of(r["idea"]) for r in db.q(f"select idea from lines where status in ({','.join('?' * len(ACTIVE))})", *ACTIVE)]
    papers = []
    for p in db.q("select * from papers order by id desc limit 40"):
        rel = max((town.library.coverage(t, f"{p['title']} {p['abstract']}")[0] for t in terms), default=0.0)
        papers.append(town.library.card(p) | {"relevance": round(rel, 2), "source": p["source"], "added_at": p["added_at"]})
    papers.sort(key=lambda p: -p["relevance"])  # stable: ties stay newest first
    return papers[:n]


def status(town: "Town") -> dict:
    db = town.db
    projects = [{k: s[k] for k in ("id", "seq", "title", "status", "pct", "verdict", "mill_id")}
                | {"stage": NAMES.get(s["stage"], s["stage"]), "files": s["files"]} for s in town.pipeline.lines()]
    counts = {r["kind"]: r["c"] for r in db.q("select kind, count(*) as c from trace where ts >= ? group by kind", week_ago())}
    top = max(counts.values(), default=1)
    calls = [{"kind": k, "name": name, "count": counts.get(k, 0), "pct": round(100 * counts.get(k, 0) / top)} for k, name in KINDS]
    news = [m["body"].get("text", "") for m in db.q("select body from messages where kind in ('report', 'team', 'paper') order by id desc limit 4")]
    return {
        "projects": projects, "papers": fresh_papers(town), "calls": calls,
        "skills": [s.summary() for s in town.skills.all()], "headline": news, "hud": hud(town),
        "library": {"total": town.library.count(), "arxiv": db.val("select count(*) from papers where source = 'arxiv'"),
                    "graph": town.genealogy.stats()},
    }
