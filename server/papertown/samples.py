"""Prebuilt sample projects and the library shelves."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from functools import lru_cache
from typing import TYPE_CHECKING

from .cards import clean
from .db import now
from .library import Library

if TYPE_CHECKING:
    from .town import Town

FIXTURE = Path(__file__).parent / "data" / "samples.json"
SAMPLES = json.loads(FIXTURE.read_text(encoding="utf-8"))["samples"] if FIXTURE.exists() else []

# the seed library's search queries, as shelf labels
TOPICS = {
    'abs:"code generation" AND abs:agent AND abs:repository': "仓库级代码 Agent",
    'abs:"retrieval-augmented generation"': "检索增强生成",
    'abs:graphrag OR abs:"graph retrieval-augmented"': "GraphRAG",
    'abs:"tool use" AND abs:"language model" AND abs:agent': "工具调用 Agent",
    'abs:"model context protocol"': "MCP 协议",
    'abs:"multi-agent" AND abs:"large language model" AND abs:collaboration': "多智能体协作",
    'abs:"peer review" AND abs:"large language model"': "大模型审稿",
    'abs:"research idea" AND abs:novelty': "科研 idea 与新颖性",
    'abs:"scientific" AND abs:"paper writing" AND abs:"language model"': "科研写作",
    'abs:"KV cache" AND abs:compression': "KV cache 压缩",
    'abs:"sparse attention"': "稀疏注意力",
    'abs:"vision-language-action"': "视觉语言动作（VLA）",
    'abs:"scene graph" AND abs:planning': "场景图规划",
    'abs:"long-horizon" AND abs:manipulation': "长程操作",
    'abs:"task planning" AND abs:"large language model" AND abs:robot': "机器人任务规划",
    'abs:"embodied" AND abs:memory AND abs:agent': "具身记忆",
    'abs:"spatial reasoning" AND abs:benchmark AND abs:multimodal': "多模态空间推理",
    'abs:"diffusion policy"': "扩散策略",
}
OTHER = "码头新到"


class SampleError(Exception):
    pass


def _decisions(town: "Town", lid: str, sample: dict, agent: dict) -> None:
    """Import the fixture's own words once. Never add sample decisions to an edited history."""
    with town.db.transaction():
        if town.db.val("select 1 from decided where line_id = ? and (n > 1 or source != 'idea' or state != 'active') limit 1", lid):
            return
        town.decided.idea(lid)
        for choice in sample["decided"]:
            town.decided._insert(lid, choice["text"], choice["mod"], "written", replaces=choice.get("replaces"), materials=choice.get("materials"))
        m = sample["matter"]
        town.decided.raise_matter(agent, m["question"], m["mod"], m["facts"], m["options"], m["materials"])


