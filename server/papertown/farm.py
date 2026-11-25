"""The experiment farm: one job board for every experiment (local commands and nvidb read only),
with a monitor per project that notes each job's progress. A local job prints `PROGRESS <0-100>` and
`RESULT {json}`, or writes $PAPERTOWN_JOB_DIR/result.json.
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

from .db import now

if TYPE_CHECKING:
    from .town import Town

BACKENDS = {
    "local": {"name": "本地执行器", "ready": True, "note": "在项目的代码目录里直接运行命令"},
    "nvidb": {"name": "nvidb", "ready": False, "note": "你自己机器上的 GPU 队列（只读）：显卡和任务显示在这里，提交用 nvidb job submit"},
}
PROGRESS = re.compile(r"^\s*PROGRESS\s+(\d{1,3})\b")
RESULT = re.compile(r"^\s*RESULT\s+(\{.*\})\s*$")


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
        for j in self.db.q("select id from jobs where status in ('queued', 'running')"):
            self._set(j["id"], status="failed", note="服务重启，任务被中断", ended_at=now())

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
        out = [{"id": k, **v, "active": counts.get(k, 0)} for k, v in BACKENDS.items()]
        nv = self.town.nvidb.status()
        for b in out:
            if b["id"] == "nvidb":
                sm = nv["summary"]
                b["ready"] = nv["ok"]
                b["active"] = nv["counts"].get("running", 0)
                b["note"] = (f"{sm['up']}/{sm['nodes']} 台机器在线 · {sm['gpus']} 张卡 · {sm['idle']} 张空闲，{sm['room']} 张还放得下任务"
                             f"（只读：提交用 nvidb job submit）") if nv["ok"] else nv["note"]
        return out

    def submit(self, line_id: str | None, name: str, command: str, backend: str = "local", submitted_by: str | None = None,
               cwd: str | None = None, basis: list[str] | None = None, outs: list[str] | None = None) -> dict:
        if backend not in BACKENDS:
            raise FarmError(f"没有这个后端：{backend}")
        if backend == "nvidb":
            raise FarmError("nvidb 只读接入：在这里看显卡和任务，提交请在终端里用 nvidb job submit")
        command = (command or "").strip()
        if not command:
            raise FarmError("command 不能为空")
        if (self.town.agents.get(submitted_by) or {}).get("role") == "lead":
            cwd = None
        basis = self.town.decided.basis(line_id, basis)
        workdir = Path(cwd) if cwd else (self.town.linked.workdir(line_id, "coder") or self.town.s.projects_dir / line_id / "code" if line_id else self.dir)
        workdir.mkdir(parents=True, exist_ok=True)
        job_id = f"job_{uuid.uuid4().hex[:8]}"
        row = {"id": job_id, "line_id": line_id, "name": (name or "job")[:60], "backend": backend, "status": "queued", "progress": 0,
               "command": command, "cwd": str(workdir), "config": {}, "result": None, "note": None, "submitted_by": submitted_by,
               "created_at": now("microseconds"), "started_at": None, "ended_at": None, "outs": list(dict.fromkeys(outs or []))}
        self.town.prov.request(line_id, "paper", "submit")
        row["op"] = self.town.prov.request(line_id, "code", "submit").result()
        with self.db.transaction():
            row["basis"] = self.town.decided.basis(line_id, basis)
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
        # marked first: the runner looks at the status once the process has gone, and must find it cancelled, not failed
        self._set(job_id, status="cancelled", ended_at=now(), note="已取消")
        p = self._procs.get(job_id)
        if p and p.poll() is None:
            os.killpg(p.pid, signal.SIGTERM)
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
                limit = self.town.s.local_job_timeout  # 0: no limit
                timer = threading.Timer(limit, lambda: p.poll() is None and os.killpg(p.pid, signal.SIGTERM)) if limit > 0 else None
                if timer:
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
                if timer:
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

    def _set(self, job_id: str, **fields) -> None:
        with self.db.transaction():
            before = self.db.one("select line_id, status, progress from jobs where id = ?", job_id)
            self.db.update("jobs", {"id": job_id}, **fields)
            finish = before["line_id"] and self.town.s.prov and fields.get("status") in ("done", "failed", "cancelled") and fields["status"] != before["status"]
            if finish and fields["status"] == "done":
                self.db.x("insert or ignore into prov_job_pending values (?)", job_id)
        if finish:
            self.town.prov.finish_job(self.get(job_id))
        self._changed(job_id, before)

    def _changed(self, job_id: str, before: dict | None = None) -> None:
        j = self.get(job_id)
        self.town.bus.publish("job", job=j)
        if j["line_id"]:
            self._monitor(j, before)

    def _monitor(self, j: dict, before: dict | None) -> None:
        status = j["status"]
        note = None
        if before is None:
            where = BACKENDS.get(j["backend"], {}).get("name", j["backend"])
            note = f"收到任务「{j['name']}」，排进{where}的队列。"
        elif status != before["status"]:
            if status == "running":
                note = f"「{j['name']}」开始跑了。"
            elif status == "done":
                note = f"「{j['name']}」跑完了。{summarize(j)}"
            elif status == "failed":
                tail = self.log(j["id"], 3).strip().splitlines()
                note = f"「{j['name']}」失败：{j.get('note') or ''}" + (f"，日志最后一行：{tail[-1][:120]}" if tail else "")
            elif status == "cancelled":
                note = f"「{j['name']}」被取消了。"
        elif before["progress"] < 50 <= j["progress"] < 100:
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
