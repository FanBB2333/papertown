"""电厂: the GPUs as nvidb reports them (read only): each machine and card, how full and busy, who is on
it, and each lane's running jobs and queue in the order they will run."""

from __future__ import annotations

from typing import Any

from rich.console import Group
from rich.padding import Padding
from rich.text import Text
from textual import on, work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widgets import DataTable, Static

from ..anim import Tween, bar, dur, seconds_since, spark
from ..look import JOB, busy_mark, clip, gb, job_mark, job_state
from ..widgets import Bar, Pane, Place, row_key, sync_rows

STATE = {"full": "满", "idle": "空闲", "room": "有空", "busy": "忙"}


class Plant(Place):
    key, title = "plant", "电厂"
    BINDINGS = [Binding("R", "fresh", "现在就问 nvidb"), Binding("v", "procs", "进程")]

    def __init__(self) -> None:
        super().__init__(id="plant")
        self.g: dict = {}
        self.lane: str | None = None
        self.procs = True
        self.fill: dict[str, Tween] = {}

    def compose(self) -> ComposeResult:
        yield Bar(id="pl-sum", classes="chips")
        with Horizontal():
            with Vertical(classes="detail-col wide"):
                yield Pane(id="pl-nodes")
            with Vertical(classes="list-col"):
                yield DataTable(id="pl-lanes", cursor_type="row")
                yield Pane(id="pl-queue", classes="peek")

    def on_mount(self) -> None:
        t = self.query_one("#pl-lanes", DataTable)
        for k, label, w in [("mark", "", 1), ("name", "lane", 18), ("run", "在跑", 18), ("q", "排队", 4)]:
            t.add_column(label, key=k, width=w)
        self.set_interval(5, self.refresh_soon)

    async def load(self, fresh: bool = False) -> None:
        self.g = await self.town.local.gpus(fresh)
        self.paint()

    def job(self, jid: Any) -> dict | None:
        return next((j for j in self.g.get("jobs") or [] if j.get("id") == jid), None)

    def paint(self) -> None:
        self.paint_summary()
        self.paint_nodes()
        p = self.pal
        rows = []
        for ln in self.g.get("lanes") or []:
            run = [self.job(i) for i in ln.get("running") or []]
            mark = busy_mark(self.town.t, p) if run else Text("‖" if ln.get("paused") else "·", style=p["muted"])
            rows.append((ln["name"], (mark, Text(clip(ln["name"], 18), style=p["ink"]),
                                      Text(clip(", ".join((j or {}).get("name", "?") for j in run) or ("暂停" if ln.get("paused") else "—"), 18), style=p["muted"]),
                                      Text(str(len(ln.get("queued") or [])), style=p["warn"] if ln.get("queued") else p["faint"]))))
        table = self.query_one("#pl-lanes", DataTable)
        sync_rows(table, rows)
        if self.lane is None and table.row_count:
            self.lane = row_key(table)
        self.paint_queue()

    def paint_summary(self) -> None:
        p, g = self.pal, self.g
        out = Text(" ")
        if not g.get("ok"):
            plant = (self.town.hud or {}).get("plant") or {}
            out.append(f"{plant.get('name', '电厂')} · {plant.get('summary', '')}", style=p["ink"])
            if g.get("note"):
                out.append(f"   {g['note']}", style=p["muted"])
            self.query_one("#pl-sum", Static).update(out, layout=False)
            return
        s, c = g.get("summary") or {}, g.get("counts") or {}
        for v, label, color in [(f"{s.get('up', 0)}/{s.get('nodes', 0)}", "台机器在线", "ink"), (s.get("gpus", 0), "张卡", "ink"),
                                (s.get("idle", 0), "张空闲", "ok"), (gb(s.get("free_mb")), f"/ {gb(s.get('total_mb'))} 显存空着", "ink"),
                                (c.get("running", 0), "在跑", "run"), (c.get("pending", 0), "排队", "warn")]:
            out.append(str(v), style=f"bold {p[color]}")
            out.append(f" {label}   ", style=p["muted"])
        if g.get("alerts"):
            out.append(f"{g['alerts']} 条告警   ", style=p["bad"])
        ago = seconds_since(g.get("polled_at"))
        out.append(f"{dur(ago)}前更新" if ago is not None else "", style=p["faint"])
        out.append("  · 只读", style=p["faint"])
        self.query_one("#pl-sum", Static).update(out, layout=False)

    def paint_nodes(self, layout: bool = True) -> None:
        p, t = self.pal, self.town.t
        pane = self.query_one("#pl-nodes", Pane)
        nodes = self.g.get("nodes") or []
        if not nodes:
            pane.show(Padding(Text(self.g.get("note") or "没有接入 nvidb：这里显示模拟电厂", style=p["muted"]), (1, 2)))
            return
        parts: list[Any] = []
        room = max(0, min(20, pane.content_size.width - 76))
        for n in nodes:
            up = n.get("state") == "up"
            parts.append(Text.assemble(("● " if up else "○ ", p["ok"] if up else p["bad"]), (n["name"], f"bold {p['ink']}"),
                                       (f"  {n.get('state', '')} · {len(n.get('gpus') or [])} 张卡", p["muted"]),
                                       (f"  {n['last_error']}" if n.get("last_error") else "", p["bad"])))
            for c in n.get("gpus") or []:
                key = f"{n['name']}:{c['index']}"
                total = c.get("mem_total_mb") or 1
                tw = self.fill.setdefault(key, Tween(0, rate=5))
                tw.set((c.get("mem_used_mb") or 0) / total)
                busy = any(x.get("managed") for x in c.get("procs") or [])
                row = Text("  ")
                row.append_text(busy_mark(t, p) if busy else Text("·", style=p["faint"]))
                row.append(f" GPU{c['index']} ", style=p["ink"])
                row.append(f"{clip(c.get('name'), 16):<16} ", style=p["muted"])
                full = c.get("state") == "full"
                row.append_text(bar(tw.value, 14, p["bad"] if full else p["brand"], p["raised"]))
                row.append(f" {gb(c.get('mem_used_mb'))}/{gb(total)}", style=p["ink"])
                row.append(f"  {c.get('util_percent') or 0:>3}% ", style=p["run"] if (c.get("util_percent") or 0) > 50 else p["muted"])
                row.append(spark([x[1] for x in (c.get("trend") or [])[-room:]] if room else [], 0, 100), style=p["brand"])
                if c.get("temperature_c") is not None:
                    row.append(f"  {c['temperature_c']}°C", style=p["muted"])
                row.append(f"  {STATE.get(c.get('state') or '', c.get('state') or '')}", style=p["bad"] if full else p["ok"])
                parts.append(row)
                if self.procs:
                    for x in c.get("procs") or []:
                        who = f"{x.get('job_name')} #{x.get('job_id')}" if x.get("job_id") else f"{x.get('name')} ({x.get('user')})"
                        parts.append(Text(f"        {clip(who, 40)}  {gb(x.get('mem_mb'))}" + ("" if x.get("managed") else "  不在队列里"),
                                          style=p["faint"] if x.get("managed") else p["muted"]))
            parts.append(Text())
        pane.show(Padding(Group(*parts), (0, 1)), layout=layout)

    @on(DataTable.RowHighlighted, "#pl-lanes")
    def picked(self, e: DataTable.RowHighlighted) -> None:
        self.lane = e.row_key.value
        self.paint_queue()

    def paint_queue(self) -> None:
        p, t = self.pal, self.town.t
        ln = next((x for x in self.g.get("lanes") or [] if x["name"] == self.lane), None)
        pane = self.query_one("#pl-queue", Pane)
        if not ln:
            pane.show(Text(""))
            return
        parts: list[Any] = [Text.assemble((ln["name"], f"bold {p['ink']}"), (f"  并发 {ln.get('concurrency', 1)}" + (" · 暂停" if ln.get("paused") else "")
                                                                            + (f" · 堵住了：{ln['blocked']}" if ln.get("blocked") else ""), p["muted"]))]
        order = [*(ln.get("running") or []), *(ln.get("queued") or [])]
        if not order:
            parts.append(Text("空着", style=p["muted"]))
        for i, jid in enumerate(order):
            j = self.job(jid) or {"id": jid, "name": f"#{jid}", "state": "pending"}
            st = job_state(j.get("state"))
            parts.append(Text.assemble((f"{i + 1:>2} ", p["faint"]), job_mark(st, t, p), (f" {clip(j.get('name'), 34)}", p["ink"]),
                                       (f"  {JOB[st]}", p["muted"]), ("  挂起" if j.get("held") else "", p["warn"])))
        parts.append(Text("排在前面的先跑；在 nvidb 里调顺序", style=p["faint"]))
        pane.show(Padding(Group(*parts), (0, 1)))

    def tick(self, t: float) -> None:
        moving = any(tw.step(1 / 12) for tw in self.fill.values())
        if moving or (self.town.beat and self.g.get("lanes")):
            self.paint_nodes(layout=False)
            self.paint_summary()
        if self.town.beat:
            table = self.query_one("#pl-lanes", DataTable)
            for ln in self.g.get("lanes") or []:
                if ln.get("running"):
                    table.update_cell(ln["name"], "mark", busy_mark(t, self.pal))

    @work(exclusive=True, group="pl-load")
    async def refresh_soon(self) -> None:
        if self.town.place == "plant":
            await self.load()

    def hints(self) -> list[tuple[str, str]]:
        return [("R", "现在就问 nvidb"), ("v", "隐藏进程" if self.procs else "显示进程"), ("↑↓", "看 lane 的队列")]

    def context(self) -> dict[str, Any]:
        return {"building": "power"}

    @work(exclusive=True, group="pl-load")
    async def action_fresh(self) -> None:
        self.town.notify("正在问 nvidb…")
        await self.load(fresh=True)

    def action_procs(self) -> None:
        self.procs = not self.procs
        self.paint_nodes()
        self.town.paint_hints()
