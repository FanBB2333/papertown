"""The console's assistant: the sidebar agent, one for the whole town, that reads the page you are on
(.papertown/page.md), asks and shows you things, and acts for you across projects from a fixed list of actions.
"""

from __future__ import annotations

import json
import re
import secrets
from pathlib import Path
from typing import TYPE_CHECKING, Callable

from .agents import PAGE_GUIDE, ROLES, AgentError, model_label
from .db import now
from .leads import LeadError, clip
from .paseo import PaseoError
from .workspace import WsError

if TYPE_CHECKING:
    from .town import Town

ID = "assistant"
MODS = {"overview": "概览", "survey": "调研", "code": "代码仓库", "exp": "实验", "data": "数据", "paper": "论文",
        "agents": "员工", "skills": "Skills", "mcp": "MCP", "rag": "图书馆"}
TEXT_MAX = 8000
SELECTION_MAX = 2000
REFS_MAX = 80

# name -> (what it does, its arguments with the optional ones in brackets); DIRECT ones run at once, the rest wait for your yes
ACTIONS: dict[str, tuple[str, str]] = {
    "tell": ("给项目发消息、派活：发给项目负责人；用户明确要求时，role 写 coder 或 writer 直接发给员工；now=true 插进它正在做的事",
             "line text [role] [now]"),
    "answer": ("把用户对项目里某个问题的回答转给在等的 agent：id 是问题编号，text 是用户的回答", "id text"),
    "job.submit": ("在实验农场提交一个任务：本地执行器在项目的代码目录里用 bash 跑这条命令", "line name command"),
    "job.cancel": ("取消实验农场里排着或在跑的任务（nvidb 的任务不行，Papertown 对 nvidb 只读）", "job"),
    "line.hatch": ("让孵化场里查重过了的项目立项，进造纸厂开工", "line"),
    "line.resume": ("让停下来等你的项目接着往下做", "line"),
    "line.adjust": ("按一句话调整项目的方向，再接着做", "line text"),
    "idea.submit": ("放入一颗新 idea，孵化场先查重", "text"),
    "agent.brief": ("给项目的代码员工或写作员工再发一遍最新的项目简报", "line role"),
    "agent.abort": ("打断项目的代码员工或写作员工手上的事", "line role"),
    "paper.compile": ("重新编译项目的论文", "line"),
    "skill.toggle": ("在技能学堂里打开或关掉一个 skill；scope 是 global（全局）、project（项目，默认）或 session（某个员工）",
                     "name enabled [scope] [line] [role]"),
    "mcp.toggle": ("启用或停用接线局里的一个 MCP server", "name enabled"),
    "mcp.restart": ("重连接线局里的一个 MCP server", "name"),
}
DIRECT = ("tell", "answer")
MENTIONED_MAX = 3

# how the assistant reaches the town, by runtime
TOOLS = {
    "pi": {"page": "`papertown_page` 工具", "get": "`papertown_get` 工具（path 写接口路径）", "brief": "`papertown_brief` 工具",
           "ask": "`papertown_ask` 工具（question；choices 是给他点的选项；point 为 true 时请他在页面上点一下）",
           "show": "`papertown_show` 工具（mod、line、file、job、ref 按需要填）", "actions": "`papertown_actions` 工具",
           "do": "`papertown_do` 工具（action 是动作名，args 是它的参数，why 写为什么要做）", "net": "",
           "status": "`papertown_get` 读 `/api/lines/<项目>/lead`（负责人、汇报和等回答的问题）和 `/api/lines/<项目>`",
           "reports": "`papertown_get` 读 `/api/reports?line_id=<项目>`", "worker": "`papertown_get` 读 `/api/agents/coder-<项目>`（写作员工换成 writer）",
           "tell": "`papertown_do` 工具（action 写 tell，args 写 line 和 text；发给员工本人时加 role）",
           "answer": "`papertown_do` 工具（action 写 answer，args 写 id 和 text）"},
    "paseo": {"page": "`.papertown/pt page`（或直接读这个文件）", "get": "`.papertown/pt get <接口>`", "brief": "`.papertown/pt brief [项目]`",
              "ask": "`.papertown/pt ask \"问题\" [--choice 选项]… [--point]`（--choice 是给他点的选项，--point 请他在页面上点一下）",
              "show": "`.papertown/pt show [--mod 面板] [--line 项目] [--file code:路径[:行号]] [--job 任务] [--ref 标识]`",
              "actions": "`.papertown/pt actions`", "do": "`.papertown/pt do <动作> key=value… --why \"为什么\"`",
              "net": "\n- `.papertown/pt` 直接连本机的 Papertown（{url}）；所在的沙箱不让联网时，它自动改走工作目录里的文件，不用为它申请权限。\n",
              "status": "`.papertown/pt status <项目>`", "reports": "`.papertown/pt reports <项目>`",
              "worker": "`.papertown/pt worker coder|writer --line <项目>`",
              "tell": "`.papertown/pt tell <项目> \"…\"`（发给员工本人时写 `.papertown/pt tell \"<项目> coder\" \"…\"`；加 `--now` 插进它正在做的事）",
              "answer": "`.papertown/pt answer <问题编号> \"…\"`"},
}

