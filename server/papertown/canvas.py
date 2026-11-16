"""A project's canvas (研究画布), full-window in 进展: a free graph of nodes and the lines between them.

Nodes are the stages of the research loop, hard and soft checks (checks.py), tasks the user gives an agent, and
notes. Nothing fixes where a node sits or what it connects to: the user moves, adds, edits and wires them. A task
node is a job for the lead, the coder or the writer: sending it delivers a <task> message with what the node is
wired to, and the agent closes it with `pt task <id> done|blocked "…"`, which also goes to the user as a report;
the user can send a result back with what is wrong, and the node keeps a log of all of it. A line can carry a
few words of its own.
A soft check comes due once a stage it is wired to has been reached (always, when it is wired to none).

    data/projects/<project>/canvas.json   nodes (id, kind, x, y and what each kind keeps), edges (and their labels),
                                          what was removed
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import TYPE_CHECKING

from .agents import ROLES
from .checks import HARD_IDS, STATUS as CHECK_STATUS, CheckError, clip
from .db import now, read_json, write_json
from .pipeline import INDEX, NAMES

if TYPE_CHECKING:
    from .town import Town

TASK = {"draft": "还没发", "sent": "已经发给它", "done": "完成", "blocked": "卡住了"}
TO = ("lead", "coder", "writer")
STAGE = {"todo": "没开始", "run": "进行中", "wait": "等用户", "done": "完成"}
STEP, DROP, ROW, CHECK_W, STAGE_W = 400, 300, 52, 176, 168  # the first layout: see _first_layout
NODES_MAX, EDGES_MAX, LOG_MAX = 300, 800, 40


def _log(n: dict, kind: str, text: str = "", by: str = "你") -> None:
    """A line in a task's log: made, sent, resent, done, blocked, back (sent back by the user), marked, reopened."""
    n["log"] = [*(n.get("log") or []), {"ts": now(), "kind": kind, "text": clip(text, 600), "by": by}][-LOG_MAX:]


class CanvasError(Exception):
    pass


def _stage_at(key: str) -> tuple[int, int, int]:
    """Where a stage starts, and which way its checks fan out: the loop runs along the top and back along the bottom."""
    i, n = INDEX[key], len(INDEX)
    half = (n + 1) // 2
    return (i * STEP, 0, -1) if i < half else ((n - 1 - i) * STEP, DROP, 1)


