// The insides of the buildings: each hall shows the work done there at full size, built from the building's live data.
// Aim at a machine and F or a click opens its room; the door you came in by takes you back out.

import * as THREE from 'three';
import { BUILDINGS } from '@design/sprites.js';
import { placementName } from '@design/world.js';
import type { Gpu, GpuNode, GpuStatus, Hud, Job, Line, Placement, Roster, Sheet, Shelf } from '../api';
import { tr } from '../i18n';
import type { World } from './body';
import { Pen3, ZS, type V3 } from './pen3';
import { disposeGeometry, INK, meshes, mix, type Materials } from './scene';

export interface HallData {
  sheet: Sheet | null;
  lines: Line[];
  jobs: Job[];
  gpus: GpuStatus | null;
  plant: Hud['plant'] | null;
  shelf: Shelf | null;
  roster: Roster | null;
}

// what a machine in a hall is, for the card while you aim at it, and what F does with it
export interface Thing {
  title: string;
  sub: string;
  note?: string;
  verb?: string; // what F does, when it is more than opening the room
  act: { kind: 'open'; building: string; line?: string | null } | { kind: 'exit' };
  at: THREE.Vector3; // its middle, for the room to open from
}

export interface Hall {
  pl: Placement;
  scene: THREE.Scene;
  pick: THREE.Object3D[]; // userData.thing on each
  exit: Thing;
  world: World;
  spawn: { x: number; y: number; heading: number; pitch: number };
  update(t: number, dt: number): void;
  dispose(): void;
}

const LAMP = { done: '#62b25c', run: '#f2b233', wait: '#dd5a4b', todo: '#8f877b' } as const;
const RUNS = new Set(['running', 'linked']);
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const hash = (s: string, k = 0) => {
  let h = 2166136261 ^ k;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
};
const statusName = (s: string) => ({
  running: tr('进行中'), waiting: tr('等待中'), paused: tr('暂停'), done: tr('已完成'), linked: tr('已关联'),
  queued: tr('排队中'), failed: tr('失败'), cancelled: tr('已取消'), run: tr('进行中'), wait: tr('等待中'), todo: tr('未开始'),
} as Record<string, string>)[s] ?? s;

interface Box { x0: number; z0: number; x1: number; z1: number; top: number; drift?: () => [number, number] }

// what a hall is built with: one merged pen for what stands still, meshes for what moves, hidden boxes to aim at and boxes to stand on
class Kit {
  scene = new THREE.Scene();
  p = new Pen3();
  pick: THREE.Mesh[] = [];
  boxes: Box[] = [];
  faint: number[] = []; // light lines: floor joints, cables
  private own: { dispose(): void }[] = [];
  private glows = new Map<string, THREE.MeshBasicMaterial>();
  private hidden = new THREE.MeshBasicMaterial();
  private redraw: (() => void)[] = [];

  constructor(public mats: Materials, public accent: string, public font: string, fonts: Promise<unknown>) {
    this.own.push(this.hidden);
    fonts.then(() => this.redraw.forEach(f => f()));
  }

  color = (m: string) => (m.startsWith('#') ? m : this.mats.color(m, this.accent));

  // something to stand on or bump into
  solid(x: number, z: number, w: number, d: number, top: number, drift?: () => [number, number]) {
    this.boxes.push({ x0: x, z0: z, x1: x + w, z1: z + d, top, drift });
  }

