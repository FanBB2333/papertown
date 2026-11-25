# Papertown 调研报告：科研由谁决定，论文如何追到证据

## 摘要

- **最值得优先讲的是谁先写下关键决定。** Carl 让人批准模型选出的路线，Agent Laboratory 让人逐步放行或打回，Denario 允许人直接写 idea 和 method。Papertown 可以把区别落实到四项有记录的决定上：方向、关键方法、实验安排和文档设计均由研究者先写，agent 据此执行。在本次核查的系统中，未查到同时强制这四项的公开流程。[Carl 技术报告][carlpaper]、[Agent Laboratory][al]、[Denario][den]
- **硬检查与语义审查已有直接先例。** Curie 会锁住尚未验证的实验步骤，AutoResearchClaw 会拒绝含有无法匹配的关键数字的稿件，ScientistOne 同时检查证据文件和主张是否过度。Papertown 能展示的差异是哪些工序受锁、失败退回哪里，以及谁能处理语义预警。[Curie][cu]、[AutoResearchClaw][arc]、[ScientistOne][sone]
- **数字回链、内部证据标签、带归属的状态历史也各有先例。** data-to-paper 已把数字连到公式、表格、输出文件和代码行，ScientistOne 会从终稿剥离内部证据标签，YouRA 为每次研究状态变更记录时间和归属。Papertown 更有价值的承诺是把这些记录接通，让人从一个段落找到正确的实验、原始文件和具体写入操作。[data-to-paper][dt]、[ScientistOne][sone]、[YouRA][yra]
- **人先判断有条件性的实证支持。** 在可能出现误导建议的任务中，先记录判断能降低错采风险。尚未查到直接证明“科研人员自由写下决定，比审批模型方案更能提高最终论文质量”的对照实验。[判断顺序随机实验][yan]、[人脸匹配反例][face]、[科研 idea 实际执行研究][si2]

## A. 已有 AI 科研系统怎么做

核查范围截至 2026 年 11 月 26 日，共 18 个系统或版本。下文把**确定性门禁**限定为程序按明确条件阻止后续动作。脚本能运行、模型审稿给分、专家事后复核分别列出。“未查到”指所引一手资料没有展示该项能力。Papertown 按题述设计比较，本报告未验证其实现，也未独立重跑各系统。

### A1. 最值得拆开的先例：data-to-paper

**谁决定。** Kishony lab 将两组选择独立开放。研究可以采用人给目标的 *fixed-goal*，也可以用 *open-goal* 让模型从带说明的数据提出假设。系统又可在 *Autopilot* 下自行推进，或在 *Copilot* 下让研究者审阅中间产物、写反馈、回退并重做。因此，它既容纳实质性人工干预，也容纳由模型提出并执行整条路线。[论文][dt]、[作者仓库及 Copilot 说明][dtgit]

**如何把关。** 每一步只收到预先指定的上游产物，输出按该步规则抽取并检查，包括格式、长度、引用、代码运行和输出。失败会生成具体反馈，部分步骤另有 LLM reviewer，Copilot 还能加入人的评语。论文描述的 Results 流程一旦发现表示缺失数值的占位符，可以中止整个研究周期。这已经是实际门禁。[Methods 中的检查和中止规则][dm]、[发表版流程图][dt]

**一个数字如何回到代码。** Results 写作前，程序给上游产物中的数值分配唯一标签，并生成 LaTeX `hypertarget`。模型引用数值时须给对应的 hyperlink，程序核对目标标签。遇到单位换算等派生值，模型可以提交 `\num` 公式和解释，编译时计算显示值，将推导保留在 Notes 附录。读者因此可以沿 **正文数值 → 推导公式及操作数 → 表中具体值 → 生成表的输出文件 → 写出文件的代码行** 反查。发表版明确说明，较早生成的部分稿件没有这套链接。[Information tracing 原始方法][dm]、[发表版第 9 页][dt]

**与 Papertown 最相关的边界。** data-to-paper 公开支持记录和回放 run，论文重点验证的是数值与中间产物的关系。未查到它要求所有非数值段落都绑定证据，也未查到从每个段落直接定位“哪个 agent 在哪次编辑中写入”的统一机制。因此，“数字可点回代码”应当作为 Papertown 的对标基线。[作者仓库][dtgit]、[Information tracing][dm]

### A2. 人提出、筛选或批准研究的不同方式

