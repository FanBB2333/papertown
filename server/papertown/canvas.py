"""A project's research loop (研究回路), full-window in 进展: a free graph of the loop's nodes and the lines between them.

The loop is framed by the parts of the project's research flow, the same ones the console lists (pipeline.MODULES:
概览, 调研, 代码仓库, 实验, 数据, 论文, 员工). Each part is a block: a frame round the nodes that belong to it, which
is where they start and where 「按分块规整」 puts them back; nothing holds a node in its place. The blocks stand in
four rows, the same for every project: the overview and the agents, the survey, the code with the experiments and the
data, the paper. Every row is the whole width, and a block is as tall as what is in it: it grows and shrinks with its
nodes, and the rows under it make room (_fit, at every save). A stage belongs to
its part of the flow (pipeline.STAGE_MOD) and takes with it its hard gate (the stage's hard checks as one node, which
opens into a node per check), the soft sentinels that watch it (soft checks, checks.py: questions the lead judges)
and the rework and corrections they send back. The overview holds what bears on the whole project: the soft spec (what
the agents are told: the work boundaries' musts and the rules no code enforces), the hard clamp (the boundaries bound
to actions Papertown stops or asks you about) and the human gate, where what needs your decision collects (escalated
gates, stuck tasks, sentinels judged off course, questions). A task or a note is in the block the user put it in, and
changes block when it is dropped in another frame. In a block: the cards that show what the project has there (info
cards: the progress card and the outputs, the agents, the related work and the method, the code, the jobs and the
results, the datasets, the paper), beside them the stages and their gates in order with the sentinels over the stages
they watch, and under them the rework tickets, tasks and notes. A gate
whose blocking check fails locks the stage after it and sends a rework ticket back to the stage's agent, round after
round up to the stage's limit; past it the gate comes to the human gate.

A task node is a job for the lead, the coder or the writer: sending it delivers a <task> message with what the node
is wired to, and the agent closes it with `pt task <id> done|blocked "…"`, which also goes to the user as a report;
the user can send a result back with what is wrong, and the node keeps a log of all of it. A line has a kind (the
flow, a sentinel watching, the spec and the clamp, the loops back) or none (one the user drew), and can carry a few
words. An info card taken off the canvas can be put back.

The order of tasks is kept here, in code, not left to the agents. A line between two tasks is an order line (kind
"order") unless the user makes it a plain one: the task at its tail comes first. A task sent while one before it is
not done waits (status "queued") and goes out by itself once they all are; a task that is stuck holds what comes
after it; when a task is done again, what ran after it is marked to be looked at again ("stale") and holds its own
followers until the user says it still stands or redoes it. A project can also run one task per working directory at
a time ("exclusive"). Order lines may not close a ring: a loop is a gate's rework, not a ring of tasks.

    data/projects/<project>/canvas.json   nodes (id, kind, x, y and what each kind keeps), edges (kind, label),
                                          what was taken off
"""

from __future__ import annotations

import html
import json
import shlex
import secrets
import shutil
import threading
from pathlib import Path
from typing import TYPE_CHECKING

from .agents import ROLES, AgentError
from .checks import BAD, GATE, HARD_IDS, STATUS as CHECK_STATUS, CheckError, clip
from .db import now, write_json
from .pipeline import INDEX, MODULES, NAMES, STAGE_MOD

if TYPE_CHECKING:
    from .town import Town

TASK = {"draft": "还没发", "queued": "排队中", "sent": "已经发给它", "done": "完成", "blocked": "卡住了"}
TO = ("lead", "coder", "writer")
STAGE = {"todo": "没开始", "run": "进行中", "wait": "等用户", "done": "完成"}
NODES_MAX, EDGES_MAX, LOG_MAX, TRAIL_MAX = 300, 800, 40, 12
KIND = {"stage": "工序", "gate": "硬卡口", "hard": "硬检查", "soft": "软巡检", "spec": "软限制", "clamp": "硬边界",
        "human": "人类拍板", "task": "任务", "note": "备注", "info": "资料卡"}
EDGES = {"flow": "主推进", "watch": "巡检", "spec": "软限制注入", "clamp": "动作钳制", "hard_loop": "硬打回",
         "soft_loop": "软纠偏", "escalate": "升级", "member": "卡口的规则", "order": "先后顺序"}
# the cards that show the project live, in the order they stand in their block
INFO = {"card": "进展", "outputs": "预期产出", "agent:lead": "项目负责人", "agent:coder": "代码员工", "agent:writer": "写作员工",
        "survey": "相关工作", "method": "方法", "code": "代码", "runs": "实验任务", "results": "实验结果", "datasets": "数据集",
        "paper": "论文"}
FIXED = {"spec": "软限制规范", "clamp": "硬边界夹", "human": "人类拍板节点"}
# sizes, for where things go. A card is drawn as big as INFO_SIZE says (by the first part of its ref), whatever it holds
WIDTH = {"stage": 230, "gate": 250, "hard": 210, "soft": 290, "spec": 270, "clamp": 270, "human": 300, "task": 290, "note": 200, "info": 250}
HEIGHT = {"stage": 92, "gate": 96, "hard": 76, "soft": 96, "spec": 92, "clamp": 92, "human": 104, "task": 108, "note": 80, "info": 190}
INFO_SIZE = {"card": (300, 208), "outputs": (250, 208), "agent": (210, 76), "survey": (300, 190), "method": (280, 190)}
# The blocks (see _layout): the research flow's parts, in four rows from the top down, every row as wide as the
# widest and as tall as what is in it (_fit). PAD and HEAD are a frame's margin round its nodes and the room its header
# takes (the page draws the frames, Canvas.tsx, with the same two), BGAP the gap between two frames; in a block, GAP
# between a stage and its gate, ROW_GAP between its rows, CELL a task's place in the grid under them. MIN_W: a block
# with no stage of its own still has room for two tasks side by side.
BLOCKS = dict(MODULES)
BLOCK_ROWS = [["overview", "agents"], ["survey"], ["code", "exp", "data"], ["paper"]]
GAP, PAD, HEAD, BGAP, ROW_GAP = 64, 28, 64, 56, 44
SOFT_H, CELL = HEIGHT["soft"] + ROW_GAP, (WIDTH["task"] + 30, HEIGHT["task"] + 30)
MIN_W, MIN_H = {"code": 2 * CELL[0] - 30, "data": 2 * CELL[0] - 30}, HEIGHT["gate"]
STACKED = {"agents"}  # a block whose cards stand over its stages; in the others they stand to the left of them
AT = {"spec": (0, 0), "clamp": (0, 116), "human": (WIDTH["spec"] + 24, 52)}  # the fixed three, beside the overview's cards
INFO_MOD = {"card": "overview", "outputs": "overview", "agent:lead": "agents", "agent:coder": "agents", "agent:writer": "agents",
            "survey": "survey", "method": "survey", "code": "code", "runs": "exp", "results": "exp", "datasets": "data", "paper": "paper"}
LINKS = [("info:code", "info:results", "跑出")]  # lines the first layout draws between cards
TO_MOD = {"lead": "overview", "coder": "code", "writer": "paper"}  # where a task with nothing else to go by starts
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


def _kind_of(nid: str) -> str:
    return nid.split(":", 1)[0] if ":" in nid else nid


def _mod(n: dict, stage_of: dict[str, str]) -> str:
    """The block a node belongs to. A stage is in its part of the flow and takes its gate, its checks and what they
    send back with it; the fixed three and a check without a stage are in the overview; an info card is with what it
    shows; a task or a note is where the user put it. `stage_of`: each check's stage."""
    k = n["kind"]
    if k in ("stage", "gate"):
        return STAGE_MOD.get(n["ref"], "overview")
    if k in ("hard", "soft"):
        return STAGE_MOD.get(stage_of.get(n["ref"], ""), "overview")
    if k == "info":
        return INFO_MOD.get(n["ref"], "overview")
    if k == "task" and n.get("loop") == "hard":
        return STAGE_MOD.get(n.get("gate"), "overview")
    if k == "task" and n.get("loop") == "soft" and n.get("from") in stage_of:
        return STAGE_MOD.get(stage_of[n["from"]], "overview")
    return n["mod"] if k in ("task", "note") and n.get("mod") in BLOCKS else "overview"


