"""Each project's card on the 进展 page: where it stands, in fields its lead fills in when you
ask. Nothing fills it on its own: you press 更新 (on one card, or on all of them), Papertown
sends the lead a <card> message with the fields and the card as it is, the lead reads the
project (pt status, pt worker, pt jobs) and writes the card back with `pt card set`. A card
nobody asked for is refused. Beside it the page shows what Papertown knows itself, as it is
now: the stages, the experiments running and queued, the code and paper repositories, the
memories imported from earlier agent conversations, the questions waiting for you.

Which parts a card shows, and in what order, is one choice for every card (so they stay the
same height): the panes, picked on the page.

    data/projects/<project>/card.json    the card, the one before it, and the request in flight
    data/card_layout.json                 the panes the cards show
"""

from __future__ import annotations

import json
import threading
import time
from collections import Counter
from pathlib import Path
from typing import TYPE_CHECKING

from .agents import AgentError
from .db import now
from .linked import _git, _home
from .workspace import list_files

if TYPE_CHECKING:
    from .town import Town

HEALTH = {"ok": "顺利", "risk": "有风险", "blocked": "卡住了"}
LISTS = {"done": "最近完成的", "next": "接下来要做的", "blockers": "卡点和风险", "need_you": "要用户决定或去做的"}
STATES = {"todo": "还没开始", "doing": "在做", "done": "完成"}
LIST_MAX = 6
SUMMARY_MAX, ITEM_MAX = 200, 160
# what a card can show, in the order offered; the lead's fields and Papertown's own facts
PANES = {"summary": "进展摘要", "attention": "要你决定和卡点", "milestone": "下一个里程碑", "metrics": "关键数字",
         "running": "在跑的实验", "planned": "规划中的实验", "outputs": "预期产出", "code": "代码仓库", "paper": "论文仓库",
         "memory": "导入的记忆"}
DEFAULT_PANES = ["summary", "attention", "running", "planned", "outputs", "code", "paper"]
REPO_TTL = 30  # seconds a repository's line on the card is reused

FIELDS = f"""- summary：一两句话，项目现在的样子（必填，{SUMMARY_MAX} 字以内）
- health：ok（顺利）、risk（有风险）或 blocked（卡住了）
- progress：0–100 的整数，你估计整个项目完成了多少；说不准就不写
- milestone：下一个里程碑，一句话
- done：最近完成的事
- next：接下来要做的
- blockers：卡点和风险
- need_you：要用户决定或去做的
- metrics：关键数字，每个写成 {{"name": "…", "value": "…", "note": "…"}}（note 可以不写）
- plans：规划中、还没提交的实验，每个写成 {{"name": "…", "goal": "…", "when": "…"}}（goal 是想验证什么，when 是打算什么时候跑，都可以不写）
- outputs：预期产出（论文、主表、图、模型、数据集…），每个写成 {{"name": "…", "due": "…", "state": "todo|doing|done"}}（due 可以不写）
done、next、blockers、need_you、metrics、plans、outputs 各最多 {LIST_MAX} 条，每条一句话（{ITEM_MAX} 字以内），没有就写空列表。
在跑的实验不用写：Papertown 自己从任务队列里读。"""

EXAMPLE = {"summary": "主实验在 4 张卡上跑到第 3 轮，消融还没开始。", "health": "ok", "progress": 45,
           "milestone": "周五前拿到主表的三组结果", "done": ["baseline 复现，和论文差 0.3 以内"], "next": ["跑完主实验", "写方法一节"],
           "blockers": [], "need_you": ["要不要加第四个数据集"], "metrics": [{"name": "主指标", "value": "71.2", "note": "baseline 68.9"}],
           "plans": [{"name": "消融：去掉记忆模块", "goal": "看记忆模块贡献多少", "when": "主实验跑完后"}],
           "outputs": [{"name": "主表（三个数据集）", "due": "周五", "state": "doing"}, {"name": "方法框图", "state": "todo"}]}


class CardError(Exception):
    pass


def _text(v: object, n: int, what: str) -> str:
    t = " ".join(str(v if v is not None else "").split())
    if len(t) > n:
        raise CardError(f"{what}太长了：最多 {n} 个字")
    return t


