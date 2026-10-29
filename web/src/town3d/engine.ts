// The 3D town's engine: renderer, camera, walking, picking, the name tags and the
// minimap marker. It has two ways of looking: from the air, at exactly the map's angle
// (30° down, from the +x +y corner, with a near-orthographic lens), and through your
// own eyes. Going in and out of 3D is a camera flight between the two, so the map and
// the 3D town hand over to each other without a cut.

import * as THREE from 'three';
import { BUILDINGS } from '@design/sprites.js';
import { KEY_LABELS, placementName } from '@design/world.js';
import type { Placement } from '../api';
import type { MapView } from '../components/WorldMap';
import { doorOf, free, loadPos, nearest, savePos, slide, START, type Pos } from '../components/walk';
import { buildTown, Materials, PAPER, type Town } from './scene';

// the palette is given in display colours and the lights are tuned for them: no linear workflow
THREE.ColorManagement.enabled = false;

export const EYE = 0.55; // eye height in tiles
const WALK = 1.8, RUN = 3.6, TURN = 2.2; // tiles / s, rad / s
const LOOK = 0.0024, DRAG = 0.0045; // rad per pixel, pointer locked / dragging
const AIM = 4.5; // how far a look at a building reaches its door
const FOV_AIR = 2, FOV_EYE = 68;
const MAP_PX = 32 * Math.SQRT2; // map pixels per tile, across the screen
const HEADING = -0.75 * Math.PI; // looking the way the map does, towards -x -y
const AIR_EL = Math.PI / 6, AIR_AZ = Math.PI / 4; // the map's camera, as seen from its target

interface Orbit { t: THREE.Vector3; d: number; az: number; el: number; fov: number }

export interface Target { pl: Placement; how: 'door' | 'look' | 'hover' }

export interface EngineEvents {
  target(t: Target | null): void;
  lock(on: boolean): void;
  open(id: string, at: { x: number; y: number }): void;
  moved(): void;
}

const ease = (s: number) => s < 0.5 ? 4 * s * s * s : 1 - Math.pow(-2 * s + 2, 3) / 2;
const lerp = (a: number, b: number, s: number) => a + (b - a) * s;
const sig = (ps: Placement[]) => ps.map(p => [p.id, p.type, p.x, p.y, p.accent, p.label, p.name].join(':')).join('|');

function typing(e: Event) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
}

