#!/usr/bin/env python3
"""Papertown from inside an agent's shell, for agents that run in Paseo: read the project
brief, submit experiments to the farm and check on them. The server passes
PAPERTOWN_URL, PAPERTOWN_AGENT and PAPERTOWN_AGENT_TOKEN in the agent's environment; a
conversation imported from Paseo has none of them and reads link.json next to this file.

    .papertown/pt brief
    .papertown/pt submit main -- python run.py --seed 0
    .papertown/pt jobs [job_id]
    .papertown/pt rules                      your work boundaries: must, never, ask first
    .papertown/pt ask "question" [--choice X]...   ask the user, in the project
    .papertown/pt tell lead "..." [--now]    a worker to its project's lead

A project's lead also has:

    .papertown/pt status                     where the project stands
    .papertown/pt worker coder|writer [n]    a worker's last messages
    .papertown/pt tell coder|writer "..." [--now]
    .papertown/pt report "..." [--key]       a report for the user
    .papertown/pt reports                    the project's reports and questions
    .papertown/pt card                       its card on the 进展 page: the fields and the card as it is
    .papertown/pt card set '<json>'|file.json   write the card, when the user asked for it
    .papertown/pt check <id> pass|warn|fail "reason"   a soft check's verdict
    .papertown/pt hire coder|writer [--runtime R] [--cli C] [--model M] [--thinking T]
                                             start the project's coder or writer
    .papertown/pt stage                      the project's stages: whose they are, what is handed in, which gate holds
    .papertown/pt stage run|done|todo <stage> ["note"] [--pct N]
                                             open a stage or write its progress, close it, put it back
    .papertown/pt survey                     the novelty scan, by code: the closest papers and the verdict
    .papertown/pt library "keywords" [--top N]   search the library

Any agent of a project has:

    .papertown/pt recall "..."               search the project: its card, reports, jobs, code, paper
                                             and the agent conversations and notes imported for it
    .papertown/pt publish page.html ["title"] [--kind report|explain]
                                             a page in HTML for the user, under 汇报与讲解 in 进展
                                             (the assistant adds --line <project>)
    .papertown/pt checks [run]               the project's checks: hard ones and where they fail
                                             (run: check again now), soft ones and the lead's verdicts
    .papertown/pt tasks                      the tasks the user put on the project's canvas for you
    .papertown/pt tell task:<id> "..."       to another task's assigned agent in the same project
    .papertown/pt task <id> done|blocked "…" close one: what came of it, or why it is stuck
    .papertown/pt output <stage> '<json>'|@file.json   hand in a stage's output (the lead: any stage; a worker: its own)

The console's assistant has more (see its AGENTS.md):

    .papertown/pt page                       what the user is looking at
    .papertown/pt get /api/lines/line_6      any of Papertown's endpoints, read only
    .papertown/pt brief [line]
    .papertown/pt ask "question" [--choice X]... [--point]
    .papertown/pt show [--mod exp] [--line line_6] [--file code:path[:line]] [--job id] [--ref ref]
    .papertown/pt actions
    .papertown/pt do <action> [key=value]... [--why "..."]
    .papertown/pt status|reports <line>      where a project stands; its reports and questions
    .papertown/pt worker coder|writer --line <line>
    .papertown/pt tell <line> "..." [--now]   to a project's lead ("<line> coder": to a worker)
    .papertown/pt answer <question> "..."    your answer, passed on to the agent that asked

When the shell has no network (Codex's sandbox), the assistant's requests go as files in
q/ beside this script; the server answers each one in a/.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from urllib.parse import quote

HERE = os.path.dirname(os.path.realpath(__file__))
CLIP = 40000
# Papertown runs on this machine: never through a system proxy, which macOS hands urllib
OPEN = urllib.request.build_opener(urllib.request.ProxyHandler({})).open


def link():
    if os.environ.get("PAPERTOWN_AGENT_TOKEN"):
        return os.environ["PAPERTOWN_URL"], os.environ["PAPERTOWN_AGENT"], os.environ["PAPERTOWN_AGENT_TOKEN"]
    try:
        with open(os.path.join(HERE, "link.json"), encoding="utf-8") as f:
            d = json.load(f)
    except OSError:
        sys.exit("找不到 Papertown：环境里没有 PAPERTOWN_* 变量，旁边也没有 link.json")
    return d["url"], d["agent"], d["token"]


# Only scalar lifecycle metadata leaves the CLI process. Never include conversation content.
HOOK_FIELDS = {"hook_event_name", "event", "type", "session_id", "thread-id", "conversation_id",
               "notification_type", "tool_name", "agent_state", "tool_confirmation_pending",
               "agent_id", "source", "transcript_path"}


def hook(provider, args):
    try:
        raw = json.loads(args[-1] if provider == "codex" and args else sys.stdin.read())
        data = {k: v for k, v in raw.items() if k in HOOK_FIELDS and isinstance(v, (str, bool, int, float))}
        url, agent, token = link()
        body = {"provider": provider, "data": data}
        if provider == "agy":
            state = json.dumps({k: data.get(k) for k in ("conversation_id", "agent_state", "tool_confirmation_pending", "tool_name")}, sort_keys=True)
            cache = os.path.join(HERE, "hook-agy.json")
            try:
                with open(cache, encoding="utf-8") as f:
                    if f.read() == state:
                        return
            except OSError:
                pass
        req = urllib.request.Request(url.rstrip("/") + "/api/agents/" + quote(agent, safe="") + "/hook",
            data=json.dumps(body).encode(), headers={"content-type": "application/json", "x-papertown-token": token}, method="POST")
        with OPEN(req, timeout=2):
            pass
        if provider == "agy":
            tmp = cache + "." + uuid.uuid4().hex
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(state)
            os.replace(tmp, cache)
    except (Exception, SystemExit):
        pass
    finally:
        if provider == "agy":
            print("Papertown")


def call(path, body=None):
    """A bridge call (a path like /brief) or one of the public endpoints (/api/...)."""
    url, agent, token = link()
    full = path if path.startswith("/api/") else "/api/bridge/" + agent + path
    req = urllib.request.Request(url.rstrip("/") + full, data=None if body is None else json.dumps(body).encode(),
                                 headers={"content-type": "application/json", "x-papertown-token": token},
                                 method="GET" if body is None else "POST")
    try:
        with OPEN(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            detail = json.load(e).get("detail")
        except ValueError:
            detail = None
        sys.exit(detail or str(e))
    except OSError as e:
        if not os.path.isdir(os.path.join(HERE, "q")):
            sys.exit(f"连不上 Papertown（{url}）：{e}")
        return by_files(full, body, token)


def by_files(path, body, token):
    rid = uuid.uuid4().hex
    tmp, req = os.path.join(HERE, "q", rid + ".tmp"), os.path.join(HERE, "q", rid + ".json")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"method": "GET" if body is None else "POST", "path": path, "body": body, "token": token}, f, ensure_ascii=False)
    os.replace(tmp, req)
    ans = os.path.join(HERE, "a", rid + ".json")
    t0 = time.time()
    while time.time() - t0 < 60:
        if os.path.exists(ans):
            with open(ans, encoding="utf-8") as f:
                out = json.load(f)
            os.unlink(ans)
            if out.get("status", 200) >= 400:
                sys.exit((out.get("body") or {}).get("detail") or f"Papertown {out.get('status')}")
            return out.get("body")
        time.sleep(0.15)
    try:
        os.unlink(req)
    except OSError:
        pass
    sys.exit("Papertown 没有回应：它在运行吗？")


def local(name, missing):
    """A file the server keeps next to this script (the page, the list of actions)."""
    try:
        with open(os.path.join(HERE, name), encoding="utf-8") as f:
            return f.read()
    except OSError:
        return missing


def options(args, many=("--choice",), flags=("--point",)):
    """--key value pairs and bare flags; the rest stays positional."""
    opts, rest, i = {}, [], 0
    while i < len(args):
        a = args[i]
        if a in flags:
            opts[a[2:]] = True
        elif a.startswith("--") and i + 1 < len(args):
            if a in many:
                opts.setdefault(a[2:], []).append(args[i + 1])
            else:
                opts[a[2:]] = args[i + 1]
            i += 1
        else:
            rest.append(a)
        i += 1
    return opts, rest


def task_args(args):
    """`pt task`'s words and its --dispatch: only that one option is taken out, so a result may itself contain
    words that start with --."""
    rest = list(args)
    if "--dispatch" in rest:
        i = len(rest) - 1 - rest[::-1].index("--dispatch")
        if i + 1 < len(rest):
            dispatch = rest[i + 1]
            del rest[i:i + 2]
            return rest, dispatch
    return rest, None


def read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except (OSError, UnicodeDecodeError) as e:
        sys.exit(f"读不了 {path}：{e}")


def main(a):
    if a[:1] == ["hook"]:
        if len(a) > 1 and a[1] in ("claude", "codex", "agy"):
            hook(a[1], a[2:])
        return
    if not a or a[0] in ("-h", "--help"):
        print(__doc__)
    elif a[0] in ("brief", "status", "reports"):
        print(call(f"/{a[0]}" + (f"?line={quote(a[1])}" if len(a) > 1 else ""))["text"])
    elif a[0] == "submit":
        if "--" not in a or a.index("--") < 2:
            sys.exit("用法：pt submit <name> [--backend local] -- <command>")
        i = a.index("--")
        opts = a[2:i]
        backend = opts[opts.index("--backend") + 1] if "--backend" in opts else "local"
        j = call("/jobs", {"name": a[1], "command": " ".join(a[i + 1:]), "backend": backend})
        print(j.get("text") or f"已提交 {j['id']}（{j['name']}，{j['backend']}），状态 {j['status']}。用 pt jobs {j['id']} 查看。")
    elif a[0] == "jobs":
        print(call(f"/jobs/{a[1]}" if len(a) > 1 else "/jobs")["text"])
    elif a[0] == "rules":
        print(call("/rules")["text"])
    elif a[0] == "worker":
        opts, rest = options(a[1:], many=(), flags=())
        if not rest:
            sys.exit("用法：pt worker coder|writer [条数] [--line 项目]")
        q = {**({"n": rest[1]} if len(rest) > 1 else {}), **({"line": opts["line"]} if opts.get("line") else {})}
        print(call(f"/worker/{quote(rest[0])}" + ("?" + "&".join(f"{k}={quote(str(v))}" for k, v in q.items()) if q else ""))["text"])
    elif a[0] == "answer":
        if len(a) < 3:
            sys.exit('用法：pt answer <问题编号> "回答"')
        print(call("/answer", {"id": a[1], "text": " ".join(a[2:])})["text"])
    elif a[0] == "tell":
        opts, rest = options(a[1:], many=(), flags=("--now",))
        if len(rest) < 2:
            sys.exit('用法：pt tell <收件人> "消息" [--now]')
        print(call("/tell", {"to": rest[0], "text": " ".join(rest[1:]), "now": bool(opts.get("now"))})["text"])
    elif a[0] == "report":
        opts, rest = options(a[1:], many=(), flags=("--key",))
        if not rest:
            sys.exit('用法：pt report "汇报" [--key]')
        print(call("/report", {"text": " ".join(rest), "key": bool(opts.get("key"))})["text"])
    elif a[0] == "card":
        if len(a) == 1:
            print(call("/card")["text"])
        elif a[1] == "set" and len(a) > 2:
            raw = " ".join(a[2:]).strip()
            if not raw.startswith("{"):
                raw = read(raw)
            try:
                card = json.loads(raw)
            except ValueError as e:
                sys.exit(f"卡片不是合法的 JSON：{e}")
            print(call("/card", {"card": card})["text"])
        else:
            sys.exit("用法：pt card | pt card set '<JSON>' | pt card set 文件.json")
    elif a[0] == "checks":
        opts, rest = options(a[1:], many=(), flags=())
        q = f"?line={quote(opts['line'])}" if opts.get("line") else ""
        print((call("/checks/run" + q, {}) if rest[:1] == ["run"] else call("/checks" + q))["text"])
    elif a[0] == "tasks":
        print(call("/tasks")["text"])
    elif a[0] == "task":
        rest, dispatch = task_args(a[1:])
        if len(rest) < 3 or rest[1] not in ("done", "blocked"):
            sys.exit('用法：pt task <编号> done|blocked "结果或原因" [--dispatch 本轮编号]')
        print(call("/task", {"id": rest[0], "status": rest[1], "text": " ".join(rest[2:]), "dispatch": dispatch})["text"])
    elif a[0] == "check":
        if len(a) < 4 or a[2] not in ("pass", "warn", "fail"):
            sys.exit('用法：pt check <编号> pass|warn|fail "理由"')
        print(call("/check", {"id": a[1], "status": a[2], "text": " ".join(a[3:])})["text"])
    elif a[0] == "hire":
        opts, rest = options(a[1:], many=(), flags=())
        if len(rest) != 1:
            sys.exit("用法：pt hire coder|writer [--runtime paseo|herdr|tmux|headless] [--cli claude|codex|antigravity] [--model 模型] [--thinking 强度]")
        print(call("/hire", {"role": rest[0], "runtime": opts.get("runtime"), "provider": opts.get("cli") or opts.get("provider"),
                             "model": opts.get("model"), "thinking": opts.get("thinking")})["text"])
    elif a[0] == "stage":
        opts, rest = options(a[1:], many=(), flags=())
        if not rest:
            print(call("/stage" + (f"?line={quote(opts['line'])}" if opts.get("line") else ""))["text"])
        elif rest[0] in ("run", "done", "todo") and len(rest) >= 2:
            pct = opts.get("pct")
            if pct is not None and not pct.isdigit():
                sys.exit("--pct 是 0 到 100 的整数")
            print(call("/stage", {"stage": rest[1], "status": rest[0], "note": " ".join(rest[2:]) or None, "pct": int(pct) if pct else None})["text"])
        else:
            sys.exit('用法：pt stage | pt stage run|done|todo <工序> ["说明"] [--pct 0-99]')
    elif a[0] == "output":
        if len(a) < 3:
            sys.exit("用法：pt output <工序> '<JSON>' | pt output <工序> @文件.json")
        raw = " ".join(a[2:]).strip()
        raw = read(raw[1:]) if raw.startswith("@") else raw if raw.startswith("{") else read(raw)
        try:
            body = json.loads(raw)
        except ValueError as e:
            sys.exit(f"产出不是合法的 JSON：{e}")
        print(call("/output", {"stage": a[1], "body": body})["text"])
    elif a[0] == "survey":
        print(call("/survey" + (f"?line={quote(a[1])}" if len(a) > 1 else ""))["text"])
    elif a[0] == "library":
        opts, rest = options(a[1:], many=(), flags=())
        if not rest:
            sys.exit('用法：pt library "英文关键词" [--top 8]')
        print(call("/library?q=" + quote(" ".join(rest)) + (f"&top={quote(opts['top'])}" if opts.get("top") else ""))["text"])
    elif a[0] == "recall":
        if len(a) < 2:
            sys.exit('用法：pt recall "要找的"')
        print(call("/recall?q=" + quote(" ".join(a[1:])))["text"])
    elif a[0] == "publish":
        opts, rest = options(a[1:], many=(), flags=())
        if not rest or not os.path.isfile(rest[0]):
            sys.exit('用法：pt publish 页面.html ["标题"] [--kind report|explain]（小助手加 --line <项目>）')
        print(call("/publish", {"html": read(rest[0]), "title": " ".join(rest[1:]).strip(), "kind": opts.get("kind") or "explain",
                                "line": opts.get("line")})["text"])
    elif a[0] == "page":
        print(local("page.md", "用户还没在侧边栏里发过消息，不知道他在看哪一页。"))
    elif a[0] == "actions":
        print(local("actions.md", "") or call("/actions")["text"])
    elif a[0] == "get":
        if len(a) < 2 or not a[1].startswith("/api/"):
            sys.exit("用法：pt get /api/...")
        text = json.dumps(call(a[1]), ensure_ascii=False, indent=1)
        print(text if len(text) <= CLIP else text[:CLIP] + f"\n…（截断了，全文 {len(text)} 个字符；换个更具体的接口）")
    elif a[0] == "ask":
        opts, rest = options(a[1:])
        if not rest:
            sys.exit('用法：pt ask "问题" [--choice 选项]… [--point]')
        print(call("/ask", {"question": " ".join(rest), "choices": opts.get("choice", []), "point": bool(opts.get("point"))})["text"])
    elif a[0] == "show":
        opts, _ = options(a[1:], many=(), flags=())
        print(call("/show", {k: opts.get(k) for k in ("mod", "line", "file", "job", "ref", "note")})["text"])
    elif a[0] == "do":
        if len(a) < 2:
            sys.exit('用法：pt do <动作> [key=value]… [--why "为什么"]')
        opts, rest = options(a[2:], many=(), flags=())
        if rest and rest[0].startswith("{"):
            args = json.loads(" ".join(rest))
        else:
            bad = [x for x in rest if "=" not in x]
            if bad:
                sys.exit(f"参数要写成 key=value：{bad[0]}")
            args = dict(x.split("=", 1) for x in rest)
        print(call("/act", {"action": a[1], "args": args, "why": opts.get("why", "")})["text"])
    else:
        sys.exit(f"没有这个命令：{a[0]}")


if __name__ == "__main__":
    main(sys.argv[1:])
