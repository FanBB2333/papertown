"""The editor's looks in the TUI, the same as the web page's (web/src/console/edthemes.ts): a colour
theme for the code and paper pages (the file list, the viewer, the editor and their status line) and
a file icon theme for the list of files. 纸墨, the default, is the TUI's own palette, dark or on paper
as the TUI is; the others are VS Code's and their families'.

A theme colours the widgets through the classes css() writes (one .ed-… per theme, swapped on the
page), and the text through the roles the lexers give each token (texlex.py, role_for()). What was
chosen, with the TUI's own theme, is kept in tui.json in the data directory."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from pygments.lexer import Lexer
from pygments.lexers import get_lexer_by_name
from pygments.token import Token, _TokenType
from pygments.util import ClassNotFound
from rich.style import Style
from rich.syntax import SyntaxTheme
from rich.text import Text
from textual.widgets.text_area import TextAreaTheme

from .anim import mix
from .look import PALETTES
from .texlex import ROLE_OF, BibtexLexer, LatexLexer


@dataclass(frozen=True)
class EdTheme:
    id: str
    name: str
    dark: bool
    ui: dict[str, str]
    tok: dict[str, str]
    italic: bool = False

    @property
    def key(self) -> str:
        """its class on the page: 纸墨 has one for each of the TUI's own themes"""
        return f"paper-{'dark' if self.dark else 'light'}" if self.id == "paper" else self.id


def _ui(bg: str, fg: str, side: str, border: str, muted: str, gutter: str, gutter_on: str, line: str, sel: str, accent: str, status: str,
        status_fg: str, row_on: str, git: tuple[str, str, str], dark: bool) -> dict[str, str]:
    return dict(bg=bg, fg=fg, side=side, border=border, muted=muted, gutter=gutter, gutterOn=gutter_on, line=line, sel=sel, accent=accent,
                cursor=accent, status=status, statusFg=status_fg, rowOn=row_on, hover=mix(side, fg, 0.07),
                add=mix(bg, "#3fb950", 0.2 if dark else 0.16), dele=mix(bg, "#f85149", 0.2 if dark else 0.14),
                gitMod=git[0], gitAdd=git[1], gitDel=git[2], scroll=mix(bg, fg, 0.22))


def _paper(dark: bool) -> EdTheme:
    p = PALETTES["papertown" if dark else "papertown-paper"]
    bg = p["bg"] if dark else p["panel"]
    ui = _ui(bg, p["ink"], p["bg"] if dark else mix(p["raised"], p["bg"], 0.45), p["raised"], p["muted"], p["faint"] if dark else p["muted"],
             p["ink"], p["panel"] if dark else mix(bg, p["brand"], 0.05), mix(p["brand"], bg, 0.62), p["brand"],
             mix(p["brand"], p["bg"], 0.35) if dark else mix(p["brand"], p["ink"], 0.22), "#fff8ef", mix(p["brand"], bg, 0.8),
             (p["warn"], p["ok"], p["bad"]), dark)
    tok = dict(kw="#e0896a", ctl="#d98bb0", str="#a9c47f", esc="#e8907a", num="#e0ad4c", con="#e0ad4c", com="#7d6f5d", fn="#7eaedc",
               type="#6fbfb4", var=p["ink"], prop="#c3a0d8", op="#b5a48c", punc="#b5a48c", tag="#e0896a", macro="#7eaedc", attr="#c3a0d8",
               head="#f3e9da", link="#7eaedc", label="#6fbfb4", math="#c3a0d8", mathCmd="#e0896a", mathDelim="#e0ad4c", meta="#a3927b",
               bad="#e0705a", quote="#93846f", mono="#e0896a", list="#e0ad4c") if dark else dict(
        kw="#a5482c", ctl="#9a3f63", str="#5b7a37", esc="#b9543f", num="#a06a14", con="#a06a14", com="#a3927b", fn="#2f6390", type="#2e7472",
        var=p["ink"], prop="#7a4f93", op="#6b5a46", punc="#6b5a46", tag="#a5482c", macro="#2f6390", attr="#7a4f93", head="#2f261d",
        link="#2f6390", label="#2e7472", math="#7a4f93", mathCmd="#a5482c", mathDelim="#a06a14", meta="#857560", bad="#b9543f",
        quote="#857560", mono="#a5482c", list="#a06a14")
    return EdTheme("paper", "纸墨（默认）", dark, ui, tok, italic=True)


