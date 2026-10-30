// The land round the town, made up as you go. Past the board the world carries on: the sea
// on the harbour side, and on the others first meadows, then rolling hills in terraces,
// woods, fields, lakes and now and then a village with a windmill. It is built in chunks of
// 16×16 tiles round wherever you are, nearest first and a few each frame, and the chunks
// left behind are dropped again. Everything comes from a fixed noise, so the land is the
// same every time and the ground under you can be asked for (top) without building any of
// it. From the air, at the map's view, it fades away and leaves the board on its paper.

import * as THREE from 'three';
import { N, tileMat } from '@design/world.js';
import type { World } from './body';
import { INK, TOP, WADE_Y, WATER_Y, type Materials } from './scene';
import { PX, ZS } from './pen3';

const CH = 16; // tiles a chunk
const STEP = 0.2; // terraces, a step you walk up
const BANK = WATER_Y - 0.05;

type Kind = 'water' | 'sand' | 'grass' | 'grass2' | 'field' | 'forest' | 'stone';
interface Tile { h: number; kind: Kind; tree: number; seed: number }

// ---------- noise ----------

function hash(x: number, y: number, s: number) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s, 982451653) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function vnoise(x: number, y: number, s: number) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash(x0, y0, s), b = hash(x0 + 1, y0, s), c = hash(x0, y0 + 1, s), d = hash(x0 + 1, y0 + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x: number, y: number, s: number) {
  let v = 0, amp = 0.5, f = 1;
  for (let o = 0; o < 4; o++) { v += vnoise(x * f, y * f, s + o * 17) * amp; f *= 2.03; amp *= 0.5; }
  return v / 0.9375; // 0..1
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const onBoard = (x: number, y: number) => x >= 0 && y >= 0 && x < N && y < N;

// the board's own tiles, as the land sees them from outside: ground at 0, or the sea
const boardTop = (tx: number, ty: number) => (tileMat(tx, ty) === 'water' ? BANK : 0);

// ---------- what is where ----------

const cache = new Map<number, Tile>();

export function tileAt(tx: number, ty: number): Tile {
  const key = tx * 65536 + ty;
  let t = cache.get(key);
  if (t) return t;
  if (cache.size > 60000) cache.clear();
  const dx = Math.max(0, -tx, tx - (N - 1)), dy = Math.max(0, -ty, ty - (N - 1)), d = Math.hypot(dx, dy);
  // the harbour side stays sea for a good way out; the other sides stay land close in
  const seaward = tx < 0 || ty < 0;
  const bias = seaward ? -1.1 * clamp01(1 - d / 16) : 0.9 * clamp01(1 - d / 6);
  const L = (fbm(tx / 26, ty / 26, 1) - 0.5) * 1.7 + 0.12 + bias;
  const seed = hash(tx, ty, 5);
  if (L <= 0) t = { h: 0, kind: 'water', tree: 0, seed };
  else {
    const ramp = clamp01((d - 3) / 12); // flat by the town, hillier further out
    const h = Math.floor(Math.min(3.4, Math.pow(L, 1.25) * 3.6 * ramp) / STEP) * STEP;
    const wood = fbm(tx / 17, ty / 17, 7), crop = fbm(tx / 13, ty / 13, 9);
    let kind: Kind = L < 0.07 ? 'sand' : h >= 2.4 ? 'stone' : wood > 0.58 ? 'forest' : crop > 0.62 && h <= 0.6 && d > 4 ? 'field' : hash(tx, ty, 3) < 0.3 ? 'grass2' : 'grass';
    const tree = kind === 'forest' ? (seed < 0.55 ? 1 : 0) : (kind === 'grass' || kind === 'grass2') && seed < 0.035 ? 1 : 0;
    if (kind === 'sand' && h > 0) kind = 'grass';
    t = { h, kind, tree, seed };
  }
  cache.set(key, t);
  return t;
}

// a village every so often: a few cottages round a windmill, out of sight of the town
function villageOf(tx: number, ty: number) {
  const gx = Math.floor(tx / 36), gy = Math.floor(ty / 36);
  if (hash(gx, gy, 11) > 0.55) return null;
  const cx = gx * 36 + 10 + Math.floor(hash(gx, gy, 12) * 16), cy = gy * 36 + 10 + Math.floor(hash(gx, gy, 13) * 16);
  const d = Math.hypot(Math.max(0, -cx, cx - N), Math.max(0, -cy, cy - N));
  return d > 10 ? { cx, cy } : null;
}

function flat(tx: number, ty: number, t: Tile) {
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([a, b]) => { const n = tileAt(tx + a, ty + b); return n.kind !== 'water' && n.h === t.h; });
}

