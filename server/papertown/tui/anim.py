"""How the TUI moves, after Claude Code's terminal: a turning star and a gleam along the words while
something works, counters that count up, bars that fill and changes that glow and fade. Everything is
drawn from the app's one clock `t`."""

from __future__ import annotations

import math
import unicodedata
from datetime import datetime, timezone

from rich.text import Text

FRAMES = "·✢✳✶✻✽✻✶✳✢"
BLOCKS = " ▏▎▍▌▋▊▉█"
SPARK = "▁▂▃▄▅▆▇█"


def star(t: float, speed: float = 4) -> str:
    """the turning star at time t, `speed` glyphs a second"""
    return FRAMES[int(t * speed) % len(FRAMES)]


def _rgb(c: str) -> tuple[int, int, int]:
    c = c.lstrip("#")
    return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)


def mix(a: str, b: str, k: float) -> str:
    k = min(1.0, max(0.0, k))
    (r1, g1, b1), (r2, g2, b2) = _rgb(a), _rgb(b)
    return f"#{round(r1 + (r2 - r1) * k):02x}{round(g1 + (g2 - g1) * k):02x}{round(b1 + (b2 - b1) * k):02x}"


def breathe(t: float, period: float = 2.4) -> float:
    """0 → 1 → 0, smoothly, once a period"""
    return (1 - math.cos(t / period * 2 * math.pi)) / 2


def char_width(ch: str) -> int:
    """terminal cells a character takes: two for wide (Chinese) ones"""
    return 2 if unicodedata.east_asian_width(ch) in "WF" else 1


def gleam(text: str, t: float, base: str, hi: str, period: float = 2.2, width: float = 4, style: str = "") -> Text:
    """The words with a light passing along them, left to right, once a period."""
    cells, x = [], 0
    for ch in text:
        w = char_width(ch)
        cells.append(x + w / 2)
        x += w
    head = (t % period) / period * (x + 2 * width) - width
    out = Text()
    for ch, c in zip(text, cells):
        k = max(0.0, 1 - abs(c - head) / width)
        out.append(ch, style=f"{style} {mix(base, hi, k * k * (3 - 2 * k))}".strip())
    return out


def bar(frac: float, width: int, fill: str, back: str) -> Text:
    """A bar `width` cells wide, filled to `frac` in eighths of a cell."""
    frac = min(1.0, max(0.0, frac))
    eighths = round(frac * width * 8)
    full, part = divmod(eighths, 8)
    out = Text("█" * full, style=fill)
    if full < width:
        out.append(BLOCKS[part], style=f"{fill} on {back}")
        out.append(" " * (width - full - 1), style=f"on {back}")
    return out


def spark(values: list[float], lo: float | None = None, hi: float | None = None) -> str:
    if not values:
        return ""
    lo = min(values) if lo is None else lo
    hi = max(values) if hi is None else hi
    span = (hi - lo) or 1
    return "".join(SPARK[min(7, max(0, int((v - lo) / span * 7.999)))] for v in values)


def parse_ts(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def seconds_since(s: str | None) -> float | None:
    d = parse_ts(s)
    return (datetime.now(timezone.utc) - d).total_seconds() if d else None


def dur(seconds: float | None) -> str:
    """12s · 3m 04s · 2h 05m · 3d 4h"""
    if seconds is None:
        return "—"
    s = max(0, int(seconds))
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m {s % 60:02d}s"
    if s < 86400:
        return f"{s // 3600}h {s % 3600 // 60:02d}m"
    return f"{s // 86400}d {s % 86400 // 3600}h"


def clock(ts: str | None) -> str:
    d = parse_ts(ts)
    return d.astimezone().strftime("%m-%d %H:%M") if d else "—"


class Tween:
    """A number easing towards its target: the counters count up instead of jumping."""

    def __init__(self, value: float = 0.0, rate: float = 7.0):
        self.value = self.target = float(value)
        self.rate = rate

    def set(self, target: float) -> None:
        self.target = float(target)

    def step(self, dt: float) -> bool:
        """moves on by dt seconds; True while still moving"""
        if abs(self.target - self.value) < 0.005:
            self.value = self.target
            return False
        self.value += (self.target - self.value) * (1 - math.exp(-self.rate * dt))
        return True


class Glow:
    """What just changed, keyed by anything: k(key) is 1 at the change and fades to 0."""

    def __init__(self, seconds: float = 1.2):
        self.seconds = seconds
        self.at: dict[object, float] = {}

    def touch(self, key: object, t: float) -> None:
        self.at[key] = t

    def k(self, key: object, t: float) -> float:
        start = self.at.get(key)
        if start is None:
            return 0.0
        k = 1 - (t - start) / self.seconds
        if k <= 0:
            self.at.pop(key, None)
            return 0.0
        return k * k
