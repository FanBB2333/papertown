"""Pygments lexers for LaTeX and BibTeX that read a paper as the web page does (web/src/console/latex.ts),
telling apart math, \\cite and \\ref keys and .bib entries; each token is a role of the editor's themes."""

from __future__ import annotations

import re
from collections.abc import Iterator

from pygments.lexer import Lexer
from pygments.token import Token, _TokenType

ROLES = ("kw", "ctl", "str", "esc", "num", "con", "com", "fn", "type", "var", "prop", "op", "punc", "tag", "macro", "attr", "head",
         "link", "label", "math", "mathCmd", "mathDelim", "meta", "bad", "quote", "mono", "list", "strong", "em", "ins", "del")
PT: dict[str, _TokenType] = {r: getattr(Token.Pt, r[0].upper() + r[1:]) for r in ROLES}
ROLE_OF: dict[_TokenType, str] = {v: k for k, v in PT.items()}
SPACE = re.compile(r"\s+")


class Stream:
    """a line read the way CodeMirror's StringStream reads it"""

    def __init__(self, line: str):
        self.s, self.pos, self.start = line, 0, 0

    def eol(self) -> bool:
        return self.pos >= len(self.s)

    def peek(self) -> str:
        return self.s[self.pos] if self.pos < len(self.s) else ""

    def next(self) -> str:
        ch = self.peek()
        self.pos += 1 if ch else 0
        return ch

    def eat(self, chars: str) -> bool:
        if self.peek() and self.peek() in chars:
            self.pos += 1
            return True
        return False

    def match(self, pat: str | re.Pattern, consume: bool = True) -> re.Match | bool | None:
        if isinstance(pat, str):
            if self.s.startswith(pat, self.pos):
                self.pos += len(pat) if consume else 0
                return True
            return None
        m = pat.match(self.s, self.pos)
        if m and consume:
            self.pos = m.end()
        return m

    def eat_space(self) -> bool:
        m = SPACE.match(self.s, self.pos)
        if m:
            self.pos = m.end()
        return bool(m)

    def current(self) -> str:
        return self.s[self.start:self.pos]


def _lines(text: str, token, state: dict) -> Iterator[tuple[int, _TokenType, str]]:
    at = 0
    for line in text.splitlines(keepends=True):
        body = line.rstrip("\r\n")
        st = Stream(body)
        while not st.eol():
            st.start = st.pos
            role = token(st, state)
            if st.pos == st.start:  # nothing taken: take a character so the line moves on
                st.next()
            yield at + st.start, PT[role] if role else Token.Text, st.current()
        if len(line) > len(body):
            yield at + len(body), Token.Text, line[len(body):]
        at += len(line)


ARG = {"head": "head", "label": "label", "env": "type", "strong": "strong", "em": "em", "url": "link", "path": "str", "pkg": "type"}
NEXT = [
    (re.compile(r"\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph|title|caption|frametitle)(?![a-zA-Z@])\*?"), "head"),
    (re.compile(r"\\(?:[a-zA-Z]*cite[a-zA-Z]*|[cC]ref|ref|eqref|autoref|pageref|nameref|label)(?![a-zA-Z@])\*?"), "label"),
    (re.compile(r"\\(?:url|href)(?![a-zA-Z@])"), "url"),
    (re.compile(r"\\(?:input|include|includeonly|includegraphics|bibliography|addbibresource|graphicspath|bibliographystyle)(?![a-zA-Z@])\*?"), "path"),
    (re.compile(r"\\(?:usepackage|RequirePackage|documentclass|LoadClass)(?![a-zA-Z@])"), "pkg"),
    (re.compile(r"\\(?:textbf|mathbf)(?![a-zA-Z@])"), "strong"),
    (re.compile(r"\\(?:emph|textit|textsl)(?![a-zA-Z@])"), "em"),
]
MATH_ENVS = re.compile(r"(?:equation|align|alignat|flalign|gather|multline|eqnarray|math|displaymath|split)\*?$")
BEGIN = re.compile(r"\\(begin|end)\b")
CMD = re.compile(r"\\[a-zA-Z@]+\*?")
ESC = re.compile(r"\\[%&$#_{}]")
SPACE_OP = re.compile(r"\\(?:\\|[,;:!> ])")
OPT = re.compile(r"[^\]\n]*\]?")
WORD = re.compile(r"[^\\{}%$&~\[\]\s]*")
END_ENV = re.compile(r"\\end\s*\{([^}]*)\}")
MATH_CMD = re.compile(r"\\[a-zA-Z@]+|\\.")
NUM = re.compile(r"\d+(?:\.\d+)?")
LETTERS = re.compile(r"[a-zA-Z]+")