const cottageAt = (tx: number, ty: number, t: Tile) => {
  if (t.kind === 'water' || t.kind === 'forest' || t.kind === 'stone' || t.kind === 'sand') return false;
  const v = villageOf(tx, ty);
  if (!v || (tx === v.cx && ty === v.cy)) return false;
  return Math.hypot(tx - v.cx, ty - v.cy) < 5 && hash(tx, ty, 41) < 0.24 && flat(tx, ty, t);
};

const millAt = (tx: number, ty: number, t: Tile) => {
  const v = villageOf(tx, ty);
  return !!v && tx === v.cx && ty === v.cy && t.kind !== 'water';
};

const treeSpot = (tx: number, ty: number, t: Tile) => [tx + 0.5 + (hash(tx, ty, 21) - 0.5) * 0.3, ty + 0.5 + (hash(tx, ty, 22) - 0.5) * 0.3, 0.85 + t.seed * 0.5] as const;

// ---------- the ground you stand on ----------

export function landTop(x: number, y: number) {
  const tx = Math.floor(x), ty = Math.floor(y), t = tileAt(tx, ty);
  if (t.kind === 'water') return WADE_Y;
  let h = t.h;
  if (t.tree && !cottageAt(tx, ty, t)) {
    const [px, py, s] = treeSpot(tx, ty, t);
    if ((x - px) ** 2 + (y - py) ** 2 < 0.17 * 0.17) h = Math.max(h, t.h + 0.9 * s);
  }
  if (cottageAt(tx, ty, t) && x > tx + 0.15 && x < tx + 0.85 && y > ty + 0.2 && y < ty + 0.8) {
    h = t.h + 0.42 + 0.3 * (1 - Math.abs(y - (ty + 0.5)) / 0.36); // up the slope of its roof
  }
  if (millAt(tx, ty, t) && (x - tx - 0.5) ** 2 + (y - ty - 0.5) ** 2 < 0.3 * 0.3) h = t.h + 1.55;
  return h;
}

export const landWet = (x: number, y: number) => tileAt(Math.floor(x), Math.floor(y)).kind === 'water';

// the whole world: the town on its board, the land made up round it
export function worldOf(town: World | null): World {
  return {
    bounds: [-1e6, -1e6, 1e6, 1e6],
    ceiling: 40,
    top: (x, y) => (onBoard(x, y) ? town?.top(x, y) ?? 0 : landTop(x, y)),
    wet: (x, y) => (onBoard(x, y) ? !!town?.wet?.(x, y) : landWet(x, y)),
  };
}

// ---------- building a chunk ----------

type V3 = [number, number, number];
interface Shape { pos: Float32Array; nrm: Float32Array }

function shape(...gs: THREE.BufferGeometry[]): Shape {
  const pos: number[] = [], nrm: number[] = [];
  for (const g of gs) {
    if (!g.getAttribute('normal')) g.computeVertexNormals(); // before unindexing, so round things stay smooth
    const n = g.index ? g.toNonIndexed() : g;
    pos.push(...(n.getAttribute('position').array as Float32Array));
    nrm.push(...(n.getAttribute('normal').array as Float32Array));
    if (n !== g) n.dispose();
    g.dispose();
  }
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm) };
}

