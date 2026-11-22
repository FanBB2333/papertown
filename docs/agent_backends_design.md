# 员工的终端后端：herdr、tmux 与 headless

## 1. 要解决的问题

Papertown 的员工（代码员工、写作员工、项目负责人、节点 agent、小助手）可以跑在 Paseo 里，也可由 Papertown 在终端里启动和管理 Claude Code、Codex、Antigravity。项目负责人按项目开关常驻，代码员工和写作员工可由负责人用 `pt hire` 启动：

- **herdr**：每个员工一个 herdr 标签页，用户在自己的 herdr 里能看到、能接手。
- **tmux**：最原生的做法，每个员工一个 tmux 窗口，用户可以 `tmux attach` 进去。
- **headless**：Papertown 自己在后台托管伪终端，不依赖 tmux 或 herdr，网页就是它的窗口（见第 7 节）。

三种后端遵守同一条交互原则：CLI 一律以真实的交互界面（TUI）运行，网页上的每个操作都换成终端里的真实输入送达。发消息是一次粘贴加回车，停止是 Esc，回答对话框是数字键或方向键加回车。Papertown 不使用反向代理，不改 CLI 的 API 地址，也不用 SDK、`app-server`、`-p`/`exec` 这类结构化接口驱动 agent。读回的只有三样：终端画面、CLI 自己写在本机的会话日志、各 CLI 官方的 hooks、notify 和状态栏回报的元数据（事件名、会话 id、工具名，不含对话内容，见 3.3）。

两种后端都要做到和 Paseo 员工同样的事：启动时带上模型、思考强度、工作目录和项目简报，之后能插话、排队、打断并发送、停止，员工页能看到它在工作、做完了、在等你还是空闲，本机会话日志能按会话 id 算到这个员工头上。

## 2. 能用的信号

调研日期 2026-11-22，依据本机安装的 Claude Code 2.1.330、Codex 0.169.0、agy 1.5.14、herdr 0.9.3（协议 22）、tmux 3.7c 的帮助、源码和官方文档。所有做法都只作用于本次启动的会话，不改用户的全局配置。

| CLI | 启动参数 | 状态信号 | 会话 id |
| --- | --- | --- | --- |
| Claude Code | `--model`、`--effort low\|medium\|high\|xhigh\|max`、`--add-dir`、`--settings <文件>` | `--settings` 里的 hooks：`SessionStart`（只用来拿会话 id）、`UserPromptSubmit` 和 `PreToolUse`（工作中）、`PermissionRequest` 和 `Notification` 的 `permission_prompt`、`elicitation_dialog`（等你）、`Stop`（这一轮结束）。带 `agent_id` 的是子 agent 的事件，忽略 | `--session-id <uuid>` 由 Papertown 预先指定 |
| Codex | `-m`、`-c model_reasoning_effort="…"`、`-c notify=[…]` | `notify` 只在一轮结束时调用（`agent-turn-complete`）。等批准没有不经信任确认的信号：新 hooks 会弹「Hooks need review」，`--dangerously-bypass-hook-trust` 会连带放行用户自己未审核的 hooks，采用现有 notify 和终端画面识别 | `notify` 载荷里的 `thread-id`，或按工作目录和启动时间找到的会话日志里第一条 `session_meta` |
| Antigravity | `--model`（id 自带思考强度，如 `gemini-3.8-flash-low`）、`--add-dir`、`--settings <JSON>`（只对本次会话生效） | `--settings` 里的状态栏命令：每次状态变化收到 `agent_state`（`idle`、`working`、`tool_use` 等）和 `tool_confirmation_pending`，至多每 300 毫秒一次 | 状态栏载荷里的 `conversation_id` |

另外两条通用信号：

- **画面不动**：三种 CLI 工作时都有计时或动画。员工处于工作中，画面却连续 15 秒没有变化，就判为「等你」（终端里可能有对话框）。画面一变就回到工作中。Codex 的等批准只能靠这一条。
- **进程退出**：tmux 窗口设 `remain-on-exit`，用 `#{pane_dead}` 判断。herdr 看 agent 是否还在列表里。

herdr 后端里 Claude Code 和 Codex 的状态直接用 herdr 自己识别的 `agent_status` 和 `completion_seq`，和员工页里的 herdr 终端会话一致，上面的 hooks 和 notify 只用来拿会话 id。Antigravity 例外：没装 herdr 自己的集成时，herdr 能看出它在工作和停下，却从不把一轮计入 `completion_seq`，所以 Antigravity 在 herdr 里也按状态栏回报判断状态。

