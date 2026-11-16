"""Questions about a project, answered from what it holds (card, reports, stages, jobs, code and
paper files, imported memory). BM25 over pieces of all of it finds what is relevant; a model
answers citing the pieces as [n], offline the best sentences in them are quoted, or the lead
answers with `pt reply`, in a few words or as a page.

    data/projects/<project>/questions.json
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import threading
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from .agents import AgentError
from .db import now, read_json, write_json
from .library import GLOSSARY, STOP, stem
from .linked import plain
from .pages import PageError, title_of
from .llm import ProviderError, Turn
from .workspace import WsError, _text, list_files

if TYPE_CHECKING:
    from .town import Town

KINDS = {"card": "进展卡片", "report": "负责人的汇报", "line": "项目", "job": "实验", "code": "代码", "paper": "论文",
         "session": "以前的对话", "note": "记忆"}
WEIGHT = {"card": 1.35, "report": 1.2, "note": 1.25, "line": 1.1, "job": 1.15, "session": 1.0, "code": 1.0, "paper": 1.05}
TEXT_EXT = {".py", ".sh", ".bash", ".zsh", ".md", ".txt", ".rst", ".yaml", ".yml", ".toml", ".cfg", ".ini", ".json", ".js", ".ts",
            ".tsx", ".jsx", ".c", ".cc", ".cpp", ".h", ".hpp", ".cu", ".rs", ".go", ".java", ".lua", ".r", ".jl", ".m", ".tex", ".bib",
            ".sty", ".cls", ".mk", ".cmake"}
TEXT_NAMES = {"Makefile", "Dockerfile", "README", "LICENSE"}
FILE_MAX, JSON_MAX, FILES_MAX, REPO_CHARS = 300_000, 60_000, 2500, 30_000_000
LINES, PIECE = 40, 1400  # lines in a code window; characters in a prose piece
K1, B = 1.2, 0.75
QSTOP = {"什么", "怎么", "现在", "这个", "那个", "一个", "哪些", "哪个", "是不", "不是", "有没", "没有", "可以", "我们", "你们", "目前",
         "如何", "为什", "为何", "多少", "是否", "一下", "情况", "怎样", "了吗", "的是", "项目"}
TRADE = {"实验": "experiment exp run", "训练": "train training", "结果": "result results", "数据": "data", "模型": "model",
         "损失": "loss", "准确率": "accuracy acc", "精度": "accuracy precision", "论文": "paper", "代码": "code", "配置": "config",
         "超参": "hyperparameter lr batch", "学习率": "lr learning rate", "显存": "memory vram gpu", "评测": "eval evaluation",
         "基线": "baseline", "消融": "ablation", "图": "figure fig", "表": "table", "引用": "cite citation", "日志": "log",
         "脚本": "script", "部署": "deploy", "推理": "inference", "提交": "commit submit", "摘要": "abstract", "方法": "method"}
_TERMS = sorted({**GLOSSARY, **TRADE}, key=len, reverse=True)
WORD = re.compile(r"[A-Za-z][A-Za-z0-9]*|\d+(?:\.\d+)?|[㐀-鿿]+")
KEEP = 60  # questions kept per project

SYSTEM = """你在回答用户关于自己一个科研项目的问题。只根据下面给出的材料回答：材料里没有的，就直说不知道，并说可以去哪里看或去问谁。
引用材料时在那句话末尾写上它的编号，如 [2]；不要编造编号。用中文，先给结论，再给依据，简洁。"""


class AskError(Exception):
    pass


def terms(text: str) -> list[str]:
    out = []
    for w in WORD.findall(text):
        if "㐀" <= w[0] <= "鿿":
            out += [w[i:i + 2] for i in range(len(w) - 1)] if len(w) > 1 else [w]
            continue
        lw = w.lower()
        if lw in STOP or (len(lw) < 2 and not lw.isdigit()):
            continue
        out.append(stem(lw))
        parts = re.findall(r"[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+", w)
        if len(parts) > 1:
            out += [stem(p.lower()) for p in parts if len(p) > 1 and p.lower() not in STOP]
    return out


def query_terms(q: str) -> dict[str, float]:
    """A question's terms with weights: its own words, then English for its Chinese ones."""
    w: dict[str, float] = {}
    for t in terms(q):
        if t not in QSTOP:
            w[t] = 1.0
    rest = q
    for k in _TERMS:
        if k in rest:
            for t in terms(GLOSSARY.get(k) or TRADE[k]):
                w.setdefault(t, 0.6)
            rest = rest.replace(k, " ")
    return w


