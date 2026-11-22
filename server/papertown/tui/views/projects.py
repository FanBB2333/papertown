"""项目: the web console in a terminal: every project down the left and, page by page on the right, the
selected one's progress, survey, code, experiments, paper, files and staff."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from rich.console import Group
from rich.padding import Padding
from rich.table import Table
from rich.text import Text
from textual import on, work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widgets import ContentSwitcher, DataTable, Static

from ..anim import bar, clock, dur, gleam, mix, seconds_since
from ..client import ApiError
from ..look import JOB, LEAD, LINE, STAGE, clip, job_mark, job_state, line_mark, stage_mark
from ..widgets import Bar, Confirm, Pane, Place, Prompt, row_key, sync_rows
from . import cycle, tabs
from .ide import Editor, Ide

TABS = [("overview", "概览"), ("survey", "调研"), ("code", "代码"), ("exp", "实验"), ("paper", "论文"), ("files", "文件"), ("team", "员工")]
FILTERS = [("all", "全部"), ("active", "在做的"), ("done", "已出厂")]
ACTIVE = ("running", "linked")


def shown(f: str, status: str) -> bool:
    """whether a project in this status passes the filter f"""
    return f == "all" or (status in ACTIVE if f == "active" else status == f)


class Projects(Place):
    key = "projects"
    BINDINGS = [
        Binding("left_square_bracket", "tab(-1)", "上一页", show=False), Binding("right_square_bracket", "tab(1)", "下一页", show=False),
        Binding("f", "filter", "筛选"), Binding("slash", "search", "搜索"), Binding("n", "idea", "新 idea"),
        Binding("l", "lead", "负责人开关"), Binding("a", "ask", "问"),
        Binding("d", "diff", "看改动", show=False), Binding("E", "edit", "改文件", show=False), Binding("C", "compile", "编译", show=False),
        Binding("P", "pdf", "看 PDF", show=False), Binding("o", "open", "打开", show=False), Binding("z", "focus_mode", "专注", show=False),
    ]

    def __init__(self) -> None:
        super().__init__(id="projects")
        self.tab = "overview"
        self.filter = "all"
        self.search = ""
        self.sel: str | None = None
        self.line: dict | None = None
        self.ws: dict = {}
        self.papers: list[dict] = []
        self.data: dict = {}
        self.jobs: list[dict] = []
        self.agents: list[dict] = []

    def compose(self) -> ComposeResult:
        with Horizontal():
            with Vertical(id="pj-left", classes="list-col"):
                yield Bar(id="pj-filter", classes="chips")
                yield DataTable(id="pj-table", cursor_type="row", zebra_stripes=False)
            with Vertical(id="pj-right", classes="detail-col"):
                yield Bar(id="pj-tabs", classes="tabs")
                with ContentSwitcher(id="pj-panes", initial="overview"):
                    yield Pane(id="overview")
                    with Vertical(id="survey"):
                        yield DataTable(id="pj-papers", cursor_type="row")
                        yield Pane(id="pj-paper", classes="peek")
                    yield Ide("code", id="code")
                    yield Pane(id="exp")
                    yield Ide("paper", id="paper")
                    with Vertical(id="files"):
                        yield DataTable(id="pj-files", cursor_type="row")
                        yield Static(id="pj-files-note", classes="note")
                    yield Pane(id="team")

    def on_mount(self) -> None:
        t = self.query_one("#pj-table", DataTable)
        t.add_column("", key="mark", width=1)
        t.add_column("#", key="seq", width=3)
        t.add_column("项目", key="title", width=26)
        t.add_column("阶段", key="stage", width=8)
        t.add_column("进度", key="pct", width=12)
        p = self.query_one("#pj-papers", DataTable)
        for k, label, w in [("sim", "相似", 10), ("title", "论文", 44), ("year", "年份", 4), ("topic", "主题", 12)]:
            p.add_column(label, key=k, width=w)
        self.lay_out()
        f = self.query_one("#pj-files", DataTable)
        f.add_column("文件", key="name", width=36)
        f.add_column("", key="what", width=24)

    def visible(self) -> list[dict]:
        out = []
        for ln in self.town.lines:
            if not shown(self.filter, ln["status"]):
                continue
            if self.search and self.search.lower() not in f"{ln['seq']} {ln['title']} {ln.get('idea', '')}".lower():
                continue
            out.append(ln)
        return sorted(out, key=lambda x: -x["seq"])

    def rows(self) -> list[tuple[str, tuple]]:
        p, t = self.pal, self.town.t
        out = []
        for ln in self.visible():
            cur = ln.get("current") or {}
            glow = self.town.glow.k(("line", ln["id"]), t)
            title = Text(clip(ln["title"], 26), style=p["ink"])
            if glow:
                title.stylize(f"on {mix(p['bg'], p['brand'], glow * 0.45)}")
            pct = bar(ln.get("pct", 0) / 100, 7, p["done"] if ln["status"] == "done" else p["brand"], p["raised"])
            pct.append(f" {ln.get('pct', 0):>3}%", style=p["muted"])
            out.append((ln["id"], (line_mark(ln["status"], t, p), Text(str(ln["seq"]), style=p["brand"]), title,
                                   Text(clip(cur.get("name") or LINE.get(ln["status"], ""), 8), style=p["muted"]), pct)))
        return out

    def paint_list(self) -> None:
        table = self.query_one("#pj-table", DataTable)
        sync_rows(table, self.rows())
        p = self.pal
        chips = Text()
        counts = {k: sum(shown(k, ln["status"]) for ln in self.town.lines) for k, _ in FILTERS}
        for k, label in FILTERS:
            on = k == self.filter
            chips.append(f" {label} {counts[k]} ", style=f"bold {p['ink']} on {p['raised']}" if on else p["muted"])
            chips.append(" ")
        if self.search:
            chips.append(f"  /{self.search}", style=p["brand"])
        self.query_one("#pj-filter", Static).update(chips, layout=False)
        if self.sel is None and table.row_count:
            self.sel = row_key(table)

    async def load(self) -> None:
        self.paint_tabs()
        self.paint_list()
        if self.sel:
            await self.load_line(self.sel)

    def tick(self, t: float) -> None:
        if not self.town.beat:
            return
        table = self.query_one("#pj-table", DataTable)
        moving = {ln["id"] for ln in self.town.lines if ln["status"] in ACTIVE}
        if moving or self.town.glow.at:
            for key, cells in self.rows():
                if key in moving or self.town.glow.k(("line", key), t):
                    try:
                        table.update_cell(key, "mark", cells[0])
                        table.update_cell(key, "title", cells[2])
                    except Exception:
                        pass
        if self.tab == "overview" and self.line and any(s["status"] == "run" for s in self.line.get("stages", [])):
            self.paint_overview(layout=False)

    def on_town_event(self, ev: dict) -> None:
        if ev.get("type") == "line" and self.is_mounted:
            self.paint_list()
            if ev["line"]["id"] == self.sel:
                self.line = {**(self.line or {}), **ev["line"]}
                if self.tab == "overview":
                    self.paint_overview()

    @on(DataTable.RowHighlighted, "#pj-table")
    def picked(self, e: DataTable.RowHighlighted) -> None:
        key = e.row_key.value
        if key and key != self.sel:
            self.sel = key
            self.fetch(key)

    @work(exclusive=True, group="pj-line")
    async def fetch(self, key: str) -> None:
        await self.load_line(key)

    async def load_line(self, key: str) -> None:
        try:
            self.line = await self.town.api.get(f"/api/lines/{key}")
        except ApiError:
            return
        self.town.retarget()
        await self.load_tab()

    def paint_tabs(self) -> None:
        p = self.pal
        out = tabs(TABS, self.tab, p)
        out.append("   [ ] 翻页", style=p["faint"])
        self.query_one("#pj-tabs", Static).update(out, layout=False)

    def action_tab(self, step: int) -> None:
        self.tab = cycle(TABS, self.tab, step)
        self.query_one("#pj-panes", ContentSwitcher).current = self.tab
        self.lay_out()
        self.paint_tabs()
        self.town.paint_hints()
        self.run_worker(self.load_tab(), exclusive=True, group="pj-tab")

    def on_click(self, e: Any) -> None:
        if getattr(e, "widget", None) is self.query_one("#pj-tabs", Static):
            keys = [k for k, _ in TABS]
            x = 0
            for i, (_, label) in enumerate(TABS):
                w = len(label) * 2 + 3
                if x <= e.x < x + w:
                    self.action_tab(i - keys.index(self.tab))
                    return
                x += w

    async def load_tab(self) -> None:
        if not self.line:
            return
        lid = self.line["id"]
        api = self.town.api
        try:
            if self.tab == "overview":
                self.ws = await api.get(f"/api/lines/{lid}/ws")
                self.paint_overview()
            elif self.tab == "survey":
                self.papers = (await api.get(f"/api/lines/{lid}/papers")).get("survey", [])
                self.paint_survey()
            elif self.tab in ("code", "paper"):
                self.ws = await api.get(f"/api/lines/{lid}/ws")
                await self.query_one(f"#{self.tab}", Ide).load(self.line, self.ws)
            elif self.tab == "exp":
                self.data, jobs = await api.get(f"/api/lines/{lid}/data"), await api.get("/api/jobs", line_id=lid, external="false")
                self.jobs = await self.town.local.nvidb_jobs(self.town.lines, lid) + jobs["jobs"]
                self.paint_exp()
            elif self.tab == "files":
                self.paint_files()
            elif self.tab == "team":
                self.agents = list(self.line.get("team") or [])
                self.paint_team()
        except ApiError as e:
            self.town.notify(str(e), severity="error")

    def head(self) -> Text:
        p, ln = self.pal, self.line
        out = Text()
        out.append(f"#{ln.get('seq')} ", style=f"bold {p['brand']}")
        out.append(ln.get("title", ""), style=f"bold {p['ink']}")
        out.append("  ")
        out.append_text(line_mark(ln.get("status", ""), self.town.t, p))
        out.append(f" {LINE.get(ln.get('status', ''), ln.get('status', ''))}", style=p["muted"])
        return out

    def paint_overview(self, layout: bool = True) -> None:
        ln, p, t = self.line, self.pal, self.town.t
        parts: list[Any] = [self.head()]
        if ln.get("idea"):
            parts.append(Text(clip(ln["idea"], 400), style=p["muted"]))
        lead = ln.get("lead") or {}
        state = LEAD.get(lead.get("state"), lead.get("state") or "—")
        parts.append(Text(f"负责人：{state} · {'开启' if lead.get('on') else '关闭'} · {lead.get('runtime') or '—'}", style=p["ink"]))
        if lead.get("note"):
            parts.append(Text(lead["note"], style=p["warn"]))
        if ln["status"] in ACTIVE:
            parts.append(Text("l  切换负责人开关", style=p["brand"]))
        if ln.get("sample"):
            parts.append(Text("样例项目 · 预制状态", style=p["muted"]))
        stages = ln.get("stages") or []
        done = sum(s["status"] == "done" for s in stages)
        prog = Text("进度  ", style=p["muted"])
        prog.append_text(bar(ln.get("pct", 0) / 100, 24, p["brand"], p["raised"]))
        prog.append(f"  {done}/{len(stages)} 道工序", style=p["muted"])
        parts += [Text(), prog, Text()]
        grid = Table.grid(padding=(0, 2))
        for col in ("mark", "name", "where", "state", "when"):
            grid.add_column(col, no_wrap=col != "state")
        for i, s in enumerate(stages):
            running = s["status"] == "run"
            name = gleam(s["name"], t, p["run"], p["hi"]) if running else Text(s["name"], style=p["ink"] if s["status"] != "todo" else p["muted"])
            state = Text(STAGE.get(s["status"], s["status"]), style=p["run"] if running else p["muted"])
            if s.get("note"):
                state.append(f" · {clip(s['note'], 40)}", style=p["muted"])
            state.append(f" · {s.get('owner') or '—'}", style=p["muted"])
            if s.get("agents"):
                state.append(f"  {'、'.join(w.get('name') or w['id'] for w in s['agents'][:3])}", style=p["faint"])
            since = seconds_since(s.get("started_at")) if running else None
            when = Text(dur(since) if since is not None else (clock(s.get("ended_at")) if s.get("ended_at") else ""), style=p["muted"])
            grid.add_row(stage_mark(s["status"], t, p), Text.assemble((f"{i + 1} ", p["faint"]), name),
                         Text(self.town.building_name(s.get("building")), style=p["muted"]), state, when)
        parts.append(grid)
        facts = []
        if ln.get("verdict"):
            facts.append(("查重", ln["verdict"]))
        if c := self.ws.get("code"):
            facts.append(("代码", f"{c.get('name')} · {c.get('branch') or ''} · {'%d 处改动' % c['dirty'] if c.get('dirty') else '无改动'}"))
        if pp := self.ws.get("paper"):
            facts.append(("论文", f"{pp.get('main') or pp.get('name')} · {'有 PDF' if pp.get('pdf') else '还没编译'}"))
        if ln.get("files"):
            facts.append(("成品", "、".join(ln["files"])))
        if facts:
            parts.append(Text())
            for k, v in facts:
                parts.append(Text.assemble((f"{k}  ", p["muted"]), (clip(v, 200), p["ink"])))
        self.query_one("#overview", Pane).show(Padding(Group(*parts), (1, 2)), layout=layout)

    def paint_survey(self) -> None:
        p = self.pal
        rows = []
        for x in self.papers:
            sim = x.get("similarity") or 0
            cell = bar(sim, 5, p["bad"] if x.get("closest") else p["brand"], p["raised"])
            cell.append(f" {sim:.2f}", style=p["muted"])
            rows.append((x["paper_id"], (cell, Text(clip(x["title"], 44), style=f"bold {p['ink']}" if x.get("closest") else p["ink"]),
                                         Text(str(x.get("year") or ""), style=p["muted"]), Text(clip(x.get("topic"), 12), style=p["muted"]))))
        sync_rows(self.query_one("#pj-papers", DataTable), rows)
        self.peek_paper()

    @on(DataTable.RowHighlighted, "#pj-papers")
    def peek_paper(self, e: DataTable.RowHighlighted | None = None) -> None:
        p = self.pal
        key = e.row_key.value if e else row_key(self.query_one("#pj-papers", DataTable))
        x = next((x for x in self.papers if x["paper_id"] == key), None)
        if not x:
            self.query_one("#pj-paper", Pane).show(Text("还没有调研结果" if not self.papers else "", style=p["muted"]))
            return
        body = [Text(x["title"], style=f"bold {p['ink']}"), Text(f"{x.get('authors', '')} · {x.get('year', '')}", style=p["muted"])]
        if x.get("note"):
            body.append(Text(x["note"], style=p["warn"]))
        body.append(Text(clip(x.get("snippet"), 600), style=p["ink"]))
        body.append(Text.assemble(("Enter", f"bold {p['brand']}"), (f" 打开 {x.get('url', '')}", p["muted"])))
        self.query_one("#pj-paper", Pane).show(Padding(Group(*body), (0, 1)))

    @on(DataTable.RowSelected, "#pj-papers")
    def open_paper(self, e: DataTable.RowSelected | None = None) -> None:
        key = e.row_key.value if e else row_key(self.query_one("#pj-papers", DataTable))
        x = next((x for x in self.papers if x["paper_id"] == key), None)
        if x and x.get("url"):
            self.town.open_url(x["url"])

    def ide(self) -> Ide | None:
        return self.query_one(f"#{self.tab}", Ide) if self.tab in ("code", "paper") else None

    def lay_out(self) -> None:
        """the list of projects: slim beside the code and the paper, gone in 专注 (z)"""
        left = self.query_one("#pj-left")
        left.display = not self.town.prefs.focus
        left.set_class(self.tab in ("code", "paper"), "slim")

    def action_focus_mode(self) -> None:
        self.town.prefs.focus = not self.town.prefs.focus
        self.town.save_prefs()
        self.lay_out()
        if self.town.prefs.focus and self.query_one("#pj-table").has_focus:
            ide = self.ide()
            (ide.ftree if ide else self.query_one("#pj-tabs")).focus()
        self.town.notify("专注：收起项目列表，z 放回来" if self.town.prefs.focus else "项目列表放回来了")

    def action_diff(self) -> None:
        if (ide := self.ide()) and (path := ide.current()):
            ide.open(path, diff=True)

    @work(group="pj-edit")
    async def action_edit(self) -> None:
        ide = self.ide()
        path = ide.current() if ide else None
        if not ide or not path or not self.line:
            return
        lid, root = self.line["id"], ide.root
        try:
            f = await self.town.local.ws_read((ide.info or {}).get("path") or "", path) or \
                await self.town.api.get(f"/api/lines/{lid}/ws/{root}/file", path=path)
        except ApiError as e:
            self.town.notify(str(e), severity="error")
            return
        if f.get("error") or f.get("binary") or f.get("too_big"):
            self.town.notify(f.get("error") or "这个文件不能在这里改", severity="warning")
            return

        async def save(text: str) -> bool:
            try:
                await self.town.api.put(f"/api/lines/{lid}/ws/{root}/file", {"path": path, "text": text})
                return True
            except ApiError as e:
                self.town.notify(str(e), title="没存上", severity="error")
                return False

        if await self.app.push_screen_wait(Editor(path, f.get("text") or "", save)):
            self.town.notify(f"已保存 {path}")
            await self.load_tab()
            ide.open(path)

    def paint_exp(self) -> None:
        p, t, d = self.pal, self.town.t, self.data
        parts: list[Any] = [self.head(), Text()]
        meta = d.get("meta") or {}
        if meta:
            for k, label in (("datasets", "数据集"), ("metrics", "指标"), ("baselines", "对比方法")):
                if meta.get(k):
                    parts.append(Text.assemble((f"{label}  ", p["muted"]), ("、".join(meta[k]), p["ink"])))
            parts.append(Text.assemble(("规模  ", p["muted"]), (f"{meta.get('seeds', '—')} 个种子 · {meta.get('gpu_hours', '—')} GPU 小时 · {meta.get('backend', '')}", p["ink"])))
        res = d.get("results") or {}
        if res.get("rows"):
            parts.append(Text())
            if self.line.get("sample") or res.get("simulated"):
                parts.append(Text("样例实验结果（预制数据）", style=p["warn"]))
            tb = Table(box=None, header_style=f"bold {p['muted']}", pad_edge=False, padding=(0, 2))
            if "values" in res["rows"][0]:
                metrics = res.get("metrics") or [f"#{i + 1}" for i in range(len(res["rows"][0]["values"]))]
                tb.add_column("方法")
                for m in metrics:
                    tb.add_column(clip(m, 24), justify="right")
                best = [max((r["values"][i] for r in res["rows"] if i < len(r["values"])), default=None) for i in range(len(metrics))]
                for r in res["rows"]:
                    style = f"bold {p['brand']}" if r.get("ours") else p["ink"]
                    tb.add_row(Text(("★ " if r.get("ours") else "  ") + clip(r.get("method"), 40), style=style),
                               *[Text(str(v), style=f"bold {p['ok']}" if v == best[i] else style) for i, v in enumerate(r["values"])])
            else:
                cols = list(res["rows"][0].keys())
                for c in cols:
                    tb.add_column(str(c), justify="right" if c != cols[0] else "left")
                for r in res["rows"]:
                    tb.add_row(*[f"{r[c]:.2f}" if isinstance(r[c], float) else str(r[c]) for c in cols])
            parts.append(tb)
            if res.get("analysis"):
                parts += [Text(), Text(res["analysis"], style=p["ink"])]
            for c in res.get("concerns") or []:
                parts.append(Text(f"· {c}", style=p["warn"]))
        runs = [r for r in d.get("runs") or [] if not str(r.get("id")).startswith("nvidb-")]
        jobs = self.jobs
        if runs or jobs:
            parts += [Text(), Text("运行", style=f"bold {p['ink']}")]
            grid = Table.grid(padding=(0, 2))
            for _ in range(5):
                grid.add_column()
            for j in jobs[:30]:
                st = job_state(j.get("status"))
                grid.add_row(job_mark(st, t, p), Text(clip(j.get("name"), 36), style=p["ink"]), Text(JOB[st], style=p["muted"]),
                             Text(f"{j.get('progress') or 0}%", style=p["muted"]), Text(j.get("backend", ""), style=p["faint"]))
            for r in runs if not jobs else []:
                st = job_state(r.get("state"))
                grid.add_row(job_mark(st, t, p), Text(clip(r.get("name"), 36), style=p["ink"]), Text(JOB[st], style=p["muted"]),
                             Text(r.get("where", ""), style=p["muted"]), Text(clock(r.get("started_at")), style=p["faint"]))
            parts.append(grid)
            parts.append(Text.assemble(("2", f"bold {p['brand']}"), (" 到任务页看全部、提交或取消", p["faint"])))
        if len(parts) == 2:
            parts.append(Text("还没有实验", style=p["muted"]))
        self.query_one("#exp", Pane).show(Padding(Group(*parts), (1, 2)))

    def paint_files(self) -> None:
        p = self.pal
        files = self.line.get("files") or []
        what = {"main.pdf": "论文 PDF", "main.tex": "LaTeX 源文件", "refs.bib": "参考文献", "paper.zip": "投稿包"}
        sync_rows(self.query_one("#pj-files", DataTable), [(f, (Text(f, style=f"bold {p['ink']}"), Text(what.get(f, ""), style=p["muted"]))) for f in files])
        note = Text.assemble(("Enter", f"bold {p['brand']}"), (" 存到「下载」 · ", p["muted"]), ("o", f"bold {p['brand']}"), (" 在浏览器里打开", p["muted"])) \
            if files else Text("还没有出厂的文件", style=p["muted"])
        self.query_one("#pj-files-note", Static).update(note)

    @on(DataTable.RowSelected, "#pj-files")
    def save_file(self, e: DataTable.RowSelected) -> None:
        self.download(e.row_key.value or "")

    @work(group="pj-download")
    async def download(self, name: str) -> None:
        dest = Path.home() / "Downloads"
        dest.mkdir(exist_ok=True)
        target = dest / f"{self.line['id']}-{name}"
        n = 1
        while target.exists():
            n += 1
            target = dest / f"{self.line['id']}-{Path(name).stem} {n}{Path(name).suffix}"
        try:
            await self.town.api.download(f"/api/lines/{self.line['id']}/files/{name}", target)
            self.town.notify(str(target), title="已下载")
        except Exception as e:
            self.town.notify(str(e), title="下载失败", severity="error")

    def paint_team(self) -> None:
        p, ln = self.pal, self.line
        parts: list[Any] = [self.head(), Text()]
        if self.agents:
            parts.append(Text("已启动的员工", style=f"bold {p['ink']}"))
            for a in self.agents:
                last = a.get("last") or {}
                last_text = (last.get("data") or {}).get("text") or last.get("text") or ""
                parts.append(Text.assemble(("● ", p["ok"]),
                                           (a.get("name") or self.town.agent_name(a["id"]), f"bold {p['ink']}"),
                                           (f"  {a.get('status', '')} · {a.get('runtime', '')} · {a.get('model') or ''}", p["muted"])))
                if last_text:
                    parts.append(Text(f"   {clip(last_text, 120)}", style=p["faint"]))
            parts.append(Text.assemble(("Tab", f"bold {p['brand']}"), (" 在底下的框里换成「对它说」 · ", p["muted"]), ("4", f"bold {p['brand']}"), (" 到员工页看它在做什么", p["muted"])))
            parts.append(Text())
        if len(parts) == 2:
            parts.append(Text("还没有员工接手", style=p["muted"]))
        self.query_one("#team", Pane).show(Padding(Group(*parts), (1, 2)))

    def hints(self) -> list[tuple[str, str]]:
        if self.tab in ("code", "paper"):
            out = [("[ ]", "翻页"), ("Enter", "打开"), ("→←", "展开收起"), ("/", "筛选文件"), ("E", "改"), ("d", "改动"), ("w", "换行")]
            if self.tab == "paper":
                out += [("C", "编译"), ("P", "PDF")]
            return out + [("z", "专注"), ("T", "配色")]
        out = [("[ ]", "翻页"), ("f", "筛选"), ("/", "搜索"), ("n", "新 idea")]
        if self.line:
            out.append(("a", "问"))
            if self.line["status"] in ACTIVE:
                out.append(("l", "关闭负责人" if (self.line.get("lead") or {}).get("on") else "开启负责人"))
        if self.tab in ("survey", "files"):
            out.append(("Enter", "打开" if self.tab == "survey" else "下载"))
        return out

    def context(self) -> dict[str, Any]:
        ctx: dict[str, Any] = {"line": self.sel}
        if self.tab == "team" and self.agents:
            ctx["agent"] = self.agents[0]["id"]
        return ctx

    def action_filter(self) -> None:
        self.filter = cycle(FILTERS, self.filter, 1)
        self.paint_list()

    @work(group="pj-ask")
    async def action_search(self) -> None:
        if ide := self.ide():
            q = await self.app.push_screen_wait(Prompt("筛选文件", "路径里带这些字的文件，空着回车就是不筛", ide.ftree.filter))
            ide.set_filter(q or "")
            ide.ftree.focus()
            return
        q = await self.app.push_screen_wait(Prompt("搜索项目", "按编号、标题或 idea 里的字找，空着回车就是不筛", self.search))
        self.search = q or ""
        self.paint_list()

    def action_idea(self) -> None:
        self.town.aim("idea", default=0)

    def action_ask(self) -> None:
        self.town.aim("ask")

    async def action_lead(self) -> None:
        if not self.line or self.line["status"] not in ACTIVE:
            return
        on = not (self.line.get("lead") or {}).get("on", False)
        try:
            await self.town.api.post(f"/api/lines/{self.line['id']}/lead", {"on": on})
            self.town.notify("负责人已开启" if on else "负责人已关闭")
            await self.town.refetch()
            await self.load()
        except ApiError as e:
            self.town.notify(str(e), severity="error")

    @work(group="pj-ask")
    async def action_compile(self) -> None:
        if not self.line or self.tab != "paper":
            return
        if not await self.app.push_screen_wait(Confirm(f"编译 #{self.line['seq']} 的论文？", "用 latexmk 重新编译，会更新 PDF")):
            return
        self.town.notify("正在编译…")
        ide = self.query_one("#paper", Ide)
        try:
            r = await self.town.api.post(f"/api/lines/{self.line['id']}/ws/paper/compile")
        except ApiError as e:
            self.town.notify(str(e), title="编译失败", severity="error")
            return
        ok, pages = r["ok"], r.get("pages")
        self.town.notify(f"编译好了 · {r['seconds']} 秒" + (f" · {pages} 页" if pages else "") if ok else "编译失败，报错在右边",
                         severity="information" if ok else "error")
        await self.load_tab()
        if not ok and r.get("log"):
            ide.show_log(r["log"])

    def action_pdf(self) -> None:
        if not self.line:
            return
        path = f"/api/lines/{self.line['id']}/linked/pdf" if self.line.get("linked") else f"/api/lines/{self.line['id']}/ws/paper/pdf"
        self.town.open_url(self.town.api.url(path))

    def action_open(self) -> None:
        if self.tab == "files":
            key = row_key(self.query_one("#pj-files", DataTable))
            if key:
                self.town.open_url(self.town.api.url(f"/api/lines/{self.line['id']}/files/{key}"))
        elif self.tab == "survey":
            self.open_paper()
