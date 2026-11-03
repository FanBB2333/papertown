"""Paseo as a home for the depot's and the press's agents.

Paseo (paseo.sh) runs a local daemon that hosts coding agents from many providers
(Claude Code, Codex, OpenCode, Pi, Copilot, ...) and serves its own app for them. The town
talks to that daemon through the `paseo` CLI, which is a client of the daemon's WebSocket
endpoint (127.0.0.1:6767 by default): it creates one agent per project and role, sends it
messages and reads its status. Reading conversations goes through Paseo's official SDK
(@getpaseo/client, in paseo_link/): the room shows a trimmed transcript of the agent, and
existing Paseo conversations on this machine can be imported into a project. The full
Paseo page can be opened in the room as well, for its slash commands, model and thinking
switches, modes and permission prompts.

    cd server/papertown/paseo_link && pnpm install          # the SDK, once

    paseo daemon config set features.webUi.enabled true   # serve the web app the room embeds
    paseo daemon restart
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
    from .agents import _which  # same lookup as for pi: PATH, Homebrew, nvm
    node = _which("node")
    if node:
        return [node]
    return [APP_NODE] if Path(APP_NODE).exists() else None


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
        out = r.stdout.strip()
        if r.returncode != 0:
            msg = (r.stderr.strip() or out).splitlines()
            raise PaseoError(f"paseo {args[0]} 失败：{msg[-1] if msg else r.returncode}")
        try:
            return json.loads(out) if out else None
        except json.JSONDecodeError:
            raise PaseoError(f"paseo {args[0]} 的输出不是 JSON") from None

    def _link(self, *args: str, timeout: float = 30) -> Any:
        """Run paseo_link/link.mjs (the SDK) and parse its JSON."""
        node = _node()
        if not self.bin or not node:
            raise PaseoError("本机没有找到 Paseo 或 node")
        if not (LINK / "node_modules" / "@getpaseo" / "client").exists():
            raise PaseoError("还没装 Paseo 的 SDK：在 server/papertown/paseo_link 里运行 pnpm install")
        env = {**os.environ, "ELECTRON_RUN_AS_NODE": "1"}
        if self.host:
            env["PASEO_WS"] = f"ws://{self.host}/ws"
        try:
            r = subprocess.run([*node, str(LINK / "link.mjs"), *args], capture_output=True, text=True, timeout=timeout, cwd=LINK, env=env)
        except subprocess.TimeoutExpired:
            raise PaseoError("读取 Paseo 超时") from None
        if r.returncode != 0:
            raise PaseoError(f"读取 Paseo 失败：{(r.stderr.strip().splitlines() or [r.returncode])[-1]}")
        return json.loads(r.stdout)

    def conversations(self) -> list[dict]:
        """Every Paseo agent on this machine, newest first (not archived)."""
        return self._cached("conversations", 5, lambda: self._link("list"))

    def timeline(self, agent_id: str, limit: int = 200) -> dict:
        return self._link("timeline", agent_id, str(limit))

    def label(self, agent_id: str, labels: dict[str, str]) -> None:
        args = ["agent", "update", agent_id]
        for k, v in labels.items():
            args += ["--label", f"{k}={v}"]
        self._cli(*args)

    def _cached(self, key: str, ttl: float, fn) -> Any:
        with self._lock:
            hit = self._cache.get(key)
            if hit and time.time() - hit[0] < ttl:
                return hit[1]
        v = fn()
        if v:  # an empty answer is worth asking again
            with self._lock:
                self._cache[key] = (time.time(), v)
        return v

    # ---------- the daemon ----------

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
        if fresh:
            with self._lock:
                self._cache.pop("status", None)
        return self._cached("status", 15, probe)

    def _web_up(self) -> bool:
        try:
            with urllib.request.urlopen(self.web + "/", timeout=2) as r:
                return r.status == 200 and "text/html" in r.headers.get("content-type", "")
        except OSError:
            return False

    def providers(self, fresh: bool = False) -> list[dict]:
        """Providers that are ready, each with its models and thinking options; read again when
        `fresh`, else kept for five minutes."""
        def load() -> list[dict]:
            for _ in range(10):  # right after the daemon starts, providers report "loading" for a while
                rows = self._cli("provider", "ls") or []
                if not any(p.get("status") == "loading" for p in rows):
                    break
                time.sleep(2)
            rows = [p for p in rows if p.get("status") == "available"]

            def models(p: dict) -> dict:
                try:
                    ms = self._cli("provider", "models", p["provider"], timeout=40) or []
                except PaseoError:
                    ms = []
                return {"id": p["provider"], "label": p.get("label") or p["provider"], "modes": p.get("modes") or "",
                        "models": [{"id": m["id"], "name": m.get("model") or m["id"], "thinking": m.get("thinkingOptionIds") or [],
                                    "default_thinking": m.get("defaultThinkingOptionId")} for m in ms]}
            with ThreadPoolExecutor(4) as ex:
                return list(ex.map(models, rows))
        if fresh:
            with self._lock:
                self._cache.pop("providers", None)
        return self._cached("providers", 300, load)

    def url(self, agent_id: str) -> str | None:
        st = self.status()
        return f"{st['web']}/h/{st['server_id']}/agent/{agent_id}" if st.get("web") and st.get("server_id") else None

    # ---------- agents ----------

    def create(self, *, title: str, provider: str, model: str | None, thinking: str | None, cwd: Path,
               labels: dict[str, str], env: dict[str, str], prompt: str) -> dict:
        args = ["run", "--no-wait", "--title", title, "--provider", provider, "--cwd", str(cwd)]
        if model:
            args += ["--model", model]
        if thinking:
            args += ["--thinking", thinking]
        for k, v in labels.items():
            args += ["--label", f"{k}={v}"]
        for k, v in env.items():
            args += ["--env", f"{k}={v}"]
        r = self._cli(*args, prompt, timeout=90) or {}
        if not r.get("agentId"):
            raise PaseoError("Paseo 没有返回 agent id")
        return r

    def send(self, agent_id: str, text: str) -> None:
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as f:
            f.write(text)
        try:
            self._cli("send", agent_id, "--no-wait", "--prompt-file", f.name, timeout=60)
        finally:
            os.unlink(f.name)

    def interrupt(self, agent_id: str) -> None:
        self._cli("stop", agent_id)

    def permit(self, agent_id: str, request_id: str, allow: bool) -> None:
        self._cli("permit", "allow" if allow else "deny", agent_id, request_id)

    def open_desktop(self, agent_id: str) -> None:
        self._cli("agent", "open", agent_id)

    def list(self, labels: dict[str, str]) -> list[dict]:
        args = ["ls", "--all", "--global"]
        for k, v in labels.items():
            args += ["--label", f"{k}={v}"]
        return self._cli(*args) or []

    def inspect(self, agent_id: str) -> dict:
        return self._cli("inspect", agent_id) or {}
