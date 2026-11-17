"""A project's research loop (研究回路), full-window in 进展: a free graph of the loop's nodes and the lines between them.

The loop has three lanes, which are where things start and where 「按回路规整」 puts them back; nothing holds a node
in its lane. Along the top, the soft layer: the soft spec (what the agents are told: the work boundaries' musts and
the rules no code enforces), the hard clamp (the boundaries bound to actions Papertown stops or asks you about), and
the soft sentinels (soft checks, checks.py: questions the lead judges, each watching a stage). In the middle the
spine: the stages in order, and after a stage its hard gate, the stage's hard checks as one node (it opens into a
node per check). A gate whose blocking check fails locks the stage after it and sends a rework ticket back to the
stage's agent, round after round up to the stage's limit; past it the gate comes to the human gate. Along the bottom
the loop back: rework tickets, the corrections sent from a sentinel, the tasks and notes the user adds, and the human
gate, where what needs your decision collects (escalated gates, stuck tasks, sentinels judged off course, questions).

A task node is a job for the lead, the coder or the writer: sending it delivers a <task> message with what the node
is wired to, and the agent closes it with `pt task <id> done|blocked "…"`, which also goes to the user as a report;
the user can send a result back with what is wrong, and the node keeps a log of all of it. A line has a kind (the
flow, a sentinel watching, the spec and the clamp, the loops back) or none (one the user drew), and can carry a few
words. Info cards (the progress card, the agents, jobs, code, paper, outputs) are off the canvas until put on.

    data/projects/<project>/canvas.json   nodes (id, kind, x, y and what each kind keeps), edges (kind, label),
                                          what was taken off
"""

from __future__ import annotations

import html
import threading
from pathlib import Path
from typing import TYPE_CHECKING

from .agents import ROLES
from .checks import BAD, GATE, HARD_IDS, STATUS as CHECK_STATUS, CheckError, clip
from .db import now, read_json, write_json
from .pipeline import INDEX, NAMES

if TYPE_CHECKING:
    from .town import Town

TASK = {"draft": "还没发", "sent": "已经发给它", "done": "完成", "blocked": "卡住了"}
TO = ("lead", "coder", "writer")
STAGE = {"todo": "没开始", "run": "进行中", "wait": "等用户", "done": "完成"}
NODES_MAX, EDGES_MAX, LOG_MAX, TRAIL_MAX = 300, 800, 40, 12
KIND = {"stage": "工序", "gate": "硬卡口", "hard": "硬检查", "soft": "软巡检", "spec": "软限制", "clamp": "硬边界",
        "human": "人类拍板", "task": "任务", "note": "备注", "info": "资料卡"}
EDGES = {"flow": "主推进", "watch": "巡检", "spec": "软限制注入", "clamp": "动作钳制", "hard_loop": "硬打回",
         "soft_loop": "软纠偏", "escalate": "升级", "member": "卡口的规则"}
INFO = {"card": "进展", "agent:lead": "项目负责人", "agent:coder": "代码员工", "agent:writer": "写作员工",
        "code": "代码", "runs": "实验任务", "paper": "论文", "outputs": "预期产出"}
FIXED = {"spec": "软限制规范", "clamp": "硬边界夹", "human": "人类拍板节点"}
# the first layout (see _first_layout): sizes, the lanes and the spine's two rows
WIDTH = {"stage": 230, "gate": 250, "hard": 210, "soft": 290, "spec": 270, "clamp": 270, "human": 300, "task": 290, "note": 200, "info": 250}
HEIGHT = {"stage": 92, "gate": 96, "hard": 76, "soft": 96, "spec": 92, "clamp": 92, "human": 104, "task": 108, "note": 80, "info": 130}
GAP, SPLIT = 64, INDEX["write"]
LANES = [{"key": "soft", "title": "SOFT LAYER · 软限制与软巡检（Prompt 引导 · 负责人语义校准）", "y0": -64, "y1": 250},
         {"key": "spine", "title": "RESEARCH SPINE & HARD GATES · 工序主干与代码硬卡口", "y0": 290, "y1": 880},
         {"key": "loop", "title": "LOOPBACK & ESCALATION · 自动打回、纠偏任务与人类拍板", "y0": 920, "y1": 1200}]
ROW_Y, ROW_B_X, SOFT_Y, SOFT_X, LOOP_Y = {"a": 380, "b": 640}, 294, 40, 310, 980
AT = {"spec": (0, -10), "clamp": (0, 110)}
# who works at a stage, and who a gate's rework goes back to
STATION = {"team": "lead", "method": "lead", "exp": "coder", "write": "writer", "review": "lead", "ship": "writer"}
REWORK = {"idea": "lead", "hatch": "lead", "team": "lead", "method": "lead", "exp": "coder", "write": "writer", "review": "writer", "ship": "writer"}


def _log(n: dict, kind: str, text: str = "", by: str = "你") -> None:
    """A line in a task's log: made, sent, resent, done, blocked, back (sent back by the user), marked, reopened,
    round (a gate sent its rework back again), escalated, converged."""
    n["log"] = [*(n.get("log") or []), {"ts": now(), "kind": kind, "text": clip(text, 600), "by": by}][-LOG_MAX:]


class CanvasError(Exception):
    pass


def _bad(c: dict) -> bool:
    return c["on"] and (c.get("last") or {}).get("status") in BAD


def _over(c: dict, value: float | None) -> int:
    """How many places a hard check finds beyond what it allows: what the loop drives down to nothing."""
    return int(value) if value is not None and value > (c.get("max") or 0) else 0


def _spine(checks: list[tuple[str, str, str]]) -> dict[str, list[str]]:
    """The spine's nodes in order, on two rows: each stage, and after it its gate when it has hard checks."""
    gated = {stage for _, kind, stage in checks if kind == "hard" and stage in INDEX}
    rows: dict[str, list[str]] = {"a": [], "b": []}
    for k in INDEX:
        row = rows["a" if INDEX[k] < SPLIT else "b"]
        row.append(f"stage:{k}")
        if k in gated:
            row.append(f"gate:{k}")
    return rows


def _kind_of(nid: str) -> str:
    return nid.split(":", 1)[0] if ":" in nid else nid