| 系统 | 谁提出方向、谁作决定 | 实际检查与公开可追到的位置 |
|---|---|---|
| **Agent Laboratory** | 人提供初始 idea，也可提前写实验或图表要求。Autonomous 模式随后自行推进。Co-pilot 在子任务后让人放行或写反馈要求重做，具体计划通常先由 agent 提交。[论文][al] | 有代码执行、LaTeX 编译和多位模型 reviewer。报告、代码和阶段 `state_saves` 可检查、恢复，未查到正文逐数回链。[论文][al]、[仓库][alrepo] |
| **CodeScientist** | 主评测中，人筛文献和代码示例，从模型候选中选 idea 并可写方法意见，Planner 再定实验计划。工具也支持人直接输入 idea、编辑计划或全自动运行。[论文][codes]、[操作说明][codesrepo] | 有成本、时间或调试次数限制，模型判断试运行能否继续，最终由人核验。示例实验保留 idea、代码、日志、结果文件和报告，未查到每个正文数值的固定反向链接。[论文][codes]、[实验产物][codesrepo] |
| **Denario** | 人可以用 `set_idea`、`set_method` 直接写 idea 和 method，也可让模型生成，再逐模块启动。它是“研究者亲自定方法”最接近的已有入口之一，公开流程把这种用法设为可选。[论文及接口示例][den] | LaTeX 编译错误可触发修复，review 模块将对逻辑、假设等问题的意见写入 `referee.md`。`methods.md`、`results.md`、图和稿件分开保存，未查到逐条 claim 到特定 run 的绑定。[模块输入输出表及 Review module][den] |
| **AI-Researcher（HKU）** | Guided 模式可给出具体方法指令和参考文献。Open-ended 模式仅给参考文献，由模型提出和遴选方向。未查到两种模式都要求逐项人工审批。[论文][hku]、[作者示例][hkurepo] | 先做小规模运行，通过后扩大实验，持续失败可标为 `unfeasible`。Advisor Agent 按方法要点审实现。公开示例有论文和对应 workplace，含代码与运行材料，未查到逐句证据映射。[论文][hku]、[workplace 示例][hkurepo] |
| **MLR-Copilot** | 可从论文出发由 IdeaAgent 生成 idea 和计划，也支持输入已有 idea。人在执行阶段可给反馈、促成修订，没有公开的逐关批准要求。[论文][mlr]、[仓库][mlrrepo] | 依据执行结果调试，论文另有人和模型评测。`logs/<task_name>/<start_timestamp>/agent_log/full_log.jsonl` 与 `env_log/` 能定位某次运行的操作和环境反馈。未查到报告中每个数对应哪条记录。[日志结构][mlrrepo]、[论文][mlr] |
| **Carl（Autoscience）** | 人给起始文献，Carl 提出具体假设和方法。由构思进入实验、由实验进入写作都要人批准，写作中还有批准点。团队说明，这些节点主要让人决定是否继续投入，最清楚地体现了“模型选路线、人放行”。[技术报告 §2、§3.1][carlpaper]、[团队说明][carl] | 团队报告有多个实例独立重做、人工逐行审代码和复验，也使用查重及引文工具。可查其读过的文献和验证过程，未查到正文段落直达运行文件的公开索引。[技术报告 §5][carlpaper]、[团队说明][carl] |

### A3. 模型选择路线，再由人使用、验证或投稿

| 系统 | 谁提出方向、谁作决定 | 实际检查与公开可追到的位置 |
|---|---|---|
| **The AI Scientist v1** | 人给宽方向、模板和起始代码，模型提出具体 idea、查新、设计实验并写稿。单次流程未设逐项人工审批。[论文][as1] | 脚本失败或超时会返回错误，写作有编译检查和 LLM review。实现将 `run_i.py` 对应到 `run_i/final_info.json`，并让模型把运行号和图记入 `notes.txt`。可查某次实验，未查到稿件每个数字的来源校验。[实验代码][ascode]、[论文][as1] |
| **The AI Scientist-v2** | 人给主题，模型探索假设，选择实验树节点。真实投稿实验多了两次人工选择：团队先从模型候选选三个 idea，再从各 idea 不同随机种子的完整稿件中择稿。[论文 §4.2][as2] | 有执行失败、阶段预算和重复实验，模型评节点，VLM 审图。节点含计划、代码、输出和错误，复制及聚合节点形成图表，仓库可导出实验树。未查到从终稿每项主张回到节点的通用链接。[论文][as2]、[实验树说明][as2git] |
| **AI co-scientist（Google）** | 科学家给目标和约束，也可给初始假设和中途反馈。模型生成、反思、辩论并排序假设，科学家选择值得验证的方案，实验由合作研究者验证。这给人保留了实质决定权，也允许模型先给出具体候选。[2025 系统论文][co25]、[2026 Nature 论文][co] | 有文献检索、模型批评和 tournament 排序。排序分是模型间的比较结果。公开材料能查候选假设、评审例和文献依据，未查到系统将每个报告段落绑定到实验 run、原始文件和编辑操作。[系统方法][co25]、[验证案例][co] |
| **Robin（FutureHouse）** | 人给研究对象，Robin 提假设、推荐实验并排序候选。案例中的科学家实审候选、编写实际实验方案并执行，随后把结果交回系统分析，人的角色包括实验设计和判断。[Nature 论文，图 1–2][rb] | 模型 tournament 和多条分析轨迹用于评选、汇总，实验提供外部检验。可查候选结果、日志、分析 notebook 和案例数据，未查到从终稿逐段进入对应原始记录的统一机制。[论文及 Data availability][rb]、[示例仓库][rbrepo] |
| **Curie** | 人给实验问题及可选数据或起始代码。Architect 定假设、变量与优先级，Technician 执行，未查到逐关人工批准。[论文][cu] | Inter-ARM 只允许规定的状态迁移，实验设置须验证才能执行，另有与计划是否一致的审查。Time Machine 用 DAG 保存设置、执行状态、结果及变更。报告、结果汇总和工作目录可按实验 ID 查找，未查到正文逐段回链。[架构与 Time Machine][cu]、[产物目录][curepo] |
| **ResearchAgent** | 从种子论文、引用关系和相关实体出发，模型提出问题、方法和实验设计，多个 ReviewingAgents 反复提意见。人的判断用于形成评价准则和事后评估，未列出逐方案批准。[论文][ra] | 有语义评审，公开任务止于研究 idea 和实验设计。因此文献关系可查，实验结果文件和运行记录在这个任务中不适用。[论文][ra] |
| **Zochi（Intology）** | 据团队报告，人给宽领域，模型形成具体方向和实验。后续投稿沿用此前已生成的高层 idea，人参与内审、核对代码和结果、制图及 rebuttal。[团队原文][zblog] | 有自动评测脚本和模型审稿。作者注明，公开技术材料对应较早版本，发布的代码清理过中间研究痕迹。可审最终代码和结果，未查到新版逐段还原运行轨迹的公开接口。[作者仓库][zrepo]、[团队原文][zblog] |

### A4. 2025–2026 年直接影响定位的新系统

