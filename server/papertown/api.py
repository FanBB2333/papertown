"""HTTP API and the live event stream; serves the built web app too, when there is one."""

from __future__ import annotations

import asyncio
import json
import threading
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import samples, status as status_mod
from .agents import AgentError, ROLES
from .herdr import HerdrError
from .prompts import PromptError
from .ask import AskError
from .assistant import ID as ASSISTANT, ActError
from .auth import COOKIE, Auth, AuthError, Gate
from .bounds import BoundsError
from .canvas import CanvasError
from .cards import CardError
from .decisions import DecisionError
from .network import Network, NetworkError
from .checks import CheckError
from .paseo_models import ModelError
from .usage import UsageError
from .paseo import PaseoError
from .leads import LeadError
from .config import SERVER_DIR, Settings
from .library import RAG_LIMITS
from .farm import FarmError, summarize
from .history import HistoryError
from .pages import KINDS as PAGE_KINDS, MAX as PAGE_MAX, PageError, csp as page_csp, render as render_page
from .mcp_hub import McpError
from .pipeline import NAMES as STAGE_NAMES, OWNER, LineError
from .skim import SkimError
from .town import Town
from .workspace import WsError
from .world import STAFF_AT

try:
    from importlib.metadata import version as _version
    VERSION = _version("papertown")
except Exception:  # running from a checkout without the package installed
    VERSION = "0.1.0"

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
    on: bool | None = None


class HireIn(BaseModel):
    role: str = Field(min_length=1, max_length=20)
    runtime: str | None = Field(default=None, max_length=20)
    provider: str | None = Field(default=None, max_length=60)
    model: str | None = Field(default=None, max_length=120)
    thinking: str | None = Field(default=None, max_length=40)


class StageIn(BaseModel):
    stage: str = Field(min_length=1, max_length=20)
    status: str = Field(min_length=1, max_length=10)
    note: str | None = Field(default=None, max_length=600)
    pct: int | None = Field(default=None, ge=0, le=100)


class OutputIn(BaseModel):
    stage: str = Field(min_length=1, max_length=20)
    body: dict


class UsageSettingsIn(BaseModel):
    default_budget: float | None = Field(default=None, strict=True, gt=0, allow_inf_nan=False)
    poll: float | None = None
    logs: bool | None = None


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


class DecideCardIn(BaseModel):
    kind: Literal["ask", "permission", "prompt", "need"]
    id: str = Field(min_length=1, max_length=400)
    agent: str | None = Field(default=None, max_length=100)
    value: bool | int | str | None = None
    text: str | None = Field(default=None, max_length=2000)


class KeyIn(BaseModel):
    name: str = Field(default="", max_length=60)


class NetworkIn(BaseModel):
    host: str | None = Field(default=None, max_length=40)
    port: int | None = None
    sources: list[str] | None = Field(default=None, max_length=64)
    password: bool | None = None
    keys: bool | None = None
    days: int | None = None


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


class PublishIn(BaseModel):
    html: str = Field(min_length=1, max_length=PAGE_MAX)
    title: str = Field(default="", max_length=200)
    kind: str = "explain"
    line: str | None = None


class ReportIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    key: bool = False


class CheckSetIn(BaseModel):
    on: bool | None = None
    params: dict[str, float | None] | None = None
    title: str | None = Field(default=None, max_length=40)
    prompt: str | None = Field(default=None, max_length=2000)
    every: float | None = None
    stage: str | None = None
    gate: str | None = None


class LoopSetIn(BaseModel):
    auto: bool | None = None
    rounds: int | None = Field(default=None, ge=1, le=20)


class GateIn(BaseModel):
    what: str


class CheckAddIn(BaseModel):
    kind: str
    stage: str
    title: str = Field(min_length=1, max_length=40)
    text: str = Field(min_length=1, max_length=2000)
    prio: str = "P1"
    max: int = Field(default=0, ge=0, le=10000)


class NodeIn(BaseModel):
    kind: str
    x: float = 0
    y: float = 0
    title: str = Field(default="", max_length=80)
    text: str = Field(default="", max_length=4000)
    to: str = "lead"
    prio: str = "P1"
    link: str | None = None
    send: bool = False


class NodeSetIn(BaseModel):
    title: str | None = Field(default=None, max_length=80)
    text: str | None = Field(default=None, max_length=4000)
    to: str | None = None
    status: str | None = None
    stale: bool | None = None  # False: its result still stands


