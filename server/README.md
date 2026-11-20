# Papertown server

运行方式和环境变量见仓库根目录的 README。这里说明代码怎么分层。

```
papertown/
  api.py         FastAPI 路由与 SSE 事件流（/api/events）
  town.py        把下面所有部件接在一起，注册员工可用的工具
  pipeline.py    一颗 idea 一条流水线：孵化 → 编队 → 方法 → 实验 → 写作 → 审稿 → 出港
  stages.py      每道工序交给哪个 skill、提交什么格式
  agent.py       员工的 agent 循环：选模型、扣预算、调工具、失败停止并记录原因
  llm/           provider：Anthropic、OpenAI 兼容、离线脚本
  skills.py      Agent Skills 注册表（渐进加载，热插拔）
  tools.py       工具注册表，每次调用写一条 trace
  mcp_hub.py     MCP 客户端，把外部 server 的工具挂给员工
  ports/         arXiv 码头（MCP server）
  library.py     论文库：FTS5 BM25 召回 + 关键词覆盖率 / embedding 打分
  graph.py       族谱：相近边与引用边
  market.py      人才市场：分诊、按预算编最小团队、ROI 结算与升降级
  compute.py     模拟 GPU 电厂
  farm.py        实验农场：统一的任务看板（本地执行器、模拟电厂，nvidb 待接入）和每个项目的看田员
  agents.py      仓库和印刷厂的 pi 员工：tmux 里的交互式 pi、收发消息、记录对话
  pi/bridge.ts   加载进 pi 的扩展，把对话实时同步到 Papertown，并提供提交实验的工具
  press.py       印刷厂：TeX 组装与 latexmk 编译
  bank.py        账本：按模型单价记账
  world.py       世界地图状态与建筑详情（一座造纸厂做大本营，一座仓库）
  status.py      「运行状态」页的数据
  mcp_server.py  Papertown 自己的只读 MCP server
skills/          员工的 skills
skills-extra/    热插拔演示用的 skill
scripts/         维护脚本（刷新种子论文）
tests/           pytest，离线运行
```

数据默认写在 `server/var/`（SQLite 数据库和印刷厂产物），可以用 `PAPERTOWN_DATA_DIR` 改位置。删掉这个目录就是重新开局；重启时正在跑的流水线会被标记为暂停，可以在界面上继续。

常用命令：

```bash
uv run papertown serve [--port 8000]
uv run papertown ingest "vision language action" "scene graph planning" [--max 50] [--refs]
uv run papertown skills
uv run papertown demo "<idea>"
uv run papertown mcp
uv run papertown job submit --line line_1 --name main -- python run.py
```
