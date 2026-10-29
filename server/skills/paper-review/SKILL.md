---
name: paper-review
description: 以指定的审稿人视角审一篇初稿：按评分标准给出新颖性、可靠性、清晰度和总分，列出优点和问题，决定通过还是退回修改。质检所使用。
allowed-tools: press_read read_reference(references/personas.md) read_reference(references/rubric.md)
metadata:
  roles: reviewer
---

# 模拟审稿

## 步骤

1. 读 `references/personas.md`，找到任务里分配给你的审稿视角，按这个视角审。
2. 读 `references/rubric.md`，按标准打分。
3. `press_read`：读初稿的 TeX 源码。
4. 调用 `submit_review` 提交。

## 要求

- 每条问题都要指向初稿里的具体位置（哪一节、哪个说法）。
- 格式检查（匿名、页数）的结果会在任务里给出，有问题就写进 `weaknesses`。
- 实验是模拟结果时，可靠性最高给 5 分，并在问题里写明。
- `decision`：总分 ≥ 5 且没有格式硬伤写 `accept`，否则写 `revise`。
