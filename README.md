# Papertown

把一条科研流水线做成一座纸艺小镇：一颗 idea 从孵化场查重开始，通过后建一座造纸厂，经过方法设计、实验、写作、审稿，最后出港一篇论文。每道工序由一组 agent 员工完成，员工的能力来自 Agent Skills，外部数据通过 MCP 接入。

```
assets/   建筑素材与 manifest（design/src/sprites.js 生成）
design/   设计方案与离线原型（单文件 HTML）
server/   后端：FastAPI + agent 员工 + 检索 + MCP
web/      前端：React + Vite，复用 design/src 的地图渲染
```

## 运行

后端（Python 3.11，用 uv）：

```bash
cd server
uv sync
uv run papertown serve            # http://127.0.0.1:8000
```

前端开发（另开一个终端，/api 会代理到 8000）：

```bash
cd web
pnpm install
pnpm dev                          # http://127.0.0.1:5173
```

`pnpm build` 之后，`papertown serve` 会直接托管 `web/dist`，只开后端也能用。

不想开界面，可以直接让一颗 idea 跑完整条线：

```bash
cd server
uv run papertown demo "让 VLA 模型用结构化的场景图做长程规划"
```

## 模型与离线模式

没有配置任何 key 时，后端以**离线模式**运行：员工由脚本化的 provider 驱动，按 skill 声明的工具依次调用真实工具（检索、arXiv、模拟 GPU、LaTeX 编译），再按模板提交结果。整条流水线能跑通，但文字是模板拼出来的，界面上会标注「离线」。

接入模型只需要环境变量，key 放在 `~/.secrets.zsh` 或 Keychain，不要写进仓库：

| 变量 | 说明 |
| --- | --- |
| `ANTHROPIC_API_KEY` | 设置后用 Claude（默认 `claude-opus-5-5` / `claude-haiku-5-5`） |
| `PAPERTOWN_OPENAI_API_KEY`、`PAPERTOWN_OPENAI_BASE_URL` | 任意 OpenAI 兼容接口（默认 DeepSeek） |
| `PAPERTOWN_PROVIDER` | 强制指定 `anthropic` / `openai` / `mock` |
| `PAPERTOWN_MODEL_STRONG`、`PAPERTOWN_MODEL_CHEAP` | Lv.3 及以上员工用强模型，其余用便宜模型 |
| `PAPERTOWN_WEEKLY_BUDGET`、`PAPERTOWN_LINE_BUDGET` | 每周总预算、每条流水线默认预算（美元） |
| `PAPERTOWN_EMBED_*` | 可选的 embeddings 接口；不配时用 BM25 + 关键词覆盖率 |
| `PAPERTOWN_MCP_CONFIG` | 额外的 MCP server，Claude Desktop 格式的 JSON |
| `PAPERTOWN_ARXIV=0` | 关掉 arXiv 码头（无网络时） |
| `S2_API_KEY` | 可选，`papertown ingest --refs` 拉 Semantic Scholar 引用边时使用 |

完整列表见 [`.env.example`](.env.example) 和 `server/papertown/config.py`。

## 现在是真的、还是模拟的

| 建筑 | 状态 |
| --- | --- |
| 孵化场、图书馆、族谱馆、学术海关 | 真实：SQLite FTS5 检索 + 查重 / 分类 skill，自带 346 篇 arXiv 论文作种子 |
| arXiv 码头 | 真实：MCP server，拉到的论文自动入馆 |
| 造纸厂、质检所、人才市场 | 真实：按预算编队、多视角审稿、结算 ROI 并升降级 |
| 印刷厂 | 真实：组装 TeX 和 refs.bib，本机有 `latexmk` 时编译 PDF |
| 仓库区 | 示例数据：三个虚构的示例仓库 |
| 模拟电厂、实验农场 | **模拟**：GPU 和实验结果都是按种子生成的，结果里带 `simulated: true` |
| 其余建筑 | 未接入，点开能看到计划 |

## Skills 热插拔

员工的能力在 `server/skills/` 下，每个目录是一个标准的 Agent Skill（`SKILL.md` + `references/` + `scripts/`）。后端每 2 秒扫一次目录，新增的 skill 会立刻出现在界面上，并分给 `metadata.roles` 里写的岗位。

试一下：把 `server/skills-extra/reproducibility-check` 复制到 `server/skills/`，质检所下一次审稿就会多一份可复现性检查。

## 作为 MCP server

Papertown 自己也能作为只读的 MCP server，让其他 agent 查论文库和流水线：

```json
{"mcpServers": {"papertown": {"command": "uv", "args": ["--directory", "/path/to/papertown/server", "run", "papertown", "mcp"]}}}
```

## 测试

```bash
cd server && uv run --group dev pytest -q
cd web && pnpm build
```
