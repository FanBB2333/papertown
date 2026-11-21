"""SQLite storage: one file holds the world, the pipelines, the ledger and the library.
Connections are per thread (pipelines run in worker threads); WAL keeps readers and the writer apart.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, TypeVar

SCHEMA = """
create table if not exists meta(k text primary key, v text);

create table if not exists buildings(
  id text primary key, type text not null, x integer not null, y integer not null,
  name text, label text, accent text, line_id text, status text default 'idle', created_at text);

create table if not exists lines(
  id text primary key, seq integer, title text, idea text, budget real, spent real default 0,
  status text, stage text, mill_id text, verdict text, team text, plan text,
  revisions integer default 0, note text, created_at text, updated_at text);

create table if not exists stages(
  line_id text, idx integer, key text, status text, building text, workers text,
  pct integer default 0, item_id text, note text, started_at text, ended_at text,
  primary key(line_id, idx));

create table if not exists items(
  id text primary key, line_id text, kind text, stage text, building text, title text,
  body text, created_at text);

create table if not exists workers(
  id text primary key, code text, role text, level integer, status text, runs integer default 0,
  trailing_roi real default 0, history text, created_at text);

create table if not exists worker_events(
  id integer primary key autoincrement, ts text, worker_id text, change text, note text);

create table if not exists runs(
  id text primary key, line_id text, stage text, worker_id text, provider text, model text,
  status text, tokens_in integer default 0, tokens_out integer default 0, cost real default 0,
  steps integer default 0, error text, started_at text, ended_at text);

create table if not exists trace(
  id integer primary key autoincrement, ts text, run_id text, line_id text, kind text,
  label text, detail text, ms integer);

create table if not exists ledger(
  id integer primary key autoincrement, ts text, run_id text, line_id text, provider text,
  model text, tokens_in integer, tokens_out integer, cost real);

create table if not exists messages(
  id integer primary key autoincrement, ts text, line_id text, role text, worker_id text,
  kind text, body text);

create table if not exists papers(
  id integer primary key autoincrement, arxiv_id text unique, title text, abstract text,
  authors text, categories text, published text, url text, tags text, source text, added_at text);
create virtual table if not exists papers_fts using fts5(
  title, abstract, content='papers', content_rowid='id', tokenize='porter unicode61');
create table if not exists paper_vecs(paper_id integer primary key, vec blob);

create table if not exists edges(
  src text, dst text, kind text, weight real default 1, title text, primary key(src, dst, kind));

create table if not exists repos(id text primary key, repo text, label text, accent text, data text);
create table if not exists repo_docs(id integer primary key autoincrement, repo_id text, path text, text text);
create virtual table if not exists repo_fts using fts5(
  path, text, content='repo_docs', content_rowid='id', tokenize='porter unicode61');

create table if not exists jobs(
  id text primary key, line_id text, name text, backend text, status text, progress integer default 0,
  command text, cwd text, config text, result text, note text, submitted_by text,
  created_at text, started_at text, ended_at text);
create table if not exists agents(
  id text primary key, line_id text, role text, status text, tmux text, cwd text, token text,
  model text, cost real default 0, created_at text, updated_at text);
create table if not exists agent_events(id integer primary key autoincrement, agent_id text, ts text, kind text, data text);
create table if not exists terminal_seen(terminal_id text primary key, seq integer, at text);
create table if not exists terminal_queue(
  id integer primary key autoincrement, terminal_id text, text text, created_at text, state text);
create index if not exists terminal_queue_terminal on terminal_queue(terminal_id, state, id);

-- reports from a project's agents, and the questions they ask you (leads.py)
create table if not exists reports(id integer primary key autoincrement, line_id text, agent_id text, ts text, kind text, data text);

-- what each check on a project found, a row each time it changes (checks.py)
create table if not exists checks(id integer primary key autoincrement, line_id text, check_id text, ts text, seen text,
  status text, value real, data text, by text);

create index if not exists agent_events_agent on agent_events(agent_id, id);
create index if not exists reports_line on reports(line_id, id);
create index if not exists checks_line on checks(line_id, check_id, id);
create index if not exists jobs_line on jobs(line_id, created_at);
create index if not exists trace_line on trace(line_id, id);
create index if not exists messages_line on messages(line_id, id);
create index if not exists ledger_ts on ledger(ts);

create table if not exists usage_samples(
  id integer primary key, ts real, provider text, account text, window text, used real,
  resets_at text, plan text, data text);
create index if not exists usage_samples_window on usage_samples(provider, account, window, ts);
create table if not exists usage_tokens(
  minute integer, bucket_start real, provider text, model text, session_id text, cwd text, line_id text,
  first_at real, last_at real, input integer, cache_write integer, cache_write_1h integer, cache_read integer, output integer);
create table if not exists usage_files(path text primary key, offset integer, mtime real, data text);
create table if not exists agent_sessions(
  session_id text primary key, agent_id text, line_id text, provider text);
create table if not exists terminal_sessions(
  session_id text, provider text, terminal_id text, name text, cwd text,
  primary key(session_id, provider));
create table if not exists usage_alerts(
  line_id text, budget real, threshold integer, primary key(line_id, budget, threshold));
