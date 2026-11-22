"""Each project's lead: the agent that runs its project. It stays up while the town does (`ensure`, unless you
switch it off), starts the workers it needs (`hire`), moves the line through its stages (`stage`) and acts on the
<checkin> messages sent when the project's stages, jobs, workers or open questions change (or it sits still too long).
What it does to other agents and to the line passes the work boundaries (bounds.py) first.

    data/projects/<project>/lead.json    whether it runs, whether it gets check-ins, and how long a quiet spell is
"""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime
from typing import TYPE_CHECKING

from .agents import AgentError, ROLES
from .db import now, read_json
from .hosted import RUNTIMES
from .nvidb import as_farm_job
from .pipeline import LIVE, NAMES as STAGES, LineError

if TYPE_CHECKING:
    from .town import Town

NAMES = {role: ROLES[role]["name"] for role in ("assistant", "lead", "coder", "writer")}
STATUS = {"running": "在做", "done": "已出厂", "dropped": "放弃了", "linked": "本地项目"}
STAGE = {"todo": "没开始", "run": "进行中", "done": "完成"}
JOB = {"queued": "排队", "running": "在跑", "done": "完成", "failed": "失败", "cancelled": "已取消"}
CHECK = {"pass": "通过", "warn": "有问题", "fail": "没过"}
TASK = {"sent": "已经发出", "done": "完成", "blocked": "卡住了"}
WORKER = {"working": "在干活", "idle": "空闲", "starting": "启动中", "error": "出错", "stopped": "没在运行", "offline": "连不上（Paseo 没在运行）"}
YES = ("可以", "允许", "同意", "好", "行", "yes", "ok", "y")
DEFAULTS = {"supervise": True, "every": 60}  # every: minutes of quiet before a check-in comes anyway
QUIET_MAX = 3  # check-ins in a row with nothing new, then quiet until something happens
RETRY = 60  # seconds before a lead that could not be started is tried again
ACTIVE = LIVE
HIRE = ("coder", "writer")


class LeadError(Exception):
    pass


def clip(s: object, n: int = 120) -> str:
    t = " ".join(str(s or "").split())
    return t if len(t) <= n else t[: n - 1] + "…"


def _ago(iso: str | None) -> str:
    try:
        m = (datetime.now().astimezone() - datetime.fromisoformat(str(iso))).total_seconds() / 60
    except (TypeError, ValueError):
        return ""
    return "刚刚" if m < 1 else f"{int(m)} 分钟前" if m < 60 else f"{int(m / 60)} 小时前" if m < 1440 else f"{int(m / 1440)} 天前"


