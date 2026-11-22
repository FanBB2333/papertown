"""herdr protocol 22: one newline-delimited JSON request per socket connection."""

from __future__ import annotations

import json
import socket
import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from uuid import uuid4

from .config import Settings

EVENTS = ("pane.agent_detected", "pane.closed", "pane.exited")
ERRORS = {
    "agent_blocked": "它在等你处理终端里的对话框",
    "agent_not_found": "没有这个终端会话",
    "pane_not_found": "没有这个终端会话",
    "agent_not_ready": "终端里的 agent 尚未就绪",
    "timeout": "herdr 响应超时，请查看终端状态",
}


class HerdrError(Exception):
    def __init__(self, message: str, code: str = ""):
        super().__init__(message)
        self.code = code


def _lines(stream: socket.socket, deadline: float | None = None) -> Iterator[dict]:
    """Retain partial frames across socket reads, including split UTF-8 characters."""
    pending = b""
    while True:
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError
            stream.settimeout(remaining)
        chunk = stream.recv(65536)
        if not chunk:
            raise HerdrError("herdr 连接已断开")
        pending += chunk
        while b"\n" in pending:
            line, pending = pending.split(b"\n", 1)
            try:
                data = json.loads(line)
            except (ValueError, UnicodeError) as e:
                raise HerdrError("herdr 返回了无效数据") from e
            if not isinstance(data, dict):
                raise HerdrError("herdr 返回了无效数据")
            yield data
        if len(pending) > 8 * 1024 * 1024:
            raise HerdrError("herdr 返回的数据过长")


def _result(data: dict, request_id: str) -> dict:
    if data.get("id") != request_id:
        raise HerdrError("herdr 返回了无效数据")
    if "error" in data:
        if not isinstance(data["error"], dict):
            raise HerdrError("herdr 返回了无效数据")
        code = data["error"].get("code", "")
        raise HerdrError(ERRORS.get(code, f"herdr 未能完成操作（{code or '未知错误'}），请查看终端状态"), code)
    if not isinstance(data.get("result"), dict):
        raise HerdrError("herdr 返回了无效数据")
    return data["result"]


class Herdr:
    def __init__(self, settings: Settings):
        self.path = Path(settings.herdr_socket).expanduser()
        self.enabled = settings.herdr
        self.timeout = 2.0

    def connect(self, timeout: float | None = None) -> socket.socket:
        if not self.enabled:
            raise HerdrError("herdr 接入已关闭")
        stream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        stream.settimeout(self.timeout if timeout is None else timeout)
        try:
            stream.connect(str(self.path))
        except OSError as e:
            stream.close()
            raise HerdrError("herdr 没有运行") from e
        return stream

    @staticmethod
    def send(stream: socket.socket, method: str, params: dict) -> str:
        request_id = uuid4().hex
        stream.sendall((json.dumps({"id": request_id, "method": method, "params": params}, ensure_ascii=False) + "\n").encode())
        return request_id

    def call(self, method: str, params: dict, timeout: float | None = None) -> dict:
        deadline = time.monotonic() + (self.timeout if timeout is None else timeout)
        try:
            with self.connect(timeout) as stream:
                stream.settimeout(max(0.001, deadline - time.monotonic()))
                request_id = self.send(stream, method, params)
                return _result(next(_lines(stream, deadline)), request_id)
        except TimeoutError as e:
            raise HerdrError(ERRORS["timeout"], "timeout") from e
        except OSError as e:
            raise HerdrError("herdr 连接已断开") from e

    def agents(self) -> list[dict]:
        agents = self.call("agent.list", {}).get("agents")
        if not isinstance(agents, list) or any(not self._agent(a) for a in agents):
            raise HerdrError("herdr 返回了无效数据")
        return agents

    @staticmethod
    def _agent(a: object) -> bool:
        return isinstance(a, dict) and all(isinstance(a.get(k), str) for k in ("terminal_id", "pane_id", "agent_status"))

    def get(self, target: str, timeout: float | None = None) -> dict:
        agent = self.call("agent.get", {"target": target}, timeout).get("agent")
        if not self._agent(agent):
            raise HerdrError("herdr 返回了无效数据")
        return agent

    def read(self, target: str, lines: int = 200) -> str:
        # Unwrapping history takes herdr longer than the other calls, more so while several agents work.
        try:
            read = self.call("agent.read", {"target": target, "source": "recent_unwrapped", "lines": lines}, 5).get("read")
        except HerdrError as e:
            # Full-screen agents keep their history on the alternate screen, which herdr
            # can only scroll back while they are idle. While they work, show the screen.
            if e.code != "agent_not_idle":
                raise
            read = self.call("agent.read", {"target": target, "source": "visible"}, 5).get("read")
        if not isinstance(read, dict) or not isinstance(read.get("text"), str):
            raise HerdrError("herdr 返回了无效数据")
        return read["text"]

    def prompt(self, target: str, text: str) -> dict:
        return self.call("agent.prompt", {"target": target, "text": text})

    def keys(self, target: str, keys: list[str]) -> dict:
        return self.call("agent.send_keys", {"target": target, "keys": keys})


class Feed:
    def __init__(self, client: Herdr, callback: Callable[[dict], None]):
        self.client, self.callback = client, callback
        self._halt = threading.Event()
        self._lock = threading.Lock()
        self._panes: set[str] = set()
        self._stream: socket.socket | None = None
        self._live = False
        self._restart = False
        self._thread = threading.Thread(target=self._run, daemon=True, name="herdr-feed")
        self._thread.start()

    @property
    def live(self) -> bool:
        return self._live and not self._halt.is_set()

    def follow(self, panes: set[str]) -> None:
        # Status subscriptions require a pane_id in protocol 22. Replace the connection when panes change.
        with self._lock:
            if panes == self._panes:
                return
            self._panes = panes.copy()
            self._restart = True
            self._disconnect()

    def _disconnect(self) -> None:
        if self._stream:
            try:
                self._stream.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def close(self) -> None:
        self._halt.set()
        with self._lock:
            self._disconnect()
        self._thread.join(timeout=self.client.timeout + 1)

    def _run(self) -> None:
        delay = 1
        while not self._halt.is_set():
            started = time.monotonic()
            try:
                with self.client.connect() as stream:
                    with self._lock:
                        if self._halt.is_set():
                            return
                        self._stream, self._restart = stream, False
                        subscriptions = [{"type": e} for e in EVENTS] + [
                            {"type": "pane.agent_status_changed", "pane_id": p} for p in sorted(self._panes)]
                    request_id = self.client.send(stream, "events.subscribe", {"subscriptions": subscriptions})
                    lines = _lines(stream)
                    _result(next(lines), request_id)
                    stream.settimeout(None)
                    self._live = True
                    self.callback({"event": "connected", "data": {}})
                    for data in lines:
                        if "error" in data:
                            _result(data, request_id)
                        if "event" in data:
                            self.callback(data)
                        if self._halt.is_set():
                            break
            except (HerdrError, OSError):
                pass  # A missing socket is normal while herdr is not running.
            finally:
                was_live, self._live = self._live, False
                with self._lock:
                    self._stream = None
                    restart, self._restart = self._restart, False
                if was_live and not self._halt.is_set():
                    self.callback({"event": "disconnected", "data": {}})
            if restart:
                delay = 1
                continue
            if time.monotonic() - started >= 10:
                delay = 1
            if self._halt.wait(delay):
                break
            delay = min(delay * 2, 30)
