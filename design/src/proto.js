// Interactive prototype of the chosen design (layout A, paper-craft): the world map as home,
// the B workbench as a chat drawer, C-style building details and a D-style status view.
//
//   prototype.html#theme=paper&view=status&open=mill&chat

import { THEMES, THEME_ORDER, themeCSS } from './theme.js';
import { BUILDINGS, DISTRICTS, ITEMS, WORKERS, spriteSVG, itemSVG } from './sprites.js';
import { renderMap, PLACEMENTS, placementName } from './world.js';
import { LOGO, ava, STAGES, TRACE, LEGEND, TICKER, traceRow, benchHTML, pipelineHTML, millPanels, dailyBody } from './layouts.js';
import { SAMPLE_REPOS } from './sample.js';

const st = (name, out, s, team = []) => ({ name, out, st: s, team });
const repoGoods = b => SAMPLE_REPOS.filter(r => r.to.includes(b)).map(r => [r.id, 'crate']);
const REPO_B = SAMPLE_REPOS[1];

// What happens inside each building: stations are its production line (st: done / run / todo);
// from / to are [placement id, item] pairs for incoming and outgoing goods.
const BUILDING_FLOWS = {
  dock_arxiv: { job: '今日到货 48 篇',
    stations: [st('船靠岸', 'notes', 'done'), st('卸货', 'tex', 'done'), st('送海关', 'notes', 'run', ['scout']), st('入馆', 'notes', 'todo')],
    note: '拉取 arXiv 当天的新论文列表，下载元数据和 TeX 源码。',
    skills: [], mcp: ['arxiv.list_new', 'arxiv.get_source'],
    from: [], to: [['customs', 'notes'], ['press', 'tex']],
    real: 'arXiv API，每天定时拉取；TeX 源码包同时供印刷厂参考别人的写法（arXivTeXplorer）。' },
  dock_github: { job: '3 个仓库有更新',
    stations: [st('同步', 'crate', 'done'), st('拆包分拣', 'crate', 'run', ['keeper']), st('发往仓库', 'crate', 'todo')],
    note: '拉取关注仓库的 star、issue 和 PR，按仓库分拣。',
    skills: [], mcp: ['github.list_events', 'github.get_repo'],
    from: [], to: SAMPLE_REPOS.map(r => [r.id, 'crate']),
    real: 'GitHub MCP server。' },
  customs: { job: '48 篇入境检查',
    stations: [st('去重', 'notes', 'done'), st('过滤', 'notes', 'done'), st('打标签', 'notes', 'run', ['scout']), st('放行', 'notes', 'todo')],
    note: '按 arXiv id 和标题去重，和关注领域无关的退回，再打上领域、方法、数据集标签。',
    skills: ['paper-triage'], mcp: [],
    from: [['dock_arxiv', 'notes']], to: [['library', 'notes'], ['newspaper', 'notes']],
    real: 'paper-triage skill，分类规则写在 SKILL.md 里。' },
  lighthouse: { job: '盯着 5 位作者、3 个关键词',
    stations: [st('订阅', 'notes', 'done'), st('定时扫描', 'notes', 'run'), st('发信号', 'notes', 'todo')],
    note: '每天 8:00 扫一遍关注的作者和关键词，有撞车风险就通知报社。',
    skills: [], mcp: ['arxiv.search', 'scheduler'],
    from: [], to: [['newspaper', 'notes']],
    real: '定时任务 + arXiv 检索。' },
  hatchery: { job: 'idea #12「VLA × 结构化场景图」',
    stations: [st('收蛋', 'egg', 'done'), st('检索相似工作', 'notes', 'done', ['hatcher']), st('写撞车报告', 'notes', 'done', ['hatcher']), st('等你决定', 'egg', 'run'), st('建厂', 'draft', 'todo')],
    note: '撞车报告已经发到对话框，点「孵化并建厂」就会进入造纸厂。',
    skills: ['novelty-check'], mcp: ['arxiv.search', 'library.search'],
    from: [['cityhall', 'egg'], ['library', 'notes'], ['genealogy', 'notes']], to: [['mill', 'notes']],
    real: 'RAG（图书馆的向量库）+ novelty-check skill。' },
  farm: { job: '造纸厂 #1 的 2 块田',
    stations: [st('领种子', 'crate', 'done', ['experimenter']), st('备料', 'dataset', 'done'), st('接电', 'energy', 'run', ['experimenter']), st('生长', 'table', 'todo'), st('收割', 'table', 'todo')],
    note: '代码和数据都到了，正在算力电厂排队，第 2 位。',
    skills: ['experiment-runner'], mcp: ['nvidb.submit', 'nvidb.status'],
    from: [...repoGoods('farm'), ['coldstore', 'dataset'], ['power', 'energy']], to: [['mill', 'table'], ['press', 'table']],
    real: 'nvidb 任务队列；没有 GPU 时由模拟电厂（FakeGPU）兜底。' },
  press: { job: '造纸厂 #2 的稿子 v0.6',
    stations: [st('排铅字', 'tex', 'done', ['writer']), st('校样', 'tex', 'run', ['writer']), st('开机印刷', 'pdf', 'todo'), st('送质检', 'pdf', 'todo')],
    note: '在检查引用和图表编号，然后编译 PDF。',
    skills: ['latex-writing'], mcp: ['downleaf.compile'],
    from: [['mill', 'draft'], ['farm', 'table'], ...repoGoods('press')], to: [['qa', 'pdf']],
    real: 'downleaf 本地编译 TeX；arXivTeXplorer 用来参考别人论文的 TeX 写法。' },
  qa: { job: '造纸厂 #2 · 稀疏注意力加速',
    stations: [st('格式检查', 'pdf', 'done'), st('审稿人打分', 'pdf', 'done', ['reviewer', 'reviewer']), st('汇总意见', 'pdf', 'run', ['reviewer']), st('退回或放行', 'pdf', 'todo')],
    note: '3 个审稿 persona 已打分，发现 1 处匿名问题。',
    skills: ['paper-review', 'anonymity-check'], mcp: [],
    from: [['press', 'pdf']], to: [['dock_arxiv', 'pdf'], ['press', 'tex']],
    real: '多个审稿 persona 的 Skills；检查规则来自会议的投稿要求。' },
  depot: { job: '仓库',
    stations: [st('入库', 'crate', 'done'), st('上架', 'crate', 'done'), st('盘点', 'crate', 'run', ['keeper']), st('出货', 'crate', 'todo')],
    note: 'commit 入库，按目录上架建索引；盘点就是看 issue 和 CI。',
    skills: ['repo-maintain'], mcp: ['github.get_repo'],
    from: [['dock_github', 'crate']], to: [['workshop', 'crate']],
    real: '一座仓库就是一个 GitHub repo，README 和代码进 RAG，可以直接问"这个函数在哪"。' },
  workshop: { job: `修 ${REPO_B.label} 的 2 个 issue`,
    stations: [st('接单', 'crate', 'done'), st('修理', 'crate', 'run', ['keeper']), st('跑 CI', 'crate', 'todo'), st('送回仓库', 'crate', 'todo')],
    note: '改动会先给你确认，不会自己 push。',
    skills: ['bug-fix', 'doc-writer'], mcp: ['github.create_pr'],
    from: [[REPO_B.id, 'crate']], to: [[REPO_B.id, 'crate']],
    real: '维护 agent：回 issue、改文档、开 PR。' },
  logistics: { job: '6 条依赖线路',
    stations: [st('登记线路', 'crate', 'done'), st('调度', 'crate', 'run'), st('签收', 'crate', 'todo')],
    note: `造纸厂 #1 要的 baseline 代码从 ${REPO_B.label} 仓发货。`,
    skills: [], mcp: [],
    from: SAMPLE_REPOS.map(r => [r.id, 'crate']), to: [['farm', 'crate']],
    real: '依赖图谱：repo 之间、repo 和论文之间的引用关系。' },
  library: { job: '馆藏 1.2 万篇',
    stations: [st('收书', 'notes', 'done'), st('切段', 'notes', 'done'), st('编目', 'notes', 'run'), st('借阅', 'notes', 'todo')],
    note: '今天放行的 6 篇正在向量化。',
    skills: [], mcp: ['library.search'],
    from: [['customs', 'notes']], to: [['hatchery', 'notes'], ['mill', 'notes'], ['newspaper', 'notes']],
    real: 'RAG 主库：论文分块 + 向量检索，作业要求的 RAG 落在这里。' },
  genealogy: { job: 'idea #12 的 23 个祖先节点',
    stations: [st('抽引用', 'notes', 'done'), st('连边', 'notes', 'done'), st('查族谱', 'notes', 'run', ['scout']), st('出报告', 'notes', 'todo')],
    note: '从你的 idea 往上找 2 代：谁引用谁、方法从哪里继承。',
    skills: [], mcp: ['genealogy.expand'],
    from: [['library', 'notes']], to: [['hatchery', 'notes']],
    real: '引用知识图谱 + GraphRAG。' },
  market: { job: '造纸厂 #1 编了 3 人小队',
    stations: [st('列岗位', 'notes', 'done'), st('按预算编队', 'notes', 'done', ['scout']), st('上岗', 'notes', 'done', ['designer', 'writer']), st('结算 ROI', 'notes', 'todo')],
    note: '方法设计师 D-03 升到 Lv.3；审稿人 V-02 漏检 2 次，降为 Lv.1。',
    skills: ['team-builder'], mcp: [],
    from: [['cityhall', 'egg']], to: [['mill', 'notes']],
    real: 'Capitalist 的员工系统：每个 agent 带一组 Skills，按产出和花费评级。' },
  cityhall: { job: '你的个人中心',
    stations: [st('写下 idea', 'egg', 'done'), st('设预算', 'egg', 'done'), st('送孵化场', 'egg', 'done'), st('等报告', 'notes', 'run')],
    note: '对话框里写下的 idea 都从这里出发。',
    skills: [], mcp: [],
    from: [], to: [['hatchery', 'egg'], ['market', 'egg']],
    real: '项目总览、预算和待办。' },
  bank: { job: '本周 $3.10 / $10',
    stations: [st('记账', 'notes', 'done'), st('预算提醒', 'notes', 'run'), st('结算', 'notes', 'todo')],
    note: '每次 LLM / MCP 调用记一笔；超过预算 80% 会提醒。',
    skills: [], mcp: [],
    from: [['mill', 'notes'], ['farm', 'energy']], to: [],
    real: '计费日志，HUD 上的余额就是这里的数字。' },
  newspaper: { job: '第 12 期日报',
    stations: [st('收稿', 'notes', 'done'), st('写摘要', 'notes', 'done'), st('排版', 'notes', 'run'), st('送报', 'notes', 'todo')],
    note: '「运行状态」页就是这份报纸。',
    skills: ['daily-digest'], mcp: ['library.search'],
    from: [['customs', 'notes'], ['farm', 'table'], ['dock_github', 'crate']], to: [],
    real: 'RAG + 摘要 skill。' },
  power: { job: 'GPU 负荷 63%',
    stations: [st('接单', 'energy', 'done'), st('分卡', 'energy', 'run'), st('发电', 'energy', 'todo'), st('抄表', 'energy', 'todo')],
    note: '按显存挑卡；停电就是 OOM。',
    skills: [], mcp: ['nvidb.submit', 'nvidb.status'],
    from: [], to: [['farm', 'energy']],
    real: 'nvidb 管理的自有 GPU 服务器。' },
  power_sim: { job: '待机',
    stations: [st('待机', 'energy', 'run'), st('接管', 'energy', 'todo'), st('模拟输出', 'energy', 'todo')],
    note: '真 GPU 不可用时接管，模拟出训练过程。',
    skills: [], mcp: [],
    from: [], to: [['farm', 'energy']],
    real: 'FakeGPU，保证现场 demo 没有显卡也能跑完。' },
  coldstore: { job: '14 个数据集',
    stations: [st('登记', 'dataset', 'done'), st('下载', 'dataset', 'done'), st('出库', 'dataset', 'run')],
    note: '记录每个数据集的大小、格式和存放位置。',
    skills: [], mcp: [],
    from: [], to: [['farm', 'dataset']],
    real: '数据集元数据库。' },
  weather: { job: '关注 3 个会议',
    stations: [st('抓 DDL', 'notes', 'done'), st('预警', 'notes', 'run'), st('推送', 'notes', 'todo')],
    note: '截稿前 14 天开始预警。',
    skills: [], mcp: ['calendar.list'],
    from: [], to: [['newspaper', 'notes']],
    real: '会议 DDL 和日程。' },
};

