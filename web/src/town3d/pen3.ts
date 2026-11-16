// The sprite Pen in three dimensions: takes the same calls as design/src/sprites.js and collects
// closed solid geometry instead of isometric SVG. Tile (x, y, z) maps to three's (x, z·ZS, y), y up;
// ZS scales the sprites' height so that, seen from the map's angle, the 3D town lines up with the map.

import * as THREE from 'three';
import { Pen, ZU } from '@design/sprites.js';

export const ZS = ZU / (32 * Math.SQRT2 * Math.cos(Math.PI / 6));
export const PX = 1 / 37; // one sprite pixel on a face, in tile units

export type V3 = [number, number, number];
export const EDGES = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];

// a sign's text or a decal's inner SVG, painted on a +y face (L, left on the map) or a +x face (R)
export interface Glyph {
  kind: 'text' | 'svg';
  body: string;
  size: number;
  at: V3;
  face: 'L' | 'R';
}

const matOf = (cls: string) => cls.split(/\s+/).find(c => c.startsWith('m-'))?.slice(2) ?? null;
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

export class Pen3 extends Pen {
  pos = new Map<string, number[]>();
  nrm = new Map<string, number[]>();
  ink: number[] = [];
  strokes = new Map<string, number[]>();
  glyphs: Glyph[] = [];
  puffs: { at: V3; s: number }[] = [];

  constructor(k = 1, public ox = 0, public oy = 0) {
    super(k);
  }

  W(x: number, y: number, z = 0): V3 {
    const k = this.k;
    return [this.ox + x * k, z * k * ZS, this.oy + y * k];
  }

  private arr(m: string) {
    if (!this.pos.has(m)) { this.pos.set(m, []); this.nrm.set(m, []); }
    return [this.pos.get(m)!, this.nrm.get(m)!];
  }

  // a flat convex polygon, fan-triangulated
  face(P: V3[], m: string | null, ink = true) {
    if (!m || P.length < 3) return;
    const [pos, nrm] = this.arr(m);
    let n: V3 = [0, 1, 0];
    for (let i = 1; i + 1 < P.length; i++) {
      const u = sub(P[i], P[0]), v = sub(P[i + 1], P[0]);
      const c: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const l = Math.hypot(...c);
      if (l > 1e-9) { n = [c[0] / l, c[1] / l, c[2] / l]; break; }
    }
    for (let i = 1; i + 1 < P.length; i++) {
      pos.push(...P[0], ...P[i], ...P[i + 1]);
      nrm.push(...n, ...n, ...n);
    }
    if (ink) for (let i = 0; i < P.length; i++) this.edge(P[i], P[(i + 1) % P.length]);
  }

  edge(a: V3, b: V3) { this.ink.push(...a, ...b); }

  // a three.js geometry, already placed in the world, merged into the material's buffers
  geom(g: THREE.BufferGeometry, m: string | null) {
    if (!m) return;
    const [pos, nrm] = this.arr(m);
    const ng = g.index ? g.toNonIndexed() : g;
    pos.push(...(ng.getAttribute('position').array as Float32Array));
    nrm.push(...(ng.getAttribute('normal').array as Float32Array));
    if (ng !== g) ng.dispose();
    g.dispose();
  }

