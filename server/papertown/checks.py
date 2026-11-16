"""Checks on a project. They are nodes on its canvas in 进展 (canvas.py), wired to whatever they guard.

Hard checks are code: counts, patterns and fixed formats in the paper's source, the duplicate check, the jobs'
results and the PDF. They must pass. Papertown runs them again whenever what they read changes, and a worker runs
them itself (`pt checks run`) until they pass. The paper rules come from the user's lastcheck list.

Soft checks are questions the lead answers by reading the project: a model's judgement, so a soft limit. When one
is due it goes out with the lead's <checkin>, and the lead records pass, warn or fail with its reason
(`pt check <id> pass|warn|fail "…"`); one that is not a pass becomes a report.

    data/projects/<project>/checks.json   checks turned off, thresholds, the soft questions, added pattern checks
"""

from __future__ import annotations

import bisect
import re
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import cached_property
from pathlib import Path
from typing import TYPE_CHECKING, Callable

from .db import now, read_json, write_json
from .pipeline import INDEX

if TYPE_CHECKING:
    from .town import Town

STATUS = {"pass": "通过", "warn": "有问题", "fail": "没过", "none": "没有可查的", "wait": "等负责人判断"}
VERDICTS = ("pass", "warn", "fail")
FINDINGS_MAX = 60
HISTORY_MAX = 30
TREND_MAX = 40
SOFT_EVERY = 24  # hours before a soft check is asked again
FILES_MAX = 200
REACHED = ("run", "wait", "done")


class CheckError(Exception):
    pass


def clip(s: object, n: int = 120) -> str:
    t = " ".join(str(s or "").split())
    return t if len(t) <= n else t[: n - 1] + "…"


# ---------- the paper's source, as the checks read it ----------

COMMENT = re.compile(r"(?<!\\)%.*")
ENV = re.compile(r"\\(begin|end)\{([^}]+)\}|(?<!\\)\\(\[|\])")
INPUT = re.compile(r"\\(?:input|include|subfile)\{([^}]+)\}")
MATH = {"equation", "align", "gather", "multline", "eqnarray", "displaymath", "math", "flalign", "alignat", "dmath", "["}
RAW = {"verbatim", "lstlisting", "minted", "comment", "tikzpicture", "algorithmic", "algorithm2e", "filecontents"}
TABLE = {"tabular", "tabularx", "longtable", "tabulary", "array", "supertabular"}
INLINE_MATH = re.compile(r"(?<!\\)\$[^$]*\$|\\\(.*?\\\)")
DROP = re.compile(r"\\(?:cite[a-zA-Z]*|ref|eqref|autoref|cref|Cref|pageref|label|url|href|includegraphics|input|include|"
                  r"bibliography[a-z]*|vspace|hspace|footnotemark)\*?(?:\[[^\]]*\])*(?:\{[^{}]*\})?")
CMD = re.compile(r"\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?")
CITE = re.compile(r"\\cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{([^}]*)\}")


def _base(env: str) -> str:
    return env.rstrip("*")


def clean(s: str) -> str:
    """A line of LaTeX as the words a reader sees: no math, citations, references or commands."""
    s = INLINE_MATH.sub(" ", s)
    s = DROP.sub(" ", s)
    s = s.replace("\\\\", " ").replace("~", " ")
    s = re.sub(r"\\([%&_#$])", r"\1", s)
    s = CMD.sub("", s)
    return re.sub(r"\s+", " ", s.replace("{", "").replace("}", "")).strip()


@dataclass
class Line:
    file: str
    no: int
    raw: str  # without its comment
    kind: str  # prose, table, math, raw, pre (the preamble)


@dataclass
class Para:
    """Consecutive lines of prose, cleaned and joined, with where each line starts."""
    text: str
    starts: list[int]
    lines: list[Line]

    def at(self, i: int) -> Line:
        return self.lines[max(0, bisect.bisect_right(self.starts, i) - 1)]

    def excerpt(self, i: int, j: int, pad: int = 50) -> str:
        a, b = max(0, i - pad), min(len(self.text), j + pad)
        return ("…" if a else "") + self.text[a:b] + ("…" if b < len(self.text) else "")


class Paper:
    """The paper's files from the main one through \\input and \\include, line by line; every .tex file when there
    is no main one."""

    def __init__(self, root: Path, main: Path | None):
        self.root = root
        self.lines: list[Line] = []
        self.files: list[str] = []
        self._stack: list[str] = []
        if main:
            self._walk(main, in_doc=False, depth=0, seen=set())
        else:
            for p in sorted(tex_files(root))[:FILES_MAX]:
                self._walk(p, in_doc=True, depth=99, seen=set())

    def _walk(self, path: Path, in_doc: bool, depth: int, seen: set) -> bool:
        if path in seen or len(self.files) >= FILES_MAX:
            return in_doc
        seen.add(path)
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
            rel = path.relative_to(self.root).as_posix()
        except (OSError, ValueError):
            return in_doc
        self.files.append(rel)
        for no, line in enumerate(text.splitlines(), 1):
            raw = COMMENT.sub("", line)
            if "\\begin{document}" in raw:
                in_doc = True
            ends = []
            for m in ENV.finditer(raw):
                env = _base(m.group(2)) if m.group(2) else "["
                if (m.group(1) == "begin" or m.group(3) == "[") and env in MATH | RAW | TABLE:
                    self._stack.append(env)
                elif (m.group(1) == "end" or m.group(3) == "]") and env in self._stack:
                    ends.append(env)
            kind = ("pre" if not in_doc else "raw" if RAW & set(self._stack) else "math" if MATH & set(self._stack)
                    else "table" if TABLE & set(self._stack) else "prose")
            for env in ends:
                i = len(self._stack) - 1 - self._stack[::-1].index(env)
                del self._stack[i:]
            self.lines.append(Line(rel, no, raw, kind))
            if "\\end{document}" in raw:
                return False
            if depth < 8 and kind == "prose":
                for m in INPUT.finditer(raw):
                    name = m.group(1).strip()
                    p = (self.root / name) if name.endswith(".tex") else (self.root / f"{name}.tex")
                    if p.is_file():
                        in_doc = self._walk(p, in_doc, depth + 1, seen) or in_doc
        return in_doc

    @cached_property
    def paras(self) -> list[Para]:
        out: list[Para] = []
        cur: list[tuple[Line, str]] = []

        def flush():
            if cur:
                starts, parts, n = [], [], 0
                for _, t in cur:
                    starts.append(n)
                    parts.append(t)
                    n += len(t) + 1
                out.append(Para(" ".join(parts), starts, [ln for ln, _ in cur]))
                cur.clear()

        for ln in self.lines:
            t = clean(ln.raw) if ln.kind == "prose" else ""
            if not t:
                flush()
                continue
            cur.append((ln, t))
        flush()
        return out

    def body(self) -> list[Line]:
        return [ln for ln in self.lines if ln.kind != "pre"]


