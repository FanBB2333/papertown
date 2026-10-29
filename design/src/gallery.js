// Design gallery: four page layouts × four art styles, an asset library, and a
// "my choice" bar that copies the selection as text.

import { THEMES, THEME_ORDER, themeCSS } from './theme.js';
import { BUILDINGS, DISTRICTS, ITEMS, WORKERS, PROPS, spriteSVG, propSVG, itemSVG, workerSVG } from './sprites.js';
import { PLACEMENTS, placementName } from './world.js';
import { LAYOUTS } from './layouts.js';

const LAYOUT_DIMS = ['世界感', '技术可讲性', '投影可读性', '日常使用', '实现工作量'];
const THEME_DIMS = ['契合 Papertown', '投影可读性', '辨识度', '美术工作量'];
const THEME_SCORE = { paper: [5, 4, 4, '中'], day: [3, 5, 2, '低'], blueprint: [3, 3, 4, '低'], night: [3, 2, 5, '中（发光特效）'] };
const stars = n => typeof n === 'number' ? `<span class="stars">${'★'.repeat(n)}<s>${'★'.repeat(5 - n)}</s></span>` : n;

// ---------- state ----------

const KEY = 'papertown-design-v1';
let saved = {};
try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { saved = {}; }
const S = {
  layout: saved.view?.layout || 'B',
  theme: saved.view?.theme || 'paper',
  assetTab: 'buildings',
  pick: { layout: saved.pick?.layout || null, theme: saved.pick?.theme || null, note: saved.pick?.note || '' },
};
const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ view: { layout: S.layout, theme: S.theme }, pick: S.pick })); } catch { /* storage unavailable */ } };
const L = k => LAYOUTS.find(l => l.key === k);
const hp = new URLSearchParams(location.hash.slice(1));
if (L(hp.get('layout'))) S.layout = hp.get('layout');
if (THEMES[hp.get('theme')]) S.theme = hp.get('theme');
const SOLO = hp.has('solo');

// ---------- page ----------

const style = document.createElement('style');
style.textContent = THEME_ORDER.map(k => themeCSS(THEMES[k])).join('\n');
document.head.appendChild(style);

const app = document.getElementById('app');
function initGallery() {
app.innerHTML = `
<div class="g-wrap">
  <header class="g-head">
    <div class="g-title"><h1>Papertown 页面设计方案</h1><span>COMP6708 Mini Demo · Group 20 · 设计探索 v0.1</span></div>
    <p class="g-lead">布局决定信息怎么摆，美术风格决定世界长什么样，两者可以自由组合。点卡片切换预览，满意了点「选定」，最后在页面底部复制结果发给 Claude。地图上的建筑可以悬停查看说明。</p>
    <a class="g-proto" href="prototype.html">已选定：A 全景小镇 + 纸艺 · 打开可交互原型 →</a>
  </header>

  <section class="g-sec"><h2>① 布局方案</h2><div class="g-cards" id="layout-cards"></div></section>
  <section class="g-sec"><h2>② 美术风格</h2><div class="g-cards" id="theme-cards"></div></section>

  <section class="g-sec">
    <div class="g-row"><h2>预览：<span id="pv-title"></span></h2><button class="g-btn ghost" data-act="full">全屏预览</button></div>
    <div class="g-frame" id="frame">
      <div class="g-chrome"><i></i><i></i><i></i><span>papertown.online</span></div>
      <div class="g-fit" data-fit><div class="g-stage glow" id="stage"></div></div>
      <div class="g-tip" id="tip" hidden></div>
    </div>
    <div class="g-detail" id="detail"></div>
  </section>

  <section class="g-sec"><h2>③ 方案对比</h2><div class="g-compare" id="compare"></div></section>

  <section class="g-sec">
    <div class="g-row"><h2>④ 素材库</h2><div class="g-tabs" id="asset-tabs"></div></div>
    <p class="g-note">全部素材由代码生成（<code>design/src/sprites.js</code>），按当前预览的风格显示；纸艺配色版已导出到 <code>assets/sprites/</code>，<code>assets/manifest.json</code> 记录每种建筑 type 对应的文件。</p>
    <div class="g-assets" id="assets"></div>
  </section>
</div>

<div class="g-bar"><div class="g-bar-in">
  <b>我的选择</b>
  <span class="g-pick" id="pick-layout"></span>
  <span class="g-pick" id="pick-theme"></span>
  <input id="note" placeholder="备注：比如想把 A 当开场、B 当主界面，或者想换某种配色…">
  <button class="g-btn" data-act="copy">复制结果</button>
  <button class="g-btn ghost" data-act="clear">清除</button>
  <span class="g-toast" id="toast"></span>
</div></div>

<div class="g-full" id="full" hidden>
  <button class="g-close" data-act="close">关闭 Esc</button>
  <div class="g-fs glow" id="fs"></div>
</div>`;
  wire();
  renderLayoutCards(); renderThemeCards(); renderPreview(); renderCompare(); renderAssets(); renderBar();
  requestAnimationFrame(fitAll);
}