def _first_layout(checks: list[tuple[str, str, str]]) -> tuple[list[dict], list[dict]]:
    """Where everything starts: the stages as a loop (out along the top, back along the bottom) and joined in order,
    with the way back from review to writing; each stage's checks fanned out beside it and wired to it. It is only
    a start: nothing holds a node in place or to its lines, and from here it is the user's to rearrange."""
    keys = list(INDEX)
    nodes = [{"id": f"stage:{k}", "kind": "stage", "ref": k, "x": _stage_at(k)[0], "y": _stage_at(k)[1]} for k in keys]
    edges = [(f"stage:{a}", f"stage:{b}") for a, b in zip(keys, keys[1:])] + [("stage:review", "stage:write")]
    loose = [c for c in checks if c[2] not in INDEX]
    for j, (cid, kind, _) in enumerate(loose):
        nodes.append({"id": f"check:{cid}", "kind": kind, "ref": cid, "x": -STEP, "y": 120 + j * ROW})
    for stage in keys:
        mine = [c for c in checks if c[2] == stage]
        x0, y0, side = _stage_at(stage)
        cols = 2 if len(mine) > 3 else 1
        for j, (cid, kind, _) in enumerate(mine):
            x = x0 + STAGE_W / 2 - CHECK_W / 2 + ((j % cols) - (cols - 1) / 2) * (CHECK_W + 12)
            y = y0 + (-96 - (j // cols) * ROW if side < 0 else 116 + (j // cols) * ROW)
            nodes.append({"id": f"check:{cid}", "kind": kind, "ref": cid, "x": round(x), "y": round(y)})
            edges.append((f"stage:{stage}", f"check:{cid}"))
    return nodes, [{"id": f"e{i + 1}", "source": a, "target": b} for i, (a, b) in enumerate(edges)]


class Canvas:
    def __init__(self, town: "Town"):
        self.town = town
        self.s = town.s
        self._lock = threading.RLock()

    def _path(self, line_id: str) -> Path:
        return self.s.projects_dir / line_id / "canvas.json"

    def _save(self, line_id: str, d: dict) -> None:
        p = self._path(line_id)
        p.parent.mkdir(parents=True, exist_ok=True)
        write_json(p, d)

    def _checks(self, line_id: str) -> list[tuple[str, str, str]]:
        cfg = self.town.checks.config(line_id)
        return [(h.id, "hard", h.stage) for h in self.town.checks.hard(line_id, cfg)] + \
               [(s["id"], "soft", s.get("stage") or "") for s in cfg["soft"]]

    def _load(self, line_id: str) -> dict:
        """The canvas as saved, laid out the first time, and kept in step with the project's checks: a new check
        gets a node, a check that is gone loses its."""
        with self._lock:
            d = read_json(self._path(line_id), {})
            checks = self._checks(line_id)
            if not isinstance(d.get("nodes"), list):
                nodes, edges = _first_layout(checks)
                d = {"nodes": nodes, "edges": edges, "gone": [], "next": len(edges) + 1}
                self._save(line_id, d)
                return d
            d.setdefault("edges", [])
            d.setdefault("gone", [])
            d.setdefault("next", 1)
            kinds = {f"check:{cid}": kind for cid, kind, _ in checks}
            have = {n["id"] for n in d["nodes"]}
            keep = [n for n in d["nodes"] if n["kind"] not in ("hard", "soft") or n["id"] in kinds]
            changed = len(keep) != len(d["nodes"])
            d["nodes"] = keep
            for cid, kind, stage in checks:
                nid = f"check:{cid}"
                if nid in have or nid in d["gone"]:
                    continue
                at = next((n for n in d["nodes"] if n["id"] == f"stage:{stage}"), None)
                n = sum(1 for x in d["nodes"] if x["kind"] == kind)
                d["nodes"].append({"id": nid, "kind": kind, "ref": cid, "x": (at["x"] if at else -STEP) + STAGE_W + 24,
                                   "y": (at["y"] if at else 0) + 70 + (n % 6) * 14})
                if at:
                    d["edges"].append({"id": self._id(d, "e"), "source": at["id"], "target": nid})
                changed = True
            ids = {n["id"] for n in d["nodes"]}
            edges = [e for e in d["edges"] if e["source"] in ids and e["target"] in ids]
            if changed or len(edges) != len(d["edges"]):
                d["edges"] = edges
                self._save(line_id, d)
            return d

    @staticmethod
    def _id(d: dict, prefix: str) -> str:
        n = int(d.get("next") or 1)
        d["next"] = n + 1
        return f"{prefix}{n}"

    def _line(self, line_id: str) -> dict:
        ln = self.town.db.one("select id, seq, title from lines where id = ?", line_id)
        if not ln:
            raise CanvasError("没有这个项目")
        return ln

    @staticmethod
    def _node(d: dict, node_id: str) -> dict:
        n = next((x for x in d["nodes"] if x["id"] == node_id), None)
        if not n:
            raise CanvasError("画布上没有这个节点")
        return n

    def _changed(self, line_id: str) -> None:
        self.town.bus.publish("canvas", line_id=line_id)

    # what the checks and the lead need from the wiring

    def stages_of(self, line_id: str, check_id: str) -> set[str]:
        """The stages a check is wired to."""
        d = self._load(line_id)
        nid = f"check:{check_id}"
        near = {e["target"] if e["source"] == nid else e["source"] for e in d["edges"] if nid in (e["source"], e["target"])}
        return {n["ref"] for n in d["nodes"] if n["kind"] == "stage" and n["id"] in near}

    def task_facts(self, line_id: str) -> dict[str, tuple[str, str]]:
        """The tasks on the canvas, for the lead's check-ins: each with its state and what it is."""
        if not self._path(line_id).exists():
            return {}
        out = {}
        for n in self._load(line_id)["nodes"]:
            if n["kind"] == "task" and n.get("status") != "draft":
                what = f"画布上给{ROLES[n['to']]['name']}的任务「{clip(n.get('title'), 40)}」"
                out[f"task:{n['id']}"] = (n["status"], what + (f"（{clip(n['result'], 160)}）" if n.get("result") else ""))
        return out

    # the view

    def view(self, line_id: str) -> dict:
        ln = self._line(line_id)
        cv = self.town.checks.view(line_id)
        d = self._load(line_id)
        stages = {s["key"]: s for s in cv["stages"]}
        checks = {c["id"]: c for c in cv["checks"]}
        nodes = []
        for n in d["nodes"]:
            out = {"id": n["id"], "kind": n["kind"], "x": n["x"], "y": n["y"]}
            if n["kind"] == "stage":
                s = stages.get(n["ref"])
                if not s:
                    continue
                out |= {"ref": n["ref"], "title": s["name"], "status": s["status"], "pct": s["pct"]}
            elif n["kind"] in ("hard", "soft"):
                c = checks.get(n["ref"])
                if not c:
                    continue
                out |= {"kind": c["kind"], "ref": n["ref"], "title": c["title"], "check": c}
            elif n["kind"] == "task":
                out |= {k: n.get(k) for k in ("title", "text", "to", "status", "sent_at", "done_at", "result", "by", "created_at")}
                out["log"] = n.get("log") or []
            else:
                out |= {"text": n.get("text") or ""}
            nodes.append(out)
        ids = {n["id"] for n in nodes}
        tasks = [n for n in nodes if n["kind"] == "task"]
        gone = [{"id": g, "title": NAMES.get(g.split(":", 1)[1]) or next((c["title"] for c in cv["checks"] if f"check:{c['id']}" == g), g)}
                for g in d["gone"]]
        return {"line_id": line_id, "seq": ln["seq"], "title": ln["title"], "nodes": nodes,
                "edges": [e for e in d["edges"] if e["source"] in ids and e["target"] in ids], "gone": gone,
                "summary": cv["summary"], "tasks": {k: sum(1 for t in tasks if t["status"] == k) for k in TASK},
                "trend": cv["trend"], "rounds": cv["rounds"], "ran": cv["ran"], "lead": cv["lead"],
                "agents": {r: {"there": bool(a), "status": a["status"] if a else None}
                           for r in TO for a in [self.town.leads.agent(line_id, r)]}}

    # editing

    def add(self, line_id: str, kind: str, x: float, y: float, title: str = "", text: str = "", to: str = "lead",
            prio: str = "P1", link: str | None = None, send: bool = False) -> dict:
        """A new node where the user put it, wired to the node it was drawn from: a task (sent at once when asked),
        a check of the user's own, or a note."""
        self._line(line_id)
        title, text = clip(title, 60), str(text or "").strip()
        with self._lock:
            d = self._load(line_id)
            if len(d["nodes"]) >= NODES_MAX:
                raise CanvasError("画布上的节点太多了")
            if kind == "task":
                if not title:
                    raise CanvasError("给任务写个名字")
                if to not in TO:
                    raise CanvasError("任务交给 lead（项目负责人）、coder（代码员工）或 writer（写作员工）")
                node = {"id": self._id(d, "t"), "kind": "task", "title": title, "text": text[:4000], "to": to, "status": "draft",
                        "created_at": now(), "sent_at": None, "done_at": None, "result": "", "by": "", "log": []}
                _log(node, "made")
            elif kind == "note":
                if not text:
                    raise CanvasError("备注是空的")
                node = {"id": self._id(d, "n"), "kind": "note", "text": text[:2000]}
            elif kind in ("hard", "soft"):
                try:
                    cid = self.town.checks.create(line_id, kind, "", title, text, prio)
                except CheckError as e:
                    raise CanvasError(str(e)) from e
                d = self._load(line_id)
                node = self._node(d, f"check:{cid}")
                d["nodes"].remove(node)
            else:
                raise CanvasError("节点可以是任务（task）、硬检查（hard）、软检查（soft）或备注（note）")
            node |= {"x": round(float(x)), "y": round(float(y))}
            d["nodes"].append(node)
            if link and any(n["id"] == link for n in d["nodes"]):
                d["edges"].append({"id": self._id(d, "e"), "source": link, "target": node["id"]})
            self._save(line_id, d)
        if kind == "task" and send:
            self.send(line_id, node["id"])
        self._changed(line_id)
        return {**self.view(line_id), "added": node["id"]}

    def set(self, line_id: str, node_id: str, title: str | None = None, text: str | None = None, to: str | None = None,
            status: str | None = None) -> dict:
        """Edit a task or a note. (A check's own settings are the checks' to change.)"""
        with self._lock:
            d = self._load(line_id)
            n = self._node(d, node_id)
            if n["kind"] == "task":
                if title is not None:
                    if not title.strip():
                        raise CanvasError("给任务写个名字")
                    n["title"] = clip(title, 60)
                if text is not None:
                    n["text"] = text.strip()[:4000]
                if to is not None:
                    if to not in TO:
                        raise CanvasError("任务交给 lead、coder 或 writer")
                    if to != n["to"] and n["status"] == "sent":
                        raise CanvasError("这件事已经发出去了；要换人先重新打开它")
                    n["to"] = to
                if status is not None:
                    if status not in ("draft", "done"):
                        raise CanvasError("只能标成完成，或者重新打开")
                    n |= {"status": status, "done_at": now() if status == "done" else None, "by": "你" if status == "done" else "",
                          "result": n.get("result") if status == "done" else ""}
                    _log(n, "marked" if status == "done" else "reopened")
            elif n["kind"] == "note":
                if text is not None:
                    if not text.strip():
                        raise CanvasError("备注是空的")
                    n["text"] = text.strip()[:2000]
            else:
                raise CanvasError("这个节点在它自己的设置里改")
            self._save(line_id, d)
        self._changed(line_id)
        return self.view(line_id)

    def move(self, line_id: str, at: dict[str, list[float]]) -> dict:
        with self._lock:
            d = self._load(line_id)
            for n in d["nodes"]:
                if n["id"] in at and len(at[n["id"]]) == 2:
                    n["x"], n["y"] = round(float(at[n["id"]][0])), round(float(at[n["id"]][1]))
            self._save(line_id, d)
        return {"ok": True}

    def remove(self, line_id: str, node_id: str) -> dict:
        """Take a node off the canvas. A check of the user's own goes with it; a built-in one is turned off."""
        with self._lock:
            d = self._load(line_id)
            n = self._node(d, node_id)
            if n["kind"] in ("hard", "soft"):
                try:
                    if n["ref"] in HARD_IDS:
                        self.town.checks.set(line_id, n["ref"], on=False)
                        d["gone"].append(node_id)
                    else:
                        self.town.checks.remove(line_id, n["ref"])
                except CheckError as e:
                    raise CanvasError(str(e)) from e
            elif n["kind"] == "stage":
                d["gone"].append(node_id)
            d["nodes"] = [x for x in d["nodes"] if x["id"] != node_id]
            d["edges"] = [e for e in d["edges"] if node_id not in (e["source"], e["target"])]
            self._save(line_id, d)
        self._changed(line_id)
        return self.view(line_id)

    def restore(self, line_id: str, node_id: str) -> dict:
        """Put back a stage or a built-in check that was taken off."""
        with self._lock:
            d = self._load(line_id)
            if node_id not in d["gone"]:
                raise CanvasError("这个节点没有被移走")
            d["gone"].remove(node_id)
            kind, ref = node_id.split(":", 1)
            if kind == "stage" and ref in INDEX:
                d["nodes"].append({"id": node_id, "kind": "stage", "ref": ref, "x": _stage_at(ref)[0], "y": _stage_at(ref)[1]})
            self._save(line_id, d)
            if kind == "check":
                self.town.checks.set(line_id, ref, on=True)  # the next load gives it its node back
        self._changed(line_id)
        return self.view(line_id)

    def connect(self, line_id: str, source: str, target: str) -> dict:
        with self._lock:
            d = self._load(line_id)
            self._node(d, source)
            self._node(d, target)
            if source == target:
                raise CanvasError("节点不能连到自己")
            if len(d["edges"]) >= EDGES_MAX:
                raise CanvasError("连线太多了")
            if not any({e["source"], e["target"]} == {source, target} for e in d["edges"]):
                d["edges"].append({"id": self._id(d, "e"), "source": source, "target": target})
                self._save(line_id, d)
        self._changed(line_id)
        return self.view(line_id)

    def label(self, line_id: str, edge_id: str, text: str) -> dict:
        """A few words on a line (none takes them off)."""
        with self._lock:
            d = self._load(line_id)
            e = next((x for x in d["edges"] if x["id"] == edge_id), None)
            if not e:
                raise CanvasError("画布上没有这条线")
            text = clip(text, 40)
            if text:
                e["label"] = text
            else:
                e.pop("label", None)
            self._save(line_id, d)
        self._changed(line_id)
        return self.view(line_id)

    def disconnect(self, line_id: str, edge_id: str) -> dict:
        with self._lock:
            d = self._load(line_id)
            d["edges"] = [e for e in d["edges"] if e["id"] != edge_id]
            self._save(line_id, d)
        self._changed(line_id)
        return self.view(line_id)

    def tidy(self, line_id: str) -> dict:
        """Lay the stages and checks out as at first; tasks, notes and the lines the user drew stay."""
        with self._lock:
            d = self._load(line_id)
            nodes, edges = _first_layout(self._checks(line_id))
            at = {n["id"]: n for n in nodes if n["id"] not in d["gone"]}
            for n in d["nodes"]:
                if n["id"] in at:
                    n["x"], n["y"] = at[n["id"]]["x"], at[n["id"]]["y"]
            ids = {n["id"] for n in d["nodes"]}
            have = {frozenset((e["source"], e["target"])) for e in d["edges"]}
            for e in edges:
                if e["source"] in ids and e["target"] in ids and frozenset((e["source"], e["target"])) not in have:
                    d["edges"].append({"id": self._id(d, "e"), "source": e["source"], "target": e["target"]})
            self._save(line_id, d)
        self._changed(line_id)
        return self.view(line_id)

    # tasks: to an agent, and back

    def _around(self, line_id: str, d: dict, node: dict) -> list[str]:
        """What a task is wired to, in words, for the agent that gets it."""
        cv = self.town.checks.view(line_id)
        stages = {s["key"]: s for s in cv["stages"]}
        checks = {c["id"]: c for c in cv["checks"]}
        near = {(e["target"] if e["source"] == node["id"] else e["source"]): e.get("label") for e in d["edges"] if node["id"] in (e["source"], e["target"])}
        out = []
        for n in d["nodes"]:
            if n["id"] not in near:
                continue
            what = ""
            if n["kind"] == "stage" and n["ref"] in stages:
                s = stages[n["ref"]]
                what = f"工序「{s['name']}」（{STAGE.get(s['status'], s['status'])}）"
            elif n["kind"] in ("hard", "soft") and n["ref"] in checks:
                c = checks[n["ref"]]
                last = c["last"] or {}
                st = CHECK_STATUS.get(last.get("status") or ("wait" if c["kind"] == "soft" else "none"))
                val = "" if last.get("value") is None else f"，{int(last['value'])} {c.get('unit') or '处'}"
                what = f"{'硬' if c['kind'] == 'hard' else '软'}检查 {c['id']}「{c['title']}」（现在{st}{val}）：{c['text']}"
            elif n["kind"] == "task":
                what = f"任务 {n['id']}「{n['title']}」（给{ROLES[n['to']]['name']}，{TASK[n['status']]}）"
            elif n["kind"] == "note":
                what = f"备注：{clip(n.get('text'), 300)}"
            if what:
                out.append(what + (f"［线上写着：{near[n['id']]}］" if near[n["id"]] else ""))
        return out

    def send(self, line_id: str, node_id: str) -> dict:
        """Deliver a task to its agent; sending it again tells the agent it has changed."""
        with self._lock:
            d = self._load(line_id)
            n = self._node(d, node_id)
            if n["kind"] != "task":
                raise CanvasError("只有任务能发给 agent")
            a = self.town.leads.agent(line_id, n["to"])
            if not a:
                raise CanvasError(f"这个项目的{ROLES[n['to']]['name']}还没有启动：先在「员工」面板里启动它，任务会留在画布上")
            again = n["status"] != "draft"
            around = self._around(line_id, d, n)
            body = [f'<task id="{n["id"]}">',
                    ("用户改了画布上这件事，按新的来：" if again else "用户在研究画布上给你派了一件事：") + f"「{n['title']}」"]
            if n.get("text"):
                body += ["", n["text"]]
            if around:
                body += ["", "它在画布上连着这些（连着检查的，做完要让那项检查通过）：", *[f"- {x}" for x in around]]
            body += ["", f"做完后运行 `.papertown/pt task {n['id']} done \"结果，一两句\"`；做不了或卡住了运行 "
                         f"`.papertown/pt task {n['id']} blocked \"原因\"`。没有 pt 就在回复里说清楚。", "</task>"]
            self.town.agents.say(a["id"], "\n".join(body), "queue", origin="papertown")
            n |= {"status": "sent", "sent_at": now(), "done_at": None, "result": "", "by": ""}
            _log(n, "resent" if again else "sent", by=f"给{ROLES[n['to']]['name']}")
            self._save(line_id, d)
        self._changed(line_id)
        return self.view(line_id)

    def back(self, line_id: str, node_id: str, text: str) -> dict:
        """Send a task back: the agent hears what is wrong with what it returned, and the task is under way again."""
        text = str(text or "").strip()
        if not text:
            raise CanvasError("写上哪里不行、要怎么改")
        with self._lock:
            d = self._load(line_id)
            n = self._node(d, node_id)
            if n["kind"] != "task" or n["status"] not in ("done", "blocked"):
                raise CanvasError("只有交回了结果的任务能退回")
            a = self.town.leads.agent(line_id, n["to"])
            if not a:
                raise CanvasError(f"这个项目的{ROLES[n['to']]['name']}还没有启动")
            body = [f'<task id="{n["id"]}">', f"用户看了你对画布上「{n['title']}」这件事交回的结果，退回来了：", "", text[:4000]]
            if n.get("result"):
                body += ["", f"你上次回的是：{clip(n['result'], 600)}"]
            body += ["", f"按用户说的接着做，做完再运行 `.papertown/pt task {n['id']} done \"结果\"`，卡住了运行 "
                         f"`.papertown/pt task {n['id']} blocked \"原因\"`。", "</task>"]
            self.town.agents.say(a["id"], "\n".join(body), "queue", origin="papertown")
            n |= {"status": "sent", "sent_at": now(), "done_at": None, "by": ""}
            _log(n, "back", text)
            self._save(line_id, d)
        self._changed(line_id)
        return self.view(line_id)

    def close(self, agent_id: str, task_id: str, status: str, text: str) -> dict:
        """`pt task <id> done|blocked "…"`: the agent's word on a task, which also goes to the user as a report."""
        a = self.town.agents.get(agent_id)
        if not a or not a.get("line_id"):
            raise CanvasError("只有项目里的 agent 能回任务")
        if status not in ("done", "blocked"):
            raise CanvasError("写 done（做完了）或 blocked（卡住了）")
        text = str(text or "").strip()
        if not text:
            raise CanvasError("写上结果或原因")
        lid = a["line_id"]
        with self._lock:
            d = self._load(lid)
            n = next((x for x in d["nodes"] if x["id"] == task_id and x["kind"] == "task"), None)
            if not n:
                raise CanvasError(f"画布上没有任务 {task_id}（`pt tasks` 看有哪些）")
            if a["role"] != "lead" and n["to"] != a["role"]:
                raise CanvasError(f"这件事是给{ROLES[n['to']]['name']}的")
            n |= {"status": status, "done_at": now(), "result": text[:4000], "by": self.town.leads._who(a)}
            _log(n, status, text, by=n["by"])
            self._save(lid, d)
        self.town.leads.report(agent_id, f"画布上的任务「{n['title']}」{TASK[status]}：{text}", key=status == "blocked")
        self._changed(lid)
        return {"text": f"记下了：「{n['title']}」{TASK[status]}。用户在画布和汇报里会看到。"}

    def tasks_text(self, agent_id: str) -> str:
        """`pt tasks`: what the user has put on the canvas for this agent (a lead sees every task)."""
        a = self.town.agents.get(agent_id)
        if not a or not a.get("line_id"):
            raise CanvasError("只有项目里的 agent 有画布上的任务")
        d = self._load(a["line_id"])
        mine = [n for n in d["nodes"] if n["kind"] == "task" and n["status"] != "draft" and (a["role"] == "lead" or n["to"] == a["role"])]
        if not mine:
            return "画布上没有给你的任务。"
        out = []
        for n in mine:
            out.append(f"- {n['id']}「{n['title']}」（给{ROLES[n['to']]['name']}，{TASK[n['status']]}）" + (f"：{clip(n.get('text'), 400)}" if n.get("text") else ""))
            out += [f"    连着：{x}" for x in self._around(a["line_id"], d, n)]
            if n.get("result"):
                out.append(f"    结果：{clip(n['result'], 300)}")
        return "\n".join(["画布上的任务（做完用 `pt task <编号> done \"结果\"`，卡住用 blocked）：", *out])