| 系统 | 人和检查点 | 溯源做到了哪里 |
|---|---|---|
| **Kosmos（2025）** | 人给数据集和宽目标，系统根据 world model 自选下一轮检索和分析任务，最后由人解读、核验。未查到每项结论在交付前都经过确定性真实性门禁。[论文 §2.1][kos] | **报告每项陈述和每幅图**引用一篇文献或某个分析 agent 生成的 Jupyter notebook。团队组织专家独立核验三份报告的 102 条陈述，总体获支持比例为 79.4%，跨证据综合判断为 57.9%。这两个数直接体现了“能找到来源”和“来源支持解释”之间的距离。[论文 §2.1][kos] |
| **AutoResearchClaw（2026）** | 可选 Full-Auto、Gate-Only、CoPilot 等模式。Gate-Only 在文献筛选、实验设计和最终质检暂停，CoPilot 可共同拟假设。论文的人工干预模式比较使用脚本模拟干预，未用真人参与者。[论文 §3.5、附录 J][arc] | 执行时建立按实验条件区分的只读 numeric registry，记录各 seed、均值和标准差。关键章节数字无法按条件匹配会拒稿，其他章节可换成可见占位符，另有多角色语义讨论。可回到结果登记与条件文件，未查到每个解释段的编辑者操作链。[论文 §3.4 及附录][arc] |
| **ScientistOne（2026）** | 给定研究任务后，模型提出方案、探索分支并选结果。Ground 确定性检查文件和分数，Critic 审主张过度、缺失比较及基线公平性，尚有 blocking violation 的稿件不能晋级。[论文 §4][sone] | **与 Papertown 的内部标签最接近。** 草稿中的事实已绑定日志行、分数文件项、消融结果或 citation key，终版 LaTeX 剥离标签。作者在 15 篇稿件中提取 639 条数值主张，以指定日志行和 5% 相对容差核验，627 条通过。该测量的终点是所引日志值，未查到每条都继续绑定原始文件哈希及写入者的 CLI 操作。[论文 §4.3、§6.2][sone] |
| **YouRA（2026）** | 从宽主题开始，多角色形成假设，独立 controller 决定推进、修理或重设。研究者能写入指令，`MUST_STOP` 可要求人介入。`MUST_WORK` 未满足不能推进，状态迁移受约束，其中若干判定由 LLM 做出。[论文 §3、附录 A][yra] | `verification_state.yaml` 存假设、门状态、证据指针与失败历史，**每次状态变更有时间和归属**。Accuracy Checker 对照登记数值、代码、日志及结果。未查到公开终稿每个段落的每次编辑都锚定到原始文件内位置。[论文 §3.2、附录 A][yra] |

## B. 溯源和可复现技术

对 Papertown，最有用的区分是三个可分别验收的问题：**出处**问“这句话用了哪份证据”，**复现**问“给定版本与环境能否重算”，**科学审查**问“这个实验是否支持这句话”。Kosmos 的综合判断误差，以及对科研 agent 数值错配的独立检查，都说明有必要分别衡量三者。[Kosmos][kos]、[Beyond fabrication][numbers]

