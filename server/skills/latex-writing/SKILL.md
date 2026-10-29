---
name: latex-writing
description: 根据方法草案、撞车报告和实验结果写论文初稿，排成 TeX 并编译出 PDF。印刷厂使用。
allowed-tools: paper_get read_reference(references/paper-structure.md) press_typeset
metadata:
  roles: writer
---

# 写作排版

## 步骤

1. 读 `references/paper-structure.md`，按结构写各节。
2. `paper_get`：取撞车报告里那几篇相近工作的完整摘要，写 related work 时只依据这些摘要。
3. `press_typeset`：提交题目、摘要和各节正文（LaTeX），以及要引用的论文 id。印刷厂会生成 `refs.bib`、插入结果表并编译。
4. 编译失败（卡纸）时看返回的报错，改正后再调用一次 `press_typeset`。
5. 调用 `submit_paper` 提交一句话说明这一版写了什么。

## 要求

- 全文英文。正文是 LaTeX 片段，引用写成 `\cite{arxiv<编号去掉标点>}`，例如 arXiv 2401.01234 写成 `\cite{arxiv240101234}`。
- 不要在正文里写作者、单位、致谢和指向自己仓库的链接（投稿是匿名的）。
- 结果表由印刷厂自动插入在 Experiments 一节末尾，正文用 `Table~\ref{tab:main}` 引用即可。
- 实验是模拟结果时，Experiments 里要明确写出来。
