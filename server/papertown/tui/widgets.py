"""Pieces the places share: the base of a place, a table that updates in place instead of being
rebuilt, and the dialogs (a line of text, a small form, a yes/no)."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import DataTable, Input, Label, Select, Static

if TYPE_CHECKING:
    from .app import Papertown


class Place(Vertical):
    """One of the places in the index on the left: a view onto part of the town."""

    key = ""
    title = ""
    animated = False  # has something that moves, so it is redrawn on the clock

    @property
    def town(self) -> "Papertown":
        return self.app  # type: ignore[return-value]

    @property
    def pal(self) -> dict[str, str]:
        return self.town.pal

    def hints(self) -> list[tuple[str, str]]:
        return []

    async def load(self) -> None:
        """fetch what it shows; called when it is opened and when the town changes"""

    def on_town_event(self, ev: dict) -> None:
        """an event from the server's stream"""

    def tick(self, t: float) -> None:
        """a frame of the clock, while it is the place shown"""

    def context(self) -> dict[str, Any]:
        """what the box at the bottom can talk to from here: line, building, agent"""
        return {}

    def focus_first(self) -> None:
        for w in self.query("*"):
            if w.focusable and w.display:
                w.focus()
                return


def row_key(table: DataTable) -> str | None:
    if not table.row_count:
        return None
    try:
        return table.coordinate_to_cell_key(table.cursor_coordinate).row_key.value
    except Exception:
        return None


def sync_rows(table: DataTable, rows: list[tuple[str, tuple]]) -> None:
    """Shows these rows: the same rows in the same order are updated cell by cell (so the cursor
    and the scroll stay put); otherwise the table is refilled and the cursor kept on its row."""
    keys = [k for k, _ in rows]
    cols = list(table.columns.keys())
    if [k.value for k in table.rows] == keys:
        for k, cells in rows:
            for col, v in zip(cols, cells):
                if table.get_cell(k, col) != v:
                    table.update_cell(k, col, v)
        return
    keep = row_key(table)
    table.clear()
    for k, cells in rows:
        table.add_row(*cells, key=k)
    if keep in keys:
        table.move_cursor(row=keys.index(keep), animate=False)


def transcript(items: list[dict], p: dict[str, str], dark: bool) -> list[Any]:
    """An agent's conversation (Paseo's timeline): what you said, its answers as Markdown, and the
    tools it ran folded into one line between them."""
    from rich.markdown import Markdown
    from rich.padding import Padding

    from .look import clip

    parts: list[Any] = []
    tools: list[str] = []

    def flush() -> None:
        if tools:
            parts.append(Text(f"  ⚙ {'、'.join(tools[:6])}{' …' if len(tools) > 6 else ''}", style=p["faint"]))
            tools.clear()

    for it in items:
        kind = it.get("kind")
        if kind == "tool":
            tools.append(it.get("name") or it.get("text") or "tool")
            continue
        flush()
        if kind == "user":
            text = it.get("text") or ""
            if text.startswith("<page>"):  # what the console's assistant is told about the page: not yours to read again
                text = text.split("</page>", 1)[-1].strip() or text
            parts.append(Text.assemble(("你 ❯ ", f"bold {p['brand']}"), (clip(text, 600), p["ink"])))
        elif kind == "assistant":
            text = re.sub(r"^\s*(?:-{3,}|\*{3,})\s*\n", "", it.get("text") or "")  # Paseo starts a turn after a tool with a rule
            parts.append(Padding(Markdown(text, code_theme="ansi_dark" if dark else "ansi_light"), (0, 0, 0, 2)))
        else:
            parts.append(Text(f"  {it.get('text') or ''}", style=p["bad"] if kind == "error" else p["muted"]))
        parts.append(Text())
    flush()
    return parts


def writing(live: tuple[str, float, float] | None, t: float, p: dict[str, str]) -> list[Any]:
    """what an agent is writing right now (its streamed text so far), with the cursor blinking after it"""
    import time

    from rich.padding import Padding

    from .anim import dur, star

    if not live:
        return []
    text, since, _ = live
    body = Text(text[-3000:], style=p["ink"])
    body.append("▍", style=p["brand"] if int(t * 2) % 2 == 0 else p["bg"])
    return [Text.assemble((star(t) + " ", f"bold {p['run']}"), (f"在写（{dur(time.time() - since)}）", p["muted"])), Padding(body, (0, 0, 0, 2))]


class Bar(Static):
    """a piece of the interface itself (tabs, filters, hints): clicked, never selected as text"""

    ALLOW_SELECT = False


