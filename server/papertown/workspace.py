"""A project's code and paper files for the console, and its experiment data in one place. A path
never leaves its root, `.git` is off limits and only text is saved. A linked paper compiles into
Papertown's own build directory (latexmk -outdir), so its repository gets no build files.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import TYPE_CHECKING

from .linked import _git, _home, _main_tex

if TYPE_CHECKING:
    from .town import Town

ROOTS = ("code", "paper")
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache", ".ruff_cache",
             ".ipynb_checkpoints", ".idea", ".vscode", ".papertown", ".DS_Store"}
BUILD = {".aux", ".log", ".fls", ".fdb_latexmk", ".bbl", ".blg", ".out", ".toc", ".lof", ".lot", ".xdv", ".nav", ".snm",
         ".vrb", ".synctex.gz", ".run.xml", ".bcf"}
DATA_EXT = {".csv", ".tsv", ".json", ".jsonl", ".parquet", ".npy", ".npz", ".pt", ".pth", ".pkl", ".h5", ".hdf5", ".arrow"}
DATA_DIRS = {"data", "datasets", "results", "result", "outputs", "output", "runs", "logs", "eval", "evals", "experiments",
             "metrics", "artifacts", "records"}
MAX_FILES = 4000
MAX_READ = 1_000_000
MAX_SAVE = 1_000_000
STATUS = {"M": "modified", "A": "added", "D": "deleted", "R": "renamed", "?": "untracked"}


class WsError(Exception):
    def __init__(self, status: int, msg: str):
        super().__init__(msg)
        self.status = status


def _text(p: Path) -> str | None:
    """The file as text, or None when it is not (a NUL early on, or not UTF-8)."""
    raw = p.read_bytes()[:MAX_READ]
    if b"\0" in raw[:8000]:
        return None
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return None


def inside(root: Path, rel: str) -> Path:
    """rel under root, refused when it would leave it or reach into .git"""
    parts = Path(rel).parts
    if not rel or rel.startswith(("/", "~")) or ".." in parts or ".git" in parts:
        raise WsError(400, f"不能用这个路径：{rel}")
    p = (root / rel).resolve()
    if not p.is_relative_to(root.resolve()):
        raise WsError(400, f"路径出了项目目录：{rel}")
    return p


def git_status(root: Path) -> dict[str, str]:
    out = {}
    for ln in _git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all", timeout=15).split("\0"):
        if len(ln) > 3:
            code = (ln[0] if ln[0] not in " ?" else ln[1]) if ln[:2] != "??" else "?"
            out[ln[3:]] = STATUS.get(code, "modified")
    return out


def list_files(root: Path, press: bool = False) -> dict:
    """The files under root: git's own list in a repository (with each file's state), otherwise a
    walk that leaves out hidden and tool directories; with `press`, no LaTeX build files."""
    if (root / ".git").exists():
        names = [n for n in _git(root, "ls-files", "-z", "--cached", "--others", "--exclude-standard", timeout=15).split("\0") if n]
        status = git_status(root)
    else:
        names, status = [], {}
        for d, dirs, files in os.walk(root):
            dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS and not x.startswith("."))
            rel = Path(d).relative_to(root)
            names += [(rel / f).as_posix() for f in sorted(files) if not f.startswith(".")]
            if len(names) > MAX_FILES:
                break
    files = []
    for n in sorted(set(names)):
        if any(part in SKIP_DIRS for part in Path(n).parts):
            continue
        if press and (Path(n).suffix in BUILD or n.endswith(".synctex.gz")):
            continue
        p = root / n
        if not p.is_file():
            continue
        files.append({"path": n, "size": p.stat().st_size, **({"status": status[n]} if n in status else {})})
        if len(files) >= MAX_FILES:
            break
    return {"files": files, "truncated": len(files) >= MAX_FILES}


def read_file(root: Path, rel: str) -> dict:
    p = inside(root, rel)
    if not p.is_file():
        raise WsError(404, f"没有这个文件：{rel}")
    size = p.stat().st_size
    text = _text(p) if size <= MAX_READ else None
    return {"path": rel, "size": size, "mtime": p.stat().st_mtime, "binary": text is None and size <= MAX_READ,
            "too_big": size > MAX_READ, "text": text}


def repo_info(root: Path, *, timeout: float = 15) -> dict:
    """A directory's path and name, and for a git repository its branch and uncommitted changes."""
    d: dict = {"path": _home(root), "name": root.name, "git": (root / ".git").exists()}
    if d["git"]:
        d["branch"] = _git(root, "rev-parse", "--abbrev-ref", "HEAD", timeout=timeout).strip() or None
        d["dirty"] = len(_git(root, "status", "--porcelain", timeout=timeout).splitlines())
    return d