## 3. 设计

### 3.1 一层终端后端

新增 `server/papertown/backends.py`：

- `TerminalBackend` 接口：`open(spec) → handle`、`alive(handle)`、`screen(handle) → 文字`、`glance(handle) → 当前画面`（每秒的状态同步只读这个，herdr 下不触发历史回滚）、`submit(handle, text)`（作为一次粘贴发送再回车）、`keys(handle, keys)`、`state(handle) → {status, seq, since}`、`close(handle)`。
- `HerdrBackend`：每个项目一个 herdr 工作区（`workspace.create`，标签「Papertown #序号 标题」，小助手一个「Papertown」工作区），每个员工一个标签页（带工作目录和 `PAPERTOWN_*` 环境变量），在标签页的窗格里 `agent.start`。新建的工作区自带一个标签页，项目的第一个员工直接用它（`tab.rename` 改为员工名），之后的员工用 `tab.create` 新建，这样关掉项目的最后一个员工时工作区随之关闭，不留空的 shell。新标签页的 shell 还在加载配置时 herdr 会回 `agent_pane_busy`，此时每 0.3 秒重试，至多 20 秒。agent 名为 `pt<序号>-<岗位或节点>`，只含小写字母、数字、`-`、`_`，不超过 32 个字符。`agent.start` 拿到终端 id 就返回，是否就绪由状态同步判断。发送用 `agent.prompt`，按键用 `agent.send_keys`，读屏用 `agent.read`（工作中退回读当前画面），关闭用 `tab.close`。
- `TmuxBackend`：用 Papertown 已有的 tmux 服务器（`tmux -L papertown`，与 pi 共用）。每个项目一个会话 `pt-<序号>`（小助手为 `pt-assistant`），每个员工一个窗口，用 `new-session`/`new-window -P -F '#{window_id} #{pane_id}'` 创建，记下窗口和窗格 id。CLI 作为窗格的进程直接运行，`remain-on-exit on`。发送用 `load-buffer` 加 `paste-buffer -p -r -d`，再单独发 `Enter`。读屏用 `capture-pane -p -J`。按键用 `send-keys`（Esc 为 `Escape`）。关闭用 `kill-window`。

员工这边新增两种运行方式 `herdr` 和 `tmux`，`agents.py` 里凡是按运行方式分支的地方（启动、发送、排队放行、打断、停止、状态、退休、重连），这两种都交给一个 `Hosted` 服务处理，不再在 Paseo 分支里加条件。

### 3.2 启动

1. 和 Paseo 员工一样写好工作说明（`AGENTS.md`，主目录就是工作目录时另写 `CLAUDE.md`）和 `.papertown/pt` 工具。
2. 把 Paseo 员工的第一条消息（说明加项目简报）写进主目录的 `.papertown/intro.md`。
3. 按 CLI 组装参数：

| CLI | 参数 |
| --- | --- |
| Claude Code | `--model M`、思考强度为 low 至 max 时加 `--effort`、`--session-id <新 uuid>`、`--settings <主目录>/.papertown/claude-settings.json`（只含上表的 hooks）、`--add-dir <主目录>`，最后一个参数是第一条消息 |
| Codex | `-m M`、思考强度不为 off 时加 `-c model_reasoning_effort="E"`、`-c notify=["<pt>","hook","codex"]`，最后一个参数是第一条消息 |
| Antigravity | `--model M`、`--add-dir <主目录>`、`--settings '{"statusLine":{"type":"command","command":"<pt> hook agy","stack_with_default":true}}'`、`-i <第一条消息>` |

   第一条消息只有一行：「请先完整阅读 <主目录>/.papertown/intro.md，其中是你在 Papertown 的工作说明和项目简报。读完后说说你打算怎么开始。」单行能直接作为启动参数（herdr 的 `agent.start` 不接受含换行的参数），也避免在 CLI 还没就绪时粘贴长文本。
4. CLI 的路径依次取设置（`PAPERTOWN_CLAUDE_BIN`、`PAPERTOWN_CODEX_BIN`、`PAPERTOWN_AGY_BIN`）和 PATH，跳过其他程序装的包装脚本（例如 cmux 的 `agy` 包装会给会话装 cmux 自己的 hooks）。
5. 首次在某个目录启动 Claude Code 会出现「是否信任此目录」，Codex 可能出现 hooks 审核等对话框。这时员工处于「等你」，员工页显示终端画面和按键，由用户处理。Papertown 不替用户回答，也不写用户的信任配置。
6. 已关闭的员工再次启动时，若知道上次的会话 id，就接着那个会话：Claude Code 用 `--resume <id>`，Codex 用 `resume <id>`，Antigravity 用 `--conversation <id>`。这时的第一条消息改为告诉它 Papertown 重新接上了会话，说明和简报若有更新请重读，然后继续之前的工作。

