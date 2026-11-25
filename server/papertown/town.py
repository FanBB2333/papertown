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
from .bounds import Bounds
from .ask import Asker
from .pages import Pages
from .cards import Cards
from .config import Settings
from .db import DB, now
from .depots import Depots
from .events import EventBus
from .farm import Farm, summarize
from .canvas import Canvas
from .checks import Checks
from .leads import Leads
from .graph import Genealogy
from .library import Library
from .linked import Linked
from .mcp_hub import McpHub
from .nvidb import Nvidb
from .history import History
from .paseo_models import PaseoModels
from .accounts import Accounts
from .skim import Skim
from .pipeline import NAMES, Pipeline
from .relay import Relay
from .press import Press
from .skills import SkillRegistry
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
        self.library = Library(self.db, self.s.data_dir / "rag.json")
        self.genealogy = Genealogy(self.db, self.library, self.s)
        self.depots = Depots(self.db)
        self.nvidb = Nvidb(self.s)
        self.press = Press(self.s.press_dir, self.library, self.s.compile_tex, self.s.latexmk_bin)
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
        self.mcp = McpHub(self)
        self.pipeline = Pipeline(self)
        self.linked = Linked(self)
        self.usage = Usage(self)
        self.workspace = Workspace(self)
        self.skim = Skim(self)
        self.accounts = Accounts(self)
        if not self.library.count():
            self.ingest(seed_papers(), "seed")

    def start(self) -> None:
        self.pipeline.migrate()
        self.farm.recover()
        self.agents.reconcile()
        self.mcp.start()
        samples.maybe_seed(self)
        self.linked.sync()
        try:
            self.skim.sync_town()  # before any lead starts, so its first brief lists the town's skills
        except Exception:  # noqa: BLE001 - skim is optional; the academy shows what is wrong
            pass
        self.terminals.start()
        self.nvidb.start()
        self.relay.start()
        self.leads.start()
        self.checks.start()
        self.paseo_models.start()
        self.usage.start()

    def stop(self) -> None:
        self.leads.stop()
        self.usage.stop()
        self.terminals.shutdown()
        self.agents.shutdown()
        self.paseo_models.stop()
        self.checks.stop()
        self.relay.stop()
        self.nvidb.stop()
        self.mcp.stop()

    def trace(self, kind: str, label: str, detail: str = "", ms: int = 0, run_id: str | None = None, line_id: str | None = None) -> None:
        row = {"ts": now(), "run_id": run_id, "line_id": line_id, "kind": kind, "label": label, "detail": detail, "ms": ms}
        row["id"] = self.db.insert("trace", row)
        self.bus.publish("trace", row=row)

    def message(self, line_id: str | None, role: str, worker_id: str | None, kind: str, body: dict) -> dict:
        row = {"ts": now(), "line_id": line_id, "role": role, "worker_id": worker_id, "kind": kind, "body": body}
        row["id"] = self.db.insert("messages", row)
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

    def brief(self, line_id: str, role: str = "", agent: dict | None = None) -> str:
        """Everything a pi agent should know about its project, as plain text; `agent` (else the project's agent for
        the role) gets its skills listed."""
        ln = self.pipeline.line(line_id)
        out = [f"项目 #{ln['seq']}：{ln['title']}", f"状态：{ln['status']}，当前工序：{NAMES.get(ln['stage'], ln['stage'])}", "", "## idea", ln["idea"]]
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
            out += ["", "## 方法草案", "还没有，由项目负责人在「方法设计」工序里写。"]
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
        agent = agent or (self.agents.get(f"{role}-{line_id}") if role in ("coder", "writer", "lead") else None)
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