def clean(d: object) -> dict:
    """A card as the lead wrote it, checked field by field."""
    if not isinstance(d, dict):
        raise CardError("卡片要写成一个 JSON 对象")
    unknown = [k for k in d if k not in ("summary", "health", "progress", "milestone", "metrics", "plans", "outputs", *LISTS)]
    if unknown:
        raise CardError(f"没有这些字段：{'、'.join(unknown)}")
    out: dict = {"summary": _text(d.get("summary"), SUMMARY_MAX, "summary")}
    if not out["summary"]:
        raise CardError("summary 是必填的")
    health = d.get("health") or "ok"
    if health not in HEALTH:
        raise CardError(f"health 只能是 {'、'.join(HEALTH)}")
    out["health"] = health
    p = d.get("progress")
    if p not in (None, ""):
        try:
            p = int(round(float(p)))
        except (TypeError, ValueError):
            raise CardError("progress 要是 0–100 的数字") from None
        if not 0 <= p <= 100:
            raise CardError("progress 要在 0–100 之间")
    out["progress"] = None if p in (None, "") else p
    out["milestone"] = _text(d.get("milestone"), ITEM_MAX, "milestone")
    for k in LISTS:
        v = d.get(k) or []
        if not isinstance(v, list):
            raise CardError(f"{k} 要是一个列表")
        if len(v) > LIST_MAX:
            raise CardError(f"{k} 最多 {LIST_MAX} 条")
        out[k] = [t for t in (_text(x, ITEM_MAX, k) for x in v) if t]
    ms = d.get("metrics") or []
    if not isinstance(ms, list) or len(ms) > LIST_MAX:
        raise CardError(f"metrics 要是一个列表，最多 {LIST_MAX} 个")
    out["metrics"] = []
    for m in ms:
        if not isinstance(m, dict) or not str(m.get("name") or "").strip():
            raise CardError('metrics 的每一个写成 {"name": "…", "value": "…", "note": "…"}')
        out["metrics"].append({"name": _text(m["name"], 40, "metrics 的 name"), "value": _text(m.get("value"), 40, "metrics 的 value"),
                               "note": _text(m.get("note"), 80, "metrics 的 note")})
    out["plans"] = [{"name": _text(x["name"], ITEM_MAX, "plans 的 name"), "goal": _text(x.get("goal"), ITEM_MAX, "plans 的 goal"),
                     "when": _text(x.get("when"), 40, "plans 的 when")}
                    for x in _items(d, "plans", '{"name": "…", "goal": "…", "when": "…"}')]
    out["outputs"] = []
    for x in _items(d, "outputs", '{"name": "…", "due": "…", "state": "todo|doing|done"}'):
        state = x.get("state") or "todo"
        if state not in STATES:
            raise CardError(f"outputs 的 state 只能是 {'、'.join(STATES)}")
        out["outputs"].append({"name": _text(x["name"], ITEM_MAX, "outputs 的 name"), "due": _text(x.get("due"), 40, "outputs 的 due"),
                               "state": state})
    return out


def _items(d: dict, k: str, shape: str) -> list[dict]:
    """A list of objects with a name, as plans and outputs are written; a bare sentence is a name."""
    v = d.get(k) or []
    if not isinstance(v, list) or len(v) > LIST_MAX:
        raise CardError(f"{k} 要是一个列表，最多 {LIST_MAX} 个")
    out = []
    for x in v:
        if isinstance(x, str):
            x = {"name": x}
        if not isinstance(x, dict) or not str(x.get("name") or "").strip():
            raise CardError(f"{k} 的每一个写成 {shape}")
        out.append(x)
    return out


