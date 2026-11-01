"""项目: every project down the left, and the one you are on, page by page, on the right: how far it has
got and what it waits on, its survey, code, experiments, paper, files and the staff on it. The
console of the web page, in a terminal."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from rich.console import Group
from rich.padding import Padding
from rich.panel import Panel
from rich.syntax import Syntax
from rich.table import Table
from rich.text import Text
from textual import on, work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import ContentSwitcher, DataTable, Static, TextArea

from ..anim import bar, clock, dur, gleam, seconds_since
from ..client import ApiError
from ..look import JOB, LINE, STAGE, clip, job_mark, job_state, line_mark, money, size, stage_mark
from ..widgets import Bar, Confirm, Pane, Place, Prompt, row_key, sync_rows

TABS = [("overview", "概览"), ("survey", "调研"), ("code", "代码"), ("exp", "实验"), ("paper", "论文"), ("files", "文件"), ("team", "员工")]
FILTERS = [("all", "全部"), ("active", "在做的"), ("waiting", "等你决定"), ("done", "已出厂")]


def lexer_for(path: str) -> str:
    ext = Path(path).suffix.lower()
    return {".tex": "latex", ".bib": "bibtex", ".py": "python", ".md": "markdown", ".yaml": "yaml", ".yml": "yaml", ".json": "json",
            ".sh": "bash", ".js": "javascript", ".ts": "typescript", ".tsx": "tsx", ".cpp": "cpp", ".h": "c", ".c": "c", ".toml": "toml",
            ".css": "css", ".html": "html", ".txt": "text", ".cfg": "ini", ".ini": "ini"}.get(ext, "text")


class Editor(ModalScreen[str | None]):
    """a file of the project's workspace, to change and save (Ctrl+S) or leave as it was (Esc)"""

    BINDINGS = [Binding("ctrl+s", "save", "保存", priority=True), Binding("escape", "dismiss(None)", "不存", priority=True)]  # before the text area's own

    def __init__(self, path: str, text: str):
        super().__init__(classes="modal")
        self.path, self.text = path, text

    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog editor"):
            yield Static(Text.assemble(("改 ", "bold"), (self.path, "bold"), ("    Ctrl+S 保存 · Esc 不存", "dim")), classes="dialog-title")
            yield TextArea(self.text, show_line_numbers=True, tab_behavior="indent", soft_wrap=False)

    def action_save(self) -> None:
        self.dismiss(self.query_one(TextArea).text)