const $ = id => document.getElementById(id);

function renderLayoutCards() {
  $('layout-cards').innerHTML = LAYOUTS.map(l => `
    <div class="g-card${S.layout === l.key ? ' on' : ''}" role="button" tabindex="0" data-layout="${l.key}">
      ${S.pick.layout === l.key ? '<span class="picked">已选定</span>' : ''}
      <div class="g-thumb"><div class="g-fit" data-fit><div class="g-stage still theme-${S.theme}">${l.render(true)}</div></div></div>
      <h3>${l.key} · ${l.name}${l.tag ? `<span class="tag">${l.tag}</span>` : ''}</h3>
      <p>${l.pitch}</p>
    </div>`).join('');
}

function renderThemeCards() {
  $('theme-cards').innerHTML = THEME_ORDER.map(k => {
    const t = THEMES[k];
    const sw = [t.ui.bg, t.ui.panel, t.ui.brand, t.ui.ink, t.mats.grass[1], t.mats.water[1]];
    return `
    <div class="g-card${S.theme === k ? ' on' : ''}" role="button" tabindex="0" data-theme="${k}">
      ${S.pick.theme === k ? '<span class="picked">已选定</span>' : ''}
      <div class="g-tsample theme-${k} map-bg">${spriteSVG('hatchery').html}${spriteSVG('mill').html}${spriteSVG('depot', { label: 'repo' }).html}</div>
      <div class="g-sw">${sw.map(c => `<i style="background:${c}"></i>`).join('')}</div>
      <h3>${t.name}<small>${t.en}</small>${t.tag ? `<span class="tag">${t.tag}</span>` : ''}</h3>
      <p>${t.pitch}</p>
    </div>`;
  }).join('');
}

function renderPreview() {
  const l = L(S.layout), t = THEMES[S.theme];
  $('pv-title').textContent = `布局 ${l.key} ${l.name} × ${t.name}风格`;
  const stage = $('stage');
  stage.className = `g-stage glow theme-${S.theme}`;
  stage.innerHTML = l.render(false);
  const pickedL = S.pick.layout === l.key, pickedT = S.pick.theme === S.theme;
  $('detail').innerHTML = `
    <div class="g-box">
      <h3>布局 ${l.key} · ${l.name} <small>${l.en}</small></h3>
      <p>${l.pitch}</p>
      <p class="g-fitfor"><b>适合：</b>${l.fit}</p>
      <div class="g-pc"><ul class="pros">${l.pros.map(x => `<li>${x}</li>`).join('')}</ul><ul class="cons">${l.cons.map(x => `<li>${x}</li>`).join('')}</ul></div>
      <button class="g-btn${pickedL ? ' ghost' : ''}" data-act="pick-layout">${pickedL ? '✓ 已选定这个布局' : '选定这个布局'}</button>
      <a class="g-link" href="#layout=${l.key}&theme=${S.theme}&solo" target="_blank">单独打开这个组合（1280×800，适合截图放进 slides）↗</a>
    </div>
    <div class="g-box">
      <h3>风格 · ${t.name} <small>${t.en}</small></h3>
      <p>${t.pitch}</p>
      <p class="g-fitfor"><b>关键词：</b>${t.keywords.join(' · ')}</p>
      <div class="g-pc"><ul class="pros">${t.pros.map(x => `<li>${x}</li>`).join('')}</ul><ul class="cons">${t.cons.map(x => `<li>${x}</li>`).join('')}</ul></div>
      <button class="g-btn${pickedT ? ' ghost' : ''}" data-act="pick-theme">${pickedT ? '✓ 已选定这个风格' : '选定这个风格'}</button>
    </div>`;
  fitAll();
}

