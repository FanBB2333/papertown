"""Projects of your own, linked in from local repositories (the code in one, the LaTeX paper in
another), listed in `projects.json` in the data directory (PAPERTOWN_PROJECTS to point elsewhere):

    {"projects": [{"key": "my-proj", "code": "~/repos/my-code", "paper": "~/repos/overleaf/my-paper",
                   "match": ["my-code", "my-proj"]}]}

`match` picks the project's experiments out of nvidb's queue (by working directory, job name or
submitter; by default the code repo's folder name and the key). The repositories are only read:
git runs with --no-optional-locks and Papertown writes nothing into them.
"""

from __future__ import annotations

import json
import re
import subprocess
import threading
import time
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import quote_plus

from .db import now
from .nvidb import as_farm_job

if TYPE_CHECKING:
    from .town import Town

TTL = 30  # seconds a repository summary is reused


def _home(p: str | Path) -> str:
    s = str(p)
    h = str(Path.home())
    return "~" + s[len(h):] if s.startswith(h) else s


def _git(repo: Path, *args: str, timeout: float = 10) -> str:
    try:
        r = subprocess.run(["git", "--no-optional-locks", "-C", str(repo), *args], capture_output=True, text=True, timeout=timeout)
        return r.stdout if r.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


def _commits(repo: Path, n: int) -> list[dict]:
    out = []
    for line in _git(repo, "log", f"-{n}", "--format=%h%x09%cI%x09%an%x09%s").splitlines():
        h, when, who, subject = (line.split("\t", 3) + ["", "", "", ""])[:4]
        out.append({"hash": h, "when": when, "author": who, "subject": subject})
    return out


def _braced(s: str, i: int) -> tuple[str, int]:
    """The {...} group starting at s[i] == '{'."""
    depth, j = 0, i
    while j < len(s):
        if s[j] == "{" and (j == 0 or s[j - 1] != "\\"):
            depth += 1
        elif s[j] == "}" and s[j - 1] != "\\":
            depth -= 1
            if depth == 0:
                return s[i + 1:j], j + 1
        j += 1
    return s[i + 1:], len(s)


def _arg(s: str, cmd: str) -> str | None:
    m = re.search(r"\\" + cmd + r"\*?\s*(\[[^\]]*\])?\s*\{", s)
    return _braced(s, m.end() - 1)[0] if m else None


def plain(tex: str) -> str:
    """LaTeX to readable text: commands dropped, their text kept."""
    t = re.sub(r"(?<!\\)%.*", "", tex)
    t = re.sub(r"\\(cite|citep|citet|ref|eqref|label|autoref|cref|Cref)\*?\{[^}]*\}", "", t)
    t = re.sub(r"\\footnote\{[^}]*\}", "", t)
    t = re.sub(r"\\\\|\\newline", " ", t)
    t = re.sub(r"\\[a-zA-Z@]+\*?(\[[^\]]*\])?", "", t)
    t = t.replace("~", " ").replace("{", "").replace("}", "").replace("$", "")
    t = re.sub(r"\\(.)", r"\1", t)
    return re.sub(r"\s+", " ", t).strip()


def _strip_comments(s: str) -> str:
    return "\n".join(re.sub(r"(?<!\\)%.*", "", ln) for ln in s.splitlines())


def _main_tex(repo: Path) -> Path | None:
    """The .tex with \\documentclass: the one with a compiled PDF next to it, else main.tex, else the largest."""
    cands = [p for p in repo.glob("*.tex") if "\\documentclass" in p.read_text(encoding="utf-8", errors="ignore")]
    if not cands:
        return None
    cands.sort(key=lambda p: (not p.with_suffix(".pdf").exists(), p.stem != "main", -p.stat().st_size))
    return cands[0]


