// Papertown sprite library: isometric buildings, props, item icons and worker avatars.
// Everything is drawn from code into SVG strings. Shapes carry a material class (m-*)
// and a face class (f-t top / f-l left / f-r right); the theme decides the colours.

export const TW = 64, TH = 32, ZU = 26;
const HW = TW / 2, HH = TH / 2, R2 = Math.SQRT2;
export const iso = (x, y, z = 0) => [(x - y) * HW, (x + y) * HH - z * ZU];
const r1 = n => Math.round(n * 10) / 10;
const pt = p => `${r1(p[0])},${r1(p[1])}`;

// Hand-drawn mode: every polygon comes out as a slightly wobbly wash of colour plus a
// separate ink line drawn over it, a little off register and overshooting the corners,
// like a sketch coloured in afterwards. The wobble is seeded by the coordinates, so the
// same shape always draws the same way and shared edges get the same stroke.
let HAND = false;
export function handDrawn(on = true) { HAND = on; }
export const isHand = () => HAND;

function noise(a, b, c) {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c, 982451653)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (((h ^ (h >>> 16)) >>> 0) / 4294967296) * 2 - 1;
}
const q4 = v => Math.round(v * 4);
const jit = (p, k, amp) => [p[0] + noise(q4(p[0]), q4(p[1]), k) * amp, p[1] + noise(q4(p[1]), q4(p[0]), k + 7) * amp];

function bowed(a, b, k, amount) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const off = noise(q4(mx), q4(my), k) * Math.min(amount, len * 0.03);
  return [mx - (b[1] - a[1]) / len * off, my + (b[0] - a[0]) / len * off];
}

function washPath(P) {
  const Q = P.map(p => jit(p, 1, 0.55));
  let d = `M${pt(Q[0])}`;
  for (let i = 0; i < Q.length; i++) {
    const a = Q[i], b = Q[(i + 1) % Q.length];
    d += Math.hypot(b[0] - a[0], b[1] - a[1]) < 6 ? `L${pt(b)}` : `Q${pt(bowed(a, b, 3, 1.1))} ${pt(b)}`;
  }
  return d + 'Z';
}

// the same two strokes for shapes drawn outside a Pen (screen points)
export function handPath(P) { return { wash: washPath(P), ink: inkPath(P) }; }

function inkPath(P) {
  let d = '';
  for (let i = 0; i < P.length; i++) {
    // draw each edge in one canonical direction so a shared edge is the same stroke
    let a = P[i], b = P[(i + 1) % P.length];
    if (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])) [a, b] = [b, a];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 2.5) continue;
    const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len, over = Math.min(1.8, len * 0.1);
    const o1 = over * (0.5 + 0.5 * noise(q4(a[0]), q4(a[1]), 11)), o2 = over * (0.5 + 0.5 * noise(q4(b[0]), q4(b[1]), 12));
    const A = jit([a[0] - ux * o1, a[1] - uy * o1], 5, 0.45), B = jit([b[0] + ux * o2, b[1] + uy * o2], 6, 0.45);
    d += `M${pt(A)}Q${pt(bowed(A, B, 9, 0.9))} ${pt(B)}`;
  }
  return d;
}

export class Pen {
  // k draws everything k times its size: the core buildings stand larger than life
  constructor(k = 1) { this.k = k; this.o = []; this.bb = [1e9, 1e9, -1e9, -1e9]; }
  I(x, y, z = 0) { const k = this.k; return iso(x * k, y * k, z * k); }
  grow(x, y) {
    const b = this.bb;
    if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
  }
  P(x, y, z = 0) { const p = this.I(x, y, z); this.grow(p[0], p[1]); return p; }
  raw(s) { this.o.push(s); return this; }
  poly(pts, cls) {
    const P = pts.map(q => this.P(q[0], q[1], q[2]));
    if (!HAND) {
      this.o.push(`<polygon class="${cls}" points="${P.map(pt).join(' ')}"/>`);
      return this;
    }
    const w = Math.max(...P.map(p => p[0])) - Math.min(...P.map(p => p[0])), h = Math.max(...P.map(p => p[1])) - Math.min(...P.map(p => p[1]));
    this.o.push(`<path class="${cls} wash" d="${washPath(P)}"/><path class="ink${w * h < 90 ? ' ink-s' : ''}" d="${inkPath(P)}"/>`);
    return this;
  }
  line(pts, cls) {
    const P = pts.map(q => this.P(q[0], q[1], q[2]));
    const d = HAND ? `M${pt(jit(P[0], 2, 0.5))}` + P.slice(1).map((p, i) => `Q${pt(bowed(P[i], p, 4, 0.8))} ${pt(jit(p, 2, 0.5))}`).join('') : `M${P.map(pt).join('L')}`;
    this.o.push(`<path class="${cls}" d="${d}"/>`);
    return this;
  }
  path(d, cls, box = []) { box.forEach(([x, y]) => this.grow(x, y)); this.o.push(`<path class="${cls}" d="${d}"/>`); return this; }
  ell(cx, cy, rx, ry, cls) {
    this.grow(cx - rx, cy - ry); this.grow(cx + rx, cy + ry);
    this.o.push(`<ellipse class="${cls}" cx="${r1(cx)}" cy="${r1(cy)}" rx="${r1(rx)}" ry="${r1(ry)}"/>`);
    return this;
  }
  circ(cx, cy, r, cls) { return this.ell(cx, cy, r, r, cls); }