### 3.3 回报：`pt hook`

`pt` 增加 `hook` 子命令，作为 hooks、notify 和状态栏的命令：

- 从 stdin（Claude Code、Antigravity）或最后一个参数（Codex notify）读取 JSON，只保留白名单字段：事件名、`session_id`/`thread-id`/`conversation_id`、`notification_type`、`tool_name`、`agent_state`、`tool_confirmation_pending`、`agent_id`、`source`、`transcript_path`。提示词、回复、工具参数一律丢弃，不出本机进程。
- 发到 `POST /api/agents/{id}/hook`，用员工自己的令牌鉴权（和 pi 的 bridge 相同）。超时 2 秒，出错静默，退出码为 0，不阻塞 CLI。
- 状态栏模式下，同样的状态不重复发送（上次的状态记在 `.papertown/` 下），并输出「Papertown」作为状态栏文字。

### 3.4 状态

终端员工的状态记在 `agents.term`（JSON）：后端、句柄、提供方、`status`（`starting`、`idle`、`working`、`blocked`、`done`、`exited`）、`seq`（已完成的轮数）、`seen_seq`、`since`、最近一次工具名、画面摘要的时间戳。变化时写库并在总线上发 `agent` 事件。

| 来源 | 变为 |
| --- | --- |
| Papertown 发出消息 | `working` |
| 启动后画面 5 秒不动 | `blocked`（`startup`，画面一变回到 `starting`） |
| `UserPromptSubmit`、`PreToolUse`、Antigravity `working`/`tool_use` | `working` |
| `PermissionRequest`、`Notification` 的等你类型、Antigravity `tool_confirmation_pending` | `blocked` |
| Claude `Stop`、Codex `agent-turn-complete`、Antigravity 由工作中变为 `idle` | `done`，`seq` 加一 |
| 工作中画面 15 秒未变 | `blocked`（`still`，画面一变回到 `working`） |
| Papertown 发出 Esc 后画面 2 秒不动 | `idle`（被 Esc 打断的一轮，Claude Code 不触发 `Stop`，Codex 也不发 notify） |
| 进程退出、窗口或 agent 消失 | `exited` |

每次启动都带着第一条消息，所以启动只会以工作结束，不会直接进入待命。启动阶段的就绪类信号（Claude 的 `SessionStart`，Antigravity 状态栏的 `idle`、`initializing`，herdr 报告的空闲）都不改变状态，启动画面静止时就是对话框挡住了它，例如信任目录、登录或 Codex 的 hooks 审核（herdr 把这个对话框报告为空闲）。

herdr 后端里的 Claude Code 和 Codex 用 herdr 的 `agent_status` 和 `completion_seq` 代替上表中来自 hooks 和 notify 的几行，Antigravity 仍按上表。

状态同步每秒在锁外读一次终端，再在锁内合并状态。herdr 回应偶尔要好几秒，读终端时持锁会让同时到达的回报等锁超时而被丢弃。

员工页的分桶与 herdr 终端会话相同：`exited` 为未启动，`blocked` 为「等你」（`why` 为 `terminal`），有未答复的 `pt ask` 时为「等你」，`seq` 大于 `seen_seq` 为「待查看」，`working`、`starting` 为工作中，其余为待命。标记已读时 `seen_seq = seq`。

### 3.5 发送

与 herdr 终端会话一致，排队由 Papertown 保管：

| 方式 | 做法 |
| --- | --- |
| 插话 | 直接发送，怎么处理由 CLI 决定（Claude Code 并入当前这一轮，Codex 回车即插话，Antigravity 按它自己的设置） |
| 排队 | 记为排队消息（与 Paseo 员工共用 `agent_events` 的 `held`），员工进入 `idle` 或 `done` 后按顺序一条一条发出 |
| 打断并发送 | 发 Esc，等它离开工作中（至多 10 秒），再发送。超时则不发送并报错 |
| 停止 | 发 Esc |

派给节点 agent 的任务、`pt` 的催促和汇报回复都走同一个发送入口。

### 3.6 会话 id 与用量