"""

# (table, column, declaration) for columns added to tables after they first shipped
ADDED = [("agents", "runtime", "text"), ("agents", "ext_id", "text"), ("lines", "hold", "text"), ("lines", "linked", "text")]
ADDED += [("agents", "node_id", "text"), ("agents", "workspace_id", "text"), ("lines", "paseo_project", "text")]
ADDED += [("agents", "seen_at", "text")]
ADDED += [("lines", "usage_budget", "real"), ("agents", "session_id", "text")]

JSON_COLS = {"team", "plan", "workers", "body", "history", "authors", "categories", "tags", "data", "config", "result", "linked"}


JSONValue = TypeVar("JSONValue", dict, list)


def read_json(path: Path, default: JSONValue) -> JSONValue:
    """Read a persisted JSON container, falling back on missing, invalid or wrong-shaped data."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, type(default)) else default
    except (OSError, ValueError):
        return default


def write_json(path: Path, data: dict | list, *, mode: int | None = None) -> None:
    """Replace a JSON file atomically, applying private permissions before it becomes visible."""
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    if mode is not None:
        tmp.chmod(mode)
    tmp.replace(path)


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def week_ago() -> str:
    return (datetime.now(timezone.utc) - timedelta(days=7)).isoformat(timespec="seconds")


def _row(r: sqlite3.Row | None) -> dict | None:
    if r is None:
        return None
    d = dict(r)
    for k in JSON_COLS & d.keys():
        if isinstance(d[k], str) and d[k][:1] in "[{":
            d[k] = json.loads(d[k])
    return d


class DB:
    def __init__(self, path: Path):
        self.path = path
        self._local = threading.local()
        self.lock = threading.RLock()  # serialises multi-statement writes
        with self.lock:
            self.conn.executescript(SCHEMA)
            for table, col, decl in ADDED:
                if col not in {r[1] for r in self.conn.execute(f"pragma table_info({table})")}:
                    self.conn.execute(f"alter table {table} add column {col} {decl}")
            # The unshipped quota-based prototype did not retain session IDs. Rebuild
            # its derived token cache from logs, while keeping subscription samples.
            columns = {r[1] for r in self.conn.execute("pragma table_info(usage_tokens)")}
            if "session_id" in columns and "cache_write_1h" not in columns:
                # Derived from the logs: rebuild it to price one-hour cache writes.
                self.conn.executescript("drop table usage_tokens; delete from usage_files;")
                self.conn.executescript(SCHEMA)
            if "session_id" not in columns:
                self.conn.executescript("drop table usage_tokens; delete from usage_files; drop table usage_alerts;")
                self.conn.executescript(SCHEMA)
                # Retain only window readings, stripping prototype bookkeeping.
                keep = {"id", "label", "group", "used", "left", "resets_at", "fetched_at"}
                for row in self.conn.execute("select id, data from usage_samples").fetchall():
                    data = json.loads(row["data"] or "{}")
                    self.conn.execute("update usage_samples set data = ? where id = ?",
                                      (json.dumps({k: v for k, v in data.items() if k in keep}), row["id"]))
                saved = self.conn.execute("select v from meta where k = 'usage_state'").fetchone()
                if saved:
                    state = json.loads(saved["v"])
                    for provider in state.get("providers", {}).values():
                        for account in provider.get("accounts", {}).values():
                            account["windows"] = [{k: v for k, v in w.items() if k in keep} for w in account.get("windows", [])]
                    self.conn.execute("update meta set v = ? where k = 'usage_state'", (json.dumps(state),))
            self.conn.execute("drop table if exists usage_share")
            self.conn.execute("delete from meta where k = 'usage_baseline'")
            if next(r[2] for r in self.conn.execute("pragma table_info(lines)") if r[1] == "usage_budget").lower() != "real":
                self.conn.execute("alter table lines drop column usage_budget")
                self.conn.execute("alter table lines add column usage_budget real")
            self.conn.execute("create unique index if not exists usage_tokens_key on usage_tokens(minute, bucket_start, provider, model, session_id, cwd, coalesce(line_id, ''))")
            self.conn.commit()

    @property
    def conn(self) -> sqlite3.Connection:
        c = getattr(self._local, "conn", None)
        if c is None:
            c = sqlite3.connect(self.path, timeout=10, check_same_thread=False)
            c.row_factory = sqlite3.Row
            c.execute("pragma journal_mode=wal")
            c.execute("pragma busy_timeout=10000")
            self._local.conn = c
        return c

    def q(self, sql: str, *args: Any) -> list[dict]:
        return [_row(r) for r in self.conn.execute(sql, args).fetchall()]

    def one(self, sql: str, *args: Any) -> dict | None:
        return _row(self.conn.execute(sql, args).fetchone())

    def val(self, sql: str, *args: Any) -> Any:
        r = self.conn.execute(sql, args).fetchone()
        return r[0] if r else None

    def x(self, sql: str, *args: Any) -> int:
        with self.lock:
            cur = self.conn.execute(sql, [json.dumps(a, ensure_ascii=False) if isinstance(a, (dict, list)) else a for a in args])
            self.conn.commit()
            return cur.lastrowid

    def insert(self, table: str, row: dict) -> int:
        cols = ", ".join(row)
        marks = ", ".join("?" for _ in row)
        return self.x(f"insert into {table} ({cols}) values ({marks})", *row.values())

    def update(self, table: str, key: dict, **fields: Any) -> None:
        if not fields:
            return
        sets = ", ".join(f"{k} = ?" for k in fields)
        where = " and ".join(f"{k} = ?" for k in key)
        self.x(f"update {table} set {sets} where {where}", *fields.values(), *key.values())

    def get_meta(self, k: str) -> str | None:
        return self.val("select v from meta where k = ?", k)

    def set_meta(self, k: str, v: str) -> None:
        self.x("insert into meta(k, v) values(?, ?) on conflict(k) do update set v = excluded.v", k, v)