const place = id => PLACEMENTS.find(p => p.id === id) ||
  (SAMPLE_REPOS.some(r => r.id === id) ? PLACEMENTS.find(p => p.type === 'depot') : undefined);

const style = document.createElement('style');
style.textContent = THEME_ORDER.map(k => themeCSS(THEMES[k])).join('\n');
document.head.appendChild(style);

const hp = new URLSearchParams(location.hash.slice(1));
const theme = THEMES[hp.get('theme')] ? hp.get('theme') : 'paper';
const BASE = { x: -790, y: -150, w: 1580, h: 950 };
const MIN_W = 420, MAX_W = BASE.w * 1.5;

const RUNNING = [
  { id: 'mill', title: '造纸厂 #1 · VLA 场景图规划', step: '方法设计', pct: 60 },
  { id: 'qa', title: '造纸厂 #2 · 稀疏注意力加速', step: '质检', pct: 85 },
  { id: 'farm', title: '实验农场 · 造纸厂 #1', step: '排队等电', pct: 20 },
  { id: 'hatchery', title: '孵化场 · idea #12', step: '等你决定', pct: 90 },
];

const HUD = {
  world: [['世界时间', '第 12 天 · 09:41'], ['银行', '$4.20 <em>/ $10</em>'], ['流水线', '2 <em>条运行中</em>'], ['算力电厂', '63% <em>负荷</em>']],
  status: [['时间', '10 月 29 日 09:41'], ['本周预算', '$4.20 <em>/ $10</em>'], ['项目', '2 <em>个运行中</em>'], ['GPU', '63% <em>占用</em>']],
};

