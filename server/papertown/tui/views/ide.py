"""The code and paper pages' editor, as the web page has it (web/src/console/files.tsx and Editor.tsx):
the files as a tree of folders that open and close, each with its icon and git's state of it; the
file you open, in the editor's colour theme and wrapped when it is prose; a status line under it;
the editor itself in the same colours; and the pick of those colours, the file icons and the TUI's
own theme (T), tried on as you move through it. A workspace on this machine is read from its
directory; one elsewhere through the server, which also does all the saving."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from pathlib import PurePosixPath
from typing import TYPE_CHECKING, Any

from rich.console import Group
from rich.padding import Padding
from rich.syntax import Syntax
from rich.table import Table
from rich.text import Text
from textual import on, work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, ScrollableContainer, Vertical
from textual.message import Message
from textual.screen import ModalScreen
from textual.widgets import DataTable, OptionList, Static, TextArea
from textual.widgets.option_list import Option

from ..client import ApiError
from ..edthemes import (GIT, ICON_THEMES, PAPER, THEMES, WRAPPED, EdSyntax, EdTheme, file_icon, folder_icon, language, resolve, role_for,
                        textarea_theme)
from ..look import PALETTES, size
from ..widgets import Bar, Confirm, row_key, sync_rows

if TYPE_CHECKING:
    from ..app import Papertown

NAME_W = 31  # the file list's name column (.ed-side is 34 wide: the mark and the scrollbar beside it)


def parents(path: str) -> list[str]:
    parts = path.split("/")[:-1]
    return ["/".join(parts[: i + 1]) for i in range(len(parts))]


THEME_CLASSES = {f"ed-{t.key}" for t in [*THEMES, PAPER[True]]}


def swap_theme_class(w: Any, th: EdTheme) -> None:
    """the theme's class (edthemes.css()) on w, in place of the last one"""
    w.remove_class(*(THEME_CLASSES & set(w.classes)))
    w.add_class(f"ed-{th.key}")


