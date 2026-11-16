"""HTTP API and the live event stream; serves the built web app too, when there is one."""

from __future__ import annotations

import asyncio
import json
import threading
from contextlib import asynccontextmanager
from typing import Literal
from urllib.parse import urlparse

from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import samples, stages, status as status_mod
from .agents import AgentError, ROLES
from .ask import AskError
from .assistant import ID as ASSISTANT, ActError
from .auth import COOKIE, DAYS, Auth, AuthError, Gate
from .bounds import BoundsError
from .cards import CardError
from .paseo_models import ModelError
from .leads import LeadError
from .config import SERVER_DIR, Settings
from .library import RAG_LIMITS
from .farm import FarmError, summarize
from .history import HistoryError
from .pages import KINDS as PAGE_KINDS, MAX as PAGE_MAX, PageError, csp as page_csp, render as render_page
from .mcp_hub import McpError
from .pipeline import LineError
from .skim import SkimError
from .town import Town
from .workspace import WsError
from .world import ASK_ROLE

FILES = {"main.tex", "refs.bib", "main.pdf", "paper.zip"}


class SkimIn(BaseModel):
    scope: str
    key: str = Field(min_length=3, max_length=200)
    value: str | None = None  # None unsets the key
    line_id: str | None = None
    agent_id: str | None = None


class BoundsIn(BaseModel):
    line_id: str | None = None  # none: the global level
    role: str | None = None  # with line_id: one of the project's workers
    rules: list[dict] = []
    off: list[str] = []


class LeadIn(BaseModel):
    supervise: bool | None = None
    every: int | None = Field(default=None, ge=10, le=1440)


class AnswerIn(BaseModel):
    text: str = Field(min_length=1, max_length=2000)


class TellIn(BaseModel):
    to: str = Field(min_length=1, max_length=80)
    text: str = Field(min_length=1, max_length=8000)
    now: bool = False
    line: str | None = None


class AnswerByIn(BaseModel):
    id: str = Field(min_length=1, max_length=20)
    text: str = Field(min_length=1, max_length=2000)


class LoginIn(BaseModel):
    password: str = Field(max_length=200)


class PasswordIn(BaseModel):
    password: str = Field(max_length=200)
    old: str | None = Field(default=None, max_length=200)  # from another device: the one it replaces


class CardAsk(BaseModel):
    note: str = Field(default="", max_length=300)


class CardIn(BaseModel):
    card: dict


class LayoutIn(BaseModel):
    panes: list[str] | None = None  # None: back to the default


class MemoryIn(BaseModel):
    keys: list[str] = Field(min_length=1, max_length=400)


class QuestionIn(BaseModel):
    q: str = Field(min_length=1, max_length=1000)
    lead: bool = False


class ReplyIn(BaseModel):
    id: str
    text: str = Field(default="", max_length=20000)
    html: str | None = Field(default=None, max_length=PAGE_MAX)


class PublishIn(BaseModel):
    html: str = Field(min_length=1, max_length=PAGE_MAX)
    title: str = Field(default="", max_length=200)
    kind: str = "explain"
    line: str | None = None


class ReportIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    key: bool = False


class McpServerIn(BaseModel):
    name: str
    command: str
    args: list[str] = []
    env: dict[str, str] = {}


class ToggleIn(BaseModel):
    enabled: bool


class RagIn(BaseModel):
    top_k: int | None = None
    candidates: int | None = None
    vectors: bool | None = None


class IdeaIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    budget: float | None = Field(default=None, gt=0, le=50)


class AdjustIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


class ChatIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    building: str | None = None


class AgentIn(BaseModel):
    line_id: str
    role: str


class ImportIn(BaseModel):
    line_id: str
    role: str
    ext_id: str


class PermitIn(BaseModel):
    request_id: str
    allow: bool


class StartIn(BaseModel):
    runtime: str | None = None
    provider: str | None = None
    model: str | None = None
    thinking: str | None = None


class LlmIn(BaseModel):
    provider: str | None = None
    model_strong: str | None = None
    model_cheap: str | None = None
    effort: str | None = None


class SaveIn(BaseModel):
    path: str
    text: str


class SayIn(BaseModel):
    text: str = Field(min_length=1, max_length=20000)
    mode: Literal["steer", "queue"] | None = None


class JobIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    command: str = Field(min_length=1, max_length=4000)
    backend: str = "local"
    line_id: str | None = None


class BridgeIn(BaseModel):
    events: list[dict]


class PageIn(BaseModel):
    page: dict


class AssistantSayIn(BaseModel):
    text: str = Field(min_length=1, max_length=20000)
    page: dict | None = None


class DefaultIn(BaseModel):
    role: str
    provider: str | None = None  # none: back to the environment's setting
    model: str | None = None
    thinking: str | None = None


class DismissIn(BaseModel):
    keys: list[str] | None = None  # none: all of it


class DecideIn(BaseModel):
    allow: bool


class ResumeIn(BaseModel):
    id: str = Field(min_length=1, max_length=120)