Claude Code 的会话 id 在启动时就写进 `agent_sessions`。Codex 和 Antigravity 的在第一次回报时写入。herdr 后端另外读 herdr 报告的 `agent_session`。用量统计照旧按 `agent_sessions` 把会话算给员工和项目。

### 3.7 重启与关闭

- Papertown 重启后，按 `agents.term` 里的句柄重新找到窗口或 agent。tmux 窗口和 herdr 标签页不随 Papertown 退出。找不到的标为 `exited`。
- 员工页的上下文栏有「关闭终端」：tmux 关窗口，herdr 关标签页，员工变为未启动，会话 id 保留，下次启动接着用。
- 节点 agent 退休时同样关闭它的终端。
- Papertown 从不启动或关闭 herdr 服务器。herdr 没在运行时，herdr 后端不可用并说明原因。

### 3.8 页面

- **招员工**：在 Paseo、pi 之外加一张「终端」卡片：选后端（herdr、tmux，不可用的置灰并写明原因）、CLI（只列本机装了的 Claude Code、Codex、Antigravity）、模型和思考强度（用 Paseo 的模型目录，Paseo 不可用时只能用 CLI 的默认模型），按钮「在 herdr 中启动」「在 tmux 中启动」。
- **员工页**：终端员工的行带后端标签（herdr、tmux）。选中后中栏与 herdr 终端会话相同，分「对话」「终端」两个标签（见 3.9），下方是共用的输入框（插话、排队、打断并发送、停止，排队的消息可现在发或撤回）。右栏显示后端、CLI、模型、会话 id、接入方式（tmux 为 `tmux -L papertown attach -t <会话>:<窗口>`，herdr 为工作区和标签页）和「关闭终端」，可收起，窗口窄于 1180px 时改为抽屉。
- **新建员工**：员工页左上角的按钮打开弹窗，依次选择项目、岗位（代码员工、写作员工、项目负责人）、运行方式（Paseo、herdr、tmux、pi，不可用的置灰并写明原因）和模型，直接启动。该岗位的员工已在运行时改为「打开对话」。
- 由 herdr 后端启动的员工不再出现在「终端」或「其他终端」里。
- **设置 › 员工 Agent**：新增「默认运行方式」（Paseo、herdr、tmux），节点任务派发、负责人常驻和 `pt hire` 启动员工时使用。模型按各岗位默认设置，`PAPERTOWN_WORKER_MODEL` 留空时沿用负责人默认值。

### 3.9 对话记录与提示弹窗

终端员工和 herdr 终端会话与 Paseo 员工使用同一个对话组件，各后端只提供读取、发送、按键和回答四个动作。

- **对话**：对话内容在请求时从 CLI 自己的会话日志读取，只按会话 id 定位文件（Claude Code 在 `projects/*/<id>.jsonl`，Codex 在 `sessions/年/月/日/rollout-*-<id>.jsonl`，Antigravity 在 `brain/<id>/.system_generated/logs/`），只读文件末尾 4 MB，Papertown 自己不保存任何对话内容。读出的条目与 Paseo 相同：用户消息、回复、工具调用（名称、160 字以内的参数、状态）和「这一轮已被打断」。思考内容、工具输出、子 agent 的对话和斜杠命令的记录不显示。日志目录内的符号链接一律不跟随。`PAPERTOWN_TRANSCRIPTS=0` 关闭读取，此时只显示终端画面。会话尚未建立或找不到日志时，「对话」标签写明原因，页面停在「终端」标签。
- **提示弹窗**：员工因终端里的对话框停住时（信任目录、hooks 审核、权限确认），服务端从可见画面里解析出标题、正文和选项（带编号的列表，或带光标的列表），页面弹出同一个弹窗列出选项，点击即回答。回答前服务端重新读取画面并核对摘要，画面已变化则返回 409，页面刷新后再让用户选择。带编号的选项发送对应数字键，其余按光标位置发送方向键和回车。解析不出选项时弹窗显示画面末尾几行和按键行。Paseo 员工的权限请求使用同一个弹窗（允许、拒绝）。弹窗只在用户点击时发送按键，Papertown 不自行回答。

## 4. 接口