export class Engine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV_EYE, 1, 0.05, 300);
  private mats = new Materials();
  private town: Town | null = null;
  private sig = '';
  private places: Placement[] = [];
  private font: string;
  private fonts: Promise<unknown>;
  private sizer = new ResizeObserver(() => this.resize());
  private ray = new THREE.Raycaster();
  private tags = new Map<string, HTMLElement>();

  pos: Pos = loadPos();
  heading = HEADING;
  pitch = -0.05;
  private vel = new THREE.Vector2();
  private bob = 0;
  private keys = new Set<string>();
  private orbit: Orbit;
  private eyes = false; // through your own eyes (vs from the air)
  private flight: { from: Orbit; to: () => Orbit; t0: number; dur: number; done: () => void } | null = null;
  private width = 1200; // the map's view width, to come back to

  private active = false;
  private shown = false;
  private raf = 0;
  private last = 0;
  private clock = 0;
  private saved = 0;
  private shadowed = 0;
  private hidden = new Set<string>(); // tags behind a building
  private probe = 0; // which tags to test for that next
  private mouse: { x: number; y: number } | null = null;
  private drag: { x: number; y: number; moved: boolean } | null = null;
  private target: Target | null = null;
  private reach: Placement | null = null;
  private locked = false;

  constructor(private host: HTMLElement, private tagHost: HTMLElement, private marker: SVGGElement | null, private ev: EngineEvents) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false; // the town stands still: shadows are redrawn only when it moves
    this.renderer.domElement.className = 't3-canvas';
    host.prepend(this.renderer.domElement);

    this.scene.background = new THREE.Color(PAPER);
    this.scene.fog = new THREE.Fog(PAPER, 8, 46);
    // lit so that tops come out a little lighter than the map's fill, +y faces as the fill
    // and +x faces a little darker, as the sprites shade them; a soft fill from the other
    // corner keeps the sides the map never shows from going muddy
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.5 * Math.PI));
    const fill = new THREE.DirectionalLight(0xffffff, 0.44 * Math.PI);
    fill.position.set(-0.64, 0.34, -0.69);
    this.scene.add(fill);
    const sun = new THREE.DirectionalLight(0xffffff, 0.79 * Math.PI);
    sun.position.set(12 + 0.443 * 40, 0.633 * 40, 12 + 0.633 * 40);
    sun.target.position.set(12, 0, 12);
    sun.castShadow = true;
    sun.shadow.intensity = 0.42;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 120 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun, sun.target);

    // the signs are lettered in the page's heading font (set on the themed root, not on <html>)
    this.font = getComputedStyle(host).getPropertyValue('--head').trim() || '"LXGW WenKai Screen", serif';
    this.fonts = document.fonts?.load?.(`40px ${this.font}`, 'PAPER MILL 人才市场 HIRING 日报 DAILY GPU TeX SIM DATA DDL arXiv GitHub') ?? Promise.resolve();
    this.orbit = this.air({ cx: 0, cy: 380, w: 1600 });

    this.sizer.observe(host);
    this.resize();
    const c = this.renderer.domElement;
    c.addEventListener('pointerdown', this.onDown);
    c.addEventListener('pointerleave', () => { this.mouse = null; });
    addEventListener('pointermove', this.onMove);
    addEventListener('pointerup', this.onUp);
    addEventListener('keydown', this.onKey);
    addEventListener('keyup', this.onKeyUp);
    addEventListener('blur', this.onBlur);
    document.addEventListener('pointerlockchange', this.onLock);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.sizer.disconnect();
    removeEventListener('pointermove', this.onMove);
    removeEventListener('pointerup', this.onUp);
    removeEventListener('keydown', this.onKey);
    removeEventListener('keyup', this.onKeyUp);
    removeEventListener('blur', this.onBlur);
    document.removeEventListener('pointerlockchange', this.onLock);
    this.town?.dispose();
    this.mats.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ---------- the town ----------

  setPlaces(places: Placement[], notes: Record<string, string>) {
    this.places = places;
    const s = sig(places);
    if (s !== this.sig) {
      this.sig = s;
      if (this.town) { this.scene.remove(this.town.root); this.town.dispose(); }
      this.town = buildTown(places, this.mats, this.font, this.fonts);
      this.scene.add(this.town.root);
      this.makeTags();
      this.renderer.shadowMap.needsUpdate = true;
    } else {
      this.town?.setBusy(new Set(places.filter(p => p.status === 'busy').map(p => p.id)));
    }
    for (const p of places) {
      const el = this.tags.get(p.id);
      if (el) el.textContent = notes[p.id] ? `${placementName(p)} · ${notes[p.id]}` : placementName(p);
    }
    if (!free(this.places, this.pos.x, this.pos.y)) this.pos = { ...START };
    this.wake();
  }

  private makeTags() {
    this.tagHost.textContent = '';
    this.tags.clear();
    for (const b of this.town!.buildings.values()) {
      const el = document.createElement('div');
      el.className = `t3-tag${b.pl.core ? ' core' : ''}`;
      el.style.setProperty('--accent', b.pl.accent || BUILDINGS[b.pl.type].accent);
      el.dataset.id = b.pl.id;
      this.tagHost.appendChild(el);
      this.tags.set(b.pl.id, el);
    }
  }

  // ---------- the camera ----------

  // the map's own view, from the air: same centre, same width on screen
  private air(v: MapView): Orbit {
    const gx = (v.cx / 32 + v.cy / 16) / 2, gy = (v.cy / 16 - v.cx / 32) / 2;
    const d = v.w / MAP_PX / (2 * Math.tan(FOV_AIR / 2 * Math.PI / 180) * this.camera.aspect);
    return { t: new THREE.Vector3(gx, 0, gy), d, az: AIR_AZ, el: AIR_EL, fov: FOV_AIR };
  }

  // through your eyes: an orbit of a point a few tiles ahead, from right behind it
  private eye(): Orbit {
    const cp = Math.cos(this.pitch), d = 3;
    const f = new THREE.Vector3(Math.cos(this.heading) * cp, Math.sin(this.pitch), Math.sin(this.heading) * cp);
    const e = new THREE.Vector3(this.pos.x, EYE + Math.sin(this.bob) * 0.012, this.pos.y);
    return { t: e.addScaledVector(f, d), d, az: Math.atan2(-f.z, -f.x), el: Math.asin(-f.y), fov: FOV_EYE };
  }

  private place(o: Orbit) {
    const c = this.camera, ce = Math.cos(o.el);
    c.position.set(o.t.x + Math.cos(o.az) * ce * o.d, o.t.y + Math.sin(o.el) * o.d, o.t.z + Math.sin(o.az) * ce * o.d);
    c.fov = o.fov;
    c.near = Math.max(0.04, o.d - 70);
    c.far = o.d + 160;
    c.updateProjectionMatrix();
    c.lookAt(o.t);
    const fog = this.scene.fog as THREE.Fog;
    fog.near = o.d + 6;
    fog.far = o.d + 44;
  }

  private mix(a: Orbit, b: Orbit, s: number): Orbit {
    let daz = b.az - a.az;
    daz = Math.atan2(Math.sin(daz), Math.cos(daz)); // the short way round
    const ta = Math.tan(a.fov / 2 * Math.PI / 180), tb = Math.tan(b.fov / 2 * Math.PI / 180);
    return {
      t: a.t.clone().lerp(b.t, s),
      d: Math.exp(lerp(Math.log(a.d), Math.log(b.d), s)),
      az: a.az + daz * s,
      el: lerp(a.el, b.el, s),
      fov: Math.atan(Math.exp(lerp(Math.log(ta), Math.log(tb), s))) * 2 * 180 / Math.PI,
    };
  }

  private fly(to: () => Orbit, dur: number) {
    return new Promise<void>(done => {
      this.flight = { from: { ...this.orbit, t: this.orbit.t.clone() }, to, t0: performance.now(), dur, done };
      this.wake();
    });
  }

  // show the town from where the map was looking, ready to fly down
  enter(from: MapView) {
    this.width = from.w;
    this.pos = loadPos();
    if (!free(this.places, this.pos.x, this.pos.y)) this.pos = { ...START };
    this.heading = HEADING;
    this.pitch = -0.05;
    this.eyes = false;
    this.flight = null;
    this.orbit = this.air(from);
    this.shown = true;
    cancelAnimationFrame(this.raf);
    this.frame(performance.now());
  }

  // the way with the most room to walk, leaning towards the way the map looks
  private openHeading() {
    let best = HEADING, score = -Infinity;
    for (let i = 0; i < 24; i++) {
      const h = HEADING + (i / 24) * Math.PI * 2;
      let d = 0;
      while (d < 10 && free(this.places, this.pos.x + Math.cos(h) * (d + 0.25), this.pos.y + Math.sin(h) * (d + 0.25))) d += 0.25;
      const sc = d - 2.5 * (1 - Math.cos(h - HEADING));
      if (sc > score) { score = sc; best = h; }
    }
    return best;
  }

  async down() {
    this.heading = this.openHeading(); // the flight turns you there on the way down
    await this.fly(() => this.eye(), 2100);
    this.eyes = true;
    this.ev.moved();
  }

  // back up to the map's angle, over where you stand; the map takes over from there
  async up(): Promise<MapView> {
    document.exitPointerLock?.();
    this.keys.clear();
    savePos(this.pos);
    this.eyes = false;
    const v = { cx: (this.pos.x - this.pos.y) * 32, cy: (this.pos.x + this.pos.y) * 16, w: this.width };
    await this.fly(() => this.air(v), 1500);
    return v;
  }

  setShown(on: boolean) { this.shown = on; this.wake(); }

  setActive(on: boolean) {
    this.active = on;
    if (!on) {
      this.keys.clear();
      if (this.locked) document.exitPointerLock?.();
      this.setTarget(null);
      this.reach = null;
    }
    this.wake();
  }

  private resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.wake();
  }

  // ---------- the loop ----------

  private wake() {
    if (!this.raf && this.shown) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    const dt = Math.min(0.1, this.last ? (now - this.last) / 1000 : 0);
    this.last = now;
    this.clock += dt;
    if (this.flight) {
      const f = this.flight, s = Math.min(1, (now - f.t0) / f.dur);
      this.orbit = this.mix(f.from, f.to(), ease(s));
      if (s >= 1) { this.flight = null; f.done(); }
    } else if (this.eyes) {
      if (this.active) this.walk(dt);
      this.orbit = this.eye();
    }
    this.place(this.orbit);
    if (this.eyes && this.active && !this.flight) this.aim();
    const town = this.town;
    if (town) {
      // a building rising or settling moves its shadow; a few times a second is enough
      if (town.update(this.clock, dt, this.target?.pl.id ?? null) && now - this.shadowed > 120) {
        this.shadowed = now;
        this.renderer.shadowMap.needsUpdate = true;
      }
      // you are only seen from outside your own eyes
      town.me.position.set(this.pos.x, 0, this.pos.y);
      town.me.visible = !this.eyes && this.camera.position.distanceTo(new THREE.Vector3(this.pos.x, EYE, this.pos.y)) > 1.5;
      town.me.rotation.y = -this.heading;
    }
    this.renderer.render(this.scene, this.camera);
    this.drawTags();
    this.drawMarker();
    if (this.shown && (this.active || this.flight)) this.raf = requestAnimationFrame(this.frame);
    else this.last = 0;
  };

  private walk(dt: number) {
    const k = this.keys, has = (...c: string[]) => c.some(x => k.has(x));
    if (has('ArrowLeft')) this.heading -= TURN * dt;
    if (has('ArrowRight')) this.heading += TURN * dt;
    const fwd = (has('KeyW', 'ArrowUp') ? 1 : 0) - (has('KeyS', 'ArrowDown') ? 1 : 0);
    const side = (has('KeyD') ? 1 : 0) - (has('KeyA') ? 1 : 0);
    const speed = has('ShiftLeft', 'ShiftRight') ? RUN : WALK;
    const ch = Math.cos(this.heading), sh = Math.sin(this.heading);
    let wx = ch * fwd - sh * side, wy = sh * fwd + ch * side;
    const l = Math.hypot(wx, wy);
    if (l) { wx = wx / l * speed; wy = wy / l * speed; }
    // ease into and out of a walk
    const a = 1 - Math.exp(-dt * 11);
    this.vel.x += (wx - this.vel.x) * a;
    this.vel.y += (wy - this.vel.y) * a;
    const v = Math.hypot(this.vel.x, this.vel.y);
    if (v < 0.01) {
      if (v) { this.vel.set(0, 0); savePos(this.pos); } // came to a stop
      return;
    }
    const before = this.pos;
    this.pos = slide(this.places, this.pos, this.pos.x + this.vel.x * dt, this.pos.y + this.vel.y * dt);
    if (this.pos === before) this.vel.set(0, 0); // walked into a wall
    this.bob += v * dt * 6.5;
    const now = performance.now();
    if (now - this.saved > 600) { this.saved = now; savePos(this.pos); }
    this.ev.moved();
  }

  // ---------- what you are looking at ----------

  private hit(ndcX: number, ndcY: number, far = Infinity): string | null {
    if (!this.town) return null;
    this.ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    this.ray.far = far;
    const h = this.ray.intersectObjects(this.town.pick, false)[0];
    return (h?.object.userData.id as string) ?? null;
  }

  private ndc(x: number, y: number) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return [((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1] as const;
  }

  // what E would walk into (the building you look at up close, or the door you stand at),
  // and what the card shows (that, unless the mouse is over another building)
  private aim() {
    const byId = (id: string | null) => (id && this.places.find(p => p.id === id)) || null;
    const look = byId(this.hit(0, 0, AIM)), door = look ? null : nearest(this.places, this.pos.x, this.pos.y);
    this.reach = look ?? door;
    const hov = !this.locked && this.mouse && !this.drag?.moved ? byId(this.hit(...this.ndc(this.mouse.x, this.mouse.y))) : null;
    const t: Target | null = hov && hov.id !== this.reach?.id ? { pl: hov, how: 'hover' }
      : look ? { pl: look, how: 'look' } : door ? { pl: door, how: 'door' } : null;
    this.renderer.domElement.style.cursor = hov ? 'pointer' : this.locked ? 'none' : 'grab';
    this.setTarget(t);
  }

  private setTarget(t: Target | null) {
    if (t?.pl.id === this.target?.pl.id && t?.how === this.target?.how) return;
    this.target = t;
    this.ev.target(t);
  }

  // where a building's door is on screen, for the room to open from
  private screenOf(id: string) {
    const b = this.town?.buildings.get(id), r = this.renderer.domElement.getBoundingClientRect();
    if (!b) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    const p = b.mid.clone().project(this.camera);
    return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height };
  }

  // go in: step to its door first, as on the map, so you come out there
  go(id: string) {
    const pl = this.places.find(p => p.id === id);
    if (!pl) return;
    const at = this.screenOf(id);
    if (nearest(this.places, this.pos.x, this.pos.y)?.id !== id) {
      const d = doorOf(this.places, pl);
      if (d) this.pos = d;
    }
    savePos(this.pos);
    this.keys.clear();
    if (this.locked) document.exitPointerLock?.();
    this.ev.open(id, at);
  }

  // stand at a building's door without going in (a click on it in the minimap)
  toDoor(id: string) {
    // a step further off than on the map, so the front is in view, still within reach of the door
    const pl = this.places.find(p => p.id === id), d = pl && (doorOf(this.places, pl, 1.0) ?? doorOf(this.places, pl));
    if (!d) return;
    this.pos = d;
    this.vel.set(0, 0);
    // face the building, looking up a little at it
    const f = this.town?.buildings.get(id)?.mid;
    if (f) this.heading = Math.atan2(f.z - d.y, f.x - d.x);
    this.pitch = 0.12;
    savePos(this.pos);
    this.ev.moved();
    this.wake();
  }

  // jump to a spot (a click on the minimap)
  teleport(x: number, y: number) {
    if (!free(this.places, x, y)) return false;
    this.pos = { x, y };
    savePos(this.pos);
    this.ev.moved();
    this.wake();
    return true;
  }

  // ---------- tags and the minimap marker ----------

  private drawTags() {
    if (!this.town) return;
    const r = this.renderer.domElement.getBoundingClientRect(), cam = this.camera;
    const high = Math.min(1, Math.max(0, (cam.position.y - 2) / 6)); // up in the air the map's labels show
    const v = new THREE.Vector3();
    // on the ground, a tag behind a building is hidden like the building; a few are tested each frame
    const all = [...this.town.buildings.values()];
    if (high > 0.5) this.hidden.clear();
    else for (let i = 0; i < 5 && all.length; i++) {
      const b = all[this.probe++ % all.length];
      v.copy(b.top);
      v.y += b.lift;
      const dir = v.clone().sub(cam.position), dist = dir.length();
      this.ray.set(cam.position, dir.normalize());
      this.ray.far = dist - 0.2;
      const h = this.ray.intersectObjects(this.town.pick, false)[0];
      if (h && h.object.userData.id !== b.pl.id) this.hidden.add(b.pl.id); else this.hidden.delete(b.pl.id);
    }
    for (const [id, b] of this.town.buildings) {
      const el = this.tags.get(id);
      if (!el) continue;
      v.copy(b.top);
      v.y += b.lift;
      const dist = v.distanceTo(cam.position);
      v.project(cam);
      const key = b.pl.key ?? KEY_LABELS.has(id);
      const op = Math.max(high * (key ? 1 : 0), (1 - high) * Math.min(1, Math.max(0, (19 - dist) / 6)) * (this.hidden.has(id) ? 0 : 1));
      if (v.z > 1 || op < 0.02) { el.style.opacity = '0'; continue; }
      el.style.opacity = op.toFixed(2);
      el.style.transform = `translate(${((v.x + 1) / 2 * r.width).toFixed(1)}px, ${((1 - v.y) / 2 * r.height).toFixed(1)}px) translate(-50%, -100%)`;
      el.classList.toggle('on', this.target?.pl.id === id);
    }
  }

  private drawMarker() {
    const m = this.marker;
    if (!m) return;
    const { x, y } = this.pos, c = Math.cos(this.heading), s = Math.sin(this.heading);
    const deg = Math.atan2((c + s) * 16, (c - s) * 32) * 180 / Math.PI; // the heading as drawn on the map
    m.setAttribute('transform', `translate(${((x - y) * 32).toFixed(1)},${((x + y) * 16).toFixed(1)}) rotate(${deg.toFixed(1)})`);
  }

  // ---------- input ----------

  private onKey = (e: KeyboardEvent) => {
    if (!this.active || !this.eyes || typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (['KeyE', 'Enter', 'Space'].includes(e.code)) {
      e.preventDefault();
      if (!e.repeat && this.reach) this.go(this.reach.id);
      return;
    }
    if (/^(Key[WASD]|Arrow(Up|Down|Left|Right)|Shift(Left|Right))$/.test(e.code)) {
      e.preventDefault();
      this.keys.add(e.code);
      this.wake();
    }
  };

  private onKeyUp = (e: KeyboardEvent) => { this.keys.delete(e.code); };
  private onBlur = () => { this.keys.clear(); };

  private onDown = (e: PointerEvent) => {
    if (e.button !== 0 || !this.active || !this.eyes) return;
    this.drag = { x: e.clientX, y: e.clientY, moved: false };
  };

  private onMove = (e: PointerEvent) => {
    if (!this.active || !this.eyes) return;
    if (this.locked) {
      this.heading += e.movementX * LOOK;
      this.pitch = Math.max(-1.2, Math.min(1.2, this.pitch - e.movementY * LOOK));
      return;
    }
    const inside = e.target === this.renderer.domElement;
    this.mouse = inside ? { x: e.clientX, y: e.clientY } : null;
    const d = this.drag;
    if (d) {
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      d.moved = true;
      // drag the view, like turning a photo sphere
      this.heading -= dx * DRAG;
      this.pitch = Math.max(-1.2, Math.min(1.2, this.pitch + dy * DRAG));
      d.x = e.clientX;
      d.y = e.clientY;
      this.renderer.domElement.style.cursor = 'grabbing';
    }
  };

  private onUp = (e: PointerEvent) => {
    const d = this.drag;
    this.drag = null;
    if (!d || d.moved || !this.active || !this.eyes) return;
    // a click: on a building goes in, elsewhere takes the mouse for looking round
    const id = this.locked ? this.hit(0, 0, AIM) : this.hit(...this.ndc(e.clientX, e.clientY));
    if (id) this.go(id);
    else if (!this.locked) (this.renderer.domElement.requestPointerLock?.() as Promise<void> | undefined)?.catch?.(() => {});
  };

  private onLock = () => {
    this.locked = document.pointerLockElement === this.renderer.domElement;
    this.ev.lock(this.locked);
    this.wake();
  };
}
