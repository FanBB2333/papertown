import asyncio
import socket
import threading
import time

import pytest
import uvicorn
from textual.widgets import Input

from papertown.api import create_app
from papertown.tui.app import PLACES, Main, Papertown
from papertown.tui.client import Api
from papertown.tui.widgets import Confirm, Form

from .conftest import make_settings


@pytest.fixture
def server(tmp_path, monkeypatch):
    s = make_settings(tmp_path)
    # what the TUI reads itself (nvidb, skim, the skills) follows the same settings: none of it real here
    for k, v in {"PAPERTOWN_DATA_DIR": s.data_dir, "PAPERTOWN_SKILLS_DIR": s.skills_dir, "PAPERTOWN_NVIDB_BIN": s.nvidb_bin,
                 "PAPERTOWN_SKIM_BIN": s.skim_bin, "PAPERTOWN_PROVIDER": "mock"}.items():
        monkeypatch.setenv(k, str(v))
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    srv = uvicorn.Server(uvicorn.Config(create_app(s), host="127.0.0.1", port=port, log_level="warning"))
    th = threading.Thread(target=srv.run, daemon=True)
    th.start()
    t0 = time.time()
    while not srv.started and time.time() - t0 < 30:
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}"
    srv.should_exit = True
    th.join(10)


async def until(pilot, ok, timeout: float = 20) -> None:
    t0 = time.time()
    while not ok():
        if time.time() - t0 > timeout:
            raise TimeoutError
        await pilot.pause(0.1)


def test_tui_places_idea_and_job(server):
    async def go():
        app = Papertown(Api(server), start_server=False, events=False)
        async with app.run_test(size=(170, 46)) as pilot:
            await until(pilot, lambda: isinstance(app.screen, Main))
            for i, (key, _) in enumerate(PLACES):  # every place opens
                await pilot.press(str(i + 1))
                await pilot.pause(0.3)
                assert app.place == key

            await pilot.press("1", "i")  # an idea, from the box at the bottom
            app.screen.query_one("#say", Input).value = "TUI 冒烟测试：小模型的工具路由"
            await pilot.press("enter")
            await until(pilot, lambda: any("冒烟" in (ln.get("idea") or ln.get("title") or "") for ln in app.lines))

            await pilot.press("escape", "2", "n")  # a job on the farm, then cancel it
            await until(pilot, lambda: isinstance(app.screen, Form))
            app.screen.query_one("#f-name", Input).value = "tui-smoke"
            app.screen.query_one("#f-command", Input).value = "sleep 30"
            await pilot.press("ctrl+s")
            jobs = app.current
            await until(pilot, lambda: (jobs.detail or {}).get("name") == "tui-smoke" and jobs.detail.get("status") in ("running", "queued"))
            await pilot.press("x")
            await until(pilot, lambda: isinstance(app.screen, Confirm))
            await pilot.press("y")
            await until(pilot, lambda: (jobs.detail or {}).get("status") == "cancelled")
            await pilot.press("q")
    asyncio.run(go())
