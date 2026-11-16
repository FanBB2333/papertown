# 全仓重构：完成记录

更新于 2026-11-16。续写已完成，当前代码和验收结果以下节为准。后面的原始交接记录保留作范围与决策依据，其中的“还没做”“接下来”是接手时的状态。

## 续写结果与验收

保留并接续了 Claude 的未提交修改，没有覆盖原有工作。4.2 的 24 项建议已逐项处理：第 12 项的标签渲染已经共用，无需再搬一次；第 9 项只移除未读的 `animated`，保留 Textual 的 `title` 属性；其余项完成抽取或调用替换。`leads.NAMES` 使用现有 `ROLES`，实际代码中已有 `assistant`。

| 范围 | 本轮完成的内容 |
|---|---|
| server | 共用容错 JSON 读取与原子写入，保留 UTF-8、缩进、换行及 auth 的 0600 权限；统一助手项目定位、检索词生成和 nvidb 项目匹配；去除重复查询 |
| TUI | 复用忙碌/等待标记、项目编号和输入目标选择；保留不同视图的空值显示与输入回退；补验标签正反向循环 |
| web | 共用输入焦点判断、Enter 发送、状态标签、Set 切换、provider 草稿和设置控件；保留 IME、CodeMirror、combobox 及各页面状态文案的差异 |
| 3D | 共用 clamp、混色和几何体释放；核对释放对象类型和所有原调用点 |
| 全仓复查 | 检查异常边界、持久化兼容、动态 CSS 类名、共享 helper 的行为差异；补查 server/web 的跨文件重复实现 |

对抗性复查中修正了以下回归风险：

- 工作目录解析失败时，助手仍返回原来的空位置描述，避免误报“本地项目”。
- 助手重新执行持久化动作时，保留非字典参数的校验。
- 仓库摘要和提问资料保留文件系统错误回退；共享 git helper 保留各调用点原有的 10/15 秒超时。
- MCP/RAG 路由保留原函数名，避免无意改变 OpenAPI operationId。
- TUI 未安装或未启用 nvidb 时仍可读取空日志；文件浏览器与编辑窗口保留各自的长文本溢出方式。
- `.bld.is-dim` / `.bld.is-busy` 实际由模板动态生成；删掉的是被 `theme-sketch` 抵消的外层效果，内层视觉规则保留。`.cm-empty.first` 与基础规则相同，移除不影响空状态布局。

新增持久化回归测试，覆盖缺失/损坏/错误类型/非法 UTF-8、文件格式、原子替换和私有权限；新增 pi 启动及恢复会话测试，防止 `_pi_argv` 再与聊天命令处理重名。现有 TUI 集成测试增加了标签循环检查。

| 验证 | 最终结果 |
|---|---|
| `cd server && PAPERTOWN_PROVIDER=mock uv run pytest -q` | **56 passed, 1 skipped**，85.88 秒；跳过项需要本机 skim |
| 与 `e15289d` 比较 OpenAPI JSON | 完全相同，包含路由、schema 和 operationId |
| `cd web && pnpm -s build` | TypeScript 检查和 Vite 构建通过 |
| `cd web && pnpm -s i18n:missing` | 所有 `tr()` 字符串均有英文 |
| 浏览器 mock 验收 | 三种主题各 25 条路由，共 75 次页面加载，零脚本/console error；另检查七类建筑、对话栏、进展行视图和 3D 场景，均通过 |
| 截图抽查 | Cloudflare 中控、macOS 深色小镇、纸本进展布局正常；未取得旧会话截图，未做像素级前后比较 |
| `cd design && node build.mjs` | 通过；`assets/` 与基线逐字节一致 |
| pi / Paseo bridge 语法 | 通过；pi TypeScript 先用 Node `stripTypeScriptTypes` 转换再执行 `node --check`，原交接的直接 `--check bridge.ts` 命令在当前 Node 不适用 |
| 真实 pi 启动 | 独立临时数据、pi 配置及 tmux socket 下完成 bridge 握手，进入 `idle`；未发送模型请求，随后清理测试会话 |
| macOS | `swift build`、`./build.sh` 与签名打包通过；前台确认原生窗口渲染首页。未逐项手动验收原生菜单和主题联动 |
| `git diff --check` | 通过 |

