"""MCP client side (the ports): each configured server runs over stdio on the hub's own event loop thread, its tools
listed in the MCP room. Servers are built in (arXiv), from PAPERTOWN_MCP_CONFIG or from the
town's mcp.json (Claude Desktop format, plus a "disabled" list); env values may name variables ("${GITHUB_TOKEN}").
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import Future
from pathlib import Path
from typing import TYPE_CHECKING, Any

from mcp import Client, StdioServerParameters

from .config import SERVER_DIR
from .db import read_json

if TYPE_CHECKING:
    from .town import Town

NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,31}$")


class McpError(Exception):
    pass


def _decode(result) -> Any:
    if result.structured_content is not None:
        sc = result.structured_content
        return sc["result"] if isinstance(sc, dict) and set(sc) == {"result"} else sc
    text = "\n".join(getattr(c, "text", "") for c in result.content or [])
    try:
        return json.loads(text)
    except ValueError:
        return text


class McpHub:
    def __init__(self, town: "Town"):
        self.town = town
        self.loop: asyncio.AbstractEventLoop | None = None
        self.clients: dict[str, Client] = {}
        self.status: dict[str, dict] = {}
        self.tools_of: dict[str, list[dict]] = {}  # each server's tools: name and description
        self._stop: asyncio.Event | None = None
        self._stops: dict[str, asyncio.Event] = {}
        self._running: dict[str, Future] = {}
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()

    @property
    def town_file(self) -> Path:
        return self.town.s.data_dir / "mcp.json"

    def _town_config(self) -> dict:
        d = read_json(self.town_file, {})
        return {"mcpServers": d.get("mcpServers") or {}, "disabled": d.get("disabled") or []}

    def _save_town(self, d: dict) -> None:
        self.town_file.parent.mkdir(parents=True, exist_ok=True)
        self.town_file.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")

    def catalog(self) -> dict[str, dict]:
        """Every server the town knows, with where it is configured and whether it is on."""
        out: dict[str, dict] = {}
        if self.town.s.arxiv_port:
            out["arxiv"] = {"command": sys.executable, "args": ["-m", "papertown.ports.arxiv_server"], "cwd": str(SERVER_DIR),
                            "source": "builtin"}
        if self.town.s.mcp_config and Path(self.town.s.mcp_config).exists():
            try:
                for n, cfg in json.loads(Path(self.town.s.mcp_config).read_text()).get("mcpServers", {}).items():
                    out[n] = {**cfg, "source": "file"}
            except ValueError:
                pass
        town = self._town_config()
        for n, cfg in town["mcpServers"].items():
            out.setdefault(n, {**cfg, "source": "town"})
        for n, cfg in out.items():
            cfg["enabled"] = n not in town["disabled"] and not cfg.get("disabled")
        return out

    def servers(self) -> dict[str, dict]:
        return {n: cfg for n, cfg in self.catalog().items() if cfg["enabled"]}

    def info(self) -> list[dict]:
        """The servers as the exchange shows them; env values are never sent, only names."""
        out = []
        for n, cfg in self.catalog().items():
            st = self.status.get(n) or {}
            state = "off" if not cfg["enabled"] else "ok" if st.get("ok") else "error" if st.get("ok") is False else "connecting"
            out.append({"name": n, "source": cfg["source"], "command": cfg.get("command", ""), "args": cfg.get("args") or [],
                        "env": sorted((cfg.get("env") or {}).keys()), "cwd": cfg.get("cwd"), "enabled": cfg["enabled"],
                        "state": state, "error": st.get("error"), "tools": self.tools_of.get(n, []) if state == "ok" else []})
        return out

    def add(self, name: str, command: str, args: list[str], env: dict[str, str]) -> None:
        """Add or change a server of the town's own, and connect it."""
        if not NAME.match(name):
            raise McpError("名字只能用字母、数字、- 和 _，以字母开头")
        if not command.strip():
            raise McpError("要填启动命令")
        cat = self.catalog()
        if name in cat and cat[name]["source"] != "town":
            raise McpError(f"{name} 是{'内置的' if cat[name]['source'] == 'builtin' else ' PAPERTOWN_MCP_CONFIG 里的'}，在这里不能改")
        with self._lock:
            d = self._town_config()
            old = (d["mcpServers"].get(name) or {}).get("env") or {}
            env = {k: v if v != "" or k not in old else old[k] for k, v in env.items()}  # values are never shown, so a blank keeps the old one
            d["mcpServers"][name] = {"command": command.strip(), "args": [a for a in args if a != ""],
                                     **({"env": env} if env else {})}
            self._save_town(d)
        self.restart(name)

    def remove(self, name: str) -> None:
        cat = self.catalog()
        if name not in cat:
            raise McpError("没有这个 MCP server")
        if cat[name]["source"] != "town":
            raise McpError("只有在小镇里添加的才能删，别的可以停用")
        self.disconnect(name)
        with self._lock:
            d = self._town_config()
            d["mcpServers"].pop(name, None)
            d["disabled"] = [x for x in d["disabled"] if x != name]
            self._save_town(d)
        self.status.pop(name, None)

    def toggle(self, name: str, enabled: bool) -> None:
        if name not in self.catalog():
            raise McpError("没有这个 MCP server")
        with self._lock:
            d = self._town_config()
            d["disabled"] = [x for x in d["disabled"] if x != name] + ([] if enabled else [name])
            self._save_town(d)
        if enabled:
            self.restart(name)
        else:
            self.disconnect(name)
            self.status.pop(name, None)

    def start(self, timeout: float = 20) -> None:
        ready = threading.Event()
        self._thread = threading.Thread(target=self._run, args=(ready,), daemon=True, name="mcp-hub")
        self._thread.start()
        ready.wait(5)
        servers = self.servers()
        for n, cfg in servers.items():
            self.connect(n, cfg)
        deadline = timeout  # wait for the first connections, so the ports' tools are there
        while deadline > 0 and not all(n in self.status and self.status[n].get("ok") is not None for n in servers):
            time.sleep(0.05)
            deadline -= 0.05

    def _run(self, ready: threading.Event) -> None:
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        self._stop = asyncio.Event()
        self.loop.call_soon(ready.set)
        self.loop.run_until_complete(self._stop.wait())
        pending = asyncio.all_tasks(self.loop)
        if pending:
            self.loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))

    def connect(self, name: str, cfg: dict) -> None:
        if not self.loop:
            return
        self.status[name] = {"ok": None}
        self._running[name] = asyncio.run_coroutine_threadsafe(self._serve(name, cfg), self.loop)

    def disconnect(self, name: str, timeout: float = 8) -> None:
        stop, fut = self._stops.get(name), self._running.pop(name, None)
        if stop and self.loop:
            self.loop.call_soon_threadsafe(stop.set)
        if fut:
            try:
                fut.result(timeout)
            except Exception:
                pass

    def restart(self, name: str) -> None:
        self.disconnect(name)
        cfg = self.servers().get(name)
        if cfg:
            self.connect(name, cfg)

    async def _serve(self, name: str, cfg: dict) -> None:
        stop = self._stops[name] = asyncio.Event()
        env = {**os.environ, **{k: os.path.expandvars(str(v)) for k, v in (cfg.get("env") or {}).items()}}
        params = StdioServerParameters(command=cfg["command"], args=cfg.get("args", []), env=env, cwd=cfg.get("cwd"))
        try:
            async with Client(params, read_timeout_seconds=60) as client:
                listed = await asyncio.wait_for(client.list_tools(), 60)
                self.clients[name] = client
                self.tools_of[name] = [{"name": t.name, "description": (t.description or "").strip()[:400]} for t in listed.tools]
                self.status[name] = {"ok": True, "tools": [t.name for t in listed.tools]}
                waits = [asyncio.ensure_future(stop.wait()), asyncio.ensure_future(self._stop.wait())]
                await asyncio.wait(waits, return_when=asyncio.FIRST_COMPLETED)
                for w in waits:
                    w.cancel()
        except Exception as e:  # a port that fails to start must not take the town down
            self.status[name] = {"ok": False, "error": f"{type(e).__name__}: {e}"[:400]}
        finally:
            self.clients.pop(name, None)
            self.tools_of.pop(name, None)
            if self._stops.get(name) is stop:
                self._stops.pop(name, None)

    def call(self, server: str, tool: str, args: dict, timeout: float = 90) -> Any:
        client = self.clients.get(server)
        if not client or not self.loop:
            raise RuntimeError(f"MCP 端口 {server} 没有连上")
        fut = asyncio.run_coroutine_threadsafe(client.call_tool(tool, args), self.loop)
        result = fut.result(timeout)
        if result.is_error:
            raise RuntimeError(_decode(result))
        return _decode(result)

    def stop(self) -> None:
        if self.loop and self._stop:
            self.loop.call_soon_threadsafe(self._stop.set)
        if self._thread:
            self._thread.join(8)
