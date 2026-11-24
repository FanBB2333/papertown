"""A terminal's colours and text attributes, read from its ANSI text into lines of styled runs.

The server does all of the reading, so the web and the app draw a terminal alike: colours come out as hex, already
dimmed, reversed or hidden as the terminal would show them on one shared palette, and each client only lays out runs.

A screen comes back as `{"text", "lines", "styles", "theme"}`: `text` is the plain screen (each line without trailing
spaces), `lines` holds one list of `[text, style]` runs per line, `style` indexes `styles` (0 is the terminal's own
colours), and `theme` gives those colours.
"""
from __future__ import annotations

import re

BOLD, DIM, ITALIC, UNDERLINE, REVERSE, HIDDEN, STRIKE = 1, 2, 4, 8, 16, 32, 64

# a pen: (foreground, background, flags); a colour is None (the terminal's own), 0-255, or an (r, g, b) tuple
Pen = tuple
PLAIN: Pen = (None, None, 0)

THEME = {"fg": "#cccccc", "bg": "#1e1e1e"}
PALETTE16 = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
             "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"]
_FLAG = {1: BOLD, 2: DIM, 3: ITALIC, 4: UNDERLINE, 7: REVERSE, 8: HIDDEN, 9: STRIKE, 21: UNDERLINE, 53: 0}
_OFF = {22: BOLD | DIM, 23: ITALIC, 24: UNDERLINE, 27: REVERSE, 28: HIDDEN, 29: STRIKE}


def _groups(body: str) -> list[list[int | None]]:
    """`1;38:2::255:0:0;4` -> [[1], [38, 2, None, 255, 0, 0], [4]]"""
    out = []
    for group in (body or "0").split(";"):
        parts = []
        for p in group.split(":"):
            parts.append(int(p) if p.isdigit() else None)
        out.append(parts)
    return out


def _colour(parts: list, rest: list) -> tuple[int | tuple | None, int]:
    """The colour after 38/48: from the group's own colon parts, else from the groups that follow. Returns the colour
    and how many following groups it used."""
    if len(parts) > 1:  # colon form: 38:5:n or 38:2:[colourspace:]r:g:b
        if parts[1] == 5 and len(parts) > 2:
            return (parts[2] or 0) % 256, 0
        if parts[1] == 2:
            rgb = [p or 0 for p in parts[2:]][-3:]
            return (tuple(min(v, 255) for v in rgb) if len(rgb) == 3 else None), 0
        return None, 0
    kind = rest[0][0] if rest else None
    if kind == 5 and len(rest) > 1:
        return (rest[1][0] or 0) % 256, 2
    if kind == 2 and len(rest) > 3:
        return tuple(min(r[0] or 0, 255) for r in rest[1:4]), 4
    return None, 1 if rest else 0


def apply(pen: Pen | None, body: str) -> Pen | None:
    """The pen after an SGR sequence (`ESC [ body m`); None stands for the plain pen."""
    fg, bg, flags = pen or PLAIN
    groups = _groups(body)
    i = 0
    while i < len(groups):
        parts = groups[i]
        code = parts[0] or 0
        i += 1
        if code == 0:
            fg, bg, flags = PLAIN
        elif code == 4 and len(parts) > 1:  # 4:0 is no underline, 4:1 to 4:5 are its kinds
            flags = flags | UNDERLINE if parts[1] else flags & ~UNDERLINE
        elif code in _FLAG:
            flags |= _FLAG[code]
        elif code in _OFF:
            flags &= ~_OFF[code]
        elif 30 <= code <= 37:
            fg = code - 30
        elif 90 <= code <= 97:
            fg = code - 90 + 8
        elif 40 <= code <= 47:
            bg = code - 40
        elif 100 <= code <= 107:
            bg = code - 100 + 8
        elif code == 39:
            fg = None
        elif code == 49:
            bg = None
        elif code in (38, 48, 58):
            colour, used = _colour(parts, groups[i:])
            i += used
            if code == 38:
                fg = colour
            elif code == 48:
                bg = colour
    pen = (fg, bg, flags)
    return None if pen == PLAIN else pen


