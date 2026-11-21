# Papertown「员工」页与运行中 Agent 的介入：设计方案

## 1. 要解决的问题

项目里干活的是接进来的 agent（Claude Code、Codex、Antigravity 等）。它们在后台运行时，用户需要三件事：

1. **看得见**：每个项目现在有哪些 agent，各自处在什么状态，对话进行到哪里。
2. **插得上话**：agent 正在工作时能追加后续指令、插话引导、打断并换一条指令，agent 汇报或提问时能当场回复。
3. **不漏事**：哪个 agent 在等用户批准、哪个做完了还没看、哪个出错了，要排在最前面。

改动前的状况：单个 agent 的对话页已经有插话、排队、打断和权限审批（`AgentRoom.tsx` 的 `PaseoChat`），但入口分散在小镇的建筑、项目页和回路节点里，没有一处能看到所有 agent。状态只有六种，「等批准」被并进「工作中」，「做完未读」没有记录。状态靠每 6 秒轮询 `paseo ls` 得到，打开的对话每 2 秒启动一个 node 进程读一次。

## 2. 三家 agent 的官方接口

调研日期 2026-11-21，依据各家官方文档和仓库源码。四种能力：排队（本轮结束后送达）、插话（steer，进入正在运行的这一轮）、打断后续发、观测状态和对话。

| | 排队 | 插话 | 打断后续发 | 观测 |
| --- | --- | --- | --- | --- |
| **Claude Code** | Agent SDK 流式输入，消息 `priority: "later"` | 默认行为：下一个工具调用边界读到。`priority: "now"` 立即 | `Query.interrupt()`，会话保持打开 | `session_state_changed`（`idle` / `running` / `requires_action`）、`canUseTool` 回调、hooks |
| **Codex** | CLI `codex queue`，app-server 的实验性 `thread/queue/*` | app-server `turn/steer` | `turn/interrupt`，再 `turn/start` | `thread/status/changed`，`active` 带 `waitingOnApproval`、`waitingOnUserInput` |
| **Antigravity** | TUI 默认排队 | 仅 ACP 模式（`agy acp`）：轮中再发 prompt 即插话 | ACP `session/cancel` | ACP `session/update` 和权限请求。headless 模式拒绝控制消息 |

结论：

- 三家都有官方的程序接口，但协议各不相同（Agent SDK、app-server JSON-RPC、ACP）。
- Claude Code 和 Antigravity 的 Remote Control 只面向各自的官方界面，没有公开 API。
- 终端里直接启动的会话没有可供外部程序插话的入口，要经过宿主接管。

## 3. 参考设计

**Paseo**（本项目已经在用）：daemon 用各家的结构化协议持有会话，Claude 走 Agent SDK，Codex 走 app-server，Antigravity、Copilot、Cursor 等走原生适配或 ACP。状态、对话和权限请求都是协议事件。值得采用的有三点：

- 生命周期（`initializing` / `idle` / `running` / `error` / `closed`）和注意力（`pendingPermissions`、`requiresAttention`、`attentionReason`）分开保存，展示时合成一个分桶。
- 发送行为三选一：打断（interrupt）、插话（steer）、排队（queue）。排队由客户端保存，轮结束后再发。
- SDK 可以订阅 agent 更新和对话流，不必轮询。

**herdr**：持有真实终端，靠读屏幕判断状态。它的列表排序规则值得采用：等用户的排最前，其次是完成未读、工作中、空闲，同级按最近一次状态变化倒序。「完成」不是独立状态，是「空闲加未读」。agent 在等用户批准时，它拒绝把普通消息打进去，避免文字被当成对话框的回答。

## 4. 设计

### 4.1 接入路径：统一经宿主

Papertown 不自己实现三套协议。所有可以介入的 agent 都由宿主持有：

- **Paseo**（推荐）：Claude Code、Codex、Antigravity 以及 ACP 目录里的 agent。Papertown 通过 `paseo` CLI 和 `@getpaseo/client` SDK 对接。
- **pi**：本机 tmux 里的 pi，经 `bridge.ts` 对接，已有排队、插话和中止。

在 Paseo 里手动启动、工作目录落在某个项目仓库里的会话，在员工页列为「未接入的会话」，可以接入成这个项目的员工（已有的导入流程）。Paseo 以外的终端会话先用 `paseo import` 接管。

### 4.2 状态模型：一个分桶，六种取值

每个 agent 由服务端算出一个 `watch` 对象，所有运行方式共用。分桶按优先级从高到低：

