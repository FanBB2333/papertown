"""Read quota commands only. Command output and login details never enter error messages."""

from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from .paseo import PaseoError

if TYPE_CHECKING:
    from .town import Town

LABELS = {"claude": "Claude", "codex": "Codex", "antigravity": "Antigravity"}


class UsageError(ValueError):
    pass


def stamp(value: object) -> float | None:
    try:
        if isinstance(value, (int, float)):
            return float(value) / (1000 if value > 100_000_000_000 else 1) if math.isfinite(value) else None
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return (parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)).timestamp()
    except (ValueError, TypeError, OverflowError):
        return None


def iso(value: float | None) -> str | None:
    return datetime.fromtimestamp(value, timezone.utc).isoformat(timespec="seconds") if value is not None else None


def reset(value: object) -> str | None:
    at = stamp(value)
    return iso(at) if at and at > 86400 else None


def percent(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or not 0 <= value <= 100:
        raise UsageError("订阅用量报告格式无效")
    return float(value)


def failed_report(report: dict) -> str:
    problem = report.get("problem") or {}
    kind = problem.get("kind", "")
    if kind in ("expired", "not_logged_in", "login_required", "login_expired", "auth", "unauthorized") or (kind == "rejected" and problem.get("status") in (401, 403)):
        return "订阅登录已失效，请重新登录"
    if kind == "no_quota":
        return "订阅尚未提供用量额度"
    if kind == "rate_limited" or (kind == "rejected" and problem.get("status") == 429):
        return "订阅用量读取受到限流，请稍后重试"
    return "订阅用量读取失败，请检查登录状态或稍后重试"


def paseo_reports(entries: list[dict]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {"claude": [], "codex": []}
    for entry in entries:
        source = str(entry.get("sourceId", "")).lower()
        provider = next((p for p in out if p in source), None)
        if not provider:
            continue
        report = entry.get("report") or {}
        good = report.get("status") == "available"
        saved = entry.get("lastSuccessful") or {}
        current = report if good else saved.get("report") or {}
        at = entry.get("successfulAt") or entry.get("fetchedAt") if good else saved.get("fetchedAt")
        windows = []
        try:
            for w in current.get("windows") or []:
                if w.get("usedPct") is None and w.get("remainingPct") is None:
                    continue
                used = percent(w["usedPct"] if w.get("usedPct") is not None else 100 - percent(w["remainingPct"]))
                windows.append({"id": str(w["id"]), "label": w.get("label") or w["id"], "group": None,
                                "used": used, "left": 100 - used, "resets_at": reset(w.get("resetsAt"))})
        except (KeyError, TypeError, UsageError):
            out[provider].append({"account": str(entry["id"]), "error": "订阅用量报告格式无效", "windows": []})
            continue
        balances = [{k: b[k] for k in ("id", "label", "unit", "used", "remaining", "limit", "resetsAt") if k in b}
                    for b in current.get("balances") or []]
        out[provider].append({"account": str(entry["id"]), "plan": current.get("planLabel"), "windows": windows,
                              "balances": balances, "fetched_at": iso(stamp(at)),
                              "error": None if good and windows else failed_report(report)})
    return out


def agy_report(reply: dict, at: float) -> dict:
    command = reply.get("command") or {}
    if reply.get("status") != "SUCCESS" or command.get("name") != "usage":
        raise UsageError("Antigravity 用量读取失败，请检查登录状态")
    data = command.get("data") or {}
    windows = []
    try:
        for group in data.get("groups") or []:
            for b in group.get("buckets") or []:
                if b.get("disabled"):
                    continue
                left = percent(float(b["remaining_fraction"]) * 100)
                windows.append({"id": b["id"], "label": "每周额度" if b["window"] == "weekly" else "5 小时额度",
                                "group": group["name"], "used": 100 - left, "left": left,
                                "resets_at": reset(b.get("reset_time"))})
    except (KeyError, TypeError, ValueError):
        raise UsageError("订阅用量报告格式无效") from None
    if not windows:
        raise UsageError("订阅尚未提供用量额度")
    return {"account": "antigravity", "plan": data.get("plan_tier") or data.get("planLabel"), "windows": windows,
            "balances": [], "fetched_at": iso(at), "error": None}


class Readers:
    def __init__(self, town: Town):
        self.town = town

    def paseo(self, force: bool) -> dict[str, list[dict]]:
        try:
            data = self.town.agents.paseo._link("usage", *(["--force"] if force else []), timeout=30)
        except PaseoError as e:
            message = str(e).lower()
            if "没有运行" in message or "没有安装" in message or "没有找到" in message:
                raise UsageError("Paseo 未运行或未安装") from None
            if "超时" in message:
                raise UsageError("Paseo 用量读取超时") from None
            raise UsageError("Paseo 用量读取失败，请检查连接与登录状态") from None
        if not isinstance(data, list):
            raise UsageError("订阅用量报告格式无效")
        return paseo_reports(data)

    def agy(self, at: float) -> list[dict]:
        binary = self.town.s.agy_bin or shutil.which("agy")
        if not binary:
            raise UsageError("未找到 Antigravity 命令")
        try:
            r = subprocess.run([binary, "-p", "/usage", "--output-format", "json"], capture_output=True,
                               text=True, timeout=30, env={**os.environ, "NO_COLOR": "1"})
        except subprocess.TimeoutExpired:
            raise UsageError("Antigravity 用量读取超时") from None
        except OSError:
            raise UsageError("未找到 Antigravity 命令") from None
        if r.returncode:
            raise UsageError("Antigravity 用量读取失败，请检查登录状态")
        try:
            return [agy_report(json.loads(r.stdout), at)]
        except UsageError:
            raise
        except (ValueError, TypeError, AttributeError):
            raise UsageError("订阅用量报告格式无效") from None
