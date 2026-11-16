"""The depot district: one depot per repository, its docs and code indexed for RAG. The sample repos
come from data/sample_repos.json; real repos synced into `repos` and `repo_docs` take their place.
"""

from __future__ import annotations

import json
from pathlib import Path

from .db import DB
from .library import terms_of

SAMPLE = Path(__file__).parent / "data" / "sample_repos.json"


class Depots:
    def __init__(self, db: DB):
        self.db = db
        if not db.val("select count(*) from repos"):
            self.load(json.loads(SAMPLE.read_text(encoding="utf-8"))["repos"], sample=True)

    def load(self, repos: list[dict], sample: bool = False) -> None:
        with self.db.lock:
            c = self.db.conn
            for r in repos:
                docs = r.get("docs", {})
                data = {k: v for k, v in r.items() if k != "docs"} | {"sample": sample}
                c.execute("insert or replace into repos(id, repo, label, accent, data) values (?,?,?,?,?)",
                          (r["id"], r["repo"], r["label"], r["accent"], json.dumps(data, ensure_ascii=False)))
                for path, text in docs.items():
                    cur = c.execute("insert into repo_docs(repo_id, path, text) values (?,?,?)", (r["id"], path, text))
                    c.execute("insert into repo_fts(rowid, path, text) values (?,?,?)", (cur.lastrowid, path, text))
            c.commit()

    def all(self) -> list[dict]:
        return [r["data"] for r in self.db.q("select data from repos order by id")]

    def get(self, rid: str) -> dict | None:
        r = self.db.one("select data from repos where id = ? or repo = ? or label = ?", rid, rid, rid)
        return r["data"] if r else None

    def search(self, query: str, repo: str | None = None, top_k: int = 5) -> dict:
        terms = terms_of(query)
        if not terms:
            return {"query": query, "hits": []}
        match = " OR ".join(f'"{t}"' for t in terms)
        sql = ("select d.repo_id, d.path, d.text, bm25(repo_fts) as rank from repo_fts join repo_docs d on d.id = repo_fts.rowid"
               " where repo_fts match ?" + (" and d.repo_id = ?" if repo else "") + " order by rank limit ?")
        rid = (self.get(repo) or {}).get("id") if repo else None
        rows = self.db.q(sql, match, *([rid] if repo else []), top_k)
        repos = {r["id"]: r for r in self.all()}
        return {"query": query, "hits": [{"repo_id": r["repo_id"], "repo": repos[r["repo_id"]]["repo"], "path": r["path"],
                                          "snippet": r["text"][:400], "sample": repos[r["repo_id"]].get("sample", False)}
                                         for r in rows]}
