"""The console's assistant: an agent in the sidebar that tells you what the page in front of
you shows, read from where it comes from, and does things in the town once you allow them.
It runs the way the depot's and the press's agents do (pi in tmux, or Paseo); what is
particular to it is here:

- The page. Each message from the sidebar starts with what you are looking at: the project,
  the panel with its settings and what is open, what you pointed at and the text you had
  selected. The latest is also kept in .papertown/page.md in its directory, with where every
  part of that panel comes from (files, nvidb commands, Papertown endpoints) and the text the
  panel shows.
- Asking. It can ask you something, with choices, or ask you to point at the page.
- Showing. It can open a panel, a file or a job for you and light up a part of the page.
- Doing. It proposes actions from a fixed list (submit or cancel a farm job, hatch, resume,
  adjust, message an employee, compile a paper, switch a skill or an MCP server). Each one
  waits in the sidebar until you allow it, and what came of it is sent back to the assistant.
- Earlier conversations. A new conversation sets the Paseo one aside; the sidebar lists those
  (named by the first thing asked in each) and can go back to one.

Its tools reach the server over HTTP. Codex runs commands in a sandbox without network, so
`pt` then writes the same request as a file in the assistant's directory, which the server
watches and answers beside it.
"""

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
from pathlib import Path
from typing import TYPE_CHECKING, Callable

from .agents import ROLES, AgentError
from .db import now
from .paseo import PaseoError
from .workspace import WsError

if TYPE_CHECKING:
    from .town import Town

ID = "assistant"
MODS = {"overview": "概览", "survey": "调研", "code": "代码仓库", "exp": "实验", "data": "数据", "paper": "论文",
        "agents": "员工", "skills": "Skills", "mcp": "MCP", "rag": "图书馆"}
TEXT_MAX = 8000  # of the panel's own text
SELECTION_MAX = 2000  # of the text you had selected
REFS_MAX = 80
OPEN = urllib.request.build_opener(urllib.request.ProxyHandler({})).open  # to this server itself, never through a proxy

# What the assistant may ask to do, each run only once you allow it in the sidebar:
# name -> (what it does, its arguments, the optional ones in brackets)
ACTIONS: dict[str, tuple[str, str]] = {
    "job.submit": ("在实验农场提交一个任务：本地执行器在项目的代码目录里用 bash 跑这条命令", "line name command"),
    "job.cancel": ("取消实验农场里排着或在跑的任务（nvidb 的任务不行，Papertown 对 nvidb 只读）", "job"),
    "line.hatch": ("让孵化场里查重过了的项目立项，进造纸厂开工", "line"),
    "line.resume": ("让停下来等你的项目接着往下做", "line"),
    "line.adjust": ("按一句话调整项目的方向，再接着做", "line text"),
    "idea.submit": ("放入一颗新 idea，孵化场先查重", "text"),
    "agent.say": ("给项目的代码员工（coder）或写作员工（writer）发一条消息，它要已经启动过", "line role text"),
    "agent.brief": ("给项目的代码员工或写作员工再发一遍最新的项目简报", "line role"),
    "agent.abort": ("打断项目的代码员工或写作员工手上的事", "line role"),
    "paper.compile": ("重新编译项目的论文", "line"),
    "skill.toggle": ("在技能学堂里打开或关掉一个 skill；scope 是 global（全局）、project（项目，默认）或 session（某个员工）",
                     "name enabled [scope] [line] [role]"),
    "mcp.toggle": ("启用或停用接线局里的一个 MCP server", "name enabled"),
    "mcp.restart": ("重连接线局里的一个 MCP server", "name"),
}