def tex_files(root: Path) -> list[Path]:
    out = []
    for p in root.rglob("*.tex"):
        rel = p.relative_to(root).parts
        if any(x.startswith(".") or x in ("node_modules", "build", "out") for x in rel[:-1]):
            continue
        out.append(p)
        if len(out) >= 500:
            break
    return out


def balanced(text: str, i: int) -> tuple[str, int] | None:
    """The argument in braces that opens at text[i] ('{'), and where it ends."""
    depth = 0
    for j in range(i, len(text)):
        c = text[j]
        if c == "{" and (j == 0 or text[j - 1] != "\\"):
            depth += 1
        elif c == "}" and text[j - 1] != "\\":
            depth -= 1
            if depth == 0:
                return text[i + 1:j], j
    return None


# ---------- what each hard check reads, gathered once a run ----------

class Inputs:
    def __init__(self, town: "Town", line_id: str):
        self.town, self.line_id = town, line_id

    @cached_property
    def paper_root(self) -> Path | None:
        return self.town.workspace.find(self.line_id, "paper")

    @cached_property
    def paper(self) -> Paper | None:
        root = self.paper_root
        if not root:
            return None
        try:
            main = self.town.workspace._main(self.line_id, root)
        except OSError:
            main = None
        p = Paper(root, main)
        return p if p.lines else None

    @cached_property
    def runs(self) -> list[dict]:
        """The project's jobs that finished well, with what they returned."""
        out = []
        for j in self.town.linked.jobs(self.line_id) + self.town.farm.list(self.line_id, 200):
            state = j.get("state") or j.get("status")
            if state in ("completed", "done"):
                out.append({"id": f"nvidb-{j['id']}" if "gpu_ids" in j else j["id"], "name": j.get("name") or "", "result": j.get("result")})
        return out

    def sig(self) -> str:
        """What the hard checks read, in a line: it changes when any of it does."""
        parts = []
        root = self.paper_root
        if root:
            for p in tex_files(root):
                try:
                    st = p.stat()
                except OSError:
                    continue
                parts.append(f"{p.name}:{st.st_mtime_ns}:{st.st_size}")
            pdf = self.town.workspace.pdf(self.line_id)
            parts.append(f"pdf:{pdf.stat().st_mtime_ns if pdf else 0}")
        jobs = self.town.linked.jobs(self.line_id) + self.town.farm.list(self.line_id, 200)
        parts += sorted(f"{j['id']}:{j.get('state') or j.get('status')}:{bool(j.get('result'))}" for j in jobs)
        parts.append(str(self.town.db.val("select max(created_at) from items where line_id = ? and stage = 'hatch'", self.line_id)))
        return str(hash("|".join(parts)))


Found = tuple[float | None, list[dict], str]  # what a hard check counted (None: nothing to check), where, a note


def _hit(p: Para, m: re.Match, hint: str, hit: str | None = None) -> dict:
    ln = p.at(m.start())
    return {"file": ln.file, "line": ln.no, "text": p.excerpt(m.start(), m.end()), "hit": hit or m.group(0), "hint": hint}


def _no_paper(x: Inputs) -> Found:
    return None, [], "还没有论文" if not x.paper_root else "论文目录里没有读到 .tex 源码"


WORDS = [
    (re.compile(r"\b(?:legs?|arms?)\b", re.I), "换成具体的说法（模块、分支、部分）"),
    (re.compile(r"\brather than\b", re.I), "换个说法，比如 instead of，或者拆成两句"),
    (re.compile(r"\b(?:gates?|gated|gating)\b", re.I), "换成具体的说法"),
    (re.compile(r"\bledges?\b", re.I), "换成具体的说法"),
    (re.compile(r"\bheld-out\b", re.I), "换成 unseen、test 这类说法"),
    (re.compile(r"\bnot\b[^.!?;:]{1,80}?\bbut\b", re.I), "直接说是什么，不用 not … but …"),
    (re.compile(r"\b(?:is|are|was|were)\b[^.!?;]{1,80}?,\s*not\b", re.I), "直接说是什么，不用 … is …, not …"),
]


def check_words(x: Inputs, _: dict) -> Found:
    if not x.paper:
        return _no_paper(x)
    out = [_hit(p, m, hint) for p in x.paper.paras for rx, hint in WORDS for m in rx.finditer(p.text)]
    return len(out), out, ""


HYPHEN = re.compile(r"\b[A-Za-z]{2,}(?:-[A-Za-z]{2,})+\b")
COINED = re.compile(r"-(?:aware|guided|based|driven|centric|oriented|specific|agnostic)\b", re.I)


