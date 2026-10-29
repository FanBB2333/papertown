// The Papertown map: placements on a 24×24 isometric grid, ground tiles, props,
// logistics flows and labels. renderMap() returns one <svg> string.
//
// The board is a 3×3 grid of areas. The four core buildings each own a 7×7 yard in a
// corner (造纸厂 at the top of the screen, then clockwise 仓库, 实验农场, 印刷厂) and
// are drawn larger than life. The strips between two neighbouring yards hold the small
// buildings that serve both, and the square in the middle is where an idea is written
// down, checked and handed to the mill. A ring road joins the yards in work order:
// mill → depot → farm → press → mill. The far shores are sea, with a dock in each of
// the two strips that touch it.

import { Pen, iso, isHand, handPath, BUILDINGS, PROPS, DISTRICTS } from './sprites.js';

export const N = 24;

// the core buildings, and how many times their sprite size they are drawn
export const SCALE = { mill: 1.6, depot: 1.6, farm: 1.5, press: 2.2 };
const YARD = [4.5, 19.5]; // yard centres along each axis
const RING = [4, 19]; // the ring road's rows and columns

// x, y are the back corner of the footprint in tile units
export const PLACEMENTS = [
  { id: 'mill', type: 'mill', x: 2, y: 3, name: '造纸厂' },
  { id: 'depot', type: 'depot', x: 17, y: 3, name: '仓库', label: 'code' },
  { id: 'farm', type: 'farm', x: 17, y: 17 },
  { id: 'press', type: 'press', x: 2, y: 17 },
  // 造纸厂 ↔ 印刷厂: papers come in to be read and go out once printed
  { id: 'dock_arxiv', type: 'dock_arxiv', x: 0, y: 9 },
  { id: 'customs', type: 'customs', x: 1, y: 12 },
  { id: 'library', type: 'library', x: 5, y: 9 },
  { id: 'qa', type: 'qa', x: 5, y: 13 },
  { id: 'lighthouse', type: 'lighthouse', x: 0, y: 12 },
  // 造纸厂 ↔ 仓库: a method turns into code
  { id: 'dock_github', type: 'dock_github', x: 11, y: 0 },
  { id: 'logistics', type: 'logistics', x: 14, y: 1 },
  { id: 'market', type: 'market', x: 10, y: 5 },
  // 仓库 ↔ 实验农场: tested code, datasets and compute
  { id: 'workshop', type: 'workshop', x: 16, y: 9 },
  { id: 'coldstore', type: 'coldstore', x: 16, y: 13 },
  { id: 'power', type: 'power', x: 20, y: 9 },
  { id: 'power_sim', type: 'power_sim', x: 20, y: 13 },
  // 实验农场 ↔ 印刷厂: results become a paper
  { id: 'newspaper', type: 'newspaper', x: 11, y: 16 },
  { id: 'weather', type: 'weather', x: 9, y: 20 },
  { id: 'bank', type: 'bank', x: 13, y: 20 },
  // the square in the middle
  { id: 'cityhall', type: 'cityhall', x: 11, y: 11 },
  { id: 'hatchery', type: 'hatchery', x: 9, y: 8 },
  { id: 'genealogy', type: 'genealogy', x: 8, y: 12 },
];

const KEY_LABELS = new Set(['mill', 'depot', 'farm', 'press', 'dock_arxiv', 'library', 'qa', 'dock_github', 'market', 'power', 'newspaper', 'cityhall', 'hatchery']);

// band and square names, at [x, y, z]
const DISTRICT_LABELS = [
  ['harbour', 3.2, 15.4, 0.6], ['wharf', 15.6, 1.2, 1.4], ['grid', 22.6, 15.6, 0.6],
  ['press_row', 8.4, 22.6, 0.6], ['plaza', 14.6, 14.6, 0.4],
];

const LAMPS = [[8.0, 4.0], [16.0, 5.0], [19.0, 8.0], [20.0, 16.0], [16.0, 19.0], [8.0, 20.0], [5.0, 16.0], [4.0, 8.0]];
const BOATS = [[0.1, 6.6], [7.6, 0.1]];
const BAYS = new Set(['1,9', '1,10', '11,1', '12,1']); // where the docks reach into the sea

// goods on the ring road (x, y of each bend)
const FLOWS = [
  { kind: 'paper', pts: [[2.6, 10.1], [4.5, 10.1], [4.5, 7.0]], dur: 8 },
  { kind: 'egg', pts: [[9.3, 8.6], [8.4, 8.6], [8.4, 4.5], [7.0, 4.5]], dur: 9 },
  { kind: 'code', pts: [[16.8, 4.5], [19.5, 4.5], [19.5, 7.0], [19.5, 16.8]], dur: 12 },
  { kind: 'energy', pts: [[20.2, 10.5], [19.5, 10.5], [19.5, 16.8]], dur: 8 },
  { kind: 'data', pts: [[17.9, 14.2], [19.5, 14.2], [19.5, 16.8]], dur: 6 },
];