  // ---- solids ----
  box(x, y, z, w, d, h, m) {
    this.poly([[x, y + d, z], [x + w, y + d, z], [x + w, y + d, z + h], [x, y + d, z + h]], `${m} f-l`);
    this.poly([[x + w, y, z], [x + w, y + d, z], [x + w, y + d, z + h], [x + w, y, z + h]], `${m} f-r`);
    this.poly([[x, y, z + h], [x + w, y, z + h], [x + w, y + d, z + h], [x, y + d, z + h]], `${m} f-t`);
    return this;
  }
  // ridge along x; the gable end faces +x (right)
  gableX(x, y, z, w, d, rh, m, me = m) {
    const ym = y + d / 2, zt = z + rh;
    this.poly([[x, y, z], [x + w, y, z], [x + w, ym, zt], [x, ym, zt]], `${m} f-t`);
    this.poly([[x, y + d, z], [x + w, y + d, z], [x + w, ym, zt], [x, ym, zt]], `${m} f-l`);
    this.poly([[x + w, y, z], [x + w, y + d, z], [x + w, ym, zt]], `${me} f-r`);
    return this;
  }
  // ridge along y; the gable end faces +y (left)
  gableY(x, y, z, w, d, rh, m, me = m) {
    const xm = x + w / 2, zt = z + rh;
    this.poly([[x, y, z], [x, y + d, z], [xm, y + d, zt], [xm, y, zt]], `${m} f-t`);
    this.poly([[x + w, y, z], [x + w, y + d, z], [xm, y + d, zt], [xm, y, zt]], `${m} f-r`);
    this.poly([[x, y + d, z], [x + w, y + d, z], [xm, y + d, zt]], `${me} f-l`);
    return this;
  }
  pyramid(x, y, z, w, d, rh, m) {
    const a = [x + w / 2, y + d / 2, z + rh];
    this.poly([[x, y, z], [x + w, y, z], a], `${m} f-t`);
    this.poly([[x, y, z], [x, y + d, z], a], `${m} f-t`);
    this.poly([[x, y + d, z], [x + w, y + d, z], a], `${m} f-l`);
    this.poly([[x + w, y, z], [x + w, y + d, z], a], `${m} f-r`);
    return this;
  }
  // factory roof: n teeth rising along +x, glazing faces +x
  sawtooth(x, y, z, w, d, n, th, m, mg) {
    const s = w / n;
    for (let i = 0; i < n; i++) {
      const x0 = x + i * s, x1 = x0 + s;
      this.poly([[x0, y, z], [x0, y + d, z], [x1, y + d, z + th], [x1, y, z + th]], `${m} f-t`);
      this.poly([[x0, y + d, z], [x1, y + d, z], [x1, y + d, z + th]], `${m} f-l`);
      this.poly([[x1, y, z], [x1, y + d, z], [x1, y + d, z + th], [x1, y, z + th]], `${mg} f-r`);
    }
    return this;
  }
  cyl(cx, cy, z, r, h, m, cap = true) {
    const k = this.k, [sx, sb] = this.I(cx, cy, z), st = sb - h * k * ZU, rx = r * k * HW * R2, ry = r * k * HH * R2;
    this.path(`M${r1(sx - rx)},${r1(st)}L${r1(sx - rx)},${r1(sb)}A${r1(rx)},${r1(ry)} 0 0 0 ${r1(sx)},${r1(sb + ry)}L${r1(sx)},${r1(st)}Z`,
      `${m} f-l`, [[sx - rx, st - ry], [sx, sb + ry]]);
    this.path(`M${r1(sx)},${r1(st)}L${r1(sx)},${r1(sb + ry)}A${r1(rx)},${r1(ry)} 0 0 0 ${r1(sx + rx)},${r1(sb)}L${r1(sx + rx)},${r1(st)}Z`,
      `${m} f-r`, [[sx + rx, st]]);
    if (cap) this.ell(sx, st, rx, ry, `${m} f-t`);
    return this;
  }
  dome(cx, cy, z, r, hd, m) {
    const k = this.k, [sx, sy] = this.I(cx, cy, z), rx = r * k * HW * R2, ry = r * k * HH * R2, hz = hd * k * ZU;
    this.path(`M${r1(sx - rx)},${r1(sy)}A${r1(rx)},${r1(hz)} 0 0 1 ${r1(sx + rx)},${r1(sy)}A${r1(rx)},${r1(ry)} 0 0 1 ${r1(sx - rx)},${r1(sy)}Z`,
      `${m} f-l`, [[sx - rx, sy - hz], [sx + rx, sy + ry]]);
    this.path(`M${r1(sx)},${r1(sy - hz)}A${r1(rx)},${r1(hz)} 0 0 1 ${r1(sx + rx)},${r1(sy)}A${r1(rx)},${r1(ry)} 0 0 1 ${r1(sx)},${r1(sy + ry)}Z`, `${m} f-r`);
    this.ell(sx - rx * 0.38, sy - hz * 0.55, rx * 0.16, hz * 0.14, 'hl');
    return this;
  }
  egg(cx, cy, z, r, h, m) {
    const k = this.k, [sx, sy] = this.I(cx, cy, z), rx = r * k * HW * R2, ry = r * k * HH * R2, hz = h * k * ZU;
    const L = r1(sx - rx), R = r1(sx + rx), X = r1(sx), Y = r1(sy), T = r1(sy - hz);
    this.path(`M${L},${Y}C${L},${r1(sy - hz * 0.55)} ${r1(sx - rx * 0.62)},${T} ${X},${T}C${r1(sx + rx * 0.62)},${T} ${R},${r1(sy - hz * 0.55)} ${R},${Y}A${r1(rx)},${r1(ry)} 0 0 1 ${L},${Y}Z`,
      `${m} f-l`, [[sx - rx, sy - hz], [sx + rx, sy + ry]]);
    this.path(`M${X},${T}C${r1(sx + rx * 0.62)},${T} ${R},${r1(sy - hz * 0.55)} ${R},${Y}A${r1(rx)},${r1(ry)} 0 0 1 ${X},${r1(sy + ry)}Z`, `${m} f-r`);
    this.ell(sx - rx * 0.4, sy - hz * 0.62, rx * 0.12, hz * 0.12, 'hl');
    return this;
  }
  cooling(cx, cy, z, r, h, m) {
    const k = this.k, [sx, sb] = this.I(cx, cy, z), rx = r * k * HW * R2, ry = r * k * HH * R2;
    const st = sb - h * k * ZU, sm = sb - h * k * ZU * 0.62, rt = rx * 0.7, rw = rx * 0.6, rty = ry * 0.7;
    this.path(`M${r1(sx - rx)},${r1(sb)}Q${r1(sx - rw)},${r1(sm)} ${r1(sx - rt)},${r1(st)}L${r1(sx)},${r1(st)}L${r1(sx)},${r1(sb + ry)}A${r1(rx)},${r1(ry)} 0 0 1 ${r1(sx - rx)},${r1(sb)}Z`,
      `${m} f-l`, [[sx - rx, st - rty], [sx + rx, sb + ry]]);
    this.path(`M${r1(sx)},${r1(st)}L${r1(sx + rt)},${r1(st)}Q${r1(sx + rw)},${r1(sm)} ${r1(sx + rx)},${r1(sb)}A${r1(rx)},${r1(ry)} 0 0 1 ${r1(sx)},${r1(sb + ry)}Z`, `${m} f-r`);
    this.ell(sx, st, rt, rty, `${m} f-t`);
    this.ell(sx, st, rt * 0.75, rty * 0.7, 'm-dark f-l');
    return this;
  }

  // ---- facade details ----
  winL(Y, x0, z0, w, h, m = 'm-win') { return this.poly([[x0, Y, z0], [x0 + w, Y, z0], [x0 + w, Y, z0 + h], [x0, Y, z0 + h]], `${m} f-l`); }
  winR(X, y0, z0, w, h, m = 'm-win') { return this.poly([[X, y0, z0], [X, y0 + w, z0], [X, y0 + w, z0 + h], [X, y0, z0 + h]], `${m} f-r`); }
  rowL(Y, x0, x1, z, n, w, h, m) { const g = (x1 - x0 - n * w) / (n - 1 || 1); for (let i = 0; i < n; i++) this.winL(Y, x0 + i * (w + g), z, w, h, m); return this; }
  rowR(X, y0, y1, z, n, w, h, m) { const g = (y1 - y0 - n * w) / (n - 1 || 1); for (let i = 0; i < n; i++) this.winR(X, y0 + i * (w + g), z, w, h, m); return this; }
  textL(x, Y, z, s, size = 10, cls = 't-sign') {
    const [px, py] = this.P(x, Y, z);
    this.o.push(`<text class="${cls}" transform="matrix(.894 .447 0 1 ${r1(px)} ${r1(py)})" font-size="${r1(size * this.k)}" text-anchor="middle">${s}</text>`);
    return this;
  }
  textR(X, y, z, s, size = 10, cls = 't-sign') {
    const [px, py] = this.P(X, y, z);
    this.o.push(`<text class="${cls}" transform="matrix(.894 -.447 0 1 ${r1(px)} ${r1(py)})" font-size="${r1(size * this.k)}" text-anchor="middle">${s}</text>`);
    return this;
  }
  boardL(Y, x0, x1, z0, z1, s, size = 10) {
    this.winL(Y, x0, z0, x1 - x0, z1 - z0, 'm-sign');
    return this.textL((x0 + x1) / 2, Y, z0 + (z1 - z0) * 0.5 - size * 0.36 / ZU, s, size);
  }
  // a flat glyph painted on a left (+y) face, drawn in the face's own 2D space
  decalL(x, Y, z, inner) {
    const [px, py] = this.P(x, Y, z);
    this.grow(px - 12, py - 12); this.grow(px + 12, py + 12);
    this.o.push(`<g transform="matrix(.894 .447 0 1 ${r1(px)} ${r1(py)})">${inner}</g>`);
    return this;
  }
  decalR(X, y, z, inner) {
    const [px, py] = this.P(X, y, z);
    this.grow(px - 12, py - 12); this.grow(px + 12, py + 12);
    this.o.push(`<g transform="matrix(.894 -.447 0 1 ${r1(px)} ${r1(py)})">${inner}</g>`);
    return this;
  }
  smoke(cx, cy, z, s = 1) {
    const [x, y] = this.I(cx, cy, z);
    s *= this.k;
    this.o.push(`<g class="smoke-g"><circle class="smoke s1" cx="${r1(x)}" cy="${r1(y - 6 * s)}" r="${r1(5 * s)}"/>` +
      `<circle class="smoke s2" cx="${r1(x + 5 * s)}" cy="${r1(y - 16 * s)}" r="${r1(7 * s)}"/>` +
      `<circle class="smoke s3" cx="${r1(x + 12 * s)}" cy="${r1(y - 29 * s)}" r="${r1(9 * s)}"/></g>`);
    this.grow(x - 6 * s, y - 40 * s); this.grow(x + 22 * s, y);
    return this;
  }
  flag(x, y, z, h, m = 'm-acc2') {
    this.box(x, y, z, 0.05, 0.05, h, 'm-metal');
    return this.poly([[x + 0.05, y + 0.05, z + h], [x + 0.6, y + 0.05, z + h - 0.12], [x + 0.05, y + 0.05, z + h - 0.28]], `${m} f-l`);
  }
  figure(x, y, m) {
    const [sx, sy] = this.P(x, y, 0);
    this.ell(sx, sy, 5, 2.5, 'shadow');
    this.path(`M${r1(sx - 4)},${r1(sy)}L${r1(sx - 4)},${r1(sy - 10)}Q${r1(sx - 4)},${r1(sy - 15)} ${r1(sx)},${r1(sy - 15)}Q${r1(sx + 4)},${r1(sy - 15)} ${r1(sx + 4)},${r1(sy - 10)}L${r1(sx + 4)},${r1(sy)}Z`, `${m} f-l`, [[sx - 4, sy - 24]]);
    return this.circ(sx, sy - 19, 4, 'm-egg f-l');
  }
  truck(x, y, m) {
    this.box(x, y, 0.06, 0.36, 1.0, 0.42, m);
    this.box(x, y + 1.03, 0.06, 0.36, 0.3, 0.34, 'm-acc2');
    return this.winL(y + 1.33, x + 0.05, 0.24, 0.26, 0.12, 'm-glass');
  }