| 技术 | 记录内容和粒度 | Papertown 可借鉴的做法与已知边界 |
|---|---|---|
| **W3C PROV** | `Entity` 表示有确定版本的对象，`Activity` 表示运行或编辑，`Agent` 表示承担责任的人或软件。`used`、`wasGeneratedBy`、`wasDerivedFrom`、`wasAssociatedWith` 分别表达使用、生成、派生和活动归属。[PROV-DM][prov] | 把“跑出数值”和“把数值写进文章”记为两项 Activity，各有执行者。一个段落可用多个结果，同一结果也可支撑多个段落，底层宜存图，界面按需展开成树。PROV 提供表达方式，采集哪些边仍由应用决定。[PROV-DM][prov] |
| **RO-Crate** | `ro-crate-metadata.json` 用 JSON-LD 关联文件、软件、人员等对象。Workflow Run Crate 描述一次工作流运行，Provenance Run Crate 可细到工具调用、步骤和中间输出。[基础规范][crate]、[Workflow Run Crate][wrc]、[Provenance Run Crate][prc] | 适合把选定结果及证据导出为可移交的包。基础 crate 也可只引用外部 URL，接收者能否取得原始字节、包中是否有步骤级历史，取决于打包内容和 profile。[文件实体规范][cratedata]、[Provenance Run Crate][prc] |
| **DVC** | `dvc.yaml` 声明阶段、命令、依赖和输出，`dvc.lock` 记录实际参数和输入输出文件的内容标识。`dvc push` 单独上传缓存数据。[pipeline 与 lock 文件][dvc]、[dvc push][dvcp] | 用内容标识固定结果版本，并给每次执行另发 `run_id`。只提交 Git 中的 lock 文件，队友仍可能拿不到数据。脚本读取但未声明的输入也会破坏重算。[DVC 依赖与可复现要求][dvc]、[远端数据][dvcp] |
| **MLflow** | run 记录起止时间、参数、指标、代码版本及 artifacts。MLflow 3 可把指标连到特定模型 checkpoint 和数据集，`log_input()` 可登记数据集的 digest、schema 与 source。[Tracking][ml]、[Dataset API][mld] | 论文数字应至少带 run、指标、数据集版本和条件。MLflow 明确提醒，经过过滤、变换的训练数据可与原始 source 不同，单存源 URL 不足以恢复实际输入。[Dataset API][mld] |
| **Weights & Biases Artifacts** | `use_artifact()` 声明 run 的输入，`log_artifact()` 声明输出，形成 artifact 版本与 run 交替的 lineage DAG。[官方 lineage 文档][wb] | 借鉴显式生产者、消费者和 artifact 版本。漏登记的依赖不会出现在这张图中，论文里的一个表格单元格还需单独绑定 artifact 内的位置。[lineage API 与示例][wb] |
| **Sumatra** | 每次计算一条 Record，可含代码库与版本、入口、参数、用户、时间、输入、输出和控制台记录。可把唯一运行标签传给程序，用该标签划分结果目录。[Record API][sum]、[输入输出文档][sumd] | 适合防止两个 run 的同名结果混放。其文件检测依赖配置的本地目录，数据上传与备份要另行处理。[输入输出文档][sumd] |
| **noWorkflow** | 无需改写原 Python 脚本，就能按 trial 记录环境、函数调用和文件访问。细粒度模式可捕获变量赋值及依赖，外部程序调用还可记录启动及交换的文件。[VLDB 论文][nw]、[项目文档][nwdoc] | 对关键统计量，可从输出追到 Python 计算。作者指出过粗会漏信息、过细会淹没使用者。适合对重点计算按需展开，另存正文引用位置。[VLDB 论文][nw] |
| **ReproZip** | 在 Linux 跟踪实际运行的系统调用，捕获二进制、文件、库和环境变量，生成可重放的实验包。[官方打包文档][rz] | 适合保存“这次究竟用了什么”。只跟踪本地客户端无法捕获远程服务端状态，包内文件访问记录也没有论文主张的语义。[官方 FAQ][rzfaq]、[打包文档][rz] |
| **Quarto / knitr / Jupyter Book** | Quarto 可在正文求值，knitr 可将 inline R expression 的结果嵌入文本。Jupyter Book v1 的 `glue()` 给输出命名并可跨文档插入，MyST 也能按标签复用 notebook 输出。[Quarto][qu]、[knitr][kn]、[Jupyter Book `glue`][jb]、[MyST][myst] | 直接渲染指标可避免手抄。Quarto 的 `freeze: auto` 在整项目渲染时看源文件变化，外部数据已换而源文件未改时仍可能复用旧结果。应把输入版本和实际执行记录一起留存。[Quarto 执行与缓存][freeze] |
| **Manubot** | Markdown 稿件在 Git 中保留变更历史，通过 pull request 审阅，源文更新后重新构建。引文可用 DOI 等持久标识解析。[原论文][mb] | 适合回答“谁改过这句、哪次审过”。若要回答“这句采用哪次实验的哪个数字”，仍需在写作版本与实验记录之间增加一条边。[原论文的写作及引用流程][mb] |
| **Jujutsu operation log** | 每次修改仓库的 operation 带父操作、操作结束时的仓库视图、时间、用户名、主机和描述，可用 `jj op log` 查看、用 `jj op restore` 恢复旧视图。[官方设计文档][jj] | 适合借鉴细于业务 commit 的操作 ID，也能表达并行更新。其快照范围是仓库视图，实验在数据库或远程服务中的副作用要单独记录。[官方设计文档][jj] |
| **Claude Code checkpoint** | 开始新 turn 的 prompt 建 checkpoint，可回退会话或受跟踪文件。编辑工具碰过的文件会保留快照，只被 Bash 修改的文件通常不在覆盖内，快照还有保留期限。[官方 checkpoint 文档][cc] | 适合工作中撤销。若某次 shell 命令产生关键结果，项目负责人 agent 应主动登记该命令和结果文件，不能仅靠会话 rewind 回答实验出处。[官方覆盖范围与限制][cc] |
| **Codex ghost commit / shadow commit** | 历史实现用临时 Git index 构树、创建不移动 refs 的 detached commit，并对过大的未跟踪文件作排除处理。版本差异很实在，`rust-v0.169.0` 已把旧 `undo` / `GhostCommit` 标志标为兼容用 no-op。[OpenAI 合并记录][ghost]、[固定版本源码][codexv] | 值得借鉴的是不污染工作分支的快照机制。项目需要持久存储自己的操作记录和结果清单，不能把某一版 CLI 的内部快照当作跨版本审计接口。[历史实现][ghost]、[固定版本源码][codexv] |

**Git notes 和自定义 refs 能解决存放位置，项目权限还需单独设计。** `git notes` 默认写入 `refs/notes/commits`，可以给对象追加说明而不改变原 commit。普通 `git push` 在默认 `push.default=simple` 配置下推当前同名分支，不会顺带推 `refs/notes/*` 或自定义的 `refs/papertown/*`。`git push --all` 覆盖 `refs/heads/*`，仍不含这两类引用。显式 refspec 可以传输它们，`git push --mirror` 则会镜像整个 `refs/`。常规 fetch 的分支映射同样需要为自定义 refs 另作配置。[git-notes][gn]、[git-push][push]、[The Refspec][refspec]

**“默认不 push”只能作为默认传输行为。** Git 官方明确指出，fetch/push 协议和 namespace 不能作为对不可信对端的保密边界。Papertown 若承诺“仅项目内可见”，宜用有项目访问控制的证据存储，另验导出的 Markdown、LaTeX、PDF 是否移除了内部标签和路径。团队成员之间则需要一条有授权的同步通道，否则换机后连自己也无法恢复证据。[Git namespace 安全说明][gsec]、[ScientistOne 的标签导出处理][sone]

**建议的最小可验收链。** 以“某方法比基线高 2.1 个百分点”为假设示例，项目内应能展开到两个操作数各自的指标、数据划分和 run，再看到聚合公式、脚本版本、输入及结果文件哈希、文件内行或 JSON 字段，最后能分别指出谁运行实验、谁在何时把结论写进哪一版段落。背景段可连外部文献，方法段可连人的决定和代码，综合判断可连多份证据。这样既保留读者熟悉的树形视图，也能表达证据复用。[PROV-DM][prov]、[data-to-paper 的派生值][dm]、[数值错配实证][numbers]

## C. “人主导、模型干活”的理论与证据

