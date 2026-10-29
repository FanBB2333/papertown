"""Power plants: where experiments get their GPUs.

Only the simulated plant is built so far. It accepts jobs, "runs" them for a few
seconds with progress events, and returns a results table generated from a seeded
random model. Every number it produces is marked simulated, and the paper and the
UI say so; a real GPU backend implements the same three calls (status/submit/wait).
"""

from __future__ import annotations

import hashlib
import random
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Callable


@dataclass
class Job:
    id: str
    line_id: str | None
    name: str
    config: dict
    gpus: int
    status: str = "queued"
    progress: int = 0
    result: dict | None = None
    created: float = field(default_factory=time.time)


class SimulatedPlant:
    name = "模拟电厂"
    kind = "simulated"

    def __init__(self, seconds: float = 6.0, gpus: int = 4, on_change: Callable[[Job], None] | None = None):
        self.seconds = seconds
        self.total = gpus
        self.jobs: dict[str, Job] = {}
        self.on_change = on_change or (lambda j: None)
        self._lock = threading.Lock()

    def status(self) -> dict:
        with self._lock:
            running = [j for j in self.jobs.values() if j.status == "running"]
            queued = [j for j in self.jobs.values() if j.status == "queued"]
            used = sum(j.gpus for j in running)
        return {"backend": self.kind, "name": self.name, "gpus": self.total, "busy": used,
                "load": round(100 * used / self.total), "running": len(running), "queued": len(queued),
                "summary": f"{used}/{self.total} 卡在用，排队 {len(queued)}"}

    def submit(self, line_id: str | None, name: str, config: dict, gpus: int = 1) -> Job:
        job = Job(f"job_{uuid.uuid4().hex[:8]}", line_id, name, config, max(1, min(gpus, self.total)))
        with self._lock:
            self.jobs[job.id] = job
        threading.Thread(target=self._run, args=(job,), daemon=True).start()
        return job

    def _run(self, job: Job) -> None:
        while True:  # wait for free cards
            with self._lock:
                used = sum(j.gpus for j in self.jobs.values() if j.status == "running")
                if used + job.gpus <= self.total:
                    job.status = "running"
                    break
            time.sleep(0.2)
        self.on_change(job)
        steps = 5
        for i in range(1, steps + 1):
            time.sleep(self.seconds / steps)
            job.progress = int(100 * i / steps)
            self.on_change(job)
        job.result = simulate_results(job)
        job.status = "done"
        self.on_change(job)

    def wait(self, job_id: str, timeout: float = 300) -> Job:
        job = self.jobs.get(job_id)
        if not job:
            raise KeyError(f"没有这个任务：{job_id}")
        t0 = time.time()
        while job.status != "done" and time.time() - t0 < timeout:
            time.sleep(0.1)
        return job


def simulate_results(job: Job) -> dict:
    """Seeded by line + job name, so a replay gives the same table."""
    cfg = job.config
    methods = [str(m) for m in (cfg.get("baselines") or ["Baseline"])][:4] + [str(cfg.get("method") or "Ours")]
    metrics = [str(m) for m in (cfg.get("metrics") or ["Success rate (%)"])][:4]
    seed = int(hashlib.sha256(f"{job.line_id}:{job.name}".encode()).hexdigest()[:8], 16)
    rng = random.Random(seed)
    rows = []
    for mi, m in enumerate(methods):
        is_ours = mi == len(methods) - 1
        vals = []
        for _ in metrics:
            base = rng.uniform(38, 62)
            vals.append(round(base + (rng.uniform(4, 9) if is_ours else rng.uniform(-6, 2)), 1))
        rows.append({"method": m, "values": vals, "ours": is_ours})
    # keep "ours" ahead of every baseline on most metrics, but not uniformly
    for k in range(len(metrics)):
        best = max(r["values"][k] for r in rows[:-1])
        if rows[-1]["values"][k] <= best and rng.random() < 0.75:
            rows[-1]["values"][k] = round(best + rng.uniform(0.8, 4.5), 1)
    return {"simulated": True, "backend": "模拟电厂", "metrics": metrics, "rows": rows,
            "seeds": int(cfg.get("seeds") or 3), "gpu_hours": round(job.gpus * rng.uniform(2, 8), 1)}
