"""MCP client side: the ports. Each configured MCP server is spawned over stdio, its tools
are listed and registered for the agents as `<server>_<tool>` (shown as server.tool in the
trace, kind MCP).

Default servers: the arXiv dock (ports/arxiv_server.py). More can be added with
PAPERTOWN_MCP_CONFIG pointing at a JSON file in the Claude Desktop format:
    {"mcpServers": {"github": {"command": "...", "args": [...], "env": {...}}}}

The MCP client is async; it lives on its own event loop thread and the (threaded)
pipelines call into it with run_coroutine_threadsafe.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from mcp import Client, StdioServerParameters

from .config import SERVER_DIR
from .tools import Tool, ToolCtx

if TYPE_CHECKING:
    from .town import Town


def _decode(result) -> Any:
    if result.structured_content is not None:
        sc = result.structured_content
        return sc.get("result", sc) if isinstance(sc, dict) and set(sc) == {"result"} else sc
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
        self.registered: dict[str, list[str]] = {}
        self.after: dict[str, Callable[[ToolCtx, dict, Any], Any]] = {}  # post-processing per api tool name
        self._stop: asyncio.Event | None = None
        self._thread: threading.Thread | None = None

    def servers(self) -> dict[str, dict]:
        out: dict[str, dict] = {}
        if self.town.s.arxiv_port:
            out["arxiv"] = {"command": sys.executable, "args": ["-m", "papertown.ports.arxiv_server"], "cwd": str(SERVER_DIR)}
        if self.town.s.mcp_config and Path(self.town.s.mcp_config).exists():
            out.update(json.loads(Path(self.town.s.mcp_config).read_text()).get("mcpServers", {}))
        return out

    def start(self, timeout: float = 20) -> None:
        servers = self.servers()
        if not servers:
            return
        ready = threading.Event()
        self._thread = threading.Thread(target=self._run, args=(servers, ready), daemon=True, name="mcp-hub")
        self._thread.start()
        ready.wait(timeout)

    def _run(self, servers: dict, ready: threading.Event) -> None:
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        self._stop = asyncio.Event()

        async def main():
            pending = [asyncio.create_task(self._serve(n, cfg)) for n, cfg in servers.items()]
            while not all(n in self.status for n in servers):
                await asyncio.sleep(0.05)
            ready.set()
            await asyncio.gather(*pending, return_exceptions=True)

        self.loop.run_until_complete(main())

    async def _serve(self, name: str, cfg: dict) -> None:
        params = StdioServerParameters(command=cfg["command"], args=cfg.get("args", []),
                                       env={**os.environ, **cfg.get("env", {})}, cwd=cfg.get("cwd"))
        try:
            async with Client(params, read_timeout_seconds=60) as client:
                listed = await client.list_tools()
                self.clients[name] = client
                for t in listed.tools:
                    self._register(name, t)
                self.status[name] = {"ok": True, "tools": [t.name for t in listed.tools]}
                await self._stop.wait()
        except Exception as e:  # a port that fails to start must not take the town down
            self.status[name] = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        finally:
            self.clients.pop(name, None)
            for api in self.registered.pop(name, []):
                self.town.tools.remove(api)

    def _register(self, server: str, t) -> None:
        api = f"{server}_{t.name}".replace("-", "_").replace(".", "_")[:64]
        schema = t.input_schema or {"type": "object", "properties": {}}
        main_arg = next(iter(schema.get("properties", {})), None)

        def fn(ctx: ToolCtx, args: dict, _tool=t.name, _api=api):
            value = self.call(server, _tool, args)
            hook = self.after.get(_api)
            return hook(ctx, args, value) if hook else value

        tool = Tool(api, f"{server}.{t.name}", "MCP", (t.description or t.name)[:1000], schema, fn, arg=main_arg)
        self.town.tools.add(tool)
        self.registered.setdefault(server, []).append(api)

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
            self._thread.join(5)
