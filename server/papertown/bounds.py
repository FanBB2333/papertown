"""Work boundaries: what an agent must get done, must never do, and must ask you about first, set at the
global (assistant), project (lead) and worker levels and passed down as each rule's inheritance says.
Stored in data/bounds.json and data/projects/<project>/bounds.json (its workers' under "workers").
"""

from __future__ import annotations

import secrets
import threading
from pathlib import Path
from typing import TYPE_CHECKING

from .db import read_json, write_json

if TYPE_CHECKING:
    from .town import Town

KINDS = {"must": "必须完成", "never": "不能做", "ask": "需要询问"}
INHERIT = {"yes": "继承", "no": "不继承", "force": "必须继承"}
LEVELS = {"global": "全局", "project": "项目", "worker": "员工"}
WORKERS = ("coder", "writer")
# actions a never or ask rule can name; Papertown then refuses them or holds them for you
ACTIONS = {
    "tell": "给别的 agent 发消息、派活",
    "answer": "替用户回答项目里的问题",
    "job.submit": "提交实验任务",
    "job.cancel": "取消实验任务",
    "line.hatch": "让项目立项",
    "line.resume": "让项目接着往下做",
    "line.adjust": "调整项目的方向",
    "idea.submit": "放入新 idea",
    "agent.brief": "给员工重发项目简报",
    "agent.abort": "打断员工手上的事",
    "paper.compile": "编译论文",
    "skill.toggle": "开关 skill",
    "mcp.toggle": "启用或停用 MCP server",
    "mcp.restart": "重连 MCP server",
}
TEXT_MAX = 300
RULES_MAX = 60


class BoundsError(Exception):
    pass


def _clean(rules: object, level: str, known: set[str]) -> list[dict]:
    """A level's rules as they are written down: checked, each with an id."""
    if not isinstance(rules, list):
        raise BoundsError("rules 要是一个列表")
    if len(rules) > RULES_MAX:
        raise BoundsError(f"一层最多 {RULES_MAX} 条")
    out = []
    for r in rules:
        if not isinstance(r, dict):
            raise BoundsError("每一条要写成 {kind, text, inherit}")
        text = " ".join(str(r.get("text") or "").split())
        if not text:
            continue
        if len(text) > TEXT_MAX:
            raise BoundsError(f"一条最多 {TEXT_MAX} 个字：{text[:20]}…")
        kind = r.get("kind")
        if kind not in KINDS:
            raise BoundsError(f"kind 要写 {'、'.join(KINDS)}，不是 {kind}")
        inherit = "no" if level == "worker" else r.get("inherit") or "yes"
        if inherit not in INHERIT:
            raise BoundsError(f"inherit 要写 {'、'.join(INHERIT)}，不是 {inherit}")
        action = r.get("action") or None
        if action and action not in ACTIONS:
            raise BoundsError(f"没有这个动作：{action}")
        if action and kind == "must":
            raise BoundsError("「必须完成」的条目不能绑定动作，只有「不能做」和「需要询问」可以")
        rid = str(r.get("id") or "")
        if not rid.startswith("b_") or rid in known:  # ids are unique across the levels: a lower one switches off by id
            rid = f"b_{secrets.token_hex(4)}"
        known.add(rid)
        out.append({"id": rid, "kind": kind, "text": text, "inherit": inherit, "action": action})
    return out


def _norm(rules: object, level: str) -> list[dict]:
    """A level's rules as read back, keeping what is whole even if the file was edited by hand."""
    out = []
    for r in rules if isinstance(rules, list) else []:
        if isinstance(r, dict) and r.get("kind") in KINDS and r.get("text") and r.get("id"):
            inherit = "no" if level == "worker" else r.get("inherit") if r.get("inherit") in INHERIT else "yes"
            out.append({"id": str(r["id"]), "kind": r["kind"], "text": str(r["text"]), "inherit": inherit,
                        "action": r.get("action") if r.get("action") in ACTIONS and r["kind"] != "must" else None})
    return out