export const FLOW_KINDS = {
  paper: '论文原料', egg: 'idea 蛋', code: '代码货箱', energy: '算力', data: '数据集',
};

export function scaleOf(pl) { return SCALE[pl.type] || 1; }

export function footprint(pl) {
  const b = BUILDINGS[pl.type], k = scaleOf(pl);
  return { x: pl.x, y: pl.y, w: (b?.w ?? 1) * k, d: (b?.d ?? 1) * k };
}

// the 7×7 yard a core building stands in
function yardOf(pl) {
  const f = footprint(pl), near = v => YARD.reduce((a, c) => Math.abs(c - v) < Math.abs(a - v) ? c : a);
  const cx = near(f.x + f.w / 2), cy = near(f.y + f.d / 2);
  return { x0: cx - 3.5, y0: cy - 3.5, x1: cx + 3.5, y1: cy + 3.5 };
}

// a rounded square inset from the yard's edges, in tile coordinates
function yardOutline(r, inset = 0.3, rad = 1.3) {
  const pts = [], x0 = r.x0 + inset, y0 = r.y0 + inset, x1 = r.x1 - inset, y1 = r.y1 - inset;
  const corners = [[x1 - rad, y0 + rad, -90], [x1 - rad, y1 - rad, 0], [x0 + rad, y1 - rad, 90], [x0 + rad, y0 + rad, 180]];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= 3; i++) {
      const a = (a0 + i * 30) * Math.PI / 180;
      pts.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]);
    }
  }
  return pts;
}

const CORE_FEET = PLACEMENTS.filter(p => SCALE[p.type]).map(footprint);
const under = (x, y) => CORE_FEET.some(f => x + 1 > f.x && x < f.x + f.w && y + 1 > f.y && y < f.y + f.d);