### C1. 人在哪一步参与，比有没有批准按钮更重要

Sheridan & Verplank 在 *Human and Computer Control of Undersea Teleoperators* 表 8.2 中已经区分两种权限分配。第 1 级由人选定行动、交计算机执行，第 5 级由计算机选行动，获人批准后执行。Horvitz 的 *Principles of Mixed-Initiative User Interfaces* 则把目标不确定性、打断成本，以及用户能否调用或终止自动服务纳入设计。前者给 Papertown 一个准确的分类，后者说明可以让 agent 主动索取证据或提示矛盾，同时保留研究者的决定权。两篇都属于设计框架。[Sheridan & Verplank，表 8.2][sv]、[Horvitz][hor]

被动审批的风险有行为证据。Skitka 等的模拟飞行实验中，参与者既会漏掉系统没有提示的事件，也会在错误建议与训练及可靠仪表相冲突时照办。对 LLM，Kim 等的预注册实验发现，提供解释同时增加了 308 名参与者对正确和错误回答的依赖，提供来源则降低了对错误回答的依赖。对应到科研界面，展示一段有说服力的理由和提供可核查出处，是两种效果不同的干预。[automation bias 原始实验][sk]、[LLM 依赖实验][kim]

### C2. “先自己写”能支持到什么程度

| 证据 | 能支持的结论 | 需要保留的限定 |
|---|---|---|
| **先记录判断，再看生成式 AI 建议** | Yan 的随机实验招募 240 名职前教师，主分析保留 218 人。遇到误导建议时，先记录方案和理由的一组，最终两项均符合专家判准的胜算为先看建议组的 **1.91 倍**，95% CI 为 **1.41–2.59**。建议正确时，组间差异不显著。[原文][yan] | 参与者分别从四个方案和四个理由中选择。实验直接检验了**独立判断的顺序**，尚不能把效果归功于自由撰写文本，也不能直接推到科研成果质量。[任务材料与分析][yan] |
| **Cognitive forcing functions** | Buçinca 等的 199 人实验包含先答后改等干预。与直接展示建议及解释相比，认知干预降低了模型出错时的过度依赖。[原文][bf] | 研究比较了多种干预，不能单独归因于“写理由”。总体准确率没有相应的普遍优势，较强干预的主观评价也较差。[原文][bf] |
| **先作答也会产生代价** | 三项预注册人脸匹配实验中，先独立判断、按需或按条件出示 AI 建议，在部分设置下降低了误信。参与者也可能更难接受与初判冲突的正确建议，各实验均未发现总体表现显著改善。[原文][face] | 产品验证应同时测**错建议采纳率、正确反证采纳率和耗时**。只测用户驳回模型多少次，会漏掉另一类错误。[实验结果][face] |

**可由证据支撑的一句话是：当模型可能给出误导性建议时，让用户先留下独立判断和理由，可以降低照采错误建议的风险。** 对 Papertown，更贴近证据的实现是先让人接触文献和数据、写决定，再让 agent 核实、提供反证，并允许人有记录地修订决定。真实科研项目中，自由撰写与点击批准对最终论文质量的直接因果比较，本次未查到。[判断顺序实验][yan]、[反向条件][face]、[实际科研执行研究][si2]

### C3. AI 生成 idea 再由人挑选，确实可能有收益

Si、Yang 与 Hashimoto 的 NLP 研究盲评每组有 49 个 idea。按 idea 聚合，新颖性均分为人写 **4.86**、AI 生成 **5.62**、AI 生成加人工重排 **5.78**，两个 AI 组均显著高于人写组。该检验没有证明人工重排显著优于单用 AI。同一研究也发现，在作者设定的语义相似度阈值下，每个主题生成 4,000 个种子 idea 后，平均约 200 个被判不重复。**优选出的方案可以新颖，整个候选池也可以高度重复。** [盲评与去重方法][si]

后续研究让 **43 位研究者**随机接手人或 LLM 提出的 idea，每人投入超过 **100 小时**，完成实验后提交匿名短文。AI 组从构想到执行后的四项评分降幅更大，最终两组评分差异不显著。因此，支持 Papertown 人先定题的理由包括保留研究者自身的判断和方向多样性。用现有数据宣称“人提出的 idea 最终一定更好”则站不住。[执行研究][si2]

关于“谁动笔”，另有一项更贴近界面设计的反证和折中结果。Maier 等在产品创意任务中先让所有人提交初始想法，模型主动重写提高了专家评分，同时降低了多样性和主观归属感。模型提出反思问题、由人自行扩写也提高了质量，并保留了多样性和归属感。主实验 486 人，另一情境验证 640 人，研究对象是产品创意。[原文][maier]

### C4. 全自动科研的独立评测与会议边界

- **v1 的独立实测。** Beel、Kan 与 Baumgart 在其配置下测试 The AI Scientist，12 个拟议实验中有 5 个因代码错误失败，部分生成稿含错误或虚构数值，已有方法也会被误判为新颖。这个小样本足以说明执行检查和自评可能漏掉实质错误，不能当作所有模型配置的错误率。[独立评测原文][beel]
- **看底层记录确实能改善审计。** 一项针对 Agent Laboratory 和 The AI Scientist-v2 的 PNAS 研究发现，同类 LLM auditor 只看终稿时识别问题的准确率为 **53.7%**，加入带时间的决定日志、中间产物和代码后达到 **81.5%**。样本为平衡构造，含自然失误及受控植入失误。这是保留执行证据的直接理由，不能用来估计真实论文失误率。[PNAS 原文][audit]
- **最容易漏掉的数值问题是用错出处。** 2026 年预印本 *Beyond fabrication: Misattributed numbers in papers written by AI research agents* 手工标注了 18 份提交中的 256 条数值主张。缺乏正确证据的主张里，约五分之四的数字其实能在文件中找到，只是来自错误的实验、指标或 run。对 Papertown，硬检查应比对“指定证据中的指定指标”，只在全项目搜索同值会漏掉这类错误。[原文][numbers]
- **工作坊过线与会议政策有明确范围。** ICLR 2025 的 ICBINB workshop 经批准，在 43 篇投稿中混入 3 篇 AI 稿，评审可退出。Sakana 报告其中 1 篇超过该 workshop 的接收分数线，并按约在发表前撤回。ICLR 2026 主会允许 LLM 辅助，显著参与构思或写作须披露，人类作者负全责。NeurIPS 2026 **Position Paper Track** 要求正文实质上由人撰写，AI 限于润色等外围修改。这些规定应按届次和 track 引用。[工作坊评审指南][work]、[Sakana 实验记录][sreport]、[ICLR 2026 作者指南][iclr]、[NeurIPS 专项政策][neur]

