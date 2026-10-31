"""The GPUs on your own machines, read from nvidb's job queue. Read only.

nvidb keeps every node's cards, what runs on them, its queue of jobs and the lanes they
wait in (a lane: one GPU, or a few, and the order it runs its jobs) in one SQLite file,
kept fresh by its keeper. Papertown reads it with `nvidb queue status --json
--no-tick`, which never contacts the nodes itself, at most every few seconds, and shows
it on the farm and at the power plant. Nothing is submitted, cancelled or acknowledged
from here; jobs are still submitted with `nvidb job submit`.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

from .config import Settings

TTL = 8  # seconds a reading is reused
# nvidb's job states as the farm names them
STATE = {"pending": "queued", "running": "running", "completed": "done", "failed": "failed", "lost": "failed",
         "timeout": "failed", "cancelled": "cancelled"}


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
        "state": state,
        "procs": [{"user": p.get("user"), "name": Path(p.get("name") or "").name, "mem_mb": p.get("mem_mb"), "managed": p.get("managed"),
                   "job_id": p.get("job_id"), "job_name": p.get("job_name")} for p in g.get("processes") or [] if (p.get("mem_mb") or 0) > 64],
    }


def _job(j: dict) -> dict:
    return {
        "id": j["id"], "name": j.get("name") or f"job {j['id']}", "state": j.get("state"), "node": j.get("node"),
        "gpu_ids": j.get("gpu_ids") or [], "lane": j.get("lane"), "vram_mb": j.get("vram_mb") or 0, "progress": j.get("progress"),
        "submitter": j.get("submitter"), "workdir": j.get("workdir"), "command": (j.get("command") or "")[:400],
        "notes": (j.get("notes") or "")[:400], "held": bool(j.get("held")), "created_at": j.get("created_at"),
        "started_at": j.get("started_at"), "finished_at": j.get("finished_at"), "elapsed_s": j.get("elapsed_s"),
        "exit_code": j.get("exit_code"), "last_error": (j.get("last_error") or "")[:400],
        # where it may go: a lane, a pool, or any card that fits; what it waits for
        "pool": j.get("pool"), "lane_seq": j.get("lane_seq"), "node_constraint": j.get("node_constraint"),
        "gpu_constraint": j.get("gpu_constraint") or [], "gpus": j.get("gpus", 1), "priority": j.get("priority") or 0,
        "depends_on": j.get("depends_on") or [], "held_reason": j.get("held_reason"), "gpu_mem_mb": j.get("gpu_mem_mb"),
        "max_runtime_s": j.get("max_runtime_s"), "progress_at": j.get("progress_at"),
        "result": _result(j.get("result")),  # what a finished job handed back in result.json
    }


def _result(r):
    if r is None:
        return None
    s = json.dumps(r, ensure_ascii=False)
    return r if len(s) <= 6000 else {"_truncated": s[:6000]}


def _lane(ln: dict) -> dict:
    return {"name": ln["name"], "node": ln.get("node"), "gpu_ids": ln.get("gpu_ids") or [], "paused": bool(ln.get("paused")),
            "concurrency": ln.get("concurrency") or 1, "runner_up": ln.get("runner_up"), "blocked": ln.get("blocked"),
            "running": [j["id"] for j in ln.get("running") or []], "queued": [j["id"] for j in ln.get("queued") or []]}  # in running order


class Nvidb:
    def __init__(self, s: Settings):
        self.s = s
        self.bin = s.nvidb_bin or shutil.which("nvidb")
        self._lock = threading.Lock()
        self._at = 0.0
        self._last: dict | None = None

    def _off(self, note: str) -> dict:
        return {"ok": False, "note": note, "at": None, "nodes": [], "jobs": [], "lanes": [], "pools": [], "summary": None, "counts": {},
                "alerts": 0}

    def status(self, fresh: bool = False) -> dict:
        if not self.s.nvidb:
            return self._off("没有接入（PAPERTOWN_NVIDB=0）")
        if not self.bin or not Path(self.bin).exists():
            return self._off("没找到 nvidb 命令：装好后放进 PATH，或者设 PAPERTOWN_NVIDB_BIN")
        with self._lock:
            if not fresh and self._last is not None and time.time() - self._at < TTL:
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
                          "last_error": n.get("last_error"), "gpus": [_gpu(g) for g in n.get("gpus") or []]})
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
        return {"ok": True, "note": "", "at": d.get("generated_at"), "ticked": d.get("last_tick_at"), "nodes": nodes, "jobs": jobs,
                "lanes": [_lane(ln) for ln in lanes], "pools": pools, "summary": summary, "counts": d.get("counts") or {}, "alerts": d.get("open_alerts") or 0}

    def jobs_matching(self, patterns: list[str]) -> list[dict]:
        """Jobs whose working directory, name or submitter mentions one of the patterns."""
        pats = [p.lower() for p in patterns if p]
        out = []
        for j in self.status()["jobs"]:
            hay = " ".join(str(j.get(k) or "") for k in ("workdir", "name", "submitter")).lower()
            if any(p in hay for p in pats):
                out.append(j)
        return out


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
