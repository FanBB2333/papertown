"""Each project's card on the 进展 page: where it stands, in fields its lead fills in when you
ask. Nothing fills it on its own: you press 更新 (on one card, or on all of them), Papertown
sends the lead a <card> message with the fields and the card as it is, the lead reads the
project (pt status, pt worker, pt jobs) and writes the card back with `pt card set`. A card
nobody asked for is refused. Beside it the page shows what Papertown knows itself (the
stages, the jobs, the questions waiting for you) as it is now.

    data/projects/<project>/card.json    the card, the one before it, and the request in flight
"""

from __future__ import annotations

import json
import threading
from collections import Counter
from typing import TYPE_CHECKING

from .agents import AgentError
from .db import now

if TYPE_CHECKING:
    from .town import Town

HEALTH = {"ok": "顺利", "risk": "有风险", "blocked": "卡住了"}
LISTS = {"done": "最近完成的", "next": "接下来要做的", "blockers": "卡点和风险", "need_you": "要用户决定或去做的"}
LIST_MAX = 6
SUMMARY_MAX, ITEM_MAX = 200, 160

FIELDS = f"""- summary：一两句话，项目现在的样子（必填，{SUMMARY_MAX} 字以内）
- health：ok（顺利）、risk（有风险）或 blocked（卡住了）
- progress：0–100 的整数，你估计整个项目完成了多少；说不准就不写
- milestone：下一个里程碑，一句话
- done：最近完成的事
- next：接下来要做的
- blockers：卡点和风险
- need_you：要用户决定或去做的
- metrics：关键数字，每个写成 {{"name": "…", "value": "…", "note": "…"}}（note 可以不写）
done、next、blockers、need_you、metrics 各最多 {LIST_MAX} 条，每条一句话（{ITEM_MAX} 字以内），没有就写空列表。"""

EXAMPLE = {"summary": "主实验在 4 张卡上跑到第 3 轮，消融还没开始。", "health": "ok", "progress": 45,
           "milestone": "周五前拿到主表的三组结果", "done": ["baseline 复现，和论文差 0.3 以内"], "next": ["跑完主实验", "写方法一节"],
           "blockers": [], "need_you": ["要不要加第四个数据集"], "metrics": [{"name": "主指标", "value": "71.2", "note": "baseline 68.9"}]}


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
    unknown = [k for k in d if k not in ("summary", "health", "progress", "milestone", "metrics", *LISTS)]
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
    return out


class Cards:
    def __init__(self, town: "Town"):
        self.town = town
        self.db = town.db
        self.s = town.s
        self._lock = threading.Lock()

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
        jobs = Counter(j.get("status") for j in self.town.leads._jobs(lid))  # the farm's and, for a linked project, nvidb's
        a = self.town.agents.get(f"lead-{lid}")
        return {
            "line": {"id": lid, "seq": line["seq"], "title": line["title"], "status": line["status"], "linked": bool(line.get("linked")),
                     "stages": [{"key": s["key"], "name": s["name"], "status": s["status"]} for s in stages],
                     "stage": cur and {"name": cur["name"], "status": cur["status"], "pct": cur.get("pct", 0)}, "updated_at": line.get("updated_at")},
            "lead": self.town.agents.public(a) if a else None,
            "card": d.get("card"), "prev": (d.get("prev") or {}).get("progress"), "pending": d.get("pending"),
            "jobs": dict(jobs),
            "asks": len(self.town.leads.asks(lid)),
        }

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
