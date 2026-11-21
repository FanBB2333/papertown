"""The town: one object wiring the world together. The API, the CLI, the MCP server and
the tests all start from Town()."""

from __future__ import annotations

import json
import uuid
from pathlib import Path

from . import samples
from .agents import Agents
from .terminals import Terminals
from .usage import Usage
from .assistant import Assistant
from .bank import Bank
from .bounds import Bounds
from .ask import Asker
from .pages import Pages
from .cards import Cards
from .compute import Job, SimulatedPlant
from .config import PROVIDERS, Settings
from .db import DB, now
from .depots import Depots
from .events import EventBus
from .farm import Farm, summarize
from .canvas import Canvas
from .checks import Checks
from .leads import Leads
from .graph import Genealogy
from .library import Embedder, Library, terms_of
from .linked import Linked
from .llm import make_provider
from .market import Market
from .mcp_hub import McpHub
from .nvidb import Nvidb
from .history import History
from .paseo_models import PaseoModels
from .skim import Skim
from .pipeline import Pipeline
from .relay import Relay
from .press import Press
from .skills import SkillRegistry
from .tools import Tool, ToolCtx, ToolError, ToolRegistry, arr, n, obj, register_skill_tools, s
from .world import World
from .workspace import Workspace

SEED = Path(__file__).parent / "data" / "seed_papers.jsonl"


def seed_papers() -> list[dict]:
    """The demo's bundled seed library."""
    if not SEED.exists():
        return []
    return [json.loads(line) for line in SEED.read_text(encoding="utf-8").splitlines() if line.strip()]


