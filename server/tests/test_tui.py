import asyncio
import contextlib
import socket
import threading
import time

import pytest
import uvicorn
from textual.widgets import DataTable, Input

from papertown.api import create_app
from papertown.tui.app import PLACES, Main, Papertown
from papertown.tui.client import Api
from papertown.tui.views.projects import TABS
from papertown.tui.views.setup import PAGES
from papertown.tui.widgets import Confirm, Form, Prompt

from .conftest import make_settings


@contextlib.contextmanager
def serving(s, monkeypatch, app=None):
    """Serve the app for `s` on a free port and yield its URL; what the TUI reads itself (nvidb, skim, the skills) follows `s` too."""
    for k, v in {"PAPERTOWN_DATA_DIR": s.data_dir, "PAPERTOWN_SKILLS_DIR": s.skills_dir, "PAPERTOWN_NVIDB_BIN": s.nvidb_bin,
                 "PAPERTOWN_SKIM_BIN": s.skim_bin, "PAPERTOWN_LEAD_RESIDENT": "0"}.items():
        monkeypatch.setenv(k, str(v))
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    srv = uvicorn.Server(uvicorn.Config(app or create_app(s), host="127.0.0.1", port=port, log_level="warning"))
    th = threading.Thread(target=srv.run, daemon=True)
    th.start()
    t0 = time.time()
    while not srv.started and time.time() - t0 < 30:
        time.sleep(0.05)
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        srv.should_exit = True
        th.join(10)


@pytest.fixture
def server(tmp_path, monkeypatch):
    with serving(make_settings(tmp_path, lead_resident=False), monkeypatch) as url:
        yield url


async def until(pilot, ok, timeout: float = 20) -> None:
    t0 = time.time()
    while not ok():
        if time.time() - t0 > timeout:
            raise TimeoutError
        await pilot.pause(0.1)


def test_tui_writes_a_research_decision(tmp_path, monkeypatch):
    s = make_settings(tmp_path)
    service = create_app(s)

    async def go(server):
        api = Api(server)
        lid = (await api.post("/api/samples"))["added"][-1]
        service.state.town.cards._write(lid, {"card": {"need_you": ["怎样报告 [A] 组的失败？"]}})
        app = Papertown(api, start_server=False, events=False)
        async with app.run_test(size=(150, 45)) as pilot:
            await until(pilot, lambda: isinstance(app.screen, Main) and app.place == "projects" and app.current.pending)
            projects = app.current
            item = projects.pending[0]
            assert projects.line["id"] == lid and len(projects.pending) == 2
            assert item["kind"] == "matter" and item["facts"] and item["options"] == []
            app.screen.query_one("#pj-table", DataTable).focus()
            await pilot.press("r")
            await until(pilot, lambda: isinstance(app.screen, Form))
            await pilot.press("ctrl+s")
            await until(pilot, lambda: isinstance(app.screen, Prompt))
            assert item["facts"][0] in app.screen.hint
            text = "以接收方确认时间为准，单列超时记录。"
            app.screen.query_one(Input).value = text
            await pilot.press("enter")
            await until(pilot, lambda: isinstance(app.screen, Main) and len(projects.pending) == 1)
            latest = (await api.get(f"/api/lines/{lid}/decided"))["decisions"][0]
            assert latest["text"] == text and latest["mod"] == item["mod"] and latest["source"] == "answer"
            need, = projects.pending
            assert need["kind"] == "need"
            app.screen.query_one("#pj-table", DataTable).focus()
            await pilot.press("r")
            await until(pilot, lambda: isinstance(app.screen, Prompt))
            app.screen.query_one(Input).value = "按超时和参数错误分别报告。"
            await pilot.press("enter")
            await until(pilot, lambda: isinstance(app.screen, Main) and not projects.pending)
            latest = (await api.get(f"/api/lines/{lid}/decided"))["decisions"][0]
            assert latest["ref"] == need["title"] and latest["text"] == "按超时和参数错误分别报告。"
    with serving(s, monkeypatch, service) as url:
        asyncio.run(go(url))


def test_tui_places_idea_and_job(server):
    class RecordingApi(Api):
        def __init__(self):
            super().__init__(server)
            self.posts = []
            self.staff_reply = None

        async def get(self, path, **params):
            if self.staff_reply and path.endswith("/staff"):
                return self.staff_reply
            return await super().get(path, **params)

        async def post(self, path, body=None):
            self.posts.append((path, body))
            if self.staff_reply and path.endswith("/say"):
                return {}  # exercise routing without delivering a message or starting an agent
            return await super().post(path, body)

    async def go():
        api = RecordingApi()
        app = Papertown(api, start_server=False, events=False)
        async with app.run_test(size=(170, 46)) as pilot:
            await until(pilot, lambda: isinstance(app.screen, Main))
            for i, (key, _) in enumerate(PLACES):
                await pilot.press(str(i + 1))
                await pilot.pause(0.3)
                assert app.place == key

            for key, tabs, attr in (("1", TABS, "tab"), ("7", PAGES, "page")):
                await pilot.press(key)
                for tab, _ in [*tabs[1:], tabs[0]]:
                    await pilot.press("right_square_bracket")
                    assert getattr(app.current, attr) == tab
                await pilot.press("left_square_bracket")
                assert getattr(app.current, attr) == tabs[-1][0]
                await pilot.press("right_square_bracket")

            assert [key for key, _ in PAGES] == ["skills", "mcp", "library"]
            await pilot.press("1", "i")
            app.screen.query_one("#say", Input).value = "TUI 冒烟测试：小模型的工具路由"
            await pilot.press("enter")
            await until(pilot, lambda: any("冒烟" in (ln.get("idea") or ln.get("title") or "") for ln in app.lines))

            assert ("/api/ideas", {"text": "TUI 冒烟测试：小模型的工具路由"}) in api.posts
            line = next(ln for ln in app.lines if "冒烟" in ln.get("idea", ""))
            assert line["status"] == "running"
            assert line["team"] == []
            assert "bank" not in app.hud and "leads" in app.hud
            await pilot.press("escape")
            projects = app.current
            await until(pilot, lambda: projects.line and projects.line["id"] == line["id"])
            table = app.screen.query_one("#pj-table", DataTable)
            table.focus()
            before = projects.line["lead"]["on"]
            await pilot.press("l")
            await until(pilot, lambda: projects.line["lead"]["on"] is not before)
            assert (f"/api/lines/{line['id']}/lead", {"on": not before}) in api.posts
            await pilot.press("l")
            await until(pilot, lambda: projects.line["lead"]["on"] is before)
            assert projects.line["team"] == []  # resident startup is disabled throughout this test

            for staff, endpoint in [
                ({"who": "coder", "name": "代码员工", "agent": {"id": "coder-test"}}, "/api/agents/coder-test/say"),
                ({"who": "assistant", "name": "小助手", "agent": None}, "/api/assistant/say"),
            ]:
                api.staff_reply = staff
                table.focus()
                await pilot.press("a")
                box = app.screen.query_one("#say", Input)
                box.value = "请说明此处的进展"
                await pilot.press("enter")
                await until(pilot, lambda: box.value == "")
                path, body = api.posts[-1]
                assert path == endpoint
                assert body["text"].startswith("关于") and body["text"].endswith("：请说明此处的进展")
                await pilot.press("escape")
            api.staff_reply = None

            await pilot.press("2", "n")
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