class FileTree(DataTable):
    """a workspace's files as folders that open (→, Enter) and close (←), each file with its icon and git's state"""

    BINDINGS = [Binding("right", "open_dir", "展开", show=False), Binding("left", "close_dir", "收起", show=False)]

    class Open(Message):
        def __init__(self, path: str):
            super().__init__()
            self.path = path

    def __init__(self, **kw: Any):
        super().__init__(cursor_type="row", show_header=False, cell_padding=0, **kw)
        self.files: list[dict] = []
        self.opened: set[str] = set()  # the folders open
        self.filter = ""
        self.cur: str | None = None  # the file shown beside it

    @property
    def town(self) -> "Papertown":
        return self.app  # type: ignore[return-value]

    def on_mount(self) -> None:
        self.add_column("name", key="name", width=NAME_W)
        self.add_column("mark", key="mark", width=2)

    def set_files(self, files: list[dict], fresh: bool) -> None:
        self.files = files
        if fresh:
            self.opened = {d for f in files for d in parents(f["path"])} if len(files) <= 40 else set()  # a small tree opens all the way
        self.paint()

    def reveal(self, path: str) -> None:
        self.cur = path
        self.opened |= set(parents(path))
        self.paint()
        keys = [k.value for k in self.rows]
        if path in keys:
            self.move_cursor(row=keys.index(path), animate=False)

    def paint(self) -> None:
        th, icons = self.town.ed, self.town.prefs.ed_icons
        u = th.ui
        q = self.filter.lower()
        files = [f for f in self.files if q in f["path"].lower()] if q else self.files
        top: dict = {"dirs": {}, "files": []}
        for f in files:
            node = top
            for part in f["path"].split("/")[:-1]:
                node = node["dirs"].setdefault(part, {"dirs": {}, "files": []})
            node["files"].append(f)
        rows: list[tuple[str, tuple]] = []

        def changed(node: dict) -> bool:
            return any(f.get("status") for f in node["files"]) or any(changed(d) for d in node["dirs"].values())

        def walk(node: dict, depth: int, prefix: str) -> None:
            for name in sorted(node["dirs"], key=str.lower):
                sub, path = node["dirs"][name], prefix + name
                on = bool(q) or path in self.opened
                t = Text.assemble("  " * depth, ("▾ " if on else "▸ ", u["muted"]), folder_icon(name, icons, th),
                                  (name, f"bold {u['fg']}"))
                t.truncate(NAME_W, overflow="ellipsis")
                rows.append((f"d:{path}", (t, Text(" •", style=u["gitMod"]) if changed(sub) else Text(""))))
                if on:
                    walk(sub, depth + 1, path + "/")
            for f in sorted(node["files"], key=lambda f: f["path"].rsplit("/", 1)[-1].lower()):
                st = GIT.get(f.get("status") or "")
                color = u[st[1]] if st else u["fg"]
                t = Text.assemble("  " * depth + "  ", file_icon(f["path"], icons, th),
                                  (f["path"].rsplit("/", 1)[-1], f"{color}{' strike' if f.get('status') == 'deleted' else ''}"
                                                                  f"{' bold' if f['path'] == self.cur else ''}"))
                t.truncate(NAME_W, overflow="ellipsis")
                rows.append((f["path"], (t, Text(f" {st[0]}", style=f"bold {color}") if st else Text(""))))

        walk(top, 0, "")
        sync_rows(self, rows)

    def current(self) -> tuple[bool, str] | None:
        """(is a folder, its path) of the row the cursor is on"""
        key = row_key(self)
        if not key:
            return None
        return (True, key[2:]) if key.startswith("d:") else (False, key)

    @on(DataTable.RowSelected)
    def _picked(self, e: DataTable.RowSelected) -> None:
        e.stop()
        key = e.row_key.value or ""
        if key.startswith("d:"):
            self.opened ^= {key[2:]}
            self.paint()
        elif key:
            self.post_message(self.Open(key))

    def action_open_dir(self) -> None:
        cur = self.current()
        if cur and cur[0]:
            if cur[1] in self.opened:
                self.action_cursor_down()
            else:
                self.opened.add(cur[1])
                self.paint()

    def action_close_dir(self) -> None:
        cur = self.current()
        if not cur:
            return
        if cur[0] and cur[1] in self.opened and not self.filter:
            self.opened.discard(cur[1])
            self.paint()
            return
        parent = str(PurePosixPath(cur[1]).parent)
        keys = [k.value for k in self.rows]
        if parent != "." and f"d:{parent}" in keys:
            self.move_cursor(row=keys.index(f"d:{parent}"), animate=False)


class Viewer(ScrollableContainer, can_focus=True):
    """the open file; Esc goes back to the list"""

    BINDINGS = [Binding("escape", "back", "回到文件", show=False), Binding("w", "wrap", "换行", show=False),
                Binding("j", "scroll_down", show=False), Binding("k", "scroll_up", show=False),
                Binding("g", "scroll_home", show=False), Binding("G", "scroll_end", show=False)]

    def compose(self) -> ComposeResult:
        yield Static(classes="ed-body")

    def show(self, renderable: Any, wrap: bool = True) -> None:
        self.set_class(not wrap, "nowrap")
        self.query_one(".ed-body", Static).update(renderable)

    def ide(self) -> "Ide":
        return next(a for a in self.ancestors if isinstance(a, Ide))

    def action_back(self) -> None:
        self.ide().ftree.focus()

    def action_wrap(self) -> None:
        self.ide().toggle_wrap()