const app = document.getElementById('app');
document.body.className = 'proto-page';
app.innerHTML = `
<div class="proto la glow theme-${theme}" id="proto" data-mode="world">
  <section class="p-world map-bg w-only" id="world">${renderMap({ labels: 'key', highlight: 'mill', note: '方法设计中', anim: true, vb: `${BASE.x} ${BASE.y} ${BASE.w} ${BASE.h}` })}</section>

  <main class="p-status" id="status"><div class="ld p-paper">${dailyBody({ plain: true })}</div></main>

  <header class="hud pnl">
    <div class="brand">${LOGO}<b>Papertown</b></div>
    <div class="seg" role="tablist"><button data-view="world" class="on">世界</button><button data-view="status">运行状态</button></div>
    <div class="hud-stats" id="hud-stats"></div>
    <div class="hud-r">
      <button class="btn" data-act="chat">对话</button>
      <span class="bell" title="3 条通知">3</span><span class="me">你</span>
    </div>
  </header>

  <div class="lg-bar w-only"><button class="btn" data-act="legend">图例</button><span class="p-hint pnl">点建筑看流水线 · 拖动平移 · 滚轮缩放</span></div>
  <aside class="legend pnl w-only" id="legend" hidden>${LEGEND}</aside>

  <aside class="running pnl w-only">
    <h4>进行中</h4>
    ${RUNNING.map(r => `<div class="rn" data-open="${r.id}">${spriteSVG(place(r.id).type).html}<div><b>${r.title}</b><div class="rn-row">${r.step}<div class="bar"><i style="width:${r.pct}%"></i></div></div></div></div>`).join('')}
  </aside>

  <button class="newidea btn pri w-only" data-act="newidea">${itemSVG('egg')}放入一颗新 idea</button>
  <div class="ticker pnl w-only" data-view="status" title="打开运行状态"><b>世界日报</b><span>${TICKER}</span></div>
  <div class="minimap pnl w-only" id="minimap">
    ${renderMap({ objects: false, flows: false, districts: false, anim: false, labels: 'none' }).replace('</svg>', '<rect class="mm-rect" id="mm-rect"/></svg>')}
    <div class="mm-zoom"><button data-zoom="in" title="放大">＋</button><button data-zoom="out" title="缩小">－</button><button data-zoom="reset" title="复位">⟲</button></div>
  </div>

  <aside class="p-drawer pnl" id="drawer" data-show="chat">${benchHTML({ closable: true, extra: `
    <div class="bench-pane" data-pane="line"><div class="pane-pad">
      <h5>造纸厂 #1 · VLA 场景图规划</h5>
      <ol class="steps">${STAGES.map((s, i) => `<li class="${s.st}" data-open="${s.b}"><i>${i + 1}</i><b>${s.name}</b><span>${placementName(place(s.b))}</span></li>`).join('')}</ol>
    </div></div>
    <div class="bench-pane" data-pane="trace"><div class="pane-pad">
      <h5>最近的调用</h5>
      <div class="trace-rows" id="trace-all">${TRACE.map(traceRow).join('')}</div>
    </div></div>` })}</aside>

  <div class="p-modal" id="modal" hidden><div class="p-sheet pnl lc" id="sheet" role="dialog" aria-modal="true"></div></div>
  <div class="ptip pnl" id="tip" hidden></div>
  <span class="demo-tag">原型 · 示意数据</span>
</div>`;

