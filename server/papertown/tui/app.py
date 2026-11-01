"""The terminal view of the town. Top to bottom: the masthead (the town's numbers, counting up), the
ribbon (what is happening right now, moving while it does), the index of places on the left and the
place itself, the box you talk to the town through, and the keys that work where you are."""

from __future__ import annotations

import asyncio
import time
import webbrowser
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from rich.text import Text
from textual import on, work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Center, Horizontal, Middle
from textual.screen import Screen
from textual.widgets import ContentSwitcher, Input, Static

from .anim import Glow, Tween, breathe, dur, gleam, mix, parse_ts, star
from .client import Api, ApiError, LocalServer
from .local import Local
from .look import PALETTES, clip, doing, themes
from .widgets import Help, Place

# the events after which the numbers and the lists are fetched again, as the page does
TICK = {"line", "world", "building", "bank", "power", "workers", "library", "skills", "job", "agent"}
LOGO = ["   ▗▖      ", "  ▐▀▀▙▖ ▗▌", " ▐▀▀▀▀▀▀▀▌", " ▐▬▬▬▬  ▄▌", " ▝▀▀▀▀▀▀▘ "]


@dataclass
class Target:
    """who the box at the bottom talks to"""

    kind: str  # idea | ask | adjust | say | assistant
    label: str
    line: str | None = None
    building: str | None = None
    agent: str | None = None


class Masthead(Static):
    def __init__(self) -> None:
        super().__init__(id="masthead")
        self.n = {k: Tween() for k in ("running", "waiting", "total", "week", "gpus", "idle")}

    def line(self, t: float) -> Text:
        town: Papertown = self.app  # type: ignore[assignment]
        p, hud = town.pal, town.hud
        v = {k: tw.value for k, tw in self.n.items()}
        out = Text()
        out.append(" ⌂ ", style=f"bold {p['brand']}")
        out.append("Papertown", style=f"bold {p['ink']}")
        if hud:
            out.append(f"  第 {hud.get('day', 1)} 天", style=p["muted"])
        out.append("   ")
        out.append(f"{v['running']:.0f}", style=f"bold {p['run']}")
        out.append(" 在跑  ", style=p["muted"])
        out.append(f"{v['waiting']:.0f}", style=f"bold {mix(p['warn'], p['hi'], breathe(t) * 0.5) if hud and hud['lines']['waiting'] else p['muted']}")
        out.append(" 等你决定  ", style=p["muted"])
        out.append(f"{v['total']:.0f}", style=f"bold {p['ink']}")
        out.append(" 个项目", style=p["muted"])
        if hud:
            out.append("   本周 ", style=p["muted"])
            out.append(f"${v['week']:.2f}", style=f"bold {p['ink']}")
            out.append(f" / ${hud['bank'].get('budget', 0):.0f}", style=p["muted"])
        if town.gpu_summary:
            out.append("   GPU ", style=p["muted"])
            out.append(f"{v['gpus']:.0f}", style=f"bold {p['ink']}")
            out.append(" 张 · ", style=p["muted"])
            out.append(f"{v['idle']:.0f}", style=f"bold {p['ok']}")
            out.append(" 张空闲", style=p["muted"])
        right = Text()
        if hud:
            right.append(" 离线模式 " if hud.get("offline") else f" {hud.get('provider', '')} ", style=f"{p['warn'] if hud.get('offline') else p['ok']} on {p['raised']}")
            right.append("  ")
        right.append("● " if town.online else f"{star(t, 8)} ", style=p["ok"] if town.online else p["bad"])
        right.append("已连接" if town.online else "重连中", style=p["muted"])
        right.append(f"  {datetime.now():%H:%M} ", style=p["muted"])
        pad = max(1, self.size.width - out.cell_len - right.cell_len)
        out.append(" " * pad)
        out.append_text(right)
        return out

    def frame(self, t: float, dt: float) -> None:
        town: Papertown = self.app  # type: ignore[assignment]
        hud = town.hud
        if hud:
            self.n["running"].set(hud["lines"]["running"])
            self.n["waiting"].set(hud["lines"]["waiting"])
            self.n["total"].set(hud["lines"]["total"])
            self.n["week"].set(hud["bank"].get("week", 0))
        if town.gpu_summary:
            self.n["gpus"].set(town.gpu_summary.get("total", town.gpu_summary.get("gpus", 0)))
            self.n["idle"].set(town.gpu_summary.get("idle", 0))
        for tw in self.n.values():
            tw.step(dt)
        self.update(self.line(t), layout=False)  # one line, always: no layout pass at 12 fps


