"""A project's memory from before Papertown: agent conversations (Claude Code, Codex) and notes found
for its repositories on this machine, imported only when you pick them, as the words alone (no tool
calls or injected context, secrets blanked). Where it looks, and where an import lands:

    ~/.claude/projects/<the repository's path, other characters as ->/<session>.jsonl
    ~/.claude/projects/<the same>/memory/*.md
    ~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl    (a Codex worktree of the repository counts)
    <repository>/CLAUDE.md, <repository>/AGENTS.md
    data/projects/<project>/memory/<id>.json, listed in index.json
"""

from __future__ import annotations

import json
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Iterator

from .db import now, read_json
from .linked import _git, _home

if TYPE_CHECKING:
    from .town import Town

NOTES = ("CLAUDE.md", "AGENTS.md")
HEAD_LINES, HEAD_BYTES, TAIL_BYTES = 400, 4_000_000, 512_000
MSG_MAX, MSGS_MAX, NOTE_MAX = 8000, 4000, 60_000
# how a user turn begins when the coding tool, not the person, wrote it
INJECTED = ("<command-", "<local-command", "Caveat:", "<system-reminder>", "[Request interrupted", "<bash-", "<task-notification",
            "<user-prompt-submit-hook>", "<environment_context>", "<user_instructions>", "# AGENTS.md", "<permissions",
            "<collaboration_mode>", "<turn_aborted>", "<user_shell_command>", "<INSTRUCTIONS>", "<subagent_notification")
SECRET = re.compile(
    r"sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}"
    r"|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----")
SAID = re.compile(rb'"type":\s*"(?:user|assistant)"')  # a line worth parsing, found before parsing it
ASSIGNED = re.compile(r"(?i)\b([A-Z0-9_]*(?:api[_-]?key|token|secret|password|passwd)[A-Z0-9_]*)(\s*[=:]\s*['\"]?)([^\s'\"]{8,})")


class HistoryError(Exception):
    pass


def redact(t: str) -> str:
    t = SECRET.sub("[已隐去]", t)
    return ASSIGNED.sub(lambda m: f"{m.group(1)}{m.group(2)}[已隐去]", t)


