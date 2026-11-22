"""日报: the town's daily report (the web page's 运行状态): headlines, projects, new papers, resident leads and tools, with bars that grow in when the page opens."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from rich.columns import Columns
from rich.console import Group
from rich.padding import Padding
from rich.table import Table
from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding

from ..anim import Tween, bar
from ..client import ApiError
from ..look import LINE, clip, line_mark, pad
from ..widgets import Pane, Place


class Daily(Place):
    key = "daily"
    BINDINGS = [Binding("o", "open", "在浏览器里看", show=False)]

    def __init__(self) -> None:
        super().__init__(id="daily")
        self.s: dict = {}
        self.grow = Tween(0, rate=4)

    def compose(self) -> ComposeResult:
        yield Pane(id="dl-page")

    async def load(self) -> None:
        try:
            self.s = await self.town.api.get("/api/status")
        except ApiError as e:
            self.s = {"error": str(e)}
        self.grow = Tween(0, rate=4)
        self.grow.set(1)
        self.paint()

    def section(self, title: str) -> Text:
        return Text.assemble((title, f"bold {self.pal['brand']}"), (" " + "─" * 30, self.pal["faint"]))

    def paint(self, layout: bool = True) -> None:
        p, t, s, k = self.pal, self.town.t, self.s, self.grow.value
        if not s or s.get("error"):
            self.query_one("#dl-page", Pane).show(Text(s.get("error") or "加载中…", style=p["muted"]))
            return
        hud = s.get("hud") or {}
        parts: list[Any] = [Text.assemble(("Papertown 日报", f"bold {p['ink']}"), (f"   第 {hud.get('day', 1)} 天 · {datetime.now():%Y-%m-%d}", p["muted"])), Text()]
        news = s.get("headline") or []
        if news:
            for i, n in enumerate(news):
                lede, _, rest = n.partition("：")
                line = Text("· " if i else "", style=p["brand"])
                if rest:
                    line.append(lede + "：", style=f"bold {p['ink']}")
                    line.append(rest, style=p["ink"])
                else:
                    line.append(n, style=f"bold {p['ink']}" if not i else p["ink"])
                parts.append(line)
            parts.append(Text())
        projects = s.get("projects") or []
        if projects:
            parts.append(self.section("项目"))
            grid = Table.grid(padding=(0, 2))
            for _ in range(5):
                grid.add_column(no_wrap=True)
            for x in projects:
                prog = bar((x.get("pct") or 0) / 100 * k, 14, p["done"] if x.get("status") == "done" else p["brand"], p["raised"])
                prog.append(f" {x.get('pct') or 0:>3}%", style=p["muted"])
                grid.add_row(line_mark(x.get("status", ""), t, p), Text(f"#{x['seq']}", style=p["brand"]), Text(clip(x.get("title"), 34), style=p["ink"]),
                             Text(x.get("stage") or LINE.get(x.get("status", ""), ""), style=p["muted"]), prog)
            parts += [grid, Text()]
        papers = s.get("papers") or []
        if papers:
            parts.append(self.section("新入馆"))
            for x in papers[:8]:
                rel = bar((x.get("relevance") or 0) * k, 6, p["info"], p["raised"])
                parts.append(Text.assemble(rel, (f" {clip(x.get('title'), 60)}", p["ink"]), (f"  {x.get('year', '')}  {'、'.join(x.get('tags') or [])}", p["muted"])))
            parts.append(Text())
        side: list[Any] = []
        leads = hud.get("leads") or {}
        side += [self.section("负责人"), Text(f"{leads.get('running', 0)} 位运行 · {leads.get('on', 0)} 位开启", style=p["ink"]), Text()]
        calls = s.get("calls") or []
        if calls:
            side.append(self.section("调用"))
            top = max((c.get("count") or 0) for c in calls) or 1
            for c in calls:
                side.append(Text.assemble((f"{pad(c.get('name') or c.get('kind'), 12)} ", p["ink"]), bar((c.get("count") or 0) / top * k, 16, p["brand"], p["raised"]),
                                          (f" {c.get('count', 0)}", p["muted"])))
            side.append(Text())
        other: list[Any] = []
        lib = s.get("library") or {}
        if lib:
            graph = lib.get("graph") or {}
            other += [self.section("图书馆"), Text(f"馆藏 {lib.get('total', 0)} 篇 · arXiv {lib.get('arxiv', 0)} 篇"
                                                   + (f" · 引用边 {graph.get('edges', 0)} 条" if graph else ""), style=p["ink"]), Text()]
        skills = s.get("skills") or []
        if skills:
            other += [self.section("技能"), Text("、".join(x["name"] for x in skills), style=p["muted"]), Text()]
        if side or other:
            parts.append(Columns([Group(*side), Group(*other)], expand=True, equal=True, padding=(0, 4)))
        self.query_one("#dl-page", Pane).show(Padding(Group(*parts), (1, 3)), layout=layout)

    def tick(self, t: float) -> None:
        if not self.town.beat:
            return
        if self.grow.step(3 / 12) or any(x.get("status") in ("running", "linked") for x in self.s.get("projects") or []):
            self.paint(layout=False)

    def hints(self) -> list[tuple[str, str]]:
        return [("o", "在浏览器里看")]

    def action_open(self) -> None:
        self.town.open_url(self.town.api.url("/#view=status"))
