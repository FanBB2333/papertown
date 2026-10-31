"""员工: the town's departments and what each is doing, and the agents you plugged in (the code and
writing staff of each project), with their conversation: what you said, what they answered (as it
streams in), the tools they ran, and what they ask permission for."""

from __future__ import annotations

from typing import Any

from rich.console import Group
from rich.padding import Padding
from rich.table import Table
from rich.text import Text
from textual import on, work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widgets import DataTable

from ..anim import breathe, gleam, mix, star
from ..client import ApiError
from ..look import AGENT, DEPT, JOB, LINE, WORKER, clip, doing, line_mark, money
from ..widgets import Confirm, Pane, Place, row_key, sync_rows, transcript, writing


class Staff(Place):
    key, title, animated = "staff", "员工", True
    BINDINGS = [
        Binding("s", "say", "对它说"), Binding("b", "brief", "发简报"), Binding("S", "start", "启动"), Binding("x", "stop", "停下"),
        Binding("exclamation_mark", "abort", "打断"), Binding("y", "permit(True)", "允许", show=False), Binding("N", "permit(False)", "拒绝", show=False),
    ]

    def __init__(self) -> None:
        super().__init__(id="staff")
        self.sel: tuple[str, str] | None = None  # ("dept" | "agent", id)
        self.timeline: dict | None = None
        self.roster: list[dict] = []
        self._polled = 0.0

    def compose(self) -> ComposeResult:
        with Horizontal():
            with Vertical(classes="list-col"):
                yield DataTable(id="st-depts", cursor_type="row")
                yield DataTable(id="st-agents", cursor_type="row")
            with Vertical(classes="detail-col"):
                yield Pane(id="st-detail")

    def on_mount(self) -> None:
        d = self.query_one("#st-depts", DataTable)
        for k, label, w in [("mark", "", 1), ("name", "部门", 8), ("job", "在做", 30)]:
            d.add_column(label, key=k, width=w)
        a = self.query_one("#st-agents", DataTable)
        for k, label, w in [("mark", "", 1), ("name", "agent", 14), ("state", "状态", 8), ("last", "最近", 16)]:
            a.add_column(label, key=k, width=w)

    def agents(self) -> list[dict]:
        out: dict[str, dict] = {}
        for d in self.town.depts:
            for a in d.get("agents") or []:
                out[a["id"]] = a
        return sorted(out.values(), key=lambda a: (-(a.get("seq") or 0), a["id"]))

    def dept_mark(self, d: dict, t: float) -> Text:
        p = self.pal
        if d.get("state") == "busy":
            return Text(star(t), style=f"bold {p['run']}")
        if d.get("state") == "wait":
            return Text("◐", style=f"bold {mix(p['warn'], p['hi'], breathe(t) * 0.6)}")
        return Text("·", style=p["faint"])

    def agent_mark(self, a: dict, t: float) -> Text:
        p = self.pal
        working = a.get("status") in ("working", "running") or a["id"] in self.town.streaming
        if working:
            return Text(star(t), style=f"bold {p['run']}")
        return Text("●" if a.get("started") else "○", style=p["ok"] if a.get("started") else p["faint"])

    async def load(self) -> None:
        p, t = self.pal, self.town.t
        sync_rows(self.query_one("#st-depts", DataTable), [
            (d["id"], (self.dept_mark(d, t), Text(d["name"], style=p["ink"]), Text(clip(doing(d), 30), style=p["muted"]))) for d in self.town.depts])
        sync_rows(self.query_one("#st-agents", DataTable), [
            (a["id"], (self.agent_mark(a, t), Text(self.town.agent_name(a["id"]), style=p["ink"]), Text(AGENT.get(a.get("status") or "", a.get("status") or ""), style=p["muted"]),
                       Text(clip((a.get("last") or {}).get("text"), 16), style=p["faint"]))) for a in self.agents()])
        if self.sel is None and self.town.depts:
            self.sel = ("dept", self.town.depts[0]["id"])
        await self.load_detail()

    async def load_detail(self) -> None:
        if not self.sel:
            return
        kind, key = self.sel
        try:
            if kind == "agent":
                self.timeline = await self.town.api.get(f"/api/agents/{key}/timeline", limit=200)
            elif key == "market":
                self.roster = await self.town.api.get("/api/workers")
        except ApiError as e:
            self.timeline = {"items": [{"kind": "error", "text": str(e)}], "agent": next((a for a in self.agents() if a["id"] == key), {})}
        self.paint_detail()

    @on(DataTable.RowHighlighted, "#st-depts")
    def picked_dept(self, e: DataTable.RowHighlighted) -> None:
        if self.query_one("#st-depts", DataTable).has_focus or self.sel is None:
            self.pick(("dept", e.row_key.value or ""))

    @on(DataTable.RowHighlighted, "#st-agents")
    def picked_agent(self, e: DataTable.RowHighlighted) -> None:
        if self.query_one("#st-agents", DataTable).has_focus:
            self.pick(("agent", e.row_key.value or ""))

    def on_descendant_focus(self, e: Any) -> None:
        w = getattr(e, "widget", None)
        if isinstance(w, DataTable) and w.id in ("st-depts", "st-agents"):
            key = row_key(w)
            if key:
                self.pick(("dept" if w.id == "st-depts" else "agent", key))

    def pick(self, sel: tuple[str, str]) -> None:
        if sel != self.sel:
            self.sel = sel
            self.timeline = None
            self.town.retarget()
            self.town.paint_hints()
            self.fetch()

    @work(exclusive=True, group="st-detail")
    async def fetch(self) -> None:
        await self.load_detail()

    def paint_detail(self) -> None:
        if not self.sel:
            return
        if self.sel[0] == "agent":
            self.paint_agent()
        else:
            self.paint_dept()

    def paint_dept(self) -> None:
        p, t = self.pal, self.town.t
        d = next((x for x in self.town.depts if x["id"] == self.sel[1]), None) if self.sel else None
        if not d:
            return
        head = Text()
        head.append_text(self.dept_mark(d, t))
        head.append(f" {d['name']}", style=f"bold {p['ink']}")
        head.append(f"  {d.get('district', '')} · {DEPT.get(d.get('state', ''), d.get('state', ''))}", style=p["muted"])
        parts: list[Any] = [head, gleam(doing(d), t, p["run"], p["hi"]) if d.get("state") == "busy" else Text(doing(d), style=p["ink"]), Text()]
        if d.get("worker"):
            w = d["worker"]
            parts.append(Text(f"当班：{w.get('id')} · {w.get('role')} · Lv.{w.get('level')}", style=p["muted"]))
        if d.get("lines"):
            parts += [Text(), Text("手上的项目", style=f"bold {p['ink']}")]
            for ln in d["lines"]:
                parts.append(Text.assemble("  ", line_mark(ln.get("status", ""), t, p), (f" #{ln['seq']} ", p["brand"]), (clip(ln.get("title"), 40), p["ink"]),
                                           (f"  {ln.get('stage') or LINE.get(ln.get('status', ''), '')} · {ln.get('pct', 0)}%", p["muted"])))
        if d.get("jobs"):
            parts += [Text(), Text("任务", style=f"bold {p['ink']}")]
            for j in d["jobs"][:12]:
                parts.append(Text(f"  {JOB.get(j.get('status') or '', j.get('status'))}  {clip(j.get('name'), 40)}  {j.get('progress') or 0}%", style=p["muted"]))
        if d.get("agents"):
            parts += [Text(), Text("agent", style=f"bold {p['ink']}")]
            for a in d["agents"]:
                parts.append(Text.assemble("  ", self.agent_mark(a, t), (f" {self.town.agent_name(a['id'])}", p["ink"]),
                                           (f"  {AGENT.get(a.get('status') or '', a.get('status'))} · {a.get('model') or ''}", p["muted"])))
        if d["id"] == "market" and self.roster:
            parts += [Text(), Text("人才市场", style=f"bold {p['ink']}")]
            tb = Table(box=None, header_style=p["muted"], padding=(0, 2), pad_edge=False)
            for c in ("员工", "岗位", "等级", "状态", "接单", "近期 ROI"):
                tb.add_column(c, justify="right" if c in ("等级", "接单", "近期 ROI") else "left")
            for w in self.roster:
                tb.add_row(w["id"], w.get("role", ""), f"Lv.{w.get('level')}", WORKER.get(w.get("status") or "", w.get("status") or ""), str(w.get("runs", 0)),
                           f"{w.get('trailing_roi') or 0:.1f}")
            parts.append(tb)
        parts += [Text(), Text.assemble(("i", f"bold {self.pal['brand']}"), (" 在底下的框里问这个部门", self.pal["faint"]))]
        self.query_one("#st-detail", Pane).show(Padding(Group(*parts), (0, 1)))

    def paint_agent(self) -> None:
        p, t = self.pal, self.town.t
        tl = self.timeline or {}
        a = tl.get("agent") or next((x for x in self.agents() if self.sel and x["id"] == self.sel[1]), None) or {}
        if not a:
            return
        head = Text()
        head.append_text(self.agent_mark(a, t))
        head.append(f" {self.town.agent_name(a['id'])}", style=f"bold {p['ink']}")
        head.append(f"  {AGENT.get(a.get('status') or '', a.get('status') or '')} · {a.get('runtime', '')} · {a.get('model') or '—'} · {money(a.get('cost'))}", style=p["muted"])
        parts: list[Any] = [head]
        if a.get("cwd"):
            parts.append(Text(a["cwd"], style=p["faint"]))
        parts.append(Text())
        parts += transcript((tl.get("items") or [])[-60:], p, self.town.theme == "papertown")
        parts += writing(self.town.streaming.get(a["id"]), t, p)
        for q in (tl.get("paseo") or {}).get("permissions") or []:
            parts += [Text(), Text.assemble((" 它想" + ("运行命令" if q.get("name") == "Bash" else f"用 {q.get('name')}") + " ", f"bold {p['bg']} on {p['warn']}"),
                                            (f" {q.get('title') or ''}", p["ink"])),
                      Text(q.get("arg") or "", style=p["muted"]),
                      Text.assemble(("y", f"bold {p['brand']}"), (" 允许  ", p["muted"]), ("N", f"bold {p['brand']}"), (" 拒绝", p["muted"]))]
        if len(parts) <= 3:
            parts.append(Text("还没有对话", style=p["muted"]))
        pane = self.query_one("#st-detail", Pane)
        pane.show(Padding(Group(*parts), (0, 1)))
        pane.scroll_end(animate=False)

    def tick(self, t: float) -> None:
        dt = self.query_one("#st-depts", DataTable)
        for d in self.town.depts:
            if d.get("state") in ("busy", "wait"):
                try:
                    dt.update_cell(d["id"], "mark", self.dept_mark(d, t))
                except Exception:
                    pass
        at = self.query_one("#st-agents", DataTable)
        for a in self.agents():
            if a.get("status") in ("working", "running") or a["id"] in self.town.streaming:
                try:
                    at.update_cell(a["id"], "mark", self.agent_mark(a, t))
                except Exception:
                    pass
        if self.sel and self.sel[0] == "agent":
            live = self.sel[1] in self.town.streaming
            if live or int(t * 2) != int((t - 1 / 12) * 2):
                self.paint_agent()
            if t - self._polled > 5:
                self._polled = t
                self.fetch()
        elif self.sel:
            d = next((x for x in self.town.depts if x["id"] == self.sel[1]), None)
            if d and d.get("state") in ("busy", "wait"):
                self.paint_dept()

    def on_town_event(self, ev: dict) -> None:
        if not self.is_mounted or self.town.place != "staff":
            return
        if ev.get("type") in ("agent", "agent_event") and self.sel and self.sel[0] == "agent":
            aid = (ev.get("agent") or ev.get("event") or {}).get("agent_id") or (ev.get("agent") or {}).get("id")
            if aid == self.sel[1]:
                self.fetch()

    # ---------- doing things ----------

    def agent(self) -> dict | None:
        if self.sel and self.sel[0] == "agent":
            return (self.timeline or {}).get("agent") or next((a for a in self.agents() if a["id"] == self.sel[1]), None)
        return None

    def hints(self) -> list[tuple[str, str]]:
        if self.agent():
            out = [("s", "对它说"), ("b", "发简报"), ("x", "停下"), ("!", "打断")]
            if not (self.agent() or {}).get("started"):
                out.insert(0, ("S", "启动"))
            if ((self.timeline or {}).get("paseo") or {}).get("permissions"):
                out += [("y", "允许"), ("N", "拒绝")]
            return out
        return [("Tab", "到 agent 列表"), ("i", "问这个部门")]

    def context(self) -> dict[str, Any]:
        if self.sel and self.sel[0] == "agent":
            a = self.agent() or {}
            return {"agent": self.sel[1], "line": a.get("line_id")}
        return {"building": self.sel[1] if self.sel else None}

    def action_say(self) -> None:
        if self.agent():
            self.town.retarget()
            self.town.target_i = next((i for i, x in enumerate(self.town.targets) if x.kind == "say"), 0)
            self.town.action_compose()

    async def _post(self, path: str, done: str, body: Any = None) -> None:
        try:
            await self.town.api.post(path, body)
            self.town.notify(done)
            self.fetch()
        except ApiError as e:
            self.town.notify(str(e), severity="error")

    async def action_brief(self) -> None:
        if a := self.agent():
            await self._post(f"/api/agents/{a['id']}/brief", "简报发过去了")

    async def action_start(self) -> None:
        if a := self.agent():
            await self._post(f"/api/agents/{a['id']}/start", "正在启动", {})

    @work(group="st-ask")
    async def action_stop(self) -> None:
        a = self.agent()
        if a and await self.app.push_screen_wait(Confirm(f"让{self.town.agent_name(a['id'])}停下？", "会话关掉，之后可以再启动")):
            await self._post(f"/api/agents/{a['id']}/stop", "停下了")

    async def action_abort(self) -> None:
        if a := self.agent():
            await self._post(f"/api/agents/{a['id']}/abort", "打断了它手上的这一轮")

    async def action_permit(self, allow: bool) -> None:
        a = self.agent()
        asks = ((self.timeline or {}).get("paseo") or {}).get("permissions") or []
        if a and asks:
            await self._post(f"/api/agents/{a['id']}/permit", "允许了" if allow else "拒绝了", {"request_id": asks[0]["id"], "allow": allow})