class SendIn(BaseModel):
    chain: bool = False  # also queue every draft task after it


class RulesIn(BaseModel):
    exclusive: bool


class MoveIn(BaseModel):
    at: dict[str, list[float]]
    blocks: dict[str, list[float]] | None = None


class EdgeIn(BaseModel):
    source: str
    target: str


class EdgeSetIn(BaseModel):
    label: str | None = Field(default=None, max_length=80)
    order: bool | None = None  # an order line between two tasks, or a plain one
    flip: bool = False


class BackIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


class TaskIn(BaseModel):
    id: str = Field(min_length=1, max_length=40)
    status: str
    text: str = Field(min_length=1, max_length=4000)
    dispatch: str | None = Field(default=None, max_length=80)


class VerdictIn(BaseModel):
    id: str = Field(min_length=1, max_length=40)
    status: str
    text: str = Field(min_length=1, max_length=4000)


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


class IdeaIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


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


class NodeAgentIn(BaseModel):
    runtime: str | None = None
    provider: str | None = None
    model: str | None = None
    thinking: str | None = None
    ext_id: str | None = None


class SaveIn(BaseModel):
    path: str
    text: str


class SayIn(BaseModel):
    text: str = Field(min_length=1, max_length=20000)
    mode: Literal["steer", "queue", "interrupt"] | None = None


class QueueIn(BaseModel):
    what: Literal["now", "drop"]


class PromptIn(BaseModel):
    digest: str
    option: int = Field(strict=True)