  // a box to aim at for a thing (and, unless it is only a door, to stand on)
  thing(x: number, y: number, z: number, w: number, h: number, d: number, t: Omit<Thing, 'at'>, solid = true): Thing {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x + w / 2, y + h / 2, z + d / 2);
    const m = new THREE.Mesh(g, this.hidden);
    m.visible = false;
    const thing = { ...t, at: new THREE.Vector3(x + w / 2, y + h / 2, z + d / 2) };
    m.userData.thing = thing;
    this.scene.add(m);
    this.pick.push(m);
    if (solid) this.solid(x, z, w, d, y + h);
    return thing;
  }

  // a lit, ink-outlined surface that moves on its own
  mesh(g: THREE.BufferGeometry, m: string) {
    const mesh = new THREE.Mesh(g, this.mats.surface(this.color(m)!));
    mesh.castShadow = mesh.receiveShadow = true;
    this.scene.add(mesh);
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(g, 30), this.mats.line(INK, 0.55)));
    return mesh;
  }

  // light that is not lit: lamps, LEDs, screens
  glow(color: string) {
    let m = this.glows.get(color);
    if (!m) { m = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }); this.glows.set(color, m); this.own.push(m); }
    return m;
  }

  lamp(g: THREE.BufferGeometry, color: string) {
    const m = new THREE.Mesh(g, this.glow(color));
    this.scene.add(m);
    return m;
  }

  owned<T extends { dispose(): void }>(x: T) { this.own.push(x); return x; }

  // the accent paled towards paper, for carpets and rugs
  tint(s: number) { return mix(this.accent, '#f3e9d6', s); }

  // lettering on a board: lines of text on a canvas, on a plane facing +z (turned by `rot`)
  sign(lines: string[], o: { at: V3; w: number; size?: number; rot?: number; bg?: string | null; color?: string; align?: 'left' | 'center'; wrap?: boolean; back?: boolean }) {
    const size = o.size ?? 0.09, S = Math.max(220, 18 / size), pad = size * 0.5;
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d')!;
    const font = () => `${Math.round(size * S)}px ${this.font}`;
    ctx.font = font();
    let rows = lines;
    if (o.wrap) {
      rows = [];
      for (const ln of lines) {
        let cur = '';
        for (const ch of ln) {
          if (ctx.measureText(cur + ch).width > (o.w - pad * 2) * S && cur) { rows.push(cur); cur = ''; }
          cur += ch;
        }
        rows.push(cur);
      }
    }
    const h = rows.length * size * 1.35 + pad * 1.2;
    canvas.width = Math.ceil(o.w * S);
    canvas.height = Math.ceil(h * S);
    const tex = this.owned(new THREE.CanvasTexture(canvas));
    tex.anisotropy = 4;
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (o.bg !== null) {
        ctx.fillStyle = o.bg ?? '#fdf7e6';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = 'rgba(46,31,18,.7)';
        ctx.lineWidth = 3;
        ctx.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
      }
      ctx.font = font();
      ctx.fillStyle = o.color ?? '#3a2c1e';
      ctx.textBaseline = 'middle';
      ctx.textAlign = o.align ?? 'center';
      rows.forEach((r, i) => {
        const x = o.align === 'left' ? pad * S : canvas.width / 2;
        ctx.fillText(r, x, (pad * 0.6 + size * 1.35 * (i + 0.5)) * S);
      });
      tex.needsUpdate = true;
    };
    draw();
    this.redraw.push(draw);
    const mat = this.owned(new THREE.MeshBasicMaterial({ map: tex, transparent: o.bg === null }));
    const m = new THREE.Mesh(new THREE.PlaneGeometry(o.w, h), mat);
    m.position.set(...o.at);
    m.rotation.y = o.rot ?? 0;
    this.scene.add(m);
    if (o.bg !== null && o.back !== false) {
      const r = o.rot ?? 0, side = Math.abs(Math.sin(r)) > 0.5, nx = Math.sin(r) * 0.012, nz = Math.cos(r) * 0.012, [x, y, z] = o.at;
      if (side) this.p.block(x - nx - 0.008, y - h / 2, z - o.w / 2, 0.016, h, o.w, 'wood', false);
      else this.p.block(x - o.w / 2, y - h / 2, z - nz - 0.008, o.w, h, 0.016, 'wood', false);
    }
    return m;
  }

  // the way out, where room() put it: in the near wall (+z), or in the left one (x = 0)
  door: { side: 'south' | 'west'; x: number; z: number } = { side: 'south', x: 0, z: 0 };

  // the room: floor, walls with windows, the beams overhead, the way out and the building's name
  room(W: number, D: number, H: number, pl: Placement, o: { floor?: string; wall?: string; glass?: boolean; sky?: string; door?: 'south' | 'west' } = {}) {
    const p = this.p, T = 0.14, west = o.door === 'west';
    this.door = west ? { side: 'west', x: 0, z: D / 2 } : { side: 'south', x: W / 2, z: D };
    const sky = o.sky ?? '#e9e0cc';
    this.scene.background = new THREE.Color(sky);
    this.scene.fog = new THREE.Fog(sky, 14, 40);
    p.face([[0, 0, 0], [0, 0, D], [W, 0, D], [W, 0, 0]], o.floor ?? '#d6ccb8', false);
    for (let x = 1; x < W; x++) this.faint.push(x, 0.002, 0, x, 0.002, D);
    for (let z = 1; z < D; z++) this.faint.push(0, 0.002, z, W, 0.002, z);
    const wall = o.wall ?? 'wall';
    if (o.glass) {
      const pane = this.owned(new THREE.MeshLambertMaterial({ color: '#e4f1ec', transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false }));
      for (const [x, z, w, d] of [[0, -T, W, T], [0, D, W, T], [-T, 0, T, D], [W, 0, T, D]] as const) {
        p.block(x, 0, z, w, 0.32, d, '#c9876a');
        const g = new THREE.BoxGeometry(Math.max(w, 0.01), H - 0.32, Math.max(d, 0.01));
        g.translate(x + w / 2, 0.32 + (H - 0.32) / 2, z + d / 2);
        this.scene.add(new THREE.Mesh(g, pane));
      }
      for (let x = 0; x <= W + 0.01; x += 1) { p.block(x - 0.02, 0.32, -0.04, 0.04, H - 0.32, 0.04, 'white'); p.block(x - 0.02, 0.32, D, 0.04, H - 0.32, 0.04, 'white'); }
      for (let z = 0; z <= D + 0.01; z += 1) { p.block(-0.04, 0.32, z - 0.02, 0.04, H - 0.32, 0.04, 'white'); p.block(W, 0.32, z - 0.02, 0.04, H - 0.32, 0.04, 'white'); }
      const roof = new THREE.PlaneGeometry(W, D);
      roof.rotateX(Math.PI / 2);
      roof.translate(W / 2, H, D / 2);
      this.scene.add(new THREE.Mesh(roof, pane));
      for (let x = 0; x <= W + 0.01; x += 1) p.block(x - 0.025, H - 0.05, 0, 0.05, 0.05, D, 'white');
      p.block(0, H - 0.06, D / 2 - 0.04, W, 0.06, 0.08, 'white');
    } else {
      p.block(-T, 0, -T, W + 2 * T, H, T, wall);
      p.block(W, 0, 0, T, H, D, wall);
      p.block(-0.01, 0, 0.002, W + 0.02, 0.22, 0.02, 'base', false);
      p.block(W - 0.022, 0, 0, 0.02, 0.22, D, 'base', false);
      if (west) {
        const c = D / 2;
        p.block(-T, 0, D, W + 2 * T, H, T, wall);
        p.block(-T, 0, 0, T, H, c - 0.42, wall);
        p.block(-T, 0, c + 0.42, T, H, D - c - 0.42, wall);
        p.block(-T, 1.0, c - 0.42, T, H - 1.0, 0.84, wall);
        p.block(-0.01, 0, D - 0.022, W + 0.02, 0.22, 0.02, 'base', false);
      } else {
        const c = W / 2;
        p.block(-T, 0, 0, T, H, D, wall);
        p.block(-T, 0, D, c - 0.42 + T, H, T, wall);
        p.block(c + 0.42, 0, D, W - c - 0.42 + T, H, T, wall);
        p.block(c - 0.42, 1.0, D, 0.84, H - 1.0, T, wall);
        p.block(0.002, 0, 0, 0.02, 0.22, D, 'base', false);
      }
      const day = this.glow('#fff6dc');
      const win = (x: number, z: number, rot: number) => {
        const g = new THREE.PlaneGeometry(0.62, 0.5);
        g.rotateY(rot);
        g.translate(x, 0.95, z);
        this.scene.add(new THREE.Mesh(g, day));
      };
      for (let x = 1.2; x < W - 0.8; x += 1.7) win(x, 0.005, 0);
      for (let z = 1.2; z < D - 0.8; z += 1.7) {
        if (!west || Math.abs(z - D / 2) > 0.8) win(0.005, z, Math.PI / 2);
        win(W - 0.005, z, -Math.PI / 2);
      }
      if (west) for (let x = 1.2; x < W - 0.8; x += 1.7) win(x, D - 0.005, Math.PI);
      for (let x = 1.2; x < W - 0.8; x += 1.7) {
        p.block(x - 0.33, 0.68, 0.0, 0.66, 0.04, 0.05, 'wood');
        p.edge([x - 0.31, 0.7, 0.007], [x - 0.31, 1.2, 0.007]); p.edge([x + 0.31, 0.7, 0.007], [x + 0.31, 1.2, 0.007]);
        p.edge([x - 0.31, 1.2, 0.007], [x + 0.31, 1.2, 0.007]); p.edge([x, 0.7, 0.007], [x, 1.2, 0.007]);
      }
      p.face([[0, H, 0], [W, H, 0], [W, H, D], [0, H, D]], 'roof', false);
      for (let x = 0.8; x < W; x += 1.6) p.block(x - 0.05, H - 0.12, 0, 0.1, 0.12, D, 'wood');
      for (let x = 1.6; x < W - 0.5; x += 3.2) for (let z = 1.6; z < D - 0.5; z += 2.6) {
        p.tube([x, H - 0.12, z], [x, H - 0.45, z], 0.006, 'dark');
        const shade = new THREE.CylinderGeometry(0.05, 0.16, 0.1, 16, 1, true);
        shade.translate(x, H - 0.5, z);
        p.geom(shade, 'acc');
        this.lamp(new THREE.SphereGeometry(0.045, 10, 8).translate(x, H - 0.55, z), '#fff1c8');
      }
    }
    const name = placementName(pl), exit = this.sign([tr('出口')], { at: [0, 1.17, 0], w: 0.42, size: 0.08, bg: '#5aa060', color: '#fffaf2', back: false });
    if (west) {
      const c = D / 2;
      this.lamp(new THREE.PlaneGeometry(0.84, 1.0).rotateY(Math.PI / 2).translate(-0.02, 0.5, c), '#fff8e6');
      for (const s of [-1, 1]) p.block(-0.03, 0, c + s * 0.42 - (s > 0 ? 0 : 0.06), 0.2, 1.06, 0.06, 'dark');
      p.block(-0.03, 1.0, c - 0.48, 0.2, 0.06, 0.96, 'dark');
      exit.position.set(0.18, 1.17, c);
      exit.rotation.y = Math.PI / 2;
      p.block(W - 0.04, H - 0.62, D / 2 - 1.3, 0.04, 0.4, 2.6, this.accent);
      this.sign([name], { at: [W - 0.05, H - 0.42, D / 2], w: 2.4, size: 0.22, bg: null, color: '#fffaf2', rot: -Math.PI / 2 });
    } else {
      const c = W / 2;
      this.lamp(new THREE.PlaneGeometry(0.84, 1.0).translate(c, 0.5, D + 0.02), '#fff8e6');
      for (const s of [-1, 1]) p.block(c + s * 0.42 - (s > 0 ? 0 : 0.06), 0, D - 0.03, 0.06, 1.06, 0.2, 'dark');
      p.block(c - 0.48, 1.0, D - 0.03, 0.96, 0.06, 0.2, 'dark');
      exit.position.set(c, 1.17, D - 0.04);
      exit.rotation.y = Math.PI;
      p.block(W / 2 - 1.3, H - 0.62, 0.0, 2.6, 0.4, 0.04, this.accent);
      this.sign([name], { at: [W / 2, H - 0.42, 0.05], w: 2.4, size: 0.22, bg: null, color: '#fffaf2' });
    }
  }

  // a standing status lamp on a post
  beacon(x: number, z: number, h: number, color: string) {
    this.p.tube([x, 0, z], [x, h, z], 0.012, 'dark');
    return this.lamp(new THREE.SphereGeometry(0.035, 10, 8).translate(x, h + 0.03, z), color);
  }

  finish(W: number, D: number, H: number, pl: Placement, spawn: Hall['spawn'], exit: Thing, update: (t: number, dt: number) => void): Hall {
    const sc = this.scene;
    for (const o of meshes(this.p, this.color, this.mats)) sc.add(o);
    if (this.faint.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(this.faint, 3));
      sc.add(new THREE.LineSegments(g, this.mats.line(INK, 0.12)));
    }
    sc.add(new THREE.AmbientLight(0xffffff, 0.56 * Math.PI));
    const key = new THREE.DirectionalLight(0xfff4e0, 0.6 * Math.PI);
    key.position.set(W * 0.7, H * 3, D * 1.2);
    key.target.position.set(W / 2, 0, D / 2);
    key.castShadow = true;
    key.shadow.intensity = 0.35;
    key.shadow.mapSize.set(2048, 2048);
    const r = Math.max(W, D) * 0.8;
    Object.assign(key.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 0.5, far: H * 6 + r * 2 });
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.02;
    const fill = new THREE.DirectionalLight(0xe8eeff, 0.22 * Math.PI);
    fill.position.set(-W, H, -D);
    sc.add(key, key.target, fill);
    const boxes = this.boxes;
    const at = (x: number, y: number) => boxes.filter(b => x >= b.x0 && x <= b.x1 && y >= b.z0 && y <= b.z1);
    const world: World = {
      bounds: [0.02, 0.02, W - 0.02, D - 0.02],
      ceiling: H,
      top(x, y) {
        let h = 0;
        for (const b of at(x, y)) h = Math.max(h, b.top);
        return h;
      },
      drift(x, y, z) {
        for (const b of at(x, y)) if (b.drift && Math.abs(z - b.top) < 0.02) return b.drift();
        return null;
      },
    };
    const own = this.own;
    return {
      pl, scene: sc, pick: this.pick, exit, world, spawn, update,
      dispose() {
        disposeGeometry(sc);
        for (const x of own) x.dispose();
      },
    };
  }
}

// a strip that scrolls along x: a belt, a paper web
function stripe(k: Kit, colors: [string, string], len: number, wide: number, period: number) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 16;
  const x = c.getContext('2d')!;
  x.fillStyle = colors[0]; x.fillRect(0, 0, 64, 16);
  x.fillStyle = colors[1];
  for (const o of [0, 32]) x.fillRect(o, 0, 6, 16);
  const tex = k.owned(new THREE.CanvasTexture(c));
  tex.wrapS = THREE.RepeatWrapping;
  tex.repeat.set(len / period, 1);
  const mat = k.owned(new THREE.MeshLambertMaterial({ map: tex }));
  const g = new THREE.PlaneGeometry(len, wide);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, mat);
  m.receiveShadow = true;
  k.scene.add(m);
  return { mesh: m, tex };
}