function renderCompare() {
  $('compare').innerHTML = `
    <table class="g-table"><thead><tr><th>布局</th>${LAYOUT_DIMS.map(d => `<th>${d}</th>`).join('')}<th>适合</th></tr></thead><tbody>
    ${LAYOUTS.map(l => `<tr><td><b>${l.key} ${l.name}</b></td>${l.score.map(s => `<td>${stars(s)}</td>`).join('')}<td>${l.fit}</td></tr>`).join('')}
    </tbody></table>
    <table class="g-table"><thead><tr><th>风格</th>${THEME_DIMS.map(d => `<th>${d}</th>`).join('')}<th>一句话</th></tr></thead><tbody>
    ${THEME_ORDER.map(k => `<tr><td><b>${THEMES[k].name}</b></td>${THEME_SCORE[k].map(s => `<td>${stars(s)}</td>`).join('')}<td>${THEMES[k].keywords.join(' · ')}</td></tr>`).join('')}
    </tbody></table>
    <p class="g-note">我的建议：<b>B 地图 + 工作台</b> 做主界面，<b>纸艺</b>做画风；A 的全景可以作为 demo 开场的 5 秒镜头，D 留到以后做登录首页。</p>`;
}

const ASSET_TABS = { buildings: '建筑', items: '物件', workers: '员工', props: '地形与道具' };

function renderAssets() {
  $('asset-tabs').innerHTML = Object.entries(ASSET_TABS).map(([k, v]) => `<button class="${S.assetTab === k ? 'on' : ''}" data-atab="${k}">${v}</button>`).join('');
  const card = (art, title, code, sub, rep, file, extra = '') =>
    `<div class="acard"><div class="art">${art}</div><b>${title}${extra}</b><code>${code}</code>${sub ? `<span class="dist">${sub}</span>` : ''}<p>${rep}</p><small>${file}</small></div>`;
  let html = '';
  if (S.assetTab === 'buildings') {
    for (const [dk, d] of Object.entries(DISTRICTS)) {
      const list = Object.entries(BUILDINGS).filter(([, b]) => b.district === dk);
      html += `<h4 class="a-h"><i style="background:${d.color}"></i>${d.name}<small>${d.en} · ${d.dir}</small></h4><div class="g-agrid">` +
        list.map(([k, b]) => card(spriteSVG(k).html, b.name, k, `${b.w}×${b.d} 格 · ${b.tech}`, b.rep, `assets/sprites/buildings/${k}.svg`, b.later ? '<span class="later">以后再做</span>' : '')).join('') + '</div>';
    }
  } else if (S.assetTab === 'items') {
    html = '<div class="g-agrid">' + Object.entries(ITEMS).map(([k, it]) => card(itemSVG(k), it.name, k, '', it.rep, `assets/sprites/items/${k}.svg`)).join('') + '</div>';
  } else if (S.assetTab === 'workers') {
    html = '<div class="g-agrid">' + Object.entries(WORKERS).map(([k, w]) => card(workerSVG(k), w.name, k, '', w.rep, `assets/sprites/workers/${k}.svg`)).join('') + '</div>';
  } else {
    html = '<div class="g-agrid">' + Object.entries(PROPS).map(([k, p]) => card(propSVG(k).html, p.name, k, '', k.startsWith('tile') ? '地面瓦片，1×1 格' : '装饰道具', `assets/sprites/props/${k}.svg`)).join('') + '</div>';
  }
  const a = $('assets');
  a.className = `g-assets theme-${S.theme}`;
  a.innerHTML = html;
}

