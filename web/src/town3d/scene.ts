// The town as a three.js scene, built from the same data as the map: ground tiles from
// tileMat, yards and trees from world.js, every building from its own sprite drawing
// (through Pen3), coloured from the ink-and-wash palette. Outlines are drawn as ink
// lines that overshoot their corners a little, like the map's pen strokes.

import * as THREE from 'three';
import { BUILDINGS } from '@design/sprites.js';
import { THEMES, matColor } from '@design/theme.js';
import { N, RING, decorItems, footprint, scaleOf, tileMat, yards } from '@design/world.js';
import type { Placement } from '../api';
import { free } from '../components/walk';
import type { World } from './body';
import { PX, Pen3, ZS, type Glyph, type V3 } from './pen3';

const THEME = THEMES.sketch as { mats: Record<string, unknown>; ink: string; text: string; ui: { bg: string; head: string } };
export const PAPER = THEME.ui.bg;
export const BRAND = (THEMES.sketch as { ui: { brand: string } }).ui.brand;
export const TOP = 1.15; // how much brighter the lights make an upward face than the map's flat fill
export const INK = '#2e1f12';
export const WATER_Y = -0.1;
export const WADE_Y = -0.16; // where your feet are in the shallows
const GLOW = new THREE.Color('#ffc46b'); // lit windows and lamps after dark

// ---------- materials ----------

export class Materials {
  private solid = new Map<string, THREE.Material>();
  private lines = new Map<string, THREE.LineBasicMaterial>();
  textures: THREE.Texture[] = [];

  color(mat: string, accent: string) {
    try { return matColor(THEME, mat, accent); } catch { return null; } // a class the theme has no colour for
  }

