// Page pieces shared by the gallery and the prototype: the workbench (from layout B),
// the production line (from C), the daily paper (from D), and the four 1280×800 layouts.

import { DISTRICTS, WORKERS, spriteSVG, itemSVG, workerSVG } from './sprites.js';
import { renderMap, FLOW_KINDS } from './world.js';

export const LOGO = '<svg class="logo-ic" viewBox="0 0 32 32"><path class="lg1" d="M4 14L16 5l12 9v13H4Z"/><path class="lg2" d="M16 5l12 9v13H16Z"/><path class="lg3" d="M12 27v-7h8v7"/><path class="lg3" d="M9 4h7l-3 3H9Z"/></svg>';
export const ava = (role, lv) => `<span class="ava" title="${WORKERS[role].name}${lv ? ' · 示例 ' + lv : ''}">${workerSVG(role)}</span>`;
const DEMO = '<span class="demo-tag">示意数据</span>';

// the life of one paper; each stage happens in a building
export const STAGES = [
  { key: 'idea', name: '灵感', short: '灵感', b: 'cityhall', out: 'egg', team: [], st: 'done' },
  { key: 'hatch', name: '查重孵化', short: '孵化', b: 'hatchery', out: 'notes', team: ['hatcher'], st: 'done' },
  { key: 'team', name: '立项编队', short: '编队', b: 'market', out: 'notes', team: ['scout'], st: 'done' },
  { key: 'method', name: '方法设计', short: '方法', b: 'mill', out: 'draft', team: ['designer', 'scout'], st: 'run', pct: 60 },
  { key: 'exp', name: '实验', short: '实验', b: 'farm', out: 'table', team: ['experimenter'], st: 'todo' },
  { key: 'write', name: '写作排版', short: '排版', b: 'press', out: 'tex', team: ['writer'], st: 'todo' },
  { key: 'review', name: '质检', short: '质检', b: 'qa', out: 'pdf', team: ['reviewer', 'reviewer'], st: 'todo' },
  { key: 'ship', name: '出厂投稿', short: '出港', b: 'dock_arxiv', out: 'pdf', team: [], st: 'todo' },
];

export const TRACE = [
  ['SKILL', 'hatchery/novelty-check', '加载 SKILL.md'],
  ['MCP', 'arxiv.search("VLA scene graph planning")', '48 篇'],
  ['RAG', 'library.search(top_k=8)', '命中 6 段'],
  ['GRAPH', 'genealogy.expand(depth=2)', '23 个节点'],
  ['SKILL', 'references/novelty-rubric.md', '按需读取'],
  ['LLM', '负责人生成撞车报告', '3.2k tok'],
];

export const traceRow = t => `<div class="tr"><span class="k k-${t[0].toLowerCase()}">${t[0]}</span><code>${t[1]}</code><em>${t[2]}</em></div>`;

// The B workbench (chat, trace, composer); extra: more panes (data-pane="line" / "trace")
// that the prototype's tabs switch to.
export function benchHTML({ closable = false, extra = '' } = {}) {
  return `<div class="bench-tabs"><a class="on" data-tab="chat">对话</a><a data-tab="line">流水线</a><a data-tab="trace">调用轨迹</a>${closable ? '<button class="bench-x" data-act="drawer-close" title="收起 Esc">×</button>' : ''}</div>
    <div class="bench-pane" data-pane="chat">
    <div class="chat">
      <div class="msg mine">我想做：让 VLA 模型用结构化的场景图做长程规划，减少多步任务里的误差累积。</div>
      <div class="msg bot">
        <div class="who">${ava('hatcher', 2)}<b>项目负责人</b><span class="chip ok">撞车报告</span></div>
        <p>检索了图书馆 1.2 万篇和 arXiv 近 30 天的 48 篇，最接近的工作：</p>
        <ul class="sim">
          <li><span>相似工作 A · 场景图 + LLM 任务规划</span><i style="--v:.71"></i><b>0.71</b></li>
          <li><span>相似工作 B · VLA 的层级动作分解</span><i style="--v:.64"></i><b>0.64</b></li>
          <li><span>相似工作 C · 具身智能的误差恢复</span><i style="--v:.58"></i><b>0.58</b></li>
        </ul>
        <p class="verdict"><span class="chip warn">可孵化 · 需调整</span>空白点：已有工作只在短程任务上验证，长程任务里场景图怎么持续更新还没人系统研究。</p>
        <div class="btns"><button class="btn pri" data-open="mill">查看项目</button><button class="btn">询问负责人</button></div>
        <div class="cost">6 步调用 · 3.2k tokens · $0.004</div>
      </div>
    </div>
    <div class="trace">
      <h5>本次调用轨迹</h5>
      <div class="trace-rows">${TRACE.map(traceRow).join('')}</div>
    </div>
    </div>${extra}
    <div class="composer"><input placeholder="描述你的 idea，或给工厂下订单…"><button class="btn pri" data-act="send">发送</button></div>`;
}

