"""`papertown` in a terminal: the town's console, as the web page has it, driven by the keyboard.

It talks to the server over the same API the page uses (PAPERTOWN_URL, or --server); when nothing
answers there on this machine, it starts `papertown serve` for as long as it runs."""

from __future__ import annotations

import os


def run(server: str | None = None, start: bool = True) -> None:
    from .app import Papertown
    from .client import Api

    Papertown(Api(server or os.environ.get("PAPERTOWN_URL", "http://127.0.0.1:8000")), start_server=start).run()
