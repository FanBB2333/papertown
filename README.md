# Papertown

把一条科研流水线做成一座纸艺小镇：一颗 idea 从孵化场查重开始，通过后在造纸厂立项，经过方法设计、实验、写作、审稿，最后出港一篇论文。每道工序由一组 agent 员工完成，员工的能力来自 Agent Skills，外部数据通过 MCP 接入。

你在小镇里是一个小人：WASD 或方向键走动，走到建筑门口按 F（E、Enter、空格也行）进去，也可以直接点建筑。主要的四座建筑：

- **造纸厂**：大本营，所有项目的总览和每个项目的工序。
- **仓库**：每个项目一个写代码的 agent（Paseo 或本机 pi），写代码、跑测试，再把实验提交到实验农场。
- **实验农场**：所有实验任务的看板，每个项目有一位看田员盯进度；以后在这里接 nvidb。
- **印刷厂**：每个项目一个写论文的 agent（Paseo 或本机 pi），稿子就在印刷厂的目录里。

这四座建筑进门先是「车间」，用同一种结构展示每个项目的 agent 在做什么：一个项目占一条线，线上排着工位，负责的 agent 站在工位上，正在干活的会动，等你决定的会问，停着的在歇，出错的会提示。四座建筑的样子各不相同：造纸厂是传送带上的八道工序，论文跟着传送带走；仓库是货架，从找 baseline、写代码、跑测试到把实验箱子发往农场；实验农场是一垄垄田，每个实验任务是一块地，按进度长高、跑完结穗；印刷厂是印刷机，排字、开印、校对、装订出厂。点一条线进「明细」，就是这个项目的全部内容（工序产出、和 agent 的对话、任务日志）。

顶栏的「平面 | 3D 漫游」把同一座小镇切到 3D，用第一人称在里面走。镜头先停在地图的同一个角度，再落到你站的地方；回到平面时从你头顶升回地图的视角，人还站在原处。3D 里鼠标像第一人称游戏那样锁在画面中间：移动鼠标转视角，WASD 走、Shift 跑、←/→ 转身；空格跳，连按两下空格飞起来（按住空格上升、Ctrl 下降，再连按两下或落到地上就停），Ctrl（或 C）下蹲，蹲着走到屋顶或机器的边上不会掉下去。跳得上的台阶、屋顶、树顶和机器都能站上去，浅水里能蹚着走。V 在第一、第三人称之间切换，T 在白天和夜晚之间切换（夜里窗户和路灯会亮），M 回到平面，Esc 放开鼠标，再点一下画面继续。进入 3D 时默认全屏（设置里的「全屏漫游」可以关）：开着面板时 Esc 先关面板，没有面板时退出全屏，再点画面继续时回到全屏。和建筑打交道只用 F 和鼠标左键：准星对准建筑（或站在门口）按 F 或点一下，就走进它的大厅。大厅按建筑的实时数据搭起来，进门就是整套设备：造纸厂里每个项目一条流水线，八道工序各是一台机器，亮灯表示进度，纸张在传送带上跑（站上正在跑的传送带会被带着走）；印刷厂里每篇论文一台四色轮转印刷机，写作进行时滚筒转、纸张飞出；实验农场是一座温室，每个实验一畦庄稼，长得多高就是进度，跑着的那畦头顶亮着补光灯；算力电厂里每台机器一个机架式机柜，从上到下是交换机、主机、每张 GPU 一个 2U 托盘（灯条是利用率，蓝条是显存，风扇随负载转）、硬盘仓和 UPS，一排机柜的末尾是网络机柜，两头是行间空调，准星对着机柜按 F 打开这台机器的详情，对着某张卡的托盘就直接定位到那张卡；仓库里每个仓库一排货架、每个项目一张写代码的工位；图书馆里每个主题一架书；其他建筑的大厅中央转着它的模型。准星对着某台设备按 F，就打开它对应的面板（流水线上的某道工序会直接打开那道工序所在建筑、那个项目的面板）；走回门口按 F 回到小镇。小镇外面是走不到头的地形：海岸、沙滩、田地、森林、湖和零星的村子、风车，按区块在你周围生成、走远了就收起来，飞得越高看得越远；这片地只在 3D 里有，升回地图视角时淡出。镇上还有天上飘的方块云、在各家门口之间走动的员工（对着他们按 F 打个招呼）、海上的帆船、白天的蝴蝶和夜里的萤火虫。鼠标放开时，右下角的小地图点一下就过去，点建筑就到它门口。3D 小镇由同一份建筑画稿（`design/src/sprites.js`）生成，three.js 只在第一次打开 3D 时加载。地址后面加 `#3d` 直接进 3D。画面右下角是你的手，像方块游戏里那样握着一支铅笔：走路时跟着摆，转头时稍微落后一点，点击时挥一下。