function hash(x, y, s = 0) {
  let h = (x * 374761393 + y * 668265263 + s * 982451653) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function tileMat(x, y) {
  if (x === 0 && y === 12) return 'sand'; // the lighthouse rock
  if (x === 0 || y === 0 || BAYS.has(`${x},${y}`)) return 'water';
  const ring = (RING.includes(y) && x >= RING[0] && x <= RING[1]) || (RING.includes(x) && y >= RING[0] && y <= RING[1]);
  if (ring && !under(x, y)) return 'road';
  if (x >= 9 && x <= 14 && y >= 9 && y <= 14) return 'plaza';
  return hash(x, y) < 0.3 ? 'grass2' : 'grass';
}

const f1 = n => Math.round(n * 10) / 10;
const sp = (x, y, z = 0) => iso(x, y, z).map(f1).join(',');

function textWidth(s, size) {
  let w = 0;
  for (const ch of s) w += /[　-鿿＀-￯]/.test(ch) ? size : size * 0.58;
  return w;
}

function pill(x, y, text, cls, size = 12, style = '') {
  const w = textWidth(text, size) + 16, h = size + 9;
  // hand-drawn: a wobbly tag with an ink outline instead of a perfect capsule
  const shape = isHand()
    ? (() => { const P = [[-w / 2, -h], [w / 2, -h], [w / 2 + 2, -h / 2], [w / 2, 0], [-w / 2, 0], [-w / 2 - 2, -h / 2]]; const d = handPath(P); return `<path class="tag" d="${d.wash}"/><path class="tag-ink" d="${d.ink}"/>`; })()
    : `<rect x="${f1(-w / 2)}" y="${-h}" width="${f1(w)}" height="${h}" rx="${h / 2}"/>`;
  return `<g class="${cls}"${style ? ` style="${style}"` : ''} transform="translate(${f1(x)},${f1(y)})">${shape}` +
    `<text x="0" y="${f1(-h / 2 + size * 0.36)}" font-size="${size}" text-anchor="middle">${text}</text></g>`;
}

export function placementName(pl) { return pl.name || BUILDINGS[pl.type].name; }

// placements: live placements from the server (default: the static design ones); a
// placement's `key` decides whether it is labelled, `status: 'busy'` marks it working,
// `core` puts a pad under it and dims everything that is not core.
// notes: placement id -> text appended to its label.
// decor: 'full' trees, lamps and boats; 'light' a few trees kept clear of core buildings; 'none'.
// dashes: centre lines on the roads.
export function renderMap(o = {}) {
  const opt = { labels: 'key', anim: true, objects: true, flows: true, districts: true, decor: 'full', dashes: true, highlight: null, note: '', notes: {}, vb: '-790 -150 1580 950', ...o };
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

  // road centre dashes (one per tile, along the ring) and water ripples
  const dash = [], waves = [];
  for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) {
    const m = tileMat(x, y);
    if (m === 'road') {
      if (RING.includes(y)) dash.push(`M${sp(x + 0.22, y + 0.5)}L${sp(x + 0.78, y + 0.5)}`);
      if (RING.includes(x)) dash.push(`M${sp(x + 0.5, y + 0.22)}L${sp(x + 0.5, y + 0.78)}`);
    } else if (m === 'water' && hash(x, y, 7) < 0.4) {
      const [cx, cy] = iso(x + 0.5, y + 0.5);
      waves.push(`M${f1(cx - 9)},${f1(cy)}q4.5,-4 9,0t9,0`);
    }
  }
  out.push(`<g class="sp">${opt.dashes ? `<path class="ln m-white roaddash" d="${dash.join('')}"/>` : ''}<path class="ln m-white wave" d="${waves.join('')}"/></g>`);

  // focus ring under the highlighted building
  const hl = opt.highlight && places.find(p => p.id === opt.highlight);
  if (hl) {
    const f = footprint(hl), [cx, cy] = iso(f.x + f.w / 2, f.y + f.d / 2, 0.05), rx = (f.w + f.d) / 2 * 32 * 1.25;
    out.push(`<ellipse class="focus" cx="${f1(cx)}" cy="${f1(cy)}" rx="${f1(rx)}" ry="${f1(rx / 2)}"/>`);
  }

  // each core building's yard: a rounded square of tinted ground filling its corner
  if (opt.objects) {
    for (const pl of places.filter(p => SCALE[p.type])) {
      const pts = yardOutline(yardOf(pl));
      if (isHand()) {
        const d = handPath(pts.map(([x, y]) => iso(x, y, 0.02)));
        out.push(`<g class="core-pad-g" style="--accent:${accent(pl)}"><path class="core-pad" d="${d.wash}"/><path class="core-pad-ink" d="${d.ink}"/></g>`);
      } else {
        out.push(`<path class="core-pad" style="--accent:${accent(pl)}" d="M${pts.map(([x, y]) => sp(x, y, 0.02)).join('L')}Z"/>`);
      }
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
      const f = footprint(pl), r = SCALE[pl.type] ? yardOf(pl) : { x0: f.x - 1, y0: f.y - 1, x1: f.x + f.w + 1, y1: f.y + f.d + 1 };
      for (let x = Math.floor(r.x0); x < r.x1; x++) for (let y = Math.floor(r.y0); y < r.y1; y++) blocked.add(`${x},${y}`);
      objs.push({ k: f.x + f.w / 2 + f.y + f.d / 2, pl });
    }
    if (opt.decor !== 'none') {
      for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) {
        const m = tileMat(x, y);
        if (!m.startsWith('grass') || blocked.has(`${x},${y}`)) continue;
        const rim = x >= N - 1 || y >= N - 1; // the near shore, where a few trees frame the board
        if (hash(x, y, 3) < (rim ? 0.55 : 0.18) * (light ? 0.3 : 1)) {
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
        const pl = ob.pl, b = BUILDINGS[pl.type], p = new Pen(scaleOf(pl));
        b.draw(p, pl);
        const [tx, ty] = iso(pl.x, pl.y);
        const cls = `${pl.id === opt.highlight ? ' is-hl' : ''}${pl.status === 'busy' ? ' is-busy' : ''}${pl.core ? ' is-core' : hasCore ? ' is-dim' : ''}`;
        out.push(`<g class="sp bld${cls}" data-b="${pl.type}" data-id="${pl.id}" style="--accent:${accent(pl)}" transform="translate(${f1(tx)},${f1(ty)})"><g class="bld-in">${p.o.join('')}</g></g>`);
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
      const [sx, sy] = iso(f.x + f.w / 2, f.y + f.d / 2, b.h * scaleOf(pl) + 0.5);
      const note = (isHl && opt.note) || opt.notes[pl.id];
      const text = note ? `${placementName(pl)} · ${note}` : placementName(pl);
      out.push(isHl ? pill(sx, sy, text, 'blbl hl', 12) : pl.core ? pill(sx, sy, text, 'blbl core', 13, `--accent:${accent(pl)}`) : pill(sx, sy, text, 'blbl', 12));
    }
  }

  return `<svg class="map${opt.anim ? ' anim' : ''}" viewBox="${opt.vb}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">${out.join('')}</svg>`;
}