浏览器初次交互脚本把所有建筑都写成 `[data-open]`，因此报选择器不存在；地图实际使用 `.bld[data-b]` / `data-id`，按真实 DOM 修正验收脚本后七类建筑均通过。这是测试脚本问题，无需修改产品代码。

本轮未改动第 3.3 节列出的既有行为问题，未连接真实模型、GPU 集群或远端 Paseo 做端到端执行。经用户确认，已在 `main` 按区域提交，未 push；本记录另作一个 docs 提交。

| 提交 | 内容 |
|---|---|
| `849c78a` | pi 启动入口与聊天命令分离 |
| `55a693b` | 服务端与 TUI 重构 |
| `045f1e4` | 测试复用与兼容性回归覆盖 |
| `94b468f` | 设计代码与生成预览 |
| `9e53c12` | 前端组件、样式与 3D 复用 |
| `a059e51` | macOS 生命周期与构建逻辑 |

临时验收记录（不作为项目依赖）：`/tmp/papertown-browser-results.json`、`/tmp/papertown-browser-interactions.json`、`/tmp/papertown-refactor-screens/`。接手时的原始 diff 备份在 `/tmp/papertown-refactor-inherited.patch`。

---

以下为原始交接记录。

## 1. 要求

用户的要求：

- 去掉没有意义的保底逻辑；
- 去掉无关的函数调用；
- 能复用的逻辑检查后复用；
- 让代码更简洁、可读；
- 注释只保留入口级别的说明，即文件、函数、组件是做什么的。这类注释不应频繁变动，也不要逐行写。

落到操作上的规则如下。

**注释**

- 保留：1–3 行的文件头；名字说明不了用途时，顶层函数、类、组件、hook、CSS 段落前的一行说明；极少数记录"不写下来就会被改回去"的约束（WebKit 或平台差异、安全原因、必须的顺序）。
- 删掉：逐行讲解、复述代码、代码里的分隔横幅、注释掉的代码、"以前 / 现在 / 不再"这类历史说明。
- 保留各类工具指令：`# noqa`、`// @ts-expect-error`、`eslint-disable`、`/* @vite-ignore */` 等。

**保底逻辑**

- 删掉：不可能触发的 try/except，类型或构造已经保证的 `?? x`、`or x`、`.get(k, default)`、`?.`，重复调用方已做过的校验，所有运行环境都有的特性检测。
- 保留：
  - 网络、文件、子进程、数据库、LLM provider 的失败处理；
  - 用户输入和请求体的校验；
  - 鉴权；
  - 已持久化数据的兼容（localStorage 设置及其版本迁移、`server/var` 下的文件、数据库 schema）；
  - Chromium、Safari/WebKit 与 macOS App 之间的差异；
  - 离线和 mock provider 路径；
  - 测试覆盖到的行为。
- 拿不准就保留。

**不能变的东西**

- 所有用户可见文字：`tr()` 的 key、TUI 输出、prompt；
- API 路由和 JSON 字段名、事件名；
- 文件外部用到的 CSS 类名；
- localStorage 的 key 和格式、文件格式、CLI 参数、环境变量名；
- mock provider 下的行为、测试断言；
- 文件不改名、不挪位置。

## 2. 当前进度

### 基线提交

重构前，先把上一轮 macOS 风格的工作提交成干净基线（未 push）：

| commit | 内容 |
|---|---|
| `e982567` | web 的 macOS 风格 |
| `e34a4e6` | App 跟随页面风格 |
| `e15289d` | 对应的 README 说明 |

重构之前的状态就是 `e15289d`。

