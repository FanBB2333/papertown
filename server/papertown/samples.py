"""Prebuilt sample projects and the library shelves."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from functools import lru_cache
from typing import TYPE_CHECKING

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


def seed(town: "Town") -> dict:
    """Import fixtures directly, leaving every sample lead unstarted."""
    from .pipeline import STAGES

    samples = json.loads(FIXTURE.read_text(encoding="utf-8"))["samples"] if FIXTURE.exists() else SAMPLES
    if not samples:
        raise SampleError("预制样例文件尚未就绪")
    added = []
    with town.db.lock:
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
            start = datetime.now(timezone.utc)
            for idx, item in enumerate(sample["items"]):
                row = town.save_item(line_id, **item)
                town.db.update("items", {"id": row["id"]}, created_at=(start + timedelta(microseconds=idx)).isoformat())
            directory = town.press.dir(line_id)
            for name, text in sample["press"].items():
                if name not in ("main.tex", "refs.bib"):
                    raise SampleError(f"样例论文文件名无效：{name}")
                (directory / name).write_text(text, encoding="utf-8")
            agent = town.agents.ensure(line_id, "lead")
            for event in sample["chat"]:
                town.agents.record(agent["id"], event["kind"], {"text": event["text"]})
            for report in sample["reports"]:
                if report["kind"] == "ask":
                    town.leads.ask(agent["id"], report["question"], report["choices"])
                else:
                    town.leads.report(agent["id"], report["text"], report.get("key", False))
            town.pipeline._publish(line_id)
            added.append(line_id)
            have.add(sample["idea"])
        town.db.set_meta("samples", now())
    return {"added": added, "note": f"已放入 {len(added)} 个预制样例。样例的负责人开关默认关闭，打开项目开关后由真实负责人接手。"}


def maybe_seed(town: "Town") -> None:
    """Seed only the first empty start when samples are enabled."""
    if town.s.samples and not town.db.get_meta("samples") and not town.db.val("select count(*) from lines"):
        seed(town)


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
