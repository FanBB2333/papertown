"""The user's project decisions, the matters awaiting a decision, and the work that cites them."""

from __future__ import annotations

import re
import threading
import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Literal
from xml.sax.saxutils import escape

from .agents import AgentError, ROLES
from .db import now
from .pipeline import MODULES, OUTPUTS, STAGE_MOD

if TYPE_CHECKING:
    from .town import Town

METHOD = {"problem": "问题", "mechanism": "机制", "baselines": "基线", "datasets": "数据集", "metrics": "指标"}
WorkKind = Literal["job", "output", "tell", "task", "prov"]
GROUPS: dict[WorkKind, str] = {"job": "jobs", "output": "outputs", "tell": "tells", "task": "tasks", "prov": "prov"}
MODS = dict(MODULES)
LEANING = re.compile(r"我(?:们|个人)?\s*(?:建议|推荐|倾向|认为\s*应该)|建议\s*(?:你|选)|推荐\s*选|最好\s*选|"
                     r"\b(?:I|we)\s+(?:recommend|suggest)\b|\bI['’]d\s+go\s+with\b", re.I)
SUBJECT = r"(?:论文|原文|文献|作者|报告|研究者|审稿人|手册|文档)(?:在(?:附录|正文|文中))?(?:中|里)?\s*(?:明确)?"
ATTRIBUTION = re.compile(SUBJECT + r"(?:认为|提出)?\s*$")
SPEAKER = r"(?:" + SUBJECT + r"(?:写道|提到|指出|说)|(?:paper|authors?|reviewers?|manual|report)\s+(?:states?|writes?|says?|wrote))"
QUOTED = re.compile(SPEAKER + r"[\s：:,「“‘\"']*$", re.I)
QUOTATION = re.compile(SPEAKER + r"""[\s：:,]*(?:“[^”]*”|「[^」]*」|‘[^’]*’|"[^"]*"|'[^']*')""", re.I)
HUMAN_EVENT = """select e.* from agent_events e join agents a on a.id = e.agent_id
    where a.line_id = ? and e.kind = 'user' and json_extract(e.data, '$.origin') in ('web', 'terminal')"""
AUTHORED = "coalesce(json_extract(e.data, '$.user_text'), json_extract(e.data, '$.text'))"


class DecisionError(Exception):
    def __init__(self, detail: str, status: int = 400):
        self.status = status
        super().__init__(detail)


def flat_basis(value: dict | list | None) -> list[str]:
    if isinstance(value, dict):
        value = [ref for refs in value.values() if isinstance(refs, list) for ref in refs]
    return list(dict.fromkeys(ref for ref in value if isinstance(ref, str))) if isinstance(value, list) else []


def instant(at: str | None) -> datetime:
    try:
        stamp = datetime.fromisoformat(at or "")
        return stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)


def materials_of(values: list[dict] | None) -> list[dict]:
    out = []
    for m in values or []:
        if not all(isinstance(m.get(k), str) and m[k].strip() for k in ("kind", "ref")):
            raise DecisionError("材料须包含种类和引用")
        out.append({"kind": m["kind"], "ref": m["ref"], "title": str(m.get("title") or m["ref"])})
    return out


def check_mod(mod: str) -> str:
    if mod not in MODS:
        raise DecisionError("请选择研究分项")
    return mod


def same_question(left: str, right: str) -> bool:
    def words(s: str) -> str:
        return " ".join(s.strip().rstrip("。？！.?!").split()).casefold()
    return words(left) == words(right)


