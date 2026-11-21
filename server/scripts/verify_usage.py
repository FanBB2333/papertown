"""Opt-in quota verification. Reads existing services and logs, without starting agents.

Run from server/: uv run --frozen python scripts/verify_usage.py --times 3 --every 30
"""

from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace

from papertown.config import Settings
from papertown.db import DB
from papertown.events import EventBus
from papertown.paseo import Paseo
from papertown.usage import Usage
from papertown.usage_readers import stamp


def daemon_running(paseo: Paseo) -> bool:
    if not paseo.bin:
        return False
    try:
        result = subprocess.run([paseo.bin, "daemon", "status", "--json"], capture_output=True, text=True, timeout=15)
        if result.returncode:
            return False
        status = json.loads(result.stdout)
        return isinstance(status, dict) and (status.get("running") is True or status.get("status") == "running"
                                             or status.get("localDaemon") == "running")
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return False


def check(service: Usage, snapshot: dict, at: float) -> list[str]:
    errors = []
    for p in snapshot["providers"]:
        tokens = p["week"]["tokens"]
        print(json.dumps({"provider": p["id"], "plan": p["plan"], "windows": [
            {k: w[k] for k in ("id", "group", "used", "left", "resets_at")} for w in p["windows"]],
            "freshness": {"status": p["status"], "fetched_at": p["fetched_at"],
                          "age_seconds": at - stamp(p["fetched_at"]) if p["fetched_at"] else None},
            "error": p["error"], "notes": p["notes"], "machine_tokens_this_week": tokens,
            "machine_cost_this_week_usd": round(p["week"]["cost"], 2), "project_cost_this_week_usd": round(p["week"]["projects"], 2),
            "unpriced_models": p["week"]["unpriced"]}, ensure_ascii=False), flush=True)
        if not p["windows"]:
            errors.append(f"{p['id']}: no quota windows")
        if p["error"] or p["status"] != "available":
            errors.append(f"{p['id']}: reading is unavailable or stale")
        for w in p["windows"]:
            if not 0 <= w["used"] <= 100 or not 0 <= w["left"] <= 100:
                errors.append(f"{p['id']}/{w['id']}: percentage out of range")
            resets = stamp(w["resets_at"])
            # agy returns Unix epoch for untouched buckets; these have no active reset yet.
            if p["id"] == "antigravity" and resets is None and w["used"] == 0:
                continue
            if resets is None or resets <= at:
                errors.append(f"{p['id']}/{w['id']}: reset is not in the future")
        if sum(tokens.values()) <= 0:
            errors.append(f"{p['id']}: no machine tokens found this week")
    if snapshot.get("log_error"):
        errors.append("local log scan failed")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--times", type=int, default=3)
    parser.add_argument("--every", type=float, default=30)
    args = parser.parse_args()
    if args.times < 1 or args.every < 0:
        parser.error("--times must be positive and --every must be nonnegative")
    with tempfile.TemporaryDirectory(prefix="papertown-usage-") as folder:
        settings = Settings(data_dir=Path(folder), usage_poll=0, usage_logs=True)
        paseo = Paseo(settings.paseo_bin, settings.paseo_url, settings.paseo_host)
        if not daemon_running(paseo):
            print("Refusing to run: paseo daemon status did not confirm a running daemon.", flush=True)
            return 1
        # Wire only the readers and accounting service. Town.start() would start unrelated workers.
        town = SimpleNamespace(s=settings, db=DB(settings.db_path), bus=EventBus(), agents=SimpleNamespace(paseo=paseo),
                               linked=SimpleNamespace(config=lambda: []), terminals=SimpleNamespace(all=lambda: []))
        service = Usage(town)
        failures = []
        for i in range(args.times):
            if i:
                time.sleep(args.every)
            print(f"Reading {i + 1}/{args.times}", flush=True)
            # Exactly one forced refresh, on the first reading only.
            snapshot = service.poll(force=i == 0)
            failures.extend(check(service, snapshot, time.time()))
        for failure in dict.fromkeys(failures):
            print(f"FAIL: {failure}", flush=True)
        print("PASS" if not failures else "FAIL", flush=True)
        town.db.conn.close()
        return int(bool(failures))


if __name__ == "__main__":
    raise SystemExit(main())