def _first_layout(checks: list[tuple[str, str, str]]) -> tuple[list[dict], list[tuple[str, str, str]]]:
    """Where everything starts, lane by lane. The spine: the stages and their gates in order along two rows, joined
    by the flow. The soft layer above it: the spec and the clamp on the left, wired to the stages they bear on, and
    each sentinel above the stage it watches. The loop lane below: the human gate, which the last review reports to.
    Hard checks without a stage sit on their own left of the spine. It is only a start: from here it is the user's."""
    nodes: list[dict] = []
    edges: list[tuple[str, str, str]] = []
    at: dict[str, dict] = {}
    rows = _spine(checks)
    order: list[str] = []
    for row, x in (("a", 0), ("b", ROW_B_X)):
        for nid in rows[row]:
            kind = _kind_of(nid)
            n = {"id": nid, "kind": kind, "ref": nid.split(":", 1)[1], "x": x, "y": ROW_Y[row]}
            nodes.append(n)
            at[nid] = n
            order.append(nid)
            x += WIDTH[kind] + GAP
    edges += [(a, b, "flow") for a, b in zip(order, order[1:])]
    loose = [cid for cid, kind, stage in checks if kind == "hard" and stage not in INDEX]
    for j, cid in enumerate(loose):
        nodes.append({"id": f"check:{cid}", "kind": "hard", "ref": cid, "x": -WIDTH["hard"] - GAP, "y": ROW_Y["a"] + j * (HEIGHT["hard"] + 16)})
    # the sentinels: each wants to sit over its stage; going left to right, one pushes the next along
    want = []
    for cid, kind, stage in checks:
        if kind != "soft":
            continue
        s = at.get(f"stage:{stage}")
        want.append((s["x"] + WIDTH["stage"] / 2 if s else 0, cid, stage))
    x = SOFT_X
    for centre, cid, stage in sorted(want, key=lambda w: w[0]):
        x = max(x, round(centre - WIDTH["soft"] / 2))
        nodes.append({"id": f"check:{cid}", "kind": "soft", "ref": cid, "x": x, "y": SOFT_Y})
        if f"stage:{stage}" in at:
            edges.append((f"check:{cid}", f"stage:{stage}", "watch"))
        x += WIDTH["soft"] + 24
    nodes.append({"id": "spec", "kind": "spec", "x": AT["spec"][0], "y": AT["spec"][1]})
    nodes.append({"id": "clamp", "kind": "clamp", "x": AT["clamp"][0], "y": AT["clamp"][1]})
    edges += [("spec", f"stage:{k}", "spec") for k in ("method", "write")] + [("clamp", "stage:exp", "clamp")]
    right = max(n["x"] + WIDTH[n["kind"]] for n in nodes)
    nodes.append({"id": "human", "kind": "human", "x": right - WIDTH["human"], "y": LOOP_Y})
    edges.append(("stage:review", "human", "escalate"))
    return nodes, edges


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

    @staticmethod
    def _id(d: dict, prefix: str) -> str:
        n = int(d.get("next") or 1)
        d["next"] = n + 1
        return f"{prefix}{n}"

    def _edge(self, d: dict, source: str, target: str, kind: str | None = None, label: str = "") -> None:
        if any({e["source"], e["target"]} == {source, target} for e in d["edges"]):
            return
        e = {"id": self._id(d, "e"), "source": source, "target": target}
        if kind:
            e["kind"] = kind
        if label:
            e["label"] = label
        d["edges"].append(e)

    def _load(self, line_id: str) -> dict:
        """The canvas as saved: laid out the first time, moved over once from the canvas before the loop, and kept in
        step with the project's checks (a new check gets its node, a check that is gone loses it)."""
        with self._lock:
            d = read_json(self._path(line_id), {})
            checks = self._checks(line_id)
            if not isinstance(d.get("nodes"), list):
                nodes, edges = _first_layout(checks)
                d = {"v": 2, "nodes": nodes, "edges": [], "gone": [], "next": 1}
                for a, b, kind in edges:
                    self._edge(d, a, b, kind)
                self._save(line_id, d)
                return d
            d.setdefault("edges", [])
            d.setdefault("gone", [])
            d.setdefault("next", 1)
            changed = False
            if d.get("v") != 2:
                self._migrate(d, checks)
                changed = True
            changed |= self._sync(d, checks)
            ids = {n["id"] for n in d["nodes"]}
            edges = [e for e in d["edges"] if e["source"] in ids and e["target"] in ids]
            if changed or len(edges) != len(d["edges"]):
                d["edges"] = edges
                self._save(line_id, d)
            return d

    def _migrate(self, d: dict, checks: list[tuple[str, str, str]]) -> None:
        """A canvas from before the loop: the loop's own layout, with the tasks and notes moved to the loop lane and
        the lines the user drew to them kept (a line to a hard check goes to its gate; info cards come off)."""
        stage_of = {cid: stage for cid, kind, stage in checks if kind == "hard"}
        mine = [n for n in d["nodes"] if n["kind"] in ("task", "note")]
        gone = [g for g in d["gone"] if not g.startswith("info:")]
        nodes, edges = _first_layout(checks)
        nodes = [n for n in nodes if n["id"] not in gone]
        for i, n in enumerate(mine):
            n["x"], n["y"] = (i % 4) * (WIDTH["task"] + 30), LOOP_Y + (i // 4) * (HEIGHT["task"] + 30)
        own = {n["id"] for n in mine}
        kept = {n["id"] for n in nodes} | own

        def to(nid: str) -> str:
            if nid.startswith("check:") and stage_of.get(nid[6:]) in INDEX:
                return f"gate:{stage_of[nid[6:]]}"
            return nid

        old = [e for e in d["edges"] if e["source"] in own or e["target"] in own]
        d.update({"v": 2, "nodes": nodes + mine, "edges": [], "gone": gone})
        for a, b, kind in edges:
            self._edge(d, a, b, kind)
        for e in old:
            a, b = to(e["source"]), to(e["target"])
            if a in kept and b in kept and a != b:
                self._edge(d, a, b, None, e.get("label") or "")

    def _sync(self, d: dict, checks: list[tuple[str, str, str]]) -> bool:
        """Nodes for what the project has now: a gate for each stage with hard checks, a node for each sentinel, for
        each hard check without a stage and for each check of an open gate, and the fixed three."""
        hard = {cid: stage for cid, kind, stage in checks if kind == "hard"}
        soft = {cid: stage for cid, kind, stage in checks if kind == "soft"}
        gated = {s for s in hard.values() if s in INDEX}
        have = {n["id"]: n for n in d["nodes"]}
        opened = {n["ref"] for n in d["nodes"] if n["kind"] == "gate" and n.get("open")}

        def wanted(n: dict) -> bool:
            if n["kind"] == "gate":
                return n["ref"] in gated
            if n["kind"] == "hard":
                return n["ref"] in hard and (hard[n["ref"]] not in INDEX or hard[n["ref"]] in opened)
            if n["kind"] == "soft":
                return n["ref"] in soft
            return True

        keep = [n for n in d["nodes"] if wanted(n)]
        changed = len(keep) != len(d["nodes"])
        d["nodes"] = keep
        have = {n["id"]: n for n in keep}

        def put(n: dict, link: tuple[str, str, str] | None = None) -> None:
            nonlocal changed
            if n["id"] in have or n["id"] in d["gone"]:
                return
            d["nodes"].append(n)
            have[n["id"]] = n
            if link and link[0] in have and link[1] in have:
                self._edge(d, *link)
            changed = True

        for stage in sorted(gated, key=INDEX.get):
            s = have.get(f"stage:{stage}")
            put({"id": f"gate:{stage}", "kind": "gate", "ref": stage, "x": (s["x"] if s else 0) + WIDTH["stage"] + GAP // 2,
                 "y": (s["y"] if s else ROW_Y["a"]) + HEIGHT["stage"] + 40}, (f"stage:{stage}", f"gate:{stage}", "flow"))
        for cid, stage in soft.items():
            s = have.get(f"stage:{stage}")
            n = sum(1 for x in d["nodes"] if x["kind"] == "soft")
            put({"id": f"check:{cid}", "kind": "soft", "ref": cid, "x": (s["x"] if s else SOFT_X) + (n % 3) * 30, "y": SOFT_Y + 120 + (n % 3) * 20},
                (f"check:{cid}", f"stage:{stage}", "watch"))
        loose = [cid for cid, stage in hard.items() if stage not in INDEX]
        for j, cid in enumerate(loose):
            put({"id": f"check:{cid}", "kind": "hard", "ref": cid, "x": -WIDTH["hard"] - GAP, "y": ROW_Y["a"] + j * (HEIGHT["hard"] + 16)})
        for stage in opened & gated:
            self._open_at(d, stage, [cid for cid, s in hard.items() if s == stage], have, put)
        for k in FIXED:
            if k not in have and k not in d["gone"]:
                n = {"id": k, "kind": k, "x": AT.get(k, (0, LOOP_Y))[0], "y": AT.get(k, (0, LOOP_Y))[1]}
                if k == "human":
                    n["x"] = max((x["x"] + WIDTH.get(x["kind"], 200) for x in d["nodes"] if x["kind"] in ("stage", "gate")), default=WIDTH["human"]) - WIDTH["human"]
                put(n)
        return changed

    @staticmethod
    def _open_at(d: dict, stage: str, mine: list[str], have: dict, put) -> None:
        """An open gate's checks, one node each, in a row under it, each wired to it."""
        g = have.get(f"gate:{stage}")
        if not g or not mine:
            return
        w = WIDTH["hard"] + 14
        x0 = g["x"] + WIDTH["gate"] / 2 - len(mine) * w / 2
        for j, cid in enumerate(mine):
            put({"id": f"check:{cid}", "kind": "hard", "ref": cid, "x": round(x0 + j * w), "y": g["y"] + HEIGHT["gate"] + 34},
                (f"gate:{stage}", f"check:{cid}", "member"))

    def _line(self, line_id: str) -> dict:
        ln = self.town.db.one("select id, seq, title, status, note, budget, spent from lines where id = ?", line_id)
        if not ln:
            raise CanvasError("没有这个项目")
        return ln

    @staticmethod
    def _node(d: dict, node_id: str) -> dict:
        n = next((x for x in d["nodes"] if x["id"] == node_id), None)
        if not n:
            raise CanvasError("回路上没有这个节点")
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
                what = f"回路上给{ROLES[n['to']]['name']}的{'修补单' if n.get('loop') == 'hard' else '任务'}「{clip(n.get('title'), 40)}」"
                out[f"task:{n['id']}"] = (n["status"], what + (f"（{clip(n['result'], 160)}）" if n.get("result") else ""))
        return out

    def locks(self, line_id: str) -> list[str]:
        """The gates that hold the stage after them, in words, for the lead's view of the project."""
        if not self._path(line_id).exists():
            return []
        v = self.view(line_id)
        return [f"「{n['gate']['name']}」的硬卡口阻断，「{n['gate']['locks']}」要等它放行（{'、'.join(c['title'] for c in n['gate']['blocking'])}）"
                for n in v["nodes"] if n["kind"] == "gate" and n["gate"]["state"] == "block" and n["gate"]["locks"] and not n["gate"]["waived"]]

    # for the assistant, which edits the canvas for the user (assistant.py)

    def find(self, line_id: str, ref: object) -> dict:
        """A node by its id, or by a stage's key, a check's id, a gate's stage or an info card's name without the prefix."""
        d, ref = self._load(line_id), str(ref or "").strip()
        n = next((n for cand in (ref, f"stage:{ref}", f"check:{ref}", f"gate:{ref}", f"info:{ref}") for n in d["nodes"] if n["id"] == cand), None)
        cid = ref.removeprefix("check:")
        if not n and any(c[0] == cid and c[1] == "hard" for c in self._titles(line_id)):  # a check inside its gate
            n = {"id": f"check:{cid}", "kind": "hard", "ref": cid, "x": 0, "y": 0}
        if not n:
            raise CanvasError(f"回路上没有节点「{ref}」（编号见回路的清单）")
        return {"id": n["id"], "kind": n["kind"], "ref": n.get("ref"), "x": n["x"], "y": n["y"], "w": WIDTH[n["kind"]], "label": self._label(line_id, n)}

    def _label(self, line_id: str, n: dict) -> str:
        if n["kind"] == "stage":
            return NAMES.get(n["ref"], n["ref"])
        if n["kind"] == "gate":
            return f"{NAMES.get(n['ref'], n['ref'])}硬卡口"
        if n["kind"] in FIXED:
            return FIXED[n["kind"]]
        if n["kind"] == "info":
            return INFO.get(n["ref"], n["ref"])
        if n["kind"] in ("hard", "soft"):
            return next((c[3] for c in self._titles(line_id) if c[0] == n["ref"]), n["ref"])
        return clip(n.get("title") or n.get("text"), 40)

    def _titles(self, line_id: str) -> list[tuple[str, str, str, str]]:
        cfg = self.town.checks.config(line_id)
        return [(h.id, "hard", h.stage, h.title) for h in self.town.checks.hard(line_id, cfg)] + \
               [(s["id"], "soft", s.get("stage") or "", s.get("title") or s["id"]) for s in cfg["soft"]]

    def edge_between(self, line_id: str, a: str, b: str) -> dict | None:
        return next((e for e in self._load(line_id)["edges"] if {e["source"], e["target"]} == {a, b}), None)

    def spot(self, line_id: str) -> tuple[int, int]:
        """Somewhere free for a node nobody placed: in the loop lane, after what is there."""
        nodes = [n for n in self._load(line_id)["nodes"] if n["y"] >= LANES[2]["y0"] - 40 and n["kind"] != "human"]
        return (max((n["x"] + WIDTH[n["kind"]] for n in nodes), default=-30) + 30, LOOP_Y)

    def outline(self, line_id: str) -> str:
        """The canvas in words: every node with its id and how it stands, and the lines between them."""
        v = self.view(line_id)
        out = [f"#{v['seq']}「{clip(v['title'], 40)}」的研究回路（第 {v['rounds']} 轮）。节点（编号 · 种类 · 名字 · 现在怎样）："]
        for n in v["nodes"]:
            if n["kind"] == "stage":
                how = STAGE.get(n["status"], n["status"]) + (f" {n['pct']}%" if n["status"] == "run" else "") + ("，被硬卡口锁住" if n.get("locked") else "")
            elif n["kind"] == "gate":
                g = n["gate"]
                how = f"{GATE_STATE[g['state']]}，{g['pass']}/{g['total']} 过，违规 {g['before']}→{g['now']} 处" + (f"，修补单 {g['ticket']} 第 {g['round']} 轮" if g["ticket"] else "")
            elif n["kind"] in ("hard", "soft"):
                c, last = n["check"], n["check"]["last"] or {}
                how = "已关闭" if not c["on"] else CHECK_STATUS.get(last.get("status") or ("wait" if c["kind"] == "soft" else "none"), "")
                if c["kind"] == "hard" and last.get("value") is not None:
                    how += f"（{int(last['value'])}，最多 {c.get('max', 0)}，{GATE[c['gate']]}）"
                elif c["kind"] == "soft":
                    how += f"：{clip(last.get('note') or c['text'], 80)}"
            elif n["kind"] == "task":
                how = f"给{ROLES[n['to']]['name']}，{TASK[n['status']]}" + (f"，第 {n['round']} 轮" if n.get("loop") == "hard" else "") \
                    + (f"：{clip(n['result'] or n['text'], 100)}" if n.get("result") or n.get("text") else "")
            elif n["kind"] == "human":
                how = f"{len(n['items'])} 件等你拍板" if n["items"] else "没有等你拍板的"
            elif n["kind"] in ("spec", "clamp"):
                how = f"{len(n['rules'])} 条"
            elif n["kind"] == "note":
                how = ""
            else:
                how = "实时显示项目的这部分"
            name = clip(n.get("text"), 80) if n["kind"] == "note" else n.get("title")
            out.append(f"- {n['id']} · {KIND[n['kind']]} · {name}" + (f" · {how}" if how else ""))
        out += ["", "连线（圆括号里是线的种类，方括号里是线上写的字）："]
        out += [f"- {e['source']} — {e['target']}" + (f"（{EDGES[e['kind']]}）" if e.get("kind") else "") + (f" [{e['label']}]" if e.get("label") else "")
                for e in v["edges"]] or ["- 还没有连线"]
        if v["gone"]:
            out += ["", "从回路上拿掉了（用户能在「更多」里放回）：" + "、".join(f"{g['id']}（{g['title']}）" for g in v["gone"])]
        return "\n".join(out)

    def nudge(self, line_id: str, node_id: str, x: float, y: float) -> None:
        """Move one node and tell the page (dragging on the page does not need telling)."""
        self.move(line_id, {node_id: [x, y]})
        self._changed(line_id)

    # the view

    def view(self, line_id: str) -> dict:
        ln = self._line(line_id)
        cv = self.town.checks.view(line_id)
        d = self._load(line_id)
        stages = {s["key"]: s for s in cv["stages"]}
        checks = {c["id"]: c for c in cv["checks"]}
        tasks = [n for n in d["nodes"] if n["kind"] == "task"]
        gates = {n["ref"]: self._gate(n, cv, stages, tasks) for n in d["nodes"] if n["kind"] == "gate"}
        locked = {g["next"]: g for g in gates.values() if g["state"] == "block" and g["next"] and not g["waived"]}
        bounds = self._bounds(line_id)
        nodes = []
        for n in d["nodes"]:
            out = {"id": n["id"], "kind": n["kind"], "x": n["x"], "y": n["y"]}
            if n["kind"] == "stage":
                s = stages.get(n["ref"])
                if not s:
                    continue
                g = locked.get(n["ref"])
                out |= {"ref": n["ref"], "title": s["name"], "status": s["status"], "pct": s["pct"], "note": s.get("note") or "",
                        "role": STATION.get(n["ref"]), "locked": {"gate": g["stage"], "title": g["name"]} if g else None}
            elif n["kind"] == "gate":
                out |= {"ref": n["ref"], "title": gates[n["ref"]]["name"], "gate": gates[n["ref"]]}
            elif n["kind"] in ("hard", "soft"):
                c = checks.get(n["ref"])
                if not c:
                    continue
                out |= {"kind": c["kind"], "ref": n["ref"], "title": c["title"], "check": c}
            elif n["kind"] in ("spec", "clamp"):
                out |= {"title": FIXED[n["kind"]], "rules": bounds[n["kind"]], **({"budget": bounds["budget"]} if n["kind"] == "clamp" else {})}
            elif n["kind"] == "human":
                out |= {"title": FIXED["human"], "items": self._human(line_id, ln, cv, tasks, gates)}
            elif n["kind"] == "info":
                if n["ref"] not in INFO:
                    continue
                out |= {"ref": n["ref"], "title": INFO[n["ref"]]}
            elif n["kind"] == "task":
                out |= {k: n.get(k) for k in ("title", "text", "to", "status", "sent_at", "done_at", "result", "by", "created_at")}
                out |= {"log": n.get("log") or [], "loop": n.get("loop"), "stage": n.get("gate"), "round": n.get("round") or 0,
                        "trail": n.get("trail") or [], "from": n.get("from"), "escalated": bool(n.get("escalated")), "converged": bool(n.get("converged"))}
            else:
                out |= {"text": n.get("text") or ""}
            nodes.append(out)
        ids = {n["id"] for n in nodes}
        on = [n for n in nodes if n["kind"] == "task"]
        gone = [{"id": g, "title": self._gone_title(g, cv)} for g in d["gone"]]
        return {"line_id": line_id, "seq": ln["seq"], "title": ln["title"], "nodes": nodes,
                "edges": [e for e in d["edges"] if e["source"] in ids and e["target"] in ids], "gone": gone,
                "spare": [{"id": f"info:{k}", "title": t} for k, t in INFO.items() if f"info:{k}" not in ids],
                "lanes": LANES, "checks": cv["checks"], "summary": cv["summary"], "tasks": {k: sum(1 for t in on if t["status"] == k) for k in TASK},
                "trend": cv["trend"], "found": cv["found"], "rounds": cv["rounds"], "ran": cv["ran"], "lead": cv["lead"],
                "agents": {r: {"there": bool(a), "status": self.town.agents.shown(a) if a else None, "model": a.get("model") if a else None}
                           for r in TO for a in [self.town.leads.agent(line_id, r)]}}

    @staticmethod
    def _gone_title(g: str, cv: dict) -> str:
        kind, _, ref = g.partition(":")
        if kind in FIXED:
            return FIXED[kind]
        if kind == "gate":
            return f"{NAMES.get(ref, ref)}硬卡口"
        return INFO.get(ref) or NAMES.get(ref) or next((c["title"] for c in cv["checks"] if c["id"] == ref), g)

    def _gate(self, n: dict, cv: dict, stages: dict, tasks: list[dict]) -> dict:
        """A stage's gate: its hard checks, whether it lets the next stage through, before → after, its rework."""
        stage = n["ref"]
        mine = [c for c in cv["checks"] if c["kind"] == "hard" and c["stage"] == stage]
        on = [c for c in mine if c["on"]]
        blocking = [c for c in on if _bad(c) and c["gate"] == "block"]
        warning = [c for c in on if _bad(c) and c["gate"] != "block"]
        state = ("off" if not on else "block" if blocking else "warn" if warning
                 else "none" if all(not c["last"] or c["last"]["status"] == "none" for c in on) else "pass")
        later = [k for k in INDEX if INDEX[k] > INDEX[stage]]
        ticket = next((t for t in reversed(tasks) if t.get("loop") == "hard" and t.get("gate") == stage), None)
        policy = cv["loops"].get(stage) or {"auto": False, "rounds": 5}
        return {"stage": stage, "name": NAMES.get(stage, stage), "state": state, "checks": [c["id"] for c in mine],
                "pass": sum(1 for c in on if (c["last"] or {}).get("status") == "pass"), "total": len(on),
                "blocking": [{"id": c["id"], "title": c["title"]} for c in blocking],
                "before": sum(_over(c, (c.get("first") or {}).get("value")) for c in on), "now": sum(_over(c, (c["last"] or {}).get("value")) for c in on),
                "policy": policy, "ticket": ticket["id"] if ticket else None, "ticket_status": ticket["status"] if ticket else None,
                "round": ticket.get("round") or 0 if ticket else 0, "escalated": bool(ticket and ticket.get("escalated") and ticket["status"] != "done"),
                "open": bool(n.get("open")), "waived": bool(n.get("waived")), "reached": (stages.get(stage) or {}).get("status") in ("run", "wait", "done"),
                "next": later[0] if later else None, "locks": NAMES[later[0]] if later else None}

    def _bounds(self, line_id: str) -> dict:
        """What the spec and the clamp show: the work boundaries the project's agents keep, split by how they hold.
        Bound to an action, Papertown stops it or asks you (the clamp); anything else is words the agent is told (the spec)."""
        seen, spec, clamp = set(), [], []
        for role in ("lead", "coder", "writer"):
            for r in self.town.bounds.effective(role, line_id):
                if r["id"] in seen:
                    continue
                seen.add(r["id"])
                row = {"id": r["id"], "kind": r["kind"], "text": r["text"], "from": r.get("from") or role, "action": r.get("action")}
                (clamp if r.get("action") else spec).append(row)
        ln = self.town.db.one("select budget, spent from lines where id = ?", line_id) or {}
        return {"spec": spec, "clamp": clamp, "budget": {"budget": ln.get("budget") or 0, "spent": ln.get("spent") or 0}}

    def _human(self, line_id: str, ln: dict, cv: dict, tasks: list[dict], gates: dict) -> list[dict]:
        """What waits for your decision: gates past their rounds, stuck tasks, sentinels judged off course,
        questions from the agents, a project waiting on you."""
        out = []
        for t in tasks:
            if t.get("loop") == "hard" and t.get("escalated") and t.get("status") != "done":
                g = gates.get(t.get("gate"))
                out.append({"kind": "escalated", "id": t["id"], "gate": t.get("gate"),
                            "text": f"「{g['name'] if g else t.get('gate')}」硬卡口打回 {t.get('round') or 0} 轮还没清零"})
            elif t.get("status") == "blocked":
                out.append({"kind": "blocked", "id": t["id"], "text": f"{ROLES[t['to']]['name']}卡在「{clip(t.get('title'), 30)}」：{clip(t.get('result'), 80)}"})
        for c in cv["checks"]:
            if c["kind"] == "soft" and c["on"] and (c["last"] or {}).get("status") == "fail":
                out.append({"kind": "fail", "id": f"check:{c['id']}", "text": f"软巡检「{c['title']}」判为偏离：{clip(c['last']['note'], 80)}"})
        for q in self.town.leads.asks(line_id):
            out.append({"kind": "ask", "id": str(q["id"]), "text": f"{q['data'].get('who') or 'agent'}问你：{clip(q['data'].get('question'), 100)}"})
        if ln.get("status") in ("waiting", "paused", "failed"):
            out.append({"kind": "line", "id": ln["id"], "text": clip(ln.get("note") or "项目在等你", 100)})
        return out

    # editing

    def add(self, line_id: str, kind: str, x: float, y: float, title: str = "", text: str = "", to: str = "lead",
            prio: str = "P1", link: str | None = None, send: bool = False) -> dict:
        """A new node where the user put it, wired to the node it was drawn from: a task (sent at once when asked),
        a check of the user's own, or a note. A task drawn from a sentinel is a correction: it goes back to the
        stage the sentinel watches."""
        self._line(line_id)
        title, text = clip(title, 60), str(text or "").strip()
        with self._lock:
            d = self._load(line_id)
            if len(d["nodes"]) >= NODES_MAX:
                raise CanvasError("回路上的节点太多了")
            src = next((n for n in d["nodes"] if n["id"] == link), None) if link else None
            if kind == "task":
                if not title:
                    raise CanvasError("给任务写个名字")
                if to not in TO:
                    raise CanvasError("任务交给 lead（项目负责人）、coder（代码员工）或 writer（写作员工）")
                node = {"id": self._id(d, "t"), "kind": "task", "title": title, "text": text[:4000], "to": to, "status": "draft",
                        "created_at": now(), "sent_at": None, "done_at": None, "result": "", "by": "", "log": []}
                if src and src["kind"] == "soft":
                    node |= {"loop": "soft", "from": src["ref"]}
                _log(node, "made")
            elif kind == "note":
                if not text:
                    raise CanvasError("备注是空的")
                node = {"id": self._id(d, "n"), "kind": "note", "text": text[:2000]}
            elif kind in ("hard", "soft"):
                stage = src["ref"] if src and src["kind"] in ("stage", "gate") else ""
                try:
                    cid = self.town.checks.create(line_id, kind, stage, title, text, prio)
                except CheckError as e:
                    raise CanvasError(str(e)) from e
                d = self._load(line_id)
                if kind == "hard" and stage:  # it joins its stage's gate, which is where it shows
                    self._changed(line_id)
                    return {**self.view(line_id), "added": f"gate:{stage}"}
                node = next((n for n in d["nodes"] if n["id"] == f"check:{cid}"), None) or {"id": f"check:{cid}", "kind": kind, "ref": cid}
                d["nodes"] = [n for n in d["nodes"] if n["id"] != node["id"]]
                d["edges"] = [e for e in d["edges"] if node["id"] not in (e["source"], e["target"])]
            else:
                raise CanvasError("节点可以是任务（task）、硬检查（hard）、软巡检（soft）或备注（note）")
            node |= {"x": round(float(x)), "y": round(float(y))}
            d["nodes"].append(node)
            if src:
                if node.get("loop") == "soft":
                    self._edge(d, src["id"], node["id"], "soft_loop")
                    for e in [e for e in d["edges"] if e.get("kind") == "watch" and e["source"] == src["id"]]:
                        self._edge(d, node["id"], e["target"], "soft_loop")
                elif kind == "soft" and src["kind"] == "stage":
                    self._edge(d, node["id"], src["id"], "watch")
                else:
                    self._edge(d, src["id"], node["id"])
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
                        raise CanvasError("这件事已经发出去了，要换人先重新打开它")
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
        """Take a node off the canvas. A check of the user's own goes with it; a built-in one is turned off. A stage,
        a gate and the fixed three come off until put back; an info card goes back to the spare ones."""
        with self._lock:
            d = self._load(line_id)
            n = self._node(d, node_id)
            if n["kind"] in ("hard", "soft"):
                try:
                    if n["ref"] in HARD_IDS or n["kind"] == "soft" and not n["ref"].startswith("ask-"):
                        self.town.checks.set(line_id, n["ref"], on=False)
                        d = self._load(line_id)
                        d["gone"].append(node_id)
                    else:
                        self.town.checks.remove(line_id, n["ref"])
                        d = self._load(line_id)
                except CheckError as e:
                    raise CanvasError(str(e)) from e
            elif n["kind"] in ("stage", "gate", *FIXED):
                d["gone"].append(node_id)
            d["nodes"] = [x for x in d["nodes"] if x["id"] != node_id]
            d["edges"] = [e for e in d["edges"] if node_id not in (e["source"], e["target"])]
            self._save(line_id, d)
        self._changed(line_id)
        return self.view(line_id)

    def restore(self, line_id: str, node_id: str) -> dict:
        """Put back what was taken off, or put a spare info card on the canvas."""
        with self._lock:
            d = self._load(line_id)
            kind, _, ref = node_id.partition(":")
            if kind == "info" and ref in INFO:
                if any(n["id"] == node_id for n in d["nodes"]):
                    raise CanvasError("这张资料卡已经在回路上了")
                x, y = self.spot(line_id)
                d["nodes"].append({"id": node_id, "kind": "info", "ref": ref, "x": x, "y": y})
                self._save(line_id, d)
                self._changed(line_id)
                return {**self.view(line_id), "added": node_id}
            if node_id not in d["gone"]:
                raise CanvasError("这个节点没有被移走")
            d["gone"].remove(node_id)
            first, _ = _first_layout(self._checks(line_id))
            at = next((n for n in first if n["id"] == node_id), None)
            if kind in ("stage", "gate") and at:
                d["nodes"].append(at)
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
            self._edge(d, source, target)
            self._save(line_id, d)
        self._changed(line_id)
        return self.view(line_id)

    def label(self, line_id: str, edge_id: str, text: str) -> dict:
        """A few words on a line (none takes them off)."""
        with self._lock:
            d = self._load(line_id)
            e = next((x for x in d["edges"] if x["id"] == edge_id), None)
            if not e:
                raise CanvasError("回路上没有这条线")
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
        """按回路规整: the stages, gates, checks and the fixed three back in their lanes as at first, each gate's rework
        ticket under it, and the lines of the first layout drawn again; the user's tasks, notes and lines stay."""
        with self._lock:
            d = self._load(line_id)
            nodes, edges = _first_layout(self._checks(line_id))
            at = {n["id"]: n for n in nodes}
            for n in d["nodes"]:
                if n["id"] in at:
                    n["x"], n["y"] = at[n["id"]]["x"], at[n["id"]]["y"]
            for n in d["nodes"]:
                if n["kind"] == "task" and n.get("loop") == "hard" and f"gate:{n.get('gate')}" in at:
                    g = at[f"gate:{n['gate']}"]
                    n["x"], n["y"] = g["x"] - (WIDTH["task"] - WIDTH["gate"]) // 2, LOOP_Y
            have = {n["id"]: n for n in d["nodes"]}
            for g in [n for n in d["nodes"] if n["kind"] == "gate" and n.get("open")]:
                mine = [n for n in d["nodes"] if n["kind"] == "hard" and any(
                    e["source"] == g["id"] and e["target"] == n["id"] for e in d["edges"])]
                w = WIDTH["hard"] + 14
                x0 = g["x"] + WIDTH["gate"] / 2 - len(mine) * w / 2
                for j, n in enumerate(mine):
                    n["x"], n["y"] = round(x0 + j * w), g["y"] + HEIGHT["gate"] + 34
            for a, b, kind in edges:
                if a in have and b in have:
                    self._edge(d, a, b, kind)
            self._save(line_id, d)
        self._changed(line_id)
        return self.view(line_id)

    # gates: open into a node per check, and their rework

    def gate(self, line_id: str, stage: str, what: str) -> dict:
        """open / close: a gate's checks as nodes of their own, or back into the gate. rework: write (or bring up to
        date) the gate's rework ticket and send it. more: two more rounds for a gate that came to you. waive: you
        let it through as it is; it stops sending rework and holding the next stage until it passes."""
        with self._lock:
            d = self._load(line_id)
            g = self._node(d, f"gate:{stage}")
            if what in ("open", "close"):
                g["open"] = what == "open"
                if what == "close":
                    ids = {n["id"] for n in d["nodes"] if n["kind"] == "hard" and any(
                        e["source"] == g["id"] and e["target"] == n["id"] and e.get("kind") == "member" for e in d["edges"])}
                    d["nodes"] = [n for n in d["nodes"] if n["id"] not in ids]
                    d["edges"] = [e for e in d["edges"] if e["source"] not in ids and e["target"] not in ids]
                self._save(line_id, d)
                if what == "open":
                    d = self._load(line_id)  # the next load puts the gate's checks under it
            elif what == "waive":
                g["waived"] = True
                ticket = next((t for t in reversed(d["nodes"]) if t["kind"] == "task" and t.get("loop") == "hard" and t.get("gate") == stage), None)
                if ticket and ticket["status"] != "done":
                    ticket |= {"status": "done", "done_at": now(), "by": "你", "escalated": False, "result": ticket.get("result") or "你决定先放行"}
                    _log(ticket, "marked", "你决定先放行")
                self._save(line_id, d)
            elif what == "more":
                ticket = next((t for t in reversed(d["nodes"]) if t["kind"] == "task" and t.get("loop") == "hard" and t.get("gate") == stage), None)
                if not ticket or not ticket.get("escalated"):
                    raise CanvasError("这道卡口没有等你决定的修补单")
                ticket |= {"escalated": False, "extra": int(ticket.get("extra") or 0) + 2, "status": "done", "by": "Papertown"}
                self._save(line_id, d)
            elif what != "rework":
                raise CanvasError("对卡口能做的是 open、close、rework、more、waive")
        if what in ("rework", "more"):
            self._loop(line_id, force=stage)  # what stops it is the user's to read
        self._changed(line_id)
        return self.view(line_id)

    def loop(self, line_id: str, force: str | None = None) -> bool:
        """Move each gate's rework on: a blocking check that fails at a stage the project has reached gets the stage's
        agent a rework ticket listing what fails (sent at once when the stage says so); when the agent says done and
        the gate still fails, the next round goes out; past the stage's rounds it comes to you; once the gate passes,
        the ticket is closed as converged. `force` is a stage whose rework the user asked for now. True if anything moved."""
        try:
            return self._loop(line_id, force)
        except (CanvasError, CheckError):
            return False

    def _loop(self, line_id: str, force: str | None) -> bool:
        if not self._path(line_id).exists() and not force:
            return False
        send: list[str] = []
        with self._lock:
            v = self.view(line_id)
            d = self._load(line_id)
            checks = {n["ref"]: n["check"] for n in v["nodes"] if n.get("check")}
            cv = None
            changed = False
            for gn in [n for n in v["nodes"] if n["kind"] == "gate"]:
                g, stage = gn["gate"], gn["ref"]
                node, t = self._node(d, gn["id"]), self._ticket(d, stage)
                if g["state"] != "block":
                    if node.get("waived") and g["state"] in ("pass", "warn", "off"):
                        node.pop("waived")
                        changed = True
                    if t and not t.get("converged") and g["state"] in ("pass", "warn", "off"):
                        if t["status"] != "done":
                            t |= {"status": "done", "done_at": now(), "by": "Papertown"}
                        t |= {"converged": True, "escalated": False, "trail": [*(t.get("trail") or []), g["now"]][-TRAIL_MAX:],
                              "result": t.get("result") or f"硬卡口放行：{t.get('round') or 1} 轮收敛"}
                        _log(t, "converged", f"硬卡口放行：{t.get('round') or 1} 轮收敛（违规 {g['before']}→{g['now']} 处）", by="Papertown")
                        changed = True
                    if force == stage:
                        raise CanvasError("修补单在卡口有规则阻断时才派得出去")
                    continue
                if force != stage and (node.get("waived") or not g["reached"]):
                    continue
                if cv is None:
                    cv = self.town.checks.view(line_id)
                    checks |= {c["id"]: c for c in cv["checks"]}
                title, text = self._rework_text(g, [checks[c] for c in g["checks"] if c in checks and _bad(checks[c])])
                if not t or t.get("converged"):  # a new ticket, under the gate
                    t = {"id": self._id(d, "t"), "kind": "task", "loop": "hard", "gate": stage, "round": 1, "trail": [g["now"]],
                         "title": title, "text": text, "to": REWORK.get(stage, "lead"), "status": "draft", "created_at": now(),
                         "sent_at": None, "done_at": None, "result": "", "by": "", "log": [],
                         "x": gn["x"] - (WIDTH["task"] - WIDTH["gate"]) // 2, "y": LOOP_Y}
                    _log(t, "made", f"「{g['name']}」硬卡口阻断，Papertown 写了第 1 轮修补单", by="Papertown")
                    d["nodes"].append(t)
                    self._edge(d, gn["id"], t["id"], "hard_loop")
                    self._edge(d, t["id"], f"stage:{stage}", "hard_loop")
                    changed = True
                    if g["policy"]["auto"] or force == stage:
                        send.append(t["id"])
                    continue
                if t["status"] in ("draft", "sent"):
                    if t["text"] != text:
                        t |= {"title": title, "text": text}
                        changed = True
                    if force == stage or t["status"] == "draft" and g["policy"]["auto"]:
                        send.append(t["id"])
                    continue
                # done (or stuck) while the gate still blocks: the next round, unless you closed it or it ran out
                if force != stage and (t["status"] == "blocked" or t.get("by") == "你"):
                    continue
                if force != stage and (t.get("round") or 1) >= g["policy"]["rounds"] + int(t.get("extra") or 0):
                    t |= {"escalated": True, "status": "blocked", "result": f"打回 {t.get('round') or 1} 轮还没清零，等你拍板"}
                    _log(t, "escalated", t["result"], by="Papertown")
                    self.town.message(line_id, "system", None, "text",
                                      {"text": f"「{g['name']}」的硬卡口打回 {t.get('round') or 1} 轮还没清零，在研究回路的人类拍板节点等你决定。"})
                    changed = True
                    continue
                t |= {"round": (t.get("round") or 1) + 1, "title": title, "text": text, "status": "draft", "escalated": False,
                      "trail": [*(t.get("trail") or []), g["now"]][-TRAIL_MAX:]}
                _log(t, "round", f"硬卡口还是阻断（还有 {g['now']} 处），第 {t['round']} 轮", by="Papertown")
                changed = True
                if g["policy"]["auto"] or force == stage:
                    send.append(t["id"])
            if changed:
                self._save(line_id, d)
        for tid in send:
            try:
                self.send(line_id, tid)
            except CanvasError:
                if force:
                    raise
        if changed and not send:
            self._changed(line_id)
        return changed or bool(send)

    @staticmethod
    def _ticket(d: dict, stage: str) -> dict | None:
        return next((t for t in reversed(d["nodes"]) if t["kind"] == "task" and t.get("loop") == "hard" and t.get("gate") == stage), None)

    @staticmethod
    def _rework_text(g: dict, bad: list[dict]) -> tuple[str, str]:
        """A rework ticket: what fails at the gate, rule by rule, with where."""
        bad = sorted(bad, key=lambda c: (c["gate"] != "block", c["prio"]))
        names = "、".join(c["title"] for c in bad if c["gate"] == "block") or "、".join(c["title"] for c in bad)
        lines = [f"「{g['name']}」的硬卡口阻断（{g['pass']}/{g['total']} 过，还有 {g['now']} 处）。把下面阻断的规则清零，告警的也尽量清零；"
                 "改完运行 `.papertown/pt checks run` 确认，直到这道卡口放行：", ""]
        for c in bad:
            last = c["last"] or {}
            lines.append(f"- [{c['prio']} · {GATE[c['gate']]}] {c['id']}「{c['title']}」：{int(last.get('value') or 0)} {c.get('unit') or '处'}，"
                         f"最多 {int(c.get('max') or 0)}（{c['rule']}）")
            for f in (last.get("findings") or [])[:8]:
                where = f"{f['file']}:{f['line']} " if f.get("file") else ""
                lines.append(f"    {where}「{clip(f['text'], 100)}」→ {f['hint']}")
            if (last.get("total") or 0) > 8:
                lines.append(f"    …共 {last['total']} 处，`pt checks` 看全部")
        return clip(f"清零{g['name']}卡口：{names}", 60), "\n".join(lines)

    # tasks: to an agent, and back

    def _around(self, line_id: str, d: dict, node: dict) -> list[str]:
        """What a task is wired to, in words, for the agent that gets it."""
        v = self.view(line_id)
        by = {n["id"]: n for n in v["nodes"]}
        near = {(e["target"] if e["source"] == node["id"] else e["source"]): e.get("label") for e in d["edges"] if node["id"] in (e["source"], e["target"])}
        out = []
        for nid, label in near.items():
            n = by.get(nid)
            if not n:
                continue
            what = ""
            if n["kind"] == "stage":
                what = f"工序「{n['title']}」（{STAGE.get(n['status'], n['status'])}）"
            elif n["kind"] == "gate":
                g = n["gate"]
                what = f"「{g['name']}」的硬卡口（{GATE_STATE[g['state']]}，{g['pass']}/{g['total']} 过，还有 {g['now']} 处）"
            elif n["kind"] in ("hard", "soft"):
                c = n["check"]
                last = c["last"] or {}
                st = CHECK_STATUS.get(last.get("status") or ("wait" if c["kind"] == "soft" else "none"))
                val = "" if last.get("value") is None else f"，{int(last['value'])} {c.get('unit') or '处'}"
                what = f"{'硬' if c['kind'] == 'hard' else '软'}检查 {c['id']}「{c['title']}」（现在{st}{val}）：{c['text']}" \
                    + (f"；负责人的判断：{clip(last.get('note'), 300)}" if c["kind"] == "soft" and last.get("note") else "")
            elif n["kind"] == "task":
                what = f"任务 {n['id']}「{n['title']}」（给{ROLES[n['to']]['name']}，{TASK[n['status']]}）"
            elif n["kind"] == "note":
                what = f"备注：{clip(n.get('text'), 300)}"
            elif n["kind"] == "info":
                what = f"项目的{INFO.get(n['ref'], n['ref'])}"
            elif n["kind"] in ("spec", "clamp"):
                what = f"{FIXED[n['kind']]}：" + ("；".join(clip(r["text"], 80) for r in n["rules"]) or "还没有写进工作边界的条目")
            if what:
                out.append(what + (f"［线上写着：{label}］" if label else ""))
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
                raise CanvasError(f"这个项目的{ROLES[n['to']]['name']}还没有启动：先在「员工」面板里启动它，任务会留在回路上")
            again = n["status"] != "draft" or any(x["kind"] in ("sent", "resent") for x in n.get("log") or [])
            around = self._around(line_id, d, n)
            if n.get("loop") == "hard":
                head = f"Papertown 的研究回路把这件事打回给你（第 {n.get('round') or 1} 轮修补单）：「{n['title']}」"
            elif n.get("loop") == "soft":
                head = ("用户改了研究回路上这件事，按新的来：" if again else "研究回路上的软巡检发现了偏差，用户派你纠偏：") + f"「{n['title']}」"
            else:
                head = ("用户改了研究回路上这件事，按新的来：" if again else "用户在研究回路上给你派了一件事：") + f"「{n['title']}」"
            body = [f'<task id="{n["id"]}">', head]
            if n.get("text"):
                body += ["", n["text"]]
            if around:
                body += ["", "它在回路上连着这些（连着检查或卡口的，做完要让它通过）：", *[f"- {x}" for x in around]]
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
            body = [f'<task id="{n["id"]}">', f"用户看了你对研究回路上「{n['title']}」这件事交回的结果，退回来了：", "", text[:4000]]
            if n.get("result"):
                body += ["", f"你上次回的是：{clip(n['result'], 600)}"]
            body += ["", f"按用户说的接着做，做完再运行 `.papertown/pt task {n['id']} done \"结果\"`，卡住了运行 "
                         f"`.papertown/pt task {n['id']} blocked \"原因\"`。", "</task>"]
            self.town.agents.say(a["id"], "\n".join(body), "queue", origin="papertown")
            n |= {"status": "sent", "sent_at": now(), "done_at": None, "by": "", "escalated": False}
            _log(n, "back", text)
            self._save(line_id, d)
        self._changed(line_id)
        return self.view(line_id)

    def close(self, agent_id: str, task_id: str, status: str, text: str) -> dict:
        """`pt task <id> done|blocked "…"`: the agent's word on a task, which also goes to the user as a report. A rework
        ticket said done has its gate checked again at once: the next round goes out if it still fails."""
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
                raise CanvasError(f"回路上没有任务 {task_id}（`pt tasks` 看有哪些）")
            if a["role"] != "lead" and n["to"] != a["role"]:
                raise CanvasError(f"这件事是给{ROLES[n['to']]['name']}的")
            n |= {"status": status, "done_at": now(), "result": text[:4000], "by": self.town.leads._who(a)}
            _log(n, status, text, by=n["by"])
            self._save(lid, d)
        self.town.leads.report(agent_id, f"研究回路上的{'修补单' if n.get('loop') == 'hard' else '任务'}「{n['title']}」{TASK[status]}：{text}",
                               key=status == "blocked")
        if n.get("loop") == "hard" and status == "done":
            self.town.checks.run(lid, force=True)
            self.loop(lid)
        self._changed(lid)
        return {"text": f"记下了：「{n['title']}」{TASK[status]}。用户在研究回路和汇报里会看到。"}

    def tasks_text(self, agent_id: str) -> str:
        """`pt tasks`: what the user has put on the canvas for this agent (a lead sees every task)."""
        a = self.town.agents.get(agent_id)
        if not a or not a.get("line_id"):
            raise CanvasError("只有项目里的 agent 有研究回路上的任务")
        d = self._load(a["line_id"])
        mine = [n for n in d["nodes"] if n["kind"] == "task" and n["status"] != "draft" and (a["role"] == "lead" or n["to"] == a["role"])]
        if not mine:
            return "研究回路上没有给你的任务。"
        out = []
        for n in mine:
            what = f"第 {n.get('round') or 1} 轮修补单" if n.get("loop") == "hard" else "纠偏任务" if n.get("loop") == "soft" else "任务"
            out.append(f"- {n['id']}「{n['title']}」（{what}，给{ROLES[n['to']]['name']}，{TASK[n['status']]}）" + (f"：{clip(n.get('text'), 400)}" if n.get("text") else ""))
            out += [f"    连着：{x}" for x in self._around(a["line_id"], d, n)]
            if n.get("result"):
                out.append(f"    结果：{clip(n['result'], 300)}")
        return "\n".join(["研究回路上的任务（做完用 `pt task <编号> done \"结果\"`，卡住用 blocked）：", *out])

    # the report: hard before → after and the sentinels' word, for the user and for a page

    def report(self, line_id: str) -> dict:
        """The loop as a report: each gate's rules from the first round to now, and each sentinel's latest verdict."""
        v = self.view(line_id)
        checks = {n["check"]["id"]: n["check"] for n in v["nodes"] if n.get("check")}
        cv = self.town.checks.view(line_id)
        checks |= {c["id"]: c for c in cv["checks"]}
        found = v["found"]
        md = [f"# #{v['seq']} {v['title']} · 研究回路汇报", "",
              f"第 {v['rounds']} 轮 · 硬卡口违规 {found['first'] if found['first'] is not None else '—'} → {found['now'] if found['now'] is not None else '—'} 处", "",
              "## 硬限制质控（Code Rule · Before → After）", "", "| 卡口 | 规则 | 要求 | R1 | 现在 | 门禁 |", "| --- | --- | --- | --- | --- | --- |"]
        rows_h = []
        for n in v["nodes"]:
            if n["kind"] != "gate":
                continue
            g = n["gate"]
            for cid in g["checks"]:
                c = checks.get(cid)
                if not c or not c["on"]:
                    continue
                first, last = (c.get("first") or {}).get("value"), (c["last"] or {}).get("value")
                st = (c["last"] or {}).get("status") or "none"
                gate = "放行" if st == "pass" else GATE[c["gate"]] if st in BAD else CHECK_STATUS[st]
                row = [g["name"], f"{c['title']}（{c['rule']}）", f"{c['prio']} · ≤{int(c.get('max') or 0)}",
                       "—" if first is None else str(int(first)), "—" if last is None else str(int(last)), gate]
                rows_h.append(row)
                md.append("| " + " | ".join(row) + " |")
        md += ["", "## 软检测航向（负责人语义巡检结论）", "", "| 巡检 | 判断 | 判词 | 时间 |", "| --- | --- | --- | --- |"]
        rows_s = []
        verdict = {"pass": "契合", "warn": "预警", "fail": "偏离"}
        for c in cv["checks"]:
            if c["kind"] != "soft" or not c["on"]:
                continue
            last = c["last"]
            row = [c["title"], verdict.get(last["status"], "—") if last else "还没判断", clip(last["note"], 200) if last else clip(c["text"], 120),
                   last["ts"][:16].replace("T", " ") if last else ""]
            rows_s.append(row)
            md.append("| " + " | ".join(x.replace("|", "/") for x in row) + " |")

        def table(head: list[str], rows: list[list[str]]) -> str:
            return ("<table><thead><tr>" + "".join(f"<th>{html.escape(h)}</th>" for h in head) + "</tr></thead><tbody>"
                    + "".join("<tr>" + "".join(f"<td>{html.escape(x)}</td>" for x in r) + "</tr>" for r in rows) + "</tbody></table>")

        page = ("<!doctype html><html lang=\"zh\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
                f"<title>#{v['seq']} 研究回路汇报</title></head><body>"
                f"<h1>#{v['seq']} {html.escape(v['title'])} · 研究回路汇报</h1>"
                f"<p>第 {v['rounds']} 轮 · 硬卡口违规 {found['first'] if found['first'] is not None else '—'} → {found['now'] if found['now'] is not None else '—'} 处</p>"
                "<h2>硬限制质控（Before → After）</h2>" + table(["卡口", "规则", "要求", "R1", "现在", "门禁"], rows_h)
                + "<h2>软检测航向</h2>" + table(["巡检", "判断", "判词", "时间"], rows_s) + "</body></html>")
        return {"markdown": "\n".join(md), "html": page, "title": f"研究回路汇报 · 第 {v['rounds']} 轮"}

    def publish(self, line_id: str) -> dict:
        """The report as one of the project's pages (/progress/<n>/pages)."""
        r = self.report(line_id)
        return self.town.pages.publish(line_id, r["html"], r["title"], kind="report", by="Papertown")


GATE_STATE = {"pass": "放行", "warn": "告警", "block": "阻断", "none": "还没查", "off": "已关闭"}