class Bounds:
    def __init__(self, town: "Town"):
        self.town = town
        self.s = town.s
        self._lock = threading.Lock()

    def _global_path(self) -> Path:
        return self.s.data_dir / "bounds.json"

    def _project_path(self, line_id: str) -> Path:
        return self.s.projects_dir / line_id / "bounds.json"

    @staticmethod
    def _read(p: Path) -> dict:
        return read_json(p, {})

    def _write(self, p: Path, d: dict) -> None:
        p.parent.mkdir(parents=True, exist_ok=True)
        write_json(p, d)

    def levels(self, line_id: str | None = None) -> dict:
        """What is written at each level: the global rules and, for a project, its own and each worker's with what they switched off."""
        g = self._read(self._global_path())
        out = {"global": {"rules": _norm(g.get("rules"), "global")}}
        if line_id:
            p = self._read(self._project_path(line_id))
            ws = p.get("workers") if isinstance(p.get("workers"), dict) else {}
            off = lambda d: [str(x) for x in d.get("off") or [] if x] if isinstance(d, dict) else []  # noqa: E731
            out["project"] = {"rules": _norm(p.get("rules"), "project"), "off": off(p)}
            out["workers"] = {w: {"rules": _norm((ws.get(w) or {}).get("rules"), "worker"), "off": off(ws.get(w) or {})} for w in WORKERS}
        return out

    def effective(self, role: str, line_id: str | None = None) -> list[dict]:
        """The rules an agent of this role keeps, each with the level it comes from and whether it is locked."""
        lv = self.levels(line_id if role != "assistant" else None)
        top = [r | {"from": "global", "locked": False} for r in lv["global"]["rules"]]
        if role == "assistant":
            return top
        if role not in ("lead", *WORKERS) or not line_id:
            return []
        proj = lv["project"]
        down = [r | {"locked": r["inherit"] == "force"} for r in top if r["inherit"] == "force" or r["inherit"] == "yes" and r["id"] not in proj["off"]]
        mine = [r | {"from": "project", "locked": False} for r in proj["rules"]]
        if role == "lead":
            return down + mine
        w = lv["workers"][role]
        down = [r for r in down if r["locked"] or r["id"] not in w["off"]]
        down += [r | {"locked": r["inherit"] == "force"} for r in mine if r["inherit"] == "force" or r["inherit"] == "yes" and r["id"] not in w["off"]]
        return down + [r | {"from": "worker", "locked": False} for r in w["rules"]]

    def policy(self, role: str, line_id: str | None, action: str, default: str = "auto") -> tuple[str, dict | None]:
        """Whether an agent may take an action Papertown carries out: "never", "ask" or `default`, with the rule that decided."""
        bound = [r for r in self.effective(role, line_id) if r["action"] == action]
        for kind in ("never", "ask"):
            hit = next((r for r in bound if r["kind"] == kind), None)
            if hit:
                return kind, hit
        return default, None

    def text(self, role: str, line_id: str | None = None, pt: str | None = ".papertown/pt") -> str:
        """The rules as the agent reads them, grouped by kind; `pt` is its tool, None for pi."""
        rules = self.effective(role, line_id)
        if not rules:
            return "用户还没有给你设工作边界。"
        out = []
        for kind, name in KINDS.items():
            rows = [r for r in rules if r["kind"] == kind]
            if not rows:
                continue
            out += ["", f"{name}："]
            for r in rows:
                tail = [LEVELS[r["from"]]]
                if r["action"]:
                    tail.append(f"Papertown 会{'拦下' if kind == 'never' else '先问用户'}「{ACTIONS[r['action']]}」")
                out.append(f"- {r['text']}（{'，'.join(tail)}）")
        if any(r["kind"] == "ask" for r in rules):
            how = f"用 `{pt} ask \"问题\" [--choice 选项]…` 问" if pt else "在对话里问用户"
            out += ["", f"「需要询问」的事，动手前先{how}，等到回答再做。"]
        return "\n".join(out).strip()

    def section(self, role: str, line_id: str | None = None, pt: str | None = ".papertown/pt") -> str:
        """The part of an agent's AGENTS.md about its rules."""
        again = f"，随时可以用 `{pt} rules` 再看一遍" if pt else ""
        return ("\n## 工作边界\n\n用户在 Papertown 里分全局、项目、员工三层设定，下面是对你有效的。它们比这份说明里的其他要求优先；"
                f"改了会发消息告诉你{again}。\n\n" + self.text(role, line_id, pt) + "\n")

    def save(self, line_id: str | None, role: str | None, rules: object, off: object = None) -> dict:
        """Write one level: the global one, a project's (line_id) or one of its workers' (line_id and role);
        the agents whose rules changed hear about it."""
        if role and role not in WORKERS:
            raise BoundsError(f"员工这一层只有 {'、'.join(WORKERS)}")
        if role and not line_id or line_id and not self.town.db.one("select 1 from lines where id = ?", line_id):
            raise BoundsError("没有这个项目")
        level = "worker" if role else "project" if line_id else "global"
        off = [str(x) for x in (off or []) if x] if level != "global" else []
        with self._lock:
            before = self._snapshot(line_id)
            lv = self.levels(line_id)
            every = [lv["global"], *([lv["project"], *lv["workers"].values()] if line_id else [])]
            mine = lv["global"] if level == "global" else lv["project"] if level == "project" else lv["workers"][role]
            known = {r["id"] for x in every for r in x["rules"]} - {r["id"] for r in mine["rules"]}
            clean = _clean(rules, level, known)
            above = self._above(lv, level)
            off = [x for x in dict.fromkeys(off) if x in above]
            if level == "global":
                self._write(self._global_path(), {"rules": clean})
            else:
                p = self._read(self._project_path(line_id))
                if level == "project":
                    p |= {"rules": clean, "off": off}
                else:
                    p.setdefault("workers", {})[role] = {"rules": clean, "off": off}
                self._write(self._project_path(line_id), p)
            after = self._snapshot(line_id)
        self._tell(before, after)
        return self.view(line_id)

    @staticmethod
    def _above(lv: dict, level: str) -> set[str]:
        """The rules a level may switch off: inherited ones marked 继承."""
        up = [r for r in lv["global"]["rules"] if r["inherit"] == "yes"]
        if level == "worker":
            up = [r for r in up if r["id"] not in lv["project"]["off"]] + [r for r in lv["project"]["rules"] if r["inherit"] == "yes"]
        return {r["id"] for r in up}

    def _snapshot(self, line_id: str | None) -> dict[str, list[dict]]:
        """Every started agent the change can reach, with its rules now."""
        rows = self.town.db.q("select id, role, line_id from agents where runtime is not null and role in ('assistant', 'lead', 'coder', 'writer')"
                              + (" and (line_id = ? or role = 'assistant')" if line_id else ""), *([line_id] if line_id else []))
        return {a["id"]: self.effective(a["role"], a["line_id"]) for a in rows}

    def _tell(self, before: dict, after: dict) -> None:
        for aid, rules in after.items():
            if before.get(aid) == rules:
                continue
            self.town.agents.renew(aid)
            a = self.town.agents.get(aid)
            if a.get("runtime") == "pi" and not self.town.agents.alive(a):
                continue  # a stopped pi reads them in AGENTS.md when it starts; saying something would start it
            pt = str(self.town.agents.pt(a)) if a.get("runtime") == "paseo" else None
            msg = "<bounds>\n用户改了你的工作边界，从现在起按这一份做（AGENTS.md 里也更新了）：\n\n" + self.text(a["role"], a["line_id"], pt) + "\n</bounds>"
            try:
                self.town.agents.say(aid, msg, "queue")
            except Exception:  # noqa: BLE001 - it hears about it from AGENTS.md when it starts again
                pass

    def view(self, line_id: str | None = None) -> dict:
        """Everything the editor shows: each level as written, and what holds for each agent."""
        lv = self.levels(line_id)
        roles = ["assistant", *(["lead", *WORKERS] if line_id else [])]
        return {"levels": lv, "effective": {r: self.effective(r, line_id) for r in roles},
                "kinds": KINDS, "inherit": INHERIT, "actions": ACTIONS}