# how the assistant reaches the town, by runtime
TOOLS = {
    "pi": {"page": "`papertown_page` 工具", "get": "`papertown_get` 工具（path 写接口路径）", "brief": "`papertown_brief` 工具",
           "ask": "`papertown_ask` 工具（question；choices 是给他点的选项；point 为 true 时请他在页面上点一下）",
           "show": "`papertown_show` 工具（mod、line、file、job、ref 按需要填）", "actions": "`papertown_actions` 工具",
           "do": "`papertown_do` 工具（action 是动作名，args 是它的参数，why 写为什么要做）", "net": ""},
    "paseo": {"page": "`.papertown/pt page`（或直接读这个文件）", "get": "`.papertown/pt get <接口>`", "brief": "`.papertown/pt brief [项目]`",
              "ask": "`.papertown/pt ask \"问题\" [--choice 选项]… [--point]`（--choice 是给他点的选项，--point 请他在页面上点一下）",
              "show": "`.papertown/pt show [--mod 面板] [--line 项目] [--file code:路径[:行号]] [--job 任务] [--ref 标识]`",
              "actions": "`.papertown/pt actions`", "do": "`.papertown/pt do <动作> key=value… --why \"为什么\"`",
              "net": "\n- `.papertown/pt` 直接连本机的 Papertown（{url}）；所在的沙箱不让联网时，它自动改走工作目录里的文件，不用为它申请权限。\n"},
}

GUIDE = """# Papertown · 小助手

你是 Papertown 中控屏右边侧边栏里的小助手。用户一边看页面一边问你：这一页显示的是什么、数字从哪来、任务现在怎么样了、接下来该做什么。你读页面背后的真实数据来回答；用户要你办的事，你提出请求，他点了「允许」才执行。

## 用户在看什么

- 用户每条消息开头有一段 `<page>…</page>`：在看哪个项目、哪个面板、面板上的设置和打开着的东西，以及他在页面上点了什么（「指着」）。他说「这个」「这里」，就是指着的那一项；没指着东西时，就是整个面板。
- 更详细的在 `.papertown/page.md`：这一页每块内容的数据从哪来（文件、命令、接口），页面上能亮给他看的地方，以及面板上现在显示的文字。他换页面、指东西时它会更新。用 {page} 读。
- 回答之前去读真实来源，不要只凭页面上的文字猜；回答里说一句你看的是哪里。

## 读数据

- Papertown 的接口用 {get} 读，例如 `/api/lines/<项目>`（工序、状态、产出）、`/api/jobs?line_id=<项目>`（任务）、`/api/gpus`（显卡和谁在用）、`/api/lines/<项目>/data`（实验数据）。page.md 里列了这一页用到的接口。
- 项目简报（idea、方法草案、实验、审稿意见、仓库现状）：{brief}。
- 代码和论文就是本机的文件，路径在 page.md 里，直接读。用户的仓库只读：不要改文件，也不要提交。
- 显卡和任务队列来自 nvidb：`nvidb queue status --json --no-tick`、`nvidb job show <编号> --json --no-tick`。nvidb 只读：不要提交、取消任务，也不要确认告警；用户想这么做时，把命令告诉他，让他自己在终端里跑。{net}
## 和用户来回

- 拿不准他问的是哪里，就问他：{ask}。他的回答会作为下一条消息发来，开头的 `<page>` 里有他点的东西。问完就结束这一轮，等他回答。
- 想让他看页面上的某处：{show}。可以打开一个项目的某个面板（mod：overview 概览、survey 调研、code 代码仓库、exp 实验、data 数据、paper 论文、agents 员工、skills、mcp、rag 图书馆），打开代码仓库里的文件（file：`code:路径` 或 `code:路径:行号`），打开实验面板里一个任务的详情（job），或者把页面上的一处亮出来（ref，用 page.md 里列的标识）。说到页面上具体的东西时，顺手亮给他看。

## 替用户办事

- 能做的事用 {actions} 看：提交或取消实验农场的任务、立项、继续、调整方向、放入新 idea、给项目的代码员工或写作员工发消息、编译论文、开关 skill 和 MCP server。
- 办事用 {do}。请求不会马上执行：侧边栏会弹出一张卡片，写着你要做什么、为什么，他点「允许」才执行，结果会作为一条 `<event>…</event>` 消息发给你。提完请求就结束这一轮，告诉他你请求了什么、在等他点。
- 只用这个办法改小镇里的东西，不要直接调用会改东西的接口。要改代码或论文，请对应的员工去做（agent.say）。

## 回复

- 用中文，短：先给结论，再给依据。数字带上单位和出处。
- 不知道就说不知道，并说可以去哪里查。
"""


class ActError(Exception):
    pass


def clip(s: object, n: int = 120) -> str:
    t = " ".join(str(s or "").split())
    return t if len(t) <= n else t[: n - 1] + "…"


