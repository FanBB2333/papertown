"""Novelty verdict from retrieval similarities. Deterministic; the report must quote it.

stdin:  {"candidates": [{"id": str, "title": str, "similarity": float}], "method": "coverage" | "embedding"}
stdout: {"verdict": str, "top": float, "ranked": [...], "thresholds": {...}, "summary": str}
"""

import json
import sys

THRESHOLDS = {
    "coverage": {"done": 0.85, "adjust": 0.6, "crowd": 0.5},
    "embedding": {"done": 0.88, "adjust": 0.78, "crowd": 0.72},
}

args = json.load(sys.stdin)
method = args.get("method") if args.get("method") in THRESHOLDS else "coverage"
t = THRESHOLDS[method]

seen, ranked = set(), []
for c in sorted(args.get("candidates") or [], key=lambda c: -float(c.get("similarity") or 0)):
    key = c.get("id") or c.get("title")
    if key in seen:
        continue
    seen.add(key)
    ranked.append({"id": c.get("id"), "title": c.get("title"), "similarity": round(float(c.get("similarity") or 0), 2)})

top = ranked[0]["similarity"] if ranked else 0.0
crowd = sum(1 for c in ranked if c["similarity"] >= t["crowd"])
if top >= t["done"]:
    verdict = "已被做过"
elif top >= t["adjust"] or crowd >= 3:
    verdict = "需调整"
else:
    verdict = "可孵化"

print(json.dumps({
    "verdict": verdict, "top": top, "crowd": crowd, "method": method, "thresholds": t, "ranked": ranked[:5],
    "summary": f"{verdict}（最高相似度 {top:.2f}，{len(ranked)} 篇候选）",
}, ensure_ascii=False))
