// What moves in the town while you walk it: clouds, townsfolk going door to door, a boat, butterflies,
// fireflies and stars. None of it is seen from the air, so the hand-over to the map stays clean.

import * as THREE from 'three';
import { WORKERS } from '@design/sprites.js';
import { N, footprint } from '@design/world.js';
import type { Placement } from '../api';
import { free } from '../components/walk';
import { tr } from '../i18n';
import { Pen3 } from './pen3';
import { disposeGeometry, figure, meshes, type Materials } from './scene';

export interface Walker { key: string; name: string; rep: string; group: THREE.Group; hop(): void }

export interface Life {
  root: THREE.Group;
  pick: THREE.Object3D[]; // userData.walker on each
  update(t: number, dt: number, me: THREE.Vector3, night: number, air: number): void; // me: your feet; air: 0 on the ground … 1 up at the map's view
  dispose(): void;
}

const rnd = (() => { let s = 7; return () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) + 0x6d2b79f5 | 0) >>> 0) / 4294967296; })();

// tiles you can walk, and the way between two of them
function grid(places: Placement[]) {
  const ok = (x: number, y: number) => x > 0 && y > 0 && x < N && y < N && free(places, x + 0.5, y + 0.5);
  return {
    ok,
    path(a: [number, number], b: [number, number]) {
      const key = (x: number, y: number) => x * 64 + y, from = new Map<number, number>([[key(...a), -1]]), q = [a];
      while (q.length) {
        const [x, y] = q.shift()!;
        if (x === b[0] && y === b[1]) break;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (!ok(nx, ny) || from.has(key(nx, ny))) continue;
          from.set(key(nx, ny), key(x, y));
          q.push([nx, ny]);
        }
      }
      if (!from.has(key(...b))) return null;
      const out: [number, number][] = [];
      for (let k = key(...b); k !== -1; k = from.get(k)!) out.unshift([Math.floor(k / 64) + 0.5, (k % 64) + 0.5]);
      return out;
    },
  };
}