| 分桶 | 界面文字 | 判定 | 原因 `why` |
| --- | --- | --- | --- |
| `needs` | 等你 | 有待批准的权限请求，或有它用 `pt ask` 提出的未回答问题 | `permission` 等你批准、`question` 等你回答（Paseo 权限类型为 question 或 plan）、`ask` 等你回答（Papertown 的问题） |
| `failed` | 出错 | 状态为 error | `error` |
| `review` | 待查看 | 一轮做完了，用户还没看 | `finished` |
| `working` | 工作中 | 正在运行一轮 | |
| `idle` | 待命 | 空闲，结果已看过 | |
| `off` | 未启动、连不上 | 没有会话，或宿主连不上 | |

- 「待查看」是空闲加未读。未读的判定：Paseo 给出 `requiresAttention` 且原因是完成，且时间晚于 Papertown 记下的 `seen_at`。pi 的判定是最后一条 agent 消息晚于 `seen_at`。用户在 Paseo 自己的界面里看过，Paseo 会清掉 attention，Papertown 也随之变成待命。
- `watch.doing` 是一句话的现状：工作中是正在调用的工具和参数，等批准时是请求的内容，其余是它说的最后一句话。
- `watch.since` 是进入这个分桶的时间，`watch.turn` 是当前这一轮开始的时间，`watch.queued` 是排队中的消息数。

### 4.3 发送模型：三种方式加停止

agent 工作中时，一条消息有三种交法，在所有对话入口用同一个输入组件：

| 方式 | 含义 | Paseo | pi |
| --- | --- | --- | --- |
| **插话**（steer，默认） | 进入正在运行的这一轮，它做完当前这一步就会看到 | `send --behavior steer` | bridge 的 `steer` |
| **排队**（queue） | 等它做完手上的事再交给它 | Papertown 保存，空闲后发出 | bridge 的队列 |
| **打断并发送**（interrupt） | 停下当前这一轮，立刻改做这条 | `send --behavior interrupt` | 中止后入队 |

另有「停止」：只打断，不发新消息。空闲时发送就是开始新的一轮。

- 排队中的消息列在输入框上方，可以「现在发」（改为插话）或「撤回」（文字回到输入框）。
- 插话是否真的进入当前这一轮取决于 agent：Codex（`turn/steer`）、Claude Code（推入活动的 SDK 输入）、pi（`steer`）原生支持。适配层报告不支持时，Paseo 会退化为打断并换成这条消息。
- agent 在等批准时插话，Paseo 会先拒绝这次请求再送达。输入框在这种情况下提示这一点，权限卡片上的「允许」「拒绝」仍是首选。
- Enter 按默认方式发送，⌘/Ctrl+Enter 排队。默认方式在设置里改。

### 4.4 实时通路

`paseo_link/link.mjs watch` 是一个常驻进程：保持一条到 daemon 的 WebSocket 连接，订阅 agent 更新，并订阅 Papertown 名下各 agent 的对话流，把变化逐行以 NDJSON 写到标准输出：

- `{"t":"agent","agent":{…}}`：一个 agent 的快照变了（状态、权限请求、attention）。
- `{"t":"doing","id":"…","doing":{"kind":"tool","text":"pytest -q"},"at":"…"}`：它正在做的事或最后说的话变了。
- `{"t":"live","id":"…"}`：它的对话有新内容（每个 agent 每秒至多一行），打开着这段对话的页面据此重读。
- `{"t":"gone","id":"…"}`、`{"t":"beat"}`（心跳）。

服务端读这条流，更新内存里的快照和 `doing`，套用和轮询相同的规则（写状态、空闲时发出排队的消息），再通过事件总线推给页面。进程退出后带退避重启。流不可用时退回现有的轮询，流可用时轮询降为低频的对账。

### 4.5 员工页

顶栏增加第三栏「员工」（`/agents`，选中某个 agent 时是 `/agents/<id>`）。「进展」看项目，「员工」看 agent，「小镇」看细节。顶栏另有一个常驻的计数：有 agent 在等用户时显示「等你 n」，点了进入员工页并筛出这些 agent。

页面分三栏：