- `GET /api/backends`：`{paseo: {ok, note}, herdr: {ok, note}, tmux: {ok, note}, headless: {ok, note}, clis: {claude, codex, antigravity}}`，`clis` 为找到的路径或 null。
- `POST /api/agents/{id}/start` 的 `runtime` 增加 `herdr`、`tmux`、`headless`，其余参数不变。
- `GET /api/agents/{id}/screen`：`{text, term, prompt}`，`prompt` 为 `{digest, title, body, options: [{index, label, current, key}], hint}` 或 null。
- `GET /api/agents/{id}/timeline`：终端员工也可用，返回 `{agent, items, queued, paseo: {}, transcript: {ok, note}}`。
- `POST /api/agents/{id}/prompt`：`{digest, option}`，回答画面上的对话框。画面已变化返回 409。
- `GET /api/terminals/{id}/timeline`、`POST /api/terminals/{id}/prompt`：herdr 终端会话的对话和回答，`GET /api/terminals/{id}` 增加 `prompt`。
- `POST /api/agents/{id}/keys`：`{keys: [...]}`，按键范围与 herdr 终端会话相同。
- `POST /api/agents/{id}/close`：关闭终端。
- `POST /api/agents/{id}/hook`：`pt hook` 专用，令牌鉴权。
- 员工的公开数据增加 `term`（去掉令牌和内部字段）和 `attach`。

## 5. 测试

- **单元测试**：用真实 tmux（独立的 `-L` 套接字）和一个模拟 CLI 的小脚本：它读输入、打印画面、按需调用 `pt hook`，模拟就绪、工作、对话框、一轮结束和退出。覆盖启动参数的组装、第一条消息、插话、排队放行、打断等待、停止、画面不动判为等你、进程退出、关闭与接着会话、`pt hook` 的白名单、重启后重新找到窗口。herdr 后端用扩展后的 FakeHerdr（`workspace.create`、`tab.create`、`tab.rename`、`agent.start` 及其 `agent_pane_busy`、`agent.get` 的就绪、`tab.close` 及随之关闭的工作区）。
- **真实联调**：`verify_watch.py` 增加 `--runtime paseo|herdr|tmux`，对终端后端从终端画面里检查回复，跑同一套标准流程。herdr 需要用户已开着，脚本不会启动它。tmux 用每次联调独立的 tmux 服务器（`-L papertown-live-<随机后缀>`），项目编号从 #1 起，与正在运行的 Papertown 互不干扰。Antigravity 的回复不带圆点，是缩进两格的正文，脚本按这个格式另行识别。

### 5.1 真实联调结果

2026-11-22，Claude Code 用 Sonnet 5.5，Codex 用 gpt-6-luna，Antigravity 用 Gemini 3.8 Flash（Low），在 tmux 和用户已开着的 herdr 里各跑一遍标准流程：

| | tmux | herdr |
| --- | --- | --- |
| Claude Code | 六步通过，会话 id 已记录 | 六步通过，会话 id 已记录 |
| Codex | 六步通过，会话 id 已记录 | 六步通过，会话 id 已记录 |
| Antigravity | 六步行为正确，会话 id 已记录 | 六步通过，会话 id 已记录 |

- 每次联调用新的临时目录，Claude Code 和 Antigravity 启动时都弹出信任目录的对话框，Codex 弹出 hooks 审核（来自本机 Codex 配置里的 hook）。三者都在 5 到 11 秒内显示为「等你」，经员工页的按键处理后继续。
- Antigravity 在工作中收到的消息进入它自己的队列，插话的回复作为单独的一轮出现。它的回复是缩进两格的正文，不带圆点。tmux 那一轮的回复识别是对照这一轮的终端画面离线核对的。
- 联调中修正的问题：herdr 工作区多出空标签页，新标签页的 shell 还在加载时启动失败，herdr 把 Codex 的 hooks 审核报告为空闲，启动阶段的就绪信号让员工直接变为待命，herdr 不计 Antigravity 的轮次，读终端时持锁导致回报被丢弃，herdr 读屏偶尔超过 2 秒。

## 6. 这一版不做

- 不自行回答信任、登录、hooks 审核等对话框（由用户在提示弹窗里选择），也不写这些 CLI 的全局配置。
- 不使用 Codex 的新 hooks 和 `--dangerously-bypass-hook-trust`。
- 不支持把已有的 tmux 窗口或 herdr 终端会话转为员工（herdr 终端会话仍在员工页的「终端」组里直接操作）。
- pi 仍按原来的方式运行。

## 7. headless：Papertown 自己的后台终端

2026-11-22 新增。headless 指 Papertown 在后台自己管理终端：每个员工仍然有一个真实的终端，CLI 在里面运行它的交互界面，只是这个终端不在 tmux 或 herdr 里，也没有窗口，网页就是查看和操作它的地方。它不是 Claude Code 的 `-p` 或 Codex 的 `exec` 那种无界面模式。

