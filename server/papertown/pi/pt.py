#!/usr/bin/env python3
"""Papertown from inside an agent's shell, for agents that run in Paseo: read the project
brief, submit experiments to the farm and check on them. The server passes
PAPERTOWN_URL, PAPERTOWN_AGENT and PAPERTOWN_AGENT_TOKEN in the agent's environment; a
conversation imported from Paseo has none of them and reads link.json next to this file.

    .papertown/pt brief
    .papertown/pt submit main -- python run.py --seed 0
    .papertown/pt jobs [job_id]
"""

import json
import os
import sys
import urllib.error
import urllib.request


def link():
    if os.environ.get("PAPERTOWN_AGENT_TOKEN"):
        return os.environ["PAPERTOWN_URL"], os.environ["PAPERTOWN_AGENT"], os.environ["PAPERTOWN_AGENT_TOKEN"]
    try:
        with open(os.path.join(os.path.dirname(os.path.realpath(__file__)), "link.json"), encoding="utf-8") as f:
            d = json.load(f)
    except OSError:
        sys.exit("找不到 Papertown：环境里没有 PAPERTOWN_* 变量，旁边也没有 link.json")
    return d["url"], d["agent"], d["token"]


def call(path, body=None):
    url, agent, token = link()
    base = url.rstrip("/") + "/api/bridge/" + agent
    req = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(),
                                 headers={"content-type": "application/json", "x-papertown-token": token},
                                 method="GET" if body is None else "POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(json.load(e).get("detail", str(e)))


def main(a):
    if not a or a[0] in ("-h", "--help"):
        print(__doc__)
    elif a[0] == "brief":
        print(call("/brief")["text"])
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
    else:
        sys.exit(f"没有这个命令：{a[0]}")


if __name__ == "__main__":
    main(sys.argv[1:])
