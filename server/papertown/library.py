"""The library: the shared paper store and the main RAG index. BM25 (SQLite FTS5) recalls candidates,
then embedding cosine or idf-weighted term coverage ranks them; Chinese queries are expanded through a CS glossary.
"""

from __future__ import annotations

import json
import math
import re
import threading
from collections import Counter
from pathlib import Path
from typing import Callable, Iterable

import numpy as np

from .db import DB, now

STOP = set("""a an the of for and or in on with to via by from using towards toward is are be we our this that
these those as at into over under than then it its their can may new based approach method methods paper propose
proposed results show study task tasks model models learning large language data""".split())

GLOSSARY = {
    "视觉语言动作": "vision-language-action", "视觉语言模型": "vision-language model", "大语言模型": "large language model",
    "大模型": "large language model", "多模态": "multimodal", "场景图": "scene graph", "长程": "long-horizon",
    "长时程": "long-horizon", "任务规划": "task planning", "规划": "planning", "机器人": "robot", "具身": "embodied",
    "机械臂": "robot manipulation", "操作": "manipulation", "空间推理": "spatial reasoning", "推理加速": "inference acceleration",
    "推理": "reasoning", "检索增强": "retrieval-augmented generation", "检索": "retrieval", "知识图谱": "knowledge graph",
    "图谱": "graph", "稀疏注意力": "sparse attention", "注意力": "attention", "加速": "acceleration",
    "高效": "efficient", "缓存": "cache", "压缩": "compression", "量化": "quantization", "多智能体": "multi-agent",
    "智能体": "agent", "工具调用": "tool use", "代码生成": "code generation", "代码仓库": "code repository",
    "仓库": "repository", "扩散策略": "diffusion policy", "扩散模型": "diffusion model", "强化学习": "reinforcement learning",
    "模仿学习": "imitation learning", "记忆": "memory", "误差累积": "error accumulation",
    "误差": "error", "恢复": "recovery", "评测": "evaluation", "基准": "benchmark", "数据集": "dataset",
    "审稿": "peer review", "论文写作": "paper writing", "科研": "scientific research", "新颖性": "novelty",
    "创新性": "novelty", "分层": "hierarchical", "层级": "hierarchical", "动作": "action", "导航": "navigation",
    "视频": "video", "生成": "generation", "分割": "segmentation", "检测": "detection", "点云": "point cloud",
    "三维": "3D", "微调": "fine-tuning", "对齐": "alignment", "幻觉": "hallucination", "长上下文": "long context",
    "上下文": "context", "提示词": "prompt", "蒸馏": "distillation", "自监督": "self-supervised",
    "对比学习": "contrastive learning", "图神经网络": "graph neural network", "世界模型": "world model",
    "结构化": "structured", "增量": "incremental", "更新": "update", "协作": "collaboration", "技能": "skill",
    "编排": "orchestration", "协议": "protocol", "长序列": "long sequence", "效率": "efficiency", "显存": "memory",
}
_GLOSS = sorted(GLOSSARY, key=len, reverse=True)
WORD = re.compile(r"[a-z0-9][a-z0-9\-]*[a-z0-9]|[a-z0-9]")


def stem(w: str) -> str:
    if len(w) > 4 and w.endswith("ies"):
        return w[:-3] + "y"
    if len(w) > 3 and w.endswith("s") and not w.endswith("ss"):
        return w[:-1]
    return w


def tokens(text: str) -> list[str]:
    out = []
    for w in WORD.findall(text.lower()):
        parts = [w] + (w.split("-") if "-" in w else [])
        out.extend(stem(p) for p in parts if len(p) > 1 and p not in STOP)
    return out


def phrases(query: str) -> list[str]:
    """English phrases for a query, in the order they appear: ASCII words as written, and
    known Chinese terms translated (longest match first, so 任务规划 beats 规划)."""
    found: list[tuple[int, str]] = []
    rest = query
    for k in _GLOSS:
        for m in re.finditer(re.escape(k), rest):
            found.append((m.start(), GLOSSARY[k]))
        rest = rest.replace(k, "\0" * len(k))
    found += [(m.start(), m.group()) for m in re.finditer(r"[A-Za-z0-9][A-Za-z0-9\-\.]*[A-Za-z0-9]|[A-Za-z0-9]", rest)]
    out: dict[str, str] = {}
    for _, ph in sorted(found):
        out.setdefault(ph.lower(), ph)
    return list(out.values())


def expand(query: str) -> str:
    return " ".join(phrases(query))


def terms_of(query: str) -> list[str]:
    return list(dict.fromkeys(tokens(expand(query))))


def short_authors(a: list[str]) -> str:
    return ", ".join(a[:3]) + (" et al." if len(a) > 3 else "")


class Embedder:
    """Optional: any OpenAI-compatible /embeddings endpoint."""

    def __init__(self, base_url: str, api_key: str, model: str):
        import openai
        self.client = openai.OpenAI(base_url=base_url, api_key=api_key)
        self.model = model

    def __call__(self, texts: list[str]) -> np.ndarray:
        resp = self.client.embeddings.create(model=self.model, input=texts)
        v = np.array([d.embedding for d in resp.data], dtype=np.float32)
        return v / np.maximum(np.linalg.norm(v, axis=1, keepdims=True), 1e-9)


