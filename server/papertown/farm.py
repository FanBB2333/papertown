"""The experiment farm: one job board for every experiment, whoever submitted it.

Backends behind the same submit / list / cancel calls:
  sim    the simulated plant the offline pipeline uses (compute.py); mirrored here
  local  a shell command run in the project's code workspace, output kept as a log
  nvidb  the shared GPU queue; not wired up yet, listed so the board shows where it goes

A local job reports progress by printing `PROGRESS <0-100>` and its result by printing
`RESULT {json}` or writing `$PAPERTOWN_JOB_DIR/result.json`.

Each project also gets a monitor on the farm: a small built-in agent that watches its
jobs and writes a note when one is queued, starts, passes halfway, finishes or fails.
"""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import threading
import uuid
from pathlib import Path
from typing import TYPE_CHECKING

from .compute import Job
from .db import now

if TYPE_CHECKING:
    from .town import Town

BACKENDS = {
    "local": {"name": "本地执行器", "ready": True, "note": "在项目的代码目录里直接运行命令"},
    "sim": {"name": "模拟电厂", "ready": True, "note": "离线流水线用的模拟 GPU，结果都标着「模拟」"},
    "nvidb": {"name": "nvidb", "ready": False, "note": "统一的 GPU 任务队列，以后在这里接入提交和管理"},
}
PROGRESS = re.compile(r"^\s*PROGRESS\s+(\d{1,3})\b")
RESULT = re.compile(r"^\s*RESULT\s+(\{.*\})\s*$")
TIMEOUT = 3600


class FarmError(Exception):
    pass


