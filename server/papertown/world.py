"""World state: what stands where (from assets/manifest.json, generated from design/src/world.js),
and what each building shows when you open it.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

from .db import now

if TYPE_CHECKING:
    from .town import Town

# What each building runs on, where that differs from the design label.
TECH = {
    "mill": "负责人 · 本地员工", "farm": "本地命令 · nvidb", "press": "Skill · latexmk", "market": "员工名册 · 真实会话",
    "power": "nvidb · GPU 队列（只读）", "dock_arxiv": "MCP · arXiv", "library": "RAG · BM25 + 覆盖率",
    "genealogy": "知识图谱 · 相近 / 引用", "depot": "RAG · 仓库文档", "academy": "skim · 分层 skill 配置", "exchange": "MCP · 工具接线",
}
# The four buildings the main map is about; they are labelled and highlighted, the rest recede.
CORE = {"mill", "farm", "press", "depot"}

# Buildings backed by working code; the rest are scenery and say so.
LIVE = {"dock_arxiv", "customs", "hatchery", "mill", "farm", "press", "qa", "depot", "library", "genealogy",
        "market", "cityhall", "bank", "newspaper", "power", "academy", "exchange"}

# whose building it is: the worker to ask there, a project's lead anywhere else
STAFF_AT = {"depot": "coder", "farm": "coder", "power": "coder", "press": "writer"}


def st(name: str, out: str) -> dict:
    return {"name": name, "out": out}


# what happens inside each building: its own production line, goods in and out, tools
CATALOG: dict[str, dict] = {
    "dock_arxiv": {"stations": [st("船靠岸", "notes"), st("卸货", "tex"), st("送海关", "notes"), st("出港投稿", "pdf")],
                   "skills": [], "tools": ["arxiv.search", "arxiv.get_papers"], "from": [["qa", "pdf"]], "to": [["customs", "notes"]],
                   "real": "arXiv 码头通过 MCP 提供论文检索。负责人可检索和阅读相关工作，论文可通过导入功能送入图书馆。"},
    "dock_github": {"stations": [st("同步", "crate"), st("拆包分拣", "crate"), st("发往仓库", "crate")],
                    "skills": [], "tools": ["github.list_events", "github.get_repo"], "from": [], "to": [["depot", "crate"]],
                    "real": "计划接入 GitHub MCP server。配置后可在 MCP 房间查看连接状态和工具列表。"},
    "customs": {"stations": [st("去重", "notes"), st("打标签", "notes"), st("放行", "notes")],
                "skills": ["paper-triage"], "tools": [], "from": [["dock_arxiv", "notes"]], "to": [["library", "notes"], ["newspaper", "notes"]],
                "real": "入馆前按 arXiv id 和标题去重，再用 paper-triage skill 的脚本打领域标签。"},
    "lighthouse": {"stations": [st("订阅", "notes"), st("定时扫描", "notes"), st("发信号", "notes")],
                   "skills": [], "tools": ["arxiv.search"], "from": [], "to": [["newspaper", "notes"]],
                   "real": "以后做：定时盯住关注的作者和关键词，有撞车风险就提醒。"},
    "mill": {"stations": [st("方法设计", "draft"), st("实验", "table"), st("写作排版", "tex"),
                          st("质检", "pdf"), st("出厂", "pdf")],
             "skills": ["method-design"], "tools": ["library.search", "depot.search"],
             "from": [["hatchery", "notes"], ["market", "notes"], ["depot", "crate"]], "to": [["farm", "draft"], ["press", "draft"]],
             "real": "项目负责人组织本地员工推进方法、实验和写作。方法草案与工序产出保存在项目中，硬检查和卡口由代码执行。"},
    "hatchery": {"stations": [st("收蛋", "egg"), st("检索相似工作", "notes"), st("写撞车报告", "notes"),
                              st("等你决定", "egg"), st("立项", "draft")],
                 "skills": ["novelty-check"], "tools": ["library.search", "arxiv.search", "genealogy.expand"],
                 "from": [["cityhall", "egg"], ["library", "notes"], ["genealogy", "notes"]], "to": [["mill", "notes"]],
                 "real": "RAG（图书馆检索）+ MCP（arXiv 码头）+ novelty-check skill。结论由 skill 自带的 verdict.py 计算。"},
    "farm": {"stations": [st("领种子", "crate"), st("接电", "energy"), st("生长", "table"), st("收割", "table")],
             "skills": ["experiment-runner"], "tools": ["power.status", "power.submit", "power.wait"],
             "from": [["depot", "crate"], ["coldstore", "dataset"], ["power", "energy"]], "to": [["press", "table"]],
             "real": "代码员工提交本地命令或使用 nvidb GPU 队列运行实验，任务进度与真实结果在实验农场展示。"},
    "press": {"stations": [st("排铅字", "tex"), st("校样", "tex"), st("开机印刷", "pdf"), st("送质检", "pdf")],
              "skills": ["latex-writing"], "tools": ["library.get", "press.typeset"],
              "from": [["mill", "draft"], ["farm", "table"], ["depot", "crate"]], "to": [["qa", "pdf"]],
              "real": "写手生成 TeX，印刷厂从图书馆生成 refs.bib、插入结果表，用 latexmk 编译出 PDF。编译报错（卡纸）会退回写手。"},
    "qa": {"stations": [st("格式检查", "pdf"), st("审稿人打分", "pdf"), st("汇总意见", "pdf"), st("退回或放行", "pdf")],
           "skills": ["anonymity-check", "paper-review"], "tools": ["press.read"],
           "from": [["press", "pdf"]], "to": [["dock_arxiv", "pdf"], ["press", "tex"]],
           "real": "项目负责人提交审稿意见。硬检查由代码执行，研究回路上的卡口决定工序是否可以收尾。"},
    "depot": {"stations": [st("读简报", "draft"), st("写代码", "crate"), st("跑测试", "crate"), st("提交实验", "energy")],
              "skills": [], "tools": ["papertown_submit_job", "papertown_job_status", "depot.search"],
              "from": [["mill", "draft"], ["dock_github", "crate"]], "to": [["farm", "crate"]],
              "real": "项目的代码员工在本地运行，负责阅读方法草案、修改代码、运行测试和提交实验。示例仓库文档可用于检索 baseline。"},
    "workshop": {"stations": [st("接单", "crate"), st("修理", "crate"), st("跑 CI", "crate"), st("送回仓库", "crate")],
                 "skills": [], "tools": [], "from": [["depot", "crate"]], "to": [["farm", "crate"], ["depot", "crate"]],
                 "real": "以后做：代码送去实验农场之前先在这里跑 CI，维护 agent 回 issue、改文档、开 PR，改动先给你确认。"},
    "logistics": {"stations": [st("登记线路", "crate"), st("调度", "crate"), st("签收", "crate")],
                  "skills": [], "tools": [], "from": [["depot", "crate"]], "to": [["mill", "crate"]],
                  "real": "以后做：repo 之间、repo 和论文之间的依赖图谱，造纸厂的方法要用哪些代码从这里查。"},
    "library": {"stations": [st("收书", "notes"), st("切段", "notes"), st("编目", "notes"), st("借阅", "notes")],
                "skills": [], "tools": ["library.search", "library.get"], "from": [["customs", "notes"]],
                "to": [["hatchery", "notes"], ["mill", "notes"], ["press", "notes"]],
                "real": "SQLite FTS5 做 BM25 召回，再按关键词覆盖率排序。中文 idea 通过术语表扩展成英文检索词。"},
    "academy": {"stations": [st("开课", "notes"), st("排课表", "notes"), st("发教材", "notes"), st("上岗", "notes")],
                "skills": [], "tools": [], "from": [["market", "notes"]], "to": [["depot", "notes"], ["press", "notes"]],
                "real": "用 skim 管理 skill：skill 都在 skim 的全局仓库（~/.skim/store），配置像 git config 一样分三层，窄的覆盖宽的——全局（~/.skim/skimconfig）、项目（Papertown 里这个项目的 .skim/config）、对话（~/.skim/sessions/papertown-<员工>.config）。算出来的 skill 链接进员工的 .papertown/skills，简报里列出每个 SKILL.md 的路径。"},
    "exchange": {"stations": [st("登记线路", "notes"), st("接通", "energy"), st("转接", "notes"), st("挂断", "notes")],
                 "skills": [], "tools": [], "from": [], "to": [["hatchery", "notes"], ["dock_arxiv", "notes"]],
                 "real": "MCP 房间管理内置和自定义 server 的连接、状态与工具列表，支持接通、停用和重连。环境变量配置保存在本地。"},
    "genealogy": {"stations": [st("抽关系", "notes"), st("连边", "notes"), st("查族谱", "notes"), st("出报告", "notes")],
                  "skills": [], "tools": ["genealogy.expand"], "from": [["library", "notes"]], "to": [["hatchery", "notes"]],
                  "real": "论文关系图：默认是入馆时算出的相近关系。用 `papertown ingest --refs` 可以从 Semantic Scholar 补上真实引用。"},
    "market": {"stations": [st("列岗位", "notes"), st("查看岗位", "notes"), st("上岗", "notes"), st("查看会话", "notes")],
               "skills": [], "tools": ["pt hire"], "from": [["cityhall", "egg"]], "to": [["mill", "notes"], ["depot", "notes"]],
               "real": "这里展示实际启动过的员工及其岗位。项目负责人通过 pt hire 启动代码员工和写作员工。"},
    "cityhall": {"stations": [st("写下 idea", "egg"), st("启动负责人", "egg"), st("送孵化场", "egg"), st("等报告", "notes")],
                 "skills": [], "tools": [], "from": [], "to": [["hatchery", "egg"], ["market", "egg"]],
                 "real": "个人中心展示项目、负责人开关和待办。写下 idea 后，项目负责人开始查重并汇报进展。"},
    "bank": {"stations": [st("记账", "notes"), st("预算提醒", "notes"), st("结算", "notes")],
             "skills": [], "tools": [], "from": [["mill", "notes"], ["farm", "energy"], ["press", "notes"]], "to": [],
             "real": "这里展示本地 CLI 的订阅额度与会话用量。统计来自订阅读数和本地会话日志，费用为代码计算的估算值。"},
    "newspaper": {"stations": [st("收稿", "notes"), st("写摘要", "notes"), st("排版", "notes"), st("送报", "notes")],
                  "skills": [], "tools": [], "from": [["customs", "notes"], ["farm", "table"], ["market", "notes"]], "to": [["press", "notes"]],
                  "real": "运行状态页展示项目进度、新入馆论文、负责人状态和工具活动。"},
    "power": {"stations": [st("接单", "energy"), st("分卡", "energy"), st("发电", "energy"), st("抄表", "energy")],
              "skills": [], "tools": [], "from": [], "to": [["farm", "energy"]],
              "real": "读 nvidb 的队列数据库（nvidb queue status --json --no-tick，不会主动连节点）：每台机器每张卡的显存、利用率、温度和上面跑的进程，以及队列里的任务。只读，提交和取消仍然用 nvidb 命令。"},
    "coldstore": {"stations": [st("登记", "dataset"), st("下载", "dataset"), st("出库", "dataset")],
                  "skills": [], "tools": [], "from": [], "to": [["farm", "dataset"], ["depot", "dataset"]],
                  "real": "以后做：数据集的大小、格式和存放位置。"},
    "weather": {"stations": [st("抓 DDL", "notes"), st("预警", "notes"), st("推送", "notes")],
                "skills": [], "tools": [], "from": [], "to": [["press", "notes"], ["farm", "notes"], ["newspaper", "notes"]],
                "real": "以后做：会议 DDL 和日程，截稿临近时提醒印刷厂收稿、提醒实验农场别再加实验。"},
}


class World:
    def __init__(self, town: "Town"):
        self.town = town
        self.db = town.db
        m = json.loads(town.s.manifest.read_text(encoding="utf-8"))
        self.types = {b["type"]: b for b in m["buildings"]}
        self.districts = m["districts"]
        self._migrate(m["placements"])

    def _place(self, p: dict) -> None:
        self.db.insert("buildings", {"id": p["id"], "type": p["type"], "x": p["x"], "y": p["y"], "name": p.get("name"),
                                     "label": p.get("label"), "accent": p.get("accent"), "status": "idle", "created_at": now()})

    def _migrate(self, placements: list[dict]) -> None:
        """Bring the town in line with the manifest: fold the per-paper mills and per-repo depots of towns from
        before the base camp, then put every building where the layout has it."""
        self.db.x("delete from buildings where type in ('mill', 'depot') and id not in ('mill', 'depot')")
        self.db.x("update lines set mill_id = 'mill' where mill_id is not null and mill_id != 'mill'")
        self.db.x("update stages set building = 'mill' where building like 'mill_%'")
        for p in placements:
            if self.db.one("select 1 from buildings where id = ?", p["id"]):
                self.db.update("buildings", {"id": p["id"]}, x=p["x"], y=p["y"])
            else:
                self._place(p)

    def name(self, b: dict) -> str:
        return b.get("name") or self.types[b["type"]]["name"]

    def placements(self) -> list[dict]:
        out = []
        for b in self.db.q("select * from buildings order by created_at, id"):
            core = b["type"] in CORE
            out.append({"id": b["id"], "type": b["type"], "x": b["x"], "y": b["y"], "name": self.name(b),
                        "label": b["label"], "accent": b["accent"], "line_id": b["line_id"], "status": b["status"],
                        "core": core, "key": core, "live": b["type"] in LIVE,
                        "tech": TECH.get(b["type"], self.types[b["type"]]["tech"])})
        return out

    def get(self, bid: str) -> dict | None:
        b = self.db.one("select * from buildings where id = ?", bid)
        if b:
            return b
        if bid.startswith("mill_"):  # links from before the base camp
            return self.db.one("select * from buildings where id = 'mill'")
        return self.db.one("select * from buildings where type = ? order by id limit 1", bid)

    def set_status(self, bid: str, status: str, line_id: str | None = None) -> None:
        b = self.get(bid)
        if b and b["type"] == "mill":
            status = "busy" if status == "busy" or self.db.val("select 1 from lines where status = 'running' and id != ?", line_id or "") else "idle"
        if not b or b["status"] == status:
            return
        self.db.update("buildings", {"id": b["id"]}, status=status)
        self.town.bus.publish("building", id=b["id"], status=status, line_id=line_id)

    def sheet(self, bid: str) -> dict | None:
        b = self.get(bid)
        if not b:
            return None
        meta = self.types[b["type"]]
        cat = CATALOG.get(b["type"], {"stations": [], "skills": [], "tools": [], "from": [], "to": [], "real": ""})
        base = {"id": b["id"], "type": b["type"], "name": self.name(b), "label": b["label"], "accent": b["accent"],
                "district": self.districts[meta["district"]]["name"], "rep": meta["represents"], "tech": TECH.get(b["type"], meta["tech"]),
                "later": meta.get("later", False), "live": b["type"] in LIVE, "status": b["status"],
                "skills": cat["skills"], "tools": cat["tools"], "real": cat["real"],
                "from": self._goods(cat["from"]), "to": self._goods(cat["to"])}
        if b["type"] == "mill":
            return base | self._mill(b)
        active = self._active(b["type"])
        stations = [dict(s, st="todo") for s in cat["stations"]]
        if active and stations:
            k = min(len(stations) - 1, max(1, round(active["pct"] / 100 * (len(stations) - 1))))
            for i, s in enumerate(stations):
                s["st"] = "done" if i < k else "run" if i == k else "todo"
        elif b["status"] == "idle" and stations and self._recent(b["type"]):
            for s in stations:
                s["st"] = "done"
        job = self._job(b, active)
        return base | {"job": job, "stations": stations, "active_line": active["line_id"] if active else None,
                       "repos": self.town.depots.all() if b["type"] == "depot" else None}

    def job(self, b: dict) -> str:
        """What a building is doing, in a line."""
        return self._mill(b)["job"] if b["type"] == "mill" else self._job(b, self._active(b["type"]))

    def _active(self, btype: str) -> dict | None:
        return self.db.one("select s.*, l.title, l.seq from stages s join lines l on l.id = s.line_id"
                           " where s.building = ? and s.status = 'run' order by s.started_at desc limit 1", btype)

    def _goods(self, pairs: list) -> list[list[str]]:
        return [[target, item] for target, item in pairs if self.get(target)]

    def _recent(self, btype: str) -> bool:
        return bool(self.db.val("select 1 from stages where building = ? and status = 'done' limit 1", btype))

    def _job(self, b: dict, active: dict | None) -> str:
        t, town = b["type"], self.town
        if t not in LIVE:
            return "未接入"
        if active:
            return f"项目 #{active['seq']}「{active['title']}」"
        if t == "library":
            return f"馆藏 {town.library.count()} 篇"
        if t == "academy":
            sk = town.skim.status()
            return f"skim · 仓库里 {len(sk['store'])} 个 skill · {len(sk['envs'])} 个环境" if sk["ok"] else f"skim 未接入：{sk['note']}"
        if t == "exchange":
            info = town.mcp.info()
            return f"{sum(1 for x in info if x['state'] == 'ok')}/{len(info)} 条线接通 · {sum(len(x['tools']) for x in info)} 个工具"
        if t == "customs":
            return f"已放行 {town.library.count()} 篇"
        if t == "dock_arxiv":
            n = self.db.val("select count(*) from papers where source = 'arxiv'")
            return f"arXiv 端口{'已连接' if town.mcp.clients.get('arxiv') else '未连接'} · 累计拉货 {n} 篇"
        if t == "genealogy":
            g = town.genealogy.stats()
            return f"{sum(g.values())} 条关系" + (f"（{g.get('cites', 0)} 条引用）" if g.get("cites") else "")
        if t == "market":
            rows = self.db.q("select role, count(*) n from agents where runtime is not null group by role")
            from .agents import ROLES
            return "已启动 " + str(sum(r["n"] for r in rows)) + " 名员工" + (" · " + "、".join(f"{ROLES.get(r['role'], {}).get('name', r['role'])} {r['n']}" for r in rows) if rows else "")
        if t == "cityhall":
            return f"{self.db.val('select count(*) from lines')} 个项目"
        if t == "bank":
            providers = town.usage.snapshot()["providers"]
            return " · ".join(f"{p['label']}：" + ("、".join(f"{w['label']} 剩余 {w['left']}%" for w in p["windows"]) or "暂未取得订阅额度") for p in providers)
        if t == "power":
            nv = town.nvidb.status()
            if not nv["ok"]:
                return f"nvidb 未连接：{nv['note']}"
            sm = nv["summary"]
            return f"{sm['up']} 台机器 · {sm['gpus']} 张卡 · {sm['idle']} 张空闲 · {nv['counts'].get('running', 0)} 个任务在跑"
        if t == "depot":
            n = self.db.val("select count(*) from agents where role = 'coder' and status in ('idle', 'working', 'starting')")
            return f"{n} 个代码员工在线"
        if t == "newspaper":
            return "运行状态页"
        return "空闲"

    def _mill(self, b: dict) -> dict:
        n = self.db.val("select count(*) from lines where status = 'running'")
        total = self.db.val("select count(*) from lines where status != 'dropped'")
        return {"job": f"{n} 个项目在跑，共 {total} 个" if total else "空闲 · 放入一颗 idea 后开工", "line": None, "stations": []}
