"""HTTP API and the live event stream. Serves the built web app too, when there is one.

    uv run papertown serve            # http://127.0.0.1:8000
"""

from __future__ import annotations

import asyncio
import json
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import stages, status as status_mod
from .config import Settings
from .pipeline import LineError
from .town import Town

FILES = {"main.tex", "refs.bib", "main.pdf", "paper.zip"}
ASK_ROLE = {"hatchery": "hatcher", "mill": "designer", "farm": "experimenter", "power_sim": "experimenter", "press": "writer",
            "qa": "reviewer", "depot": "keeper", "workshop": "keeper", "logistics": "keeper", "dock_github": "keeper"}


class IdeaIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    budget: float | None = Field(default=None, gt=0, le=50)


class AdjustIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


class ChatIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    building: str | None = None


def create_app(settings: Settings | None = None) -> FastAPI:
    town = Town(settings)

    async def watch_skills():
        while True:
            await asyncio.sleep(2)
            added, removed = await asyncio.to_thread(town.skills.refresh)
            if added or removed:
                town.bus.publish("skills", added=added, removed=removed, skills=[s.summary() for s in town.skills.all()])

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await asyncio.to_thread(town.start)
        task = asyncio.create_task(watch_skills())
        yield
        task.cancel()
        await asyncio.to_thread(town.stop)

    app = FastAPI(title="Papertown", lifespan=lifespan)
    app.state.town = town

    def guard(fn, *args):
        try:
            return fn(*args)
        except LineError as e:
            raise HTTPException(400, str(e)) from e

    @app.get("/api/health")
    def health():
        return {"ok": True, "provider": town.provider.name, "offline": town.s.offline, "ports": town.mcp.status}

    @app.get("/api/world")
    def world():
        return {"placements": town.world.placements(), "running": status_mod.running(town), "hud": status_mod.hud(town),
                "districts": town.world.districts}

    @app.get("/api/buildings/{bid}")
    def building(bid: str):
        sheet = town.world.sheet(bid)
        if not sheet:
            raise HTTPException(404, f"没有这座建筑：{bid}")
        return sheet

    @app.get("/api/lines")
    def lines():
        return town.pipeline.lines()

    @app.get("/api/lines/{line_id}")
    def line(line_id: str):
        snap = town.pipeline.snapshot(line_id)
        if not snap:
            raise HTTPException(404, "没有这条流水线")
        snap["outputs"] = {r["stage"]: r["body"] for r in town.db.q(
            "select stage, body from items where line_id = ? order by created_at", line_id)}
        return snap

    @app.post("/api/ideas")
    def submit_idea(body: IdeaIn):
        return guard(town.pipeline.submit_idea, body.text, body.budget)

    @app.post("/api/lines/{line_id}/hatch")
    def hatch(line_id: str):
        return guard(town.pipeline.hatch, line_id)

    @app.post("/api/lines/{line_id}/adjust")
    def adjust(line_id: str, body: AdjustIn):
        return guard(town.pipeline.adjust, line_id, body.text)

    @app.post("/api/lines/{line_id}/resume")
    def resume(line_id: str):
        return guard(town.pipeline.resume, line_id)

    @app.get("/api/lines/{line_id}/files/{name}")
    def file(line_id: str, name: str):
        p = town.press.root / line_id / name
        if name not in FILES or not town.pipeline.snapshot(line_id) or not p.exists():
            raise HTTPException(404, "文件不存在")
        return FileResponse(p, filename=f"{line_id}-{name}")

    @app.get("/api/messages")
    def messages(limit: int = 80, line_id: str | None = None):
        rows = town.db.q("select * from messages" + (" where line_id = ?" if line_id else "") + " order by id desc limit ?",
                         *([line_id] if line_id else []), min(limit, 300))
        workers = {w["id"]: w for w in town.market.all()}
        for r in rows:
            w = workers.get(r["worker_id"])
            r["worker"] = {"id": w["id"], "role": w["role"], "level": w["level"]} if w else None
        return rows[::-1]

    @app.get("/api/trace")
    def trace(limit: int = 60, line_id: str | None = None):
        rows = town.db.q("select * from trace" + (" where line_id = ?" if line_id else "") + " order by id desc limit ?",
                         *([line_id] if line_id else []), min(limit, 500))
        return rows[::-1]

    @app.post("/api/chat")
    def chat(body: ChatIn):
        if not body.building:
            return {"line": guard(town.pipeline.submit_idea, body.text, None)}
        b = town.world.get(body.building)
        if not b:
            raise HTTPException(404, "没有这座建筑")
        sheet = town.world.sheet(b["id"])
        line_id = b["line_id"] or sheet.get("active_line")
        ln = town.db.one("select * from lines where id = ?", line_id) if line_id else None
        role = ASK_ROLE.get(b["type"], "scout")
        worker = town.market.best(role)[0]
        town.message(line_id, "user", None, "text", {"text": body.text, "to": b["id"]})
        context = f"{sheet['name']}现在：{sheet.get('job', '')}。"

        def answer():
            try:
                out, _ = stages.ask(town, worker, b, body.text, ln, context)
                town.message(line_id, "worker", worker["id"], "text", {"text": out.get("text", ""), "from": b["id"]})
            except Exception as e:
                town.message(line_id, "system", None, "error", {"text": f"回答失败：{e}"})

        threading.Thread(target=answer, daemon=True).start()
        return {"ok": True, "worker": worker["id"]}

    @app.get("/api/status")
    def status():
        return status_mod.status(town)

    @app.get("/api/skills")
    def skills():
        town.skills.refresh()
        return [s.summary() for s in town.skills.all()]

    @app.get("/api/workers")
    def workers():
        return town.market.all()

    @app.get("/api/events")
    async def events(request: Request):
        q = town.bus.subscribe()

        async def stream():
            try:
                yield "retry: 3000\n\n"
                while not await request.is_disconnected():
                    try:
                        ev = await asyncio.wait_for(q.get(), timeout=15)
                        yield f"event: {ev['type']}\ndata: {json.dumps(ev, ensure_ascii=False)}\n\n"
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"
            finally:
                town.bus.unsubscribe(q)

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    if town.s.web_dist.is_dir():
        app.mount("/", StaticFiles(directory=town.s.web_dist, html=True), name="web")
    return app