  svg(cls = '', style = '', pad = 6) {
    const [x0, y0, x1, y1] = this.bb;
    const vb = `${r1(x0 - pad)} ${r1(y0 - pad)} ${r1(x1 - x0 + pad * 2)} ${r1(y1 - y0 + pad * 2)}`;
    return { vb, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2, body: `<g class="sp ${cls}"${style ? ` style="${style}"` : ''}>${this.o.join('')}</g>` };
  }
}

// ---------- districts & buildings ----------

// The town is laid out as a 3×3 grid: the four core buildings each have a corner yard,
// the strips between two yards hold the buildings that serve both, and the square in
// the middle is where an idea becomes a project. `dir` is where the area sits.
export const DISTRICTS = {
  camp: { name: '造纸厂大本营', en: 'Base Camp', dir: '北', color: '#a8743f' },
  code: { name: '仓库', en: 'Code Depot', dir: '东', color: '#4f8a3d' },
  field: { name: '实验农场', en: 'Experiment Fields', dir: '南', color: '#6f9a4a' },
  print: { name: '印刷厂', en: 'Print Works', dir: '西', color: '#4b5f9e' },
  harbour: { name: '文献港', en: 'Literature Harbour', dir: '造纸厂 ↔ 印刷厂', color: '#5aa0c8' },
  wharf: { name: '开源码头', en: 'Open-source Wharf', dir: '造纸厂 ↔ 仓库', color: '#4a5568' },
  grid: { name: '算力带', en: 'Compute Belt', dir: '仓库 ↔ 实验农场', color: '#e0a030' },
  press_row: { name: '成果街', en: 'Results Row', dir: '实验农场 ↔ 印刷厂', color: '#9b4a4a' },
  plaza: { name: '立项广场', en: 'Project Square', dir: '中央', color: '#b07d4f' },
};

const stilts = (p, pts) => pts.forEach(([x, y]) => p.box(x, y, -0.4, 0.12, 0.12, 0.4, 'm-wood'));

