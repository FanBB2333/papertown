"""World state: what stands where, and what each building shows when you open it.

Static placements come from assets/manifest.json (generated from design/src). Mills are
not static: every paper gets its own mill, built on the next free slot in the industry
district when its idea hatches.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

from .db import now

if TYPE_CHECKING:
    from .town import Town

MILL_SLOTS = [(1, 17), (0, 12), (3, 12), (0, 14), (3, 14), (12, 19), (12, 21), (8, 21)]
# What each building actually runs on today, where that differs from the design label.
TECH = {
    "mill": "Skills + agent 编队", "farm": "Skill · 电厂接口", "press": "Skill · latexmk", "market": "组织编译 · ROI 升降级",
    "power": "GPU 任务队列（未接入）", "power_sim": "模拟 GPU 后端", "dock_arxiv": "MCP · arXiv", "library": "RAG · BM25 + 覆盖率",
    "genealogy": "知识图谱 · 相近 / 引用", "depot": "RAG · 仓库文档",
}
KEY_LABELS = {"dock_arxiv", "hatchery", "farm", "press", "qa", "library", "market", "cityhall", "depot_a", "power_sim"}

# Buildings backed by working code. The rest are scenery for now and say so.
LIVE = {"dock_arxiv", "customs", "hatchery", "mill", "farm", "press", "qa", "depot", "library", "genealogy",
        "market", "cityhall", "bank", "newspaper", "power_sim"}


def st(name: str, out: str, *team: str) -> dict:
    return {"name": name, "out": out, "team": list(team)}


# what happens inside each building: its own production line, goods in and out, tools
CATALOG: dict[str, dict] = {
    "dock_arxiv": {"stations": [st("船靠岸", "notes"), st("卸货", "tex"), st("送海关", "notes", "scout"), st("出港投稿", "pdf")],
                   "skills": [], "tools": ["arxiv.search", "arxiv.get_papers"], "from": [["qa", "pdf"]], "to": [["customs", "notes"]],
                   "real": "arXiv 码头是一个 MCP server（papertown.ports.arxiv_server），孵化员查重时通过 MCP 调用它检索 arXiv；拉到的论文经过海关进入图书馆。论文出厂也从这里出港。"},
    "dock_github": {"stations": [st("同步", "crate"), st("拆包分拣", "crate", "keeper"), st("发往仓库", "crate")],
                    "skills": [], "tools": ["github.list_events", "github.get_repo"], "from": [], "to": [["depot", "crate"]],
                    "real": "计划接 GitHub MCP server；把它写进 PAPERTOWN_MCP_CONFIG 后，工具会自动出现在员工的工具列表里。"},
    "customs": {"stations": [st("去重", "notes"), st("打标签", "notes"), st("放行", "notes")],
                "skills": ["paper-triage"], "tools": [], "from": [["dock_arxiv", "notes"]], "to": [["library", "notes"], ["newspaper", "notes"]],
                "real": "入馆前按 arXiv id 和标题去重，再用 paper-triage skill 的脚本打领域标签。"},
    "lighthouse": {"stations": [st("订阅", "notes"), st("定时扫描", "notes"), st("发信号", "notes")],
                   "skills": [], "tools": ["arxiv.search"], "from": [], "to": [["newspaper", "notes"]],
                   "real": "以后做：定时盯住关注的作者和关键词，有撞车风险就提醒。"},
    "hatchery": {"stations": [st("收蛋", "egg"), st("检索相似工作", "notes", "hatcher"), st("写撞车报告", "notes", "hatcher"),
                              st("等你决定", "egg"), st("建厂", "draft")],
                 "skills": ["novelty-check"], "tools": ["library.search", "arxiv.search", "genealogy.expand"],
                 "from": [["cityhall", "egg"], ["library", "notes"], ["genealogy", "notes"]], "to": [["mill", "notes"]],
                 "real": "RAG（图书馆检索）+ MCP（arXiv 码头）+ novelty-check skill；结论由 skill 自带的 verdict.py 计算。"},
    "farm": {"stations": [st("领种子", "crate", "experimenter"), st("接电", "energy", "experimenter"), st("生长", "table"), st("收割", "table")],
             "skills": ["experiment-runner"], "tools": ["power.status", "power.submit", "power.wait"],
             "from": [["depot", "crate"], ["coldstore", "dataset"], ["power_sim", "energy"]], "to": [["press", "table"]],
             "real": "实验员按方法草案向电厂提交任务。目前只有模拟电厂，结果表都标着「模拟」。"},
    "press": {"stations": [st("排铅字", "tex", "writer"), st("校样", "tex", "writer"), st("开机印刷", "pdf"), st("送质检", "pdf")],
              "skills": ["latex-writing"], "tools": ["library.get", "press.typeset"],
              "from": [["mill", "draft"], ["farm", "table"], ["depot", "crate"]], "to": [["qa", "pdf"]],
              "real": "写手生成 TeX，印刷厂从图书馆生成 refs.bib、插入结果表，用 latexmk 编译出 PDF；编译报错（卡纸）会退回写手。"},
    "qa": {"stations": [st("格式检查", "pdf"), st("审稿人打分", "pdf", "reviewer", "reviewer"), st("汇总意见", "pdf", "reviewer"), st("退回或放行", "pdf")],
           "skills": ["anonymity-check", "paper-review"], "tools": ["press.read"],
           "from": [["press", "pdf"]], "to": [["dock_arxiv", "pdf"], ["press", "tex"]],
           "real": "anonymity-check 的脚本先做格式检查，再由几位不同视角的审稿人（paper-review skill）打分；不通过就退回印刷厂改一轮。"},
    "depot": {"stations": [st("入库", "crate"), st("上架", "crate"), st("盘点", "crate", "keeper"), st("出货", "crate")],
              "skills": [], "tools": ["depot.search"], "from": [["dock_github", "crate"]], "to": [["workshop", "crate"]],
              "real": "一座仓库是一个 repo：README 和代码文档进 RAG，方法设计师在这里找 baseline 实现和指标定义。"},
    "workshop": {"stations": [st("接单", "crate"), st("修理", "crate", "keeper"), st("跑 CI", "crate"), st("送回仓库", "crate")],
                 "skills": [], "tools": [], "from": [["depot", "crate"]], "to": [["depot", "crate"]],
                 "real": "以后做：维护 agent 回 issue、改文档、开 PR，改动先给你确认。"},
    "logistics": {"stations": [st("登记线路", "crate"), st("调度", "crate"), st("签收", "crate")],
                  "skills": [], "tools": [], "from": [["depot", "crate"]], "to": [["farm", "crate"]],
                  "real": "以后做：repo 之间、repo 和论文之间的依赖图谱。"},
    "library": {"stations": [st("收书", "notes"), st("切段", "notes"), st("编目", "notes"), st("借阅", "notes")],
                "skills": [], "tools": ["library.search", "library.get"], "from": [["customs", "notes"]],
                "to": [["hatchery", "notes"], ["mill", "notes"], ["press", "notes"]],
                "real": "RAG 主库：SQLite FTS5 做 BM25 召回，再按关键词覆盖率（或配置的 embedding 余弦）排序；中文 idea 先经过术语表扩展成英文检索词。"},
    "genealogy": {"stations": [st("抽关系", "notes"), st("连边", "notes"), st("查族谱", "notes", "scout"), st("出报告", "notes")],
                  "skills": [], "tools": ["genealogy.expand"], "from": [["library", "notes"]], "to": [["hatchery", "notes"]],
                  "real": "论文关系图：默认是入馆时算出的相近关系；用 `papertown ingest --refs` 可以从 Semantic Scholar 补上真实引用。"},
    "market": {"stations": [st("列岗位", "notes"), st("按预算编队", "notes"), st("上岗", "notes"), st("结算 ROI", "notes")],
               "skills": [], "tools": ["market.compile_team"], "from": [["cityhall", "egg"]], "to": [["mill", "notes"]],
               "real": "组织编译：按复杂度和预算编最小够用的团队；论文出厂后按质量和花费结算 ROI，升级或降级。Lv.3 以上的员工用强模型。"},
    "cityhall": {"stations": [st("写下 idea", "egg"), st("设预算", "egg"), st("送孵化场", "egg"), st("等报告", "notes")],
                 "skills": [], "tools": [], "from": [], "to": [["hatchery", "egg"], ["market", "egg"]],
                 "real": "你的个人中心：所有项目、预算和待办；对话框里写下的 idea 从这里出发。"},
    "bank": {"stations": [st("记账", "notes"), st("预算提醒", "notes"), st("结算", "notes")],
             "skills": [], "tools": [], "from": [["mill", "notes"], ["farm", "energy"]], "to": [],
             "real": "每次模型调用都按 token 计价入账，记到对应的运行和论文上；HUD 上的花费就是这里的数字。"},
    "newspaper": {"stations": [st("收稿", "notes"), st("写摘要", "notes"), st("排版", "notes"), st("送报", "notes")],
                  "skills": [], "tools": [], "from": [["customs", "notes"], ["farm", "table"], ["market", "notes"]], "to": [],
                  "real": "「运行状态」页就是这份报纸：项目进度、新入馆论文、员工升降级和各类调用次数。"},
    "power": {"stations": [st("接单", "energy"), st("分卡", "energy"), st("发电", "energy"), st("抄表", "energy")],
              "skills": [], "tools": [], "from": [], "to": [["farm", "energy"]],
              "real": "计划接真实 GPU 服务器的任务队列，实现和模拟电厂相同的 status / submit / wait 三个接口即可替换。"},
    "power_sim": {"stations": [st("接单", "energy"), st("排队", "energy"), st("模拟训练", "energy"), st("出表", "table")],
                  "skills": [], "tools": ["power.status", "power.submit", "power.wait"], "from": [], "to": [["farm", "energy"]],
                  "real": "没有 GPU 时的备用电源：按方法草案生成带固定种子的模拟结果表，所有数字都标着「模拟」，保证 demo 能跑完。"},
    "coldstore": {"stations": [st("登记", "dataset"), st("下载", "dataset"), st("出库", "dataset")],
                  "skills": [], "tools": [], "from": [], "to": [["farm", "dataset"]],
                  "real": "以后做：数据集的大小、格式和存放位置。"},
    "weather": {"stations": [st("抓 DDL", "notes"), st("预警", "notes"), st("推送", "notes")],
                "skills": [], "tools": [], "from": [], "to": [["newspaper", "notes"]],
                "real": "以后做：会议 DDL 和日程，截稿临近时预警。"},
}


class World:
    def __init__(self, town: "Town"):
        self.town = town
        self.db = town.db
        m = json.loads(town.s.manifest.read_text(encoding="utf-8"))
        self.types = {b["type"]: b for b in m["buildings"]}
        self.districts = m["districts"]
        if not self.db.val("select count(*) from buildings"):
            for p in m["placements"]:
                if p["type"] == "mill":
                    continue  # mills are built per paper
                self.db.insert("buildings", {"id": p["id"], "type": p["type"], "x": p["x"], "y": p["y"], "name": p.get("name"),
                                             "label": p.get("label"), "accent": p.get("accent"), "status": "idle", "created_at": now()})

    # ---------- placements ----------

    def name(self, b: dict) -> str:
        return b.get("name") or self.types[b["type"]]["name"]

    def placements(self) -> list[dict]:
        out = []
        for b in self.db.q("select * from buildings order by created_at, id"):
            out.append({"id": b["id"], "type": b["type"], "x": b["x"], "y": b["y"], "name": self.name(b),
                        "label": b["label"], "accent": b["accent"], "line_id": b["line_id"], "status": b["status"],
                        "key": b["id"] in KEY_LABELS or b["type"] == "mill", "live": b["type"] in LIVE,
                        "tech": TECH.get(b["type"], self.types[b["type"]]["tech"])})
        return out

    def get(self, bid: str) -> dict | None:
        b = self.db.one("select * from buildings where id = ?", bid)
        if b:
            return b
        if bid == "mill":  # the newest mill stands in for the type
            return self.db.one("select * from buildings where type = 'mill' order by created_at desc limit 1")
        return self.db.one("select * from buildings where type = ? order by id limit 1", bid)

    def build_mill(self, line: dict) -> dict:
        taken = {(b["x"], b["y"]) for b in self.db.q("select x, y from buildings where type = 'mill'")}
        slot = next((s for s in MILL_SLOTS if s not in taken), None)
        if slot is None:  # town is full: the oldest finished paper's mill makes room
            old = self.db.one("select b.* from buildings b join lines l on l.id = b.line_id where b.type = 'mill'"
                              " and l.status in ('done', 'dropped') order by b.created_at limit 1")
            if not old:
                raise RuntimeError("工业区没有空地了，先结束一条流水线")
            self.db.x("delete from buildings where id = ?", old["id"])
            slot = (old["x"], old["y"])
        bid = f"mill_{line['seq']}"
        self.db.insert("buildings", {"id": bid, "type": "mill", "x": slot[0], "y": slot[1], "name": f"造纸厂 #{line['seq']}",
                                     "line_id": line["id"], "status": "busy", "created_at": now()})
        self.town.bus.publish("world", placements=self.placements(), built=bid)
        return self.get(bid)

    def set_status(self, bid: str, status: str, line_id: str | None = None) -> None:
        b = self.get(bid)
        if not b or b["status"] == status:
            return
        self.db.update("buildings", {"id": b["id"]}, status=status)
        self.town.bus.publish("building", id=b["id"], status=status, line_id=line_id)

    # ---------- what a building shows ----------

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
        active = self.db.one("select s.*, l.title, l.seq from stages s join lines l on l.id = s.line_id"
                             " where s.building = ? and s.status = 'run' order by s.started_at desc limit 1", b["type"])
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
                       "repo": self.town.depots.get(b["id"]) if b["type"] == "depot" else None}

    def _goods(self, pairs: list) -> list[list[str]]:
        out = []
        for target, item in pairs:
            if target == "depot":
                out += [[r["id"], item] for r in self.town.depots.all()]
            elif target == "mill":
                m = self.get("mill")
                if m:
                    out.append([m["id"], item])
            elif self.get(target):
                out.append([target, item])
        return out

    def _recent(self, btype: str) -> bool:
        return bool(self.db.val("select 1 from stages where building = ? and status = 'done' limit 1", btype))

    def _job(self, b: dict, active: dict | None) -> str:
        t, town = b["type"], self.town
        if t not in LIVE:
            return "未接入"
        if active:
            return f"造纸厂 #{active['seq']}「{active['title']}」"
        if t == "library":
            return f"馆藏 {town.library.count()} 篇"
        if t == "customs":
            return f"已放行 {town.library.count()} 篇"
        if t == "dock_arxiv":
            n = self.db.val("select count(*) from papers where source = 'arxiv'") or 0
            return f"arXiv 端口{'已连接' if town.mcp.clients.get('arxiv') else '未连接'} · 累计拉货 {n} 篇"
        if t == "genealogy":
            g = town.genealogy.stats()
            return f"{sum(g.values())} 条关系" + (f"（{g.get('cites', 0)} 条引用）" if g.get("cites") else "")
        if t == "market":
            return f"{len(town.market.all())} 名员工"
        if t == "cityhall":
            return f"{self.db.val('select count(*) from lines') or 0} 个项目"
        if t == "bank":
            s = town.bank.summary()
            return f"本周 ${s['week']:.2f} / ${s['budget']:.0f}"
        if t == "power_sim":
            return town.plant.status()["summary"]
        if t == "depot":
            r = town.depots.get(b["id"]) or {}
            return f"{r.get('issues', 0)} 个 open issue"
        if t == "newspaper":
            return "运行状态页"
        return "空闲"

    def _mill(self, b: dict) -> dict:
        line = self.town.pipeline.snapshot(b["line_id"]) if b["line_id"] else None
        return {"job": line["title"] if line else "空闲", "line": line}
