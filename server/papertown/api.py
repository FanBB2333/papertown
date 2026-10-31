"""HTTP API and the live event stream. Serves the built web app too, when there is one.

    uv run papertown serve            # http://127.0.0.1:8000
"""

from __future__ import annotations

import asyncio
import json
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import samples, stages, status as status_mod
from .agents import AgentError, ROLES
from .assistant import ID as ASSISTANT, ActError
from .config import SERVER_DIR, Settings
from .library import RAG_LIMITS
from .farm import FarmError, summarize
from .mcp_hub import McpError
from .pipeline import LineError
from .skim import SkimError
from .town import Town
from .workspace import WsError

FILES = {"main.tex", "refs.bib", "main.pdf", "paper.zip"}
ASK_ROLE = {"hatchery": "hatcher", "mill": "designer", "farm": "experimenter", "power_sim": "experimenter", "press": "writer",
            "qa": "reviewer", "depot": "keeper", "workshop": "keeper", "logistics": "keeper", "dock_github": "keeper"}


class SkimIn(BaseModel):
    scope: str  # global | project | session
    key: str = Field(min_length=3, max_length=200)
    value: str | None = None  # None unsets the key
    line_id: str | None = None
    agent_id: str | None = None


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
    runtime: str | None = None  # pi (tmux) | paseo
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

    # ---------- a project's files and data, for the console ----------

    def ws(fn, *args):
        try:
            return fn(*args)
        except WsError as e:
            raise HTTPException(e.status, str(e)) from e

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
        try:
            return samples.seed(town)
        except samples.SampleError as e:
            raise HTTPException(400, str(e)) from e

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

    # ---------- the farm ----------

    def farm(fn, *args):
        try:
            return fn(*args)
        except FarmError as e:
            raise HTTPException(400, str(e)) from e

    @app.get("/api/jobs")
    def jobs(line_id: str | None = None):
        ext = [j for j in town.linked.farm_jobs() if not line_id or j["line_id"] == line_id]
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
        if job_id.startswith("nvidb-"):  # one of a linked project's jobs in nvidb's queue
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

    # ---------- agents ----------

    def agents(fn, *args):
        try:
            return fn(*args)
        except AgentError as e:
            raise HTTPException(400, str(e)) from e

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
        # the console's assistant is no project's to take, nor are the conversations it set aside
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
        try:
            return town.set_llm(body.provider, body.model_strong, body.model_cheap, body.effort)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e

    @app.get("/api/paseo")
    def paseo():
        p = town.agents.paseo
        st = p.status(fresh=True)
        try:
            providers = p.providers() if st["ok"] else []
        except Exception as e:  # noqa: BLE001 - the CLI's own message is the useful part
            st = st | {"note": str(e)}
            providers = []
        return {"status": st, "providers": providers}

    @app.post("/api/agents/{agent_id}/stop")
    def agent_stop(agent_id: str):
        return agents(town.agents.stop, agent_id)

    @app.post("/api/agents/{agent_id}/say")
    def agent_say(agent_id: str, body: SayIn):
        return agents(town.agents.say, agent_id, body.text)

    @app.post("/api/agents/{agent_id}/brief")
    def agent_brief(agent_id: str):
        return agents(town.agents.say, agent_id, agents(town.agents.brief, agent_id))

    @app.post("/api/agents/{agent_id}/abort")
    def agent_abort(agent_id: str):
        agents(town.agents.abort, agent_id)
        return {"ok": True}

    # ---------- the console's assistant, in the sidebar ----------

    def assistant(fn, *args):
        try:
            return fn(*args)
        except (AgentError, ActError) as e:
            raise HTTPException(400, str(e)) from e

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

    # ---------- the bridge inside each pi ----------

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
        t0 = asyncio.get_running_loop().time()
        while not town.agents.has_mail(agent_id) and asyncio.get_running_loop().time() - t0 < min(wait, 25):
            await asyncio.sleep(0.25)
        return {"messages": town.agents.take(agent_id)}

    @app.get("/api/bridge/{agent_id}/brief")
    def bridge_brief(agent_id: str, line: str | None = None, x_papertown_token: str | None = Header(default=None)):
        a = bridged(agent_id, x_papertown_token)
        if a["role"] == ASSISTANT:  # no project of its own: the one named, else the one on your screen
            return {"text": assistant(town.assistant.brief, line)}
        return {"text": town.brief(a["line_id"], a["role"])}

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
        helper(agent_id, x_papertown_token)
        town.assistant.ask(body.question, body.choices, body.point)
        return {"text": "已经在侧边栏里问了用户。他的回答会作为下一条消息发来，先结束这一轮。"}

    @app.post("/api/bridge/{agent_id}/show")
    def bridge_show(agent_id: str, body: ShowIn, x_papertown_token: str | None = Header(default=None)):
        helper(agent_id, x_papertown_token)
        t = assistant(town.assistant.show, body.model_dump())
        return {"text": "已经在用户的页面上打开：" + "，".join(f"{k} {v}" for k, v in t.items())}

    @app.post("/api/bridge/{agent_id}/act")
    def bridge_act(agent_id: str, body: ActIn, x_papertown_token: str | None = Header(default=None)):
        helper(agent_id, x_papertown_token)
        e = assistant(town.assistant.propose, body.action, body.args, body.why)
        return {"id": e["id"], "text": f"已经请用户确认「{e['data']['title']}」。他点了允许或拒绝之后，结果会作为一条 <event> 消息发给你；先告诉他你请求了什么，然后结束这一轮。"}

    @app.post("/api/bridge/{agent_id}/jobs")
    def bridge_submit(agent_id: str, body: JobIn, x_papertown_token: str | None = Header(default=None)):
        a = bridged(agent_id, x_papertown_token)
        return farm(town.farm.submit, a["line_id"], body.name, body.command, body.backend or "local", agent_id, a["cwd"])

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

    # ---------- the skill academy: skim, layered per project and conversation ----------

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
        try:
            return town.skim.resolve(line_id, agent_id)
        except SkimError as e:
            raise HTTPException(400, str(e)) from e

    @app.post("/api/skim/config")
    def skim_config(body: SkimIn):
        try:
            town.skim.set(body.scope, body.key, body.value, body.line_id, body.agent_id)
            town.skim.apply_all(None if body.scope == "global" else body.line_id)
            return town.skim.resolve(body.line_id, body.agent_id)
        except SkimError as e:
            raise HTTPException(400, str(e)) from e

    # ---------- the MCP exchange ----------

    def mcp_view():
        return {"servers": town.mcp.info(), "town_file": str(town.mcp.town_file), "config_file": town.s.mcp_config or None,
                "self": {"mcpServers": {"papertown": {"command": "uv", "args": ["--directory", str(SERVER_DIR), "run", "papertown", "mcp"]}}}}

    @app.get("/api/mcp")
    def mcp_status():
        return mcp_view()

    @app.post("/api/mcp/servers")
    def mcp_add(body: McpServerIn):
        try:
            town.mcp.add(body.name, body.command, body.args, body.env)
        except McpError as e:
            raise HTTPException(400, str(e)) from e
        return mcp_view()

    @app.post("/api/mcp/servers/{name}/toggle")
    def mcp_toggle(name: str, body: ToggleIn):
        try:
            town.mcp.toggle(name, body.enabled)
        except McpError as e:
            raise HTTPException(400, str(e)) from e
        return mcp_view()

    @app.post("/api/mcp/servers/{name}/restart")
    def mcp_restart(name: str):
        if name not in town.mcp.servers():
            raise HTTPException(400, "这个 MCP server 没有启用")
        town.mcp.restart(name)
        return mcp_view()

    @app.delete("/api/mcp/servers/{name}")
    def mcp_remove(name: str):
        try:
            town.mcp.remove(name)
        except McpError as e:
            raise HTTPException(400, str(e)) from e
        return mcp_view()

    # ---------- the library as the RAG room ----------

    def rag_view():
        from urllib.parse import urlparse
        lib = town.library
        return {"stats": lib.stats(), "opts": lib.opts, "limits": {k: list(v) for k, v in RAG_LIMITS.items()},
                "index": "SQLite FTS5 · BM25 召回 + 关键词覆盖率打分",
                "embed": {"configured": lib.embedder is not None, "model": town.s.embed_model or None,
                          "host": urlparse(town.s.embed_base_url).netloc or None}}

    @app.get("/api/rag")
    def rag_status():
        return rag_view()

    @app.post("/api/rag")
    def rag_set(body: RagIn):
        town.library.set_opts(**body.model_dump())
        return rag_view()

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
        app.mount("/", StaticFiles(directory=town.s.web_dist, html=True), name="web")
    return app