class Workspace:
    def __init__(self, town: "Town"):
        self.town = town
        self.s = town.s

    def root(self, line_id: str, which: str) -> Path | None:
        if which not in ROOTS:
            raise WsError(404, f"没有这个目录：{which}")
        if not self.town.db.one("select id from lines where id = ?", line_id):
            raise WsError(404, "没有这个项目")
        linked = self.town.linked.of(line_id)
        if linked:
            d = linked.get(which)
            d = Path(d).expanduser() if d else None
        else:
            d = self.s.projects_dir / line_id / "code" if which == "code" else self.s.press_dir / line_id
        return d if d and d.is_dir() else None

    def _need(self, line_id: str, which: str) -> Path:
        r = self.root(line_id, which)
        if not r:
            raise WsError(404, "这个项目还没有代码目录" if which == "code" else "这个项目还没有论文")
        return r

    def info(self, line_id: str) -> dict:
        out: dict = {"line_id": line_id, "linked": bool(self.town.linked.of(line_id)), "latexmk": bool(shutil.which("latexmk"))}
        for which in ROOTS:
            r = self.root(line_id, which)
            if not r:
                out[which] = None
                continue
            d = repo_info(r)
            if which == "paper":
                main = self._main(line_id, r)
                d["main"] = main.relative_to(r).as_posix() if main else None
                d["pdf"] = bool(self.pdf(line_id))
            out[which] = d
        return out

    def tree(self, line_id: str, which: str) -> dict:
        root = self._need(line_id, which)
        return {"root": which, **list_files(root, press=which == "paper" and not self.town.linked.of(line_id))}

    def read(self, line_id: str, which: str, rel: str) -> dict:
        return read_file(self._need(line_id, which), rel)

    def save(self, line_id: str, which: str, rel: str, text: str) -> dict:
        root = self._need(line_id, which)
        p = inside(root, rel)
        data = text.encode("utf-8")
        if len(data) > MAX_SAVE:
            raise WsError(400, "文件太大，没有保存")
        if p.exists() and (not p.is_file() or _text(p) is None):
            raise WsError(400, "这不是文本文件，没有保存")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        st = git_status(root).get(rel) if (root / ".git").exists() else None
        return {"path": rel, "size": len(data), "mtime": p.stat().st_mtime, **({"status": st} if st else {})}

    def diff(self, line_id: str, which: str, rel: str) -> dict:
        root = self._need(line_id, which)
        inside(root, rel)
        return {"path": rel, "diff": _git(root, "diff", "--no-color", "--", rel, timeout=15)[:200_000] if (root / ".git").exists() else ""}

    def _main(self, line_id: str, root: Path) -> Path | None:
        if self.town.linked.of(line_id):
            return _main_tex(root)
        return root / "main.tex" if (root / "main.tex").exists() else None

    def _build(self, line_id: str) -> Path:
        return self.s.data_dir / "build" / line_id

    def compile(self, line_id: str) -> dict:
        root = self._need(line_id, "paper")
        main = self._main(line_id, root)
        if not main:
            raise WsError(400, "找不到主 .tex 文件（带 \\documentclass 的那个）")
        if not shutil.which("latexmk"):
            return {"ok": False, "log": "这台机器没装 latexmk：装好 TeX（如 MacTeX / TeX Live）后再编译。", "seconds": 0}
        t0 = time.time()
        if not self.town.linked.of(line_id):
            r = self.town.press.compile(root)
            return {"ok": r["compiled"], "log": r["log"], "pages": r.get("pages"), "seconds": round(time.time() - t0, 1)}
        out = self._build(line_id)
        out.mkdir(parents=True, exist_ok=True)
        try:
            r = subprocess.run(["latexmk", "-pdf", "-interaction=nonstopmode", "-halt-on-error", f"-outdir={out}", main.name],
                               cwd=main.parent, capture_output=True, text=True, timeout=240)
        except subprocess.TimeoutExpired:
            return {"ok": False, "log": "latexmk 超时（4 分钟）", "seconds": round(time.time() - t0, 1)}
        log_file = out / f"{main.stem}.log"
        log = log_file.read_text(errors="ignore") if log_file.exists() else r.stdout + r.stderr
        m = re.search(r"Output written on .*?\((\d+) page", log)
        ok = r.returncode == 0 and (out / f"{main.stem}.pdf").exists()
        errors = "\n".join(ln for ln in log.splitlines() if ln.startswith("!") or re.match(r"^l\.\d+ ", ln))[:2000]
        return {"ok": ok, "log": "" if ok else errors or log[-2000:], "pages": int(m.group(1)) if m else None,
                "seconds": round(time.time() - t0, 1)}

    def pdf(self, line_id: str) -> Path | None:
        """The newest PDF of the paper: built here, or next to its main file."""
        root = self.root(line_id, "paper")
        if not root:
            return None
        main = self._main(line_id, root)
        cands = [p for p in ([self._build(line_id) / f"{main.stem}.pdf", main.with_suffix(".pdf")] if main else [root / "main.pdf"])
                 if p.exists()]
        return max(cands, key=lambda p: p.stat().st_mtime) if cands else None

    def data(self, line_id: str) -> dict:
        if not self.town.db.one("select id from lines where id = ?", line_id):
            raise WsError(404, "没有这个项目")
        outs = {r["stage"]: r["body"] for r in self.town.db.q("select stage, body from items where line_id = ? order by created_at", line_id)}
        method = outs.get("method") if isinstance(outs.get("method"), dict) else {}
        exp = outs.get("exp") if isinstance(outs.get("exp"), dict) else {}
        meta = {"datasets": method.get("datasets") or [], "metrics": method.get("metrics") or exp.get("metrics") or [],
                "baselines": [b.get("name") if isinstance(b, dict) else b for b in method.get("baselines") or []],
                "seeds": exp.get("seeds"), "gpu_hours": exp.get("gpu_hours"), "backend": exp.get("backend")}
        results = {k: exp.get(k) for k in ("metrics", "rows", "simulated", "analysis", "concerns")} if exp.get("rows") else None
        runs = []
        for j in self.town.linked.jobs(line_id) + self.town.farm.list(line_id):
            nv = j if "gpu_ids" in j else None
            state = j.get("state") or j.get("status")
            if state not in ("completed", "done", "failed", "lost", "timeout"):
                continue
            runs.append({"id": f"nvidb-{j['id']}" if nv else j["id"], "name": j["name"], "state": state,
                         "where": f"{j['node']}:{','.join(map(str, j['gpu_ids']))}" if nv and j.get("node") else j.get("backend"),
                         "started_at": j.get("started_at"), "finished_at": j.get("finished_at") or j.get("ended_at"),
                         "elapsed_s": j.get("elapsed_s"), "exit_code": j.get("exit_code"), "vram_mb": j.get("vram_mb"),
                         "result": j.get("result")})
        runs.sort(key=lambda r: r.get("finished_at") or "", reverse=True)
        files = []
        root = self.root(line_id, "code")
        if root:
            for f in list_files(root)["files"]:
                parts = [x.lower() for x in Path(f["path"]).parts[:-1]]
                ext = Path(f["path"]).suffix.lower()
                if ext in DATA_EXT and (ext != ".json" or any(x in DATA_DIRS for x in parts)):
                    files.append({**f, "kind": "processed" if any(x in ("results", "result", "metrics", "outputs", "output", "eval", "evals") for x in parts)
                                  else "raw" if any(x in ("data", "datasets") for x in parts) else "other",
                                  "mtime": (root / f["path"]).stat().st_mtime})
            files.sort(key=lambda f: -f["mtime"])
        return {"meta": meta, "results": results, "runs": runs[:200], "files": files[:300]}