def _tex(st: Stream, s: dict) -> str | None:
    if st.eat_space():
        return None
    if st.peek() == "%":
        st.pos = len(st.s)
        return "com"
    if s["math"]:
        return _math(st, s)
    if st.match(BEGIN):
        s["next"], s["begin"], s["env"] = "env", st.current() == "\\begin", ""
        return "kw"
    for pat, kind in NEXT:
        if st.match(pat):
            s["next"] = kind
            return "macro"
    for delim, close in (("$$", "$$"), ("$", "$"), ("\\(", "\\)"), ("\\[", "\\]")):
        if st.match(delim):
            s["math"] = close
            return "mathDelim"
    if st.match(CMD):
        s["next"] = None
        return "macro"
    if st.match(ESC):
        return "esc"
    if st.match(SPACE_OP):
        return "op"
    ch = st.next()
    args: list[str] = s["args"]
    if ch == "{":
        args.append(s["next"] or (args[-1] if args else ""))
        s["next"] = None
        return "punc"
    if ch == "}":
        kind = args.pop() if args else None
        if kind == "env" and s["begin"] and MATH_ENVS.match(s["env"].strip()):
            s["math"] = s["env"].strip()
        return "punc"
    if ch == "[":
        if s["next"]:
            st.match(OPT)
            return "meta"
        return "punc"
    if ch == "]":
        return "punc"
    if ch in "&~":
        return "op"
    s["next"] = None
    st.match(WORD)
    kind = args[-1] if args else None
    if kind == "env":
        s["env"] += st.current()
    return ARG.get(kind) if kind else None


def _math(st: Stream, s: dict) -> str | None:
    close = s["math"]
    if close in ("$", "$$", "\\)", "\\]"):
        if st.match(close):
            s["math"] = None
            return "mathDelim"
    else:
        m = st.match(END_ENV, consume=False)
        if m and m.group(1).strip() == close:
            st.match("\\end")
            s.update(math=None, next="env", begin=False, env="")
            return "kw"
    if st.match(MATH_CMD):
        return "mathCmd"
    if st.match(NUM):
        return "num"
    if st.match(LETTERS):
        return "math"
    ch = st.next()
    if ch in "{}[]()":
        return "punc"
    if ch in "^_&+-=<>|/*,.;:!'":
        return "op"
    return "math"


class LatexLexer(Lexer):
    name, aliases, filenames = "LaTeX (Papertown)", ["pt-latex"], ["*.tex", "*.sty", "*.cls", "*.ltx"]

    def get_tokens_unprocessed(self, text: str):
        return _lines(text, _tex, {"math": None, "next": None, "args": [], "begin": False, "env": ""})


BIB_TYPE = re.compile(r"@[a-zA-Z]+")
BIB_SKIP = re.compile(r"[^@%]+")
BIB_KEY = re.compile(r"[^,\s}]+")
BIB_NAME = re.compile(r"[a-zA-Z][\w\-:.]*")
DIGITS = re.compile(r"\d+")


def _bib(st: Stream, s: dict) -> str | None:
    if s["depth"] > 0 or s["quote"]:
        return _bib_value(st, s)
    if st.eat_space():
        return None
    if st.peek() == "%":
        st.pos = len(st.s)
        return "com"
    at = s["at"]
    if at == "out":
        if st.match(BIB_TYPE):
            s["kind"], s["at"] = st.current()[1:].lower(), "open"
            return "kw"
        if not st.match(BIB_SKIP):
            st.next()
        return "com"  # BibTeX ignores text outside an entry
    if at == "open":
        if st.eat("{("):
            if s["kind"] == "comment":
                s["depth"] = 1
                return "punc"
            s["at"] = "value" if s["kind"] == "preamble" else "field" if s["kind"] == "string" else "key"
            return "punc"
        s["at"] = "out"
        return None
    if at == "key" and st.match(BIB_KEY):
        s["at"] = "field"
        return "label"
    if at == "field" and st.match(BIB_NAME):
        s["at"] = "eq"
        return "prop"
    if at == "eq" and st.eat("="):
        s["at"] = "value"
        return "op"
    if at == "value":
        if st.eat("{"):
            s["depth"] = 1
            return _bib_value(st, s)
        if st.eat('"'):
            s["quote"] = True
            return _bib_value(st, s)
        if st.match(DIGITS):
            s["at"] = "after"
            return "num"
        if st.match(BIB_NAME):
            s["at"] = "after"
            return "var"
    if at == "after" and st.eat("#"):
        s["at"] = "value"
        return "op"
    ch = st.next()
    if ch == ",":
        if s["at"] != "key":
            s["at"] = "field"
        return "punc"
    if ch in "})":
        s["at"] = "out"
        return "punc"
    return None


def _bib_value(st: Stream, s: dict) -> str:
    comment = s["kind"] == "comment"
    while not st.eol():
        ch = st.next()
        if ch == "\\":
            st.next()
            continue
        if ch == "{":
            s["depth"] += 1
        elif ch == "}":
            if s["quote"] and s["depth"] == 0:
                continue
            s["depth"] -= 1
            if s["depth"] == 0 and not s["quote"]:
                s["at"] = "out" if comment else "after"
                break
        elif ch == '"' and s["quote"] and s["depth"] == 0:
            s["quote"], s["at"] = False, "after"
            break
    return "com" if comment else "str"


class BibtexLexer(Lexer):
    name, aliases, filenames = "BibTeX (Papertown)", ["pt-bibtex"], ["*.bib"]

    def get_tokens_unprocessed(self, text: str):
        return _lines(text, _bib, {"at": "out", "kind": "", "depth": 0, "quote": False})