- **左栏，agent 列表**：按项目分组，项目的顺序和「进展」一致，小助手单独一组。每行是状态点、岗位名（节点 agent 写任务名）、模型，下面一行是 `doing`，右边是在这个状态里待了多久和排队数。顶部是分桶筛选（全部、等你、待查看、工作中）和搜索。排序可选「按项目」和「按紧急程度」（分桶优先级，同级按 `since` 倒序）。等批准的行直接带「允许」「拒绝」。每个项目组的末尾列出未接入的会话。
- **中栏，对话**：复用现有的对话组件。头部是状态、这一轮已经运行多久、之前的对话、新对话。底部是 4.3 的输入组件，「停止」也在这里。agent 有未回答的问题时，问题卡片和选项排在对话上方。
- **右栏，上下文**：所属项目和工序、节点任务（链接到研究回路上的节点）、工作目录、模型、它最近的汇报和提问、在 Paseo 里打开。

窄窗口只显示列表，选中后进入对话。

### 4.6 已读

用户打开一个 agent 的对话、在里面发送消息，或窗口在前台时对话里到达新内容，页面调用 `POST /api/agents/<id>/seen`，服务端记下 `seen_at`。聚焦以前到达、还没交互过的完成保持未读。

## 5. 接口约定

- `GET /api/agents/overview`：`{paseo: {ok, note, live}, counts: {needs, failed, review, working, idle, off}, groups: [{line: {id, seq, title, status, stage} | null, agents: [Agent], loose: [{id, title, provider, model, status, cwd, updated}]}]}`。`line` 为 null 的一组是小助手。只列启动过的 agent。
- `Agent`（`agents.public`）增加 `watch: {bucket, why, since, turn, doing: {kind, text} | null, queued, unread, permissions: [{id, name, title, arg, kind}], asks: [Report]}` 和 `task: {id, title, status} | null`（节点 agent 的任务）。总线上的 `agent` 事件因此带着 `watch`。
- `POST /api/agents/<id>/say`：`mode` 取 `steer`、`queue`、`interrupt` 或不写。
- `POST /api/agents/<id>/queue/<event id>`：`{what: "now" | "drop"}`，处理一条排队中的消息。
- `POST /api/agents/<id>/seen`。
- 总线事件 `agent_live`：`{agent_id}`，这个 agent 的对话有新内容，打开着的对话据此立即重读。

## 6. 落地

| 位置 | 改动 |
| --- | --- |
| `server/papertown/paseo_link/link.mjs`、`watch.mjs`、`protocol.mjs` | `watch` 命令。快照增加 `attention_reason`、`attention_at`、`turn_started`、权限的 `kind` |
| `server/papertown/paseo.py` | `send` 带 `behavior`。`Feed`：启动并读取 `link.mjs watch` |
| `server/papertown/agents.py` | `watch_of`、`overview`、`seen`、排队消息的处理、`say` 的 `interrupt`、读实时流 |
| `server/papertown/api.py`、`db.py` | 新接口。`agents` 表增加 `seen_at` |
| `server/papertown/pi/bridge.ts` | 排队的消息留在 bridge 里，按编号改为现在发或撤回 |
| `web/src/agents/` | `Agents.tsx`（员工页）、`Compose.tsx`（共用的输入组件）、`overview.ts`（总览的共用订阅）、`live.ts`（对话的实时重读和已读）、`watch.tsx`（分桶的文字和颜色） |
| `web/src/components/AgentRoom.tsx`、`console/LeadChat.tsx`、`progress/Ask.tsx`、`progress/NodeConversation.tsx` | 对话组件改用 `Compose`，导出给员工页复用 |
| `web/src/App.tsx`、`route.ts`、`settings.ts` | 第三栏、计数、默认发送方式 |

## 7. 这一版不做

- 不直接对接 Claude Agent SDK、Codex app-server 或 ACP，统一经 Paseo。
- 不读终端屏幕判断状态（herdr 的做法），只用协议事件。
- 系统通知、声音和手机推送留给 Paseo 自己的客户端。
- 不改 Paseo 里的已读状态，Papertown 只记自己的 `seen_at`。
- 页面底部的小助手对话框保留自己的输入框（它每条消息都带着页面上下文，并会自动命名对话），员工页里和小助手对话用的是共用的输入组件。

## 8. 实测

2026-11-21 经本机 Paseo 0.16.2，用真实 agent 各跑一遍六步：第一轮完成、插话、排队与撤回、排队后立即发送、打断并发送、停止。

