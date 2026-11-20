"""A line is one paper's life, idea to shipped PDF, in eight stages across the town.
Each line runs in its own thread and publishes its progress on the event bus; a restart pauses it at its current stage.
"""

from __future__ import annotations

import threading
import traceback
from typing import TYPE_CHECKING

from . import stages
from .db import now
from .market import title

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
MAX_REVISIONS = 1


def _short(text: str) -> str:
    return text if len(text) <= 24 else text[:23] + "…"


class LineError(Exception):
    pass


class Pipeline:
    def __init__(self, town: "Town"):
        self.town = town
        self.db = town.db
        self._active: set[str] = set()
        self._lock = threading.Lock()

    def line(self, line_id: str) -> dict:
        ln = self.db.one("select * from lines where id = ?", line_id)
        if not ln:
            raise LineError(f"没有这条流水线：{line_id}")
        return ln

    def item(self, line_id: str, stage: str) -> dict | None:
        r = self.db.one("select * from items where line_id = ? and stage = ? order by created_at desc, rowid desc limit 1", line_id, stage)
        return r["body"] if r else None

    def snapshot(self, line_id: str) -> dict | None:
        ln = self.db.one("select * from lines where id = ?", line_id)
        if not ln:
            return None
        rows = self.db.q("select * from stages where line_id = ? order by idx", line_id)
        workers = {w["id"]: w for w in self.town.market.all()}
        plan = ln["plan"] or {}
        out_stages = []
        for r in rows:
            ids = r["workers"] or []
            out_stages.append({"key": r["key"], "name": NAMES[r["key"]], "status": r["status"], "pct": r["pct"],
                               "building": r["building"], "out": STAGES[r["idx"]][3], "note": r["note"],
                               "workers": [{"id": i, "role": workers[i]["role"], "level": workers[i]["level"],
                                            "title": title(workers[i])} for i in ids if i in workers],
                               "started_at": r["started_at"], "ended_at": r["ended_at"]})
        linked = self.town.linked.summary(line_id) if ln["linked"] else None
        if linked:
            self.town.linked.overlay(line_id, out_stages)
        done = sum(1 for r in out_stages if r["status"] == "done")
        cur = next((r for r in out_stages if r["status"] in ("run", "wait")), None)
        items = self.db.q("select id, kind, stage, building, title, created_at from items where line_id = ? order by created_at", line_id)
        files = [f for f in ("main.tex", "refs.bib", "main.pdf", "paper.zip") if (self.town.press.root / line_id / f).exists()]
        return {**{k: ln[k] for k in ("id", "seq", "title", "idea", "budget", "spent", "status", "stage", "mill_id", "verdict",
                                       "revisions", "note", "created_at", "updated_at")},
                "pct": round(100 * done / len(STAGES)), "current": cur, "stages": out_stages, "team": plan.get("team", {}), "linked": linked,
                "reason": plan.get("reason"), "items": items, "files": files}

    def lines(self) -> list[dict]:
        return [self.snapshot(r["id"]) for r in self.db.q("select id from lines order by seq desc")]

    def _publish(self, line_id: str) -> None:
        self.town.bus.publish("line", line=self.snapshot(line_id))

    def _set_line(self, line_id: str, **f) -> None:
        self.db.update("lines", {"id": line_id}, **f, updated_at=now())

    def _stage(self, line_id: str, key: str, status: str, pct: int | None = None, note: str | None = None,
               workers: list[str] | None = None, building: str | None = None) -> None:
        f: dict = {"status": status}
        if pct is not None:
            f["pct"] = pct
        if note is not None:
            f["note"] = note
        if workers is not None:
            f["workers"] = workers
        if building is not None:
            f["building"] = building
        if status == "run":
            f["started_at"] = now()
        if status == "done":
            f["ended_at"], f["pct"] = now(), 100
        self.db.update("stages", {"line_id": line_id, "idx": INDEX[key]}, **f)
        if status in ("run", "done"):
            self._set_line(line_id, stage=key)
        b = building or self.db.val("select building from stages where line_id = ? and idx = ?", line_id, INDEX[key])
        if b:
            self.town.world.set_status(b, "busy" if status == "run" else "idle", line_id)
        self._publish(line_id)

    def _say(self, line_id: str, worker: dict | None, text: str, kind: str = "text", **body) -> None:
        self.town.message(line_id, "worker" if worker else "system", worker["id"] if worker else None, kind, {"text": text, **body})

    def _spawn(self, line_id: str, fn, *args) -> None:
        with self._lock:
            if line_id in self._active:
                raise LineError("这条流水线已经在运行")
            self._active.add(line_id)

        def run():
            try:
                fn(line_id, *args)
            except Exception as e:  # keep the town alive; the line records what went wrong
                traceback.print_exc()
                for stage in self.db.q("select key from stages where line_id = ? and status = 'run'", line_id):
                    self._stage(line_id, stage["key"], "wait", note=str(e))
                self._set_line(line_id, status="failed", note=f"{type(e).__name__}: {e}")
                self._say(line_id, None, f"流水线出错停下了：{e}", kind="error")
                self._publish(line_id)
            finally:
                with self._lock:
                    self._active.discard(line_id)

        threading.Thread(target=run, daemon=True, name=f"line-{line_id}").start()

    def running(self, line_id: str) -> bool:
        with self._lock:
            return line_id in self._active

    def submit_idea(self, text: str, budget: float | None = None) -> dict:
        text = text.strip()
        if len(text) < 4:
            raise LineError("idea 太短了，多写几句：想解决什么问题、打算怎么做")
        budget = float(budget or self.town.s.default_line_budget)
        seq = (self.db.val("select max(seq) from lines") or 0) + 1
        line_id = f"line_{seq}"
        with self.db.lock:
            self.db.insert("lines", {"id": line_id, "seq": seq, "title": _short(text), "idea": text, "budget": budget, "spent": 0,
                                     "status": "hatching", "stage": "idea", "revisions": 0, "created_at": now(), "updated_at": now()})
            for i, (key, _, b, _) in enumerate(STAGES):
                self.db.insert("stages", {"line_id": line_id, "idx": i, "key": key, "status": "todo", "building": b, "workers": [], "pct": 0})
        self.town.save_item(line_id, "egg", "idea", "cityhall", f"idea #{seq}", {"text": text, "budget": budget})
        self.town.message(line_id, "user", None, "text", {"text": text})
        self._stage(line_id, "idea", "done")
        self._spawn(line_id, self._hatch)
        return self.snapshot(line_id)

    def adjust(self, line_id: str, text: str) -> dict:
        ln = self.line(line_id)
        if ln["status"] not in ("waiting", "failed", "paused"):
            raise LineError("只有等你决定的 idea 才能调整")
        self._set_line(line_id, idea=text.strip(), title=_short(text), status="hatching", verdict=None)
        self.town.message(line_id, "user", None, "text", {"text": f"调整 idea：{text}"})
        self._spawn(line_id, self._hatch)
        return self.snapshot(line_id)

    def _hatch(self, line_id: str) -> None:
        worker = self.town.market.best("hatcher")[0]
        self._stage(line_id, "hatch", "run", pct=10, workers=[worker["id"]])
        self._say(line_id, worker, "收到，我先去图书馆和 arXiv 码头查有没有撞车的工作。")
        report, res = stages.hatch(self.town, self.line(line_id), worker)
        self.town.save_item(line_id, "notes", "hatch", "hatchery", "撞车报告", report)
        self._set_line(line_id, status="waiting", verdict=report.get("verdict"))
        self._stage(line_id, "hatch", "done", note=report.get("verdict"))
        self.db.update("stages", {"line_id": line_id, "idx": INDEX["team"]}, status="wait")
        self._say(line_id, worker, report.get("summary") or report.get("verdict", ""), kind="report", report=report,
                  cost=round(res.cost, 4), steps=res.steps, degraded=res.degraded, skills=res.skills)
        self._publish(line_id)

    def hatch(self, line_id: str) -> dict:
        ln = self.line(line_id)
        if ln["status"] != "waiting":
            raise LineError("这颗蛋现在不能孵化")
        report = self.item(line_id, "hatch") or {}
        plan = self.town.market.compile_team(ln["idea"], report, ln["budget"])
        self.town.trace("SCRIPT", "market.compile_team", plan["reason"], 0, line_id=line_id)
        ids = [w for ws in plan["team"].values() for w in ws]
        self._set_line(line_id, status="running", plan=plan)
        self._stage(line_id, "team", "run", workers=ids)
        self._set_line(line_id, mill_id="mill")
        self.town.world.set_status("mill", "busy", line_id)
        self.town.save_item(line_id, "notes", "team", "market", "编队方案", plan)
        workers = {w["id"]: w for w in self.town.market.all()}
        def who(i: str) -> str:
            return f"{title(workers[i])} Lv.{workers[i]['level']}"

        roster = " · ".join(f"{NAMES[k]}：{', '.join(who(i) for i in v)}" for k, v in plan["team"].items())
        self._say(line_id, None, f"项目 #{ln['seq']} 在造纸厂立项。人才市场编队：{roster}。{plan['reason']}。", kind="team",
                  mill="mill", team=plan["team"])
        self._stage(line_id, "team", "done")
        self._spawn(line_id, self._produce)
        return self.snapshot(line_id)

    def resume(self, line_id: str) -> dict:
        ln = self.line(line_id)
        if ln["status"] not in ("paused", "failed"):
            raise LineError("只有暂停或出错的流水线可以继续")
        if not ln["plan"]:
            self._set_line(line_id, status="hatching")
            self._spawn(line_id, self._hatch)
        else:
            self._set_line(line_id, status="running", note=None)
            self._spawn(line_id, self._produce)
        return self.snapshot(line_id)

    def recover(self) -> None:
        """After a restart nothing is running: park interrupted lines."""
        for ln in self.db.q("select id from lines where status in ('running', 'hatching')"):
            self._set_line(ln["id"], status="paused", note="服务重启，点「继续」从当前工序接着跑")
            self.db.x("update stages set status = 'todo', pct = 0 where line_id = ? and status = 'run'", ln["id"])
        self.db.x("update buildings set status = 'idle' where status = 'busy'")

    def _team(self, line_id: str, key: str) -> list[dict]:
        ln = self.line(line_id)
        return [self.town.market.get(i) for i in (ln["plan"] or {}).get("team", {}).get(key, [])]

    def _held(self, line_id: str, key: str) -> bool:
        """Park a demo sample before a stage once, to show a paper part way along."""
        if self.db.val("select hold from lines where id = ?", line_id) != key:
            return False
        self._set_line(line_id, status="paused", hold=None, note=f"展示样例停在「{NAMES[key]}」之前，点「继续」接着跑")
        mill = self.line(line_id)["mill_id"]
        if mill:
            self.town.world.set_status(mill, "idle", line_id)
        self._publish(line_id)
        return True

    def _produce(self, line_id: str) -> None:
        def todo(key: str) -> bool:
            return self.db.val("select status from stages where line_id = ? and idx = ?", line_id, INDEX[key]) != "done"

        report = self.item(line_id, "hatch") or {}
        if todo("method") and self._held(line_id, "method"):
            return
        if todo("method"):
            team = self._team(line_id, "method")
            self._stage(line_id, "method", "run", pct=10, workers=[w["id"] for w in team])
            self._say(line_id, team[0], "开始写方法草案：先补检索，再去仓库群找 baseline。", kind="stage", stage="method")
            draft, _ = stages.method(self.town, self.line(line_id), team[0], report)
            self.town.save_item(line_id, "draft", "method", self.line(line_id)["mill_id"], draft.get("title", "方法草案"), draft)
            self._set_line(line_id, title=draft.get("title", "")[:80] or self.line(line_id)["title"])
            self._say(line_id, team[0], f"方法草案「{draft.get('title')}」写好了，baseline：{', '.join(b['name'] for b in draft.get('baselines') or [])}。",
                      kind="stage", stage="method")
            self._stage(line_id, "method", "done")
        draft = self.item(line_id, "method") or {}

        if todo("exp") and self._held(line_id, "exp"):
            return
        if todo("exp"):
            team = self._team(line_id, "exp")
            self._stage(line_id, "exp", "run", pct=10, workers=[w["id"] for w in team])
            self._say(line_id, team[0], f"去{self.town.plant.name}申请算力，跑主实验。", kind="stage", stage="exp")
            table, _ = stages.experiment(self.town, self.line(line_id), team[0], draft)
            self.town.save_item(line_id, "table", "exp", "farm", "结果表" + ("（模拟）" if table.get("simulated") else ""), table)
            self._say(line_id, team[0], table.get("analysis", ""), kind="stage", stage="exp")
            self._stage(line_id, "exp", "done")
        table = self.item(line_id, "exp") or {}

        while True:
            ln = self.line(line_id)
            if todo("write") and self._held(line_id, "write"):
                return
            if todo("write"):
                team = self._team(line_id, "write")
                feedback = (self.item(line_id, "review") or {}).get("feedback", []) if ln["revisions"] else []
                self._stage(line_id, "write", "run", pct=10, workers=[w["id"] for w in team])
                self._say(line_id, team[0], "排铅字：按草案和结果写初稿，生成 refs.bib 后开机印刷。" if not feedback
                          else f"按审稿意见改第 {ln['revisions'] + 1} 版。", kind="stage", stage="write")
                tex, _ = stages.write(self.town, ln, team[0], report, draft, table, feedback)
                info = tex.get("typeset") or {}
                self._say(line_id, team[0], f"{tex.get('summary', '')}（{info.get('summary', '')}）", kind="stage", stage="write")
                self._stage(line_id, "write", "done")
            tex = self.item(line_id, "write") or {}

            if self._held(line_id, "review"):
                return
            team = self._team(line_id, "review")
            self._stage(line_id, "review", "run", pct=10, workers=[w["id"] for w in team])
            fmt = stages.format_check(self.town, ln, tex)
            reviews = []
            for k, w in enumerate(team):
                r, _ = stages.review(self.town, self.line(line_id), w, k, report, table, fmt)
                reviews.append(r)
                self._stage(line_id, "review", "run", pct=10 + 80 * (k + 1) // len(team))
                self._say(line_id, w, f"{r['persona']}审稿：总分 {r['overall']}，{'建议接收' if r['decision'] == 'accept' else '建议修改'}。"
                          + (f"主要问题：{r['weaknesses'][0]}" if r.get("weaknesses") else ""), kind="stage", stage="review")
            mean = sum(r["overall"] for r in reviews) / max(1, len(reviews))
            passed = fmt.get("ok", True) and mean >= 5
            feedback = [x for r in reviews for x in r.get("weaknesses", [])]
            verdict = "放行" if passed else ("退回印刷厂" if ln["revisions"] < MAX_REVISIONS else "带意见放行")
            self.town.save_item(line_id, "pdf", "review", "qa", f"审稿意见 · {verdict}",
                                {"reviews": reviews, "format": fmt, "mean": round(mean, 1), "verdict": verdict, "feedback": feedback})
            if passed or ln["revisions"] >= MAX_REVISIONS:
                self._stage(line_id, "review", "done", note=verdict)
                break
            self._set_line(line_id, revisions=ln["revisions"] + 1)
            self._say(line_id, None, f"质检所：平均 {mean:.1f} 分{'，有格式硬伤' if not fmt.get('ok', True) else ''}，退回印刷厂改一版。", kind="stage", stage="review")
            self._stage(line_id, "review", "todo", pct=0, note="退回修改")
            self._stage(line_id, "write", "todo", pct=0, note="按审稿意见修改")

        self._ship(line_id, report, table)

    def _ship(self, line_id: str, report: dict, table: dict) -> None:
        self._stage(line_id, "ship", "run", pct=50)
        z = self.town.press.package(line_id)
        files = self.snapshot(line_id)["files"]
        self.town.save_item(line_id, "pdf", "ship", "dock_arxiv", "出厂包", {"zip": z.name, "files": files})
        self._stage(line_id, "ship", "done")

        ln = self.line(line_id)
        rv = self.item(line_id, "review") or {}
        reviews = rv.get("reviews", [])
        mean = rv.get("mean", 5) / 10
        soundness = sum(r.get("scores", {}).get("soundness", 5) for r in reviews) / max(1, len(reviews)) / 10
        compiled = (self.item(line_id, "write") or {}).get("typeset", {}).get("compiled", False)
        team = (ln["plan"] or {}).get("team", {})
        quality: dict[str, float] = {}
        hatchers = self.db.one("select workers from stages where line_id = ? and idx = ?", line_id, INDEX["hatch"])["workers"]
        for wid in hatchers or []:
            quality[wid] = 0.8 if not report.get("verdict_note") else 0.6
        for wid in team.get("method", []):
            quality[wid] = min(1.0, soundness + 0.25)
        for wid in team.get("exp", []):
            quality[wid] = 0.8 if table.get("rows") else 0.3
        for wid in team.get("write", []):
            quality[wid] = max(0.1, min(1.0, mean + (0.1 if compiled else 0) - 0.15 * ln["revisions"]))
        for r in reviews:
            quality[r["worker"]] = min(0.9, 0.6 + 0.05 * len(r.get("weaknesses", [])))
        changes = self.town.market.settle(line_id, quality)
        spent = self.town.bank.line_spent(line_id)
        self._set_line(line_id, status="done", spent=spent)
        mill = ln["mill_id"]
        if mill:
            self.town.world.set_status(mill, "idle", line_id)
        self._say(line_id, None, f"论文出厂了：{ln['title']}。总花费 ${spent:.4f}。"
                  + ("".join(f" {c['note']}。" for c in changes)), kind="paper", files=files)
        self._publish(line_id)