## D. 定位

### D1. 三个卖点的横向对照

“工程检查”表示执行、编译或预算等局部条件。“门禁”表示有资料显示失败会阻止指定下游。“可追到”列的是已公开展示的较细粒度，日志、代码仓库和论文放在一起时，仍需看正文有没有指向其中的具体记录。

| 系统 | ① 硬检查与语义审查 | ② 人掌握的决定 | ③ 产出可追到 |
|---|---|---|---|
| The AI Scientist v1 | 工程检查、模型审稿 | 人给宽题和模板 | 脚本、run 目录、结果 JSON。[论文][as1]、[代码][ascode] |
| The AI Scientist-v2 | 节点失败、阶段停止、模型及 VLM 评审 | 人给主题，投稿案例另有人选题、择稿 | 实验树节点、脚本、输出、复制与聚合节点。[论文][as2] |
| Agent Laboratory | 执行、编译、模型审稿 | 人提 idea，可逐任务打回 | 报告、代码、阶段 checkpoint。[论文][al]、[仓库][alrepo] |
| data-to-paper | 步骤规则、缺失值中止、模型及可选人工审阅 | 人可定目标，也可全自动 | Results 数字经公式、表和输出文件到代码行。[方法][dm] |
| CodeScientist | 资源上限、模型反思、人工复验 | 主流程人筛机器 idea，也可自写 idea、改计划 | 每个实验的代码、日志、结果与报告。[论文][codes]、[仓库][codesrepo] |
| AI co-scientist | 反思、排序、外部实验验证 | 人定目标，可给假设，选择验证对象 | 假设、比较记录、文献及验证案例。[系统论文][co25]、[Nature][co] |
| Robin | 模型排序、多轨迹分析、人工实验验证 | 人定对象、审候选、写实际实验方案 | 候选结果、轨迹、notebook、案例数据。[论文][rb]、[仓库][rbrepo] |
| Denario | 编译修复、referee 语义审查 | 人可直接定 idea 和 method | 模块文件、图、代码、稿件。[论文][den] |
| Curie | 实验状态门禁、设置和执行验证 | 人给问题，Architect 定方案 | 实验历史 DAG、结果路径及工作目录。[论文][cu]、[仓库][curepo] |
| MLR-Copilot | 执行反馈、纠错及评估 | 人给输入，可在执行中修订 | 带时间的 agent 和环境日志。[论文][mlr]、[仓库][mlrrepo] |
| ResearchAgent | 多模型语义审查 | 人的判断校准评审，模型拟题和方法 | 种子文献、引用及 idea，实际实验不适用。[论文][ra] |
| Zochi | 自动评测、模型审稿、人工终审 | 人给宽方向，投稿前核验 | 公开代码和主结果，部分中间痕迹已清理。[团队说明][zblog]、[仓库][zrepo] |
| AI-Researcher（HKU） | 小规模验证后放大、Advisor 审实现 | 可给详细方法，也可只给文献 | 稿件及对应 workplace、代码、日志。[论文][hku]、[作者示例][hkurepo] |
| Carl | 多实例复验、人工核查、查重和引文工具 | 人给起始文献，多处批准模型继续 | 阅读记录、论文及复验说明，逐段 run 链未查到。[技术报告][carlpaper] |
| Kosmos | 模型汇总，案例由专家事后抽验 | 人定目标及数据，模型选分析 | 报告陈述及图到文献或分析 notebook。[论文][kos] |
| AutoResearchClaw | 数值门禁、拒稿或占位、多角色审查 | 全自动、关口审批、共同拟题均可选 | 数值到条件、seed 和结果登记。[论文][arc] |
| ScientistOne | 确定性查分和文件、语义批评、终稿门禁 | 人给任务，系统选方案 | 草稿事实到日志行、分数项、消融或引文。[论文][sone] |
| YouRA | 状态门禁、恢复路由、对抗式事实审阅 | 人可下指令，controller 决定推进 | 证据指针、结果文件、带时间和归属的状态变更。[论文][yra] |
| **Papertown（题述目标）** | **六道工序可锁定、退回，另标契合／预警／偏离** | **研究者先写方向、关键方法、实验安排和文档设计** | **项目内从段落或结果追到计算、原始文件、run、时间及具体 agent 操作。实现未核验。** |

### D2. 每个卖点最强的差异、质疑与可用文案

