"""The TUI's colours and words: the web page's paper palette, one dark and one light, and the labels
it gives to states, so a project or a job reads the same in both."""

from __future__ import annotations

import re

import rich._wrap
from rich.text import Text
from textual.theme import Theme

from .anim import breathe, char_width, mix, star

# Rich wraps only at spaces, so a run of Chinese never breaks: let it break between Han characters too,
# keeping punctuation with its neighbour.
_HAN = r"⺀-⿿぀-ヿ㐀-䶿一-鿿豈-﫿가-힯"
_OPEN = "（「『【《〈“‘"
_CLOSE = "，。、；：！？）」』】》〉”’…"
rich._wrap.re_word = re.compile(rf"\s*[{_OPEN}]*[{_HAN}][{_CLOSE}]*\s*"
                                rf"|\s*[{_OPEN}]*[^\s{_HAN}{_OPEN}{_CLOSE}]+[{_CLOSE}]*\s*"
                                rf"|\s*[{_OPEN}{_CLOSE}]+\s*")

# web/src/hand.css's colours: lifted for a dark terminal, and as they are on paper
PALETTES: dict[str, dict[str, str]] = {
    "papertown": dict(brand="#d9804f", hi="#ffd2b0", ink="#ece2d3", muted="#93846f", faint="#54493d", ok="#8cb878", warn="#e0ad4c",
                      bad="#e0705a", info="#7eaedc", bg="#1b1714", panel="#24201b", raised="#302922",
                      run="#e08a4c", done="#6fa3d8", failed="#d66c95", queued="#a3927b"),
    "papertown-paper": dict(brand="#c2663f", hi="#5e2a12", ink="#2f261d", muted="#857560", faint="#cfc2ac", ok="#5f8a52", warn="#b37f22",
                            bad="#b9543f", info="#3a76b0", bg="#f4eee2", panel="#fcf8f0", raised="#efe6d6",
                            run="#d0743a", done="#3a76b0", failed="#a8325e", queued="#a3927b"),
}


def themes() -> list[Theme]:
    out = []
    for name, p in PALETTES.items():
        dark = name == "papertown"
        out.append(Theme(name=name, primary=p["brand"], secondary=p["info"], accent=p["brand"], foreground=p["ink"], background=p["bg"],
                         surface=p["panel"], panel=p["raised"], success=p["ok"], warning=p["warn"], error=p["bad"], dark=dark,
                         variables={"muted": p["muted"], "faint": p["faint"], "footer-key-foreground": p["brand"],
                                    "block-cursor-background": mix(p["brand"], p["bg"], 0.55), "block-cursor-foreground": p["ink"],
                                    "block-cursor-blurred-background": mix(p["brand"], p["bg"], 0.8)}))
    return out


LINE = {"hatching": "查重中", "waiting": "等你决定", "running": "生产中", "paused": "已暂停", "failed": "出错", "done": "已出厂",
        "dropped": "已放弃", "linked": "本地项目"}
STAGE = {"done": "完成", "run": "进行中", "wait": "等你决定", "todo": "还没开始", "fail": "出错"}
JOB = {"running": "在跑", "done": "完成", "failed": "失败", "queued": "排队", "cancelled": "已取消"}
BACKEND = {"local": "本地执行器", "sim": "模拟电厂", "nvidb": "nvidb"}
DEPT = {"busy": "在忙", "wait": "等你", "idle": "空闲"}
AGENT = {"stopped": "未启动", "starting": "启动中", "idle": "待命", "working": "工作中", "error": "出错", "watching": "值守"}
WORKER = {"active": "在岗", "frozen": "冻结"}


def doing(d: dict) -> str:
    """What a department is doing; when the server says 空闲 while its jobs run, count the jobs instead."""
    running = sum(1 for j in d.get("jobs") or [] if j.get("status") == "running")
    if d.get("state") == "busy" and d.get("job") == "空闲" and running:
        return f"{running} 个任务在跑"
    return d.get("job") or ""


def job_state(s: str | None) -> str:
    """nvidb's and the farm's states, folded into the five the page shows"""
    return {"running": "running", "pending": "queued", "queued": "queued", "completed": "done", "done": "done",
            "cancelled": "cancelled"}.get(s or "", "failed")


def busy_mark(t: float, p: dict[str, str]) -> Text:
    """the turning star of something at work"""
    return Text(star(t), style=f"bold {p['run']}")


def wait_mark(t: float, p: dict[str, str]) -> Text:
    """the breathing half-moon of something waiting on you"""
    return Text("◐", style=f"bold {mix(p['warn'], p['hi'], breathe(t) * 0.6)}")


def line_mark(status: str, t: float, p: dict[str, str]) -> Text:
    """a project's state as one animated cell"""
    if status in ("running", "hatching"):
        return busy_mark(t, p)
    if status == "waiting":
        return wait_mark(t, p)
    sign, color = {"paused": ("‖", "muted"), "failed": ("✕", "bad"), "done": ("✓", "done"), "dropped": ("⊘", "muted"),
                   "linked": ("⇄", "info")}.get(status, ("·", "muted"))
    return Text(sign, style=p[color])


def job_mark(state: str, t: float, p: dict[str, str]) -> Text:
    if state == "running":
        return busy_mark(t, p)
    sign = {"done": "✓", "failed": "✕", "queued": "◷", "cancelled": "⊘"}[state]
    return Text(sign, style=p["queued" if state == "cancelled" else state])


def stage_mark(status: str, t: float, p: dict[str, str]) -> Text:
    if status == "run":
        return busy_mark(t, p)
    if status == "wait":
        return wait_mark(t, p)
    sign, color = {"done": ("✓", "ok"), "fail": ("✕", "bad")}.get(status, ("○", "faint"))
    return Text(sign, style=p[color])


def cells(s: str) -> int:
    return sum(char_width(c) for c in s)


def clip(s: str | None, width: int) -> str:
    """cut to `width` terminal cells (Chinese counts two), with … when cut"""
    s = " ".join((s or "").split())
    if cells(s) <= width:
        return s
    out, w = "", 0
    for c in s:
        cw = char_width(c)
        if w + cw > width - 1:
            break
        out += c
        w += cw
    return out + "…"


def pad(s: str | None, width: int) -> str:
    """clip to `width` cells, then fill to exactly that many"""
    s = clip(s, width)
    return s + " " * (width - cells(s))


def money(v: float | None) -> str:
    v = v or 0
    return "<$0.01" if 0 < v < 0.01 else f"${v:.2f}"


def size(n: int | None) -> str:
    if n is None:
        return "—"
    for unit in ("B", "K", "M"):
        if n < 1024:
            return f"{n:.0f}{unit}" if unit == "B" else f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}G"


def gb(mb: float | None) -> str:
    return "—" if mb is None else f"{mb / 1024:.1f}G"