class Farm:
    def __init__(self, town: "Town"):
        self.town = town
        self.db = town.db
        self.dir = town.s.jobs_dir
        self.dir.mkdir(parents=True, exist_ok=True)
        self._procs: dict[str, subprocess.Popen] = {}
        self._slots = threading.Semaphore(max(1, town.s.local_jobs))

    def recover(self) -> None:
        for j in self.db.q("select id from jobs where backend != 'sim' and status in ('queued', 'running')"):
            self._set(j["id"], status="failed", note="服务重启，任务被中断", ended_at=now())
        # the simulated plant keeps jobs in memory only
        for j in self.db.q("select id from jobs where backend = 'sim' and status in ('queued', 'running')"):
            self._set(j["id"], status="failed", note="服务重启，任务被中断", ended_at=now())

    # ---------- reading ----------

    def get(self, job_id: str, tail: int = 0) -> dict | None:
        j = self.db.one("select * from jobs where id = ?", job_id)
        if j and tail:
            j["log"] = self.log(job_id, tail)
        return j

    def list(self, line_id: str | None = None, limit: int = 200) -> list[dict]:
        if line_id:
            return self.db.q("select * from jobs where line_id = ? order by created_at desc limit ?", line_id, limit)
        return self.db.q("select * from jobs order by created_at desc limit ?", limit)

    def log(self, job_id: str, tail: int = 200) -> str:
        p = self.dir / job_id / "log.txt"
        if not p.exists():
            return ""
        return "\n".join(p.read_text(encoding="utf-8", errors="replace").splitlines()[-tail:])

    def backends(self) -> list[dict]:
        counts = {r["backend"]: r["n"] for r in self.db.q("select backend, count(*) n from jobs where status in ('queued', 'running') group by backend")}
        return [{"id": k, **v, "active": counts.get(k, 0)} for k, v in BACKENDS.items()]

    # ---------- submitting ----------

    def submit(self, line_id: str | None, name: str, command: str, backend: str = "local", submitted_by: str | None = None,
               cwd: str | None = None) -> dict:
        if backend not in BACKENDS:
            raise FarmError(f"没有这个后端：{backend}")
        if not BACKENDS[backend]["ready"]:
            raise FarmError(f"{BACKENDS[backend]['name']} 还没接入，先用 local")
        if backend == "sim":
            raise FarmError("模拟电厂只给离线流水线用")
        command = (command or "").strip()
        if not command:
            raise FarmError("command 不能为空")
        workdir = Path(cwd) if cwd else (self.town.s.projects_dir / line_id / "code" if line_id else self.dir)
        workdir.mkdir(parents=True, exist_ok=True)
        job_id = f"job_{uuid.uuid4().hex[:8]}"
        row = {"id": job_id, "line_id": line_id, "name": (name or "job")[:60], "backend": backend, "status": "queued", "progress": 0,
               "command": command, "cwd": str(workdir), "config": {}, "result": None, "note": None, "submitted_by": submitted_by,
               "created_at": now(), "started_at": None, "ended_at": None}
        self.db.insert("jobs", row)
        self._changed(job_id)
        threading.Thread(target=self._run_local, args=(job_id,), daemon=True, name=f"job-{job_id}").start()
        return self.get(job_id)

    def cancel(self, job_id: str) -> dict:
        j = self.get(job_id)
        if not j:
            raise FarmError("没有这个任务")
        if j["status"] not in ("queued", "running"):
            raise FarmError("任务已经结束")
        if j["backend"] != "local":
            raise FarmError("这个后端的任务不能取消")
        p = self._procs.get(job_id)
        if p and p.poll() is None:
            os.killpg(p.pid, signal.SIGTERM)
        self._set(job_id, status="cancelled", ended_at=now(), note="已取消")
        return self.get(job_id)

    def _run_local(self, job_id: str) -> None:
        with self._slots:
            j = self.get(job_id)
            if not j or j["status"] != "queued":
                return
            jdir = self.dir / job_id
            jdir.mkdir(parents=True, exist_ok=True)
            env = {**os.environ, "PAPERTOWN_JOB_ID": job_id, "PAPERTOWN_JOB_DIR": str(jdir), "PYTHONUNBUFFERED": "1"}
            self._set(job_id, status="running", started_at=now())
            result = None
            with open(jdir / "log.txt", "w", encoding="utf-8") as log:
                try:
                    p = subprocess.Popen(["/bin/bash", "-c", j["command"]], cwd=j["cwd"], env=env, stdout=subprocess.PIPE,
                                         stderr=subprocess.STDOUT, text=True, bufsize=1, start_new_session=True)
                except OSError as e:
                    self._set(job_id, status="failed", ended_at=now(), note=str(e))
                    return
                self._procs[job_id] = p
                timer = threading.Timer(TIMEOUT, lambda: p.poll() is None and os.killpg(p.pid, signal.SIGTERM))
                timer.start()
                last = 0
                for line in p.stdout:
                    log.write(line)
                    log.flush()
                    if m := PROGRESS.match(line):
                        pct = min(100, int(m.group(1)))
                        if pct != last:
                            last = pct
                            self._set(job_id, progress=pct)
                    elif m := RESULT.match(line):
                        try:
                            result = json.loads(m.group(1))
                        except ValueError:
                            pass
                code = p.wait()
                timer.cancel()
                self._procs.pop(job_id, None)
            if (jdir / "result.json").exists():
                try:
                    result = json.loads((jdir / "result.json").read_text(encoding="utf-8"))
                except ValueError:
                    pass
            if self.get(job_id)["status"] == "cancelled":
                return
            if code == 0:
                self._set(job_id, status="done", progress=100, result=result, ended_at=now())
            else:
                self._set(job_id, status="failed", result=result, ended_at=now(), note=f"退出码 {code}")

    # ---------- the simulated plant, mirrored ----------

    def sync_sim(self, job: Job) -> None:
        row = self.db.one("select id, status from jobs where id = ?", job.id)
        fields = {"status": job.status, "progress": job.progress, "result": job.result}
        if job.status == "running" and (not row or row["status"] != "running"):
            fields["started_at"] = now()
        if job.status == "done":
            fields["ended_at"] = now()
        if not row:
            self.db.insert("jobs", {"id": job.id, "line_id": job.line_id, "name": job.name, "backend": "sim", "command": None,
                                    "cwd": None, "config": job.config, "submitted_by": "pipeline", "created_at": now(),
                                    "note": None, "started_at": None, "ended_at": None, **fields})
            self._changed(job.id)
        else:
            self._set(job.id, **fields)

    # ---------- changes and the monitors ----------

    def _set(self, job_id: str, **fields) -> None:
        before = self.db.one("select status, progress from jobs where id = ?", job_id)
        self.db.update("jobs", {"id": job_id}, **fields)
        self._changed(job_id, before)

    def _changed(self, job_id: str, before: dict | None = None) -> None:
        j = self.get(job_id)
        if not j:
            return
        self.town.bus.publish("job", job=j)
        if j["line_id"]:
            self._monitor(j, before)

    def _monitor(self, j: dict, before: dict | None) -> None:
        status, prev = j["status"], (before or {}).get("status")
        note = None
        where = BACKENDS.get(j["backend"], {}).get("name", j["backend"])
        if before is None:
            note = f"收到任务「{j['name']}」，排进{where}的队列。"
        elif status != prev:
            if status == "running":
                note = f"「{j['name']}」开始跑了。"
            elif status == "done":
                note = f"「{j['name']}」跑完了。{summarize(j)}"
            elif status == "failed":
                tail = self.log(j["id"], 3).strip().splitlines()
                note = f"「{j['name']}」失败：{j.get('note') or ''}" + (f"，日志最后一行：{tail[-1][:120]}" if tail else "")
            elif status == "cancelled":
                note = f"「{j['name']}」被取消了。"
        elif (before or {}).get("progress", 0) < 50 <= j["progress"] < 100:
            note = f"「{j['name']}」过半了（{j['progress']}%）。"
        if note:
            self.town.agents.monitor_note(j["line_id"], note, job_id=j["id"])


def summarize(j: dict) -> str:
    r = j.get("result")
    if not isinstance(r, dict):
        return "没有写出结果。"
    if r.get("rows") and r.get("metrics"):
        ours = next((x for x in r["rows"] if x.get("ours")), r["rows"][-1])
        vals = "，".join(f"{m} {v}" for m, v in zip(r["metrics"], ours["values"]))
        return f"{ours['method']}：{vals}" + ("（模拟）" if r.get("simulated") else "")
    flat = [f"{k} {v}" for k, v in r.items() if isinstance(v, (int, float, str)) and k != "simulated"][:4]
    return "结果：" + "，".join(flat) if flat else "结果已写出。"