// the town's two trees, as in drawProp, and a windmill's sails
const PINE = [0, 1, 2].map(k => {
  const r = (14 - k * 3.5) * PX, h = (22 - k * 3) * PX * 1.06;
  return new THREE.ConeGeometry(r, h, 8).translate(0, (0.3 + k * 0.32) * ZS + h / 2, 0);
});
const SHAPES = {
  pine: shape(...PINE),
  crown: shape(new THREE.SphereGeometry(14 * PX, 12, 8).scale(1, 0.92, 1).translate(0, 0.85 * ZS, 0), new THREE.SphereGeometry(9 * PX, 10, 7).translate(0.12, 0.85 * ZS - 0.08, 0.1)),
  trunk: shape(new THREE.BoxGeometry(0.09, 0.42 * ZS, 0.09).translate(0, 0.21 * ZS, 0)),
  tower: shape(new THREE.CylinderGeometry(0.17, 0.27, 1.25, 8).translate(0, 0.625, 0)),
  cap: shape(new THREE.ConeGeometry(0.24, 0.3, 8).translate(0, 1.4, 0)),
};

class Buf {
  pos: number[] = []; nrm: number[] = []; col: number[] = []; ink: number[] = [];

  tri(a: V3, b: V3, c: V3, col: THREE.Color) {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    n = n.map(q => q / l);
    for (const p of [a, b, c]) { this.pos.push(...p); this.nrm.push(...n); this.col.push(col.r, col.g, col.b); }
  }
  quad(a: V3, b: V3, c: V3, d: V3, col: THREE.Color) { this.tri(a, b, c, col); this.tri(a, c, d, col); }
  edge(a: V3, b: V3) { this.ink.push(...a, ...b); }

  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, col: THREE.Color, ink = false) {
    const c: V3[] = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]];
    for (const [a, b, d, e] of [[4, 7, 6, 5], [0, 4, 5, 1], [3, 2, 6, 7], [0, 3, 7, 4], [1, 5, 6, 2]]) this.quad(c[a], c[b], c[d], c[e], col);
    if (ink) for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) this.edge(c[a], c[b]);
  }

  put(s: Shape, x: number, y: number, z: number, k: number, col: THREE.Color) {
    for (let i = 0; i < s.pos.length; i += 3) {
      this.pos.push(x + s.pos[i] * k, y + s.pos[i + 1] * k, z + s.pos[i + 2] * k);
      this.nrm.push(s.nrm[i], s.nrm[i + 1], s.nrm[i + 2]);
      this.col.push(col.r, col.g, col.b);
    }
  }

  mesh(mat: THREE.Material) {
    if (!this.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    return new THREE.Mesh(g, mat);
  }
}

interface Chunk { group: THREE.Group; sails: THREE.Object3D[] }

export interface Land {
  root: THREE.Group;
  update(x: number, y: number, t: number, reach: number): void; // build round (x, y) out to `reach` tiles, drop what is far
  setAir(a: number): void;
  setNight(n: number): void;
  dispose(): void;
}

