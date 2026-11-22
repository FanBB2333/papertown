# 负责人常驻：项目由本机的 agent 推进

## 1. 要解决的问题

Papertown 原来有两套 agent。一套是员工（项目负责人、代码员工、写作员工、小助手），跑在本机的 Paseo、herdr 或 tmux 里，用的是 Claude Code、Codex、Antigravity 这些 CLI 自己的登录。另一套是流水线执行器：进程内的工具循环，经 Anthropic 或 OpenAI 兼容接口按 key 调用模型，由人才市场编队、银行按美元记账，没有 key 时用脚本模板冒充。

第二套只服务于「放入一颗 idea」的项目和展示样例，接入的本地项目从来不经过它。同一件事有两种做法，其中一种还要求用户另配 key，这不成立。本次改动删掉执行器，项目的全部推进交给负责人：

- 小镇自己不调用任何模型，也不持有任何模型或 embedding 的 key。
- 每个在做的项目有一位常驻的负责人。小镇启动时它就在后台运行，项目主页上有开关。
- 负责人能办完项目里的事：启动员工、派活、提交实验、交工序产出、推进和收尾工序。硬卡口照旧由代码把关。

## 2. 保留和删除

保留工序的进度结构：`lines`、`stages`、`items` 三张表，八道工序，每道工序的硬检查和硬卡口，研究回路，项目卡片，小镇里的建筑。它们描述项目走到哪一步，和谁来执行无关。

删除执行器及其配套：

| 删除 | 说明 |
| --- | --- |
| `pipeline.py` 里的执行线程 | `_hatch`、`_produce`、`_ship`、`_spawn`、`resume`、`recover`、`_held`、`adjust`、`hatch` |
| `stages.py`、`agent.py` | 各工序的任务定义和进程内工具循环 |
| `llm/` 的三个 provider | Anthropic、OpenAI 兼容、脚本 provider。`pricing.py` 移到 `papertown/pricing.py`，用量统计还在用 |
| `market.py`、`bank.py` | 虚构员工的编队和等级、美元账本 |
| `tools.py` 和 `Town._register_tools` | 只给进程内工具循环用的工具注册表 |
| `compute.py` | 模拟电厂和模拟结果 |
| `library.Embedder` | 经 OpenAI 兼容接口取 embedding。检索只用 BM25 加关键词覆盖率 |
| 设置项 | `PAPERTOWN_PROVIDER`、`ANTHROPIC_API_KEY`、`PAPERTOWN_OPENAI_*`、`PAPERTOWN_MODEL_*`、`PAPERTOWN_EFFORT`、`PAPERTOWN_EMBED_*`、`PAPERTOWN_WEEKLY_BUDGET`、`PAPERTOWN_LINE_BUDGET`、`PAPERTOWN_SIM_GPU_SECONDS` |
| 接口 | `POST /api/lines/{id}/hatch`、`/resume`、`/adjust`，`POST /api/chat`，`GET`/`POST /api/llm`，`GET /api/workers` |
| 依赖 | `anthropic`、`openai` |

`runs`、`ledger`、`workers`、`worker_events` 四张表不再读写，建表语句留着，旧数据库照常打开。

## 3. 项目的状态

`lines.status` 只剩四个值：`running`（在做）、`linked`（接入的本地项目）、`done`（已出厂）、`dropped`（放弃）。`stages.status` 只剩 `todo`、`run`、`done`。

启动时 `Pipeline.migrate()` 把旧值改过来：`hatching`、`waiting`、`paused`、`failed` 改成 `running`，工序的 `fail` 改成 `run`、`wait` 改成 `todo`。旧执行器跑出来的样例项目按 idea 原文认出来，标上 `lines.sample = 1`。

「暂停」不再是项目的状态，它是负责人开关的状态，见第 4 节。

## 4. 负责人常驻

`leads.py` 里每个项目多一项设置 `on`，存在 `data/projects/<项目>/lead.json`。没有选过时的默认值：在做的项目为开，样例项目和已结束的项目为关。

- `Leads.ensure(line_id)`：项目在做、开关为开、负责人没有会话时，用默认运行方式（设置页里选的 Paseo、herdr 或 tmux）和负责人的默认模型启动它，第一条消息是项目简报。启动失败时记下原因，60 秒后再试。
- 触发时机：小镇启动后巡检线程的第一轮，之后每个 `PAPERTOWN_LEAD_TICK`；新建项目时（`Pipeline.create` 调 `Leads.wake`）；开关打开时。
- 开关关掉：终端里的负责人关闭终端，Paseo 里的负责人打断当前这一轮，会话保留。关着的时候不再发巡检消息。再打开时接着原来的会话。
- `Leads.resident(line_id)` 给界面用：`{on, state, note, agent, runtime, status}`。`state` 取 `running`、`starting`、`blocked`（应该在跑而没跑起来，`note` 写原因，例如 Paseo 没在运行、本机没有找到 CLI）、`off`、`ended`（项目已结束）。
- `PAPERTOWN_LEAD_RESIDENT=0` 关掉整个小镇的自动启动，测试和排查时用。此时仍可在对话里手动启动。

Papertown 不启动也不停止 Paseo 和 herdr 的守护进程。它们没在运行时，负责人的状态是 `blocked`，界面上写出原因。

## 5. 负责人能做的事

负责人的工作目录仍是 Papertown 自己的目录，它不改项目里的文件，写代码和写论文派给员工。新增的 `pt` 命令（只有项目负责人能用，都先过工作边界）：