  ring(c: V3, r: number, n = 20) {
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      this.edge([c[0] + Math.cos(a0) * r, c[1], c[2] + Math.sin(a0) * r], [c[0] + Math.cos(a1) * r, c[1], c[2] + Math.sin(a1) * r]);
    }
  }

  // world-space parts for what the sprites draw in screen space
  sphereW(c: V3, r: number, m: string, sy = 1) {
    const g = new THREE.SphereGeometry(r, 18, 12);
    g.scale(1, sy, 1);
    g.translate(...c);
    this.geom(g, m);
  }

  cylW(c: V3, r: number, h: number, m: string, rTop = r) {
    const g = new THREE.CylinderGeometry(rTop, r, h, 18);
    g.translate(c[0], c[1] + h / 2, c[2]);
    this.geom(g, m);
  }

  coneW(c: V3, r: number, h: number, m: string) {
    const g = new THREE.ConeGeometry(r, h, 14);
    g.translate(c[0], c[1] + h / 2, c[2]);
    this.geom(g, m);
  }

  // a box in three's own units and axes (y up), for the parts that exist only in 3D
  block(x: number, y: number, z: number, w: number, h: number, d: number, m: string | null, ink = true) {
    const c: V3[] = [[x, y, z], [x + w, y, z], [x + w, y, z + d], [x, y, z + d], [x, y + h, z], [x + w, y + h, z], [x + w, y + h, z + d], [x, y + h, z + d]];
    for (const f of [[0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1], [3, 2, 6, 7], [0, 3, 7, 4], [1, 5, 6, 2]]) this.face(f.map(i => c[i]), m, false);
    if (ink) for (const [a, b] of EDGES) this.edge(c[a], c[b]);
  }

  tube(a: V3, b: V3, r: number, m: string, seg = 14, ink = false) {
    const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]), len = d.length();
    if (len < 1e-6) return;
    const g = new THREE.CylinderGeometry(r, r, len, seg);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
    g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    this.geom(g, m);
    if (ink) this.edge(a, b);
  }

  override poly(pts: number[][], cls: string) {
    this.face(pts.map(q => this.W(q[0], q[1], q[2] ?? 0)), matOf(cls));
    return this;
  }

  override line(pts: number[][], cls: string) {
    const m = matOf(cls);
    if (!m) return this;
    if (!this.strokes.has(m)) this.strokes.set(m, []);
    const s = this.strokes.get(m)!;
    for (let i = 0; i + 1 < pts.length; i++) s.push(...this.W(pts[i][0], pts[i][1], pts[i][2] ?? 0), ...this.W(pts[i + 1][0], pts[i + 1][1], pts[i + 1][2] ?? 0));
    return this;
  }

  // screen-space drawing has no 3D meaning; the buildings that use it get their parts in scene.ts extras()
  override path() { return this; }
  override ell() { return this; }
  override circ() { return this; }

  override box(x: number, y: number, z: number, w: number, d: number, h: number, m: string) {
    const c = [
      this.W(x, y, z), this.W(x + w, y, z), this.W(x + w, y + d, z), this.W(x, y + d, z),
      this.W(x, y, z + h), this.W(x + w, y, z + h), this.W(x + w, y + d, z + h), this.W(x, y + d, z + h),
    ];
    const mt = matOf(m);
    for (const f of [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]]) this.face(f.map(i => c[i]), mt, false);
    for (const [a, b] of EDGES) this.edge(c[a], c[b]);
    return this;
  }

  override gableX(x: number, y: number, z: number, w: number, d: number, rh: number, m: string, me = m) {
    const ym = y + d / 2, zt = z + rh, a = matOf(m), e = matOf(me), W = this.W.bind(this);
    this.face([W(x, y, z), W(x + w, y, z), W(x + w, ym, zt), W(x, ym, zt)], a);
    this.face([W(x, y + d, z), W(x, ym, zt), W(x + w, ym, zt), W(x + w, y + d, z)], a);
    this.face([W(x + w, y, z), W(x + w, y + d, z), W(x + w, ym, zt)], e);
    this.face([W(x, y, z), W(x, ym, zt), W(x, y + d, z)], e);
    this.face([W(x, y, z), W(x, y + d, z), W(x + w, y + d, z), W(x + w, y, z)], a, false);
    return this;
  }

  override gableY(x: number, y: number, z: number, w: number, d: number, rh: number, m: string, me = m) {
    const xm = x + w / 2, zt = z + rh, a = matOf(m), e = matOf(me), W = this.W.bind(this);
    this.face([W(x, y, z), W(xm, y, zt), W(xm, y + d, zt), W(x, y + d, z)], a);
    this.face([W(x + w, y, z), W(x + w, y + d, z), W(xm, y + d, zt), W(xm, y, zt)], a);
    this.face([W(x, y + d, z), W(xm, y + d, zt), W(x + w, y + d, z)], e);
    this.face([W(x, y, z), W(x + w, y, z), W(xm, y, zt)], e);
    this.face([W(x, y, z), W(x + w, y, z), W(x + w, y + d, z), W(x, y + d, z)], a, false);
    return this;
  }

  override pyramid(x: number, y: number, z: number, w: number, d: number, rh: number, m: string) {
    const t = this.W(x + w / 2, y + d / 2, z + rh), mt = matOf(m), W = this.W.bind(this);
    const b = [W(x, y, z), W(x + w, y, z), W(x + w, y + d, z), W(x, y + d, z)];
    for (let i = 0; i < 4; i++) this.face([b[i], b[(i + 1) % 4], t], mt);
    this.face(b, mt, false);
    return this;
  }

  override sawtooth(x: number, y: number, z: number, w: number, d: number, n: number, th: number, m: string, mg: string) {
    const s = w / n, a = matOf(m), g = matOf(mg), W = this.W.bind(this);
    for (let i = 0; i < n; i++) {
      const x0 = x + i * s, x1 = x0 + s;
      this.face([W(x0, y, z), W(x0, y + d, z), W(x1, y + d, z + th), W(x1, y, z + th)], a);
      this.face([W(x0, y + d, z), W(x1, y + d, z), W(x1, y + d, z + th)], a);
      this.face([W(x0, y, z), W(x1, y, z + th), W(x1, y, z)], a);
      this.face([W(x1, y, z), W(x1, y + d, z), W(x1, y + d, z + th), W(x1, y, z + th)], g);
    }
    this.face([W(x, y, z), W(x + w, y, z), W(x + w, y + d, z), W(x, y + d, z)], a, false);
    return this;
  }

  override cyl(cx: number, cy: number, z: number, r: number, h: number, m: string) {
    const c = this.W(cx, cy, z), R = r * this.k, H = h * this.k * ZS;
    this.cylW(c, R, H, matOf(m)!);
    this.ring(c, R);
    this.ring([c[0], c[1] + H, c[2]], R);
    return this;
  }

  override dome(cx: number, cy: number, z: number, r: number, hd: number, m: string) {
    const c = this.W(cx, cy, z), R = r * this.k;
    const g = new THREE.SphereGeometry(1, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    g.scale(R, hd * this.k * ZS, R);
    g.translate(...c);
    this.geom(g, matOf(m));
    this.ring(c, R);
    return this;
  }

  // [radius, height] pairs from the bottom up, turned round the vertical axis
  private lathe(c: V3, prof: [number, number][], m: string | null) {
    const g = new THREE.LatheGeometry(prof.map(([r, h]) => new THREE.Vector2(r, h)), 22);
    g.translate(...c);
    this.geom(g, m);
  }

  override egg(cx: number, cy: number, z: number, r: number, h: number, m: string) {
    const c = this.W(cx, cy, z), R = r * this.k, H = h * this.k * ZS, prof: [number, number][] = [[0, 0]];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12, u = 1 - t;
      prof.push([u * u * u * R + 3 * u * u * t * R + 3 * u * t * t * 0.62 * R, 3 * u * u * t * 0.55 * H + 3 * u * t * t * H + t * t * t * H]);
    }
    this.lathe(c, prof, matOf(m));
    this.ring(c, R);
    return this;
  }

  override cooling(cx: number, cy: number, z: number, r: number, h: number, m: string) {
    const c = this.W(cx, cy, z), R = r * this.k, H = h * this.k * ZS, prof: [number, number][] = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10, u = 1 - t;
      prof.push([u * u * R + 2 * u * t * 0.6 * R + t * t * 0.7 * R, 2 * u * t * 0.62 * H + t * t * H]);
    }
    this.lathe(c, prof, matOf(m));
    const inner = new THREE.CircleGeometry(0.7 * R * 0.92, 20);
    inner.rotateX(-Math.PI / 2);
    inner.translate(c[0], c[1] + H * 0.96, c[2]);
    this.geom(inner, 'dark');
    this.ring(c, R);
    this.ring([c[0], c[1] + H, c[2]], 0.7 * R);
    return this;
  }

  // how far a face sits off its wall: one laid over another sits further out, or the two z-fight and flicker
  private laid = new Map<string, number[][]>();
  private out(wall: string, a0: number, a1: number, z0: number, z1: number) {
    const on = this.laid.get(wall) ?? [];
    const level = on.reduce((n, f) => (f[0] < a1 && a0 < f[1] && f[2] < z1 && z0 < f[3] ? Math.max(n, f[4] + 1) : n), 0);
    on.push([a0, a1, z0, z1, level]);
    this.laid.set(wall, on);
    return (0.012 + Math.min(level, 2) * 0.003) / this.k;
  }

  override winL(Y: number, x0: number, z0: number, w: number, h: number, m = 'm-win') {
    const W = this.W.bind(this), y = Y + this.out(`L${Y}`, x0, x0 + w, z0, z0 + h);
    this.face([W(x0, y, z0), W(x0 + w, y, z0), W(x0 + w, y, z0 + h), W(x0, y, z0 + h)], matOf(m));
    return this;
  }

  override winR(X: number, y0: number, z0: number, w: number, h: number, m = 'm-win') {
    const W = this.W.bind(this), x = X + this.out(`R${X}`, y0, y0 + w, z0, z0 + h);
    this.face([W(x, y0, z0), W(x, y0 + w, z0), W(x, y0 + w, z0 + h), W(x, y0, z0 + h)], matOf(m));
    return this;
  }

  override textL(x: number, Y: number, z: number, s: string, size = 10) {
    this.glyphs.push({ kind: 'text', body: s, size: size * this.k, at: this.W(x, Y + 0.02 / this.k, z), face: 'L' });
    return this;
  }

  override textR(X: number, y: number, z: number, s: string, size = 10) {
    this.glyphs.push({ kind: 'text', body: s, size: size * this.k, at: this.W(X + 0.02 / this.k, y, z), face: 'R' });
    return this;
  }

  override decalL(x: number, Y: number, z: number, inner: string) {
    this.glyphs.push({ kind: 'svg', body: inner, size: 24, at: this.W(x, Y + 0.02 / this.k, z), face: 'L' });
    return this;
  }

  override decalR(X: number, y: number, z: number, inner: string) {
    this.glyphs.push({ kind: 'svg', body: inner, size: 24, at: this.W(X + 0.02 / this.k, y, z), face: 'R' });
    return this;
  }

  override smoke(cx: number, cy: number, z: number, s = 1) {
    this.puffs.push({ at: this.W(cx, cy, z), s: s * this.k });
    return this;
  }

  override figure(x: number, y: number, m: string) {
    const c = this.W(x, y, 0);
    this.cylW(c, 0.1, 0.3, matOf(m)!, 0.08);
    this.sphereW([c[0], c[1] + 0.42, c[2]], 0.1, 'egg');
    this.ring(c, 0.1, 12);
    return this;
  }
}