const ST_CHIP = {
  done: () => '<span class="chip ok">完成</span>',
  run: s => `<span class="chip pri">进行中${s.pct ? ' ' + s.pct + '%' : ''}</span>`,
  todo: () => '<span class="chip">排队</span>',
};

export function pipelineHTML(stations) {
  const n = stations.length;
  const cols = `repeat(${n}, minmax(0, ${n <= 5 ? '200px' : '1fr'}))`;
  return `<section class="line"><div class="stations" style="grid-template-columns:${cols}${n <= 5 ? ';width:fit-content;margin:0 auto' : ''}"><div class="belt"></div>${stations.map((s, i) => `
    <div class="stn ${s.st}"${s.b ? ` data-open="${s.b}" title="打开${s.name}所在的建筑"` : ''}>
      <div class="stn-ic">${s.b ? spriteSVG(s.b).html : itemSVG(s.out)}</div>
      <b>${i + 1}. ${s.name}</b>
      ${ST_CHIP[s.st](s)}
      <div class="stn-team">${s.team.map(r => ava(r)).join('') || '<em>—</em>'}</div>
      ${s.b ? `<div class="stn-out">${itemSVG(s.out)}</div>` : ''}
    </div>`).join('')}</div></section>`;
}

export function millPanels() {
  return `<div class="pnl">
      <h4>4. 方法设计 · 进行中</h4>
      <dl class="kv">
        <dt>员工</dt><dd>${ava('designer', 3)} 项目负责人 ${ava('scout', 2)} 项目负责人</dd>
        <dt>项目用量</dt><dd><div class="bar"><i style="width:42%"></i></div>$0.42 / $1.00</dd>
        <dt>Skills</dt><dd><span class="chip">method-design</span><span class="chip">baseline-finder</span></dd>
        <dt>MCP</dt><dd><span class="chip">github.search</span><span class="chip">library.search</span></dd>
        <dt>退回规则</dt><dd>硬卡口未通过时，负责人安排重做此工序</dd>
      </dl>
    </div>
    <div class="pnl">
      <h4>产出预览 · 方法草案 v0.3</h4>
      <div class="doc">
        <h6>Scene-Graph Memory for Long-horizon VLA</h6>
        <div class="sec">1 问题定义</div><div class="dl" style="width:92%"></div><div class="dl" style="width:70%"></div>
        <div class="sec">2 核心机制</div><div class="dl" style="width:88%"></div><div class="dl" style="width:95%"></div><div class="dl" style="width:60%"></div>
        <div class="sec">3 Baseline 与数据集</div><div class="dl" style="width:80%"></div>
      </div>
    </div>
    <div class="pnl">
      <h4>下一站 · 实验农场</h4>
      <dl class="kv">
        <dt>算力</dt><dd>2 卡 · 约 6 小时（nvidb 预估）</dd>
        <dt>排队</dt><dd>算力电厂第 2 位</dd>
        <dt>数据集</dt><dd>${itemSVG('dataset')} 2 个已在冷库</dd>
        <dt>代码</dt><dd>${itemSVG('crate')} 从 2 座仓库提货</dd>
      </dl>
      <button class="btn pri" style="margin-top:12px" data-open="farm">去实验农场</button>
    </div>`;
}

