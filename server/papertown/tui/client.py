"""Talking to the server: the same HTTP API and event stream the web page uses, and, when nothing
answers at the address, a server of our own for as long as the TUI runs."""

from __future__ import annotations

import asyncio
import json
import os
import signal
import subprocess
import sys
from pathlib import Path
from typing import Any, AsyncIterator

import httpx


class ApiError(Exception):
    pass


class Api:
    def __init__(self, base: str, transport: httpx.AsyncBaseTransport | None = None):
        self.base = base.rstrip("/")
        self.http = httpx.AsyncClient(base_url=self.base, timeout=30, transport=transport)

    def url(self, path: str) -> str:
        return self.base + path

    @staticmethod
    def _ok(r: httpx.Response) -> Any:
        if r.status_code >= 400:
            try:
                detail = r.json().get("detail")
            except ValueError:
                detail = r.text
            if isinstance(detail, list):
                detail = "，".join(f"{'.'.join(str(x) for x in d.get('loc', [])[1:])} {d.get('msg', '')}".strip() for d in detail)
            raise ApiError(str(detail or f"HTTP {r.status_code}"))
        return r.json() if r.content else None

    async def get(self, url: str, /, **params: Any) -> Any:  # positional-only, so a query may be called path
        return self._ok(await self.http.get(url, params={k: v for k, v in params.items() if v is not None}))

    async def post(self, path: str, body: Any = None) -> Any:
        return self._ok(await self.http.post(path, json=body))

    async def put(self, path: str, body: Any = None) -> Any:
        return self._ok(await self.http.put(path, json=body))

    async def delete(self, path: str) -> Any:
        return self._ok(await self.http.delete(path))

    async def health(self) -> dict | None:
        try:
            r = await self.http.get("/api/health", timeout=2)
            body = r.json()
            return body if r.status_code == 200 and body.get("ok") else None
        except (httpx.HTTPError, ValueError):
            return None

    async def download(self, path: str, to: Path) -> Path:
        async with self.http.stream("GET", path) as r:
            if r.status_code >= 400:
                raise ApiError(f"HTTP {r.status_code}")
            with to.open("wb") as f:
                async for chunk in r.aiter_bytes():
                    f.write(chunk)
        return to

    async def events(self) -> AsyncIterator[dict]:
        """The server's events (/api/events), as they come; ends when the connection drops."""
        async with self.http.stream("GET", "/api/events", timeout=httpx.Timeout(30, read=None)) as r:
            data: list[str] = []
            async for line in r.aiter_lines():
                if line.startswith("data:"):
                    data.append(line[5:].lstrip())
                elif not line and data:
                    try:
                        yield json.loads("\n".join(data))
                    except ValueError:
                        pass
                    data = []

    async def close(self) -> None:
        await self.http.aclose()


class LocalServer:
    """`papertown serve` in its own process group, its output in the data folder's tui-server.log."""

    def __init__(self, port: int, data_dir: Path):
        self.port = port
        self.log = data_dir / "tui-server.log"
        self.proc: subprocess.Popen | None = None

    def start(self) -> None:
        out = self.log.open("ab")
        self.proc = subprocess.Popen([sys.executable, "-m", "papertown.cli", "serve", "--port", str(self.port)],
                                     stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT, start_new_session=True)
        out.close()

    @property
    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    async def ready(self, api: Api, timeout: float = 90) -> bool:
        loop = asyncio.get_running_loop()
        until = loop.time() + timeout
        while loop.time() < until:
            if not self.alive:
                return False
            if await api.health():
                return True
            await asyncio.sleep(0.3)
        return False

    def tail(self, lines: int = 12) -> str:
        try:
            return "\n".join(self.log.read_text(errors="replace").splitlines()[-lines:])
        except OSError:
            return ""

    def stop(self) -> None:
        if not self.alive:
            return
        assert self.proc
        try:
            os.killpg(self.proc.pid, signal.SIGTERM)
            self.proc.wait(5)
        except subprocess.TimeoutExpired:
            os.killpg(self.proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