  // lit surfaces; `flat` ones (the ground) are dimmed so that lit from above they keep the map's colour
  surface(color: string, flat = false) {
    const key = `${color}|${flat}`;
    let m = this.solid.get(key);
    if (!m) {
      const c = new THREE.Color(color);
      if (flat) c.multiplyScalar(1 / TOP);
      m = new THREE.MeshLambertMaterial({ color: c, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
      this.solid.set(key, m);
    }
    return m;
  }

  line(color: string, opacity = 1) {
    const key = `${color}|${opacity}`;
    let m = this.lines.get(key);
    if (!m) {
      m = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
      this.lines.set(key, m);
    }
    return m;
  }

  dispose() {
    for (const m of this.solid.values()) m.dispose();
    for (const m of this.lines.values()) m.dispose();
    for (const t of this.textures) t.dispose();
  }
}

// ---------- ink ----------

function noise(a: number, b: number, c: number) {
  let h = (Math.imul(Math.round(a * 97), 374761393) + Math.imul(Math.round(b * 89), 668265263) + Math.imul(c, 982451653)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (((h ^ (h >>> 16)) >>> 0) / 4294967296) * 2 - 1;
}

// segments as hand-drawn strokes: shared edges drawn once, each a touch long at both ends and off by a hair
export function inkLines(seg: number[], mat: THREE.Material) {
  const out: number[] = [], seen = new Set<string>();
  const key = (i: number) => `${seg[i].toFixed(3)},${seg[i + 1].toFixed(3)},${seg[i + 2].toFixed(3)}`;
  for (let i = 0; i < seg.length; i += 6) {
    const ka = key(i), kb = key(i + 3), k = ka < kb ? ka + kb : kb + ka;
    if (seen.has(k)) continue;
    seen.add(k);
    const a = seg.slice(i, i + 3), b = seg.slice(i + 3, i + 6);
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], len = Math.hypot(d[0], d[1], d[2]);
    if (len < 0.02) continue;
    const o = Math.min(0.045, len * 0.07);
    for (const [p, s, n] of [[a, -1, 1], [b, 1, 2]] as const) {
      const over = o * (0.6 + 0.4 * noise(p[0], p[2], n));
      for (let j = 0; j < 3; j++) out.push(p[j] + d[j] / len * over * s + noise(p[j], p[(j + 1) % 3], n + j) * 0.006);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  return new THREE.LineSegments(g, mat);
}

// ---------- signs and decals ----------

// a sign's lettering or a decal as a little textured plane on the face it is painted on
function glyphMesh(g: Glyph, accent: string, mats: Materials, font: string, ready: Promise<unknown>) {
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d')!;
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  mats.textures.push(tex);
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  let w: number, h: number;
  const S = 4; // texture pixels per sprite pixel
  if (g.kind === 'text') {
    ctx.font = `${g.size * S}px ${font}`;
    const tw = Math.max(ctx.measureText(g.body).width, g.size * S);
    canvas.width = Math.ceil(tw + g.size * S * 0.4);
    canvas.height = Math.ceil(g.size * S * 1.4);
    w = canvas.width / S * PX;
    h = canvas.height / S * PX;
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = `${g.size * S}px ${font}`;
      ctx.fillStyle = THEME.text;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(g.body, canvas.width / 2, canvas.height * 0.78);
      tex.needsUpdate = true;
    };
    draw();
    ready.then(draw);
  } else {
    canvas.width = canvas.height = 24 * S;
    w = h = 24 * PX;
    const css = Object.keys(THEME.mats).map(m => `.m-${m}{--c:${mats.color(m, accent)}}`).join('') +
      '.f-l{fill:var(--c)}.ln,.ln2{fill:none;stroke:var(--c);stroke-linecap:round;stroke-linejoin:round}.ln{stroke-width:1.6}.ln2{stroke-width:3}';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${24 * S}" height="${24 * S}" viewBox="-12 -12 24 24"><style>${css}</style>${g.body}</svg>`;
    const img = new Image();
    img.onload = () => { ctx.drawImage(img, 0, 0); tex.needsUpdate = true; };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  // text sits on its baseline; a decal is centred on its point
  const lift = g.kind === 'text' ? h * (0.5 - 0.22) : 0;
  m.position.set(g.at[0], g.at[1] + lift, g.at[2]);
  if (g.face === 'R') m.rotation.y = Math.PI / 2;
  m.renderOrder = 2;
  return m;
}

// ---------- the parts the sprites draw in screen space ----------

// the map's screen-right and screen-up, as directions in the world: these parts face the map's viewer
const RIGHT = new THREE.Vector3(1, 0, -1).normalize(), UP = new THREE.Vector3(0, 1, 0), TOWARD = new THREE.Vector3(1, 0, 1).normalize();
const at = (c: V3, dx: number, dy: number, out = 0): V3 => [
  c[0] + RIGHT.x * dx * PX + TOWARD.x * out, c[1] - dy * PX, c[2] + RIGHT.z * dx * PX + TOWARD.z * out,
];

interface Extra { beam?: THREE.Object3D }

function extras(type: string, p: Pen3, group: THREE.Group): Extra {
  const out: Extra = {};
  if (type === 'lighthouse') {
    const c = p.W(0.5, 0.5, 2.43);
    const cone = new THREE.ConeGeometry(0.75, 7, 24, 1, true);
    cone.translate(0, -3.5, 0);
    cone.rotateZ(Math.PI / 2); // apex at the lamp, opening sideways
    const beam = new THREE.Mesh(cone, new THREE.MeshBasicMaterial({ color: '#ffecaa', transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
    const pivot = new THREE.Group();
    pivot.position.set(...c);
    pivot.add(beam);
    group.add(pivot);
    out.beam = pivot;
  } else if (type === 'qa') {
    // the magnifying glass with its tick, standing on the roof mast
    const c = p.W(1.04, 0.99, 2.25);
    const ring = new THREE.TorusGeometry(13 * PX, 0.035, 8, 28);
    const disc = new THREE.CircleGeometry(13 * PX, 28);
    const face = new THREE.Matrix4().lookAt(new THREE.Vector3(), TOWARD, UP).setPosition(...c);
    ring.applyMatrix4(face);
    disc.applyMatrix4(face);
    p.geom(ring, 'acc');
    p.geom(disc, 'glass');
    const tick = [at(c, -6, 0, 0.03), at(c, -1, 5, 0.03), at(c, 7, -5, 0.03)];
    for (let i = 0; i + 1 < tick.length; i++) p.edge(tick[i], tick[i + 1]);
  } else if (type === 'genealogy') {
    // the family tree's crown and the ancestors hanging in it
    const c = p.W(0.8, 0.63, 1.8);
    p.sphereW(at(c, -15, 5), 17 * PX, 'leaf');
    p.sphereW(at(c, 15, 3), 17 * PX, 'leaf');
    p.sphereW(at(c, 0, -11), 20 * PX, 'leaf');
    for (const [dx, dy] of [[0, -24], [-13, -6], [12, -8], [-20, 10], [-4, 10], [18, 8]]) p.sphereW(at(c, dx, dy, 0.42), 3.2 * PX, 'acc2');
  } else if (type === 'weather') {
    // the anemometer plate on its mast, and its pointer
    const c = p.W(1.35, 0.45, 2.3);
    const dish = new THREE.CylinderGeometry(16 * PX, 13 * PX, 0.05, 24);
    dish.translate(...c);
    p.geom(dish, 'white');
    p.ring([c[0], c[1] + 0.025, c[2]], 16 * PX, 24);
    p.cylW(c, 0.015, 0.32, 'dark');
  }
  return out;
}

// ---------- props ----------

function drawProp(prop: string, x: number, y: number, p: Pen3) {
  if (prop === 'tree_round') {
    p.box(x + 0.45, y + 0.45, 0, 0.1, 0.1, 0.42, 'm-trunk');
    const c = p.W(x + 0.5, y + 0.5, 0.85);
    p.sphereW(c, 14 * PX, 'leaf', 0.92);
    p.sphereW([c[0] + 0.12, c[1] - 0.08, c[2] + 0.1], 9 * PX, 'leaf');
  } else if (prop === 'tree_pine') {
    p.box(x + 0.46, y + 0.46, 0, 0.08, 0.08, 0.3, 'm-trunk');
    for (let k = 0; k < 3; k++) p.coneW(p.W(x + 0.5, y + 0.5, 0.3 + k * 0.32), (14 - k * 3.5) * PX, (22 - k * 3) * PX * 1.06, 'leaf2');
  } else if (prop === 'lamp') {
    p.box(x + 0.47, y + 0.47, 0, 0.06, 0.06, 0.95, 'm-metal');
    p.sphereW(p.W(x + 0.5, y + 0.5, 1.02), 4.5 * PX, 'win');
  }
}

// ---------- the small things on the ground ----------

const FLOWERS = ['#e0705c', '#efc24a', '#f6f1e4', '#b08ad0', '#6f9fd4'];

// what is only seen up close: flowers and tufts on the grass, stones on the sand, benches on
// the square, a step and a mat at every door and lanterns at the big ones. Blocky, as the
// town's own blocks are, and drawn without ink where they are too small to outline.
function details(places: Placement[], taken: Set<string>, p: Pen3) {
  const n = (x: number, y: number, s: number) => (noise(x, y, s) + 1) / 2;
  for (let x = 1; x < N; x++) for (let y = 1; y < N; y++) {
    const m = tileMat(x, y);
    if (m.startsWith('grass') && !taken.has(`${x},${y}`) && free(places, x + 0.5, y + 0.5)) {
      if (n(x, y, 21) < 0.16) {
        const c = Math.floor(n(x, y, 22) * FLOWERS.length);
        for (let i = 0; i < 3 + Math.floor(n(x, y, 23) * 3); i++) {
          const fx = x + 0.2 + n(x * 7 + i, y, 24) * 0.6, fy = y + 0.2 + n(x, y * 7 + i, 25) * 0.6, h = 0.07 + n(i, x, y) * 0.05;
          p.block(fx - 0.008, 0, fy - 0.008, 0.016, h, 0.016, 'leaf', false);
          p.block(fx - 0.026, h, fy - 0.026, 0.052, 0.036, 0.052, `fl${(c + (i % 2)) % FLOWERS.length}`, false);
        }
      }
      if (n(x, y, 26) < 0.3) {
        for (let i = 0; i < 4; i++) {
          const gx = x + 0.15 + n(x, y + i, 27) * 0.7, gy = y + 0.15 + n(x + i, y, 28) * 0.7, h = 0.04 + n(gx, gy, 29) * 0.06;
          p.block(gx, 0, gy, 0.014, h, 0.014, 'leaf2', false);
          p.block(gx + 0.022, 0, gy + 0.01, 0.014, h * 0.7, 0.014, 'leaf2', false);
        }
      }
    } else if (m === 'sand' || (m.startsWith('grass') && (x === 1 || y === 1) && n(x, y, 30) < 0.25)) {
      for (let i = 0; i < 2; i++) {
        const rx = x + 0.2 + n(x, y, 31 + i) * 0.5, ry = y + 0.2 + n(y, x, 33 + i) * 0.5, s = 0.06 + n(x, i, y) * 0.07;
        p.block(rx, 0, ry, s * 1.4, s * 0.6, s, 'edge');
      }
    } else if (m === 'plaza' && free(places, x + 0.5, y + 0.5) && n(x, y, 35) < 0.3) {
      // a bench along the tile, its back to the tile's far side
      const bx = x + 0.22, by = y + 0.62;
      for (const lx of [0.03, 0.5]) p.block(bx + lx, 0, by, 0.03, 0.11, 0.14, 'dark');
      p.block(bx, 0.11, by - 0.02, 0.56, 0.035, 0.18, 'wood');
      p.block(bx, 0.15, by + 0.15, 0.56, 0.14, 0.03, 'wood');
    }
  }
  for (const pl of places) {
    const b = BUILDINGS[pl.type];
    if (!b) continue;
    const f = footprint(pl), cx = f.x + f.w / 2, y = f.y + f.d;
    if (!free(places, cx, y + 0.3)) continue;
    p.block(cx - 0.3, 0, y + 0.01, 0.6, 0.03, 0.16, 'edge'); // the step
    p.block(cx - 0.22, 0, y + 0.2, 0.44, 0.012, 0.26, pl.accent || b.accent, false); // the mat, in the building's colour
    if (!pl.core) continue;
    for (const s of [-1, 1]) { // lanterns either side
      const lx = cx + s * 0.5;
      p.block(lx - 0.015, 0, y + 0.16, 0.03, 0.34, 0.03, 'dark');
      p.block(lx - 0.045, 0.34, y + 0.13, 0.09, 0.09, 0.09, 'win');
      p.block(lx - 0.055, 0.43, y + 0.12, 0.11, 0.02, 0.11, 'dark');
    }
  }
}

// ---------- the town ----------

export interface Building {
  pl: Placement;
  group: THREE.Group;
  top: THREE.Vector3; // where its name hangs
  mid: THREE.Vector3; // its middle, for the door the room opens from
  lift: number; // how far it is raised right now (hover / at its door)
  busy: boolean;
  beam?: THREE.Object3D;
  parts: THREE.Mesh[]; // its solid surfaces
  box: THREE.Box3; // round them, unraised
  heights: Map<number, number>; // the top of it at a point, measured as you come near
}

export interface Town {
  root: THREE.Group;
  buildings: Map<string, Building>;
  pick: THREE.Object3D[];
  world: World; // what you can stand on: the ground, the shallows, roofs and treetops
  update(t: number, dt: number, focus: string | null): boolean; // true while a building is moving
  setBusy(ids: Set<string>): void;
  setNight(n: number): void; // 0 day … 1 night: windows and lamps light up
  setAir(a: number): void; // 0 on the ground … 1 at the map's view: the board's edge and the sea washing into the paper
  dispose(): void;
}

// a little person in a coat and scarf: you, seen from outside, and the townsfolk
export function figure(mats: Materials, coat: string, scarf = '#e7ca7b') {
  const g = new THREE.Group(), p = new Pen3();
  p.cylW([0, 0.12, 0], 0.13, 0.36, 'coat', 0.1);
  p.cylW([0, 0, 0], 0.05, 0.14, 'dark');
  p.cylW([0, 0.44, 0], 0.11, 0.05, 'scarf');
  p.sphereW([0, 0.6, 0], 0.11, 'egg');
  for (const o of meshes(p, m => m === 'coat' ? coat : m === 'scarf' ? scarf : mats.color(m, '#c47a3a'), mats)) g.add(o);
  return g;
}

// how high a building's solid top is at a point, unraised (-Infinity: nothing of it there)
const down = new THREE.Raycaster(), DOWN = new THREE.Vector3(0, -1, 0);
function heightOf(b: Building, x: number, y: number) {
  const k = Math.round(x * 24) * 4096 + Math.round(y * 24);
  let h = b.heights.get(k);
  if (h === undefined) {
    down.set(new THREE.Vector3(Math.round(x * 24) / 24, 40, Math.round(y * 24) / 24), DOWN);
    down.far = 60;
    const hit = down.intersectObjects(b.parts, false)[0];
    h = hit ? hit.point.y - b.group.position.y : -Infinity;
    b.heights.set(k, h);
  }
  return h;
}

export function meshes(p: Pen3, colorOf: (m: string) => string | null, mats: Materials, flat = false, inkOpacity = 0.72) {
  const out: THREE.Object3D[] = [];
  for (const [m, pos] of p.pos) {
    const c = colorOf(m);
    if (!c || !pos.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(p.nrm.get(m)!, 3));
    const mesh = new THREE.Mesh(g, mats.surface(c, flat));
    mesh.userData.mat = m;
    mesh.castShadow = !flat;
    mesh.receiveShadow = true;
    out.push(mesh);
  }
  for (const [m, seg] of p.strokes) {
    const c = colorOf(m);
    if (!c || !seg.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
    out.push(new THREE.LineSegments(g, mats.line(c)));
  }
  if (p.ink.length) out.push(inkLines(p.ink, mats.line(INK, inkOpacity)));
  return out;
}

interface Puff { mesh: THREE.Mesh; at: V3; s: number; phase: number }

// font: the lettering's font stack; fonts: resolves once it has loaded, to redraw the signs
export function buildTown(places: Placement[], mats: Materials, font: string, fonts: Promise<unknown>): Town {
  const root = new THREE.Group();
  const buildings = new Map<string, Building>();
  const pick: THREE.Object3D[] = [];
  const puffs: Puff[] = [];
  const disposables: THREE.BufferGeometry[] = [];
  const plain = (m: string) => mats.color(m, '#c47a3a');

  // ground: one top per land tile, merged per material; the shore gets a little bank
  const ground = new Pen3();
  const isWater = (x: number, y: number) => x < 0 || y < 0 || (x < N && y < N && tileMat(x, y) === 'water');
  for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) {
    const m = tileMat(x, y);
    if (m === 'water') continue;
    ground.face([[x, 0, y], [x, 0, y + 1], [x + 1, 0, y + 1], [x + 1, 0, y]], m, false);
    const bank = (a: V3, b: V3) => ground.face([a, b, [b[0], WATER_Y - 0.05, b[2]], [a[0], WATER_Y - 0.05, a[2]]], 'edge', false);
    if (isWater(x - 1, y)) bank([x, 0, y], [x, 0, y + 1]);
    if (isWater(x + 1, y)) bank([x + 1, 0, y + 1], [x + 1, 0, y]);
    if (isWater(x, y - 1)) bank([x + 1, 0, y], [x, 0, y]);
    if (isWater(x, y + 1)) bank([x, 0, y + 1], [x + 1, 0, y + 1]);
  }
  // the board's near edges, where it drops to the paper: seen only from the air, as on the
  // map; on the ground the land goes on past them (land.ts)
  const E = -0.6 * ZS, edge = new Pen3(), rim = new THREE.Group();
  edge.face([[0, 0, N], [N, 0, N], [N, E, N], [0, E, N]], 'edge', false);
  edge.face([[N, 0, 0], [N, 0, N], [N, E, N], [N, E, 0]], 'edge', false);
  edge.edge([0, 0, N], [N, 0, N]);
  edge.edge([N, 0, 0], [N, 0, N]);
  for (const o of meshes(edge, plain, mats, true)) rim.add(o);
  root.add(rim);
  // centre dashes along the ring road
  for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) {
    if (tileMat(x, y) !== 'road') continue;
    const d = 0.004, w = 0.035;
    if (RING.includes(y)) ground.face([[x + 0.22, d, y + 0.5 - w], [x + 0.22, d, y + 0.5 + w], [x + 0.78, d, y + 0.5 + w], [x + 0.78, d, y + 0.5 - w]], 'white', false);
    if (RING.includes(x)) ground.face([[x + 0.5 - w, d, y + 0.22], [x + 0.5 + w, d, y + 0.22], [x + 0.5 + w, d, y + 0.78], [x + 0.5 - w, d, y + 0.78]], 'white', false);
  }
  for (const o of meshes(ground, plain, mats, true)) root.add(o);

  // the sea on the far sides, washing out into the paper a few tiles off shore
  const SEA = 6, span = N + SEA;
  const fade = document.createElement('canvas');
  fade.width = fade.height = 128;
  const fx = fade.getContext('2d')!, img = fx.createImageData(128, 128);
  for (let j = 0; j < 128; j++) for (let i = 0; i < 128; i++) {
    const wx = -SEA + (i + 0.5) / 128 * span, wz = -SEA + (j + 0.5) / 128 * span; // texture row 0 is the far edge (z = -SEA)
    const out = Math.hypot(Math.max(0, -wx), Math.max(0, -wz)) / (SEA - 1);
    const a = Math.round(255 * Math.max(0, Math.min(1, 1 - out * out)));
    img.data.set([a, a, a, 255], (j * 128 + i) * 4);
  }
  fx.putImageData(img, 0, 0);
  const alpha = new THREE.CanvasTexture(fade); // flipped as usual: canvas row 0 lands at v = 1, the far edge
  mats.textures.push(alpha);
  const seaGeo = new THREE.PlaneGeometry(span, span);
  seaGeo.rotateX(-Math.PI / 2); // plane (x, y) -> world (x, 0, -y)
  const seaMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(plain('water')!).multiplyScalar(1 / TOP), alphaMap: alpha, transparent: true, depthWrite: false });
  const sea = new THREE.Mesh(seaGeo, seaMat);
  sea.position.set(-SEA + span / 2, WATER_Y, -SEA + span / 2);
  sea.receiveShadow = true;
  sea.renderOrder = -1;
  root.add(sea);
  // ripples in two sets that sway against each other
  const waves = [[], []] as number[][];
  for (let x = -4; x < N; x++) for (let y = -4; y < N; y++) {
    if (!isWater(x, y) || noise(x, y, 7) < 0.1) continue;
    const seg = waves[noise(x, y, 8) < 0 ? 0 : 1];
    let prev: V3 | null = null;
    for (let i = 0; i <= 8; i++) {
      const t = i / 8, q: V3 = [x + 0.3 + t * 0.4, WATER_Y + 0.01, y + 0.5 + (t - 0.5) * -0.4 + Math.sin(t * Math.PI * 2) * 0.04];
      if (prev) seg.push(...prev, ...q);
      prev = q;
    }
  }
  const waveSets = waves.map(seg => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
    return new THREE.LineSegments(g, mats.line('#fcf8ee', 0.6));
  });
  for (const w of waveSets) root.add(w);

  // the core buildings' yards: a tinted pad with an ink rim
  for (const y of yards(places)) {
    const shape = new THREE.Shape(y.pts.map(([a, b]) => new THREE.Vector2(a, b)));
    const g = new THREE.ShapeGeometry(shape);
    g.rotateX(Math.PI / 2); // shape (x, y) -> world (x, 0, y)
    g.translate(0, 0.008, 0);
    const tint = new THREE.Color(plain('grass')!).lerp(new THREE.Color(y.accent), 0.15);
    const pad = new THREE.Mesh(g, mats.surface('#' + tint.getHexString(), true));
    pad.receiveShadow = true;
    root.add(pad);
    const rim = new Pen3();
    y.pts.forEach((q, i) => { const r = y.pts[(i + 1) % y.pts.length]; rim.edge([q[0], 0.012, q[1]], [r[0], 0.012, r[1]]); });
    root.add(inkLines(rim.ink, mats.line('#' + new THREE.Color(y.accent).lerp(new THREE.Color(INK), 0.28).getHexString(), 0.75)));
  }

  // trees, from the same scatter as the map, and the street lamps; you bump into them,
  // and can stand on a treetop if you fly up to one
  const decor = new Pen3(), solids: { x: number; y: number; r: number; top: number }[] = [], taken = new Set<string>();
  const items = [...decorItems(places, 'light'), ...decorItems(places, 'full').filter(i => i.prop === 'lamp')];
  for (const it of items) {
    drawProp(it.prop, it.x, it.y, decor);
    solids.push(it.prop === 'lamp' ? { x: it.x + 0.5, y: it.y + 0.5, r: 0.05, top: 1.05 * ZS } : { x: it.x + 0.5, y: it.y + 0.5, r: 0.17, top: 0.9 });
    taken.add(`${Math.floor(it.x + 0.5)},${Math.floor(it.y + 0.5)}`);
  }
  details(places, taken, decor);
  const flower = (m: string) => m.startsWith('#') ? m : m.startsWith('fl') ? FLOWERS[+m.slice(2)] : plain(m);
  const glow = new Set<THREE.MeshLambertMaterial>();
  for (const o of meshes(decor, flower, mats)) {
    root.add(o);
    if (o instanceof THREE.Mesh && o.userData.mat === 'win') glow.add(o.material as THREE.MeshLambertMaterial);
  }

  // the buildings
  const hasCore = places.some(p => p.core);
  for (const pl of places) {
    const b = BUILDINGS[pl.type];
    if (!b) continue;
    const accent = pl.accent || b.accent, k = scaleOf(pl), f = footprint(pl);
    const p = new Pen3(k, pl.x, pl.y);
    const group = new THREE.Group();
    group.userData.id = pl.id;
    b.draw(p, pl as unknown as Record<string, unknown>);
    const ex = extras(pl.type, p, group);
    // as on the map, the buildings that are not core are a lighter wash with fainter ink
    const quiet = hasCore && !pl.core;
    const colorOf = (m: string) => {
      const c = mats.color(m, accent);
      return c && quiet ? '#' + new THREE.Color(c).lerp(new THREE.Color(PAPER), 0.38).getHexString() : c;
    };
    const parts: THREE.Mesh[] = [];
    for (const o of meshes(p, colorOf, mats, false, quiet ? 0.45 : 0.72)) {
      o.userData.id = pl.id;
      group.add(o);
      if (!(o instanceof THREE.Mesh)) continue;
      pick.push(o);
      parts.push(o);
      if (o.userData.mat === 'win') glow.add(o.material as THREE.MeshLambertMaterial);
    }
    for (const g of p.glyphs) group.add(glyphMesh(g, accent, mats, font, fonts));
    for (const s of p.puffs) {
      for (let i = 0; i < 4; i++) {
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshLambertMaterial({ color: '#fffaf2', transparent: true, depthWrite: false }));
        disposables.push(mesh.geometry);
        group.add(mesh);
        puffs.push({ mesh, at: s.at, s: s.s, phase: i / 4 });
      }
    }
    root.add(group);
    const box = new THREE.Box3();
    for (const m of parts) { m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox!); }
    buildings.set(pl.id, {
      pl, group, lift: 0, busy: pl.status === 'busy', beam: ex.beam, parts, box, heights: new Map(),
      top: new THREE.Vector3(f.x + f.w / 2, (b.h * k + 0.55) * ZS, f.y + f.d / 2),
      mid: new THREE.Vector3(f.x + f.w / 2, b.h * k * ZS * 0.4, f.y + f.d / 2),
    });
  }

  const wet = (x: number, y: number) => isWater(Math.floor(x), Math.floor(y));
  const world: World = {
    bounds: [-SEA + 0.5, -SEA + 0.5, N - 0.05, N - 0.05],
    ceiling: 40,
    wet,
    top(x, y) {
      let h = wet(x, y) ? WADE_Y : 0;
      for (const b of buildings.values()) {
        if (x < b.box.min.x || x > b.box.max.x || y < b.box.min.z || y > b.box.max.z) continue;
        h = Math.max(h, heightOf(b, x, y) + b.lift);
      }
      for (const s of solids) if ((x - s.x) ** 2 + (y - s.y) ** 2 < s.r * s.r) h = Math.max(h, s.top);
      return h;
    },
  };
  const beams = [...buildings.values()].filter(b => b.beam).map(b => (b.beam!.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial);

  return {
    root, buildings, pick, world,
    setNight(n) {
      for (const m of glow) m.emissive.copy(GLOW).multiplyScalar(n * 0.9);
      for (const m of beams) m.opacity = 0.22 + n * 0.3;
    },
    update(t, dt, focus) {
      let moving = false;
      for (const b of buildings.values()) {
        const want = (b.pl.id === focus ? 0.12 : 0) + (b.busy ? 0.035 * (1 - Math.cos(t * 2.4)) : 0);
        const next = b.lift + (want - b.lift) * (1 - Math.exp(-dt * 9));
        if (Math.abs(next - b.lift) > 1e-4) moving = true;
        b.lift = next;
        b.group.position.y = b.lift;
        if (b.beam) b.beam.rotation.y = t * 0.9 + Math.sin(t * 1.8) * 0.35; // sweeps faster past the land, lingers over the sea
      }
      for (const q of puffs) {
        const u = (t / 3.4 + q.phase) % 1; // each puff rises, drifts and thins over 3.4 s
        const up = 1 - (1 - u) * (1 - u), wide = Math.sqrt(u); // pushed out fast, slowing as it cools
        const r = (0.07 + wide * 0.16) * q.s;
        q.mesh.scale.setScalar(r);
        q.mesh.position.set(q.at[0] + u * u * 0.32 * q.s, q.at[1] + 0.06 + up * 0.95 * q.s, q.at[2] - u * u * 0.1 * q.s);
        (q.mesh.material as THREE.MeshLambertMaterial).opacity = 0.85 * Math.min(1, u * 6) * (1 - u);
      }
      waveSets.forEach((w, i) => { w.position.x = Math.sin(t * 0.8 + i * Math.PI) * 0.06; });
      return moving;
    },
    setBusy(ids) { for (const b of buildings.values()) b.busy = ids.has(b.pl.id); },
    setAir(a) {
      rim.visible = a > 0.5;
      sea.visible = a > 0.02;
      seaMat.opacity = a;
    },
    dispose() {
      root.traverse(o => { if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) o.geometry.dispose(); });
      for (const q of puffs) (q.mesh.material as THREE.Material).dispose();
      for (const g of disposables) g.dispose();
      seaMat.dispose();
      for (const b of buildings.values()) b.group.traverse(o => { if (o instanceof THREE.Mesh && o.material instanceof THREE.MeshBasicMaterial) o.material.dispose(); });
    },
  };
}