// a mill station shaped for its stage, and the parts of it that move
function stationShape(k: Kit, key: string, x: number, z: number, lamp: string) {
  const p = k.p, w = 0.72, d = 0.64, x0 = x - w / 2, z0 = z - d / 2;
  for (const cz of [z0, z0 + d - 0.12]) {
    p.block(x0, 0, cz, w, 0.62, 0.12, 'metal');
    p.block(x0 - 0.005, 0.3, cz - 0.005, w + 0.01, 0.06, 0.13, 'acc', false);
  }
  p.block(x0 - 0.02, 0.44, z0 - 0.02, w + 0.04, 0.22, d + 0.04, 'wall');
  p.block(x0 + 0.06, 0.66, z0 + 0.06, w - 0.12, 0.04, d - 0.12, 'dark');
  p.block(x0 + 0.08, 0.5, z0 + d + 0.02, 0.12, 0.07, 0.012, 'dark', false);
  const out: { piston?: THREE.Object3D; spin?: THREE.Object3D; scan?: THREE.Object3D; glow?: THREE.Mesh } = {};
  const top = 0.7;
  if (key === 'idea') {
    const g = new THREE.CylinderGeometry(0.3, 0.1, 0.32, 4, 1);
    g.rotateY(Math.PI / 4);
    g.translate(x, top + 0.16, z);
    p.geom(g, 'acc2');
    p.block(x - 0.2, top + 0.32, z - 0.2, 0.4, 0.02, 0.4, 'dark', true);
  } else if (key === 'hatch') {
    p.sphereW([x, top + 0.12, z], 0.17, 'egg', 1.25);
    out.glow = k.lamp(new THREE.CircleGeometry(0.1, 20).translate(x + 0.12, 0.55, z0 + d + 0.025), '#ffd27a');
  } else if (key === 'team') {
    for (const [i, c] of ['#c25b56', '#5f7f9e', '#6f9a4a'].entries()) {
      const fx = x - 0.2 + i * 0.2;
      p.cylW([fx, top, z], 0.06, 0.14, c, 0.05);
      p.sphereW([fx, top + 0.2, z], 0.055, 'egg');
    }
  } else if (key === 'method') {
    p.block(x - 0.06, top, z - 0.22, 0.12, 0.36, 0.08, 'metal');
    p.block(x - 0.06, top, z + 0.14, 0.12, 0.36, 0.08, 'metal');
    p.block(x - 0.12, top + 0.36, z - 0.24, 0.24, 0.08, 0.48, 'acc');
    out.piston = k.mesh(new THREE.BoxGeometry(0.14, 0.16, 0.26), 'metal');
    out.piston.position.set(x, 0.38, z);
  } else if (key === 'exp') {
    for (const s of [-1, 1]) {
      p.cylW([x + s * 0.16, top, z], 0.1, 0.34, 'glass');
      p.ring([x + s * 0.16, top + 0.34, z], 0.1, 16);
    }
    p.tube([x - 0.16, top + 0.38, z], [x + 0.16, top + 0.38, z], 0.02, 'metal');
    out.glow = k.lamp(new THREE.CylinderGeometry(0.075, 0.075, 0.2, 14).translate(x + 0.16, top + 0.11, z), '#9fd46b');
  } else if (key === 'write') {
    const roll = new THREE.CylinderGeometry(0.11, 0.11, 0.5, 18);
    roll.rotateX(Math.PI / 2);
    out.spin = k.mesh(roll, 'white');
    out.spin.position.set(x, top + 0.12, z);
    p.block(x - 0.2, top, z - 0.27, 0.06, 0.14, 0.04, 'dark');
    p.block(x - 0.2, top, z + 0.23, 0.06, 0.14, 0.04, 'dark');
  } else if (key === 'review') {
    const ring = new THREE.TorusGeometry(0.17, 0.025, 8, 24);
    ring.translate(x, top + 0.3, z + 0.1);
    p.geom(ring, 'acc');
    p.tube([x + 0.12, top + 0.18, z + 0.1], [x + 0.2, top, z + 0.1], 0.02, 'dark');
    out.scan = k.lamp(new THREE.BoxGeometry(0.03, 0.02, d - 0.2), '#7fe0d0');
    out.scan.position.set(x, 0.43, z);
  } else if (key === 'ship') {
    p.block(x - 0.2, top, z - 0.2, 0.4, 0.26, 0.4, 'wood');
    p.edge([x - 0.2, top + 0.13, z + 0.2], [x + 0.2, top + 0.13, z + 0.2]);
    p.block(x - 0.12, top + 0.26, z - 0.12, 0.24, 0.16, 0.24, 'wood');
  }
  const bulb = k.beacon(x0 + w - 0.06, z0 + d + 0.08, 0.86, lamp);
  return { ...out, bulb };
}

// the paper mill: one production line per project
function millHall(k: Kit, pl: Placement, data: HallData) {
  const rank = (l: Line) => (RUNS.has(l.status) ? 0 : l.status === 'waiting' ? 1 : l.status === 'paused' ? 2 : 3);
  const lines = [...data.lines].sort((a, b) => rank(a) - rank(b) || b.seq - a.seq).slice(0, 6);
  const n = Math.max(1, lines.length), STEP = 1.25, X0 = 3.4, GAP = 2.0;
  const W = X0 + STEP * 7 + 1.4, D = Math.max(6, 2.8 + (n - 1) * GAP), H = 2.4;
  k.room(W, D, H, pl, { floor: '#d2c8b2', door: 'west' });
  const p = k.p;
  const movers: ((t: number, dt: number) => void)[] = [];
  const slots = [...Array(n).keys()].sort((a, b) => Math.abs(a - (n - 1) / 2) - Math.abs(b - (n - 1) / 2) || a - b);
  if (!lines.length) k.sign([tr('还没有项目：在市政厅写下一个 idea，这里就会开出一条流水线')], { at: [3.2, 0.9, D / 2], w: 3.2, size: 0.1, wrap: true, rot: -Math.PI / 2 });
  lines.forEach((ln, i) => {
    const z = D / 2 + (slots[i] - (n - 1) / 2) * GAP, x0 = 2.6, x1 = W - 0.6, len = x1 - x0, moving = RUNS.has(ln.status);
    p.block(x0, 0.24, z - 0.21, len, 0.07, 0.04, 'metal');
    p.block(x0, 0.24, z + 0.17, len, 0.07, 0.04, 'metal');
    for (let x = x0 + 0.1; x < x1; x += 0.6) for (const s of [-0.19, 0.19]) p.tube([x, 0, z + s], [x, 0.25, z + s], 0.018, 'dark');
    for (const x of [x0, x1]) p.tube([x, 0.27, z - 0.19], [x, 0.27, z + 0.19], 0.04, 'metal', 16, true);
    const belt = stripe(k, ['#4b4038', '#5d5046'], len, 0.36, 0.3);
    belt.mesh.position.set((x0 + x1) / 2, 0.305, z);
    const speed = moving ? 0.35 : 0;
    k.solid(x0, z - 0.2, len, 0.4, 0.31, () => [speed, 0]);
    const reach = ln.status === 'done' ? 7 : ln.stages.findIndex(s => s.status !== 'done');
    const parts = ln.stages.slice(0, 8).map((s, j) => {
      const x = X0 + j * STEP;
      const shape = stationShape(k, s.key, x, z, LAMP[s.status] ?? LAMP.todo);
      k.sign([s.name], { at: [x + 0.08, 0.565, z + 0.335], w: 0.36, size: 0.055, bg: '#fdf7e6' });
      k.sign([s.name], { at: [x - 0.08, 0.565, z - 0.335], w: 0.36, size: 0.055, bg: '#fdf7e6', rot: Math.PI });
      k.thing(x - 0.36, 0, z - 0.32, 0.72, 0.72, 0.64, {
        title: `#${ln.seq} ${cut(ln.title, 30)}`,
        sub: `${s.name} · ${statusName(s.status)}${s.status === 'run' ? ` · ${s.pct}%` : ''}`,
        note: s.note || s.out || undefined,
        act: { kind: 'open', building: s.building, line: ln.id },
      });
      return { s, shape, x };
    });
    const bx = 2.5;
    for (const s of [-0.5, 0.5]) p.tube([bx, H - 0.12, z + s], [bx, 1.24, z + s], 0.006, 'dark');
    k.sign([`#${ln.seq} ${cut(ln.title, 22)}`, `${statusName(ln.status)} · ${ln.pct}%`], { at: [bx, 1.14, z], w: 1.1, size: 0.06, rot: -Math.PI / 2 });
    const bar = k.lamp(new THREE.BoxGeometry(0.02, 0.025, 1.0), '#e4d6b8');
    bar.position.set(bx - 0.02, 1.01, z);
    const fill = k.lamp(new THREE.BoxGeometry(0.025, 0.027, 1.0), ln.status === 'done' ? LAMP.done : '#e0a030');
    fill.scale.z = Math.max(0.01, ln.pct / 100);
    fill.position.set(bx - 0.025, 1.01, z - 0.5 * (1 - fill.scale.z));
    const end = reach < 0 ? x1 - 0.2 : X0 + reach * STEP;
    const sheets = Array.from({ length: 5 }, (_, j) => {
      const m = k.mesh(new THREE.BoxGeometry(0.17, 0.012, 0.23), 'white');
      m.position.set(x0 + 0.2 + j * ((end - x0 - 0.2) / 5), 0.318, z);
      return m;
    });
    if (ln.status === 'done') for (let j = 0; j < 3; j++) p.block(x1 - 0.55 - j * 0.02, 0.32 + j * 0.13, z - 0.14, 0.3, 0.12, 0.28, 'wood');
    movers.push((t, dt) => {
      if (moving) {
        belt.tex.offset.x -= dt * speed / 0.3;
        for (const m of sheets) {
          m.position.x += dt * speed;
          if (m.position.x > end) m.position.x = x0 + 0.2;
        }
      }
      for (const { s, shape, x } of parts) {
        const run = s.status === 'run' && moving;
        shape.bulb.scale.setScalar(s.status === 'run' ? 1 + 0.25 * Math.sin(t * 5 + x) : 1);
        if (shape.piston) shape.piston.position.y = 0.36 + (run ? Math.max(0, Math.sin(t * 3 + x)) * 0.08 : 0.08);
        if (shape.spin && run) shape.spin.rotation.z -= dt * 2.2;
        if (shape.scan) shape.scan.position.x = x + (run ? Math.sin(t * 2.4) * 0.26 : 0);
        if (shape.glow) shape.glow.visible = s.status !== 'todo' && (!run || Math.sin(t * 3 + x * 2) > -0.6);
      }
    });
  });
  return { W, D, H, update: (t: number, dt: number) => movers.forEach(f => f(t, dt)) };
}