class Ide(Horizontal):
    """a project's code or its paper: the files on the left, the open one on the right"""

    def __init__(self, root: str, **kw: Any):
        super().__init__(**kw)
        self.root = root
        self.line_id: str | None = None
        self.info: dict | None = None  # the workspace: its directory, name, git branch…
        self.press = False  # the press's own paper (its build files are left out)
        self.opened: str | None = None
        self.file: dict | None = None
        self.diff: str | None = None  # the open file's `git diff`, shown instead of it
        self.latex: str | None = None  # what LaTeX said when the paper did not compile, shown instead of the file
        self.wrap: bool | None = None  # None: as its language goes (prose wrapped, code not)

    @property
    def town(self) -> "Papertown":
        return self.app  # type: ignore[return-value]

    def compose(self) -> ComposeResult:
        with Vertical(classes="ed-side"):
            yield Bar(classes="ed-head")
            yield FileTree(classes="ed-tree")
        with Vertical(classes="ed-main"):
            yield Viewer(classes="ed-view")
            yield Bar(classes="ed-status")

    @property
    def ftree(self) -> FileTree:
        return self.query_one(FileTree)

    @property
    def viewer(self) -> Viewer:
        return self.query_one(Viewer)

    def on_mount(self) -> None:
        swap_theme_class(self, self.town.ed)

    def restyle(self) -> None:
        """the colour theme or the icons changed"""
        swap_theme_class(self, self.town.ed)
        self.ftree.paint()
        self.paint_view()
        self.paint_status()

    # ---------- what it shows ----------

    async def load(self, line: dict, ws: dict) -> None:
        fresh = line["id"] != self.line_id
        if fresh:
            self.line_id, self.opened, self.file, self.diff, self.wrap = line["id"], None, None, None, None
            self.ftree.filter, self.ftree.cur = "", None
        self.info = ws.get(self.root)
        self.press = self.root == "paper" and not ws.get("linked")
        files: list[dict] = []
        if self.info:
            t = await self.town.local.ws_tree(self.info.get("path") or "", self.press)  # on this machine: read it here
            if t is None:
                t = await self.town.api.get(f"/api/lines/{line['id']}/ws/{self.root}/tree")
            files = t.get("files", [])
        self.ftree.set_files(files, fresh)
        if self.opened and not any(f["path"] == self.opened for f in files):
            self.opened, self.file, self.diff = None, None, None
        self.paint_head()
        self.paint_view()
        self.paint_status()

    def current(self) -> str | None:
        """the file the keys act on: the one open while you read it, else the one under the cursor"""
        if self.opened and (self.viewer.has_focus or not self.ftree.has_focus):
            return self.opened
        cur = self.ftree.current()
        return cur[1] if cur and not cur[0] else self.opened

    @on(FileTree.Open)
    def _open(self, e: FileTree.Open) -> None:
        self.open(e.path, focus=True)

    @work(exclusive=True, group="ide-file")
    async def open(self, path: str, focus: bool = False, diff: bool = False) -> None:
        if not self.line_id or not self.info:
            return
        try:
            if diff:
                text = await self.town.local.git_diff(self.info.get("path") or "", path)  # git diff, run here
                if not text:
                    self.town.notify(f"{path} 没有未提交的改动")
                    return
                if self.opened != path:
                    await self._read(path)
                self.diff = text
            else:
                await self._read(path)
                self.diff = None
        except ApiError as e:
            self.town.notify(str(e), severity="error")
            return
        self.latex = None
        self.ftree.reveal(path)
        self.paint_view()
        self.paint_status()
        self.viewer.scroll_home(animate=False)
        if focus:
            self.viewer.focus()

    async def _read(self, path: str) -> None:
        f = await self.town.local.ws_read(self.info.get("path") or "", path) if self.info else None
        if f is None:
            f = await self.town.api.get(f"/api/lines/{self.line_id}/ws/{self.root}/file", path=path)
        if f.get("error"):
            raise ApiError(400, f["error"])
        if self.opened != path:
            self.wrap = None
        self.opened, self.file = path, f

    def show_log(self, log: str) -> None:
        self.latex, self.diff = log, None
        self.paint_view()
        self.paint_status()
        self.viewer.scroll_home(animate=False)

    def toggle_wrap(self) -> None:
        if self.file and self.opened:
            self.wrap = not self.wrapped()
            self.paint_view()
            self.paint_status()

    def wrapped(self) -> bool:
        if self.wrap is not None:
            return self.wrap
        return bool(self.opened) and language(self.opened)[0] in WRAPPED

    def paint_head(self) -> None:
        u = self.town.ed.ui
        t = Text(" 资源管理器" if self.root == "code" else " 论文工程", style=f"bold {u['muted']}")
        if self.ftree.filter:
            t.append(f"  筛选「{self.ftree.filter}」", style=u["accent"])
        self.query_one(".ed-head", Static).update(t)

    def paint_view(self) -> None:
        th = self.town.ed
        u = th.ui
        if not self.info:
            self.viewer.show(Padding(Text("这个项目还没有" + ("代码仓库" if self.root == "code" else "论文工程"), style=u["muted"]), (1, 2)))
            return
        if self.latex is not None:
            self.viewer.show(Padding(Group(Text("LaTeX 报错（打开一个文件就回到源码）", style=f"bold {th.tok['bad']}"), Text(),
                                           Text(self.latex, style=u["fg"])), (1, 2)))
            return
        if not self.opened or not self.file:
            keys = [("Enter", "打开"), ("→ ←", "展开 / 收起"), ("/", "筛选"), ("E", "改"), ("d", "看改动"), ("w", "换行"), ("Esc", "回到文件")]
            if self.root == "paper":
                keys += [("C", "编译"), ("P", "看 PDF")]
            keys.append(("T", "换配色和图标"))
            body = [Text(self.info.get("name") or "", style=f"bold {u['fg']}"), Text(self.info.get("path") or "", style=u["muted"]), Text()]
            body += [Text.assemble((f"{k:<6}", f"bold {u['accent']}"), (w, u["fg"])) for k, w in keys]
            self.viewer.show(Padding(Group(*body), (1, 3)))
            return
        f, path = self.file, self.opened
        if self.diff is not None:
            self.viewer.show(Syntax(self.diff, language("x.diff")[1] or "diff", theme=EdSyntax(th), word_wrap=False), wrap=False)
            return
        if f.get("binary") or f.get("too_big"):
            self.viewer.show(Padding(Text(f"{path} · {size(f.get('size'))} · {'二进制文件' if f.get('binary') else '太大，不在这里显示'}"
                                          + ("\nP 用系统的查看器打开" if path.endswith(".pdf") else ""), style=u["muted"]), (1, 2)))
            return
        _, lexer = language(path)
        wrap = self.wrapped()
        self.viewer.show(Syntax(f.get("text") or "", lexer or "text", theme=EdSyntax(th), line_numbers=True, word_wrap=wrap,
                                indent_guides=False, tab_size=4), wrap=wrap)

    def paint_status(self) -> None:
        left, right = Text(" "), Text()
        if self.info:
            if self.info.get("git"):
                left.append(f"⎇ {self.info.get('branch') or 'HEAD'}   ")
            n = sum(1 for f in self.ftree.files if f.get("status"))
            left.append(f"{n} 处改动   " if n else "没有改动   ")
            left.append(f"{len(self.ftree.files)} 个文件")
        if self.opened and self.file:
            st = GIT.get(self.file.get("status") or next((f.get("status") or "" for f in self.ftree.files if f["path"] == self.opened), ""))
            text = self.file.get("text")
            bits = ["看改动"] if self.diff is not None else ["编译报错"] if self.latex is not None else []
            if st:
                bits.append({"M": "已修改", "R": "改了名", "A": "新加的", "U": "没进 git", "D": "删掉了"}[st[0]])
            if text is not None:
                bits += [f"{text.count(chr(10)) + (0 if text.endswith(chr(10)) else 1)} 行", size(self.file.get("size")), language(self.opened)[0],
                         "自动换行" if self.wrapped() else "不换行"]
            bits.append(self.town.ed.name)
            right.append("  ·  ".join(bits) + " ")
        grid = Table.grid(expand=True)
        grid.add_column(no_wrap=True, overflow="ellipsis")
        grid.add_column(justify="right", no_wrap=True)
        grid.add_row(left, right)
        self.query_one(".ed-status", Static).update(grid)

    def set_filter(self, q: str) -> None:
        self.ftree.filter = q
        self.ftree.paint()
        self.paint_head()