THEMES: list[EdTheme] = [
    _paper(False),  # stands for both: resolve() gives the one that goes with the TUI's own theme
    EdTheme("light", "经典浅色", False, _ui("#ffffff", "#3b3b3b", "#f8f8f8", "#e5e5e5", "#6f6f6f", "#6e7681", "#171184", "#f5f5f5", "#add6ff",
                                         "#005fb8", "#007acc", "#ffffff", "#e4e6f1", ("#895503", "#587c0c", "#ad0707"), False), dict(
        kw="#0000ff", ctl="#af00db", str="#a31515", esc="#ee0000", num="#098658", con="#0000ff", com="#008000", fn="#795e26", type="#267f99",
        var="#001080", prop="#001080", op="#3b3b3b", punc="#3b3b3b", tag="#800000", macro="#0000ff", attr="#e50000", head="#800000",
        link="#0451a5", label="#0070c1", math="#098658", mathCmd="#795e26", mathDelim="#af00db", meta="#795e26", bad="#cd3131",
        quote="#0451a5", mono="#a31515", list="#0451a5")),
    EdTheme("solarized-light", "Solarized 浅色", False, _ui("#fdf6e3", "#586e75", "#eee8d5", "#ddd6c1", "#839496", "#93a1a1", "#586e75",
                                                          "#f1ecdb", "#d6e1df", "#2aa198", "#eee8d5", "#586e75", "#e1e6e0",
                                                          ("#b58900", "#859900", "#dc322f"), False), dict(
        kw="#859900", ctl="#859900", str="#2aa198", esc="#dc322f", num="#d33682", con="#cb4b16", com="#93a1a1", fn="#268bd2", type="#b58900",
        var="#268bd2", prop="#6c71c4", op="#859900", punc="#657b83", tag="#268bd2", macro="#cb4b16", attr="#93a1a1", head="#268bd2",
        link="#2aa198", label="#d33682", math="#6c71c4", mathCmd="#268bd2", mathDelim="#dc322f", meta="#cb4b16", bad="#dc322f",
        quote="#93a1a1", mono="#2aa198", list="#b58900"), italic=True),
    EdTheme("dark", "经典深色", True, _ui("#1e1e1e", "#d4d4d4", "#252526", "#2b2b2b", "#9d9d9d", "#858585", "#c6c6c6", "#282828", "#264f78",
                                        "#0078d4", "#007acc", "#ffffff", "#37373d", ("#e2c08d", "#73c991", "#c74e39"), True), dict(
        kw="#569cd6", ctl="#c586c0", str="#ce9178", esc="#d7ba7d", num="#b5cea8", con="#569cd6", com="#6a9955", fn="#dcdcaa", type="#4ec9b0",
        var="#9cdcfe", prop="#9cdcfe", op="#d4d4d4", punc="#d4d4d4", tag="#569cd6", macro="#569cd6", attr="#9cdcfe", head="#569cd6",
        link="#4daafc", label="#d7ba7d", math="#9cdcfe", mathCmd="#dcdcaa", mathDelim="#c586c0", meta="#dcdcaa", bad="#f44747",
        quote="#6a9955", mono="#ce9178", list="#6796e6")),
    EdTheme("one-dark", "One Dark", True, _ui("#282c34", "#abb2bf", "#21252b", "#181a1f", "#7f848e", "#495162", "#abb2bf", "#2c313c", "#3e4451",
                                            "#61afef", "#21252b", "#9da5b4", "#323842", ("#e5c07b", "#98c379", "#e06c75"), True), dict(
        kw="#c678dd", ctl="#c678dd", str="#98c379", esc="#56b6c2", num="#d19a66", con="#d19a66", com="#7f848e", fn="#61afef", type="#e5c07b",
        var="#e06c75", prop="#e06c75", op="#56b6c2", punc="#abb2bf", tag="#e06c75", macro="#c678dd", attr="#d19a66", head="#e06c75",
        link="#61afef", label="#d19a66", math="#56b6c2", mathCmd="#61afef", mathDelim="#e5c07b", meta="#61afef", bad="#ff616e",
        quote="#7f848e", mono="#98c379", list="#e06c75"), italic=True),
    EdTheme("monokai", "Monokai", True, _ui("#272822", "#f8f8f2", "#1e1f1c", "#151612", "#a59f85", "#90908a", "#f8f8f2", "#3e3d32", "#49483e",
                                          "#f92672", "#414339", "#f8f8f2", "#414339", ("#e6db74", "#a6e22e", "#f92672"), True), dict(
        kw="#f92672", ctl="#f92672", str="#e6db74", esc="#ae81ff", num="#ae81ff", con="#ae81ff", com="#88846f", fn="#a6e22e", type="#66d9ef",
        var="#f8f8f2", prop="#f8f8f2", op="#f92672", punc="#f8f8f2", tag="#f92672", macro="#66d9ef", attr="#a6e22e", head="#a6e22e",
        link="#66d9ef", label="#e6db74", math="#fd971f", mathCmd="#66d9ef", mathDelim="#f92672", meta="#a6e22e", bad="#f44747",
        quote="#88846f", mono="#e6db74", list="#fd971f")),
    EdTheme("solarized-dark", "Solarized 深色", True, _ui("#002b36", "#93a1a1", "#00212b", "#073642", "#839496", "#586e75", "#93a1a1",
                                                        "#073642", "#274642", "#2aa198", "#00212b", "#93a1a1", "#004454",
                                                        ("#b58900", "#859900", "#dc322f"), True), dict(
        kw="#859900", ctl="#859900", str="#2aa198", esc="#dc322f", num="#d33682", con="#cb4b16", com="#586e75", fn="#268bd2", type="#b58900",
        var="#268bd2", prop="#6c71c4", op="#859900", punc="#839496", tag="#268bd2", macro="#cb4b16", attr="#93a1a1", head="#268bd2",
        link="#2aa198", label="#d33682", math="#6c71c4", mathCmd="#268bd2", mathDelim="#dc322f", meta="#cb4b16", bad="#dc322f",
        quote="#586e75", mono="#2aa198", list="#b58900"), italic=True),
    EdTheme("nord", "Nord", True, _ui("#2e3440", "#d8dee9", "#2b303b", "#3b4252", "#8c96aa", "#4c566a", "#d8dee9", "#3b4252", "#434c5e", "#88c0d0",
                                    "#3b4252", "#d8dee9", "#434c5e", ("#ebcb8b", "#a3be8c", "#bf616a"), True), dict(
        kw="#81a1c1", ctl="#81a1c1", str="#a3be8c", esc="#ebcb8b", num="#b48ead", con="#81a1c1", com="#616e88", fn="#88c0d0", type="#8fbcbb",
        var="#d8dee9", prop="#d8dee9", op="#81a1c1", punc="#eceff4", tag="#81a1c1", macro="#88c0d0", attr="#8fbcbb", head="#88c0d0",
        link="#88c0d0", label="#8fbcbb", math="#ebcb8b", mathCmd="#88c0d0", mathDelim="#81a1c1", meta="#d08770", bad="#bf616a",
        quote="#616e88", mono="#a3be8c", list="#81a1c1"), italic=True),
]
PAPER = {False: THEMES[0], True: _paper(True)}


