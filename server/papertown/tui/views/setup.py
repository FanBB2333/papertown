"""配置: how the town is set up: its staff's skills, the MCP servers behind their tools, the library
they search and the models they use."""

from __future__ import annotations

import asyncio
from typing import Any

from rich.console import Group
from rich.padding import Padding
from rich.text import Text
from textual import on, work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widgets import ContentSwitcher, DataTable, Static

from ..anim import bar, breathe, mix
from ..client import ApiError
from ..look import clip
from ..widgets import Bar, Confirm, Form, Pane, Place, Prompt, row_key, sync_rows
from . import cycle, tabs

PAGES = [("skills", "技能"), ("mcp", "MCP"), ("library", "图书馆"), ("models", "模型")]


class Setup(Place):
    key = "setup"
    BINDINGS = [
        Binding("left_square_bracket", "page(-1)", "上一页", show=False), Binding("right_square_bracket", "page(1)", "下一页", show=False),
        Binding("t", "toggle", "启用/停用", show=False), Binding("r", "restart", "重连", show=False), Binding("n", "add", "添加", show=False),
        Binding("d", "remove", "删除", show=False), Binding("slash", "search", "检索", show=False), Binding("e", "edit", "改", show=False),
    ]

    def __init__(self) -> None:
        super().__init__(id="setup")
        self.page = "skills"
        self.skills: list[dict] = []
        self.skim: dict = {}
        self.mcp: dict = {}
        self.rag: dict = {}
        self.hits: list[dict] = []
        self.query_text = ""
        self.llm: dict = {}

    def compose(self) -> ComposeResult:
        with Vertical():
            yield Bar(id="su-tabs", classes="tabs")
            with ContentSwitcher(id="su-pages", initial="skills"):
                with Horizontal(id="skills"):
                    yield DataTable(id="su-skills", cursor_type="row", classes="list-col")
                    yield Pane(id="su-skill", classes="detail-col")
                with Horizontal(id="mcp"):
                    yield DataTable(id="su-mcp", cursor_type="row", classes="list-col")
                    yield Pane(id="su-server", classes="detail-col")
                with Vertical(id="library"):
                    yield Static(id="su-rag", classes="note")
                    with Horizontal():
                        yield DataTable(id="su-hits", cursor_type="row", classes="list-col wide")
                        yield Pane(id="su-hit", classes="detail-col")
                yield Pane(id="models")

    def on_mount(self) -> None:
        s = self.query_one("#su-skills", DataTable)
        s.add_column("技能", key="name", width=26)
        s.add_column("岗位", key="roles", width=28)
        m = self.query_one("#su-mcp", DataTable)
        for k, label, w in [("mark", "", 1), ("name", "接线", 14), ("src", "来源", 7), ("tools", "工具", 4)]:
            m.add_column(label, key=k, width=w)
        h = self.query_one("#su-hits", DataTable)
        for k, label, w in [("score", "相关", 9), ("title", "论文", 46), ("year", "年份", 4)]:
            h.add_column(label, key=k, width=w)

    def paint_tabs(self) -> None:
        p = self.pal
        out = tabs(PAGES, self.page, p)
        out.append("   [ ] 换页", style=p["faint"])
        self.query_one("#su-tabs", Static).update(out, layout=False)

    async def load(self) -> None:
        self.paint_tabs()
        api = self.town.api
        try:
            if self.page == "skills":
                self.skills, self.skim = await asyncio.gather(self.town.local.town_skills(), self.town.local.skim_store())
                self.paint_skills()
            elif self.page == "mcp":
                self.mcp = await api.get("/api/mcp")
                self.paint_mcp()
            elif self.page == "library":
                self.rag = await api.get("/api/rag")
                self.paint_library()
            else:
                self.llm = await api.get("/api/llm")
                self.paint_models()
        except ApiError as e:
            self.town.notify(str(e), severity="error")

    def paint_skills(self) -> None:
        p = self.pal
        rows = [(f"town:{s['name']}", (Text(clip(s["name"], 26), style=p["ink"]), Text(clip("、".join(s.get("roles") or []), 28), style=p["muted"])))
                for s in self.skills]
        rows += [(f"skim:{s['name']}", (Text(clip(s["name"], 26), style=p["muted"]), Text("skim", style=p["faint"]))) for s in self.skim.get("store") or []]
        sync_rows(self.query_one("#su-skills", DataTable), rows)
        self.peek_skill()

    @on(DataTable.RowHighlighted, "#su-skills")
    def peek_skill(self, e: DataTable.RowHighlighted | None = None) -> None:
        p = self.pal
        key = (e.row_key.value if e else row_key(self.query_one("#su-skills", DataTable))) or ""
        src, _, name = key.partition(":")
        pool = self.skills if src == "town" else self.skim.get("store") or []
        s = next((x for x in pool if x["name"] == name), None)
        if not s:
            return
        parts: list[Any] = [Text(s["name"], style=f"bold {p['ink']}"), Text("小镇自己的技能（server/skills）" if src == "town" else f"skim 里的技能 · {self.skim.get('bin', '')}", style=p["muted"]), Text(),
                            Text(s.get("description") or "", style=p["ink"])]
        for k, label in (("roles", "岗位"), ("allowed_tools", "能用的工具"), ("scripts", "脚本"), ("references", "参考")):
            if s.get(k):
                parts.append(Text.assemble((f"{label}  ", p["muted"]), ("、".join(s[k]), p["ink"])))
        parts += [Text(), Text("技能文件改了会自动重新加载（热插拔）", style=p["faint"])]
        self.query_one("#su-skill", Pane).show(Padding(Group(*parts), (0, 1)))

    def servers(self) -> list[dict]:
        return self.mcp.get("servers") or []

    def server(self) -> dict | None:
        key = row_key(self.query_one("#su-mcp", DataTable))
        return next((s for s in self.servers() if s["name"] == key), None)

    def mcp_mark(self, s: dict, t: float) -> Text:
        p = self.pal
        if not s.get("enabled"):
            return Text("○", style=p["faint"])
        if s.get("state") == "ok":
            return Text("●", style=p["ok"])
        if s.get("state") == "error":
            return Text("●", style=p["bad"])
        return Text("●", style=mix(p["warn"], p["hi"], breathe(t)))

    def paint_mcp(self) -> None:
        p, t = self.pal, self.town.t
        sync_rows(self.query_one("#su-mcp", DataTable), [
            (s["name"], (self.mcp_mark(s, t), Text(clip(s["name"], 14), style=p["ink"]), Text(s.get("source", ""), style=p["muted"]),
                         Text(str(len(s.get("tools") or [])), style=p["muted"]))) for s in self.servers()])
        self.peek_server()

    @on(DataTable.RowHighlighted, "#su-mcp")
    def peek_server(self, e: DataTable.RowHighlighted | None = None) -> None:
        p, s = self.pal, self.server()
        if not s:
            self.query_one("#su-server", Pane).show(Text("还没有接线", style=p["muted"]))
            return
        parts: list[Any] = [Text.assemble((s["name"], f"bold {p['ink']}"), (f"  {'在用' if s.get('enabled') else '停用'} · {s.get('state') or ''}", p["muted"]))]
        if s.get("error"):
            parts.append(Text(s["error"], style=p["bad"]))
        parts.append(Text(f"{s.get('command', '')} {' '.join(s.get('args') or [])}", style=p["muted"]))
        if s.get("cwd"):
            parts.append(Text(f"在 {s['cwd']}", style=p["faint"]))
        parts.append(Text())
        for tool in s.get("tools") or []:
            parts.append(Text.assemble((f"  {tool.get('name')}", f"bold {p['ink']}"), (f"  {clip(tool.get('description'), 240)}", p["muted"])))
        parts += [Text(), Text.assemble(*[x for k, w in [("t", "启用/停用"), ("r", "重连"), ("n", "添加")] + ([("d", "删除")] if s.get("source") == "town" else [])
                                          for x in ((k, f"bold {p['brand']}"), (f" {w}   ", p["muted"]))])]
        self.query_one("#su-server", Pane).show(Padding(Group(*parts), (0, 1)))

    def paint_library(self) -> None:
        p, r = self.pal, self.rag
        st, opts = r.get("stats") or {}, r.get("opts") or {}
        src = " · ".join(f"{k} {v}" for k, v in (st.get("sources") or {}).items())
        line = Text.assemble((f" 馆藏 {st.get('papers', 0)} 篇", f"bold {p['ink']}"), (f"（{src}） · 向量 {st.get('vectors', 0)} · 词 {st.get('terms', 0)}", p["muted"]),
                             (f"\n {r.get('index', '')}", p["faint"]),
                             (f"\n 召回 {opts.get('candidates')} 篇候选，取前 {opts.get('top_k')} 篇 · 向量 {'开' if opts.get('vectors') else '关'}", p["muted"]),
                             ("    /", f"bold {p['brand']}"), (" 检索  ", p["muted"]), ("e", f"bold {p['brand']}"), (" 改召回参数", p["muted"]))
        if self.query_text:
            line.append(f"\n 「{self.query_text}」找到 {len(self.hits)} 篇", style=p["brand"])
        self.query_one("#su-rag", Static).update(line)
        top = max((h.get("similarity") or 0 for h in self.hits), default=1) or 1
        rows = []
        for i, h in enumerate(self.hits):
            cell = bar((h.get("similarity") or 0) / top, 5, p["info"], p["raised"])
            cell.append(f" {h.get('similarity') or 0:.2f}" if h.get("similarity") is not None else "", style=p["muted"])
            rows.append((h.get("paper_id") or str(i), (cell, Text(clip(h.get("title"), 46), style=p["ink"]), Text(str(h.get("year") or ""), style=p["muted"]))))
        sync_rows(self.query_one("#su-hits", DataTable), rows)
        self.peek_hit()

    @on(DataTable.RowHighlighted, "#su-hits")
    def peek_hit(self, e: DataTable.RowHighlighted | None = None) -> None:
        p = self.pal
        key = e.row_key.value if e else row_key(self.query_one("#su-hits", DataTable))
        h = next((x for x in self.hits if x.get("paper_id") == key), None)
        if not h:
            self.query_one("#su-hit", Pane).show(Text("按 / 在馆藏里检索", style=p["muted"]))
            return
        self.query_one("#su-hit", Pane).show(Padding(Group(Text(h.get("title") or "", style=f"bold {p['ink']}"),
                                                           Text(f"{clip(h.get('authors'), 80)} · {h.get('year', '')}", style=p["muted"]),
                                                           Text(f"命中：{'、'.join(h.get('matched') or [])}" + (f"   {'、'.join(h.get('tags') or [])}" if h.get("tags") else ""), style=p["info"]),
                                                           Text(clip(h.get("snippet") or h.get("abstract"), 900), style=p["ink"]),
                                                           Text.assemble(("Enter", f"bold {p['brand']}"), (f" 打开 {h.get('url', '')}", p["muted"]))), (0, 1)))

    @on(DataTable.RowSelected, "#su-hits")
    def open_hit(self, e: DataTable.RowSelected) -> None:
        h = next((x for x in self.hits if x.get("paper_id") == e.row_key.value), None)
        if h and h.get("url"):
            self.town.open_url(h["url"])

    def paint_models(self) -> None:
        p, m = self.pal, self.llm
        parts: list[Any] = [Text.assemble(("现在用  ", p["muted"]), (f"{m.get('provider')}", f"bold {p['ink']}"),
                                          ("（离线：员工按 skill 的步骤调用真实工具，文字部分用模板）" if m.get("offline") else "", p["warn"])),
                            Text.assemble(("强模型  ", p["muted"]), (m.get("model_strong") or "—", p["ink"])),
                            Text.assemble(("便宜模型  ", p["muted"]), (m.get("model_cheap") or "—", p["ink"])),
                            Text.assemble(("思考强度  ", p["muted"]), (m.get("effort") or "—", p["ink"]))]
        if m.get("openai_base_url"):
            parts.append(Text.assemble(("OpenAI 兼容地址  ", p["muted"]), (m["openai_base_url"], p["faint"])))
        parts += [Text(), Text("可选", style=f"bold {p['ink']}")]
        for pr in m.get("providers") or []:
            parts.append(Text.assemble((f"  {pr.get('name')}", p["ink"]), (f"  {pr.get('id')} · {'、'.join((pr.get('models') or [])[:6])}", p["muted"])))
        parts += [Text(), Text.assemble(("e", f"bold {p['brand']}"), (" 换模型（key 放在 ~/.secrets.zsh 之类的环境里，这里不收）", p["muted"]))]
        self.query_one("#models", Pane).show(Padding(Group(*parts), (1, 2)))

    def tick(self, t: float) -> None:
        if self.page == "mcp" and self.town.beat:
            table = self.query_one("#su-mcp", DataTable)
            for s in self.servers():
                if s.get("enabled") and s.get("state") not in ("ok", "error"):
                    table.update_cell(s["name"], "mark", self.mcp_mark(s, t))

    def on_town_event(self, ev: dict) -> None:
        if self.is_mounted and self.town.place == "setup" and ev.get("type") in ("skills", "llm", "library"):
            self.reload()

    @work(exclusive=True, group="su-load")
    async def reload(self) -> None:
        await self.load()

    def hints(self) -> list[tuple[str, str]]:
        return {"skills": [("[ ]", "换页")], "mcp": [("[ ]", "换页"), ("t", "启用/停用"), ("r", "重连"), ("n", "添加"), ("d", "删除")],
                "library": [("[ ]", "换页"), ("/", "检索"), ("e", "召回参数"), ("Enter", "打开")], "models": [("[ ]", "换页"), ("e", "换模型")]}[self.page]

    def context(self) -> dict[str, Any]:
        return {"building": {"skills": "academy", "mcp": "exchange", "library": "library"}.get(self.page)}

    def action_page(self, step: int) -> None:
        self.page = cycle(PAGES, self.page, step)
        self.query_one("#su-pages", ContentSwitcher).current = self.page
        self.town.paint_hints()
        self.run_worker(self.load(), exclusive=True, group="su-page", exit_on_error=False)

    async def _post(self, path: str, body: Any, done: str) -> None:
        try:
            await self.town.api.post(path, body)
            self.town.notify(done)
        except ApiError as e:
            self.town.notify(str(e), severity="error")
        await self.load()

    async def action_toggle(self) -> None:
        if self.page == "mcp" and (s := self.server()):
            await self._post(f"/api/mcp/servers/{s['name']}/toggle", {"enabled": not s.get("enabled")}, f"{s['name']} {'停用' if s.get('enabled') else '启用'}了")

    async def action_restart(self) -> None:
        if self.page == "mcp" and (s := self.server()):
            await self._post(f"/api/mcp/servers/{s['name']}/restart", None, f"{s['name']} 正在重连")

    @work(group="su-ask")
    async def action_add(self) -> None:
        if self.page != "mcp":
            return
        v = await self.app.push_screen_wait(Form("接一条 MCP", [("name", "名字", ""), ("command", "命令（比如 uvx、npx）", ""), ("args", "参数（空格分开）", "")],
                                                 hint=f"写进 {self.mcp.get('town_file', '小镇的配置')}，员工就能用它的工具"))
        if v and v.get("name") and v.get("command"):
            await self._post("/api/mcp/servers", {"name": v["name"], "command": v["command"], "args": (v.get("args") or "").split()}, f"接上了 {v['name']}")

    @work(group="su-ask")
    async def action_remove(self) -> None:
        s = self.server() if self.page == "mcp" else None
        if not s:
            return
        if s.get("source") != "town":
            self.town.notify("只有小镇配置里加的接线能在这里删", severity="warning")
            return
        if await self.app.push_screen_wait(Confirm(f"删掉 {s['name']} 这条线？", "它的工具会从员工的工具箱里拿掉")):
            try:
                await self.town.api.delete(f"/api/mcp/servers/{s['name']}")
                self.town.notify("已删除")
            except ApiError as e:
                self.town.notify(str(e), severity="error")
            await self.load()

    @work(group="su-ask")
    async def action_search(self) -> None:
        if self.page != "library":
            return
        q = await self.app.push_screen_wait(Prompt("在馆藏里检索", "关键词或一句话", self.query_text))
        if not q:
            return
        self.query_text = q
        try:
            self.hits = (await self.town.api.get("/api/rag/search", q=q)).get("hits") or []
        except ApiError as e:
            self.town.notify(str(e), severity="error")
            return
        self.paint_library()
        self.query_one("#su-hits", DataTable).focus()

    @work(group="su-ask")
    async def action_edit(self) -> None:
        if self.page == "library":
            o, lim = self.rag.get("opts") or {}, self.rag.get("limits") or {}
            v = await self.app.push_screen_wait(Form("召回参数", [
                ("top_k", f"取前几篇（{'–'.join(str(x) for x in lim.get('top_k') or [])}）", o.get("top_k")),
                ("candidates", f"候选多少篇（{'–'.join(str(x) for x in lim.get('candidates') or [])}）", o.get("candidates")),
                ("vectors", "向量召回", bool(o.get("vectors")), [("开", True), ("关", False)])]))
            if v:
                try:
                    body = {"top_k": int(v["top_k"]), "candidates": int(v["candidates"]), "vectors": v["vectors"]}
                except (TypeError, ValueError):
                    self.town.notify("要填数字", severity="error")
                    return
                await self._post("/api/rag", body, "召回参数改好了")
        elif self.page == "models":
            m = self.llm
            providers = [(f"{pr.get('name')}（{pr.get('id')}）", pr["id"]) for pr in m.get("providers") or []]
            v = await self.app.push_screen_wait(Form("换模型", [
                ("provider", "用哪家", m.get("provider"), providers),
                ("model_strong", "强模型", m.get("model_strong")), ("model_cheap", "便宜模型", m.get("model_cheap")),
                ("effort", "思考强度", m.get("effort") or "medium", [("低", "low"), ("中", "medium"), ("高", "high")])]))
            if v:
                await self._post("/api/llm", {k: v[k] for k in ("provider", "model_strong", "model_cheap", "effort") if v.get(k)}, "换好了")