def _size(n: dict) -> tuple[int, int]:
    if n["kind"] == "info":
        return INFO_SIZE.get(str(n.get("ref") or "").split(":")[0], (WIDTH["info"], HEIGHT["info"]))
    return WIDTH[n["kind"]], HEIGHT[n["kind"]]


def _frames(d: dict) -> dict[str, tuple[float, float, float, float]]:
    """Each block's frame (x0, y0, x1, y1): round its slot, which is round its nodes (_fit)."""
    return {m: (s["x"] - PAD, s["y"] - HEAD, s["x"] + s["w"] + PAD, s["y"] + s["h"] + PAD) for m, s in d["blocks"].items()}


def _block_at(frames: dict[str, tuple], x: float, y: float) -> str:
    """The block a task or a note put at a point joins: the one whose frame the point is in, or the nearest. Under a
    frame, down to where the next one's nodes start, is still the upper block's: where its next row of tasks goes."""
    def far(f: tuple) -> float:
        top, bottom = f[1] + HEAD - 16, f[3] + BGAP + HEAD - 16
        return max(f[0] - x, 0, x - f[2]) ** 2 + max(top - y, 0, y - bottom) ** 2
    return min(frames, key=lambda m: far(frames[m]))


def _rows(need: dict[str, tuple[int, int]]) -> dict[str, dict]:
    """Each block's slot from the room its nodes need (w, h). The rows stand one under the other and are equally
    wide: what a row has to spare is shared out among its blocks. A row is as tall as its tallest block."""
    span = 2 * PAD + BGAP
    wide = max(sum(need[m][0] for m in row) + span * (len(row) - 1) for row in BLOCK_ROWS)
    slots: dict[str, dict] = {}
    y = 0
    for row in BLOCK_ROWS:
        each, rest = divmod(wide - sum(need[m][0] for m in row) - span * (len(row) - 1), len(row))
        h, x = max(need[m][1] for m in row), 0
        for i, m in enumerate(row):
            w = need[m][0] + each + (1 if i < rest else 0)
            slots[m] = {"x": x, "y": y, "w": w, "h": h}
            x += w + span
        y += h + HEAD + PAD + BGAP
    return slots


def _fit(d: dict, stage_of: dict[str, str]) -> None:
    """The blocks round their nodes as they now are. A block is as big as its nodes need, measured from its corner (a
    node put left of or above the corner takes the corner there); the rows are laid out again from that (_rows), and
    each block's nodes go with their block. So a block grows and shrinks with what is in it, and what is under or
    beside it makes room."""
    by: dict[str, list[dict]] = {m: [] for m in BLOCKS}
    for n in d["nodes"]:
        by[_mod(n, stage_of)].append(n)
    was = d.get("blocks") or {}
    corner: dict[str, tuple[int, int]] = {}
    need: dict[str, tuple[int, int]] = {}
    for m, ns in by.items():
        xs, ys = [n["x"] for n in ns] + [was[m]["x"]] * (m in was), [n["y"] for n in ns] + [was[m]["y"]] * (m in was)
        x0, y0 = min(xs, default=0), min(ys, default=0)
        corner[m] = (x0, y0)
        need[m] = (max([MIN_W.get(m, WIDTH["task"])] + [n["x"] + _size(n)[0] - x0 for n in ns]),
                   max([MIN_H] + [n["y"] + _size(n)[1] - y0 for n in ns]))
    d["blocks"] = _rows(need)
    for m, ns in by.items():
        dx, dy = d["blocks"][m]["x"] - corner[m][0], d["blocks"][m]["y"] - corner[m][1]
        if dx or dy:
            for n in ns:
                n["x"], n["y"] = n["x"] + dx, n["y"] + dy


def _clear(d: dict, x: float, y: float, kind: str) -> tuple[int, int]:
    """From here, the first place to the right that no node is in."""
    w, h = WIDTH[kind], HEIGHT[kind]
    for _ in range(60):
        if not any(x < n["x"] + _size(n)[0] + 10 and n["x"] < x + w + 10 and y < n["y"] + _size(n)[1] + 10 and n["y"] < y + h + 10
                   for n in d["nodes"]):
            break
        x += w + 30
    return round(x), round(y)