export function buildLand(mats: Materials): Land {
  const root = new THREE.Group();
  const C = (m: string, k = 1) => new THREE.Color(mats.color(m, '#c47a3a') ?? m).multiplyScalar(k);
  const top = (m: string) => C(m, 1 / TOP); // tops are dimmed like the town's ground, so lit from above they match it
  const COL = {
    grass: top('grass'), grass2: top('grass2'), sand: top('sand'), soil: top('soil'), stone: top('#cfc4ae'), forest: top('#c9d6a6'),
    dirt: C('edge'), lip: C('#c3cf9a'), trunk: C('trunk'), leaf: C('leaf'), leaf2: C('leaf2'), crop: C('crop'), crop2: C('crop2'),
    rock: C('#bfb4a0'), wall: C('wall'), white: C('white'), dark: C('dark'), wood: C('wood'),
  };
  const ROOFS = ['#a65a3f', '#6b4b33', '#56708a', '#7d5a3a'].map(c => C(c));
  const FLOWERS = ['#e0705c', '#efc24a', '#f6f1e4', '#b08ad0'].map(c => C(c));

  // the land's own materials, so that all of it can fade at once on the way up to the map
  const solid = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const lit = new THREE.MeshLambertMaterial({ color: mats.color('win', '#c47a3a') ?? '#6f5b45', side: THREE.DoubleSide });
  const ink = new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0.5 });
  const water = new THREE.MeshLambertMaterial({ color: C('water', 1 / TOP) });
  const sail = new THREE.MeshLambertMaterial({ color: '#f6efe0', side: THREE.DoubleSide });
  const all = [solid, lit, ink, water, sail];

  // the sea under everything, kept under you wherever you go
  const seaGeo = new THREE.PlaneGeometry(700, 700).rotateX(-Math.PI / 2);
  const sea = new THREE.Mesh(seaGeo, water);
  sea.position.y = WATER_Y - 0.004;
  sea.renderOrder = -2;
  root.add(sea);

  const chunks = new Map<string, Chunk>();
  const heightOf = (tx: number, ty: number) => {
    if (onBoard(tx, ty)) return boardTop(tx, ty);
    const t = tileAt(tx, ty);
    return t.kind === 'water' ? BANK : t.h;
  };

  function build(cx: number, cy: number): Chunk {
    const b = new Buf(), w = new Buf(), group = new THREE.Group(), sails: THREE.Object3D[] = [];
    for (let tx = cx * CH; tx < cx * CH + CH; tx++) for (let ty = cy * CH; ty < cy * CH + CH; ty++) {
      if (onBoard(tx, ty)) continue;
      const t = tileAt(tx, ty);
      if (t.kind === 'water') continue;
      const h = t.h, x0 = tx, x1 = tx + 1, z0 = ty, z1 = ty + 1;
      // the top, and a side down to each lower neighbour: dirt with a strip of turf, outlined in ink
      b.quad([x0, h, z0], [x0, h, z1], [x1, h, z1], [x1, h, z0], COL[(t.kind === 'field' ? 'soil' : t.kind) as 'grass']);
      const sides: [number, number, V3, V3][] = [[-1, 0, [x0, 0, z1], [x0, 0, z0]], [1, 0, [x1, 0, z0], [x1, 0, z1]], [0, -1, [x0, 0, z0], [x1, 0, z0]], [0, 1, [x1, 0, z1], [x0, 0, z1]]];
      for (const [dx, dy, a, c] of sides) {
        const hn = heightOf(tx + dx, ty + dy);
        if (hn >= h - 1e-6) continue;
        const lip = t.kind === 'sand' ? COL.sand : COL.lip, mid = Math.max(hn, h - 0.045);
        b.quad([a[0], h, a[2]], [c[0], h, c[2]], [c[0], mid, c[2]], [a[0], mid, a[2]], lip);
        if (mid > hn) b.quad([a[0], mid, a[2]], [c[0], mid, c[2]], [c[0], hn, c[2]], [a[0], hn, a[2]], COL.dirt);
        b.edge([a[0], h, a[2]], [c[0], h, c[2]]);
      }
      const r = (s: number) => hash(tx, ty, s);
      if (millAt(tx, ty, t)) {
        // a windmill: a tapering tower, a cap, and sails that turn
        b.put(SHAPES.tower, tx + 0.5, h, ty + 0.5, 1, COL.wall);
        b.put(SHAPES.cap, tx + 0.5, h, ty + 0.5, 1, ROOFS[0]);
        b.box(tx + 0.44, h, ty + 0.75, tx + 0.56, h + 0.22, ty + 0.78, COL.dark);
        const hub = new THREE.Group();
        for (let i = 0; i < 4; i++) {
          const arm = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.62, 0.012).translate(0.06, 0.36, 0), sail);
          arm.rotation.z = i * Math.PI / 2;
          hub.add(arm);
        }
        hub.position.set(tx + 0.5, h + 1.18, ty + 0.5 + 0.3);
        group.add(hub);
        sails.push(hub);
        continue;
      }
      if (cottageAt(tx, ty, t)) {
        // a cottage: walls, a gabled roof with a little overhang, a door, two windows, a chimney
        const X0 = tx + 0.15, X1 = tx + 0.85, Z0 = ty + 0.2, Z1 = ty + 0.8, wh = h + 0.42, rt = h + 0.72, zm = ty + 0.5, roof = ROOFS[Math.floor(r(43) * ROOFS.length)];
        b.box(X0, h, Z0, X1, wh, Z1, COL.wall, true);
        b.quad([X0 - 0.05, wh - 0.03, Z0 - 0.06], [X1 + 0.05, wh - 0.03, Z0 - 0.06], [X1 + 0.05, rt, zm], [X0 - 0.05, rt, zm], roof);
        b.quad([X0 - 0.05, wh - 0.03, Z1 + 0.06], [X0 - 0.05, rt, zm], [X1 + 0.05, rt, zm], [X1 + 0.05, wh - 0.03, Z1 + 0.06], roof);
        b.tri([X0, wh, Z0], [X0, rt - 0.02, zm], [X0, wh, Z1], COL.wall);
        b.tri([X1, wh, Z0], [X1, wh, Z1], [X1, rt - 0.02, zm], COL.wall);
        for (const [a, c] of [[[X0 - 0.05, wh - 0.03, Z0 - 0.06], [X1 + 0.05, wh - 0.03, Z0 - 0.06]], [[X0 - 0.05, rt, zm], [X1 + 0.05, rt, zm]], [[X0 - 0.05, wh - 0.03, Z1 + 0.06], [X1 + 0.05, wh - 0.03, Z1 + 0.06]]] as V3[][]) b.edge(a, c);
        b.box(X1 - 0.18, rt - 0.12, Z0 + 0.1, X1 - 0.1, rt + 0.1, Z0 + 0.18, COL.dark);
        b.box(tx + 0.44, h, Z1, tx + 0.56, h + 0.24, Z1 + 0.006, COL.dark);
        for (const wx of [X0 + 0.08, X1 - 0.2]) w.box(wx, h + 0.2, Z1, wx + 0.12, h + 0.32, Z1 + 0.008, COL.white);
        continue;
      }
      if (t.tree) {
        const [px, py, s] = treeSpot(tx, ty, t), pine = t.kind === 'forest' ? r(23) < 0.6 || h > 1 : r(23) < 0.4;
        const tint = COL.leaf.clone().lerp(r(24) < 0.5 ? COL.leaf2 : COL.crop2, r(25) * 0.35);
        b.put(SHAPES.trunk, px, h, py, s, COL.trunk);
        b.put(pine ? SHAPES.pine : SHAPES.crown, px, h, py, s, pine ? COL.leaf2.clone().lerp(tint, 0.3) : tint);
        continue;
      }
      if (t.kind === 'field') {
        // rows of a crop, the same crop over the whole field
        const c = fbm(tx / 13, ty / 13, 10) > 0.5 ? COL.crop2 : COL.crop;
        for (let row = 0; row < 3; row++) {
          const z = ty + 0.2 + row * 0.3;
          b.box(tx + 0.06, h, z - 0.035, tx + 0.94, h + 0.1 + r(30 + row) * 0.05, z + 0.035, c);
        }
      } else if (t.kind === 'grass' || t.kind === 'grass2' || t.kind === 'forest') {
        if (r(26) < 0.12) for (let i = 0; i < 3; i++) {
          const fx = tx + 0.2 + hash(tx + i, ty, 27) * 0.6, fz = ty + 0.2 + hash(tx, ty + i, 28) * 0.6, fh = 0.07 + hash(i, tx, ty) * 0.05;
          b.box(fx - 0.008, h, fz - 0.008, fx + 0.008, h + fh, fz + 0.008, COL.leaf);
          b.box(fx - 0.026, h + fh, fz - 0.026, fx + 0.026, h + fh + 0.036, fz + 0.026, FLOWERS[Math.floor(r(29) * FLOWERS.length)]);
        } else if (r(26) < 0.32) for (let i = 0; i < 3; i++) {
          const gx = tx + 0.15 + hash(tx, ty + i, 31) * 0.7, gz = ty + 0.15 + hash(tx + i, ty, 32) * 0.7;
          b.box(gx, h, gz, gx + 0.014, h + 0.05 + hash(gx, gz, 33) * 0.05, gz + 0.014, COL.leaf2);
        }
      } else if (t.kind === 'stone' || (t.kind === 'sand' && r(34) < 0.2)) {
        const s = 0.07 + r(35) * 0.1, rx = tx + 0.2 + r(36) * 0.5, rz = ty + 0.2 + r(37) * 0.5;
        b.box(rx, h, rz, rx + s * 1.4, h + s * 0.6, rz + s, COL.rock, true);
      }
    }
    const m = b.mesh(solid);
    if (m) { m.receiveShadow = false; group.add(m); }
    const lw = w.mesh(lit);
    if (lw) group.add(lw);
    if (b.ink.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.ink, 3));
      group.add(new THREE.LineSegments(g, ink));
    }
    root.add(group);
    return { group, sails };
  }

  function drop(key: string) {
    const c = chunks.get(key)!;
    root.remove(c.group);
    c.group.traverse(o => { if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) o.geometry.dispose(); });
    chunks.delete(key);
  }

  return {
    root,
    update(x, y, t, reach) {
      sea.position.x = Math.round(x / 10) * 10;
      sea.position.z = Math.round(y / 10) * 10;
      const R = Math.ceil(reach / CH), pcx = Math.floor(x / CH), pcy = Math.floor(y / CH);
      const want: [number, number, number][] = [];
      for (let a = -R; a <= R; a++) for (let b = -R; b <= R; b++) {
        const cx = pcx + a, cy = pcy + b;
        // the distance to the chunk's nearest point
        const dx = Math.max(cx * CH - x, 0, x - (cx + 1) * CH), dy = Math.max(cy * CH - y, 0, y - (cy + 1) * CH);
        const d = Math.hypot(dx, dy);
        if (d > reach || chunks.has(`${cx},${cy}`)) continue;
        if (cx * CH >= 0 && cy * CH >= 0 && (cx + 1) * CH <= N && (cy + 1) * CH <= N) continue; // the town's own
        want.push([d, cx, cy]);
      }
      want.sort((p, q) => p[0] - q[0]);
      const t0 = performance.now();
      for (const [, cx, cy] of want) {
        chunks.set(`${cx},${cy}`, build(cx, cy));
        if (performance.now() - t0 > 5) break; // a few a frame, nearest first
      }
      for (const key of [...chunks.keys()]) {
        const [cx, cy] = key.split(',').map(Number);
        const dx = Math.max(cx * CH - x, 0, x - (cx + 1) * CH), dy = Math.max(cy * CH - y, 0, y - (cy + 1) * CH);
        if (Math.hypot(dx, dy) > reach + CH * 1.5) drop(key);
      }
      for (const c of chunks.values()) for (const s of c.sails) s.rotation.z = -t * 0.6;
    },
    setAir(a) {
      root.visible = a < 0.98;
      const fade = a > 0.01;
      for (const m of all) {
        m.transparent = fade || m === ink;
        m.opacity = (m === ink ? 0.5 : 1) * (1 - a);
        m.depthWrite = !fade;
      }
    },
    setNight(n) { lit.emissive.set('#ffc46b').multiplyScalar(n * 0.9); },
    dispose() {
      for (const key of [...chunks.keys()]) drop(key);
      seaGeo.dispose();
      for (const m of all) m.dispose();
    },
  };
}
