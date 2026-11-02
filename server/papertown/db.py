"""SQLite storage. One file holds the world, the pipelines, the ledger and the library.

Connections are per thread (pipelines run in worker threads); WAL keeps readers and
the single writer out of each other's way.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

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

-- experiments on the farm: simulated pipeline runs and jobs the coding agents submit
create table if not exists jobs(
  id text primary key, line_id text, name text, backend text, status text, progress integer default 0,
  command text, cwd text, config text, result text, note text, submitted_by text,
  created_at text, started_at text, ended_at text);
-- pi agents (coder in the depot, writer in the press) and the farm's monitors, one per project
create table if not exists agents(
  id text primary key, line_id text, role text, status text, tmux text, cwd text, token text,
  model text, cost real default 0, created_at text, updated_at text);
create table if not exists agent_events(id integer primary key autoincrement, agent_id text, ts text, kind text, data text);

-- what the agents in a project report to you, and the questions they ask you (leads.py)
create table if not exists reports(id integer primary key autoincrement, line_id text, agent_id text, ts text, kind text, data text);

create index if not exists agent_events_agent on agent_events(agent_id, id);
create index if not exists reports_line on reports(line_id, id);
create index if not exists jobs_line on jobs(line_id, created_at);
create index if not exists trace_line on trace(line_id, id);
create index if not exists messages_line on messages(line_id, id);
create index if not exists ledger_ts on ledger(ts);
"""

# (table, column, declaration) for columns added to existing tables
ADDED = [("agents", "runtime", "text"), ("agents", "ext_id", "text"), ("lines", "hold", "text"), ("lines", "linked", "text")]

JSON_COLS = {"team", "plan", "workers", "body", "history", "authors", "categories", "tags", "data", "config", "result", "linked"}


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def dumps(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False)


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
            for table, col, decl in ADDED:  # columns added after a table first shipped
                if col not in {r[1] for r in self.conn.execute(f"pragma table_info({table})")}:
                    self.conn.execute(f"alter table {table} add column {col} {decl}")
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
            cur = self.conn.execute(sql, [dumps(a) if isinstance(a, (dict, list)) else a for a in args])
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

    def get_meta(self, k: str, default: str | None = None) -> str | None:
        v = self.val("select v from meta where k = ?", k)
        return default if v is None else v

    def set_meta(self, k: str, v: str) -> None:
        self.x("insert into meta(k, v) values(?, ?) on conflict(k) do update set v = excluded.v", k, v)