def _hyphenated(x: Inputs, keep: Callable[[str], bool], hint: Callable[[str], str]) -> Found:
    """Hyphenated words, each once (where it first appears, and how often)."""
    if not x.paper:
        return _no_paper(x)
    first: dict[str, dict] = {}
    count: dict[str, int] = {}
    for p in x.paper.paras:
        for m in HYPHEN.finditer(p.text):
            w = m.group(0).lower()
            if not keep(w):
                continue
            count[w] = count.get(w, 0) + 1
            if w not in first:
                first[w] = _hit(p, m, "")
    for w, f in first.items():
        f["hint"] = hint(w) + (f"（出现 {count[w]} 次）" if count[w] > 1 else "")
    return len(first), sorted(first.values(), key=lambda f: -count[f["hit"].lower()]), ""


def check_hyphens(x: Inputs, _: dict) -> Found:
    return _hyphenated(x, lambda w: True, lambda w: "写成短语，把连字符拆开说")


def check_coined(x: Inputs, _: dict) -> Found:
    return _hyphenated(x, lambda w: bool(COINED.search(w)), lambda w: f"「-{w.rsplit('-', 1)[1]}」这类词写成从句，比如 that considers …")


NUMERIC_MATH = re.compile(r"[\s\d.,;:+\-\[\]%]|\\pm")
RANGE = re.compile(r"(?<!\\)\[\s*[-+]?\d+(?:\.\d+)?\s*(?:,|;|--|–|-|to)\s*[-+]?\d+(?:\.\d+)?\s*\]")
SEED_BRACKET = re.compile(r"(?<!\\)\[[^\]\n]{0,40}\bseeds?\b[^\]\n]{0,40}\]", re.I)


def check_ranges(x: Inputs, _: dict) -> Found:
    if not x.paper:
        return _no_paper(x)
    out = []
    for ln in x.paper.body():
        if ln.kind not in ("prose", "table"):
            continue
        # inline math stays only when it is just numbers: $[0.82, 0.86]$ is a range, $\alpha \in [0, 1]$ is not
        text = INLINE_MATH.sub(lambda m: m.group(0) if not NUMERIC_MATH.sub("", m.group(0).strip("$")) else " ", ln.raw)
        for rx in (RANGE, SEED_BRACKET):
            for m in rx.finditer(text):
                out.append({"file": ln.file, "line": ln.no, "text": clip(ln.raw.strip(), 160), "hit": m.group(0),
                            "hint": "写成 ± 或放进正文，不用方括号写种子、置信区间和标准差的范围"})
    return len(out), out, ""


AMP = re.compile(r"(?<!\\)&")


def check_tablenames(x: Inputs, params: dict) -> Found:
    if not x.paper:
        return _no_paper(x)
    width = int(params.get("width") or 28)
    out = []
    for ln in x.paper.body():
        if ln.kind != "table" or not AMP.search(ln.raw):
            continue
        first = AMP.split(ln.raw, 1)[0]
        if "\\multicolumn" in first:
            continue
        name = clean(first)
        if len(name) > width:
            out.append({"file": ln.file, "line": ln.no, "text": clip(ln.raw.strip(), 160), "hit": name,
                        "hint": f"缩短到 {width} 个字符以内，细节放进正文或表注"})
    return len(out), out, ""


PAREN = re.compile(r"\(([^()]{1,240})\)")
PAREN_REF = re.compile(r"\b(?:see|cf\.|e\.g\.|i\.e\.|sections?|sec\.|appendix|app\.|tables?|tab\.|figures?|figs?\.|eq\.|details?|refer)\b", re.I)


def check_parens(x: Inputs, _: dict) -> Found:
    if not x.paper:
        return _no_paper(x)
    out = []
    for p in x.paper.paras:
        for m in PAREN.finditer(p.text):
            inner = m.group(1).strip()
            if inner and (PAREN_REF.search(inner) or len(inner.split()) > 8):
                out.append(_hit(p, m, "把括号里的内容写进句子，或者删掉"))
    return len(out), out, ""


def check_semicolons(x: Inputs, _: dict) -> Found:
    if not x.paper:
        return _no_paper(x)
    out = [_hit(p, m, "拆成两句；只有严格并列、对称的结构才用分号") for p in x.paper.paras for m in re.finditer(";", p.text)]
    return len(out), out, ""


def check_captions(x: Inputs, params: dict) -> Found:
    if not x.paper:
        return _no_paper(x)
    words = int(params.get("words") or 35)
    out = []
    by_file: dict[str, list[Line]] = {}
    for ln in x.paper.body():
        by_file.setdefault(ln.file, []).append(ln)
    for f, lines in by_file.items():
        text, starts = "", []
        for ln in lines:
            starts.append(len(text))
            text += ln.raw + "\n"
        for m in re.finditer(r"\\caption\*?(?:\[[^\]]*\])?\s*\{", text):
            arg = balanced(text, m.end() - 1)
            if not arg:
                continue
            cap = clean(arg[0])
            n = len(cap.split())
            ln = lines[max(0, bisect.bisect_right(starts, m.start()) - 1)]
            seed = re.search(r"\bseeds?\b", cap, re.I)
            if n > words or seed:
                out.append({"file": f, "line": ln.no, "text": clip(cap, 220), "hit": seed.group(0) if seed else f"{n} 个词",
                            "hint": ("去掉种子这类实验细节，" if seed else "") + f"标题缩到 {words} 个词以内，细节放进正文"})
    return len(out), out, ""


def check_cites(x: Inputs, params: dict) -> Found:
    if not x.paper:
        return _no_paper(x)
    most = int(params.get("keys") or 3)
    out = []
    for ln in x.paper.body():
        if ln.kind != "prose":
            continue
        for m in CITE.finditer(ln.raw):
            keys = [k for k in m.group(1).split(",") if k.strip()]
            if len(keys) > most:
                out.append({"file": ln.file, "line": ln.no, "text": clip(clean(ln.raw), 160), "hit": f"一处引了 {len(keys)} 篇",
                            "hint": f"一处最多引 {most} 篇，只留最相关的"})
    return len(out), out, ""


