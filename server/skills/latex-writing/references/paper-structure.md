# 初稿结构

| 节 | 字段 | 写什么 |
| --- | --- | --- |
| Abstract | `abstract` | 问题、空白点、方法一句话、主要结果一句话；120～180 词 |
| Introduction | `introduction` | 背景 → 已有工作做到哪 → 空白点 → 我们的方法 → 贡献列表（`itemize`） |
| Related Work | `related_work` | 按主题分 2～3 段，每段引用相关工作并说明区别 |
| Method | `method` | 问题定义 + 每条核心机制一个 `\subsection` |
| Experiments | `experiments` | 设定（数据集、baseline、指标）+ 结果分析 |
| Conclusion | `conclusion` | 结论和局限 |

各节正文不要写 `\section` 命令，印刷厂会加。