# ---------- the editor ----------

class EdTextArea(TextArea):
    """a TextArea that colours its text with the viewer's lexers and roles instead of tree-sitter (which
    has no LaTeX): the highlights it keeps per line are filled from the tokens"""

    def __init__(self, text: str, path: str, th: EdTheme, **kw: Any):
        self._lexer = language(path)[1]  # before TextArea's own start, which builds the highlights once
        super().__init__(text, **kw)

    def set_theme(self, th: EdTheme) -> None:
        t = textarea_theme(th)
        self.register_theme(t)
        self.theme = t.name

    def _build_highlight_map(self) -> None:
        try:
            self._line_cache.clear()
            hl = self._highlights
            hl.clear()
        except AttributeError:  # a Textual that keeps its highlights elsewhere: plain text, then
            return
        text = self.text
        if self._lexer is None or len(text) > 400_000:
            return
        row = col = 0
        for _, ttype, value in self._lexer.get_tokens_unprocessed(text):
            role = role_for(ttype)
            for k, part in enumerate(value.split("\n")):
                if k:
                    row, col = row + 1, 0
                n = len(part.encode("utf-8"))
                if role and n:
                    hl[row].append((col, col + n, role))
                col += n


class Editor(ModalScreen[bool]):
    """a file of the project's workspace, to change: Ctrl+S saves and keeps it open, Esc closes it (and
    asks first when something is not saved). Dismisses with whether anything was saved."""

    BINDINGS = [Binding("ctrl+s", "save", "保存", priority=True), Binding("escape", "close", "关闭", priority=True)]

    def __init__(self, path: str, text: str, save: Callable[[str], Awaitable[bool]]):
        super().__init__(classes="modal")
        self.path, self.saved_text, self.save = path, text, save
        self.saved_any = False

    @property
    def town(self) -> "Papertown":
        return self.app  # type: ignore[return-value]

    def compose(self) -> ComposeResult:
        th = self.town.ed
        lang = language(self.path)[0]
        with Vertical(classes="dialog editor"):
            yield Static(Text.assemble(("改 ", "bold"), (self.path, "bold")), classes="dialog-title")
            yield EdTextArea(self.saved_text, self.path, th, show_line_numbers=True, tab_behavior="indent", soft_wrap=lang in WRAPPED)
            yield Bar(classes="ed-status")

    def on_mount(self) -> None:
        self.restyle()
        self.query_one(EdTextArea).focus()

    def restyle(self) -> None:
        th = self.town.ed
        swap_theme_class(self.query_one(".editor"), th)
        self.query_one(EdTextArea).set_theme(th)
        self.paint_status()

    @property
    def dirty(self) -> bool:
        return self.query_one(EdTextArea).text != self.saved_text

    def paint_status(self, note: str = "") -> None:
        ta = self.query_one(EdTextArea)
        row, col = ta.cursor_location
        left = Text(f" 行 {row + 1}，列 {col + 1}   {language(self.path)[0]}   ")
        left.append("● 没保存" if self.dirty else (note or "已保存"), style="bold" if self.dirty else "")
        grid = Table.grid(expand=True)
        grid.add_column(no_wrap=True)
        grid.add_column(justify="right", no_wrap=True)
        grid.add_row(left, Text(f"Ctrl+S 保存 · Esc 关闭 · {self.town.ed.name} "))
        self.query_one(".ed-status", Static).update(grid)

    @on(TextArea.Changed)
    @on(TextArea.SelectionChanged)
    def _moved(self) -> None:
        self.paint_status()

    @work(exclusive=True, group="ed-save")
    async def action_save(self) -> None:
        text = self.query_one(EdTextArea).text
        if text == self.saved_text:
            self.paint_status("没有要保存的")
            return
        if await self.save(text):
            self.saved_text, self.saved_any = text, True
            self.paint_status("已保存")

    def action_close(self) -> None:
        if not self.dirty:
            self.dismiss(self.saved_any)
            return

        def answered(drop: bool | None) -> None:
            if drop:
                self.dismiss(self.saved_any)

        self.app.push_screen(Confirm(f"{self.path} 还没保存", "关掉就丢掉这些修改。y 丢掉，n 回去接着改（Ctrl+S 保存）"), answered)