export const BUILDINGS = {
  dock_arxiv: {
    name: 'arXiv 码头', en: 'arXiv Dock', district: 'harbour', w: 3, d: 2, h: 2.4, accent: '#b5523b',
    rep: '每天到港的新论文元数据和 TeX 源码', tech: 'MCP · arXiv',
    draw(p) {
      stilts(p, [[0.15, 0.2], [1.4, 0.2], [2.7, 0.2], [0.15, 1.7], [1.4, 1.7], [2.7, 1.7]]);
      p.box(0, 0, 0, 3, 2, 0.18, 'm-wood');
      p.box(0.25, 0.25, 0.18, 0.12, 0.12, 2.1, 'm-metal');
      p.box(0.25, 1.35, 0.18, 0.12, 0.12, 2.1, 'm-metal');
      p.box(0.25, 0.25, 2.28, 0.12, 1.22, 0.14, 'm-acc');
      p.box(0.25, -0.95, 2.2, 0.12, 1.32, 0.12, 'm-acc');
      p.line([[0.31, -0.8, 2.2], [0.31, -0.8, 1.25]], 'ln m-dark');
      p.box(0.19, -0.92, 1.0, 0.25, 0.25, 0.25, 'm-white');
      p.box(0.75, 0.3, 0.18, 0.55, 0.55, 0.42, 'm-white');
      p.box(1.4, 0.3, 0.18, 0.55, 0.55, 0.42, 'm-white');
      p.box(1.05, 0.33, 0.6, 0.55, 0.55, 0.42, 'm-white');
      p.box(1.15, 1.05, 0.18, 1.6, 0.8, 0.85, 'm-wall');
      p.winL(1.85, 2.15, 0.18, 0.35, 0.55, 'm-dark');
      p.boardL(1.85, 1.28, 2.0, 0.4, 0.82, 'arXiv', 11);
      p.gableX(1.1, 1.0, 1.03, 1.7, 0.9, 0.42, 'm-roof');
    },
  },
  dock_github: {
    name: 'GitHub 码头', en: 'GitHub Dock', district: 'wharf', w: 2, d: 3, h: 2.6, accent: '#4a5568',
    rep: '开源代码、issue 和 star 从这里进出', tech: 'MCP · GitHub',
    draw(p) {
      stilts(p, [[0.2, 0.15], [1.7, 0.15], [0.2, 1.45], [1.7, 1.45], [0.2, 2.75], [1.7, 2.75]]);
      p.box(0, 0, 0, 2, 3, 0.18, 'm-wood');
      p.box(0.15, 0.2, 0.18, 0.75, 1.5, 0.5, 'm-acc');
      p.box(1.0, 0.2, 0.18, 0.75, 1.5, 0.5, 'm-acc2');
      p.box(0.15, 0.2, 0.68, 0.75, 1.5, 0.5, 'm-metal');
      for (const x of [0.3, 0.5, 0.7]) p.line([[x, 1.7, 0.72], [x, 1.7, 1.12]], 'ln m-dark');
      p.box(1.62, 1.92, 0.18, 0.14, 0.14, 2.35, 'm-acc2');
      p.box(0.2, 1.95, 2.4, 1.56, 0.1, 0.1, 'm-acc2');
      p.line([[0.4, 2.0, 2.4], [0.4, 2.0, 1.4]], 'ln m-dark');
      p.box(0.2, 2.15, 0.18, 0.95, 0.7, 0.75, 'm-wall');
      p.boardL(2.85, 0.27, 1.08, 0.35, 0.72, 'GitHub', 9);
      p.box(0.16, 2.11, 0.93, 1.03, 0.78, 0.08, 'm-roof');
    },
  },
  customs: {
    name: '学术海关', en: 'Customs', district: 'harbour', w: 2, d: 2, h: 2.1, accent: '#8a7a5c',
    rep: '入境检查：去重、过滤不相关论文、打领域标签', tech: 'Skill · 分类',
    draw(p) {
      p.box(0, 0, 0, 2, 2, 0.12, 'm-base');
      p.box(0.25, 0.25, 0.12, 1.3, 1.2, 0.95, 'm-wall');
      p.rowL(1.45, 0.4, 1.4, 0.42, 3, 0.22, 0.32);
      p.rowR(1.55, 0.4, 1.3, 0.42, 2, 0.22, 0.32);
      p.box(0.2, 0.2, 1.07, 1.4, 1.3, 0.1, 'm-roof');
      p.box(0.95, 0.35, 1.17, 0.42, 0.42, 0.55, 'm-wall');
      p.pyramid(0.92, 0.32, 1.72, 0.48, 0.48, 0.38, 'm-roof');
      p.box(1.75, 0.3, 0.12, 0.1, 0.1, 0.45, 'm-metal');
      p.box(1.75, 1.7, 0.12, 0.1, 0.1, 0.45, 'm-metal');
      p.box(1.77, 0.4, 0.48, 0.06, 1.3, 0.07, 'm-acc2');
    },
  },
  lighthouse: {
    name: '灯塔', en: 'Lighthouse', district: 'harbour', w: 1, d: 1, h: 3, accent: '#c4553f',
    rep: '订阅追踪：盯住作者、关键词和竞争对手', tech: 'MCP · 定时任务', later: true,
    draw(p) {
      p.box(0.05, 0.05, 0, 0.9, 0.9, 0.22, 'm-base');
      p.cyl(0.5, 0.5, 0.22, 0.3, 0.62, 'm-white', false);
      p.cyl(0.5, 0.5, 0.84, 0.28, 0.5, 'm-acc2', false);
      p.cyl(0.5, 0.5, 1.34, 0.26, 0.5, 'm-white', false);
      p.cyl(0.5, 0.5, 1.84, 0.24, 0.42, 'm-acc2');
      p.cyl(0.5, 0.5, 2.26, 0.17, 0.34, 'm-glass', false);
      const [x, y] = p.I(0.5, 0.5, 2.43);
      p.path(`M${r1(x)},${r1(y - 3)}L${r1(x + 74)},${r1(y - 26)}L${r1(x + 74)},${r1(y + 16)}Z`, 'beam', [[x + 74, y - 26], [x + 74, y + 16]]);
      p.dome(0.5, 0.5, 2.6, 0.22, 0.32, 'm-acc2');
    },
  },

  hatchery: {
    name: '孵化场', en: 'Hatchery', district: 'plaza', w: 2, d: 2, h: 2.4, accent: '#e2b84a',
    rep: 'idea 蛋在这里查重、孵化，通过后才建厂', tech: 'RAG + Skill · 查重',
    draw(p) {
      p.box(0, 0, 0, 2, 2, 0.12, 'm-base');
      p.box(0.2, 0.2, 0.12, 1.6, 1.6, 0.5, 'm-wall');
      p.rowL(1.8, 0.35, 1.65, 0.24, 4, 0.18, 0.22);
      p.rowR(1.8, 0.35, 1.65, 0.24, 4, 0.18, 0.22);
      p.box(0.15, 0.15, 0.62, 1.7, 1.7, 0.08, 'm-acc');
      p.egg(1, 1, 0.7, 0.56, 1.6, 'm-egg');
      const [x, y] = p.I(1, 1, 0.7);
      p.path(`M${r1(x - 12)},${r1(y - 22)}l5,4l4,-5l5,5l4,-4l6,4`, 'ln m-dark');
    },
  },
  mill: {
    name: '造纸厂', en: 'Paper Mill', district: 'camp', w: 3, d: 2, h: 3.6, accent: '#a8743f',
    rep: '一篇论文一座厂：调研、方法、写作都在这条流水线上', tech: 'Capitalist 编队 + Skills',
    draw(p) {
      p.box(0, 0, 0, 3, 2, 0.12, 'm-base');
      p.box(0.1, 0.15, 0.12, 2.75, 1.65, 1.15, 'm-wall');
      p.rowL(1.8, 0.3, 2.65, 0.32, 5, 0.28, 0.38);
      p.boardL(1.8, 0.75, 2.2, 0.8, 1.17, 'PAPER MILL', 10);
      p.rowR(2.85, 0.35, 1.6, 0.4, 2, 0.3, 0.5);
      p.sawtooth(0.1, 0.15, 1.27, 2.75, 1.65, 4, 0.5, 'm-roof', 'm-glass');
      p.cyl(0.45, 0.55, 1.27, 0.17, 2.2, 'm-acc2', false);
      p.cyl(0.45, 0.55, 3.47, 0.2, 0.12, 'm-dark');
      p.smoke(0.45, 0.55, 3.6);
    },
  },
  farm: {
    name: '实验农场', en: 'Experiment Farm', district: 'field', w: 3, d: 3, h: 1.8, accent: '#6f9a4a',
    rep: '每块田是一组实验，收成是结果表；用的电来自算力电厂', tech: 'MCP · nvidb',
    draw(p) {
      p.box(0, 0, 0, 3, 3, 0.08, 'm-soil');
      for (let i = 0; i < 6; i++) p.box(0.2, 0.25 + i * 0.42, 0.08, 1.75, 0.26, 0.07, i < 3 ? 'm-crop' : 'm-crop2');
      p.box(2.1, 0.2, 0.08, 0.75, 1.1, 0.72, 'm-acc2');
      p.winL(1.3, 2.3, 0.08, 0.34, 0.45, 'm-white');
      p.gableY(2.05, 0.15, 0.8, 0.85, 1.2, 0.45, 'm-dark');
      p.cyl(2.48, 1.95, 0.08, 0.3, 1.25, 'm-metal', false);
      p.dome(2.48, 1.95, 1.33, 0.3, 0.28, 'm-acc');
      for (let x = 0.2; x < 2.0; x += 0.35) p.box(x, 2.88, 0.08, 0.06, 0.06, 0.28, 'm-wood');
      p.box(0.2, 2.88, 0.26, 1.78, 0.04, 0.04, 'm-wood');
    },
  },
  press: {
    name: '印刷厂', en: 'TeX Press', district: 'print', w: 2, d: 2, h: 2.5, accent: '#4b5f9e',
    rep: 'TeX 源码的存放、排版和编译；.tex 是铅字版，编译是开机印刷', tech: 'downleaf · arXivTeXplorer',
    draw(p) {
      p.box(0, 0, 0, 2, 2, 0.12, 'm-base');
      p.box(0.2, 0.2, 0.12, 1.6, 1.55, 1.3, 'm-wall');
      for (let r = 0; r < 3; r++) for (let c = 0; c < 6; c++) p.winL(1.75, 0.3 + c * 0.24, 0.3 + r * 0.26, 0.17, 0.18);
      p.rowR(1.8, 0.4, 1.55, 0.55, 2, 0.3, 0.45);
      p.gableX(0.15, 0.15, 1.42, 1.7, 1.65, 0.6, 'm-roof', 'm-wall');
      p.textR(1.85, 0.975, 1.5, 'TeX', 12);
      p.box(0.55, 0.9, 1.85, 0.18, 0.18, 0.4, 'm-metal');
    },
  },
  qa: {
    name: '质检所', en: 'Review Lab', district: 'harbour', w: 2, d: 2, h: 2.6, accent: '#3f8f7f',
    rep: '多个审稿人 persona 打分，检查页数、匿名和模板', tech: 'Skills · 审稿',
    draw(p) {
      p.box(0, 0, 0, 2, 2, 0.12, 'm-base');
      p.box(0.2, 0.25, 0.12, 1.55, 1.45, 1.15, 'm-wall');
      p.rowL(1.7, 0.35, 1.6, 0.45, 3, 0.28, 0.4);
      p.rowR(1.75, 0.4, 1.55, 0.45, 2, 0.28, 0.4);
      p.box(0.15, 0.2, 1.27, 1.65, 1.55, 0.1, 'm-roof');
      p.box(1.0, 0.95, 1.37, 0.08, 0.08, 0.45, 'm-metal');
      const [cx, cy] = p.I(1.04, 0.99, 2.25);
      p.circ(cx, cy, 13, 'm-glass f-t');
      p.circ(cx, cy, 13, 'ln2 m-acc');
      p.path(`M${r1(cx - 6)},${r1(cy)}L${r1(cx - 1)},${r1(cy + 5)}L${r1(cx + 7)},${r1(cy - 5)}`, 'ln2 m-acc2');
    },
  },

  depot: {
    name: '仓库', en: 'Repo Depot', district: 'code', w: 3, d: 2, h: 2.1, accent: '#4f8a3d',
    rep: '一个开源 repo 一座仓库：货架是目录，commit 入库，release 出货', tech: 'RAG · 代码与文档',
    draw(p, o = {}) {
      p.box(0, 0, 0, 3, 2, 0.12, 'm-base');
      p.box(0.1, 0.15, 0.12, 2.8, 1.6, 1.2, 'm-wall');
      for (const x of [0.35, 1.2, 2.05]) {
        p.winL(1.75, x, 0.12, 0.6, 0.66, 'm-dark');
        for (const z of [0.3, 0.45, 0.6]) p.line([[x + 0.04, 1.75, z], [x + 0.56, 1.75, z]], 'ln m-metal');
      }
      p.boardL(1.75, 0.6, 2.4, 0.86, 1.2, o.label || 'repo', 11);
      p.rowR(2.9, 0.4, 1.5, 0.6, 2, 0.3, 0.3);
      p.box(0.2, 1.78, 0.12, 2.6, 0.18, 0.14, 'm-base');
      p.gableX(0.05, 0.1, 1.32, 2.9, 1.7, 0.42, 'm-roof', 'm-wall');
    },
  },
  workshop: {
    name: '加工车间', en: 'Workshop', district: 'grid', w: 2, d: 2, h: 2.0, accent: '#c47a3a',
    rep: '维护 agent 的工位：修 bug、写文档、回 issue', tech: 'Skills · 维护',
    draw(p) {
      p.box(0, 0, 0, 2, 2, 0.12, 'm-base');
      p.box(0.3, 0.3, 0.12, 1.4, 1.3, 0.9, 'm-wall');
      p.winL(1.6, 0.45, 0.12, 0.45, 0.6, 'm-dark');
      p.winL(1.6, 1.1, 0.42, 0.38, 0.3);
      p.rowR(1.7, 0.45, 1.45, 0.45, 2, 0.25, 0.3);
      p.poly([[1.7, 0.3, 1.02], [1.7, 1.6, 1.02], [1.7, 0.3, 1.29]], 'm-wall f-r');
      p.poly([[0.25, 0.25, 1.32], [1.75, 0.25, 1.32], [1.75, 1.65, 1.0], [0.25, 1.65, 1.0]], 'm-roof f-t');
      p.poly([[0.25, 1.65, 0.94], [1.75, 1.65, 0.94], [1.75, 1.65, 1.0], [0.25, 1.65, 1.0]], 'm-roof f-l');
      p.cyl(0.6, 0.6, 1.25, 0.08, 0.6, 'm-metal');
      p.smoke(0.6, 0.6, 1.9, 0.6);
      p.decalR(1.7, 1.2, 0.95, '<circle class="ln2 m-acc" r="5.5" stroke-dasharray="3 2.2"/><circle class="m-acc f-l" r="2.4"/>');
    },
  },
  logistics: {
    name: '物流站', en: 'Logistics', district: 'wharf', w: 2, d: 2, h: 1.6, accent: '#d0a03a',
    rep: '仓库之间、仓库和造纸厂之间的依赖与调用', tech: '知识图谱 · 依赖',
    draw(p) {
      p.box(0, 0, 0, 2, 2, 0.06, 'm-road');
      for (const x of [1.05, 1.5, 1.95]) p.line([[x, 0.2, 0.06], [x, 1.8, 0.06]], 'ln m-white');
      p.box(0.15, 0.15, 0.06, 0.75, 0.8, 0.7, 'm-wall');
      p.rowL(0.95, 0.25, 0.8, 0.3, 2, 0.18, 0.25);
      p.box(0.12, 0.12, 0.76, 0.81, 0.86, 0.08, 'm-acc');
      p.truck(1.1, 0.25, 'm-acc');
      p.truck(1.55, 0.45, 'm-white');
    },
  },

  library: {
    name: '图书馆', en: 'Library', district: 'harbour', w: 3, d: 3, h: 2.3, accent: '#5f7f9e',
    rep: '全世界共享的知识库：读过的论文、笔记和摘要', tech: 'RAG 主库 · 向量检索',
    draw(p) {
      p.box(0, 0, 0, 3, 3, 0.1, 'm-base');
      p.box(0.15, 0.15, 0.1, 2.7, 2.7, 0.1, 'm-base');
      p.box(0.4, 0.35, 0.2, 2.2, 1.95, 1.4, 'm-wall');
      p.rowR(2.6, 0.6, 2.1, 0.5, 3, 0.3, 0.7);
      p.winL(2.3, 1.3, 0.2, 0.4, 0.78, 'm-dark');
      for (const x of [0.5, 0.92, 1.34, 1.76, 2.18]) p.box(x, 2.4, 0.2, 0.16, 0.16, 1.25, 'm-white');
      p.box(0.4, 2.3, 1.45, 2.2, 0.32, 0.22, 'm-white');
      p.gableY(0.35, 0.3, 1.67, 2.3, 2.4, 0.55, 'm-roof', 'm-white');
      p.decalL(1.5, 2.7, 1.83, '<path class="m-acc f-l" d="M-7,-3L0,-1L7,-3L7,4L0,6L-7,4Z"/><path class="ln m-dark" d="M0,-1V6"/>');
    },
  },
  genealogy: {
    name: '族谱馆', en: 'Lineage Hall', district: 'plaza', w: 2, d: 2, h: 2.6, accent: '#5e8c5a',
    rep: '引用关系图谱：谁是谁的"祖先"，方法怎么传下来', tech: '知识图谱 + GraphRAG',
    draw(p) {
      p.box(0, 0, 0, 2, 2, 0.12, 'm-base');
      p.box(0.72, 0.55, 0.12, 0.16, 0.16, 1.4, 'm-trunk');
      const [tx, ty] = p.I(0.8, 0.63, 1.8);
      p.circ(tx - 15, ty + 5, 17, 'm-leaf f-l');
      p.circ(tx + 15, ty + 3, 17, 'm-leaf f-r');
      p.circ(tx, ty - 11, 20, 'm-leaf f-t');
      p.path(`M${r1(tx)},${r1(ty - 24)}L${r1(tx - 13)},${r1(ty - 6)}M${r1(tx)},${r1(ty - 24)}L${r1(tx + 12)},${r1(ty - 8)}M${r1(tx - 13)},${r1(ty - 6)}L${r1(tx - 20)},${r1(ty + 10)}M${r1(tx - 13)},${r1(ty - 6)}L${r1(tx - 4)},${r1(ty + 10)}M${r1(tx + 12)},${r1(ty - 8)}L${r1(tx + 18)},${r1(ty + 8)}`, 'ln m-white');
      for (const [dx, dy] of [[0, -24], [-13, -6], [12, -8], [-20, 10], [-4, 10], [18, 8]]) p.circ(tx + dx, ty + dy, 3.2, 'm-acc2 f-l');
      p.box(0.2, 1.0, 0.12, 1.6, 0.8, 0.85, 'm-wall');
      p.rowL(1.8, 0.35, 1.65, 0.35, 3, 0.25, 0.32);
      p.rowR(1.8, 1.15, 1.65, 0.35, 1, 0.25, 0.32);
      p.box(0.15, 0.95, 0.97, 1.7, 0.9, 0.08, 'm-roof');
    },
  },
  market: {
    name: '人才市场', en: 'Talent Market', district: 'wharf', w: 3, d: 2, h: 1.6, accent: '#c25b56',
    rep: 'Agent 员工池：按任务编队，按 ROI 升职或降级', tech: 'Capitalist + Skills',
    draw(p) {
      p.box(0, 0, 0, 3, 2, 0.06, 'm-plaza');
      p.box(0.15, 0.15, 0.06, 2.7, 0.12, 1.15, 'm-wall');
      p.boardL(0.27, 0.55, 2.45, 0.7, 1.08, '人才市场 · HIRING', 10);
      for (let i = 0; i < 3; i++) {
        const x0 = 0.25 + i * 0.92, m = i % 2 ? 'm-acc2' : 'm-acc';
        p.box(x0, 0.5, 0.06, 0.06, 0.06, 0.85, 'm-metal');
        p.box(x0 + 0.66, 0.5, 0.06, 0.06, 0.06, 0.85, 'm-metal');
        p.box(x0, 0.95, 0.06, 0.72, 0.45, 0.36, 'm-wood');
        p.poly([[x0 - 0.04, 0.45, 0.95], [x0 + 0.76, 0.45, 0.95], [x0 + 0.76, 1.35, 0.72], [x0 - 0.04, 1.35, 0.72]], `${m} f-t`);
        p.poly([[x0 - 0.04, 1.35, 0.62], [x0 + 0.76, 1.35, 0.62], [x0 + 0.76, 1.35, 0.72], [x0 - 0.04, 1.35, 0.72]], `${m} f-l`);
      }
      p.figure(0.6, 1.75, 'm-acc');
      p.figure(1.55, 1.7, 'm-dark');
      p.figure(2.5, 1.8, 'm-acc2');
    },
  },
  cityhall: {
    name: '市政厅', en: 'City Hall', district: 'plaza', w: 3, d: 3, h: 3.8, accent: '#b07d4f',
    rep: '你的个人中心：项目总览、预算、待办，也是写下新 idea 的地方', tech: '—',
    draw(p) {
      p.box(0, 0, 0, 3, 3, 0.12, 'm-base');
      p.box(0.2, 0.3, 0.12, 2.6, 2.4, 1.05, 'm-wall');
      p.rowL(2.7, 0.35, 1.15, 0.42, 3, 0.2, 0.36);
      p.rowL(2.7, 1.85, 2.65, 0.42, 3, 0.2, 0.36);
      p.winL(2.7, 1.3, 0.12, 0.42, 0.6, 'm-dark');
      p.rowR(2.8, 0.45, 2.55, 0.42, 5, 0.22, 0.36);
      p.box(0.15, 0.25, 1.17, 2.7, 2.5, 0.1, 'm-roof');
      p.box(1.1, 1.1, 1.27, 0.8, 0.8, 1.55, 'm-wall');
      const clock = '<circle class="m-white f-l" r="8.5"/><path class="ln m-dark" d="M0,0V-5.5M0,0H4"/>';
      p.decalL(1.5, 1.9, 2.35, clock);
      p.decalR(1.9, 1.5, 2.35, clock);
      p.box(1.05, 1.05, 2.82, 0.9, 0.9, 0.1, 'm-roof');
      p.pyramid(1.05, 1.05, 2.92, 0.9, 0.9, 0.75, 'm-roof');
      p.flag(1.48, 1.48, 3.62, 0.55);
    },
  },
  bank: {
    name: '银行', en: 'Bank', district: 'press_row', w: 2, d: 2, h: 2.0, accent: '#c9a227',
    rep: 'token 预算和 API 成本；每条流水线结束时在这里结算', tech: '计费日志',
    draw(p) {
      p.box(0, 0, 0, 2, 2, 0.1, 'm-base');
      p.box(0.12, 0.12, 0.1, 1.76, 1.76, 0.1, 'm-base');
      p.box(0.3, 0.3, 0.2, 1.4, 1.25, 1.15, 'm-wall');
      p.winL(1.55, 0.85, 0.2, 0.3, 0.55, 'm-dark');
      p.rowR(1.7, 0.45, 1.4, 0.45, 2, 0.25, 0.45);
      for (const x of [0.38, 0.72, 1.06, 1.4]) p.box(x, 1.62, 0.2, 0.13, 0.13, 1.0, 'm-white');
      p.box(0.3, 1.55, 1.2, 1.4, 0.25, 0.17, 'm-white');
      p.gableY(0.27, 0.27, 1.37, 1.46, 1.56, 0.45, 'm-roof', 'm-white');
      p.textL(1.0, 1.83, 1.43, '$', 12);
    },
  },
  newspaper: {
    name: '报社', en: 'Newsroom', district: 'press_row', w: 2, d: 2, h: 2.8, accent: '#9b4a4a',
    rep: '每天出一份世界日报：新论文、仓库更新、实验进展', tech: 'RAG + Skill · 摘要',
    draw(p) {
      p.box(0, 0, 0, 2, 2, 0.12, 'm-base');
      p.box(0.25, 0.3, 0.12, 1.5, 1.4, 1.6, 'm-wall');
      for (const z of [0.35, 0.8, 1.25]) { p.rowL(1.7, 0.4, 1.6, z, 3, 0.25, 0.3); p.rowR(1.75, 0.45, 1.55, z, 2, 0.25, 0.3); }
      p.box(0.2, 0.25, 1.72, 1.6, 1.5, 0.08, 'm-roof');
      p.box(0.45, 0.95, 1.8, 0.06, 0.06, 0.4, 'm-metal');
      p.box(1.45, 0.95, 1.8, 0.06, 0.06, 0.4, 'm-metal');
      p.winL(1.02, 0.3, 2.15, 1.4, 0.62, 'm-sign');
      p.winL(1.02, 0.3, 2.15, 1.4, 0.1, 'm-acc2');
      p.textL(1.0, 1.02, 2.38, '日报 DAILY', 10);
    },
  },

  power: {
    name: '算力电厂', en: 'GPU Power Plant', district: 'grid', w: 3, d: 3, h: 2.6, accent: '#e0a030',
    rep: 'GPU：负荷就是显卡占用，停电就是 OOM', tech: 'MCP · nvidb',
    draw(p) {
      p.box(0, 0, 0, 3, 3, 0.1, 'm-base');
      p.cooling(0.85, 0.85, 0.1, 0.62, 2.1, 'm-white');
      p.smoke(0.85, 0.85, 2.3, 1.2);
      p.cooling(2.1, 0.7, 0.1, 0.52, 1.8, 'm-white');
      p.smoke(2.1, 0.7, 2.0);
      p.box(2.4, 1.38, 0.1, 0.45, 0.4, 0.5, 'm-metal');
      p.box(0.25, 1.85, 0.1, 2.5, 0.95, 0.85, 'm-wall');
      p.rowL(2.8, 0.4, 2.6, 0.32, 6, 0.2, 0.3);
      p.rowR(2.75, 2.0, 2.65, 0.32, 2, 0.2, 0.3);
      p.box(0.2, 1.8, 0.95, 2.6, 1.05, 0.08, 'm-roof');
      p.box(0.7, 2.2, 1.03, 0.05, 0.05, 0.25, 'm-metal');
      p.box(1.6, 2.2, 1.03, 0.05, 0.05, 0.25, 'm-metal');
      p.winL(2.25, 0.6, 1.25, 1.1, 0.42, 'm-sign');
      p.textL(1.03, 2.25, 1.38, 'GPU', 11);
      p.decalL(1.42, 2.25, 1.46, '<path class="m-acc f-l" d="M1,-6L-3,1H0L-1,6L3,-1H0Z"/>');
    },
  },
  power_sim: {
    name: '模拟电厂', en: 'FakeGPU Backup', district: 'grid', w: 2, d: 2, h: 1.6, accent: '#7a8fa6',
    rep: '没有真 GPU 时的备用电源，现场 demo 的兜底', tech: 'FakeGPU',
    draw(p) {
      p.box(0, 0, 0, 2, 2, 0.1, 'm-base');
      p.box(0.2, 0.2, 0.1, 0.95, 0.85, 0.8, 'm-wall');
      p.boardL(1.05, 0.32, 1.05, 0.38, 0.7, 'SIM', 10);
      p.box(0.17, 0.17, 0.9, 1.01, 0.91, 0.07, 'm-roof');
      p.cyl(1.5, 0.6, 0.1, 0.32, 1.05, 'm-acc');
      p.cyl(1.5, 0.6, 1.15, 0.12, 0.14, 'm-metal');
      for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) {
        const x = 0.22 + c * 0.55, y = 1.22 + r * 0.38;
        p.box(x + 0.2, y + 0.12, 0.1, 0.05, 0.05, 0.2, 'm-metal');
        p.poly([[x, y, 0.4], [x + 0.46, y, 0.4], [x + 0.46, y + 0.3, 0.2], [x, y + 0.3, 0.2]], 'm-glass f-t');
      }
    },
  },
  coldstore: {
    name: '冷库', en: 'Dataset Store', district: 'grid', w: 2, d: 2, h: 2.0, accent: '#5aa0c8',
    rep: '数据集存储：大小、格式、下载状态', tech: '元数据库',
    draw(p) {
      p.box(0, 0, 0, 2, 2, 0.1, 'm-base');
      p.cyl(0.55, 0.5, 0.1, 0.32, 1.55, 'm-metal', false);
      p.dome(0.55, 0.5, 1.65, 0.32, 0.28, 'm-acc');
      p.cyl(1.35, 0.45, 0.1, 0.3, 1.35, 'm-metal', false);
      p.dome(1.35, 0.45, 1.45, 0.3, 0.26, 'm-acc');
      p.box(0.2, 0.95, 0.1, 1.6, 0.85, 0.85, 'm-wall');
      p.winL(1.8, 0.35, 0.1, 0.5, 0.55, 'm-dark');
      p.boardL(1.8, 1.0, 1.65, 0.42, 0.74, 'DATA', 9);
      p.box(0.15, 0.9, 0.95, 1.7, 0.95, 0.08, 'm-roof');
      p.decalR(1.8, 1.35, 0.45, '<path class="ln m-acc" d="M0,-6V6M-5.2,-3L5.2,3M-5.2,3L5.2,-3"/>');
    },
  },
  weather: {
    name: '气象台', en: 'Deadline Watch', district: 'press_row', w: 2, d: 2, h: 2.6, accent: '#7f8c8d',
    rep: '会议 DDL 和日程，"台风预警"就是截稿临近', tech: 'MCP · 日历', later: true,
    draw(p) {
      p.box(0, 0, 0, 2, 2, 0.1, 'm-base');
      p.box(1.25, 0.35, 0.1, 0.2, 0.2, 2.0, 'm-metal');
      const [dx, dy] = p.I(1.35, 0.45, 2.3);
      p.ell(dx, dy, 16, 9, 'm-white f-t');
      p.ell(dx, dy, 16, 9, 'ln m-metal');
      p.path(`M${r1(dx)},${r1(dy)}L${r1(dx + 6)},${r1(dy - 12)}`, 'ln m-dark');
      p.box(0.25, 0.85, 0.1, 1.3, 0.95, 0.75, 'm-wall');
      p.rowL(1.8, 0.4, 1.4, 0.35, 2, 0.25, 0.3);
      p.box(0.2, 0.8, 0.85, 1.4, 1.05, 0.08, 'm-roof');
      p.flag(1.75, 1.7, 0.1, 1.1);
      p.textL(1.15, 1.75, 1.05, 'DDL', 7);
    },
  },
};

