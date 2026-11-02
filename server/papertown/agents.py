"""Agents with a terminal of their own: one pi per project in the depot (writes the code,
tests it, submits experiments) and one in the press (writes the paper), and the console's
assistant in the sidebar (assistant.py), one for the whole town. The farm has a built-in
monitor per project instead (farm.py), which needs no model.

An agent runs in one of two places:

- pi in a detached tmux session on a private socket, so you can attach and type there.
  It loads bridge.ts, which mirrors the session to this server, injects what you type in
  the web app and runs pi's slash commands; the ones that need pi's own terminal UI are
  typed into tmux. Pi uses its own model settings and login; nothing here touches keys.

      tmux -L papertown attach -t pt-coder-line_1

- Paseo (paseo.py): any provider Paseo hosts (Claude Code, Codex, OpenCode, Pi, ...). The
  room embeds Paseo's own app for the agent, and the agent reaches the farm with the
  .papertown/pt script.
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
from pathlib import Path
from typing import TYPE_CHECKING

from .db import now
from .paseo import Paseo, PaseoError

if TYPE_CHECKING:
    from .town import Town

BRIDGE = Path(__file__).parent / "pi" / "bridge.ts"
PT = Path(__file__).parent / "pi" / "pt.py"
SOCKET = "papertown"
ROLES = {
    "coder": {"building": "depot", "name": "代码员工", "title": "写代码的 agent"},
    "writer": {"building": "press", "name": "写作员工", "title": "写论文的 agent"},
    "monitor": {"building": "farm", "name": "看田员", "title": "看实验进度的员工"},
    "assistant": {"building": "console", "name": "小助手", "title": "中控屏侧边栏里帮你看页面、办事的 agent"},
}
PI_ROLES = ("coder", "writer")  # one per project
CHAT_ROLES = (*PI_ROLES, "assistant")  # the ones you talk to

# pi's built-in commands that open its terminal UI (selectors, login, clipboard): typed into tmux
TUI_COMMANDS = {"settings", "scoped-models", "export", "import", "share", "bug", "changelog", "hotkeys",
                "fork", "tree", "trust", "login", "logout", "resume", "copy"}
# what a Paseo agent is called, by status
PASEO_STATUS = {"running": "working", "idle": "idle", "closed": "idle", "error": "error", "permission": "working"}

# how an agent reaches the town, by runtime
TOOLS = {
    "pi": {"brief": "用 `papertown_project` 工具读项目简报",
           "submit": "用 `papertown_submit_job` 提交到实验农场",
           "status": "用 `papertown_job_status` 查看任务进度、结果和日志"},
    "paseo": {"brief": "运行 `.papertown/pt brief` 读项目简报",
              "submit": "用 `.papertown/pt submit <名字> -- <命令>` 提交到实验农场",
              "status": "用 `.papertown/pt jobs [任务 id]` 查看任务进度、结果和日志"},
}

GUIDE = {
    "coder": """# Papertown · 代码员工

你是 Papertown 里项目 #{seq}「{title}」的代码 agent，工作目录就是这个项目的代码仓库。

- 先{brief}（idea、方法草案、已有实验）。
- 按方法草案实现一个最小可运行的版本，写测试并在本地跑通。
- 正式实验不要在前台跑：{submit}，命令在本目录用 bash 执行。
  实验脚本打印 `PROGRESS <0-100>` 汇报进度，结束时打印 `RESULT {{json}}`，或写入 `$PAPERTOWN_JOB_DIR/result.json`。
- {status}。
- 回复用中文，简短说明你做了什么、下一步是什么。
""",
    "writer": """# Papertown · 写作员工

你是 Papertown 里项目 #{seq}「{title}」的写作 agent，工作目录是印刷厂里这篇论文的目录。

- 先{brief}：idea、方法草案、实验结果和审稿意见。
- 论文写在 `main.tex`，参考文献在 `refs.bib`；目录里已有初稿时在它的基础上改。
- 只写有依据的内容：数字来自实验结果，标着「模拟」的结果要在文中注明是模拟。
- 改完用 `latexmk -pdf -interaction=nonstopmode main.tex` 编译，修掉报错。
- 回复用中文，简短说明改了哪些部分。
""",
}

# A project linked in from your own repositories: the agent works in the repository itself
# and gets this guide with its brief, since nothing is written into the repo. The brief is
# already in that first message, so reading it again is optional; `pt` needs to reach the
# Papertown server, which a sandbox without network (Codex's default) does not allow.
LINKED_GUIDE = {
    "coder": """# Papertown · 代码员工