def resolve(theme_id: str, app_dark: bool) -> EdTheme:
    if theme_id == "paper":
        return PAPER[app_dark]
    return next((t for t in THEMES if t.id == theme_id), PAPER[app_dark])


# ---------- the text ----------

T = Token
STD: dict[_TokenType, str] = {
    T.Keyword: "kw", T.Keyword.Constant: "con", T.Keyword.Type: "type", T.Keyword.Namespace: "kw",
    T.Name.Builtin: "fn", T.Name.Builtin.Pseudo: "kw", T.Name.Function: "fn", T.Name.Function.Magic: "fn", T.Name.Class: "type",
    T.Name.Namespace: "type", T.Name.Decorator: "meta", T.Name.Exception: "type", T.Name.Tag: "tag", T.Name.Attribute: "attr",
    T.Name.Variable: "var", T.Name.Constant: "con", T.Name.Label: "label", T.Name.Entity: "esc", T.Name.Property: "prop",
    T.String: "str", T.String.Escape: "esc", T.String.Regex: "esc", T.String.Interpol: "esc", T.String.Symbol: "con",
    T.String.Backtick: "mono", T.Number: "num", T.Literal.Date: "num", T.Operator: "op", T.Operator.Word: "kw", T.Punctuation: "punc",
    T.Comment: "com", T.Comment.Preproc: "meta", T.Comment.PreprocFile: "str", T.Generic.Heading: "head", T.Generic.Subheading: "head",
    T.Generic.Emph: "em", T.Generic.Strong: "strong", T.Generic.Inserted: "ins", T.Generic.Deleted: "del", T.Generic.Error: "bad",
    T.Generic.Traceback: "bad", T.Generic.Prompt: "kw", T.Generic.Output: "quote",
}