class Cards:
    def __init__(self, town: "Town"):
        self.town = town
        self.db = town.db
        self.s = town.s
        self._lock = threading.Lock()
        self._repos: dict[str, tuple[float, dict]] = {}

    def _path(self, line_id: str):
        return self.s.projects_dir / line_id / "card.json"

    def _read(self, line_id: str) -> dict:
        try:
            d = json.loads(self._path(line_id).read_text(encoding="utf-8"))
            return d if isinstance(d, dict) else {}
        except (OSError, ValueError):
            return {}

    def _write(self, line_id: str, d: dict) -> None:
        p = self._path(line_id)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(d, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        tmp.replace(p)

    def _lead(self, line_id: str) -> dict | None:
        a = self.town.agents.get(f"lead-{line_id}")
        return a if a and a.get("runtime") else None

    # ---------- what the page shows ----------

    def row(self, line: dict) -> dict:
        """One project on the 进展 page: Papertown's own facts, its lead, and the card."""
        lid = line["id"]
        d = self._read(lid)
        stages = line.get("stages") or []
        # the stage it is at, or (paused, not started) the one it comes to next
        cur = next((s for s in stages if s["status"] in ("run", "wait")), None) or next((s for s in stages if s["status"] == "todo"), None)
        jobs = self.town.leads._jobs(lid)  # the farm's and, for a linked project, nvidb's
        a = self.town.agents.get(f"lead-{lid}")
        card = d.get("card")
        if card:  # a card written before plans and outputs were fields
            card = {"plans": [], "outputs": [], **card}
        return {
            "line": {"id": lid, "seq": line["seq"], "title": line["title"], "status": line["status"], "linked": bool(line.get("linked")),
                     "stages": [{"key": s["key"], "name": s["name"], "status": s["status"]} for s in stages],
                     "stage": cur and {"name": cur["name"], "status": cur["status"], "pct": cur.get("pct", 0)}, "updated_at": line.get("updated_at")},
            "lead": self.town.agents.public(a) if a else None,
            "card": card, "prev": (d.get("prev") or {}).get("progress"), "pending": d.get("pending"),
            "jobs": dict(Counter(j.get("status") for j in jobs)),
            "running": [self._run(j) for j in jobs if j.get("status") == "running"][:8],
            "queued": [self._run(j) for j in jobs if j.get("status") == "queued"][:8],
            "repos": self.repos(lid),
            "memory": self.town.history.counts(lid),
            "asks": len(self.town.leads.asks(lid)),
        }

    @staticmethod
    def _run(j: dict) -> dict:
        """A job as the card lists it: what it is, where, how far."""
        nv = j.get("nvidb") or {}
        where = f"{nv['node']}:{','.join(map(str, nv.get('gpu_ids') or []))}" if nv.get("node") else j.get("backend")
        line = nv.get("progress") if isinstance(nv.get("progress"), str) else None
        return {"id": j["id"], "name": j.get("name") or j["id"], "where": where, "progress": j.get("progress"), "line": line,
                "since": j.get("started_at") or j.get("created_at")}

    # ---------- the repositories, in a line each ----------

    def repos(self, line_id: str) -> dict:
        hit = self._repos.get(line_id)
        if hit and time.time() - hit[0] < REPO_TTL:
            return hit[1]
        out = {}
        linked = self.town.linked.summary(line_id) if self.town.linked.of(line_id) else None
        for which in ("code", "paper"):
            try:
                root = self.town.workspace.root(line_id, which)
            except Exception:  # noqa: BLE001 - no project, no repository
                root = None
            info = (linked or {}).get(which) if linked else None
            if info and info.get("missing"):
                out[which] = {"path": info["path"], "name": Path(info["path"]).name, "missing": True}
            elif root:
                out[which] = self._repo(root, which, info)
            else:
                out[which] = None
        self._repos[line_id] = (time.time(), out)
        return out

    @staticmethod
    def _repo(root: Path, which: str, info: dict | None) -> dict:
        git = (root / ".git").exists()
        d: dict = {"path": _home(root), "name": root.name, "git": git}
        if git:
            last = _git(root, "log", "-1", "--format=%h%x09%cI%x09%s").strip().split("\t")
            d |= {"branch": _git(root, "rev-parse", "--abbrev-ref", "HEAD").strip() or None,
                  "dirty": len(_git(root, "status", "--porcelain").splitlines()),
                  "commit": {"hash": last[0], "when": last[1], "subject": last[2]} if len(last) == 3 else None}
        if info:  # a linked repository's summary, already read for its survey
            if which == "code":
                d |= {k: info.get(k) for k in ("remote", "files", "langs")}
            else:
                d |= {k: info.get(k) for k in ("main", "title", "words", "figures", "tables", "bib", "pdf", "pdf_at")}
                d["sections"] = len(info.get("sections") or [])
        elif which == "paper":
            d["main"] = "main.tex" if (root / "main.tex").exists() else None
            d["pdf"] = (root / "main.pdf").exists()
        if not git and which == "code":  # Papertown's own code directory for a project: how much is in it
            d["files"] = len(list_files(root)["files"])
        return d

    # ---------- which panes the cards show ----------

    def _layout_path(self):
        return self.s.data_dir / "card_layout.json"

    def layout(self) -> dict:
        try:
            v = json.loads(self._layout_path().read_text(encoding="utf-8")).get("panes")
        except (OSError, ValueError, AttributeError):
            v = None
        panes = [p for p in v if p in PANES] if isinstance(v, list) else list(DEFAULT_PANES)
        return {"panes": panes, "all": [{"key": k, "name": n} for k, n in PANES.items()], "default": DEFAULT_PANES}

    def set_layout(self, panes: list[str] | None) -> dict:
        """The panes every card shows, in order; None goes back to the default."""
        if panes is not None:
            bad = [p for p in panes if p not in PANES]
            if bad:
                raise CardError(f"没有这些部分：{'、'.join(bad)}")
            panes = list(dict.fromkeys(panes))
        self._layout_path().write_text(json.dumps({"panes": panes if panes is not None else DEFAULT_PANES}, ensure_ascii=False) + "\n",
                                       encoding="utf-8")
        out = self.layout()
        self.town.bus.publish("card_layout", layout=out)
        return out

    def all(self) -> list[dict]:
        return [self.row(ln) for ln in self.town.pipeline.lines() if ln["status"] != "dropped"]

    def one(self, line_id: str) -> dict:
        line = self.town.pipeline.snapshot(line_id)
        if not line:
            raise CardError("没有这个项目")
        return self.row(line)

    def _publish(self, line_id: str) -> None:
        try:
            self.town.bus.publish("card", card=self.one(line_id))
        except CardError:
            pass

    # ---------- asking the lead for it ----------

    def request(self, line_id: str, note: str = "") -> dict:
        """You pressed 更新: the lead gets a <card> message and writes the card back."""
        if not self.db.one("select 1 from lines where id = ?", line_id):
            raise CardError("没有这个项目")
        a = self._lead(line_id)
        if not a:
            raise CardError("这个项目还没有负责人：先给它配一个")
        with self._lock:
            d = self._read(line_id)
            msg = self.message(line_id, d.get("card"), note)
            try:
                self.town.agents.say(a["id"], msg, "queue", origin="papertown")
            except AgentError as e:
                raise CardError(str(e)) from e
            d["pending"] = {"at": now(), "note": " ".join(note.split())[:300]}
            self._write(line_id, d)
        self._publish(line_id)
        return self.one(line_id)

    def request_all(self) -> dict:
        """更新全部: every project whose lead is there, except those already being updated."""
        sent, skipped = [], []
        for ln in self.db.q("select id, status from lines order by seq desc"):
            if ln["status"] == "dropped" or not self._lead(ln["id"]) or self._read(ln["id"]).get("pending"):
                continue
            try:
                self.request(ln["id"])
                sent.append(ln["id"])
            except CardError as e:
                skipped.append({"line_id": ln["id"], "why": str(e)})
        return {"sent": sent, "skipped": skipped}

    def cancel(self, line_id: str) -> dict:
        with self._lock:
            d = self._read(line_id)
            d["pending"] = None
            self._write(line_id, d)
        self._publish(line_id)
        return self.one(line_id)

    def message(self, line_id: str, card: dict | None, note: str = "") -> str:
        seq = self.db.val("select seq from lines where id = ?", line_id)
        now_card = {k: v for k, v in card.items() if k not in ("at", "by")} if card else None
        out = ["<card>", f"用户请你更新项目 #{seq} 在「进展」页上的卡片。",
               "先弄清项目现在的样子（pt status，需要时 pt worker coder|writer、pt jobs），再按下面的字段写成一个 JSON，"
               "用 `pt card set '<JSON>'` 交上来（长的可以先写进文件，再 `pt card set 文件.json`）。只写你读到的事实，不知道的就空着；"
               "这一轮只更新卡片，不派活、不写汇报。", "", "字段：", FIELDS, "",
               "例子：", json.dumps(EXAMPLE, ensure_ascii=False), ""]
        if now_card:
            out += [f"现在的卡片（{card.get('at', '')[:16].replace('T', ' ')} 写的），没变的可以照抄：", json.dumps(now_card, ensure_ascii=False), ""]
        else:
            out += ["这个项目还没有卡片，这是第一次写。", ""]
        if note.strip():
            out += [f"用户附言：{note.strip()}", ""]
        return "\n".join([*out, "</card>"])

    def guide(self, line_id: str) -> str:
        """What `pt card` prints: the fields, and the card as it is."""
        d = self._read(line_id)
        head = ("用户在「进展」页按了更新，正在等你交卡片。" if d.get("pending")
                else "现在没有人让你更新卡片：只在收到 <card> 消息时更新。")
        card = d.get("card")
        return "\n".join([head, "", "字段：", FIELDS, "", "现在的卡片：" if card else "还没有卡片。",
                          *([json.dumps({k: v for k, v in card.items() if k not in ("at", "by")}, ensure_ascii=False, indent=1)] if card else [])])

    # ---------- the lead writing it ----------

    def write(self, agent_id: str, data: object) -> dict:
        a = self.town.agents.get(agent_id)
        if not a or a["role"] != "lead":
            raise CardError("只有项目负责人写项目卡片")
        lid = a["line_id"]
        card = clean(data)
        with self._lock:
            d = self._read(lid)
            if not d.get("pending"):
                raise CardError("现在没有人让你更新卡片：只在收到 <card> 消息时更新")
            card |= {"at": now(), "by": a.get("model") or "项目负责人"}
            d |= {"prev": d.get("card"), "card": card, "pending": None}
            self._write(lid, d)
        self._publish(lid)
        return card
