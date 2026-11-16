"""Refresh the demo's bundled seed library (papertown/data/seed_papers.jsonl) from the arXiv API.

    uv run python scripts/fetch_seed.py

arXiv metadata (titles, abstracts) is released under CC0.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from papertown.ports import arxiv_api  # noqa: E402

QUERIES = [
    'abs:"vision-language-action"',
    'abs:"scene graph" AND abs:planning',
    'abs:"long-horizon" AND abs:manipulation',
    'abs:"embodied" AND abs:memory AND abs:agent',
    'abs:"task planning" AND abs:"large language model" AND abs:robot',
    'abs:"sparse attention"',
    'abs:"KV cache" AND abs:compression',
    'abs:"retrieval-augmented generation"',
    'abs:graphrag OR abs:"graph retrieval-augmented"',
    'abs:"tool use" AND abs:"language model" AND abs:agent',
    'abs:"multi-agent" AND abs:"large language model" AND abs:collaboration',
    'abs:"diffusion policy"',
    'abs:"spatial reasoning" AND abs:benchmark AND abs:multimodal',
    'abs:"research idea" AND abs:novelty',
    'abs:"peer review" AND abs:"large language model"',
    'abs:"scientific" AND abs:"paper writing" AND abs:"language model"',
    'abs:"model context protocol"',
    'abs:"code generation" AND abs:agent AND abs:repository',
]
PER_QUERY = 20

out = Path(__file__).resolve().parents[1] / "papertown" / "data" / "seed_papers.jsonl"
seen: dict[str, dict] = {}
for q in QUERIES:
    try:
        hits = arxiv_api.search(q, max_results=PER_QUERY)
    except Exception as e:
        print(f"skip {q!r}: {e}", file=sys.stderr)
        hits = []
    for h in hits:
        seen.setdefault(h["arxiv_id"], {**h, "seed_query": q})
    print(f"{len(hits):3d}  {q}")
    time.sleep(3.2)

rows = sorted(seen.values(), key=lambda p: p["published"], reverse=True)
out.write_text("".join(json.dumps(p, ensure_ascii=False) + "\n" for p in rows))
print(f"wrote {len(rows)} papers to {out}")