def role_for(t: _TokenType) -> str | None:
    """the role of a token, from its own type or the nearest one above it"""
    while t is not None:
        r = ROLE_OF.get(t) or STD.get(t)
        if r:
            return r
        t = t.parent
    return None


def role_style(th: EdTheme, role: str) -> Style:
    c, u = th.tok.get(role), th.ui
    if role == "strong":
        return Style(bold=True)
    if role == "em":
        return Style(italic=True)
    if role == "ins":
        return Style(color=th.tok["str"], bgcolor=u["add"])
    if role == "del":
        return Style(color=th.tok["bad"], bgcolor=u["dele"])
    return Style(color=c, bold=role in ("head", "mathDelim") or None, italic=(role == "com" and th.italic) or role == "quote" or None,
                 underline=role == "link" or None)


class EdSyntax(SyntaxTheme):
    """a theme for Rich's Syntax: each token's colour from its role"""

    def __init__(self, th: EdTheme):
        self.th = th
        self.cache: dict[_TokenType, Style] = {}
        self.base = Style(color=th.ui["fg"])

    def get_style_for_token(self, token_type: _TokenType) -> Style:
        s = self.cache.get(token_type)
        if s is None:
            r = role_for(token_type)
            s = self.cache[token_type] = self.base + role_style(self.th, r) if r else self.base
        return s

    def get_background_style(self) -> Style:
        return Style(bgcolor=self.th.ui["bg"])


def textarea_theme(th: EdTheme) -> TextAreaTheme:
    """the same for the editor: its gutter, cursor and selection, and the roles as its highlight names"""
    u = th.ui
    return TextAreaTheme(
        name=f"pt-{th.key}", base_style=Style(color=u["fg"], bgcolor=u["bg"]), gutter_style=Style(color=u["gutter"], bgcolor=u["bg"]),
        cursor_style=Style(color=u["bg"], bgcolor=u["cursor"]), cursor_line_style=Style(bgcolor=u["line"]),
        cursor_line_gutter_style=Style(color=u["gutterOn"], bgcolor=u["line"]), bracket_matching_style=Style(bgcolor=mix(u["bg"], u["accent"], 0.35)),
        selection_style=Style(bgcolor=u["sel"]), syntax_styles={r: role_style(th, r) for r in (*th.tok, "strong", "em", "ins", "del")},
    )