class Ribbon(Static):
    """What the town is doing right now: a turning star and a gleam along the words while it works,
    the time it has been at it, and the star warming to red when the stream has been quiet too long."""

    def __init__(self) -> None:
        super().__init__(id="ribbon")
        self.seen: dict[str, float] = {}  # when an activity without a start time was first seen

    def activities(self) -> list[tuple[str, float | None]]:
        town: Papertown = self.app  # type: ignore[assignment]
        now = time.time()
        out: list[tuple[str, float | None]] = []
        if town.asking:
            out.append((f"{town.building_name(town.asking[0])}在想怎么回答你", town.asking[1]))
        for aid, (text, t0, last) in town.streaming.items():
            if now - last < 10:
                out.append((f"{town.agent_name(aid)}在写：{clip(text.strip().splitlines()[-1] if text.strip() else '', 40)}", t0))
        for ln in town.lines:
            if ln["status"] in ("running", "hatching"):
                cur = ln.get("current") or {}
                started = parse_ts(cur.get("started_at"))
                out.append((f"#{ln['seq']}「{clip(ln['title'], 18)}」{cur.get('name', '')}中", started.timestamp() if started else None))
        for d in town.depts:
            if d.get("state") == "busy" and d["id"] not in ("mill",):
                out.append((f"{d['name']}：{clip(doing(d), 40)}", None))
        for key, _ in out:
            self.seen.setdefault(key, now)
        live = {k for k, _ in out}
        self.seen = {k: v for k, v in self.seen.items() if k in live}
        return [(k, s if s is not None else self.seen[k]) for k, s in out]

    def frame(self, t: float) -> None:
        town: Papertown = self.app  # type: ignore[assignment]
        p = town.pal
        out = Text(" ")
        if not town.online:
            out.append(star(t, 10), style=f"bold {p['bad']}")
            out.append(" ")
            out.append_text(gleam(f"连不上 {town.api.base}，正在重连…", t, p["bad"], p["hi"]))
            self.update(out, layout=False)
            return
        acts = self.activities()
        if not acts:
            out.append("·", style=mix(p["faint"], p["muted"], breathe(t, 3.2)))
            out.append("  小镇很安静", style=p["muted"])
            out.append("  ·  按 ", style=p["faint"])
            out.append("i", style=f"bold {p['brand']}")
            out.append(" 写一个 idea，", style=p["faint"])
            out.append("?", style=f"bold {p['brand']}")
            out.append(" 看全部按键", style=p["faint"])
            self.update(out, layout=False)
            return
        # the first thing, turning over to the next every few seconds
        what, since = acts[int(t / 5) % len(acts)]
        quiet = time.time() - town.last_event
        color = mix(p["brand"], p["bad"], (quiet - 30) / 60) if quiet > 30 else p["brand"]
        out.append(star(t, 8), style=f"bold {color}")
        out.append(" ")
        out.append_text(gleam(what + "…", t, color, p["hi"]))
        more = f" · 另有 {len(acts) - 1} 处在忙" if len(acts) > 1 else ""
        out.append(f"  ({dur(time.time() - since)}{more})", style=p["muted"])
        self.update(out, layout=False)


PLACES = [("projects", "项目"), ("jobs", "任务"), ("plant", "电厂"), ("staff", "员工"), ("chat", "对话"), ("daily", "日报"), ("setup", "配置")]