| | Claude Code（Sonnet 5.5） | Codex（GPT-6-Luna） | Antigravity（Gemini 3.8 Flash） |
| --- | --- | --- | --- |
| 第一轮完成后进入「待查看」，标记已读后变为「待命」 | 通过 | 通过 | 通过 |
| 插话 | 在同一轮内生效 | 在同一轮内生效，两条命令之间收到 | 取消当前命令后从头执行，即退化为打断后重做 |
| 排队：本轮结束后才送达，撤回的一条未发出 | 通过 | 通过 | 通过 |
| 打断并发送 | 1.2 秒内停下并回复 | 2.4 秒内停下并回复 | 16.8 秒内停下并回复 |
| 停止 | 通过 | 通过 | 通过 |

- 实时流全程在线，状态和正在执行的命令在页面上即时更新。
- 流式回复的各段由 `Activity` 拼成一条。Paseo 报告空闲的时刻比最后一段回复早约半秒，这期间列表显示的是不完整的句子，随后补全。
- Claude Code 的会话里，插话消息有时不出现在 Paseo 的对话记录中，回复本身照常按插话修改。
- Claude Code 会把 `sleep 90` 这类命令转入后台并结束本轮，这时打断和停止无从测起。标准流程因此用 `python3 -c "import time; time.sleep(90)"` 并要求在前台执行，Claude Code 的打断和停止按这个流程补测通过。

标准流程和预期结果归档在 `server/scripts/watch_flow.json`，用 `server/scripts/verify_watch.py` 对真实 agent 运行（需要 Paseo 守护进程已在运行，脚本不会启动它）：

```bash
cd server
.venv/bin/python scripts/verify_watch.py --agent claude:claude-sonnet-5-5:low --agent codex:gpt-6-luna:low \
    --agent antigravity:gemini-3.8-flash-low [--steps interrupt,stop] [--clean]
```

每一步发出的消息和预期见下表，`{n}` 是每次运行随机生成的标记。

| 步骤 | 发出 | 预期 |
| --- | --- | --- |
| 第一轮 | 启动时的项目简报 | 进入「待查看」（`finished`），标记已读后为「待命」 |
| 插话 | 任务：三次 `sleep 10` 后回复 A_DONE。运行中插话：改成「A_DONE STEER_{n}」 | 事件 `delivered`、`steered` 为真，最后的回复含 A_DONE STEER_{n} |
| 排队与撤回 | 任务：两次 `sleep 8` 后回复 B_DONE。运行中排队 QUEUED_{n} 和 DROP_{n}，撤回后者 | 事件 `held` 为真，排队数先 2 后 1，B_DONE 的回复在 QUEUED_{n} 之前，DROP_{n} 从未出现 |
| 立即发送 | 任务：两次 `sleep 8` 后回复 E_DONE。运行中排队「E_DONE NOW_{n}」并改为现在发 | 事件 `delivered` 为真、`held` 为假，最后的回复含 E_DONE NOW_{n} |
| 打断并发送 | 任务：前台执行 90 秒的命令后回复 C_DONE。运行中打断并发送 INTERRUPTED_{n} | 事件 `interrupted` 为真，60 秒内回复 INTERRUPTED_{n}，没有 C_DONE |
| 停止 | 任务：前台执行 90 秒的命令后回复 D_DONE。运行中停止 | 30 秒内回到空闲，没有 D_DONE |

## 9. herdr 接入

