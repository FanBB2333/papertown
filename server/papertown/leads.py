"""Each project's lead: an agent that keeps its project moving, acting on the <checkin> messages
sent when the project's stages, jobs, workers or open questions change (or it sits still too long).
Messages between agents (`pt tell`) pass the work boundaries (bounds.py) first.

    data/projects/<project>/lead.json    whether it gets check-ins, and how long a quiet spell is
"""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime
from typing import TYPE_CHECKING

from .agents import AgentError, ROLES
from .db import now, read_json
from .nvidb import as_farm_job

if TYPE_CHECKING:
    from .town import Town

NAMES = {role: ROLES[role]["name"] for role in ("assistant", "lead", "coder", "writer")}
STATUS = {"hatching": "孵化中", "waiting": "等你决定", "running": "在做", "paused": "暂停", "done": "已出厂", "failed": "出错",
          "dropped": "放弃了", "linked": "本地项目"}
STAGE = {"todo": "没开始", "run": "进行中", "wait": "等你", "done": "完成"}
JOB = {"queued": "排队", "running": "在跑", "done": "完成", "failed": "失败", "cancelled": "已取消"}
CHECK = {"pass": "通过", "warn": "有问题", "fail": "没过"}
TASK = {"sent": "已经发出", "done": "完成", "blocked": "卡住了"}
WORKER = {"working": "在干活", "idle": "空闲", "starting": "启动中", "error": "出错", "stopped": "没在运行", "offline": "连不上（Paseo 没在运行）"}
YES = ("可以", "允许", "同意", "好", "行", "yes", "ok", "y")
DEFAULTS = {"supervise": True, "every": 60}  # every: minutes of quiet before a check-in comes anyway
QUIET_MAX = 3  # check-ins in a row with nothing new, then quiet until something happens
ACTIVE = ("running", "linked")


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
        self._halt = threading.Event()
        self._thread: threading.Thread | None = None

    def settings(self, line_id: str) -> dict:
        d = read_json(self.s.projects_dir / line_id / "lead.json", {})
        return DEFAULTS | {k: v for k, v in d.items() if k in DEFAULTS}

    def configure(self, line_id: str, supervise: bool | None = None, every: int | None = None) -> dict:
        d = self.settings(line_id)
        if supervise is not None:
            d["supervise"] = bool(supervise)
        if every is not None:
            d["every"] = max(10, min(24 * 60, int(every)))
        p = self.s.projects_dir / line_id / "lead.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
        return d

    def view(self, line_id: str) -> dict:
        a = self.town.agents.get(f"lead-{line_id}")
        return {"agent": self.town.agents.public(a), "settings": self.settings(line_id),
                "reports": self.reports(line_id, 30), "asks": self.asks(line_id)}

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
        if not a:
            seq = self.db.val("select seq from lines where id = ?", lid)
            raise LeadError(f"#{seq} 的{NAMES[role]}还没有启动，请用户先在「员工」面板里启动它")
        if a["runtime"] == "pi" and not self.town.agents.alive(a):
            raise LeadError(f"{self._who(a)}（pi）没在运行，请用户在「员工」面板里启动它")
        return a

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
        out.append("工序：" + " · ".join(f"{s['name']}{'✓' if s['status'] == 'done' else '▶' if s['status'] == 'run' else '?' if s['status'] == 'wait' else ''}"
                                        for s in snap["stages"]))
        out.append("")
        out.append("这个项目的 agent：")
        for role in ("lead", "coder", "writer"):
            a = self.agent(line_id, role)
            if not a:
                out.append(f"- {NAMES[role]}：还没有启动")
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
        reps = [r for r in self.reports(line_id, 12) if r["kind"] == "report"][-3:]
        if reps:
            out += ["", "最近的汇报："]
            out += [f"- {_ago(r['ts'])}{'【关键】' if r['data'].get('key') else ''}：{clip(r['data']['text'], 200)}" for r in reps]
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
        while not self._halt.wait(self.s.lead_tick):
            for a in self.db.q("select * from agents where role = 'lead' and node_id is null and runtime is not null"):
                try:
                    self.look(a)
                except Exception:  # noqa: BLE001 - one project's trouble must not stop the others' check-ins
                    continue