def _paper_history(town, lid, sample):
    """Import historical revisions only while creating a new, Papertown-owned sample."""
    from .prov import Target
    prov = town.prov
    paper = town.press.dir(lid) / "main.tex"
    final = sample["press"]["main.tex"]
    writer = town.agents.ensure(lid, "writer")
    start = datetime.now(timezone.utc) - timedelta(minutes=2)

    def at(seconds):
        return (start + timedelta(seconds=seconds)).isoformat()

    def snap(root, agent, seconds, trigger="turn"):
        basis = ["D6"] if root == "paper" else ["D8"]
        return prov._snapshot(lid, root, trigger, prov._actor(agent) | {"basis": basis}, at=at(seconds))

    intro = final.index(r"\section{Introduction}")
    exp = final.index(r"\section{Experiments}")
    paper.write_text(final[:final.index(r"\begin{abstract}")] + final[intro:exp], encoding="utf-8")
    heads = {"paper": snap("paper", writer, 0)}
    fixture = sample.get("prov")
    if fixture:
        line = next(i + 1 for i, s in enumerate(paper.read_text().splitlines()) if s.startswith("Prior work"))
        src = prov._sources(lid, [fixture["cite"]], heads, writer, ["D6"])
        prov._file(lid, Target("paper", "main.tex", f":{line}"), heads, writer, basis=["D6"], src=src, at=at(1))
    paper.write_text(final[:exp], encoding="utf-8")
    snap("paper", writer, 30)
    paper.write_text(final, encoding="utf-8")
    heads["paper"] = snap("paper", writer, 60)
    if not fixture:
        return
    coder = town.agents.ensure(lid, "coder")
    code = Path(coder["cwd"])
    result, table = code / fixture["result"], code / fixture["artifact"]
    result.parent.mkdir(exist_ok=True)
    table.parent.mkdir(exist_ok=True)
    values = list(fixture["values"])
    (code / "sample_review.py").write_text(
        "import json\nfrom pathlib import Path\n\n"
        f"values = {values!r}\nPath('outputs').mkdir(exist_ok=True)\n"
        f"Path({fixture['result']!r}).write_text(json.dumps({{'seeds': 3, 'values': values}}))\n")
    version = snap("code", coder, 0)
    jid = "job_sample_" + lid
    town.db.insert("jobs", {"id": jid, "line_id": lid, "name": fixture["job"], "backend": "local", "status": "done", "progress": 100,
                            "command": "python sample_review.py", "cwd": str(code), "submitted_by": coder["id"], "basis": ["D8"],
                            "outs": [fixture["result"]], "op": version, "created_at": at(5), "started_at": at(8), "ended_at": at(20),
                            "result": {"seeds": 3, "values": values}})
    result.write_text(json.dumps({"seeds": 3, "values": values}))
    heads["code"] = snap("code", coder, 20, "job")
    leaf = prov._file(lid, Target("code", fixture["result"]), heads, coder, basis=["D8"], job=prov.job(lid, jid), at=at(21))
    table.write_text("\n".join(",".join(map(str, row)) for row in values) + "\n")
    draft = table.with_name("draft.csv")
    draft.write_text(table.read_text())
    heads["code"] = snap("code", coder, 35)
    artifact = prov._file(lid, Target("code", fixture["artifact"]), heads, coder, src=[leaf["id"]], how=fixture["how"], basis=["D8"], at=at(36))
    prov._file(lid, Target("code", "results/draft.csv"), heads, coder, at=at(36))
    target = Target("paper", "main.tex", "#" + fixture["label"])
    prov._file(lid, target, heads, writer, title=fixture["table"], basis=["D6"], at=at(61))
    prov._file(lid, target, heads, writer, title=fixture["table"], basis=["D6"], src=[artifact["id"]], at=at(65))
    values[-1] = fixture["revised"]
    result.write_text(json.dumps({"seeds": 3, "values": values}))
    draft.rename(table.with_name("archived.csv"))
    snap("code", coder, 80)


def seed(town: "Town") -> dict:
    """Import fixtures directly, leaving every sample lead unstarted."""
    from .pipeline import STAGES

    samples = json.loads(FIXTURE.read_text(encoding="utf-8"))["samples"] if FIXTURE.exists() else SAMPLES
    if not samples:
        raise SampleError("预制样例文件尚未就绪")
    added = []
    with town.db.transaction():
        have = {r["idea"] for r in town.db.q("select idea from lines")}
        for sample in samples:
            if sample["idea"] in have:
                continue
            seq = (town.db.val("select max(seq) from lines") or 0) + 1
            line_id = f"line_{seq}"
            stages = sample["stages"]
            stage = next((k for k, *_ in STAGES if stages[k]["status"] == "run"), None)
            stage = stage or next((k for k, *_ in reversed(STAGES) if stages[k]["status"] == "done"), "idea")
            at = now()
            town.db.insert("lines", {"id": line_id, "seq": seq, "idea": sample["idea"], "title": sample["title"],
                                     "verdict": sample["verdict"], "status": sample["status"], "note": sample["note"],
                                     "sample": 1, "mill_id": "mill", "stage": stage, "created_at": at, "updated_at": at})
            for idx, (key, _, building, _) in enumerate(STAGES):
                st = stages[key]
                town.db.insert("stages", {"line_id": line_id, "idx": idx, "key": key, "building": building,
                                          "status": st["status"], "pct": st["pct"], "note": st["note"],
                                          "started_at": at if st["status"] != "todo" else None,
                                          "ended_at": at if st["status"] == "done" else None})
            agent = town.agents.ensure(line_id, "lead")
            start = datetime.now(timezone.utc)
            for idx, item in enumerate(sample["items"]):
                row = town.save_item(line_id, **item, agent_id=agent["id"] if item["stage"] != "idea" else None)
                town.db.update("items", {"id": row["id"]}, created_at=(start + timedelta(microseconds=idx)).isoformat())
            directory = town.press.dir(line_id)
            for name, text in sample["press"].items():
                if name not in ("main.tex", "refs.bib"):
                    raise SampleError(f"样例论文文件名无效：{name}")
                (directory / name).write_text(text, encoding="utf-8")
            town.cards._write(line_id, {"card": clean(sample["card"]) | {"at": at, "by": "项目负责人"}})
            for event in sample["chat"]:
                data = {"text": event["text"]}
                if event["kind"] == "user":
                    data.update(origin="web", user_text=event["text"])
                elif event["kind"] == "sent":
                    recipient = town.agents.ensure(line_id, event["to"])
                    data.update(to=recipient["id"], who=town.leads._who(recipient), line_id=line_id, basis=event["basis"])
                town.agents.record(agent["id"], event["kind"], data)
            for report in sample["reports"]:
                if report["kind"] == "ask":
                    town.leads.ask(agent["id"], report["question"], report["choices"])
                else:
                    town.leads.report(agent["id"], report["text"], report.get("key", False))
            _decisions(town, line_id, sample, agent)
            if town.s.prov and sample["press"].get("main.tex"):
                _paper_history(town, line_id, sample)
            town.pipeline._publish(line_id)
            added.append(line_id)
            have.add(sample["idea"])
        town.db.set_meta("samples", now())
    return {"added": added, "note": f"已放入 {len(added)} 个预制样例。样例的负责人开关默认关闭，打开项目开关后由真实负责人接手。"}