### 7.1 结构

- **守护进程 `server/papertown/ptyd.py`**：一个独立进程持有所有后台终端。每个终端是一个伪终端（`pty.fork`），子进程是新会话的首进程，伪终端是它的控制终端，窗口大小 160×48，`TERM=xterm-256color`。服务端第一次在 headless 里启动员工时拉起它（`python -m papertown.ptyd <socket>`，自行脱离为孤儿进程，不是服务端的子进程），之后它与服务端各自运行：服务端重启时员工照常工作，重启后按句柄里的终端 id 重新找到。连续 10 分钟没有任何终端时它自行退出。同一个套接字只会有一个守护进程（`ptyd.sock.lock` 加锁）。
- **套接字**：`<数据目录>/ptyd.sock`，路径过长时改放 `$TMPDIR/papertown-<uid>/<哈希>.sock`，权限 600。每次连接一个 JSON 请求、一个 JSON 回答：`ping`、`open`、`list`、`state`、`screen`、`paste`、`keys`、`close`。日志写在 `<数据目录>/ptyd.log`。
- **屏幕 `server/papertown/vt.py`**：一个精简的终端模拟器，处理 agent CLI 用到的控制序列：光标移动、擦除、插入删除字符和行、滚动区域（Codex 在输入框上方插入历史就靠它）、备用屏幕、宽字符和组合字符、同步输出（读到的是上一帧完整画面）。颜色和字形属性丢弃，读出的文字与 `tmux capture-pane -p -J` 一致：自动折行的行拼回一行，行尾空格去掉。CLI 启动时会询问终端（光标位置、设备属性、窗口大小、前景和背景色），模拟器照 xterm 的格式回答，否则 Codex 读不到光标位置会启动失败。键盘增强协议（kitty、CSI u）的询问不回答，CLI 随之退回普通按键编码。
- **后端 `HeadlessBackend`（`backends.py`）**：与 `TmuxBackend` 同一套接口。终端的环境变量取服务端的环境，去掉服务端所在终端程序和复用器的变量（`TMUX`、`TERM_PROGRAM`、`GHOSTTY_*`、`CMUX_*` 等），免得 CLI 以为自己在那些程序里。`attach` 为空，员工页的接入方式写「Papertown 后台终端，在此页面查看与操作」。

### 7.2 输入只走键盘

| 网页上的操作 | 终端收到的字节 |
| --- | --- |
| 发消息 | CLI 打开了 bracketed paste（三种 CLI 都会打开）时为 `ESC[200~ 正文 ESC[201~`，0.1 秒后再发 `\r`。换行保持为 LF，与 `tmux paste-buffer -p -r` 相同 |
| 停止、打断 | `ESC` |
| 方向键 | `ESC[A`、`ESC[B`，CLI 开了应用光标键模式时为 `ESCOA`、`ESCOB` |
| 回车、Ctrl+C、数字和 y/n | `\r`、`\x03`、字符本身 |

多个按键之间隔 30 毫秒，让 CLI 一次读到一个。状态判断与 tmux 完全相同：hooks、notify、状态栏回报，加上画面是否变化、进程是否退出（守护进程 `waitpid` 到子进程退出后，在画面末尾写一行「进程已退出，退出码 N」，终端保留到关闭为止，失败原因看得见）。关闭终端时向进程组发 SIGHUP，3 秒后仍在的进程组发 SIGKILL。

### 7.3 验证

- `tests/test_backends.py` 的三组终端测试同时跑 tmux 和 headless：启动参数、第一条消息、多行粘贴、插话、排队放行、打断等待与超时、停止、对话框判为等你、关闭后接着会话、服务端重启后重新接上终端、进程退出。每个测试用自己的数据目录和守护进程，结束时停掉。
- `tests/test_vt.py` 覆盖移动与擦除、折行拼接、宽字符、跨读取的 UTF-8、滚动区域与历史、插入删除、备用屏幕、启动询问的回答、OSC 和 DCS 字符串、同步输出。
- 本机真实的 Claude Code 2.1.330、Codex 0.169.0、Antigravity 在 headless 终端里以临时主目录启动（不碰用户的配置和信任状态，不发任何消息）：Claude Code 的主题选择、Codex 的登录和更新提示、Antigravity 的登录菜单都完整显示，三者都打开了 bracketed paste，Codex 与 Antigravity 的菜单按方向键后选中项随之移动。

