"""任务: the experiment farm's jobs, to follow, submit and cancel, beside the linked projects' jobs in
nvidb's queue, which are read here with `--no-tick` and only shown."""

from __future__ import annotations

from typing import Any

from rich.console import Group
from rich.padding import Padding
from rich.pretty import Pretty
from rich.syntax import Syntax
from rich.text import Text
from textual import on, work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widgets import DataTable, Static

from ..anim import bar, clock, dur, gleam, parse_ts, seconds_since
from ..client import ApiError
from ..look import BACKEND, JOB, clip, job_mark, job_state
from ..widgets import Bar, Confirm, Form, Pane, Place, Prompt, row_key, sync_rows
from . import cycle

STATES = [("all", "全部"), ("running", "在跑"), ("queued", "排队"), ("done", "完成"), ("failed", "失败"), ("cancelled", "已取消")]


class Jobs(Place):
    key = "jobs"
    BINDINGS = [
        Binding("f", "state", "状态"), Binding("b", "backend", "后端"), Binding("p", "project", "项目"), Binding("slash", "search", "搜索"),
        Binding("n", "submit", "提交"), Binding("x", "cancel", "取消"), Binding("R", "again", "再跑一次"), Binding("l", "follow", "跟日志"),
    ]

    def __init__(self) -> None:
        super().__init__(id="jobs")
        self.jobs: list[dict] = []
        self.backends: list[dict] = []
        self.state, self.backend, self.project, self.search = "all", "all", "all", ""
        self.sel: str | None = None
        self.detail: dict | None = None
        self.follow = True
        self._polled = 0.0

    def compose(self) -> ComposeResult:
        yield Bar(id="jb-filter", classes="chips")
        with Horizontal():
            with Vertical(classes="list-col wide"):
                yield DataTable(id="jb-table", cursor_type="row")
            with Vertical(classes="detail-col"):
                yield Static(id="jb-head", classes="note")
                yield Pane(id="jb-detail")

    def on_mount(self) -> None:
        t = self.query_one("#jb-table", DataTable)
        for k, label, w in [("mark", "", 1), ("name", "任务", 30), ("line", "项目", 4), ("backend", "后端", 6), ("pct", "进度", 11), ("age", "时间", 8)]:
            t.add_column(label, key=k, width=w)
        self.set_interval(10, self.refresh_list)  # nvidb's jobs change without an event

    async def load(self) -> None:
        try:
            r = await self.town.api.get("/api/jobs", external="false")
        except ApiError:
            return
        own, self.backends = r["jobs"], r["backends"]
        # the first load waits for nvidb too, so the cursor does not settle on a farm job before nvidb's running ones
        last = [j for j in self.jobs if j.get("backend") == "nvidb"]
        if last:
            self.jobs = last + own
            self.paint_list()
        self.jobs = await self.town.local.nvidb_jobs(self.town.lines) + own
        self.paint_list()
        table = self.query_one("#jb-table", DataTable)
        if self.sel is None and table.row_count:
            table.move_cursor(row=0)
            self.sel = row_key(table)
        if self.sel:
            await self.load_detail(self.sel)

    @work(exclusive=True, group="jb-list")
    async def refresh_list(self) -> None:
        if self.town.place == "jobs":
            await self.load()

    def visible(self) -> list[dict]:
        out = []
        for j in self.jobs:
            st = job_state(j.get("status"))
            if self.state != "all" and st != self.state:
                continue
            if self.backend != "all" and j.get("backend") != self.backend:
                continue
            if self.project != "all" and j.get("line_id") != self.project:
                continue
            if self.search and self.search.lower() not in f"{j['id']} {j.get('name', '')} {j.get('command', '')} {j.get('submitted_by', '')}".lower():
                continue
            out.append(j)
        order = {"running": 0, "queued": 1}
        return sorted(out, key=lambda j: (order.get(job_state(j.get("status")), 2), -(parse_ts(j.get("created_at")) or parse_ts("1970-01-01")).timestamp()))

    def seq(self, line_id: str | None) -> str:
        seq = self.town.line_seq(line_id)
        return f"#{seq}" if seq is not None else "—"

    def rows(self) -> list[tuple[str, tuple]]:
        p, t = self.pal, self.town.t
        out = []
        for j in self.visible()[:500]:
            st = job_state(j.get("status"))
            pct = bar((j.get("progress") or 0) / 100, 6, p["run"] if st == "running" else p["done"] if st == "done" else p["faint"], p["raised"])
            pct.append(f" {j.get('progress') or 0:>3}%", style=p["muted"])
            since = seconds_since(j.get("started_at") if st == "running" else j.get("created_at"))
            out.append((j["id"], (job_mark(st, t, p), Text(clip(j.get("name"), 30), style=p["ink"] if st in ("running", "queued") else p["muted"]),
                                  Text(self.seq(j.get("line_id")), style=p["brand"]), Text(j.get("backend", ""), style=p["muted"]), pct,
                                  Text(dur(since).split(" ")[0] if since is not None else "—", style=p["faint"]))))
        return out

    def paint_list(self) -> None:
        table = self.query_one("#jb-table", DataTable)
        sync_rows(table, self.rows())
        p = self.pal
        chips = Text()
        counts = {k: sum(job_state(j.get("status")) == k for j in self.jobs) for k, _ in STATES[1:]}
        counts["all"] = len(self.jobs)
        for k, label in STATES:
            on = k == self.state
            chips.append(f" {label} {counts[k]} ", style=f"bold {p['ink']} on {p['raised']}" if on else p["muted"])
        chips.append("   后端 ", style=p["faint"])
        chips.append("全部" if self.backend == "all" else BACKEND.get(self.backend, self.backend), style=p["brand"])
        chips.append("   项目 ", style=p["faint"])
        chips.append("全部" if self.project == "all" else self.seq(self.project), style=p["brand"])
        if self.search:
            chips.append(f"   /{self.search}", style=p["brand"])
        self.query_one("#jb-filter", Static).update(chips, layout=False)

    def tick(self, t: float) -> None:
        if not self.town.beat:
            return
        table = self.query_one("#jb-table", DataTable)
        for j in self.jobs:
            if job_state(j.get("status")) == "running" and j["id"] in table.rows:
                table.update_cell(j["id"], "mark", job_mark("running", t, self.pal))
        if self.detail and job_state(self.detail.get("status")) == "running":
            self.paint_head(layout=False)
            if self.follow and t - self._polled > (5 if str(self.detail["id"]).startswith("nvidb-") else 2):
                self._polled = t
                self.fetch(self.detail["id"])

    def on_town_event(self, ev: dict) -> None:
        if ev.get("type") == "job" and self.is_mounted and self.town.place == "jobs":
            j = ev.get("job") or {}
            for i, x in enumerate(self.jobs):
                if x["id"] == j.get("id"):
                    self.jobs[i] = {**x, **j}
                    break
            else:
                if j.get("id") and j.get("name"):
                    self.jobs.insert(0, j)
            self.paint_list()
            if j.get("id") == self.sel:
                self.fetch(self.sel)

    @on(DataTable.RowHighlighted, "#jb-table")
    def picked(self, e: DataTable.RowHighlighted) -> None:
        if e.row_key.value != self.sel:
            self.sel = e.row_key.value
            self.fetch(self.sel)

    @work(exclusive=True, group="jb-detail")
    async def fetch(self, job_id: str | None) -> None:
        if job_id:
            await self.load_detail(job_id)

    async def load_detail(self, job_id: str) -> None:
        try:
            if job_id.startswith("nvidb-"):
                self.detail = await self.town.local.nvidb_job(int(job_id.removeprefix("nvidb-")), self.town.lines)
            else:
                self.detail = await self.town.api.get(f"/api/jobs/{job_id}", tail=200)
        except (ApiError, ValueError):
            self.detail = None
        self.detail = self.detail or next((j for j in self.jobs if j["id"] == job_id), None)
        self.paint_detail()

    def paint_head(self, layout: bool = True) -> None:
        """the top of the detail, which moves while a job runs: its mark, name, progress and time"""
        p, t, j = self.pal, self.town.t, self.detail
        box = self.query_one("#jb-head", Static)
        if not j:
            box.update(Text("没有任务" if not self.jobs else "", style=p["muted"]), layout=layout)
            return
        st = job_state(j.get("status"))
        head = Text()
        head.append_text(job_mark(st, t, p))
        head.append(" ")
        head.append_text(gleam(j.get("name") or j["id"], t, p["run"], p["hi"]) if st == "running" else Text(j.get("name") or j["id"], style=f"bold {p['ink']}"))
        head.append(f"   {JOB[st]}", style=p["run"] if st == "running" else p["muted"])
        parts: list[Any] = [head, Text(f"{j['id']} · {BACKEND.get(j.get('backend', ''), j.get('backend', ''))} · 项目 {self.seq(j.get('line_id'))}"
                                       f" · {j.get('submitted_by') or '—'} 提交", style=p["muted"]), Text()]
        prog = bar((j.get("progress") or 0) / 100, 30, p["run"] if st == "running" else p["done"], p["raised"])
        prog.append(f"  {j.get('progress') or 0}%", style=p["muted"])
        parts.append(prog)
        times = [f"提交 {clock(j.get('created_at'))}"]
        if j.get("started_at"):
            times.append(f"开始 {clock(j['started_at'])}")
        if j.get("ended_at"):
            took = (parse_ts(j["ended_at"]) - parse_ts(j["started_at"])).total_seconds() if j.get("started_at") else None
            times.append(f"结束 {clock(j['ended_at'])}" + (f"（{dur(took)}）" if took is not None else ""))
        elif st == "running":
            times.append(f"已跑 {dur(seconds_since(j.get('started_at')))}")
        parts.append(Text(" · ".join(times), style=p["muted"]))
        box.update(Group(*parts), layout=layout)

    def paint_detail(self) -> None:
        p, j = self.pal, self.detail
        self.paint_head()
        pane = self.query_one("#jb-detail", Pane)
        if not j:
            pane.show(Text(""))
            return
        st = job_state(j.get("status"))
        parts: list[Any] = []
        if j.get("note"):
            parts.append(Text(j["note"], style=p["warn"] if st in ("failed", "queued") else p["ink"]))
        nv = j.get("nvidb") or {}
        if nv:
            where = f"{nv.get('node') or nv.get('node_constraint') or '未分配'}"
            if nv.get("gpu_ids"):
                where += f" · GPU {','.join(str(x) for x in nv['gpu_ids'])}"
            if nv.get("lane"):
                where += f" · lane {nv['lane']}"
            parts.append(Text(f"nvidb #{nv.get('id', '')} · {where} · 显存 {nv.get('vram_mb') or 0}MB", style=p["muted"]))
            if nv.get("held_reason"):
                parts.append(Text(f"挂起：{nv['held_reason']}", style=p["warn"]))
            for e in (nv.get("events") or [])[-6:]:
                parts.append(Text.assemble((f"  {clock(e.get('ts'))} ", p["faint"]), (f"{e.get('kind', '')} ", p["info"]), (clip(e.get("message"), 90), p["muted"])))
            parts.append(Text("nvidb 只读：调度请用 nvidb queue / nvidb job", style=p["faint"]))
        parts += [Text(), Text("命令", style=f"bold {p['ink']}")]
        parts.append(Syntax(j.get("command") or "", "bash", theme="ansi_dark" if self.town.theme == "papertown" else "ansi_light", word_wrap=True))
        if j.get("cwd"):
            parts.append(Text(f"在 {j['cwd']}", style=p["faint"]))
        if j.get("result"):
            parts += [Text(), Text("结果", style=f"bold {p['ink']}"), (Text(j["result"][:1200], style=p["ink"]) if isinstance(j["result"], str) else Pretty(j["result"], max_length=12, max_string=160))]
        if j.get("log"):
            parts += [Text(), Text.assemble(("日志", f"bold {p['ink']}"), ("（最后 200 行" + ("，跟着在更新）" if st == "running" and self.follow else "）"), p["faint"]))]
            parts.append(Text(j["log"][-12000:], style=p["muted"]))
        elif nv.get("id"):
            parts += [Text(), Text.assemble(("日志", f"bold {p['ink']}"), ("  还没有输出（nvidb job logs）", p["faint"]))]
        pane.show(Padding(Group(*parts), (0, 1)))
        if st == "running" and self.follow:
            pane.scroll_end(animate=False)

    def hints(self) -> list[tuple[str, str]]:
        out = [("f", "状态"), ("b", "后端"), ("p", "项目"), ("/", "搜索"), ("n", "提交")]
        st = job_state((self.detail or {}).get("status"))
        if self.detail and self.detail.get("backend") == "local":
            if st in ("running", "queued"):
                out.append(("x", "取消"))
            out.append(("R", "再跑一次"))
        if st == "running":
            out.append(("l", "跟日志" if not self.follow else "停跟"))
        return out

    def context(self) -> dict[str, Any]:
        return {"line": (self.detail or {}).get("line_id"), "building": "farm"}

    def action_state(self) -> None:
        self.state = cycle(STATES, self.state, 1)
        self.paint_list()

    def action_backend(self) -> None:
        keys = ["all", *[b["id"] for b in self.backends]] if self.backends else ["all", "local", "sim", "nvidb"]
        self.backend = keys[(keys.index(self.backend) + 1) % len(keys)] if self.backend in keys else "all"
        self.paint_list()

    def action_project(self) -> None:
        keys = ["all", *sorted({j["line_id"] for j in self.jobs if j.get("line_id")}, key=self.seq)]
        self.project = keys[(keys.index(self.project) + 1) % len(keys)] if self.project in keys else "all"
        self.paint_list()

    def action_follow(self) -> None:
        self.follow = not self.follow
        self.paint_detail()
        self.town.paint_hints()

    @work(group="jb-ask")
    async def action_search(self) -> None:
        q = await self.app.push_screen_wait(Prompt("搜索任务", "按编号、名字、命令或提交人找，空着回车就是不筛", self.search))
        self.search = q or ""
        self.paint_list()

    @work(group="jb-ask")
    async def action_submit(self, name: str = "", command: str = "", line: str | None = None) -> None:
        lines = [(f"#{ln['seq']} {clip(ln['title'], 30)}", ln["id"]) for ln in sorted(self.town.lines, key=lambda x: -x["seq"])]
        v = await self.app.push_screen_wait(Form("在实验农场提交任务", [
            ("line_id", "项目（在它的代码目录里跑，不选就在农场自己的目录）", line, lines),
            ("name", "名字", name or "job"),
            ("command", "命令（shell，输出 PROGRESS 50 报进度、RESULT {…} 报结果）", command),
        ], hint="由本地执行器运行。nvidb 的任务在这里只能看，提交请用 nvidb job submit"))
        if not v or not v.get("command"):
            return
        try:
            j = await self.town.api.post("/api/jobs", {"name": v["name"] or "job", "command": v["command"], "line_id": v.get("line_id"), "backend": "local"})
            self.town.notify(f"{j['id']} 排上了", title="已提交")
            self.sel = j["id"]
            await self.load()
        except ApiError as e:
            self.town.notify(str(e), title="没提交上", severity="error")

    def action_again(self) -> None:
        j = self.detail
        if j and j.get("backend") == "local":
            self.action_submit(j.get("name") or "", j.get("command") or "", j.get("line_id"))

    @work(group="jb-ask")
    async def action_cancel(self) -> None:
        j = self.detail
        if not j or job_state(j.get("status")) not in ("running", "queued"):
            return
        if j.get("backend") != "local":
            self.town.notify("只有本地执行器的任务能在这里取消", severity="warning")
            return
        if not await self.app.push_screen_wait(Confirm(f"取消 {j.get('name')}？", f"{j['id']} 会被停掉，正在跑的部分不会保留")):
            return
        try:
            await self.town.api.post(f"/api/jobs/{j['id']}/cancel")
            self.town.notify("已取消")
            await self.load()
        except ApiError as e:
            self.town.notify(str(e), severity="error")
