"""The agents you talk to (each project's coder, writer and lead, and the console's assistant) and the farm's monitors.
Each runs either as pi in a tmux session on a private socket (`tmux -L papertown attach -t pt-coder-line_1`),
mirrored to the server by bridge.ts, or in Paseo (paseo.py), reaching the town with `.papertown/pt`.
"""

from __future__ import annotations

import json
import os
import secrets
import shlex
import shutil
import subprocess
import threading
import time
from copy import deepcopy
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path
from typing import TYPE_CHECKING

from .db import now, read_json, write_json
from .paseo import Feed, Paseo, PaseoError
from .hosted import Hosted, RUNTIMES

if TYPE_CHECKING:
    from .town import Town

BRIDGE = Path(__file__).parent / "pi" / "bridge.ts"
PT = Path(__file__).parent / "pi" / "pt.py"
SOCKET = "papertown"
ROLES = {
    "coder": {"name": "代码员工"},
    "writer": {"name": "写作员工"},
    "monitor": {"name": "看田员"},
    "assistant": {"name": "小助手"},
    "lead": {"name": "项目负责人"},
}
PI_ROLES = ("coder", "writer")
CHAT_ROLES = (*PI_ROLES, "assistant", "lead")

# pi's built-in commands that open its terminal UI: typed into tmux rather than sent to the bridge
TUI_COMMANDS = {"settings", "scoped-models", "export", "import", "share", "bug", "changelog", "hotkeys",
                "fork", "tree", "trust", "login", "logout", "resume", "copy"}
# Paseo's lifecycle (initializing, idle, running, error, closed) and the CLI's permission state, as the room shows them
PASEO_STATUS = {"initializing": "starting", "running": "working", "idle": "idle", "closed": "idle", "error": "error", "permission": "working"}

# how an agent reaches the town, by runtime
TOOLS = {
    "pi": {"brief": "用 `papertown_project` 工具读项目简报",
           "submit": "用 `papertown_submit_job` 提交到实验农场",
           "status": "用 `papertown_job_status` 查看任务进度、结果和日志",
           "lead": "这个项目由项目负责人推进，它给你派活、提醒你（消息开头是 `<msg from=\"…项目负责人\">`），照它说的做；"
                   "做完或卡住时在回复里说清楚，它会读你的对话。"},
    "paseo": {"brief": "运行 `.papertown/pt brief` 读项目简报",
              "submit": "用 `.papertown/pt submit <名字> -- <命令>` 提交到实验农场",
              "status": "用 `.papertown/pt jobs [任务 id]` 查看任务进度、结果和日志",
              "lead": "这个项目由项目负责人推进，它给你派活、提醒你（消息开头是 `<msg from=\"…项目负责人\">`），照它说的做；"
                      "做完、卡住或要它拍板时，用 `.papertown/pt tell lead \"…\"` 告诉它。它让你交工序产出时用 `.papertown/pt output <工序> '<JSON>'`"
                      "（`.papertown/pt stage` 写着格式）。"},
}
CHECKS = {
    "pi": "论文还要过一组用代码查的硬检查（禁用词、连字符、括号、分号、图表标题、方括号区间），结果在用户的研究回路上。阻断级的规则没过时，Papertown 会给你发一张修补单（`<task>`，写着第几轮、哪条规则、哪个文件哪一行），改完用 `pt checks run` 确认清零再 `pt task <编号> done`。",
    "paseo": "论文还要过一组用代码查的硬检查（禁用词、连字符、括号、分号、图表标题、方括号区间）：用 `.papertown/pt checks` 看，没过的写着文件、行和原句；"
             "改完用 `.papertown/pt checks run` 再跑一遍，直到都通过。",
}

GUIDE = {
    "coder": """# Papertown · 代码员工

你是 Papertown 里项目 #{seq}「{title}」的代码 agent，工作目录就是这个项目的代码仓库。

- 先{brief}（idea、方法草案、已有实验）。
- 按方法草案实现一个最小可运行的版本，写测试并在本地跑通。
- 正式实验不要在前台跑：{submit}，命令在本目录用 bash 执行。
  实验脚本打印 `PROGRESS <0-100>` 汇报进度，结束时打印 `RESULT {{json}}`，或写入 `$PAPERTOWN_JOB_DIR/result.json`。
- {status}。
- {lead}
- 回复用中文，简短说明你做了什么、下一步是什么。
""",
    "writer": """# Papertown · 写作员工

你是 Papertown 里项目 #{seq}「{title}」的写作 agent，工作目录是印刷厂里这篇论文的目录。

- 先{brief}：idea、方法草案、实验结果和审稿意见。
- 论文写在 `main.tex`，参考文献在 `refs.bib`；目录里已有初稿时在它的基础上改。
- 只写有依据的内容：数字来自实验农场里跑完的任务，没有跑出来的结果不写。
- 改完用 `latexmk -pdf -interaction=nonstopmode main.tex` 编译，修掉报错。
- {checks}
- {lead}
- 回复用中文，简短说明改了哪些部分。
""",
}