class Nav(Static):
    """the places, with a number to jump to each and what is going on there"""

    def __init__(self) -> None:
        super().__init__(id="nav")

    def badge(self, key: str) -> tuple[str, str]:
        town: Papertown = self.app  # type: ignore[assignment]
        p = town.pal
        if key == "projects" and town.hud:
            w = town.hud["lines"]["waiting"]
            return (f"◐{w}", p["warn"]) if w else (str(town.hud["lines"]["total"]), p["muted"])
        if key == "jobs":
            n = sum(1 for d in town.depts for _ in d.get("jobs") or [])
            return (str(n), p["run"]) if n else ("", p["muted"])
        if key == "plant" and town.gpu_summary:
            return (f"{town.gpu_summary.get('idle', 0)}空", p["ok"])
        if key == "staff":
            n = sum(1 for d in town.depts if d.get("state") == "busy")
            return (f"{n}忙", p["run"]) if n else ("", p["muted"])
        if key == "chat" and town.unread:
            return (f"●{town.unread}", p["brand"])
        return "", p["muted"]

    def frame(self, t: float) -> None:
        town: Papertown = self.app  # type: ignore[assignment]
        p = town.pal
        out = Text()
        width = max(12, self.size.width)
        for i, (key, name) in enumerate(PLACES):
            on = key == town.place
            b, bc = self.badge(key)
            row = Text()
            row.append("▌" if on else " ", style=p["brand"])
            row.append(f"{i + 1} ", style=p["brand"] if on else p["faint"])
            row.append(name, style=f"bold {p['ink']}" if on else p["muted"])
            pad = width - row.cell_len - len(b) - 1
            row.append(" " * max(1, pad))
            row.append(b, style=bc)
            if on:
                row.stylize(f"on {p['raised']}")
            out.append_text(row)
            out.append("\n\n" if i < len(PLACES) - 1 else "\n")
        self.update(out, layout=False)

    def on_click(self, e: Any) -> None:
        i = (e.y - 1) // 2  # a line of padding on top, then a place every two lines (its own and the gap under it)
        if e.y >= 1 and 0 <= i < len(PLACES):
            self.app.call_later(self.app.action_place, PLACES[i][0])  # type: ignore[attr-defined]


class SayBox(Input):
    """the line you write in; its keys come before the places' and the screen's"""

    BINDINGS = [Binding("tab", "app.next_target", "换对象", show=False), Binding("ctrl+b", "app.cycle_option", show=False),
                Binding("escape", "app.leave_box", "离开", show=False)]


class Composer(Horizontal):
    """The box at the bottom: write to the town from any place. Tab changes who it goes to."""

    def __init__(self) -> None:
        super().__init__(id="composer")
        self.label = Static(id="target")
        self.box = SayBox(id="say", placeholder="写一个新 idea，Enter 发出去")

    def compose(self) -> ComposeResult:
        yield self.label
        yield self.box


class Splash(Screen):
    """while the TUI finds the server, or starts one"""

    BINDINGS = [Binding("q,ctrl+c", "app.quit", "退出"), Binding("r", "retry", "重试")]

    def __init__(self) -> None:
        super().__init__(id="splash")
        self.status = "正在连接…"
        self.error: str | None = None
        self.mark = Static(id="splash-mark")

    def compose(self) -> ComposeResult:
        with Middle():
            with Center():
                yield self.mark

    def frame(self, t: float) -> None:
        town: Papertown = self.app  # type: ignore[assignment]
        p = town.pal
        out = Text(justify="center")
        lift = int(breathe(t, 2.6) * 1.99)  # the mark bobs, as it does while the page loads
        out.append("\n" * (1 - lift))
        for i, row in enumerate(LOGO):
            out.append(row + "\n", style=p["brand"] if i < 3 else p["ink"])
        out.append("\n" * lift)
        out.append("\n")
        out.append_text(gleam("P a p e r t o w n", t, p["ink"], p["brand"], period=2.6))
        out.append("\n\n")
        if self.error:
            out.append(self.error + "\n\n", style=p["bad"])
            out.append("r", style=f"bold {p['brand']}")
            out.append(" 重试 · ", style=p["muted"])
            out.append("q", style=f"bold {p['brand']}")
            out.append(" 退出", style=p["muted"])
        else:
            out.append(star(t, 8) + " ", style=f"bold {p['brand']}")
            out.append(self.status, style=p["muted"])
        self.mark.update(out)

    def action_retry(self) -> None:
        if self.error:
            self.error = None
            self.app.connect()  # type: ignore[attr-defined]