你是 Papertown 里项目 #{seq}「{title}」的代码 agent。这个项目是从本机接入的：工作目录 `{code}` 就是用户自己的代码仓库，改动都是真的。

- 项目简报附在这份说明后面，里面有仓库现状和最近的提交；以后想看最新的，{brief}。
- 动手前先看 `git status` 和最近的提交，弄清楚做到哪一步了。只改和任务有关的文件，不要动用户还没提交的改动；commit、push 之前先问用户。
- 要 GPU 或要跑很久的实验，用用户的 nvidb 队列提交（`nvidb job submit`，写清 `--vram` 和 `--note`），不要用 ssh 直接起任务。实验农场按工作目录和任务名认出这个项目的任务。
- 回复用中文，简短说明你做了什么、下一步是什么。
""",
    "writer": """# Papertown · 写作员工

你是 Papertown 里项目 #{seq}「{title}」的写作 agent。这个项目是从本机接入的：工作目录 `{paper}` 就是用户自己的论文仓库（LaTeX），改动都是真的。

- 项目简报附在这份说明后面，里面有论文的章节和仓库现状；以后想看最新的，{brief}。
- 主文件是 `{main}`，章节可能在它 `\\input` 的文件里，参考文献在仓库里的 .bib 文件。在已有内容上改，不要换模板、不要重排结构。
- 动手前先看 `git status`。只改和任务有关的文件，不要动用户还没提交的改动；commit、push 之前先问用户。
- 只写有依据的内容：数字和结论来自代码仓库 `{code}` 里的实验结果，找不到依据的地方留 TODO，不要编。
- 需要编译时用 `latexmk -pdf -interaction=nonstopmode {main}`，编译产物不要提交。
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