// The D daily paper; plain drops the world metaphor (the prototype's status view).
export function dailyBody({ plain = false, map = '' } = {}) {
  const w = (plainName, worldName) => plain ? plainName : worldName;
  const news = [
    ['场景图驱动的机器人长程规划', '与你的 idea 相似度 0.62'],
    ['VLA 模型的分层动作 token 化', '方法可借鉴'],
    ['面向具身任务的检索增强记忆', '可加入 related work'],
    ['多模态大模型的空间推理评测', '新 benchmark'],
  ];
  const last = plain
    ? `<section class="col">
        <h3>本周 Agent 调用</h3><p class="sub">作业要求的几项技术各用了多少次</p>
        ${[['RAG', '检索', 312, 100], ['MCP', '外部工具', 128, 41], ['SKILL', '加载 skill', 57, 18], ['GRAPH', '图谱扩展', 33, 11], ['LLM', '生成', 41, 13]]
          .map(([k, n, c, p]) => `<div class="fac"><div class="row"><span class="k k-${k.toLowerCase()}">${k}</span>${n}<div class="bar"><i style="width:${p}%"></i></div>${c}</div></div>`).join('')}
        <div class="fac"><div class="row">项目 #1 用量 <b style="margin-left:auto;color:var(--ink)">$3.10</b> / 预算 $10</div></div>
      </section>`
    : `<aside class="col inset">
        <h3>世界地图</h3>
        <div class="mapbox map-bg">${map}</div>
        <button class="btn pri">进入世界 →</button>
      </aside>`;
  return `<header class="mast">
      <div class="mast-l">第 12 期 · ${plain ? '运行状态' : '世界时间第 12 天'} · 09:41</div>
      <h1>PAPERTOWN 日报</h1>
      <div class="mast-r">${plain ? '' : `${LOGO}<span class="chip">用量 $4.20</span><span class="me">你</span>`}</div>
    </header>
    <div class="rule"></div>
    <section class="lead">
      <div>
        <span class="kicker">头条</span>
        <h2>${plain ? '你的 idea #12 通过查重，项目 #1 已开工' : '你的 idea #12 孵化成功，造纸厂 #1 今日开工'}</h2>
        <p>${plain ? '在本地论文库和 arXiv 里检索了 1.2 万篇论文，结论是"可做 · 需调整"。负责人已启动代码员工和写作员工，方法设计已经完成 60%。'
          : '负责人在图书馆和 arXiv 码头检索了 1.2 万篇论文，结论是"可孵化 · 需调整"。负责人在人才市场启动代码员工和写作员工，方法设计已经完成 60%。'}</p>
        <div class="btns"><button class="btn pri" data-open="mill">${plain ? '打开项目 #1' : '进入造纸厂 #1'}</button><button class="btn" data-act="chat">看${plain ? '查重' : '撞车'}报告</button></div>
      </div>
      ${plain ? `<ol class="lead-steps">${STAGES.map(s => `<li class="${s.st}" data-open="${s.b}"><b>${s.name}</b>${ST_CHIP[s.st](s)}</li>`).join('')}</ol>`
        : `<div class="lead-art">${spriteSVG('hatchery').html}${spriteSVG('mill').html}</div>`}
    </section>
    <div class="cols">
      <section class="col">
        <h3>${w('新论文', '港口到货')}</h3><p class="sub">${plain ? 'arXiv 今日新增 48 篇，与你相关 6 篇' : 'arXiv 码头今日卸货 48 篇，与你相关 6 篇'}</p>
        <ul class="news">${news.map(([t, d]) => `<li data-open="library">${itemSVG('notes')}<div><b>${t}</b><small>${d}</small></div></li>`).join('')}</ul>
      </section>
      <section class="col">
        <h3>${w('我的项目', '我的工厂')}</h3><p class="sub">2 个${plain ? '项目' : '造纸厂'}在运转</p>
        <div class="fac" data-open="mill"><b>${plain ? '项目' : '造纸厂'} #1 · VLA 场景图规划</b><div class="row">方法设计<div class="bar"><i style="width:60%"></i></div>60%</div></div>
        <div class="fac" data-open="qa"><b>${plain ? '项目' : '造纸厂'} #2 · 稀疏注意力加速</b><div class="row">质检<div class="bar"><i style="width:85%"></i></div>85%</div></div>
        <div class="fac" data-open="farm"><b>${w('实验结果', '实验农场 · 收成')}</b><div class="row">${itemSVG('table')}${plain ? '项目 #2 的消融实验结果表已出' : '造纸厂 #2 的消融实验结果表已收割'}</div></div>
      </section>
      <section class="col">
        <h3>${w('Agent 员工', '人才市场')}</h3><p class="sub">项目已启动的${plain ? ' agent' : '员工'}状态</p>
        <div class="fac" data-open="market"><div class="row">${ava('designer', 3)}项目负责人 · 运行中</div></div>
        <div class="fac" data-open="market"><div class="row">${ava('reviewer', 1)}写作员工 · 等待负责人派发任务</div></div>
        <h3 style="margin-top:12px">${w('GPU 与截稿', '电厂 · 气象台')}</h3>
        <div class="fac" data-open="power"><div class="row">${plain ? 'GPU 负荷' : '算力负荷'}<div class="bar"><i style="width:63%"></i></div>63%</div></div>
        <div class="fac" data-open="weather"><div class="row"><span class="chip bad">DDL 预警</span>你关注的会议还有 12 天截稿</div></div>
      </section>
      ${last}
    </div>
    <div class="stats">
      <div><b>48</b><span>今日${plain ? '新论文' : '到港论文'}</span></div>
      <div><b>2</b><span>运行中的${plain ? '项目' : '流水线'}</span></div>
      <div><b>9</b><span>在岗${plain ? ' agent' : '员工'}</span></div>
      <div><b>$3.10</b><span>本周折算用量</span></div>
      <div><b>17</b><span>已${plain ? '查重' : '孵化'}的 idea</span></div>
    </div>`;
}