def sgr(pen: Pen | None) -> str:
    """The sequence that sets a pen from scratch."""
    if not pen:
        return "\x1b[0m"
    fg, bg, flags = pen
    codes = ["0"]
    codes += [str(n) for n, f in ((1, BOLD), (2, DIM), (3, ITALIC), (4, UNDERLINE), (7, REVERSE), (8, HIDDEN), (9, STRIKE)) if flags & f]
    for base, c in ((38, fg), (48, bg)):
        if isinstance(c, int):
            codes.append(f"{base};5;{c}")
        elif c:
            codes.append(f"{base};2;{c[0]};{c[1]};{c[2]}")
    return "\x1b[" + ";".join(codes) + "m"


def has_background(pen: Pen | None) -> bool:
    return bool(pen) and (pen[1] is not None or bool(pen[2] & (REVERSE | UNDERLINE | STRIKE)))


def _hex(c) -> str | None:
    if c is None:
        return None
    if isinstance(c, tuple):
        return "#%02x%02x%02x" % c
    if c < 16:
        return PALETTE16[c]
    if c < 232:
        c -= 16
        levels = (0, 95, 135, 175, 215, 255)
        return "#%02x%02x%02x" % (levels[c // 36], levels[c // 6 % 6], levels[c % 6])
    v = 8 + (c - 232) * 10
    return "#%02x%02x%02x" % (v, v, v)


def _mix(a: str, b: str, t: float) -> str:
    x, y = int(a[1:], 16), int(b[1:], 16)
    out = 0
    for shift in (16, 8, 0):
        ca, cb = (x >> shift) & 255, (y >> shift) & 255
        out |= round(ca + (cb - ca) * t) << shift
    return "#%06x" % out


def style(pen: Pen | None) -> dict:
    """What a pen looks like on the shared palette: `fg` and `bg` when they differ from the theme, and `b`, `i`, `u`,
    `s` for bold, italic, underlined and struck through."""
    if not pen:
        return {}
    fg, bg, flags = pen
    f, b = _hex(fg) or THEME["fg"], _hex(bg) or THEME["bg"]
    if flags & REVERSE:
        f, b = b, f
    if flags & DIM:
        f = _mix(f, b, 0.45)
    if flags & HIDDEN:
        f = b
    out: dict = {}
    if f != THEME["fg"]:
        out["fg"] = f
    if b != THEME["bg"]:
        out["bg"] = b
    for key, flag in (("b", BOLD), ("i", ITALIC), ("u", UNDERLINE), ("s", STRIKE)):
        if flags & flag:
            out[key] = True
    return out


_ESCAPE = re.compile(r"\x1b(?:\[([0-?]*)[ -/]*([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[P_^X][^\x1b]*(?:\x1b\\)?|[()*+\-./#% ].|.)", re.S)
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def render(text: str) -> dict:
    """ANSI text as styled lines (see the module's description)."""
    styles: list[dict] = [{}]
    index: dict[tuple, int] = {(): 0}
    lines: list[list[list]] = []
    plain: list[str] = []
    pen: Pen | None = None

    def style_id(p: Pen | None) -> int:
        s = style(p)
        key = tuple(sorted(s.items()))
        if key not in index:
            index[key] = len(styles)
            styles.append(s)
        return index[key]

    for raw in text.split("\n"):
        runs: list[list] = []
        pos = 0
        for m in _ESCAPE.finditer(raw):
            chunk = _CONTROL.sub("", raw[pos:m.start()])
            if chunk:
                runs.append([chunk, style_id(pen)])
            pos = m.end()
            if m.group(2) == "m" and not (m.group(1) or "").startswith(("?", ">", "<", "=")):
                pen = apply(pen, m.group(1) or "")
        chunk = _CONTROL.sub("", raw[pos:])
        if chunk:
            runs.append([chunk, style_id(pen)])
        merged: list[list] = []
        for t, s in runs:
            if merged and merged[-1][1] == s:
                merged[-1][0] += t
            else:
                merged.append([t, s])
        # trailing spaces only show when they paint something
        while merged and not merged[-1][0].strip() and not ({"bg", "u", "s"} & styles[merged[-1][1]].keys()):
            merged.pop()
        if merged and not ({"bg", "u", "s"} & styles[merged[-1][1]].keys()):
            merged[-1][0] = merged[-1][0].rstrip()
        lines.append(merged)
        plain.append("".join(t for t, _ in merged).rstrip())
    return {"text": "\n".join(plain), "lines": lines, "styles": styles, "theme": THEME}