def _expand(repo: Path, f: Path, depth: int = 0, seen: set | None = None) -> str:
    """A file's text with its \\input and \\include pulled in, in order."""
    seen = seen if seen is not None else set()
    if depth > 4 or f in seen or not f.exists():
        return ""
    seen.add(f)
    s = _strip_comments(f.read_text(encoding="utf-8", errors="ignore"))

    def sub(m: re.Match) -> str:
        name = m.group(2).strip()
        p = (repo / name) if (repo / name).suffix else (repo / f"{name}.tex")
        return _expand(repo, p, depth + 1, seen)

    return re.sub(r"\\(input|include)\{([^}]+)\}", sub, s)


def _bib_entries(repo: Path) -> list[dict]:
    out = []
    for bib in sorted(repo.glob("**/*.bib")):
        if any(part.startswith(".") for part in bib.relative_to(repo).parts):
            continue
        text = bib.read_text(encoding="utf-8", errors="ignore")
        for m in re.finditer(r"@(\w+)\s*\{\s*([^,\s]+)\s*,", text):
            kind = m.group(1).lower()
            if kind in ("string", "comment", "preamble"):
                continue
            body = text[m.end():]
            nxt = re.search(r"\n\s*@\w+\s*\{", body)
            body = body[:nxt.start()] if nxt else body

            def field(name: str) -> str:
                f = re.search(r"\b" + name + r"\s*=\s*", body, re.I)
                if not f:
                    return ""
                rest = body[f.end():]
                if rest.startswith("{"):
                    return _braced(rest, 0)[0]
                q = re.match(r'"([^"]*)"', rest) or re.match(r"([^,\n]+)", rest)
                return q.group(1) if q else ""

            out.append({"key": m.group(2), "kind": kind, "title": plain(field("title")), "author": plain(field("author")),
                        "year": plain(field("year")), "venue": plain(field("booktitle") or field("journal")),
                        "eprint": field("eprint").strip(), "url": field("url").strip(), "doi": field("doi").strip()})
    return out