顶栏的「设置」（或按 <kbd>,</kbd>）打开完整的设置页：界面语言（English / 简体中文 / 繁體中文，默认 English）、动画（完整 / 柔和）、纸纹浓淡、打开时先看平面还是 3D；平面地图的顺滑缩放、滚轮速度、建筑名字显示多少；3D 的鼠标灵敏度、上下反转、视野、手、走路晃动、画质（低画质不画阴影）、建筑名字和小地图；小镇员工用的模型；Paseo 和本机 pi 的连接状态；展示模式的样例项目；以及全部快捷键。这些设置存在浏览器里，模型的切换只在这次运行里有效。

界面文字在源码里写的是简体中文。前端自己的文字用 `tr('…')` 包起来，英文在 `web/src/i18n/en.json` 里按中文查；服务器发来的文字（建筑名、工序、状态、提示）在 `web/src/api.ts` 收到时用同一本词典翻译，带变量的句子按 `{0}`、`{1}` 模板匹配。繁体用 OpenCC 从简体转换（台湾用语）。员工写的内容（对话、草稿、论文）不翻译，繁体模式下只转字形。新加的文字跑一下 `cd web && pnpm i18n:missing`，列出还没有英文的 `tr()` 字符串；服务器新加的句子要手动写进 `en.json`。

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
| `PAPERTOWN_SAMPLES=0` | 离线模式下不自动放入样例项目 |
| `PAPERTOWN_NVIDB=0`、`PAPERTOWN_NVIDB_BIN` | 关掉 nvidb 显卡读取；nvidb 的路径（默认在 PATH 上找） |
| `PAPERTOWN_PROJECTS` | 本地项目清单的位置，默认数据目录下的 `projects.json` |
| `PAPERTOWN_SKIM_BIN` | skim 的路径（默认在 PATH 上找），技能学堂用它按项目、按对话配置 skill |

完整列表见 [`.env.example`](.env.example) 和 `server/papertown/config.py`。

### 展示模式的样例

离线模式第一次启动、小镇里还没有项目时，会自动放入五个样例项目，选题都落在种子论文覆盖的方向上（仓库级代码 Agent、大模型审稿、稀疏注意力与 KV cache 压缩、场景图与 VLA 长程操作、MCP 与多智能体）：一篇一路跑到出厂，三篇分别停在实验、写作、质检之前（点「继续」接着跑），一篇留在孵化场等你决定。每个项目的明细里有「调研文章」：孵化场查重时找到的相近工作（带相似度和差在哪），和论文 refs.bib 里引用的文章，都链到 arXiv。图书馆里按方向分格陈列全部馆藏，可以搜索。设置页的「展示模式」里可以再放一次样例（已有的不会重复）；`PAPERTOWN_SAMPLES=0` 关掉自动放入。接了模型以后不提供样例，因为每道工序都会真的调用模型。

## 现在是真的、还是模拟的

| 建筑 | 状态 |
| --- | --- |
| 孵化场、图书馆、族谱馆、学术海关 | 真实：SQLite FTS5 检索 + 查重 / 分类 skill，自带 346 篇 arXiv 论文作种子 |
| arXiv 码头 | 真实：MCP server，拉到的论文自动入馆 |
| 造纸厂、质检所、人才市场 | 真实：所有项目共用一座造纸厂；按预算编队、多视角审稿、结算 ROI 并升降级 |
| 仓库、印刷厂的 pi 员工 | 真实：本机的 pi，跑在后台 tmux 里，网页和终端双向同步 |
| 实验农场 | 真实：本地执行器在项目代码目录里跑命令；接入的本地项目在 nvidb 队列里的任务也显示在这里（只读） |
| 算力电厂 | 真实：从 nvidb 读你自己机器上的显卡和任务队列，只读 |
| 印刷厂 | 真实：组装 TeX 和 refs.bib，本机有 `latexmk` 时编译 PDF |
| 参考仓库 | 示例数据：三个虚构的示例仓库，文档进了检索库 |
| 模拟电厂 | **模拟**：离线流水线的实验结果是按种子生成的，结果里带 `simulated: true` |
| 其余建筑 | 未接入，点开能看到计划 |

## 本机的显卡（nvidb）