@dataclass
class Doc:
    kind: str
    title: str
    text: str
    where: str = ""
    ref: dict = field(default_factory=dict)


class Source:
    """Pieces of one kind of thing, counted for BM25."""

    def __init__(self, docs: list[Doc]):
        self.docs = docs
        self.tfs = [Counter(terms(f"{d.title}\n{d.text}")) for d in docs]
        self.lens = [sum(c.values()) for c in self.tfs]
        self.post: dict[str, list[int]] = {}
        for i, c in enumerate(self.tfs):
            for t in c:
                self.post.setdefault(t, []).append(i)


def search(sources: list[Source], q: str, k: int = 8) -> list[tuple[Doc, float, list[str]]]:
    """The k best pieces by BM25, at most two from one file or conversation and no text twice."""
    qt = query_terms(q)
    if not qt:
        return []
    n = sum(len(s.docs) for s in sources) or 1
    avg = (sum(sum(s.lens) for s in sources) / n) or 1
    df = {t: sum(len(s.post.get(t, ())) for s in sources) for t in qt}
    idf = {t: math.log(1 + (n - df[t] + 0.5) / (df[t] + 0.5)) for t in qt if df[t]}
    phrase = re.sub(r"\s+", "", q.lower())
    out = []
    for s in sources:
        cand = {i for t in idf for i in s.post.get(t, ())}
        for i in cand:
            tf, dl = s.tfs[i], s.lens[i]
            hit = [t for t in idf if tf.get(t)]
            score = sum(qt[t] * idf[t] * tf[t] * (K1 + 1) / (tf[t] + K1 * (1 - B + B * dl / avg)) for t in hit)
            score *= WEIGHT.get(s.docs[i].kind, 1.0) * (1 + 0.15 * (len(hit) - 1))
            if len(phrase) >= 4 and phrase in re.sub(r"\s+", "", s.docs[i].text.lower()):
                score *= 1.4
            out.append((s.docs[i], score, hit))
    out.sort(key=lambda x: -x[1])
    seen: Counter = Counter()
    said: set[str] = set()
    picked = []
    for d, sc, hit in out:
        key = (d.kind, d.ref.get("file", "").rsplit(":", 1)[0], d.ref.get("memory"))
        same = hashlib.sha1(d.text.encode()).hexdigest()
        if seen[key] >= 2 or same in said:
            continue
        said.add(same)
        seen[key] += 1
        picked.append((d, sc, hit))
        if len(picked) >= k:
            break
    return picked