GUIDE = """# Papertown · 小助手

你是 Papertown 中控屏右边侧边栏里的小助手，也是用户的代理人：他通过你了解各个项目、给项目下命令、协调项目之间的事。他一边看页面一边问你：这一页显示的是什么、数字从哪来、某个项目怎么样了、接下来该做什么。你读页面背后的真实数据来回答，替他把话带给项目。

## 你和项目

- 每个项目有一位项目负责人（agent）：盯进度、催员工、给用户写汇报。员工（代码员工、写作员工）在它手下干活。你不盯某一个项目，你管项目之间的事：比较、取舍、协调（两个项目抢同一批卡、一个项目的结论另一个要用）。
- 用户不发话时你不做事，也不要自己去巡检项目，那是负责人的事。
- 用户提到某个项目，先弄清它现在的样子再回答。他用 #编号 提到的，Papertown 会把那个项目刚读的进展附在消息里（`<projects>`）；没附上的（他说的是名字，或者说「这个项目」），用 {status} 读。要更细的：{reports} 看汇报和问题，{worker} 看员工的对话。
- 给项目的命令发给它的负责人：{tell}。说清楚要什么结果、什么时候要；负责人会派给员工，办完写汇报。用户明确说「直接让代码员工……」时才发给员工本人。
- 项目里有 agent 在等用户回答（汇报里标着「等回答」）：用户跟你说话时给了答案，用 {answer} 转过去；他没说的，不要替他拿主意，把问题转述给他。

## 用户在看什么

- 用户每条消息开头有一段 `<page>…</page>`：在看哪个项目、哪个面板、面板上的设置和打开着的东西，他在页面上点了什么（「指着」），以及选中了哪段文字（「选中」，和它所在的那一块）。他说「这个」「这里」，就是指着的那一项或选中的文字；都没有时，就是整个面板。
- 更详细的在 `.papertown/page.md`：这一页每块内容的数据从哪来（文件、命令、接口），页面上能亮给他看的地方，以及面板上现在显示的文字。他换页面、指东西时它会更新。用 {page} 读。
- 回答之前去读真实来源，不要只凭页面上的文字猜；回答里说一句你看的是哪里。

## 读数据

- Papertown 的接口用 {get} 读，例如 `/api/lines/<项目>`（工序、状态、产出）、`/api/jobs?line_id=<项目>`（任务）、`/api/gpus`（显卡和谁在用）、`/api/lines/<项目>/data`（实验数据）。page.md 里列了这一页用到的接口。
- 项目简报（idea、方法草案、实验、审稿意见、仓库现状）：{brief}。
- 代码和论文就是本机的文件，路径在 page.md 里，直接读。用户的仓库只读：不要改文件，也不要提交。
- 显卡和任务队列来自 nvidb：`nvidb queue status --json --no-tick`、`nvidb job show <编号> --json --no-tick`。nvidb 只读：不要提交、取消任务，也不要确认告警；用户想这么做时，把命令告诉他，让他自己在终端里跑。{net}
## 和用户来回

- 指着或选中的只是一个数字、一个词时，先看 page.md 里那一块写着什么、面板上的文字，多半就知道是什么了。还拿不准他问的是哪里，再问他：{ask}。他的回答会作为下一条消息发来，开头的 `<page>` 里有他点的东西。问完就结束这一轮，等他回答。
- 想让他看页面上的某处：{show}。可以打开一个项目的某个面板（mod：overview 概览、survey 调研、code 代码仓库、exp 实验、data 数据、paper 论文、agents 员工、skills、mcp、rag 图书馆），打开代码仓库里的文件（file：`code:路径` 或 `code:路径:行号`），打开实验面板里一个任务的详情（job），或者把页面上的一处亮出来（ref，用 page.md 里列的标识）。说到页面上具体的东西时，顺手亮给他看。

## 替用户办事

- 能做的事用 {actions} 看，每件后面写着现在是直接做、要他先点「允许」，还是不能做（取决于他给你设的工作边界）：给项目发消息、转达回答、提交或取消实验农场的任务、立项、继续、调整方向、放入新 idea、编译论文、开关 skill 和 MCP server。
- 办事用 {do}（发消息和转达回答也可以用上面的写法）。直接做的会马上执行并告诉你结果；要他允许的，侧边栏会弹出一张卡片写着你要做什么、为什么，他点了才执行，结果会作为一条 `<event>…</event>` 消息发给你。提完这种请求就结束这一轮，告诉他你请求了什么、在等他点。
- 只用这个办法改小镇里的东西，不要直接调用会改东西的接口。要改代码或论文，告诉那个项目的负责人（tell）。

## 回复

- 用中文，短：先给结论，再给依据。数字带上单位和出处。
- 要用表格、图或对比才讲得清的（比较几个项目、一批实验的结果、一段代码怎么工作），写成一页 HTML，用 `.papertown/pt publish 页面.html "标题" --line <项目>` 发到那个项目的「汇报与讲解」，在侧边栏里说一句结论，告诉他页面的标题。
- 不知道就说不知道，并说可以去哪里查。
""" + PAGE_GUIDE


