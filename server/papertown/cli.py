"""papertown serve | ingest | mcp | skills | demo | job"""

from __future__ import annotations

import argparse
import json
import os
import time


def main() -> None:
    p = argparse.ArgumentParser(prog="papertown")
    sub = p.add_subparsers(dest="cmd", required=True)
    sv = sub.add_parser("serve", help="start the API (and the built web app)")
    sv.add_argument("--host", default="127.0.0.1")
    sv.add_argument("--port", type=int, default=8000)
    ig = sub.add_parser("ingest", help="pull papers from arXiv into the library")
    ig.add_argument("query", nargs="+")
    ig.add_argument("--max", type=int, default=50)
    ig.add_argument("--refs", action="store_true", help="also fetch citation edges from Semantic Scholar")
    sub.add_parser("mcp", help="serve Papertown's own tools over MCP (stdio)")
    sub.add_parser("skills", help="list skills")
    dm = sub.add_parser("demo", help="run one idea through the whole line, without the server")
    dm.add_argument("idea", nargs="?", default="让 VLA 模型用结构化的场景图做长程规划，减少多步任务里的误差累积")
    jb = sub.add_parser("job", help="submit or list experiments on a running server's farm")
    jb.add_argument("action", choices=["submit", "list"])
    jb.add_argument("--line", help="project id, e.g. line_1")
    jb.add_argument("--name", default="job")
    jb.add_argument("--server", default=os.environ.get("PAPERTOWN_URL", "http://127.0.0.1:8000"))
    jb.add_argument("command", nargs=argparse.REMAINDER, help="after --: the shell command")
    a = p.parse_args()

    if a.cmd == "serve":
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
    elif a.cmd == "mcp":
        from .mcp_server import serve
        serve()
    elif a.cmd == "skills":
        from .config import Settings
        from .skills import SkillRegistry
        for s in SkillRegistry(Settings().skills_dir).all():
            print(f"{s.name:22} {','.join(s.roles):18} {s.description[:60]}")
    elif a.cmd == "demo":
        from .town import Town
        town = Town()
        town.start()
        try:
            line = town.pipeline.submit_idea(a.idea)
            wait(town, line["id"], {"waiting", "failed"})
            print(json.dumps(town.pipeline.item(line["id"], "hatch"), ensure_ascii=False, indent=1)[:1500])
            town.pipeline.hatch(line["id"])
            wait(town, line["id"], {"done", "failed"})
            snap = town.pipeline.snapshot(line["id"])
            print(f"{snap['status']}: {snap['title']}  files={snap['files']}  spent=${snap['spent']:.4f}")
        finally:
            town.stop()


def wait(town, line_id: str, until: set[str], timeout: float = 900) -> None:
    t0 = time.time()
    while time.time() - t0 < timeout:
        if town.pipeline.line(line_id)["status"] in until and not town.pipeline.running(line_id):
            return
        time.sleep(0.3)
    raise TimeoutError(line_id)


if __name__ == "__main__":
    main()