const $ = id => document.getElementById(id);
const root = $('proto');

function setView(v) {
  root.dataset.mode = v;
  root.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  $('hud-stats').innerHTML = HUD[v].map(([k, val]) => `<div><i>${k}</i><b>${val}</b></div>`).join('');
  $('tip').hidden = true;
  if (v === 'world') requestAnimationFrame(applyVB);
}

function openDetail(key) {
  const pl = place(key);
  if (!pl) return;
  const b = BUILDINGS[pl.type], d = DISTRICTS[b.district];
  const head = (title, sub, chips) => `
    <header class="sh-head">
      <div class="sh-art">${spriteSVG(pl.type, { label: pl.label, accent: pl.accent }).html}</div>
      <div class="sh-t">
        <div class="crumbs">世界 / ${d.name} / <b>${placementName(pl)}</b></div>
        <h2>${title}</h2>
        <p>${sub}</p>
        <div class="sh-chips">${chips}</div>
      </div>
      <div class="sh-btns">
        <button class="btn" data-act="ask" data-ask="${pl.id}">问问这里的员工</button>
        <button class="sh-x" data-act="close" title="关闭 Esc">×</button>
      </div>
    </header>`;

  let html;
  if (pl.type === 'mill') {
    html = head('造纸厂 #1「VLA × 结构化场景图规划」', '一篇论文一座厂。下面是这篇论文从灵感到出港的 8 道工序，点工序可以跳到它所在的建筑。',
      `<span class="chip">${b.tech}</span><span class="chip pri">方法设计 60%</span><span class="chip">预算 $0.42 / $1.00</span>`) +
      pipelineHTML(STAGES) + `<section class="detail">${millPanels()}</section>`;
  } else {
    const f = BUILDING_FLOWS[pl.type];
    const cur = f.stations.find(s => s.st === 'run') || f.stations[f.stations.length - 1];
    const team = [...new Set(f.stations.flatMap(s => s.team))];
    const goods = (list, dir) => list.length ? list.map(([id, it]) => {
      const p2 = place(id);
      return `<div class="io" data-open="${id}">${itemSVG(it)}<div><b>${dir} ${placementName(p2)}</b><small>${ITEMS[it].name}</small></div><span class="go">→</span></div>`;
    }).join('') : '<p class="muted">—</p>';
    const chips = list => list.length ? list.map(x => `<span class="chip">${x}</span>`).join('') : '<span class="muted">—</span>';
    html = head(`${placementName(pl)} · ${f.job}`, b.rep,
      `<span class="chip">${b.tech}</span>${b.later ? '<span class="chip warn">以后再做</span>' : ''}<span class="chip pri">${cur.name}</span>`) +
      pipelineHTML(f.stations) + `
      <section class="detail">
        <div class="pnl">
          <h4>当前工位 · ${cur.name}</h4>
          <dl class="kv">
            <dt>员工</dt><dd>${team.length ? team.map(r => `${ava(r)} ${WORKERS[r].name}`).join(' ') : '<span class="muted">自动运行，没有 agent 员工</span>'}</dd>
            <dt>Skills</dt><dd>${chips(f.skills)}</dd>
            <dt>MCP</dt><dd>${chips(f.mcp)}</dd>
            <dt>说明</dt><dd>${f.note}</dd>
          </dl>
        </div>
        <div class="pnl">
          <h4>进货 / 出货</h4>
          <div class="io-list">${goods(f.from, '来自')}${goods(f.to, '送往')}</div>
        </div>
        <div class="pnl">
          <h4>现实里对应什么</h4>
          <p class="real">${f.real}</p>
          <div class="btns"><button class="btn pri" data-act="ask" data-ask="${pl.id}">问问这里的员工</button><button class="btn" data-view="status">看运行状态</button></div>
        </div>
      </section>`;
  }
  const sheet = $('sheet');
  sheet.innerHTML = html;
  sheet.scrollTop = 0;
  $('modal').hidden = false;
  $('tip').hidden = true;
}

