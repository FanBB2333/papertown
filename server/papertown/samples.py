"""Demo samples: a handful of example papers for the offline demo, so the town has
something on its lines the first time it is opened.

Each sample is an ordinary idea put through the ordinary pipeline. One runs all the way
to a shipped paper; the others are parked before different stages (the line's `hold`),
so the mill, the farm and the press each show a paper part way along; the last is left
waiting at the hatchery for you to decide. The ideas sit on the topics the seed library
covers, so the hatchery's survey and the paper's references come from real papers.

The library shelf (topics and cards) lives here too: the seed file says which query each
seed paper was found by, and that is the topic it is shelved under.
"""

from __future__ import annotations

import json
import threading
import time
from functools import lru_cache
from typing import TYPE_CHECKING

from .db import now
from .library import Library

if TYPE_CHECKING:
    from .town import Town

# until: the stage a sample stops before (None: runs to the end; "hatch": waits for you)
SAMPLES = [
    {"idea": "仓库级代码 Agent：先用检索增强在整个代码仓库里定位相关文件和调用链，再让 agent 分步修改并跑测试回归，"
             "减少跨文件修改时漏改、改错接口的情况", "until": None},
    {"idea": "大语言模型审稿：把 peer review 拆成查新颖性、核对方法、核对实验三个 agent，先检索相近工作再评新颖性，"
             "和单个模型直接审稿比打分的一致性与可解释性", "until": "review"},
    {"idea": "长上下文推理加速：用稀疏注意力挑出关键 token，再对 KV cache 做分层压缩，显存减半时保持长文档问答的精度",
     "until": "write"},
    {"idea": "机器人长程操作：用场景图记录物体关系和状态变化，视觉语言动作模型按子目标执行，失败时沿场景图回退重新规划，"
             "减少多步任务里的误差累积", "until": "exp"},
    {"idea": "多智能体通过 model context protocol 共享工具：研究工具调用的分工与交接，谁来调用、何时交给别人、怎样避免重复调用",
     "until": "hatch"},
]

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
    """Put the samples the town does not have yet onto its lines. Offline only: with a model
    connected every stage would call it, and that costs money."""
    if not town.s.offline:
        raise SampleError("样例只在展示模式（离线）里提供：接了模型以后，跑样例的每道工序都会真的调用模型、花钱")
    have = {r["idea"] for r in town.db.q("select idea from lines")}
    todo = [x for x in SAMPLES if x["idea"] not in have]
    town.db.set_meta("samples", now())
    if not todo:
        return {"added": [], "note": "样例项目都已经在小镇里了"}
    added = [(town.pipeline.submit_idea(x["idea"])["id"], x) for x in todo]
    threading.Thread(target=_drive, args=(town, added), daemon=True, name="samples").start()
    parked = sum(1 for _, x in added if x["until"] not in (None, "hatch"))
    return {"added": [i for i, _ in added],
            "note": f"放入了 {len(added)} 个样例项目，正在孵化场查重。之后"
                    + "、".join(p for p in [
                        "1 篇一路跑到出厂" if any(x["until"] is None for _, x in added) else "",
                        f"{parked} 篇停在不同工序前（点「继续」接着跑）" if parked else "",
                        "1 篇留在孵化场等你决定" if any(x["until"] == "hatch" for _, x in added) else ""] if p)
                    + "。"}


def _drive(town: "Town", added: list[tuple[str, dict]]) -> None:
    """Once the hatchery has reported on a sample, hatch it, parked where it should stop."""
    for line_id, x in added:
        if x["until"] == "hatch":
            continue
        t0 = time.time()
        while time.time() - t0 < 180:
            ln = town.pipeline.line(line_id)
            if ln["status"] != "hatching" and not town.pipeline.running(line_id):
                break
            time.sleep(0.1)
        if ln["status"] != "waiting":
            continue
        if x["until"]:
            town.db.update("lines", {"id": line_id}, hold=x["until"])
        town.pipeline.hatch(line_id)


def maybe_seed(town: "Town") -> None:
    """The first start of an offline town with nothing on its lines gets the samples."""
    if town.s.offline and town.s.samples and not town.db.get_meta("samples") and not town.db.val("select count(*) from lines"):
        seed(town)


# ---------- the library shelf ----------

@lru_cache(maxsize=1)
def _seed_topics() -> dict[str, str]:
    from .town import SEED
    out = {}
    if SEED.exists():
        for line in SEED.read_text(encoding="utf-8").splitlines():
            if line.strip():
                p = json.loads(line)
                out[p["arxiv_id"]] = TOPICS.get(p.get("seed_query", ""), OTHER)
    return out


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
    """What a paper read and cites: the hatchery's survey (closest first, each with how close
    and why) and the references the press put in its bibliography."""
    if town.linked.of(line_id):  # a project of your own: what its .bib cites
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