class ActError(Exception):
    pass


def _role(v: object, allowed: tuple[str, ...] = ("coder", "writer")) -> str:
    r = {"coder": "coder", "代码员工": "coder", "代码": "coder", "writer": "writer", "写作员工": "writer", "写作": "writer",
         "lead": "lead", "负责人": "lead", "项目负责人": "lead"}.get(str(v).strip().lower())
    if r not in allowed:
        raise ActError("role 要写 " + "、".join({"coder": "coder（代码员工）", "writer": "writer（写作员工）", "lead": "lead（项目负责人）"}[x] for x in allowed))
    return r


def _bool(v: object) -> bool:
    if isinstance(v, bool):
        return v
    s = str(v).strip().lower()
    if s in ("1", "true", "yes", "on", "打开", "启用"):
        return True
    if s in ("0", "false", "no", "off", "关掉", "停用"):
        return False
    raise ActError(f"enabled 要写 true 或 false，不是 {v}")


def _part(f: object) -> dict | None:
    """A part of the page as the sidebar names it: its label, ref, the heading over it and its text."""
    if not isinstance(f, dict):
        return None
    return {k: clip(f.get(k), 400 if k == "text" else 120) for k in ("ref", "label", "where", "text") if f.get(k)} or None


def _pointed(f: dict) -> str:
    """What you pointed at, as one line: its label, its ref and the part of the page it is in."""
    out = f.get("label") or clip(f.get("text"))
    if f.get("ref"):
        out += f"〔{f['ref']}〕"
    if f.get("where"):
        out += f"，在「{f['where']}」里"
    return out