class Main(Screen):
    def __init__(self, places: list[Place]) -> None:
        super().__init__(id="main")
        self.places = places

    def compose(self) -> ComposeResult:
        yield Masthead()
        yield Ribbon()
        with Horizontal(id="body"):
            yield Nav()
            with ContentSwitcher(id="places", initial="projects"):
                yield from self.places
        yield Composer()
        yield Static(id="hints")


class Papertown(App):
    CSS_PATH = "app.tcss"
    TITLE = "Papertown"
    ENABLE_COMMAND_PALETTE = False
    BINDINGS = [
        *[Binding(str(i + 1), f"place('{k}')", n, show=False) for i, (k, n) in enumerate(PLACES)],
        Binding("i", "compose", "写点什么"),
        Binding("question_mark", "help", "按键"),
        Binding("ctrl+r", "reload", "刷新"),
        Binding("T", "theme", "换主题"),
        Binding("W", "web", "浏览器里打开"),
        Binding("q", "quit", "退出"),
        Binding("ctrl+c", "quit", "退出", show=False, priority=True),
    ]

    def __init__(self, api: Api, start_server: bool = True, events: bool = True):
        super().__init__()
        self.api = api
        self.start_server = start_server
        self.use_events = events
        self.server: LocalServer | None = None
        self.local = Local()  # what the TUI reads with nvidb, skim and git itself
        self.t0 = time.monotonic()
        self.t = 0.0
        self.online = False
        self.last_event = time.time()
        self.hud: dict | None = None
        self.lines: list[dict] = []
        self.depts: list[dict] = []
        self.placements: list[dict] = []
        self.gpu_summary: dict | None = None
        self.messages: list[dict] = []
        self.trace: list[dict] = []
        self.unread = 0
        self.asking: tuple[str, float] | None = None  # a building you asked, and when
        self.streaming: dict[str, tuple[str, float, float]] = {}  # agent → (text so far, started, last)
        self.glow = Glow()
        self.place = "projects"
        self.targets: list[Target] = []
        self.target_i = 0
        self.budget = 1.0
        self.say_mode = "steer"
        self._refetch: asyncio.TimerHandle | None = None
        self._last_frame = time.monotonic()
        self._sending = False
        self._focus: object = None
        self.frames = 0
        self.beat = False  # every third frame: the rate tables and pages animate at (the masthead, ribbon and nav run at 12 fps)
        self._target: tuple | None = None
        for th in themes():
            self.register_theme(th)
        self.theme = "papertown"
        from .views import make_places
        self.places = make_places()

    @property
    def pal(self) -> dict[str, str]:
        return PALETTES.get(self.theme, PALETTES["papertown"])

    # ---------- starting ----------

    def on_mount(self) -> None:
        self.splash = Splash()
        self.push_screen(self.splash)
        self.set_interval(1 / 12, self.frame)
        self.connect()

    @work(exclusive=True, group="connect")
    async def connect(self) -> None:
        if await self.api.health():
            return await self.enter()
        local = any(h in self.api.base for h in ("127.0.0.1", "localhost"))
        if not (self.start_server and local):
            self.splash.error = f"{self.api.base} 上没有 Papertown 服务"
            return
        port = int(self.api.base.rsplit(":", 1)[-1]) if self.api.base.rsplit(":", 1)[-1].isdigit() else 8000
        self.splash.status = f"正在启动服务（端口 {port}）…"
        self.server = LocalServer(port)
        self.server.start()
        if await self.server.ready(self.api):
            return await self.enter()
        tail = self.server.tail(6)
        self.server.stop()
        self.splash.error = "服务没能启动" + (f"：\n{tail}" if tail else "") + f"\n（日志：{self.server.log}）"

    async def enter(self) -> None:
        self.online = True
        await self.refetch()
        self.main = Main(self.places)
        await self.switch_screen(self.main)
        self.retarget()
        await self.current.load()
        if self.use_events:
            self.listen()
        self.set_interval(15, self.schedule_refetch)
        self.local.start()
        self.set_interval(5, self.read_gpus)

    @work(group="events")
    async def listen(self) -> None:
        while True:
            try:
                async for ev in self.api.events():
                    self.online = True
                    self.last_event = time.time()
                    self.on_town_event(ev)
            except Exception:
                pass
            self.online = False
            await asyncio.sleep(2)
            if await self.api.health():
                self.online = True
                self.schedule_refetch()

    async def refetch(self) -> None:
        """the numbers, the projects and the departments: what the masthead, the ribbon and the index show"""
        try:
            world, lines, depts = await asyncio.gather(self.api.get("/api/world"), self.api.get("/api/lines"), self.api.get("/api/departments"))
        except (ApiError, Exception):
            return
        self.hud, self.placements, self.lines, self.depts = world["hud"], world["placements"], lines, depts
        await self.read_gpus()
        if not self.messages:
            try:
                self.messages, self.trace = await asyncio.gather(self.api.get("/api/messages"), self.api.get("/api/trace"))
            except Exception:
                pass

    async def read_gpus(self) -> None:
        """the GPU counts up top: nvidb's, read here; without nvidb, the town's simulated plant"""
        g = await self.local.gpus()
        if g.get("ok"):
            self.gpu_summary = g.get("summary")
            return
        power = next((d for d in self.depts if d["id"] == "power"), None)
        if power and isinstance(power.get("gpus"), dict):
            self.gpu_summary = power["gpus"].get("summary") or power["gpus"]

    def schedule_refetch(self) -> None:
        if self._refetch:
            self._refetch.cancel()
        self._refetch = asyncio.get_running_loop().call_later(0.3, lambda: self.run_worker(self._refetch_all(), group="refetch", exclusive=True))

    async def _refetch_all(self) -> None:
        await self.refetch()
        if isinstance(self.screen, Main):
            await self.current.load()
            self.retarget()

    def on_town_event(self, ev: dict) -> None:
        kind = ev.get("type")
        if kind == "line":
            ln = ev["line"]
            i = next((i for i, x in enumerate(self.lines) if x["id"] == ln["id"]), None)
            if i is None:
                self.lines.insert(0, ln)
            else:
                self.lines[i] = {**self.lines[i], **ln}
            self.glow.touch(("line", ln["id"]), self.t)
        elif kind == "message":
            m = ev["message"]
            if not any(x["id"] == m["id"] for x in self.messages):
                self.messages = [*self.messages, m][-400:]
                if self.place != "chat":
                    self.unread += 1
            body = m.get("body") or {}
            if self.asking and (body.get("from") == self.asking[0] or m.get("kind") == "error"):
                who = m.get("worker_id") or "员工"
                self.notify(f"{who} 回答了：{clip(body.get('text'), 60)}", title=self.building_name(self.asking[0]))
                self.asking = None
        elif kind == "trace":
            self.trace = [*self.trace, ev["row"]][-300:]
        elif kind == "agent_delta":
            aid = ev.get("agent_id", "")
            text, t0, _ = self.streaming.get(aid, ("", time.time(), 0))
            self.streaming[aid] = (text + ev.get("text", ""), t0, time.time())
        elif kind == "agent_event":
            self.streaming.pop((ev.get("event") or {}).get("agent_id", ""), None)
        for place in self.places:
            place.on_town_event(ev)
        if kind in TICK:
            self.schedule_refetch()

    # ---------- the clock ----------

    def frame(self) -> None:
        now = time.monotonic()
        dt, self._last_frame = now - self._last_frame, now
        self.t = now - self.t0
        self.frames += 1
        self.beat = self.frames % 3 == 0
        if isinstance(self.screen, Splash):
            self.screen.frame(self.t)
            return
        if not isinstance(self.screen, Main):
            return
        try:
            self.screen.query_one(Masthead).frame(self.t, dt)
            self.screen.query_one(Ribbon).frame(self.t)
            self.screen.query_one(Nav).frame(self.t)
            self.paint_target()
            if self.focused is not self._focus:
                self._focus = self.focused
                self.paint_hints()
        except Exception:
            return
        self.current.tick(self.t)

    # ---------- places ----------

    @property
    def current(self) -> Place:
        return next(p for p in self.places if p.key == self.place)

    async def action_place(self, key: str) -> None:
        if not isinstance(self.screen, Main):
            return
        self.place = key
        if key == "chat":
            self.unread = 0
        self.screen.query_one(ContentSwitcher).current = key
        self.retarget()
        self.paint_hints()
        place = self.current
        place.focus_first()  # type: ignore[attr-defined]
        # loading runs on its own, so the switch shows at once and keys keep working while it reads
        self.run_worker(place.load(), group=f"load-{key}", exclusive=True, exit_on_error=False)

    def paint_hints(self) -> None:
        if not isinstance(self.screen, Main):
            return
        p = self.pal
        out = Text(" ")
        if getattr(self.focused, "id", None) == "say":  # in the box, only its own keys work
            option = {"idea": [("Ctrl+B", "换预算")], "say": [("Ctrl+B", "插话 / 排队")]}.get(self.target.kind if self.targets else "", [])
            keys = [("Enter", "发出去"), ("Tab", "换对象"), *option, ("Esc", "离开框")]
        else:
            own = self.current.hints()
            keys = [*own, *([] if any(k == "i" for k, _ in own) else [("i", "写点什么")]), ("1-7", "换地方"), ("?", "全部按键"), ("q", "退出")]
        for i, (k, what) in enumerate(keys):
            if i:
                out.append("  ")
            out.append(k, style=f"bold {p['brand']}")
            out.append(f" {what}", style=p["muted"])
        self.screen.query_one("#hints", Static).update(out)

    def action_help(self) -> None:
        self.push_screen(Help([
            (f"这里（{dict(PLACES)[self.place]}）", self.current.hints()),
            ("到处都能用", [("1 … 7", "项目 / 任务 / 电厂 / 员工 / 对话 / 日报 / 配置"), ("i", "到底下的框里写点什么"),
                         ("Tab（在框里）", "换说话的对象：新 idea、问部门、调整项目、对员工说、小助手"),
                         ("Ctrl+B（在框里）", "新 idea 的预算 / 对员工说时插话还是排队"), ("Esc", "离开框"),
                         ("Ctrl+R", "全部重新拉一遍"), ("W", "在浏览器里打开网页版的同一处"), ("T", "深色 / 纸色主题"), ("q", "退出")]),
        ]))

    def action_theme(self) -> None:
        self.theme = "papertown-paper" if self.theme == "papertown" else "papertown"

    def action_reload(self) -> None:
        self.run_worker(self.reload(), group="reload", exclusive=True, exit_on_error=False)

    async def reload(self) -> None:
        await self.refetch()
        await self.current.load()
        self.notify("已刷新")

    def action_web(self) -> None:
        ctx = self.current.context()
        frag = {"projects": f"view=console&line={ctx.get('line', '')}", "chat": "view=world&chat", "daily": "view=status"}.get(self.place, "view=console")
        webbrowser.open(self.api.url(f"/#{frag}"))

    def open_url(self, url: str, *, new_tab: bool = True) -> None:  # type: ignore[override]
        webbrowser.open(url)

    # ---------- the box at the bottom ----------

    def retarget(self) -> None:
        """who the box can talk to from the place you are in"""
        ctx = self.current.context() if isinstance(self.screen, Main) else {}
        ts = [Target("idea", "新 idea")]
        line = next((x for x in self.lines if x["id"] == ctx.get("line")), None)
        if ctx.get("agent"):
            ts.insert(0, Target("say", f"对{self.agent_name(ctx['agent'])}说", agent=ctx["agent"]))
        if line:
            b = ctx.get("building") or (line.get("current") or {}).get("building") or line.get("mill_id") or "mill"
            ts.append(Target("ask", f"问{self.building_name(b)}", line=line["id"], building=b))
            ts.append(Target("adjust", f"调整 #{line['seq']}", line=line["id"]))
        elif ctx.get("building"):
            ts.append(Target("ask", f"问{self.building_name(ctx['building'])}", building=ctx["building"]))
        ts.append(Target("assistant", "小助手"))
        keep = self.targets[self.target_i].kind if self.targets else None
        self.targets = ts
        self.target_i = next((i for i, x in enumerate(ts) if x.kind == keep), 0)

    @property
    def target(self) -> Target:
        return self.targets[self.target_i] if self.targets else Target("idea", "新 idea")

    def paint_target(self) -> None:
        p, tg = self.pal, self.target
        out = Text()
        sign = {"idea": "✎", "ask": "?", "adjust": "↻", "say": "→", "assistant": "✦"}[tg.kind]
        out.append(star(self.t, 8) if self._sending else sign, style=f"bold {p['brand']}")
        out.append(f" {tg.label}", style=f"bold {p['ink']}")
        if tg.kind == "idea":
            out.append(f" · ${self.budget:.2f}", style=p["muted"])
        if tg.kind == "say":
            out.append(" · 插话" if self.say_mode == "steer" else " · 排队", style=p["muted"])
        out.append(" ❯ ", style=p["brand"])
        if self._target == (out, tg.kind):  # the same as on screen: no repaint, and no layout (its width follows the words)
            return
        self._target = (out, tg.kind)
        try:
            self.screen.query_one("#target", Static).update(out)
            box = self.screen.query_one("#say", Input)
            box.placeholder = {"idea": "一句话写下想法，Enter 交给孵化场查重", "ask": "问这个部门，它的员工会在对话里回答",
                               "adjust": "一句话说怎么改方向，项目会按新方向接着做", "say": "对这个员工说，它在忙时插进去或排在后面",
                               "assistant": "问中控屏的小助手"}[tg.kind]
        except Exception:
            pass

    def action_compose(self) -> None:
        if isinstance(self.screen, Main):
            self.screen.query_one("#say", Input).focus()

    def action_next_target(self) -> None:
        if self.targets:
            self.target_i = (self.target_i + 1) % len(self.targets)
            self.paint_hints()

    def action_cycle_option(self) -> None:
        if self.target.kind == "idea":
            steps = [0.5, 1.0, 2.0, 5.0, 10.0]
            self.budget = steps[(steps.index(self.budget) + 1) % len(steps)] if self.budget in steps else 1.0
        elif self.target.kind == "say":
            self.say_mode = "queue" if self.say_mode == "steer" else "steer"

    def action_leave_box(self) -> None:
        self.current.focus_first()

    def check_action(self, action: str, parameters: tuple) -> bool | None:
        # in a text box, letters are letters
        if isinstance(self.focused, Input) and action in {"compose", "help", "theme", "web", "quit", "place"}:
            return False
        return True

    @on(Input.Submitted, "#say")
    async def send(self, e: Input.Submitted) -> None:
        text = e.value.strip()
        if not text:
            return
        tg = self.target
        self._sending = True
        try:
            if tg.kind == "idea":
                r = await self.api.post("/api/ideas", {"text": text, "budget": self.budget})
                self.notify(f"孵化场收下了，项目 #{r.get('seq', '?')} 正在查重", title="新 idea")
            elif tg.kind == "ask":
                await self.api.post("/api/chat", {"text": text, "building": tg.building})
                self.asking = (tg.building or "", time.time())
            elif tg.kind == "adjust":
                await self.api.post(f"/api/lines/{tg.line}/adjust", {"text": text})
                self.notify("按新方向接着做", title=f"调整 {tg.label[2:]}")
            elif tg.kind == "say":
                await self.api.post(f"/api/agents/{tg.agent}/say", {"text": text, "mode": self.say_mode})
                self.notify("已插进它正在做的事" if self.say_mode == "steer" else "排在它手头这件事后面", title=tg.label)
            else:
                await self.api.post("/api/assistant/say", {"text": text, "page": {"view": self.place, **self.current.context()}})
                self.streaming["assistant"] = ("", time.time(), time.time())
            e.input.value = ""
            self.schedule_refetch()
        except ApiError as err:
            self.notify(str(err), title="没发出去", severity="error")
        finally:
            self._sending = False

    # ---------- names ----------

    def building_name(self, bid: str | None) -> str:
        p = next((x for x in self.placements if x["id"] == bid), None)
        if p:
            return p.get("name") or p.get("label") or bid or ""
        d = next((x for x in self.depts if x["id"] == bid), None)
        return d["name"] if d else (bid or "")

    def agent_name(self, aid: str) -> str:
        if aid == "assistant":
            return "小助手"
        role, _, line = aid.partition("-")
        seq = next((x["seq"] for x in self.lines if x["id"] == line), None)
        name = {"coder": "代码员工", "writer": "写作员工", "monitor": "看田员"}.get(role, role)
        return f"{name} #{seq}" if seq else name

    async def on_unmount(self) -> None:
        self.local.stop()
        if self.server:
            self.server.stop()
        await self.api.close()