| 卖点 | 最强差异 | 最可能被质疑的地方 | 宣传材料拟用表述 |
|---|---|---|---|
| **① 硬检查点和软检查点** | 展示一个跨工序的实际失败案例：缺结果文件时谁被锁、退给谁、补齐后怎样恢复。对“实验是否足以支撑主张”，另留带证据的语义判断。Curie 和 ScientistOne 已经能做局部门禁与语义审查。[Curie][cu]、[ScientistOne][sone] | 一组容易通过的规则对科学质量有多大帮助？例如相似度阈值可以触发复核，但比例本身不能判定抄袭。应能说明每条规则检验了什么、漏掉什么。[Turnitin 官方解释][turnitin]、[独立审计][audit] | **中**　必备检查失败时，Papertown 会暂停下游工序并退回修改，方法和证据上的问题会单独标出供复核。 **EN**　Papertown pauses the next stage when a required check fails and flags questions about methods or evidence for review. |
| **② 研究者先作决定** | 将四类关键决定设为研究者先填写的项目记录，在 agent 执行前生成版本。相较 Carl 的继续按钮和 Denario 的可选方法输入，这是一项用户能亲自验证的默认流程差异。[Carl][carlpaper]、[Denario][den] | 用户能否只复制模型意见走完形式？记录能证明输入顺序、作者和修订，难以证明思想原创。还要看用户是否更能拒绝错建议，同时接受正确反证，以及多花了多少时间。[顺序实验][yan]、[反向证据][face] | **中**　研究方向、关键方法、实验安排和文档提纲由你先写定，agent 按这些决定查文献、核实证据并执行。 **EN**　You set the direction, key methods, experiment schedule, and paper outline, and the agents check the literature and carry out the work you specify. |
| **③ 项目内可验证、可溯源** | 把三条容易断开的记录接起来：**论文用了什么证据、哪次运行生成了证据、哪个 agent 的哪次操作写下了这段话**。验证时应选一个跨多个 seed 的派生数字，再选一个综合段落。已有系统分别覆盖了数字回链、内部标签和带归属的状态变更。[data-to-paper][dt]、[ScientistOne][sone]、[YouRA][yra] | 同一个数出现在错误 run，标签是否仍会亮绿？段落移动、重新聚合或切换机器后能否找回原证据？导出的论文会否泄露私有路径？这分别考验语义匹配、版本持久性和项目权限。[数值错配实证][numbers]、[Git notes][gn]、[Git 安全说明][gsec] | **中**　每个段落都有项目内的来源标签，实验主张可沿标签查到结果文件、计算过程、运行记录和写入它的 agent 操作。 **EN**　Each paragraph has a project-only evidence link that, for experimental claims, leads to the result files, calculations, runs, and agent edits behind it. |

## 参考来源列表

- **科研系统与公开实现**：[The AI Scientist v1][as1]、[v1 实验代码][ascode]、[The AI Scientist-v2][as2]、[v2 仓库][as2git]、[Agent Laboratory][al]、[阶段存档][alrepo]、[CodeScientist][codes]、[公开实验记录][codesrepo]、[Denario][den]、[Curie][cu]、[Curie 产物目录][curepo]。
- **人机协作与系统案例**：[Towards an AI co-scientist][co25]、[Accelerating scientific discovery with Co-Scientist][co]、[Robin][rb]、[Robin 仓库][rbrepo]、[MLR-Copilot][mlr]、[运行日志][mlrrepo]、[ResearchAgent][ra]、[AI-Researcher][hku]、[workplace 示例][hkurepo]、[Zochi 团队说明][zblog]、[Zochi 仓库][zrepo]、[Carl 团队说明][carl]、[Carl 技术报告][carlpaper]。
- **逐项证据与新系统**：[data-to-paper 发表版][dt]、[Information tracing 方法原文][dm]、[data-to-paper 仓库][dtgit]、[Kosmos][kos]、[AutoResearchClaw][arc]、[ScientistOne][sone]、[YouRA][yra]。
- **溯源标准与实验记录**：[W3C PROV-DM][prov]、[RO-Crate][crate]、[RO-Crate 文件实体][cratedata]、[Workflow Run Crate][wrc]、[Provenance Run Crate][prc]、[DVC lock][dvc]、[DVC push][dvcp]、[MLflow Tracking][ml]、[MLflow Dataset][mld]、[W&B lineage][wb]、[Sumatra Record][sum]、[Sumatra 数据处理][sumd]、[noWorkflow 论文][nw]、[noWorkflow 文档][nwdoc]、[ReproZip][rz]、[ReproZip FAQ][rzfaq]。
- **计算写作、版本历史与 checkpoint**：[Quarto][qu]、[Quarto freeze][freeze]、[knitr][kn]、[Jupyter Book][jb]、[MyST][myst]、[Manubot][mb]、[git-notes][gn]、[git-push][push]、[Git refspec][refspec]、[Git namespaces][gsec]、[Jujutsu operation log][jj]、[Claude Code checkpointing][cc]、[Codex ghost snapshot][ghost]、[Codex 固定版本源码][codexv]。
- **人因与 idea 研究**：[Sheridan & Verplank][sv]、[Horvitz][hor]、[Skitka 等][sk]、[Buçinca 等][bf]、[Yan 判断顺序实验][yan]、[人脸匹配实验][face]、[Kim 等 LLM 依赖实验][kim]、[科研 idea 盲评][si]、[科研 idea 执行研究][si2]、[Maier 等人机共创实验][maier]。
- **独立评估与政策**：[The AI Scientist v1 独立评测][beel]、[PNAS 执行记录审计][audit]、[Beyond fabrication][numbers]、[ICBINB workshop 评审指南][work]、[Sakana 投稿实验说明][sreport]、[ICLR 2026 作者指南][iclr]、[NeurIPS 2026 Position Paper Track][neur]、[Turnitin 相似度说明][turnitin]。

