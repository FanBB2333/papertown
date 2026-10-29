# Papertown

把一条科研流水线做成一座纸艺小镇：一颗 idea 从孵化场查重开始，通过后在造纸厂立项，经过方法设计、实验、写作、审稿，最后出港一篇论文。每道工序由一组 agent 员工完成，员工的能力来自 Agent Skills，外部数据通过 MCP 接入。

你在小镇里是一个小人：WASD 或方向键走动，走到建筑门口按 E（或 Enter / 空格）进去，也可以直接点建筑。主要的四座建筑：

- **造纸厂**：大本营，所有项目的总览和每个项目的工序。
- **仓库**：每个项目一个写代码的 pi，写代码、跑测试，再把实验提交到实验农场。
- **实验农场**：所有实验任务的看板，每个项目有一位看田员盯进度；以后在这里接 nvidb。
- **印刷厂**：每个项目一个写论文的 pi，稿子就在印刷厂的目录里。

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
| `PAPERTOWN_PI_BIN`、`PAPERTOWN_TMUX_BIN` | pi 和 tmux 的路径；不设时自动查找（会跳过终端包装的 shim，也会找 nvm 下的 pi） |
| `PAPERTOWN_PI_MODEL` | 给 pi 员工指定模型；不设时用 pi 自己的默认模型 |
| `PAPERTOWN_LOCAL_JOBS` | 实验农场本地执行器同时跑几个任务，默认 2 |

完整列表见 [`.env.example`](.env.example) 和 `server/papertown/config.py`。

## 现在是真的、还是模拟的

| 建筑 | 状态 |
| --- | --- |
| 孵化场、图书馆、族谱馆、学术海关 | 真实：SQLite FTS5 检索 + 查重 / 分类 skill，自带 346 篇 arXiv 论文作种子 |
| arXiv 码头 | 真实：MCP server，拉到的论文自动入馆 |
| 造纸厂、质检所、人才市场 | 真实：所有项目共用一座造纸厂；按预算编队、多视角审稿、结算 ROI 并升降级 |
| 仓库、印刷厂的 pi 员工 | 真实：本机的 pi，跑在后台 tmux 里，网页和终端双向同步 |
| 实验农场 | 真实：本地执行器在项目代码目录里跑命令；nvidb 还没接入 |
| 印刷厂 | 真实：组装 TeX 和 refs.bib，本机有 `latexmk` 时编译 PDF |
| 参考仓库 | 示例数据：三个虚构的示例仓库，文档进了检索库 |
| 模拟电厂 | **模拟**：离线流水线的实验结果是按种子生成的，结果里带 `simulated: true` |
| 其余建筑 | 未接入，点开能看到计划 |

## 仓库和印刷厂里的员工

每个项目在仓库有一个写代码的员工，在印刷厂有一个写论文的员工。启动时可以选两种运行方式，工作目录都一样：代码员工在 `server/var/projects/<项目>/code`，写作员工在印刷厂的 `server/var/press/<项目>`，里面会写一份 `AGENTS.md` 交代它的职责，启动时先把项目简报发给它。

### Paseo（推荐）

[Paseo](https://paseo.sh) 在本机跑一个守护进程（默认 `127.0.0.1:6767`），托管 Claude Code、Codex、OpenCode、Pi、Copilot 等 agent。Papertown 通过 `paseo` CLI（它是这个端点的客户端）为每个项目创建 agent，供应商、模型和思考强度在启动时从 Paseo 列出的清单里选；对话记录通过 Paseo 的官方 SDK（`@getpaseo/client`）读取。手机上的 Paseo 也能看到同一个 agent。

```bash
paseo daemon start                                      # 守护进程
paseo daemon config set features.webUi.enabled true     # 让守护进程提供网页端，「完整界面」才能嵌入
paseo daemon restart
cd server/papertown/paseo_link && pnpm install          # SDK，装一次
```

房间里默认是精简视图：只显示你和它的消息，工具调用收成一行（点开看每一步），思考过程和待办留在 Paseo 里，长消息（比如项目简报）先折起来。它要运行命令或改文件时会弹出权限卡片，在这里点「允许」或「拒绝」就行。「完整界面」嵌入 Paseo 自己的 agent 页面，slash 命令、模型切换和模式都和在 Paseo 里一样；「桌面端」在 Paseo 应用里打开同一个 agent。

本机 Paseo 里已有的对话也能接过来：在没有员工的项目房间里点「导入 Paseo 里已有的对话」，选一段，它就成了这个项目的员工。工作目录保持对话原来的目录，Papertown 给它打上 `papertown.*` 标签，一段对话只能导入给一个项目。

这些 agent 用 `.papertown/pt` 读项目简报、把实验提交到实验农场（`pt brief`、`pt submit <名字> -- <命令>`、`pt jobs`）。导入的对话不在项目目录里，可以点房间侧栏的「发送项目简报」把用法发给它。Papertown 每隔几秒同步一次它们的状态。Paseo 用它自己的登录和设置，Papertown 不碰任何 key。

### pi · 后台终端

本机的 [pi](https://github.com/earendil-works/pi)（`@earendil-works/pi-coding-agent`）跑在一个独立的 tmux 服务器里，加载 `server/papertown/pi/bridge.ts`。这个扩展只用了 pi 公开的扩展 API，写法参照 pi 自带的官方示例 `examples/extensions/file-trigger.ts` 和 `send-user-message.ts`：

- pi 的事件（你的输入、流式回复、工具调用、结束）实时转发到网页；
- 网页里发的消息由扩展用 `pi.sendUserMessage()` 注入，pi 正忙时排在它手上的事之后；
- 网页上能切换模型和思考强度，并显示上下文用量；输入 `/` 可以用 pi 的命令：`/model`、`/thinking`、`/compact`、`/new`、`/clone`、`/name`、`/session`、`/reload` 由扩展通过 pi 的 API 执行，扩展命令、skills 和提示模板交给 pi 自己展开；`/settings`、`/resume`、`/fork`、`/tree`、`/login`、`/export` 这类需要 pi 终端界面的命令会被敲进 tmux，在终端里接着操作；
- 代码员工多了 `papertown_submit_job` / `papertown_job_status` 两个工具，实验提交后出现在实验农场。

想直接在终端里看同一段对话，复制建筑里显示的命令，例如：

```bash
tmux -L papertown attach -t pt-coder-line_1
```

pi 用它自己的模型设置和登录，Papertown 不碰任何 key；pi 报告的费用会记进银行。

### 小镇自己的员工

对话抽屉右上角可以切换小镇员工用的供应商（离线演示 / Anthropic / OpenAI 兼容接口）和强、便宜两档模型。只在这次运行里有效，key 照旧从环境变量读取，重启后按环境变量重新决定。

实验任务也可以手动提交：

```bash
uv run papertown job submit --line line_1 --name main -- python run.py --seed 0
uv run papertown job list
```

脚本打印 `PROGRESS <0-100>` 汇报进度，打印 `RESULT {json}` 或写 `$PAPERTOWN_JOB_DIR/result.json` 交结果。

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