export function buildLife(places: Placement[], mats: Materials): Life {
  const root = new THREE.Group(), own: { dispose(): void }[] = [], pick: THREE.Object3D[] = [];
  const g = grid(places);
  const doors = places.map(pl => {
    const f = footprint(pl);
    return [Math.floor(f.x + f.w / 2), Math.floor(f.y + f.d + 0.5)] as [number, number];
  }).filter(([x, y]) => g.ok(x, y));

  const cloudMat = new THREE.MeshLambertMaterial({ color: '#fffdf6', emissive: '#c9c3b6', transparent: true, opacity: 0.88, depthWrite: false });
  own.push(cloudMat);
  const clouds: THREE.Group[] = [];
  for (let i = 0; i < 15; i++) {
    const c = new THREE.Group();
    for (let j = 0; j < 2 + Math.floor(rnd() * 3); j++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(1.2 + rnd() * 2.4, 0.32, 0.9 + rnd() * 1.8), cloudMat);
      m.position.set((rnd() - 0.5) * 2.2, j % 2 ? 0.16 : 0, (rnd() - 0.5) * 1.6);
      c.add(m);
    }
    c.position.set(rnd() * 44 - 12, 5.6 + rnd() * 1.8, rnd() * 36 - 8);
    clouds.push(c);
    root.add(c);
  }

  const keys = Object.keys(WORKERS);
  const walkers: (Walker & { path: [number, number][]; i: number; wait: number; x: number; y: number; face: number; up: number })[] = [];
  for (let n = 0; n < Math.min(7, doors.length); n++) {
    const key = keys[n % keys.length], w = WORKERS[key];
    const group = figure(mats, w.accent, '#f3ead6');
    group.scale.setScalar(0.92);
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.7, 8).translate(0, 0.35, 0), new THREE.MeshBasicMaterial());
    own.push(hit.material as THREE.Material);
    hit.visible = false;
    group.add(hit);
    const [x, y] = doors[(n * 3) % doors.length];
    const walker = {
      key, name: tr(w.name), rep: tr(w.rep), group, path: [] as [number, number][], i: 0, wait: rnd() * 3, x: x + 0.5, y: y + 0.5, face: 0, up: 0,
      hop() { if (walker.up <= 0) walker.up = 1; },
    };
    hit.userData.walker = walker;
    pick.push(hit);
    walkers.push(walker);
    root.add(group);
  }

  const boat = new THREE.Group();
  {
    const p = new Pen3();
    const hull = new THREE.CylinderGeometry(0.2, 0.12, 0.9, 4, 1);
    hull.rotateZ(Math.PI / 2);
    hull.rotateX(Math.PI / 4);
    hull.scale(1, 0.55, 1);
    p.geom(hull, 'wood');
    p.block(-0.32, 0.1, -0.11, 0.64, 0.02, 0.22, 'dark');
    p.tube([0, 0.1, 0], [0, 1.0, 0], 0.012, 'dark');
    p.face([[0.02, 0.2, 0], [0.02, 0.95, 0], [0.42, 0.22, 0]], 'white');
    p.face([[-0.02, 0.24, 0], [-0.02, 0.8, 0], [-0.32, 0.26, 0]], '#c9644c');
    for (const o of meshes(p, m => (m.startsWith('#') ? m : mats.color(m)), mats)) boat.add(o);
  }
  root.add(boat);

  const wing = new THREE.PlaneGeometry(0.05, 0.035).translate(0.025, 0, 0);
  const flies = Array.from({ length: 9 }, (_, i) => {
    const mat = new THREE.MeshBasicMaterial({ color: ['#f2c84b', '#f6f1e4', '#e0705c', '#9fc0e8'][i % 4], side: THREE.DoubleSide });
    own.push(mat);
    const b = new THREE.Group(), l = new THREE.Mesh(wing, mat), r = new THREE.Mesh(wing, mat);
    r.rotation.y = Math.PI;
    b.add(l, r);
    const [x, y] = doors[(i * 5 + 2) % doors.length] ?? [12, 12];
    root.add(b);
    return { b, l, r, x: x + 0.5 + (rnd() - 0.5) * 3, y: y + 0.5 + (rnd() - 0.5) * 3, ph: rnd() * 10 };
  });
  const bugs = new THREE.BufferGeometry(), bugAt: number[] = [];
  for (let i = 0; i < 70; i++) bugAt.push(1 + rnd() * (N - 2), 0.15 + rnd() * 0.5, 1 + rnd() * (N - 2));
  bugs.setAttribute('position', new THREE.Float32BufferAttribute(bugAt, 3));
  const bugMat = new THREE.PointsMaterial({ color: '#ffe680', size: 0.05, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  const fireflies = new THREE.Points(bugs, bugMat);
  own.push(bugMat);
  root.add(fireflies);
  const sky = new THREE.BufferGeometry(), starAt: number[] = [];
  for (let i = 0; i < 260; i++) {
    const a = rnd() * Math.PI * 2, e = 0.12 + rnd() * 1.3, d = 120;
    starAt.push(12 + Math.cos(a) * Math.cos(e) * d, Math.sin(e) * d, 12 + Math.sin(a) * Math.cos(e) * d);
  }
  sky.setAttribute('position', new THREE.Float32BufferAttribute(starAt, 3));
  const starMat = new THREE.PointsMaterial({ color: '#fff6dc', size: 1.1, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false });
  const stars = new THREE.Points(sky, starMat);
  own.push(starMat);
  root.add(stars);

  return {
    root, pick,
    update(t, dt, me, night, air) {
      root.visible = air < 0.95;
      const near = 1 - air;
      cloudMat.opacity = 0.88 * near * (1 - night * 0.5);
      cloudMat.color.setStyle(night > 0.5 ? '#9aa3c0' : '#fffdf6');
      cloudMat.emissive.setStyle(night > 0.5 ? '#262b3d' : '#c9c3b6');
      for (const c of clouds) {
        c.position.x += dt * 0.22;
        if (c.position.x - me.x > 26) c.position.x -= 52; else if (c.position.x - me.x < -26) c.position.x += 52;
        if (c.position.z - me.z > 22) c.position.z -= 44; else if (c.position.z - me.z < -22) c.position.z += 44;
      }
      for (const w of walkers) {
        const dx = me.x - w.x, dy = me.z - w.y, close = dx * dx + dy * dy < 1.4 && me.y < 0.8;
        let moving = false;
        if (close) {
          w.face = Math.atan2(dy, dx);
        } else if (w.wait > 0) {
          w.wait -= dt;
        } else if (w.i >= w.path.length) {
          const to = doors[Math.floor(rnd() * doors.length)];
          w.path = g.path([Math.floor(w.x), Math.floor(w.y)], to) ?? [];
          w.i = 0;
          if (!w.path.length) w.wait = 2;
        } else {
          const [tx, ty] = w.path[w.i], ex = tx - w.x, ey = ty - w.y, d = Math.hypot(ex, ey), s = dt * 0.75;
          if (d < s) { w.x = tx; w.y = ty; w.i++; if (w.i >= w.path.length) w.wait = 2 + rnd() * 5; }
          else { w.x += ex / d * s; w.y += ey / d * s; moving = true; w.face = Math.atan2(ey, ex); }
        }
        const cur = -w.group.rotation.y, turn = Math.atan2(Math.sin(w.face - cur), Math.cos(w.face - cur));
        w.group.rotation.y = -(cur + turn * (1 - Math.exp(-dt * 8)));
        w.up = Math.max(0, w.up - dt * 2.2);
        w.group.position.set(w.x, (moving ? Math.abs(Math.sin(t * 9 + w.x)) * 0.025 : 0) + Math.sin(w.up * Math.PI) * 0.22, w.y);
      }
      const bx = -2.6 + Math.sin(t * 0.05) * 1.2, by = 4 + (Math.sin(t * 0.03) + 1) * 7;
      boat.position.set(bx, -0.12 + Math.sin(t * 1.3) * 0.015, by);
      boat.rotation.set(Math.sin(t * 1.1) * 0.05, Math.cos(t * 0.03) > 0 ? -Math.PI / 2 : Math.PI / 2, Math.sin(t * 0.9) * 0.04);
      for (const f of flies) {
        f.b.visible = night < 0.4;
        const u = t * 0.4 + f.ph;
        f.b.position.set(f.x + Math.sin(u) * 0.8, 0.25 + Math.sin(u * 2.3) * 0.1, f.y + Math.cos(u * 0.7) * 0.8);
        f.b.rotation.y = -u;
        const flap = Math.sin(t * 22 + f.ph) * 0.9;
        f.l.rotation.z = flap; f.r.rotation.z = -flap;
      }
      bugMat.opacity = night * near * (0.6 + 0.4 * Math.sin(t * 3));
      fireflies.position.y = Math.sin(t * 0.7) * 0.04;
      starMat.opacity = night * near;
      stars.position.set(me.x - 12, 0, me.z - 12);
    },
    dispose() {
      disposeGeometry(root);
      for (const x of own) x.dispose();
    },
  };
}