[dt]: https://kishony.technion.ac.il/wp-content/uploads/sites/403/2025/07/AIoa2400555.pdf
[dm]: https://arxiv.org/pdf/2404.17605
[dtgit]: https://github.com/Technion-Kishony-lab/data-to-paper
[as1]: https://arxiv.org/html/2408.06292
[ascode]: https://raw.githubusercontent.com/SakanaAI/AI-Scientist/main/ai_scientist/perform_experiments.py
[as2]: https://arxiv.org/html/2504.08066
[as2git]: https://github.com/SakanaAI/AI-Scientist-v2
[al]: https://arxiv.org/html/2501.04227
[alrepo]: https://github.com/SamuelSchmidgall/AgentLaboratory
[codes]: https://arxiv.org/html/2503.22708
[codesrepo]: https://github.com/allenai/codescientist
[co25]: https://arxiv.org/html/2502.18864v1
[co]: https://www.nature.com/articles/s41586-026-10644-y
[rb]: https://www.nature.com/articles/s41586-026-10652-y
[rbrepo]: https://github.com/Future-House/robin
[den]: https://arxiv.org/html/2510.26887v1
[cu]: https://arxiv.org/html/2502.16069
[curepo]: https://github.com/Just-Curieous/Curie
[mlr]: https://arxiv.org/html/2408.14033
[mlrrepo]: https://github.com/du-nlp-lab/MLR-Copilot
[ra]: https://aclanthology.org/2025.naacl-long.342/
[zblog]: https://intology.ai/blog/zochi-acl
[zrepo]: https://github.com/IntologyAI/Zochi/blob/main/README.md
[hku]: https://arxiv.org/html/2505.18705
[hkurepo]: https://github.com/HKUDS/AI-Researcher
[carl]: https://www.autoscience.ai/blog/meet-carl
[carlpaper]: https://drive.google.com/file/d/1iVedOdZDuEdjS4lcm9Z7i8oEDGWfzVJq/view
[kos]: https://arxiv.org/html/2511.02824v1
[arc]: https://arxiv.org/html/2605.20025v1
[sone]: https://arxiv.org/html/2605.26340v1
[yra]: https://arxiv.org/html/2610.01097v1
[prov]: https://www.w3.org/TR/prov-dm/
[crate]: https://www.researchobject.org/ro-crate/specification/1.2/introduction
[cratedata]: https://www.researchobject.org/ro-crate/specification/1.2/data-entities.html
[wrc]: https://www.researchobject.org/workflow-run-crate/profiles/workflow_run_crate/
[prc]: https://www.researchobject.org/workflow-run-crate/profiles/provenance_run_crate/
[dvc]: https://doc.dvc.org/user-guide/project-structure/dvcyaml-files
[dvcp]: https://doc.dvc.org/command-reference/push
[ml]: https://mlflow.org/docs/latest/ml/tracking/
[mld]: https://mlflow.org/docs/latest/api_reference/python_api/mlflow.data.html
[wb]: https://raw.githubusercontent.com/wandb/docs/main/models/artifacts/explore-and-traverse-an-artifact-graph.mdx
[sum]: https://sumatra.readthedocs.io/en/latest/reference/records.html
[sumd]: https://sumatra.readthedocs.io/en/master/handling_data.html
[nw]: https://www.vldb.org/pvldb/vol10/p1841-pimentel.pdf
[nwdoc]: https://gems-uff.github.io/noworkflow/
[rz]: https://docs.reprozip.org/en/latest/packing.html
[rzfaq]: https://docs.reprozip.org/en/latest/faq.html
[qu]: https://quarto.org/docs/manuscripts/authoring/vscode.html
[freeze]: https://quarto.org/docs/projects/code-execution.html
[kn]: https://pkg.yihui.org/rmarkdown-book/r-code
[jb]: https://jupyterbook.org/v1/content/executable/output-insert.html
[myst]: https://mystmd.org/guide/reuse-jupyter-outputs
[mb]: https://journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1007128
[gn]: https://git-scm.com/docs/git-notes
[push]: https://git-scm.com/docs/git-push
[refspec]: https://git-scm.com/book/en/v2/Git-Internals-The-Refspec
[gsec]: https://git-scm.com/docs/gitnamespaces
[jj]: https://raw.githubusercontent.com/jj-vcs/jj/main/docs/operation-log.md
[cc]: https://code.claude.com/docs/en/checkpointing
[ghost]: https://github.com/openai/codex/pull/8055
[codexv]: https://raw.githubusercontent.com/openai/codex/rust-v0.169.0/codex-rs/features/src/lib.rs
[sv]: https://www.academia.edu/45510118/Human_and_Computer_Control_of_Undersea_Teleoperators
[hor]: https://www.microsoft.com/en-us/research/wp-content/uploads/2016/11/chi99horvitz.pdf
[sk]: https://www.researchgate.net/publication/222507469_Does_automation_bias_decision-making
[bf]: https://arxiv.org/pdf/2102.09692
[yan]: https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2026.1936522/full
[face]: https://link.springer.com/article/10.1186/s41235-026-00707-z
[kim]: https://arxiv.org/html/2502.08554v1
[si]: https://arxiv.org/pdf/2409.04109
[si2]: https://arxiv.org/html/2506.20803v1
[maier]: https://arxiv.org/pdf/2510.23324
[beel]: https://sigir.org/wp-content/uploads/2025/09/p14.pdf
[audit]: https://pmc.ncbi.nlm.nih.gov/articles/PMC13663820/
[numbers]: https://arxiv.org/pdf/2610.38691
[work]: https://sites.google.com/view/icbinb-2025/reviewer-guidelines
[sreport]: https://sakana.ai/ai-scientist-first-publication/
[iclr]: https://iclr.cc/Conferences/2026/AuthorGuide
[neur]: https://blog.neurips.cc/2026/06/02/ai-generated-papers-in-the-neurips-2026-position-paper-track/
[turnitin]: https://helpcenter.turnitin.com/hc/en-us/articles/27811925295501-Does-Turnitin-check-for-plagiarism-and-what-is-a-good-Similarity-score