// ---------- props & terrain ----------

export const PROPS = {
  tree_round: { name: '圆冠树', w: 1, d: 1, draw(p) {
    p.box(0.45, 0.45, 0, 0.1, 0.1, 0.42, 'm-trunk');
    const [x, y] = p.I(0.5, 0.5, 0.85);
    p.circ(x, y, 14, 'm-leaf f-l'); p.circ(x + 5, y + 4, 9, 'm-leaf f-r'); p.circ(x - 4, y - 5, 4, 'hl');
  } },
  tree_pine: { name: '松树', w: 1, d: 1, draw(p) {
    p.box(0.46, 0.46, 0, 0.08, 0.08, 0.3, 'm-trunk');
    for (let k = 0; k < 3; k++) {
      const [x, y] = p.I(0.5, 0.5, 0.3 + k * 0.32), w = 14 - k * 3.5, h = 22 - k * 3;
      p.path(`M${r1(x - w)},${r1(y)}L${r1(x)},${r1(y - h)}L${r1(x)},${r1(y + 3)}Z`, 'm-leaf2 f-l', [[x - w, y - h], [x, y + 3]]);
      p.path(`M${r1(x)},${r1(y + 3)}L${r1(x)},${r1(y - h)}L${r1(x + w)},${r1(y)}Z`, 'm-leaf2 f-r', [[x + w, y]]);
    }
  } },
  lamp: { name: '路灯', w: 1, d: 1, draw(p) {
    p.box(0.47, 0.47, 0, 0.06, 0.06, 0.95, 'm-metal');
    const [x, y] = p.I(0.5, 0.5, 1.02);
    p.circ(x, y, 4.5, 'm-win f-l lampbulb');
  } },
  boat: { name: '货船', w: 1.2, d: 0.4, draw(p) {
    p.poly([[0, 0.4, 0], [0.9, 0.4, 0], [0.9, 0.4, 0.16], [0, 0.4, 0.16]], 'm-acc2 f-l');
    p.poly([[0.9, 0.4, 0], [1.2, 0.2, 0], [1.2, 0.2, 0.16], [0.9, 0.4, 0.16]], 'm-acc2 f-r');
    p.poly([[0, 0, 0.16], [0.9, 0, 0.16], [1.2, 0.2, 0.16], [0.9, 0.4, 0.16], [0, 0.4, 0.16]], 'm-white f-t');
    p.box(0.1, 0.08, 0.16, 0.35, 0.25, 0.25, 'm-white');
    p.box(0.55, 0.1, 0.16, 0.25, 0.2, 0.2, 'm-acc');
  } },
  truck: { name: '货车', w: 0.4, d: 1.4, draw(p) { p.truck(0, 0, 'm-acc'); } },
  tile_grass: { name: '草地', w: 1, d: 1, draw(p) { p.box(0, 0, -0.15, 1, 1, 0.15, 'm-grass'); } },
  tile_road: { name: '道路', w: 1, d: 1, draw(p) { p.box(0, 0, -0.15, 1, 1, 0.15, 'm-road'); p.line([[0.5, 0.1, 0], [0.5, 0.4, 0]], 'ln m-white'); p.line([[0.5, 0.6, 0], [0.5, 0.9, 0]], 'ln m-white'); } },
  tile_plaza: { name: '广场地砖', w: 1, d: 1, draw(p) { p.box(0, 0, -0.15, 1, 1, 0.15, 'm-plaza'); p.line([[0.5, 0, 0], [0.5, 1, 0]], 'ln m-base'); p.line([[0, 0.5, 0], [1, 0.5, 0]], 'ln m-base'); } },
  tile_water: { name: '水面', w: 1, d: 1, draw(p) { p.box(0, 0, -0.15, 1, 1, 0.15, 'm-water'); const [x, y] = p.I(0.5, 0.5, 0); p.path(`M${r1(x - 9)},${r1(y)}q4.5,-4 9,0t9,0`, 'ln m-white'); } },
  tile_sand: { name: '沙滩', w: 1, d: 1, draw(p) { p.box(0, 0, -0.15, 1, 1, 0.15, 'm-sand'); } },
};

