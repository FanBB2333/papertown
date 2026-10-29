# Papertown 素材

这里的 SVG 全部由 `design/src/sprites.js` 用代码生成，配色是纸艺风格（Paper-craft），没有引用任何第三方素材。
改素材请改源码，然后运行 `node design/build.mjs` 重新导出；不要手改这里的文件。

- 等距网格：瓦片 64×32 像素，高度 1 单位 = 26 像素；每个建筑 SVG 的坐标原点是占地的后角。
- `manifest.json`：建筑 type → 文件、占地、强调色、代表含义；世界地图的摆放（placements）；四种风格的完整色板。
- 正式开发时，前端按 `type` 查 manifest 取图，换画风或换成 3D 模型时只换映射，不动业务逻辑。

## 建筑

| type | 名称 | 区域 | 占地 | 代表 | 技术 |
| --- | --- | --- | --- | --- | --- |
| `dock_arxiv` | arXiv 码头 | 文献港 | 3×2 | 每天到港的新论文元数据和 TeX 源码 | MCP · arXiv |
| `dock_github` | GitHub 码头 | 开源码头 | 2×3 | 开源代码、issue 和 star 从这里进出 | MCP · GitHub |
| `customs` | 学术海关 | 文献港 | 2×2 | 入境检查：去重、过滤不相关论文、打领域标签 | Skill · 分类 |
| `lighthouse` | 灯塔（以后再做） | 文献港 | 1×1 | 订阅追踪：盯住作者、关键词和竞争对手 | MCP · 定时任务 |
| `hatchery` | 孵化场 | 立项广场 | 2×2 | idea 蛋在这里查重、孵化，通过后才建厂 | RAG + Skill · 查重 |
| `mill` | 造纸厂 | 造纸厂大本营 | 3×2 | 一篇论文一座厂：调研、方法、写作都在这条流水线上 | Capitalist 编队 + Skills |
| `farm` | 实验农场 | 实验农场 | 3×3 | 每块田是一组实验，收成是结果表；用的电来自算力电厂 | MCP · nvidb |
| `press` | 印刷厂 | 印刷厂 | 2×2 | TeX 源码的存放、排版和编译；.tex 是铅字版，编译是开机印刷 | downleaf · arXivTeXplorer |
| `qa` | 质检所 | 文献港 | 2×2 | 多个审稿人 persona 打分，检查页数、匿名和模板 | Skills · 审稿 |
| `depot` | 仓库 | 仓库 | 3×2 | 一个开源 repo 一座仓库：货架是目录，commit 入库，release 出货 | RAG · 代码与文档 |
| `workshop` | 加工车间 | 算力带 | 2×2 | 维护 agent 的工位：修 bug、写文档、回 issue | Skills · 维护 |
| `logistics` | 物流站 | 开源码头 | 2×2 | 仓库之间、仓库和造纸厂之间的依赖与调用 | 知识图谱 · 依赖 |
| `library` | 图书馆 | 文献港 | 3×3 | 全世界共享的知识库：读过的论文、笔记和摘要 | RAG 主库 · 向量检索 |
| `genealogy` | 族谱馆 | 立项广场 | 2×2 | 引用关系图谱：谁是谁的"祖先"，方法怎么传下来 | 知识图谱 + GraphRAG |
| `market` | 人才市场 | 开源码头 | 3×2 | Agent 员工池：按任务编队，按 ROI 升职或降级 | Capitalist + Skills |
| `cityhall` | 市政厅 | 立项广场 | 3×3 | 你的个人中心：项目总览、预算、待办，也是写下新 idea 的地方 | — |
| `bank` | 银行 | 成果街 | 2×2 | token 预算和 API 成本；每条流水线结束时在这里结算 | 计费日志 |
| `newspaper` | 报社 | 成果街 | 2×2 | 每天出一份世界日报：新论文、仓库更新、实验进展 | RAG + Skill · 摘要 |
| `power` | 算力电厂 | 算力带 | 3×3 | GPU：负荷就是显卡占用，停电就是 OOM | MCP · nvidb |
| `power_sim` | 模拟电厂 | 算力带 | 2×2 | 没有真 GPU 时的备用电源，现场 demo 的兜底 | FakeGPU |
| `coldstore` | 冷库 | 算力带 | 2×2 | 数据集存储：大小、格式、下载状态 | 元数据库 |
| `weather` | 气象台（以后再做） | 成果街 | 2×2 | 会议 DDL 和日程，"台风预警"就是截稿临近 | MCP · 日历 |

## 物件

| key | 名称 | 代表 |
| --- | --- | --- |
| `egg` | idea 蛋 | 刚写下的一个 idea，放进孵化场 |
| `notes` | 调研笔记 | 孵化员和调研员从图书馆带回的摘录 |
| `draft` | 方法草案 | 方法设计车间产出的问题定义和机制 |
| `table` | 结果表 | 实验农场的收成 |
| `tex` | TeX 铅字 | 印刷厂里的一版 .tex 源码 |
| `pdf` | PDF 成品 | 印刷厂编译出来、质检通过的论文 |
| `crate` | 代码货箱 | 从仓库提出来的代码和 baseline |
| `energy` | 算力 | 从电厂送去实验农场的 GPU 时间 |
| `dataset` | 数据集 | 冷库里存放、按需取用的数据 |

## 员工

| key | 角色 | 职责 |
| --- | --- | --- |
| `hatcher` | 孵化员 | 查重、写撞车报告 |
| `scout` | 调研员 | 检索文献、整理 related work |
| `designer` | 方法设计师 | 把 idea 写成可验证的方法 |
| `experimenter` | 实验员 | 排 GPU、跑实验、收结果 |
| `writer` | 写手 | 在印刷厂里写 TeX |
| `reviewer` | 审稿人 | 在质检所里打分、挑毛病 |
| `keeper` | 仓管员 | 维护仓库：回 issue、管 release |

## 地形与道具

| key | 名称 |
| --- | --- |
| `tree_round` | 圆冠树 |
| `tree_pine` | 松树 |
| `lamp` | 路灯 |
| `boat` | 货船 |
| `truck` | 货车 |
| `tile_grass` | 草地 |
| `tile_road` | 道路 |
| `tile_plaza` | 广场地砖 |
| `tile_water` | 水面 |
| `tile_sand` | 沙滩 |