class Decided:
    def __init__(self, town: Town):
        self.town = town
        self.db = town.db
        self._delivery_lock = threading.Lock()
        self.db.x("insert or ignore into meta(k, v) values ('decided_since', ?)", now("microseconds"))

    def _line(self, line_id: str) -> dict:
        line = self.db.one("select idea, stage, created_at from lines where id = ?", line_id)
        if not line:
            raise DecisionError("没有这个项目", 404)
        return line

    def idea(self, line_id: str) -> dict:
        with self.db.transaction():
            old = self.db.one("select * from decided where line_id = ? order by n limit 1", line_id)
            if old:
                return old
            line = self._line(line_id)
            d = self._insert(line_id, line["idea"] or "", "overview", "idea", at=line["created_at"])
        return d

    def migrate(self) -> None:
        for line in self.db.q("select id from lines where not exists (select 1 from decided where line_id = lines.id)"):
            self.idea(line["id"])

    def _insert(self, lid: str, text: str, mod: str, source: str, *, ref: str | None = None, replaces: str | None = None,
                materials: list | None = None, matter: dict | None = None, at: str | None = None) -> dict:
        """Called in a write transaction, which also consumes the source or retires the previous decision."""
        check_mod(mod)
        old = self._active(lid, replaces) if replaces is not None else None
        n = self.db.val("select coalesce(max(n), 0) + 1 from decided where line_id = ?", lid)
        row = {"id": f"dc_{uuid.uuid4().hex[:10]}", "line_id": lid, "n": n, "mod": mod, "text": text, "source": source,
               "ref": ref, "state": "active", "replaces": old["id"] if old else None, "materials": materials_of(materials),
               "matter": matter, "created_at": at or now(), "ended_at": None}
        if old:
            self.db.update("decided", {"id": old["id"]}, state="replaced", ended_at=row["created_at"])
        self.db.insert("decided", row)
        self.db.after_commit(self.town.bus.publish, "decided", line_id=lid, id=row["id"])
        return row

    def _get(self, lid: str, did: str) -> dict:
        row = self.db.one("select * from decided where line_id = ? and (id = ? or 'D' || n = ?)", lid, did, did)
        if not row:
            raise DecisionError("本项目未找到这条决定", 404)
        return row

    def _active(self, lid: str, did: str) -> dict:
        row = self._get(lid, did)
        if row["state"] != "active":
            raise DecisionError(f"决定 D{row['n']} 已失效", 409)
        return row

    def withdraw(self, lid: str, did: str) -> dict:
        with self.db.transaction():
            row = self._active(lid, did)
            self.db.update("decided", {"id": row["id"]}, state="withdrawn", ended_at=now())
        self.town.bus.publish("decided", line_id=lid, id=row["id"])
        self.town.cards._publish(lid)
        return self.detail(lid, did)

    def current_mod(self, lid: str) -> str:
        return STAGE_MOD.get(self._line(lid)["stage"], "overview")

    def raise_matter(self, agent: dict, question: str, mod: str, facts: list[str], options: list[str], materials: list[dict]) -> dict:
        if not agent.get("line_id"):
            raise DecisionError("待定的事须由项目员工提出")
        check_mod(mod)
        if not question.strip() or not facts or not all(f.strip() for f in [*facts, *options]):
            raise DecisionError("请写下问题和至少一条事实")
        for field in (question, *facts, *options):
            field = QUOTATION.sub(" ", field)
            for m in LEANING.finditer(field):
                before = field[:m.start()]
                if QUOTED.search(before) or (m[0][0] not in "我IiWw" and ATTRIBUTION.search(before)):
                    continue
                raise DecisionError("只写事实和可能的做法，倾向留给用户")
        matter = {"mod": mod, "facts": facts, "options": options, "materials": materials_of(materials)}
        row = self.town.leads._row(agent["id"], agent["line_id"], "ask",
                                   {"question": question.strip(), "choices": [], "act": None, "open": True,
                                    "who": ROLES[agent["role"]]["name"], "matter": matter})
        self.db.after_commit(self.town.cards._publish, agent["line_id"])
        return row

    @staticmethod
    def matter(row: dict) -> dict:
        data = row["data"]
        return {"id": row["id"], "agent": row["agent_id"], "who": data["who"], "question": data["question"],
                **data["matter"], "since": row["ts"]}

    def write(self, lid: str, text: str, mod: str | None = None, *, replaces: str | None = None, matter: int | None = None,
              need: str | None = None, materials: list | None = None) -> dict:
        if not isinstance(text, str) or not text.strip():
            raise DecisionError("请用文字写下决定")
        if matter is not None and need is not None:
            raise DecisionError("每条决定只能回答一件事")
        self._line(lid)
        cards = self.town.cards
        report = None
        with cards._lock, self.db.transaction():
            if need is not None or matter is not None:
                doc = cards._read(lid)
                open_items = set((doc.get("card") or {}).get("need_you") or []) - cards.answered(lid, doc)
            if need is not None:
                if need not in open_items:
                    raise DecisionError("卡片上的这件事已更新，请刷新", 409)
                matter = next((q["id"] for q in self.town.leads.asks(lid)
                               if q["data"].get("matter") and same_question(need, q["data"]["question"])), None)
            if matter is not None:
                report = self.db.one("select * from reports where line_id = ? and id = ? and kind = 'ask'", lid, matter)
                if not report or not report["data"].get("matter"):
                    raise DecisionError("本项目未找到这件待定的事", 404)
                data = report["data"]
                if not data.get("open"):
                    raise DecisionError("这件事已有决定", 409)
                snapshot = {"question": data["question"], **data["matter"]}
                d = self._insert(lid, text, mod or snapshot["mod"], "answer", ref=str(report["id"]), matter=snapshot,
                                 replaces=replaces, materials=[*snapshot["materials"], *(materials or [])])
                report["data"] = data | {"open": False, "answer": text, "answered_at": d["created_at"], "by": "you", "decided": f"D{d['n']}"}
                self.db.update("reports", {"id": report["id"]}, data=report["data"])
            elif need is not None:
                d = self._insert(lid, text, mod or self.current_mod(lid), "answer", ref=need, replaces=replaces, materials=materials)
            else:
                d = self._insert(lid, text, mod, "written", replaces=replaces, materials=materials)
            if report or need is not None:
                recipients = {f"lead-{lid}"}
                if report:
                    recipients.add(report["agent_id"])
                for aid in recipients:
                    self.db.insert("decided_delivery", {"decision_id": d["id"], "agent_id": aid})
                question = report["data"]["question"] if report else need
                for item in open_items:
                    if same_question(item, question):
                        self.db.insert("decided_needs", {"line_id": lid, "item": item, "card_key": (doc.get("need_keys") or {}).get(item, ""),
                                                         "decision_id": d["id"]})
        if report:
            self.town.bus.publish("report", report=report)
        if report or need is not None:
            self.deliver()
        self.town.cards._publish(lid)
        return self.detail(lid, d["id"])

    def deliver(self, agent_id: str | None = None) -> None:
        """A stopped recipient keeps its copy until its own session can receive it."""
        if not self._delivery_lock.acquire(blocking=False):
            return
        try:
            rows = self.db.q("select d.*, p.agent_id from decided_delivery p join decided d on d.id = p.decision_id"
                             + (" where p.agent_id = ?" if agent_id else "") + " order by d.n", *([agent_id] if agent_id else []))
            for d in rows:
                aid = d["agent_id"]
                a = self.town.agents.get(aid)
                if not a or not a.get("runtime") or self.town.agents.shown(a) not in ("idle", "working"):
                    continue
                msg = f'<decision id="D{d["n"]}" mod="{d["mod"]}">{escape(d["text"])}</decision>'
                recorded = self.db.val("""select 1 from agent_events where agent_id = ? and kind = 'user'
                    and json_extract(data, '$.origin') = 'papertown' and json_extract(data, '$.text') = ? limit 1""", aid, msg)
                if not recorded:
                    try:
                        self.town.agents.say(aid, msg, "queue", origin="papertown")
                    except AgentError:
                        continue
                self.db.x("delete from decided_delivery where decision_id = ? and agent_id = ?", d["id"], aid)
        finally:
            self._delivery_lock.release()

    def quote(self, lid: str, mod: str, *, event_id: int | None = None, fragment: str | None = None) -> dict:
        """A bridge call can only point at the authenticated author's stored words."""
        self._line(lid)
        check_mod(mod)
        with self.db.transaction():
            if event_id is not None:
                row = self.db.one(HUMAN_EVENT + " and e.id = ?", lid, event_id)
            elif fragment and fragment.strip():
                row = self.db.one(HUMAN_EVENT + f" and instr({AUTHORED}, ?) > 0 order by e.id desc limit 1", lid, fragment)
            else:
                raise DecisionError("请提供用户原话")
            if row:
                text, ref = row["data"].get("user_text", row["data"]["text"]), str(row["id"])
                if not text.strip():
                    raise DecisionError("请提供用户原话")
            elif event_id is None:
                answer = self.db.one("""select id, data from reports where line_id = ? and kind = 'ask'
                    and json_extract(data, '$.by') = 'you' and instr(json_extract(data, '$.answer'), ?) > 0
                    order by id desc limit 1""", lid, fragment)
                if not answer:
                    raise DecisionError("项目中未找到这段用户原话", 404)
                text, ref = answer["data"]["answer"], f"report:{answer['id']}"
                if answer["data"].get("decided"):
                    return self.detail(lid, answer["data"]["decided"])
            else:
                raise DecisionError("项目中未找到这条用户消息", 404)
            existing = self.db.val("select id from decided where line_id = ? and source = 'chat' and ref = ?", lid, ref)
            if existing:
                return self.detail(lid, existing)
            d = self._insert(lid, text, mod, "chat", ref=ref)
            if row:
                self.db.x("update agent_events set data = json_set(data, '$.decided', ?) where id = ?", f"D{d['n']}", row["id"])
        if row:
            self.town.bus.publish("agent_event", event=self.db.one("select * from agent_events where id = ?", row["id"]))
        self.town.cards._publish(lid)
        return self.detail(lid, d["id"])

    def active(self, lid: str) -> list[dict]:
        return self.db.q("select n, mod, text from decided where line_id = ? and state = 'active' order by n", lid)

    def text(self, lid: str) -> str:
        rows = self.active(lid)
        return "\n".join(f"{name}\n" + "\n".join(f"- D{d['n']} {d['text']}" for d in group)
                         for mod, name in MODULES if (group := [d for d in rows if d["mod"] == mod])) or "暂无有效决定"

    def references(self, lid: str | None, refs: object) -> dict[str, str]:
        if refs is None or refs == []:
            return {}
        if not isinstance(refs, list) or not all(isinstance(r, str) for r in refs):
            raise DecisionError("依据须为编号列表")
        refs = list(dict.fromkeys(refs))
        names = {f"D{r['n']}": r["text"] for r in self.active(lid)}
        if lid and any(r.startswith("#") for r in refs):
            names.update(("#" + t["id"], t["title"]) for t in self.town.canvas.task_nodes(lid) if t["created_by"] == "you")
        bad = [r for r in refs if r not in names]
        if bad:
            raise DecisionError("依据无效：" + "、".join(bad))
        return {ref: names[ref] for ref in refs}

    def basis(self, lid: str | None, refs: object) -> list[str]:
        return list(self.references(lid, refs))

    def output_basis(self, lid: str, stage: str, value: object) -> list | dict:
        if stage != "method":
            return self.basis(lid, value)
        if value is None:
            return {}
        if not isinstance(value, dict) or any(k not in METHOD for k in value):
            raise DecisionError("方法草案须按问题、机制、基线、数据集和指标填写依据")
        for refs in value.values():
            if not isinstance(refs, list) or not all(isinstance(r, str) for r in refs):
                raise DecisionError("依据须为编号列表")
        self.basis(lid, flat_basis(value))
        return {k: list(dict.fromkeys(refs)) for k, refs in value.items()}

    def _work(self, lid: str) -> list[dict]:
        agents = {r["id"]: ROLES.get(r["role"], {}).get("name", r["role"])
                  for r in self.db.q("select id, role from agents where line_id = ?", lid)}
        agents.update({"you": "你", "assistant": "小助手", "papertown": "Papertown"})
        out = []

        def add(kind: WorkKind, id_, title, who, at, basis):
            out.append({"kind": kind, "id": str(id_), "title": title, "who": agents.get(who, who or ""), "at": at, "basis": flat_basis(basis)})

        for r in self.db.q("select id, name, submitted_by, created_at, basis from jobs where line_id = ?", lid):
            add("job", r["id"], r["name"], r["submitted_by"], r["created_at"], r["basis"])
        for r in self.town.linked.jobs(lid):
            add("job", f"nvidb-{r['id']}", r.get("name") or str(r["id"]), r.get("submitter"), r.get("created_at"), [])
        for r in self.db.q("select id, stage, title, agent_id, created_at, json_extract(body, '$.basis') as basis from items where line_id = ?", lid):
            if r["stage"] in OUTPUTS:
                add("output", r["id"], r["title"], r["agent_id"], r["created_at"], r["basis"])
        for r in self.db.q("""select e.* from agent_events e join agents a on a.id = e.agent_id
                where e.kind = 'sent' and (a.line_id = ? or (a.role = 'assistant' and json_extract(e.data, '$.line_id') = ?))""", lid, lid):
            add("tell", r["id"], r["data"]["text"], r["agent_id"], r["ts"], r["data"].get("basis"))
        for t in self.town.canvas.task_nodes(lid):
            add("task", t["id"], t["title"], t["created_by"], t.get("created_at"), t["basis"])
        for r in self.db.q("select id, title, made, created_at from prov where line_id = ?", lid):
            add("prov", r["id"], r["title"], r["made"]["who"], r["created_at"], r["made"]["basis"])
        return sorted(out, key=lambda w: instant(w["at"]), reverse=True)

    def _index(self, lid: str) -> tuple[list[dict], list[dict], dict]:
        self._line(lid)
        rows = self.db.q("select * from decided where line_id = ? order by n desc", lid)
        by_id = {r["id"]: r for r in rows}
        by_ref = {f"D{r['n']}": r for r in rows}
        for r in rows:
            r.pop("line_id")
            r.setdefault("replaced_by", None)
            r["counts"] = dict.fromkeys(GROUPS.values(), 0)
            if r["replaces"]:
                by_id[r["replaces"]]["replaced_by"] = r["id"]
        work = self._work(lid)
        since = instant(self.db.get_meta("decided_since"))
        loose = []
        for w in work:
            for ref in w["basis"]:
                if ref in by_ref:
                    by_ref[ref]["counts"][GROUPS[w["kind"]]] += 1
            if not w["basis"] and instant(w["at"]) >= since:
                loose.append(w)
        stats = {"total": len(rows), "active": sum(r["state"] == "active" for r in rows),
                 "anchored": sum(bool(w["basis"]) for w in work), "loose": len(loose)}
        return rows, loose, stats

    def view(self, lid: str) -> dict:
        rows, loose, stats = self._index(lid)
        return {"decisions": rows, "matters": [self.matter(q) for q in self.town.leads.asks(lid) if q["data"].get("matter")],
                "loose": loose, "stats": stats, "mods": [{"id": k, "name": v} for k, v in MODULES]}

    def card(self, lid: str) -> dict:
        rows, _, stats = self._index(lid)
        latest = {d["mod"]: {k: d[k] for k in ("id", "n", "mod", "text")} for d in reversed(rows) if d["state"] == "active"}
        return {**stats, "latest": [latest[m] for m in MODS if m in latest]}

    def detail(self, lid: str, did: str) -> dict:
        row = self._get(lid, did)
        row.pop("line_id")
        ref = f"D{row['n']}"
        work = {k: [] for k in GROUPS.values()}
        for w in self._work(lid):
            if ref in w["basis"]:
                work[GROUPS[w["kind"]]].append(w)
        return row | {"replaced_by": self.db.val("select id from decided where replaces = ?", row["id"]),
                      "counts": {k: len(v) for k, v in work.items()}, "work": work}