def _role(v: object) -> str:
    r = {"coder": "coder", "代码员工": "coder", "代码": "coder", "writer": "writer", "写作员工": "writer", "写作": "writer"}.get(str(v).strip())
    if not r:
        raise ActError("role 要写 coder（代码员工）或 writer（写作员工）")
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
        self._halt = threading.Event()
        self._thread: threading.Thread | None = None

    # ---------- its row and its files ----------

    def row(self) -> dict:
        """The assistant's agent, one for the whole town (no project of its own)."""
        a = self.town.agents.get(ID)
        if a:
            return a
        import secrets
        self.dir.mkdir(parents=True, exist_ok=True)
        self.db.insert("agents", {"id": ID, "line_id": None, "role": ID, "status": "stopped", "tmux": f"pt-{ID}", "cwd": str(self.dir),
                                  "token": secrets.token_urlsafe(18), "model": None, "cost": 0, "created_at": now(), "updated_at": now()})
        return self.town.agents.get(ID)

    def guide(self, runtime: str) -> str:
        tools = TOOLS[runtime] | {"net": TOOLS[runtime]["net"].format(url=self.s.url)}
        return GUIDE.format(**tools)

    def intro(self) -> str:
        """Its first message, marked <start> so the sidebar shows it as a note rather than as yours."""
        return ("<start>\n你是 Papertown 中控屏的小助手。工作目录里的 AGENTS.md 说明了怎么看用户的页面、怎么读数据、怎么问用户、怎么替用户办事，先读一遍。"
                "读完用一两句话告诉用户你能帮什么，然后等他提问。\n</start>")

    def tools(self, d: Path) -> None:
        """Next to its `pt`: the list of actions, the page, and the folders the relay watches."""
        (d / "actions.md").write_text(self.actions_text() + "\n", encoding="utf-8")
        for sub in ("q", "a"):
            (d / sub).mkdir(exist_ok=True)
        if self.page:
            (d / "page.md").write_text(self._page_md(self.page), encoding="utf-8")

    def actions_text(self) -> str:
        out = ["能替用户做的事（每件都要他在侧边栏点「允许」才执行）：", ""]
        out += [f"- {k}（{v[1]}）：{v[0]}" for k, v in ACTIONS.items()]
        out += ["", "line 写项目的 id（line_6）或编号（#6）；job 写实验农场的任务 id（job_xxxxxxxx）。"]
        return "\n".join(out)

    # ---------- the page you are looking at ----------

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
        focus = p.get("focus") if isinstance(p.get("focus"), dict) else None
        return {
            "at": now(),
            "line": {"id": str(ln.get("id") or ""), "seq": ln.get("seq"), "title": clip(ln.get("title"), 80)} if ln.get("id") else None,
            "mod": mod, "mod_name": MODS.get(mod, clip(p.get("mod_name"), 20) or mod),
            "state": {clip(k, 20): clip(v, 160) for k, v in (p.get("state") or {}).items() if v not in (None, "", False)},
            "focus": {k: clip(focus.get(k), 400 if k == "text" else 120) for k in ("ref", "label", "where", "text") if focus.get(k)} if focus else None,
            "refs": [{"ref": clip(r.get("ref"), 80), "label": clip(r.get("label"), 80)} for r in (p.get("refs") or [])[:REFS_MAX]
                     if isinstance(r, dict) and r.get("ref")],
            "text": str(p.get("text") or "")[:TEXT_MAX],
            "selection": str(p.get("selection") or "").strip()[:SELECTION_MAX],
        }

    def header(self, p: dict) -> str:
        """The head of a message from the sidebar: where you are and what you point at."""
        ln, st = p.get("line"), " · ".join(f"{k} {v}" for k, v in (p.get("state") or {}).items())
        project = f"#{ln['seq']}「{ln['title']}」· " if ln else ""
        out = ["<page>", f"在看：{project}{p.get('mod_name') or '中控屏'}" + (f"（{st}）" if st else "")]
        if p.get("focus"):
            out.append("指着：" + _pointed(p["focus"]))
        if p.get("selection"):
            n = p["selection"].count("\n") + 1
            out.append(f"选中：「{clip(p['selection'], 120)}」" + (f"（{n} 行，全文在 page.md）" if n > 1 else ""))
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
            out += ["- 用户在页面上选中了这段文字：", "", "```text", p["selection"], "```"]
        out += ["", "## 这一页的数据从哪来", "", *[f"- {x}" for x in self._sources(p["mod"], ln["id"] if ln else None)]]
        if p["refs"]:
            out += ["", "## 页面上能亮给他看的地方（show 的 ref）", "", *[f"- `{r['ref']}` {r['label']}" for r in p["refs"]]]
        if p["text"]:
            out += ["", "## 面板上现在显示的文字（节选）", "", "```text", p["text"], "```"]
        return "\n".join(out) + "\n"

    def _place(self, line_id: str) -> list[str]:
        try:
            code, paper = self.town.workspace.root(line_id, "code"), self.town.workspace.root(line_id, "paper")
        except WsError:
            return []
        return [*(["本地项目"] if self.town.linked.of(line_id) else []), *([f"代码 {code}"] if code else []), *([f"论文 {paper}"] if paper else [])]

    def _sources(self, mod: str, lid: str | None) -> list[str]:
        """Where each part of a panel comes from, for the assistant to read it there."""
        t, x = self.town, lid or "<项目>"
        try:
            code, paper = (t.workspace.root(lid, "code"), t.workspace.root(lid, "paper")) if lid else (None, None)
        except WsError:
            code = paper = None
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
            out += [f"论文目录 `{paper}`，主文件 `{main or '?'}`，直接读" if paper else "这个项目还没有论文",
                    f"文件树：接口 `/api/lines/{x}/ws/paper/tree`；一个文件：`/api/lines/{x}/ws/paper/file?path=<相对路径>`",
                    f"编译出的 PDF：`{t.workspace.pdf(lid)}`" if lid and paper and t.workspace.pdf(lid) else "还没有编译好的 PDF；要编译用 paper.compile"]
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

    # ---------- talking ----------

    def say(self, text: str, page: dict | None) -> dict:
        """A message from the sidebar, headed by the page it was written on."""
        a = self.row()
        if not a.get("runtime"):
            raise AgentError("先启动小助手")
        p = self.set_page(page) if page else self.page
        self._close_asks(text)
        if a.get("runtime") == "paseo" and a.get("ext_id"):
            self._name(a["ext_id"], text)
        return self.town.agents.say(ID, f"{self.header(p)}\n\n{text.strip()}" if p else text)

    def brief(self, line: str | None) -> str:
        lid = self._line(line)["id"] if line else (self.page.get("line") or {}).get("id")
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

    # ---------- doing things, once you allow them ----------

    def propose(self, action: str, args: dict, why: str) -> dict:
        title, _ = self._plan(action, args)
        return self.town.agents.record(ID, "act", {"action": action, "args": args, "why": clip(why, 300), "title": title, "status": "pending"})

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
            lid = self._line(a.get("line") or (self.page.get("line") or {}).get("id"))["id"] if scope != "global" else None
            agent = f"{_role(a.get('role'))}-{lid}" if scope == "session" else None
            where = {"global": "全局", "project": f"项目 {lid}", "session": f"员工 {agent}"}.get(scope)
            if not where:
                raise ActError("scope 要写 global、project 或 session")

            def toggle() -> str:
                t.skim.set(scope, f"skill.{skill}.enabled", "true" if on else "false", lid, agent)
                t.skim.apply_all(None if scope == "global" else lid)
                return "已" + ("打开" if on else "关掉")
            return f"在{where}这一层{'打开' if on else '关掉'} skill「{skill}」", toggle
        ln = self._line(a["line"])  # the rest act on one project
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
        if name == "agent.say":
            text = str(a["text"]).strip()
            return f"给{who}发消息：{clip(text, 160)}", lambda: (t.agents.say(aid, text), "已发出")[1]
        if name == "agent.brief":
            return f"给{who}发项目简报", lambda: (t.agents.say(aid, t.agents.brief(aid)), "已发出")[1]
        return f"打断{who}手上的事", lambda: (t.agents.abort(aid), "已打断")[1]

    # ---------- what the sidebar shows ----------

    def view(self) -> dict:
        a = self.row()
        rows = self.db.q("select * from agent_events where agent_id = ? and kind in ('ask', 'act') order by id desc limit 30", ID)
        return {"agent": self.town.agents.public(a), "asks": [e for e in rows if e["kind"] == "ask" and e["data"].get("open")][:1],
                "acts": [e for e in rows if e["kind"] == "act"][:8][::-1], "actions": {k: {"what": v[0], "args": v[1]} for k, v in ACTIONS.items()}}

    def reset(self) -> dict:
        """A new conversation: Paseo's is set aside (it stays in Paseo) and the next start makes
        another; pi starts a new session of its own."""
        a = self.row()
        if a.get("runtime") == "paseo":
            if a.get("ext_id") and a["status"] == "working":
                try:
                    self.town.agents.abort(ID)
                except AgentError:
                    pass
            self.town.agents.detach(ID)
        elif a.get("runtime") == "pi" and self.town.agents.alive(a):
            self.town.agents.say(ID, "/new")
        self._close_asks()
        return self.town.agents.public(self.row())

    # ---------- earlier conversations ----------

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
        out = [{"id": c["id"], "title": names.get(c["id"]), "model": "/".join(x for x in (c["provider"], c.get("model")) if x),
                "at": c.get("last_user") or c.get("updated") or c.get("created"), "current": c["id"] == cur} for c in self._mine()]
        return sorted(out, key=lambda x: x["at"] or "", reverse=True)

    def resume(self, ext_id: str) -> dict:
        """Go back to an earlier conversation; the one open now is set aside as a new one would."""
        conv = next((c for c in self._mine() if c["id"] == ext_id), None)
        if not conv:
            raise AgentError("Paseo 里没有这段对话了")
        a = self.row()
        if a.get("ext_id") != ext_id:
            if a.get("runtime") == "paseo" and a.get("ext_id") and a["status"] == "working":
                try:
                    self.town.agents.abort(ID)
                except AgentError:
                    pass
            self._close_asks()
            self.town.agents.attach(ID, conv)
        return self.town.agents.public(self.row())

    # ---------- the relay, for a sandbox without network ----------

    def start(self) -> None:
        if self._thread:
            return
        self._halt.clear()
        self._thread = threading.Thread(target=self._watch, daemon=True, name="assistant-relay")
        self._thread.start()

    def stop(self) -> None:
        self._halt.set()
        self._thread = None

    def _watch(self) -> None:
        q = self.dir / ".papertown" / "q"
        while not self._halt.wait(0.3):
            try:
                found = sorted(q.glob("*.json")) if q.is_dir() else []
            except OSError:
                continue
            for f in found:
                threading.Thread(target=self._relay, args=(f,), daemon=True).start()

    def _relay(self, f: Path) -> None:
        """One request `pt` left as a file: sent on to the server as it would have sent it, the
        answer written beside it. Only reads and the assistant's own bridge go through."""
        try:
            req = json.loads(f.read_text(encoding="utf-8"))
            f.unlink()
        except (OSError, json.JSONDecodeError):
            return
        method, path, body = str(req.get("method") or "GET"), str(req.get("path") or ""), req.get("body")
        if not path.startswith("/api/") or method not in ("GET", "POST") or method == "POST" and not path.startswith(f"/api/bridge/{ID}/"):
            out = {"status": 400, "body": {"detail": f"不能经过这里转发：{method} {path}"}}
        else:
            out = self._fetch(method, path, body, str(req.get("token") or ""))
        ans = f.parent.parent / "a" / f.name
        try:
            tmp = ans.with_suffix(".tmp")
            tmp.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
            tmp.replace(ans)
        except OSError:
            pass

    def _fetch(self, method: str, path: str, body: object, token: str) -> dict:
        req = urllib.request.Request(self.s.url.rstrip("/") + path, method=method,
                                     data=None if body is None else json.dumps(body).encode(),
                                     headers={"content-type": "application/json", "x-papertown-token": token})
        try:
            with OPEN(req, timeout=60) as r:
                return {"status": r.status, "body": json.load(r)}
        except urllib.error.HTTPError as e:
            try:
                return {"status": e.code, "body": json.load(e)}
            except (json.JSONDecodeError, ValueError):
                return {"status": e.code, "body": {"detail": str(e)}}
        except (OSError, ValueError) as e:
            return {"status": 502, "body": {"detail": f"Papertown 没有回应：{e}"}}