def check_novelty(x: Inputs, params: dict) -> Found:
    body = x.town.pipeline.item(x.line_id, "hatch")
    sims = [s.get("similarity") or 0 for s in (body or {}).get("similar") or [] if isinstance(s, dict)]
    if not sims:
        return None, [], "还没有查重报告"
    top = max(sims)
    cap = float(params.get("sim") or 0.85)
    out = [{"file": "", "line": 0, "text": clip(s.get("title"), 160), "hit": f"相似度 {s.get('similarity'):.2f}",
            "hint": "和 idea 太像，说清差别或调整 idea"} for s in body["similar"] if isinstance(s, dict) and (s.get("similarity") or 0) > cap]
    return len(out), out, f"最接近的一篇相似度 {top:.2f}，上限 {cap:.2f}"


def check_results(x: Inputs, _: dict) -> Found:
    runs = x.runs
    if not runs:
        return None, [], "还没有跑完的实验"
    miss = [r for r in runs if not r.get("result")]
    out = [{"file": "", "line": 0, "text": clip(r["name"], 120), "hit": r["id"], "hint": "结束时打印 RESULT {json} 或写 $PAPERTOWN_JOB_DIR/result.json"}
           for r in miss[:FINDINGS_MAX]]
    return len(miss), out, f"{len(runs) - len(miss)}/{len(runs)} 个跑完的任务交回了结果"


def check_pdf(x: Inputs, _: dict) -> Found:
    root = x.paper_root
    if not root:
        return None, [], "还没有论文"
    srcs = tex_files(root)
    if not srcs:
        return None, [], "论文目录里没有 .tex 源码"
    pdf = x.town.workspace.pdf(x.line_id)
    newest = max(srcs, key=lambda p: p.stat().st_mtime)
    if not pdf:
        return 1, [{"file": "", "line": 0, "text": "还没有编译出 PDF", "hit": "没有 PDF", "hint": "在中控屏的论文面板里重新编译"}], ""
    if pdf.stat().st_mtime + 1 < newest.stat().st_mtime:
        rel = newest.relative_to(root).as_posix()
        return 1, [{"file": rel, "line": 0, "text": f"{rel} 比 PDF 新", "hit": "PDF 过期", "hint": "改完重新编译一次"}], ""
    return 0, [], ""


@dataclass(frozen=True)
class Hard:
    id: str
    title: str  # short: it goes on the node
    stage: str
    prio: str  # P0 must pass; P1 should
    rule: str  # where it comes from
    text: str  # what it checks
    run: Callable[[Inputs, dict], Found]
    max: int = 0  # findings it lets through
    unit: str = "处"
    params: tuple = ()  # (key, default, what) a user can change
    custom: bool = False

    def judge(self, value: float | None, most: int) -> str:
        if value is None:
            return "none"
        return "pass" if value <= most else "fail" if self.prio == "P0" else "warn"


HARD = [
    Hard("novelty", "查重相似度", "hatch", "P0", "Papertown", "最接近的已有工作和 idea 的相似度不超过上限。", check_novelty, unit="篇",
         params=(("sim", 0.85, "相似度上限"),)),
    Hard("results", "交回结果", "exp", "P1", "Papertown", "跑完的实验任务都交回了 result.json（或打印了 RESULT）。", check_results, unit="个"),
    Hard("words", "禁用词", "write", "P0", "lastcheck 1.1",
         "不用 leg、arm、rather than、not … but …、gate、ledge、held-out、… is …, not … 这些说法。", check_words),
    Hard("coined", "-aware 这类词", "write", "P1", "lastcheck 1.2", "不用 xxx-aware、xxx-guided、xxx-based 这类连字符造词。", check_coined,
         unit="个词"),
    Hard("hyphens", "连字符", "write", "P1", "lastcheck 1.2", "少用连字符，尤其是自己造的词。", check_hyphens, max=8, unit="个词"),
    Hard("parens", "括号补充", "write", "P1", "lastcheck 2.3", "不用括号补充细节或指向别的章节。", check_parens),
    Hard("semicolons", "分号", "write", "P1", "lastcheck 2.4", "只有严格并列、对称的结构才用分号。", check_semicolons, max=3),
    Hard("cites", "引用堆叠", "write", "P1", "lastcheck 3.3", "一处不堆太多引用。", check_cites, params=(("keys", 3, "一处最多引几篇"),)),
    Hard("ranges", "方括号区间", "review", "P0", "lastcheck 2.1", "种子、95% 置信区间、标准差的范围不写成 [a, b]。", check_ranges),
    Hard("tablenames", "表格方法名", "review", "P1", "lastcheck 2.2", "表格里的方法名要短。", check_tablenames,
         params=(("width", 28, "方法名最多几个字符"),)),
    Hard("captions", "图表标题", "review", "P0", "lastcheck 3.2", "图表标题不长，不写种子这类细节。", check_captions,
         params=(("words", 35, "标题最多几个词"),)),
    Hard("pdf", "PDF 最新", "ship", "P1", "Papertown", "编译出的 PDF 比所有 .tex 源码都新。", check_pdf, unit="项"),
]
HARD_IDS = {h.id for h in HARD}

