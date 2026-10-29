// The Papertown map: placements on a 24×24 isometric grid, ground tiles, props,
// logistics flows and labels. renderMap() returns one <svg> string.

import { Pen, iso, BUILDINGS, PROPS, DISTRICTS } from './sprites.js';
import { SAMPLE_REPOS } from './sample.js';

export const N = 24;

// x, y are the back corner of the footprint in tile units
export const PLACEMENTS = [
  { id: 'lighthouse', type: 'lighthouse', x: 1, y: 1 },
  { id: 'dock_arxiv', type: 'dock_arxiv', x: 0, y: 4 },
  { id: 'dock_github', type: 'dock_github', x: 4, y: 0 },
  { id: 'customs', type: 'customs', x: 4, y: 4 },
  { id: 'hatchery', type: 'hatchery', x: 2, y: 9 },
  { id: 'mill', type: 'mill', x: 1, y: 17, name: '造纸厂 #1' },
  { id: 'farm', type: 'farm', x: 4, y: 17 },
  { id: 'press', type: 'press', x: 1, y: 20 },
  { id: 'qa', type: 'qa', x: 4, y: 21 },
  { id: 'library', type: 'library', x: 8, y: 8 },
  { id: 'genealogy', type: 'genealogy', x: 13, y: 8 },
  { id: 'cityhall', type: 'cityhall', x: 11, y: 11 },
  { id: 'bank', type: 'bank', x: 14, y: 11 },
  { id: 'market', type: 'market', x: 8, y: 13 },
  { id: 'newspaper', type: 'newspaper', x: 11, y: 14 },
  { id: 'logistics', type: 'logistics', x: 10, y: 2 },
  // one depot per repo, filled from the sample data
  ...SAMPLE_REPOS.map((r, i) => ({ id: r.id, type: 'depot', x: [17, 21, 17][i], y: [1, 1, 4][i], label: r.label, accent: r.accent, name: `${r.label} 仓` })),
  { id: 'workshop', type: 'workshop', x: 21, y: 4 },
  { id: 'coldstore', type: 'coldstore', x: 9, y: 18 },
  { id: 'power', type: 'power', x: 18, y: 18 },
  { id: 'weather', type: 'weather', x: 21, y: 17 },
  { id: 'power_sim', type: 'power_sim', x: 21, y: 21 },
];

const KEY_LABELS = new Set(['dock_arxiv', 'hatchery', 'mill', 'farm', 'press', 'qa', 'library', 'market', 'cityhall', SAMPLE_REPOS[0].id, 'power']);

const DISTRICT_LABELS = [
  ['port', 6.2, 1.2, 2.6], ['industry', 0.6, 14.2, 1.4], ['depot', 20.5, 0.2, 2.6],
  ['plaza', 12.2, 8.6, 2.2], ['infra', 16.6, 23.2, 1.0],
];

const FOOTPATH = new Set(['4,10', '5,10', '6,10']);
const LAMPS = [[15.3, 8.3], [15.3, 15.3], [8.3, 15.3], [7.0, 7.0], [16.0, 16.0]];
const BOATS = [[2.2, 1.0], [0.3, 2.4]];

const FLOWS = [
  { kind: 'paper', pts: [[1.5, 6.2], [1.5, 7.5], [9.5, 7.5]], dur: 9 },
  { kind: 'egg', pts: [[4.0, 10.5], [7.5, 10.5], [7.5, 16.5], [2.5, 16.5]], dur: 11 },
  { kind: 'code', pts: [[16.5, 2.5], [16.5, 16.5], [5.5, 16.5]], dur: 16 },
  { kind: 'energy', pts: [[19.5, 17.8], [19.5, 16.5], [5.0, 16.5]], dur: 12 },
  { kind: 'data', pts: [[10.0, 17.8], [10.0, 16.5], [6.0, 16.5]], dur: 7 },
];

export const FLOW_KINDS = {
  paper: '论文原料', egg: 'idea 蛋', code: '代码货箱', energy: '算力', data: '数据集',
};