// the press: a rotary press per paper being written
function pressHall(k: Kit, pl: Placement, data: HallData) {
  const st = (l: Line, key: string) => l.stages.find(s => s.key === key);
  let lines = data.lines.filter(l => ['write', 'review', 'ship'].some(key => { const s = st(l, key); return !!s && s.status !== 'todo'; }));
  if (!lines.length) lines = data.lines.slice(0, 2);
  lines = lines.sort((a, b) => b.seq - a.seq).slice(0, 4);
  const n = Math.max(1, lines.length), W = 9.4, D = 3.4 + (n - 1) * 2.2 + 1.8, H = 2.5;
  k.room(W, D, H, pl, { floor: '#cfc8ba' });
  const p = k.p, INKS = ['#2f9fc4', '#c64f86', '#e5bf3c', '#3a3530'];
  const movers: ((t: number, dt: number) => void)[] = [];
  const x0 = 2.2, x1 = 7.6;
  lines.forEach((ln, i) => {
    const z = D - 3.4 - i * 2.2, w = st(ln, 'write'), run = w?.status === 'run' && RUNS.has(ln.status);
    const done = w?.status === 'done', pct = done ? 100 : w?.pct ?? 0;
    const sub = `${w?.name ?? tr('写作排版')} · ${statusName(w?.status ?? 'todo')} · ${pct}%`;
    p.block(x0 - 0.75, 0, z - 0.42, 0.1, 0.5, 0.06, 'dark');
    p.block(x0 - 0.75, 0, z + 0.36, 0.1, 0.5, 0.06, 'dark');
    const reel = new THREE.CylinderGeometry(0.24, 0.24, 0.66, 24);
    reel.rotateX(Math.PI / 2);
    const roll = k.mesh(reel, 'white');
    roll.position.set(x0 - 0.7, 0.46, z);
    p.block(x0 - 0.1, 0, z - 0.45, x1 - x0 + 0.2, 0.14, 0.9, 'dark');
    const spins: THREE.Mesh[] = [];
    for (let u = 0; u < 4; u++) {
      const ux = x0 + 0.35 + u * 1.05;
      for (const s of [-1, 1]) p.block(ux - 0.32, 0.14, z + s * 0.38 - (s > 0 ? 0.06 : 0), 0.64, 0.9, 0.06, 'acc');
      p.block(ux - 0.34, 1.04, z - 0.44, 0.68, 0.06, 0.88, 'acc');
      p.block(ux - 0.22, 1.1, z - 0.3, 0.44, 0.12, 0.6, '#e9e2d2');
      p.block(ux - 0.15, 1.1, z - 0.31, 0.3, 0.08, 0.02, INKS[u], false);
      for (const [cy, r] of [[0.66, 0.13], [0.36, 0.11], [0.86, 0.07]] as const) {
        const g = new THREE.CylinderGeometry(r, r, 0.68, 20);
        g.rotateX(Math.PI / 2);
        const c = k.mesh(g, cy === 0.86 ? INKS[u] : 'metal');
        c.position.set(ux, cy, z);
        spins.push(c);
      }
      k.sign([['C', 'M', 'Y', 'K'][u]], { at: [ux, 0.95, z + 0.445], w: 0.16, size: 0.08, bg: INKS[u], color: '#fffaf2' });
    }
    const web = stripe(k, ['#fbf6ea', '#e9e1cf'], x1 - x0 + 0.6, 0.6, 0.5);
    web.mesh.position.set((x0 + x1) / 2 - 0.2, 0.51, z);
    p.block(x1 + 0.1, 0, z - 0.4, 0.8, 0.3, 0.8, 'dark');
    p.block(x1 + 0.12, 0.3, z - 0.36, 0.06, 0.28, 0.72, 'metal');
    const stack = k.mesh(new THREE.BoxGeometry(0.42, 1, 0.56), 'white');
    const sh = 0.02 + 0.3 * pct / 100;
    stack.scale.y = sh;
    stack.position.set(x1 + 0.52, 0.3 + sh / 2, z);
    const flying = Array.from({ length: 3 }, () => {
      const m = k.mesh(new THREE.BoxGeometry(0.4, 0.008, 0.54), 'white');
      m.visible = run;
      return m;
    });
    p.block(x0 - 0.3, 0, z + 0.62, 0.5, 0.42, 0.3, 'wall');
    p.block(x0 - 0.3, 0.42, z + 0.62, 0.5, 0.03, 0.3, 'dark');
    const leds = [LAMP.done, run ? LAMP.run : LAMP.todo, done ? LAMP.done : LAMP.todo].map((c, j) => {
      const m = k.lamp(new THREE.SphereGeometry(0.02, 8, 6), c);
      m.position.set(x0 - 0.2 + j * 0.12, 0.46, z + 0.72);
      return m;
    });
    k.solid(x0 - 0.3, z + 0.62, 0.5, 0.3, 0.45);
    k.solid(x1 + 0.1, z - 0.4, 0.8, 0.8, 0.3 + sh);
    p.tube([0.75, 0, z + 0.62], [0.75, 0.62, z + 0.62], 0.02, 'dark');
    k.sign([`#${ln.seq} ${cut(ln.title, 24)}`, sub], { at: [0.75, 0.78, z + 0.645], w: 1.15, size: 0.065 });
    k.solid(0.7, z + 0.57, 0.1, 0.1, 0.9);
    k.thing(x0 - 0.8, 0, z - 0.46, x1 - x0 + 1.75, 1.22, 0.92, {
      title: `#${ln.seq} ${cut(ln.title, 30)}`,
      sub,
      note: (ln.files ?? []).filter(f => /\.(tex|pdf)$/.test(f)).slice(0, 3).join(' · ') || undefined,
      act: { kind: 'open', building: pl.id, line: ln.id },
    });
    movers.push((t, dt) => {
      leds[1].scale.setScalar(run ? 1 + 0.4 * Math.sin(t * 6) : 1);
      if (!run) return;
      roll.rotation.z += dt * 1.6;
      for (const c of spins) c.rotation.z -= dt * 5;
      web.tex.offset.x -= dt * 1.4;
      flying.forEach((m, j) => {
        const u = (t * 0.7 + j / 3) % 1;
        m.position.set(x1 - 0.1 + u * 0.62, 0.62 + Math.sin(u * Math.PI) * 0.18 - u * (0.3 - sh), z);
        m.rotation.z = -Math.sin(u * Math.PI) * 0.3;
      });
    });
  });
  const cz = D / 2 - 0.6;
  p.block(0.25, 0, cz, 0.7, 0.62, 1.2, 'wood');
  const g = new THREE.BoxGeometry(0.62, 0.04, 1.1);
  g.rotateZ(-0.35);
  g.translate(0.6, 0.72, cz + 0.6);
  p.geom(g, 'dark');
  for (let a = 0; a < 5; a++) for (let b = 0; b < 9; b++) {
    if (hash(`${a}.${b}`) < 0.3) continue;
    p.block(0.36 + a * 0.1, 0.77 - a * 0.037, cz + 0.12 + b * 0.11, 0.05, 0.03, 0.05, hash(`${a}${b}`, 3) < 0.5 ? 'metal' : 'acc', false);
  }
  k.sign(['TeX'], { at: [0.27, 1.02, cz + 0.6], w: 0.5, size: 0.14, rot: Math.PI / 2, bg: null });
  k.thing(0.25, 0, cz, 0.7, 0.8, 1.2, { title: tr('排版台'), sub: tr('TeX 源码、编译和 PDF'), act: { kind: 'open', building: pl.id } });
  return { W, D, H, update: (t: number, dt: number) => movers.forEach(f => f(t, dt)) };
}

// the farm: a greenhouse, one bed per experiment
function farmHall(k: Kit, pl: Placement, data: HallData) {
  const order = { running: 0, queued: 1, done: 2, failed: 3, cancelled: 4 } as Record<string, number>;
  const jobs = [...data.jobs].sort((a, b) => (order[a.status] ?? 5) - (order[b.status] ?? 5) || b.created_at.localeCompare(a.created_at)).slice(0, 16);
  const cols = 4, rows = Math.max(1, Math.ceil(jobs.length / cols)), BW = 1.3, BD = 0.66, GX = 0.62, GZ = 0.85;
  const W = 1.0 + cols * BW + (cols - 1) * GX + 1.0, D = 2.8 + rows * (BD + GZ) + 0.6, H = 2.2;
  k.room(W, D, H, pl, { floor: '#d9cdb0', glass: true, sky: '#e3ecdf' });
  const p = k.p;
  const sway: { g: THREE.Group; ph: number; amp: number }[] = [];
  const lights: { m: THREE.Mesh; ph: number }[] = [];
  if (!jobs.length) k.sign([tr('这里还没有实验：方法定下来以后，实验会在这里一畦一畦长出来')], { at: [W / 2, 0.8, D - 2.8], w: 3.0, size: 0.1, wrap: true });
  for (let i = 0; i < Math.max(jobs.length, 4); i++) {
    const job = jobs[i], c = i % cols, r = Math.floor(i / cols);
    const x = 1.0 + c * (BW + GX), z = D - 2.8 - BD - r * (BD + GZ);
    p.block(x, 0, z, BW, 0.2, 0.05, 'wood');
    p.block(x, 0, z + BD - 0.05, BW, 0.2, 0.05, 'wood');
    p.block(x, 0, z, 0.05, 0.2, BD, 'wood');
    p.block(x + BW - 0.05, 0, z, 0.05, 0.2, BD, 'wood');
    p.block(x + 0.05, 0, z + 0.05, BW - 0.1, 0.17, BD - 0.1, 'soil', false);
    k.solid(x, z, BW, BD, 0.2);
    if (!job) continue;
    const prog = job.status === 'done' ? 1 : job.status === 'running' ? Math.max(0.12, job.progress / 100) : job.status === 'queued' ? 0.06 : job.status === 'failed' ? 0.4 : 0;
    const g = new THREE.Group();
    const cp = new Pen3();
    const crop = job.status === 'failed' ? '#a88a5c' : 'crop';
    if (prog) for (let a = 0; a < 3; a++) for (let b = 0; b < 7; b++) {
      const px = x + 0.14 + b * ((BW - 0.28) / 6), pz = z + 0.15 + a * ((BD - 0.3) / 2), h = 0.04 + 0.34 * prog * (0.85 + hash(`${i}${a}${b}`) * 0.3);
      const lean = job.status === 'failed' ? 0.06 : 0;
      for (const [dx, dz] of [[-0.018, 0], [0.018, 0.012], [0, -0.016]]) cp.block(px + dx - 0.007 + lean, 0.17, pz + dz - 0.007, 0.014, h, 0.014, crop, false);
      if (prog > 0.3) cp.block(px - 0.03, 0.17 + h * 0.45, pz - 0.006, 0.06, 0.012, 0.012, 'leaf', false);
      if (job.status === 'done') cp.block(px - 0.02, 0.17 + h, pz - 0.02, 0.04, 0.08, 0.04, 'crop2', false);
    }
    for (const o of meshes(cp, k.color, k.mats)) g.add(o);
    k.scene.add(g);
    sway.push({ g, ph: i * 1.7, amp: job.status === 'failed' ? 0.002 : 0.012 });
    if (job.status === 'running') {
      for (const s of [0.3, 0.7]) p.tube([x + BW * s, H - 0.05, z + BD / 2], [x + BW * s, 1.12, z + BD / 2], 0.005, 'dark');
      p.block(x + 0.1, 1.06, z + BD / 2 - 0.05, BW - 0.2, 0.05, 0.1, 'dark');
      const m = k.lamp(new THREE.BoxGeometry(BW - 0.26, 0.012, 0.06), '#f08ad8');
      m.position.set(x + BW / 2, 1.055, z + BD / 2);
      lights.push({ m, ph: i });
    } else if (job.status === 'done') {
      p.block(x + BW + 0.08, 0, z + 0.1, 0.3, 0.2, 0.26, 'wood');
      for (let j = 0; j < 5; j++) p.block(x + BW + 0.11 + (j % 3) * 0.08, 0.2, z + 0.14 + Math.floor(j / 3) * 0.1, 0.07, 0.05, 0.07, 'crop2', false);
    }
    const state = `${statusName(job.status)}${job.status === 'running' ? ` · ${job.progress}%` : ''}`;
    p.tube([x + 0.12, 0, z + BD + 0.04], [x + 0.12, 0.38, z + BD + 0.04], 0.012, 'wood');
    k.sign([cut(job.name, 22), state], { at: [x + 0.42, 0.36, z + BD + 0.06], w: 0.66, size: 0.055 });
    k.thing(x, 0, z, BW, 0.55, BD, {
      title: job.name,
      sub: `${job.backend} · ${state}`,
      note: job.note ?? (job.nvidb ? `${job.nvidb.node ?? ''} ${job.nvidb.lane ?? ''}`.trim() : undefined),
      act: { kind: 'open', building: pl.id, line: job.line_id },
    }, false);
  }
  p.tube([0.4, 0.05, 0.22], [W - 0.4, 0.05, 0.22], 0.025, '#5f8fb0');
  for (let x = 1.0; x < W - 0.5; x += BW + GX) p.tube([x + BW / 2, 0.05, 0.22], [x + BW / 2, 0.05, D - 2.8 - BD + 0.05], 0.012, '#5f8fb0');
  p.tube([0.06, 1.6, 0.4], [W - 0.4, 1.6, 0.4], 0.02, 'dark');
  p.block(W - 0.6, 1.3, 0.08, 0.3, 0.42, 0.12, '#e0a030');
  k.sign([tr('算力电厂')], { at: [W - 0.45, 1.12, 0.15], w: 0.6, size: 0.06 });
  const update = (t: number) => {
    for (const s of sway) s.g.rotation.z = Math.sin(t * 1.1 + s.ph) * s.amp;
    for (const l of lights) (l.m.material as THREE.MeshBasicMaterial).color.setStyle(Math.sin(t * 2 + l.ph) > 0.92 ? '#ffd0f0' : '#f08ad8');
  };
  return { W, D, H, update };
}