class TerminalKeysIn(BaseModel):
    keys: list[str] = Field(min_length=1, max_length=32)


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
    terminals = mapped(HerdrError)
    agent_prompts, terminal_prompts = mapped(AgentError, PromptError), mapped(HerdrError, PromptError)
    leads = mapped(LeadError, AgentError, CardError)
    checks = mapped(CheckError, AgentError, LeadError)
    canvas = mapped(CanvasError, CheckError, AgentError, LeadError)
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
    net = Network(town.s.config_file)
    auth = Auth(town.s.data_dir, net)
    app.add_middleware(Gate, auth=auth)

    # signing in
    @app.get("/api/auth/state")
    def auth_state(request: Request):
        return auth.state(request.scope)

    @app.post("/api/auth/login")
    def auth_login(body: LoginIn, request: Request, response: Response):
        tok = authed(auth.login, request.scope, body.password, request.headers.get("user-agent", ""))
        https = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
        response.set_cookie(COOKIE, tok, max_age=auth.days() * 86400, httponly=True, samesite="lax", secure=https, path="/")
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

    # access keys for apps: `Authorization: Bearer <key>` (auth.py)
    @app.get("/api/auth/keys")
    def auth_keys(request: Request):
        authed(auth.manage, request.scope)
        return {"keys": auth.keys()}

    @app.post("/api/auth/keys")
    def auth_key_new(body: KeyIn, request: Request):
        authed(auth.manage, request.scope)
        return authed(auth.create_key, body.name)

    @app.delete("/api/auth/keys/{key_id}")
    def auth_key_revoke(key_id: str, request: Request):
        authed(auth.manage, request.scope)
        authed(auth.revoke_key, key_id)
        return {"keys": auth.keys()}

    # where it listens, who may reach it, how they sign in (network.py); changed from this machine or a
    # browser signed in with the password, never with an access key
    def network_view(scope: dict) -> dict:
        return {**net.view(scope), "can_edit": auth.local(scope) or auth.session(scope)}

    @app.get("/api/network")
    def network_get(request: Request):
        return network_view(request.scope)

    @app.put("/api/network")
    def network_set(body: NetworkIn, request: Request):
        authed(auth.manage, request.scope)
        before = net.get()
        conf = mapped(NetworkError)(net.set, body.model_dump(exclude_none=True), request.scope)
        if before["password"] and not conf["password"]:
            auth.end_sessions()  # turned off: nobody stays signed in with it
        return network_view(request.scope)

    @app.get("/api/health")
    def health():
        # open to anyone: an app checks with it that the address is a Papertown server before signing in
        return {"ok": True, "app": "papertown", "version": VERSION, "ports": town.mcp.status}

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
    def create_idea(body: IdeaIn):
        return guard(town.pipeline.create, body.text)

    @app.get("/api/usage")
    def usage():
        return town.usage.snapshot()

    @app.post("/api/usage/refresh")
    def refresh_usage():
        return town.usage.poll(force=True)

    @app.get("/api/usage/settings")
    def usage_settings():
        return town.usage.settings()

    @app.put("/api/usage/settings")
    def set_usage_settings(body: UsageSettingsIn):
        return mapped(UsageError)(town.usage.set_settings, body.model_dump(exclude_unset=True))

    @app.get("/api/lines/{line_id}/usage")
    def line_usage(line_id: str):
        return mapped(UsageError)(town.usage.line, line_id)

    @app.put("/api/lines/{line_id}/usage_budget")
    def usage_budget(line_id: str, body: dict):
        if set(body) != {"usd"}:
            raise HTTPException(400, "请提供 usd 美元金额或 null")
        return mapped(UsageError)(town.usage.set_budget, line_id, body["usd"])

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
        return rows

    @app.get("/api/trace")
    def trace(limit: int = 60, line_id: str | None = None):
        return latest("trace", line_id, min(limit, 500))

    @app.get("/api/buildings/{bid}/staff")
    def building_staff(bid: str):
        """Whom to ask in a building: the worker of the project there (the coder at the depot and the farm, the writer
        at the press), else that project's lead; the assistant where no project is at work."""
        b = town.world.get(bid)
        if not b:
            raise HTTPException(404, "没有这座建筑")
        sheet = town.world.sheet(b["id"]) or {}
        line_id = b["line_id"] or sheet.get("active_line")
        ln = town.db.one("select id, seq, title, status from lines where id = ?", line_id) if line_id else None
        if not ln or ln["status"] not in ("running", "linked"):
            return {"who": ASSISTANT, "agent": town.agents.public(town.agents.get(ASSISTANT)), "line": None, "name": "小助手"}
        role = STAFF_AT.get(b["type"], "lead")
        a = town.leads.agent(ln["id"], role) or town.leads.agent(ln["id"], "lead") or town.agents.ensure(ln["id"], "lead")
        return {"who": a["role"], "agent": town.agents.public(a), "line": {k: ln[k] for k in ("id", "seq", "title")}, "name": ROLES[a["role"]]["name"]}

    @app.get("/api/status")
    def status():
        return status_mod.status(town)

    @app.get("/api/papers/fresh")
    def fresh_papers():
        return {"papers": status_mod.fresh_papers(town)}

    @app.get("/api/departments")
    def departments():
        return status_mod.departments(town)

    # the farm
    @app.get("/api/jobs")
    def jobs(line_id: str | None = None, external: bool = True):
        # external=false: only the farm's own (the TUI reads nvidb's itself)
        ext = [j for j in town.linked.farm_jobs() if not line_id or j["line_id"] == line_id] if external else []
        return {"jobs": ext + town.farm.list(line_id), "backends": town.farm.backends()}

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

    @app.post("/api/agents/{agent_id}/prompt")
    def agent_prompt(agent_id: str, body: PromptIn):
        return agent_prompts(town.agents.hosted.prompt, agent_id, body.digest, body.option)

    @app.post("/api/terminals/{id}/prompt")
    def terminal_prompt(id: str, body: PromptIn):
        return terminal_prompts(town.terminals.prompt, id, body.digest, body.option)

    @app.get("/api/terminals/{id}/timeline")
    def terminal_timeline(id: str, limit: int = 200):
        return terminals(town.terminals.timeline, id, min(max(limit, 1), 1000))

    @app.get("/api/herdr")
    def herdr_info():
        return town.terminals.info()

    @app.get("/api/terminals/{id}")
    def terminal(id: str):
        return terminals(town.terminals.detail, id)

    @app.post("/api/terminals/{id}/say")
    def terminal_say(id: str, body: SayIn):
        return terminals(town.terminals.say, id, body.text, body.mode)

    @app.post("/api/terminals/{id}/keys")
    def terminal_keys(id: str, body: TerminalKeysIn):
        return terminals(town.terminals.keys, id, body.keys)

    @app.post("/api/terminals/{id}/queue/{queue_id}")
    def terminal_queue(id: str, queue_id: int, body: QueueIn):
        return terminals(town.terminals.queue, id, queue_id, body.what)

    @app.post("/api/terminals/{id}/seen")
    def terminal_seen(id: str):
        return terminals(town.terminals.seen, id)

    @app.get("/api/backends")
    def backends():
        return town.agents.hosted.available()

    @app.get("/api/agents/runtime")
    def agent_runtime():
        return {"runtime": town.paseo_models.runtime(), "paseo_chat": town.s.paseo_chat}

    @app.post("/api/agents/runtime")
    def set_agent_runtime(body: StartIn):
        return mapped(ModelError)(town.paseo_models.set_runtime, body.runtime)

    @app.get("/api/agents/{agent_id}/screen")
    def agent_screen(agent_id: str):
        return agents(town.agents.hosted.screen, agent_id)

    @app.post("/api/agents/{agent_id}/keys")
    def agent_keys(agent_id: str, body: TerminalKeysIn):
        agents(town.agents.hosted.keys, agent_id, body.keys)
        return {"ok": True}

    @app.post("/api/agents/{agent_id}/close")
    def agent_close(agent_id: str):
        return agents(town.agents.hosted.close, agent_id)

    @app.post("/api/agents/{agent_id}/hook")
    def agent_hook(agent_id: str, body: dict, x_papertown_token: str | None = Header(default=None)):
        bridged(agent_id, x_papertown_token)
        data = body.get("data")
        if not isinstance(data, dict):
            raise HTTPException(422, "hook 数据必须是对象")
        agents(town.agents.hosted.hook, agent_id, body.get("provider"), data)
        return {"ok": True}

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

    @app.get("/api/agents/overview")
    def agent_overview():
        return town.agents.overview()

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
        except PaseoError as e:
            raise HTTPException(400, str(e)) from e
        linked = {a["ext_id"]: town.leads._who(a) for a in town.db.q(
            "select * from agents where runtime = 'paseo' and ext_id is not null and line_id is not null")}

        def owner(c: dict) -> str | None:
            """Who has the conversation: the agent it is open in, else the one its label names (set aside, still theirs)."""
            if c["id"] in linked:
                return linked[c["id"]]
            aid = (c.get("labels") or {}).get("papertown.agent")
            if not aid:
                return None
            a = town.agents.get(aid)
            return town.leads._who(a) if a else "另一个 Papertown Agent"
        # the assistant's own conversations are not for a project to take
        mine = [c for c in rows if (c.get("labels") or {}).get("papertown.role") != ASSISTANT]
        return {"conversations": [c | {"linked": owner(c)} for c in mine]}

    @app.post("/api/agents/{agent_id}/open")
    def agent_open_desktop(agent_id: str):
        agents(town.agents.open_desktop, agent_id)
        return {"ok": True}

    # an agent's conversations in Paseo: the one open now, a new one, an earlier one
    def found(agent_id: str) -> str:
        if not town.agents.get(agent_id):
            raise HTTPException(404, "没有这个员工")
        return agent_id

    @app.get("/api/agents/{agent_id}/conversations")
    def agent_conversations(agent_id: str):
        return {"conversations": agents(town.agents.conversations, found(agent_id))}

    @app.post("/api/agents/{agent_id}/conversations/new")
    def agent_conversation_new(agent_id: str):
        if agent_id == ASSISTANT:  # it also closes its open asks
            return assistant(town.assistant.reset)
        return agents(town.agents.fresh, found(agent_id))

    @app.post("/api/agents/{agent_id}/conversations/{ext_id}")
    def agent_conversation_resume(agent_id: str, ext_id: str):
        if agent_id == ASSISTANT:
            return assistant(town.assistant.resume, ext_id)
        return agents(town.agents.resume, found(agent_id), ext_id)

    @app.get("/api/paseo")
    def paseo(fresh: bool = False):
        p, m = town.agents.paseo, town.paseo_models
        st = p.status(fresh=True)
        try:
            providers = p.providers(fresh) if st["ok"] else []
        except PaseoError as e:
            st = st | {"note": str(e)}
            providers = []
        if providers:
            m.learn(providers)
        # Paseo not running: the models it listed before, so a terminal can still be started on one of them
        return {"status": st, "providers": providers or m.known(), "defaults": m.defaults(), "news": m.news(), "runtime": m.runtime(),
                "chat": town.s.paseo_chat}

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

    @app.post("/api/agents/{agent_id}/seen")
    def agent_seen(agent_id: str):
        return agents(town.agents.seen, found(agent_id))

    @app.post("/api/agents/{agent_id}/queue/{event_id}")
    def agent_queue(agent_id: str, event_id: int, body: QueueIn):
        action = town.agents.queue_now if body.what == "now" else town.agents.queue_drop
        return agents(action, found(agent_id), event_id)

    @app.post("/api/agents/{agent_id}/brief")
    def agent_brief(agent_id: str):
        return agents(town.agents.say, agent_id, agents(town.agents.brief, agent_id), None, "papertown")

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

    # the 进展 page: each project's card, lead, reports, memory, search and pages
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

    # 待你决定 on a card: answers a question, a permission request or a terminal dialog of the project's agents,
    # or tells the lead what you decided about a line of its card (decisions.py)
    @app.post("/api/lines/{line_id}/decide")
    def card_decide(line_id: str, body: DecideCardIn):
        return mapped(CardError, DecisionError)(town.cards.decide, line_id, body.kind, body.id, body.agent, body.value, body.text)

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

    @app.get("/api/lines/{line_id}/checks")
    def line_checks(line_id: str):
        checks(town.checks.run, line_id)  # only when what the hard checks read has changed
        return checks(town.checks.view, line_id)

    @app.post("/api/lines/{line_id}/checks/run")
    def line_checks_run(line_id: str):
        checks(town.checks.run, line_id, True)
        return checks(town.checks.view, line_id)

    @app.post("/api/lines/{line_id}/checks")
    def line_checks_add(line_id: str, body: CheckAddIn):
        return checks(town.checks.add, line_id, body.kind, body.stage, body.title, body.text, body.prio, body.max)

    @app.put("/api/lines/{line_id}/checks/{check_id}")
    def line_check_set(line_id: str, check_id: str, body: CheckSetIn):
        return checks(town.checks.set, line_id, check_id, body.on, body.params, body.title, body.prompt, body.every, body.stage, body.gate)

    @app.put("/api/lines/{line_id}/loops/{stage}")
    def line_loop_set(line_id: str, stage: str, body: LoopSetIn):
        return checks(town.checks.set_loop, line_id, stage, body.auto, body.rounds)

    @app.post("/api/lines/{line_id}/checks/ask")
    def line_checks_ask_all(line_id: str):
        return checks(town.checks.ask_all, line_id)

    @app.delete("/api/lines/{line_id}/checks/{check_id}")
    def line_check_remove(line_id: str, check_id: str):
        return checks(town.checks.remove, line_id, check_id)

    @app.post("/api/lines/{line_id}/checks/{check_id}/ask")
    def line_check_ask(line_id: str, check_id: str):
        return checks(town.checks.ask_now, line_id, check_id)

    @app.get("/api/lines/{line_id}/canvas")
    def line_canvas(line_id: str):
        checks(town.checks.run, line_id)
        return canvas(town.canvas.view, line_id)

    @app.get("/api/lines/{line_id}/canvas/outline")
    def canvas_outline(line_id: str):
        return {"text": canvas(town.canvas.outline, line_id)}

    @app.post("/api/lines/{line_id}/canvas/nodes")
    def canvas_add(line_id: str, body: NodeIn):
        return canvas(town.canvas.add, line_id, body.kind, body.x, body.y, body.title, body.text, body.to, body.prio, body.link, body.send)

    @app.put("/api/lines/{line_id}/canvas/nodes/{node_id}")
    def canvas_set(line_id: str, node_id: str, body: NodeSetIn):
        return canvas(town.canvas.set, line_id, node_id, body.title, body.text, body.to, body.status, body.stale)

    @app.delete("/api/lines/{line_id}/canvas/nodes/{node_id}")
    def canvas_remove(line_id: str, node_id: str):
        return canvas(town.canvas.remove, line_id, node_id)

    @app.post("/api/lines/{line_id}/canvas/nodes/{node_id}/send")
    def canvas_send(line_id: str, node_id: str, body: SendIn | None = None):
        return canvas(town.canvas.send, line_id, node_id, bool(body and body.chain))

    @app.post("/api/lines/{line_id}/canvas/nodes/{node_id}/agent")
    def canvas_bind(line_id: str, node_id: str, body: NodeAgentIn):
        return canvas(town.canvas.bind, line_id, node_id, body.provider, body.model, body.thinking, body.ext_id, body.runtime)

    @app.post("/api/lines/{line_id}/canvas/nodes/{node_id}/back")
    def canvas_back(line_id: str, node_id: str, body: BackIn):
        return canvas(town.canvas.back, line_id, node_id, body.text)

    @app.post("/api/lines/{line_id}/canvas/nodes/{node_id}/restore")
    def canvas_restore(line_id: str, node_id: str):
        return canvas(town.canvas.restore, line_id, node_id)

    @app.post("/api/lines/{line_id}/canvas/move")
    def canvas_move(line_id: str, body: MoveIn):
        return canvas(town.canvas.move, line_id, body.at, body.blocks)

    @app.post("/api/lines/{line_id}/canvas/edges")
    def canvas_connect(line_id: str, body: EdgeIn):
        return canvas(town.canvas.connect, line_id, body.source, body.target)

    @app.put("/api/lines/{line_id}/canvas/edges/{edge_id}")
    def canvas_label(line_id: str, edge_id: str, body: EdgeSetIn):
        view = None
        if body.order is not None or body.flip:
            view = canvas(town.canvas.order, line_id, edge_id, body.order, body.flip)
        if body.label is not None or view is None:
            view = canvas(town.canvas.label, line_id, edge_id, body.label or "")
        return view

    @app.put("/api/lines/{line_id}/canvas/rules")
    def canvas_rules(line_id: str, body: RulesIn):
        return canvas(town.canvas.rules, line_id, body.exclusive)

    @app.delete("/api/lines/{line_id}/canvas/edges/{edge_id}")
    def canvas_disconnect(line_id: str, edge_id: str):
        return canvas(town.canvas.disconnect, line_id, edge_id)

    @app.post("/api/lines/{line_id}/canvas/tidy")
    def canvas_tidy(line_id: str):
        return canvas(town.canvas.tidy, line_id)

    @app.post("/api/lines/{line_id}/canvas/gates/{stage}")
    def canvas_gate(line_id: str, stage: str, body: GateIn):
        return canvas(town.canvas.gate, line_id, stage, body.what)

    @app.get("/api/lines/{line_id}/canvas/report")
    def canvas_report(line_id: str):
        return canvas(town.canvas.report, line_id)

    @app.post("/api/lines/{line_id}/canvas/report")
    def canvas_publish(line_id: str):
        try:
            return canvas(town.canvas.publish, line_id)
        except PageError as e:
            raise HTTPException(400, str(e)) from e

    @app.get("/api/lines/{line_id}/lead")
    def lead(line_id: str):
        if not town.pipeline.line(line_id):
            raise HTTPException(404, "没有这个项目")
        return town.leads.view(line_id)

    @app.post("/api/lines/{line_id}/lead")
    def lead_settings(line_id: str, body: LeadIn):
        if not town.pipeline.line(line_id):
            raise HTTPException(404, "没有这个项目")
        return town.leads.configure(line_id, body.supervise, body.every, body.on)

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
        agents(town.agents.ingest, agent_id, body.events)
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
        return {"text": town.bounds.text(a["role"], a["line_id"], str(town.agents.pt(a)) if a["runtime"] in ("paseo", "herdr", "tmux", "headless") else None)}

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

    @app.post("/api/bridge/{agent_id}/hire")
    def bridge_hire(agent_id: str, body: HireIn, x_papertown_token: str | None = Header(default=None)):
        bridged(agent_id, x_papertown_token)
        return {"text": leads(town.leads.hire, agent_id, body.role, body.runtime, body.provider, body.model, body.thinking)}

    @app.get("/api/bridge/{agent_id}/stage")
    def bridge_stages(agent_id: str, line: str | None = None, x_papertown_token: str | None = Header(default=None)):
        a = bridged(agent_id, x_papertown_token)
        return {"text": guard(town.pipeline.text, own_line(a, line))}

    @app.post("/api/bridge/{agent_id}/stage")
    def bridge_stage(agent_id: str, body: StageIn, x_papertown_token: str | None = Header(default=None)):
        bridged(agent_id, x_papertown_token)
        return {"text": leads(town.leads.stage, agent_id, body.stage, body.status, body.note, body.pct)}

    @app.post("/api/bridge/{agent_id}/output")
    def bridge_output(agent_id: str, body: OutputIn, x_papertown_token: str | None = Header(default=None)):
        a = bridged(agent_id, x_papertown_token)
        if not a["line_id"]:
            raise HTTPException(400, "你没有自己的项目")
        owner, name = OWNER.get(body.stage, "lead"), STAGE_NAMES.get(body.stage, body.stage)
        if a["role"] != "lead" and owner != a["role"]:
            who = "项目负责人" if owner == "lead" else f"{ROLES[owner]['name']}或项目负责人"
            raise HTTPException(403, f"「{name}」的产出由{who}交")
        out = guard(town.pipeline.output, a["line_id"], body.stage, body.body)
        tail = f"查重结论（用代码算）：{out['verdict']}，最接近的一篇相似度 {max((x['similarity'] for x in out['similar']), default=0):.2f}。" if body.stage == "hatch" else ""
        then = (f"这道工序做完了就用 `pt stage done {body.stage}` 收尾。" if a["role"] == "lead"
                else "收尾由项目负责人来做，用 `pt tell lead \"…\"` 告诉它产出已交。")
        return {"text": f"「{name}」的产出记下了，用户在项目页和中控屏里能看到。{tail}{then}"}

    @app.get("/api/bridge/{agent_id}/survey")
    def bridge_survey(agent_id: str, line: str | None = None, x_papertown_token: str | None = Header(default=None)):
        a = bridged(agent_id, x_papertown_token)
        return {"text": guard(town.pipeline.survey_text, own_line(a, line))}

    @app.get("/api/bridge/{agent_id}/library")
    def bridge_library(agent_id: str, q: str, top: int = 8, x_papertown_token: str | None = Header(default=None)):
        bridged(agent_id, x_papertown_token)
        r = town.library.search(q, top_k=max(1, min(top, 20)))
        rows = [f"- {h['paper_id']}（相似度 {h['similarity']:.2f}，{h.get('year') or '?'}，{h.get('authors') or ''}）{h['title']}\n  {str(h.get('snippet') or '')[:400]}" for h in r["hits"]]
        return {"text": f"图书馆里和「{q}」最接近的 {len(rows)} 篇（{r['method']}）：\n" + "\n".join(rows) if rows else f"图书馆里没有找到和「{q}」相关的论文，换几个英文关键词再试。"}

    @app.get("/api/bridge/{agent_id}/checks")
    def bridge_checks(agent_id: str, line: str | None = None, x_papertown_token: str | None = Header(default=None)):
        a = bridged(agent_id, x_papertown_token)
        return {"text": checks(town.checks.text, own_line(a, line))}

    @app.post("/api/bridge/{agent_id}/checks/run")
    def bridge_checks_run(agent_id: str, line: str | None = None, x_papertown_token: str | None = Header(default=None)):
        lid = own_line(bridged(agent_id, x_papertown_token), line)
        checks(town.checks.run, lid, True)
        return {"text": checks(town.checks.text, lid)}

    @app.post("/api/bridge/{agent_id}/check")
    def bridge_check(agent_id: str, body: VerdictIn, x_papertown_token: str | None = Header(default=None)):
        bridged(agent_id, x_papertown_token)
        return checks(town.checks.verdict, agent_id, body.id, body.status, body.text)

    @app.get("/api/bridge/{agent_id}/tasks")
    def bridge_tasks(agent_id: str, x_papertown_token: str | None = Header(default=None)):
        bridged(agent_id, x_papertown_token)
        return {"text": canvas(town.canvas.tasks_text, agent_id)}

    @app.post("/api/bridge/{agent_id}/task")
    def bridge_task(agent_id: str, body: TaskIn, x_papertown_token: str | None = Header(default=None)):
        bridged(agent_id, x_papertown_token)
        return canvas(town.canvas.close, agent_id, body.id, body.status, body.text, body.dispatch)

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
        agents = {a["id"]: a | {"status": town.agents.shown(a)} for a in town.db.q("select id, line_id, role, status, runtime, model from agents where role in ('coder', 'writer')")}
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
                "index": "SQLite FTS5 · BM25 召回 + 关键词覆盖率打分"}

    @app.post("/api/rag")
    def rag_set(body: RagIn):
        town.library.set_opts(**body.model_dump())
        return rag_status()

    @app.get("/api/rag/search")
    def rag_search(q: str, k: int | None = None):
        if not q.strip():
            raise HTTPException(400, "输入要检索的内容")
        return town.library.search(q, k)

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
