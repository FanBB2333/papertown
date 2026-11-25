# 订阅用量与项目预算：设计方案

## 1. 要解决的问题

项目里的 agent 跑在用户自己的订阅上：Claude Code 用 Claude Max，Codex 用 ChatGPT 套餐，Antigravity 用 Google 的套餐。这些订阅不按美元计费，而是按时间窗口限额：5 小时窗口、每周窗口，用完就要等重置。Papertown 展示订阅余量，并从 agent 的本机会话日志统计各项目的用量。

用户要两件事：

1. **看得见余量**：每个订阅现在用了多少、还剩多少、什么时候重置，并周期性刷新。
2. **按项目设预算**：开启一个项目时，写下它预计用掉多少，之后能看到它的 agent 实际用了多少、是否超出。

## 2. 能读到什么

调研日期 2026-11-21，依据本机安装的 Paseo 0.16.2、agy 1.5.14 及其源码和官方文档。

| 订阅 | 余量从哪读 | 内容 |
| --- | --- | --- |
| Claude（Max） | Paseo `listUsageReports()`。Paseo 用 Claude 登录凭据请求 `api.anthropic.com/api/oauth/usage`，结果缓存 5 分钟 | 套餐名，`five_hour`、`weekly`，以及按模型的周窗口（如 `weekly_model_fable`），各有已用百分比和重置时间 |
| Codex（ChatGPT） | 同上。Paseo 请求 `chatgpt.com/backend-api/wham/usage` | 套餐名，周窗口，额外点数余额 |
| Antigravity | `agy -p /usage --output-format json`。这是 CLI 自己处理的命令，实测 0 轮、0 token | 按模型组（Gemini Models、Claude and GPT models）各有周窗口和 5 小时窗口，给出剩余比例和重置时间 |

每个 agent 实际用了多少 token，记录在本机的会话日志里：

