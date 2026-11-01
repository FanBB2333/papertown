"""对话: what the town says (each department's reports and answers, what you said to it), with the
calls behind it if you want them; and the console's assistant, its conversation and the actions it
asks you to approve."""

from __future__ import annotations

from typing import Any

from rich.console import Group
from rich.padding import Padding
from rich.text import Text
from textual import work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.widgets import ContentSwitcher, Static

from ..anim import clock, mix
from ..client import ApiError
from ..look import clip
from ..widgets import Pane, Place, Prompt, transcript, writing

PAGES = [("town", "小镇"), ("assistant", "小助手")]


class Chat(Place):
    key, title, animated = "chat", "对话", True
    BINDINGS = [
        Binding("left_square_bracket,right_square_bracket", "page", "换页", show=False), Binding("t", "trace", "调用记录"),
        Binding("p", "project", "项目"), Binding("y", "act(True)", "批准", show=False), Binding("N", "act(False)", "不批", show=False),
        Binding("C", "new", "新对话", show=False), Binding("H", "history", "历史", show=False), Binding("G", "end", "到底", show=False),
    ]

    def __init__(self) -> None:
        super().__init__(id="chat")
        self.page = "town"
        self.trace = False
        self.project: str | None = None
        self.assistant: dict | None = None
        self.items: list[dict] = []
        self.seen = 0

    def compose(self) -> ComposeResult:
        with Vertical():
            yield Static(id="ch-tabs", classes="tabs")
            with ContentSwitcher(id="ch-pages", initial="town"):
                yield Pane(id="town")
                yield Pane(id="assistant")

    async def load(self) -> None:
        self.paint_tabs()
        if self.page == "assistant":
            try:
                self.assistant, tl = await self.town.api.get("/api/assistant"), await self.town.api.get("/api/agents/assistant/timeline", limit=200)
                self.items = tl.get("items") or []
            except ApiError as e:
                self.assistant, self.items = {}, [{"kind": "error", "text": str(e)}]
            self.paint_assistant()
        else:
            self.paint_town(scroll=True)

    def paint_tabs(self) -> None:
        p = self.pal
        out = Text()
        for k, label in PAGES:
            out.append(f" {label} ", style=f"bold {p['brand']} underline" if k == self.page else p["muted"])
            out.append(" ")
        if self.page == "town":
            out.append(f"   项目：{'全部' if not self.project else self.seq(self.project)}", style=p["faint"])
            out.append("   调用记录：" + ("显示" if self.trace else "不显示"), style=p["faint"])
        out.append("   [ ] 换页", style=p["faint"])
        self.query_one("#ch-tabs", Static).update(out, layout=False)

    def seq(self, line_id: str | None) -> str:
        ln = next((x for x in self.town.lines if x["id"] == line_id), None)
        return f"#{ln['seq']}" if ln else (line_id or "")

    def message(self, m: dict, t: float) -> list[Any]:
        p = self.pal
        body = m.get("body") or {}
        role, kind = m.get("role"), m.get("kind")
        head = Text()
        if role == "user":
            head.append("你", style=f"bold {p['brand']}")
            if body.get("to"):
                head.append(f" → {self.town.building_name(body['to'])}", style=p["muted"])
        elif role == "worker":
            who = (m.get("worker") or {}).get("title") or m.get("worker_id") or "员工"
            head.append(who, style=f"bold {p['ink']}")
            if body.get("from"):
                head.append(f" @ {self.town.building_name(body['from'])}", style=p["muted"])
        else:
            head.append("小镇", style=f"bold {p['bad'] if kind == 'error' else p['muted']}")
        if m.get("line_id"):
            head.append(f"  {self.seq(m['line_id'])}", style=p["brand"])
        head.append(f"  {clock(m.get('ts'))}", style=p["faint"])
        text = body.get("text") or body.get("note") or body.get("title") or ""
        lines: list[Any] = [head]
        if text:
            lines.append(Text(f"  {clip(text, 1200) if len(text) > 1200 else text}", style=p["bad"] if kind == "error" else p["ink"]))
        rep = body.get("report") or {}
        for s in (rep.get("similar") or [])[:3]:
            lines.append(Text(f"  · {clip(s.get('title'), 70)}  {s.get('similarity', 0):.2f}", style=p["muted"]))
        if body.get("files"):
            lines.append(Text(f"  文件：{'、'.join(body['files'])}", style=p["muted"]))
        glow = self.town.glow.k(("msg", m["id"]), t)
        if glow:
            for x in lines:
                if isinstance(x, Text):
                    x.stylize(f"on {mix(p['bg'], p['brand'], glow * 0.3)}")
        return lines

    def paint_town(self, scroll: bool = False, layout: bool = True) -> None:
        p, t = self.pal, self.town.t
        rows: list[tuple[str, dict]] = [(m.get("ts") or "", {"m": m}) for m in self.town.messages if not self.project or m.get("line_id") == self.project]
        if self.trace:
            rows += [(r.get("ts") or "", {"r": r}) for r in self.town.trace if not self.project or r.get("line_id") == self.project]
        rows.sort(key=lambda x: x[0])
        parts: list[Any] = []
        for _, x in rows[-300:]:
            if "m" in x:
                parts += self.message(x["m"], t)
                parts.append(Text())
            else:
                r = x["r"]
                parts.append(Text(f"    ↳ {r.get('kind', '')} {r.get('label', '')}  {clip(r.get('detail'), 70)}  {self.seq(r.get('line_id'))}", style=p["faint"]))
        if not parts:
            parts = [Text("还没有对话。在底下的框里写一个 idea，或者问哪个部门在做什么。", style=p["muted"])]
        pane = self.query_one("#town", Pane)
        bottom = pane.scroll_offset.y >= pane.max_scroll_y - 2
        pane.show(Padding(Group(*parts), (0, 1)), layout=layout)
        if scroll or bottom:
            pane.scroll_end(animate=False)
        self.seen = len(self.town.messages)

    def paint_assistant(self) -> None:
        p, t = self.pal, self.town.t
        a = (self.assistant or {}).get("agent") or {}
        head = Text.assemble(("✦ ", f"bold {p['brand']}"), ("小助手", f"bold {p['ink']}"),
                             (f"  {a.get('status', '')} · {a.get('model') or ''}" if a else "  还没启动：在底下的框里问它，它就会开工", p["muted"]))
        parts: list[Any] = [head, Text()]
        parts += transcript(self.items[-60:], p, self.town.theme == "papertown")
        parts += writing(self.town.streaming.get("assistant"), t, p)
        for q in (self.assistant or {}).get("asks") or []:
            if not q.get("data", q).get("answer"):
                d = q.get("data", q)
                parts += [Text.assemble((" 它在问 ", f"bold {p['bg']} on {p['info']}"), (f" {d.get('question', '')}", p["ink"]))]
                if d.get("choices"):
                    parts.append(Text("  " + " / ".join(d["choices"]), style=p["muted"]))
                parts.append(Text("  在底下的框里回答", style=p["faint"]))
        for act in (self.assistant or {}).get("acts") or []:
            d = act.get("data") or {}
            if d.get("status") == "pending":
                parts += [Text(), Text.assemble((" 它想 ", f"bold {p['bg']} on {p['warn']}"), (f" {d.get('title') or d.get('action')}", f"bold {p['ink']}")),
                          Text(f"  {d.get('why') or ''}", style=p["muted"]),
                          Text.assemble(("  y", f"bold {p['brand']}"), (" 批准  ", p["muted"]), ("N", f"bold {p['brand']}"), (" 不批", p["muted"]))]
        pane = self.query_one("#assistant", Pane)
        pane.show(Padding(Group(*parts), (0, 1)))
        pane.scroll_end(animate=False)

    def tick(self, t: float) -> None:
        if not self.town.beat:
            return
        if self.page == "town" and len(self.town.messages) != self.seen:
            self.paint_town()
        elif self.page == "town" and self.town.glow.live:  # new ones fading in: the same lines, other colours
            self.paint_town(layout=False)
        elif self.page == "assistant" and "assistant" in self.town.streaming:
            self.paint_assistant()

    def on_town_event(self, ev: dict) -> None:
        kind = ev.get("type")
        if kind == "message":
            self.town.glow.touch(("msg", ev["message"]["id"]), self.town.t)
        if not self.is_mounted or self.town.place != "chat":
            return
        if kind == "trace" and self.trace and self.page == "town":
            self.paint_town()
        if self.page == "assistant" and (kind in ("agent_event", "agent") and "assistant" in str(ev)[:400] or kind == "assistant_show"):
            self.refresh_assistant()

    @work(exclusive=True, group="ch-load")
    async def refresh_assistant(self) -> None:
        await self.load()

    # ---------- doing things ----------

    def hints(self) -> list[tuple[str, str]]:
        if self.page == "assistant":
            out = [("[ ]", "换页"), ("C", "新对话"), ("H", "历史")]
            if any((a.get("data") or {}).get("status") == "pending" for a in (self.assistant or {}).get("acts") or []):
                out += [("y", "批准"), ("N", "不批")]
            return out
        return [("[ ]", "换页"), ("p", "按项目看"), ("t", "调用记录"), ("G", "到底")]

    def context(self) -> dict[str, Any]:
        return {"line": self.project} if self.project else {}

    def action_page(self) -> None:
        self.page = "assistant" if self.page == "town" else "town"
        self.query_one("#ch-pages", ContentSwitcher).current = self.page
        if self.page == "assistant":
            self.town.target_i = next((i for i, x in enumerate(self.town.targets) if x.kind == "assistant"), self.town.target_i)
        self.town.paint_hints()
        self.run_worker(self.load(), exclusive=True, group="ch-page", exit_on_error=False)

    def action_trace(self) -> None:
        self.trace = not self.trace
        self.paint_tabs()
        self.paint_town(scroll=True)

    def action_project(self) -> None:
        ids = [None, *[ln["id"] for ln in sorted(self.town.lines, key=lambda x: -x["seq"])]]
        self.project = ids[(ids.index(self.project) + 1) % len(ids)] if self.project in ids else None
        self.town.retarget()
        self.paint_tabs()
        self.paint_town(scroll=True)

    def action_end(self) -> None:
        self.query_one(f"#{self.page}", Pane).scroll_end(animate=False)

    async def action_act(self, allow: bool) -> None:
        pending = [a for a in (self.assistant or {}).get("acts") or [] if (a.get("data") or {}).get("status") == "pending"]
        if self.page != "assistant" or not pending:
            return
        try:
            r = await self.town.api.post(f"/api/assistant/acts/{pending[0]['id']}", {"allow": allow})
            self.town.notify(((r or {}).get("data") or {}).get("result") or ("批准了" if allow else "没批"))
        except ApiError as e:
            self.town.notify(str(e), severity="error")
        await self.load()

    async def action_new(self) -> None:
        if self.page != "assistant":
            return
        try:
            await self.town.api.post("/api/assistant/new")
            self.town.notify("开了一个新对话")
        except ApiError as e:
            self.town.notify(str(e), severity="error")
        await self.load()

    @work(group="ch-ask")
    async def action_history(self) -> None:
        if self.page != "assistant":
            return
        try:
            convs = (await self.town.api.get("/api/assistant/history")).get("conversations") or []
        except ApiError as e:
            self.town.notify(str(e), severity="error")
            return
        if not convs:
            self.town.notify("还没有别的对话")
            return
        listing = "\n".join(f"{i + 1}. {clip(c.get('title'), 40)}  {clock(c.get('at'))}{'  ← 现在这个' if c.get('current') else ''}" for i, c in enumerate(convs[:20]))
        n = await self.app.push_screen_wait(Prompt("接着哪个对话？", listing, placeholder="输入编号"))
        if n and n.isdigit() and 0 < int(n) <= len(convs):
            try:
                await self.town.api.post("/api/assistant/resume", {"id": convs[int(n) - 1]["id"]})
                self.town.notify("接上了")
            except ApiError as e:
                self.town.notify(str(e), severity="error")
            await self.load()