LEAD_GUIDE = """# Papertown · 项目负责人

你是 Papertown 里项目 #{seq}「{title}」的负责人。这个项目由你推进：从查重、立项、方法、实验、写作、质检到出厂，八道工序都是你的事。代码由代码员工写，论文由写作员工写，你不动手改项目里的文件；员工由你启动、由你派活。Papertown 自己不调用任何模型，项目里的每一步都是你和你启动的员工做的。

## 工具（都是 `.papertown/pt`）

- `pt status`：项目现在的样子：工序、三个 agent 在做什么、最近的实验任务、等用户回答的问题、最近的汇报。
- `pt brief`：项目简报（idea、方法草案、实验、审稿意见、仓库现状）。
- `pt worker coder|writer [条数]`：员工最近的对话。
- `pt jobs [任务 id]`：实验农场里的任务和日志。
- `pt hire coder|writer`：启动代码员工或写作员工（已经在运行的不会重复启动）。它启动后先读项目简报，再用 `pt tell` 给它派活。
- `pt tell coder|writer "…" [--now]`：给员工派活或提醒它。默认等它做完手上的事再交给它，`--now` 插进它正在做的事。
- `pt stage`：八道工序的状态、归谁做、产出交没交、哪道硬卡口在阻断，以及各工序产出的格式。
- `pt stage run|done|todo <工序> ["说明"] [--pct N]`：开工或写进度、收尾、放回去重做。工序的名字是 idea、hatch、team、method、exp、write、review、ship。
- `pt output <工序> '<JSON>'`（或 `@文件.json`）：交一道工序的产出，用户在项目页和中控屏里看的就是它。
- `pt survey`：Papertown 用代码做的查重：图书馆里最接近的论文、相似度和结论。`pt library "英文关键词"`：检索图书馆。
- `pt report "…" [--key]`：给用户写一条汇报；要紧的（结论、卡住了、要他拍板的取舍）加 `--key`。
- `pt ask "问题" [--choice 选项]…`：问用户，他的回答会作为 `<answer>` 消息发给你。
- `pt rules`：你的工作边界。
- `pt card`、`pt card set '<JSON>'`：项目在「进展」页上的卡片，用户按了更新才写（见下面）。
- `pt recall "…"`：在项目里检索：卡片、汇报、实验、代码和论文，还有用户导入的以前的 agent 对话和记忆。
- `pt publish 页面.html ["标题"] [--kind report|explain]`：发布一页 HTML 给用户看，放在「进展」里这个项目的「汇报与讲解」（见「写给用户看的页面」）。
- `pt checks [run]`：项目的检查：硬检查的结果和没过的位置（`run` 是马上再查一遍），软检查和你上次的判断。
- `pt tasks`、`pt task <编号> done|blocked "…"`：研究回路上派给你的任务和硬卡口打回的修补单，和回一件任务的结果。
- `pt check <编号> pass|warn|fail "理由"`：记下一项软检查的判断。
{linked}
## 怎么干活

- 八道工序按顺序推进，每道做完用 `pt stage done <工序>` 收尾，下一道自动开工。收尾时 Papertown 会再跑一遍这道工序的硬检查，阻断级的没过就收不了：看 `pt checks`，让员工改完再收尾。做到一半时用 `pt stage run <工序> --pct 40 "做到哪了"` 写进度，用户在小镇和项目页上看得到。
  - **查重孵化（hatch）**：先 `pt survey` 看代码算出的最接近的工作，再用 `pt library` 和你自己的检索换几个说法找一找、读一读，然后 `pt output hatch` 交撞车报告（差别在哪、建议怎么调、最相近的几篇各一句说明）。相似度和结论由 Papertown 用代码算，你写的是理解。交完用 `pt report --key` 告诉用户结论。结论是「已被做过」或「需调整」时，先用 `pt ask` 问用户是调整 idea 还是照做，再收尾。
  - **立项编队（team）**：想清楚这个项目要谁，用 `pt hire coder`、`pt hire writer` 启动（写作员工可以等到要写的时候再启动），然后 `pt stage done team "为什么这样编队"`。
  - **方法设计（method）**：自己定方法，`pt output method` 交草案（题目、问题、机制、baseline、数据、指标、风险）。需要读代码或找 baseline 实现时派给代码员工。
  - **实验（exp）**：派给代码员工：写代码、用 `pt submit` 把实验提交到实验农场、结束时交回结果。跑完后你或它用 `pt output exp` 交结果表。只写真的跑出来的数字。
  - **写作排版（write）**：派给写作员工，它在论文目录里写 `main.tex` 和 `refs.bib`。
  - **质检（review）**：你来审：读稿子、对照结果表，`pt output review` 交审稿意见。要改就 `pt stage todo write "按审稿意见修改"` 放回去，再派给写作员工。
  - **出厂投稿（ship）**：`pt stage done ship` 打包，项目结束。
- 你不会一直在线。项目里有动静时（实验结束或失败、员工结束一轮、工序变了、用户回答了问题），Papertown 会发一条 `<checkin>` 给你，写着这段时间变了什么和项目现在的样子；项目停着不动时也会隔一阵来一条。收到后看一眼，需要时读员工的对话或任务日志，该催的催、该派的派、该报的报，然后结束这一轮。
- 派活时说清楚做什么、做到什么程度算完、做完用 `pt tell lead` 告诉你。员工卡住了先看它卡在哪，你能定的直接定；超出你工作边界的问用户。
- 汇报只写用户该知道的：进展的结论、出了什么问题、要他决定什么，三五句话。没有新东西就不写，不要每次巡检都汇报。要用表格、图或对比才说得清的（一批实验的结果、方案之间的取舍），写成一页 HTML 用 `pt publish 页面.html --kind report` 发布，再用 `pt report` 说一句结论，提一下页面的标题。
- 项目有一张研究回路（在「进展」的项目页上打开）：工序、硬卡口、软巡检、用户派的任务和备注都是上面的节点，用线连着，用户随时会加、会改。硬检查是 Papertown 用代码查的：论文里的禁用词和格式、查重相似度、实验交没交结果、PDF 是不是最新。一道工序的硬检查合成它的硬卡口：阻断级（默认 P0）的没过，卡口锁住下一道工序，Papertown 给这道工序的员工写一张修补单打回去，员工说做完而卡口还没放行就再打回一轮，超过轮数交给用户拍板；告警级（默认 P1）的只提醒。结果有变化会写在 `<checkin>` 里，`pt status` 写着哪道卡口在锁着；告警的你看情况派给员工去改，让它用 `pt checks` 看位置，改完再跑。软检查是要你判断的问题（实验方向、实验设计、主张有没有依据……）：到期时随 `<checkin>` 发给你，用户点了「让负责人现在查」时你会收到 `<check>`。读完项目后用 `pt check <编号> pass|warn|fail "理由"` 记下判断；不是 pass 的会自动成为一条给用户的汇报，不用再 `pt report` 一遍。用户在画布上派给你的事会作为 `<task id="…">` 发来，写着它连着哪些节点：照做（该派给员工的派出去），做完用 `pt task <编号> done "结果"` 回一句，卡住用 `blocked`，这句话也会成为给用户的汇报；直接派给员工的任务，完成或卡住时会写在你的 `<checkin>` 里。
- 项目卡片只在收到 `<card>` 消息时写：那是用户在「进展」页上按了更新。照消息里的字段写，只写读到的事实，写完这一轮就结束；平时巡检不要动卡片。
- 用户会在「进展」里这个项目的对话、或者中控屏里直接和你说话（不带标签的消息就是他说的）：是问题就读项目回答（需要时 `pt recall`），要用表格、图或对比才说得清的，写成一页 HTML 用 `pt publish 页面.html --kind explain` 发布，再在回复里说一句结论和页面的标题；是要你办的事，在工作边界内办或派出去，再告诉他做了什么。不要动卡片。
- 小助手是用户的代理人，它发来的消息（开头是 `<msg from="小助手">`）就是用户的意思：照办，办完用 `pt report` 回一句。员工发来的消息开头是 `<msg from="…代码员工">` 这样。
- 回复用中文，短。
{pages}"""
PAGE_GUIDE = """
## 写给用户看的页面

用户在网页上看你写的 HTML：在「进展」里这个项目的「汇报与讲解」，也能全屏拿来演示。

- 一个 `.html` 文件就是一整页：CSS 和 JS 都写在页面里，图用 HTML 和 CSS 画，复杂的用内联 SVG（或 canvas、data: URI 的图片）。页面在沙箱里显示：不能联网，不能加载外部的脚本、样式、字体和图片，也读不到 Papertown 的接口，所以要用的数据直接写进页面。
- 页面是一篇从上往下读的文档，内容多了就往下滚动：不是幻灯片，不要垂直居中，不要做成一屏一屏，不要用 `100vh`。第一段直接写结论（不重复标题，标题在页面外面已经显示了），下面按小节往下排，最后一行小字写出处（文件路径、任务 id、提交）。只写读到的事实和数字。
- 要紧凑：直接写 `h2`、`p`、`ul`、`table`，Papertown 给了紧凑的默认样式（字号、间距、表格、内容宽度），不要自己放大字号和留白，不要用大卡片。同一组数字不要既做成卡片又画图又列表。
- 图要小而简单：一般不高过 200px；能并进表格就并进去，比如每行一根从 0 开始的细条，数字标在条的末端；数字都标出来了就不要坐标轴、网格线和图例；柱子不从中间截断；只用一种强调色，文字用正文颜色；SVG 缩放时里面的字也跟着变小，放到手机上要还看得清。
- `<a data-pt-file="src/train.py:42">`、`<a data-pt-job="任务 id">`、`<a data-pt-page="页面 id">` 在 Papertown 里打开那个文件、任务或页面；普通链接在新标签页打开。
- 页面里已经有 Papertown 的配色和字体，可以直接用：`var(--pt-bg)`、`--pt-panel`、`--pt-ink`、`--pt-muted`、`--pt-line`、`--pt-brand`、`--pt-ok`、`--pt-warn`、`--pt-bad`，字体 `--pt-font`、`--pt-head`、`--pt-mono`。背景、正文颜色和边距已经设好。
- 要在手机上也能看：宽度自适应，列标题写短，不要让它把别的列挤没；确实宽的表放进能横向滚动的容器里。
- 标题写在 `<title>` 里（没写就用第一个 `<h1>`）。页面写好先存成文件再发布，同一件事改了就再发一页新的。
"""

LEAD_LINKED = """
这个项目是从本机接入的：代码在 `{code}`，论文在 `{paper}`。你可以读这两个目录、看 `git status` 和 `git log`，但不要改文件，也不要提交。员工的工作目录就是这两个仓库，所以 `pt hire` 会先问用户，他同意后 Papertown 替你启动。项目已经在进行中，先弄清它走到了哪一步，不要从头重做。
"""

# for a linked repository, which Papertown does not write into: the guide goes with the brief
LINKED_GUIDE = {
    "coder": """# Papertown · 代码员工

你是 Papertown 里项目 #{seq}「{title}」的代码 agent。这个项目是从本机接入的：工作目录 `{code}` 就是用户自己的代码仓库，改动都是真的。

- 项目简报附在这份说明后面，里面有仓库现状和最近的提交；以后想看最新的，{brief}。
- 动手前先看 `git status` 和最近的提交，弄清楚做到哪一步了。只改和任务有关的文件，不要动用户还没提交的改动；commit、push 之前先问用户。
- 要 GPU 或要跑很久的实验，用用户的 nvidb 队列提交（`nvidb job submit`，写清 `--vram` 和 `--note`），不要用 ssh 直接起任务。实验农场按工作目录和任务名认出这个项目的任务。
- {lead}
- 回复用中文，简短说明你做了什么、下一步是什么。
""",
    "writer": """# Papertown · 写作员工

你是 Papertown 里项目 #{seq}「{title}」的写作 agent。这个项目是从本机接入的：工作目录 `{paper}` 就是用户自己的论文仓库（LaTeX），改动都是真的。

- 项目简报附在这份说明后面，里面有论文的章节和仓库现状；以后想看最新的，{brief}。
- 主文件是 `{main}`，章节可能在它 `\\input` 的文件里，参考文献在仓库里的 .bib 文件。在已有内容上改，不要换模板、不要重排结构。
- 动手前先看 `git status`。只改和任务有关的文件，不要动用户还没提交的改动；commit、push 之前先问用户。
- 只写有依据的内容：数字和结论来自代码仓库 `{code}` 里的实验结果，找不到依据的地方留 TODO，不要编。
- 需要编译时用 `latexmk -pdf -interaction=nonstopmode {main}`，编译产物不要提交。
- {checks}
- {lead}
- 回复用中文，简短说明改了哪些部分。
""",
}
LINKED_BRIEF = {
    "pi": "用 `papertown_project` 工具读",
    "paseo": "运行 `.papertown/pt brief`（它要连本机的 Papertown 服务，在 Codex 这类不开网络的沙箱里会被拦下；这一步不是必需的，被拦下就跳过）",
}


class AgentError(Exception):
    pass


def _which(name: str, explicit: str = "") -> str | None:
    if explicit:
        return explicit if Path(explicit).exists() else shutil.which(explicit)
    for d in os.environ.get("PATH", "").split(os.pathsep):
        if "cmux-cli-shims" in d:  # terminal wrappers that re-exec the real binary
            continue
        p = Path(d) / name
        if p.is_file() and os.access(p, os.X_OK):
            return str(p)
    extra = [Path("/opt/homebrew/bin"), Path("/usr/local/bin")]
    extra += sorted(Path.home().glob(".nvm/versions/node/*/bin"), key=lambda p: [int(x) for x in p.parent.name.lstrip("v").split(".") if x.isdigit()])[::-1]
    for d in extra:
        p = d / name
        if p.is_file() and os.access(p, os.X_OK):
            return str(p)
    return None


def model_label(provider: str | None, model: str | None) -> str:
    return "/".join(x for x in (provider, model) if x)


def _attach(session: str, socket: str = SOCKET) -> str:
    return shlex.join(["tmux", "-L", socket, "attach", "-t", session])


def _serialized(fn):
    """Keep session changes, sends and queue delivery in one order."""
    @wraps(fn)
    def call(self, *args, **kwargs):
        with self._delivery_lock:
            return fn(self, *args, **kwargs)
    return call


def _session_change(fn):
    """Take the canvas lock first, then the delivery lock: whatever may start pi or build a brief reads the canvas, and
    nothing that holds the delivery lock may wait for the canvas lock."""
    serialized = _serialized(fn)
    @wraps(fn)
    def call(self, *args, **kwargs):
        with self.town.canvas._lock:
            return serialized(self, *args, **kwargs)
    return call