function renderBar() {
  const l = L(S.pick.layout), t = THEMES[S.pick.theme];
  $('pick-layout').innerHTML = l ? `布局 <b>${l.key} ${l.name}</b>` : '布局 <em>未选</em>';
  $('pick-theme').innerHTML = t ? `风格 <b>${t.name}</b>` : '风格 <em>未选</em>';
  $('pick-layout').classList.toggle('empty', !l);
  $('pick-theme').classList.toggle('empty', !t);
  if (document.activeElement !== $('note')) $('note').value = S.pick.note;
}

function fitAll() {
  document.querySelectorAll('[data-fit]').forEach(el => {
    const s = el.clientWidth / 1280;
    el.style.height = `${800 * s}px`;
    el.firstElementChild.style.transform = `scale(${s})`;
  });
  const fs = $('fs');
  if (!$('full').hidden) fs.style.transform = `scale(${Math.min(innerWidth / 1280, innerHeight / 800) * 0.94})`;
}

function resultText() {
  const l = L(S.pick.layout), t = THEMES[S.pick.theme];
  return `Papertown 设计方案选择\n- 布局：${l ? `${l.key} ${l.name}（${l.en}）` : '未选'}\n- 风格：${t ? `${t.name}（${t.en}）` : '未选'}\n- 备注：${S.pick.note || '无'}`;
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back below */ }
  const ta = document.createElement('textarea');
  ta.value = text; document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 2200);
}

function openFull() {
  const fs = $('fs');
  fs.className = `g-fs glow theme-${S.theme}`;
  fs.innerHTML = L(S.layout).render(false);
  $('full').hidden = false;
  fitAll();
}

// ---------- events ----------

function wire() {

document.addEventListener('click', async e => {
  const c = e.target.closest('[data-layout],[data-theme],[data-act],[data-atab]');
  if (!c) return;
  if (c.dataset.layout) { S.layout = c.dataset.layout; save(); renderLayoutCards(); renderPreview(); }
  else if (c.dataset.theme) { S.theme = c.dataset.theme; save(); renderLayoutCards(); renderThemeCards(); renderPreview(); renderAssets(); }
  else if (c.dataset.atab) { S.assetTab = c.dataset.atab; renderAssets(); }
  else {
    const act = c.dataset.act;
    if (act === 'pick-layout') { S.pick.layout = S.layout; save(); renderLayoutCards(); renderPreview(); renderBar(); toast(`已选定布局 ${S.layout}`); }
    if (act === 'pick-theme') { S.pick.theme = S.theme; save(); renderThemeCards(); renderPreview(); renderBar(); toast(`已选定${THEMES[S.theme].name}风格`); }
    if (act === 'copy') toast(await copyText(resultText()) ? '已复制，粘贴给 Claude 即可' : '复制失败，请手动选择文字');
    if (act === 'clear') { S.pick = { layout: null, theme: null, note: '' }; save(); renderLayoutCards(); renderThemeCards(); renderPreview(); renderBar(); }
    if (act === 'full') openFull();
    if (act === 'close') $('full').hidden = true;
  }
  fitAll();
});

$('note').addEventListener('input', e => { S.pick.note = e.target.value; save(); });
addEventListener('keydown', e => { if (e.key === 'Escape') $('full').hidden = true; });
addEventListener('resize', fitAll);

const tip = $('tip');
$('frame').addEventListener('mousemove', e => {
  const g = e.target.closest('[data-b]');
  if (!g) { tip.hidden = true; return; }
  const pl = PLACEMENTS.find(p => p.id === g.dataset.id), b = BUILDINGS[g.dataset.b];
  tip.innerHTML = `<b>${placementName(pl)}</b><span>${DISTRICTS[b.district].name}</span><p>${b.rep}</p><em>${b.tech}</em>`;
  const r = $('frame').getBoundingClientRect();
  const x = Math.min(e.clientX - r.left + 14, r.width - 280);
  tip.style.left = `${x}px`; tip.style.top = `${e.clientY - r.top + 14}px`; tip.hidden = false;
});
$('frame').addEventListener('mouseleave', () => { tip.hidden = true; });

}

// ---------- start ----------

if (SOLO) {
  document.body.className = 'solo';
  app.innerHTML = `<div class="g-solo glow theme-${S.theme}">${L(S.layout).render(false)}</div>`;
} else {
  initGallery();
}
