"""`papertown` in a terminal: the town's console, driven by the keyboard. It talks to the server's API
(PAPERTOWN_URL, or --server) and starts `papertown serve` itself when nothing answers on this machine."""

from __future__ import annotations

import os


def run(server: str | None = None, start: bool = True) -> None:
    from .app import Papertown
    from .client import Api

    Papertown(Api(server or os.environ.get("PAPERTOWN_URL", "http://127.0.0.1:8000")), start_server=start).run()
