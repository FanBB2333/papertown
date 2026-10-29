---
name: method-design
description: 把通过查重的 idea 写成方法草案：问题定义、核心机制、baseline、数据集和评价指标。造纸厂立项后的第一道工序使用。
allowed-tools: library_search repo_search read_reference(references/method-template.md)
metadata:
  roles: designer scout
---

# 方法设计

输入是 idea、撞车报告（最相近的工作和空白点）。产出一份方法草案，交给实验农场和印刷厂。

## 步骤

1. 读 `references/method-template.md`，按模板的栏目组织。
2. `library_search`：围绕空白点再检索一次，找能借用的组件和常用的评测设定。
3. `repo_search`：在仓库群里找现成的 baseline 实现、评测脚本和指标定义。找到的要写进 `baselines` 的 `source`（仓库名 + 路径）。
4. 调用 `submit_draft` 提交草案。

## 要求

- `title` 用英文，像一篇论文的题目。
- `mechanism` 写 2～4 条，每条一句话说清"做什么、为什么能解决空白点"。
- `baselines` 至少 2 个，优先用仓库里已有实现的；每个都要有 `source`，来自论文就写 arXiv id。
- `metrics` 用仓库或论文里已有的指标名，不要自创。
- 不确定的地方写进 `risks`，不要假装确定。