### 已完成：20 块全部做完单块重构

全仓约 52k 行源码，分成 20 块。每块先由一个只读 agent 勘查并出改动清单，再由另一个 agent 按清单改写，同时逐文件执行注释规则。下表的"清单"指勘查列出的改动条数，"保留"指勘查判定必须留下的条数。

| 区域 | 块 | 文件数 | 勘查：清单 / 保留 |
|---|---|---|---|
| server | server-core（api、auth、db、config、status…） | 12 | 16 / 22 |
| | server-agents（agents、assistant、tools、mcp…） | 7 | 26 / 32 |
| | server-projects（leads、cards、ask、history、pages、linked、workspace） | 7 | 24 / 27 |
| | server-town（stages、pipeline、town、farm、library、nvidb…） | 12 | 33 / 29 |
| | server-integrations（llm、ports、pi、paseo、bounds、skills scripts） | 19 | 17 / 16 |
| | server-tui-core | 9 | 20 / 30 |
| | server-tui-views | 9 | 24 / 21 |
| | server-tests | 20 | 17 / 15 |
| web | web-core（api、App、settings、i18n、route、Landing…） | 20 | 16 / 29 |
| | web-components-a（Chat、AgentRoom、Select、Sheet…） | 7 | 20 / 22 |
| | web-components-b（Settings、looks、Showcase、Floor、Gpus…） | 10 | 12 / 18 |
| | web-progress-rooms（progress/*、各房间组件） | 15 | 26 / 21 |
| | web-console-a（Assistant、Console、Data、Overview…） | 8 | 14 / 18 |
| | web-console-b（charts、Code、Editor、jobs、util…） | 18 | 29 / 22 |
| | web-town3d-a（halls、engine、body） | 3 | 27 / 22 |
| | web-town3d-b（scene、land、pen3、life、hand、town3d.css） | 6 | 24 / 21 |
| | web-css-a（console、rooms、dock、floor、gpus、config-rooms） | 6 | 26 / 17 |
| | web-css-b（progress、ask、landing、macos、settings、cloudflare…） | 11 | 29 / 16 |
| design | design | 10 | 27 / 21 |
| macos | macos | 10 | 9 / 24 |

工作区未提交的改动共 201 个文件，新增 2944 行、删除 5082 行：

| 范围 | 文件数 | 新增 | 删除 |
|---|---|---|---|
| `server/` | 83 | 1176 | 2096 |
| `web/` | 98 | 1351 | 2193 |
| `design/src`、`design/build.mjs` | 9 | 150 | 289 |
| `macos/` | 9 | 47 | 80 |

另外，`design/index.html` 和 `design/prototype.html` 由 `design/build.mjs` 重新生成，因为它们内嵌了源码。

### 已通过的检查（在当前工作区上跑的）

| 检查 | 结果 |
|---|---|
| `cd server && PAPERTOWN_PROVIDER=mock uv run pytest -q` | 47 passed，1 skipped（与重构前相同；跳过的那个需要 skim） |
| 导入 `papertown` 下全部模块 | 没有失败 |
| `cd web && npx tsc --noEmit -p .` | 没有错误 |
| `cd web && pnpm -s i18n:missing` | every tr() string has English |
| `cd web && npx vite build --outDir <临时目录>` | 构建成功 |
| `node --experimental-strip-types --check server/papertown/pi/bridge.ts` | 能解析 |
| `node --check server/papertown/paseo_link/link.mjs` | 通过 |
| `cd design && node build.mjs`，再 `git status --short assets` | `assets/` 没有任何变化，导出的建筑和道具与重构前逐字节相同 |
| `cd macos && swift build` | Build complete，只有两条与本次无关的 ld 搜索路径 warning |
| 所有 `animation:` 用到的名字都有对应的 `@keyframes` | 是 |

### 还没做的

- **对 diff 的对抗性复查**：按区域逐段读，专找行为变化。
- **跨模块复用**：见 4.2。
- **运行时检查**：
  - 浏览器里走一遍所有路由；
  - macOS App 在前台看一遍；
  - TUI 手动看一遍；
  - pi 员工的启动（见 3.1）。
- **提交**。

重构前的运行时基线已经记下：重构前在 Cloudflare、macOS 深色、纸本三种风格下，用无头 Chrome 走了附录里的 25 个路由，都没有 console 报错。截图和日志放在会话的临时目录里，可能已被清掉；判断标准就是"重构后同样零报错、页面一致"。

## 3. 已做的改动要点

### 3.1 需要特别看一眼的行为变化

1. **`server/papertown/agents.py`：pi 员工启动从报错变为可用，这是修 bug。** 原来有两个同名的 `_command` 方法，后一个覆盖了前一个，`Agents.start()` 启动 pi 员工时必定抛 `TypeError`。现在把前一个改名为 `_pi_argv`。测试没覆盖到，需要实际启动一次 pi 员工确认。
2. **`web/src/console/charts.tsx`：删掉了 `elapsed`。** `Experiments.tsx` 和 `JobViews.tsx` 改用 `util.ts` 的 `dur`。要确认这两处显示的时长格式与原来一致。
3. **`web/src/components/MillRoom.tsx`：抽出共用的 `StatusTag`。** 它带 `?? status` 回退，而原来项目卡头部的状态没有。服务端写入的状态都在 `STATUS` 里，所以显示应当不变。
4. **`server/papertown/tui/look.py`：`_HAN` 一度被改坏。** 中途有一次编辑把字符 U+F900 改成了 U+8C48，后来已改回，现与 HEAD 逐字节相同。复查时再确认一次。
5. **`server/papertown/tui/views/*`：几处 `r.get('seconds', 0)` 改成了 `r['seconds']`。** 同样改了 `r['jobs']`、`r['backends']`。依据是服务端每条路径都返回这些字段。
6. **CSS 删掉的规则：**
   - `web/src/app.css` 的 `.bld.is-dim`、`.bld.is-busy`、`busy`，以及 `web/src/hand.css` 中专门抵消它们的规则；
   - `.pg-link`、`.lg-core`、`.rn-empty`。

   这些都是 grep 确认没人用后才删的，运行时检查时留意小镇建筑的样式。

### 3.2 各区域的主要改动

**server**

- **api.py**：用一个 `mapped(*errors)` 工厂替代了 8 个照抄的 try/except 包装和 10 处内联的 try/except；路由、返回体、状态码和报错信息都没变。
- **status.py**：`departments` 里的 `gpus_running` 只算一次，删掉 `count(*)` 后面多余的 `or 0`。
- **agents.py / assistant.py / tools.py**：
  - 删掉了没人引用的符号：`_event`、`shutdown`、`ToolRegistry.get/label`、`ToolCtx.stage/worker`、`AgentResult.run_id`、`ROLES` 里的 `building/title`；
  - `assistant.clip` 也删了，改为从 `leads` 导入。
- **library.py**：新增 `Library.rank(papers, terms, sims)`，替换三处重复的打分加排序。
- **cards.py**：`message()` 和 `guide()` 共用 `_content()`。
- **pages.py**：一次性的 `_known()` 内联。
- **llm/mock.py**：`plan_key` 改成查表。
- **tui**：
  - `views/__init__.py` 新增 `cycle()`，替换五份"按键切换到下一项"的逻辑；
  - `look.py` 新增 `busy_mark` 和 `wait_mark`，供 look 内部使用；
  - `texlex` 的正则提成常量。
- **tests**：
  - `with_paseo`（在 test_farm_agents.py）替换 4 个文件里同样的假 paseo 准备；
  - `linked_settings`（在 test_linked.py）替换几处重复的"写 projects.json 再 make_settings"。
- **原样未动的文件**：`press.py`、`cli.py`、`llm/openai_provider.py`、`ports/arxiv_server.py`、`skills/*/scripts/*.py`。它们的注释和保底逻辑本来就符合规则。

**web**

- **共用组件**：
  - AgentRoom 抽出 `PaseoLog`、`PiLog`、`Thinking`、`useRoster`、`FileLink`，Chat 也在用；
  - MillRoom 导出 `StatusTag`；
  - progress/Ask.tsx 导出 `enterSends`；
  - console/util.ts 新增 `toggled`。
- **Console**：
  - 重复的时钟合成 `useNow`；
  - `typeOf` 只留在 Console；
  - `parse`、`useLead`、`AskCard`、`Reports` 不再导出；
  - 重复的 `MODS.find` 和 `markOf` 只调一次。
- **Gpus**：`shared()` 不再每行重算。
- **town3d**：
  - `hash()` 和 `disposeGeometry()` 移到 `scene.ts`，`land.ts` 和 `life.ts` 共用；
  - `pen3.ts` 导出 `EDGES`，三处共用；
  - 去掉 `document.fonts` 的可选链（Landing 同样处理）。
- **CSS**：
  - 合并重复和被覆盖的规则：`.tile span`、`.xt-res b`、meter 的 transition、`.jd-back`、`.jd-pre/.json`、`.dim/.rel` 等；
  - 四个相同的淡入 keyframes（`pd-fade`、`ld-in`、`st-fade`、`demo-in`）统一用 console.css 的 `fade`；
  - `progress.css` 里重复的 `from-r` 删掉；
  - `--hud-h`、`--in-out` 一定有定义，删掉它们的回退值。
- **`web/src/design.d.ts`**：删掉了没用的 `@design/layouts.js` 声明。

**design**

- `badge` 内联；`proto.js` 删掉未用的 `FLOW_KINDS` 导入。
- 导出的素材逐字节不变。

**macos**

- `Shell.start` 和 `Server.stop` 不再重复检查服务是否在跑，被调用方已经检查过。
- 启动画面的日志尾部只读一次盘。
- 删掉一处无效的 `websiteDataStore` 赋值和一处多余的 JSON 判断。

### 3.3 发现但没修的问题

这些都是行为问题，超出本次重构的范围：

- **`design/prototype.html` 打开学院或交易所会抛错**：`PLACEMENTS` 里有 `academy` 和 `exchange`，但 `proto.js` 的 `BUILDING_FLOWS` 没有对应条目，打开时抛 `TypeError`。重构前就是这样。
- **`agents.py` 的 `_watch_paseo` 比较对象可能弄错了**：`model = x.get('provider')` 拿 provider 和完整的 model 名比较，看起来是 bug。
- **`web/src/console.css` 的 `.pp-foot` 类名冲突**：论文卡片的页脚和 Cluster 的脚注共用这个类名，后者的 `margin: 10px 0 0` 覆盖了前者的 `margin-top: auto`。
- **`web/src/dock.css` 有一条死规则**：`.pt-hint { bottom: 84px }` 被后加载的 console.css 覆盖，实际不生效，可能对应一个已经丢失的意图。

## 4. 接下来怎么做

### 4.1 复查当前 diff

按区域（server、web 组件和 console、town3d、CSS、design、macos）逐段读 `git diff e15289d`，专门找三类问题：

- 删掉的保底逻辑里，有没有实际需要的；
- 删掉的符号是否可能被动态引用，比如模板字符串拼出的类名、getattr、事件名；
- 合并后的 helper 与原来每一处是否完全等价。

3.1 列出的几点优先看。发现问题就地修正，修完重跑第 2 节的检查。

### 4.2 跨模块复用（单块重构时因跨块而没有动的）

下表各项已在当前代码上逐条核对过。

**这份清单可能不全。** 它来自两个来源：

- 勘查阶段 20 块各自报告的跨块问题；
- 单块重构之后的第二轮跨块扫描。这一轮只跑完了 7 块：design、macos、server-tests、web-css-a、web-css-b、web-town3d-a、web-town3d-b。其余 13 块（server 的其余 7 块、web 的其余 6 块）在停下时还没扫。

补齐的办法：对这 13 块，各自在当前代码上找"与其他块重复的实现、只在本块用的导出、多余的防御"，结果并入下表。

**建议做：**

| # | 改什么 | 位置 | 做法与注意 |
|---|---|---|---|
| 1 | 原子写 JSON 和容错读 JSON 散在多个模块 | `ask.py`、`bounds.py`、`cards.py`、`pages.py`（都是 `tmp.replace(p)`），`auth.py`，`paseo_models.py`，`history.imported` | 在 `db.py` 加 `read_json(p, default)` 和 `write_json(p, data)`；这些模块都已从 db 导入 `now`。逐个对照原实现：`auth.py` 的文件权限、`indent`、`ensure_ascii`、类型不符时回落默认值，都要保持原样。 |
| 2 | "指定的项目，否则用户屏幕上的那个"算了四次 | `api.py` 的 `own_line`、`bridge_tell`；`assistant.py` 的 `brief`、`_plan` | 给 `Assistant` 加一个公开方法，例如 `line_id(line)`；api.py 不再碰 assistant 的私有字段。 |
| 3 | `leads.NAMES` 与 `agents.ROLES[*]['name']` 重复 | `leads.py:23` | 先确认 ROLES 里的名字与 NAMES 完全一致；ROLES 没有 assistant，"小助手"要单独保留。 |
| 4 | 先判断 `linked.of()` 再调 `linked.summary()` | `agents.py:347` | `cards.py:208` 和 `town.py:201` 已经直接调 `summary()`，说明它能处理没关联仓库的项目。确认返回值一致（`None` 还是空）后直接调用。 |
| 5 | 查询词提取重复 | `depots.py:43`、`status.py:95`，都是 `list(dict.fromkeys(tokens(expand(x))))` | 在 `library.py` 加一个小函数，比如 `terms_of(query)`。不能叫 `query_terms`：`ask.py` 里已有一个同名但不同的函数。 |
| 6 | `nvidb.status()` 的字段一定存在，却还在防御 | `status.py:65` 的 `(nv.get("counts") or {})`，`status.py:82` 的 `nv.get("summary")` | 先确认 `nvidb.status()` 每条分支（包括出错的分支）都返回 `counts` 和 `summary`，再改成 `nv["counts"]`、`nv["summary"]`。 |
| 7 | 判断 nvidb 任务是否提到某个项目，实现了两遍 | `nvidb.py` 的 `jobs_matching`，`tui/local.py` 的 `nvidb_job` | 在 nvidb.py 抽一个模块级 `mentions(job, patterns)`，两处共用。 |
| 8 | 视图里自己拼运行中和等待中的标记 | `tui/views/staff.py:66,68,75`，`plant.py:64,118,172` | `look.py` 已有 `busy_mark` 和 `wait_mark`，视图改用它们。逐处比对 style：plant 的 `bold {p['run']}` 与 busy_mark 是否相同。 |
| 9 | `Place` 的 `title` 和 `animated` 只写不读 | 每个视图的 `key, title, animated = …` | app 和 widgets 里已经没人读这两个属性。删之前确认这些类是否继承 Textual 的 `Screen` 或 `Widget`：`title` 在那里是框架属性，有的话就保留 `title`。 |
| 10 | 由项目 id 查 `#编号`，写了三份 | `views/chat.py` 的 `seq`、`views/jobs.py` 的 `seq`、`app.py` 的 `agent_name` | 在 app.py 加 `line_seq(line_id)`；两个视图各自保留找不到时的显示文字（chat 显示原 id，jobs 显示"—"）。 |
| 11 | 选中某类输入目标的逻辑重复 | `projects.py` 的 `action_idea` 和 `action_ask`，`staff.py` 的 `action_say` | 在 app.py 加 `aim(kind) -> bool`。 |
| 12 | 标签条的渲染重复 | `chat.py`、`projects.py`、`setup.py` 的 `paint_tabs` | 在 `widgets.py` 加 `tabs(pairs, current, p) -> Text`，先逐个比对样式是否一致。 |
| 13 | "焦点是否在输入框里"写了 5 份 | `App.tsx:203`、`Chat.tsx:504`、`useAvatar.ts:147`、`Console.tsx:233`、`town3d/engine.ts` | 在轻量模块里导出 `typing(e, extra?)`，例如 `components/walk.ts`。不能让入口包因此引入 three.js。Chat 额外判断 `.cm-editor`，Console 额外判断 combobox 和 `.cm-editor`，要保留这些差异。 |
| 14 | Enter 发送的处理重复 | `AgentRoom.tsx:451,644`、`Assistant.tsx:466` | 与 `progress/Ask.tsx` 的 `enterSends` 完全相同，可以改用它；建议把 `enterSends` 挪到 `console/util.ts`。`Chat.tsx:596` 不判断 `isComposing`，写法不同，不要动。 |
| 15 | 状态标签的 span 重复 | `StatusView.tsx`、`Console.tsx`、`Overview.tsx` | 改用 `MillRoom` 的 `StatusTag`。 |
| 16 | 手写的 Set 切换 | `Data.tsx:182` | 改用 `util.ts` 的 `toggled`。 |
| 17 | 已经用不到的 CSS 规则 | `console.css:580` 的 `.g-bar.other` | `GJob.mine` 已删，这条规则不会再生效，直接删。 |
| 18 | 只剩一边的类名 | `Console.tsx:252` 的 `cm-empty first` | `.cm-empty.first` 的规则已删，把类名里的 `first` 去掉。 |
| 19 | 永远是 null 的 prop | `WorldMap` 的 `highlight`（`App.tsx:312` 传 `null`） | 删掉这个 prop，在 `renderMap` 调用里直接写 `highlight: null`。 |
| 20 | `clamp01` 定义了两次 | `town3d/engine.ts:74`、`land.ts:30` | 从 land.ts 导出，engine.ts 已经从 land 导入别的东西。 |
| 21 | 手写的几何体释放 | `engine.ts:212`、`halls.ts:328` | 改用 `scene.ts` 的 `disposeGeometry`，先确认判断条件相同（Mesh 和 LineSegments）。 |
| 22 | 混色函数重复 | `halls.ts:122` 的 `tint()` | 与 `scene.ts` 的 `mix` 相同，导出 `mix` 后改用。 |
| 23 | Chat 和设置页切换 provider 的草稿逻辑重复 | `Chat.tsx:170`（LlmForm），`Settings.tsx:222` 起（ModelForm） | 在 `applyLlm` 旁边导出 `withProvider(llm, draft, id)`。 |
| 24 | 设置页的开关和滑块组件只在本文件里定义 | `Settings.tsx:48,50` 的 `Toggle`、`Range` | 挪到 `controls.tsx`（Row、Card、Pick 已经在那里）。`Showcase.tsx` 有没有自己的一份，要先核对再决定。 |

**可选（收益小）：**

- localStorage 的 try/catch 读写散在 6 个以上文件，可以在 `settings.ts` 加 `stored(key)` 和 `store(key, v)`。key 和格式都不能变。
- `console.css` 的 `con-in` 与 `rooms.css` 的 `rise-in` 如果完全相同，可以合并成一个。
- `ToolRegistry.names()` 只有 `test_rooms.py:58` 在用，可以改成 `has()` 后删掉；`Library.latest()` 也只被一个测试使用。
- `#c47a3a` 默认强调色出现在 design 和 town3d 的多处，可以在 `design/src/world.js` 加 `placementAccent(pl)`。
- `App.tsx:273` 的 `.detail ?? {}`：只有 macOS App 发这个事件，而且总带 detail。

**建议不做：**

| 项 | 原因 |
|---|---|
| `test_memory_ask.py` 自己实现的 `slug` | 测试独立实现能起到对照作用，改成导入 `history._slug` 就等于自己验证自己。 |
| `cli.wait` 与 `conftest.wait_for` | 用途和返回值不同。 |
| `paseo._find` 与 `agents._which` | 合并后查找的时机会变。 |
| 各处的 `ago()` | FarmRoom、Linked、Gpus 的取整和显示不同，AgentRoom 已经改用 util 的版本。 |
| 两处 Esc 关闭抽屉 | JobDrawer 还处理别的键。 |
| Assistant 的权限卡片 | 类名和阈值都不同。 |
| 相似度条的 clamp | 改动太小。 |
| `typeOf` | MillRoom 和 Sheet 里各是一行。 |
| pointer lock | 要保留 WebKit 下的可选链。 |
| `node:gpu_ids` 字符串 | 收益太小。 |
| `Agents.ensure` 与 `Assistant.row` 的插入 | 收益太小。 |
| `_text` 字段的剥离 | 收益太小。 |
| `edthemes` 的主题列表 | 收益太小。 |

这些改动彼此有文件重叠：#1–#7 都在 server，#8–#12 都在 tui，#13–#24 都在 web。各组内按顺序做，每做完一组跑一遍第 2 节的检查。

### 4.3 运行时检查

1. 启动离线服务：
   ```bash
   cd server && PAPERTOWN_PROVIDER=mock PAPERTOWN_SKIM_BIN=$HOME/repos/skim/skim uv run papertown serve --port 8000
   ```
   改过前端后要先 `cd web && pnpm -s build`。
2. 用无头 Chrome（CDP，`--remote-debugging-port`）走附录的路由，分三种风格各走一遍。打开前往 localStorage 写入：
   - `pt-settings`：`{"v":3,"ui":"cloudflare"|"macos"|"paper","mode":"light"|"dark"}`
   - `papertown.lang`：`zh-Hans`

   收集 `Runtime.exceptionThrown`、`console.error` 和 Log 里的 error，并截图。标准：零报错，截图与重构前一致。
3. macOS App：
   ```bash
   cd macos && ./build.sh
   ```
   打开后在**前台**检查，因为 WebKit 会暂停后台窗口的动画。重点看：
   - 标题栏的颜色跟随页面风格；
   - 设置页；
   - 小镇。
4. TUI：`uv run papertown tui`，把每个视图切一遍，按一下标签和按键切换（`cycle()` 改过）。
5. 启动一次 pi 员工，验证 3.1 第 1 点。

### 4.4 提交

按区域拆开，用 Conventional Commits，不 push：

| 提交信息 | 内容 |
|---|---|
| `refactor(server): trim comments and fallbacks, share repeated helpers` | 包含 agents.py 的 `_pi_argv` 修复，也可以把它单拆成一个 `fix(server): …` 提交 |
| `test(server): share the fake paseo and linked-project setup` | 测试的改动 |
| `refactor(web): …` | web 的改动 |
| `refactor(design): …` | 连同重新生成的 `design/index.html` 和 `prototype.html` |
| `refactor(macos): …` | macOS App 的改动 |

跨模块复用（4.2）如果单独做，各区域再各提交一次。

## 附：运行时检查的路由

```
/                       落地页
/progress               进展（块）；再点页顶的「行」看行视图
/progress/5             项目页
/progress/4/ask         提问
/progress/1/pages/p1    汇报与讲解
/console/5/overview  /code  /paper  /data  /exp  /agents  /skills  /mcp  /rag  /rules  /survey
/town                   小镇；点开一个建筑（[data-open]）；点开对话栏（.hud-chat）
/status
/settings/look  /settings/showcase  /settings/map
```
