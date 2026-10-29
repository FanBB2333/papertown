"""Tag papers by keyword rules (references/taxonomy.md).

stdin:  {"papers": [{"title": str, "abstract": str, "categories": [str]}]}
stdout: {"tags": [[str]], "summary": str}
"""

import json
import re
import sys

RULES = {
    "具身智能": ["embodied", "robot", "manipulation", "navigation", "vision-language-action", r"\bvla\b"],
    "规划": ["planning", "planner", "long-horizon", "task decomposition"],
    "场景图": ["scene graph"],
    "检索增强": ["retrieval-augmented", r"\brag\b", "retrieval"],
    "知识图谱": ["knowledge graph", "graphrag", "graph retrieval"],
    "智能体": [r"\bagents?\b", "multi-agent", "tool use", r"\bmcp\b", "model context protocol"],
    "高效推理": ["sparse attention", "kv cache", "efficient inference", "quantization", "compression"],
    "多模态": ["multimodal", "vision-language", r"\bvlms?\b"],
    "科研辅助": ["peer review", "research idea", "scientific discovery", "paper writing", "novelty"],
    "代码": ["code generation", "repository", "software engineering"],
    "扩散模型": ["diffusion"],
    "评测": ["benchmark", "evaluation suite"],
}
CATS = {"cs.RO": "机器人", "cs.CV": "视觉", "cs.CL": "语言", "cs.LG": "机器学习", "cs.AI": "人工智能"}

papers = json.load(sys.stdin).get("papers") or []
out = []
for p in papers:
    text = f"{p.get('title', '')} {p.get('abstract', '')}".lower()
    tags = [t for t, pats in RULES.items() if any(re.search(x, text) for x in pats)]
    cat = next((CATS[c] for c in p.get("categories") or [] if c in CATS), None)
    out.append(([cat] if cat else []) + tags[:4])
print(json.dumps({"tags": out, "summary": f"{len(out)} 篇已打标签"}, ensure_ascii=False))