// ---------- flat icons: items & workers (48×48) ----------

const sheet = (x, y, w, h, m = 'm-white') => `<rect class="${m} f-l" x="${x}" y="${y}" width="${w}" height="${h}" rx="2"/>`;

export const ITEMS = {
  egg: { name: 'idea 蛋', rep: '刚写下的一个 idea，放进孵化场', accent: '#e2b84a', svg:
    '<ellipse class="shadow" cx="24" cy="42" rx="11" ry="3"/>' +
    '<path class="m-egg f-l" d="M24 5C15 5 10 19 10 28c0 8 6 13 14 13s14-5 14-13C38 19 33 5 24 5Z"/>' +
    '<path class="m-egg f-r" d="M24 5c9 0 14 14 14 23 0 8-6 13-14 13 5-3 7-8 7-14C31 18 28 8 24 5Z"/>' +
    '<circle class="m-acc f-l" cx="19" cy="25" r="2.6"/><circle class="m-acc f-l" cx="27" cy="31" r="2"/><circle class="m-acc f-l" cx="26" cy="18" r="1.6"/>' +
    '<ellipse class="hl" cx="17.5" cy="15" rx="2.6" ry="4.5"/>' },
  notes: { name: '调研笔记', rep: '孵化员和调研员从图书馆带回的摘录', accent: '#5f7f9e', svg:
    `<g transform="rotate(-8 24 24)">${sheet(9, 8, 24, 30, 'm-sign')}</g>${sheet(14, 10, 24, 30)}` +
    '<path class="ln m-acc" d="M18 18h16M18 23h16M18 28h11M18 33h14"/>' },
  draft: { name: '方法草案', rep: '方法设计车间产出的问题定义和机制', accent: '#7a5aa6', svg:
    `${sheet(10, 6, 28, 36, 'm-glass')}<circle class="ln m-acc" cx="21" cy="20" r="6"/><path class="ln m-acc" d="M27 20h6M21 26v8M15 34h18"/><path class="ln m-dark" d="M30 30l4 4"/>` },
  table: { name: '结果表', rep: '实验农场的收成', accent: '#6f9a4a', svg:
    `${sheet(8, 8, 32, 32)}<rect class="m-acc f-l" x="13" y="26" width="5" height="9"/><rect class="m-acc f-l" x="21" y="19" width="5" height="16"/><rect class="m-acc2 f-l" x="29" y="14" width="5" height="21"/><path class="ln m-dark" d="M12 36h24"/>` },
  tex: { name: 'TeX 铅字', rep: '印刷厂里的一版 .tex 源码', accent: '#4b5f9e', svg:
    '<rect class="m-metal f-r" x="12" y="14" width="26" height="26" rx="3"/><rect class="m-metal f-t" x="9" y="10" width="26" height="26" rx="3"/>' +
    '<text class="t-sign" x="22" y="28" font-size="11" text-anchor="middle" font-weight="700">TeX</text>' },
  pdf: { name: 'PDF 成品', rep: '印刷厂编译出来、质检通过的论文', accent: '#c4553f', svg:
    '<path class="m-white f-l" d="M11 5h19l8 8v30H11Z"/><path class="m-base f-l" d="M30 5v8h8Z"/>' +
    '<rect class="m-acc f-l" x="8" y="24" width="26" height="11" rx="2"/><text class="t-inv" x="21" y="32.5" font-size="8.5" text-anchor="middle" font-weight="700">PDF</text>' },
  crate: { name: '代码货箱', rep: '从仓库提出来的代码和 baseline', accent: '#c47a3a', svg:
    '<path class="m-acc f-t" d="M24 6L41 14L24 22L7 14Z"/><path class="m-acc f-l" d="M7 14L24 22V42L7 34Z"/><path class="m-acc f-r" d="M41 14L24 22V42L41 34Z"/>' +
    '<text class="t-inv" transform="matrix(.894 .447 0 1 15.5 30)" font-size="8" text-anchor="middle" font-weight="700">&lt;/&gt;</text>' },
  energy: { name: '算力', rep: '从电厂送去实验农场的 GPU 时间', accent: '#e0a030', svg:
    '<path class="m-acc f-l" d="M27 4L11 27h11l-4 17 19-25H25Z"/><path class="m-acc f-r" d="M27 4l-2 15h12L18 44l4-17Z"/>' },
  dataset: { name: '数据集', rep: '冷库里存放、按需取用的数据', accent: '#5aa0c8', svg:
    '<path class="m-acc f-l" d="M10 12v24c0 3.5 6 6 14 6V18c-8 0-14-2.5-14-6Z"/><path class="m-acc f-r" d="M38 12v24c0 3.5-6 6-14 6V18c8 0 14-2.5 14-6Z"/>' +
    '<ellipse class="m-acc f-t" cx="24" cy="12" rx="14" ry="6"/><path class="ln m-white" d="M10 24c0 3.5 6 6 14 6s14-2.5 14-6"/>' },
};