LANGS = {".tex": ("LaTeX", None), ".sty": ("LaTeX", None), ".cls": ("LaTeX", None), ".ltx": ("LaTeX", None), ".bib": ("BibTeX", None),
         ".py": ("Python", "python"), ".pyi": ("Python", "python"), ".md": ("Markdown", "markdown"), ".markdown": ("Markdown", "markdown"),
         ".yaml": ("YAML", "yaml"), ".yml": ("YAML", "yaml"), ".json": ("JSON", "json"), ".jsonl": ("JSON Lines", "json"),
         ".toml": ("TOML", "toml"), ".sh": ("Shell", "bash"), ".bash": ("Shell", "bash"), ".zsh": ("Shell", "zsh"),
         ".js": ("JavaScript", "javascript"), ".mjs": ("JavaScript", "javascript"), ".jsx": ("JavaScript", "jsx"),
         ".ts": ("TypeScript", "typescript"), ".tsx": ("TypeScript", "tsx"), ".c": ("C", "c"), ".h": ("C", "c"), ".cc": ("C++", "cpp"),
         ".cpp": ("C++", "cpp"), ".hpp": ("C++", "cpp"), ".cu": ("CUDA", "cuda"), ".rs": ("Rust", "rust"), ".go": ("Go", "go"),
         ".java": ("Java", "java"), ".css": ("CSS", "css"), ".html": ("HTML", "html"), ".cfg": ("INI", "ini"), ".ini": ("INI", "ini"),
         ".sql": ("SQL", "sql"), ".r": ("R", "r"), ".jl": ("Julia", "julia"), ".lua": ("Lua", "lua"), ".diff": ("Diff", "diff"),
         ".patch": ("Diff", "diff")}
NAMES = {"makefile": ("Makefile", "make"), "dockerfile": ("Dockerfile", "docker"), ".gitignore": ("Ignore", "text")}
WRAPPED = {"LaTeX", "BibTeX", "Markdown", "纯文本"}  # prose: shown wrapped unless you say otherwise


def language(path: str) -> tuple[str, Lexer | None]:
    """a file's language, by its name, and the lexer that reads it (None: plain text)"""
    p = Path(path)
    name, alias = NAMES.get(p.name.lower()) or LANGS.get(p.suffix.lower()) or ("纯文本", None)
    opts = dict(stripnl=False, ensurenl=True, tabsize=4)  # the lines as they are, so the numbers stay right
    if name == "LaTeX":
        return name, LatexLexer(**opts)
    if name == "BibTeX":
        return name, BibtexLexer(**opts)
    try:
        return name, get_lexer_by_name(alias, **opts) if alias else None
    except ClassNotFound:
        return name, None


# ---------- file icons ----------

ICON_THEMES = [("dots", "色点", "文件名前一个小色块，最安静（默认）"), ("glyphs", "字标", "彩色的类型缩写，像 Seti"),
               ("badges", "徽章", "实心的类型色块，常见文件夹各有颜色"), ("none", "无图标", "只有文件名")]

