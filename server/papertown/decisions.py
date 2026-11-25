"""What waits on you in one project, each with the choices that settle it, for the 进展 page's 待你决定:

- ask: a question one of its agents asked with `pt ask`, and its choices
- permission: a native permission request of an agent in Paseo (Codex, Claude Code), allowed or denied
- prompt: a dialog on a hosted agent's terminal (Codex, Claude Code), answered with the keys that pick an option
- matter and need: a research question or card entry that takes a written decision

One click answers by the same path the agent asked by, so its own session carries on as if you had answered there.
"""

from __future__ import annotations

import threading
import time
from typing import TYPE_CHECKING

from .agents import AgentError
from .decided import DecisionError, same_question
from .leads import NAMES
from .prompts import PromptError

if TYPE_CHECKING:
    from .town import Town

KINDS = ("prompt", "permission", "ask", "matter", "need")
SETTLE = 30  # seconds an answered request stays hidden while the agent's state catches up


class Decisions:
    def live_lead(self, line_id: str) -> dict | None:
        """The lead, while it runs: a message would start a stopped one, which is the lead switch's to do."""
        lead = self.town.leads.agent(line_id, "lead")
        return lead if lead and self.town.agents.shown(lead) in ("idle", "working", "starting") else None

    def __init__(self, town: "Town"):
        self.town = town
        self.db = town.db
        self._settled: dict[str, float] = {}
        self._lock = threading.Lock()

    def _key(self, kind: str, agent: str | None, id_: str) -> str:
        return f"{kind}:{agent or ''}:{id_}"

    def _fresh(self, key: str) -> bool:
        with self._lock:
            at = self._settled.get(key)
            if at and time.time() - at < SETTLE:
                return False
            self._settled.pop(key, None)
            return True

    def _settle(self, key: str) -> None:
        with self._lock:
            self._settled[key] = time.time()

    def gather(self, line_id: str, card: dict | None, done: set[str]) -> list[dict]:
        out: list[dict] = []
        rows = self.db.q("select id from agents where line_id = ? order by role = 'lead' desc, rowid", line_id)
        for r in rows:
            a = self.town.agents.get(r["id"])
            if not a or not a.get("runtime"):
                continue
            try:
                w = self.town.agents.watch_of(a)
            except Exception:  # noqa: BLE001 - one agent that cannot be read leaves the others
                continue
            who = NAMES.get(a["role"], a["role"]) + (f"（节点 {a['node_id']}）" if a.get("node_id") else "")
            for p in w.get("permissions") or []:
                if not self._fresh(self._key("permission", a["id"], p["id"])):
                    continue
                title = p.get("title") or p.get("name") or "权限请求"
                if p.get("kind") == "question":  # its question has answers of its own, in the conversation
                    out.append({"kind": "permission", "id": p["id"], "agent": a["id"], "who": who, "title": title,
                                "detail": p.get("arg") or "", "options": [], "free": False, "since": w.get("since")})
                    continue
                out.append({"kind": "permission", "id": p["id"], "agent": a["id"], "who": who, "title": title,
                            "detail": p.get("arg") or "", "since": w.get("since"), "free": False,
                            "options": [{"label": "允许", "value": True, "main": True}, {"label": "拒绝", "value": False}]})
            pr = w.get("prompt")
            if pr and pr.get("options") and self._fresh(self._key("prompt", a["id"], pr["digest"])):
                out.append({"kind": "prompt", "id": pr["digest"], "agent": a["id"], "who": who, "title": pr.get("title") or "终端里的对话框",
                            "detail": "\n".join(line for line in pr.get("body") or [] if line.strip() and line != pr.get("title"))[:600],
                            "since": w.get("since"), "free": False,
                            "options": [{"label": o["label"], "value": o["index"], "main": bool(o.get("current"))} for o in pr["options"]]})
        asks = self.town.leads.asks(line_id)
        for q in asks:
            if not self._fresh(self._key("ask", None, str(q["id"]))):
                continue
            d = q["data"]
            if m := d.get("matter"):
                out.append({"kind": "matter", "id": str(q["id"]), "agent": q["agent_id"], "who": d.get("who") or "",
                            "title": d["question"], "detail": "", "since": q["ts"], "free": True, "write": True,
                            "mod": m["mod"], "facts": m["facts"], "options_text": m["options"], "materials": m["materials"], "options": []})
                continue
            choices = d.get("choices") or []
            if not choices and d.get("act"):
                choices = ["可以", "不可以"]
            out.append({"kind": "ask", "id": str(q["id"]), "agent": q["agent_id"], "who": d.get("who") or "", "title": d["question"],
                        "detail": "", "since": q["ts"], "free": True, "act": d.get("act"),
                        "options": [{"label": c, "value": c, "main": i == 0 and bool(d.get("act"))} for i, c in enumerate(choices)]})
        lead = self.town.leads.agent(line_id, "lead")
        live = self.live_lead(line_id)
        for item in (card or {}).get("need_you") or []:
            if item in done or any(q["data"].get("matter") and same_question(item, q["data"]["question"]) for q in asks):
                continue
            out.append({"kind": "need", "id": item, "agent": lead["id"] if lead else None, "who": "负责人", "title": item, "detail": "",
                        "since": (card or {}).get("at"), "free": True, "later": not live, "mod": self.town.decided.current_mod(line_id),
                        "options": [], "write": True})
        for x in out:
            x.setdefault("ready", True)
        return sorted(out, key=lambda x: {"matter": 0, "need": 1}.get(x["kind"], 2))

    def decide(self, line_id: str, kind: str, id_: str, agent: str | None, value: object, text: str | None, mod: str | None = None) -> dict | None:
        """Answer one of `gather`'s decisions with an option's value, or your own words where it takes them."""
        if kind not in KINDS:
            raise DecisionError("不认识这种决定")
        if kind == "need":
            return self.town.decided.write(line_id, text or "", mod, need=id_)
        if kind in ("permission", "prompt"):
            a = self.town.agents.get(agent or "")
            if not a or a.get("line_id") != line_id:
                raise DecisionError("这个员工不在这个项目里", 404)
        try:
            if kind in ("ask", "matter"):
                q = self.db.one("select * from reports where id = ? and kind = 'ask'", int(id_) if str(id_).isdigit() else -1)
                if not q or q["line_id"] != line_id:
                    raise DecisionError("没有这个问题", 404)
                if kind == "matter" or q["data"].get("matter"):
                    return self.town.decided.write(line_id, text or "", mod, matter=q["id"])
                words = (text or "").strip()
                if not words and not isinstance(value, str):
                    raise DecisionError("选一个选项，或者写几句")
                self.town.leads.answer(q["id"], words or value)
            elif kind == "permission":
                if not isinstance(value, bool):
                    raise DecisionError("权限请求只能允许或拒绝")
                self.town.agents.permit(agent, id_, value)
            elif kind == "prompt":
                if isinstance(value, bool) or not isinstance(value, int):
                    raise DecisionError("选一个选项")
                self.town.agents.hosted.prompt(agent, id_, value)
        except (AgentError, PromptError) as e:
            raise DecisionError(getattr(e, "detail", None) or str(e), getattr(e, "status", 400)) from e
        except DecisionError:
            raise
        except Exception as e:  # LeadError and the like carry the reason to show
            raise DecisionError(str(e)) from e
        self._settle(self._key(kind, agent if kind in ("permission", "prompt") else None, str(id_)))