const badge = inner => `<circle class="m-white f-l" cx="36.5" cy="35" r="8"/>${inner}`;
export const WORKERS = {
  hatcher: { name: '孵化员', rep: '查重、写撞车报告', accent: '#e2b84a', mark: '<ellipse class="m-acc f-l" cx="36.5" cy="35.5" rx="3.2" ry="4.2"/>' },
  scout: { name: '调研员', rep: '检索文献、整理 related work', accent: '#5f7f9e', mark: '<circle class="ln m-acc" cx="35.5" cy="34" r="3.2"/><path class="ln m-acc" d="M38 36.5l3 3"/>' },
  designer: { name: '方法设计师', rep: '把 idea 写成可验证的方法', accent: '#7a5aa6', mark: '<path class="ln m-acc" d="M33 40l3.5-9 3.5 9M34.5 37h4"/>' },
  experimenter: { name: '实验员', rep: '排 GPU、跑实验、收结果', accent: '#6f9a4a', mark: '<path class="ln m-acc" d="M35 30v4l-3.5 6h10L38 34v-4"/>' },
  writer: { name: '写手', rep: '在印刷厂里写 TeX', accent: '#4b5f9e', mark: '<path class="ln2 m-acc" d="M33 39l7-7"/>' },
  reviewer: { name: '审稿人', rep: '在质检所里打分、挑毛病', accent: '#3f8f7f', mark: '<path class="ln2 m-acc" d="M32.5 35l3 3 5-6"/>' },
  keeper: { name: '仓管员', rep: '维护仓库：回 issue、管 release', accent: '#c47a3a', mark: '<rect class="ln m-acc" x="32.5" y="31.5" width="8" height="7" rx="1"/><path class="ln m-acc" d="M32.5 34.5h8"/>' },
};

