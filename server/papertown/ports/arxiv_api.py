"""arXiv API client that parses the Atom feed into plain dicts.

The API asks for at most one request every 3 seconds; callers that loop must sleep.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET

import httpx

API = "https://export.arxiv.org/api/query"
NS = {"a": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}
FIELD = re.compile(r"\b(ti|au|abs|co|jr|cat|rn|id|all):")
STOP = {"a", "an", "the", "of", "for", "and", "or", "in", "on", "with", "to", "via", "by", "from", "using", "towards"}


def build_query(text: str) -> str:
    """Free text becomes an AND of its first three terms ("quoted phrases" stay phrases);
    field queries pass through."""
    if FIELD.search(text):
        return text
    quoted = re.findall(r'"([^"]+)"', text)
    words = [w for w in re.findall(r"[A-Za-z0-9][A-Za-z0-9\-]+", re.sub(r'"[^"]*"', " ", text)) if w.lower() not in STOP]
    terms = [f'all:"{q}"' for q in quoted] + [f"all:{w}" for w in words]
    return " AND ".join(terms[:3]) or "all:*"


def _clean(s: str | None) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


def parse_feed(xml: str) -> list[dict]:
    root = ET.fromstring(xml)
    out = []
    for e in root.findall("a:entry", NS):
        abs_url = _clean(e.findtext("a:id", default="", namespaces=NS))
        m = re.search(r"abs/(.+?)(v\d+)?$", abs_url)
        if not m:
            continue
        pdf = next((l.get("href") for l in e.findall("a:link", NS) if l.get("title") == "pdf"), None)
        out.append({
            "arxiv_id": m.group(1),
            "title": _clean(e.findtext("a:title", namespaces=NS)),
            "abstract": _clean(e.findtext("a:summary", namespaces=NS)),
            "authors": [_clean(a.findtext("a:name", namespaces=NS)) for a in e.findall("a:author", NS)],
            "categories": [c.get("term") for c in e.findall("a:category", NS)],
            "published": _clean(e.findtext("a:published", namespaces=NS))[:10],
            "url": abs_url,
            "pdf_url": pdf,
        })
    return out


def _get(params: dict, timeout: float) -> list[dict]:
    r = httpx.get(API, params=params, timeout=timeout, follow_redirects=True)
    r.raise_for_status()
    return parse_feed(r.text)


def search(query: str, max_results: int = 10, sort: str = "relevance", timeout: float = 20.0) -> list[dict]:
    """sort: relevance | submittedDate"""
    q = build_query(query)
    params = {"search_query": q, "max_results": max(1, min(max_results, 100)),
              "sortBy": sort, "sortOrder": "descending"}
    hits = _get(params, timeout)
    if not hits and " AND " in q:
        hits = _get({**params, "search_query": q.replace(" AND ", " OR ")}, timeout)
    return hits


def get(ids: list[str], timeout: float = 20.0) -> list[dict]:
    if not ids:
        return []
    return _get({"id_list": ",".join(ids), "max_results": len(ids)}, timeout)
