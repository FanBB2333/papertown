---
name: anonymity-check
description: 投稿格式检查：匿名（作者、邮箱、致谢、自引仓库链接）、页数和引用数量。质检所在审稿前自动运行。
metadata:
  roles: qa
---

# 格式检查

运行 `scripts/check.py`，输入初稿 TeX 源码和 PDF 页数，输出问题列表。检查是确定性的规则，结果直接交给审稿人。

规则：
- `\author` 里不能是真实作者；不能出现邮箱、`\thanks`、Acknowledgments 一节。
- 不能出现 github.com / gitlab.com 等代码仓库链接（审稿期间会暴露身份）。
- 正文页数（PDF 页数）超过 `page_limit` 视为硬伤，默认 9 页。
- 引用少于 5 篇提示补充 related work。