// a 19-inch rack, a little larger than life so its gear reads from the aisle
const RW = 0.34, RD = 0.52, RH = 0.98, U = 0.03, U0 = 0.07, US = 28; // width, depth, height; one rack unit; the lowest; how many

// a face for rack gear, drawn on a canvas and lit like the rest
function gearFace(k: Kit, pxW: number, pxH: number, draw: (c: CanvasRenderingContext2D, w: number, h: number) => void) {
  const c = document.createElement('canvas');
  c.width = pxW; c.height = pxH;
  draw(c.getContext('2d')!, pxW, pxH);
  const tex = k.owned(new THREE.CanvasTexture(c));
  tex.anisotropy = 4;
  return k.owned(new THREE.MeshLambertMaterial({ map: tex }));
}

function faces(k: Kit) {
  const grid = (c: CanvasRenderingContext2D, w: number, h: number, bg: string, dot: string, step: number) => {
    c.fillStyle = bg; c.fillRect(0, 0, w, h);
    c.fillStyle = dot;
    for (let y = step / 2, r = 0; y < h; y += step * 0.86, r++) for (let x = (r % 2 ? step : step / 2); x < w; x += step) { c.beginPath(); c.arc(x, y, step * 0.3, 0, 7); c.fill(); }
  };
  return {
    grille: gearFace(k, 256, 64, (c, w, h) => grid(c, w, h, '#34373b', '#1b1d20', 9)),
    ports: gearFace(k, 384, 32, (c, w, h) => {
      c.fillStyle = '#2b2e32'; c.fillRect(0, 0, w, h);
      for (let i = 0; i < 24; i++) for (let r = 0; r < 2; r++) {
        const x = 70 + i * 12.5, y = 4 + r * 13;
        c.fillStyle = '#121416'; c.fillRect(x, y, 10, 10);
        c.strokeStyle = '#4a4e53'; c.strokeRect(x + 0.5, y + 0.5, 9, 9);
      }
      c.fillStyle = '#9aa0a6'; c.fillRect(8, 10, 40, 3); c.fillRect(8, 18, 28, 3);
    }),
    drives: gearFace(k, 256, 64, (c, w, h) => {
      c.fillStyle = '#26292c'; c.fillRect(0, 0, w, h);
      for (let i = 0; i < 12; i++) {
        const x = 4 + i * 21;
        c.fillStyle = '#c4c2bb'; c.fillRect(x, 5, 18, h - 10);
        c.fillStyle = '#7b7a76'; c.fillRect(x + 3, h - 16, 12, 3);
        c.fillStyle = '#3a3c3f'; c.fillRect(x + 7, 10, 4, 4);
      }
    }),
    bezel: gearFace(k, 256, 64, (c, w, h) => {
      c.fillStyle = '#b8bbbe'; c.fillRect(0, 0, w, h);
      c.strokeStyle = '#9da1a5'; c.lineWidth = 3;
      for (let x = -h; x < w; x += 10) { c.beginPath(); c.moveTo(x, h); c.lineTo(x + h, 0); c.stroke(); }
      c.fillStyle = '#2b2e31'; c.fillRect(150, 10, 96, h - 20);
      for (let i = 0; i < 4; i++) { c.fillStyle = '#d2d4d6'; c.fillRect(154 + i * 23, 14, 19, h - 28); }
    }),
    vents: gearFace(k, 256, 96, (c, w, h) => {
      c.fillStyle = '#2a2a2b'; c.fillRect(0, 0, w, h);
      c.fillStyle = '#141415';
      for (let y = 10; y < h - 6; y += 9) c.fillRect(110, y, 136, 4);
    }),
    blank: gearFace(k, 128, 16, (c, w, h) => {
      c.fillStyle = '#303337'; c.fillRect(0, 0, w, h);
      c.fillStyle = '#3a3d41'; c.fillRect(0, 0, w, 2);
      c.fillStyle = '#4b4f54'; c.fillRect(6, h / 2 - 2, 4, 4); c.fillRect(w - 10, h / 2 - 2, 4, 4);
    }),
  };
}

interface RackFx { fans: { m: THREE.Object3D; v: number }[]; blink: { m: THREE.Mesh; rate: number; ph: number; duty: number }[] }

