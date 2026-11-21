"""Incremental, metadata-only transcript accounting with durable deduplication."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import unquote, urlsplit

from .project_dirs import owner, project_roots
from .usage_readers import stamp

if TYPE_CHECKING:
    from .town import Town

# cache_write counts every cache write; cache_write_1h is the part written with the one-hour lifetime.
COUNTS = ("input", "cache_write", "cache_write_1h", "cache_read", "output")
# Drop all prose while decoding, including messages nested inside records and summaries.
FIELDS = {"type", "timestamp", "created_at", "timestamp_ms", "cwd", "sessionId", "id", "message", "usage", "model",
          "payload", "info", "total_token_usage", "input_tokens", "cache_creation_input_tokens", "cache_write_input_tokens",
          "cached_input_tokens", "cache_read_input_tokens", "cache_read_tokens", "output_tokens", "step_index",
          "cache_creation", "ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens",
          "conversations", "summary", "WorkspaceURIs", "ProjectID"}
CONTAINERS = {"message", "usage", "payload", "info", "total_token_usage", "conversations", "summary", "cache_creation"}


def metadata(raw: str | bytes) -> dict:
    def project(d: dict) -> dict:
        # Some event types put prose in message or summary instead of a metadata object.
        return {k: v for k, v in d.items()
                if (k in FIELDS and (k not in CONTAINERS or isinstance(v, dict)))
                or (isinstance(v, dict) and re.fullmatch(r"[a-f0-9-]{32,36}", k))}
    return json.loads(raw, object_hook=project)


def number(value: object) -> int:
    return max(0, int(value)) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0


def counts(usage: dict, provider: str) -> dict[str, int]:
    cache = number(usage.get("cache_read_input_tokens", usage.get("cached_input_tokens", usage.get("cache_read_tokens", 0))))
    write = number(usage.get("cache_creation_input_tokens", usage.get("cache_write_input_tokens", 0)))
    inp = number(usage.get("input_tokens"))
    # Codex includes cached input and writes in its input total; reasoning is already in output.
    hour = min(write, number((usage.get("cache_creation") or {}).get("ephemeral_1h_input_tokens")))
    return {"input": max(0, inp - cache - write) if provider == "codex" else inp, "cache_write": write, "cache_write_1h": hour,
            "cache_read": cache, "output": number(usage.get("output_tokens"))}


class Ownership:
    """Session identity wins over cwd. Only metadata is retained for departed terminals."""
    def __init__(self, town: Town, *, remember_terminals: bool = False):
        self.town, self.db = town, town.db
        self.roots = project_roots(town)
        self.created = {r["id"]: stamp(r["created_at"]) or 0 for r in self.db.q("select id, created_at from lines")}
        self.agents = {(r["provider"], r["session_id"]): r for r in self.db.q("select * from agent_sessions")}
        for a in self.db.q("select * from agents where session_id is not null"):
            provider = (a.get("model") or "").split("/")[0]
            self.agents.setdefault((provider, a["session_id"]), {"agent_id": a["id"], "line_id": a["line_id"]})
        self.terminals = {(r["provider"], r["session_id"]): r for r in self.db.q("select * from terminal_sessions")}
        self._owners: dict[str | None, str | None] = {}
        for t in town.terminals.all():
            session = t.get("agent_session") or {}
            provider = (t.get("kind") or "").lower()
            provider = {"agy": "antigravity", "claude-code": "claude"}.get(provider, provider)
            if session.get("kind") == "id" and session.get("value") and provider:
                name = t.get("name") or {"claude": "Claude Code", "codex": "Codex", "antigravity": "Antigravity"}.get(provider, provider)
                row = {"session_id": session["value"], "provider": provider, "terminal_id": t["id"], "name": name, "cwd": t.get("cwd")}
                self.terminals[(provider, session["value"])] = row
                if remember_terminals:
                    self.db.x("insert into terminal_sessions values (?, ?, ?, ?, ?) on conflict(session_id, provider) do update set "
                              "terminal_id=excluded.terminal_id, name=excluded.name, cwd=excluded.cwd", *row.values())

    def resolve(self, provider: str, session: str, cwd: str | None, at: float) -> tuple[str | None, dict]:
        key = (provider, session)
        if a := self.agents.get(key):
            lid, who = a["line_id"], {"kind": "agent", "id": a["agent_id"]}
        else:
            t = self.terminals.get(key)
            where = cwd or (t or {}).get("cwd")
            if where not in self._owners:  # resolving a path touches the disk, and rescans repeat directories
                self._owners[where] = owner(where, self.roots)
            lid = self._owners[where]
            who = {"kind": "terminal", "id": t["terminal_id"], "name": t["name"]} if t else {"kind": "dir", "id": cwd or "", "name": cwd or ""}
        if lid not in self.created or at < self.created[lid]:
            lid = None
        return lid, who


class Scanner:
    def __init__(self, town: Town):
        self.town, self.db = town, town.db

    def _reassign(self, ownership: Ownership) -> None:
        # Snapshots may arrive after a file was scanned. Reconcile retained history
        # even when the log has not grown or is no longer on disk.
        with self.db.lock:
            conn = self.db.conn
            try:
                changed = []
                for row in self.db.q("select rowid, * from usage_tokens"):
                    lid, _ = ownership.resolve(row["provider"], row["session_id"], row["cwd"], row["first_at"])
                    if lid == row["line_id"]:
                        continue
                    conn.execute("delete from usage_tokens where rowid = ?", (row["rowid"],))
                    row["line_id"] = lid
                    changed.append(row)
                for row in changed:
                    cols = [k for k in row if k != "rowid"]
                    conn.execute("insert into usage_tokens (" + ",".join(cols) + ") values (" + ",".join("?" for _ in cols) + ") "
                                 "on conflict do update set input=input+excluded.input, cache_write=cache_write+excluded.cache_write, cache_write_1h=cache_write_1h+excluded.cache_write_1h, "
                                 "cache_read=cache_read+excluded.cache_read, output=output+excluded.output, "
                                 "first_at=min(first_at, excluded.first_at), last_at=max(last_at, excluded.last_at)", [row[k] for k in cols])
                conn.commit()
            except Exception:
                conn.rollback()
                raise

    def scan(self, at: float) -> None:
        s = self.town.s
        ownership = Ownership(self.town, remember_terminals=True)
        self._reassign(ownership)
        roots = ownership.roots
        homes = [("claude", Path(s.claude_home).expanduser() / "projects", "**/*.jsonl"),
                 ("codex", Path(s.codex_home).expanduser() / "sessions", "**/rollout-*.jsonl"),
                 ("antigravity", Path(s.antigravity_home).expanduser() / "brain", "*/.system_generated/logs/transcript.jsonl")]
        workspaces = {}
        try:
            data = metadata((Path(s.antigravity_home).expanduser() / "cache/conversation_metadata.json").read_bytes())
            for sid, info in (data.get("conversations") or {}).items():
                uris = (info.get("summary") or {}).get("WorkspaceURIs") or []
                dirs = [unquote(urlsplit(u).path) if u.startswith("file:") else u for u in uris if isinstance(u, str)]
                workspaces[sid] = next((d for d in dirs if owner(d, roots)), dirs[0] if dirs else None)
        except (OSError, ValueError, TypeError, AttributeError):
            pass
        for provider, home, pattern in homes:
            for path in sorted(home.glob(pattern)):
                if path.is_symlink():
                    continue
                try:
                    self._file(path, provider, at, ownership, workspaces)
                except OSError:
                    continue  # A disappearing or unreadable file is retried on the next scan.

    def _file(self, path: Path, provider: str, at: float, ownership: Ownership, workspaces: dict) -> None:
        stat = path.stat()
        previous = self.db.one("select * from usage_files where path = ?", str(path))
        if not previous and stat.st_mtime < at - 35 * 86400:
            return
        data = (previous or {}).get("data") or {}
        identity = f"{stat.st_dev}:{stat.st_ino}"
        offset = previous["offset"] if previous and data.get("identity") == identity and stat.st_size >= previous["offset"] else 0
        if previous and offset == stat.st_size and previous["mtime"] == stat.st_mtime:
            return
        if offset and data.get("anchor"):
            with path.open("rb") as stream:
                stream.seek(data["anchor_offset"])
                try:
                    anchor = hashlib.sha256(json.dumps(metadata(stream.readline()), sort_keys=True).encode()).hexdigest()
                except (ValueError, TypeError):
                    anchor = ""
            if anchor != data["anchor"]:
                offset = 0
        if not offset:
            data = {"identity": identity, "session": path.parents[2].name if provider == "antigravity" else path.stem}
        session_states: dict[str, dict] = {}
        rows = []
        with path.open("rb") as stream:
            stream.seek(offset)
            while raw := stream.readline():
                if not raw.endswith(b"\n"):
                    break  # Retry an unfinished JSON line after the writer completes it.
                start, offset = offset, stream.tell()
                try:
                    record = metadata(raw)
                    if not isinstance(record, dict):
                        continue
                    data["anchor_offset"] = start
                    data["anchor"] = hashlib.sha256(json.dumps(record, sort_keys=True).encode()).hexdigest()
                    tokens, key = self._record(record, provider, data)
                    if not tokens:
                        continue
                    sid = data["session"]
                    state_key = f"@{provider}:{sid}" if provider != "claude" else f"@claude:{key}"
                    if state_key not in session_states:
                        saved = self.db.one("select data from usage_files where path = ?", state_key)
                        session_states[state_key] = saved["data"] if saved else {}
                    state = session_states[state_key]
                    if provider == "codex":
                        total = state.get("total") or dict.fromkeys(COUNTS, 0)
                        delta = {k: max(0, tokens[k] - total[k]) for k in COUNTS}
                        state["total"] = {k: max(tokens[k], total[k]) for k in COUNTS}
                        tokens = delta
                    elif provider == "claude":
                        if state.get("seen"):
                            continue
                        state["seen"] = True
                    else:
                        seen = state.setdefault("steps", [])
                        if key in seen:
                            continue
                        seen.append(key)
                    ts = stamp(record.get("timestamp") or record.get("created_at") or record.get("timestamp_ms")) or stat.st_mtime
                    if ts > at + 60 or not sum(tokens.values()):
                        continue
                    model = data.get("model") or "unknown"
                    cwd = workspaces.get(sid) if provider == "antigravity" else data.get("cwd")
                    lid, _ = ownership.resolve(provider, sid, cwd, ts)
                    # Split only a project's creation minute, so a late snapshot can
                    # reassign history without including earlier records in that minute.
                    bucket = max([int(ts // 60) * 60] + [t for t in ownership.created.values() if int(ts // 60) * 60 < t <= ts])
                    rows.append((int(ts // 60), bucket, provider, model, sid, cwd or "", lid, ts, ts,
                                 *(tokens[k] for k in COUNTS)))
                except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
                    continue
        # Tokens, dedup state and byte offsets commit together, so retries cannot double-count.
        with self.db.lock:
            conn = self.db.conn
            try:
                for row in rows:
                    conn.execute("insert into usage_tokens values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict do update set "
                                 "input=input+excluded.input, cache_write=cache_write+excluded.cache_write, cache_write_1h=cache_write_1h+excluded.cache_write_1h, "
                                 "cache_read=cache_read+excluded.cache_read, output=output+excluded.output, "
                                 "first_at=min(first_at, excluded.first_at), last_at=max(last_at, excluded.last_at)", row)
                for key, state in session_states.items():
                    conn.execute("insert into usage_files values (?, 0, ?, ?) on conflict(path) do update set data=excluded.data, mtime=excluded.mtime",
                                 (key, at, json.dumps(state)))
                conn.execute("insert into usage_files values (?, ?, ?, ?) on conflict(path) do update set "
                             "offset=excluded.offset, mtime=excluded.mtime, data=excluded.data", (str(path), offset, stat.st_mtime, json.dumps(data)))
                conn.commit()
            except Exception:
                conn.rollback()
                raise

    @staticmethod
    def _record(r: dict, provider: str, state: dict) -> tuple[dict | None, str | None]:
        if provider == "claude":
            message = r.get("message") or {}
            if r.get("cwd"):
                state["cwd"] = r["cwd"]
            state["session"] = r.get("sessionId") or state["session"]
            if r.get("type") != "assistant" or not message.get("id") or not message.get("usage"):
                return None, None
            state["model"] = message.get("model") or "unknown"
            return counts(message["usage"], provider), str(message["id"])
        if provider == "codex":
            payload = r.get("payload") or {}
            if r.get("type") == "session_meta":
                state.update(session=payload.get("id") or state["session"], cwd=payload.get("cwd"))
            if r.get("type") == "turn_context":
                state["model"] = payload.get("model") or "unknown"
                state["cwd"] = payload.get("cwd") or state.get("cwd")
            total = (payload.get("info") or {}).get("total_token_usage")
            if r.get("type") == "event_msg" and payload.get("type") == "token_count" and total:
                return counts(total, provider), None
            return None, None
        if r.get("step_index") is None or not any(k in r for k in ("input_tokens", "output_tokens", "cache_read_tokens")):
            return None, None
        state["model"] = r.get("model") or "unknown"
        return counts(r, provider), str(r["step_index"])