class Agents:
    def __init__(self, town: "Town"):
        self.town = town
        self.db = town.db
        self.s = town.s
        self.pi = _which("pi", self.s.pi_bin)
        self.tmux = _which("tmux", self.s.tmux_bin)
        self.paseo = Paseo(self.s.paseo_bin, self.s.paseo_url, self.s.paseo_host, self.s.node_bin)
        self._inbox: dict[str, list[dict]] = {}
        self._state: dict[str, dict] = {}  # what each pi's bridge last reported: model, thinking, session
        self._lock = threading.Lock()
        self._delivery_lock = threading.RLock()
        self._versions: dict[str, int] = {}
        self._seq = 0
        self._watch_thread: threading.Thread | None = None
        self._halt = threading.Event()
        self._paseo_up: bool | None = None  # whether the Paseo daemon answered when the watcher last looked
        self._paseo_note = ""
        self._snapshots: dict[str, dict] = {}
        self._doing: dict[str, dict] = {}
        self._says: dict[str, dict] = {}
        self._buckets: dict[str, tuple[tuple, str]] = {}
        self._turns: dict[str, str] = {}
        self._watch_lock = threading.RLock()
        self._feed: Feed | None = None
        self.hosted = Hosted(self)

    def available(self) -> dict:
        missing = [n for n, p in (("pi", self.pi), ("tmux", self.tmux)) if not p]
        return {"pi": self.pi, "tmux": self.tmux, "ok": not missing,
                "note": f"本机没有找到 {' 和 '.join(missing)}" if missing else "pi 会用它自己的模型设置和登录"}

    def _pi_argv(self) -> list[str]:
        """pi is a node script: run it with the node next to it, so tmux needs no PATH setup."""
        real = Path(os.path.realpath(self.pi))
        node = Path(self.pi).parent / "node"
        if real.suffix in (".js", ".mjs") and node.exists():
            return [str(node), str(real)]
        return [self.pi]

    def get(self, agent_id: str) -> dict | None:
        return self.db.one("select * from agents where id = ?", agent_id)

    def down(self, a: dict | None) -> str:
        """Why a Paseo agent cannot be reached now (its daemon is not running, or Paseo is not installed); empty when it can,
        or when the agent is not in Paseo."""
        if not a or a.get("runtime") != "paseo":
            return ""
        if self._paseo_up is False:
            return self._paseo_note or "连不上 Paseo"
        if self._feed and self._feed.live:
            return ""
        try:
            st = self.paseo.status()
        except PaseoError as e:
            return str(e)
        return "" if st["ok"] else st["note"] or "连不上 Paseo"

    def shown(self, a: dict) -> str:
        """The status to show: what was last heard from the agent, or "offline" while Paseo cannot be reached (the
        stored status is kept, and comes back once Paseo does)."""
        return "offline" if self.down(a) else a["status"]

    def public(self, a: dict | None) -> dict | None:
        if not a:
            return None
        out = {k: v for k, v in a.items() if k != "token"}
        out["status"], out["down"] = self.shown(a), self.down(a) or None
        out["runtime"] = rt = a.get("runtime") or "pi"
        out["started"] = bool(a.get("runtime"))
        out["attach"] = _attach(a["tmux"], self.s.tmux_socket) if rt == "pi" and a.get("tmux") else None
        out["web"] = self.paseo.url(a["ext_id"]) if rt == "paseo" and a.get("ext_id") and not out["down"] else None
        out["state"] = self._state.get(a["id"]) if rt == "pi" else None
        out["name"] = ROLES[a["role"]]["name"]
        out["last"] = self.db.one("select * from agent_events where agent_id = ? and kind in ('assistant', 'note', 'user') order by id desc limit 1", a["id"])
        if rt in RUNTIMES:
            out["term"], out["attach"] = self.hosted.public(a), self.hosted.attach(a)
        else:
            out["term"] = None
        out["watch"] = self.watch_of(a)
        out["task"] = None
        if a.get("node_id") and a.get("line_id"):
            # Read the atomic canvas file directly. Publishing must not acquire the canvas lock or migrate it.
            canvas = read_json(self.town.canvas._path(a["line_id"]), {})
            task = next((n for n in canvas.get("nodes", []) if n.get("id") == a["node_id"] and n.get("kind") == "task"), None)
            if task:
                out["task"] = {k: task.get(k) for k in ("id", "title", "status")}
        return out

    @staticmethod
    def _after(at: str | None, seen: str | None) -> bool:
        """Compare instants rather than ISO spellings with different offsets or precision."""
        if not at:
            return False
        if not seen:
            return True
        return datetime.fromisoformat(at.replace("Z", "+00:00")) > datetime.fromisoformat(seen.replace("Z", "+00:00"))

    def watch_of(self, a: dict) -> dict:
        """Combine lifecycle, attention and local questions into the shared watch contract."""
        if a.get("runtime") in RUNTIMES:
            return self.hosted.watch_of(a)
        ext = a.get("ext_id")
        with self._watch_lock:
            snap = self._snapshots.get(ext, {})
            doing = self._doing.get(ext, {}).get("doing")
            say = self._says.get(ext)
        permissions = [{k: p.get(k) for k in ("id", "name", "title", "arg", "kind")} for p in snap.get("permissions", [])]
        asks = self.db.q("select * from reports where agent_id = ? and kind = 'ask' and json_extract(data, '$.open') = 1 order by id", a["id"])
        queued = self.db.val("select count(*) from agent_events where agent_id = ? and kind = 'user' and json_extract(data, '$.held') = 1", a["id"])
        turn = snap.get("turn_started") if a.get("runtime") == "paseo" else self._turns.get(a["id"])
        finished = snap.get("attention_at") if snap.get("attention") and snap.get("attention_reason") == "finished" else None
        if a.get("runtime") != "paseo":
            last = self.db.one("select * from agent_events where agent_id = ? and kind = 'assistant' order by id desc limit 1", a["id"])
            finished = last["ts"] if last else None
            say = {"kind": "say", "text": (last["data"].get("text") or "")[:200]} if last else None
            tool = self.db.one("select * from agent_events t where agent_id = ? and kind = 'tool' and not exists"
                               " (select 1 from agent_events e where e.agent_id = t.agent_id and e.kind = 'tool_end'"
                               " and e.id > t.id and json_extract(e.data, '$.id') = json_extract(t.data, '$.id')) order by id desc limit 1", a["id"])
            if tool:
                args = tool["data"].get("args") or {}
                arg = next((args[k] for k in ("command", "path", "filePath", "query", "url") if args.get(k)), "") if isinstance(args, dict) else args
                doing = {"kind": "tool", "text": f"{tool['data'].get('name') or ''} {arg}".strip()}
        unread = a["status"] == "idle" and self._after(finished, a.get("seen_at"))
        bucket, why, since = "idle", None, a["updated_at"]
        if not a.get("runtime") or a["status"] in ("stopped", "offline") or (a.get("runtime") == "paseo" and (not ext or self.down(a))):
            bucket, unread = "off", False
        elif permissions:
            bucket, why = "needs", "question" if permissions[0]["kind"] in ("question", "plan") else "permission"
            since = snap.get("attention_at") or since
        elif asks:
            bucket, why, since = "needs", "ask", asks[0]["ts"]
        elif a["status"] == "error":
            bucket, why = "failed", "error"
        elif unread:
            bucket, why, since = "review", "finished", finished
        elif a["status"] in ("working", "starting"):
            bucket, since = "working", turn or since
        if bucket == "needs" and permissions:
            p = permissions[0]
            doing = {"kind": why, "text": " ".join(str(x) for x in (p["title"] or p["name"], p["arg"]) if x)[:200]}
        elif bucket == "needs" and asks:
            doing = {"kind": "ask", "text": asks[0]["data"]["question"][:200]}
        elif bucket != "working" or not doing:
            doing = say
        key = (ext, a.get("runtime"), bucket, why)
        with self._watch_lock:
            previous = self._buckets.get(a["id"])
            if previous and previous[0] == key:
                since = previous[1]
            elif previous and bucket in ("off", "idle"):
                since = now()
            self._buckets[a["id"]] = (key, since)
        return {"bucket": bucket, "why": why, "since": since, "turn": turn if a["status"] in ("working", "starting") else None,
                "doing": doing, "queued": queued, "unread": unread, "permissions": permissions, "asks": asks}

    def seen(self, agent_id: str) -> dict:
        if not self.get(agent_id):
            raise AgentError("没有这个员工")
        a = self.get(agent_id)
        if a.get("runtime") in RUNTIMES:
            self.hosted.seen(a)
        self.db.update("agents", {"id": agent_id}, seen_at=datetime.now(timezone.utc).isoformat())
        self._publish(agent_id)
        return self.public(self.get(agent_id))

    def overview(self) -> dict:
        """Group started agents and unowned conversations by project, including during an outage."""
        try:
            status = self.paseo.status()
            conversations = self.paseo.conversations() if status["ok"] else []
        except PaseoError as e:
            status, conversations = {"ok": False, "note": str(e)}, []
        self._paseo_up, self._paseo_note = status["ok"], status.get("note") or ""
        rows = self.db.q("select * from agents")
        counts = dict.fromkeys(("needs", "failed", "review", "working", "idle", "off"), 0)
        lines = self.db.q("select id, seq, title, status, stage from lines where status != 'dropped' order by seq desc")
        terminals, others = self.town.terminals.grouped(lines, rows)
        for terminal in [*others, *(t for group in terminals.values() for t in group)]:
            counts[terminal["watch"]["bucket"]] += 1
        groups = []
        attached = {a["ext_id"] for a in rows if a.get("ext_id")}
        for line in [None, *lines]:
            lid = line["id"] if line else None
            agents = [self.public(a) for a in rows if a["line_id"] == lid and a.get("runtime")]
            for a in agents:
                counts[a["watch"]["bucket"]] += 1
            agents.sort(key=lambda a: a["watch"]["since"] or "", reverse=True)
            agents.sort(key=lambda a: list(counts).index(a["watch"]["bucket"]))
            roots = [Path(a["cwd"]).resolve() for a in rows if lid and a["line_id"] == lid and a.get("cwd")]
            loose = []
            for conv in conversations:
                labels = conv.get("labels") or {}
                if not lid or conv["id"] in attached or labels.get("papertown.agent") or labels.get("papertown.role") == "assistant" or not conv.get("cwd"):
                    continue
                if any(Path(conv["cwd"]).resolve().is_relative_to(root) for root in roots):
                    loose.append({k: conv.get(k) for k in ("id", "title", "provider", "model", "status", "cwd", "updated")}
                                 | {"status": PASEO_STATUS.get(conv.get("status"), conv.get("status"))})
            group_terminals = terminals.get(lid, [])
            if agents or loose or group_terminals:
                groups.append({"line": line, "agents": agents, "loose": loose, "terminals": group_terminals})
        return {"paseo": {"ok": status["ok"], "note": self._paseo_note, "live": bool(self._feed and self._feed.live)},
                "herdr": self.town.terminals.status(), "counts": counts, "groups": groups, "others": others}

    def ensure(self, line_id: str, role: str, node_id: str | None = None) -> dict:
        if role not in ROLES or role == "assistant":
            raise AgentError(f"没有这个岗位：{role}")
        line = self.db.one("select * from lines where id = ?", line_id)
        if not line:
            raise AgentError("没有这个项目")
        agent_id = f"node-{line_id}-{node_id}" if node_id else f"{role}-{line_id}"
        a = self.get(agent_id)
        if a:
            if node_id and a["role"] != role and not a["runtime"]:
                self.db.update("agents", {"id": agent_id}, role=role, cwd=str(self._workdir(line_id, role)))
                return self.get(agent_id)
            return a
        cwd = self._workdir(line_id, role)
        self.db.insert("agents", {"id": agent_id, "line_id": line_id, "role": role, "node_id": node_id, "status": "stopped" if role in CHAT_ROLES else "watching",
                                  "tmux": f"pt-{agent_id}" if role in PI_ROLES else None, "cwd": str(cwd) if cwd else None,
                                  "token": secrets.token_urlsafe(18), "model": None, "cost": 0, "created_at": now(), "updated_at": now()})
        self._publish(agent_id)
        return self.get(agent_id)

    def _workdir(self, line_id: str | None, role: str) -> Path | None:
        if role == "assistant":
            return self.town.assistant.dir
        if role == "lead":  # always Papertown's own directory: it reads the project, it does not write it
            d = self.s.projects_dir / line_id / "lead"
            d.mkdir(parents=True, exist_ok=True)
            return d
        linked = self.town.linked.workdir(line_id, role)
        if linked:
            return linked
        if role == "coder":
            d = self.s.projects_dir / line_id / "code"
        elif role == "writer":
            d = self.town.press.dir(line_id)
        else:
            return None
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _home(self, line_id: str | None, role: str) -> Path:
        """Where Papertown keeps an agent's guide and pt: its working directory, unless that is a linked repository."""
        if role != "assistant" and self.town.linked.workdir(line_id, role):
            d = self.s.projects_dir / line_id / role
            d.mkdir(parents=True, exist_ok=True)
            return d
        return self._workdir(line_id, role)

    def home(self, a: dict) -> Path:
        """Node sessions have their own credentials and guide, even when they share project files."""
        if not a.get("node_id"):
            return self._home(a["line_id"], a["role"])
        path = self.s.projects_dir / a["line_id"] / "agents" / a["node_id"]
        path.mkdir(parents=True, exist_ok=True)
        return path

    def roster(self, role: str) -> list[dict]:
        """Every project with its agent for this role (None until one is created)."""
        lines = self.db.q("select id, seq, title, status, stage from lines where status != 'dropped' order by seq desc")
        agents = {a["line_id"]: a for a in self.db.q("select * from agents where role = ? and node_id is null", role)}
        return [{"line": ln, "agent": self.public(agents.get(ln["id"]))} for ln in lines]

    def _set(self, agent_id: str, **fields) -> None:
        self.db.update("agents", {"id": agent_id}, updated_at=now(), **fields)
        self._versions[agent_id] = self._versions.get(agent_id, 0) + 1
        self._publish(agent_id)

    def _publish(self, agent_id: str) -> None:
        self.town.bus.publish("agent", agent=self.public(self.get(agent_id)))

    def record(self, agent_id: str, kind: str, data: dict) -> dict:
        # Replies and read markers can arrive within the same second.
        row = {"agent_id": agent_id, "ts": datetime.now(timezone.utc).isoformat(), "kind": kind, "data": data}
        row["id"] = self.db.insert("agent_events", row)
        self.town.bus.publish("agent_event", event=row)
        return row

    def amend(self, event_id: int, data: dict) -> dict:
        self.db.update("agent_events", {"id": event_id}, data=data)
        row = self.db.one("select * from agent_events where id = ?", event_id)
        self.town.bus.publish("agent_event", event=row)
        return row

    def detach(self, agent_id: str) -> None:
        """Set an agent's Paseo conversation aside (it stays in Paseo); the next start makes another."""
        self._set(agent_id, runtime=None, ext_id=None, session_id=None, status="stopped", model=None)

    def attach(self, agent_id: str, conv: dict) -> None:
        """Take a Paseo conversation (back) as the agent's own."""
        self._set(agent_id, runtime="paseo", ext_id=conv["id"], model=model_label(conv["provider"], conv.get("model")),
                  cwd=conv["cwd"], workspace_id=conv.get("workspace_id"), status=PASEO_STATUS.get(conv["status"], "error"))
        self._remember_session(self.get(agent_id), conv)
        self.watch()

    def _chat(self, agent_id: str) -> dict:
        a = self.get(agent_id)
        if not a or a["role"] not in CHAT_ROLES:
            raise AgentError("这个员工不能对话")
        return a

    def _own(self, agent_id: str) -> list[dict]:
        """The agent's conversations in Paseo, by the label it created or imported them with."""
        try:
            convs = self.paseo.conversations()
        except PaseoError as e:
            raise AgentError(str(e)) from e
        return [c for c in convs if (c.get("labels") or {}).get("papertown.agent") == agent_id]

    def _titles(self, a: dict) -> Path:
        return self.home(a) / "conversations.json"

    def title(self, agent_id: str, text: str) -> None:
        """The first thing the user said in the agent's Paseo conversation, as its name among the others."""
        a = self.get(agent_id)
        if not a or a.get("runtime") != "paseo" or not a.get("ext_id"):
            return
        path, t = self._titles(a), " ".join(text.split())
        with self._lock:
            names = read_json(path, {})
            if a["ext_id"] not in names:
                names[a["ext_id"]] = t if len(t) <= 60 else t[:59] + "…"
                write_json(path, names)

    def conversations(self, agent_id: str) -> list[dict]:
        """The agent's conversations in Paseo, the latest first; pi keeps its sessions to itself."""
        a = self._chat(agent_id)
        names = read_json(self._titles(a), {})
        out = [{"id": c["id"], "title": names.get(c["id"]), "model": model_label(c["provider"], c.get("model")),
                "at": c.get("last_user") or c.get("updated") or c.get("created"), "current": c["id"] == a.get("ext_id")}
               for c in self._own(agent_id)]
        return sorted(out, key=lambda x: x["at"] or "", reverse=True)

    def _interrupt(self, a: dict) -> None:
        if a.get("runtime") == "paseo" and a.get("ext_id") and a["status"] == "working":
            self.abort(a["id"])

    def _switchable(self, a: dict) -> None:
        if a.get("node_id"):
            raise AgentError("节点使用固定的 Paseo 会话。要换会话，请创建另一个任务节点")
        if self.db.val("select 1 from agent_events where agent_id = ? and json_extract(data, '$.held') = 1", a["id"]):
            raise AgentError("还有排队的消息，处理完后才能切换对话")
        if a.get("line_id"):
            from .canvas import CanvasError
            try:
                active = self.town.canvas.active_for(a)
            except CanvasError as e:
                raise AgentError(str(e)) from e
            if active:
                raise AgentError("还有已派发的任务，交回结果或重新打开任务后才能切换对话")

    @_session_change
    def fresh(self, agent_id: str) -> dict:
        """A new conversation. Paseo's is set aside (it stays in Paseo): the assistant then waits for a model to be
        picked, the others start another at once on the same model, so a lead keeps supervising. pi starts a new session."""
        a = self._chat(agent_id)
        self._switchable(a)
        if a.get("runtime") in RUNTIMES:
            raise AgentError("终端员工请关闭终端后接着会话启动")
        if a.get("runtime") == "paseo":
            conv = next((c for c in self._own(agent_id) if c["id"] == a.get("ext_id")), None)
            self._interrupt(a)
            if a["role"] != "assistant":
                provider, _, model = (a.get("model") or "").partition("/")  # if it is gone from Paseo: the model it was on
                if conv:
                    provider, model = conv["provider"], conv.get("model")
                return self._start_paseo(a | {"ext_id": None}, provider or None, model or None, (conv or {}).get("thinking"))
            self.detach(agent_id)
        elif a.get("runtime") == "pi" and self.alive(a):
            self.say(agent_id, "/new")
        return self.public(self.get(agent_id))

    @_session_change
    def resume(self, agent_id: str, ext_id: str) -> dict:
        """Go back to one of the agent's earlier conversations; the one open now is set aside as a new one would."""
        a = self._chat(agent_id)
        if a.get("ext_id") == ext_id:
            return self.public(a)
        self._switchable(a)
        conv = next((c for c in self._own(agent_id) if c["id"] == ext_id), None)
        if not conv:
            raise AgentError("Paseo 里没有这段对话了")
        if not conv.get("cwd"):
            raise AgentError("这段 Paseo 对话没有工作目录，无法切换")
        if a.get("ext_id") != ext_id:
            if a.get("runtime") in RUNTIMES:
                self.hosted.close(agent_id)
            self._interrupt(a)
            self.attach(agent_id, conv)
        return self.public(self.get(agent_id))

    def events(self, agent_id: str, after: int = 0, limit: int = 400) -> list[dict]:
        rows = self.db.q("select * from agent_events where agent_id = ? and id > ? order by id desc limit ?", agent_id, after, limit)
        return rows[::-1]

    def _tmux(self, *args: str, input: str | None = None) -> subprocess.CompletedProcess:
        # own tmux server: ~/.tmux.conf plus the extended keys pi asks for
        conf = self.s.data_dir / "tmux.conf"
        if not conf.exists():
            conf.write_text(("source-file -q ~/.tmux.conf\n" if self.s.tmux_socket == SOCKET else "") + "set -g extended-keys on\nset -g extended-keys-format csi-u\n", encoding="utf-8")
        return subprocess.run([self.tmux, "-L", self.s.tmux_socket, "-f", str(conf), *args], input=input, capture_output=True, text=True, timeout=10)

    def alive(self, a: dict) -> bool:
        if a.get("runtime") in RUNTIMES:
            return self.hosted.backends[a["runtime"]].alive(a["term"]["handle"])
        return bool(self.tmux and a.get("tmux")) and self._tmux("has-session", "-t", a["tmux"]).returncode == 0

    def _guide(self, a: dict, runtime: str) -> str:
        """Write the role's guide to the agent's home (never into a linked repository) and return it."""
        runtime = "paseo" if runtime in RUNTIMES else runtime
        cwd = Path(a["cwd"])
        cwd.mkdir(parents=True, exist_ok=True)
        text = self._guide_text(a, runtime)
        home = self.home(a)
        (home / "AGENTS.md").write_text(text, encoding="utf-8")
        if runtime == "paseo":
            if home == cwd:
                (cwd / "CLAUDE.md").write_text(text, encoding="utf-8")
            self._tools(a)
        return text

    def _guide_text(self, a: dict, runtime: str) -> str:
        """The role's guide, ending with the agent's work boundaries."""
        runtime = "paseo" if runtime in RUNTIMES else runtime
        bounds = self.town.bounds.section(a["role"], a["line_id"], ".papertown/pt" if runtime == "paseo" else None)
        if a["role"] == "assistant":
            return self.town.assistant.guide(runtime) + bounds
        line = self.db.one("select seq, title from lines where id = ?", a["line_id"])
        info = self.town.linked.summary(a["line_id"])
        code, paper = ((info or {}).get("code") or {}), ((info or {}).get("paper") or {})
        where = {"code": code.get("path") or "（没有接代码仓库）", "paper": paper.get("path") or "（没有接论文仓库）"}
        if a["role"] == "lead":
            return LEAD_GUIDE.format(seq=line["seq"], title=line["title"], linked=LEAD_LINKED.format(**where) if info else "", pages=PAGE_GUIDE) + bounds
        if not info:
            return GUIDE[a["role"]].format(seq=line["seq"], title=line["title"], checks=CHECKS[runtime], **TOOLS[runtime]) + bounds
        return LINKED_GUIDE[a["role"]].format(seq=line["seq"], title=line["title"], brief=LINKED_BRIEF[runtime], lead=TOOLS[runtime]["lead"],
                                              checks=CHECKS[runtime], main=paper.get("main") or "main.tex", **where) + bounds

    def renew(self, agent_id: str) -> None:
        """Write a started agent's guide again, after its rules changed."""
        a = self.get(agent_id)
        if a and a.get("runtime") and a.get("cwd"):
            self._guide(a, a["runtime"])

    def pt(self, a: dict) -> Path:
        """A Paseo agent's `pt` by full path, since an imported conversation works elsewhere."""
        return self.home(a) / ".papertown" / "pt"

    def _linked_intro(self, a: dict, runtime: str) -> str:
        """A linked project's first message: the guide, then the brief."""
        guide = self._guide_text(a, runtime)
        if runtime == "paseo":
            guide = guide.replace(".papertown/pt", str(self._tools(a)))
        return guide + "\n\n这是项目简报，先读一遍，再说说你打算怎么开始：\n\n" + self.town.brief(a["line_id"], a["role"])

    def _tools(self, a: dict) -> Path:
        """Write `.papertown/pt` and its link.json (who it speaks for, for a shell without PAPERTOWN_* env); returns pt."""
        tools = self.home(a) / ".papertown"
        tools.mkdir(parents=True, exist_ok=True)
        for sub in ("q", "a"):  # requests by file, for a sandbox without network (relay.py)
            (tools / sub).mkdir(exist_ok=True)
        shutil.copyfile(PT, tools / "pt")
        (tools / "pt").chmod(0o755)
        link = tools / "link.json"
        write_json(link, {"url": self.s.url, "agent": a["id"], "token": a["token"]}, mode=0o600)
        if a["role"] == "assistant":
            self.town.assistant.tools(tools)
        return tools / "pt"

    def start(self, agent_id: str, runtime: str | None = None, provider: str | None = None,
              model: str | None = None, thinking: str | None = None) -> dict:
        """A Paseo start reads its brief (and through it the canvas) first, then holds only the delivery lock while
        Paseo creates the session, so canvases elsewhere are not kept waiting on Paseo's CLI. A pi start keeps the
        canvas lock throughout: its bridge reads gates as it comes up."""
        a = self.get(agent_id)
        if a and a["role"] in CHAT_ROLES and (runtime or a.get("runtime")) == "paseo" and not a.get("ext_id") and a.get("runtime") not in RUNTIMES:
            intro = self._paseo_intro(a)
            with self._delivery_lock:
                return self._start_paseo(self.get(agent_id), provider, model, thinking, intro)
        return self._start_held(agent_id, runtime, provider, model, thinking)

    @_session_change
    def _start_held(self, agent_id: str, runtime: str | None = None, provider: str | None = None,
                    model: str | None = None, thinking: str | None = None) -> dict:
        a = self.get(agent_id)
        if not a or a["role"] not in CHAT_ROLES:
            raise AgentError("这个员工不能对话")
        runtime = runtime or a.get("runtime") or (self.town.paseo_models.runtime() if a["role"] == "lead" else "pi")
        if runtime not in ("pi", "paseo", *RUNTIMES):
            raise AgentError("没有这种运行方式")
        if runtime in RUNTIMES:
            if a.get("runtime") == "paseo" and a.get("ext_id"):
                lead_off = a["role"] == "lead" and a.get("line_id") and not self.town.leads.settings(a["line_id"])["on"]
                if a["status"] == "stopped" or self.down(a) or lead_off:
                    self.detach(agent_id)
                    a = self.get(agent_id)
                else:
                    raise AgentError("请先结束当前 Paseo 会话后再切换运行方式")
            if a.get("runtime") == "pi" and self.alive(a):
                raise AgentError("请先关闭 pi 会话后再切换运行方式")
            return self.hosted.start(a, runtime, provider, model, thinking)
        if a.get("runtime") in RUNTIMES:
            self.hosted.close(agent_id)
        if runtime == "paseo":
            if a.get("runtime") == "paseo" and a.get("ext_id") and a["status"] == "stopped":
                self.detach(agent_id)
                a = self.get(agent_id)
            return self._start_paseo(a, provider, model, thinking)
        if a.get("node_id"):
            raise AgentError("节点 Agent 暂不支持 pi")
        if a["role"] == "lead":
            raise AgentError("项目负责人暂不支持 pi")
        if not (self.pi and self.tmux):
            raise AgentError(self.available()["note"])
        if self.alive(a):
            return self.public(a)
        self._guide(a, "pi")
        if a["role"] == "assistant":
            self._tools(a)
        cwd = Path(a["cwd"])
        sessions = self.s.data_dir / "agents" / agent_id
        sessions.mkdir(parents=True, exist_ok=True)
        cmd = [*self._pi_argv(), "-e", str(BRIDGE), "--session-dir", str(sessions)]
        if any(sessions.glob("*.jsonl")):
            cmd.append("--continue")
        if self.s.pi_model:
            cmd += ["--model", self.s.pi_model]
        env = {"PAPERTOWN_URL": self.s.url, "PAPERTOWN_AGENT": agent_id, "PAPERTOWN_AGENT_TOKEN": a["token"],
               "PAPERTOWN_AGENT_ROLE": a["role"], "PATH": f"{Path(cmd[0]).parent}{os.pathsep}{os.environ.get('PATH', '')}"}
        # keep a failed start on screen for a while so it can be read
        shell = f"{shlex.join(cmd)}; code=$?; [ $code -ne 0 ] && {{ echo; echo \"pi 退出了（$code）\"; sleep 60; }}"
        args = ["new-session", "-d", "-s", a["tmux"], "-x", "160", "-y", "48", "-c", str(cwd)]
        for k, v in env.items():
            args += ["-e", f"{k}={v}"]
        r = self._tmux(*args, shell)
        if r.returncode != 0:
            raise AgentError(f"tmux 启动失败：{r.stderr.strip()}")
        self._set(agent_id, status="starting", runtime="pi")
        self.record(agent_id, "note", {"text": "在后台终端里启动 pi。", "attach": _attach(a["tmux"], self.s.tmux_socket)})
        threading.Thread(target=self._watch_start, args=(agent_id,), daemon=True).start()
        return self.public(self.get(agent_id))

    def _watch_start(self, agent_id: str, timeout: float = 25) -> None:
        t0 = time.time()
        while time.time() - t0 < timeout:
            time.sleep(0.5)
            if self.get(agent_id)["status"] != "starting":
                return
        a = self.get(agent_id)
        if a["status"] == "starting":
            screen = self._tmux("capture-pane", "-p", "-t", a["tmux"]).stdout.strip().splitlines()[-6:] if self.alive(a) else []
            self._set(agent_id, status="error")
            self.record(agent_id, "note", {"text": "pi 没有连上 Papertown。" + (f"终端最后几行：{' / '.join(screen)}" if screen else ""), "error": True})

    def _workspace(self, a: dict) -> str | None:
        """One Paseo project per research project, with a workspace for each role or task."""
        if not a["line_id"]:
            return None
        if a.get("workspace_id"):
            return a["workspace_id"]
        line = self.db.one("select * from lines where id = ?", a["line_id"])
        project_id = line["paseo_project"]
        if not project_id:
            project_id = self.paseo.project(self.s.projects_dir / a["line_id"])
            self.db.update("lines", {"id": a["line_id"]}, paseo_project=project_id)
        title = f"#{line['seq']} · {a.get('node_id') or ROLES[a['role']]['name']} · {line['title']}"
        workspace_id = self.paseo.workspace(project_id, Path(a["cwd"]), title)
        self.db.update("agents", {"id": a["id"]}, workspace_id=workspace_id)
        return workspace_id

    @staticmethod
    def labels(a: dict) -> dict[str, str]:
        labels = {"papertown": "1", "papertown.agent": a["id"], "papertown.line": a["line_id"] or "-", "papertown.role": a["role"]}
        if a.get("node_id"):
            labels["papertown.node"] = a["node_id"]
        return labels

    def _paseo_intro(self, a: dict) -> tuple[str, str]:
        """The guide written to the agent's home, and the title and first message of its Paseo session."""
        self._guide(a, "paseo")
        if a["role"] == "assistant":
            return "Papertown · 小助手", self.town.assistant.intro()
        line = self.db.one("select * from lines where id = ?", a["line_id"])
        if a.get("node_id"):
            return (f"Papertown #{line['seq']} · {a['node_id']} · {ROLES[a['role']]['name']}",
                    self._linked_intro(a, "paseo") + f"\n\n你负责研究回路节点 {a['node_id']}，等待该节点的任务；不要自行启动其他任务。")
        if a["role"] == "lead":
            return f"Papertown #{line['seq']} 项目负责人：{line['title']}", self.brief(a["id"])
        title = f"Papertown #{line['seq']} {ROLES[a['role']]['name']}：{line['title']}"
        if self.town.linked.of(a["line_id"]):
            return title, self._linked_intro(a, "paseo")
        return title, ("这是项目简报，先读一遍（工作目录里的 AGENTS.md 说明了怎么用 Papertown），再说说你打算怎么开始：\n\n"
                       + self.town.brief(a["line_id"], a["role"]))

    def _start_paseo(self, a: dict, provider: str | None, model: str | None, thinking: str | None,
                     intro: tuple[str, str] | None = None) -> dict:
        """Create the agent in Paseo with its brief as the first message; once there, starting again only reopens it."""
        if a.get("ext_id"):
            return self.public(a)
        if not provider:
            d = self.town.paseo_models.default(a["role"])
            provider, model, thinking = d["provider"], model or d["model"], thinking or d["thinking"]
        if not provider:
            raise AgentError("先选一个 Paseo 里的供应商")
        st = self.paseo.status(fresh=True)
        if not st["ok"]:
            raise AgentError(st["note"])
        title, prompt = intro or self._paseo_intro(a)
        try:
            r = self.paseo.create(
                title=title, provider=provider, model=model,
                thinking=thinking, cwd=Path(a["cwd"]), prompt=prompt,
                workspace_id=self._workspace(a), labels=self.labels(a),
                env={"PAPERTOWN_URL": self.s.url, "PAPERTOWN_AGENT": a["id"], "PAPERTOWN_AGENT_TOKEN": a["token"], "PAPERTOWN_AGENT_ROLE": a["role"]})
        except PaseoError as e:
            raise AgentError(str(e)) from e
        self._set(a["id"], runtime="paseo", ext_id=r["agentId"], session_id=None, status="working", model=model_label(provider, model))
        sent = "说明" if a["role"] == "assistant" else "项目简报"
        self.record(a["id"], "note", {"text": f"在 Paseo 里启动了 {provider}{f' · {model}' if model else ''}，并发了{sent}。"})
        self.watch()
        return self.public(self.get(a["id"]))

    def import_paseo(self, line_id: str, role: str, ext_id: str) -> dict:
        """Take over an existing Paseo conversation as this project's agent for the role."""
        if role not in PI_ROLES:
            raise AgentError("这个岗位不能对话")
        return self.import_session(self.ensure(line_id, role)["id"], ext_id)

    @_session_change
    def import_session(self, agent_id: str, ext_id: str) -> dict:
        a = self._chat(agent_id)
        if a.get("ext_id") == ext_id:
            return self.public(a)
        if a.get("runtime"):
            self._switchable(a)
        try:
            conv = next((c for c in self.paseo.conversations() if c["id"] == ext_id), None)
        except PaseoError as e:
            raise AgentError(str(e)) from e
        if not conv:
            raise AgentError("Paseo 里没有这段对话")
        if not conv.get("cwd"):
            raise AgentError("这段 Paseo 对话没有工作目录，不能导入")
        other = self.db.one("select id from agents where ext_id = ? and runtime = 'paseo'", ext_id)
        owner = (conv.get("labels") or {}).get("papertown.agent")
        if other and other["id"] != a["id"]:
            raise AgentError(f"这段对话已经导入给了{self.town.leads._who(self.get(other['id']))}")
        if owner and owner != a["id"]:
            raise AgentError("这段对话已经属于另一个 Papertown Agent，不能重复导入")
        if a.get("runtime") in RUNTIMES:
            self.hosted.close(agent_id)
        try:
            self.paseo.label(ext_id, self.labels(a))
        except PaseoError as e:
            raise AgentError(str(e)) from e
        self._tools(a)
        self._set(a["id"], runtime="paseo", ext_id=ext_id, model=model_label(conv["provider"], conv.get("model")),
                  cwd=conv["cwd"], workspace_id=conv.get("workspace_id"), status=PASEO_STATUS.get(conv["status"], "error"))
        self._remember_session(self.get(a["id"]), conv)
        self.record(a["id"], "note", {"text": f"导入了 Paseo 里的对话「{conv.get('title') or ext_id[:8]}」。点侧栏的「发送项目简报」，它就知道这个项目和怎么用 Papertown。"})
        self.watch()
        return self.public(self.get(a["id"]))

    def _paseo_agent(self, agent_id: str) -> dict:
        a = self.get(agent_id)
        if not a or a.get("runtime") != "paseo" or not a.get("ext_id"):
            raise AgentError("这个员工不在 Paseo 里")
        return a

    def timeline(self, agent_id: str, limit: int = 200) -> dict:
        """The current conversation, read on demand; also refreshes its status."""
        a = self.get(agent_id)
        if a and a.get("runtime") in RUNTIMES:
            from .transcripts import read
            a = self.hosted.refresh(agent_id)
            result = read(self.s, a['term']['provider'], a.get('session_id'), limit, a['term'].get('started'))
            queued = self.db.q("select * from agent_events where agent_id = ? and kind = 'user' and json_extract(data, '$.held') = 1 order by id", agent_id)
            return {"agent": self.public(a), "paseo": {}, "queued": queued, **result}
        a = self._paseo_agent(agent_id)
        version = self._versions.get(agent_id, 0)
        try:
            t = self.paseo.timeline(a["ext_id"], limit)
        except PaseoError as e:
            raise AgentError(str(e)) from e
        snap = t["agent"]
        with self._delivery_lock:
            current = self._paseo_agent(agent_id)
            if current["ext_id"] != a["ext_id"]:
                raise AgentError("会话已切换，请重新读取对话")
            if self._versions.get(agent_id, 0) == version:
                if "doing" in t:
                    self._activity(a["ext_id"], t["doing"], snap.get("updated") or now())
                last = next((item for item in reversed(t["items"]) if item.get("kind") == "assistant"), None)
                if last:
                    self._says[a["ext_id"]] = {"kind": "say", "text": last["text"][:200]}
                self._apply_snapshot(current, snap)
            queued = self.db.q("select * from agent_events where agent_id = ? and kind = 'user' and json_extract(data, '$.held') = 1 order by id", agent_id)
            return {"agent": self.public(self.get(agent_id)), "paseo": snap, "items": t["items"], "queued": queued, "transcript": {"ok": True, "note": None}}

    def permit(self, agent_id: str, request_id: str, allow: bool) -> None:
        """Answer a Paseo agent's permission request."""
        a = self._paseo_agent(agent_id)
        try:
            self.paseo.permit(a["ext_id"], request_id, allow)
        except PaseoError as e:
            raise AgentError(str(e)) from e

    def open_desktop(self, agent_id: str) -> None:
        a = self.get(agent_id)
        if not a or not a.get("ext_id"):
            raise AgentError("这个员工不在 Paseo 里")
        try:
            self.paseo.open_desktop(a["ext_id"])
        except PaseoError as e:
            raise AgentError(str(e)) from e

    def watch(self) -> None:
        """Follow native status and release queued messages while the server is running."""
        if self._watch_thread or not self.db.val("select 1 from agents where runtime = 'paseo' and ext_id is not null"):
            return
        self._halt.clear()
        self._feed = Feed(self.paseo, self._feed_line)
        self._watch_thread = threading.Thread(target=self._watch_paseo, daemon=True, name="paseo-watch")
        self._watch_thread.start()

    def shutdown(self) -> None:
        self.hosted.shutdown()
        self._halt.set()
        if self._feed:
            self._feed.close()
            self._feed = None
        if self._watch_thread:
            self._watch_thread.join(timeout=2)
        self._watch_thread = None

    def _watch_paseo(self) -> None:
        while not self._halt.wait(20 if self._feed and self._feed.live else 6):
            try:
                self.sync_paseo()
            except Exception as e:  # noqa: BLE001 - the watcher must outlive any one bad reading; the trace says what it was
                self.town.trace("PASEO", "会话同步失败", f"{type(e).__name__}: {e}")

    def sync_paseo(self) -> None:
        """Refresh native status before delivering queued messages to the same session."""
        rows = self.db.q("select * from agents where runtime = 'paseo' and ext_id is not null")
        if not rows:
            return
        status = self.paseo.status()
        up, self._paseo_note = status["ok"], status.get("note") or ""
        if up != self._paseo_up:
            self._paseo_up = up
            for a in rows:
                self._publish(a["id"])
        if not up:
            return
        versions = {a["id"]: self._versions.get(a["id"], 0) for a in rows}
        live = {x["id"]: x for x in self.paseo.list({"papertown": "1"})}
        for previous in rows:
            with self._delivery_lock:
                a = self.get(previous["id"])
                if a["ext_id"] != previous["ext_id"] or self._versions.get(a["id"], 0) != versions[a["id"]]:
                    continue
                x = live.get(a["ext_id"])
                self._apply_snapshot(a, x or {"id": a["ext_id"], "status": "stopped"})

    def _activity(self, ext_id: str, doing: dict | None, at: str) -> bool:
        with self._watch_lock:
            changed = self._doing.get(ext_id, {}).get("doing") != doing
            self._doing[ext_id] = {"doing": doing, "at": at}
            if doing and doing.get("kind") == "say":
                self._says[ext_id] = doing
            return changed

    def _remember_session(self, a: dict, snap: dict) -> None:
        """Preserve every provider session, including sessions from imported snapshots."""
        if "session_id" in snap:
            session_id = snap["session_id"]
            with self.db.lock:
                if session_id:
                    self.db.conn.execute("insert into agent_sessions values (?, ?, ?, ?) on conflict(session_id) do update set "
                                         "agent_id=excluded.agent_id, line_id=excluded.line_id, provider=excluded.provider",
                                         (session_id, a["id"], a["line_id"], snap.get("provider") or (a.get("model") or "").split("/")[0]))
                self.db.conn.execute("update agents set session_id = ? where id = ?", (session_id, a["id"]))
                self.db.conn.commit()

    def _apply_snapshot(self, a: dict | None, snap: dict) -> None:
        """Apply native status and release one held message under the caller's delivery lock."""
        ext = snap["id"]
        if "doing" in snap:
            self._activity(ext, snap["doing"], snap.get("updated") or now())
        with self._watch_lock:
            previous = self._snapshots.get(ext, {})
            merged = previous | deepcopy(snap)
            # CLI listings omit attention details. Keep known values, but never a finished turn's permission or clock.
            if snap["status"] not in ("running", "permission"):
                merged["turn_started"] = None
                if "permissions" not in snap:
                    merged["permissions"] = []
            self._snapshots[ext] = merged
        if not a:
            return
        self._remember_session(a, snap)
        status = "stopped" if snap["status"] == "stopped" or snap.get("archived") else PASEO_STATUS.get(snap["status"], "error")
        model = model_label(snap["provider"], snap.get("model")) if "provider" in snap else a["model"]
        if status != a["status"] or model != a["model"]:
            self._set(a["id"], status=status, model=model)
            if status == "stopped" and a["status"] != "stopped":
                self.record(a["id"], "note", {"text": "Paseo 里找不到这个 agent 了（可能被删除或归档）。"})
        elif merged != previous:
            self._versions[a["id"]] = self._versions.get(a["id"], 0) + 1
            self._publish(a["id"])
        if status == "idle" and not merged.get("permissions"):
            self.release(a["id"])

    @_serialized
    def _feed_line(self, line: dict) -> None:
        """Consume parsed NDJSON. Tests can drive this without launching the SDK."""
        kind = line.get("t")
        if kind in ("ready", "beat"):
            self._paseo_up, self._paseo_note = True, ""
            return
        ext = (line.get("agent") or {}).get("id") if kind == "agent" else line.get("id")
        if not ext:
            return
        a = self.db.one("select * from agents where runtime = 'paseo' and ext_id = ?", ext)
        if kind == "agent":
            previous = self._snapshots.get(ext, {})
            if previous and all(k in previous and previous[k] == value for k, value in line["agent"].items()):
                return
            self._apply_snapshot(a, line["agent"])
        elif kind == "gone":
            with self._watch_lock:
                self._snapshots.pop(ext, None)
                self._doing.pop(ext, None)
                self._says.pop(ext, None)
            self._apply_snapshot(a, {"id": ext, "status": "stopped"})
        elif kind == "doing" and self._activity(ext, line.get("doing"), line.get("at") or now()) and a:
            self._versions[a["id"]] = self._versions.get(a["id"], 0) + 1
            self._publish(a["id"])
        elif kind == "live" and a:  # its conversation has something new: a page showing it reads it again
            self.town.bus.publish("agent_live", agent_id=a["id"])

    @_serialized
    def retire(self, agent_id: str, why: str) -> None:
        """A node agent whose task is gone: stop what it is doing, cut its access to Papertown (its token changes) and set
        its conversation aside. The conversation stays in Paseo, still labelled as this agent's."""
        a = self.get(agent_id)
        if not a:
            return
        if a.get("runtime") in RUNTIMES:
            self.hosted.close(agent_id)
        if a.get("runtime") == "paseo" and a.get("ext_id") and a["status"] == "working" and not self.down(a):
            try:
                self.paseo.interrupt(a["ext_id"])
            except PaseoError as e:
                raise AgentError(f"无法停止 Agent：{e}") from e
        for row in self.db.q("select * from agent_events where agent_id = ? and kind = 'user' and json_extract(data, '$.held') = 1", agent_id):
            self.amend(row["id"], row["data"] | {"held": False, "error": why})
        self.db.update("agents", {"id": agent_id}, token=secrets.token_urlsafe(18))
        self._set(agent_id, runtime=None, ext_id=None, workspace_id=None, status="stopped", model=None)
        self.record(agent_id, "note", {"text": f"{why}。终端已关闭，该 Agent 已无法访问 Papertown。" if a.get("runtime") in RUNTIMES else f"{why}。Paseo 中的对话已保留，该 Agent 已无法访问 Papertown。"})

    @_serialized
    def release(self, agent_id: str) -> None:
        """Deliver the oldest queued message; failures remain visible and retryable."""
        a = self.get(agent_id)
        if a and a.get("runtime") in RUNTIMES:
            return self.hosted.release(agent_id)
        row = self.db.one("select * from agent_events where agent_id = ? and kind = 'user' and json_extract(data, '$.held') = 1"
                          " order by id limit 1", agent_id)
        if not a or not row or not a.get("ext_id") or a["status"] != "idle":
            return
        if row["data"].get("ext_id", a["ext_id"]) != a["ext_id"]:
            self.amend(row["id"], row["data"] | {"held": False, "error": "目标会话已改变，消息未发送"})
            return
        try:
            self.paseo.send(a["ext_id"], row["data"]["text"])
        except PaseoError as e:
            self.amend(row["id"], row["data"] | {"error": str(e)})
            return
        self.amend(row["id"], row["data"] | {"delivered": True, "held": False, "error": None})
        self._set(agent_id, status="working")

    def _held(self, agent_id: str, event_id: int) -> tuple[dict, dict]:
        a = self._chat(agent_id)
        row = self.db.one("select * from agent_events where agent_id = ? and id = ? and kind = 'user'"
                          " and json_extract(data, '$.held') = 1", agent_id, event_id)
        if not row:
            raise AgentError("未找到该排队消息")
        return a, row

    @_serialized
    def queue_now(self, agent_id: str, event_id: int) -> dict:
        """Deliver a held event once, preserving its identity and session ownership."""
        a, row = self._held(agent_id, event_id)
        if a.get("runtime") in RUNTIMES:
            return self.hosted.queue_now(agent_id, event_id)
        if a.get("runtime") == "pi":
            self._queue(agent_id, {"kind": "queue_now", "mid": row["data"]["mid"]})
            event = self.amend(event_id, row["data"] | {"held": False, "steered": True})
            self._publish(agent_id)
            return event
        if not a.get("ext_id") or row["data"].get("ext_id") != a["ext_id"]:
            raise AgentError("目标会话已改变，消息未发送")
        try:
            self.paseo.send(a["ext_id"], row["data"]["text"])
        except PaseoError as e:
            self.amend(event_id, row["data"] | {"error": str(e)})
            raise AgentError(str(e)) from e
        event = self.amend(event_id, row["data"] | {"held": False, "delivered": True, "steered": a["status"] == "working", "error": None})
        self._set(agent_id, status="working")
        return event

    @_serialized
    def queue_drop(self, agent_id: str, event_id: int) -> dict:
        a, row = self._held(agent_id, event_id)
        if a.get("runtime") in RUNTIMES:
            return self.hosted.queue_drop(agent_id, event_id)
        if a.get("runtime") == "pi":
            self._queue(agent_id, {"kind": "queue_drop", "mid": row["data"]["mid"]})
        event = self.amend(event_id, row["data"] | {"held": False, "dropped": True})
        self._publish(agent_id)
        return event

    def stop(self, agent_id: str) -> dict:
        a = self.get(agent_id)
        if not a:
            raise AgentError("没有这个员工")
        if a.get("runtime") in RUNTIMES:
            return self.hosted.stop(agent_id)
        if a.get("runtime") == "paseo":
            self.abort(agent_id)
            return self.public(self.get(agent_id))
        if self.alive(a):
            self._tmux("kill-session", "-t", a["tmux"])
        self._set(agent_id, status="stopped")
        self.record(agent_id, "note", {"text": "pi 已停止。"})
        return self.public(self.get(agent_id))

    def reconcile(self) -> None:
        self.hosted.reconcile()
        for a in self.db.q("select * from agents where role in ('coder', 'writer', 'assistant') and status != 'stopped' and coalesce(runtime, 'pi') = 'pi'"):
            if not self.alive(a):
                self.db.update("agents", {"id": a["id"]}, status="stopped", updated_at=now())
        self.watch()

    def say(self, agent_id: str, text: str, mode: str | None = None, origin: str = "web") -> dict:
        """A message to the agent. While it works, `mode` "steer" puts it into the current turn and "queue"
        holds it until the turn ends. The default is steer. A message to a Paseo session holds
        only the delivery lock; one that may have to start pi also holds the canvas lock, taken first."""
        if (self.get(agent_id) or {}).get("runtime") in RUNTIMES:
            event = self.hosted.say(agent_id, text, mode, origin)
            if origin == "web":
                self.seen(agent_id)
            return event
        if (self.get(agent_id) or {}).get("runtime") == "paseo":
            with self._delivery_lock:
                if (self.get(agent_id) or {}).get("runtime") == "paseo":  # still, now that the order is ours
                    event = self._say(agent_id, text, mode, origin)
                else:
                    event = None
            if event is not None:
                if origin == "web":
                    self.seen(agent_id)
                return event
        event = self._say_held(agent_id, text, mode, origin)
        if origin == "web":
            self.seen(agent_id)
        return event

    @_session_change
    def _say_held(self, agent_id: str, text: str, mode: str | None = None, origin: str = "web") -> dict:
        return self._say(agent_id, text, mode, origin)

    def _say(self, agent_id: str, text: str, mode: str | None, origin: str) -> dict:
        a = self.get(agent_id)
        if not a or a["role"] not in CHAT_ROLES:
            raise AgentError("这个员工不能对话")
        text = text.strip()
        if not text:
            raise AgentError("消息是空的")
        if mode not in (None, "queue", "steer", "interrupt"):
            raise AgentError("发送模式只能是 steer、queue 或 interrupt")
        if a.get("runtime") in RUNTIMES:
            return self.hosted.say(agent_id, text, mode, origin)
        if a.get("runtime") == "paseo":
            if not a.get("ext_id"):
                raise AgentError("先在 Paseo 里启动它")
            if origin == "web" and a["role"] != "assistant":  # the assistant names its own, before the page context goes on
                self.title(agent_id, text)
            busy = a["status"] == "working"
            if busy and mode == "queue":  # Paseo has no queue of its own: the watcher sends it once the agent is idle
                event = self.record(agent_id, "user", {"text": text, "origin": origin, "ext_id": a["ext_id"], "delivered": False, "queued": True, "held": True})
                self._publish(agent_id)
                return event
            try:
                if mode == "interrupt":
                    self.paseo.send(a["ext_id"], text, behavior="interrupt")
                else:
                    self.paseo.send(a["ext_id"], text)
            except PaseoError as e:
                raise AgentError(str(e)) from e
            self._set(agent_id, status="working")
            return self.record(agent_id, "user", {"text": text, "origin": origin, "ext_id": a["ext_id"], "delivered": True,
                                                   "steered": busy and mode != "interrupt", **({"interrupted": True} if busy and mode == "interrupt" else {})})
        if text.startswith("/") and len(text) > 1 and not text[1:2].isspace():
            return self._command(a, text)
        running = self.alive(a)
        if not running and not (self.pi and self.tmux):
            raise AgentError(self.available()["note"])
        cut = mode == "interrupt" and a["status"] == "working"  # an idle agent has nothing to stop
        if cut:
            self.abort(agent_id)
        mid = self._queue(agent_id, {"text": text, "mode": "queue" if mode == "interrupt" else mode or "steer"})
        ev = self.record(agent_id, "user", {"text": text, "origin": origin, "mid": mid, "delivered": False,
                                           "held": a["status"] == "working" and mode in ("queue", "interrupt"),
                                           **({"interrupted": True} if cut else {})})
        if not running:
            self.start(agent_id)
        self._publish(agent_id)
        return ev

    def _command(self, a: dict, text: str) -> dict:
        """A slash command for pi: typed into tmux when it needs pi's terminal UI, otherwise run by the bridge."""
        name, _, args = text[1:].partition(" ")
        if name == "quit":
            self.stop(a["id"])
            return self.record(a["id"], "user", {"text": text, "origin": "web", "cmd": True, "delivered": True})
        if not self.alive(a):
            raise AgentError("pi 没在运行，先启动它")
        if name in TUI_COMMANDS:
            self._tmux("send-keys", "-t", a["tmux"], "-l", text)
            self._tmux("send-keys", "-t", a["tmux"], "Enter")
            ev = self.record(a["id"], "user", {"text": text, "origin": "web", "cmd": True, "delivered": True})
            attach = _attach(a["tmux"], self.s.tmux_socket)
            self.record(a["id"], "note", {"text": f"{text} 要用 pi 的终端界面，已经在终端里执行了，接上终端操作：{attach}", "attach": attach})
            return ev
        mid = self._queue(a["id"], {"kind": "cmd", "name": name, "args": args.strip()})
        return self.record(a["id"], "user", {"text": text, "origin": "web", "cmd": True, "mid": mid, "delivered": False})

    def abort(self, agent_id: str) -> None:
        a = self.get(agent_id)
        if a and a.get("runtime") in RUNTIMES:
            self.hosted.stop(agent_id)
            return
        if a and a.get("runtime") == "paseo" and a.get("ext_id"):
            try:
                self.paseo.interrupt(a["ext_id"])
            except PaseoError as e:
                raise AgentError(str(e)) from e
            return
        self._queue(agent_id, {"kind": "abort"})

    def _queue(self, agent_id: str, msg: dict) -> int:
        """Put a message in a pi agent's inbox for its bridge to take; returns its id."""
        with self._lock:
            self._seq += 1
            self._inbox.setdefault(agent_id, []).append({"id": self._seq, **msg})
            return self._seq

    def take(self, agent_id: str) -> list[dict]:
        with self._lock:
            return self._inbox.pop(agent_id, [])

    def has_mail(self, agent_id: str) -> bool:
        with self._lock:
            return bool(self._inbox.get(agent_id))

    def brief(self, agent_id: str) -> str:
        """The project brief as a message to the agent; a Paseo agent also gets its tools by full path."""
        a = self.get(agent_id)
        if not a:
            raise AgentError("没有这个员工")
        if a["role"] == "assistant":
            raise AgentError("小助手不跟着某个项目，没有项目简报")
        if a["role"] == "lead":
            line = self.db.one("select seq, title from lines where id = ?", a["line_id"])
            return (f"你现在是项目 #{line['seq']}「{line['title']}」的负责人，这个项目由你推进。工作目录里的 AGENTS.md 说明了你的职责和工具，先读一遍，"
                    f"再读下面项目现在的样子和简报，然后从当前工序做起（`{self._tools(a)} stage` 看每道工序的状态和要交的产出）："
                    "该你做的现在就做，要员工动手的先 `pt hire` 启动它、再用 `pt tell` 派下去。"
                    "这一轮做完用 `pt report` 写一条汇报：项目到哪了、接下来怎么推进、有什么要用户定的。然后结束这一轮，等巡检消息。\n\n"
                    + self.town.leads.status(a["line_id"]) + "\n\n## 项目简报\n\n" + self.town.brief(a["line_id"], "lead"))
        if self.town.linked.of(a["line_id"]):
            return self._linked_intro(a, "paseo" if a.get("runtime") in ("paseo", *RUNTIMES) else "pi")
        text = self.town.brief(a["line_id"], a["role"])
        if a.get("runtime") not in ("paseo", *RUNTIMES):
            return "这是项目简报，先读一遍，再说说你打算怎么开始：\n\n" + text
        pt = self._tools(a)
        line = self.db.one("select seq, title from lines where id = ?", a["line_id"])
        return (f"你现在是 Papertown 里项目 #{line['seq']}「{line['title']}」的{ROLES[a['role']]['name']}。先读一遍下面的简报，再说说你打算怎么开始。\n\n"
                f"Papertown 的工具（在终端里直接用这个路径运行）：\n"
                f"- `{pt} brief` 读最新的项目简报\n"
                f"- `{pt} submit <名字> -- <命令>` 把实验提交到实验农场，命令在当前目录用 bash 执行；"
                f"脚本打印 `PROGRESS <0-100>` 汇报进度，结束时打印 `RESULT {{json}}`\n"
                f"- `{pt} jobs [任务 id]` 查看任务进度、结果和日志\n"
                f"- `{pt} tell lead \"…\"` 告诉项目负责人你做完了、卡住了或要它拍板\n"
                f"- `{pt} ask \"问题\" [--choice 选项]…` 问用户；`{pt} rules` 看你的工作边界\n\n" + text)

    def check(self, agent_id: str, token: str | None) -> dict:
        a = self.get(agent_id)
        if not a or not token or not secrets.compare_digest(a["token"], token):
            raise AgentError("bridge 身份不对")
        return a

    @_serialized
    def ingest(self, agent_id: str, events: list[dict]) -> None:
        """Events from a pi agent's bridge."""
        if (self.get(agent_id) or {}).get("runtime") in RUNTIMES:
            raise AgentError("终端员工请使用 hook 回报接口")
        for e in events:
            t = e.get("t")
            if t == "hello":
                before = self.get(agent_id)["status"]
                self._set(agent_id, runtime="pi", status="idle" if e.get("idle", True) else "working", model=e.get("model"))
                if before in ("starting", "stopped", "error"):  # the bridge also says hello after a reconnect
                    self.record(agent_id, "note", {"text": f"pi 已连上（{e.get('model') or '默认模型'}）。"})
            elif t == "input":
                self.record(agent_id, "user", {"text": e.get("text", ""), "origin": "terminal" if e.get("source") == "interactive" else e.get("source")})
            elif t == "start":
                self._turns[agent_id] = now()
                self._set(agent_id, status="working")
            elif t == "delta":
                self.town.bus.publish("agent_delta", agent_id=agent_id, text=e.get("text", ""))
            elif t == "assistant":
                usage = e.get("usage") or {}
                self.record(agent_id, "assistant", {k: e.get(k) for k in ("text", "tools", "model", "stop", "error")} | {"usage": usage})
                if usage.get("cost"):
                    self._charge(agent_id, e.get("model") or "pi", usage)
            elif t == "tool_start":
                self.record(agent_id, "tool", {"id": e.get("id"), "name": e.get("name"), "args": e.get("args")})
            elif t == "tool_end":
                self.record(agent_id, "tool_end", {k: e.get(k) for k in ("id", "name", "error", "result", "ms")})
            elif t == "settled":
                self._turns.pop(agent_id, None)
                self._set(agent_id, status="idle")
            elif t in ("queued", "delivered"):
                for mid in e.get("ids") or []:
                    row = self.db.one("select * from agent_events where agent_id = ? and kind = 'user' and json_extract(data, '$.mid') = ?"
                                      " order by id desc limit 1", agent_id, mid)
                    if row:
                        if t == "queued":
                            if not row["data"].get("dropped") and not row["data"].get("steered"):
                                self.amend(row["id"], row["data"] | {"held": True, "queued": True})
                        else:
                            self.amend(row["id"], row["data"] | {"held": False, "delivered": True,
                                                                  "queued": bool(e.get("queued")), "steered": bool(e.get("steered"))})
            elif t == "note":
                self.record(agent_id, "note", {"text": e.get("text", ""), "error": bool(e.get("error"))})
            elif t == "state":
                cur = {k: v for k, v in e.items() if k != "t"}
                self._state[agent_id] = self._state.get(agent_id, {}) | cur  # the model list and commands come only now and then
                m = cur.get("model")
                self._set(agent_id, **({"model": f"{m['provider']}/{m['id']}"} if m else {}))
            elif t == "bye":
                self._turns.pop(agent_id, None)
                self._set(agent_id, status="stopped")
        if events:
            self._publish(agent_id)

    def _charge(self, agent_id: str, model: str, usage: dict) -> None:
        a = self.get(agent_id)
        cost = float(usage.get("cost") or 0)
        self.db.update("agents", {"id": agent_id}, cost=(a["cost"] or 0) + cost)

    def monitor_note(self, line_id: str, text: str, **data) -> None:
        """A note from the farm's built-in monitor of a project."""
        a = self.ensure(line_id, "monitor")
        self.record(a["id"], "note", {"text": text, **data})
        self._set(a["id"], status="watching")