export const LEGEND = `<h4>区域</h4>${Object.values(DISTRICTS).map(d => `<div class="lg-row"><i style="background:${d.color}"></i>${d.name}<em>${d.dir}</em></div>`).join('')}` +
  `<h4>物流</h4>${Object.entries(FLOW_KINDS).map(([k, v]) => `<div class="lg-row"><i class="fkey fd-${k}"></i>${v}</div>`).join('')}`;
export const TICKER = 'arXiv 码头今日卸货 48 篇，其中 6 篇与你相关 · 项目负责人 · 运行中 · 质检所在造纸厂 #2 的草稿里发现 1 处匿名问题 · 算力电厂排队 2 个任务';

function layoutA(still) {
  return `<div class="ui la">
    <div class="map-bg">${renderMap({ labels: 'key', highlight: 'mill', note: '方法设计中', anim: !still })}</div>
    <header class="hud pnl">
      <div class="brand">${LOGO}<b>Papertown</b></div>
      <div class="hud-stats">
        <div><i>世界时间</i><b>第 12 天 · 09:41</b></div>
        <div><i>负责人</i><b>2 <em>位运行中</em></b></div>
        <div><i>流水线</i><b>2 <em>条运行中</em></b></div>
        <div><i>算力电厂</i><b>63% <em>负荷</em></b></div>
      </div>
      <div class="hud-r"><span class="bell">3</span><span class="me">你</span></div>
    </header>
    <aside class="legend pnl">${LEGEND}</aside>
    <div class="bcard pnl">
      <div class="bc-head">${spriteSVG('mill').html}<div><small>学术工业区</small><h3>造纸厂 #1</h3><p>VLA × 结构化场景图做长程规划</p></div></div>
      <div class="stages">${STAGES.map(s => `<span class="st ${s.st}">${s.short}</span>`).join('')}</div>
      <div class="bc-row"><span>方法设计</span><div class="bar"><i style="width:60%"></i></div><b>60%</b></div>
      <div class="bc-team">${ava('designer', 3)}${ava('scout', 2)}${ava('writer', 1)}<span>3 名员工在岗 · 已花 $0.42 / $1.00</span></div>
      <div class="bc-btns"><button class="btn pri">进入工厂</button><button class="btn">查看调用轨迹</button></div>
    </div>
    <button class="newidea btn pri">${itemSVG('egg')}放入一颗新 idea</button>
    <div class="ticker pnl"><b>世界日报</b><span>${TICKER}</span></div>
    <div class="minimap pnl">${renderMap({ objects: false, flows: false, districts: false, anim: false, labels: 'none' })}<i class="mm-view"></i></div>
    ${DEMO}
  </div>`;
}