def _clip(t: str, n: int) -> str:
    return t if len(t) <= n else t[: n * 2 // 3] + "\n…\n" + t[-n // 3:]


def _slug(p: Path) -> str:
    return re.sub(r"[^A-Za-z0-9]", "-", str(p))


def _inside(cwd: str, root: Path) -> bool:
    return cwd == str(root) or cwd.startswith(str(root) + "/")


def _worktree(cwd: str, root: Path) -> bool:
    """A Codex worktree of the repository: ~/.codex/worktrees/<name>/<repository's folder>."""
    return re.search(r"/\.codex/worktrees/[^/]+/" + re.escape(root.name) + r"(/|$)", cwd) is not None


def _ts(v) -> str | None:
    if isinstance(v, str) and v:
        return v
    if isinstance(v, (int, float)):
        return datetime.fromtimestamp(v / 1000 if v > 1e11 else v, timezone.utc).isoformat(timespec="seconds")
    return None


def _said(content) -> str:
    """The text in a message's content: a string, or the text parts of a list."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n\n".join(b.get("text") or "" for b in content if isinstance(b, dict) and b.get("type") in ("text", "input_text", "output_text"))
    return ""


def _typed(text: str) -> str | None:
    """What a person typed, without what the tool added; None when the tool wrote all of it."""
    t = re.sub(r"<system-reminder>[\s\S]*?</system-reminder>", "", text).strip()
    if not t or t.startswith(INJECTED):
        return None
    return t


def _lines(path: Path, head: bool = True) -> Iterator[str]:
    """The first lines of a file (a few MB at most), or the whole lines in its last part."""
    with path.open("rb") as f:
        if head:
            got = 0
            for i, raw in enumerate(f):
                got += len(raw)
                if i >= HEAD_LINES or got > HEAD_BYTES:
                    return
                yield raw.decode("utf-8", errors="replace")
        else:
            size = path.stat().st_size
            f.seek(max(0, size - TAIL_BYTES))
            chunk = f.read().decode("utf-8", errors="replace")
            yield from (chunk.splitlines()[1:] if size > TAIL_BYTES else chunk.splitlines())


def _json(line: str) -> dict | None:
    try:
        d = json.loads(line)
        return d if isinstance(d, dict) else None
    except ValueError:
        return None


def claude_head(path: Path) -> dict | None:
    """Where a Claude Code session ran, when, and what it was about, from its first and last parts."""
    cwd = started = first = title = None
    for ln in _lines(path):
        d = _json(ln)
        if not d:
            continue
        cwd = cwd or d.get("cwd")
        started = started or d.get("timestamp")
        if d.get("type") == "ai-title":
            title = d.get("aiTitle") or title
        if not first and d.get("type") == "user" and not d.get("isMeta") and not d.get("isSidechain"):
            first = _typed(_said((d.get("message") or {}).get("content")))
        if cwd and first and started:
            break
    if not cwd:
        return None
    ended = None
    for ln in _lines(path, head=False):
        if '"ai-title"' in ln or '"timestamp"' in ln:
            d = _json(ln)
            if d:
                title = d.get("aiTitle") or title if d.get("type") == "ai-title" else title
                ended = d.get("timestamp") or ended
    return {"cwd": cwd, "started": started, "ended": ended or started, "title": title or (first or "").split("\n")[0][:90] or path.stem}


def claude_messages(path: Path) -> list[dict]:
    out: list[dict] = []
    with path.open("rb") as f:
        for raw in f:
            if b'"tool_result"' in raw or not SAID.search(raw):
                continue
            d = _json(raw.decode("utf-8", errors="replace"))
            if not d or d.get("type") not in ("user", "assistant") or d.get("isMeta") or d.get("isSidechain"):
                continue
            text = _said((d.get("message") or {}).get("content"))
            if d["type"] == "user":
                text = _typed(text) or ""
            _add(out, d["type"], text, d.get("timestamp"))
    return out[-MSGS_MAX:]


def codex_head(path: Path) -> dict | None:
    meta = first = started = ended = None
    for i, ln in enumerate(_lines(path)):
        d = _json(ln)
        if not d:
            continue
        p = d.get("payload") or {}
        if i == 0:
            if d.get("type") != "session_meta" or (isinstance(p.get("source"), dict) and "subagent" in p["source"]):
                return None  # a subagent's session belongs to the one that started it
            meta, started = p, p.get("timestamp") or d.get("timestamp")
            continue
        if d.get("type") == "response_item" and p.get("type") == "message" and p.get("role") == "user":
            first = _typed(_said(p.get("content")))
            if first:
                break
    if not meta or not meta.get("cwd"):
        return None
    for ln in _lines(path, head=False):
        if '"timestamp"' in ln:
            d = _json(ln)
            ended = (d or {}).get("timestamp") or ended
    return {"cwd": meta["cwd"], "id": meta.get("id") or path.stem, "started": started, "ended": ended or started,
            "remote": ((meta.get("git") or {}).get("repository_url") or "").strip() or None,
            "title": (first or "").split("\n")[0][:90] or path.stem}


def codex_messages(path: Path) -> list[dict]:
    out: list[dict] = []
    with path.open("rb") as f:
        for raw in f:
            if b'"message"' not in raw:
                continue
            d = _json(raw.decode("utf-8", errors="replace"))
            p = (d or {}).get("payload") or {}
            if not d or d.get("type") != "response_item" or p.get("type") != "message" or p.get("role") not in ("user", "assistant"):
                continue
            text = _said(p.get("content"))
            if p["role"] == "user":
                text = _typed(text) or ""
            _add(out, p["role"], text, d.get("timestamp"))
    return out[-MSGS_MAX:]


def _add(out: list[dict], role: str, text: str, at) -> None:
    text = redact(text.strip())
    if not text:
        return
    if out and out[-1]["role"] == role:
        out[-1]["text"] = _clip(out[-1]["text"] + "\n\n" + text, MSG_MAX)
        return
    out.append({"role": role, "text": _clip(text, MSG_MAX), "at": _ts(at)})


def _note(path: Path) -> tuple[str, str]:
    """A memory note's title (its front matter's name or description, else its first heading) and text."""
    text = path.read_text(encoding="utf-8", errors="replace")[:NOTE_MAX]
    title = path.stem
    fm = re.match(r"^---\n([\s\S]*?)\n---\n?", text)
    if fm:
        name = re.search(r"^description:\s*(.+)$", fm.group(1), re.M) or re.search(r"^name:\s*(.+)$", fm.group(1), re.M)
        title = name.group(1).strip() if name else title
        text = text[fm.end():]
    else:
        h = re.search(r"^#\s+(.+)$", text, re.M)
        title = h.group(1).strip() if h else title
    return title.strip().strip('"\'“”')[:120], redact(text.strip())


class History:
    def __init__(self, town: "Town"):
        self.town = town
        self.s = town.s
        self._lock = threading.Lock()
        self._heads: dict[str, tuple[float, int, dict | None]] = {}

    def roots(self, line_id: str) -> list[tuple[str, Path]]:
        out = []
        for which in ("code", "paper"):
            try:
                r = self.town.workspace.root(line_id, which)
            except Exception:  # noqa: BLE001 - no project
                r = None
            if r:
                out.append((which, r.resolve()))
        return out

    def _head(self, path: Path, read) -> dict | None:
        st = path.stat()
        hit = self._heads.get(str(path))
        if hit and hit[0] == st.st_mtime and hit[1] == st.st_size:
            return hit[2]
        try:
            v = read(path)
        except OSError:
            v = None
        self._heads[str(path)] = (st.st_mtime, st.st_size, v)
        return v

    def scan(self, line_id: str) -> dict:
        """What there is to import, for each of the project's repositories, newest first."""
        roots = self.roots(line_id)
        have = {m["key"]: m for m in self.imported(line_id)}
        found: list[dict] = []
        claude, codex = Path(self.s.claude_home).expanduser() / "projects", Path(self.s.codex_home).expanduser() / "sessions"
        for which, root in roots:
            slug = _slug(root)
            dirs = sorted(d for d in claude.iterdir() if d.is_dir() and (d.name == slug or d.name.startswith(slug + "-"))) if claude.is_dir() else []
            for d in dirs:
                ran_here = d.name == slug
                for f in d.glob("*.jsonl"):
                    h = self._head(f, claude_head)
                    if h and _inside(h["cwd"], root):
                        ran_here = True
                        found.append(self._item(f"claude:{f.stem}", "claude", "session", which, f, h))
                if ran_here and (d / "memory").is_dir():
                    for f in sorted((d / "memory").glob("*.md")):
                        if f.name != "MEMORY.md":
                            title, _ = _note(f)
                            found.append(self._item(f"claude-memory:{d.name}/{f.name}", "claude-memory", "note", which, f,
                                                    {"title": title, "cwd": str(root)}))
            if codex.is_dir():
                origin = _git(root, "remote", "get-url", "origin").strip()
                for f in codex.glob("*/*/*/rollout-*.jsonl"):
                    h = self._head(f, codex_head)
                    if h and (_inside(h["cwd"], root) or (_worktree(h["cwd"], root) and (not origin or not h["remote"] or h["remote"] == origin))):
                        found.append(self._item(f"codex:{h['id']}", "codex", "session", which, f, h))
            for name in NOTES:
                f = root / name
                if f.is_file():
                    title, _ = _note(f)
                    found.append(self._item(f"repo:{which}/{name}", "repo", "note", which, f, {"title": f"{name} · {title}", "cwd": str(root)}))
        seen: set[str] = set()
        out = []
        for x in found:
            if x["key"] in seen:
                continue
            seen.add(x["key"])
            m = have.get(x["key"])
            x["imported"] = bool(m)
            x["changed"] = bool(m) and (m.get("mtime"), m.get("size")) != (x["mtime"], x["size"])
            out.append(x)
        out.sort(key=lambda x: (x["kind"] != "note", -(x["mtime"] or 0)))
        return {"found": out, "roots": [{"repo": w, "path": _home(r)} for w, r in roots],
                "sources": {"claude": claude.is_dir(), "codex": codex.is_dir()}}

    @staticmethod
    def _item(key: str, source: str, kind: str, which: str, f: Path, h: dict) -> dict:
        st = f.stat()
        return {"key": key, "source": source, "kind": kind, "repo": which, "title": h.get("title") or f.stem, "cwd": _home(h.get("cwd") or ""),
                "origin": str(f), "started": h.get("started"), "ended": h.get("ended") or _ts(st.st_mtime),
                "size": st.st_size, "mtime": st.st_mtime}

    def _dir(self, line_id: str) -> Path:
        return self.s.projects_dir / line_id / "memory"

    @staticmethod
    def _id(key: str) -> str:
        return re.sub(r"[^\w.-]+", "_", key)[:140]

    def imported(self, line_id: str) -> list[dict]:
        return read_json((self._dir(line_id) / "index.json"), [])

    def _save_index(self, line_id: str, rows: list[dict]) -> None:
        d = self._dir(line_id)
        d.mkdir(parents=True, exist_ok=True)
        rows.sort(key=lambda m: (m["kind"] != "note", m.get("ended") or ""))
        (d / "index.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    def counts(self, line_id: str) -> dict:
        rows = self.imported(line_id)
        return {"sessions": sum(1 for m in rows if m["kind"] == "session"), "notes": sum(1 for m in rows if m["kind"] == "note"),
                "messages": sum(m.get("n", 0) for m in rows), "at": max((m["imported_at"] for m in rows), default=None)}

    def do_import(self, line_id: str, keys: list[str]) -> dict:
        if not self.town.db.one("select 1 from lines where id = ?", line_id):
            raise HistoryError("没有这个项目")
        found = {x["key"]: x for x in self.scan(line_id)["found"]}
        done, failed = [], []
        for key in dict.fromkeys(keys):
            x = found.get(key)
            if not x:
                failed.append({"key": key, "why": "在这个项目的仓库里找不到它了"})
                continue
            try:
                done.append(self._import(line_id, x))
            except (OSError, ValueError) as e:
                failed.append({"key": key, "why": str(e)[:200]})
        if not done:
            return {"imported": done, "failed": failed, "counts": self.counts(line_id)}
        with self._lock:
            rows = {m["key"]: m for m in self.imported(line_id)}
            rows.update({m["key"]: m for m in done})
            self._save_index(line_id, list(rows.values()))
        counts = self.counts(line_id)
        self.town.bus.publish("memory", line_id=line_id, counts=counts)
        self.town.trace("记忆", f"导入 {len(done)} 条", "、".join(m["title"][:20] for m in done[:4]), 0, line_id=line_id)
        return {"imported": done, "failed": failed, "counts": counts}

    def _import(self, line_id: str, x: dict) -> dict:
        f = Path(x["origin"])
        meta = {k: x[k] for k in ("key", "source", "kind", "repo", "title", "cwd", "started", "ended", "size", "mtime")}
        meta |= {"id": self._id(x["key"]), "origin": _home(f), "imported_at": now()}
        body: dict = {}
        if x["kind"] == "note":
            _, text = _note(f)
            body["text"] = text
            meta["n"], meta["chars"] = 1, len(text)
        else:
            msgs = claude_messages(f) if x["source"] == "claude" else codex_messages(f)
            if not msgs:
                raise ValueError("里面没有能导入的对话")
            body["messages"] = msgs
            meta["n"], meta["chars"] = len(msgs), sum(len(m["text"]) for m in msgs)
            meta["started"] = meta["started"] or msgs[0]["at"]
            meta["ended"] = msgs[-1]["at"] or meta["ended"]
        d = self._dir(line_id)
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{meta['id']}.json").write_text(json.dumps(meta | body, ensure_ascii=False) + "\n", encoding="utf-8")
        return meta

    def get(self, line_id: str, mid: str) -> dict:
        if mid != self._id(mid) or mid == "index":
            raise HistoryError("没有这条记忆")
        p = self._dir(line_id) / f"{mid}.json"
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise HistoryError("没有这条记忆") from None

    def remove(self, line_id: str, mid: str) -> dict:
        """Papertown's copy goes; the conversation where it was found stays."""
        m = self.get(line_id, mid)
        with self._lock:
            self._save_index(line_id, [r for r in self.imported(line_id) if r["id"] != mid])
            (self._dir(line_id) / f"{mid}.json").unlink(missing_ok=True)
        counts = self.counts(line_id)
        self.town.bus.publish("memory", line_id=line_id, counts=counts)
        return {"removed": m["key"], "counts": counts}

    def all(self, line_id: str) -> Iterator[dict]:
        """Every imported conversation and note in full, for the project's search."""
        for m in self.imported(line_id):
            try:
                yield self.get(line_id, m["id"])
            except HistoryError:
                continue