// one rack cabinet: frame and rails, its gear from the top down, power strips and cables at the back
function rack(k: Kit, F: ReturnType<typeof faces>, fx: RackFx, x: number, z: number, o: {
  name: string; up: boolean; gpus: Gpu[]; net?: boolean; util: number; card?: Omit<Thing, 'at'>; gpuCard?: (g: Gpu) => Omit<Thing, 'at'>;
}) {
  const p = k.p, zb = z - RD / 2, zf = z + RD / 2, ix = x + 0.032, iw = RW - 0.064, body = RD - 0.08, gz = zf - 0.012;
  const on = o.up, ledOff = '#26231f';
  p.block(x, 0, zb, RW, 0.03, RD, '#26282b');
  for (const px of [x, x + RW - 0.026]) for (const pz of [zb, zf - 0.026]) p.block(px, 0.03, pz, 0.026, RH - 0.03, 0.026, '#202225');
  p.block(x, RH - 0.024, zb, RW, 0.024, RD, '#26282b');
  for (const sx of [x + 0.002, x + RW - 0.008]) {
    p.block(sx, 0.03, zb + 0.026, 0.006, RH - 0.054, RD - 0.052, '#393c40', false);
    for (let v = 0; v < 6; v++) k.faint.push(sx + (sx > x + 0.1 ? 0.007 : -0.001), 0.1 + v * 0.13, zb + 0.08, sx + (sx > x + 0.1 ? 0.007 : -0.001), 0.1 + v * 0.13, zf - 0.08);
  }
  for (const rx of [x + 0.026, x + RW - 0.032]) {
    p.block(rx, U0, zf - 0.02, 0.006, US * U, 0.006, '#55595e', false);
    for (let u = 0; u <= US; u += 1) k.faint.push(rx, U0 + u * U, zf - 0.013, rx + 0.006, U0 + u * U, zf - 0.013);
  }
  const plate = (mat: THREE.Material, px: number, py: number, w: number, h: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    m.position.set(px + w / 2, py + h / 2, gz + 0.0015);
    k.scene.add(m);
    return m;
  };
  const led = (px: number, py: number, color: string, rate = 0, duty = 0.5, r = 0.0045) => {
    const m = k.lamp(new THREE.BoxGeometry(r, r, 0.003), color);
    m.position.set(px, py, gz + 0.003);
    if (rate) fx.blink.push({ m, rate, ph: Math.random() * 10, duty });
    return m;
  };
  let top = U0 + US * U;
  const slot = (n: number, color: string) => {
    const y = top - n * U;
    top = y;
    p.block(ix, y + 0.001, gz - body, iw, n * U - 0.002, body, color, false);
    k.faint.push(ix, y + 0.001, gz + 0.001, ix + iw, y + 0.001, gz + 0.001);
    return y + 0.001;
  };
  const busy = (c: number) => (on ? c : 0);
  const sw = () => { // a network switch
    const y = slot(1, '#2b2e32');
    plate(F.ports, ix, y, iw, U - 0.002);
    for (let i = 0; i < 8; i++) led(ix + 0.07 + i * 0.026, y + U - 0.007, on ? '#6fe07a' : ledOff, busy(3 + (i % 3) * 2), 0.6);
  };
  const manager = () => {
    const y = slot(1, '#1d1f22');
    k.faint.push(ix + 0.01, y + U / 2, gz + 0.002, ix + iw - 0.01, y + U / 2, gz + 0.002);
  };
  sw();
  manager();
  if (o.net) {
    sw(); sw(); manager(); sw();
    const y = slot(3, '#2a2d31');
    plate(F.drives, ix, y, iw, 3 * U - 0.002);
    led(ix + 0.012, y + 0.075, on ? '#6fe07a' : ledOff, busy(1.2), 0.7);
  } else {
    const y = slot(2, '#b8bbbe');
    plate(F.bezel, ix, y, iw, 2 * U - 0.002);
    k.sign([o.name], { at: [ix + 0.07, y + 0.042, gz + 0.004], w: 0.13, size: 0.0125, bg: '#e9e4d6', back: false });
    k.sign([on ? `${o.util}%` : '--'], { at: [ix + 0.07, y + 0.017, gz + 0.004], w: 0.06, size: 0.012, bg: on ? '#1d3a28' : '#1a1a1a', color: '#9fffb0', back: false });
    led(ix + 0.012, y + 0.03, on ? '#6fe07a' : '#d9574a', on ? 0 : 0.8, 0.5, 0.006);
    for (const g of o.gpus.slice(0, 10)) {
      const ty = slot(2, '#2f3236'), th = 2 * U - 0.002, util = on ? g.util_percent : 0, mem = on ? g.mem_used_mb / Math.max(1, g.mem_total_mb) : 0;
      plate(F.grille, ix + 0.1, ty, iw - 0.15, th);
      k.sign([`GPU ${g.index}`], { at: [ix + 0.045, ty + th * 0.7, gz + 0.004], w: 0.07, size: 0.0125, bg: '#e8e3d6', back: false });
      const color = util < 30 ? LAMP.done : util < 80 ? LAMP.run : LAMP.wait;
      for (let s = 0; s < 10; s++) {
        const m = k.lamp(new THREE.BoxGeometry(0.0055, 0.008, 0.003), on && util >= (s + 0.5) * 10 ? color : ledOff);
        m.position.set(ix + 0.016 + s * 0.0062, ty + th * 0.36, gz + 0.003);
      }
      p.block(ix + 0.013, ty + th * 0.13, gz, 0.064, 0.0045, 0.002, '#191b1d', false);
      if (mem > 0.01) {
        const m = k.lamp(new THREE.BoxGeometry(0.064 * mem, 0.0045, 0.003), '#58b4ec');
        m.position.set(ix + 0.013 + 0.032 * mem, ty + th * 0.13 + 0.00225, gz + 0.003);
      }
      const cx = ix + iw - 0.027, cy = ty + th / 2;
      p.ring([cx, cy, gz + 0.0035], 0.021, 18);
      const hub = new THREE.Group();
      for (let b = 0; b < 5; b++) {
        const blade = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.008, 0.002), k.mats.surface('#8f8a82'));
        blade.rotation.z = b * Math.PI * 2 / 5;
        hub.add(blade);
      }
      hub.position.set(cx, cy, gz + 0.004);
      k.scene.add(hub);
      fx.fans.push({ m: hub, v: on ? 2 + util / 100 * 16 : 0 });
      led(ix + 0.008, ty + th * 0.7, on ? '#7ff07a' : ledOff, util > 0 ? 5 + util / 10 : on ? 0.6 : 0, util > 0 ? 0.5 : 0.15);
      if (o.gpuCard) k.thing(ix, ty, gz - 0.03, iw, th, 0.045, o.gpuCard(g), false);
    }
    const sy = slot(2, '#26292c');
    plate(F.drives, ix, sy, iw, 2 * U - 0.002);
    for (let i = 0; i < 12; i++) led(ix + 0.013 + i * 0.0233, sy + 0.012, on ? '#5ab0ff' : ledOff, busy(0.7 + (i % 4) * 0.5), 0.8, 0.003);
  }
  const upsTop = U0 + 3 * U;
  while (top - U >= upsTop - 1e-6) { const y = slot(1, '#303337'); plate(F.blank, ix, y, iw, U - 0.002); }
  top = upsTop;
  const uy = slot(3, '#2a2a2b');
  plate(F.vents, ix, uy, iw, 3 * U - 0.002);
  k.sign([on ? '230V · 72%' : '--'], { at: [ix + 0.05, uy + 0.05, gz + 0.004], w: 0.08, size: 0.011, bg: on ? '#1d3a28' : '#1a1a1a', color: '#9fffb0', back: false });
  led(ix + 0.012, uy + 0.03, on ? '#6fe07a' : ledOff, 0, 0.5, 0.006);
  k.sign([o.name], { at: [x + RW / 2, RH - 0.045, zf + 0.002], w: RW - 0.07, size: 0.024, bg: on ? '#ece6d7' : '#8f887c', back: false });
  const strip = k.lamp(new THREE.BoxGeometry(RW - 0.06, 0.006, 0.004), on ? (o.util > 80 ? LAMP.wait : o.util > 30 ? LAMP.run : LAMP.done) : '#5a3a34');
  strip.position.set(x + RW / 2, RH - 0.018, zf + 0.003);
  for (const px of [x + 0.04, x + RW - 0.06]) {
    p.block(px, 0.12, zb + 0.03, 0.02, 0.74, 0.02, '#9c3328');
    const lcd = k.lamp(new THREE.BoxGeometry(0.014, 0.02, 0.003), on ? '#ff7a5c' : ledOff);
    lcd.position.set(px + 0.01, 0.8, zb + 0.0285);
  }
  for (let c = 0; c < 4; c++) p.tube([x + 0.1 + c * 0.04, RH, zb + 0.06], [x + 0.1 + c * 0.04, 0.12, zb + 0.06], 0.006, ['#4f8ac9', '#e0a030', '#d9574a', '#5aa060'][c]);
  p.block(ix, U0, zb + 0.004, iw, US * U, 0.004, '#1e2022', false);
  for (let r = 0; r < 14; r++) k.faint.push(ix + 0.02, U0 + 0.03 + r * 0.058, zb + 0.003, ix + iw - 0.02, U0 + 0.03 + r * 0.058, zb + 0.003);
  for (let c = 0; c < 3; c++) p.tube([x + 0.12 + c * 0.05, RH, z - 0.1], [x + 0.12 + c * 0.05, 1.18, z - 0.1], 0.007, ['#4f8ac9', '#e0a030', '#d9574a'][c]);
  k.solid(x, zb, RW, RD, RH);
  if (o.card) k.thing(x - 0.015, 0, zb, RW + 0.03, RH, RD, o.card, false);
}

// the power plant: a rack cabinet per machine, the network cabinet and a cooling unit at either end
function gpuHall(k: Kit, pl: Placement, data: HallData, sim: boolean) {
  let nodes: GpuNode[] = data.gpus?.ok ? data.gpus.nodes : [];
  if (sim) {
    const n = data.plant?.gpus ?? 4, busy = data.plant?.busy ?? 0;
    nodes = [{
      name: 'FakeGPU', state: 'up', enabled: true, last_seen: null, last_error: null,
      gpus: Array.from({ length: n }, (_, i): Gpu => ({
        index: i, name: tr('模拟卡'), mem_total_mb: 24576, mem_used_mb: i < busy ? 18000 : 0, free_mb: 0, util_percent: i < busy ? 96 : 0,
        temperature_c: null, queue_mem_mb: 0, external_mem_mb: 0, reserved_mb: 0, attribution: null, state: i < busy ? 'room' : 'idle', procs: [],
      })),
    }];
  }
  const dark = !nodes.length;
  if (dark) nodes = [0, 1, 2].map(() => ({ name: '—', state: 'down', enabled: false, last_seen: null, last_error: null, gpus: [] }));
  nodes = nodes.slice(0, 8);
  const n = nodes.length + 1, gap = 0.03, CL = 0.3, row = n * RW + (n - 1) * gap;
  const W = Math.max(6.6, row + 4), D = 5.8, H = 2.4, z = 1.45, x0 = (W - row) / 2;
  k.room(W, D, H, pl, { floor: '#c9cdd0', wall: '#e4e2da', sky: '#dfe3e2' });
  const p = k.p, F = faces(k), fx: RackFx = { fans: [], blink: [] };
  for (let x = Math.floor(x0 - CL - 0.5); x < x0 + row + CL + 0.5; x += 0.5) for (let r = 0; r < 2; r++) {
    const tz = z + RD / 2 + 0.05 + r * 0.5;
    p.block(x + 0.01, 0, tz, 0.48, 0.006, 0.48, '#b7c6cf', false);
    for (let l = 0; l < 4; l++) k.faint.push(x + 0.06, 0.007, tz + 0.07 + l * 0.1, x + 0.44, 0.007, tz + 0.07 + l * 0.1);
  }
  for (const cx of [x0 - gap - CL, x0 + row + gap]) {
    p.block(cx, 0, z - RD / 2, CL, RH, RD, '#dcdcd4');
    for (let r = 0; r < 16; r++) k.faint.push(cx + 0.04, 0.12 + r * 0.045, z + RD / 2 + 0.001, cx + CL - 0.04, 0.12 + r * 0.045, z + RD / 2 + 0.001);
    k.sign([dark ? '--' : '18°C'], { at: [cx + CL / 2, 0.86, z + RD / 2 + 0.003], w: 0.12, size: 0.035, bg: dark ? '#1a1a1a' : '#1d3a28', color: '#9fffb0', back: false });
    k.solid(cx, z - RD / 2, CL, RD, RH);
  }
  const gb = (mb: number) => (mb / 1024).toFixed(0);
  const procNames = (g: Gpu) => g.procs.map(q => q.job_name ?? q.name).filter(Boolean);
  nodes.forEach((node, i) => {
    const gpus = node.gpus, up = !dark && node.state === 'up';
    const util = gpus.length ? Math.round(gpus.reduce((a, g) => a + g.util_percent, 0) / gpus.length) : 0;
    const used = gpus.reduce((a, g) => a + g.mem_used_mb, 0), total = gpus.reduce((a, g) => a + g.mem_total_mb, 0);
    const jobs = [...new Set(gpus.flatMap(procNames))].slice(0, 2).join(' · ');
    const real = !sim && !dark, lanes = real ? (data.gpus?.lanes ?? []).filter(l => l.node === node.name) : [];
    const waiting = (on?: number) => lanes.filter(l => on == null || l.gpu_ids.includes(on)).reduce((a, l) => a + l.queued.length, 0);
    const more = (n: number) => (n ? tr('队列里还有 {0} 个', n) : '');
    rack(k, F, fx, x0 + i * (RW + gap), z, {
      name: dark ? '—' : node.name, up, gpus, util,
      card: dark ? undefined : {
        title: node.name,
        sub: `${gpus.length} GPU · ${node.state} · ${util}% · ${gb(used)}/${gb(total)} GB`,
        note: [jobs, more(waiting())].filter(Boolean).join(' · ') || node.last_error || undefined,
        verb: real ? tr('看这台机器') : undefined,
        act: { kind: 'open', building: pl.id, line: real ? `node:${node.name}` : null },
      },
      gpuCard: g => ({
        title: `${node.name} · GPU ${g.index}`,
        sub: `${cut(g.name, 22)} · ${g.util_percent}% · ${(g.mem_used_mb / 1024).toFixed(1)}/${gb(g.mem_total_mb)} GB`,
        note: [procNames(g).slice(0, 2).join(' · '), more(waiting(g.index))].filter(Boolean).join(' · ')
          || (g.temperature_c != null ? `${g.temperature_c}°C` : undefined),
        verb: real ? tr('看这张卡') : undefined,
        act: { kind: 'open', building: pl.id, line: real ? `node:${node.name}/${g.index}` : null },
      }),
    });
  });
  rack(k, F, fx, x0 + nodes.length * (RW + gap), z, {
    name: tr('网络'), up: !dark, gpus: [], net: true, util: 0,
    card: { title: tr('网络机柜'), sub: tr('交换机、配线架和路由，把各台机器连在一起'), act: { kind: 'open', building: pl.id } },
  });
  p.block(x0 - 0.1, 1.18, z - 0.18, row + 0.2, 0.04, 0.24, 'metal');
  for (const s of [x0 - 0.05, x0 + row + 0.05]) p.tube([s, H, z - 0.06], [s, 1.22, z - 0.06], 0.008, 'dark');
  for (let c = 0; c < 3; c++) p.tube([x0 - 0.1, 1.24, z - 0.13 + c * 0.07], [x0 + row + 0.1, 1.24, z - 0.13 + c * 0.07], 0.016, ['#d9574a', '#e0a030', '#4f8ac9'][c]);
  const lines = dark ? [data.gpus?.note || tr('nvidb 没有连上：电厂里还是黑的')]
    : nodes.map(m => `${m.name} · ${m.state} · ${m.gpus.filter(g => g.util_percent > 10).length}/${m.gpus.length} ${tr('张卡在忙')}`);
  k.sign(lines.slice(0, 6), { at: [0.06, 1.62, 3.75], w: 1.5, size: 0.075, bg: '#2f3a35', color: '#cdeccf', align: 'left', wrap: true, rot: Math.PI / 2 });
  const update = (t: number, dt: number) => {
    for (const f of fx.fans) f.m.rotation.z -= dt * f.v;
    for (const b of fx.blink) b.m.visible = ((t * b.rate + b.ph) % 1) < b.duty;
  };
  return { W, D, H, update };
}

