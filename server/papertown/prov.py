"""Project-local provenance: asynchronous snapshots, immutable registrations and their evidence."""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
import uuid
from collections import defaultdict, deque
from concurrent.futures import Future
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from .agents import ROLES
from .db import now, read_json, write_json
from .prov_git import EMPTY_TREE, POINTER, ROOTS, LargeFile, ProvError, Repo, blob_id, file_hash, init, safe_name
from .prov_view import Analysis, floats, passage, text_of

log = logging.getLogger(__name__)
if TYPE_CHECKING:
    from .town import Town

INTERVAL = 5.0
BASE = "开始记录前已有"
EXTERNAL = "你或外部工具"


@dataclass(frozen=True)
class Target:
    root: str
    path: str
    selector: str = ""


def op_public(row):
    n = row["files"]
    return {k: row[k] for k in ("id", "root", "ts", "trigger", "role", "who", "basis", "files", "added", "removed")} | {
        "short": row["id"][:7], "agent": row["agent_id"], "session": row["session_id"], "summary": f"{row['who']} · {n} 个文件"}


class Prov:
    def __init__(self, town: Town):
        self.town, self.db, self.s = town, town.db, town.s
        self._lock = threading.Lock()
        self._queues = {}
        self._threads = set()
        self._jobs = {}
        self._last = {}
        self._halt = threading.Event()
        self._cache = {}

    def start(self):
        self._halt.clear()
        if self.s.prov:
            for row in self.db.q("select jobs.* from jobs join prov_job_pending p on p.job_id = jobs.id"):
                self.finish_job(row)

    def stop(self):
        self._halt.set()
        with self._lock:
            threads = list(self._threads)
        for thread in threads:
            thread.join()

    def _line(self, lid):
        if not self.db.val("select 1 from lines where id = ?", lid):
            raise ProvError("没有这个项目", 404)

    def _store(self, lid):
        return self.s.projects_dir / lid / "prov.git"

    def repo(self, lid, root):
        if root not in ROOTS:
            raise ProvError("根目录应为 code 或 paper")
        store = self._store(lid)
        path = self.town.workspace.find(lid, root)
        return Repo(store, path.resolve() if path else store, root)

    def _init(self, lid):
        store = self._store(lid)
        if store.is_symlink():
            raise ProvError("溯源库须位于 Papertown 的项目数据目录内")
        for root in ROOTS:
            path = self.town.workspace.find(lid, root)
            if path and (store.resolve().is_relative_to(path.resolve()) or path.resolve().is_relative_to(store.resolve())):
                raise ProvError("溯源库须位于项目根目录之外")
        init(store)
        return store

    def head(self, lid, root):
        return self.db.one("select * from prov_ops where line_id = ? and root = ? order by ts desc limit 1", lid, root)

    def _agent_root(self, agent, roots):
        if not agent or agent.get("role") not in ("coder", "writer") or not agent.get("cwd"):
            return None
        cwd = Path(agent["cwd"]).resolve()
        inside = [r for r in roots if cwd.is_relative_to(roots[r])]
        preferred = "paper" if agent["role"] == "writer" else "code"
        return max(inside, key=lambda r: (len(roots[r].parts), r == preferred), default=None)

    def roots(self, lid):
        return {r: p.resolve() for r in ROOTS if (p := self.town.workspace.find(lid, r))}

    def _actor(self, a):
        return {"agent": a.get("id"), "role": a.get("role"), "who": ROLES.get(a.get("role"), {}).get("name", a.get("who") or EXTERNAL),
                "session": a.get("session_id") or a.get("ext_id"), "model": a.get("model")}

    def _credit(self, lid, root, roots, agent):
        people = [agent] if agent else [a for a in self.db.q("select * from agents where line_id = ? and status = 'working' order by id", lid)
                                         if self._agent_root(a, roots) == root]
        basis = []
        for a in people:
            # A held dispatch belongs to the later turn which actually receives it.
            row = self.db.one("""select data from agent_events where agent_id = ? and kind = 'user'
                and json_extract(data, '$.delivered') = 1 and json_type(data, '$.basis') = 'array'
                order by coalesce(json_extract(data, '$.delivered_at'), ts) desc, id desc limit 1""", a["id"])
            basis.extend((row or {}).get("data", {}).get("basis", []))
        actors = [self._actor(a) for a in people]
        if len(actors) == 1:
            return actors[0] | {"basis": basis}
        who = "、".join(f"{a['who']}（{a['agent']}）" for a in actors) or EXTERNAL
        return self._actor({"who": who}) | {"basis": list(dict.fromkeys(basis)), "people": actors}

    def employee(self, a: dict | None, trigger: str) -> None:
        if not self.s.prov or not a or a.get("role") not in ("writer", "coder") or not a.get("line_id"):
            return
        try:
            roots = self.roots(a["line_id"])
            root = self._agent_root(a, roots)
            if root:
                self.request(a["line_id"], root, trigger, agent=a if trigger == "turn" else None)
        except Exception as exc:
            self.failure(a["line_id"], exc)

    def failure(self, lid, exc):
        log.warning("Provenance for %s: %s", lid, exc)
        try:
            self.town.trace("PROV", "溯源记录失败", str(exc), line_id=lid)
        except Exception:
            log.exception("Could not persist the provenance trace for %s", lid)

    def request(self, lid: str | None, root: str, trigger: str, *, agent=None, extra=()) -> Future:
        future = Future()
        if not self.s.prov or self._halt.is_set() or not lid:
            future.set_result(None)
            return future
        try:
            roots = self.roots(lid)
            if root not in roots:
                future.set_result(None)
                return future
            credit = self._credit(lid, root, roots, agent)
            key = (lid, root)
            with self._lock:
                if self._halt.is_set():
                    future.set_result(None)
                elif key in self._queues:
                    queue = self._queues[key]
                    if trigger in ("before", "tick") and queue and queue[-1][:2] == (trigger, credit):
                        return queue[-1][-1]
                    queue.append((trigger, credit, extra, future))
                else:
                    self._queues[key] = deque([(trigger, credit, extra, future)])
                    worker = threading.Thread(target=self._drain, args=(key,), daemon=True, name=f"prov-{lid}-{root}")
                    self._threads.add(worker)
                    worker.start()
        except Exception as exc:
            self.failure(lid, exc)
            future.set_result(None)
        return future

    def _drain(self, key):
        while True:
            with self._lock:
                queue = self._queues[key]
                if not queue:
                    del self._queues[key]
                    self._threads.discard(threading.current_thread())
                    return
                trigger, credit, extra, future = queue.popleft()
            result = None
            try:
                delay = self._last.get(key, 0) + INTERVAL - time.monotonic()
                if not self._halt.wait(max(0.0, delay)):
                    self._last[key] = time.monotonic()
                    result = self._snapshot(*key, trigger, credit, extra)
            except Exception as exc:
                self.failure(key[0], exc)
            finally:
                future.set_result(result)

    def _snapshot(self, lid, root, trigger, credit, extra=(), at=None):
        self._init(lid)
        repo = self.repo(lid, root)
        if repo.root == repo.store:
            return None
        head = self.head(lid, root)
        if trigger == "base" and head:
            return head["id"]
        pins = {r["path"] for r in self.db.q("select distinct path from prov where line_id = ? and root = ?", lid, root)}
        pins.update(read_json(repo.store.parent / "prov.json", {}).get(root, []))
        tree = repo.stage(pins.union(extra), self.s.prov_file_bytes, self.s.prov_max_files)
        ref = f"refs/heads/{root}"
        if head and head["tree"] == tree:
            return head["id"]
        at = at or now("microseconds")
        origin = None
        if not head:
            trigger, credit = "base", self._actor({"who": BASE}) | {"basis": []}
            if (repo.root / ".git").exists():
                origin = repo.project("rev-parse", "--verify", "HEAD", optional=True).strip().decode() or None
        files = repo.files(head["tree"] if head else EMPTY_TREE, tree)
        msg = f"{trigger}: {credit['who']} · {len(files)} 个文件\n\nPapertown-Project: {lid}\nPapertown-Root: {root}\nPapertown-At: {at}\n"
        for person in credit.get("people") or [credit]:
            msg += (f"Papertown-Agent: {person['agent'] or ''}\nPapertown-Role: {person['role'] or ''}\n"
                    f"Papertown-Session: {person['session'] or ''}\n")
        msg += f"Papertown-Trigger: {trigger}\nPapertown-Basis: {' '.join(credit['basis'])}\n"
        parents = ["-p", head["id"]] if head else []
        oid = repo.git("commit-tree", tree, *parents, data=msg.encode(), date=at).strip().decode()
        row = {"id": oid, "line_id": lid, "root": root, "ts": at, "trigger": trigger, "agent_id": credit["agent"],
               "role": credit["role"], "session_id": credit["session"], "who": credit["who"], "basis": credit["basis"], "files": len(files),
               "added": sum(f["added"] for f in files), "removed": sum(f["removed"] for f in files), "tree": tree, "project_head": origin}
        with self.db.transaction():
            self.db.insert("prov_ops", row)
            repo.git("update-ref", ref, oid)
            self.db.after_commit(self.town.bus.publish, "prov", line_id=lid, op=oid)
        return oid

    def snap(self, lid: str, trigger: str = "manual") -> dict:
        self._line(lid)
        futures = {r: self.request(lid, r, trigger) for r in ROOTS}
        return {r: f.result() for r, f in futures.items()}

    def tick(self, lid):
        if self.s.prov and self.town.leads.settings(lid)["on"]:
            for root in ROOTS:
                self.request(lid, root, "tick")

    def ops(self, lid: str, root: str | None = None, before: str | None = None, limit: int = 50) -> list[dict]:
        self._line(lid)
        if root and root not in ROOTS:
            raise ProvError("根目录应为 code 或 paper")
        q, args = "select * from prov_ops where line_id = ?", [lid]
        if root:
            q += " and root = ?"
            args.append(root)
        if before:
            stamp = self.db.val("select ts from prov_ops where line_id = ? and id = ?", lid, before)
            if stamp:
                q += " and (ts, id) < (?, ?)"
                args.extend((stamp, before))
            else:
                q += " and ts < ?"
                args.append(before)
        rows = self.db.q(q + " order by ts desc, id desc limit ?", *args, min(200, max(1, limit)))
        return [op_public(r) for r in rows]

    def op(self, lid: str, oid: str) -> dict:
        row = self.db.one("select * from prov_ops where line_id = ? and id = ?", lid, oid)
        if not row:
            raise ProvError("本项目未找到这次操作", 404)
        repo = self.repo(lid, row["root"])
        parent = repo.git("rev-parse", "--verify", oid + "^", optional=True).strip().decode() or EMPTY_TREE
        files = repo.files(parent, oid)
        args = ("--no-ext-diff", "--no-textconv", "--no-renames", parent, oid)
        patch = repo.git("diff", *args)
        offsets = [m.start() for m in re.finditer(rb"(?m)^diff --git ", patch)] + [len(patch)]
        for i, f in enumerate(files):
            chunk = patch[offsets[i]:offsets[i + 1]] if len(offsets) == len(files) + 1 else repo.git("diff", *args, "--", f["path"])
            f["diff"] = chunk.decode(errors="replace")
        return op_public(row) | {"files": files}

    def lookup(self, lid, ref):
        return self.db.one("select * from prov where line_id = ? and (id = ? or tag = ?)", lid, ref, ref)

    def target(self, lid: str, value: str, cwd: str | None = None, role: str | None = None) -> Target:
        name = value.strip()
        selector = ""
        if m := re.fullmatch(r"(.+?)(:\d+(?:-\d+)?|#[^/#]+)", name):
            name, selector = m.groups()
        roots = self.roots(lid)
        prefix, _, path = name.partition("/")
        if prefix in ROOTS:
            root = prefix
        else:
            if not cwd and not Path(name).is_absolute():
                raise ProvError("请使用 code/ 或 paper/ 开头的路径")
            absolute = Path(os.path.abspath(Path(cwd or "/").resolve() / name))
            inside = [r for r in roots if absolute.is_relative_to(roots[r])]
            if not inside:
                raise ProvError(f"路径须位于本项目根目录内：{value}")
            prefer = "paper" if selector or role == "writer" else "code"
            root = max(inside, key=lambda r: (len(roots[r].parts), r == prefer))
            path = str(absolute.relative_to(roots[root]))
        if root not in roots or not safe_name(path):
            raise ProvError(f"项目文件路径无效：{value}")
        f = roots[root] / path
        if f.resolve() != f or not f.is_file():
            raise ProvError(f"本项目未找到常规文件：{value}")
        if selector and root != "paper":
            raise ProvError("文字范围须位于论文根目录")
        return Target(root, path, selector)

    def job(self, lid, jid):
        if not jid:
            return None
        if jid.startswith("nvidb-"):
            j = next((j for j in self.town.linked.jobs(lid) if f"nvidb-{j['id']}" == jid), None)
        else:
            j = self.db.one("select * from jobs where id = ? and line_id = ?", jid, lid)
        if not j:
            raise ProvError(f"本项目未找到任务：{jid}")
        return {"id": jid, "name": j.get("name"), "command": j.get("command"), "node": j.get("node") or j.get("backend"),
                "status": j.get("state") or j.get("status"), "started_at": j.get("started_at"),
                "ended_at": j.get("finished_at") or j.get("ended_at"), "op": j.get("op"), "cwd": j.get("workdir") or j.get("cwd")}

    def _source(self, lid, value, agent):
        if row := self.lookup(lid, value):
            return row["id"]
        if (value.startswith("job:") or re.fullmatch(r"(?:nvidb-\d+|job_[a-f0-9]{8})", value)
                or value.startswith("job_") and self.db.val("select 1 from jobs where line_id = ? and id = ?", lid, value)):
            jid = value.removeprefix("job:")
            self.job(lid, jid)
            return "job:" + jid
        if value.startswith(("cite:", "arxiv:")):
            if not value.partition(":")[2].strip():
                raise ProvError("请填写外部来源编号")
            return value
        return self.target(lid, value, (agent or {}).get("cwd"), (agent or {}).get("role"))

    def prepare(self, lid, agent, targets, sources, roots=()):
        extra = defaultdict(set)
        for r in roots:
            extra[r] = set()
        for spec in [*targets, *sources]:
            if isinstance(spec, Target):
                extra[spec.root].add(spec.path)
            elif spec.startswith("job:"):
                pending = self.db.one("select j.* from jobs j join prov_job_pending p on p.job_id = j.id where j.line_id = ? and j.id = ?", lid, spec[4:])
                if pending:
                    self.finish_job(pending).result()
        futures = {r: self.request(lid, r, "add", agent=agent, extra=paths) for r, paths in extra.items()}
        heads = {r: f.result() for r, f in futures.items()}
        if any(not oid for oid in heads.values()):
            raise ProvError("快照尚未完成，请重新登记")
        return heads

    def _pins(self, lid):
        with self.db.lock:
            pins = {r: [] for r in ROOTS}
            for p in self.db.q("select distinct root, path from prov where line_id = ? and root is not null order by path", lid):
                pins[p["root"]].append(p["path"])
            path = self._store(lid).parent / "prov.json"
            if read_json(path, {}) != pins:
                write_json(path, pins)

    def _record(self, lid, kind, path, blob, agent, *, root=None, op=None, span=None, location=None, src=(), job=None,
                basis=(), how=None, note=None, title=None, reuse=False, stored=None, at=None, raw=None):
        location = location or f"{root or ''}/{path}"
        old = self.db.one("select * from prov where line_id = ? and location = ? and replaced_by is null", lid, location)
        if span and not old:
            for other in self.db.q("select * from prov where line_id = ? and root = ? and path = ? and span is not null and replaced_by is null", lid, root, path):
                if passage(other, raw)[2:] == (span["start"], span["end"]):
                    old = other
                    break
        if old and reuse:
            return old
        at = at or now("microseconds")
        made = self._actor(agent or {}) | {"basis": list(basis), "job": job, "how": how}
        title = title or path
        row = {"kind": kind, "title": title, "root": root, "path": path, "location": location, "span": span, "blob": blob,
               "src": list(dict.fromkeys(src)), "note": note, "made": made, "stored": stored}
        if old and all(old[k] == v for k, v in row.items() if k != "made") and all(old["made"].get(k) == v for k, v in made.items()):
            return old
        digest = blob
        n = 7
        while self.lookup(lid, digest[:n]):
            n += 1
            if n > len(digest):
                digest += blob_id(json.dumps([row, digest], sort_keys=True, ensure_ascii=False).encode())
        row.update(id="pv_" + uuid.uuid4().hex[:10], line_id=lid, tag=digest[:n], created_at=at, op=op, replaced_by=None)
        row["made"]["at"] = at
        self.db.insert("prov", row)
        if old:
            self.db.update("prov", {"id": old["id"]}, replaced_by=row["id"])
        if root and not old:
            self.db.after_commit(self._pins, lid)
        self.db.after_commit(self.town.bus.publish, "prov", line_id=lid, node=row["id"])
        return row

    def _file(self, lid, spec, heads, agent, *, src=(), job=None, reuse=False, **kw):
        oid = heads[spec.root]
        repo = self.repo(lid, spec.root)
        key = oid + ":" + spec.path
        raw = repo.blobs([key]).get(key)
        if raw is None:
            raise ProvError(f"快照中未找到文件：{spec.path}")
        pointer = POINTER.fullmatch(raw) if isinstance(raw, LargeFile) else None
        blob = pointer[2].decode() if pointer else blob_id(raw)
        span = None
        loc = f"{spec.root}/{spec.path}"
        kind = "artifact" if src else "result"
        if spec.selector:
            text = text_of(raw)
            if text is None:
                raise ProvError("文字范围须位于可读取的文本文件内")
            lines = text.splitlines()
            if spec.selector.startswith("#"):
                label = spec.selector[1:]
                match = next((f for f in floats(lines) if label in f["labels"]), None)
                if not match:
                    raise ProvError(f"未找到含此标签的表或图：{label}")
                start, end = match["start"], match["end"]
                loc += spec.selector
            else:
                start, _, end = spec.selector[1:].partition("-")
                start, end = int(start), int(end or start)
                loc += f":{start}-{end}"
            if not 1 <= start <= end <= len(lines):
                raise ProvError("登记行号超出文件范围")
            span = {"start": start, "end": end, "text": "\n".join(lines[start - 1:end])}
            blob, kind = blob_id(span["text"].encode()), "passage"
        return self._record(lid, kind, spec.path, blob, agent, root=spec.root, op=oid, location=loc, span=span,
                            src=src, job=job, reuse=reuse, raw=raw, **kw)

    def _sources(self, lid, specs, heads, agent, basis):
        ids = []
        for spec in specs:
            if isinstance(spec, Target):
                row = self._file(lid, spec, heads, agent, basis=basis, reuse=True)
            elif spec.startswith("job:"):
                job = self.job(lid, spec[4:])
                results = self.db.q("""select id, root, path from prov where line_id = ? and kind = 'result'
                    and json_extract(made, '$.job.id') = ? and path != ? order by created_at""", lid, job["id"], spec)
                if results:
                    ids.extend({(r["root"], r["path"]): r["id"] for r in results}.values())
                    continue
                local = self.db.one("select result from jobs where line_id = ? and id = ?", lid, job["id"])
                raw = json.dumps(local["result"], ensure_ascii=False, indent=2).encode() if local and local["result"] is not None else None
                stored = self.store_blob(lid, raw) if raw is not None else None
                row = self._record(lid, "result", spec, blob_id(raw if raw is not None else spec.encode()), agent, job=job,
                                   op=job["op"], basis=basis, stored=stored)
            elif spec.startswith(("cite:", "arxiv:")):
                row = self._record(lid, "source", spec, blob_id(spec.encode()), agent, basis=basis, reuse=True)
            else:
                ids.append(spec)
                continue
            ids.append(row["id"])
        return list(dict.fromkeys(ids))

    def store_blob(self, lid, raw):
        self._init(lid)
        if len(raw) > self.s.prov_file_bytes:
            raw = f"Papertown large file\nsize {len(raw)}\nblob {blob_id(raw)}\n".encode()
        return self.repo(lid, "code").git("hash-object", "-w", "--stdin", data=raw).strip().decode()

    def add(self, lid, agent, target, sources=(), how=None, job=None, basis=None, title=None, note=None):
        self._line(lid)
        if not self.s.prov:
            raise ProvError("项目溯源已关闭")
        basis = self.town.decided.basis(lid, basis)
        job = self.job(lid, job)
        cwd = (agent or {}).get("cwd")
        spec = self.target(lid, target, cwd, (agent or {}).get("role"))
        sources = [self._source(lid, v, agent) for v in sources]
        heads = self.prepare(lid, agent, [spec], sources)
        with self.db.transaction():
            self.town.decided.basis(lid, basis)
            ids = self._sources(lid, sources, heads, agent, basis)
            return self._file(lid, spec, heads, agent, src=ids, job=job, basis=basis, how=how, title=title, note=note)

    def output_sources(self, lid, agent, rows, jid):
        refs = list(dict.fromkeys(v for row in rows for v in row.get("from", [])))
        if jid:
            refs.append("job:" + jid)
        sources = [self._source(lid, v, agent) for v in refs]
        roots = self.roots(lid)
        return sources, self.prepare(lid, agent, [], sources, list(roots)[:1])

    def output(self, item, agent, prepared):
        lid, body = item["line_id"], item["body"]
        sources, heads = prepared
        src = self._sources(lid, sources, heads, agent, body["basis"])
        raw = json.dumps(body, ensure_ascii=False, indent=2).encode()
        head = heads.get("code") or heads.get("paper")
        return self._record(lid, "artifact", item["id"], blob_id(raw), agent, op=head, src=src, title=item["title"],
                            basis=body["basis"], how=body.get("how") or None, stored=self.store_blob(lid, raw))

    def finish_job(self, row):
        jid, lid = row["id"], row["line_id"]
        with self._lock:
            if jid in self._jobs:
                return self._jobs[jid]
            done = Future()
            if self._halt.is_set() or not self.s.prov:
                done.set_result(None)
                return done
            self._jobs[jid] = done

        targets = []
        if row["status"] == "done":
            for out in row.get("outs") or []:
                try:
                    targets.append(self.target(lid, out, row["cwd"]))
                except Exception as exc:
                    self.failure(lid, exc)
        futures = {r: self.request(lid, r, "job", extra={t.path for t in targets if t.root == r}) for r in ROOTS}

        def run():
            try:
                heads = {r: f.result() for r, f in futures.items()}
                if row["status"] == "done" and not self._halt.is_set() and self._job_results(row, targets, heads):
                    self.db.x("delete from prov_job_pending where job_id = ?", jid)
            except Exception as exc:
                self.failure(lid, exc)
            finally:
                with self._lock:
                    self._jobs.pop(jid, None)
                    self._threads.discard(threading.current_thread())
                done.set_result(None)

        with self._lock:
            if self._halt.is_set():
                self._jobs.pop(jid, None)
                done.set_result(None)
                return done
            thread = threading.Thread(target=run, daemon=True, name="prov-" + jid)
            self._threads.add(thread)
            thread.start()
            return done

    def _job_results(self, row, targets, heads):
        lid = row["line_id"]
        agent = self.town.agents.get(row["submitted_by"]) or {"who": "你" if row["submitted_by"] == "you" else EXTERNAL}
        job = self.job(lid, row["id"])
        complete = True
        for spec in targets:
            if not heads[spec.root]:
                complete = False
                continue
            try:
                with self.db.transaction():
                    self._file(lid, spec, heads, agent, job=job, basis=row.get("basis") or [])
            except (OSError, ProvError) as exc:
                self.failure(lid, exc)
                complete = False
        p = self.s.jobs_dir / row["id"] / "result.json"
        if p.is_file() and not p.is_symlink() and not p.parent.is_symlink():
            repo = self.repo(lid, "code")
            self._init(lid)
            size = p.stat().st_size
            if size > self.s.prov_file_bytes:
                blob = file_hash(p, size)
                raw = f"Papertown large file\nsize {size}\nblob {blob}\n".encode()
            else:
                raw, blob = p.read_bytes(), None
            stored = repo.git("hash-object", "-w", "--stdin", data=raw).strip().decode()
            with self.db.transaction():
                self._record(lid, "result", f"jobs/{row['id']}/result.json", blob or stored, agent, op=heads["code"],
                             job=job, basis=row.get("basis") or [], stored=stored)
        return complete

    def analysis(self, lid: str, baseline: bool = False) -> Analysis:
        self._line(lid)
        roots = self.roots(lid)
        heads = {r: self.head(lid, r) for r in ROOTS}
        if baseline and self.s.prov:
            futures = {r: self.request(lid, r, "base") for r in roots if not heads[r]}
            for r, f in futures.items():
                if f.result():
                    heads[r] = self.head(lid, r)
        revision = self.db.val("select max(rowid) from prov where line_id = ?", lid)
        key = ([h and h["id"] for h in heads.values()], roots, revision)
        cached = self._cache.get(lid)
        if cached and cached[0] == key and cached[1].job_files_current():
            return cached[1]
        analysis = Analysis(self, lid, roots, heads)
        self._cache[lid] = key, analysis
        return analysis

    def card(self, lid):
        return self.analysis(lid).view["stats"] | {"recent": self.ops(lid, limit=3)}