function hash(x, y, s = 0) {
  let h = (x * 374761393 + y * 668265263 + s * 982451653) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function tileMat(x, y) {
  if (x === 1 && y === 1) return 'sand';
  if (x + y <= 6) return 'water';
  if (x === 7 || y === 7 || x === 16 || y === 16 || FOOTPATH.has(`${x},${y}`)) return 'road';
  if (x + y === 7) return 'sand';
  if (x >= 8 && x <= 15 && y >= 8 && y <= 15) return 'plaza';
  return hash(x, y) < 0.3 ? 'grass2' : 'grass';
}

const f1 = n => Math.round(n * 10) / 10;
const sp = (x, y, z = 0) => iso(x, y, z).map(f1).join(',');

function footprint(pl) {
  const b = BUILDINGS[pl.type];
  return { x: pl.x, y: pl.y, w: b.w, d: b.d };
}

function textWidth(s, size) {
  let w = 0;
  for (const ch of s) w += /[　-鿿＀-￯]/.test(ch) ? size : size * 0.58;
  return w;
}

function pill(x, y, text, cls, size = 12, style = '') {
  const w = textWidth(text, size) + 16, h = size + 9;
  return `<g class="${cls}"${style ? ` style="${style}"` : ''} transform="translate(${f1(x)},${f1(y)})"><rect x="${f1(-w / 2)}" y="${-h}" width="${f1(w)}" height="${h}" rx="${h / 2}"/>` +
    `<text x="0" y="${f1(-h / 2 + size * 0.36)}" font-size="${size}" text-anchor="middle">${text}</text></g>`;
}

export function placementName(pl) { return pl.name || BUILDINGS[pl.type].name; }

// placements: live placements from the server (default: the static design ones); a
// placement's `key` decides whether it is labelled, `status: 'busy'` marks it working,
// `core` puts a pad under it and dims everything that is not core.
// notes: placement id -> text appended to its label.
// decor: 'full' trees, lamps and boats; 'light' a few trees kept clear of core buildings; 'none'.
export function renderMap(o = {}) {
  const opt = { labels: 'key', anim: true, objects: true, flows: true, districts: true, decor: 'full', highlight: null, note: '', notes: {}, vb: '-790 -150 1580 950', ...o };
  const places = opt.placements || PLACEMENTS;
  const hasCore = places.some(p => p.core);
  const accent = pl => pl.accent || BUILDINGS[pl.type].accent;
  const out = [];

  // board edge
  const edge = new Pen();
  edge.poly([[0, N, -0.6], [N, N, -0.6], [N, N, 0], [0, N, 0]], 'm-edge f-l');
  edge.poly([[N, 0, -0.6], [N, N, -0.6], [N, N, 0], [N, 0, 0]], 'm-edge f-r');
  out.push(`<g class="sp">${edge.o.join('')}</g>`);

  // ground tiles merged per material
  const groups = {};
  for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) {
    const m = tileMat(x, y);
    (groups[m] = groups[m] || []).push(`M${sp(x, y)}L${sp(x + 1, y)}L${sp(x + 1, y + 1)}L${sp(x, y + 1)}Z`);
  }
  out.push(`<g class="sp ground">${Object.entries(groups).map(([m, d]) => `<path class="m-${m} f-l tile nost" d="${d.join('')}"/>`).join('')}</g>`);

  // road centre dashes and water ripples
  const dash = [];
  for (const v of [7.5, 16.5]) { dash.push(`M${sp(v, 0)}L${sp(v, N)}`); dash.push(`M${sp(0, v)}L${sp(N, v)}`); }
  const waves = [];
  for (let x = 0; x < 7; x++) for (let y = 0; y < 7; y++) {
    if (x + y <= 6 && hash(x, y, 7) < 0.45 && !(x === 1 && y === 1)) {
      const [cx, cy] = iso(x + 0.5, y + 0.5);
      waves.push(`M${f1(cx - 9)},${f1(cy)}q4.5,-4 9,0t9,0`);
    }
  }
  out.push(`<g class="sp"><path class="ln m-white roaddash" d="${dash.join('')}"/><path class="ln m-white wave" d="${waves.join('')}"/></g>`);

  // focus ring under the highlighted building
  const hl = opt.highlight && places.find(p => p.id === opt.highlight);
  if (hl) {
    const f = footprint(hl), [cx, cy] = iso(f.x + f.w / 2, f.y + f.d / 2, 0.05), rx = (f.w + f.d) / 2 * 32 * 1.25;
    out.push(`<ellipse class="focus" cx="${f1(cx)}" cy="${f1(cy)}" rx="${f1(rx)}" ry="${f1(rx / 2)}"/>`);
  }

  // a pad under each core building
  if (opt.objects) {
    for (const pl of places.filter(p => p.core)) {
      const f = footprint(pl), m = 0.35;
      const pts = [[f.x - m, f.y - m], [f.x + f.w + m, f.y - m], [f.x + f.w + m, f.y + f.d + m], [f.x - m, f.y + f.d + m]];
      out.push(`<path class="core-pad" style="--accent:${accent(pl)}" d="M${pts.map(([x, y]) => sp(x, y, 0.02)).join('L')}Z"/>`);
    }
  }

  // flows run on the roads, under the buildings
  if (opt.flows) {
    for (const fl of FLOWS) {
      const d = 'M' + fl.pts.map(([x, y]) => sp(x, y, 0.15)).join('L');
      out.push(`<path class="flowpath fp-${fl.kind}" d="${d}"/>`);
      const dots = opt.anim ? [0, 0.5] : [0.35];
      for (const k of dots) {
        if (opt.anim) {
          out.push(`<circle class="fdot fd-${fl.kind}" r="5.5"><animateMotion dur="${fl.dur}s" begin="-${f1(fl.dur * k)}s" repeatCount="indefinite" path="${d}"/></circle>`);
        } else {
          const [x, y] = fl.pts[Math.min(1, fl.pts.length - 1)];
          const [sx, sy] = iso(x, y, 0.15);
          out.push(`<circle class="fdot fd-${fl.kind}" r="5.5" cx="${f1(sx)}" cy="${f1(sy)}"/>`);
        }
      }
    }
  }

  // objects, painter-sorted by footprint centre
  if (opt.objects) {
    const objs = [];
    const blocked = new Set();
    const light = opt.decor === 'light';
    for (const pl of places) {
      const f = footprint(pl), m = light && pl.core ? 2 : 1;
      for (let x = f.x - m; x < f.x + f.w + m; x++) for (let y = f.y - m; y < f.y + f.d + m; y++) blocked.add(`${x},${y}`);
      objs.push({ k: f.x + f.w / 2 + f.y + f.d / 2, pl });
    }
    if (opt.decor !== 'none') {
      for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) {
        const m = tileMat(x, y);
        if (!m.startsWith('grass') || blocked.has(`${x},${y}`)) continue;
        const park = x >= 17 && y >= 8 && y <= 15;
        if (hash(x, y, 3) < (park ? 0.5 : 0.2) * (light ? 0.25 : 1)) {
          const jx = (hash(x, y, 4) - 0.5) * 0.3, jy = (hash(x, y, 5) - 0.5) * 0.3;
          objs.push({ k: x + y + 1, prop: hash(x, y, 6) < 0.5 ? 'tree_pine' : 'tree_round', x: x + jx, y: y + jy });
        }
      }
    }
    if (opt.decor === 'full') {
      for (const [x, y] of LAMPS) objs.push({ k: x + y + 1, prop: 'lamp', x: x - 0.5, y: y - 0.5 });
      for (const [x, y] of BOATS) objs.push({ k: x + y + 0.8, prop: 'boat', x, y, cls: 'bob' });
    }
    objs.sort((a, b) => a.k - b.k);

    for (const ob of objs) {
      if (ob.pl) {
        const pl = ob.pl, b = BUILDINGS[pl.type], p = new Pen();
        b.draw(p, pl);
        const [tx, ty] = iso(pl.x, pl.y);
        const cls = `${pl.id === opt.highlight ? ' is-hl' : ''}${pl.status === 'busy' ? ' is-busy' : ''}${pl.core ? ' is-core' : hasCore ? ' is-dim' : ''}`;
        out.push(`<g class="sp bld${cls}" data-b="${pl.type}" data-id="${pl.id}" style="--accent:${accent(pl)}" transform="translate(${f1(tx)},${f1(ty)})">${p.o.join('')}</g>`);
      } else {
        const p = new Pen();
        PROPS[ob.prop].draw(p);
        const [tx, ty] = iso(ob.x, ob.y);
        out.push(`<g transform="translate(${f1(tx)},${f1(ty)})"><g class="sp ${ob.cls || ''}" style="--accent:#c47a3a">${p.o.join('')}</g></g>`);
      }
    }
  }

  // labels on top
  if (opt.districts) {
    for (const [k, x, y, z] of DISTRICT_LABELS) {
      const [sx, sy] = iso(x, y, z);
      out.push(pill(sx, sy, DISTRICTS[k].name, 'dlbl', 15));
    }
  }
  if (opt.labels !== 'none' && opt.objects) {
    for (const pl of places) {
      const isHl = pl.id === opt.highlight;
      if (opt.labels === 'key' && !(pl.key ?? KEY_LABELS.has(pl.id)) && !isHl) continue;
      const b = BUILDINGS[pl.type], f = footprint(pl);
      const [sx, sy] = iso(f.x + f.w / 2, f.y + f.d / 2, b.h + 0.5);
      const note = (isHl && opt.note) || opt.notes[pl.id];
      const text = note ? `${placementName(pl)} · ${note}` : placementName(pl);
      out.push(isHl ? pill(sx, sy, text, 'blbl hl', 12) : pl.core ? pill(sx, sy, text, 'blbl core', 13, `--accent:${accent(pl)}`) : pill(sx, sy, text, 'blbl', 12));
    }
  }

  return `<svg class="map${opt.anim ? ' anim' : ''}" viewBox="${opt.vb}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">${out.join('')}</svg>`;
}