const closeDetail = () => { $('modal').hidden = true; };

const chatEl = root.querySelector('.chat'), input = root.querySelector('.composer input');

function setTab(t) {
  $('drawer').dataset.show = t;
  root.querySelectorAll('.bench-tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === t));
}

function openChat({ focus = false, placeholder } = {}) {
  root.classList.add('chat-open');
  setTab('chat');
  if (placeholder) input.placeholder = placeholder;
  if (focus) setTimeout(() => input.focus(), 280);
}
const closeChat = () => root.classList.remove('chat-open');

function addMsg(html, cls) {
  const m = document.createElement('div');
  m.className = `msg ${cls}`;
  m.innerHTML = html;
  chatEl.appendChild(m);
  chatEl.scrollTop = chatEl.scrollHeight;
  return m;
}

const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function send() {
  const v = input.value.trim();
  if (!v) return;
  input.value = '';
  addMsg(esc(v), 'mine');
  const typing = addMsg('<span class="typing"><i></i><i></i><i></i></span>', 'bot');
  setTimeout(() => {
    typing.innerHTML = `<div class="who">${ava('hatcher', 2)}<b>孵化员 H-01</b></div>
      <p>收到。我先去图书馆和 arXiv 码头查有没有撞车的工作，报告出来会贴在这里。</p>
      <div class="cost">原型里这是一条预设回复</div>`;
    chatEl.scrollTop = chatEl.scrollHeight;
    const rows = [['SKILL', 'hatchery/novelty-check', '加载 SKILL.md'], ['MCP', `arxiv.search("${v.slice(0, 24)}")`, '检索中…']];
    $('trace-all').insertAdjacentHTML('afterbegin', rows.map(r => traceRow(r.map(esc))).join(''));
  }, 700);
}

function ask(id) {
  const pl = place(id), f = BUILDING_FLOWS[pl.type];
  const role = pl.type === 'mill' ? 'designer' : f.stations.flatMap(s => s.team)[0] || 'scout';
  const cur = f && (f.stations.find(s => s.st === 'run') || f.stations[0]);
  openChat({ focus: true, placeholder: `问问${placementName(pl)}…` });
  addMsg(`<div class="who">${ava(role)}<b>${WORKERS[role].name} · ${placementName(pl)}</b></div>
    <p>${pl.type === 'mill' ? '方法草案写到 v0.3 了，还差 baseline 的对比设计。想先看哪部分？' : `这里现在是「${f.job}」，进行到「${cur.name}」。想问什么？`}</p>`, 'bot');
}

const mapSvg = $('world').querySelector('svg');
const mmSvg = $('minimap').querySelector('svg');
let vb = { ...BASE };

function aspect() { const r = mapSvg.getBoundingClientRect(); return r.height / r.width || BASE.h / BASE.w; }

function applyVB() {
  const cx = vb.x + vb.w / 2, cy = vb.y + vb.h / 2;
  vb.w = Math.min(MAX_W, Math.max(MIN_W, vb.w));
  vb.h = vb.w * aspect();
  const ncx = Math.min(BASE.x + BASE.w, Math.max(BASE.x, cx)), ncy = Math.min(BASE.y + BASE.h, Math.max(BASE.y, cy));
  vb.x = ncx - vb.w / 2; vb.y = ncy - vb.h / 2;
  mapSvg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  const r = $('mm-rect');
  r.setAttribute('x', vb.x); r.setAttribute('y', vb.y); r.setAttribute('width', vb.w); r.setAttribute('height', vb.h);
}

function fitBoard() {
  const a = aspect();
  vb.w = Math.max(BASE.w, BASE.h / a) * 0.98;
  vb.h = vb.w * a;
  vb.x = BASE.x + BASE.w / 2 - vb.w / 2;
  vb.y = BASE.y + BASE.h / 2 - vb.h / 2 + 30;
  applyVB();
}

function svgPoint(svg, cx, cy) {
  const p = svg.createSVGPoint();
  p.x = cx; p.y = cy;
  return p.matrixTransform(svg.getScreenCTM().inverse());
}

function zoomAt(k, cx, cy) {
  const before = svgPoint(mapSvg, cx, cy);
  const nw = Math.min(MAX_W, Math.max(MIN_W, vb.w * k));
  const s = nw / vb.w;
  vb.x = before.x - (before.x - vb.x) * s;
  vb.y = before.y - (before.y - vb.y) * s;
  vb.w = nw;
  applyVB();
}

function zoomCenter(k) {
  const r = mapSvg.getBoundingClientRect();
  zoomAt(k, r.left + r.width / 2, r.top + r.height / 2);
}

let drag = null, dragged = false;
mapSvg.addEventListener('wheel', e => { e.preventDefault(); zoomAt(Math.exp(e.deltaY * 0.0015), e.clientX, e.clientY); }, { passive: false });
mapSvg.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  drag = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y, id: e.pointerId };
  dragged = false;
});
addEventListener('pointermove', e => {
  if (!drag) {
    hover(e);
    return;
  }
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!dragged && Math.hypot(dx, dy) < 4) return;
  if (!dragged) { dragged = true; mapSvg.setPointerCapture(drag.id); root.classList.add('panning'); $('tip').hidden = true; }
  const s = vb.w / mapSvg.getBoundingClientRect().width;
  vb.x = drag.vx - dx * s; vb.y = drag.vy - dy * s;
  applyVB();
});
addEventListener('pointerup', () => { drag = null; root.classList.remove('panning'); });