// the depot: shelving per repository, a desk per project's coder
function depotHall(k: Kit, pl: Placement, data: HallData) {
  type Repo = { id: string; label: string; lang?: string; release?: string; stars?: number; desc?: string };
  const repos: Repo[] = ((data.sheet?.repos ?? []) as Repo[]).slice(0, 5);
  const desks = (data.roster?.roster ?? []).slice(0, 6);
  const rows = Math.max(2, repos.length), W = Math.max(8.4, 1.6 + Math.max(desks.length, 3) * 1.25), D = 4.3 + rows * 1.35 + 0.8, H = 2.6;
  k.room(W, D, H, pl, { floor: '#cfc6b0' });
  const p = k.p;
  const screens: { tex: THREE.CanvasTexture; on: boolean }[] = [];
  desks.forEach((row, i) => {
    const x = 0.9 + i * 1.25, z = D - 2.6, a = row.agent, on = !!a && ['working', 'idle', 'starting', 'watching'].includes(a.status);
    p.block(x, 0.36, z, 0.9, 0.04, 0.5, 'wood');
    for (const [dx, dz] of [[0.03, 0.03], [0.83, 0.03], [0.03, 0.43], [0.83, 0.43]]) p.block(x + dx, 0, z + dz, 0.04, 0.36, 0.04, 'dark');
    p.block(x + 0.33, 0.4, z + 0.12, 0.24, 0.02, 0.1, 'dark');
    p.block(x + 0.43, 0.42, z + 0.15, 0.04, 0.1, 0.03, 'dark');
    p.block(x + 0.2, 0.5, z + 0.12, 0.5, 0.32, 0.03, '#2f2b28');
    p.block(x + 0.25, 0.4, z + 0.3, 0.4, 0.012, 0.12, 'white', false);
    const c = document.createElement('canvas');
    c.width = 128; c.height = 80;
    const tex = k.owned(new THREE.CanvasTexture(c));
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = on ? '#16241c' : '#1b1917'; ctx.fillRect(0, 0, 128, 80);
    if (!on) { ctx.fillStyle = '#4a4540'; ctx.font = `14px ${k.font}`; ctx.textAlign = 'center'; ctx.fillText(`#${row.line.seq}`, 64, 22); }
    else for (let r = 0; r < 14; r++) {
      ctx.fillStyle = ['#7fd38a', '#cfe8d0', '#e0c46a', '#86b8e8'][Math.floor(hash(`${i}${r}`) * 4)];
      ctx.fillRect(6 + Math.floor(hash(`${r}${i}`, 2) * 3) * 8, 4 + r * 11, 20 + hash(`${r}.${i}`) * 80, 4);
    }
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, 0.5);
    screens.push({ tex, on: a?.status === 'working' });
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.44, 0.27), k.owned(new THREE.MeshBasicMaterial({ map: tex })));
    scr.position.set(x + 0.45, 0.66, z + 0.155);
    k.scene.add(scr);
    p.block(x + 0.3, 0.2, z + 0.62, 0.3, 0.04, 0.28, 'acc');
    p.block(x + 0.3, 0.24, z + 0.88, 0.3, 0.3, 0.03, 'acc');
    p.tube([x + 0.45, 0, z + 0.76], [x + 0.45, 0.2, z + 0.76], 0.02, 'dark');
    k.sign([`#${row.line.seq} ${cut(row.line.title, 16)}`], { at: [x + 0.45, 0.87, z + 0.12], w: 0.52, size: 0.034 });
    k.thing(x, 0, z, 0.9, 0.82, 0.5, {
      title: `#${row.line.seq} ${cut(row.line.title, 30)}`,
      sub: a ? `${a.name || tr('代码员工')} · ${a.status}` : tr('还没有代码员工'),
      act: { kind: 'open', building: pl.id, line: row.line.id },
    });
  });
  if (!desks.length) k.sign([tr('还没有项目在这里写代码')], { at: [W / 2, 0.7, D - 2.4], w: 2.0, size: 0.1 });
  for (let i = 0; i < rows; i++) {
    const r = repos[i], z = D - 4.2 - i * 1.35, x0 = 1.0, len = W - 2.6;
    for (let x = x0; x <= x0 + len + 0.01; x += len / 3) for (const dz of [0, 0.5]) p.block(x - 0.03, 0, z + dz - 0.03, 0.06, 1.5, 0.06, '#d27a2c');
    for (const y of [0.05, 0.55, 1.05]) for (const dz of [0, 0.5]) p.block(x0, y + 0.06, z + dz - 0.02, len, 0.05, 0.04, '#3f6fb0');
    for (const y of [0.05, 0.55, 1.05]) for (let b = 0; b < 3; b++) for (let c = 0; c < 3; c++) {
      if (!r || hash(`${r.id}${y}${b}${c}`) > 0.35 + Math.min(0.5, (r.stars ?? 10) / 300)) continue;
      const cx = x0 + b * (len / 3) + 0.1 + c * (len / 9), s = 0.26 + hash(`${b}${c}${y}`) * 0.12;
      p.block(cx, y + 0.11, z + 0.04, s, 0.3 * (0.8 + hash(`${c}${y}`) * 0.4), 0.42, hash(`${r.id}${c}`) < 0.6 ? 'wood' : '#8fae6a');
    }
    k.solid(x0 - 0.05, z - 0.05, len + 0.1, 0.6, 1.62);
    if (r) {
      k.sign([r.label, [r.lang, r.release].filter(Boolean).join(' · ')], { at: [x0 + len / 2, 1.42, z + 0.53], w: 1.3, size: 0.08 });
      k.thing(x0, 0, z - 0.03, len, 1.6, 0.56, { title: r.label, sub: [r.lang, r.release, r.stars != null ? `★ ${r.stars}` : ''].filter(Boolean).join(' · '), note: r.desc, act: { kind: 'open', building: pl.id } });
    }
  }
  const fork = new THREE.Group(), fp = new Pen3();
  fp.block(-0.22, 0.05, -0.16, 0.44, 0.22, 0.32, '#e0a030');
  fp.block(-0.18, 0.27, -0.14, 0.24, 0.24, 0.02, 'dark'); fp.block(-0.18, 0.27, 0.12, 0.24, 0.24, 0.02, 'dark');
  fp.block(-0.2, 0.5, -0.15, 0.3, 0.03, 0.3, 'dark');
  fp.block(0.22, 0.02, -0.12, 0.04, 0.7, 0.04, 'dark'); fp.block(0.22, 0.02, 0.08, 0.04, 0.7, 0.04, 'dark');
  fp.block(0.26, 0.08, -0.12, 0.3, 0.02, 0.05, 'metal'); fp.block(0.26, 0.08, 0.07, 0.3, 0.02, 0.05, 'metal');
  fp.block(0.28, 0.1, -0.15, 0.28, 0.22, 0.3, 'wood');
  for (const [wx, wz] of [[-0.14, -0.17], [0.14, -0.17], [-0.14, 0.17], [0.14, 0.17]]) {
    const g = new THREE.CylinderGeometry(0.06, 0.06, 0.04, 14);
    g.rotateX(Math.PI / 2);
    g.translate(wx, 0.06, wz);
    fp.geom(g, 'dark');
  }
  for (const o of meshes(fp, k.color, k.mats)) fork.add(o);
  const beep = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), k.glow('#ff9a3a'));
  beep.position.set(-0.05, 0.56, 0);
  fork.add(beep);
  k.scene.add(fork);
  const aisle = D - 4.2 - rows * 1.35 + 0.85;
  const update = (t: number, dt: number) => {
    const u = (Math.sin(t * 0.25) + 1) / 2, dir = Math.cos(t * 0.25);
    fork.position.set(1.0 + u * (W - 3), 0, Math.max(0.8, aisle));
    fork.rotation.y = dir >= 0 ? 0 : Math.PI;
    beep.visible = Math.sin(t * 7) > 0;
    for (const s of screens) if (s.on) s.tex.offset.y = (s.tex.offset.y + dt * 0.08) % 1;
  };
  return { W, D, H, update };
}