SOFT = [
    {"id": "method", "stage": "method", "title": "方法对题", "rule": "",
     "prompt": "方法草案有没有回答 idea 要解决的核心问题？哪一步和 idea 对不上？"},
    {"id": "direction", "stage": "exp", "title": "实验方向", "rule": "",
     "prompt": "现在在跑和计划中的实验，是不是在回答论文的核心问题？有没有偏到别的方向上？偏了就说偏在哪。"},
    {"id": "design", "stage": "exp", "title": "实验设计", "rule": "",
     "prompt": "实验设计满足要求吗：数据集、baseline、指标和消融齐不齐，比得公不公平？对照用户在卡片和工作边界里提的要求，缺什么就列出来。"},
    {"id": "claims", "stage": "write", "title": "主张有据", "rule": "",
     "prompt": "论文的每条贡献和结论，各由哪张表或哪张图支撑？没有支撑的列出来。"},
    {"id": "defensive", "stage": "review", "title": "防御性表达", "rule": "lastcheck 3.1",
     "prompt": "论文里是不是有太多防御性的表达（may、might、to some extent、potentially…）在给结论留退路？"
               "我们本来就没法用实验证明方法在所有场景都成立，有些地方可以说得更肯定。列出最该改的几句。"},
]


def pattern_check(d: dict) -> Hard:
    """A rule the user added: a pattern that should not appear in the paper (more than max times)."""
    try:
        rx = re.compile(d["pattern"], re.I)
    except (re.error, KeyError):
        rx = None

    def run(x: Inputs, _: dict) -> Found:
        if rx is None:
            return None, [], "规则写错了，改一下"
        if not x.paper:
            return _no_paper(x)
        out = [_hit(p, m, d.get("hint") or "按规则改掉") for p in x.paper.paras for m in rx.finditer(p.text)]
        return len(out), out, ""

    return Hard(d["id"], d.get("title") or d["id"], d.get("stage") or "", d.get("prio") or "P1", "你加的规则",
                f"论文里不出现 /{d.get('pattern', '')}/。", run, max=int(d.get("max") or 0), custom=True)


# ---------- the checks of each project, their results and their history ----------

