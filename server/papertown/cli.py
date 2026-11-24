"""papertown (the TUI) | tui | serve | ingest | mcp | skills | job | key"""

from __future__ import annotations

import argparse
import os
import time


def main() -> None:
    p = argparse.ArgumentParser(prog="papertown", description="On its own, `papertown` opens the town in this terminal (as `papertown tui`).")
    sub = p.add_subparsers(dest="cmd")
    tu = sub.add_parser("tui", help="the town in this terminal: projects, jobs, GPUs, staff, chat (the default)")
    tu.add_argument("--server", default=os.environ.get("PAPERTOWN_URL", "http://127.0.0.1:8000"))
    tu.add_argument("--no-start", action="store_true", help="don't start a server when none answers")
    sv = sub.add_parser("serve", help="start the API (and the built web app)")
    sv.add_argument("--host", default="127.0.0.1")
    sv.add_argument("--port", type=int, default=8000)
    ig = sub.add_parser("ingest", help="pull papers from arXiv into the library")
    ig.add_argument("query", nargs="+")
    ig.add_argument("--max", type=int, default=50)
    ig.add_argument("--refs", action="store_true", help="also fetch citation edges from Semantic Scholar")
    sub.add_parser("mcp", help="serve Papertown's own tools over MCP (stdio)")
    sub.add_parser("skills", help="list skills")
    jb = sub.add_parser("job", help="submit or list experiments on a running server's farm")
    jb.add_argument("action", choices=["submit", "list"])
    jb.add_argument("--line", help="project id, e.g. line_1")
    jb.add_argument("--name", default="job")
    jb.add_argument("--server", default=os.environ.get("PAPERTOWN_URL", "http://127.0.0.1:8000"))
    jb.add_argument("command", nargs=argparse.REMAINDER, help="after --: the shell command")
    ky = sub.add_parser("key", help="access keys for the iPhone and Mac apps and other devices")
    ky.add_argument("action", choices=["create", "list", "revoke"])
    ky.add_argument("id", nargs="?", help="revoke: the key's id, from `papertown key list`")
    ky.add_argument("--name", default="", help="create: the device it is for, e.g. iPhone")
    a = p.parse_args()

    if a.cmd in (None, "tui"):
        from .tui import run
        run(getattr(a, "server", None), start=not getattr(a, "no_start", False))
    elif a.cmd == "serve":
        import uvicorn
        from .api import create_app
        os.environ.setdefault("PAPERTOWN_URL", f"http://{'127.0.0.1' if a.host in ('0.0.0.0', '::') else a.host}:{a.port}")
        uvicorn.run(create_app(), host=a.host, port=a.port)
    elif a.cmd == "job":
        import httpx
        if a.action == "list":
            r = httpx.get(f"{a.server}/api/jobs", params={"line_id": a.line} if a.line else None)
            for j in r.json()["jobs"]:
                print(f"{j['id']}  {j['status']:9} {j['progress']:3}%  {j['backend']:5}  {j['line_id'] or '-':8}  {j['name']}")
        else:
            cmd = " ".join(x for x in a.command if x != "--")
            r = httpx.post(f"{a.server}/api/jobs", json={"name": a.name, "command": cmd, "line_id": a.line})
            print(r.json() if r.status_code == 200 else r.json().get("detail"))
    elif a.cmd == "ingest":
        from .ports import arxiv_api
        from .town import Town
        town = Town()
        added = []
        for q in a.query:
            added += town.ingest(arxiv_api.search(q, a.max), "arxiv")
            time.sleep(3.1)  # arXiv asks for one request every three seconds
        print(f"入馆 {len(added)} 篇，馆藏 {town.library.count()} 篇")
        if a.refs and added:
            print(f"引用边 {town.genealogy.fetch_references([x['arxiv_id'] for x in added])} 条")
    elif a.cmd == "key":
        key(a)
    elif a.cmd == "mcp":
        from .mcp_server import serve
        serve()
    elif a.cmd == "skills":
        from .config import Settings
        from .skills import SkillRegistry
        for s in SkillRegistry(Settings().skills_dir).all():
            print(f"{s.name:22} {','.join(s.roles):18} {s.description[:60]}")


def key(a: argparse.Namespace) -> None:
    """Keys live in the data directory's auth.json, so this works with the server running or not."""
    import sys
    from .auth import Auth, AuthError
    from .config import Settings
    auth = Auth(Settings().data_dir)
    try:
        if a.action == "create":
            k = auth.create_key(a.name)
            print(f"新的访问密钥「{k['name']}」（id {k['id']}）：\n\n    {k['key']}\n")
            print("它只显示这一次。在 App 里填服务器地址和这个密钥即可连接，地址是设备访问这台电脑用的那个，")
            print("例如 http://<这台电脑的局域网或 Tailscale 地址>:8000，服务要用 `papertown serve --host 0.0.0.0` 启动。")
        elif a.action == "list":
            keys = auth.keys()
            if not keys:
                print("还没有访问密钥：papertown key create --name iPhone")
            for k in keys:
                print(f"{k['id']}  {k['hint']}…  {k['name']:16} 创建 {k['at'][:16]}  最近使用 {(k['seen'] or '从未')[:16]}")
        else:
            if not a.id:
                sys.exit("要撤销哪一个：papertown key revoke <id>")
            auth.revoke_key(a.id)
            print(f"已撤销 {a.id}，用它连接的设备将无法再访问")
    except AuthError as e:
        sys.exit(str(e))


if __name__ == "__main__":
    main()