[herdr](https://github.com/herdrdev/herdr) 是终端复用器，持有用户手动开的 Claude Code、Codex 等终端会话，并通过读屏幕和 agent 自己上报的 hook 判断状态。Paseo 托管 Papertown 启动的 agent，herdr 补上用户在终端里自己开的那部分。两者并存。

### 9.1 对接方式

herdr 的服务在 `~/.config/herdr/herdr.sock` 提供 JSON API（协议 22）。Papertown 直接连这个 socket，不经 CLI：

| 用途 | 方法 |
| --- | --- |
| 列出 agent 和状态 | `agent.list`：`agent_status`（`idle` / `working` / `blocked` / `done` / `unknown`）、`completion_seq`、`cwd`、`foreground_cwd`、`title`、`terminal_id`、`pane_id` |
| 实时变化 | `events.subscribe`，订阅 `pane.agent_status_changed`、`pane.agent_detected`、`pane.closed`、`pane.exited` |
| 看对话 | `agent.read`，`source: recent_unwrapped`，得到终端里的文字 |
| 发消息 | `agent.prompt`。agent 停在批准或提问对话框时，herdr 以 `agent_blocked` 拒绝 |
| 打断、按键 | `agent.send_keys`，例如 `esc`、`enter`、`1` |

Papertown 只读写 herdr 已有的会话，不启动 herdr 服务，不新建窗格，不安装 herdr 的 hook。herdr 没在运行时，员工页照常工作，只是没有终端会话。

### 9.2 状态

| herdr | 分桶 | 说明 |
| --- | --- | --- |
| `blocked` | 等你（`why: terminal`） | 终端里出现了批准或提问的对话框 |
| `working` | 工作中 | |
| `idle`、`done`，且有 Papertown 未看过的完成 | 待查看 | 以 `completion_seq` 判断：大于 Papertown 记下的已读序号即未读 |
| `idle`、`done`，已看过 | 待命 | |
| `unknown` | 待命（`why: unknown`） | 有 agent，但 herdr 判断不出状态 |

herdr 自己的已读状态由聚焦操作改变，会影响用户的 herdr 界面，所以 Papertown 用 `terminal_id` 和 `completion_seq` 另记一份。`doing` 取终端标题（Claude Code、Codex 会把当前任务写进标题）。

### 9.3 发送

| 方式 | 做法 |
| --- | --- |
| 插话 | agent 工作中时直接 `agent.prompt`，怎么处理由终端里的 agent 决定（Claude Code 和 Codex 会把它排进当前这一轮） |
| 排队 | Papertown 保存，状态变为 `idle` 或 `done` 后发出 |
| 打断并发送 | 发 `esc`，等它离开 `working`（至多 10 秒），再发消息 |
| 停止 | 发 `esc` |

处于「等你」时，输入框换成一排按键（Enter、Esc、↑、↓、1、2、3、y、n），对着上方的终端画面处理对话框。

终端文字用 `agent.read` 的 `recent_unwrapped` 读最近 200 行。Claude Code、Codex 这类全屏界面的历史在备用屏幕上，herdr 只能在它们空闲时滚动取回，工作中读历史会返回 `agent_not_idle`，这时改读当前画面（`visible`）。

### 9.4 归属和页面

- 终端会话按工作目录归到项目：目录落在某个项目的代码目录、论文目录或它的员工工作目录里，就列在这个项目下，标记「终端」。其余的列在「其他终端」组。
- 选中一个终端会话，中栏显示终端文字（每 2 秒刷新，空闲时 10 秒，状态事件到达时立即刷新）和上面的输入框，右栏显示 herdr 的工作区、窗格、目录和 agent 种类。
- 终端会话不是项目员工：它没有 `pt` 命令，不接派发的任务。

### 9.5 接口

- `GET /api/agents/overview` 增加 `herdr: {ok, note, live}`，每组增加 `terminals: [Terminal]`，另有 `others: [Terminal]`。`counts` 包括终端会话。
- `Terminal`：`{id: "herdr:<terminal_id>", terminal_id, pane_id, workspace_id, name, kind, title, cwd, watch}`，`watch` 与员工相同。
- `GET /api/terminals/{id}`：会话信息、终端文字、排队的消息。
- `POST /api/terminals/{id}/say`：`{text, mode: steer | queue | interrupt}`。
- `POST /api/terminals/{id}/keys`：`{keys: [...]}`，只接受上面那一排按键和 `ctrl+c`。
- `POST /api/terminals/{id}/queue/{queue id}`：`{what: now | drop}`。
- `POST /api/terminals/{id}/seen`。
- 总线事件 `terminal`：`{id}`，某个终端会话变了。

### 9.6 联调结果

2026-11-22 在用户已开的 herdr 0.9.3 里，起一个临时 Papertown 实例，测了 Claude Code（Sonnet 5.5）和 Codex（gpt-6-luna）各一个终端会话。前者的目录在项目的代码目录里，后者在无关目录。

| 项目 | Claude Code | Codex |
| --- | --- | --- |
| 归属 | 列在项目 #1 下 | 列在「其他终端」 |
| 启动对话框 | 「是否信任此目录」显示为「等你」，用按键 ↓、Enter 处理 | 「Hooks need review」herdr 报为 `idle`，未进「等你」，用按键 3 处理 |
| 直接发送、完成后待查看、已读后待命 | 通过 | 通过 |
| 插话 | 通过，并入当前这一轮 | 通过，并入当前这一轮 |
| 排队 | 通过，本轮结束后送达 | 通过，本轮结束后送达 |
| 打断并发送 | 通过，2.3 秒后开始回答 | 通过，5.0 秒后开始回答。被打断的命令留在 Codex 的后台终端里继续运行 |
| 停止 | 通过 | 通过 |

联调中发现工作中读不到终端文字（见 9.3 的 `agent_not_idle`），已修正。

