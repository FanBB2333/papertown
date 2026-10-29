"""papertown serve | ingest | mcp | skills | demo"""

from __future__ import annotations

import argparse
import json
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
    a = p.parse_args()

    if a.cmd == "serve":
        import uvicorn
        from .api import create_app
        uvicorn.run(create_app(), host=a.host, port=a.port)
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