def maybe_seed(town: "Town") -> None:
    """Seed only the first empty start when samples are enabled."""
    if town.s.samples and not town.db.get_meta("samples") and not town.db.val("select count(*) from lines"):
        seed(town)
    elif town.db.get_meta("samples"):
        fixtures = {s["idea"]: s for s in SAMPLES}
        for ln in town.db.q("select id, idea from lines where sample = 1 and (select count(*) from decided where line_id = lines.id) <= 1"):
            if ln["idea"] in fixtures:
                _decisions(town, ln["id"], fixtures[ln["idea"]], town.agents.ensure(ln["id"], "lead"))


@lru_cache(maxsize=1)
def _seed_topics() -> dict[str, str]:
    from .town import seed_papers
    return {p["arxiv_id"]: TOPICS.get(p.get("seed_query", ""), OTHER) for p in seed_papers()}


def shelf(town: "Town", q: str = "", topic: str = "", limit: int = 60) -> dict:
    """The library as shelves: every topic with its count, and the cards on the one asked
    for (or the best matches for a search, or the newest)."""
    topics = _seed_topics()
    rows = town.db.q("select * from papers order by published desc, id desc")
    counts: dict[str, int] = {}
    for r in rows:
        t = topics.get(r["arxiv_id"], OTHER)
        counts[t] = counts.get(t, 0) + 1
    order = list(dict.fromkeys(list(TOPICS.values()) + [OTHER]))
    out_topics = [{"label": t, "n": counts[t]} for t in order if counts.get(t)]
    limit = max(1, min(200, limit))
    if q.strip():
        hits = town.library.search(q, top_k=limit)["hits"]
        papers = [h for h in hits if not topic or topics.get(h["arxiv_id"], OTHER) == topic]
    else:
        papers = [Library.card(p) for p in rows if not topic or topics.get(p["arxiv_id"], OTHER) == topic][:limit]
    for p in papers:
        p["topic"] = topics.get(p["arxiv_id"], OTHER)
    return {"total": len(rows), "topics": out_topics, "papers": papers}


def papers_of(town: "Town", line_id: str) -> dict:
    """What a paper read and cites: the hatchery's survey (closest first, each with how close and why) and the
    references the press put in its bibliography, or for a linked project of your own what its .bib cites."""
    if town.linked.of(line_id):
        return {"survey": [], "references": town.linked.references(line_id)}
    report = town.pipeline.item(line_id, "hatch") or {}
    tex = town.pipeline.item(line_id, "write") or {}
    topics = _seed_topics()
    notes = {s["paper_id"]: s for s in report.get("similar") or []}
    survey_ids = list(dict.fromkeys([s["paper_id"] for s in report.get("similar") or []]
                                    + [c["paper_id"] for c in report.get("candidates") or []]))
    sims = {c["paper_id"]: c.get("similarity") for c in report.get("candidates") or []} | {k: v.get("similarity") for k, v in notes.items()}

    def cards(ids: list[str]) -> list[dict]:
        out = []
        for p in town.library.get(ids):
            c = Library.card(p)
            c["topic"] = topics.get(p["arxiv_id"], OTHER)
            if c["paper_id"] in sims:
                c["similarity"] = sims[c["paper_id"]]
            if c["paper_id"] in notes:
                c["note"] = notes[c["paper_id"]].get("note")
                c["closest"] = True
            out.append(c)
        return out

    return {"survey": cards(survey_ids), "references": cards(list(dict.fromkeys(tex.get("cite_ids") or [])))}