装了 [nvidb](https://github.com/FanBB2333/nvidb) 的话，算力电厂、实验农场的「明细」和农场车间顶上会显示它管着的每台机器、每张卡：可排显存（扣掉别人的程序、已给任务预留的部分和余量之后）、利用率、温度，以及卡上跑着的任务和程序。状态分三档：空闲（几乎没人用）、有空（还放得下 8G 以上的任务）、满。

点机器卡片上的「详情」（或在 3D 的算力电厂里对着它的机柜按 F）打开这台机器的详情：它的每条队列（lane：一张或几张卡，和它按顺序要跑的任务）在跑、暂停还是被卡住；每张卡上正在跑什么、它的队列里按顺序排着哪些任务、还有哪些没分到卡的排队任务放得进这张卡；以及指定了这台机器、但因为依赖没成功被卡住的任务。每个任务展开能看到说明、命令和它在等什么。

读取用的是 `nvidb queue status --json --no-tick`（队列和卡池也在这份输出里），只读 nvidb 的数据库、不去连节点，几秒读一次。Papertown 不提交、不取消、不确认告警，提交任务照旧用 `nvidb job submit`。机器的地址和用户名不会出现在网页上。

## 接入本地项目

自己已有的项目可以接进小镇展示：代码在一个 git 仓库里，论文在另一个 LaTeX 仓库里（比如 Overleaf 的 git 克隆）。在数据目录（默认 `server/var/`，不进 git）写一个 `projects.json`：

```json
{"projects": [{"key": "my-proj", "code": "~/repos/my-code", "paper": "~/repos/overleaf/my-paper", "match": ["my-code", "my-proj"]}]}
```

启动时每个项目变成一条状态为「本地项目」的生产线：

- 造纸厂明细里有「本地仓库」：代码仓库的分支、远端、最近提交、没提交的改动、语言分布和 README 摘要；论文的标题、摘要、章节、词数、图表和引用数，已经编译过的 PDF 可以直接打开。「调研文章」列出 `.bib` 里的参考文献。
- `match` 里的字符串用来从 nvidb 队列里认领这个项目的任务（匹配工作目录、任务名或提交者；不写时用代码仓库的目录名和 `key`）。认领到的任务出现在实验农场和仓库的发货区，实验工序的进度也按它们算。
- 这条线不走流水线，也不花预算；前四道工序记为已完成，写作工序在有论文仓库时记为进行中。

两个仓库 Papertown 只读：git 命令带 `--no-optional-locks`，不往里写任何文件。给这样的项目配的代码员工和写作员工会直接在仓库里工作，改动是真的；它们的说明（`AGENTS.md`）和 `pt` 工具放在 Papertown 自己的项目目录里，简报会提醒它们先看 `git status`、提交和推送前问你。

## 技能学堂、接线局和图书馆：小镇的配置

小镇中央广场上的两座建筑和图书馆是配置用的房间，点进去就能改，改完立刻生效。

### 技能学堂（skills，用 skim）

[skim](https://github.com/FanBB2333/skim) 把本机所有 skill 收在一个仓库里（`~/.skim/store`，第一次用先 `skim init`）。技能学堂按项目、按对话配置用哪些 skill，配置像 `git config` 一样分三层，窄的一层覆盖宽的：

| 层 | 文件 | 管什么 |
| --- | --- | --- |
| 全局 | `~/.skim/skimconfig` | 本机所有项目和对话 |
| 项目 | `server/var/projects/<项目>/.skim/config` | 这个项目里的每段对话（接入的本地项目也放在这里，不写进你的仓库） |
| 对话 | `~/.skim/sessions/papertown-<员工>.config` | 只管这一个员工 |

每一层可以选一个起始环境（`core.env`，比如 skim init 建的 `base`），再逐个打开或关掉 skill（`skill.<名字>.enabled`）；在这一层没说的沿用上一层。房间里每个 skill 都标着是哪一层定的，右边列出三层的文件内容，和 `skim config --list --show-origin` 一样。算出来的 skill 链接进员工的 `.papertown/skills/`，简报里会列出每个 `SKILL.md` 的路径，Claude Code、Codex、pi 都按这个读。仓库和印刷厂的员工房间右侧有「这段对话的 skill」。

同样的配置也能在终端里改：`skim config --project --project-dir server/var/projects/line_1 skill.<名字>.enabled true`、`skim resolve --project-dir … --session-id papertown-coder-line_1`。

### 接线局（MCP）

小镇接的每个 MCP server 是一条线：内置的 arXiv 码头、`PAPERTOWN_MCP_CONFIG` 里的，以及在这里添加的（存在数据目录的 `mcp.json`，Claude Desktop 的格式）。每条线显示接通状态和它给员工的工具，可以随时停用、重连；在这里添加的还能修改和删除。环境变量写成 `${变量名}`，启动时从环境里取，密钥不落进文件。房间右侧有把 Papertown 自己作为 MCP server 接到别的 agent 上的配置。

### 图书馆（RAG）

馆藏统计、检索设置和试检索台：默认返回几篇、全文召回多少篇候选再打分、配了 embeddings 时是否用向量排序（存在数据目录的 `rag.json`）。试检索会显示检索词怎么扩展、每篇按什么排的、命中了哪些词。

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