class Linked:
    def __init__(self, town: "Town"):
        self.town = town
        self.db = town.db
        self.path = town.s.projects_file
        self._cache: dict[str, tuple[float, dict]] = {}
        self._lock = threading.Lock()

    def config(self) -> list[dict]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        out = []
        for p in raw.get("projects") or []:
            code = Path(p["code"]).expanduser() if p.get("code") else None
            paper = Path(p["paper"]).expanduser() if p.get("paper") else None
            key = p.get("key") or (code or paper).name.lower()
            match = p.get("match") or [x for x in [code.name if code else None, key] if x]
            out.append({"key": key, "code": str(code) if code else None, "paper": str(paper) if paper else None,
                        "match": match, "title": p.get("title"), "idea": p.get("idea")})
        return out

    def of(self, line_id: str) -> dict | None:
        ln = self.db.one("select linked from lines where id = ?", line_id)
        return ln["linked"] if ln and isinstance(ln["linked"], dict) else None

    def lines(self) -> list[dict]:
        return [r for r in self.db.q("select id, linked from lines where linked is not null") if isinstance(r["linked"], dict)]

    def sync(self) -> list[str]:
        """Make sure every project in the list has its line; keep their paths up to date."""
        have = {r["linked"].get("key"): r["id"] for r in self.lines()}
        added = []
        for p in self.config():
            if p["key"] in have:
                self.db.update("lines", {"id": have[p["key"]]}, linked=p, updated_at=now())
                continue
            added.append(self._create(p))
        return added

    def _create(self, p: dict) -> str:
        from .pipeline import STAGES
        code, paper = (Path(p["code"]) if p["code"] else None), (Path(p["paper"]) if p["paper"] else None)
        pinfo = self._paper(paper) if paper and paper.exists() else {}
        cinfo = self._code(code) if code and code.exists() else {}
        title = (p.get("title") or pinfo.get("title") or cinfo.get("title") or p["key"])[:120]
        idea = p.get("idea") or pinfo.get("abstract") or cinfo.get("readme") or title
        seq = (self.db.val("select max(seq) from lines") or 0) + 1
        line_id = f"line_{seq}"
        done = {"idea", "hatch", "team", "method"}
        notes = {"idea": "来自本地仓库", "hatch": "本地项目，没有经过孵化场", "team": "本地项目，由你和你的 agent 负责",
                 "method": "方法已经在代码仓库里实现", "write": "论文在本地 LaTeX 仓库里写"}
        with self.db.lock:
            self.db.insert("lines", {"id": line_id, "seq": seq, "title": title, "idea": idea[:1200], "budget": 0, "spent": 0,
                                     "status": "linked", "stage": "write", "revisions": 0, "linked": p,
                                     "note": "从本地仓库接入的项目", "created_at": now(), "updated_at": now()})
            for i, (key, _, b, _) in enumerate(STAGES):
                st = "done" if key in done else "run" if key == "write" and paper else "todo"
                self.db.insert("stages", {"line_id": line_id, "idx": i, "key": key, "status": st, "building": b, "workers": [],
                                          "pct": 100 if st == "done" else 0, "note": notes.get(key)})
        self.town.bus.publish("line", line=self.town.pipeline.snapshot(line_id))
        return line_id

    def _cached(self, key: str, fn) -> dict:
        with self._lock:
            hit = self._cache.get(key)
            if hit and time.time() - hit[0] < TTL:
                return hit[1]
        v = fn()
        with self._lock:
            self._cache[key] = (time.time(), v)
        return v

    def _code(self, repo: Path) -> dict:
        files = _git(repo, "ls-files").splitlines()
        exts: dict[str, int] = {}
        for f in files:
            e = Path(f).suffix.lower() or Path(f).name
            exts[e] = exts.get(e, 0) + 1
        top = sorted(exts.items(), key=lambda kv: -kv[1])[:5]
        readme = next((repo / n for n in ("README.md", "readme.md", "README.rst", "README") if (repo / n).exists()), None)
        title, para = None, ""
        if readme:
            text = readme.read_text(encoding="utf-8", errors="ignore")
            h = re.search(r"^#\s+(.+)$", text, re.M)
            title = h.group(1).strip() if h else None
            body = re.sub(r"^#.*$", "", text, flags=re.M)
            para = next((re.sub(r"\s+", " ", b).strip() for b in re.split(r"\n\s*\n", body) if len(b.strip()) > 60), "")
        dirs = sorted({f.split("/")[0] for f in files if "/" in f})
        return {"path": _home(repo), "name": repo.name, "branch": _git(repo, "rev-parse", "--abbrev-ref", "HEAD").strip(),
                "remote": re.sub(r"^.*[:/]([^/:]+/[^/]+?)(\.git)?$", r"\1", _git(repo, "remote", "get-url", "origin").strip()) or None,
                "commits": _commits(repo, 8), "dirty": len(_git(repo, "status", "--porcelain").splitlines()),
                "files": len(files), "langs": [{"ext": e, "n": n} for e, n in top], "dirs": dirs[:12],
                "title": title, "readme": para[:700]}

    def _paper(self, repo: Path) -> dict:
        main = _main_tex(repo)
        if not main:
            return {"path": _home(repo), "name": repo.name, "main": None, "commits": _commits(repo, 5)}
        full = _expand(repo, main)
        title = _arg(full, "title")
        m = re.search(r"\\begin\{abstract\}(.*?)\\end\{abstract\}", full, re.S)
        sections = [plain(_braced(full, s.end() - 1)[0]) for s in re.finditer(r"\\section\*?\s*\{", full)]
        bib = _bib_entries(repo)
        pdf = main.with_suffix(".pdf")
        figs = len(re.findall(r"\\includegraphics", full))
        return {"path": _home(repo), "name": repo.name, "main": main.name, "title": plain(title) if title else None,
                "abstract": plain(m.group(1))[:900] if m else "", "sections": sections[:20], "figures": figs,
                "tables": len(re.findall(r"\\begin\{table\*?\}", full)), "words": len(plain(full).split()),
                "bib": len(bib), "pdf": pdf.exists(), "pdf_at": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(pdf.stat().st_mtime)) if pdf.exists() else None,
                "commits": _commits(repo, 5), "dirty": len(_git(repo, "status", "--porcelain").splitlines())}

    def summary(self, line_id: str) -> dict | None:
        p = self.of(line_id)
        if not p:
            return None

        def build() -> dict:
            code = Path(p["code"]) if p.get("code") else None
            paper = Path(p["paper"]) if p.get("paper") else None
            return {"key": p["key"], "match": p["match"],
                    "code": (self._code(code) if code.exists() else {"path": _home(code), "missing": True}) if code else None,
                    "paper": (self._paper(paper) if paper.exists() else {"path": _home(paper), "missing": True}) if paper else None}

        return self._cached(line_id, build)

    def workdir(self, line_id: str, role: str) -> Path | None:
        p = self.of(line_id)
        if not p:
            return None
        d = p.get("code") if role == "coder" else p.get("paper") if role == "writer" else None
        return Path(d) if d and Path(d).exists() else None

    def pdf(self, line_id: str) -> Path | None:
        p = self.of(line_id)
        if not p or not p.get("paper"):
            return None
        main = _main_tex(Path(p["paper"]))
        return main.with_suffix(".pdf") if main and main.with_suffix(".pdf").exists() else None

    def references(self, line_id: str) -> list[dict]:
        p = self.of(line_id)
        if not p or not p.get("paper") or not Path(p["paper"]).exists():
            return []
        out = []
        for e in _bib_entries(Path(p["paper"])):
            arxiv = e["eprint"] if re.match(r"^\d{4}\.\d{4,5}", e["eprint"]) else ""
            if not arxiv:
                m = re.search(r"arxiv\.org/(?:abs|pdf)/(\d{4}\.\d{4,5})", e["url"])
                arxiv = m.group(1) if m else ""
            url = (f"https://arxiv.org/abs/{arxiv}" if arxiv else e["url"] or (f"https://doi.org/{e['doi']}" if e["doi"] else "")
                   or f"https://scholar.google.com/scholar?q={quote_plus(e['title'] or e['key'])}")
            authors = [a.strip() for a in re.split(r"\s+and\s+", e["author"]) if a.strip()]
            out.append({"paper_id": f"bib:{e['key']}", "arxiv_id": arxiv, "title": e["title"] or e["key"], "year": e["year"],
                        "authors": ", ".join(authors[:3]) + (" et al." if len(authors) > 3 else ""), "snippet": e["venue"],
                        "url": url, "tags": [], "topic": "参考文献"})
        return out

    def jobs(self, line_id: str) -> list[dict]:
        p = self.of(line_id)
        return self.town.nvidb.jobs_matching(p["match"]) if p else []

    def farm_jobs(self) -> list[dict]:
        out = []
        for r in self.lines():
            out += [as_farm_job(j, r["id"]) for j in self.town.nvidb.jobs_matching(r["linked"].get("match") or [])]
        return out

    def overlay(self, line_id: str, stages: list[dict]) -> None:
        """A linked project's experiment stage as nvidb sees it right now."""
        jobs = self.jobs(line_id)
        if not jobs:
            return
        run = sum(1 for j in jobs if j["state"] == "running")
        wait = sum(1 for j in jobs if j["state"] == "pending")
        done = sum(1 for j in jobs if j["state"] == "completed")
        bad = sum(1 for j in jobs if j["state"] in ("failed", "lost", "timeout"))
        for s in stages:
            if s["key"] == "exp":
                s["status"] = "run" if run or wait else "done"
                s["pct"] = round(100 * done / max(1, done + run + wait)) if run or wait else 100
                s["note"] = "nvidb：" + "、".join(x for x in [f"{run} 个在跑" if run else "", f"{wait} 个排队" if wait else "",
                                                             f"最近 {done} 个跑完" if done else "", f"{bad} 个失败" if bad else ""] if x)
