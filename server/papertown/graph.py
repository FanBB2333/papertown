"""The genealogy hall: a graph over papers (and, later, repos).

Edges:
  cites    paper -> reference, from Semantic Scholar (`papertown ingest --refs`, needs
           network and ideally S2_API_KEY; the public API rate-limits hard)
  similar  paper <-> paper, the top lexical neighbours, computed at ingest so the graph
           is never empty offline. These are "close to", not "descends from", and the
           UI labels them that way.
"""

from __future__ import annotations

import os
from collections import deque

import httpx

from .db import DB
from .library import Library

S2_BATCH = "https://api.semanticscholar.org/graph/v1/paper/batch"


class Genealogy:
    def __init__(self, db: DB, library: Library):
        self.db = db
        self.library = library

    def add(self, src: str, dst: str, kind: str, weight: float = 1.0, title: str | None = None) -> None:
        self.db.x("insert or ignore into edges(src, dst, kind, weight, title) values (?,?,?,?,?)", src, dst, kind, weight, title)

    def link_similar(self, papers: list[dict], k: int = 3) -> int:
        n = 0
        for p in papers:
            for other, w in self.library.similar_to(p, k):
                if w >= 0.3:
                    self.add(f"arxiv:{p['arxiv_id']}", f"arxiv:{other['arxiv_id']}", "similar", w)
                    n += 1
        return n

    def fetch_references(self, arxiv_ids: list[str], timeout: float = 30) -> int:
        """One batch call per 500 papers. Raises httpx errors (429 without a key is common)."""
        headers = {"x-api-key": os.environ["S2_API_KEY"]} if os.environ.get("S2_API_KEY") else {}
        n = 0
        for i in range(0, len(arxiv_ids), 500):
            chunk = arxiv_ids[i:i + 500]
            r = httpx.post(S2_BATCH, params={"fields": "references.title,references.externalIds,references.year"},
                           json={"ids": [f"ARXIV:{a}" for a in chunk]}, headers=headers, timeout=timeout)
            r.raise_for_status()
            for aid, paper in zip(chunk, r.json()):
                for ref in (paper or {}).get("references") or []:
                    ext = ref.get("externalIds") or {}
                    dst = f"arxiv:{ext['ArXiv']}" if ext.get("ArXiv") else f"s2:{ref.get('paperId')}"
                    if dst.endswith(":None"):
                        continue
                    self.add(f"arxiv:{aid}", dst, "cites", 1.0, f"{ref.get('title') or ''} ({ref.get('year') or ''})".strip())
                    n += 1
        return n

    def expand(self, node_ids: list[str], depth: int = 1, limit: int = 40) -> dict:
        depth = max(1, min(depth, 3))
        seen = {i: 0 for i in node_ids}
        edges, q = [], deque(node_ids)
        while q and len(seen) < limit:
            cur = q.popleft()
            if seen[cur] >= depth:
                continue
            rows = self.db.q("select * from edges where src = ? or (dst = ? and kind = 'similar') limit 20", cur, cur)
            for e in rows:
                other = e["dst"] if e["src"] == cur else e["src"]
                edges.append({"src": e["src"], "dst": e["dst"], "kind": e["kind"], "weight": e["weight"]})
                if other not in seen and len(seen) < limit:
                    seen[other] = seen[cur] + 1
                    q.append(other)
        papers = {f"arxiv:{p['arxiv_id']}": p for p in self.library.get([i for i in seen if i.startswith("arxiv:")])}
        titles = {e["dst"]: e["title"] for e in self.db.q("select dst, title from edges where kind = 'cites'") if e["title"]}
        nodes = [{"id": i, "title": papers[i]["title"] if i in papers else titles.get(i, i), "in_library": i in papers,
                  "year": (papers[i]["published"] or "")[:4] if i in papers else "", "hop": h} for i, h in seen.items()]
        kinds = {e["kind"] for e in edges}
        return {"nodes": nodes, "edges": edges, "summary": f"{len(nodes)} 个节点" + ("（含引用）" if "cites" in kinds else "（相近关系）" if edges else "")}

    def stats(self) -> dict:
        return {r["kind"]: r["c"] for r in self.db.q("select kind, count(*) as c from edges group by kind")}