# ---------- the looks ----------

LOOK_TABS = [("ui", "界面"), ("theme", "编辑器配色"), ("icons", "文件图标")]
UI_NAMES = {"papertown": "深色", "papertown-paper": "纸色"}


def swatch(bg: str, *colors: str) -> Text:
    return Text.assemble((" ", f"on {bg}"), *[("●", f"{c} on {bg}") for c in colors], (" ", f"on {bg}"))


class LookPicker(ModalScreen[None]):
    """the TUI's theme, the editor's colours and the file icons, as VS Code picks a theme: moving
    through the list tries each, Enter keeps it, Esc puts back what was there"""

    BINDINGS = [Binding("escape", "cancel", "取消", priority=True), Binding("tab,right", "tab(1)", "下一类", priority=True),
                Binding("shift+tab,left", "tab(-1)", "上一类", priority=True)]

    def __init__(self, tab: str = "theme"):
        super().__init__(classes="modal")
        self.tab = tab
        self.filling = False

    @property
    def town(self) -> "Papertown":
        return self.app  # type: ignore[return-value]

    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog picker"):
            yield Bar(id="lp-tabs", classes="dialog-title")
            yield OptionList(id="lp-list")
            yield Static(Text.assemble(("↑↓", "bold"), " 试 · ", ("Enter", "bold"), " 就用它 · ", ("Tab ← →", "bold"), " 换一类 · ",
                                       ("Esc", "bold"), " 不换"), classes="dialog-keys")

    def on_mount(self) -> None:
        pr = self.town.prefs
        self.was = (self.town.theme, pr.ed_theme, pr.ed_icons)
        self.fill()

    def fill(self) -> None:
        p = self.town.pal
        t = Text()
        for k, label in LOOK_TABS:
            t.append(f" {label} ", style=f"bold {p['brand']} underline" if k == self.tab else p["muted"])
            t.append(" ")
        self.query_one("#lp-tabs", Static).update(t)
        ol = self.query_one(OptionList)
        self.filling = True
        ol.clear_options()
        dark = self.town.theme == "papertown"
        was = dict(zip(("ui", "theme", "icons"), self.was))
        now = (self.town.theme, self.town.prefs.ed_theme, self.town.prefs.ed_icons)[["ui", "theme", "icons"].index(self.tab)]

        def mark(k: str) -> Text:
            return Text("  当前", style=p["muted"]) if k == was[self.tab] else Text()

        if self.tab == "ui":
            for k, name in UI_NAMES.items():
                q = PALETTES[k]
                ol.add_option(Option(Text.assemble(swatch(q["bg"], q["brand"], q["ink"], q["ok"], q["info"]), f"  {name}", mark(k)), id=f"ui:{k}"))
        elif self.tab == "theme":
            opts: list[Option | None] = []
            for group, is_dark in (("浅色", False), ("深色", True)):
                if opts:
                    opts.append(None)
                opts.append(Option(Text(group, style=p["muted"]), disabled=True))
                for th in THEMES:
                    shown = resolve(th.id, dark)  # 纸墨 goes with the TUI's own theme
                    if shown.dark != is_dark:
                        continue
                    tk = shown.tok
                    opts.append(Option(Text.assemble(swatch(shown.ui["bg"], tk["kw"], tk["str"], tk["fn"], tk["num"]), f"  {th.name}", mark(th.id)),
                                       id=f"theme:{th.id}"))
            ol.add_options(opts)
        else:
            th = self.town.ed
            for k, name, desc in ICON_THEMES:
                sample = Text()
                for f in ("a.py", "main.tex", "refs.bib", "README.md"):
                    sample.append_text(file_icon(f, k, th))
                sample.truncate(18, overflow="ellipsis", pad=True)
                ol.add_option(Option(Text.assemble(sample, (f"  {name}", "bold"), mark(k), (f"  {desc}", p["muted"])), id=f"icons:{k}"))
        ol.highlighted = ol.get_option_index(f"{self.tab}:{now}")  # by its id: the separators are not counted
        self.filling = False
        ol.focus()

    @on(OptionList.OptionHighlighted)
    def _try(self, e: OptionList.OptionHighlighted) -> None:
        if not self.filling and e.option.id:
            self.town.set_look(**self._choice(e.option.id))

    @on(OptionList.OptionSelected)
    def _keep(self, e: OptionList.OptionSelected) -> None:
        if e.option.id:
            self.town.set_look(**self._choice(e.option.id), keep=True)
        self.dismiss(None)

    @staticmethod
    def _choice(oid: str) -> dict:
        kind, value = oid.split(":", 1)
        return {"ui": {"theme": value}, "theme": {"ed_theme": value}, "icons": {"ed_icons": value}}[kind]

    def action_tab(self, step: int) -> None:
        keys = [k for k, _ in LOOK_TABS]
        self.tab = keys[(keys.index(self.tab) + step) % len(keys)]
        self.fill()

    def action_cancel(self) -> None:
        theme, ed, icons = self.was
        self.town.set_look(theme=theme, ed_theme=ed, ed_icons=icons)
        self.dismiss(None)