| agent | 日志 | 取法 |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/<目录>/<会话>.jsonl`（含 `subagents/`） | assistant 记录的 `cwd`、`sessionId`、`message.id`、`message.usage` 的输入、缓存写入、缓存读取、输出 token。同一 `message.id` 只计一次 |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `session_meta` 给出会话 id 和 `cwd`，`token_count` 事件的 `total_token_usage` 是会话累计值，取相邻两次的差 |
| Antigravity | `~/.gemini/antigravity-cli/brain/<会话>/.system_generated/logs/transcript.jsonl` | 每步的 `input_tokens`、`cache_read_tokens`、`output_tokens`，按 `step_index` 去重。目录取自 `cache/conversation_metadata.json` 的 `WorkspaceURIs` |

Paseo 启动的 agent 和用户在终端里开的会话都写这些日志。Paseo 的 agent 快照带着它的会话 id（`persistence.sessionId`），herdr 的终端会话带着 `agent_session`，所以日志里的会话能对应到具体的 agent。Papertown 只读其中的数字、模型名、时间、会话 id 和目录，不读、不存对话内容。

## 3. 设计

### 3.1 订阅用量

订阅额度只在有人要看时读：打开网页时读一次，App 打开用量页时读一次，再加上页面上的「刷新」按钮。每次读 Paseo 的用量报告（跳过缓存，`forceRefresh`）和 `agy /usage` 各一次，读到的每个窗口存一条样本。同一订阅 1 分钟内至多读一次。服务端不在后台自行读取额度，因为这些 CLI 换不到登录令牌时会打开浏览器要求重新登录，Mac 睡眠中短暂醒来、网络未通时就会这样。

后台只增量扫描本机会话日志，间隔为 `papertown.toml` 的 `[history] usage_poll`（秒，默认 300）。

读不到时照实显示：Paseo 没在运行、登录过期、命令出错，各订阅分别标出原因，并保留最近一次成功读到的数值和时间。Paseo 可能为同一订阅列出多个登录，只要有一个读到了，其余登录的错误只作为附注显示。

### 3.2 项目用量：按 agent 的实际计费统计

项目的用量直接取它的 agent 自己记录的 token，按 API 价格折算成美元，不再把订阅额度分摊到项目。

- **会话归属**：会话 id 属于项目的某个员工（Paseo agent 或节点 agent），就算这个员工的。否则按工作目录归属：目录落在项目的代码目录、论文目录、`projects.json` 登记的仓库或员工工作目录里，算作这个项目的其他会话（例如 herdr 里手动开的终端会话）。都不符合的，属于「本机其他会话」。
- **折算**：每个模型按价格表计算。缓存写入分两档：5 分钟的按输入价的 1.25 倍，1 小时的按 2 倍（Claude Code 的缓存写入都是 1 小时档）。缓存读取按各模型公布的价格，未公布单独价格的按输入价的十分之一。价格表在 `papertown/pricing.py`，注明了来源和核对日期，促销价写明截止日期，可用 `PAPERTOWN_PRICES` 覆盖。缺价格的模型照常计 token，金额栏注明「缺价格」。Codex 的审批复核模型 `codex-auto-review` 用 ChatGPT 登录时免费，计为 0。
- **口径**：从项目开启时算起的累计值，另显示本周的部分。本周从本机时区的周一零点起算。订阅本身不按美元收费，这里的美元只是统一的计量单位，便于和预算比较。

### 3.3 项目预算

- **项目创建后设置**：在项目页「用量与预算」中填写：「预计 Agent 用量（按 API 价格折算，美元）」，预填设置里的默认值，留空表示不设。
- **随时修改**：项目页的「用量与预算」块里可以改。
- **状态**：低于预算的 80% 为正常，达到 80% 为接近，达到 100% 为超出。
- **提醒**：达到 80% 和 100% 时各给项目记一条汇报，改了预算后重新计。项目负责人用 `pt brief` 和 `pt status` 时也会看到本项目的用量和预算。Papertown 不为此主动给 agent 发消息。
- 这一版只提醒，不自动暂停 agent 或拦截任务。

### 3.4 页面

- **员工页**：左栏底部一条「订阅用量」，写法和终端的状态栏一样，每个窗口一行：订阅名（同一订阅只写在第一行，按模型分组的窗口第二行写组名）、窗口简称（`5h`、`7d`）、十格分段条、已用百分比、距重置的时间（如 `3h38m`、`1d23h`）。百分比和分段条按用量着色：低于 50% 为绿色，50% 到 80% 为橙色，80% 以上为红色。还没开始计时且没有用量的窗口只在展开后出现。点开看全部窗口（同样的分段条，下面一行写剩余和具体的重置时间）、额外余额，以及本周本机该订阅的会话折合多少美元、其中 Papertown 项目占多少。
- **项目页**：「用量与预算」块：累计用量 / 预算的进度条（按状态着色），本周用量，按订阅和模型分的 token 与金额，以及按会话列出的明细（能对应到员工或终端会话的写出名字）。
- **进展卡片**：接近或超出预算时显示一个小标记。
- **设置 › 员工 Agent**：默认项目预算、轮询间隔、是否读取本机会话日志（关掉后只显示订阅余量，项目用量停止统计）。

## 4. 存储

| 表 | 内容 |
| --- | --- |
| `usage_samples` | 每次读到的订阅窗口：时间、订阅、账户、窗口、已用百分比、重置时间、套餐名。保留 35 天 |
| `usage_tokens` | 会话日志里的 token，按分钟、订阅、模型、会话、项目（无则为空）汇总：输入、缓存写入（另记其中 1 小时档的部分）、缓存读取、输出 |
| `usage_files` | 每个日志文件读到的位置、修改时间，以及去重需要的少量状态 |
| `agents.session_id` | Paseo agent 当前的会话 id，同步状态时记下 |
| `lines.usage_budget` | 项目预算，美元，空表示不设 |
| `usage_alerts` | 每个项目在某个预算额下已经提醒过的档位，避免重复 |

首次扫描读最近 35 天内修改过的日志，之后按记下的位置增量读取。

## 5. 接口

- `GET /api/usage`：`{polled_at, next_at, logs, providers: [{id, label, plan, status, error, fetched_at, windows: [{id, label, group, used, left, resets_at}], balances, week: {cost, projects, tokens}}]}`。`week.cost` 是本周本机该订阅所有会话的折合金额，`week.projects` 是其中属于 Papertown 项目的部分。
- `POST /api/usage/refresh`：强制刷新一次。
- `GET /api/lines/{id}/usage`：`{budget, spent, state, since, week, providers: [{id, cost, tokens}], models: [{provider, model, cost, tokens, priced}], sessions: [{session, provider, owner: {kind: agent | terminal | dir, id, name}, cwd, cost, tokens, last_at}]}`，`state` 为 `ok`、`near`、`over`，没有预算时为 `none`。`tokens` 含 `input`、`cache_write`、`cache_read`、`output`。
- `PUT /api/lines/{id}/usage_budget`：`{usd: 数值或 null}`。
- `POST /api/ideas {text}` 创建项目后，用上述用量预算接口单独设置预算。
- 总线事件 `usage`：每次读数完成后发出。

## 6. 测试

- **单元测试**：用临时目录放三种日志的样例和 Paseo、agy 的报告样例，覆盖 token 去重与累计差值、会话按员工和按目录的归属、按模型折算金额（含缺价格的模型）、预算状态和提醒只发一次（改预算后重新计）、项目创建后设置用量预算、接口形状、订阅读数的保留与出错处理。
- **真实读取**：`server/scripts/verify_usage.py` 用本机正在运行的 Paseo、agy 和会话日志，按间隔读若干次，检查每个订阅都读到了窗口、百分比在 0 到 100 之间、重置时间在未来、日志扫描得到本周各订阅的 token 和折合金额，并打印每次的读数。它不启动任何守护进程，不向任何 agent 发消息，不消耗额度。

### 6.1 真实读取结果

2026-11-22 用本机正在运行的 Paseo、agy 和会话日志读了三次，间隔 30 秒，没有调用任何模型：

- Claude：5 小时窗口、每周窗口和按模型的每周窗口都读到，百分比和重置时间正常。
- Codex：Paseo 为同一订阅列出了多个登录，其中有已过期的。修正后只要有一个登录读到，订阅就显示为可用，过期的登录作为附注。
- Antigravity：Gemini 和第三方模型两组的周窗口、5 小时窗口都读到。未使用过的一组重置时间为空，显示「尚未开始」。
- 会话日志首次扫描最近 35 天约需 40 秒，之后增量读取。
- 在 herdr 联调的临时项目里，项目代码目录下的 Claude Code 终端会话被算到这个项目，会话归属显示为该终端会话。预算设为 $0.25 时状态为「接近预算」，并记了一条 80% 的提醒。

## 7. 这一版不做

- 不直接调用 Anthropic 或 OpenAI 的用量接口，统一经 Paseo。Paseo 没在运行时，Claude 和 Codex 的余量暂不可读。
- 不自动暂停超预算的项目。
- 不把订阅额度分摊到项目。订阅额度只在全局展示，项目用 agent 的实际计费统计。
- 不读其他设备上的会话。
