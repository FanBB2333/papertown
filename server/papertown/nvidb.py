"""The GPUs on your own machines, read only from nvidb's job queue with `--json --no-tick` commands that never
contact the nodes, polled in the background. Adds what nvidb does not keep: each card's last hour of utilisation
and memory, and when each process on a card was first seen.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import threading
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

from .config import Settings

TTL = 8  # seconds a reading is reused when nothing reads in the background
TREND_S = 3600  # how far back each card's utilisation and memory are kept
TREND_N = 240  # at most this many of them go to the page
HIST_TTL = 45  # the job history changes slowly and is a bigger read
HIST_N = 1000  # how many of the newest jobs the history keeps
# nvidb's job states as the farm names them
STATE = {"pending": "queued", "running": "running", "completed": "done", "failed": "failed", "lost": "failed",
         "timeout": "failed", "cancelled": "cancelled"}


def mentions(job: dict, patterns: list[str]) -> bool:
    """Whether a queue job mentions any of a linked project's names or paths."""
    hay = " ".join(str(job.get(k) or "") for k in ("workdir", "name", "submitter", "notes", "command")).lower()
    return any(p.lower() in hay for p in patterns if p)


def _gpu(g: dict) -> dict:
    total = g.get("mem_total_mb") or 0
    used = g.get("mem_used_mb") or 0
    util = g.get("util_percent") or 0
    free = g.get("free_mb") or 0
    # idle: nothing much on it at all; room: a job of a few GB would be placed there
    state = "idle" if util < 10 and used < 0.05 * total else "room" if free >= 8192 else "full"
    return {
        "index": g.get("index"), "name": (g.get("name") or "").removeprefix("NVIDIA "), "mem_total_mb": total, "mem_used_mb": used,
        "free_mb": free, "util_percent": util, "temperature_c": g.get("temperature_c"), "queue_mem_mb": g.get("queue_mem_mb") or 0,
        "external_mem_mb": g.get("external_mem_mb") or 0, "reserved_mb": g.get("reserved_mb") or 0, "attribution": g.get("attribution"),
        "state": state, "updated_at": g.get("updated_at"),
        "procs": [{"pid": p.get("pid"), "user": p.get("user"), "name": Path(p.get("name") or "").name, "mem_mb": p.get("mem_mb"),
                   "managed": p.get("managed"), "job_id": p.get("job_id"), "job_name": p.get("job_name")}
                  for p in g.get("processes") or [] if (p.get("mem_mb") or 0) > 64],
    }


def _epoch(ts: str | None) -> float | None:
    try:
        return datetime.fromisoformat(ts).timestamp() if ts else None
    except ValueError:
        return None


def _iso(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).isoformat(timespec="seconds")


def _job(j: dict) -> dict:
    return {
        "id": j["id"], "name": j.get("name") or f"job {j['id']}", "state": j.get("state"), "node": j.get("node"),
        "gpu_ids": j.get("gpu_ids") or [], "lane": j.get("lane"), "vram_mb": j.get("vram_mb") or 0, "progress": j.get("progress"),
        "submitter": j.get("submitter"), "workdir": j.get("workdir"), "command": (j.get("command") or "")[:400],
        "notes": (j.get("notes") or "")[:400], "held": bool(j.get("held")), "created_at": j.get("created_at"),
        "started_at": j.get("started_at"), "finished_at": j.get("finished_at"), "elapsed_s": j.get("elapsed_s"),
        "exit_code": j.get("exit_code"), "last_error": (j.get("last_error") or "")[:400],
        "pool": j.get("pool"), "lane_seq": j.get("lane_seq"), "node_constraint": j.get("node_constraint"),
        "gpu_constraint": j.get("gpu_constraint") or [], "gpus": j.get("gpus", 1), "priority": j.get("priority") or 0,
        "depends_on": j.get("depends_on") or [], "held_reason": j.get("held_reason"), "gpu_mem_mb": j.get("gpu_mem_mb"),
        "max_runtime_s": j.get("max_runtime_s"), "progress_at": j.get("progress_at"),
        "result": _result(j.get("result")),
    }


def _result(r):
    if r is None:
        return None
    s = json.dumps(r, ensure_ascii=False)
    return r if len(s) <= 6000 else {"_truncated": s[:6000]}


def _lane(ln: dict) -> dict:
    return {"name": ln["name"], "node": ln.get("node"), "gpu_ids": ln.get("gpu_ids") or [], "paused": bool(ln.get("paused")),
            "concurrency": ln.get("concurrency") or 1, "runner_up": ln.get("runner_up"), "blocked": ln.get("blocked"),
            "running": [j["id"] for j in ln.get("running") or []], "queued": [j["id"] for j in ln.get("queued") or []]}