class Town:
    def __init__(self, settings: Settings | None = None):
        self.s = settings or Settings()
        self.db = DB(self.s.db_path)
        self.bus = EventBus()
        self.skills = SkillRegistry(self.s.skills_dir)
        self.provider = make_provider(self.s)
        embedder = Embedder(self.s.embed_base_url, self.s.embed_api_key, self.s.embed_model) if self.s.embed_model else None
        self.library = Library(self.db, embedder, self.s.data_dir / "rag.json")
        self.genealogy = Genealogy(self.db, self.library)
        self.depots = Depots(self.db)
        self.bank = Bank(self.db, self.bus, self.s.weekly_budget)
        self.market = Market(self.db, self.bus)
        self.plant = SimulatedPlant(self.s.sim_gpu_seconds, on_change=self._job_changed)
        self.nvidb = Nvidb(self.s)
        self.press = Press(self.s.press_dir, self.library, self.s.compile_tex)
        self.world = World(self)
        self.farm = Farm(self)
        self.agents = Agents(self)
        self.terminals = Terminals(self)
        self.bounds = Bounds(self)
        self.leads = Leads(self)
        self.checks = Checks(self)
        self.canvas = Canvas(self)
        self.relay = Relay(self)
        self.paseo_models = PaseoModels(self)
        self.cards = Cards(self)
        self.history = History(self)
        self.pages = Pages(self)
        self.asker = Asker(self)
        self.assistant = Assistant(self)
        self.tools = ToolRegistry()
        self.mcp = McpHub(self)
        self.pipeline = Pipeline(self)
        self.linked = Linked(self)
        self.usage = Usage(self)
        self.workspace = Workspace(self)
        self.skim = Skim(self)
        self._register_tools()
        if not self.library.count():
            self.ingest(seed_papers(), "seed")

    def start(self) -> None:
        self.pipeline.recover()
        self.farm.recover()
        self.agents.reconcile()
        self.mcp.start()
        samples.maybe_seed(self)
        self.linked.sync()
        self.terminals.start()
        self.nvidb.start()
        self.relay.start()
        self.leads.start()
        self.checks.start()
        self.paseo_models.start()
        self.usage.start()

    def stop(self) -> None:
        self.usage.stop()
        self.terminals.shutdown()
        self.agents.shutdown()
        self.paseo_models.stop()
        self.leads.stop()
        self.checks.stop()
        self.relay.stop()
        self.nvidb.stop()
        self.mcp.stop()

    def llm(self) -> dict:
        s = self.s
        return {"provider": s.provider, "model_strong": s.model_strong, "model_cheap": s.model_cheap, "effort": s.effort,
                "openai_base_url": s.openai_base_url, "offline": s.offline,
                "providers": [{"id": k, "name": v["name"], "models": v["models"]} for k, v in PROVIDERS.items()]}

    def set_llm(self, provider: str | None = None, model_strong: str | None = None, model_cheap: str | None = None,
                effort: str | None = None) -> dict:
        """Switch the workers' provider and models until the next start; keys still come from the environment."""
        s = self.s
        old = (s.provider, s.model_strong, s.model_cheap, s.effort)
        if provider and provider not in PROVIDERS:
            raise ValueError(f"没有这个供应商：{provider}")
        if provider and provider != s.provider:
            s.provider = provider
            s.model_strong, s.model_cheap = PROVIDERS[provider]["default"]
        s.model_strong = (model_strong or "").strip() or s.model_strong
        s.model_cheap = (model_cheap or "").strip() or s.model_cheap
        s.effort = effort or s.effort
        try:
            self.provider = make_provider(s)
        except Exception as e:
            s.provider, s.model_strong, s.model_cheap, s.effort = old
            raise ValueError(f"切换失败：{e}") from e
        info = self.llm()
        self.bus.publish("llm", llm=info)
        return info

    def trace(self, kind: str, label: str, detail: str = "", ms: int = 0, run_id: str | None = None, line_id: str | None = None) -> None:
        row = {"ts": now(), "run_id": run_id, "line_id": line_id, "kind": kind, "label": label, "detail": detail, "ms": ms}
        row["id"] = self.db.insert("trace", row)
        self.bus.publish("trace", row=row)

    def message(self, line_id: str | None, role: str, worker_id: str | None, kind: str, body: dict) -> dict:
        row = {"ts": now(), "line_id": line_id, "role": role, "worker_id": worker_id, "kind": kind, "body": body}
        row["id"] = self.db.insert("messages", row)
        if worker_id:
            w = self.market.get(worker_id)
            row["worker"] = {"id": w["id"], "role": w["role"], "level": w["level"]} if w else None
        self.bus.publish("message", message=row)
        return row

    def save_item(self, line_id: str, kind: str, stage: str, building: str, title: str, body: dict) -> dict:
        row = {"id": f"it_{uuid.uuid4().hex[:10]}", "line_id": line_id, "kind": kind, "stage": stage, "building": building,
               "title": title, "body": body, "created_at": now()}
        self.db.insert("items", row)
        self.bus.publish("item", item={k: v for k, v in row.items() if k != "body"})
        return row

    def tag_papers(self, papers: list[dict]) -> list[list[str]]:
        try:
            out = self.skills.run_script("paper-triage", "tag.py", {"papers": [
                {"title": p["title"], "abstract": p.get("abstract", ""), "categories": p.get("categories", [])} for p in papers]})
            return out["tags"]
        except Exception:
            return [[] for _ in papers]

    def ingest(self, papers: list[dict], source: str) -> list[dict]:
        """Customs: dedup, tag, shelve in the library, link into the genealogy."""
        added = self.library.ingest(papers, source, self.tag_papers)
        if added:
            self.genealogy.link_similar(added)
            self.bus.publish("library", added=len(added), total=self.library.count())
        return added

    def brief(self, line_id: str, role: str = "") -> str:
        """Everything a pi agent should know about its project, as plain text."""
        ln = self.pipeline.line(line_id)
        out = [f"项目 #{ln['seq']}：{ln['title']}", f"状态：{ln['status']}，当前工序：{ln['stage']}", "", "## idea", ln["idea"]]
        report = self.pipeline.item(line_id, "hatch") or {}
        if report.get("gap"):
            out += ["", "## 查重结论", f"{report.get('verdict', '')}：{report['gap']}"]
        draft = self.pipeline.item(line_id, "method")
        if draft:
            out += ["", "## 方法草案", f"题目：{draft.get('title', '')}", f"问题：{draft.get('problem', '')}"]
            out += [f"- 机制：{m}" for m in draft.get("mechanism") or []]
            out += [f"- baseline：{b.get('name')}（{b.get('source', '')}）" for b in draft.get("baselines") or []]
            if draft.get("datasets"):
                out.append(f"- 数据 / 任务：{', '.join(draft['datasets'])}")
            if draft.get("metrics"):
                out.append(f"- 指标：{', '.join(draft['metrics'])}")
        elif not ln["linked"]:
            out += ["", "## 方法草案", "还没有。孵化通过、造纸厂开工后会写出来。"]
        jobs = self.farm.list(line_id, 20)
        if jobs:
            out += ["", "## 实验农场里的任务"]
            out += [f"- {j['id']} {j['name']}（{j['backend']}）：{j['status']} {j['progress']}%"
                    + (f"，{summarize(j)}" if j["status"] == "done" else "") for j in jobs]
        review = self.pipeline.item(line_id, "review") or {}
        if review.get("feedback"):
            out += ["", "## 审稿意见"] + [f"- {x}" for x in review["feedback"][:8]]
        info = self.linked.summary(line_id)
        if info:
            out += self._linked_brief(info, role)
        elif role == "writer":
            files = [n for n in ("main.tex", "refs.bib", "main.pdf") if (self.press.dir(line_id) / n).exists()]
            out += ["", "## 论文目录", "已有：" + ("、".join(files) if files else "还没有文件")]
        agent = self.agents.get(f"{role}-{line_id}") if role in ("coder", "writer") else None
        if agent:
            out += self.skim.brief(agent)
        out += self.usage.brief(line_id)
        return "\n".join(out)

    @staticmethod
    def _linked_brief(info: dict, role: str) -> list[str]:
        out = ["", "## 本地仓库", "这个项目是从本机仓库接入的：工作目录就是仓库本身，改动都是真的。动手前先看 git status，"
               "只改和任务有关的文件，提交、推送前先问用户。"]
        c, p = info.get("code"), info.get("paper")
        if c:
            out += [f"- 代码：{c['path']}（分支 {c.get('branch') or '?'}，{c.get('files', 0)} 个文件，未提交改动 {c.get('dirty', 0)} 处）"]
            out += [f"  - {x['hash']} {x['subject']}" for x in (c.get("commits") or [])[:5]]
        if p:
            out += [f"- 论文：{p['path']}，主文件 {p.get('main') or '?'}，{p.get('bib', 0)} 条参考文献"]
            if p.get("sections"):
                out.append("  - 章节：" + " / ".join(p["sections"]))
        if role == "coder":
            out.append("实验跑在 nvidb 的 GPU 队列上（nvidb job submit），实验农场会按工作目录和名字认出这个项目的任务。")
        return out

    def _job_changed(self, job: Job) -> None:
        self.farm.sync_sim(job)
        self.bus.publish("power", job={"id": job.id, "line_id": job.line_id, "status": job.status, "progress": job.progress},
                         plant=self.plant.status())
        if job.line_id:
            self.db.x("update stages set pct = ? where line_id = ? and key = 'exp' and status = 'run'",
                      max(10, job.progress), job.line_id)
            self.bus.publish("line", line=self.pipeline.snapshot(job.line_id))

    def _register_tools(self) -> None:
        reg = self.tools
        register_skill_tools(reg)

        def library_search(ctx: ToolCtx, a: dict):
            return self.library.search(a["query"], int(a.get("top_k") or 0) or None, a.get("since"))

        reg.add(Tool("library_search", "library.search", "RAG",
                     "检索图书馆（论文库，英文）。返回标题、摘要片段和与 query 的相似度 similarity（0~1）。",
                     obj(["query"], query=s("英文关键词或短语"), top_k=n("返回几篇，默认按图书馆里的设置"), since=s("只看这个日期之后的，如 2025-01-01")),
                     library_search, lambda v: f"命中 {len(v['hits'])} 篇（{v['method']}）", arg="query"))

        def paper_get(ctx: ToolCtx, a: dict):
            return {"papers": [{"paper_id": f"arxiv:{p['arxiv_id']}", "arxiv_id": p["arxiv_id"], "title": p["title"],
                                "abstract": p["abstract"], "authors": p["authors"], "year": (p["published"] or "")[:4],
                                "bibkey": self.library.bibkey(p["arxiv_id"])} for p in self.library.get(a.get("ids") or [])]}

        reg.add(Tool("paper_get", "library.get", "RAG", "按 id（如 arxiv:2401.01234）取论文的完整摘要和 bib key。",
                     obj(["ids"], ids=arr("论文 id 列表")), paper_get, lambda v: f"{len(v['papers'])} 篇", arg="ids"))

        def genealogy_expand(ctx: ToolCtx, a: dict):
            return self.genealogy.expand(a.get("paper_ids") or [], int(a.get("depth") or 1))

        reg.add(Tool("genealogy_expand", "genealogy.expand", "GRAPH", "在族谱馆里展开论文的邻居（引用或相近关系），depth 1~3。",
                     obj(["paper_ids"], paper_ids=arr("论文 id，如 arxiv:2401.01234"), depth=n("展开几层，默认 1")),
                     genealogy_expand, arg="depth"))

        def repo_search(ctx: ToolCtx, a: dict):
            return self.depots.search(a["query"], a.get("repo"))

        reg.add(Tool("repo_search", "depot.search", "RAG", "检索仓库群里的 README、文档和代码说明，找 baseline 实现、评测脚本和指标定义。",
                     obj(["query"], query=s("英文关键词"), repo=s("只搜某个仓库，可选")), repo_search,
                     lambda v: f"命中 {len(v['hits'])} 段", arg="query"))

        reg.add(Tool("gpu_status", "power.status", "TOOL", "查看电厂的 GPU 负荷和排队。", obj(), lambda c, a: self.plant.status()))

        def gpu_submit(ctx: ToolCtx, a: dict):
            job = self.plant.submit(ctx.line_id, a.get("name") or "main", a.get("config") or {}, int(a.get("gpus") or 1))
            return {"job_id": job.id, "status": job.status, "plant": self.plant.name, "summary": f"{job.id} 已提交"}

        reg.add(Tool("gpu_submit", "power.submit", "TOOL", "向电厂提交一个实验任务。config: {method, baselines, metrics, seeds}。",
                     obj(["name", "config"], name=s("任务名"), gpus=n("申请几张卡"),
                         config=obj(["method", "baselines", "metrics"], method=s("我们的方法名"), baselines=arr("baseline 名字"),
                                    metrics=arr("指标"), seeds=n("种子数"))),
                     gpu_submit, arg="name"))

        def gpu_wait(ctx: ToolCtx, a: dict):
            job = self.plant.wait(a["job_id"])
            if job.status != "done":
                raise ToolError("任务还没跑完")
            return {"job_id": job.id, "status": job.status, "result": job.result,
                    "summary": "完成（模拟结果）" if job.result.get("simulated") else "完成"}

        reg.add(Tool("gpu_wait", "power.wait", "TOOL", "等待实验任务完成，返回结果表。", obj(["job_id"], job_id=s("任务 id")), gpu_wait, arg="job_id"))

        def press_typeset(ctx: ToolCtx, a: dict):
            if not ctx.line_id:
                raise ToolError("没有对应的流水线")
            table = self.pipeline.item(ctx.line_id, "exp")
            sections = a.get("sections") or {}
            info = self.press.typeset(ctx.line_id, a.get("title") or "Untitled", a.get("abstract") or "", sections,
                                      a.get("cite_ids") or [], table)
            self.save_item(ctx.line_id, "tex", "write", "press", a.get("title") or "初稿",
                           {"title": a.get("title"), "abstract": a.get("abstract"), "sections": sections,
                            "cite_ids": a.get("cite_ids") or [], "typeset": info})
            return info

        sec = {k: s(f"{k} 一节的 LaTeX 正文") for k in ("introduction", "related_work", "method", "experiments", "conclusion")}
        reg.add(Tool("press_typeset", "press.typeset", "TOOL",
                     "排版并编译论文。sections 的每一节是 LaTeX 正文（不含 \\section）；cite_ids 是要进 refs.bib 的论文 id。返回编译结果，失败时带报错。",
                     obj(["title", "abstract", "sections", "cite_ids"], title=s("英文题目"), abstract=s("摘要"),
                         sections=obj(list(sec), **sec), cite_ids=arr("论文 id，如 arxiv:2401.01234")),
                     press_typeset, arg="title"))

        def press_read(ctx: ToolCtx, a: dict):
            text = self.press.read(ctx.line_id or "", a.get("name") or "main.tex")
            if not text:
                raise ToolError("还没有排版好的稿子")
            return text

        reg.add(Tool("press_read", "press.read", "TOOL", "读取当前论文的 TeX 源码。", obj(name=s("文件名，默认 main.tex")),
                     press_read, lambda v: f"{len(v)} 字符", arg="name"))

        def line_items(ctx: ToolCtx, a: dict):
            if not ctx.line_id:
                return []
            return [{"stage": r["stage"], "title": r["title"], "kind": r["kind"],
                     "body": json.dumps(r["body"], ensure_ascii=False)[:1500]}
                    for r in self.db.q("select * from items where line_id = ? order by created_at", ctx.line_id)]

        reg.add(Tool("line_items", "line.read", "TOOL", "读取当前这篇论文流水线上已有的产出（撞车报告、草案、结果表、审稿意见）。",
                     obj(), line_items))

        def arxiv_after(ctx: ToolCtx, a: dict, value):
            papers = value.get("papers", []) if isinstance(value, dict) else []
            added = self.ingest(papers, "arxiv")
            hits = self.library.rank(papers, terms_of(a.get("query", "")))
            return {"query": a.get("query"), "hits": hits, "ingested": len(added),
                    "summary": f"{len(papers)} 篇，新入馆 {len(added)} 篇"}

        self.mcp.after["arxiv_search"] = arxiv_after
