#!/usr/bin/env python3
"""Papertown from inside an agent's shell, for agents that run in Paseo: read the project
brief, submit experiments to the farm and check on them. The server passes
PAPERTOWN_URL, PAPERTOWN_AGENT and PAPERTOWN_AGENT_TOKEN in the agent's environment; a
conversation imported from Paseo has none of them and reads link.json next to this file.

    .papertown/pt brief
    .papertown/pt submit main -- python run.py --seed 0
    .papertown/pt jobs [job_id]
    .papertown/pt rules                      your work boundaries: must, never, ask first

The console's assistant has more (see its AGENTS.md):

    .papertown/pt page                       what the user is looking at
    .papertown/pt get /api/lines/line_6      any of Papertown's endpoints, read only
    .papertown/pt brief [line]
    .papertown/pt ask "question" [--choice X]... [--point]
    .papertown/pt show [--mod exp] [--line line_6] [--file code:path[:line]] [--job id] [--ref ref]
    .papertown/pt actions
    .papertown/pt do <action> [key=value]... [--why "..."]

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
CLIP = 40000  # characters of an endpoint's answer
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
    except (urllib.error.URLError, OSError) as e:
        if not os.path.isdir(os.path.join(HERE, "q")):  # only the assistant has a relay
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


def main(a):
    if not a or a[0] in ("-h", "--help"):
        print(__doc__)
    elif a[0] == "brief":
        print(call("/brief" + (f"?line={quote(a[1])}" if len(a) > 1 else ""))["text"])
    elif a[0] == "submit":
        if "--" not in a or a.index("--") < 2:
            sys.exit("用法：pt submit <name> [--backend local] -- <command>")
        i = a.index("--")
        opts = a[2:i]
        backend = opts[opts.index("--backend") + 1] if "--backend" in opts else "local"
        j = call("/jobs", {"name": a[1], "command": " ".join(a[i + 1:]), "backend": backend})
        print(f"已提交 {j['id']}（{j['name']}，{j['backend']}），状态 {j['status']}。用 pt jobs {j['id']} 查看。")
    elif a[0] == "jobs":
        print(call(f"/jobs/{a[1]}" if len(a) > 1 else "/jobs")["text"])
    elif a[0] == "rules":
        print(call("/rules")["text"])
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
