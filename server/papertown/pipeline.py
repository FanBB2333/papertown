"""A project's line: eight stages from idea to shipped paper, and what each stage has handed in.

Papertown runs no model of its own. A project's lead (leads.py) moves its line with `pt stage`, and its agents hand
in a stage's output with `pt output`; the hard gates of the research loop (canvas.py) decide what may close.
"""

from __future__ import annotations

import math
import threading
from typing import TYPE_CHECKING

from .agents import ROLES
from .db import now
from .library import expand

if TYPE_CHECKING:
    from .town import Town

STAGES = [
    ("idea", "灵感", "cityhall", "egg"),
    ("hatch", "查重孵化", "hatchery", "notes"),
    ("team", "立项编队", "market", "notes"),
    ("method", "方法设计", "mill", "draft"),
    ("exp", "实验", "farm", "table"),
    ("write", "写作排版", "press", "tex"),
    ("review", "质检", "qa", "pdf"),
    ("ship", "出厂投稿", "dock_arxiv", "pdf"),
]
INDEX = {k: i for i, (k, *_) in enumerate(STAGES)}
NAMES = {k: name for k, name, *_ in STAGES}
# The parts of a project's research flow. The console lists them in this order (web: console/Console.tsx, MODS) and
# the research loop frames its nodes by them (canvas.py); STAGE_MOD says which part a stage's work is in.
MODULES = [("overview", "概览"), ("survey", "调研"), ("code", "代码仓库"), ("exp", "实验"), ("data", "数据"), ("paper", "论文"), ("agents", "员工")]
STAGE_MOD = {"idea": "survey", "hatch": "survey", "team": "agents", "method": "survey", "exp": "exp", "write": "paper", "review": "paper", "ship": "paper"}
# the post whose work a stage is: it stands at the stage, and the lead hands the stage's work to it
OWNER = {"idea": "lead", "hatch": "lead", "team": "lead", "method": "lead", "exp": "coder", "write": "writer", "review": "lead", "ship": "lead"}
POSTS = ("lead", "coder", "writer")
LIVE = ("running", "linked")  # the projects still being worked on
STATUS = {"run": "进行中", "done": "完成", "todo": "还没开始"}
TEXT_MAX, LIST_MAX = 4000, 12

# what an agent hands in for a stage: the item's kind and title, the fields it must have, and how to write it
OUTPUTS = {
    "hatch": ("notes", "撞车报告", ("gap",),
              '{"gap": "和最相近的工作差在哪", "summary": "一两句结论", "suggestions": ["…"], "similar": [{"paper_id": "arxiv:2401.01234", "note": "它做了什么、和 idea 的差别"}]}'),
    "method": ("draft", "方法草案", ("title", "problem"),
               '{"title": "英文题目", "problem": "要解决的问题", "mechanism": ["…"], "baselines": [{"name": "…", "source": "arxiv:…"}], "datasets": ["…"], "metrics": ["…"], "risks": ["…"], '
               '"basis": {"problem": ["D2"], "mechanism": ["D3"], "baselines": ["D4"], "datasets": ["D4"], "metrics": ["D5"]}}'),
    "exp": ("table", "结果表", ("metrics", "rows"),
             '{"metrics": ["指标名"], "rows": [{"method": "方法名", "values": [数字], "ours": true, "from": ["来源标签或路径"]}], "seeds": 3, "analysis": "结果说明了什么", "how": "汇总方法", "concerns": ["…"], "job_id": "任务 id"}'),
    "write": ("tex", "论文稿", ("title",), '{"title": "论文题目", "abstract": "摘要", "cite_ids": ["arxiv:2401.01234"], "summary": "这一版改了什么"}'),
    "review": ("pdf", "审稿意见", ("verdict",),
               '{"verdict": "放行 | 退回修改", "mean": 6.5, "reviews": [{"persona": "方法", "overall": 6, "strengths": ["…"], "weaknesses": ["…"], "decision": "accept | revise"}], "feedback": ["要改的事"]}'),
}
NEEDED = ("hatch", "method", "review")  # these stages close only once their output is in


