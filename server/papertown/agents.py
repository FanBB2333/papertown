"""Agents with a terminal of their own: one pi per project in the depot (writes the code,
tests it, submits experiments) and one in the press (writes the paper). The farm has a
built-in monitor per project instead (farm.py), which needs no model.

Each pi runs interactively in a detached tmux session on a private socket, so you can
attach and type there, and loads bridge.ts, which mirrors the session to this server and
injects what you type in the web app. Pi uses its own model settings and login; nothing
here touches keys.

    tmux -L papertown attach -t pt-coder-line_1
"""

from __future__ import annotations

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

if TYPE_CHECKING:
    from .town import Town

BRIDGE = Path(__file__).parent / "pi" / "bridge.ts"
SOCKET = "papertown"
ROLES = {
    "coder": {"building": "depot", "name": "代码 pi", "title": "写代码的 pi"},
    "writer": {"building": "press", "name": "写作 pi", "title": "写论文的 pi"},
    "monitor": {"building": "farm", "name": "看田员", "title": "看实验进度的员工"},
}
PI_ROLES = ("coder", "writer")

GUIDE = {
    "coder": """# Papertown · 代码 pi

你是 Papertown 里项目 #{seq}「{title}」的代码 agent，工作目录就是这个项目的代码仓库。

- 先用 `papertown_project` 工具读项目简报（idea、方法草案、已有实验）。
- 按方法草案实现一个最小可运行的版本，写测试并在本地跑通。
- 正式实验不要在前台跑：用 `papertown_submit_job` 提交到实验农场，命令在本目录用 bash 执行。
  实验脚本打印 `PROGRESS <0-100>` 汇报进度，结束时打印 `RESULT {{json}}`，或写入 `$PAPERTOWN_JOB_DIR/result.json`。
- 用 `papertown_job_status` 查看任务进度、结果和日志。
- 回复用中文，简短说明你做了什么、下一步是什么。
""",
    "writer": """# Papertown · 写作 pi

你是 Papertown 里项目 #{seq}「{title}」的写作 agent，工作目录是印刷厂里这篇论文的目录。

- 先用 `papertown_project` 工具读项目简报：idea、方法草案、实验结果和审稿意见。
- 论文写在 `main.tex`，参考文献在 `refs.bib`；目录里已有初稿时在它的基础上改。
- 只写有依据的内容：数字来自实验结果，标着「模拟」的结果要在文中注明是模拟。
- 改完用 `latexmk -pdf -interaction=nonstopmode main.tex` 编译，修掉报错。
- 回复用中文，简短说明改了哪些部分。
""",
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
        self._inbox: dict[str, list[dict]] = {}
        self._lock = threading.Lock()
        self._seq = 0

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
        out["attach"] = f"tmux -L {SOCKET} attach -t {a['tmux']}" if a.get("tmux") else None
        out["name"] = ROLES[a["role"]]["name"]
        last = self.db.one("select * from agent_events where agent_id = ? and kind in ('assistant', 'note', 'user') order by id desc limit 1", a["id"])
        out["last"] = last
        return out

    def ensure(self, line_id: str, role: str) -> dict:
        if role not in ROLES:
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

    def _workdir(self, line_id: str, role: str) -> Path | None:
        if role == "coder":
            d = self.s.projects_dir / line_id / "code"
        elif role == "writer":
            d = self.town.press.dir(line_id)  # the paper the press serves is the one pi edits
        else:
            return None
        d.mkdir(parents=True, exist_ok=True)
        return d

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

    def start(self, agent_id: str) -> dict:
        a = self.get(agent_id)
        if not a or a["role"] not in PI_ROLES:
            raise AgentError("这个员工不是 pi")
        if not (self.pi and self.tmux):
            raise AgentError(self.available()["note"])
        if self.alive(a):
            return self.public(a)
        line = self.db.one("select * from lines where id = ?", a["line_id"])
        cwd = Path(a["cwd"])
        cwd.mkdir(parents=True, exist_ok=True)
        (cwd / "AGENTS.md").write_text(GUIDE[a["role"]].format(seq=line["seq"], title=line["title"]), encoding="utf-8")
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
        self._set(agent_id, status="starting")
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

    def stop(self, agent_id: str) -> dict:
        a = self.get(agent_id)
        if not a:
            raise AgentError("没有这个员工")
        if self.alive(a):
            self._tmux("kill-session", "-t", a["tmux"])
        self._set(agent_id, status="stopped")
        self._event(agent_id, "note", {"text": "pi 已停止。"})
        return self.public(self.get(agent_id))

    def reconcile(self) -> None:
        for a in self.db.q("select * from agents where role in ('coder', 'writer') and status != 'stopped'"):
            if not self.alive(a):
                self.db.update("agents", {"id": a["id"]}, status="stopped", updated_at=now())

    def shutdown(self) -> None:
        """Pi sessions outlive the server on purpose; nothing to do."""

    # ---------- talking to it ----------

    def say(self, agent_id: str, text: str) -> dict:
        a = self.get(agent_id)
        if not a or a["role"] not in PI_ROLES:
            raise AgentError("这个员工不能对话")
        text = text.strip()
        if not text:
            raise AgentError("消息是空的")
        running = self.alive(a)
        if not running and not (self.pi and self.tmux):
            raise AgentError(self.available()["note"])
        with self._lock:
            self._seq += 1
            mid = self._seq
            self._inbox.setdefault(agent_id, []).append({"id": mid, "text": text})
        ev = self._event(agent_id, "user", {"text": text, "origin": "web", "mid": mid, "delivered": False})
        if not running:
            self.start(agent_id)
        return ev

    def abort(self, agent_id: str) -> None:
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
        a = self.get(agent_id)
        if not a:
            raise AgentError("没有这个员工")
        return self.town.brief(a["line_id"], a["role"])

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
                        self.db.update("agent_events", {"id": row["id"]}, data=row["data"] | {"delivered": True, "queued": bool(e.get("queued"))})
                        self.town.bus.publish("agent_event", event=self.db.one("select * from agent_events where id = ?", row["id"]))
            elif t == "bye":
                self._set(agent_id, status="stopped")

    def _charge(self, agent_id: str, model: str, usage: dict) -> None:
        a = self.get(agent_id)
        cost = float(usage.get("cost") or 0)
        self.db.insert("ledger", {"ts": now(), "run_id": None, "line_id": a["line_id"], "provider": "pi", "model": model,
                                  "tokens_in": int(usage.get("input") or 0), "tokens_out": int(usage.get("output") or 0), "cost": cost})
        self.db.x("update lines set spent = spent + ? where id = ?", cost, a["line_id"])
        self.db.update("agents", {"id": agent_id}, cost=(a["cost"] or 0) + cost)
        self.town.bus.publish("bank", **self.town.bank.summary())

    # ---------- the farm's monitors ----------

    def monitor_note(self, line_id: str, text: str, **data) -> None:
        a = self.ensure(line_id, "monitor")
        self._event(a["id"], "note", {"text": text, **data})
        self._set(a["id"], status="watching")