class Assistant:
    def __init__(self, town: "Town"):
        self.town = town
        self.s = town.s
        self.db = town.db
        self.dir = self.s.data_dir / "assistant"
        self.page: dict = {}  # the latest from the sidebar

    def row(self) -> dict:
        """The assistant's agent row, created on first use."""
        a = self.town.agents.get(ID)
        if a:
            return a
        self.dir.mkdir(parents=True, exist_ok=True)
        self.db.insert("agents", {"id": ID, "line_id": None, "role": ID, "status": "stopped", "tmux": f"pt-{ID}", "cwd": str(self.dir),
                                  "token": secrets.token_urlsafe(18), "model": None, "cost": 0, "created_at": now(), "updated_at": now()})
        return self.town.agents.get(ID)

    def guide(self, runtime: str) -> str:
        tools = TOOLS[runtime] | {"net": TOOLS[runtime]["net"].format(url=self.s.url)}
        return GUIDE.format(**tools)

    def intro(self) -> str:
        """Its first message, marked <start> so the sidebar shows it as a note rather than as yours."""
        return ("<start>\n你是 Papertown 中控屏的小助手，也是用户的代理人。工作目录里的 AGENTS.md 说明了你和各个项目的关系、怎么看用户的页面、"
                "怎么读数据、怎么问用户、怎么替用户办事，先读一遍。读完用一两句话告诉用户你能帮什么，然后等他提问。\n</start>")

    def tools(self, d: Path) -> None:
        """Next to its `pt`: the list of actions and the page."""
        (d / "actions.md").write_text(self.actions_text() + "\n", encoding="utf-8")
        if self.page:
            (d / "page.md").write_text(self._page_md(self.page), encoding="utf-8")

    def actions_text(self) -> str:
        out = ["能替用户做的事，后面写着现在怎么办（按用户给你设的工作边界）：", ""]
        for k, v in ACTIONS.items():
            kind, rule = self.policy(k)
            how = {"auto": "直接做", "ask": "要他在侧边栏点「允许」", "never": "不能做"}[kind] + (f"：{rule['text']}" if rule else "")
            out.append(f"- {k}（{v[1]}）：{v[0]}。〔{how}〕")
        out += ["", "line 写项目的 id（line_6）或编号（#6）；job 写实验农场的任务 id（job_xxxxxxxx）。"]
        return "\n".join(out)

    def policy(self, action: str) -> tuple[str, dict | None]:
        return self.town.bounds.policy(ID, None, action, "auto" if action in DIRECT else "ask")

    def set_page(self, p: dict) -> dict:
        """What the sidebar says you are looking at; written to page.md for the assistant."""
        page = self._clean(p)
        self.page = page
        tools = self.dir / ".papertown"
        tools.mkdir(parents=True, exist_ok=True)
        (tools / "page.md").write_text(self._page_md(page), encoding="utf-8")
        return page

    def page_text(self) -> str:
        return self._page_md(self.page) if self.page else "用户还没在侧边栏里发过消息，不知道他在看哪一页。"

    @staticmethod
    def _clean(p: dict) -> dict:
        ln = p.get("line") if isinstance(p.get("line"), dict) else {}
        mod = str(p.get("mod") or "")
        selection = str(p.get("selection") or "").strip()[:SELECTION_MAX]
        return {
            "at": now(),
            "line": {"id": str(ln.get("id") or ""), "seq": ln.get("seq"), "title": clip(ln.get("title"), 80)} if ln.get("id") else None,
            "mod": mod, "mod_name": MODS.get(mod, clip(p.get("mod_name"), 20) or mod),
            "state": {clip(k, 20): clip(v, 160) for k, v in (p.get("state") or {}).items() if v not in (None, "", False)},
            "focus": _part(p.get("focus")),
            "refs": [{"ref": clip(r.get("ref"), 80), "label": clip(r.get("label"), 80)} for r in (p.get("refs") or [])[:REFS_MAX]
                     if isinstance(r, dict) and r.get("ref")],
            "text": str(p.get("text") or "")[:TEXT_MAX],
            "selection": selection,
            "selection_at": _part(p.get("selection_at")) if selection else None,
        }

    def header(self, p: dict) -> str:
        """The head of a message from the sidebar: where you are and what you point at."""
        ln, st = p.get("line"), " · ".join(f"{k} {v}" for k, v in p["state"].items())
        project = f"#{ln['seq']}「{ln['title']}」· " if ln else ""
        out = ["<page>", f"在看：{project}{p.get('mod_name') or '中控屏'}" + (f"（{st}）" if st else "")]
        if p.get("focus"):
            out.append("指着：" + _pointed(p["focus"]))
        if p.get("selection"):
            n = p["selection"].count("\n") + 1
            out.append(f"选中：「{clip(p['selection'], 120)}」" + (f"（{n} 行，全文在 page.md）" if n > 1 else ""))
            if p.get("selection_at"):
                out.append("选中的地方：" + _pointed(p["selection_at"]))
        return "\n".join([*out, "详细：.papertown/page.md", "</page>"])

    def _page_md(self, p: dict) -> str:
        ln = p.get("line")
        out = ["# 用户现在看的页面", "", f"{p['at']} 更新；他换页面、在页面上指东西时会更新。", ""]
        if ln:
            where = "，".join([ln["id"], *self._place(ln["id"])])
            out.append(f"- 项目：#{ln['seq']}「{ln['title']}」（{where}）")
        out.append(f"- 面板：{p['mod_name']}（{p['mod'] or '?'}）")
        out += [f"  - {k}：{v}" for k, v in p["state"].items()]
        f = p.get("focus")
        if f:
            out.append("- 用户指着：" + _pointed(f))
            if f.get("text") and f.get("text") != f.get("label"):
                out.append(f"  - 那一块写着：{f['text']}")
        if p.get("selection"):
            at = p.get("selection_at")
            out.append("- 用户在页面上选中了这段文字" + (f"，选中的地方：{_pointed(at)}" if at else "") + "：")
            if at and at.get("text") and at.get("text") != at.get("label"):
                out.append(f"  - 那一块写着：{at['text']}")
            out += ["", "```text", p["selection"], "```"]
        out += ["", "## 这一页的数据从哪来", "", *[f"- {x}" for x in self._sources(p["mod"], ln["id"] if ln else None)]]
        if p["refs"]:
            out += ["", "## 页面上能亮给他看的地方（show 的 ref）", "", *[f"- `{r['ref']}` {r['label']}" for r in p["refs"]]]
        if p["text"]:
            out += ["", "## 面板上现在显示的文字（节选）", "", "```text", p["text"], "```"]
        return "\n".join(out) + "\n"

    def _roots(self, lid: str | None) -> tuple[Path | None, Path | None] | None:
        try:
            return (self.town.workspace.root(lid, "code"), self.town.workspace.root(lid, "paper")) if lid else (None, None)
        except WsError:
            return None

    def _place(self, line_id: str) -> list[str]:
        roots = self._roots(line_id)
        if roots is None:
            return []
        code, paper = roots
        return [*(["本地项目"] if self.town.linked.of(line_id) else []), *([f"代码 {code}"] if code else []), *([f"论文 {paper}"] if paper else [])]

    def _sources(self, mod: str, lid: str | None) -> list[str]:
        """Where each part of a panel comes from, for the assistant to read it there."""
        t, x = self.town, lid or "<项目>"
        code, paper = self._roots(lid) or (None, None)
        link = t.linked.of(lid) if lid else None
        out: list[str] = []
        if mod == "overview":
            out += [f"八道工序的状态和每道工序的产出：接口 `/api/lines/{x}`（stages、outputs）",
                    f"代码和论文目录、分支、没提交的改动数：接口 `/api/lines/{x}/ws`",
                    f"小镇里和这个项目有关的消息：接口 `/api/messages?line_id={x}`"]
        elif mod == "survey":
            out += [f"查重报告（outputs.hatch）和方法草案（outputs.method）：接口 `/api/lines/{x}`",
                    f"调研到的文章和论文引用的文献：接口 `/api/lines/{x}/papers`",
                    "图书馆的馆藏：接口 `/api/library?q=<关键词>`"]
        elif mod == "code":
            out += [f"代码目录 `{code}`，文件直接读；git 只读：`git -C {code} status`、`git -C {code} log --oneline -10`" if code else "这个项目还没有代码目录",
                    f"文件树和 git 标记：接口 `/api/lines/{x}/ws/code/tree`；一个文件：`/api/lines/{x}/ws/code/file?path=<相对路径>`；"
                    f"和 git 里的版本对比：`/api/lines/{x}/ws/code/diff?path=<相对路径>`"]
        elif mod == "exp":
            out += [f"这个项目的任务（nvidb 队列和历史里认领到的，加上实验农场的）：接口 `/api/jobs?line_id={x}`"
                    + (f"；nvidb 的任务按 projects.json 的 match {link.get('match')} 认领（比对名字、工作目录、提交者、说明和命令）" if link else ""),
                    "显卡、队列、谁在用、用了多久：接口 `/api/gpus`（Papertown 每 10 秒读一次 nvidb；每张卡近一小时的趋势和每个进程第一次被看到的时间是 Papertown 自己记的）",
                    "一个 nvidb 任务的详情和事件：接口 `/api/nvidb/jobs/<编号>`；实验农场的任务和日志：`/api/jobs/<任务 id>?tail=200`",
                    "nvidb 的原始数据（只读，都带 --no-tick）：`nvidb queue status --json --no-tick`、`nvidb job show <编号> --json --no-tick`、"
                    "`nvidb job ls --json --no-tick -n 200`、`nvidb job logs <编号> -n 100`"]
        elif mod == "data":
            out += [f"这一页的全部数据：接口 `/api/lines/{x}/data`（meta 是数据集、baseline、指标；results 是实验工序报的结果；runs 是 nvidb 任务交回的 result.json；"
                    "files 是代码仓库里 results/、outputs/ 等目录下的数据文件）",
                    *([f"数据文件在代码目录 `{code}` 下，按 files 里的相对路径直接读"] if code else []),
                    "一个 nvidb 任务交回的结果：`nvidb job result <编号> --json`"]
        elif mod == "paper":
            main = (t.workspace.info(lid).get("paper") or {}).get("main") if paper else None
            pdf = t.workspace.pdf(lid) if paper else None
            out += [f"论文目录 `{paper}`，主文件 `{main or '?'}`，直接读" if paper else "这个项目还没有论文",
                    f"文件树：接口 `/api/lines/{x}/ws/paper/tree`；一个文件：`/api/lines/{x}/ws/paper/file?path=<相对路径>`",
                    f"编译出的 PDF：`{pdf}`" if pdf else "还没有编译好的 PDF；要编译用 paper.compile"]
        elif mod == "agents":
            out += ["代码员工、写作员工和它们的状态：接口 `/api/agents?role=coder`、`/api/agents?role=writer`",
                    f"一个员工的对话：接口 `/api/agents/coder-{x}`（pi 的）或 `/api/agents/coder-{x}/timeline`（Paseo 的），写作员工把 coder 换成 writer"]
        elif mod == "skills":
            out += ["skim 的状态和三层配置：接口 `/api/skim`；某个项目或员工算出来用哪些 skill：`/api/skim/resolve?line_id=<项目>`",
                    "配置文件：`~/.skim/skimconfig`（全局）、`server/var/projects/<项目>/.skim/config`（项目）、`~/.skim/sessions/papertown-<员工>.config`（员工）"]
        elif mod == "mcp":
            out += ["接的 MCP server、接通了没有、它们给的工具：接口 `/api/mcp`"]
        elif mod == "rag":
            out += ["馆藏统计和检索设置：接口 `/api/rag`；试检索：`/api/rag/search?q=<检索词>`；馆藏：`/api/library?q=<关键词>`"]
        return [*out, "所有项目：接口 `/api/lines`；小镇的运行状态：`/api/status`"]

    def say(self, text: str, page: dict | None) -> dict:
        """A message from the sidebar, headed by the page it was written on."""
        a = self.row()
        if not a.get("runtime"):
            raise AgentError("先启动小助手")
        p = self.set_page(page) if page else self.page
        self._close_asks(text)
        if a.get("runtime") == "paseo" and a.get("ext_id"):
            self._name(a["ext_id"], text)
        head = [x for x in (self.header(p) if p else "", self.projects(text)) if x]
        return self.town.agents.say(ID, "\n\n".join([*head, text.strip()]))

    def projects(self, text: str) -> str:
        """Where the projects you name by number stand, read just now, to go with your message."""
        seqs = list(dict.fromkeys(int(x) for x in re.findall(r"#(\d+)", text)))[:MENTIONED_MAX]
        lines = [ln for ln in (self.db.one("select id from lines where seq = ?", n) for n in seqs) if ln]
        parts = []
        for ln in lines:
            try:
                parts.append(self.town.leads.status(ln["id"]))
            except LeadError:
                continue
        return "<projects>\n你提到的项目，Papertown 刚读的进展：\n\n" + "\n\n".join(parts) + "\n</projects>" if parts else ""

    def line_id(self, line: str | None) -> str | None:
        """Resolve a named project, or use the project currently on the user's screen."""
        return self._line(line)["id"] if line else (self.page.get("line") or {}).get("id")

    def brief(self, line: str | None) -> str:
        lid = self.line_id(line)
        if not lid:
            raise ActError("说一下是哪个项目（line）")
        return self.town.brief(lid)

    def ask(self, question: str, choices: list[str], point: bool) -> dict:
        self._close_asks()
        return self.town.agents.record(ID, "ask", {"question": question.strip(), "choices": [clip(c, 80) for c in choices if str(c).strip()][:6],
                                                   "point": bool(point), "open": True})

    def _close_asks(self, answer: str = "") -> None:
        for e in self.db.q("select * from agent_events where agent_id = ? and kind = 'ask' and json_extract(data, '$.open') = 1", ID):
            self.town.agents.amend(e["id"], e["data"] | {"open": False, "answer": clip(answer, 200)})

    def show(self, target: dict) -> dict:
        """Open something for you in the console, or light up a part of the page."""
        t = {k: str(v).strip() for k, v in target.items() if k in ("mod", "line", "file", "job", "ref", "note") and v not in (None, "")}
        if t.get("mod") and t["mod"] not in MODS:
            raise ActError(f"没有这个面板：{t['mod']}（可以用 {'、'.join(MODS)}）")
        if t.get("line"):
            t["line"] = self._line(t["line"])["id"]
        if t.get("file") and not t["file"].startswith(("code:", "paper:")):
            t["file"] = "code:" + t["file"]
        if not t:
            raise ActError("要说明打开什么：mod、line、file、job 或 ref")
        self.town.bus.publish("assistant_show", target=t)
        return t

    def act(self, action: str, args: dict, why: str) -> dict:
        """An action the assistant takes: done now if it may, else a card that waits for you."""
        title, run = self._plan(action, args)
        kind, rule = self.policy(action)
        if kind == "never":
            raise ActError(f"你的工作边界不让你做这件事：{rule['text']}")
        card = {"action": action, "args": args, "why": clip(why, 300), "title": title}
        if kind == "ask":
            return self.town.agents.record(ID, "act", card | {"status": "pending", **({"rule": rule["text"]} if rule else {})})
        try:
            return self.town.agents.record(ID, "act", card | {"status": "done", "auto": True, "result": run(), "decided_at": now()})
        except (ActError, LeadError, AgentError) as e:
            self.town.agents.record(ID, "act", card | {"status": "failed", "auto": True, "result": str(e), "decided_at": now()})
            raise ActError(str(e)) from e

    def decide(self, event_id: int, allow: bool) -> dict:
        e = self.db.one("select * from agent_events where id = ? and agent_id = ? and kind = 'act'", event_id, ID)
        if not e:
            raise ActError("没有这个请求")
        d = e["data"]
        if d.get("status") != "pending":
            raise ActError("这个请求已经处理过了")
        if not allow:
            d = d | {"status": "denied", "decided_at": now()}
            note = f"用户拒绝了你请求的「{d['title']}」。"
        else:
            try:
                _, run = self._plan(d["action"], d["args"])
                d = d | {"status": "done", "result": run(), "decided_at": now()}
                note = f"用户允许了你请求的「{d['title']}」，已经执行：{d['result']}"
            except Exception as ex:  # noqa: BLE001 - whatever stopped it is what you and the assistant need to read
                d = d | {"status": "failed", "result": str(ex), "decided_at": now()}
                note = f"用户允许了你请求的「{d['title']}」，但执行失败：{ex}"
        e = self.town.agents.amend(event_id, d)
        try:
            self.town.agents.say(ID, f"<event>\n{note}\n</event>")
        except AgentError:
            pass  # it is not running any more; the card says what happened
        return e

    def _line(self, ref: object) -> dict:
        s = str(ref or "").strip().lstrip("#")
        ln = self.db.one("select id, seq, title, status from lines where id = ? or (? != '' and cast(seq as text) = ?)", s, s, s)
        if not ln:
            raise ActError(f"没有这个项目：{ref}")
        return ln

    def _plan(self, name: str, a: dict) -> tuple[str, Callable[[], str]]:
        """What an action will do, as the card says it, and the call that does it."""
        t = self.town
        if name not in ACTIONS:
            raise ActError(f"没有这个动作：{name}。能做的事见 actions")
        a = a if isinstance(a, dict) else {}
        miss = [k for k in ACTIONS[name][1].split() if not k.startswith("[") and a.get(k) in (None, "")]
        if miss:
            raise ActError(f"{name} 还缺 {'、'.join(miss)}（参数是 {ACTIONS[name][1]}）")
        if name == "answer":
            try:
                q = self.db.one("select * from reports where id = ? and kind = 'ask'", int(str(a["id"]).lstrip("#")))
            except ValueError:
                q = None
            if not q or not q["data"].get("open"):
                raise ActError(f"没有在等回答的问题 {a['id']}")
            seq, text = self.db.val("select seq from lines where id = ?", q["line_id"]), str(a["text"]).strip()
            return (f"替你回答 #{seq} 的{q['data'].get('who') or ''}「{clip(q['data']['question'], 60)}」：{clip(text, 120)}",
                    lambda: (t.leads.answer(q["id"], text, "assistant"), "已经转给它")[1])
        if name == "tell":
            ln, text = self._line(a["line"]), str(a["text"]).strip()
            role = _role(a["role"], ("lead", "coder", "writer")) if a.get("role") else "lead"
            try:
                target = t.leads.target(self.row(), role, ln["id"])
            except LeadError as e:
                raise ActError(str(e)) from e
            now_, who = _bool(a["now"]) if a.get("now") not in (None, "") else False, t.leads._who(target)

            def tell() -> str:
                t.leads.deliver(self.row(), target, text, now_)
                return f"已发给{who}" + ("" if now_ or target["status"] != "working" else "，它在忙，等它做完手上的事再交给它")
            return f"给{who}发消息：{clip(text, 160)}", tell
        if name == "idea.submit":
            text = str(a["text"]).strip()
            return f"放入一颗新 idea：{clip(text, 80)}", lambda: f"已放入，成了项目 #{t.pipeline.submit_idea(text, None)['seq']}"
        if name in ("mcp.toggle", "mcp.restart"):
            n = str(a["name"])
            if n not in {s["name"] for s in t.mcp.info()}:
                raise ActError(f"接线局里没有 MCP server「{n}」")
            if name == "mcp.restart":
                return f"重连 MCP server「{n}」", lambda: (t.mcp.restart(n), "已重连")[1]
            on = _bool(a["enabled"])
            return f"{'启用' if on else '停用'} MCP server「{n}」", lambda: (t.mcp.toggle(n, on), "已启用" if on else "已停用")[1]
        if name == "job.cancel":
            job = str(a["job"]).strip()
            if job.startswith("nvidb-") or job.isdigit():
                raise ActError("nvidb 的任务 Papertown 只读，不能在这里取消；要取消请用户自己在终端里用 nvidb job cancel")
            j = t.farm.get(job)
            if not j:
                raise ActError(f"实验农场里没有任务 {job}")
            return f"取消实验农场的任务 {job}（{j['name']}，现在{j['status']}）", lambda: f"{job} 现在是 {t.farm.cancel(job)['status']}"
        if name == "skill.toggle":
            scope, on, skill = str(a.get("scope") or "project"), _bool(a["enabled"]), str(a["name"]).strip()
            lid = self._line(a.get("line") or self.line_id(None))["id"] if scope != "global" else None
            agent = f"{_role(a.get('role'))}-{lid}" if scope == "session" else None
            where = {"global": "全局", "project": f"项目 {lid}", "session": f"员工 {agent}"}.get(scope)
            if not where:
                raise ActError("scope 要写 global、project 或 session")

            def toggle() -> str:
                t.skim.set(scope, f"skill.{skill}.enabled", "true" if on else "false", lid, agent)
                t.skim.apply_all(None if scope == "global" else lid)
                return "已" + ("打开" if on else "关掉")
            return f"在{where}这一层{'打开' if on else '关掉'} skill「{skill}」", toggle
        ln = self._line(a["line"])
        lid, tag = ln["id"], f"#{ln['seq']}「{clip(ln['title'], 30)}」"
        if name == "job.submit":
            jname, cmd = clip(a["name"], 60), str(a["command"]).strip()
            return (f"在 {tag} 提交实验农场任务「{jname}」：{clip(cmd, 160)}",
                    lambda: (lambda j: f"已提交 {j['id']}，现在{j['status']}")(t.farm.submit(lid, jname, cmd, "local", ID)))
        if name == "line.hatch":
            return f"让 {tag} 立项", lambda: f"已立项，现在是 {t.pipeline.hatch(lid)['status']}"
        if name == "line.resume":
            return f"让 {tag} 接着往下做", lambda: f"已继续，现在是 {t.pipeline.resume(lid)['status']}"
        if name == "line.adjust":
            text = str(a["text"]).strip()
            return f"调整 {tag} 的方向：{clip(text, 120)}", lambda: f"已调整，现在是 {t.pipeline.adjust(lid, text)['status']}"
        if name == "paper.compile":
            def build() -> str:
                r = t.workspace.compile(lid)
                if r.get("ok"):
                    pages = f"，{r['pages']} 页" if r.get("pages") else ""
                    return f"编译好了{pages}，用了 {r.get('seconds', 0):.1f} 秒"
                return "编译失败：" + clip(" / ".join(x for x in str(r.get("log") or "").splitlines() if x.startswith("!"))[:600] or r.get("log"), 400)
            return f"重新编译 {tag} 的论文", build
        role = _role(a["role"])
        aid, who = f"{role}-{lid}", f"{tag} 的{ROLES[role]['name']}"
        ag = t.agents.get(aid)
        if not ag or not ag.get("runtime"):
            raise ActError(f"{who}还没有启动，请用户先在「员工」面板里启动它")
        if name == "agent.brief":
            return f"给{who}发项目简报", lambda: (t.agents.say(aid, t.agents.brief(aid)), "已发出")[1]
        return f"打断{who}手上的事", lambda: (t.agents.abort(aid), "已打断")[1]

    def view(self) -> dict:
        """What the sidebar shows: the agent, the open question, the latest actions and the action list."""
        a = self.row()
        rows = self.db.q("select * from agent_events where agent_id = ? and kind in ('ask', 'act') order by id desc limit 30", ID)
        return {"agent": self.town.agents.public(a), "asks": [e for e in rows if e["kind"] == "ask" and e["data"].get("open")][:1],
                "acts": [e for e in rows if e["kind"] == "act"][:8][::-1], "actions": {k: {"what": v[0], "args": v[1]} for k, v in ACTIONS.items()}}

    def _interrupt(self, a: dict) -> None:
        if a.get("runtime") == "paseo" and a.get("ext_id") and a["status"] == "working":
            try:
                self.town.agents.abort(ID)
            except AgentError:
                pass

    def reset(self) -> dict:
        """A new conversation: Paseo's is set aside (it stays in Paseo); pi starts a new session."""
        a = self.row()
        if a.get("runtime") == "paseo":
            self._interrupt(a)
            self.town.agents.detach(ID)
        elif a.get("runtime") == "pi" and self.town.agents.alive(a):
            self.town.agents.say(ID, "/new")
        self._close_asks()
        return self.town.agents.public(self.row())

    def _names(self) -> dict[str, str]:
        try:
            return json.loads((self.dir / "conversations.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _name(self, ext_id: str, text: str) -> None:
        """The first thing asked in a conversation, as its name among the earlier ones."""
        names = self._names()
        if ext_id not in names:
            names[ext_id] = clip(text, 60)
            (self.dir / "conversations.json").write_text(json.dumps(names, ensure_ascii=False, indent=1), encoding="utf-8")

    def _mine(self) -> list[dict]:
        try:
            convs = self.town.agents.paseo.conversations()
        except PaseoError:
            return []
        return [c for c in convs if (c.get("labels") or {}).get("papertown.role") == ID]

    def history(self) -> list[dict]:
        """Its conversations in Paseo, the latest first; pi keeps its sessions to itself."""
        cur, names = self.row().get("ext_id"), self._names()
        out = [{"id": c["id"], "title": names.get(c["id"]), "model": model_label(c["provider"], c.get("model")),
                "at": c.get("last_user") or c.get("updated") or c.get("created"), "current": c["id"] == cur} for c in self._mine()]
        return sorted(out, key=lambda x: x["at"] or "", reverse=True)

    def resume(self, ext_id: str) -> dict:
        """Go back to an earlier conversation; the one open now is set aside as a new one would."""
        conv = next((c for c in self._mine() if c["id"] == ext_id), None)
        if not conv:
            raise AgentError("Paseo 里没有这段对话了")
        a = self.row()
        if a.get("ext_id") != ext_id:
            self._interrupt(a)
            self._close_asks()
            self.town.agents.attach(ID, conv)
        return self.town.agents.public(self.row())