function layoutB(still) {
  return `<div class="ui lb">
    <header class="topbar">
      <div class="brand">${LOGO}<b>Papertown</b></div>
      <nav class="tabs"><a class="on">世界</a><a>我的工厂</a><a>图书馆</a><a>人才市场</a><a>仓库</a></nav>
      <div class="search">搜索论文、仓库、员工…<kbd>⌘K</kbd></div>
      <span class="chip">负责人 2 位运行</span><span class="me">你</span>
    </header>
    <main>
      <section class="map-area map-bg">${renderMap({ labels: 'key', highlight: 'hatchery', note: '正在查重', anim: !still, vb: '-720 -140 1440 960' })}
        <div class="map-tools pnl"><button>＋</button><button>－</button><span class="sep"></span><button class="on">建筑</button><button class="on">物流</button><button>标签</button></div>
        <div class="map-hint pnl">点击建筑查看详情 · 拖动平移 · 滚轮缩放</div>
      </section>
      <aside class="bench">${benchHTML()}</aside>
    </main>
    ${DEMO}
  </div>`;
}

function layoutC(still) {
  return `<div class="ui lc${still ? '' : ' anim-ui'}">
    <header class="topbar">
      <div class="brand">${LOGO}<b>Papertown</b></div>
      <div class="crumbs">世界 / 学术工业区 / <b>造纸厂 #1「VLA × 结构化场景图规划」</b></div>
      <span class="chip" style="margin-left:auto">用量 $0.42 / $1.00</span><span class="me">你</span>
    </header>
    <div class="strip map-bg">${renderMap({ labels: 'key', highlight: 'mill', anim: !still, districts: false, vb: '-860 120 1330 300' })}
      <button class="btn back">← 回到世界地图</button>
    </div>
    ${pipelineHTML(STAGES)}
    <section class="detail">${millPanels()}</section>
    ${DEMO}
  </div>`;
}

function layoutD() {
  return `<div class="ui ld">${dailyBody({ map: renderMap({ labels: 'none', anim: false, districts: false, flows: false }) })}${DEMO}</div>`;
}

export const LAYOUTS = [
  { key: 'A', name: '全景小镇', en: 'World-first', render: layoutA,
    pitch: '整屏都是世界地图，统计、建筑详情和日报以浮层 HUD 叠在地图上。',
    fit: 'Demo 开场的全景、宣传截图',
    pros: ['世界感最强，第一眼最有冲击力', '地图占满屏幕，物流动画最显眼'],
    cons: ['RAG / MCP / Skills 的调用过程藏在二级界面，讲技术要多点一层', '浮层一多就会挡住地图'],
    score: [5, 2, 3, 3, '中高'] },
  { key: 'B', name: '地图 + 工作台', en: 'Map + Workbench', tag: '推荐', render: layoutB,
    pitch: '左边是世界地图，右边是固定的工作台：对话下单、流水线进度、调用轨迹。',
    fit: '主界面。现场演示时边操作边讲技术',
    pros: ['地图和"系统正在做什么"同屏，轨迹面板直接对应作业要求的技术点', '对话框直接接收 idea 和项目要求，入口清晰'],
    cons: ['地图只剩约 2/3 宽度，世界感比 A 弱一些', '右栏信息密度高，字号要控制好'],
    score: [4, 5, 4, 4, '中'] },
  { key: 'C', name: '流水线主视角', en: 'Production line', render: layoutC,
    pitch: '以一篇论文的 8 道工序为主角，世界地图缩成顶部的一条。',
    fit: '讲"从 idea 到 paper"的主线。工厂详情页',
    pros: ['主线一目了然，答辩时最好讲故事', '每道工序的员工、产出、进度都看得到'],
    cons: ['世界地图退成配角，world-online 的感觉弱', '只适合看单个项目，不适合当首页'],
    score: [2, 4, 5, 3, '中'] },
  { key: 'D', name: '日报首页', en: 'Daily paper', render: layoutD,
    pitch: '登录后先看到一份当天的世界日报：港口到货、我的工厂、人才市场和 DDL 预警。',
    fit: '每天回访的首页。真实服务的留存',
    pros: ['最像真实服务，每天打开都有新东西', '版面清楚，投影上文字最好读'],
    cons: ['地图只是插图，交互性最弱', '单独拿来 demo 不够"哇"'],
    score: [2, 3, 4, 5, '低'] },
];
