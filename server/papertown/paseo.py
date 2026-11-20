"""Paseo (paseo.sh), the local daemon that hosts the projects' coding agents: driven through the
`paseo` CLI, with conversations read through Paseo's SDK in paseo_link/.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

APP_CLI = "/Applications/Paseo.app/Contents/Resources/bin/paseo"
APP_NODE = "/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper"  # Electron, run as node
LINK = Path(__file__).parent / "paseo_link"


class PaseoError(Exception):
    pass


def _find(explicit: str) -> str | None:
    if explicit:
        return explicit if Path(explicit).exists() else None
    for c in (shutil.which("paseo") or "", APP_CLI):
        if c and Path(c).exists():
            return c
    return None


def _node() -> list[str] | None:
    from .agents import _which
    node = _which("node")
    if node:
        return [node]
    return [APP_NODE] if Path(APP_NODE).exists() else None


def _pairs(flag: str, d: dict[str, str]) -> list[str]:
    return [x for k, v in d.items() for x in (flag, f"{k}={v}")]


class Paseo:
    def __init__(self, bin_path: str = "", web: str = "", host: str = ""):
        self.bin = _find(bin_path)
        self.web = (web or "http://127.0.0.1:6767").rstrip("/")
        self.host = host
        self._cache: dict[str, tuple[float, Any]] = {}
        self._lock = threading.Lock()

    def _cli(self, *args: str, timeout: float = 30) -> Any:
        if not self.bin:
            raise PaseoError("本机没有找到 Paseo（paseo CLI）")
        cmd = [self.bin, *args, "--json", *(["--host", self.host] if self.host else [])]
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise PaseoError(f"paseo {args[0]} 超时") from None
        except OSError as e:
            raise PaseoError(f"无法运行 Paseo：{e}") from e
        out = r.stdout.strip()
        if r.returncode != 0:
            msg = (r.stderr.strip() or out).splitlines()
            raise PaseoError(f"paseo {args[0]} 失败：{msg[-1] if msg else r.returncode}")
        try:
            result = json.loads(out)
        except json.JSONDecodeError:
            raise PaseoError(f"paseo {args[0]} 的输出不是 JSON") from None
        if isinstance(result, dict) and result.get("error"):
            raise PaseoError(f"paseo {args[0]} 失败：{result['error']}")
        return result

    def _link(self, *args: str, timeout: float = 30) -> Any:
        """Run paseo_link/link.mjs (the SDK) and parse its JSON."""
        node = _node()
        if not self.bin or not node:
            raise PaseoError("本机没有找到 Paseo 或 node")
        if not (LINK / "node_modules" / "@getpaseo" / "client").exists():
            raise PaseoError("还没装 Paseo 的 SDK：在 server/papertown/paseo_link 里运行 pnpm install")
        st = self.status()  # cached; the SDK would wait out its whole timeout for a daemon that is not running
        if not st["ok"]:
            raise PaseoError(st["note"])
        env = {**os.environ, "ELECTRON_RUN_AS_NODE": "1"}
        endpoint = self.host or st.get("listen")
        if not endpoint:
            raise PaseoError("Paseo 没有公布 TCP 端点，请设置 PAPERTOWN_PASEO_HOST=主机:端口")
        address = urlsplit(endpoint if "://" in endpoint else f"ws://{endpoint}")
        if address.scheme not in ("ws", "wss", "tcp") or not address.hostname or address.path not in ("", "/ws"):
            raise PaseoError("Paseo SDK 需要 TCP/WebSocket 端点，请把 PAPERTOWN_PASEO_HOST 设为主机:端口")
        env["PASEO_WS"] = urlunsplit(("ws" if address.scheme == "tcp" else address.scheme, address.netloc, "/ws", "", ""))
        try:
            r = subprocess.run([*node, str(LINK / "link.mjs"), *args], capture_output=True, text=True, timeout=timeout, cwd=LINK, env=env)
        except subprocess.TimeoutExpired:
            raise PaseoError("读取 Paseo 超时") from None
        except OSError as e:
            raise PaseoError(f"无法运行 Paseo SDK：{e}") from e
        if r.returncode != 0:
            raise PaseoError(f"读取 Paseo 失败：{(r.stderr.strip().splitlines() or [r.returncode])[-1]}")
        try:
            return json.loads(r.stdout)
        except json.JSONDecodeError:
            raise PaseoError("Paseo SDK 的输出不是 JSON") from None

    def conversations(self) -> list[dict]:
        """Every Paseo agent on this machine, newest first (not archived)."""
        return self._cached("conversations", 5, lambda: self._link("list"))

    def timeline(self, agent_id: str, limit: int = 200) -> dict:
        return self._link("timeline", agent_id, str(limit))

    def label(self, agent_id: str, labels: dict[str, str]) -> None:
        self._cli("agent", "update", agent_id, *_pairs("--label", labels))
        with self._lock:
            self._cache.pop("conversations", None)

    def project(self, path: Path) -> str:
        result = self._cli("project", "create", str(path))
        if not isinstance(result, dict) or not result.get("projectId"):
            raise PaseoError("Paseo 没有返回 project id（需要 Paseo 0.14 或更新版本）")
        return result["projectId"]

    def workspace(self, project_id: str, path: Path, title: str) -> str:
        result = self._cli("workspace", "create", "--isolation", "local", "--project", project_id,
                           "--path", str(path), "--title", title)
        if not isinstance(result, dict) or not result.get("workspaceId"):
            raise PaseoError("Paseo 没有返回 workspace id")
        return result["workspaceId"]

    def _cached(self, key: str, ttl: float, fn, fresh: bool = False) -> Any:
        with self._lock:
            if fresh:
                self._cache.pop(key, None)
            hit = self._cache.get(key)
            if hit and time.time() - hit[0] < ttl:
                return hit[1]
        v = fn()
        if v:  # an empty answer is worth asking again
            with self._lock:
                self._cache[key] = (time.time(), v)
        return v

    def status(self, fresh: bool = False) -> dict:
        def probe() -> dict:
            if not self.bin:
                return {"ok": False, "note": "本机没有安装 Paseo"}
            try:
                st = self._cli("status", timeout=15) or {}
            except PaseoError as e:
                return {"ok": False, "note": str(e)}
            up = st.get("localDaemon") == "running" or st.get("connectedDaemon") == "reachable"
            return {"ok": up, "server_id": st.get("serverId"), "listen": st.get("listen"), "version": st.get("daemonVersion"),
                    "web": self.web if up and self._web_up() else None,
                    "note": "" if up else "Paseo 守护进程没有运行：paseo daemon start"}
        return self._cached("status", 15, probe, fresh)

    def _web_up(self) -> bool:
        try:
            with urllib.request.urlopen(self.web + "/", timeout=2) as r:
                return r.status == 200 and "text/html" in r.headers.get("content-type", "")
        except OSError:
            return False

    def providers(self, fresh: bool = False) -> list[dict]:
        """Providers that are ready, each with its models and thinking options; kept for five minutes."""
        def load() -> list[dict]:
            for _ in range(10):  # right after the daemon starts, providers report "loading" for a while
                rows = self._cli("provider", "ls") or []
                if not any(p.get("status") == "loading" for p in rows):
                    break
                time.sleep(2)
            rows = [p for p in rows if p.get("status") == "available"]

            def models(p: dict) -> dict:
                ms = self._cli("provider", "models", p["provider"], timeout=40)
                return {"id": p["provider"], "label": p.get("label") or p["provider"], "modes": p.get("modes") or "",
                        "models": [{"id": m["id"], "name": m.get("model") or m["id"], "thinking": m.get("thinkingOptionIds") or [],
                                    "default_thinking": m.get("defaultThinkingOptionId")} for m in ms]}
            with ThreadPoolExecutor(4) as ex:
                return list(ex.map(models, rows))
        return self._cached("providers", 300, load, fresh)

    def url(self, agent_id: str) -> str | None:
        st = self.status()
        return f"{st['web']}/h/{st['server_id']}/agent/{agent_id}" if st.get("web") and st.get("server_id") else None

    def create(self, *, title: str, provider: str, model: str | None, thinking: str | None, cwd: Path,
               labels: dict[str, str], env: dict[str, str], prompt: str, workspace_id: str | None = None) -> dict:
        args = ["run", "--no-wait", "--title", title, "--provider", provider, "--cwd", str(cwd)]
        if model:
            args += ["--model", model]
        if thinking:
            args += ["--thinking", thinking]
        if workspace_id:
            args += ["--workspace", workspace_id]
        r = self._cli(*args, *_pairs("--label", labels), *_pairs("--env", env), prompt, timeout=90) or {}
        if not r.get("agentId"):
            raise PaseoError("Paseo 没有返回 agent id")
        with self._lock:  # the list of conversations now lacks this one
            self._cache.pop("conversations", None)
        return r

    def send(self, agent_id: str, text: str) -> None:
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as f:
            f.write(text)
        try:
            self._cli("send", agent_id, "--no-wait", "--prompt-file", f.name, "--behavior", "steer", timeout=60)
        finally:
            os.unlink(f.name)

    def interrupt(self, agent_id: str) -> None:
        self._cli("stop", agent_id)

    def permit(self, agent_id: str, request_id: str, allow: bool) -> None:
        self._cli("permit", "allow" if allow else "deny", agent_id, request_id)

    def open_desktop(self, agent_id: str) -> None:
        self._cli("agent", "open", agent_id)

    def list(self, labels: dict[str, str]) -> list[dict]:
        return self._cli("ls", "--all", "--global", *_pairs("--label", labels)) or []