EXT: dict[str, tuple[str, str]] = {
    "py": ("#3572a5", "py"), "pyi": ("#3572a5", "pyi"), "ipynb": ("#e46e2e", "nb"), "js": ("#c9a41a", "js"), "mjs": ("#c9a41a", "js"),
    "cjs": ("#c9a41a", "js"), "jsx": ("#c9a41a", "jsx"), "ts": ("#2f74c0", "ts"), "mts": ("#2f74c0", "ts"), "tsx": ("#2f74c0", "tsx"),
    "json": ("#a0782a", "{}"), "jsonl": ("#a0782a", "{}"), "md": ("#4b7bb0", "M↓"), "markdown": ("#4b7bb0", "M↓"), "rst": ("#4b7bb0", "rst"),
    "txt": ("#8a8a8a", "≡"), "log": ("#8a8a8a", "log"), "tex": ("#3d8b80", "TeX"), "sty": ("#3d8b80", "sty"), "cls": ("#3d8b80", "cls"),
    "bib": ("#7a9b3c", "bib"), "bst": ("#7a9b3c", "bst"), "yaml": ("#b0413e", "yml"), "yml": ("#b0413e", "yml"), "toml": ("#9c4221", "tml"),
    "ini": ("#6d8086", "ini"), "cfg": ("#6d8086", "cfg"), "sh": ("#4e9a06", "$_"), "bash": ("#4e9a06", "$_"), "zsh": ("#4e9a06", "$_"),
    "c": ("#555fbf", "C"), "h": ("#7a5fbf", "h"), "cc": ("#00599c", "C++"), "cpp": ("#00599c", "C++"), "cxx": ("#00599c", "C++"),
    "hpp": ("#7a5fbf", "h++"), "cu": ("#5b8f1f", "cu"), "cuh": ("#5b8f1f", "cu"), "rs": ("#b7410e", "rs"), "go": ("#00a3c4", "go"),
    "java": ("#b07219", "jv"), "html": ("#e44d26", "<>"), "htm": ("#e44d26", "<>"), "css": ("#563d7c", "#"), "scss": ("#c6538c", "#"),
    "csv": ("#2f8f5b", "csv"), "tsv": ("#2f8f5b", "tsv"), "parquet": ("#2f8f5b", "pq"), "pdf": ("#c4362b", "pdf"), "png": ("#a2569b", "img"),
    "jpg": ("#a2569b", "img"), "jpeg": ("#a2569b", "img"), "gif": ("#a2569b", "img"), "svg": ("#d9822b", "svg"), "webp": ("#a2569b", "img"),
    "eps": ("#a2569b", "eps"), "zip": ("#8d6e4f", "zip"), "gz": ("#8d6e4f", "gz"), "tar": ("#8d6e4f", "tar"), "pt": ("#ee4c2c", "pt"),
    "pth": ("#ee4c2c", "pt"), "ckpt": ("#7c6f64", "ck"), "safetensors": ("#7c6f64", "st"), "npy": ("#4d77cf", "np"), "npz": ("#4d77cf", "np"),
    "h5": ("#7c6f64", "h5"), "pkl": ("#7c6f64", "pk"), "lock": ("#8a8a8a", "lck"), "env": ("#c9a41a", "env"),
}
NAME: dict[str, tuple[str, str]] = {
    "readme.md": ("#2f74c0", "i"), "readme": ("#2f74c0", "i"), "license": ("#b8952d", "§"), "license.md": ("#b8952d", "§"),
    "makefile": ("#6d8086", "mk"), "dockerfile": ("#2496ed", "dk"), ".gitignore": ("#e5533b", "git"), ".gitattributes": ("#e5533b", "git"),
    ".gitmodules": ("#e5533b", "git"), "requirements.txt": ("#3572a5", "req"), "pyproject.toml": ("#3572a5", "py"), "setup.py": ("#3572a5", "py"),
    "package.json": ("#cb3837", "npm"), ".env": ("#c9a41a", "env"), "agents.md": ("#c2663f", "AI"), "claude.md": ("#c2663f", "AI"),
    "main.tex": ("#2e7472", "TeX"),
}
FOLDER: dict[str, str] = {
    "src": "#3b82c4", "lib": "#3b82c4", "app": "#3b82c4", "tests": "#3f9c5a", "test": "#3f9c5a", "docs": "#2e8f9a", "doc": "#2e8f9a",
    "data": "#c48a2a", "datasets": "#c48a2a", "scripts": "#7c8794", "tools": "#7c8794", "bin": "#7c8794", "configs": "#8a5fbf",
    "config": "#8a5fbf", "conf": "#8a5fbf", "figures": "#c25a8a", "figs": "#c25a8a", "images": "#c25a8a", "img": "#c25a8a",
    "assets": "#c25a8a", "paper": "#3d8b80", "tex": "#3d8b80", "latex": "#3d8b80", "sections": "#3d8b80", "notebooks": "#e46e2e",
    "models": "#7c6f64", "checkpoints": "#7c6f64", "results": "#b0723a", "outputs": "#b0723a", "logs": "#b0723a", "runs": "#b0723a",
    "experiments": "#b0413e", ".github": "#6b6b6b", ".papertown": "#c2663f",
}