def _layout(checks: list[tuple[str, str, str]], own: list[dict] | tuple = (), opened: set[str] | frozenset = frozenset(),
            cards: list[str] | tuple = tuple(INFO)) \
        -> tuple[list[dict], list[tuple[str, str, str]], dict[str, dict], dict[str, tuple[int, int]]]:
    """Where everything starts, block by block. The blocks stand in four rows, each the whole width: what the project
    is and who works on it (the overview, the agents), what is known (the survey), what is run (the code, the
    experiments, the data), what is written (the paper). In a block: the cards that show what the project has there
    on the left, to their right the stages and their gates in order with the sentinels over the stages they watch and
    an open gate's checks in a row under it, and below all that a grid for `own` (the user's tasks and notes, each
    saying its block in "mod"; they are placed in the order given). The agents' cards stand over their stage, which
    is then next to the row it sits between in the flow. The overview has the spec, the clamp and the human gate
    beside its cards, and the checks without a stage under them. The flow joins the stages and gates in order,
    across the blocks. `cards`: the cards on the canvas.
    Returns the loop's own nodes, the first lines, each block's slot, and where every node (and `own`) goes. It is
    only a start: from here it is the user's."""
    hard = {cid: stage for cid, kind, stage in checks if kind == "hard"}
    gated = {s for s in hard.values() if s in INDEX}
    spine: dict[str, list[str]] = {m: [] for m in BLOCKS}
    order: list[str] = []
    for k in INDEX:
        ids = [f"stage:{k}"] + ([f"gate:{k}"] if k in gated else [])
        spine[STAGE_MOD[k]] += ids
        order += ids
    watch: dict[str, list[tuple[str, str]]] = {m: [] for m in BLOCKS}
    for cid, kind, stage in checks:
        if kind == "soft":
            watch[STAGE_MOD.get(stage, "overview")].append((cid, stage))
    loose = [cid for cid, stage in hard.items() if stage not in INDEX]
    under = {stage: [cid for cid, s in hard.items() if s == stage] for stage in opened if stage in gated}
    shown = {m: [r for r in INFO if r in cards and INFO_MOD[r] == m] for m in BLOCKS}

    def run(n: int, w: int, gap: int) -> int:
        return n * (w + gap) - gap if n else 0

    local: dict[str, dict[str, tuple[int, int, int, int]]] = {m: {} for m in BLOCKS}  # in a block: id → x, y, w, h from its corner
    need: dict[str, tuple[int, int]] = {}
    for m in BLOCKS:
        p = local[m]

        def put(nid: str, x: float, y: float, kind: str, ref: str = "") -> None:
            p[nid] = (round(x), round(y), *_size({"kind": kind, "ref": ref}))

        x = 0
        for r in shown[m]:
            put(f"info:{r}", x, 0, "info", r)
            x += p[f"info:{r}"][2] + 24
        cards_w, cards_h = max(0, x - 24), max((p[f"info:{r}"][3] for r in shown[m]), default=0)
        if m == "overview":
            fx = cards_w + GAP if shown[m] else 0
            for k, (dx, dy) in AT.items():
                put(k, fx + dx, dy, k)
            y = max(cards_h, AT["clamp"][1] + HEIGHT["clamp"])
            for ids, kind, gap in ((loose, "hard", 14), ([cid for cid, _ in watch[m]], "soft", 24)):
                for j, cid in enumerate(ids):
                    put(f"check:{cid}", j * (WIDTH[kind] + gap), y + 24, kind)
                y += 24 + HEIGHT[kind] if ids else 0
        else:
            ids = spine[m]
            beside = bool(shown[m]) and m not in STACKED
            fx = cards_w + GAP if beside else 0
            fy = cards_h + ROW_GAP if shown[m] and not beside and (ids or watch[m]) else 0
            fw = max([sum(WIDTH[_kind_of(i)] for i in ids) + GAP * max(0, len(ids) - 1), run(len(watch[m]), WIDTH["soft"], 24),
                      *(run(len(under.get(i[5:], [])), WIDTH["hard"], 14) for i in ids if i.startswith("gate:"))])
            top = fy + (SOFT_H if watch[m] else 0)
            x = fx
            for nid in ids:
                put(nid, x, top, _kind_of(nid))
                x += WIDTH[_kind_of(nid)] + GAP
            # the sentinels: each wants to sit over its stage; going left to right, one pushes the next along
            want = sorted((p[f"stage:{stage}"][0] + WIDTH["stage"] / 2 if f"stage:{stage}" in p else fx, cid) for cid, stage in watch[m])
            x = fx
            for j, (centre, cid) in enumerate(want):
                x = max(x, round(centre - WIDTH["soft"] / 2))
                put(f"check:{cid}", x, fy, "soft")
                x += WIDTH["soft"] + 24
            for nid in ids:
                mine = under.get(nid[5:], []) if nid.startswith("gate:") else []
                total = run(len(mine), WIDTH["hard"], 14)
                x0 = min(max(round(p[nid][0] + WIDTH["gate"] / 2 - total / 2), fx), fx + fw - total)
                for j, cid in enumerate(mine):
                    put(f"check:{cid}", x0 + j * (WIDTH["hard"] + 14), top + HEIGHT["gate"] + 34, "hard")
            y = max([0] + [b[1] + b[3] for b in p.values()])
        wide = max([MIN_W.get(m, WIDTH["task"])] + [b[0] + b[2] for b in p.values()])
        cols = max(1, (wide + 30) // CELL[0])
        for j, n in enumerate([n for n in own if n.get("mod") == m]):
            put(n["id"], (j % cols) * CELL[0], (y + ROW_GAP if y else 0) + (j // cols) * CELL[1], n.get("kind") or "task")
        need[m] = (wide, max([MIN_H] + [b[1] + b[3] for b in p.values()]))

    slots = _rows(need)
    at = {nid: (slots[m]["x"] + b[0], slots[m]["y"] + b[1]) for m in BLOCKS for nid, b in local[m].items()}
    nodes = [{"id": nid, "kind": _kind_of(nid), "ref": nid.split(":", 1)[1], "x": at[nid][0], "y": at[nid][1]} for nid in order]
    nodes += [{"id": f"check:{cid}", "kind": "hard", "ref": cid, "x": at[f"check:{cid}"][0], "y": at[f"check:{cid}"][1]} for cid in loose]
    nodes += [{"id": f"check:{cid}", "kind": "soft", "ref": cid, "x": at[f"check:{cid}"][0], "y": at[f"check:{cid}"][1]}
              for cid, kind, _ in checks if kind == "soft"]
    nodes += [{"id": k, "kind": k, "x": at[k][0], "y": at[k][1]} for k in AT]
    nodes += [{"id": f"info:{r}", "kind": "info", "ref": r, "x": at[f"info:{r}"][0], "y": at[f"info:{r}"][1]} for m in BLOCKS for r in shown[m]]
    edges = [(a, b, "flow") for a, b in zip(order, order[1:])]
    edges += [(f"check:{cid}", f"stage:{stage}", "watch") for cid, kind, stage in checks if kind == "soft" and stage in INDEX]
    edges += [("spec", f"stage:{k}", "spec") for k in ("method", "write")] + [("clamp", "stage:exp", "clamp"), ("stage:review", "human", "escalate")]
    return nodes, edges, slots, at


class Canvas:
    def __init__(self, town: "Town"):
        self.town = town
        self.s = town.s
        self._lock = threading.RLock()
        self._binding: set[tuple[str, str]] = set()  # tasks whose session is being made, outside the lock

    def _path(self, line_id: str) -> Path:
        return self.s.projects_dir / line_id / "canvas.json"

    def _read(self, line_id: str) -> dict | None:
        """A missing canvas is new; an unreadable one must never be overwritten with an empty graph."""
        try:
            data = json.loads(self._path(line_id).read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except (OSError, ValueError) as e:
            raise CanvasError(f"读取画布失败，原文件已保留：{e}") from e
        if not isinstance(data, dict) or not isinstance(data.get("nodes"), list):
            raise CanvasError("画布数据格式无效，原文件已保留")
        return data

    def _save(self, line_id: str, d: dict) -> None:
        """Written with the blocks fitted round their nodes as they now are."""
        _fit(d, self._stage_of(line_id))
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

    def _edge(self, d: dict, source: str, target: str, kind: str | None = None, label: str = "") -> dict | None:
        if any({e["source"], e["target"]} == {source, target} for e in d["edges"]):
            return None
        e = {"id": self._id(d, "e"), "source": source, "target": target}
        if kind:
            e["kind"] = kind
        if label:
            e["label"] = label
        d["edges"].append(e)
        return e

    def _load(self, line_id: str) -> dict:
        """The canvas as saved: laid out the first time, moved over once from an older layout (the canvas before the
        loop, the loop in three lanes; the file as it was is kept beside it), and kept in step with the project's
        checks (a new check gets its node, a check that is gone loses it)."""
        with self._lock:
            d = self._read(line_id)
            checks = self._checks(line_id)
            if d is None:
                nodes, edges, slots, _ = _layout(checks)
                d = {"v": 3, "nodes": nodes, "edges": [], "gone": [], "next": 1, "blocks": slots}
                for a, b, kind in edges:
                    self._edge(d, a, b, kind)
                for a, b, label in LINKS:
                    self._edge(d, a, b, None, label)
                self._save(line_id, d)
                return d
            d.setdefault("edges", [])
            d.setdefault("gone", [])
            d.setdefault("next", 1)
            changed = False
            if d.get("v") != 3:
                old = self._path(line_id).with_name("canvas.before-blocks.json")
                if not old.exists():
                    shutil.copyfile(self._path(line_id), old)
                if d.get("v") != 2:
                    self._migrate(d, checks)
                self._to_blocks(d, checks)
                changed = True
            changed |= self._sync(d, checks)
            ids = {n["id"] for n in d["nodes"]}
            edges = [e for e in d["edges"] if e["source"] in ids and e["target"] in ids]
            if changed or len(edges) != len(d["edges"]):
                d["edges"] = edges
                self._save(line_id, d)
            return d

    def _migrate(self, d: dict, checks: list[tuple[str, str, str]]) -> None:
        """A canvas from before the loop: the loop's own nodes, with the user's tasks and notes and the lines drawn to
        them kept (a line to a hard check goes to its gate; info cards come off). _to_blocks then places it all."""
        stage_of = {cid: stage for cid, kind, stage in checks if kind == "hard"}
        mine = [n for n in d["nodes"] if n["kind"] in ("task", "note")]
        gone = [g for g in d["gone"] if not g.startswith("info:")]
        nodes, edges, _, _ = _layout(checks)
        nodes = [n for n in nodes if n["id"] not in gone]
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

    def _to_blocks(self, d: dict, checks: list[tuple[str, str, str]]) -> None:
        """A loop laid out in three lanes: every node goes to its block. A task or a note joins the block of what it
        is wired to (a stage, a gate or a check first, then a task that has one), or the block of whom it is for;
        each block gets its cards, and everything is laid out afresh; the lines stay."""
        stage_of = {cid: stage for cid, _, stage in checks}
        by = {n["id"]: n for n in d["nodes"]}
        loose = [n for n in d["nodes"] if n["kind"] in ("task", "note") and not n.get("loop") and n.get("mod") not in BLOCKS]
        rank = {"stage": 0, "gate": 0, "hard": 0, "soft": 0, "task": 1, "info": 2}

        def settle() -> None:
            for _ in range(3):
                for n in loose:
                    if "mod" in n:
                        continue
                    near = [by[b] for e in d["edges"] for a, b in ((e["source"], e["target"]), (e["target"], e["source"])) if a == n["id"] and b in by]
                    near = sorted((x for x in near if x not in loose or "mod" in x), key=lambda x: rank.get(x["kind"], 3))
                    if near and rank.get(near[0]["kind"], 3) < 3:
                        n["mod"] = _mod(near[0], stage_of)

        settle()
        for n in loose:
            if n["kind"] == "task":
                n.setdefault("mod", TO_MOD.get(n.get("to"), "overview"))
        settle()  # a note wired to a task that had nothing to go by
        for n in loose:
            n.setdefault("mod", "overview")
        d["nodes"] = [n for n in d["nodes"] if n["kind"] != "info" or n.get("ref") in INFO]
        d["nodes"] += [{"id": f"info:{r}", "kind": "info", "ref": r, "x": 0, "y": 0} for r in INFO if f"info:{r}" not in by]
        for a, b, label in LINKS:
            self._edge(d, a, b, None, label)
        d["v"] = 3
        self._arrange(d, checks)

    def _arrange(self, d: dict, checks: list[tuple[str, str, str]]) -> None:
        """Every node where its block starts it (see _layout), and the first layout's lines drawn again. In a block's
        grid: the rework tickets and corrections, then the tasks in the order their lines set, then the notes."""
        stage_of = {cid: stage for cid, _, stage in checks}
        before: dict[str, list[str]] = {}
        for e in d["edges"]:
            if e.get("kind") == "order":
                before.setdefault(e["target"], []).append(e["source"])
        depth: dict[str, int] = {}

        def deep(nid: str) -> int:
            if nid not in depth:
                depth[nid] = 0  # an order line cannot close a ring, and this keeps a bad file from looping
                depth[nid] = 1 + max((deep(x) for x in before.get(nid, [])), default=-1)
            return depth[nid]

        kinds = {"task": 2, "note": 3}
        own = [(0 if n.get("loop") == "hard" else 1 if n.get("loop") == "soft" else kinds[n["kind"]], deep(n["id"]), i, n)
               for i, n in enumerate(d["nodes"]) if n["kind"] in kinds]
        opened = {n["ref"] for n in d["nodes"] if n["kind"] == "gate" and n.get("open")}
        _, edges, slots, at = _layout(checks, [{"id": n["id"], "mod": _mod(n, stage_of), "kind": n["kind"]} for *_, n in sorted(own, key=lambda o: o[:3])],
                                      opened, [n["ref"] for n in d["nodes"] if n["kind"] == "info"])
        for n in d["nodes"]:
            if n["id"] in at:
                n["x"], n["y"] = at[n["id"]]
        d["blocks"] = slots
        have = {n["id"] for n in d["nodes"]}
        for a, b, kind in edges:
            if a in have and b in have:
                self._edge(d, a, b, kind)

    def _sync(self, d: dict, checks: list[tuple[str, str, str]]) -> bool:
        """Nodes for what the project has now: a gate for each stage with hard checks, a node for each sentinel, for
        each hard check without a stage and for each check of an open gate, and the fixed three."""
        hard = {cid: stage for cid, kind, stage in checks if kind == "hard"}
        soft = {cid: stage for cid, kind, stage in checks if kind == "soft"}
        stage_of = hard | soft
        gated = {s for s in hard.values() if s in INDEX}
        if not d.get("blocks"):
            d["blocks"] = _layout(checks)[2]
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
            if f"gate:{stage}" in have or f"gate:{stage}" in d["gone"]:
                continue
            s = have.get(f"stage:{stage}")
            x, y = _clear(d, s["x"] + WIDTH["stage"] + GAP // 2, s["y"] + HEIGHT["stage"] + 40, "gate") if s else self._place(d, stage_of, STAGE_MOD[stage], "gate")
            put({"id": f"gate:{stage}", "kind": "gate", "ref": stage, "x": x, "y": y}, (f"stage:{stage}", f"gate:{stage}", "flow"))
        for cid, stage in soft.items():  # over the stage it watches; without one, in the overview
            if f"check:{cid}" in have or f"check:{cid}" in d["gone"]:
                continue
            s = have.get(f"stage:{stage}")
            x, y = _clear(d, s["x"], s["y"] - SOFT_H, "soft") if s else self._place(d, stage_of, "overview", "soft")
            put({"id": f"check:{cid}", "kind": "soft", "ref": cid, "x": x, "y": y}, (f"check:{cid}", f"stage:{stage}", "watch"))
        for cid in [cid for cid, stage in hard.items() if stage not in INDEX]:
            if f"check:{cid}" not in have and f"check:{cid}" not in d["gone"]:
                x, y = self._place(d, stage_of, "overview", "hard")
                put({"id": f"check:{cid}", "kind": "hard", "ref": cid, "x": x, "y": y})
        for stage in opened & gated:
            self._open_at(d, stage, [cid for cid, s in hard.items() if s == stage], have, put)
        for k in FIXED:
            if k not in have and k not in d["gone"]:
                x, y = self._place(d, stage_of, "overview", k)
                put({"id": k, "kind": k, "x": x, "y": y})
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
        return {"id": n["id"], "kind": n["kind"], "ref": n.get("ref"), "x": n["x"], "y": n["y"], "w": _size(n)[0], "mod": _mod(n, self._stage_of(line_id)), "label": self._label(line_id, n)}

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

    def _stage_of(self, line_id: str) -> dict[str, str]:
        return {cid: stage for cid, _, stage in self._checks(line_id)}

    @staticmethod
    def _place(d: dict, stage_of: dict[str, str], mod: str, kind: str, near: dict | None = None, ref: str = "") -> tuple[int, int]:
        """Somewhere free in a block for a node nobody placed: the first free place in the grid under what the block
        starts with (its cards, its stages and checks), from under `near` when it is said what the node goes with."""
        ns = [n for n in d["nodes"] if _mod(n, stage_of) == mod]
        slot, (w, h) = d["blocks"][mod], _size({"kind": kind, "ref": ref})
        first = [n for n in ns if n["kind"] not in ("task", "note")]
        top = max(n["y"] + _size(n)[1] for n in first) + ROW_GAP if first else slot["y"]
        wide = max([MIN_W.get(mod, WIDTH["task"])] + [n["x"] + _size(n)[0] - slot["x"] for n in ns])
        cols = max(1, (wide + 30) // CELL[0])
        start = min(cols - 1, max(0, round((near["x"] - slot["x"]) / CELL[0]))) if near else 0
        for i in range(start, start + 400):
            x, y = slot["x"] + (i % cols) * CELL[0], top + (i // cols) * CELL[1]
            if not any(x < n["x"] + _size(n)[0] + 10 and n["x"] < x + w + 10 and y < n["y"] + _size(n)[1] + 10 and n["y"] < y + h + 10 for n in d["nodes"]):
                break
        return x, y

    def spot(self, line_id: str, mod: str = "overview", kind: str = "task", near: str | None = None) -> tuple[int, int]:
        """Somewhere free in a block for a node nobody placed, under the node `near` when one is said."""
        d = self._load(line_id)
        return self._place(d, self._stage_of(line_id), mod if mod in BLOCKS else "overview", kind, next((n for n in d["nodes"] if n["id"] == near), None))

    def outline(self, line_id: str) -> str:
        """The canvas in words: every node with its id and how it stands, and the lines between them."""
        v = self.view(line_id)
        out = [f"#{v['seq']}「{clip(v['title'], 40)}」的研究回路（第 {v['rounds']} 轮）。节点按研究流程的分块列出（编号 · 种类 · 名字 · 现在怎样）："]
        said: str | None = None
        for n in sorted(v["nodes"], key=lambda n: list(BLOCKS).index(n["mod"])):
            if n["mod"] != said:
                said = n["mod"]
                out.append(f"【{BLOCKS[said]}】")
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
                    + ("，结果待复核" if n.get("stale") else "") \
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
        empty = [t for m, t in MODULES if not any(n["mod"] == m for n in v["nodes"])]
        if empty:
            out.append("还没有节点的分块：" + "、".join(empty))
        out += ["", "连线（圆括号里是线的种类，方括号里是线上写的字）："]
        out += [f"- {e['source']} {'→' if e.get('kind') == 'order' else '—'} {e['target']}" + (f"（{EDGES[e['kind']]}）" if e.get("kind") else "") + (f" [{e['label']}]" if e.get("label") else "")
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
        stage_of = {c["id"]: c.get("stage") or "" for c in cv["checks"]}
        nodes = []
        for n in d["nodes"]:
            out = {"id": n["id"], "kind": n["kind"], "x": n["x"], "y": n["y"], "mod": _mod(n, stage_of)}
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
                out |= {"ref": n["ref"], "title": INFO[n["ref"]], "w": _size(n)[0], "h": _size(n)[1]}
            elif n["kind"] == "task":
                out |= {k: n.get(k) for k in ("title", "text", "to", "status", "sent_at", "done_at", "result", "by", "created_at", "dispatch")}
                out["agent_id"] = n.get("agent_id")
                out["agent"] = self.town.agents.public(self.assignee(line_id, n))
                out |= {"stale": n.get("stale"), "queued_at": n.get("queued_at"), "wait_note": n.get("wait_note"),
                        "waits": self._waits(line_id, d, n) if n["status"] == "queued" else []}
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
                "blocks": [{"key": m, "title": t, **d["blocks"][m]} for m, t in MODULES], "rows": BLOCK_ROWS, "checks": cv["checks"], "summary": cv["summary"], "tasks": {k: sum(1 for t in on if t["status"] == k) for k in TASK},
                "rules": {"exclusive": bool(d.get("exclusive"))},
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
                "open": bool(n.get("open")), "waived": bool(n.get("waived")), "reached": (stages.get(stage) or {}).get("status") in ("run", "fail", "wait", "done"),
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
            if t.get("stale") and t.get("status") in ("done", "blocked"):
                out.append({"kind": "stale", "id": t["id"], "text": f"「{clip(t.get('title'), 30)}」的结果待复核：{t['stale']}"})
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
            prio: str = "P1", link: str | None = None, send: bool = False, mod: str | None = None) -> dict:
        """A new node where the user put it, wired to the node it was drawn from: a task (sent at once when asked),
        a check of the user's own, or a note. A task drawn from a sentinel is a correction: it goes back to the
        stage the sentinel watches. A task or a note joins the block whose frame it lands in, or the nearest (`mod`
        says so outright)."""
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
            if kind in ("task", "note") and not node.get("loop"):
                node["mod"] = mod if mod in BLOCKS else _block_at(_frames(d), node["x"] + WIDTH[kind] / 2, node["y"] + HEIGHT[kind] / 2)
            d["nodes"].append(node)
            if src:
                if node.get("loop") == "soft":
                    self._edge(d, src["id"], node["id"], "soft_loop")
                    for e in [e for e in d["edges"] if e.get("kind") == "watch" and e["source"] == src["id"]]:
                        self._edge(d, node["id"], e["target"], "soft_loop")
                elif kind == "soft" and src["kind"] == "stage":
                    self._edge(d, node["id"], src["id"], "watch")
                else:
                    self._edge(d, src["id"], node["id"], "order" if kind == "task" and self._plain(src) else None)
            self._save(line_id, d)
        if kind == "task" and send:
            self.send(line_id, node["id"])
        self._changed(line_id)
        return {**self.view(line_id), "added": node["id"]}

    def set(self, line_id: str, node_id: str, title: str | None = None, text: str | None = None, to: str | None = None,
            status: str | None = None, stale: bool | None = None) -> dict:
        """Edit a task or a note. (A check's own settings are the checks' to change.) A task marked done lets what
        waits for it go; one opened again marks what ran after it; `stale` False says its result still stands."""
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
                    if to != n["to"] and n.get("agent_id"):
                        raise CanvasError("这个节点已经绑定了独立会话，岗位随会话保留")
                    n["to"] = to
                if status is not None:
                    if status not in ("draft", "done"):
                        raise CanvasError("只能标成完成，或者重新打开")
                    if status == "draft" and n["status"] in ("done", "blocked"):
                        self._redo(d, n)
                    unqueued = status == "draft" and n["status"] == "queued"
                    n |= {"status": status, "done_at": now() if status == "done" else None, "by": "你" if status == "done" else "",
                          "result": n.get("result") if status == "done" else ""}
                    for k in ("queued_at", "wait_note", "back", "stale"):
                        n.pop(k, None)
                    _log(n, "marked" if status == "done" else "unqueued" if unqueued else "reopened")
                if stale is False and n.get("stale"):  # you looked at it: it still stands
                    n.pop("stale")
                    _log(n, "kept")
            elif n["kind"] == "note":
                if text is not None:
                    if not text.strip():
                        raise CanvasError("备注是空的")
                    n["text"] = text.strip()[:2000]
            else:
                raise CanvasError("这个节点在它自己的设置里改")
            self._save(line_id, d)
        self._advance(line_id)
        self._changed(line_id)
        return self.view(line_id)

    def move(self, line_id: str, at: dict[str, list[float]], blocks: dict[str, list[float]] | None = None) -> dict:
        """Nodes where the user dragged them. A task or a note dropped in another block's frame joins that block (the
        answer says which, in "mods"). The blocks are then fitted round their nodes again: the answer says each
        block's slot ("blocks") and every node that went somewhere other than where it was or was put ("at"), such as
        the rows under a block that grew. `blocks` puts a whole layout back (each slot's x, y, w, h, with every node in
        `at`): then every task and note is of the block it is in."""
        mods: dict[str, str] = {}
        with self._lock:
            d = self._load(line_id)
            stage_of = self._stage_of(line_id)
            put: dict[str, tuple[int, int]] = {}
            for n in d["nodes"]:
                if n["id"] in at and len(at[n["id"]]) == 2:
                    n["x"], n["y"] = round(float(at[n["id"]][0])), round(float(at[n["id"]][1]))
                    put[n["id"]] = (n["x"], n["y"])
            was = {n["id"]: put.get(n["id"], (n["x"], n["y"])) for n in d["nodes"]}
            for m, to in (blocks or {}).items():
                if m in BLOCKS and len(to) == 4:
                    d["blocks"][m] = dict(zip("xywh", (round(float(v)) for v in to)))
            frames = _frames(d)
            for n in d["nodes"]:
                if n["kind"] in ("task", "note") and not n.get("loop") and (blocks or n["id"] in put):
                    m = _block_at(frames, n["x"] + WIDTH[n["kind"]] / 2, n["y"] + HEIGHT[n["kind"]] / 2)
                    if m != _mod(n, stage_of):
                        n["mod"] = mods[n["id"]] = m
            self._save(line_id, d)
            went = {n["id"]: [n["x"], n["y"]] for n in d["nodes"] if (n["x"], n["y"]) != was[n["id"]]}
            slots = {m: [b["x"], b["y"], b["w"], b["h"]] for m, b in d["blocks"].items()}
        return {"ok": True, "mods": mods, "blocks": slots, "at": went}

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
            elif n["kind"] == "task" and n.get("agent_id"):  # its own session stops with it
                try:
                    self.town.agents.retire(n["agent_id"], f"任务节点 {node_id} 已从研究回路删除")
                except AgentError as e:
                    raise CanvasError(f"{e}，任务节点已保留") from e
            d["nodes"] = [x for x in d["nodes"] if x["id"] != node_id]
            d["edges"] = [e for e in d["edges"] if node_id not in (e["source"], e["target"])]
            self._save(line_id, d)
        self._advance(line_id)
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
                x, y = self._place(d, self._stage_of(line_id), INFO_MOD[ref], "info", ref=ref)
                d["nodes"].append({"id": node_id, "kind": "info", "ref": ref, "x": x, "y": y})
                self._save(line_id, d)
                self._changed(line_id)
                return {**self.view(line_id), "added": node_id}
            if node_id not in d["gone"]:
                raise CanvasError("这个节点没有被移走")
            d["gone"].remove(node_id)
            first, _, slots, _ = _layout(self._checks(line_id))
            at = next((n for n in first if n["id"] == node_id), None)
            if kind != "check" and at:  # where the first layout has it in its block, in the block as it now stands
                m = _mod(at, {})
                d["nodes"].append(at | {"x": at["x"] - slots[m]["x"] + d["blocks"][m]["x"], "y": at["y"] - slots[m]["y"] + d["blocks"][m]["y"]})
            self._save(line_id, d)
            if kind == "check":
                self.town.checks.set(line_id, ref, on=True)  # the next load gives it its node back
        self._changed(line_id)
        return self.view(line_id)

    def connect(self, line_id: str, source: str, target: str) -> dict:
        """A line of the user's own. Between two tasks it is an order line (the first before the second), unless that
        would close a ring: then it is a plain one."""
        with self._lock:
            d = self._load(line_id)
            a, b = self._node(d, source), self._node(d, target)
            if source == target:
                raise CanvasError("节点不能连到自己")
            if len(d["edges"]) >= EDGES_MAX:
                raise CanvasError("连线太多了")
            order = self._plain(a) and self._plain(b) and not self._loops(d, source, target)
            self._edge(d, source, target, "order" if order else None)
            self._save(line_id, d)
        self._advance(line_id)
        self._changed(line_id)
        return self.view(line_id)

    def order(self, line_id: str, edge_id: str, on: bool | None = None, flip: bool = False) -> dict:
        """Make a line between two tasks an order line or a plain one again, or turn an order line round."""
        with self._lock:
            d = self._load(line_id)
            e = next((x for x in d["edges"] if x["id"] == edge_id), None)
            if not e:
                raise CanvasError("回路上没有这条线")
            if e.get("kind") not in (None, "order"):
                raise CanvasError("这条线由回路生成，种类不可修改")
            want = e.get("kind") == "order" if on is None else bool(on)
            source, target = (e["target"], e["source"]) if flip else (e["source"], e["target"])
            e.pop("kind", None)
            if want:
                by = {n["id"]: n for n in d["nodes"]}
                if not (self._plain(by.get(source)) and self._plain(by.get(target))):
                    raise CanvasError("先后顺序只能设在两个任务之间，修补单的先后由卡口决定")
                if self._loops(d, source, target):
                    raise CanvasError("先后顺序不能连成环。需要反复执行的工作请交给硬卡口的修补单")
                e["kind"] = "order"
            e |= {"source": source, "target": target}
            self._save(line_id, d)
        self._advance(line_id)
        self._changed(line_id)
        return self.view(line_id)

    def rules(self, line_id: str, exclusive: bool) -> dict:
        """The project's rule for tasks that share a working directory: one at a time, or as they come."""
        with self._lock:
            d = self._load(line_id)
            d["exclusive"] = bool(exclusive)
            self._save(line_id, d)
        self._advance(line_id)
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
        self._advance(line_id)
        self._changed(line_id)
        return self.view(line_id)

    def tidy(self, line_id: str) -> dict:
        """按分块规整: every block as it starts. Its cards, its stages, gates and checks and the fixed three in their
        places, an open gate's checks under it, and each block's rework, tasks and notes in a grid under them; the
        lines of the first layout are drawn again, and the user's lines stay."""
        with self._lock:
            d = self._load(line_id)
            self._arrange(d, self._checks(line_id))
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
                         **dict(zip("xy", self._place(d, self._stage_of(line_id), STAGE_MOD.get(stage, "overview"), "task", gn)))}
                    _log(t, "made", f"「{g['name']}」硬卡口阻断，Papertown 写了第 1 轮修补单", by="Papertown")
                    d["nodes"].append(t)
                    self._edge(d, gn["id"], t["id"], "hard_loop")
                    self._edge(d, t["id"], f"stage:{stage}", "hard_loop")
                    changed = True
                    if g["policy"]["auto"] or force == stage:
                        send.append(t["id"])
                    continue
                if t["status"] in ("draft", "queued", "sent"):
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
        """What a task is wired to, in words, for the agent that gets it. An order line says which side of it the other
        task is on, and a task before it that is done hands over its result."""
        v = self.view(line_id)
        by = {n["id"]: n for n in v["nodes"]}
        now_ = {n["id"]: n for n in d["nodes"] if n["kind"] == "task"}  # the tasks as they stand in this change, saved or not
        near = {(e["target"] if e["source"] == node["id"] else e["source"]): e for e in d["edges"] if node["id"] in (e["source"], e["target"])}
        out = []
        for nid, e in near.items():
            n, label = by.get(nid), e.get("label")
            if not n:
                continue
            if nid in now_:
                n = n | {k: now_[nid].get(k) for k in ("status", "result", "stale")}
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
                if e.get("kind") == "order" and e["target"] == node["id"]:
                    what = "前序" + what + "：它的产出在工作目录里" \
                        + (f"，它交回的结果是「{clip(n['result'], 400)}」" if n["status"] == "done" and n.get("result") else "") \
                        + ("（这份结果待用户复核）" if n.get("stale") else "")
                elif e.get("kind") == "order":
                    what = "后续" + what + "：你完成后才会派发给它，把它需要的产出留在工作目录里"
            elif n["kind"] == "note":
                what = f"备注：{clip(n.get('text'), 300)}"
            elif n["kind"] == "info":
                what = f"项目的{INFO.get(n['ref'], n['ref'])}"
            elif n["kind"] in ("spec", "clamp"):
                what = f"{FIXED[n['kind']]}：" + ("；".join(clip(r["text"], 80) for r in n["rules"]) or "还没有写进工作边界的条目")
            if what:
                out.append(what + (f"［线上写着：{label}］" if label else ""))
        return out

    # the order of tasks, kept in code: order lines, and what they hold back

    @staticmethod
    def _plain(n: dict | None) -> bool:
        """A task whose turn the user decides: a gate's rework ticket goes by its gate."""
        return bool(n) and n["kind"] == "task" and n.get("loop") != "hard"

    @staticmethod
    def _before(d: dict, n: dict) -> list[dict]:
        """The tasks that order lines put before this one."""
        by = {x["id"]: x for x in d["nodes"] if x["kind"] == "task"}
        return [by[e["source"]] for e in d["edges"] if e.get("kind") == "order" and e["target"] == n["id"] and e["source"] in by]

    @staticmethod
    def _after(d: dict, n: dict) -> list[dict]:
        by = {x["id"]: x for x in d["nodes"] if x["kind"] == "task"}
        return [by[e["target"]] for e in d["edges"] if e.get("kind") == "order" and e["source"] == n["id"] and e["target"] in by]

    def _chain(self, d: dict, n: dict) -> list[dict]:
        """Every task after this one along the order lines, nearest first."""
        seen, todo, out = {n["id"]}, [n], []
        while todo:
            for t in self._after(d, todo.pop(0)):
                if t["id"] not in seen:
                    seen.add(t["id"])
                    todo.append(t)
                    out.append(t)
        return out

    @staticmethod
    def _loops(d: dict, source: str, target: str) -> bool:
        """Would an order line from source to target close a ring?"""
        seen, todo = set(), [target]
        while todo:
            x = todo.pop()
            if x == source:
                return True
            if x not in seen:
                seen.add(x)
                todo += [e["target"] for e in d["edges"] if e.get("kind") == "order" and e["source"] == x]
        return False

    def _waits(self, line_id: str, d: dict, n: dict) -> list[dict]:
        """Why a task cannot go out yet: the tasks before it that are not done, or done on a result that is to be
        looked at again; then, when the project runs one task per working directory, the task at work in its own."""
        out = [{"kind": "after", "id": u["id"], "title": u["title"], "status": u["status"], "stale": bool(u.get("stale"))}
               for u in self._before(d, n) if u["status"] != "done" or u.get("stale")]
        if out or not d.get("exclusive"):
            return out
        cwd = (self.assignee(line_id, n) or {}).get("cwd")
        for t in d["nodes"]:
            if cwd and t["kind"] == "task" and t["id"] != n["id"] and t["status"] == "sent" and (self.assignee(line_id, t) or {}).get("cwd") == cwd:
                return [{"kind": "dir", "id": t["id"], "title": t["title"], "status": "sent", "stale": False}]
        return []

    def _redo(self, d: dict, n: dict) -> None:
        """A task that is being done again: what ran after it did so on a result that no longer stands. Each of those
        is marked to be looked at again, and holds what follows it until the user says it still stands or redoes it."""
        why = f"前序任务 {n['id']}「{clip(n['title'], 30)}」已重做"
        for t in self._chain(d, n):
            if t["status"] in ("sent", "done", "blocked") and not t.get("stale"):
                t["stale"] = why
                _log(t, "stale", why, by="Papertown")

    def _deliver(self, line_id: str, d: dict, n: dict) -> None:
        """Hand a task to its agent now: the <task> message with what the node is wired to, or what the user sent back."""
        a = self.assignee(line_id, n)
        if not a:
            raise CanvasError(f"这个项目的{ROLES[n['to']]['name']}还没有启动：先在「员工」面板里启动它，任务会留在回路上")
        back = n.get("back")
        again = n["status"] not in ("draft", "queued") or any(x["kind"] in ("sent", "resent") for x in n.get("log") or [])
        if back:
            body = [f'<task id="{n["id"]}">', f"用户看了你对研究回路上「{n['title']}」这件事交回的结果，退回来了：", "", back]
            if n.get("result"):
                body += ["", f"你上次回的是：{clip(n['result'], 600)}"]
        else:
            if n.get("loop") == "hard":
                head = f"Papertown 的研究回路把这件事打回给你（第 {n.get('round') or 1} 轮修补单）：「{n['title']}」"
            elif n.get("loop") == "soft":
                head = ("用户改了研究回路上这件事，按新的来：" if again else "研究回路上的软巡检发现了偏差，用户派你纠偏：") + f"「{n['title']}」"
            else:
                head = ("用户改了研究回路上这件事，按新的来：" if again else "用户在研究回路上给你派了一件事：") + f"「{n['title']}」"
            body = [f'<task id="{n["id"]}">', head]
            if n.get("text"):
                body += ["", n["text"]]
            around = self._around(line_id, d, n)
            if around:
                body += ["", "它在回路上连着这些（连着检查或卡口的，做完要让它通过）：", *[f"- {x}" for x in around]]
        dispatch = secrets.token_hex(8)
        body += ["", self._reply_instructions(a, n, dispatch), "</task>"]
        self.town.agents.say(a["id"], "\n".join(body), "queue", origin="papertown")
        n |= {"status": "sent", "sent_at": now(), "done_at": None, "by": "", "dispatch": dispatch}
        if back:
            n["escalated"] = False
            _log(n, "back", back)
        else:
            n["result"] = ""
            _log(n, "resent" if again else "sent", by=f"给{ROLES[n['to']]['name']}")
        for k in ("back", "queued_at", "wait_note", "stale"):
            n.pop(k, None)

    def _dispatch(self, line_id: str, d: dict, n: dict) -> bool:
        """Send a task, or put it in the queue when its turn has not come. True when it went out."""
        waits = [] if n["status"] == "sent" else self._waits(line_id, d, n)  # one at work already hears a change at once
        if not waits:
            self._deliver(line_id, d, n)
            return True
        if not self.assignee(line_id, n):
            raise CanvasError(f"这个项目的{ROLES[n['to']]['name']}还没有启动：先在「员工」面板里启动它，任务会留在回路上")
        self._enqueue(n, waits)
        return False

    @staticmethod
    def _enqueue(n: dict, waits: list[dict]) -> None:
        """Into the queue, with what it waits for on its log. (_advance sends it once nothing holds it.)"""
        n |= {"status": "queued", "queued_at": now(), "done_at": None, "by": ""}
        _log(n, "queued", "等待前序任务完成" if not waits else "等待" + "、".join(f"{w['id']}「{clip(w['title'], 20)}」" for w in waits)
             + ("释放工作目录" if waits[0]["kind"] == "dir" else "完成" if not any(w["stale"] for w in waits) else "完成并复核"), by="Papertown")

    def _advance(self, line_id: str) -> bool:
        """Send every queued task whose turn has come, the longest waiting first. One that cannot be delivered stays
        in the queue with the reason, and is tried again the next time anything on the canvas moves."""
        if not self._path(line_id).exists():
            return False
        moved, failed = False, []
        with self._lock:
            d = self._load(line_id)
            for n in sorted((x for x in d["nodes"] if x["kind"] == "task" and x["status"] == "queued"), key=lambda x: x.get("queued_at") or ""):
                if self._waits(line_id, d, n):
                    continue
                try:
                    self._deliver(line_id, d, n)
                except (CanvasError, AgentError) as e:
                    if n.get("wait_note") == str(e):
                        continue
                    n["wait_note"] = str(e)
                    failed.append((n["title"], str(e)))
                else:
                    _log(n, "relay", by="Papertown")
                    n["log"][-2:] = n["log"][-2:][::-1]  # its turn came, then it went out
                moved = True
                self._save(line_id, d)  # the next one's message reads the canvas as it now stands
        for title, why in failed:
            self.town.message(line_id, "system", None, "text", {"text": f"研究回路上的任务「{title}」已轮到，但派发失败：{why}"})
        if moved:
            self._changed(line_id)
        return moved

    @staticmethod
    def _assignee_id(line_id: str, node: dict) -> str:
        return node.get("agent_id") or f"{node['to']}-{line_id}"

    def assignee(self, line_id: str, node: dict) -> dict | None:
        a = self.town.agents.get(self._assignee_id(line_id, node))
        return a if a and a["line_id"] == line_id and a["runtime"] else None

    def active_for(self, agent: dict) -> bool:
        data = self._read(agent["line_id"])
        return any(n["kind"] == "task" and n["status"] == "sent" and self._assignee_id(agent["line_id"], n) == agent["id"]
                   for n in data["nodes"]) if data else False

    def _can_close(self, agent: dict, node: dict) -> bool:
        return (agent["id"] == self._assignee_id(agent["line_id"], node)
                or (not node.get("agent_id") and agent["id"] == f"lead-{agent['line_id']}"))

    def bind(self, line_id: str, node_id: str, provider: str | None = None, model: str | None = None,
             thinking: str | None = None, ext_id: str | None = None) -> dict:
        """Bind a task to its own native Paseo session; its project role remains a prompt template. The session is made
        without holding the canvas lock (Paseo's CLI can take a while), and the task is checked again before it is bound:
        a task deleted, sent, rebound or given to another role meanwhile leaves the new session stopped."""
        key = (line_id, node_id)
        with self._lock:
            n = self._node(self._load(line_id), node_id)
            if n["kind"] != "task" or n["status"] != "draft":
                raise CanvasError("只有尚未派发的任务能绑定会话，请先重新打开任务")
            if n.get("agent_id"):
                raise CanvasError("这个节点已经绑定了会话")
            if key in self._binding:
                raise CanvasError("该节点正在安排 Agent，请稍后再试")
            self._binding.add(key)
            role = n["to"]
        try:
            a = self.town.agents.ensure(line_id, role, node_id)
            if ext_id:
                a = self.town.agents.import_session(a["id"], ext_id)
            else:
                a = self.town.agents.start(a["id"], self.town.paseo_models.runtime(), provider, model, thinking)
        finally:
            with self._lock:
                self._binding.discard(key)
        with self._lock:
            d = self._load(line_id)
            n = next((x for x in d["nodes"] if x["id"] == node_id and x["kind"] == "task"), None)
            if not n or n["status"] != "draft" or n.get("agent_id") or n["to"] != role:
                try:
                    self.town.agents.retire(a["id"], "安排 Agent 期间任务已被修改或删除")
                except AgentError as e:
                    raise CanvasError(f"安排 Agent 期间任务已被修改或删除，新会话{e}") from e
                raise CanvasError("安排 Agent 期间任务已被修改或删除，新建的会话已停用")
            n["agent_id"] = a["id"]
            _log(n, "bound", f"{'Paseo' if a['runtime'] == 'paseo' else a['runtime']} · {a['model']} · {a.get('ext_id') or a.get('session_id') or a['id']}")
            self._save(line_id, d)
        self._changed(line_id)
        return self.view(line_id)

    def message_target(self, line_id: str, node_id: str) -> dict:
        n = self._node(self._load(line_id), node_id)
        if n["kind"] != "task":
            raise CanvasError("只能给任务节点的 Agent 发消息")
        a = self.assignee(line_id, n)
        if not a:
            raise CanvasError("这个节点的 Agent 还没有启动")
        return a

    def _reply_instructions(self, a: dict, n: dict, token: str) -> str:
        pt = shlex.quote(str(self.town.agents.pt(a))) if a["runtime"] in ("paseo", "herdr", "tmux") else ".papertown/pt"
        dispatch = f' --dispatch {token}'
        return (f'做完运行 `{pt} task {n["id"]} done "结果"{dispatch}`，卡住运行 `{pt} task {n["id"]} blocked "原因"{dispatch}`。'
                '回报 blocked 后如已自行解决，可使用同一 --dispatch 回报 done。'
                '只有成功回报后，画布才会更新；普通对话回复不会关闭任务。'
                f'\n向同项目另一个任务传递信息：`{pt} tell task:<节点编号> "信息"`；信息会进入对方会话，不会自动派发或完成任务。')

    def send(self, line_id: str, node_id: str, chain: bool = False) -> dict:
        """Dispatch a task: it goes to its agent now, or waits in the queue until the tasks before it are done (and its
        working directory is free, when the project asks for that). Sending one at work tells the agent it has changed;
        sending one that was done marks what ran after it. `chain` also queues every draft task after it."""
        with self._lock:
            d = self._load(line_id)
            n = self._node(d, node_id)
            if n["kind"] != "task":
                raise CanvasError("只有任务能发给 agent")
            if not self.assignee(line_id, n):
                raise CanvasError(f"这个项目的{ROLES[n['to']]['name']}还没有启动：先在「员工」面板里启动它，任务会留在回路上")
            rest = [t for t in self._chain(d, n) if t["status"] == "draft"] if chain else []
            lost = next((t for t in rest if not self.assignee(line_id, t)), None)
            if lost:
                raise CanvasError(f"后续任务 {lost['id']}「{clip(lost['title'], 30)}」的{ROLES[lost['to']]['name']}尚未启动。请先启动它或为该任务安排 Agent，再派发整条链")
            if n["status"] in ("done", "blocked"):
                self._redo(d, n)
            for t in rest:  # queued first, so the message to this one says what follows it is waiting
                self._enqueue(t, self._waits(line_id, d, t))
            if n["status"] != "queued":
                n.pop("back", None)
                self._dispatch(line_id, d, n)
            self._save(line_id, d)
        self._advance(line_id)
        self._changed(line_id)
        return self.view(line_id)

    def back(self, line_id: str, node_id: str, text: str) -> dict:
        """Send a task back: the agent hears what is wrong with what it returned, and the task is under way again
        (or queued, when something it comes after is being redone too). What ran after it is marked."""
        text = str(text or "").strip()
        if not text:
            raise CanvasError("写上哪里不行、要怎么改")
        with self._lock:
            d = self._load(line_id)
            n = self._node(d, node_id)
            if n["kind"] != "task" or n["status"] not in ("done", "blocked"):
                raise CanvasError("只有交回了结果的任务能退回")
            if not self.assignee(line_id, n):
                raise CanvasError(f"这个项目的{ROLES[n['to']]['name']}还没有启动")
            self._redo(d, n)
            n["back"] = text[:4000]
            self._dispatch(line_id, d, n)
            self._save(line_id, d)
        self._changed(line_id)
        return self.view(line_id)

    def close(self, agent_id: str, task_id: str, status: str, text: str, dispatch: str | None = None) -> dict:
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
            if not self._can_close(a, n):
                raise CanvasError("这个任务没有分配给你，请用 pt tasks 查看自己的任务")
            if (n.get("agent_id") or dispatch is not None) and dispatch != n.get("dispatch"):
                raise CanvasError("这是上一轮任务的回报，请按最新任务消息里的 --dispatch 参数回报")
            if n["status"] == status and n.get("result") == text[:4000]:
                return {"text": "已经记录过这个结果。"}
            # in progress: either word; stuck: done once the agent got past it, in the same round
            if not (n["status"] == "sent" or (n["status"] == "blocked" and status == "done")):
                raise CanvasError("这个任务没有在执行中，请等待重新派发" if n["status"] != "blocked" else "该任务已回报 blocked，问题解决后请回报 done")
            n |= {"status": status, "done_at": now(), "result": text[:4000], "by": self.town.leads._who(a)}
            _log(n, status, text, by=n["by"])
            held = [t for t in self._chain(d, n) if t["status"] == "queued"] if status == "blocked" else []
            self._save(lid, d)
        self.town.leads.report(agent_id, f"研究回路上的{'修补单' if n.get('loop') == 'hard' else '任务'}「{n['title']}」{TASK[status]}：{text}"
                               + (f"。后续任务{'、'.join('「' + clip(t['title'], 20) + '」' for t in held)}将等待它解决。" if held else ""),
                               key=status == "blocked")
        if n.get("loop") == "hard" and status == "done":
            self.town.checks.run(lid, force=True)
            self.loop(lid)
        self._advance(lid)  # the tasks that waited for this one, or for its working directory
        self._changed(lid)
        return {"text": f"记下了：「{n['title']}」{TASK[status]}。用户在研究回路和汇报里会看到。"}

    def tasks_text(self, agent_id: str) -> str:
        """`pt tasks`: what the user has put on the canvas for this agent (a lead sees every task)."""
        a = self.town.agents.get(agent_id)
        if not a or not a.get("line_id"):
            raise CanvasError("只有项目里的 agent 有研究回路上的任务")
        d = self._load(a["line_id"])
        mine = [n for n in d["nodes"] if n["kind"] == "task" and n["status"] != "draft" and self._can_close(a, n)]
        if not mine:
            return "研究回路上没有给你的任务。"
        out = []
        for n in mine:
            what = f"第 {n.get('round') or 1} 轮修补单" if n.get("loop") == "hard" else "纠偏任务" if n.get("loop") == "soft" else "任务"
            turn = "，还没有轮到，轮到时会发给你，现在先不要动手" if n["status"] == "queued" else ""
            out.append(f"- {n['id']}「{n['title']}」（{what}，给{ROLES[n['to']]['name']}，{TASK[n['status']]}{turn}）" + (f"：{clip(n.get('text'), 400)}" if n.get("text") else ""))
            out += [f"    连着：{x}" for x in self._around(a["line_id"], d, n)]
            if n.get("result"):
                out.append(f"    结果：{clip(n['result'], 300)}")
            if n.get("dispatch") and n["status"] != "queued":
                out.append(f"    回报时带上 --dispatch {n['dispatch']}")
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