class Pane(VerticalScroll):
    """a scrolling page of rich text"""

    def __init__(self, *, id: str | None = None, classes: str | None = None):
        super().__init__(id=id, classes=classes)
        self.body = Static(id=f"{id}-body" if id else None, classes="pane-body")

    def compose(self) -> ComposeResult:
        yield self.body

    def show(self, renderable: Any, layout: bool = True) -> None:
        # layout=False when only the look changes (a turning star, a gleam), not how many lines there are
        self.body.update(renderable, layout=layout)


class Prompt(ModalScreen[str | None]):
    """a line of text, or nothing when Esc is pressed"""

    BINDINGS = [Binding("escape", "dismiss(None)", "取消")]

    def __init__(self, title: str, hint: str = "", value: str = "", placeholder: str = ""):
        super().__init__(classes="modal")
        self.title_, self.hint, self.value, self.placeholder = title, hint, value, placeholder

    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog"):
            yield Label(self.title_, classes="dialog-title")
            if self.hint:
                yield Static(self.hint, classes="dialog-hint")
            yield Input(self.value, placeholder=self.placeholder)
            yield Static(Text.assemble(("Enter", "bold"), " 确定 · ", ("Esc", "bold"), " 取消"), classes="dialog-keys")

    def on_input_submitted(self, e: Input.Submitted) -> None:
        self.dismiss(e.value.strip() or None)


class Form(ModalScreen[dict | None]):
    """A few fields at once: (name, label, default) for text, (name, label, default, [(label, value)…])
    for a choice. Enter in the last field, or Ctrl+S, sends it."""

    BINDINGS = [Binding("escape", "dismiss(None)", "取消"), Binding("ctrl+s", "send", "确定")]

    def __init__(self, title: str, fields: list[tuple], hint: str = ""):
        super().__init__(classes="modal")
        self.title_, self.fields, self.hint = title, fields, hint

    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog"):
            yield Label(self.title_, classes="dialog-title")
            if self.hint:
                yield Static(self.hint, classes="dialog-hint")
            for f in self.fields:
                yield Label(f[1], classes="field-label")
                if len(f) > 3:
                    yield Select(f[3], value=f[2] if f[2] is not None else Select.NULL, allow_blank=f[2] is None, prompt="不选", id=f"f-{f[0]}")
                else:
                    yield Input(str(f[2] or ""), id=f"f-{f[0]}")
            yield Static(Text.assemble(("Enter", "bold"), " 下一项 / 确定 · ", ("Ctrl+S", "bold"), " 确定 · ", ("Esc", "bold"), " 取消"),
                         classes="dialog-keys")

    def values(self) -> dict:
        out = {}
        for f in self.fields:
            w = self.query_one(f"#f-{f[0]}")
            v = w.value
            out[f[0]] = None if v is Select.NULL else (v.strip() if isinstance(v, str) else v)
        return out

    def on_input_submitted(self, e: Input.Submitted) -> None:
        inputs = list(self.query(Input))
        if e.input is inputs[-1]:
            self.action_send()
        else:
            self.focus_next()

    def action_send(self) -> None:
        self.dismiss(self.values())


class Confirm(ModalScreen[bool]):
    BINDINGS = [Binding("y,enter", "dismiss(True)", "是"), Binding("n,escape", "dismiss(False)", "否")]

    def __init__(self, title: str, body: str = ""):
        super().__init__(classes="modal")
        self.title_, self.body = title, body

    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog"):
            yield Label(self.title_, classes="dialog-title")
            if self.body:
                yield Static(self.body, classes="dialog-hint")
            yield Static(Text.assemble(("y", "bold"), " / ", ("Enter", "bold"), " 好 · ", ("n", "bold"), " / ", ("Esc", "bold"), " 算了"),
                         classes="dialog-keys")


class Help(ModalScreen[None]):
    BINDINGS = [Binding("escape,question_mark,q", "dismiss(None)", "关闭")]

    def __init__(self, rows: list[tuple[str, list[tuple[str, str]]]]):
        super().__init__(classes="modal")
        self.rows = rows

    def compose(self) -> ComposeResult:
        from .look import pad

        t = Text()
        for i, (section, keys) in enumerate(self.rows):
            if i:
                t.append("\n")
            t.append(f"{section}\n", style="bold")
            for k, what in keys:
                t.append(f"  {pad(k, 18)}", style="bold")
                t.append(f"{what}\n")
        with Vertical(classes="dialog help"):
            yield Label("按键", classes="dialog-title")
            with VerticalScroll():
                yield Static(t)
            yield Static(Text.assemble(("Esc", "bold"), " 关闭"), classes="dialog-keys")