def kind_of(path: str) -> tuple[str, str]:
    name = Path(path).name
    ext = name.rsplit(".", 1)[-1].lower() if "." in name[1:] else ""
    return NAME.get(name.lower()) or EXT.get(ext) or ("#a3927b", "")


def file_icon(path: str, icons: str, th: EdTheme) -> Text:
    """the icon before a file's name, with the space after it (nothing for none)"""
    if icons == "none":
        return Text()
    c, short = kind_of(path)
    if th.dark:
        c = mix(c, "#ffffff", 0.25)
    if icons == "dots":
        return Text.assemble(("●", c), " ")
    if icons == "glyphs":
        return Text.assemble((f"{short or '·':<3}", f"bold {c}"), " ")
    return Text.assemble((f"{short or '·':^3}", f"bold #ffffff on {c}"), " ")


def folder_icon(name: str, icons: str, th: EdTheme) -> Text:
    if icons != "badges":
        return Text()
    c = FOLDER.get(name.lower(), "#c09a5b")
    return Text.assemble(("   ", f"on {mix(c, '#ffffff', 0.15) if th.dark else c}"), " ")  # the folder's colour, as the files' badges are


GIT = {"modified": ("M", "gitMod"), "renamed": ("R", "gitMod"), "added": ("A", "gitAdd"), "untracked": ("U", "gitAdd"), "deleted": ("D", "gitDel")}


# ---------- the widgets' colours ----------

def css() -> str:
    """one class per theme for what Textual draws itself: the file list, the viewer, the status line
    and the editor; the text in them takes its colours from the roles above"""
    out = []
    for th in [*THEMES, PAPER[True]]:
        u, c = th.ui, f".ed-{th.key}"
        bar = f"scrollbar-background: {{bg}}; scrollbar-background-hover: {{bg}}; scrollbar-background-active: {{bg}}; " \
              f"scrollbar-color: {u['scroll']}; scrollbar-color-hover: {mix(u['scroll'], u['fg'], 0.3)}; scrollbar-color-active: {u['accent']};"
        out.append(f"""
{c} .ed-tree {{ background: {u['side']}; color: {u['fg']}; {bar.format(bg=u['side'])} }}
{c} .ed-tree > .datatable--header {{ background: {u['side']}; color: {u['muted']}; }}
{c} .ed-tree > .datatable--cursor {{ background: {u['rowOn']}; color: {u['fg']}; }}
{c} .ed-tree:focus > .datatable--cursor {{ background: {u['sel']}; color: {u['fg']}; }}
{c} .ed-tree > .datatable--hover {{ background: {u['hover']}; }}
{c} .ed-side {{ background: {u['side']}; border-right: vkey {u['border']}; }}
{c} .ed-head {{ background: {u['side']}; color: {u['muted']}; }}
{c} .ed-view {{ background: {u['bg']}; color: {u['fg']}; {bar.format(bg=u['bg'])} }}
{c} .ed-status {{ background: {u['status']}; color: {u['statusFg']}; }}
{c} TextArea {{ background: {u['bg']}; {bar.format(bg=u['bg'])} }}
""")
    return "".join(out)


# ---------- what was chosen ----------

@dataclass
class Prefs:
    theme: str = "papertown"  # the TUI's own: dark, or on paper
    ed_theme: str = "paper"
    ed_icons: str = "dots"
    focus: bool = False  # the projects page without its list

    @staticmethod
    def load(path: Path) -> "Prefs":
        try:
            d = json.loads(path.read_text())
        except (OSError, ValueError):
            return Prefs()
        p = Prefs()
        if d.get("theme") in PALETTES:
            p.theme = d["theme"]
        if any(t.id == d.get("ed_theme") for t in THEMES):
            p.ed_theme = d["ed_theme"]
        if any(k == d.get("ed_icons") for k, _, _ in ICON_THEMES):
            p.ed_icons = d["ed_icons"]
        p.focus = bool(d.get("focus"))
        return p

    def save(self, path: Path) -> None:
        try:
            path.write_text(json.dumps(self.__dict__, ensure_ascii=False, indent=1))
        except OSError:
            pass
