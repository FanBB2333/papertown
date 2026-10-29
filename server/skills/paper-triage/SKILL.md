---
name: paper-triage
description: 学术海关的入境检查：给新到港的论文打领域和方法标签，方便图书馆编目和报社挑选。论文入馆时自动运行。
metadata:
  roles: customs
---

# 入境分拣

运行 `scripts/tag.py`，输入论文的标题、摘要和 arXiv 分类，输出每篇的标签。规则见 `references/taxonomy.md`；去重由海关在入馆时按 arXiv id 和标题完成。