class Nvidb:
    def __init__(self, s: Settings):
        self.s = s
        self.bin = s.nvidb_bin or shutil.which("nvidb")
        self._lock = threading.Lock()
        self._at = 0.0
        self._last: dict | None = None
        self._hist_lock = threading.Lock()
        self._hist_at = 0.0
        self._hist: list[dict] = []
        self.poll = max(2.0, float(s.nvidb_poll or 10))
        self._thread: threading.Thread | None = None
        self._halt = threading.Event()
        self._trend: dict[str, deque] = {}  # "node:gpu" -> (when, util %, memory used MB), oldest first
        self._seen: dict[tuple, float] = {}  # (node, gpu, pid) -> when Papertown first saw that process
        self._first = 0.0  # Papertown's first reading: processes already there then are marked `earlier`

    def _usable(self) -> bool:
        return bool(self.s.nvidb and self.bin and Path(self.bin).exists())

    def start(self) -> None:
        """Read the queue every few seconds in the background, for as long as the server runs."""
        if self._thread or not self._usable():
            return
        self._thread = threading.Thread(target=self._loop, daemon=True, name="nvidb")
        self._thread.start()

    def stop(self) -> None:
        self._halt.set()

    def _loop(self) -> None:
        while not self._halt.is_set():
            self.status(fresh=True)
            self._halt.wait(self.poll)

    def _off(self, note: str) -> dict:
        return {"ok": False, "note": note, "at": None, "nodes": [], "jobs": [], "lanes": [], "pools": [], "summary": None, "counts": {},
                "alerts": 0}

    def status(self, fresh: bool = False) -> dict:
        if not self.s.nvidb:
            return self._off("没有接入（PAPERTOWN_NVIDB=0）")
        if not self.bin or not Path(self.bin).exists():
            return self._off("没找到 nvidb 命令：装好后放进 PATH，或者设 PAPERTOWN_NVIDB_BIN")
        with self._lock:
            # with the background reader running a request never waits for nvidb; without it, a reading lasts TTL
            ttl = self.poll * 2 + 5 if self._thread else TTL
            if not fresh and self._last is not None and time.time() - self._at < ttl:
                return self._last
            self._last = self._read()
            self._at = time.time()
            return self._last

    def _read(self) -> dict:
        try:
            r = subprocess.run([self.bin, "queue", "status", "--json", "--no-tick"], capture_output=True, text=True, timeout=15)
            d = json.loads(r.stdout)
        except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError) as e:
            return self._off(f"读不到 nvidb 的队列：{type(e).__name__}")
        if r.returncode != 0 or not isinstance(d, dict) or "nodes" not in d:
            return self._off(f"nvidb 出错了：{(r.stderr or r.stdout).strip()[:200]}")
        nodes = []
        for n in d.get("nodes") or []:
            if n.get("ignored"):
                continue
            nodes.append({"name": n["name"], "state": n.get("state"), "enabled": n.get("enabled", True), "last_seen": n.get("last_seen"),
                          "probed_at": n.get("probed_at"), "last_error": n.get("last_error"), "gpus": [_gpu(g) for g in n.get("gpus") or []]})
        self._remember(nodes)
        jobs, seen = [], set()
        names = {n["name"] for n in nodes}
        lanes = [ln for ln in d.get("lanes") or [] if ln.get("node") in names]
        for j in ((d.get("jobs") or []) + (d.get("held") or []) + (d.get("recent") or [])
                  + [j for ln in lanes for j in (ln.get("running") or []) + (ln.get("queued") or [])]):
            if j["id"] not in seen:
                seen.add(j["id"])
                jobs.append(_job(j))
        pools = [{"name": p["name"], "members": [{"node": m["node"], "gpus": [g["index"] for g in m.get("gpus") or []]}
                                                 for m in p.get("members") or [] if m.get("node") in names]}
                 for p in d.get("pools") or []]
        gpus = [g for n in nodes if n["state"] == "up" for g in n["gpus"]]
        summary = {"nodes": len(nodes), "up": sum(1 for n in nodes if n["state"] == "up"), "gpus": len(gpus),
                   "idle": sum(1 for g in gpus if g["state"] == "idle"), "room": sum(1 for g in gpus if g["state"] != "full"),
                   "free_mb": sum(g["free_mb"] for g in gpus), "total_mb": sum(g["mem_total_mb"] for g in gpus)}
        return {"ok": True, "note": "", "at": d.get("generated_at"), "ticked": d.get("last_tick_at"), "polled_at": _iso(time.time()),
                "poll_s": self.poll, "nodes": nodes, "jobs": jobs,
                "lanes": [_lane(ln) for ln in lanes], "pools": pools, "summary": summary, "counts": d.get("counts") or {}, "alerts": d.get("open_alerts") or 0}

    def _remember(self, nodes: list[dict]) -> None:
        """Add this reading to each card's trend and note the processes seen for the first time; hand both back on the cards."""
        now = time.time()
        self._first = self._first or now
        here = set()
        for n in nodes:
            for g in n["gpus"]:
                key = f"{n['name']}:{g['index']}"
                t = _epoch(g.get("updated_at")) or now
                tr = self._trend.setdefault(key, deque())
                if not tr or t > tr[-1][0]:
                    tr.append((t, g["util_percent"], g["mem_used_mb"]))
                while tr and tr[0][0] < now - TREND_S:
                    tr.popleft()
                step = max(1, -(-len(tr) // TREND_N))
                g["trend"] = [[int(a), b, c] for a, b, c in list(tr)[::-1][::step][::-1]]  # the newest always kept
                for p in g["procs"]:
                    k = (n["name"], g["index"], p.get("pid") or p.get("name"))  # WSL may name no pid
                    here.add(k)
                    seen = self._seen.setdefault(k, now)
                    p["seen_since"], p["earlier"] = _iso(seen), seen <= self._first
        up = {n["name"] for n in nodes if n["state"] == "up"}  # a card that could not be read keeps what it had
        for k in [k for k in self._seen if k[0] in up and k not in here]:
            del self._seen[k]

    def history(self) -> list[dict]:
        """The newest jobs in the queue's database, finished ones included; [] when it can't be read."""
        if not self._usable():
            return []
        with self._hist_lock:
            if time.time() - self._hist_at < HIST_TTL:
                return self._hist
            try:
                r = subprocess.run([self.bin, "job", "ls", "--json", "--no-tick", "-n", str(HIST_N)], capture_output=True, text=True, timeout=30)
                d = json.loads(r.stdout) if r.returncode == 0 else {}
                self._hist = [_job(j) for j in (d.get("jobs") or [] if isinstance(d, dict) else [])]
            except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
                self._hist = []
            self._hist_at = time.time()
            return self._hist

    def show(self, job_id: int) -> dict | None:
        """One job in full, with its events: what a person reads to see why it ran the way it did."""
        if not self._usable():
            return None
        try:
            r = subprocess.run([self.bin, "job", "show", str(int(job_id)), "--json", "--no-tick"], capture_output=True, text=True, timeout=15)
            j = json.loads(r.stdout) if r.returncode == 0 else None
        except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError, ValueError):
            return None
        if not isinstance(j, dict) or "id" not in j:
            return None
        return {**_job(j), "command": (j.get("command") or "")[:6000], "notes": (j.get("notes") or "")[:3000],
                "last_error": (j.get("last_error") or "")[:6000], "tags": j.get("tags") or [], "attempt": j.get("attempt"),
                "events": [{"ts": e.get("ts"), "kind": e.get("kind"), "node": e.get("node"), "message": (e.get("message") or "")[:600]}
                           for e in (j.get("events") or [])[-60:]]}

    def jobs_matching(self, patterns: list[str]) -> list[dict]:
        """Jobs whose working directory, name, submitter, note or command mentions one of the patterns: the
        queue's live ones first, then the history behind them, newest first."""
        pats = [p.lower() for p in patterns if p]
        if not pats:
            return []
        out, seen = [], set()
        for j in self.status()["jobs"] + self.history():
            if j["id"] in seen:
                continue
            if mentions(j, pats):
                seen.add(j["id"])
                out.append(j)
        return sorted(out, key=lambda j: -j["id"])


def as_farm_job(j: dict, line_id: str | None) -> dict:
    """An nvidb job in the shape of a farm job, for the boards; it stays nvidb's to manage."""
    st = STATE.get(j["state"], j["state"])
    prog = 100 if st == "done" else 0
    if st == "running":  # a job's status line, when it writes one: "epoch 3/10", "42%"
        line = str(j.get("progress") or "")
        m = re.search(r"(\d+(?:\.\d+)?)\s*%", line) or re.search(r"(\d+)\s*/\s*(\d+)", line)
        prog = 50 if not m else int(float(m.group(1))) if m.lastindex == 1 else int(100 * int(m.group(1)) / max(1, int(m.group(2))))
        prog = max(1, min(99, prog))
    where = f"{j['node']}:{','.join(map(str, j['gpu_ids']))}" if j.get("node") else (j.get("lane") or "等分配")
    note = " · ".join(x for x in [where, str(j["progress"]) if isinstance(j.get("progress"), str) else "",
                                  "被依赖卡住" if j.get("held") else "", j.get("last_error") or ""] if x)
    return {"id": f"nvidb-{j['id']}", "line_id": line_id, "name": j["name"], "backend": "nvidb", "status": st, "progress": prog,
            "command": j.get("command"), "cwd": j.get("workdir"), "config": None, "result": None, "note": note or None,
            "submitted_by": j.get("submitter"), "created_at": j.get("created_at"), "started_at": j.get("started_at"),
            "ended_at": j.get("finished_at"), "external": True, "nvidb": j}