# retrieval options set in the library building: default hits, full-text candidates scored, rank by vectors
RAG_DEFAULTS = {"top_k": 8, "candidates": 40, "vectors": True}
RAG_LIMITS = {"top_k": (1, 30), "candidates": (5, 200)}


class Library:
    def __init__(self, db: DB, embedder: Embedder | None, opts_file: Path):
        self.db = db
        self.embedder = embedder
        self._df: Counter | None = None
        self._n = 0
        self._lock = threading.Lock()
        self.opts_file = opts_file
        self.opts = dict(RAG_DEFAULTS)
        try:
            saved = json.loads(opts_file.read_text(encoding="utf-8")) if opts_file.exists() else {}
            self.opts.update({k: v for k, v in saved.items() if k in RAG_DEFAULTS})
        except ValueError:
            pass

    def set_opts(self, **kw) -> dict:
        for k, v in kw.items():
            if k not in RAG_DEFAULTS or v is None:
                continue
            if k in RAG_LIMITS:
                lo, hi = RAG_LIMITS[k]
                v = max(lo, min(hi, int(v)))
            self.opts[k] = bool(v) if k == "vectors" else v
        self.opts_file.parent.mkdir(parents=True, exist_ok=True)
        self.opts_file.write_text(json.dumps(self.opts), encoding="utf-8")
        return self.opts

    @property
    def vectors(self) -> Embedder | None:
        return self.embedder if self.opts["vectors"] else None

    def stats(self) -> dict:
        by = {r["source"] or "?": r["n"] for r in self.db.q("select source, count(*) n from papers group by source")}
        return {"papers": self.count(), "sources": by, "vectors": self.db.val("select count(*) from paper_vecs"),
                "terms": len(self._stats()[0])}

    def _stats(self) -> tuple[Counter, int]:
        with self._lock:
            if self._df is None:
                df: Counter = Counter()
                rows = self.db.q("select title, abstract from papers")
                for r in rows:
                    df.update(set(tokens(f"{r['title']} {r['abstract']}")))
                self._df, self._n = df, len(rows)
            return self._df, self._n

    def idf(self, t: str) -> float:
        df, n = self._stats()
        return math.log((n + 1) / (df.get(t, 0) + 1)) + 1

    def coverage(self, terms: list[str], text: str) -> tuple[float, list[str]]:
        if not terms:
            return 0.0, []
        have = set(tokens(text))
        total = sum(self.idf(t) for t in terms)
        hit = [t for t in terms if t in have]
        return sum(self.idf(t) for t in hit) / total, hit

    def ingest(self, papers: Iterable[dict], source: str, tagger: Callable[[list[dict]], list[list[str]]]) -> list[dict]:
        """Dedup by arXiv id and normalised title, tag, index. Returns the papers added."""
        fresh = []
        for p in papers:
            if not p.get("arxiv_id") or not p.get("title"):
                continue
            if self.db.val("select 1 from papers where arxiv_id = ?", p["arxiv_id"]):
                continue
            if self.db.val("select 1 from papers where lower(title) = lower(?)", p["title"]):
                continue
            fresh.append(p)
        if not fresh:
            return []
        tags = tagger(fresh)
        added = []
        with self.db.lock:
            c = self.db.conn
            for p, tg in zip(fresh, tags):
                cur = c.execute(
                    "insert into papers(arxiv_id, title, abstract, authors, categories, published, url, tags, source, added_at)"
                    " values (?,?,?,?,?,?,?,?,?,?)",
                    (p["arxiv_id"], p["title"], p.get("abstract", ""), _j(p.get("authors", [])), _j(p.get("categories", [])),
                     p.get("published", ""), p.get("url", f"https://arxiv.org/abs/{p['arxiv_id']}"), _j(tg), source, now()))
                c.execute("insert into papers_fts(rowid, title, abstract) values (?,?,?)", (cur.lastrowid, p["title"], p.get("abstract", "")))
                added.append({**p, "id": cur.lastrowid, "tags": tg})
            c.commit()
        with self._lock:
            if self._df is not None:
                for p in added:
                    self._df.update(set(tokens(f"{p['title']} {p.get('abstract', '')}")))
                self._n += len(added)
        if self.embedder:
            self._embed(added)
        return added

    def _embed(self, papers: list[dict]) -> None:
        for i in range(0, len(papers), 32):
            batch = papers[i:i + 32]
            vecs = self.embedder([f"{p['title']}\n{p.get('abstract', '')}" for p in batch])
            for p, v in zip(batch, vecs):
                self.db.x("insert or replace into paper_vecs(paper_id, vec) values (?, ?)", p["id"], v.tobytes())

    def _fts(self, terms: list[str], limit: int, since: str | None = None) -> list[dict]:
        if not terms:
            return []
        match = " OR ".join(f'"{t}"' for t in dict.fromkeys(terms))
        sql = ("select p.*, bm25(papers_fts) as rank from papers_fts join papers p on p.id = papers_fts.rowid"
               " where papers_fts match ?" + (" and p.published >= ?" if since else "") + " order by rank limit ?")
        return self.db.q(sql, match, *([since] if since else []), limit)

    def _vector_sims(self, text: str, papers: list[dict]) -> dict[int, float] | None:
        """Cosine similarity of each paper's stored vector to the text; None without vectors or when the endpoint fails."""
        if not self.vectors or not papers:
            return None
        try:
            qv = self.vectors([text])[0]
            rows = self.db.q(f"select * from paper_vecs where paper_id in ({','.join('?' * len(papers))})", *[p["id"] for p in papers])
            return {r["paper_id"]: float(np.frombuffer(r["vec"], dtype=np.float32) @ qv) for r in rows}
        except Exception:
            return None

    def rank(self, papers: list[dict], terms: list[str], sims: dict[int, float] | None = None) -> list[dict]:
        """Cards for the papers, most similar first: by vector where one was found, else by term coverage."""
        hits = []
        for p in papers:
            cov, matched = self.coverage(terms, f"{p['title']} {p.get('abstract', '')}")
            hits.append({**self.card(p), "similarity": round(sims.get(p["id"], cov) if sims else cov, 2), "matched": matched})
        return sorted(hits, key=lambda h: -h["similarity"])

    def search(self, query: str, top_k: int | None = None, since: str | None = None) -> dict:
        q_en = expand(query)
        terms = list(dict.fromkeys(tokens(q_en)))
        cands = self._fts(terms, self.opts["candidates"], since)
        sims = self._vector_sims(q_en or query, cands)
        return {"query": query, "expanded": q_en, "terms": terms, "method": "coverage" if sims is None else "embedding",
                "hits": self.rank(cands, terms, sims)[:top_k or self.opts["top_k"]]}

    def rescore(self, query: str, arxiv_ids: list[str]) -> dict:
        """Score papers against the whole query, so a verdict does not depend on how the agent phrased its searches."""
        q_en = expand(query)
        terms = list(dict.fromkeys(tokens(q_en)))
        papers = self.get(list(dict.fromkeys(arxiv_ids)))
        sims = self._vector_sims(q_en or query, papers)
        return {"method": "embedding" if sims else "coverage", "terms": terms, "hits": self.rank(papers, terms, sims)}

    @staticmethod
    def card(p: dict) -> dict:
        return {"paper_id": f"arxiv:{p['arxiv_id']}", "arxiv_id": p["arxiv_id"], "title": p["title"],
                "year": (p.get("published") or "")[:4], "authors": short_authors(p.get("authors") or []),
                "snippet": (p.get("abstract") or "")[:320], "url": p.get("url") or f"https://arxiv.org/abs/{p['arxiv_id']}",
                "tags": p.get("tags") or []}

    def get(self, arxiv_ids: list[str]) -> list[dict]:
        ids = [i.removeprefix("arxiv:") for i in arxiv_ids]
        if not ids:
            return []
        rows = self.db.q(f"select * from papers where arxiv_id in ({','.join('?' * len(ids))})", *ids)
        order = {i: k for k, i in enumerate(ids)}
        return sorted(rows, key=lambda r: order[r["arxiv_id"]])

    def count(self) -> int:
        return self.db.val("select count(*) from papers")

    def latest(self, n: int = 10) -> list[dict]:
        return [self.card(r) for r in self.db.q("select * from papers order by published desc, id desc limit ?", n)]

    def similar_to(self, paper: dict, k: int = 3) -> list[tuple[dict, float]]:
        terms = list(dict.fromkeys(tokens(paper["title"])))
        out = []
        for c in self._fts(terms, k + 1):
            if c["arxiv_id"] == paper["arxiv_id"]:
                continue
            cov, _ = self.coverage(terms, f"{c['title']} {c['abstract']}")
            out.append((c, round(cov, 2)))
        return out[:k]

    @staticmethod
    def bibkey(arxiv_id: str) -> str:
        return "arxiv" + re.sub(r"[^0-9A-Za-z]", "", arxiv_id)

    @classmethod
    def bibtex(cls, p: dict) -> str:
        def esc(t: str) -> str:
            return re.sub(r"([&%#_$])", r"\\\1", t).replace("{", "").replace("}", "")
        authors = " and ".join(esc(a) for a in (p.get("authors") or ["Anonymous"]))
        return (f"@article{{{cls.bibkey(p['arxiv_id'])},\n  title = {{{esc(p['title'])}}},\n  author = {{{authors}}},\n"
                f"  journal = {{arXiv preprint arXiv:{p['arxiv_id']}}},\n  year = {{{(p.get('published') or '')[:4]}}},\n"
                f"  url = {{https://arxiv.org/abs/{p['arxiv_id']}}}\n}}\n")


def _j(v) -> str:
    return json.dumps(v, ensure_ascii=False)