def _short(text: str) -> str:
    return text if len(text) <= 24 else text[:23] + "…"


def _text(v: object, limit: int = TEXT_MAX) -> str:
    return str(v or "").strip()[:limit]


def _list(v: object, limit: int = 400) -> list[str]:
    return [_text(x, limit) for x in (v if isinstance(v, list) else [v] if v else []) if _text(x)][:LIST_MAX]


class LineError(Exception):
    pass


class Pipeline:
    def __init__(self, town: "Town"):
        self.town = town
        self.db = town.db
        self._lock = threading.Lock()

    def line(self, line_id: str) -> dict:
        ln = self.db.one("select * from lines where id = ?", line_id)
        if not ln:
            raise LineError(f"没有这个项目：{line_id}")
        return ln

    def item(self, line_id: str, stage: str) -> dict | None:
        r = self.db.one("select * from items where line_id = ? and stage = ? order by created_at desc, rowid desc limit 1", line_id, stage)
        return r["body"] if r else None

    def agents(self, line_id: str) -> list[dict]:
        """The project's own agents that have been started: who they are and what they run on."""
        rows = self.db.q("select id, role, status, runtime, model from agents where line_id = ? and node_id is null and runtime is not null", line_id)
        return sorted(({**r, "name": ROLES[r["role"]]["name"]} for r in rows if r["role"] in POSTS), key=lambda r: POSTS.index(r["role"]))

    def snapshot(self, line_id: str) -> dict | None:
        ln = self.db.one("select * from lines where id = ?", line_id)
        if not ln:
            return None
        rows = self.db.q("select * from stages where line_id = ? order by idx", line_id)
        team = self.agents(line_id)
        by_role = {a["role"]: a for a in team}
        out_stages = [{"key": r["key"], "name": NAMES[r["key"]], "mod": STAGE_MOD[r["key"]], "status": r["status"], "pct": r["pct"],
                       "building": r["building"], "out": STAGES[r["idx"]][3], "note": r["note"], "owner": OWNER[r["key"]],
                       "agents": [by_role[OWNER[r["key"]]]] if OWNER[r["key"]] in by_role else [],
                       "started_at": r["started_at"], "ended_at": r["ended_at"]} for r in rows]
        linked = self.town.linked.summary(line_id) if ln["linked"] else None
        if linked:
            self.town.linked.overlay(line_id, out_stages)
        done = sum(1 for r in out_stages if r["status"] == "done")
        cur = next((r for r in out_stages if r["status"] == "run"), None)
        items = self.db.q("select id, kind, stage, building, title, agent_id, created_at from items where line_id = ? order by created_at", line_id)
        files = [f for f in ("main.tex", "refs.bib", "main.pdf", "paper.zip") if (self.town.press.root / line_id / f).exists()]
        return {**{k: ln[k] for k in ("id", "seq", "title", "idea", "status", "stage", "mill_id", "verdict", "note", "created_at", "updated_at")},
                "sample": bool(ln["sample"]), "pct": round(100 * done / len(STAGES)), "current": cur, "stages": out_stages, "team": team,
                "lead": self.town.leads.resident(line_id), "linked": linked, "items": items, "files": files}

    def lines(self) -> list[dict]:
        return [self.snapshot(r["id"]) for r in self.db.q("select id from lines order by seq desc")]

    def _publish(self, line_id: str) -> None:
        self.town.bus.publish("line", line=self.snapshot(line_id))

    def _set_line(self, line_id: str, **f) -> None:
        self.db.update("lines", {"id": line_id}, **f, updated_at=now())

    def _stage(self, line_id: str, key: str, status: str, pct: int | None = None, note: str | None = None) -> None:
        f: dict = {"status": status}
        if status != "done":
            f["ended_at"] = None
        if status == "todo":
            f["started_at"] = None
        if pct is not None:
            f["pct"] = pct
        if note is not None:
            f["note"] = note
        if status == "run":
            f["started_at"] = now()
            if pct is None:
                previous = self.db.one("select status, pct from stages where line_id = ? and key = ?", line_id, key)
                f["pct"] = previous["pct"] if previous and previous["status"] == "run" else 0
        if status == "done":
            f["ended_at"], f["pct"] = now(), 100
        self.db.update("stages", {"line_id": line_id, "idx": INDEX[key]}, **f)
        rows = self.db.q("select key, status from stages where line_id = ? order by idx", line_id)
        at = next((r["key"] for r in rows if r["status"] == "run"), None) or next((r["key"] for r in reversed(rows) if r["status"] == "done"), key)
        self._set_line(line_id, stage=at)
        b = self.db.val("select building from stages where line_id = ? and idx = ?", line_id, INDEX[key])
        if b:
            self.town.world.set_status(b, "busy" if status == "run" else "idle", line_id)
        self._publish(line_id)

    # a project begins

    def create(self, text: str) -> dict:
        """An idea becomes a project: its line of stages, with the novelty check open. Its lead takes it from here."""
        text = text.strip()
        if len(text) < 4:
            raise LineError("idea 太短了，多写几句：想解决什么问题、打算怎么做")
        with self.db.transaction():
            seq = (self.db.val("select max(seq) from lines") or 0) + 1
            line_id = f"line_{seq}"
            self.db.insert("lines", {"id": line_id, "seq": seq, "title": _short(text), "idea": text, "status": "running", "stage": "idea",
                                     "mill_id": "mill", "created_at": now(), "updated_at": now()})
            for i, (key, _, b, _) in enumerate(STAGES):
                self.db.insert("stages", {"line_id": line_id, "idx": i, "key": key, "status": "todo", "building": b, "pct": 0})
            self.town.decided.idea(line_id)
        self.town.save_item(line_id, "egg", "idea", "cityhall", f"idea #{seq}", {"text": text})
        self._stage(line_id, "idea", "done")
        self._stage(line_id, "hatch", "run")
        self.town.leads.wake(line_id)
        return self.snapshot(line_id)

    def migrate(self) -> None:
        """Lines from before the leads took over: the old executor's states become plain ones, and its samples are marked."""
        from .samples import SAMPLES
        ideas = [x["idea"] for x in SAMPLES]
        for ln in self.db.q("select id, idea, sample, status from lines where status in ('hatching', 'waiting', 'paused', 'failed')"):
            self.db.update("lines", {"id": ln["id"]}, status="running", note=None, hold=None, sample=1 if ln["idea"] in ideas else ln["sample"])
        self.db.x("update stages set status = 'run' where status = 'fail'")
        self.db.x("update stages set status = 'todo' where status = 'wait'")
        for ln in self.db.q("select id, idea, sample from lines"):
            self.db.update("lines", {"id": ln["id"]}, sample=1 if ln["idea"] in ideas else ln["sample"] or 0)

    # the stages, as the lead moves them

    def stage(self, line_id: str, key: str, status: str, note: str | None = None, pct: int | None = None) -> dict:
        """Open a stage (`run`), close it (`done`) or put it back (`todo`). A stage closes only with its output in and
        its hard gate open."""
        ln = self.line(line_id)
        if key not in INDEX:
            raise LineError(f"没有工序「{key}」，可用的是：{' '.join(INDEX)}")
        if status not in STATUS:
            raise LineError("工序只能 run（开工）、done（收尾）或 todo（放回去）")
        if ln["status"] == "dropped":
            raise LineError("这个项目已经放弃了")
        note = _text(note, 300) or None
        if status != "done":
            if ln["status"] == "done":
                self._set_line(line_id, status="running")
            self._stage(line_id, key, status, pct=0 if status == "todo" else max(0, min(99, int(pct))) if pct is not None else None, note=note)
            return self.snapshot(line_id)
        if key in NEEDED and not self.item(line_id, key):
            raise LineError(f"「{NAMES[key]}」还没有交产出，先用 `pt output {key} '<JSON>'` 交上来（`pt stage` 写着格式）")
        self.town.checks.run(line_id, True)
        why = self.town.canvas.blocked(line_id, key)
        if why:
            raise LineError(f"「{NAMES[key]}」的硬卡口还没放行：{why}。用 `pt checks` 看没过的位置，改完再收尾")
        if key == "team":
            self.town.save_item(line_id, "notes", "team", "market", "编队方案", {"team": self.agents(line_id), "reason": note or ""})
        if key == "ship":
            z = self.town.press.package(line_id)
            self.town.save_item(line_id, "pdf", "ship", "dock_arxiv", "出厂包", {"zip": z.name, "files": self.snapshot(line_id)["files"]})
        self._stage(line_id, key, "done", note=note)
        nxt = self.db.one("select key, status from stages where line_id = ? and idx = ?", line_id, INDEX[key] + 1)
        if nxt and nxt["status"] == "todo":
            self._stage(line_id, nxt["key"], "run")
        if key == "ship":
            self._set_line(line_id, status="done")
            self._publish(line_id)
        return self.snapshot(line_id)

    def survey(self, line_id: str) -> dict:
        """The novelty scan, by code: the library's closest papers to the idea, each with its similarity, and the
        verdict the novelty-check skill's script gives them."""
        idea = self.line(line_id)["idea"]
        hits = self.town.library.search(expand(idea) or idea, top_k=8)["hits"]
        sc = self.town.library.rescore(idea, [h["arxiv_id"] for h in hits])
        v = self.town.skills.run_script("novelty-check", "verdict.py", {
            "candidates": [{"id": h["paper_id"], "title": h["title"], "similarity": h["similarity"]} for h in sc["hits"]], "method": sc["method"]})
        return {"verdict": v.get("verdict", "可孵化"), "summary": v.get("summary", ""), "method": sc["method"], "terms": sc["terms"], "hits": sc["hits"][:8]}

    def output(self, line_id: str, stage: str, body: object, agent_id: str | None = None) -> dict:
        """What an agent hands in for a stage. Numbers a check reads (how close the nearest paper is, the verdict)
        come from code, whatever the agent wrote."""
        ln = self.line(line_id)
        if stage not in OUTPUTS:
            raise LineError(f"「{stage}」没有要交的产出，能交的是：{' '.join(OUTPUTS)}")
        kind, title, need, how = OUTPUTS[stage]
        if not isinstance(body, dict):
            raise LineError(f"产出是一个 JSON 对象：{how}")
        miss = [k for k in need if not body.get(k)]
        if miss:
            raise LineError(f"还缺 {'、'.join(miss)}。格式：{how}")
        for key in need:
            if key not in ("metrics", "rows") and (not isinstance(body[key], str) or not body[key].strip()):
                raise LineError(f"{key} 应为非空文本。格式：{how}")
        for key in {"hatch": ("similar",), "method": ("baselines",), "exp": ("metrics", "rows"), "review": ("reviews",)}.get(stage, ()):
            if key in body and not isinstance(body[key], list):
                raise LineError(f"{key} 应为列表。格式：{how}")
        prepared = None
        if stage == "exp":
            exp = self._out_exp(ln, body)
            self.town.prov.job(line_id, exp["job_id"])
            if self.town.s.prov:
                agent = self.town.agents.get(agent_id)
                prepared = self.town.prov.output_sources(line_id, agent, exp["rows"], exp["job_id"])
        with self.db.transaction():
            basis = self.town.decided.output_basis(line_id, stage, body.get("basis"))
            out = (exp if stage == "exp" else getattr(self, f"_out_{stage}")(ln, body)) | {"basis": basis}
            item = self.town.save_item(line_id, kind, stage, STAGES[INDEX[stage]][2],
                                       _text(out.get("title"), 120) if stage in ("method", "write") else title, out, agent_id)
            if prepared is not None:
                node = self.town.prov.output(item, agent, prepared)
                out = out | {"prov": {"id": node["id"], "tag": node["tag"]}}
        self._publish(line_id)
        return out

    def _out_hatch(self, ln: dict, body: dict) -> dict:
        sv = self.survey(ln["id"])
        known = {h["paper_id"]: h for h in sv["hits"]}
        picked = [s for s in body.get("similar") or [] if isinstance(s, dict) and s.get("paper_id")][:5]
        more = [s["paper_id"] for s in picked if s["paper_id"] not in known]
        if more:  # papers the agent found beyond the scan, scored the same way
            known |= {h["paper_id"]: h for h in self.town.library.rescore(ln["idea"], [i.removeprefix("arxiv:") for i in more])["hits"]}
        similar = [{"paper_id": h["paper_id"], "title": h["title"], "similarity": h["similarity"], "url": h.get("url"), "year": h.get("year"),
                    "note": _text(s.get("note"), 600)} for s in picked if (h := known.get(s["paper_id"]))]
        if not similar:  # the closest by code, so the novelty check always has something to read
            similar = [{"paper_id": h["paper_id"], "title": h["title"], "similarity": h["similarity"], "url": h.get("url"), "year": h.get("year"),
                        "note": ""} for h in sv["hits"][:3]]
        # Keep the closest code-scored work visible to the hard check even when the lead picked other papers.
        seen = {s["paper_id"] for s in similar}
        similar += [{**h, "note": ""} for h in sv["hits"][:3] if h["paper_id"] not in seen]
        self._set_line(ln["id"], verdict=sv["verdict"])
        return {"verdict": sv["verdict"], "similar": similar, "gap": _text(body["gap"]), "suggestions": _list(body.get("suggestions")),
                "summary": _text(body.get("summary"), 600) or sv["summary"], "sources": {"library": len(sv["hits"]), "method": sv["method"]},
                "candidates": sv["hits"]}

    def _out_method(self, ln: dict, body: dict) -> dict:
        base = [{"name": _text(b.get("name") if isinstance(b, dict) else b, 120), "source": _text(b.get("source"), 120) if isinstance(b, dict) else ""}
                for b in (body.get("baselines") or [])[:LIST_MAX] if b]
        out = {"title": _text(body["title"], 160), "problem": _text(body["problem"]), "mechanism": _list(body.get("mechanism"), 800),
               "baselines": [b for b in base if b["name"]], "datasets": _list(body.get("datasets"), 160), "metrics": _list(body.get("metrics"), 160),
               "risks": _list(body.get("risks"))}
        return out

    def _out_exp(self, ln: dict, body: dict) -> dict:
        metrics = _list(body.get("metrics"), 80)
        for row in body["rows"]:
            values = row.get("values") if isinstance(row, dict) else None
            if (not isinstance(row, dict) or not isinstance(row.get("method"), str) or not row["method"].strip()
                    or not isinstance(values, list) or len(values) != len(metrics)
                    or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in values)):
                raise LineError("结果表每行应有方法名，与指标数量一致的有限数值。")
            if "from" in row and (not isinstance(row["from"], list) or not all(isinstance(v, str) and v.strip() for v in row["from"])):
                raise LineError("结果表每行的 from 应为来源列表")
        rows = [{"method": _text(r.get("method"), 120), "values": [v for v in (r.get("values") or [])[:len(metrics)] if isinstance(v, (int, float))],
                 "ours": bool(r.get("ours")), **({"from": r["from"]} if "from" in r else {})}
                for r in (body.get("rows") or [])[:40] if isinstance(r, dict) and r.get("method")]
        if not metrics or not rows:
            raise LineError("结果表要有指标名（metrics）和至少一行（rows：method、values）")
        return {"metrics": metrics, "rows": rows, "seeds": body.get("seeds") if isinstance(body.get("seeds"), int) else None,
                "analysis": _text(body.get("analysis")), "concerns": _list(body.get("concerns")), "job_id": _text(body.get("job_id"), 80) or None,
                **({"how": _text(body["how"])} if body.get("how") else {})}

    def _out_write(self, ln: dict, body: dict) -> dict:
        cites = body.get("cite_ids") if isinstance(body.get("cite_ids"), list) else []
        return {"title": _text(body["title"], 160), "abstract": _text(body.get("abstract")), "cite_ids": [_text(c, 80) for c in cites[:80] if _text(c)],
                "summary": _text(body.get("summary"), 600)}

    def _out_review(self, ln: dict, body: dict) -> dict:
        reviews = [{"persona": _text(r.get("persona"), 40) or "审稿", "overall": r.get("overall") if isinstance(r.get("overall"), (int, float)) else None,
                    "strengths": _list(r.get("strengths")), "weaknesses": _list(r.get("weaknesses")),
                    "decision": "accept" if r.get("decision") == "accept" else "revise"} for r in (body.get("reviews") or [])[:6] if isinstance(r, dict)]
        scores = [r["overall"] for r in reviews if r["overall"] is not None]
        mean = body.get("mean") if isinstance(body.get("mean"), (int, float)) else round(sum(scores) / len(scores), 1) if scores else None
        return {"reviews": reviews, "mean": mean, "verdict": _text(body["verdict"], 40),
                "feedback": _list(body.get("feedback")) or [w for r in reviews for w in r["weaknesses"]][:LIST_MAX]}

    # as the lead reads it

    def text(self, line_id: str) -> str:
        """The line as its lead reads it: each stage, whose work it is, what it has handed in, what holds it."""
        snap = self.snapshot(line_id)
        if not snap:
            raise LineError("没有这个项目")
        have = {i["stage"] for i in snap["items"]}
        out = [f"项目 #{snap['seq']}「{snap['title']}」的工序（{snap['pct']}%）："]
        for s in snap["stages"]:
            k = s["key"]
            who = ROLES[s["owner"]]["name"] + ("" if s["agents"] or s["owner"] == "lead" else "，还没有启动")
            tail = [STATUS.get(s["status"], s["status"]) + (f" {s['pct']}%" if s["status"] == "run" and s["pct"] else ""), who]
            if k in OUTPUTS:
                tail.append("产出已交" if k in have else "要交产出" if k in NEEDED else "产出可交")
            if s["note"]:
                tail.append(s["note"])
            why = self.town.canvas.blocked(line_id, k) if s["status"] != "todo" else ""
            out.append(f"- {k} {s['name']}：{'，'.join(tail)}" + (f"【硬卡口阻断：{why}】" if why else ""))
        out += ["", "推进：`pt stage run <工序> [\"说明\"] [--pct 0-99]` 开工或写进度，`pt stage done <工序> [\"说明\"]` 收尾，`pt stage todo <工序> \"原因\"` 放回去重做。",
                "收尾时 Papertown 会再跑一遍硬检查：阻断级的没过就收不了，改完再来。一道工序收尾后，下一道自动开工。", "",
                "产出：`pt output <工序> '<JSON>'`（也可以写成文件：`pt output <工序> @文件.json`）。格式："]
        out += [f"- {k}：{how}" for k, (_, _, _, how) in OUTPUTS.items()]
        out += ["各工序产出用 basis 列出依据编号。方法草案按项引用用户决定。",
                "查重报告写明相近工作、差异及出处。需要调整方向时，用 pt raise 请用户决定。"]
        return "\n".join(out)

    def survey_text(self, line_id: str) -> str:
        sv = self.survey(line_id)
        out = [f"查重（用代码算，{sv['method']}）：{sv['verdict']}。{sv['summary']}", f"检索词：{', '.join(sv['terms'][:12])}", "", "图书馆里最接近的："]
        out += [f"- {h['paper_id']}（相似度 {h['similarity']:.2f}，{h.get('year') or '?'}）{h['title']}\n  {_text(h.get('snippet'), 300)}" for h in sv["hits"]]
        out += ["", "读完后用 `pt library \"<英文关键词>\"` 换几个说法再找一找，然后用 `pt output hatch '<JSON>'` 交撞车报告。"]
        return "\n".join(out)
