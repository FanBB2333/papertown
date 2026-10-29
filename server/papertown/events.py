"""In-process event bus feeding the SSE stream.

Pipelines run in worker threads and publish from there; each SSE client owns an
asyncio.Queue on the server loop, so publishing hops threads with call_soon_threadsafe.
"""

from __future__ import annotations

import asyncio
import itertools
import threading
from typing import Any

from .db import now


class EventBus:
    def __init__(self) -> None:
        self._subs: set[tuple[asyncio.AbstractEventLoop, asyncio.Queue]] = set()
        self._lock = threading.Lock()
        self._seq = itertools.count(1)

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        with self._lock:
            self._subs.add((asyncio.get_running_loop(), q))
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        with self._lock:
            self._subs = {s for s in self._subs if s[1] is not q}

    def publish(self, type: str, **data: Any) -> None:
        ev = {"id": next(self._seq), "type": type, "ts": now(), **data}
        with self._lock:
            subs = list(self._subs)
        for loop, q in subs:
            try:
                loop.call_soon_threadsafe(self._put, q, ev)
            except RuntimeError:  # loop closed: the client is gone
                self.unsubscribe(q)

    @staticmethod
    def _put(q: asyncio.Queue, ev: dict) -> None:
        if q.full():  # a stalled client loses its oldest events rather than blocking the world
            q.get_nowait()
        q.put_nowait(ev)