class Leads:
    def __init__(self, town: "Town"):
        self.town = town
        self.db = town.db
        self.s = town.s
        self._pulse: dict[str, dict[str, tuple[str, str]]] = {}
        self._pending: dict[str, list[str]] = {}
        self._since: dict[str, str] = {}
        self._last: dict[str, float] = {}
        self._quiet: dict[str, int] = {}
        self._why: dict[str, str] = {}  # why a lead that should be running is not
        self._retry: dict[str, float] = {}
        self._starting: set[str] = set()
        self._lock = threading.Lock()
        self._halt = threading.Event()
        self._thread: threading.Thread | None = None

    def settings(self, line_id: str) -> dict:
        """on: whether the lead is kept running. Until you choose, a project you are working on has it on, and a
        sample or a finished one has it off."""
        d = read_json(self.s.projects_dir / line_id / "lead.json", {})
        out = DEFAULTS | {k: v for k, v in d.items() if k in DEFAULTS}
        if "on" in d:
            out["on"] = bool(d["on"])
        else:
            ln = self.db.one("select status, sample from lines where id = ?", line_id)
            out["on"] = bool(ln) and ln["status"] in LIVE and not ln["sample"]
        return out

    def configure(self, line_id: str, supervise: bool | None = None, every: int | None = None, on: bool | None = None) -> dict:
        d = self.settings(line_id)
        if supervise is not None:
            d["supervise"] = bool(supervise)
        if every is not None:
            d["every"] = max(10, min(24 * 60, int(every)))
        was = d["on"]
        if on is not None:
            d["on"] = bool(on)
        p = self.s.projects_dir / line_id / "lead.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
        if on is not None and d["on"] != was:
            self._switched(line_id, d["on"])
        elif on:  # switched on again while it is on: try the start once more now
            self._retry.pop(line_id, None)
            self.wake(line_id)
        return d

    def view(self, line_id: str) -> dict:
        a = self.town.agents.get(f"lead-{line_id}")
        return {"agent": self.town.agents.public(a), "settings": self.settings(line_id), "resident": self.resident(line_id),
                "reports": self.reports(line_id, 30), "asks": self.asks(line_id)}

    # the lead stays up

    def _up(self, a: dict | None) -> bool:
        """Whether the lead has a session to work in: a Paseo conversation, or a terminal that has not exited."""
        if not a or not a.get("runtime"):
            return False
        if a["runtime"] == "paseo":
            return bool(a.get("ext_id"))
        return a["runtime"] in RUNTIMES and bool(a.get("term")) and a["term"].get("status") != "exited"

    def resident(self, line_id: str) -> dict:
        """Whether the project's lead is running, for the switch on the project's page: on (your choice), state
        (running, starting, blocked: it should run and cannot, off, ended: the project is over) and why."""
        ln = self.db.one("select status from lines where id = ?", line_id)
        a = self.town.agents.get(f"lead-{line_id}")
        on = self.settings(line_id)["on"]
        base = {"on": on, "agent": a["id"] if a else None, "runtime": a.get("runtime") if a else None, "status": a["status"] if a else None, "note": None}
        if not ln or ln["status"] not in LIVE:
            return base | {"state": "ended", "note": "项目已经结束，负责人不再常驻。"}
        if not on:
            return base | {"state": "off"}
        if line_id in self._starting:
            return base | {"state": "starting"}
        if self._up(a):
            down = self.town.agents.down(a)
            return base | ({"state": "blocked", "note": down} if down else {"state": "running"})
        why = self._why.get(line_id)
        if not self.s.lead_resident:
            why = why or "这个小镇没有开负责人常驻（PAPERTOWN_LEAD_RESIDENT=0），可以在对话里手动启动。"
        return base | {"state": "blocked" if why else "starting", "note": why}

    def ensure(self, line_id: str, force: bool = False) -> None:
        """Bring the project's lead up when it should be running and is not: on the default runtime, with the lead's
        default model, its brief as the first message. A start that fails is kept as the reason and tried again later."""
        if not (self.s.lead_resident or force):
            return
        ln = self.db.one("select status from lines where id = ?", line_id)
        if not ln or ln["status"] not in LIVE or not self.settings(line_id)["on"]:
            return
        with self._lock:
            if line_id in self._starting or (not force and time.time() < self._retry.get(line_id, 0)):
                return
            a = self.town.agents.ensure(line_id, "lead")
            if self._up(a):
                self._why.pop(line_id, None)
                return
            self._starting.add(line_id)
        try:
            self.town.agents.start(a["id"])
            self._why.pop(line_id, None)
            self._retry.pop(line_id, None)
        except Exception as e:  # noqa: BLE001 - whatever stops one lead is shown on its project, the others still start
            self._why[line_id] = str(e) or type(e).__name__
            self._retry[line_id] = time.time() + RETRY
        finally:
            self._starting.discard(line_id)
            self.town.pipeline._publish(line_id)

    def wake(self, line_id: str) -> None:
        """Start the lead in the background, as a project begins or its switch goes on."""
        threading.Thread(target=self.ensure, args=(line_id,), daemon=True, name=f"lead-{line_id}").start()

    def _switched(self, line_id: str, on: bool) -> None:
        self._retry.pop(line_id, None)
        self._why.pop(line_id, None)
        if on:
            self.wake(line_id)
            return
        a = self.town.agents.get(f"lead-{line_id}")
        try:  # off: stop what it is doing; a terminal is closed, a Paseo conversation is kept
            if a and a.get("runtime") in RUNTIMES and (a.get("term") or {}).get("status") != "exited":
                self.town.agents.hosted.close(a["id"])
            elif a and a.get("runtime") == "paseo" and a.get("ext_id"):
                self.town.agents.abort(a["id"])
        except Exception:  # noqa: BLE001 - the switch is off either way: no check-in reaches it
            pass
        self.town.pipeline._publish(line_id)

    def agent(self, line_id: str, role: str) -> dict | None:
        """The project's agent in that role, once it has been started."""
        a = self.town.agents.get(f"{role}-{line_id}")
        return a if a and a["runtime"] else None

    def _who(self, a: dict) -> str:
        if a["role"] == "assistant":
            return NAMES["assistant"]
        seq = self.db.val("select seq from lines where id = ?", a["line_id"])
        who = f"#{seq} 的{NAMES[a['role']]}"
        return f"{who}（节点 {a['node_id']}）" if a.get("node_id") else who

    def target(self, sender: dict, to: str, line: str | None = None) -> dict:
        """Whom a message goes to: a lead tells its workers, a worker its lead, the assistant a
        project's lead (or, named, one of its workers)."""
        to = str(to or "").strip().lower()
        if to.startswith("task:"):
            if sender["role"] == "assistant" and not line:
                raise LeadError("说一下是哪个项目")
            lid = line if sender["role"] == "assistant" else sender["line_id"]
            from .canvas import CanvasError
            try:
                return self.town.canvas.message_target(lid, to.removeprefix("task:"))
            except CanvasError as e:
                raise LeadError(str(e)) from e
        role = {"代码员工": "coder", "写作员工": "writer", "负责人": "lead", "项目负责人": "lead"}.get(to, to)
        if sender["role"] == "assistant":
            if not line:
                raise LeadError("说一下是哪个项目")
            lid = line
            role = role or "lead"
        else:
            lid = sender["line_id"]
            allowed = ("coder", "writer") if sender["role"] == "lead" else ("lead",)
            if role not in allowed:
                raise LeadError(f"你能发消息给：{'、'.join(allowed)}")
        if role not in ("lead", "coder", "writer"):
            raise LeadError("收件人要写 lead（项目负责人）、coder（代码员工）或 writer（写作员工）")
        a = self.agent(lid, role)
        how = f"用 `pt hire {role}` 启动它" if sender["role"] == "lead" and role in HIRE else "请用户在项目页上打开负责人的开关" if role == "lead" else "让项目负责人启动它"
        if not a:
            seq = self.db.val("select seq from lines where id = ?", lid)
            raise LeadError(f"#{seq} 的{NAMES[role]}还没有启动，{how}")
        if a["runtime"] == "pi" and not self.town.agents.alive(a) or a["runtime"] in RUNTIMES and (a.get("term") or {}).get("status") == "exited":
            raise LeadError(f"{self._who(a)}没在运行，{how}")
        return a

    # what a lead does to its project: starting workers, moving the line

    def _lead(self, sender_id: str) -> dict:
        s = self.town.agents.get(sender_id)
        if not s or s["role"] != "lead" or s.get("node_id") or not s["line_id"]:
            raise LeadError("只有项目负责人能这么做")
        return s

    def hire(self, sender_id: str, role: str, runtime: str | None = None, provider: str | None = None,
             model: str | None = None, thinking: str | None = None) -> str:
        """`pt hire`: the lead starts the project's coder or writer, on the town's default runtime and the workers'
        default model unless it names others."""
        s = self._lead(sender_id)
        if role not in HIRE:
            raise LeadError("能启动的是 coder（代码员工）和 writer（写作员工）")
        kind, rule = self.town.bounds.policy("lead", s["line_id"], "agent.start")
        if kind == "never":
            raise LeadError(f"你的工作边界不让你启动员工：{rule['text']}")
        act = {"action": "agent.start", "role": role, "runtime": runtime, "provider": provider, "model": model, "thinking": thinking}
        if kind == "ask":
            q = self.ask(sender_id, f"{self._who(s)}想启动{NAMES[role]}，可以吗？", ["可以", "不可以"], act=act)
            return f"按你的工作边界（{rule['text']}），启动员工要先问用户。已经问了（问题 {q['id']}），他同意后会替你启动，结果会告诉你。"
        home = self.town.linked.workdir(s["line_id"], role)
        worker = self.town.agents.get(f"{role}-{s['line_id']}")
        if home and not (worker and self._up(worker)):
            # a linked project's worker edits the user's own repository: starting it is the user's call
            q = self.ask(sender_id, f"{self._who(s)}想启动{NAMES[role]}，它会在你自己的仓库 `{home}` 里工作，改动都是真的，可以吗？", ["可以", "不可以"], act=act)
            return (f"这个项目是从本机接入的，{NAMES[role]}的工作目录是用户自己的仓库，启动前要先问用户。"
                    f"已经问了（问题 {q['id']}），他同意后会替你启动，结果会告诉你。")
        return self._hire(s, act)

    def _hire(self, s: dict, act: dict) -> str:
        role = act["role"]
        a = self.town.agents.ensure(s["line_id"], role)
        if self._up(a) or a.get("runtime") == "pi" and self.town.agents.alive(a):
            return f"{NAMES[role]}已经在运行（{a['runtime']}{' · ' + a['model'] if a.get('model') else ''}），直接用 `pt tell {role} \"…\"` 派活。"
        runtime = act.get("runtime") or a.get("runtime") or self.town.paseo_models.runtime()
        d = self.town.paseo_models.default(role)
        try:
            a = self.town.agents.start(a["id"], runtime, act.get("provider") or d["provider"], act.get("model") or (None if act.get("provider") else d["model"]),
                                       act.get("thinking") or (None if act.get("provider") else d["thinking"]))
        except AgentError as e:
            raise LeadError(f"{NAMES[role]}没能启动：{e}") from e
        self.town.pipeline._publish(s["line_id"])
        return (f"{NAMES[role]}启动了（{a['runtime']}{' · ' + a['model'] if a.get('model') else ''}），它先读项目简报。"
                f"用 `pt tell {role} \"…\"` 给它派活，`pt worker {role}` 看它的对话。")

    def stage(self, sender_id: str, key: str, status: str, note: str | None = None, pct: int | None = None) -> str:
        """`pt stage run|done|todo`: the lead moves its project's line. A stage closes only through its hard gate."""
        s = self._lead(sender_id)
        kind, rule = self.town.bounds.policy("lead", s["line_id"], "stage.move")
        if kind == "never":
            raise LeadError(f"你的工作边界不让你推进工序：{rule['text']}")
        act = {"action": "stage.move", "stage": key, "status": status, "note": note, "pct": pct}
        if kind == "ask":
            verb = {"done": "收尾", "todo": "放回去重做"}.get(status, status)
            q = self.ask(sender_id, f"{self._who(s)}想把工序「{STAGES.get(key, key)}」{verb}{'：' + clip(note, 200) if note else ''}，可以吗？", ["可以", "不可以"], act=act)
            return f"按你的工作边界（{rule['text']}），这一步要先问用户。已经问了（问题 {q['id']}），他同意后会替你办，结果会告诉你。"
        return self._stage(s, act)

    def _stage(self, s: dict, act: dict) -> str:
        try:
            snap = self.town.pipeline.stage(s["line_id"], act["stage"], act["status"], act.get("note"), act.get("pct"))
        except LineError as e:
            raise LeadError(str(e)) from e
        key, cur = act["stage"], snap["current"]
        if act["status"] == "done":
            tail = "项目出厂了。" if snap["status"] == "done" else f"下一道「{cur['name']}」已经开工。" if cur else "没有在做的工序了。"
            return f"「{STAGES[key]}」收尾了。{tail}"
        return f"「{STAGES[key]}」{'开工了' if act['status'] == 'run' else '放回去了'}" + (f"（{snap['stages'][list(STAGES).index(key)]['pct']}%）。" if act["status"] == "run" else "。")

    def tell(self, sender_id: str, to: str, text: str, now_: bool = False, line: str | None = None) -> str:
        """`pt tell`: a message to another agent, if the sender's boundaries allow it."""
        s = self.town.agents.get(sender_id)
        text = str(text or "").strip()
        if not text:
            raise LeadError("消息是空的")
        t = self.target(s, to, line)
        kind, rule = self.town.bounds.policy(s["role"], s["line_id"], "tell")
        if kind == "never":
            raise LeadError(f"你的工作边界不让你给别的 agent 发消息：{rule['text']}")
        if kind == "ask":
            q = self.ask(sender_id, f"{self._who(s)}想给{self._who(t)}发：「{clip(text, 300)}」，可以吗？", ["可以", "不可以"],
                         act={"action": "tell", "to": t["id"], "text": text, "now": now_})
            return f"按你的工作边界（{rule['text']}），这条要先问用户。已经问了（问题 {q['id']}），他同意后会替你发出去，结果会告诉你。"
        self.deliver(s, t, text, now_)
        return f"已发给{self._who(t)}" + ("。" if now_ or t["status"] != "working" else "，它在忙，等它做完手上的事再交给它。")

    def deliver(self, sender: dict, target: dict, text: str, now_: bool = False) -> None:
        body = f'<msg from="{self._who(sender)}">\n{text.strip()}\n</msg>'
        try:
            self.town.agents.say(target["id"], body, None if now_ else "queue", origin=sender["id"])
        except AgentError as e:
            raise LeadError(str(e)) from e
        self.town.agents.record(sender["id"], "sent", {"to": target["id"], "who": self._who(target), "text": text})

    def _row(self, agent_id: str, line_id: str, kind: str, data: dict) -> dict:
        row = {"line_id": line_id, "agent_id": agent_id, "ts": now(), "kind": kind, "data": data}
        row["id"] = self.db.insert("reports", row)
        self.town.bus.publish("report", report=row)
        return row

    def report(self, agent_id: str, text: str, key: bool = False) -> dict:
        a = self.town.agents.get(agent_id)
        if not a or not a.get("line_id"):
            raise LeadError("只有项目里的 agent 能写汇报")
        text = str(text or "").strip()
        if not text:
            raise LeadError("汇报是空的")
        return self._row(agent_id, a["line_id"], "report", {"text": text[:4000], "key": bool(key), "who": NAMES.get(a["role"])})

    def ask(self, agent_id: str, question: str, choices: list[str] | None = None, act: dict | None = None) -> dict:
        a = self.town.agents.get(agent_id)
        if not a or not a.get("line_id"):
            raise LeadError("只有项目里的 agent 能在项目里提问")
        q = str(question or "").strip()
        if not q:
            raise LeadError("问题是空的")
        return self._row(agent_id, a["line_id"], "ask", {"question": q[:2000], "choices": [clip(c, 80) for c in choices or [] if str(c).strip()][:6],
                                                          "open": True, "act": act, "who": NAMES.get(a["role"])})

    def reports(self, line_id: str, limit: int = 30) -> list[dict]:
        rows = self.db.q("select * from reports where line_id = ? order by id desc limit ?", line_id, limit)
        return rows[::-1]

    def asks(self, line_id: str | None = None) -> list[dict]:
        return self.db.q("select * from reports where kind = 'ask' and json_extract(data, '$.open') = 1"
                         + (" and line_id = ?" if line_id else "") + " order by id", *([line_id] if line_id else []))

    def answer(self, report_id: int, text: str, by: str = "you") -> dict:
        """Your answer to a question, sent back to the agent that asked; what it asked to do is done if you allowed it."""
        r = self.db.one("select * from reports where id = ? and kind = 'ask'", report_id)
        if not r:
            raise LeadError("没有这个问题")
        d = r["data"]
        if not d.get("open"):
            raise LeadError("这个问题已经回答过了")
        text = str(text or "").strip()
        if not text:
            raise LeadError("回答是空的")
        d = d | {"open": False, "answer": text[:2000], "answered_at": now(), "by": by}
        asker = self.town.agents.get(r["agent_id"])
        act, done = d.get("act"), ""
        if act:
            if text.lower() in YES:
                try:
                    done = self._act(act, asker)
                except Exception as e:  # noqa: BLE001 - whatever stopped it is what the asker needs to read
                    done = f"但没办成：{e}"
                d["result"] = done
            else:
                done = "所以没有做。"
        self.db.update("reports", {"id": report_id}, data=d)
        row = self.db.one("select * from reports where id = ?", report_id)
        self.town.bus.publish("report", report=row)
        if asker and asker.get("runtime"):
            via = "用户" if by == "you" else "用户（经小助手转达）"
            msg = ["<answer>", f"你问的「{clip(d['question'], 200)}」，{via}回答：{text}", *([done] if done else []), "</answer>"]
            try:
                self.town.agents.say(asker["id"], "\n".join(msg), "queue", origin="you")
            except AgentError:
                pass
        return row

    def _act(self, act: dict, asker: dict | None) -> str:
        """What an agent asked to do and you allowed, done as that agent."""
        if not asker:
            raise LeadError("提问的 agent 不在了")
        if act.get("action") == "tell":
            target = self.town.agents.get(act["to"])
            if not target:
                raise LeadError("收消息的 agent 不在了")
            self.deliver(asker, target, act["text"], bool(act.get("now")))
            return f"已经替它发给{self._who(target)}。"
        if act.get("action") == "job.submit":
            j = self.town.farm.submit(asker["line_id"], act["name"], act["command"], act.get("backend") or "local", asker["id"], asker["cwd"])
            return f"已经提交了 {j['id']}。"
        if act.get("action") == "agent.start":
            return self._hire(asker, act)
        if act.get("action") == "stage.move":
            return self._stage(asker, act)
        raise LeadError(f"不认识的动作：{act.get('action')}")

    def status(self, line_id: str) -> str:
        """A project in a few lines: its stages, its agents, its jobs, its questions and reports."""
        snap = self.town.pipeline.snapshot(line_id)
        if not snap:
            raise LeadError("没有这个项目")
        cur = snap["current"]
        out = [f"项目 #{snap['seq']}「{snap['title']}」：{STATUS.get(snap['status'], snap['status'])}"
               + (f"，当前工序「{cur['name']}」{STAGE.get(cur['status'], cur['status'])}" + (f" {cur['pct']}%" if cur["pct"] else "") if cur else "")
               + (f"（{snap['note']}）" if snap["note"] else "")]
        out.append("工序：" + " · ".join(f"{s['name']}{'✓' if s['status'] == 'done' else '▶' if s['status'] == 'run' else ''}" for s in snap["stages"])
                   + "（`pt stage` 看每道的产出和卡口）")
        out.append("")
        out.append("这个项目的 agent：")
        for role in ("lead", "coder", "writer"):
            a = self.agent(line_id, role)
            if not a:
                out.append(f"- {NAMES[role]}：还没有启动" + (f"（要它干活时用 `pt hire {role}`）" if role in HIRE else ""))
                continue
            last = self.town.agents.public(a).get("last")
            said = f"，最后一条（{_ago(last['ts'])}）：「{clip((last['data'] or {}).get('text'), 100)}」" if last else ""
            out.append(f"- {NAMES[role]}：{a['runtime']}{' · ' + a['model'] if a.get('model') else ''}，{WORKER.get(st := self.town.agents.shown(a), st)}{said}")
        jobs = self._jobs(line_id)
        if jobs:
            out += ["", "最近的实验任务："]
            out += [f"- {j['id']} {j['name']}：{JOB.get(j['status'], j['status'])}" + (f" {j['progress']}%" if j["status"] == "running" else "")
                    + (f"，{clip(j['note'], 100)}" if j.get("note") else "") for j in jobs[:8]]
        asks = self.asks(line_id)
        if asks:
            out += ["", "等用户回答的问题："]
            out += [f"- 问题 {q['id']}（{q['data'].get('who')}，{_ago(q['ts'])}）：{clip(q['data']['question'], 160)}" for q in asks]
        out += ["", "检查：" + self.town.checks.brief(line_id)]
        locks = self.town.canvas.locks(line_id)
        if locks:
            out += ["硬卡口：" + "；".join(locks)]
        reps = [r for r in self.reports(line_id, 12) if r["kind"] in ("report", "usage")][-3:]
        if reps:
            out += ["", "最近的汇报："]
            out += [f"- {_ago(r['ts'])}{'【关键】' if r['data'].get('key') else ''}：{clip(r['data']['text'], 200)}" for r in reps]
        out += self.town.usage.brief(line_id)
        return "\n".join(out)

    def _jobs(self, line_id: str) -> list[dict]:
        rows = [as_farm_job(j, line_id) for j in self.town.linked.jobs(line_id)] + self.town.farm.list(line_id, 20)
        return sorted(rows, key=lambda j: str(j.get("started_at") or j.get("created_at") or ""), reverse=True)

    def _said(self, a: dict) -> list[tuple[str, str, str]]:
        """An agent's conversation as (who, text, when): what it received and what it said."""
        if a["runtime"] == "paseo":
            items = self.town.agents.timeline(a["id"], 80)["items"]
            return [(x["kind"], x.get("text") or "", x.get("ts")) for x in items if x["kind"] in ("user", "assistant", "error")]
        return [(e["kind"], (e["data"] or {}).get("text") or "", e["ts"]) for e in self.town.agents.events(a["id"], 0, 80)
                if e["kind"] in ("user", "assistant")]

    def peek(self, line_id: str, role: str, n: int = 6) -> str:
        """The last few messages of a worker's conversation, for its lead."""
        if role not in ("coder", "writer"):
            raise LeadError("要看 coder（代码员工）或 writer（写作员工）")
        a = self.agent(line_id, role)
        if not a:
            return f"{NAMES[role]}还没有启动。"
        try:
            rows = self._said(a)
        except AgentError as e:
            return f"读不到{NAMES[role]}的对话：{e}"
        if not rows:
            return f"{NAMES[role]}还没有对话。"
        who = {"user": "它收到", "assistant": "它说", "error": "出错"}
        out = [f"{NAMES[role]}现在{WORKER.get(a['status'], a['status'])}。最近 {min(n, len(rows))} 条："]
        return "\n".join(out + [f"- {who[k]}（{_ago(ts)}）：{clip(t, 600)}" for k, t, ts in rows[-n:]])

    def _facts(self, line_id: str) -> dict[str, tuple[str, str]]:
        """What the lead hears about when it changes: each with its state and what it is."""
        snap = self.town.pipeline.snapshot(line_id)
        if not snap:
            return {}
        f = {"line": (snap["status"], "项目")}
        f |= {f"stage:{s['key']}": (s["status"], f"工序「{s['name']}」") for s in snap["stages"]}
        f |= {f"job:{j['id']}": (j["status"], f"任务 {j['id']} {j['name']}" + (f"（{clip(j['note'], 80)}）" if j.get("note") and j["status"] == "failed" else ""))
              for j in self._jobs(line_id)[:30]}
        for role in ("coder", "writer"):
            if a := self.agent(line_id, role):
                f[f"agent:{role}"] = (a["status"], NAMES[role])
        f |= {f"ask:{q['id']}": ("open", f"{q['data'].get('who')}问用户：{clip(q['data']['question'], 120)}") for q in self.asks(line_id)}
        names = {h.id: h.title for h in self.town.checks.hard(line_id)}
        f |= {f"check:{k}": (r["status"], f"硬检查「{names[k]}」" + (f"（{int(r['value'])} 处）" if r["value"] else ""))
              for k, r in self.town.checks.latest(line_id).items() if k in names and r["status"] in CHECK}
        f |= self.town.canvas.task_facts(line_id)
        return f

    def _changes(self, line_id: str, old: dict, new: dict) -> list[str]:
        out = []
        for k, (v, what) in new.items():
            was = old.get(k, (None, ""))[0]
            if v == was:
                continue
            kind = k.split(":")[0]
            if kind == "job":
                out.append(f"{what}：{JOB.get(was, '新提交') if was else '新提交'} → {JOB.get(v, v)}")
            elif kind == "agent":
                if was == "working" and v == "idle":
                    out.append(f"{what}结束了一轮，" + self._last_words(line_id, k.split(":")[1]))
                elif v in ("error", "stopped"):
                    out.append(f"{what}{WORKER[v]}了")
            elif kind == "ask":
                out.append(what)
            elif kind == "check" and was is not None:
                out.append(f"{what}：{CHECK.get(was, was)} → {CHECK.get(v, v)}")
            elif kind == "task" and v in ("done", "blocked"):
                out.append(f"{what}：{TASK[v]}")
            elif kind == "stage" and was is not None:
                out.append(f"{what}：{STAGE.get(was, was)} → {STAGE.get(v, v)}")
            elif kind == "line" and was is not None:
                out.append(f"项目状态：{STATUS.get(was, was)} → {STATUS.get(v, v)}")
        for k, (was, what) in old.items():
            if k.startswith("ask:") and k not in new:
                q = self.db.one("select data from reports where id = ?", int(k.split(":")[1]))
                if q and q["data"].get("answer"):
                    out.append(f"用户回答了「{clip(q['data']['question'], 80)}」：{clip(q['data']['answer'], 160)}")
        return out

    def _last_words(self, line_id: str, role: str) -> str:
        try:
            said = [t for k, t, _ in self._said(self.town.agents.get(f"{role}-{line_id}")) if k == "assistant"]
        except AgentError:
            said = []
        return f"最后说：「{clip(said[-1], 300)}」" if said else "没留下话"

    def look(self, a: dict) -> None:
        """One look at a lead's project: note what changed; tell it when it is free and it is time."""
        lid = a["line_id"]
        facts = self._facts(lid)
        old = self._pulse.get(lid)
        self._pulse[lid] = facts
        if old is None:
            self._last.setdefault(lid, time.time())
            return
        changes = self._changes(lid, old, facts)
        if changes:
            self._pending.setdefault(lid, []).extend(changes)
            self._since.setdefault(lid, now())
            self._quiet[lid] = 0
        st = self.settings(lid)
        if not st["supervise"] or a["status"] != "idle" or not a.get("ext_id") and a.get("runtime") == "paseo":
            return
        quiet = time.time() - self._last[lid]
        if (self._pending.get(lid) or self.town.checks.due(lid)) and quiet >= self.s.lead_gap:
            self.checkin(a)
        elif not self._pending.get(lid) and facts.get("line", ("",))[0] in ACTIVE and quiet >= st["every"] * 60 and self._quiet.get(lid, 0) < QUIET_MAX:
            self._quiet[lid] = self._quiet.get(lid, 0) + 1
            self.checkin(a)

    def checkin(self, a: dict) -> None:
        lid = a["line_id"]
        changes, since = self._pending.pop(lid, []), self._since.pop(lid, None)
        due = self.town.checks.due(lid)
        out = ["<checkin>"]
        if changes:
            out += [f"{datetime.fromisoformat(since).astimezone():%H:%M} 以来项目里的变化：", *[f"- {c}" for c in changes]]
        elif not due:
            mins = int((time.time() - self._last[lid]) / 60)
            out.append(f"已经 {mins} 分钟没有新动静了。看看员工是不是闲着、有没有该催的、有没有该告诉用户的。")
        if due:
            out += [*([""] if changes else []), "到期的软巡检（研究回路上要你判断的问题）：", *self.town.checks.ask_text(due)]
        out += ["", "现在的情况：", self.status(lid), "</checkin>"]
        self._last[lid] = time.time()
        if due:
            self.town.checks.asked(lid, [s["id"] for s in due])
        try:
            self.town.agents.say(a["id"], "\n".join(out), "queue", origin="town")
        except AgentError:
            pass

    def start(self) -> None:
        if self._thread:
            return
        self._halt.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="leads")
        self._thread.start()

    def stop(self) -> None:
        self._halt.set()
        self._thread = None

    def _loop(self) -> None:
        first = True  # the town has just started: bring the leads up before the first check-in round is due
        while not self._halt.wait(1 if first else self.s.lead_tick):
            for ln in self.db.q("select id from lines where status in ('running', 'linked') order by seq"):
                try:  # one project's trouble must not stop the others' leads
                    self.ensure(ln["id"])
                    a = self.agent(ln["id"], "lead")
                    if a and not first and self.settings(ln["id"])["on"]:
                        self.look(a)
                except Exception:  # noqa: BLE001
                    continue
            first = False