def snippet(text: str, hit: list[str], n: int = 260) -> str:
    """The part of a piece around the first of the question's words in it."""
    low = text.lower()
    at = min((p for p in (low.find(t) for t in hit) if p >= 0), default=0)
    start = max(0, at - n // 3)
    s = text[start:start + n].strip()
    return ("…" if start else "") + re.sub(r"[ \t]+", " ", s) + ("…" if start + n < len(text) else "")


def best_sentences(text: str, hit: list[str], n: int = 2) -> str:
    """The sentences (or lines) of a piece that hold most of the question's words, in order."""
    parts = [p.strip() for p in re.split(r"(?<=[。！？.!?])\s+|\n+", text) if len(p.strip()) > 6]
    if not parts:
        return text[:200]
    scored = sorted(range(len(parts)), key=lambda i: -sum(parts[i].lower().count(t) for t in hit))[:n]
    return " … ".join(parts[i][:240] for i in sorted(scored))


def _words(v, depth: int = 0) -> list[str]:
    """What a stage handed on (a JSON body), as its sentences: the text in it, not its brackets and keys."""
    if isinstance(v, str):
        t = v.strip()
        return [t] if len(t) > 3 and not re.match(r"^(https?://|arxiv:|[\w-]+_\d+$)", t) else []
    if depth > 6:
        return []
    if isinstance(v, dict):
        return [w for k, x in v.items() if k not in ("id", "url", "paper_id", "arxiv_id", "tags", "matched") for w in _words(x, depth + 1)]
    if isinstance(v, list):
        return [w for x in v for w in _words(x, depth + 1)]
    return []


def _windows(rel: str, text: str, kind: str) -> list[Doc]:
    lines = text.splitlines()
    out = []
    for i in range(0, len(lines), LINES):
        part = "\n".join(lines[i:i + LINES]).strip()
        if part:
            out.append(Doc(kind, rel, part, f"{rel}:{i + 1}", {"file": f"{kind}:{rel}:{i + 1}"}))
    return out


def _paragraphs(rel: str, text: str, kind: str) -> list[Doc]:
    """Paragraphs grouped up to a piece's length, each starting at its line."""
    out, buf, start, n = [], [], 1, 0
    for i, ln in enumerate(text.splitlines(), 1):
        if not buf:
            start = i
        buf.append(ln)
        n += len(ln)
        if (not ln.strip() and n >= PIECE // 2) or n >= PIECE:
            part = "\n".join(buf).strip()
            if part:
                out.append(Doc(kind, rel, part, f"{rel}:{start}", {"file": f"{kind}:{rel}:{start}"}))
            buf, n = [], 0
    part = "\n".join(buf).strip()
    if part:
        out.append(Doc(kind, rel, part, f"{rel}:{start}", {"file": f"{kind}:{rel}:{start}"}))
    return out


def repo_files(root: Path) -> list[tuple[str, Path, int, float]]:
    out = []
    for f in list_files(root)["files"]:
        p = root / f["path"]
        if p.suffix.lower() not in TEXT_EXT and p.name not in TEXT_NAMES:
            continue
        if f["size"] > (JSON_MAX if p.suffix == ".json" else FILE_MAX) or f["size"] == 0:
            continue
        try:
            out.append((f["path"], p, f["size"], p.stat().st_mtime))
        except OSError:
            continue
        if len(out) >= FILES_MAX:
            break
    return out


def repo_docs(kind: str, files: list[tuple[str, Path, int, float]]) -> list[Doc]:
    docs, total = [], 0
    for rel, p, size, _ in files:
        if total > REPO_CHARS:
            break
        try:
            text = _text(p)
        except OSError:
            text = None
        if not text:
            continue
        if p.suffix == ".tex" and "\\begin{document}" in text:  # the preamble's lines stay, empty, so cited line numbers hold
            head, _, body = text.partition("\\begin{document}")
            text = "\n" * head.count("\n") + body
        total += len(text)
        prose = p.suffix in (".md", ".tex", ".txt", ".rst", ".bib") or kind == "paper"
        pieces = _paragraphs(rel, text, kind) if prose else _windows(rel, text, kind)
        if p.suffix == ".tex":
            pieces = [Doc(d.kind, d.title, t, d.where, d.ref) for d in pieces if (t := plain(d.text))]
        docs += pieces
    return docs


def memory_docs(items) -> list[Doc]:
    docs = []
    for m in items:
        label = f"{m.get('source', '')} · {m['title']}"
        if m["kind"] == "note":
            for d in _paragraphs(m["title"], m.get("text") or "", "note"):
                docs.append(Doc("note", label, d.text, m["title"], {"memory": m["id"]}))
            continue
        msgs = m.get("messages") or []
        i = 0
        while i < len(msgs):
            turn = [msgs[i]]
            if msgs[i]["role"] == "user" and i + 1 < len(msgs) and msgs[i + 1]["role"] == "assistant":
                turn.append(msgs[i + 1])
            text = "\n\n".join(("问：" if x["role"] == "user" else "答：") + x["text"] for x in turn)
            for j in range(0, max(1, len(text)), PIECE * 2):
                docs.append(Doc("session", label, text[j:j + PIECE * 2], (m.get("ended") or "")[:10], {"memory": m["id"], "msg": i}))
            i += len(turn)
    return docs


class Asker:
    def __init__(self, town: "Town"):
        self.town = town
        self.s = town.s
        self._lock = threading.Lock()
        self._roots: dict[tuple[str, str], tuple[str, Source]] = {}
        self._mem: dict[str, tuple[float, Source]] = {}

    def _root(self, line_id: str, which: str) -> Source | None:
        try:
            root = self.town.workspace.root(line_id, which)
        except (OSError, WsError):
            root = None
        if not root:
            return None
        files = repo_files(root)
        sig = hashlib.sha1(json.dumps([(r, s, m) for r, _, s, m in files]).encode()).hexdigest()
        hit = self._roots.get((line_id, which))
        if hit and hit[0] == sig:
            return hit[1]
        src = Source(repo_docs(which, files))
        self._roots[(line_id, which)] = (sig, src)
        return src

    def _memory(self, line_id: str) -> Source | None:
        p = self.s.projects_dir / line_id / "memory" / "index.json"
        if not p.exists():
            return None
        mt = p.stat().st_mtime
        hit = self._mem.get(line_id)
        if hit and hit[0] == mt:
            return hit[1]
        src = Source(memory_docs(self.town.history.all(line_id)))
        self._mem[line_id] = (mt, src)
        return src

    def _live(self, line_id: str) -> Source:
        """What changes all the time and is small: the card, the project, its reports, its jobs."""
        docs: list[Doc] = []
        card, line = self.town.cards._read(line_id).get("card"), self.town.pipeline.snapshot(line_id)
        if card:
            parts = [card["summary"], f"下一个里程碑：{card.get('milestone') or ''}"]
            for k, name in (("need_you", "要你决定"), ("blockers", "卡点"), ("next", "接下来"), ("done", "最近完成")):
                parts += [f"{name}：{x}" for x in card.get(k) or []]
            parts += [f"{m['name']}：{m['value']} {m.get('note') or ''}" for m in card.get("metrics") or []]
            parts += [f"规划中的实验：{x['name']}（{x.get('goal') or ''}，{x.get('when') or ''}）" for x in card.get("plans") or []]
            parts += [f"预期产出：{x['name']}（{x.get('due') or ''}，{x.get('state')}）" for x in card.get("outputs") or []]
            docs.append(Doc("card", "进展卡片", "\n".join(parts), (card.get("at") or "")[:16].replace("T", " "), {"card": True}))
        docs.append(Doc("line", line["title"] or "", f"{line['title']}\n{line['idea'] or ''}\n{line['note'] or ''}",
                        f"#{line['seq']}", {"mod": "overview"}))
        for st in line["stages"]:
            if st["note"]:
                docs.append(Doc("line", f"工序 · {st['name']}", st["note"], st["name"], {"mod": "overview"}))
        names = {st["key"]: st["name"] for st in line["stages"]}
        for r in self.town.db.q("select stage, body from items where line_id = ? order by created_at desc", line_id):
            name = names.get(r["stage"], r["stage"])
            docs.append(Doc("line", f"{name}的产出", "\n".join(_words(r["body"]))[:6000], name, {"mod": "overview"}))
        for r in self.town.leads.reports(line_id, 200):
            d = r["data"] or {}
            text = d.get("text") or d.get("question") or ""
            if d.get("answer"):
                text += f"\n回答：{d['answer']}"
            docs.append(Doc("report", "负责人的汇报" if r["kind"] == "report" else f"{d.get('who') or ''}的提问", text, r["ts"][:16].replace("T", " "),
                            {"report": r["id"]}))
        for j in self.town.leads._jobs(line_id)[:80]:
            res = j.get("result")
            text = "\n".join(str(x) for x in [j.get("name"), j.get("status"), j.get("note"), j.get("command"), j.get("cwd"),
                                                json.dumps(res, ensure_ascii=False)[:2000] if res else ""] if x)
            docs.append(Doc("job", j.get("name") or j["id"], text, j["id"], {"job": j["id"]}))
        return Source(docs)

    def sources(self, line_id: str) -> list[Source]:
        if not self.town.db.one("select 1 from lines where id = ?", line_id):
            raise AskError("没有这个项目")
        with self._lock:
            out = [self._live(line_id), self._root(line_id, "code"), self._root(line_id, "paper"), self._memory(line_id)]
        return [s for s in out if s]

    def search(self, line_id: str, q: str, k: int = 8) -> list[dict]:
        q = q.strip()
        if not q:
            raise AskError("问点什么")
        return [{"n": i + 1, "kind": d.kind, "title": d.title, "where": d.where, "ref": d.ref, "score": round(sc, 3),
                 "snippet": snippet(d.text, hit), "terms": hit, "_text": d.text}
                for i, (d, sc, hit) in enumerate(search(self.sources(line_id), q, k))]

    def _path(self, line_id: str) -> Path:
        return self.s.projects_dir / line_id / "questions.json"

    def questions(self, line_id: str) -> list[dict]:
        return read_json(self._path(line_id), [])

    def _save(self, line_id: str, rows: list[dict]) -> None:
        p = self._path(line_id)
        p.parent.mkdir(parents=True, exist_ok=True)
        write_json(p, rows[-KEEP:])

    def _put(self, line_id: str, rec: dict) -> dict:
        with self._lock:
            rows = [r for r in self.questions(line_id) if r["id"] != rec["id"]] + [rec]
            rows.sort(key=lambda r: r["n"])
            self._save(line_id, rows)
        self.town.bus.publish("question", line_id=line_id, question=rec)
        return rec

    def ask(self, line_id: str, q: str, to_lead: bool = False) -> dict:
        q = " ".join(q.split())[:1000]
        hits = self.search(line_id, q, 8)
        n = max((r["n"] for r in self.questions(line_id)), default=0) + 1
        rec = {"id": f"q{n}", "n": n, "q": q, "at": now(), "hits": [{k: v for k, v in h.items() if k != "_text"} for h in hits],
               "answer": None, "by": None, "status": "done", "lead": None}
        if to_lead:
            lead = self.town.cards._lead(line_id)
            if not lead:
                raise AskError("这个项目还没有负责人：先在卡片上给它配一个")
            try:
                self.town.agents.say(lead["id"], self._lead_message(rec, hits), "queue", origin="papertown")
            except AgentError as e:
                raise AskError(str(e)) from e
            rec |= {"status": "waiting", "lead": {"id": lead["id"], "asked": now()}}
        rec["answer"], rec["by"] = self._answer(line_id, q, hits)
        self.town.trace("问答", f"#{self.town.db.val('select seq from lines where id = ?', line_id)} {q[:40]}",
                        f"找到 {len(hits)} 处" + ("，也问了负责人" if to_lead else ""), 0, line_id=line_id)
        return self._put(line_id, rec)

    def _answer(self, line_id: str, q: str, hits: list[dict]) -> tuple[str | None, str | None]:
        """The answer and who gave it: a model's name, or 摘录 (offline: the sentences found, as they are)."""
        if not hits:
            return None, None
        if not self.s.offline:
            model = self.s.model_strong
            mats = "\n\n".join(f"[{h['n']}] {KINDS[h['kind']]} · {h['title']} {h['where']}\n{h['_text'][:2400]}" for h in hits)
            try:
                t0 = time.monotonic()
                r = self.town.provider.complete(model=model, system=SYSTEM, turns=[Turn("user", text=f"问题：{q}\n\n材料：\n\n{mats}")], tools=[],
                                                max_tokens=1500)
                c = self.town.bank.charge(None, line_id, self.town.provider.name, model, r.usage)
                self.town.trace("LLM", model, f"问答 · ${c:.4f}", int((time.monotonic() - t0) * 1000), line_id=line_id)
                if t := r.text.strip():
                    return t, model
            except ProviderError as e:
                self.town.trace("LLM", model, f"问答没答出来，改用摘录：{e}", 0, line_id=line_id)
        lines, seen = [], set()
        for h in hits:
            t = best_sentences(h["_text"], h["terms"])
            if t not in seen:
                seen.add(t)
                lines.append(f"- {t} [{h['n']}]")
            if len(lines) == 4:
                break
        return "\n".join(lines), "摘录"

    def _lead_message(self, rec: dict, hits: list[dict]) -> str:
        found = [f"[{h['n']}] {KINDS[h['kind']]} · {h['title']} {h['where']}" for h in hits[:6]]
        return "\n".join(["<question>", f"用户在「进展」页问了这个项目一个问题（{rec['id']}），请你回答：", "", rec["q"], "",
                          *(["Papertown 先检索了一遍，这些地方可能有关（自己核实，不要只靠它们）：", *found, ""] if found else []),
                          f"读完项目后把回答写成一页 HTML，用 `pt reply {rec['id']} 回答.html` 交上来：用户在网页上看，先写结论，再从上往下紧凑地写依据"
                          f"（怎么写见你说明里的「写给用户看的页面」）。一两句话就能答完的，用 `pt reply {rec['id']} \"你的回答\"`。"
                          "只回答这个问题：不派活、不写汇报、不动卡片。", "</question>"])

    def reply(self, agent_id: str, qid: str, text: str, html: str | None = None) -> dict:
        """The lead's answer to a question it was given: a few words, or a page (with a line about it)."""
        a = self.town.agents.get(agent_id)
        if not a or a["role"] != "lead":
            raise AskError("只有项目负责人回答项目的问题")
        rec = next((r for r in self.questions(a["line_id"]) if r["id"] == qid), None)
        if not rec:
            raise AskError(f"没有问题 {qid}")
        text, html = text.strip(), (html or "").strip()
        if not text and not html:
            raise AskError("回答是空的")
        by = a.get("model") or "项目负责人"
        rec["lead"] = (rec.get("lead") or {}) | {"text": text[:12000], "at": now(), "by": by}
        if html:
            try:
                page = self.town.pages.publish(a["line_id"], html, title=title_of(html) or f"回答：{rec['q'][:60]}", kind="answer", by=by,
                                               agent=agent_id, question=qid)
            except PageError as e:
                raise AskError(str(e)) from e
            rec["lead"] |= {"page": page["id"], "title": page["title"]}
        rec["status"] = "done"
        return self._put(a["line_id"], rec)

    def remove(self, line_id: str, qid: str) -> dict:
        with self._lock:
            rows = self.questions(line_id)
            if not any(r["id"] == qid for r in rows):
                raise AskError(f"没有问题 {qid}")
            self._save(line_id, [r for r in rows if r["id"] != qid])
        return {"ok": True}

    def recall(self, line_id: str, q: str) -> str:
        """What `pt recall` prints: the pieces found, for an agent of the project."""
        hits = self.search(line_id, q, 8)
        if not hits:
            return "没找到相关的内容。"
        return "\n\n".join(f"[{h['n']}] {KINDS[h['kind']]} · {h['title']} {h['where']}\n{h['_text'][:900]}" for h in hits)