| 命令 | 接口（`/api/bridge/{agent}` 之下） | 作用 |
| --- | --- | --- |
| `pt hire coder\|writer [--runtime R] [--cli C] [--model M] [--thinking T]` | `POST /hire` | 启动代码员工或写作员工。不写参数时用默认运行方式和员工的默认模型（`PAPERTOWN_WORKER_MODEL`，没设时跟负责人的默认模型） |
| `pt stage` | `GET /stage` | 八道工序的状态、归谁做、产出交没交、哪道硬卡口在阻断，以及各工序产出的格式 |
| `pt stage run\|done\|todo <工序> ["说明"] [--pct N]` | `POST /stage` | 开工或写进度、收尾、放回去重做 |
| `pt output <工序> '<JSON>'\|@文件` | `POST /output` | 交一道工序的产出（`hatch`、`method`、`exp`、`write`、`review`）。员工也能交自己那道工序的 |
| `pt survey` | `GET /survey` | 用代码做的查重：图书馆里最接近的论文、相似度、`novelty-check` 的 `verdict.py` 给的结论 |
| `pt library "关键词" [--top N]` | `GET /library` | 检索图书馆 |

工序收尾（`Pipeline.stage(line, key, "done")`）的规则：

1. `hatch`、`method`、`review` 要先交产出。
2. 重跑一遍硬检查，这道工序的硬卡口有阻断级规则没过时拒绝收尾，返回没过的规则名。用户在研究回路上放行过的卡口不拦。
3. `team` 收尾时把项目实际启动的员工记成编队方案。`ship` 收尾时打包 `paper.zip`，项目状态改成 `done`。
4. 收尾后下一道工序如果还没开始，自动开工。

查重的相似度和结论始终由代码算：`pt output hatch` 里负责人写的是差别在哪和建议，`similarity` 和 `verdict` 由服务端按 idea 重新打分后填入，硬检查「查重相似度」读的就是这个数。

工作边界多两个动作：`agent.start`（启动员工）、`stage.move`（推进或收尾工序）。规则是「不能做」时拒绝，是「需要询问」时变成一个问题发给用户，用户同意后由 Papertown 代办。`line.hatch`、`line.resume`、`line.adjust` 三个动作删除。

## 6. idea 项目

`POST /api/ideas {text}` 调 `Pipeline.create`：建项目（状态 `running`），`idea` 工序完成，`hatch` 工序开工，然后唤起负责人。负责人的说明里写着新项目的第一件事是查重：`pt survey` 看代码算出的最接近的工作，自己再检索和阅读，`pt output hatch` 交撞车报告，`pt report --key` 告诉用户结论，要不要立项用 `pt ask` 问用户。之后的编队（`pt hire`）、方法、实验、写作、质检、出厂都由它推进。

小助手的 `idea.submit` 动作照旧，`line.hatch`、`line.resume`、`line.adjust` 换成 `lead.switch`（开关一个项目的负责人）。

## 7. 「问问这里的员工」

`GET /api/buildings/{id}/staff` 返回在这座建筑里该问谁：`{who, agent, line, name}`。

- 建筑当前有项目时：仓库、实验农场问这个项目的代码员工，印刷厂问写作员工，别的建筑问项目负责人。对应的员工没有启动时问项目负责人。
- 没有项目时问小助手。

网页拿到结果后打开那位员工的对话，输入框里预填「关于{建筑名}：」。`POST /api/chat` 和进程内的回答线程删除。

## 8. 接口上的变化

项目快照（`GET /api/lines`、`GET /api/lines/{id}`、事件 `line`）：

```
Line     { id, seq, title, idea, status, stage, mill_id, verdict, note, created_at, updated_at,
           sample, pct, current, stages, team, lead, linked, items, files }
Stage    { key, name, mod, status, pct, building, out, note, owner, agents, started_at, ended_at }
Agent 简表 { id, role, name, status, runtime, model }      # team 和 Stage.agents 的元素
Resident { on, state, note, agent, runtime, status }       # Line.lead
```

- 去掉 `budget`、`spent`、`revisions`、`reason`，`Stage.workers` 换成 `Stage.agents`（这道工序归属岗位上已启动的员工），`team` 从虚构员工的编队换成项目已启动的员工。
- `GET /api/lines/{id}/lead` 多 `resident` 和 `settings.on`，`POST /api/lines/{id}/lead` 接受 `on`。
- `GET /api/status` 的 `hud`：去掉 `bank`、`plant`、`provider`、`offline`、`model`，多 `leads: {on, running}`。`status` 去掉 `workers`、`bank`、`models`、`plant`。
- `GET /api/departments` 的 `worker` 去掉。
- `GET /api/paseo` 的 `defaults` 多一项 `worker`，`POST /api/paseo/defaults` 接受 `role: "worker"`。

## 9. 样例项目

样例不再靠执行器跑出来。`samples.seed()` 直接写入预制的状态（`papertown/data/samples.json`）：五个项目停在不同的工序，各有工序产出、论文源码和一段占位的负责人对话。样例标着 `sample`，负责人的开关默认关着，打开后就是一个普通项目，由真的负责人接着做。

样例随时可以放入，不再限于离线模式。空的小镇第一次启动时仍会自动放入（`PAPERTOWN_SAMPLES=0` 关闭）。

## 10. 验证

- 单元测试：项目创建、工序推进和卡口、产出校验、负责人常驻（启动、失败重试、开关）、`pt hire`、工作边界的拒绝和询问、迁移、样例。
- 隔离实例：临时数据目录，替身 CLI 跑在独立的 tmux server 里。新建 idea 后负责人自动启动，开关能关能开，负责人用 `pt` 启动员工、交产出、收尾工序，卡口阻断时收尾被拒。
- 网页：项目主页的开关和状态、建筑里的「问问这里的员工」、样例的占位对话，三种界面风格各截图检查。