class Projects(Place):
    key, title, animated = "projects", "项目", True
    BINDINGS = [
        Binding("left_square_bracket", "tab(-1)", "上一页", show=False), Binding("right_square_bracket", "tab(1)", "下一页", show=False),
        Binding("f", "filter", "筛选"), Binding("slash", "search", "搜索"), Binding("n", "idea", "新 idea"),
        Binding("h", "hatch", "立项"), Binding("r", "resume", "继续"), Binding("e", "adjust", "调整"), Binding("a", "ask", "问"),
        Binding("d", "diff", "看改动", show=False), Binding("E", "edit", "改文件", show=False), Binding("C", "compile", "编译", show=False),
        Binding("P", "pdf", "看 PDF", show=False), Binding("o", "open", "打开", show=False),
    ]

    def __init__(self) -> None:
        super().__init__(id="projects")
        self.tab = "overview"
        self.filter = "all"
        self.search = ""
        self.sel: str | None = None
        self.line: dict | None = None  # the selected project in full
        self.ws: dict | None = None
        self.papers: list[dict] = []
        self.files: dict[str, list[dict]] = {}  # root → its files
        self.data: dict | None = None
        self.jobs: list[dict] = []
        self.agents: list[dict] = []
        self.opened: tuple[str, str] | None = None  # (root, path) shown in the viewer
        self.opened_text = ""

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
                    with Horizontal(id="code"):
                        yield DataTable(id="pj-code-files", cursor_type="row", classes="files")
                        yield Pane(id="pj-code-view", classes="viewer")
                    yield Pane(id="exp")
                    with Horizontal(id="paper"):
                        yield DataTable(id="pj-paper-files", cursor_type="row", classes="files")
                        yield Pane(id="pj-paper-view", classes="viewer")
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
        for tid in ("#pj-code-files", "#pj-paper-files"):
            ft = self.query_one(tid, DataTable)
            ft.add_column("文件", key="path", width=30)
            ft.add_column("大小", key="size", width=6)
        f = self.query_one("#pj-files", DataTable)
        f.add_column("文件", key="name", width=36)
        f.add_column("", key="what", width=24)

    # ---------- the list ----------

    def visible(self) -> list[dict]:
        out = []
        for ln in self.town.lines:
            s = ln["status"]
            if self.filter == "active" and s not in ("running", "hatching", "paused", "linked"):
                continue
            if self.filter == "waiting" and s != "waiting":
                continue
            if self.filter == "done" and s != "done":
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
            title = Text(clip(ln["title"], 26), style=f"bold {p['ink']}" if ln["status"] == "waiting" else p["ink"])
            if glow:
                title.stylize(f"on {self._glow(glow)}")
            pct = bar(ln.get("pct", 0) / 100, 7, p["done"] if ln["status"] == "done" else p["brand"], p["raised"])
            pct.append(f" {ln.get('pct', 0):>3}%", style=p["muted"])
            out.append((ln["id"], (line_mark(ln["status"], t, p), Text(str(ln["seq"]), style=p["brand"]), title,
                                   Text(clip(cur.get("name") or LINE.get(ln["status"], ""), 8), style=p["muted"]), pct)))
        return out

    def _glow(self, k: float) -> str:
        from ..anim import mix
        return mix(self.pal["bg"], self.pal["brand"], k * 0.45)

    def paint_list(self) -> None:
        table = self.query_one("#pj-table", DataTable)
        sync_rows(table, self.rows())
        p = self.pal
        chips = Text()
        counts = {"all": len(self.town.lines), "active": sum(ln["status"] in ("running", "hatching", "paused", "linked") for ln in self.town.lines),
                  "waiting": sum(ln["status"] == "waiting" for ln in self.town.lines), "done": sum(ln["status"] == "done" for ln in self.town.lines)}
        for i, (k, label) in enumerate(FILTERS):
            on = k == self.filter
            chips.append(f" {label} {counts[k]} ", style=f"bold {p['ink']} on {p['raised']}" if on else p["muted"])
            chips.append(" ")
        if self.search:
            chips.append(f"  /{self.search}", style=p["brand"])
        self.query_one("#pj-filter", Static).update(chips, layout=False)
        if self.sel is None and table.row_count:
            self.sel = row_key(table)

    async def load(self) -> None:
        self.paint_list()
        if self.sel:
            await self.load_line(self.sel)

    def tick(self, t: float) -> None:
        if not self.town.beat:
            return
        table = self.query_one("#pj-table", DataTable)
        # only the cells that move are redrawn: the marks of what works or waits, and rows still glowing
        moving = {ln["id"] for ln in self.town.lines if ln["status"] in ("running", "hatching", "waiting")}
        if moving or self.town.glow.live:
            for key, cells in self.rows():
                if key in moving or self.town.glow.k(("line", key), t):
                    try:
                        table.update_cell(key, "mark", cells[0])
                        table.update_cell(key, "title", cells[2])
                    except Exception:
                        pass
        if self.tab == "overview" and self.line and any(s["status"] in ("run", "wait") for s in self.line.get("stages", [])):
            self.paint_overview(layout=False)
        self.paint_tabs()

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
            self.opened = None
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

    # ---------- the pages ----------

    def paint_tabs(self) -> None:
        p = self.pal
        out = Text()
        for k, label in TABS:
            on = k == self.tab
            out.append(f" {label} ", style=f"bold {p['brand']} underline" if on else p["muted"])
            out.append(" ")
        out.append("   [ ] 翻页", style=p["faint"])
        self.query_one("#pj-tabs", Static).update(out, layout=False)

    def action_tab(self, step: int) -> None:
        keys = [k for k, _ in TABS]
        self.tab = keys[(keys.index(self.tab) + step) % len(keys)]
        self.query_one("#pj-panes", ContentSwitcher).current = self.tab
        self.paint_tabs()
        self.town.paint_hints()
        self.run_worker(self.load_tab(), exclusive=True, group="pj-tab")

    def on_click(self, e: Any) -> None:
        if getattr(e, "widget", None) is self.query_one("#pj-tabs", Static):
            x = 0
            for k, label in TABS:
                w = len(label) * 2 + 3
                if x <= e.x < x + w:
                    self.action_tab([k for k, _ in TABS].index(k) - [k for k, _ in TABS].index(self.tab))
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
                root = self.tab
                if (self.ws or {}).get(root):
                    self.files[root] = (await api.get(f"/api/lines/{lid}/ws/{root}/tree")).get("files", [])
                else:
                    self.files[root] = []
                self.paint_tree(root)
            elif self.tab == "exp":
                self.data, jobs = await api.get(f"/api/lines/{lid}/data"), await api.get("/api/jobs", line_id=lid, external="false")
                own = [j for j in jobs.get("jobs", []) if not j.get("external")]
                self.jobs = await self.town.local.nvidb_jobs(self.town.lines, lid) + own  # nvidb's read here
                self.paint_exp()
            elif self.tab == "files":
                self.paint_files()
            elif self.tab == "team":
                self.agents = []
                for role in ("coder", "writer"):
                    try:
                        self.agents.append((await api.get(f"/api/agents/{role}-{lid}"))["agent"])
                    except ApiError:
                        pass
                self.paint_team()
        except ApiError as e:
            self.town.notify(str(e), severity="error")

    def head(self) -> Text:
        p, ln = self.pal, self.line or {}
        out = Text()
        out.append(f"#{ln.get('seq')} ", style=f"bold {p['brand']}")
        out.append(ln.get("title", ""), style=f"bold {p['ink']}")
        out.append("  ")
        out.append_text(line_mark(ln.get("status", ""), self.town.t, p))
        out.append(f" {LINE.get(ln.get('status', ''), ln.get('status', ''))}", style=p["muted"])
        return out

    def paint_overview(self, layout: bool = True) -> None:
        ln, p, t = self.line, self.pal, self.town.t
        if not ln:
            return
        parts: list[Any] = [self.head()]
        if ln.get("idea"):
            parts.append(Text(clip(ln["idea"], 400), style=p["muted"]))
        hatch = (ln.get("outputs") or {}).get("hatch") or {}
        ask = None
        if ln["status"] == "waiting":
            ask = ("查重报告出来了，等你决定", hatch.get("summary") or "看过调研后，决定立项还是调整 idea。",
                   [("h", "孵化并立项"), ("e", "调整 idea"), ("]", "先看调研")])
        elif ln["status"] in ("paused", "failed"):
            ask = ("流水线出错停下了" if ln["status"] == "failed" else "流水线暂停了",
                   ln.get("note") or (ln.get("current") or {}).get("note") or ln.get("reason") or "", [("r", "继续"), ("e", "调整方向")])
        if ask:
            keys = Text()
            for k, what in ask[2]:
                keys.append(f" {k} ", style=f"bold {p['bg']} on {p['brand']}")
                keys.append(f" {what}   ", style=p["ink"])
            parts.append(Panel(Group(Text(clip(ask[1], 300), style=p["ink"]), Text(), keys), title=Text(f" {ask[0]} ", style=f"bold {p['warn']}"),
                               title_align="left", border_style=p["warn"], padding=(0, 1)))
        stages = ln.get("stages") or []
        done = sum(s["status"] == "done" for s in stages)
        prog = Text("进度  ", style=p["muted"])
        prog.append_text(bar(ln.get("pct", 0) / 100, 24, p["brand"], p["raised"]))
        prog.append(f"  {done}/{len(stages)} 道工序 · 花了 {money(ln.get('spent'))}", style=p["muted"])
        if ln.get("budget"):
            prog.append(f" / {money(ln['budget'])}", style=p["muted"])
        parts += [Text(), prog, Text()]
        grid = Table.grid(padding=(0, 2))
        for col in ("mark", "name", "where", "state", "when"):
            grid.add_column(col, no_wrap=col != "state")
        for i, s in enumerate(stages):
            running = s["status"] == "run"
            name = gleam(s["name"], t, p["run"], p["hi"]) if running else Text(s["name"], style=p["ink"] if s["status"] != "todo" else p["muted"])
            state = Text(STAGE.get(s["status"], s["status"]), style=p["run"] if running else p["warn"] if s["status"] == "wait" else p["muted"])
            if s.get("note"):
                state.append(f" · {clip(s['note'], 40)}", style=p["muted"])
            if s.get("workers"):
                state.append(f"  {'、'.join(w.get('title') or w['id'] for w in s['workers'][:3])}", style=p["faint"])
            since = seconds_since(s.get("started_at")) if running else None
            when = Text(dur(since) if since is not None else (clock(s.get("ended_at")) if s.get("ended_at") else ""), style=p["muted"])
            grid.add_row(stage_mark(s["status"], t, p), Text.assemble((f"{i + 1} ", p["faint"]), name),
                         Text(self.town.building_name(s.get("building")), style=p["muted"]), state, when)
        parts.append(grid)
        facts = []
        if hatch.get("verdict"):
            facts.append(("查重", f"{hatch['verdict']}（最接近 {len(hatch.get('similar') or [])} 篇）"))
        if ln.get("reason"):
            facts.append(("编队", ln["reason"]))
        ws = self.ws or {}
        if ws.get("code"):
            c = ws["code"]
            facts.append(("代码", f"{c.get('name')} · {c.get('branch') or ''} · {'%d 处改动' % c['dirty'] if c.get('dirty') else '无改动'}"))
        if ws.get("paper"):
            pp = ws["paper"]
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
    def open_paper(self, e: DataTable.RowSelected) -> None:
        x = next((x for x in self.papers if x["paper_id"] == e.row_key.value), None)
        if x and x.get("url"):
            self.town.open_url(x["url"])

    def paint_tree(self, root: str) -> None:
        p = self.pal
        table = self.query_one(f"#pj-{root}-files", DataTable)
        files = self.files.get(root, [])
        sync_rows(table, [(f["path"], (Text(clip(f["path"], 30), style=p["ink"]), Text(size(f.get("size")), style=p["muted"]))) for f in files])
        view = self.query_one(f"#pj-{root}-view", Pane)
        info = (self.ws or {}).get(root)
        if not info:
            view.show(Text("这个项目还没有" + ("代码仓库" if root == "code" else "论文工程"), style=p["muted"]))
        elif not self.opened or self.opened[0] != root:
            keys = [("Enter", "看文件"), ("E", "改"), ("d", "看改动")] + ([("C", "编译"), ("P", "看 PDF")] if root == "paper" else [])
            body = [Text(f"{info.get('name')}  {info.get('path', '')}", style=f"bold {p['ink']}"),
                    Text(f"{'git · ' + (info.get('branch') or '') if info.get('git') else '不是 git 仓库'}"
                         f"{' · %d 处改动' % info['dirty'] if info.get('dirty') else ''} · {len(files)} 个文件", style=p["muted"]), Text()]
            body.append(Text.assemble(*[x for k, w in keys for x in ((k, f"bold {p['brand']}"), (f" {w}   ", p["muted"]))]))
            view.show(Padding(Group(*body), (0, 1)))

    @on(DataTable.RowSelected, "#pj-code-files")
    @on(DataTable.RowSelected, "#pj-paper-files")
    def open_file(self, e: DataTable.RowSelected) -> None:
        root = "code" if e.data_table.id == "pj-code-files" else "paper"
        self.view_file(root, e.row_key.value or "")

    @work(exclusive=True, group="pj-file")
    async def view_file(self, root: str, path: str, diff: bool = False) -> None:
        p = self.pal
        view = self.query_one(f"#pj-{root}-view", Pane)
        lid = self.line["id"] if self.line else ""
        try:
            if diff:
                text = await self.town.local.git_diff(((self.ws or {}).get(root) or {}).get("path") or "", path)  # git diff, run here
                view.show(Syntax(text, "diff", theme="ansi_dark" if self.town.theme == "papertown" else "ansi_light", word_wrap=False)
                          if text else Text(f"{path} 没有未提交的改动", style=p["muted"]))
                return
            f = await self.town.api.get(f"/api/lines/{lid}/ws/{root}/file", path=path)
        except ApiError as e:
            view.show(Text(str(e), style=p["bad"]))
            return
        self.opened = (root, path)
        if f.get("binary") or f.get("too_big"):
            view.show(Text(f"{path} · {size(f.get('size'))} · {'二进制文件' if f.get('binary') else '太大，不在这里显示'}"
                           + ("\nP 用系统的查看器打开" if path.endswith(".pdf") else ""), style=p["muted"]))
            self.opened_text = ""
            return
        self.opened_text = f.get("text") or ""
        view.show(Syntax(self.opened_text, lexer_for(path), theme="ansi_dark" if self.town.theme == "papertown" else "ansi_light",
                         line_numbers=True, word_wrap=False, indent_guides=False))
        view.scroll_home(animate=False)

    def current_file(self) -> tuple[str, str] | None:
        if self.tab not in ("code", "paper"):
            return None
        key = row_key(self.query_one(f"#pj-{self.tab}-files", DataTable))
        return (self.tab, key) if key else None

    def action_diff(self) -> None:
        cf = self.current_file()
        if cf:
            self.view_file(cf[0], cf[1], diff=True)

    @work(group="pj-edit")
    async def action_edit(self) -> None:
        cf = self.current_file()
        if not cf or not self.line:
            return
        lid = self.line["id"]
        try:
            f = await self.town.api.get(f"/api/lines/{lid}/ws/{cf[0]}/file", path=cf[1])
        except ApiError as e:
            self.town.notify(str(e), severity="error")
            return
        if f.get("binary") or f.get("too_big"):
            self.town.notify("这个文件不能在这里改", severity="warning")
            return
        text = await self.app.push_screen_wait(Editor(cf[1], f.get("text") or ""))
        if text is None or text == f.get("text"):
            return
        try:
            await self.town.api.put(f"/api/lines/{lid}/ws/{cf[0]}/file", {"path": cf[1], "text": text})
            self.town.notify(f"已保存 {cf[1]}")
            self.view_file(cf[0], cf[1])
        except ApiError as e:
            self.town.notify(str(e), title="没存上", severity="error")

    def paint_exp(self) -> None:
        p, t = self.pal, self.town.t
        d = self.data or {}
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
            if res.get("simulated"):
                parts.append(Text("⚠ 模拟电厂的模拟结果，不是真实实验", style=p["warn"]))
            tb = Table(box=None, header_style=f"bold {p['muted']}", pad_edge=False, padding=(0, 2))
            if "values" in res["rows"][0]:  # the farm's table: a row per method, a value per metric, ours marked
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
        runs = [r for r in d.get("runs") or [] if not str(r.get("id")).startswith("nvidb-")]  # nvidb's are in self.jobs, read here
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
        files = (self.line or {}).get("files") or []
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
        if not self.line:
            return
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
        p, ln = self.pal, self.line or {}
        parts: list[Any] = [self.head(), Text()]
        if self.agents:
            parts.append(Text("接入的 agent", style=f"bold {p['ink']}"))
            for a in self.agents:
                last = (a.get("last") or {})
                last_text = (last.get("data") or {}).get("text") or last.get("text") or ""
                parts.append(Text.assemble(("● " if a.get("started") else "○ ", p["ok"] if a.get("started") else p["faint"]),
                                           (self.town.agent_name(a["id"]), f"bold {p['ink']}"),
                                           (f"  {a.get('status', '')} · {a.get('runtime', '')} · {a.get('model') or ''} · {money(a.get('cost'))}", p["muted"])))
                if last_text:
                    parts.append(Text(f"   {clip(last_text, 120)}", style=p["faint"]))
            parts.append(Text.assemble(("Tab", f"bold {p['brand']}"), (" 在底下的框里换成「对它说」 · ", p["muted"]), ("4", f"bold {p['brand']}"), (" 到员工页看它在做什么", p["muted"])))
            parts.append(Text())
        workers = {}
        for s in ln.get("stages") or []:
            for w in s.get("workers") or []:
                workers.setdefault(w["id"], (w, []))[1].append(s["name"])
        if workers:
            parts.append(Text("小镇的员工", style=f"bold {p['ink']}"))
            for w, stages in workers.values():
                parts.append(Text.assemble((f"  {w.get('title') or w['id']}", p["ink"]), (f"  Lv.{w.get('level', '?')} · {'、'.join(stages)}", p["muted"])))
        if len(parts) == 2:
            parts.append(Text("还没有员工接手", style=p["muted"]))
        self.query_one("#team", Pane).show(Padding(Group(*parts), (1, 2)))

    # ---------- doing things ----------

    def hints(self) -> list[tuple[str, str]]:
        st = (self.line or {}).get("status")
        out = [("[ ]", "翻页"), ("f", "筛选"), ("/", "搜索"), ("n", "新 idea")]
        if st == "waiting":
            out.append(("h", "立项"))
        if st in ("paused", "failed"):
            out.append(("r", "继续"))
        if self.line:
            out += [("e", "调整"), ("a", "问")]
        if self.tab in ("code", "paper"):
            out += [("Enter", "看"), ("E", "改"), ("d", "改动")]
        if self.tab == "paper":
            out += [("C", "编译"), ("P", "PDF")]
        if self.tab in ("survey", "files"):
            out.append(("Enter", "打开" if self.tab == "survey" else "下载"))
        return out

    def context(self) -> dict[str, Any]:
        ctx: dict[str, Any] = {"line": self.sel}
        if self.tab == "team" and self.agents:
            ctx["agent"] = self.agents[0]["id"]
        return ctx

    def action_filter(self) -> None:
        keys = [k for k, _ in FILTERS]
        self.filter = keys[(keys.index(self.filter) + 1) % len(keys)]
        self.paint_list()

    @work(group="pj-ask")
    async def action_search(self) -> None:
        q = await self.app.push_screen_wait(Prompt("搜索项目", "按编号、标题或 idea 里的字找；空着回车就是不筛", self.search))
        self.search = q or ""
        self.paint_list()

    def action_idea(self) -> None:
        self.town.target_i = 0
        self.town.retarget()
        self.town.target_i = next((i for i, x in enumerate(self.town.targets) if x.kind == "idea"), 0)
        self.town.action_compose()

    def action_ask(self) -> None:
        self.town.retarget()
        i = next((i for i, x in enumerate(self.town.targets) if x.kind == "ask"), None)
        if i is not None:
            self.town.target_i = i
            self.town.action_compose()

    async def _act(self, path: str, done: str) -> None:
        try:
            await self.town.api.post(path)
            self.town.notify(done)
            self.town.schedule_refetch()
        except ApiError as e:
            self.town.notify(str(e), severity="error")

    async def action_hatch(self) -> None:
        if self.line and self.line["status"] == "waiting":
            await self._act(f"/api/lines/{self.line['id']}/hatch", f"#{self.line['seq']} 立项了，进造纸厂开工")

    async def action_resume(self) -> None:
        if self.line and self.line["status"] in ("paused", "failed", "waiting"):
            await self._act(f"/api/lines/{self.line['id']}/resume", f"#{self.line['seq']} 接着做")

    @work(group="pj-ask")
    async def action_adjust(self) -> None:
        if not self.line:
            return
        text = await self.app.push_screen_wait(Prompt(f"调整 #{self.line['seq']} 的方向", "一句话说怎么改，项目会按新方向接着做"))
        if text:
            try:
                await self.town.api.post(f"/api/lines/{self.line['id']}/adjust", {"text": text})
                self.town.notify("按新方向接着做", title=f"#{self.line['seq']}")
                self.town.schedule_refetch()
            except ApiError as e:
                self.town.notify(str(e), severity="error")

    @work(group="pj-ask")
    async def action_compile(self) -> None:
        if not self.line or self.tab != "paper":
            return
        if not await self.app.push_screen_wait(Confirm(f"编译 #{self.line['seq']} 的论文？", "用 latexmk 重新编译，会更新 PDF")):
            return
        self.town.notify("正在编译…")
        try:
            r = await self.town.api.post(f"/api/lines/{self.line['id']}/ws/paper/compile")
            ok = (r or {}).get("ok", True)
            self.town.notify((r or {}).get("note") or ("编译好了" if ok else "编译失败"), severity="information" if ok else "error")
        except ApiError as e:
            self.town.notify(str(e), title="编译失败", severity="error")

    def action_pdf(self) -> None:
        if not self.line:
            return
        path = f"/api/lines/{self.line['id']}/linked/pdf" if self.line.get("linked") else f"/api/lines/{self.line['id']}/ws/paper/pdf"
        self.town.open_url(self.town.api.url(path))

    def action_open(self) -> None:
        if self.tab == "files":
            key = row_key(self.query_one("#pj-files", DataTable))
            if key and self.line:
                self.town.open_url(self.town.api.url(f"/api/lines/{self.line['id']}/files/{key}"))
        elif self.tab == "survey":
            x = next((x for x in self.papers if x["paper_id"] == row_key(self.query_one("#pj-papers", DataTable))), None)
            if x and x.get("url"):
                self.town.open_url(x["url"])