class AskIn(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    choices: list[str] = []
    point: bool = False


class ShowIn(BaseModel):
    mod: str | None = None
    line: str | None = None
    file: str | None = None
    job: str | None = None
    ref: str | None = None
    note: str | None = None


class ActIn(BaseModel):
    action: str = Field(min_length=1, max_length=40)
    args: dict = {}
    why: str = ""


def job_text(j: dict, log: str = "") -> str:
    out = f"{j['id']} {j['name']}（{j['backend']}）：{j['status']} {j['progress']}%"
    if j.get("note"):
        out += f"，{j['note']}"
    if j["status"] == "done":
        out += f"\n{summarize(j)}"
    if log:
        out += f"\n--- 日志最后几行 ---\n{log}"
    return out


def mapped(*errors: type[Exception]):
    """A caller that turns the given errors into HTTP errors: their own status, else 400."""
    def call(fn, *args):
        try:
            return fn(*args)
        except errors as e:
            raise HTTPException(getattr(e, "status", 400), str(e)) from e
    return call


class Pages(StaticFiles):
    """The built web app at every address it routes itself: a path that is no file gets index.html.
    Only assets/ is content-hashed, so the rest is no-cache; fonts allow any origin for the agents' sandboxed pages."""

    async def get_response(self, path: str, scope):
        try:
            r = await super().get_response(path, scope)
        except StarletteHTTPException as e:
            if e.status_code != 404 or path.startswith("api") or "." in path.rsplit("/", 1)[-1]:
                raise
            r = await super().get_response("index.html", scope)
        if not path.startswith("assets/"):
            r.headers["Cache-Control"] = "no-cache"
        if path.endswith((".woff2", ".woff")):
            r.headers["Access-Control-Allow-Origin"] = "*"
        return r


def create_app(settings: Settings | None = None) -> FastAPI:
    town = Town(settings)
    authed, guard, ws, farm = mapped(AuthError), mapped(LineError), mapped(WsError), mapped(FarmError)
    agents, assistant = mapped(AgentError), mapped(AgentError, ActError)
    leads = mapped(LeadError, AgentError, CardError)
    known = mapped(HistoryError, AskError, AgentError, CardError, PageError)
    skim, mcp = mapped(SkimError), mapped(McpError)

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
    auth = Auth(town.s.data_dir)
    app.add_middleware(Gate, auth=auth)

    # signing in
    @app.get("/api/auth/state")
    def auth_state(request: Request):
        return auth.state(request.scope)

    @app.post("/api/auth/login")
    def auth_login(body: LoginIn, request: Request, response: Response):
        tok = authed(auth.login, request.scope, body.password, request.headers.get("user-agent", ""))
        https = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
        response.set_cookie(COOKIE, tok, max_age=DAYS * 86400, httponly=True, samesite="lax", secure=https, path="/")
        return {"ok": True}

    @app.post("/api/auth/logout")
    def auth_logout(request: Request, response: Response):
        auth.logout(request.scope)
        response.delete_cookie(COOKIE, path="/")
        return {"ok": True}

    @app.post("/api/auth/logout-all")
    def auth_logout_all(request: Request, response: Response):
        n = authed(auth.logout_all, request.scope)
        response.delete_cookie(COOKIE, path="/")
        return {"ok": True, "ended": n}

    @app.post("/api/auth/password")
    def auth_password(body: PasswordIn, request: Request):
        authed(auth.set_password, request.scope, body.password, body.old)
        return auth.state(request.scope)

    @app.delete("/api/auth/password")
    def auth_password_clear(request: Request):
        authed(auth.clear_password, request.scope)
        return auth.state(request.scope)

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

    @app.get("/api/lines/{line_id}/papers")
    def line_papers(line_id: str):
        if not town.pipeline.snapshot(line_id):
            raise HTTPException(404, "没有这条流水线")
        return samples.papers_of(town, line_id)

    @app.get("/api/lines/{line_id}/linked/pdf")
    def linked_pdf(line_id: str):
        p = town.linked.pdf(line_id)
        if not p:
            raise HTTPException(404, "这个项目的论文还没有编译好的 PDF")
        return FileResponse(p, media_type="application/pdf", headers={"Content-Disposition": f'inline; filename="{p.name}"'})

    # a project's files and data, for the console
    @app.get("/api/lines/{line_id}/ws")
    def ws_info(line_id: str):
        return ws(town.workspace.info, line_id)

    @app.get("/api/lines/{line_id}/ws/{root}/tree")
    def ws_tree(line_id: str, root: str):
        return ws(town.workspace.tree, line_id, root)

    @app.get("/api/lines/{line_id}/ws/{root}/file")
    def ws_read(line_id: str, root: str, path: str):
        return ws(town.workspace.read, line_id, root, path)

    @app.put("/api/lines/{line_id}/ws/{root}/file")
    def ws_save(line_id: str, root: str, body: SaveIn):
        return ws(town.workspace.save, line_id, root, body.path, body.text)

    @app.get("/api/lines/{line_id}/ws/{root}/diff")
    def ws_diff(line_id: str, root: str, path: str):
        return ws(town.workspace.diff, line_id, root, path)

    @app.post("/api/lines/{line_id}/ws/paper/compile")
    def ws_compile(line_id: str):
        return ws(town.workspace.compile, line_id)

    @app.get("/api/lines/{line_id}/ws/paper/pdf")
    def ws_pdf(line_id: str):
        p = ws(town.workspace.pdf, line_id)
        if not p:
            raise HTTPException(404, "这篇论文还没有编译好的 PDF")
        return FileResponse(p, media_type="application/pdf", headers={"Cache-Control": "no-store", "Content-Disposition": f'inline; filename="{p.name}"'})

    @app.get("/api/lines/{line_id}/data")
    def line_data(line_id: str):
        return ws(town.workspace.data, line_id)

    @app.get("/api/library")
    def library(q: str = "", topic: str = "", limit: int = 60):
        return samples.shelf(town, q, topic, limit)

    @app.post("/api/samples")
    def put_samples():
        return mapped(samples.SampleError)(samples.seed, town)

    @app.get("/api/lines/{line_id}/files/{name}")
    def file(line_id: str, name: str):
        p = town.press.root / line_id / name
        if name not in FILES or not town.pipeline.snapshot(line_id) or not p.exists():
            raise HTTPException(404, "文件不存在")
        return FileResponse(p, filename=f"{line_id}-{name}")

    def latest(table: str, line_id: str | None, limit: int) -> list[dict]:
        where = " where line_id = ?" if line_id else ""
        return town.db.q(f"select * from {table}{where} order by id desc limit ?", *([line_id] if line_id else []), limit)[::-1]

    @app.get("/api/messages")
    def messages(limit: int = 80, line_id: str | None = None):
        rows = latest("messages", line_id, min(limit, 300))
        workers = {w["id"]: w for w in town.market.all()}
        for r in rows:
            w = workers.get(r["worker_id"])
            r["worker"] = {"id": w["id"], "role": w["role"], "level": w["level"]} if w else None
        return rows

    @app.get("/api/trace")
    def trace(limit: int = 60, line_id: str | None = None):
        return latest("trace", line_id, min(limit, 500))

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

    @app.get("/api/departments")
    def departments():
        return status_mod.departments(town)

    # the farm
    @app.get("/api/jobs")
    def jobs(line_id: str | None = None, external: bool = True):
        # external=false: only the farm's own (the TUI reads nvidb's itself)
        ext = [j for j in town.linked.farm_jobs() if not line_id or j["line_id"] == line_id] if external else []
        return {"jobs": ext + town.farm.list(line_id), "backends": town.farm.backends(), "plant": town.plant.status()}

    @app.get("/api/gpus")
    def gpus(fresh: bool = False):
        return town.nvidb.status(fresh)

    @app.get("/api/nvidb/jobs/{job_id}")
    def nvidb_job(job_id: int):
        j = town.nvidb.show(job_id)
        if not j:
            raise HTTPException(404, "nvidb 里没有这个任务")
        return j

    @app.get("/api/jobs/{job_id}")
    def job(job_id: str, tail: int = 200):
        if job_id.startswith("nvidb-"):
            j = next((x for x in town.linked.farm_jobs() if x["id"] == job_id), None)
            if not j:
                raise HTTPException(404, "nvidb 里没有这个任务了")
            return j
        j = town.farm.get(job_id, tail=tail)
        if not j:
            raise HTTPException(404, "没有这个任务")
        return j

    @app.post("/api/jobs")
    def job_submit(body: JobIn):
        return farm(town.farm.submit, body.line_id, body.name, body.command, body.backend, "you")

    @app.post("/api/jobs/{job_id}/cancel")
    def job_cancel(job_id: str):
        return farm(town.farm.cancel, job_id)

    # agents
    @app.get("/api/agents")
    def agent_roster(role: str):
        if role not in ROLES:
            raise HTTPException(400, "没有这个岗位")
        return {"roster": town.agents.roster(role), "available": town.agents.available()}

    @app.post("/api/agents")
    def agent_open(body: AgentIn):
        a = agents(town.agents.ensure, body.line_id, body.role)
        return town.agents.public(a)

    @app.get("/api/agents/{agent_id}")
    def agent(agent_id: str, after: int = 0):
        a = town.agents.get(agent_id)
        if not a:
            raise HTTPException(404, "没有这个员工")
        return {"agent": town.agents.public(a), "events": town.agents.events(agent_id, after)}

    @app.post("/api/agents/{agent_id}/start")
    def agent_start(agent_id: str, body: StartIn | None = None):
        b = body or StartIn()
        return agents(town.agents.start, agent_id, b.runtime, b.provider, b.model, b.thinking)

    @app.post("/api/agents/import")
    def agent_import(body: ImportIn):
        return agents(town.agents.import_paseo, body.line_id, body.role, body.ext_id)

    @app.get("/api/agents/{agent_id}/timeline")
    def agent_timeline(agent_id: str, limit: int = 200):
        return agents(town.agents.timeline, agent_id, min(max(limit, 1), 1000))

    @app.post("/api/agents/{agent_id}/permit")
    def agent_permit(agent_id: str, body: PermitIn):
        agents(town.agents.permit, agent_id, body.request_id, body.allow)
        return {"ok": True}

    @app.get("/api/paseo/conversations")
    def paseo_conversations():
        try:
            rows = town.agents.paseo.conversations()
        except Exception as e:  # noqa: BLE001 - the SDK's own message is the useful part
            raise HTTPException(400, str(e)) from e
        linked = {a["ext_id"]: f"#{a['seq']} 的{ROLES[a['role']]['name']}" for a in town.db.q(
            "select a.ext_id, a.role, l.seq from agents a join lines l on l.id = a.line_id where a.runtime = 'paseo' and a.ext_id is not null")}
        # the assistant's own conversations are not for a project to take
        mine = [c for c in rows if (c.get("labels") or {}).get("papertown.role") != ASSISTANT]
        return {"conversations": [c | {"linked": linked.get(c["id"])} for c in mine]}

    @app.post("/api/agents/{agent_id}/open")
    def agent_open_desktop(agent_id: str):
        agents(town.agents.open_desktop, agent_id)
        return {"ok": True}

    @app.get("/api/llm")
    def llm():
        return town.llm()

    @app.post("/api/llm")
    def set_llm(body: LlmIn):
        return mapped(ValueError)(town.set_llm, body.provider, body.model_strong, body.model_cheap, body.effort)

    @app.get("/api/paseo")
    def paseo(fresh: bool = False):
        p, m = town.agents.paseo, town.paseo_models
        st = p.status(fresh=True)
        try:
            providers = p.providers(fresh) if st["ok"] else []
        except Exception as e:  # noqa: BLE001 - the CLI's own message is the useful part
            st = st | {"note": str(e)}
            providers = []
        if providers:
            m.learn(providers)
        return {"status": st, "providers": providers, "defaults": m.defaults(), "news": m.news()}

    @app.post("/api/paseo/defaults")
    def paseo_default(body: DefaultIn):
        return mapped(ModelError)(town.paseo_models.set_default, body.role, body.provider, body.model, body.thinking)

    @app.get("/api/paseo/news")
    def paseo_news():
        return {"news": town.paseo_models.news(), "defaults": town.paseo_models.defaults()}

    @app.post("/api/paseo/news/dismiss")
    def paseo_news_dismiss(body: DismissIn):
        return {"news": town.paseo_models.dismiss(body.keys)}

    @app.post("/api/agents/{agent_id}/stop")
    def agent_stop(agent_id: str):
        return agents(town.agents.stop, agent_id)

    @app.post("/api/agents/{agent_id}/say")
    def agent_say(agent_id: str, body: SayIn):
        return agents(town.agents.say, agent_id, body.text, body.mode)

    @app.post("/api/agents/{agent_id}/brief")
    def agent_brief(agent_id: str):
        return agents(town.agents.say, agent_id, agents(town.agents.brief, agent_id))

    @app.post("/api/agents/{agent_id}/abort")
    def agent_abort(agent_id: str):
        agents(town.agents.abort, agent_id)
        return {"ok": True}

    # work boundaries: global, project, worker
    @app.get("/api/bounds")
    def bounds(line_id: str | None = None):
        return town.bounds.view(line_id)

    @app.put("/api/bounds")
    def bounds_save(body: BoundsIn):
        return mapped(BoundsError)(town.bounds.save, body.line_id, body.role, body.rules, body.off)

    # the 进展 page: each project's card, lead, reports, questions, memory and pages
    @app.get("/api/cards")
    def cards():
        return {"cards": town.cards.all(), "layout": town.cards.layout()}

    @app.get("/api/lines/{line_id}/card")
    def card_one(line_id: str):
        return leads(town.cards.one, line_id)

    @app.post("/api/cards/layout")
    def cards_layout(body: LayoutIn):
        return leads(town.cards.set_layout, body.panes)

    @app.post("/api/cards/update")
    def cards_update():
        return town.cards.request_all()

    @app.post("/api/lines/{line_id}/card")
    def card_update(line_id: str, body: CardAsk):
        return leads(town.cards.request, line_id, body.note)

    @app.post("/api/lines/{line_id}/card/cancel")
    def card_cancel(line_id: str):
        return leads(town.cards.cancel, line_id)

    @app.get("/api/lines/{line_id}/memory")
    def memory(line_id: str):
        return {"items": town.history.imported(line_id), "counts": town.history.counts(line_id)}

    @app.get("/api/lines/{line_id}/memory/scan")
    def memory_scan(line_id: str):
        return town.history.scan(line_id)

    @app.post("/api/lines/{line_id}/memory/import")
    def memory_import(line_id: str, body: MemoryIn):
        return known(town.history.do_import, line_id, body.keys)

    @app.get("/api/lines/{line_id}/memory/{mid}")
    def memory_one(line_id: str, mid: str):
        return known(town.history.get, line_id, mid)

    @app.delete("/api/lines/{line_id}/memory/{mid}")
    def memory_remove(line_id: str, mid: str):
        return known(town.history.remove, line_id, mid)

    @app.get("/api/lines/{line_id}/search")
    def line_search(line_id: str, q: str, k: int = 8):
        return {"hits": [{x: v for x, v in h.items() if x != "_text"} for h in known(town.asker.search, line_id, q, min(max(k, 1), 30))]}

    @app.get("/api/lines/{line_id}/questions")
    def questions(line_id: str):
        return {"questions": town.asker.questions(line_id), "lead": bool(town.cards._lead(line_id)), "offline": town.s.offline}

    @app.post("/api/lines/{line_id}/questions")
    def question_ask(line_id: str, body: QuestionIn):
        return known(town.asker.ask, line_id, body.q, body.lead)

    @app.delete("/api/lines/{line_id}/questions/{qid}")
    def question_remove(line_id: str, qid: str):
        return known(town.asker.remove, line_id, qid)

    @app.get("/api/lines/{line_id}/pages")
    def pages(line_id: str):
        return {"pages": town.pages.all(line_id), "kinds": PAGE_KINDS}

    @app.get("/api/lines/{line_id}/pages/{pid}/view")
    def page_view(line_id: str, pid: str, request: Request, look: str = ""):
        try:
            html = town.pages.html(line_id, pid)
        except PageError as e:
            raise HTTPException(404, str(e)) from e
        font = min(town.s.web_dist.glob("assets/lxgwwenkaigbscreen-*.css"), default=None)
        origin = f"{request.headers.get('x-forwarded-proto') or request.url.scheme}://{request.headers.get('host') or request.url.netloc}"
        return HTMLResponse(render_page(html, f"/assets/{font.name}" if font else "", look),
                            headers={"Content-Security-Policy": page_csp(origin if font else ""), "X-Content-Type-Options": "nosniff",
                                     "Referrer-Policy": "no-referrer", "Cache-Control": "no-store"})

    @app.delete("/api/lines/{line_id}/pages/{pid}")
    def page_remove(line_id: str, pid: str):
        known(town.pages.remove, line_id, pid)
        return {"ok": True}

    @app.get("/api/lines/{line_id}/lead")
    def lead(line_id: str):
        if not town.pipeline.line(line_id):
            raise HTTPException(404, "没有这个项目")
        return town.leads.view(line_id)

    @app.post("/api/lines/{line_id}/lead")
    def lead_settings(line_id: str, body: LeadIn):
        if not town.pipeline.line(line_id):
            raise HTTPException(404, "没有这个项目")
        return town.leads.configure(line_id, body.supervise, body.every)

    @app.get("/api/reports")
    def reports(line_id: str | None = None, limit: int = 30):
        n = min(max(limit, 1), 200)
        if line_id:
            return {"reports": town.leads.reports(line_id, n), "asks": town.leads.asks(line_id)}
        return {"reports": town.db.q("select * from reports where kind = 'report' order by id desc limit ?", n)[::-1],
                "asks": town.leads.asks()}

    @app.post("/api/reports/{report_id}/answer")
    def report_answer(report_id: int, body: AnswerIn):
        return leads(town.leads.answer, report_id, body.text)

    # the console's assistant, in the sidebar
    @app.get("/api/assistant")
    def assistant_view():
        return town.assistant.view()

    @app.post("/api/assistant/page")
    def assistant_page(body: PageIn):
        town.assistant.set_page(body.page)
        return {"ok": True}

    @app.post("/api/assistant/say")
    def assistant_say(body: AssistantSayIn):
        return assistant(town.assistant.say, body.text, body.page)

    @app.post("/api/assistant/acts/{event_id}")
    def assistant_decide(event_id: int, body: DecideIn):
        return assistant(town.assistant.decide, event_id, body.allow)

    @app.post("/api/assistant/new")
    def assistant_new():
        return assistant(town.assistant.reset)

    @app.get("/api/assistant/history")
    def assistant_history():
        return {"conversations": town.assistant.history()}

    @app.post("/api/assistant/resume")
    def assistant_resume(body: ResumeIn):
        return assistant(town.assistant.resume, body.id)

    # the bridge inside each agent
    def bridged(agent_id: str, token: str | None) -> dict:
        try:
            return town.agents.check(agent_id, token)
        except AgentError as e:
            raise HTTPException(403, str(e)) from e

    @app.post("/api/bridge/{agent_id}/events")
    def bridge_events(agent_id: str, body: BridgeIn, x_papertown_token: str | None = Header(default=None)):
        bridged(agent_id, x_papertown_token)
        town.agents.ingest(agent_id, body.events)
        return {"ok": True}

    @app.get("/api/bridge/{agent_id}/inbox")
    async def bridge_inbox(agent_id: str, wait: float = 20, x_papertown_token: str | None = Header(default=None)):
        bridged(agent_id, x_papertown_token)
        loop = asyncio.get_running_loop()
        t0 = loop.time()
        while not town.agents.has_mail(agent_id) and loop.time() - t0 < min(wait, 25):
            await asyncio.sleep(0.25)
        return {"messages": town.agents.take(agent_id)}

    @app.get("/api/bridge/{agent_id}/brief")
    def bridge_brief(agent_id: str, line: str | None = None, x_papertown_token: str | None = Header(default=None)):
        a = bridged(agent_id, x_papertown_token)
        if a["role"] == ASSISTANT:
            return {"text": assistant(town.assistant.brief, line)}
        return {"text": town.brief(a["line_id"], a["role"])}

    @app.get("/api/bridge/{agent_id}/rules")
    def bridge_rules(agent_id: str, x_papertown_token: str | None = Header(default=None)):
        a = bridged(agent_id, x_papertown_token)
        return {"text": town.bounds.text(a["role"], a["line_id"], str(town.agents.pt(a)) if a["runtime"] == "paseo" else None)}

    def helper(agent_id: str, token: str | None) -> dict:
        a = bridged(agent_id, token)
        if a["role"] != ASSISTANT:
            raise HTTPException(403, "只有小助手能用")
        return a

    @app.get("/api/bridge/{agent_id}/page")
    def bridge_page(agent_id: str, x_papertown_token: str | None = Header(default=None)):
        helper(agent_id, x_papertown_token)
        return {"text": town.assistant.page_text()}

    @app.get("/api/bridge/{agent_id}/actions")
    def bridge_actions(agent_id: str, x_papertown_token: str | None = Header(default=None)):
        helper(agent_id, x_papertown_token)
        return {"text": town.assistant.actions_text()}

    @app.post("/api/bridge/{agent_id}/ask")
    def bridge_ask(agent_id: str, body: AskIn, x_papertown_token: str | None = Header(default=None)):
        a = bridged(agent_id, x_papertown_token)
        if a["role"] != ASSISTANT:
            q = leads(town.leads.ask, agent_id, body.question, body.choices)
            return {"text": f"已经问了用户（问题 {q['id']}），他的回答会作为一条 <answer> 消息发给你。先做别的，或者结束这一轮。"}
        town.assistant.ask(body.question, body.choices, body.point)
        return {"text": "已经在侧边栏里问了用户。他的回答会作为下一条消息发来，先结束这一轮。"}

    def own_line(a: dict, line: str | None) -> str:
        """The project an agent asks about: its own; the assistant names one, else the one on your screen."""
        if a["role"] != ASSISTANT:
            return a["line_id"]
        lid = assistant(town.assistant.line_id, line)
        if not lid:
            raise HTTPException(400, "说一下是哪个项目")
        return lid

    @app.get("/api/bridge/{agent_id}/status")
    def bridge_status(agent_id: str, line: str | None = None, x_papertown_token: str | None = Header(default=None)):
        a = bridged(agent_id, x_papertown_token)
        return {"text": leads(town.leads.status, own_line(a, line))}

    @app.get("/api/bridge/{agent_id}/worker/{role}")
    def bridge_worker(agent_id: str, role: str, n: int = 6, line: str | None = None, x_papertown_token: str | None = Header(default=None)):
        a = bridged(agent_id, x_papertown_token)
        if a["role"] not in ("lead", ASSISTANT):
            raise HTTPException(403, "只有项目负责人和小助手能看员工的对话")
        return {"text": leads(town.leads.peek, own_line(a, line), role, min(max(n, 1), 30))}

    @app.get("/api/bridge/{agent_id}/reports")
    def bridge_reports(agent_id: str, line: str | None = None, x_papertown_token: str | None = Header(default=None)):
        a = bridged(agent_id, x_papertown_token)
        rows = town.leads.reports(own_line(a, line), 20)
        text = "\n".join(f"- {r['ts'][:16].replace('T', ' ')} {r['data'].get('who') or ''}"
                         + (f"【关键】：{r['data']['text']}" if r["kind"] == "report" and r["data"].get("key")
                            else f"：{r['data']['text']}" if r["kind"] == "report"
                            else f" 问（问题 {r['id']}{'，等回答' if r['data'].get('open') else ''}）：{r['data']['question']}"
                            + (f" → 回答：{r['data']['answer']}" if r["data"].get("answer") else "")) for r in rows)
        return {"text": text or "这个项目还没有汇报和问题。"}

    @app.post("/api/bridge/{agent_id}/tell")
    def bridge_tell(agent_id: str, body: TellIn, x_papertown_token: str | None = Header(default=None)):
        a = bridged(agent_id, x_papertown_token)
        if a["role"] == ASSISTANT:  # to a project: "#6" for its lead, "#6 coder" for one of its workers
            words = body.to.replace(":", " ").split()
            line = next((w for w in words if w.lstrip("#").isdigit() or w.startswith("line_")), body.line)
            role = next((w for w in words if w != line), None)
            return acted(town.assistant.act, "tell", {"line": line or town.assistant.line_id(None), "role": role,
                                                       "text": body.text, "now": body.now}, "")
        return {"text": leads(town.leads.tell, agent_id, body.to, body.text, body.now)}

    @app.post("/api/bridge/{agent_id}/answer")
    def bridge_answer(agent_id: str, body: AnswerByIn, x_papertown_token: str | None = Header(default=None)):
        helper(agent_id, x_papertown_token)
        return acted(town.assistant.act, "answer", {"id": body.id, "text": body.text}, "")

    @app.post("/api/bridge/{agent_id}/report")
    def bridge_report(agent_id: str, body: ReportIn, x_papertown_token: str | None = Header(default=None)):
        a = bridged(agent_id, x_papertown_token)
        if a["role"] != "lead":
            raise HTTPException(403, "只有项目负责人写汇报；员工有事用 pt tell lead 告诉负责人")
        r = leads(town.leads.report, agent_id, body.text, body.key)
        return {"text": f"已经记下这条汇报（{r['id']}），用户在项目的概览里会看到。"}

    @app.get("/api/bridge/{agent_id}/card")
    def bridge_card(agent_id: str, x_papertown_token: str | None = Header(default=None)):
        a = bridged(agent_id, x_papertown_token)
        if a["role"] != "lead":
            raise HTTPException(403, "只有项目负责人写项目卡片")
        return {"text": town.cards.guide(a["line_id"])}

    @app.post("/api/bridge/{agent_id}/card")
    def bridge_card_set(agent_id: str, body: CardIn, x_papertown_token: str | None = Header(default=None)):
        bridged(agent_id, x_papertown_token)
        c = leads(town.cards.write, agent_id, body.card)
        return {"text": f"卡片更新好了（{c['summary'][:30]}…），用户在「进展」页上会看到。"}

    @app.get("/api/bridge/{agent_id}/recall")
    def bridge_recall(agent_id: str, q: str, x_papertown_token: str | None = Header(default=None)):
        a = bridged(agent_id, x_papertown_token)
        if not a["line_id"]:
            raise HTTPException(400, "你没有自己的项目：检索要在一个项目里")
        return {"text": known(town.asker.recall, a["line_id"], q)}

    @app.post("/api/bridge/{agent_id}/reply")
    def bridge_reply(agent_id: str, body: ReplyIn, x_papertown_token: str | None = Header(default=None)):
        bridged(agent_id, x_papertown_token)
        r = known(town.asker.reply, agent_id, body.id, body.text, body.html)
        page = f"，页面是「{r['lead']['title']}」" if r["lead"].get("page") else ""
        return {"text": f"回答交上去了（{r['id']}{page}），用户在「进展」页的提问里会看到。"}

    @app.post("/api/bridge/{agent_id}/publish")
    def bridge_publish(agent_id: str, body: PublishIn, x_papertown_token: str | None = Header(default=None)):
        a = bridged(agent_id, x_papertown_token)
        line_id = a["line_id"]
        if a["role"] == ASSISTANT and body.line:
            line_id = assistant(town.assistant.line_id, body.line)
        if not line_id:
            raise HTTPException(400, "说一下是哪个项目：--line <项目>")
        p = known(town.pages.publish, line_id, body.html, body.title, body.kind, a["model"] or "", agent_id)
        return {"text": f"页面发布了（{p['id']}「{p['title']}」），用户在「进展」里这个项目的「汇报与讲解」看。"}

    @app.post("/api/bridge/{agent_id}/show")
    def bridge_show(agent_id: str, body: ShowIn, x_papertown_token: str | None = Header(default=None)):
        helper(agent_id, x_papertown_token)
        t = assistant(town.assistant.show, body.model_dump())
        return {"text": "已经在用户的页面上打开：" + "，".join(f"{k} {v}" for k, v in t.items())}

    @app.post("/api/bridge/{agent_id}/act")
    def bridge_act(agent_id: str, body: ActIn, x_papertown_token: str | None = Header(default=None)):
        helper(agent_id, x_papertown_token)
        return acted(town.assistant.act, body.action, body.args, body.why)

    def acted(fn, *args) -> dict:
        """An action of the assistant's, as pt tells it what became of it."""
        e = assistant(fn, *args)
        d = e["data"]
        if d["status"] == "done":
            return {"id": e["id"], "text": f"已经做了：{d['title']}。{d['result']}"}
        why = f"（按你的工作边界：{d['rule']}）" if d.get("rule") else ""
        return {"id": e["id"], "text": f"已经请用户确认「{d['title']}」{why}。他点了允许或拒绝之后，结果会作为一条 <event> 消息发给你；先告诉他你请求了什么，然后结束这一轮。"}

    @app.post("/api/bridge/{agent_id}/jobs")
    def bridge_submit(agent_id: str, body: JobIn, x_papertown_token: str | None = Header(default=None)):
        a = bridged(agent_id, x_papertown_token)
        kind, rule = town.bounds.policy(a["role"], a["line_id"], "job.submit")
        if kind == "never":
            raise HTTPException(403, f"你的工作边界不让你提交实验任务：{rule['text']}")
        backend = body.backend or "local"
        if kind == "ask":
            q = leads(town.leads.ask, agent_id, f"{town.leads._who(a)}想提交实验任务「{body.name}」：{body.command[:300]}，可以吗？", ["可以", "不可以"],
                      {"action": "job.submit", "name": body.name, "command": body.command, "backend": backend})
            return {"id": None, "name": body.name, "backend": backend, "status": "asking",
                    "text": f"按你的工作边界（{rule['text']}），提交前要先问用户。已经问了（问题 {q['id']}），他同意后会替你提交，结果会告诉你。"}
        return farm(town.farm.submit, a["line_id"], body.name, body.command, backend, agent_id, a["cwd"])

    @app.get("/api/bridge/{agent_id}/jobs")
    def bridge_jobs(agent_id: str, x_papertown_token: str | None = Header(default=None)):
        a = bridged(agent_id, x_papertown_token)
        rows = town.farm.list(a["line_id"], 30)
        return {"jobs": rows, "text": "\n".join(job_text(j) for j in rows) or "这个项目还没有任务。"}

    @app.get("/api/bridge/{agent_id}/jobs/{job_id}")
    def bridge_job(agent_id: str, job_id: str, x_papertown_token: str | None = Header(default=None)):
        a = bridged(agent_id, x_papertown_token)
        j = town.farm.get(job_id)
        if not j or j["line_id"] != a["line_id"]:
            raise HTTPException(404, "这个项目没有这个任务")
        log = town.farm.log(job_id, 30)
        return {"job": j, "text": job_text(j, log)}

    @app.get("/api/skills")
    def skills():
        town.skills.refresh()
        return [s.summary() for s in town.skills.all()]

    # the skill academy: skim, layered per project and conversation
    @app.get("/api/skim")
    def skim_status(fresh: bool = False):
        st = town.skim.status(fresh)
        agents = {a["id"]: a for a in town.db.q("select id, line_id, role, status, runtime, model from agents where role in ('coder', 'writer')")}
        lines = [{"id": ln["id"], "seq": ln["seq"], "title": ln["title"], "status": ln["status"],
                  "agents": [agents[f"{r}-{ln['id']}"] for r in ("coder", "writer") if f"{r}-{ln['id']}" in agents]}
                 for ln in town.db.q("select id, seq, title, status from lines where status != 'dropped' order by seq desc")]
        return st | {"lines": lines}

    @app.get("/api/skim/resolve")
    def skim_resolve(line_id: str | None = None, agent_id: str | None = None):
        return skim(town.skim.resolve, line_id, agent_id)

    @app.post("/api/skim/config")
    def skim_config(body: SkimIn):
        skim(town.skim.set, body.scope, body.key, body.value, body.line_id, body.agent_id)
        skim(town.skim.apply_all, None if body.scope == "global" else body.line_id)
        return skim(town.skim.resolve, body.line_id, body.agent_id)

    # the MCP exchange
    @app.get("/api/mcp")
    def mcp_status():
        return {"servers": town.mcp.info(), "town_file": str(town.mcp.town_file), "config_file": town.s.mcp_config or None,
                "self": {"mcpServers": {"papertown": {"command": "uv", "args": ["--directory", str(SERVER_DIR), "run", "papertown", "mcp"]}}}}

    @app.post("/api/mcp/servers")
    def mcp_add(body: McpServerIn):
        mcp(town.mcp.add, body.name, body.command, body.args, body.env)
        return mcp_status()

    @app.post("/api/mcp/servers/{name}/toggle")
    def mcp_toggle(name: str, body: ToggleIn):
        mcp(town.mcp.toggle, name, body.enabled)
        return mcp_status()

    @app.post("/api/mcp/servers/{name}/restart")
    def mcp_restart(name: str):
        if name not in town.mcp.servers():
            raise HTTPException(400, "这个 MCP server 没有启用")
        town.mcp.restart(name)
        return mcp_status()

    @app.delete("/api/mcp/servers/{name}")
    def mcp_remove(name: str):
        mcp(town.mcp.remove, name)
        return mcp_status()

    # the library as the RAG room
    @app.get("/api/rag")
    def rag_status():
        lib = town.library
        return {"stats": lib.stats(), "opts": lib.opts, "limits": {k: list(v) for k, v in RAG_LIMITS.items()},
                "index": "SQLite FTS5 · BM25 召回 + 关键词覆盖率打分",
                "embed": {"configured": lib.embedder is not None, "model": town.s.embed_model or None,
                          "host": urlparse(town.s.embed_base_url).netloc or None}}

    @app.post("/api/rag")
    def rag_set(body: RagIn):
        town.library.set_opts(**body.model_dump())
        return rag_status()

    @app.get("/api/rag/search")
    def rag_search(q: str, k: int | None = None):
        if not q.strip():
            raise HTTPException(400, "输入要检索的内容")
        return town.library.search(q, k)

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
        app.mount("/", Pages(directory=town.s.web_dist, html=True), name="web")
    return app