mmSvg.addEventListener('click', e => {
  const p = svgPoint(mmSvg, e.clientX, e.clientY);
  vb.x = p.x - vb.w / 2; vb.y = p.y - vb.h / 2;
  applyVB();
});

function hover(e) {
  const tip = $('tip');
  const g = root.dataset.mode === 'world' && $('modal').hidden && e.target.closest('.p-world [data-b]');
  if (!g) { tip.hidden = true; return; }
  const pl = place(g.dataset.id), b = BUILDINGS[pl.type];
  tip.innerHTML = `<b>${placementName(pl)}</b><span>${DISTRICTS[b.district].name}</span><p>${b.rep}</p><em>${b.tech} · 点击查看流水线</em>`;
  const x = Math.min(e.clientX + 16, innerWidth - 300), y = Math.min(e.clientY + 16, innerHeight - 140);
  tip.style.left = `${x}px`; tip.style.top = `${y}px`; tip.hidden = false;
}

root.addEventListener('click', e => {
  const t = e.target;
  const bld = t.closest('.p-world [data-b]');
  if (bld) { if (!dragged) openDetail(bld.dataset.id); return; }
  if (t === $('modal')) { closeDetail(); return; }
  const c = t.closest('[data-act],[data-open],[data-view],[data-zoom],[data-tab]');
  if (!c) return;
  if (c.dataset.zoom) {
    if (c.dataset.zoom === 'reset') fitBoard(); else zoomCenter(c.dataset.zoom === 'in' ? 0.7 : 1.4);
  } else if (c.dataset.tab) setTab(c.dataset.tab);
  else if (c.dataset.view) { closeDetail(); setView(c.dataset.view); }
  else if (c.dataset.open) openDetail(c.dataset.open);
  else {
    const act = c.dataset.act;
    if (act === 'chat') root.classList.contains('chat-open') ? closeChat() : openChat();
    if (act === 'newidea') openChat({ focus: true, placeholder: '写下你的 idea，孵化员会先帮你查重…' });
    if (act === 'drawer-close') closeChat();
    if (act === 'legend') $('legend').hidden = !$('legend').hidden;
    if (act === 'close') closeDetail();
    if (act === 'ask') ask(c.dataset.ask);
    if (act === 'send') send();
  }
});

root.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('.composer input')) send(); });
addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!$('modal').hidden) closeDetail();
  else if (root.classList.contains('chat-open')) closeChat();
});
addEventListener('resize', applyVB);

setView(hp.get('view') === 'status' ? 'status' : 'world');
fitBoard();
if (hp.has('chat')) openChat();
if (hp.get('open')) openDetail(hp.get('open'));