// the library: a bookcase per topic
function libraryHall(k: Kit, pl: Placement, data: HallData) {
  const topics = (data.shelf?.topics ?? []).slice(0, 18);
  const per = 6, rows = Math.max(1, Math.ceil(topics.length / per)), CW = 1.05;
  const W = 1.6 + per * CW + 1.2, D = 3.7 + rows * 1.5 + 0.6, H = 2.6;
  k.room(W, D, H, pl, { floor: '#c69f72' });
  const p = k.p, SPINES = ['#8c3b2e', '#2f4f6f', '#4c6b3c', '#a7792e', '#6b4a7a', '#3b5d5a', '#b55a3a', '#5a4a3a', '#d8c9a0'];
  p.block(W / 2 - 0.5, 0, 0.6, 1.0, 0.006, D - 1.2, k.tint(0.45), false);
  const lampsAt: V3[] = [];
  for (const s of [-1, 1]) {
    const tx = W / 2 + s * 1.6 - 0.6, tz = D - 1.9;
    p.block(tx, 0.34, tz, 1.2, 0.04, 0.6, 'wood');
    for (const [dx, dz] of [[0.05, 0.05], [1.1, 0.05], [0.05, 0.5], [1.1, 0.5]]) p.block(tx + dx, 0, tz + dz, 0.05, 0.34, 0.05, 'dark');
    p.block(tx + 0.2, 0.38, tz + 0.2, 0.3, 0.012, 0.22, 'white', false);
    p.block(tx + 0.5, 0.38, tz + 0.2, 0.012, 0.02, 0.22, 'dark', false);
    p.tube([tx + 0.95, 0.38, tz + 0.3], [tx + 0.95, 0.56, tz + 0.3], 0.008, '#c9a227');
    lampsAt.push([tx + 0.95, 0.58, tz + 0.3]);
    k.solid(tx, tz, 1.2, 0.6, 0.38);
  }
  for (const c of lampsAt) {
    const sh = new THREE.CylinderGeometry(0.05, 0.08, 0.06, 14, 1, true);
    sh.translate(...c);
    p.geom(sh, '#3f7a4f');
    k.lamp(new THREE.SphereGeometry(0.03, 8, 6).translate(c[0], c[1] - 0.02, c[2]), '#ffe6a8');
  }
  topics.forEach((tp, i) => {
    const c = i % per, r = Math.floor(i / per), x = 0.9 + c * CW, z = D - 3.7 - r * 1.5, w = CW - 0.08;
    p.block(x, 0, z, 0.04, 1.02, 0.32, 'wood');
    p.block(x + w - 0.04, 0, z, 0.04, 1.02, 0.32, 'wood');
    p.block(x, 0, z, w, 1.02, 0.02, 'dark');
    p.block(x - 0.02, 1.02, z - 0.01, w + 0.04, 0.05, 0.35, 'wood');
    const full = Math.max(1, Math.min(4, Math.ceil(tp.n / 5)));
    for (let s = 0; s < 4; s++) {
      const y = 0.04 + s * 0.245;
      p.block(x + 0.04, y - 0.025, z, w - 0.08, 0.025, 0.32, 'wood');
      let bx = x + 0.05;
      while (3 - s < full && bx < x + w - 0.1) {
        const bw = 0.03 + hash(`${tp.label}${s}${bx}`) * 0.03, bh = 0.13 + hash(`${bx}${s}`) * 0.07;
        p.block(bx, y, z + 0.06, bw - 0.004, bh, 0.22, SPINES[Math.floor(hash(`${i}${bx}`, 5) * SPINES.length)], false);
        bx += bw;
      }
    }
    k.sign([tp.label, tr('{0} 篇', tp.n)], { at: [x + w / 2, 1.16, z + 0.2], w: w - 0.06, size: 0.06 });
    k.thing(x, 0, z, w, 1.07, 0.34, { title: tp.label, sub: tr('{0} 篇', tp.n), act: { kind: 'open', building: pl.id } });
  });
  if (!topics.length) k.sign([tr('书架还空着：调研过的论文会按主题上架')], { at: [W / 2, 0.8, D - 3.7], w: 2.4, size: 0.1, wrap: true });
  const dx = W - 1.1, dz = D - 1.4;
  p.block(dx - 0.5, 0, dz - 0.25, 0.9, 0.42, 0.5, 'wood');
  p.block(dx - 0.2, 0.42, dz - 0.1, 0.36, 0.24, 0.03, '#2f2b28');
  k.lamp(new THREE.PlaneGeometry(0.32, 0.2).translate(dx - 0.02, 0.54, dz - 0.068), '#d8ecf0');
  k.thing(dx - 0.5, 0, dz - 0.25, 0.9, 0.7, 0.5, { title: tr('检索台'), sub: tr('{0} 篇馆藏', data.shelf?.total ?? 0), act: { kind: 'open', building: pl.id } });
  return { W, D, H, update: () => {} };
}

// every other building: its model on a turntable, desks for its projects
function plainHall(k: Kit, pl: Placement, data: HallData) {
  const b = BUILDINGS[pl.type], W = 8.0, D = 7.2, H = 2.5;
  k.room(W, D, H, pl);
  const p = k.p;
  const cx = W / 2, cz = D / 2 - 0.4, ks = 0.5 / Math.max(b.w, b.d) * 2.1;
  p.block(cx - 0.85, 0, cz - 0.85, 1.7, 0.3, 1.7, 'base');
  p.block(cx - 0.9, 0.3, cz - 0.9, 1.8, 0.04, 1.8, 'wood');
  const model = new THREE.Group(), mp = new Pen3(ks, -b.w * ks / 2, -b.d * ks / 2);
  b.draw(mp, pl as unknown as Record<string, unknown>);
  for (const o of meshes(mp, k.color, k.mats)) model.add(o);
  model.position.set(cx, 0.34, cz);
  k.scene.add(model);
  k.solid(cx - 0.9, cz - 0.9, 1.8, 1.8, 0.34);
  k.thing(cx - 0.9, 0, cz - 0.9, 1.8, 0.34 + b.h * ks * ZS, 1.8, { title: placementName(pl), sub: b.rep, note: data.sheet?.tech, act: { kind: 'open', building: pl.id } }, false);
  p.block(cx - 1.4, 0, cz - 1.4, 2.8, 0.006, 2.8, k.tint(0.55), false);
  for (const [px, pz] of [[0.45, 0.45], [W - 0.45, 0.45], [0.45, D - 0.55], [W - 0.45, D - 0.55]]) {
    p.block(px - 0.14, 0, pz - 0.14, 0.28, 0.24, 0.28, '#b8683f');
    for (const [dx, dy, dz, s2] of [[0, 0.24, 0, 0.2], [-0.06, 0.38, 0.04, 0.16], [0.05, 0.46, -0.04, 0.13]]) p.block(px + dx - s2 / 2, dy, pz + dz - s2 / 2, s2, s2, s2, 'leaf');
    k.solid(px - 0.14, pz - 0.14, 0.28, 0.28, 0.24);
  }
  for (const lx of [0.05, 1.35]) p.block(W - 0.42, 0, D / 2 + 0.6 + lx * 0.6 - 0.03, 0.3, 0.18, 0.06, 'dark');
  p.block(W - 0.45, 0.18, D / 2 + 0.6, 0.36, 0.04, 0.95, 'wood');
  k.solid(W - 0.45, D / 2 + 0.6, 0.36, 0.95, 0.22);
  p.block(0.04, 0.45, 1.2, 0.04, 1.0, 2.2, 'wood');
  p.block(0.06, 0.5, 1.25, 0.03, 0.9, 2.1, '#d9b98e', false);
  k.sign([b.rep, '', data.sheet?.real ?? ''].filter((s, i) => s || i === 1), { at: [0.1, 0.95, 2.3], w: 2.0, size: 0.075, rot: Math.PI / 2, align: 'left', wrap: true });
  const here = data.lines.filter(l => l.stages.some(s => s.building === pl.type && (s.status === 'run' || s.status === 'wait'))).slice(0, 4);
  here.forEach((ln, i) => {
    const x = W - 1.5, z = 0.9 + i * 0.95, s = ln.stages.find(q => q.building === pl.type)!;
    p.block(x, 0.36, z, 0.9, 0.04, 0.6, 'wood');
    for (const [dx, dz] of [[0.04, 0.04], [0.82, 0.04], [0.04, 0.52], [0.82, 0.52]]) p.block(x + dx, 0, z + dz, 0.04, 0.36, 0.04, 'dark');
    for (let j = 0; j < 4; j++) p.block(x + 0.15 + j * 0.01, 0.4 + j * 0.018, z + 0.15, 0.28, 0.016, 0.34, 'white', false);
    k.beacon(x + 0.8, z + 0.5, 0.5, LAMP[s.status] ?? LAMP.todo);
    k.sign([`#${ln.seq} ${cut(ln.title, 18)}`, `${s.name} · ${statusName(s.status)}`], { at: [x - 0.02, 0.62, z + 0.3], w: 0.6, size: 0.05, rot: -Math.PI / 2 });
    k.thing(x, 0, z, 0.9, 0.5, 0.6, { title: `#${ln.seq} ${cut(ln.title, 30)}`, sub: `${s.name} · ${statusName(s.status)}`, note: s.note ?? undefined, act: { kind: 'open', building: pl.id, line: ln.id } });
  });
  const fx = W - 2.2, fz = D - 1.7;
  p.block(fx, 0, fz, 1.1, 0.4, 0.42, 'acc');
  p.block(fx - 0.03, 0.4, fz - 0.03, 1.16, 0.04, 0.48, 'wood');
  p.block(fx + 0.4, 0.44, fz + 0.1, 0.3, 0.2, 0.03, '#2f2b28');
  k.lamp(new THREE.PlaneGeometry(0.26, 0.16).translate(fx + 0.55, 0.54, fz + 0.132), '#e6f0e8');
  k.thing(fx, 0, fz, 1.1, 0.66, 0.42, { title: tr('服务台'), sub: tr('打开 {0} 的面板', placementName(pl)), act: { kind: 'open', building: pl.id } });
  return { W, D, H, update: (t: number) => { model.rotation.y = t * 0.25; } };
}

export function buildHall(pl: Placement, data: HallData, mats: Materials, font: string, fonts: Promise<unknown>): Hall {
  const accent = pl.accent || BUILDINGS[pl.type].accent;
  const k = new Kit(mats, accent, font, fonts);
  const t = pl.type;
  const r = t === 'mill' ? millHall(k, pl, data) : t === 'press' ? pressHall(k, pl, data) : t === 'farm' ? farmHall(k, pl, data)
    : t === 'power' ? gpuHall(k, pl, data, false) : t === 'power_sim' ? gpuHall(k, pl, data, true) : t === 'depot' ? depotHall(k, pl, data)
      : t === 'library' ? libraryHall(k, pl, data) : plainHall(k, pl, data);
  const d = k.door, out = { title: tr('出口'), sub: tr('回到小镇'), act: { kind: 'exit' as const } };
  const exit = d.side === 'west' ? k.thing(-0.02, 0, d.z - 0.42, 0.12, 1.0, 0.84, out, false) : k.thing(d.x - 0.42, 0, d.z - 0.1, 0.84, 1.0, 0.12, out, false);
  const spawn = d.side === 'west' ? { x: 1.15, y: d.z, heading: 0, pitch: 0.06 } : { x: d.x, y: d.z - 1.15, heading: -Math.PI / 2, pitch: -0.1 };
  return k.finish(r.W, r.D, r.H, pl, spawn, exit, r.update);
}