class Checks:
    def __init__(self, town: "Town"):
        self.town = town
        self.db = town.db
        self.s = town.s
        self._sig: dict[str, str] = {}
        self._run_lock = threading.Lock()
        self._lock = threading.Lock()
        self._halt = threading.Event()
        self._thread: threading.Thread | None = None

    # configuration

    def _path(self, line_id: str) -> Path:
        return self.s.projects_dir / line_id / "checks.json"

    def config(self, line_id: str) -> dict:
        d = read_json(self._path(line_id), {})
        return {"off": list(d.get("off") or []), "params": dict(d.get("params") or {}),
                "soft": d.get("soft") if isinstance(d.get("soft"), list) else [dict(x, every=SOFT_EVERY) for x in SOFT],
                "rules": list(d.get("rules") or []), "asked": dict(d.get("asked") or {})}

    def _save(self, line_id: str, d: dict) -> None:
        p = self._path(line_id)
        p.parent.mkdir(parents=True, exist_ok=True)
        write_json(p, d)

    def hard(self, line_id: str, cfg: dict | None = None) -> list[Hard]:
        cfg = cfg or self.config(line_id)
        return HARD + [pattern_check(r) for r in cfg["rules"]]

    @staticmethod
    def params(h: Hard, cfg: dict) -> dict:
        given = cfg["params"].get(h.id) or {}
        return {k: given.get(k, default) for k, default, _ in h.params} | {"max": given.get("max", h.max)}

    def _line(self, line_id: str) -> dict:
        ln = self.db.one("select id, seq, status from lines where id = ?", line_id)
        if not ln:
            raise CheckError("没有这个项目")
        return ln

    # results

    def latest(self, line_id: str) -> dict[str, dict]:
        rows = self.db.q("select * from checks where id in (select max(id) from checks where line_id = ? group by check_id)", line_id)
        return {r["check_id"]: r for r in rows}

    def record(self, line_id: str, check_id: str, status: str, value: float | None, data: dict, by: str, ts: str | None = None,
               last: dict | None = None) -> bool:
        """Note a result; a hard check that finds the same as last time only moves its last-seen time."""
        ts = ts or now()
        if last and data.get("kind") == "hard" and last["status"] == status and last["value"] == value \
                and [(f["file"], f["line"], f["hit"]) for f in (last["data"] or {}).get("findings") or []] \
                == [(f["file"], f["line"], f["hit"]) for f in data.get("findings") or []]:
            self.db.x("update checks set seen = ? where id = ?", ts, last["id"])
            return False
        self.db.x("insert into checks(line_id, check_id, ts, seen, status, value, data, by) values (?,?,?,?,?,?,?,?)",
                  line_id, check_id, ts, ts, status, value, data, by)
        return True

    def run(self, line_id: str, force: bool = False) -> bool:
        """Run the project's hard checks if what they read has changed (or when asked); True when a result changed."""
        self._line(line_id)
        with self._run_lock:
            x = Inputs(self.town, line_id)
            sig = x.sig()
            if not force and self._sig.get(line_id) == sig:
                return False
            self._sig[line_id] = sig
            cfg = self.config(line_id)
            last, ts, changed = self.latest(line_id), stamp(), False
            for h in self.hard(line_id, cfg):
                if h.id in cfg["off"]:
                    continue
                p = self.params(h, cfg)
                try:
                    value, found, note = h.run(x, p)
                except Exception as e:  # noqa: BLE001 - one broken detector must not stop the others
                    value, found, note = None, [], f"检查出错：{clip(e, 160)}"
                data = {"kind": "hard", "max": p["max"], "note": note, "findings": found[:FINDINGS_MAX], "total": len(found)}
                changed |= self.record(line_id, h.id, h.judge(value, p["max"]), value, data, "Papertown", ts, last.get(h.id))
        if changed:
            self.town.bus.publish("checks", line_id=line_id)
        return changed

    def verdict(self, agent_id: str, check_id: str, status: str, reason: str) -> dict:
        """A soft check judged by the project's lead; one that is not a pass becomes a report."""
        a = self.town.agents.get(agent_id)
        if not a or a["role"] != "lead":
            raise CheckError("软检查由项目负责人判断")
        lid = a["line_id"]
        soft = {s["id"]: s for s in self.config(lid)["soft"]}
        if check_id not in soft:
            raise CheckError(f"没有这项软检查：{check_id}（有 {'、'.join(soft) or '没有'}）")
        if status not in VERDICTS:
            raise CheckError("判断写 pass（满足）、warn（有问题）或 fail（不满足）")
        reason = str(reason or "").strip()
        if not reason:
            raise CheckError("写上理由：依据是什么，缺什么")
        s = soft[check_id]
        who = self.town.leads._who(a)
        self.record(lid, check_id, status, None, {"kind": "soft", "note": reason[:4000], "question": s["prompt"]}, who)
        with self._lock:
            cfg = self.config(lid)
            cfg["asked"].pop(check_id, None)
            self._save(lid, cfg)
        if status != "pass":
            self.town.leads.report(agent_id, f"软检查「{s['title']}」{STATUS[status]}：{reason}", key=status == "fail")
        self.town.bus.publish("checks", line_id=lid)
        return {"text": f"记下了：「{s['title']}」{STATUS[status]}。" + ("" if status == "pass" else "这条也作为汇报给了用户。")}

    # soft checks: when they are due, and asking the lead

    def due(self, line_id: str) -> list[dict]:
        """Soft checks the lead should answer now: wired on the canvas to a stage the project has reached (or to no
        stage at all), and not answered or asked lately."""
        ln = self.db.one("select status from lines where id = ?", line_id)
        if not ln or ln["status"] not in ("running", "linked"):
            return []
        snap = self.town.pipeline.snapshot(line_id)
        reached = {s["key"] for s in (snap or {}).get("stages") or [] if s["status"] in REACHED}
        cfg, last = self.config(line_id), self.latest(line_id)
        out = []
        for s in cfg["soft"]:
            wired = self.town.canvas.stages_of(line_id, s["id"])
            if s["id"] in cfg["off"] or wired and not wired & reached:
                continue
            seen = max([t for t in ((last.get(s["id"]) or {}).get("ts"), cfg["asked"].get(s["id"])) if t] or [""])
            if not seen or _hours(seen) >= float(s.get("every") or SOFT_EVERY):
                out.append(s)
        return out

    def asked(self, line_id: str, ids: list[str]) -> None:
        with self._lock:
            cfg = self.config(line_id)
            cfg["asked"].update({i: now() for i in ids})
            self._save(line_id, cfg)

    @staticmethod
    def ask_text(items: list[dict]) -> list[str]:
        return [*[f"- {s['id']}「{s['title']}」：{s['prompt']}" for s in items],
                "读完项目后，每项用 `pt check <编号> pass|warn|fail \"理由\"` 记下判断：pass 是满足，warn 是有问题但不致命，fail 是不满足；"
                "理由写依据和缺什么。不是 pass 的会自动成为一条给用户的汇报。"]

    def ask_now(self, line_id: str, check_id: str) -> dict:
        """The user wants a soft check answered now: a <check> message to the lead."""
        soft = {s["id"]: s for s in self.config(line_id)["soft"]}
        if check_id not in soft:
            raise CheckError("没有这项软检查")
        lead = self.town.leads.agent(line_id, "lead")
        if not lead:
            raise CheckError("先配一位项目负责人：软检查要它来判断")
        body = "\n".join([f'<check id="{check_id}">', "用户请你现在做这项软检查：", *self.ask_text([soft[check_id]]), "</check>"])
        self.town.agents.say(lead["id"], body, "queue", origin="papertown")
        self.asked(line_id, [check_id])
        self.town.bus.publish("checks", line_id=line_id)
        return {"ok": True}

    # edits

    def set(self, line_id: str, check_id: str, on: bool | None = None, params: dict | None = None,
            title: str | None = None, prompt: str | None = None, every: float | None = None, stage: str | None = None) -> dict:
        self._line(line_id)
        with self._lock:
            cfg = self.config(line_id)
            hard = {h.id: h for h in self.hard(line_id, cfg)}
            soft = {s["id"]: s for s in cfg["soft"]}
            if check_id not in hard and check_id not in soft:
                raise CheckError("没有这项检查")
            if on is not None:
                cfg["off"] = [i for i in cfg["off"] if i != check_id] + ([] if on else [check_id])
            if params and check_id in hard:
                h = hard[check_id]
                allowed = {k for k, *_ in h.params} | {"max"}
                vals = {k: float(v) for k, v in params.items() if k in allowed and v is not None and str(v).strip() != ""}
                if any(v < 0 for v in vals.values()):
                    raise CheckError("阈值不能是负数")
                if h.custom:
                    for r in cfg["rules"]:
                        if r["id"] == check_id and "max" in vals:
                            r["max"] = int(vals.pop("max"))
                cfg["params"][check_id] = {**(cfg["params"].get(check_id) or {}), **vals}
            if check_id in soft:
                s = soft[check_id]
                if title is not None:
                    s["title"] = clip(title, 20) or s["title"]
                if prompt is not None:
                    if not prompt.strip():
                        raise CheckError("软检查要写一个问题")
                    s["prompt"] = prompt.strip()[:2000]
                if every is not None:
                    s["every"] = max(1.0, min(24 * 30.0, float(every)))
                if stage is not None:
                    s["stage"] = _stage(stage)
            self._save(line_id, cfg)
        self._sig.pop(line_id, None)
        self.run(line_id)
        self.town.bus.publish("checks", line_id=line_id)
        return self.view(line_id)

    def add(self, line_id: str, kind: str, stage: str, title: str, text: str, prio: str = "P1", most: int = 0) -> dict:
        self.create(line_id, kind, stage, title, text, prio, most)
        return self.view(line_id)

    def create(self, line_id: str, kind: str, stage: str, title: str, text: str, prio: str = "P1", most: int = 0) -> str:
        """A check of the user's own: a question for the lead (soft) or a pattern the paper must not contain (hard)."""
        self._line(line_id)
        title, text = clip(title, 20), str(text or "").strip()
        if not title or not text:
            raise CheckError("写上名字和内容")
        with self._lock:
            cfg = self.config(line_id)
            if kind == "soft":
                n = 1 + sum(1 for s in cfg["soft"] if s["id"].startswith("ask-"))
                cid = f"ask-{n}"
                while any(s["id"] == cid for s in cfg["soft"]):
                    n += 1
                    cid = f"ask-{n}"
                cfg["soft"].append({"id": cid, "stage": _stage(stage), "title": title, "rule": "", "prompt": text[:2000], "every": SOFT_EVERY})
            elif kind == "hard":
                try:
                    re.compile(text)
                except re.error as e:
                    raise CheckError(f"规则不是合法的正则表达式：{e}") from e
                n = 1 + len(cfg["rules"])
                cid = f"rule-{n}"
                while any(r["id"] == cid for r in cfg["rules"]):
                    n += 1
                    cid = f"rule-{n}"
                cfg["rules"].append({"id": cid, "stage": _stage(stage), "title": title, "pattern": text[:500],
                                     "prio": "P0" if prio == "P0" else "P1", "max": max(0, int(most))})
            else:
                raise CheckError("检查分硬（hard）和软（soft）两种")
            self._save(line_id, cfg)
        self.run(line_id, force=True)
        self.town.bus.publish("checks", line_id=line_id)
        return cid

    def remove(self, line_id: str, check_id: str) -> dict:
        self._line(line_id)
        with self._lock:
            cfg = self.config(line_id)
            if check_id in HARD_IDS:
                raise CheckError("内置的硬检查不能删，可以关掉")
            before = len(cfg["rules"]) + len(cfg["soft"])
            cfg["rules"] = [r for r in cfg["rules"] if r["id"] != check_id]
            cfg["soft"] = [s for s in cfg["soft"] if s["id"] != check_id]
            if len(cfg["rules"]) + len(cfg["soft"]) == before:
                raise CheckError("没有这项检查")
            cfg["off"] = [i for i in cfg["off"] if i != check_id]
            self._save(line_id, cfg)
        self.db.x("delete from checks where line_id = ? and check_id = ?", line_id, check_id)
        self.town.bus.publish("checks", line_id=line_id)
        return self.view(line_id)

    # views

    def view(self, line_id: str) -> dict:
        """The project's checks: the stages, each check with its last result and history, and the trend."""
        ln = self._line(line_id)
        snap = self.town.pipeline.snapshot(line_id) or {}
        cfg, last = self.config(line_id), self.latest(line_id)
        lead = self.town.leads.agent(line_id, "lead")
        due = {s["id"] for s in self.due(line_id)} if lead else set()
        hist: dict[str, list[dict]] = {}
        for r in self.db.q("select check_id, ts, status, value from checks where line_id = ? order by id desc limit 2000", line_id):
            if len(hist.setdefault(r["check_id"], [])) < HISTORY_MAX:
                hist[r["check_id"]].append({"ts": r["ts"], "status": r["status"], "value": r["value"]})
        out = []
        for h in self.hard(line_id, cfg):
            p = self.params(h, cfg)
            out.append({"id": h.id, "kind": "hard", "stage": h.stage, "title": h.title, "prio": h.prio, "rule": h.rule, "text": h.text,
                        "unit": h.unit, "max": p["max"], "params": [{"key": k, "value": p[k], "label": what} for k, _, what in h.params],
                        "custom": h.custom, "on": h.id not in cfg["off"], "last": self._last(last.get(h.id)),
                        "history": hist.get(h.id, [])[::-1]})
        for s in cfg["soft"]:
            out.append({"id": s["id"], "kind": "soft", "stage": s.get("stage") or "", "title": s["title"], "prio": "", "rule": s.get("rule") or "",
                        "text": s["prompt"], "every": s.get("every") or SOFT_EVERY, "custom": s["id"].startswith("ask-"),
                        "on": s["id"] not in cfg["off"], "last": self._last(last.get(s["id"])), "asked": cfg["asked"].get(s["id"]),
                        "due": s["id"] in due, "history": hist.get(s["id"], [])[::-1]})
        hard_rows = self.db.q("select check_id, ts, status from checks where line_id = ? and json_extract(data, '$.kind') = 'hard' order by id", line_id)
        return {"line_id": line_id, "seq": ln["seq"],
                "stages": [{"key": s["key"], "name": s["name"], "status": s["status"], "pct": s["pct"]} for s in snap.get("stages") or []],
                "checks": out, "summary": self.summary(line_id, out), "trend": self._trend(hard_rows, {c["id"] for c in out if c["kind"] == "hard" and c["on"]}),
                "rounds": len({r["ts"] for r in hard_rows}), "lead": bool(lead),
                "paper": bool(self.town.workspace.find(line_id, "paper")),
                "ran": max((r["seen"] for r in last.values() if r["seen"] and (r["data"] or {}).get("kind") == "hard"), default=None)}

    @staticmethod
    def _last(r: dict | None) -> dict | None:
        if not r:
            return None
        d = r["data"] or {}
        return {"status": r["status"], "value": r["value"], "ts": r["ts"], "seen": r["seen"], "by": r["by"], "note": d.get("note") or "",
                "findings": d.get("findings") or [], "total": d.get("total", len(d.get("findings") or []))}

    def summary(self, line_id: str, checks: list[dict] | None = None) -> dict:
        """How many checks of each kind pass, for the 进展 card and the lead."""
        if checks is None:
            cfg, last = self.config(line_id), self.latest(line_id)
            checks = [{"kind": "hard", "on": h.id not in cfg["off"], "last": last.get(h.id)} for h in self.hard(line_id, cfg)] + \
                     [{"kind": "soft", "on": s["id"] not in cfg["off"], "last": last.get(s["id"])} for s in cfg["soft"]]
        out = {k: {"pass": 0, "warn": 0, "fail": 0, "none": 0, "wait": 0, "total": 0} for k in ("hard", "soft")}
        for c in checks:
            if not c["on"]:
                continue
            st = (c["last"] or {}).get("status") or ("wait" if c["kind"] == "soft" else "none")
            out[c["kind"]][st] += 1
            out[c["kind"]]["total"] += 1
        return out

    @staticmethod
    def _trend(rows: list[dict], on: set[str]) -> list[dict]:
        """How many hard checks passed after each round that changed something."""
        state: dict[str, str] = {}
        out: list[dict] = []
        for r in rows:
            state[r["check_id"]] = r["status"]
            vals = [v for k, v in state.items() if k in on]
            point = {"ts": r["ts"], "pass": sum(1 for v in vals if v == "pass"), "fail": sum(1 for v in vals if v in ("fail", "warn")),
                     "total": sum(1 for v in vals if v != "none")}
            if out and out[-1]["ts"] == r["ts"]:
                out[-1] = point
            else:
                out.append(point)
        return out[-TREND_MAX:]

    def brief(self, line_id: str) -> str:
        """The checks in one line, for the lead's view of the project."""
        s = self.summary(line_id)
        h, f = s["hard"], s["soft"]
        last = self.latest(line_id)
        names = {h.id: h.title for h in self.hard(line_id)} | {x["id"]: x["title"] for x in self.config(line_id)["soft"]}
        bad = [names[k] + ("" if r["value"] is None else f" {int(r['value'])}") for k, r in last.items()
               if r["status"] in ("fail", "warn") and k in names]
        return (f"硬检查 {h['pass']}/{h['total'] - h['none']} 通过，软检查 {f['pass']}/{f['total']} 通过"
                + (f"；没过或有问题：{'、'.join(bad)}" if bad else "") + "（`pt checks` 看详情）")

    def text(self, line_id: str) -> str:
        """The checks as text, for `pt checks`: hard ones with where they fail, soft ones with the lead's last word."""
        v = self.view(line_id)
        mark = {"pass": "✓", "warn": "!", "fail": "✗", "none": "·", "wait": "?"}
        s = v["summary"]
        out = [f"#{v['seq']} 的检查：硬检查 {s['hard']['pass']}/{s['hard']['total'] - s['hard']['none']} 通过，"
               f"软检查 {s['soft']['pass']}/{s['soft']['total']} 通过", "",
               "硬检查（Papertown 用代码查，要满足；改完论文用 `pt checks run` 再跑一遍）："]
        for c in v["checks"]:
            if c["kind"] != "hard" or not c["on"]:
                continue
            last = c["last"] or {}
            st = last.get("status") or "none"
            val = last.get("value")
            out.append(f"- {mark[st]} {c['id']}「{c['title']}」[{c['prio']}，{c['rule']}]："
                       + (STATUS[st] if val is None else f"{int(val)} {c['unit']}（最多 {int(c['max'])}）") + (f"；{last['note']}" if last.get("note") else ""))
            if st in ("fail", "warn"):
                for f in last.get("findings", [])[:12]:
                    where = f"{f['file']}:{f['line']} " if f.get("file") else ""
                    out.append(f"    {where}「{clip(f['text'], 120)}」→ {f['hint']}")
                if last.get("total", 0) > 12:
                    out.append(f"    …还有 {last['total'] - 12} 处")
        out += ["", "软检查（负责人读项目判断）："]
        for c in v["checks"]:
            if c["kind"] != "soft" or not c["on"]:
                continue
            last = c["last"]
            out.append(f"- {mark[last['status'] if last else 'wait']} {c['id']}「{c['title']}」：" + (
                f"{STATUS[last['status']]}（{_ago(last['ts'])}，{last['by']}）：{clip(last['note'], 240)}" if last else "还没判断")
                + ("，到期了" if c["due"] else ""))
            out.append(f"    问题：{c['text']}")
        return "\n".join(out)

    # the loop: hard checks run again whenever what they read changes

    def start(self) -> None:
        if self._thread:
            return
        self._halt.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="checks")
        self._thread.start()

    def stop(self) -> None:
        self._halt.set()
        self._thread = None

    def _loop(self) -> None:
        while True:
            for r in self.db.q("select id from lines where status not in ('dropped')"):
                if self._halt.is_set():
                    return
                try:
                    self.run(r["id"])
                except Exception:  # noqa: BLE001 - one project's trouble must not stop the others
                    continue
            if self._halt.wait(self.s.check_tick):
                return


def stamp() -> str:
    """Now, to the millisecond: the rows of one run share it, and two runs in the same second do not."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _stage(key: str) -> str:
    """A stage a check is first placed by; none is fine, the canvas says what it is wired to."""
    if not key:
        return ""
    if key not in INDEX:
        raise CheckError(f"没有这道工序：{key}")
    return key


def _hours(iso: str) -> float:
    try:
        return (datetime.now().astimezone() - datetime.fromisoformat(iso)).total_seconds() / 3600
    except (TypeError, ValueError):
        return 1e9


def _ago(iso: str | None) -> str:
    h = _hours(iso or "")
    return "刚刚" if h < 1 / 60 else f"{int(h * 60)} 分钟前" if h < 1 else f"{int(h)} 小时前" if h < 24 else f"{int(h / 24)} 天前"