class Agents:
    def __init__(self, town: "Town"):
        self.town = town
        self.db = town.db
        self.s = town.s
        self.pi = _which("pi", self.s.pi_bin)
        self.tmux = _which("tmux", self.s.tmux_bin)
        self.paseo = Paseo(self.s.paseo_bin, self.s.paseo_url, self.s.paseo_host)
        self._inbox: dict[str, list[dict]] = {}
        self._state: dict[str, dict] = {}  # what each pi's bridge last reported: model, thinking, session
        self._lock = threading.Lock()
        self._seq = 0
        self._watching = False

    # ---------- what is installed ----------

    def available(self) -> dict:
        missing = [n for n, p in (("pi", self.pi), ("tmux", self.tmux)) if not p]
        return {"pi": self.pi, "tmux": self.tmux, "ok": not missing,
                "note": f"本机没有找到 {' 和 '.join(missing)}" if missing else "pi 会用它自己的模型设置和登录"}

    def _command(self) -> list[str]:
        """pi is a node script: run it with the node next to it, so tmux needs no PATH setup."""
        real = Path(os.path.realpath(self.pi))
        node = Path(self.pi).parent / "node"
        if real.suffix in (".js", ".mjs") and node.exists():
            return [str(node), str(real)]
        return [self.pi]

    # ---------- rows ----------

    def get(self, agent_id: str) -> dict | None:
        return self.db.one("select * from agents where id = ?", agent_id)

    def public(self, a: dict | None) -> dict | None:
        if not a:
            return None
        out = {k: v for k, v in a.items() if k != "token"}
        out["runtime"] = rt = a.get("runtime") or "pi"
        out["started"] = bool(a.get("runtime"))  # false until it has been started once (pi or Paseo)
        out["attach"] = f"tmux -L {SOCKET} attach -t {a['tmux']}" if rt == "pi" and a.get("tmux") else None
        out["web"] = self.paseo.url(a["ext_id"]) if rt == "paseo" and a.get("ext_id") else None
        out["state"] = self._state.get(a["id"]) if rt == "pi" else None
        out["name"] = ROLES[a["role"]]["name"]
        last = self.db.one("select * from agent_events where agent_id = ? and kind in ('assistant', 'note', 'user') order by id desc limit 1", a["id"])
        out["last"] = last
        return out

    def ensure(self, line_id: str, role: str) -> dict:
        if role not in ROLES or role == "assistant":
            raise AgentError(f"没有这个岗位：{role}")
        line = self.db.one("select * from lines where id = ?", line_id)
        if not line:
            raise AgentError("没有这个项目")
        agent_id = f"{role}-{line_id}"
        a = self.get(agent_id)
        if a:
            return a
        cwd = self._workdir(line_id, role)
        self.db.insert("agents", {"id": agent_id, "line_id": line_id, "role": role, "status": "stopped" if role in PI_ROLES else "watching",
                                  "tmux": f"pt-{agent_id}" if role in PI_ROLES else None, "cwd": str(cwd) if cwd else None,
                                  "token": secrets.token_urlsafe(18), "model": None, "cost": 0, "created_at": now(), "updated_at": now()})
        self._publish(agent_id)
        return self.get(agent_id)

    def _workdir(self, line_id: str | None, role: str) -> Path | None:
        if role == "assistant":
            return self.town.assistant.dir
        linked = self.town.linked.workdir(line_id, role)  # a project of your own: its repository itself
        if linked:
            return linked
        if role == "coder":
            d = self.s.projects_dir / line_id / "code"
        elif role == "writer":
            d = self.town.press.dir(line_id)  # the paper the press serves is the one pi edits
        else:
            return None
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _home(self, line_id: str | None, role: str) -> Path:
        """Where Papertown keeps an agent's own files (its guide, the pt tool). That is its
        working directory, except in a linked repository, which Papertown does not write into."""
        if role != "assistant" and self.town.linked.workdir(line_id, role):
            d = self.s.projects_dir / line_id / role
            d.mkdir(parents=True, exist_ok=True)
            return d
        return self._workdir(line_id, role)

    def roster(self, role: str) -> list[dict]:
        """Every project with its agent for this role (None until one is created)."""
        lines = self.db.q("select id, seq, title, status, stage from lines where status != 'dropped' order by seq desc")
        agents = {a["line_id"]: a for a in self.db.q("select * from agents where role = ?", role)}
        return [{"line": ln, "agent": self.public(agents.get(ln["id"]))} for ln in lines]

    def _set(self, agent_id: str, **fields) -> None:
        self.db.update("agents", {"id": agent_id}, updated_at=now(), **fields)
        self._publish(agent_id)

    def _publish(self, agent_id: str) -> None:
        self.town.bus.publish("agent", agent=self.public(self.get(agent_id)))

    def _event(self, agent_id: str, kind: str, data: dict) -> dict:
        row = {"agent_id": agent_id, "ts": now(), "kind": kind, "data": data}
        row["id"] = self.db.insert("agent_events", row)
        self.town.bus.publish("agent_event", event=row)
        return row

    def record(self, agent_id: str, kind: str, data: dict) -> dict:
        """An event of the agent's own kind: the assistant's questions and requests."""
        return self._event(agent_id, kind, data)

    def amend(self, event_id: int, data: dict) -> dict:
        self.db.update("agent_events", {"id": event_id}, data=data)
        row = self.db.one("select * from agent_events where id = ?", event_id)
        self.town.bus.publish("agent_event", event=row)
        return row

    def detach(self, agent_id: str) -> None:
        """Set an agent's Paseo conversation aside (it stays in Paseo); the next start makes another."""
        self._set(agent_id, runtime=None, ext_id=None, status="stopped", model=None)

    def attach(self, agent_id: str, conv: dict) -> None:
        """Take a Paseo conversation (back) as the agent's own: detach's other half."""
        model = "/".join(x for x in (conv["provider"], conv.get("model")) if x)
        self._set(agent_id, runtime="paseo", ext_id=conv["id"], model=model, status=PASEO_STATUS.get(conv["status"], "idle"))
        self.watch()

    def events(self, agent_id: str, after: int = 0, limit: int = 400) -> list[dict]:
        rows = self.db.q("select * from agent_events where agent_id = ? and id > ? order by id desc limit ?", agent_id, after, limit)
        return rows[::-1]

    # ---------- the terminal ----------

    def _tmux(self, *args: str) -> subprocess.CompletedProcess:
        # our own tmux server: your ~/.tmux.conf plus the extended keys pi asks for (docs/tmux.md in pi)
        conf = self.s.data_dir / "tmux.conf"
        if not conf.exists():
            conf.write_text("source-file -q ~/.tmux.conf\nset -g extended-keys on\nset -g extended-keys-format csi-u\n", encoding="utf-8")
        return subprocess.run([self.tmux, "-L", SOCKET, "-f", str(conf), *args], capture_output=True, text=True, timeout=10)

    def alive(self, a: dict) -> bool:
        return bool(self.tmux and a.get("tmux")) and self._tmux("has-session", "-t", a["tmux"]).returncode == 0

    def _guide(self, a: dict, runtime: str) -> str:
        """Write the role's guide where the agent reads it; returns the text. In a linked
        repository the repo's own AGENTS.md and CLAUDE.md are left alone: the guide goes into
        Papertown's directory and reaches the agent with its brief instead."""
        cwd = Path(a["cwd"])
        cwd.mkdir(parents=True, exist_ok=True)
        text = self._guide_text(a, runtime)
        home = self._home(a["line_id"], a["role"])
        (home / "AGENTS.md").write_text(text, encoding="utf-8")
        if runtime == "paseo":
            if home == cwd:
                (cwd / "CLAUDE.md").write_text(text, encoding="utf-8")  # Claude Code reads this one
            self._tools(a)
        return text

    def _guide_text(self, a: dict, runtime: str) -> str:
        """The role's guide, ending with the agent's work boundaries."""
        bounds = self.town.bounds.section(a["role"], a["line_id"], ".papertown/pt" if runtime == "paseo" else None)
        if a["role"] == "assistant":
            return self.town.assistant.guide(runtime) + bounds
        line = self.db.one("select seq, title from lines where id = ?", a["line_id"])
        info = self.town.linked.summary(a["line_id"]) if self.town.linked.of(a["line_id"]) else None
        if not info:
            return GUIDE[a["role"]].format(seq=line["seq"], title=line["title"], **TOOLS[runtime]) + bounds
        code, paper = info.get("code") or {}, info.get("paper") or {}
        return LINKED_GUIDE[a["role"]].format(seq=line["seq"], title=line["title"], brief=LINKED_BRIEF[runtime],
                                              code=code.get("path") or "（没有接代码仓库）", paper=paper.get("path") or "（没有接论文仓库）",
                                              main=paper.get("main") or "main.tex") + bounds

    def renew(self, agent_id: str) -> None:
        """Write a started agent's guide again, after its rules changed."""
        a = self.get(agent_id)
        if a and a.get("runtime") and a.get("cwd"):
            self._guide(a, a["runtime"])

    def pt(self, a: dict) -> Path:
        """Where a Paseo agent's `pt` is, by full path (an imported conversation works elsewhere)."""
        return self._home(a["line_id"], a["role"]) / ".papertown" / "pt"

    def _linked_intro(self, a: dict, runtime: str) -> str:
        """A linked project's first message: the guide, then the brief."""
        guide = self._guide_text(a, runtime)
        if runtime == "paseo":
            guide = guide.replace(".papertown/pt", str(self._tools(a)))
        return guide + "\n\n这是项目简报，先读一遍，再说说你打算怎么开始：\n\n" + self.town.brief(a["line_id"], a["role"])

    def _tools(self, a: dict) -> Path:
        """`.papertown/pt` in the role's own directory, with who it speaks for in link.json, for
        a shell that has no PAPERTOWN_* environment (an imported conversation). Returns pt."""
        tools = self._home(a["line_id"], a["role"]) / ".papertown"
        tools.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(PT, tools / "pt")
        (tools / "pt").chmod(0o755)
        link = tools / "link.json"
        link.write_text(json.dumps({"url": self.s.url, "agent": a["id"], "token": a["token"]}), encoding="utf-8")
        link.chmod(0o600)
        if a["role"] == "assistant":
            self.town.assistant.tools(tools)
        return tools / "pt"

    def start(self, agent_id: str, runtime: str | None = None, provider: str | None = None,
              model: str | None = None, thinking: str | None = None) -> dict:
        a = self.get(agent_id)
        if not a or a["role"] not in CHAT_ROLES:
            raise AgentError("这个员工不能对话")
        if (runtime or a.get("runtime")) == "paseo":
            return self._start_paseo(a, provider, model, thinking)
        if not (self.pi and self.tmux):
            raise AgentError(self.available()["note"])
        if self.alive(a):
            return self.public(a)
        self._guide(a, "pi")
        if a["role"] == "assistant":
            self._tools(a)  # its page and its list of actions sit next to pt
        cwd = Path(a["cwd"])
        sessions = self.s.data_dir / "agents" / agent_id
        sessions.mkdir(parents=True, exist_ok=True)
        cmd = [*self._command(), "-e", str(BRIDGE), "--session-dir", str(sessions)]
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
        self._event(agent_id, "note", {"text": "在后台终端里启动 pi。", "attach": f"tmux -L {SOCKET} attach -t {a['tmux']}"})
        threading.Thread(target=self._watch_start, args=(agent_id,), daemon=True).start()
        return self.public(self.get(agent_id))

    def _watch_start(self, agent_id: str, timeout: float = 25) -> None:
        t0 = time.time()
        while time.time() - t0 < timeout:
            time.sleep(0.5)
            a = self.get(agent_id)
            if a["status"] != "starting":
                return
        a = self.get(agent_id)
        if a["status"] == "starting":
            screen = self._tmux("capture-pane", "-p", "-t", a["tmux"]).stdout.strip().splitlines()[-6:] if self.alive(a) else []
            self._set(agent_id, status="error")
            self._event(agent_id, "note", {"text": "pi 没有连上 Papertown。" + (f"终端最后几行：{' / '.join(screen)}" if screen else ""), "error": True})

    def _start_paseo(self, a: dict, provider: str | None, model: str | None, thinking: str | None) -> dict:
        """Create the agent in Paseo with the project brief as its first message. Paseo keeps
        it from then on, so starting again only reopens it."""
        if a.get("ext_id"):
            return self.public(a)
        if not provider:
            raise AgentError("先选一个 Paseo 里的供应商")
        st = self.paseo.status(fresh=True)
        if not st["ok"]:
            raise AgentError(st["note"])
        self._guide(a, "paseo")
        if a["role"] == "assistant":
            title, prompt = "Papertown · 小助手", self.town.assistant.intro()
        else:
            line = self.db.one("select * from lines where id = ?", a["line_id"])
            title = f"Papertown #{line['seq']} {ROLES[a['role']]['name']}：{line['title']}"
            if self.town.linked.of(a["line_id"]):
                prompt = self._linked_intro(a, "paseo")
            else:
                prompt = "这是项目简报，先读一遍（工作目录里的 AGENTS.md 说明了怎么用 Papertown），再说说你打算怎么开始：\n\n" + self.town.brief(a["line_id"], a["role"])
        try:
            r = self.paseo.create(
                title=title, provider=provider, model=model,
                thinking=thinking, cwd=Path(a["cwd"]), prompt=prompt,
                labels={"papertown": "1", "papertown.agent": a["id"], "papertown.line": a["line_id"] or "-", "papertown.role": a["role"]},
                env={"PAPERTOWN_URL": self.s.url, "PAPERTOWN_AGENT": a["id"], "PAPERTOWN_AGENT_TOKEN": a["token"], "PAPERTOWN_AGENT_ROLE": a["role"]})
        except PaseoError as e:
            raise AgentError(str(e)) from e
        self._set(a["id"], runtime="paseo", ext_id=r["agentId"], status="working", model="/".join(x for x in (provider, model) if x))
        sent = "说明" if a["role"] == "assistant" else "项目简报"
        self._event(a["id"], "note", {"text": f"在 Paseo 里启动了 {provider}{f' · {model}' if model else ''}，并发了{sent}。"})
        self.watch()
        return self.public(self.get(a["id"]))

    def import_paseo(self, line_id: str, role: str, ext_id: str) -> dict:
        """Take over an existing Paseo conversation as this project's agent for the role."""
        if role not in PI_ROLES:
            raise AgentError("这个岗位不能对话")
        try:
            conv = next((c for c in self.paseo.conversations() if c["id"] == ext_id), None)
        except PaseoError as e:
            raise AgentError(str(e)) from e
        if not conv:
            raise AgentError("Paseo 里没有这段对话")
        other = self.db.one("select id from agents where ext_id = ? and runtime = 'paseo'", ext_id)
        a = self.ensure(line_id, role)
        if other and other["id"] != a["id"]:
            o = self.get(other["id"])
            seq = self.db.val("select seq from lines where id = ?", o["line_id"])
            raise AgentError(f"这段对话已经导入给了 #{seq} 的{ROLES[o['role']]['name']}")
        try:
            self.paseo.label(ext_id, {"papertown": "1", "papertown.agent": a["id"], "papertown.line": line_id, "papertown.role": role})
        except PaseoError as e:
            raise AgentError(str(e)) from e
        model = "/".join(x for x in (conv["provider"], conv.get("model")) if x)
        # the conversation keeps working where it was (nothing is written there); the tools
        # stay in the project's own directory
        self._tools(a)
        self._set(a["id"], runtime="paseo", ext_id=ext_id, model=model, cwd=conv.get("cwd") or a["cwd"], status=PASEO_STATUS.get(conv["status"], "idle"))
        self._event(a["id"], "note", {"text": f"导入了 Paseo 里的对话「{conv.get('title') or ext_id[:8]}」。点侧栏的「发送项目简报」，它就知道这个项目和怎么用 Papertown。"})
        self.watch()
        return self.public(self.get(a["id"]))

    def timeline(self, agent_id: str, limit: int = 200) -> dict:
        """A Paseo agent's conversation, trimmed for the room; also refreshes its status."""
        a = self.get(agent_id)
        if not a or a.get("runtime") != "paseo" or not a.get("ext_id"):
            raise AgentError("这个员工不在 Paseo 里")
        try:
            t = self.paseo.timeline(a["ext_id"], limit)
        except PaseoError as e:
            raise AgentError(str(e)) from e
        snap = t.get("agent") or {}
        status = PASEO_STATUS.get(snap.get("status"), a["status"])
        model = "/".join(x for x in (snap.get("provider"), snap.get("model")) if x) or a["model"]
        if status != a["status"] or model != a["model"]:
            self._set(agent_id, status=status, model=model)
        return {"agent": self.public(self.get(agent_id)), "paseo": snap, "items": t.get("items", [])}

    def permit(self, agent_id: str, request_id: str, allow: bool) -> None:
        """Answer a Paseo agent's permission request (run this command, edit that file)."""
        a = self.get(agent_id)
        if not a or a.get("runtime") != "paseo" or not a.get("ext_id"):
            raise AgentError("这个员工不在 Paseo 里")
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
        """Follow the status of the Paseo agents (a few seconds behind)."""
        if self._watching or not self.db.val("select 1 from agents where runtime = 'paseo' and ext_id is not null"):
            return
        self._watching = True
        threading.Thread(target=self._watch_paseo, daemon=True).start()

    def _watch_paseo(self) -> None:
        while True:
            time.sleep(6)
            rows = {a["ext_id"]: a for a in self.db.q("select * from agents where runtime = 'paseo' and ext_id is not null")}
            if not rows:
                continue
            try:
                live = {x["id"]: x for x in self.paseo.list({"papertown": "1"})}
            except PaseoError:
                continue
            for pid, a in rows.items():
                x = live.get(pid)
                status = PASEO_STATUS.get(x["status"], "idle") if x else "stopped"
                model = x.get("provider") if x else a["model"]
                if status != a["status"] or model != a["model"]:
                    self._set(a["id"], status=status, model=model)
                    if not x:
                        self._event(a["id"], "note", {"text": "Paseo 里找不到这个 agent 了（可能被删除或归档）。"})
                if status == "idle":
                    self.release(a["id"])

    def release(self, agent_id: str) -> None:
        """Send a Paseo agent that is done the oldest message that was queued for it."""
        a = self.get(agent_id)
        row = self.db.one("select * from agent_events where agent_id = ? and kind = 'user' and json_extract(data, '$.held') = 1"
                          " order by id limit 1", agent_id)
        if not a or not row or not a.get("ext_id"):
            return
        try:
            self.paseo.send(a["ext_id"], row["data"]["text"])
        except PaseoError:
            return  # it stays queued and goes with the next look
        self.db.update("agent_events", {"id": row["id"]}, data=row["data"] | {"delivered": True, "held": False})
        self.town.bus.publish("agent_event", event=self.db.one("select * from agent_events where id = ?", row["id"]))
        self._set(agent_id, status="working")

    def stop(self, agent_id: str) -> dict:
        a = self.get(agent_id)
        if not a:
            raise AgentError("没有这个员工")
        if a.get("runtime") == "paseo":  # Paseo keeps the agent; stopping is interrupting its turn
            self.abort(agent_id)
            return self.public(self.get(agent_id))
        if self.alive(a):
            self._tmux("kill-session", "-t", a["tmux"])
        self._set(agent_id, status="stopped")
        self._event(agent_id, "note", {"text": "pi 已停止。"})
        return self.public(self.get(agent_id))

    def reconcile(self) -> None:
        for a in self.db.q("select * from agents where role in ('coder', 'writer', 'assistant') and status != 'stopped' and coalesce(runtime, 'pi') = 'pi'"):
            if not self.alive(a):
                self.db.update("agents", {"id": a["id"]}, status="stopped", updated_at=now())
        self.watch()

    def shutdown(self) -> None:
        """Pi sessions outlive the server on purpose; nothing to do."""

    # ---------- talking to it ----------

    def say(self, agent_id: str, text: str, mode: str | None = None) -> dict:
        """A message from the web. While the agent works, `mode` says how it gets there: "steer"
        puts it into what the agent is doing, "queue" holds it until the agent is done; without
        one each runtime keeps its own way (pi queues, Paseo steers)."""
        a = self.get(agent_id)
        if not a or a["role"] not in CHAT_ROLES:
            raise AgentError("这个员工不能对话")
        text = text.strip()
        if not text:
            raise AgentError("消息是空的")
        if a.get("runtime") == "paseo":
            if not a.get("ext_id"):
                raise AgentError("先在 Paseo 里启动它")
            busy = a["status"] == "working"
            if busy and mode == "queue":  # Paseo has no queue of its own: the watcher sends it once the agent is idle
                return self._event(agent_id, "user", {"text": text, "origin": "web", "delivered": False, "queued": True, "held": True})
            try:
                self.paseo.send(a["ext_id"], text)
            except PaseoError as e:
                raise AgentError(str(e)) from e
            self._set(agent_id, status="working")
            return self._event(agent_id, "user", {"text": text, "origin": "web", "delivered": True, "steered": busy})
        if text.startswith("/") and len(text) > 1 and not text[1:2].isspace():
            return self._command(a, text)
        running = self.alive(a)
        if not running and not (self.pi and self.tmux):
            raise AgentError(self.available()["note"])
        with self._lock:
            self._seq += 1
            mid = self._seq
            self._inbox.setdefault(agent_id, []).append({"id": mid, "text": text, "mode": mode})
        ev = self._event(agent_id, "user", {"text": text, "origin": "web", "mid": mid, "delivered": False})
        if not running:
            self.start(agent_id)
        return ev

    def _command(self, a: dict, text: str) -> dict:
        """A slash command for pi. The ones that need pi's terminal UI are typed into tmux;
        the bridge runs the rest (pi's API for model, thinking, compact, new, ...; pi's own
        expansion for extension commands, skills and prompt templates)."""
        name, _, args = text[1:].partition(" ")
        if name == "quit":
            self.stop(a["id"])
            return self._event(a["id"], "user", {"text": text, "origin": "web", "cmd": True, "delivered": True})
        if not self.alive(a):
            raise AgentError("pi 没在运行，先启动它")
        if name in TUI_COMMANDS:
            self._tmux("send-keys", "-t", a["tmux"], "-l", text)
            self._tmux("send-keys", "-t", a["tmux"], "Enter")
            ev = self._event(a["id"], "user", {"text": text, "origin": "web", "cmd": True, "delivered": True})
            attach = f"tmux -L {SOCKET} attach -t {a['tmux']}"
            self._event(a["id"], "note", {"text": f"{text} 要用 pi 的终端界面，已经在终端里执行了，接上终端操作：{attach}", "attach": attach})
            return ev
        with self._lock:
            self._seq += 1
            mid = self._seq
            self._inbox.setdefault(a["id"], []).append({"id": mid, "kind": "cmd", "name": name, "args": args.strip()})
        return self._event(a["id"], "user", {"text": text, "origin": "web", "cmd": True, "mid": mid, "delivered": False})

    def abort(self, agent_id: str) -> None:
        a = self.get(agent_id)
        if a and a.get("runtime") == "paseo" and a.get("ext_id"):
            try:
                self.paseo.interrupt(a["ext_id"])
            except PaseoError as e:
                raise AgentError(str(e)) from e
            return
        with self._lock:
            self._seq += 1
            self._inbox.setdefault(agent_id, []).append({"id": self._seq, "kind": "abort"})

    def take(self, agent_id: str) -> list[dict]:
        with self._lock:
            return self._inbox.pop(agent_id, [])

    def has_mail(self, agent_id: str) -> bool:
        with self._lock:
            return bool(self._inbox.get(agent_id))

    def brief(self, agent_id: str) -> str:
        """The project brief as a message to the agent; a Paseo agent also gets the tools,
        by full path, since an imported conversation works outside the project."""
        a = self.get(agent_id)
        if not a:
            raise AgentError("没有这个员工")
        if a["role"] == "assistant":
            raise AgentError("小助手不跟着某个项目，没有项目简报")
        if self.town.linked.of(a["line_id"]):  # in a linked repo the guide is not in AGENTS.md: send it along
            return self._linked_intro(a, "paseo" if a.get("runtime") == "paseo" else "pi")
        text = self.town.brief(a["line_id"], a["role"])
        if a.get("runtime") != "paseo":
            return "这是项目简报，先读一遍，再说说你打算怎么开始：\n\n" + text
        pt = self._tools(a)
        line = self.db.one("select seq, title from lines where id = ?", a["line_id"])
        return (f"你现在是 Papertown 里项目 #{line['seq']}「{line['title']}」的{ROLES[a['role']]['name']}。先读一遍下面的简报，再说说你打算怎么开始。\n\n"
                f"Papertown 的工具（在终端里直接用这个路径运行）：\n"
                f"- `{pt} brief` 读最新的项目简报\n"
                f"- `{pt} submit <名字> -- <命令>` 把实验提交到实验农场，命令在当前目录用 bash 执行；"
                f"脚本打印 `PROGRESS <0-100>` 汇报进度，结束时打印 `RESULT {{json}}`\n"
                f"- `{pt} jobs [任务 id]` 查看任务进度、结果和日志\n\n" + text)

    # ---------- from the bridge ----------

    def check(self, agent_id: str, token: str | None) -> dict:
        a = self.get(agent_id)
        if not a or not token or not secrets.compare_digest(a["token"], token):
            raise AgentError("bridge 身份不对")
        return a

    def ingest(self, agent_id: str, events: list[dict]) -> None:
        for e in events:
            t = e.get("t")
            if t == "hello":
                before = self.get(agent_id)["status"]
                self._set(agent_id, status="idle" if e.get("idle", True) else "working", model=e.get("model"))
                if before in ("starting", "stopped", "error"):  # the bridge also says hello after a reconnect
                    self._event(agent_id, "note", {"text": f"pi 已连上（{e.get('model') or '默认模型'}）。"})
            elif t == "input":
                self._event(agent_id, "user", {"text": e.get("text", ""), "origin": "terminal" if e.get("source") == "interactive" else e.get("source")})
            elif t == "start":
                self._set(agent_id, status="working")
            elif t == "delta":
                self.town.bus.publish("agent_delta", agent_id=agent_id, text=e.get("text", ""))
            elif t == "assistant":
                usage = e.get("usage") or {}
                self._event(agent_id, "assistant", {k: e.get(k) for k in ("text", "tools", "model", "stop", "error")} | {"usage": usage})
                if usage.get("cost"):
                    self._charge(agent_id, e.get("model") or "pi", usage)
            elif t == "tool_start":
                self._event(agent_id, "tool", {"id": e.get("id"), "name": e.get("name"), "args": e.get("args")})
            elif t == "tool_end":
                self._event(agent_id, "tool_end", {k: e.get(k) for k in ("id", "name", "error", "result", "ms")})
            elif t == "settled":
                self._set(agent_id, status="idle")
            elif t == "delivered":
                for mid in e.get("ids") or []:
                    row = self.db.one("select * from agent_events where agent_id = ? and kind = 'user' and json_extract(data, '$.mid') = ?"
                                      " order by id desc limit 1", agent_id, mid)
                    if row:
                        self.db.update("agent_events", {"id": row["id"]}, data=row["data"] | {"delivered": True, "queued": bool(e.get("queued")),
                                                                                              "steered": bool(e.get("steered"))})
                        self.town.bus.publish("agent_event", event=self.db.one("select * from agent_events where id = ?", row["id"]))
            elif t == "note":
                self._event(agent_id, "note", {"text": e.get("text", ""), "error": bool(e.get("error"))})
            elif t == "state":
                prev = self._state.get(agent_id, {})
                cur = {k: v for k, v in e.items() if k != "t"}
                self._state[agent_id] = prev | cur  # the model list and commands come only now and then
                m = cur.get("model") or {}
                self._set(agent_id, model=f"{m['provider']}/{m['id']}" if m else self.get(agent_id)["model"])
            elif t == "bye":
                self._set(agent_id, status="stopped")

    def _charge(self, agent_id: str, model: str, usage: dict) -> None:
        a = self.get(agent_id)
        cost = float(usage.get("cost") or 0)
        self.db.insert("ledger", {"ts": now(), "run_id": None, "line_id": a["line_id"], "provider": "pi", "model": model,
                                  "tokens_in": int(usage.get("input") or 0), "tokens_out": int(usage.get("output") or 0), "cost": cost})
        if a["line_id"]:  # the assistant belongs to no project
            self.db.x("update lines set spent = spent + ? where id = ?", cost, a["line_id"])
        self.db.update("agents", {"id": agent_id}, cost=(a["cost"] or 0) + cost)
        self.town.bus.publish("bank", **self.town.bank.summary())

    # ---------- the farm's monitors ----------

    def monitor_note(self, line_id: str, text: str, **data) -> None:
        a = self.ensure(line_id, "monitor")
        self._event(a["id"], "note", {"text": text, **data})
        self._set(a["id"], status="watching")