// ---------- standalone SVG helpers ----------

export function drawBuilding(type, o = {}) {
  const b = BUILDINGS[type], p = new Pen();
  b.draw(p, o);
  return p;
}

export function spriteSVG(type, o = {}) {
  const b = BUILDINGS[type], p = drawBuilding(type, o);
  const s = p.svg(`b-${type}`, `--accent:${o.accent || b.accent}`);
  return { ...s, html: `<svg class="sp-svg" viewBox="${s.vb}" xmlns="http://www.w3.org/2000/svg">${s.body}</svg>` };
}

export function propSVG(key) {
  const p = new Pen();
  PROPS[key].draw(p);
  const s = p.svg(`p-${key}`, '--accent:#c47a3a');
  return { ...s, html: `<svg class="sp-svg" viewBox="${s.vb}" xmlns="http://www.w3.org/2000/svg">${s.body}</svg>` };
}

export function itemSVG(key) {
  const it = ITEMS[key];
  return `<svg class="sp-svg ic" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><g class="sp" style="--accent:${it.accent}">${it.svg}</g></svg>`;
}

export function workerBody(key) {
  const w = WORKERS[key];
  return '<ellipse class="shadow" cx="24" cy="44" rx="13" ry="3"/>' +
    '<path class="m-acc f-l" d="M9 44c0-10 6.5-16 15-16s15 6 15 16Z"/><path class="m-acc f-r" d="M24 28c8.5 0 15 6 15 16H24Z"/>' +
    '<circle class="m-egg f-l" cx="24" cy="17" r="9.5"/><circle class="m-dark f-l nost" cx="20.8" cy="17.5" r="1.3"/><circle class="m-dark f-l nost" cx="27.2" cy="17.5" r="1.3"/>' +
    badge(w.mark);
}

export function workerSVG(key) {
  return `<svg class="sp-svg ic" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><g class="sp" style="--accent:${WORKERS[key].accent}">${workerBody(key)}</g></svg>`;
}
