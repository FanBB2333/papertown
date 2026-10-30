// The 3D town's engine: renderer, camera, your body, picking, the halls inside the
// buildings, the name tags and the minimap marker. It has two ways of looking: from the
// air, at exactly the map's angle (30° down, from the +x +y corner, with a near-orthographic
// lens), and through your own eyes (or from just behind you). Going in and out of 3D is a
// camera flight between the two, so the map and the 3D town hand over to each other
// without a cut. Through your eyes the mouse works as in a first-person game: it is locked
// to the middle of the screen and moving it turns your head. You walk, run, jump, crouch
// and fly (body.ts); F or a click goes into the building, machine or person you aim at.

import * as THREE from 'three';
import { BUILDINGS } from '@design/sprites.js';
import { KEY_LABELS, N, footprint, placementName } from '@design/world.js';
import type { Placement } from '../api';
import type { MapView } from '../components/WorldMap';
import { enterFull } from '../fullscreen';
import { doorOf, free, gap, loadPos, REACH, savePos, START, type Pos } from '../components/walk';
import { Body, WALK, type Input, type World } from './body';
import { Hand } from './hand';
import { buildHall, type Hall, type HallData, type Thing } from './halls';
import { buildLand, worldOf, type Land } from './land';
import { buildLife, type Life, type Walker } from './life';
import { BRAND, buildTown, figure, Materials, PAPER, type Town } from './scene';

// the palette is given in display colours and the lights are tuned for them: no linear workflow
THREE.ColorManagement.enabled = false;

const TURN = 2.2; // rad / s
const LOOK = 0.0022; // rad per pixel of mouse movement
const AIM = 4.5; // how far a look at a building reaches its door
const FOV_AIR = 2;
const MAP_PX = 32 * Math.SQRT2; // map pixels per tile, across the screen
const HEADING = -0.75 * Math.PI; // looking the way the map does, towards -x -y
const AIR_EL = Math.PI / 6, AIR_AZ = Math.PI / 4; // the map's camera, as seen from its target
const TAP = 300; // ms between the two taps of a double-tapped space
const BEHIND = 2.3; // the camera's distance behind you, seen from outside
const NIGHT = new THREE.Color('#29304a'), MOON = new THREE.Color('#9fb0ff'), WHITE = new THREE.Color('#ffffff');
const REACH_LAND = { low: 36, mid: 52, high: 68 }; // how far out the land is built, on the ground

interface Orbit { t: THREE.Vector3; d: number; az: number; el: number; fov: number }

export type Target =
  | { kind: 'building'; pl: Placement; how: 'door' | 'look' } // in the town: a building you aim at or stand at the door of
  | { kind: 'thing'; thing: Thing } // in a hall: a machine, or the way out
  | { kind: 'walker'; walker: Walker }; // one of the townsfolk

// how you are moving and seeing, for the chips on screen
export interface Mode { fly: boolean; low: boolean; third: boolean; night: boolean }

// what you can set for the walk (the settings sheet)
export interface EngineOptions {
  sensitivity: number; // times LOOK
  invertY: boolean;
  fov: number; // through your eyes, degrees
  hand: boolean; // your hand and pencil in view
  bob: boolean; // the view and the hand sway with your steps
  quality: 'low' | 'mid' | 'high'; // resolution and shadows
  calm: boolean; // shorter flights in and out
  fullscreen: boolean; // taking the mouse back also goes full screen again
}
const OPTIONS: EngineOptions = { sensitivity: 1, invertY: false, fov: 68, hand: true, bob: true, quality: 'high', calm: false, fullscreen: true };
const SHADOW = { low: 0, mid: 1024, high: 2048 };

export interface EngineEvents {
  target(t: Target | null): void;
  lock(on: boolean): void;
  eyes(on: boolean): void; // landed in your own eyes / took off again
  open(id: string, at: { x: number; y: number }, line?: string | null): void; // a building's room, for a project if given
  hall(pl: Placement): Promise<HallData>; // what a building's hall is built from
  inside(pl: Placement | null): void; // went into a building's hall / came back out
  veil(text: string | null): void; // cover the view while the scene changes (a building's name, or '' for none)
  mode(m: Mode): void;
  moved(): void;
  leave(): void; // asked to go back to the map (M)
}

const ease = (s: number) => s < 0.5 ? 4 * s * s * s : 1 - Math.pow(-2 * s + 2, 3) / 2;
const lerp = (a: number, b: number, s: number) => a + (b - a) * s;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const sig = (ps: Placement[]) => ps.map(p => [p.id, p.type, p.x, p.y, p.accent, p.label, p.name].join(':')).join('|');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function typing(e: Event) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
}

export class Engine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(OPTIONS.fov, 1, 0.05, 300);
  private sun: THREE.DirectionalLight;
  private fill: THREE.DirectionalLight;
  private ambient: THREE.AmbientLight;
  private opt = { ...OPTIONS };
  private mats = new Materials();
  private hand = new Hand();
  private town: Town | null = null;
  private life: Life | null = null;
  private hall: Hall | null = null;
  private land: Land;
  private outdoors: World = worldOf(null); // the town and the land round it
  private hallSig = '';
  private outside: Pos | null = null; // where you come out of the hall
  private entering = false;
  private me: THREE.Group; // you, seen from the air or from behind
  private sig = '';
  private places: Placement[] = [];
  private font: string;
  private fonts: Promise<unknown>;
  private sizer = new ResizeObserver(() => this.resize());
  private ray = new THREE.Raycaster();
  private tags = new Map<string, HTMLElement>();

  private body = new Body();
  heading = HEADING;
  pitch = -0.05;
  private bob = 0;
  private keys = new Set<string>();
  private tapped = 0; // when space was last pressed, for a double tap
  private third = false; // seen from just behind you
  private night = 0;
  private nightTo = 0;
  private modeSig = '';
  private orbit: Orbit;
  private eyes = false; // through your own eyes (vs from the air)
  private flight: { from: Orbit; to: () => Orbit; t0: number; dur: number; done: () => void } | null = null;
  private width = 1200; // the map's view width, to come back to

  private active = false;
  private shown = false;
  private gone = false;
  private raf = 0;
  private last = 0;
  private clock = 0;
  private saved = 0;
  private polled = 0;
  private shadowed = 0;
  private hidden = new Set<string>(); // tags behind a building
  private probe = 0; // which tags to test for that next
  private target: Target | null = null;
  private locked = !!document.pointerLockElement; // the app may have locked it on the way in
  private started = false; // options applied once

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
    this.ambient = new THREE.AmbientLight(0xffffff, 0.5 * Math.PI);
    this.scene.add(this.ambient);
    const fill = this.fill = new THREE.DirectionalLight(0xffffff, 0.44 * Math.PI);
    fill.position.set(-0.64, 0.34, -0.69);
    this.scene.add(fill);
    const sun = this.sun = new THREE.DirectionalLight(0xffffff, 0.79 * Math.PI);
    sun.position.set(12 + 0.443 * 40, 0.633 * 40, 12 + 0.633 * 40);
    sun.target.position.set(12, 0, 12);
    sun.castShadow = true;
    sun.shadow.intensity = 0.42;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 120 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun, sun.target);
    this.land = buildLand(this.mats);
    this.scene.add(this.land.root);
    this.me = figure(this.mats, BRAND);
    this.me.traverse(o => { o.castShadow = false; });
    this.scene.add(this.me);

    // the signs are lettered in the page's heading font (set on the themed root, not on <html>)
    this.font = getComputedStyle(host).getPropertyValue('--head').trim() || '"LXGW WenKai Screen", serif';
    this.fonts = document.fonts?.load?.(`40px ${this.font}`, 'PAPER MILL 人才市场 HIRING 日报 DAILY GPU TeX SIM DATA DDL arXiv GitHub') ?? Promise.resolve();
    this.orbit = this.air({ cx: 0, cy: 380, w: 1600 });
    const p = loadPos();
    this.body.place(p.x, p.y, this.outdoors);

    this.sizer.observe(host);
    this.resize();
    const c = this.renderer.domElement;
    c.style.cursor = 'pointer';
    addEventListener('mousemove', this.onMove);
    addEventListener('mousedown', this.onDown);
    addEventListener('contextmenu', this.onMenu);
    addEventListener('keydown', this.onKey);
    addEventListener('keyup', this.onKeyUp);
    addEventListener('blur', this.onBlur);
    document.addEventListener('pointerlockchange', this.onLock);
    document.addEventListener('fullscreenchange', this.onBlur);
    ev.lock(this.locked);
  }

  dispose() {
    this.gone = true;
    cancelAnimationFrame(this.raf);
    this.sizer.disconnect();
    removeEventListener('mousemove', this.onMove);
    removeEventListener('mousedown', this.onDown);
    removeEventListener('contextmenu', this.onMenu);
    removeEventListener('keydown', this.onKey);
    removeEventListener('keyup', this.onKeyUp);
    removeEventListener('blur', this.onBlur);
    removeEventListener('beforeunload', this.onUnload);
    document.removeEventListener('pointerlockchange', this.onLock);
    document.removeEventListener('fullscreenchange', this.onBlur);
    this.scene.add(this.me);
    this.hall?.dispose();
    this.land.dispose();
    this.life?.dispose();
    this.town?.dispose();
    this.me.traverse(o => { if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) o.geometry.dispose(); });
    this.mats.dispose();
    this.hand.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private get pos(): Pos { return { x: this.body.x, y: this.body.y }; }
  private get world() { return this.hall?.world ?? this.outdoors; }

  // ---------- the town ----------

  setPlaces(places: Placement[], notes: Record<string, string>) {
    this.places = places;
    const s = sig(places);
    if (s !== this.sig) {
      this.sig = s;
      if (this.town) { this.scene.remove(this.town.root); this.town.dispose(); }
      if (this.life) { this.scene.remove(this.life.root); this.life.dispose(); }
      this.town = buildTown(places, this.mats, this.font, this.fonts);
      this.town.setNight(this.night);
      this.outdoors = worldOf(this.town.world);
      this.life = buildLife(places, this.mats);
      this.life.root.traverse(o => { o.castShadow = false; });
      this.scene.add(this.town.root, this.life.root);
      this.makeTags();
      this.renderer.shadowMap.needsUpdate = true;
    } else {
      this.town?.setBusy(new Set(places.filter(p => p.status === 'busy').map(p => p.id)));
    }
    for (const p of places) {
      const el = this.tags.get(p.id);
      if (el) el.textContent = notes[p.id] ? `${placementName(p)} · ${notes[p.id]}` : placementName(p);
    }
    // standing somewhere the new town has a wall: back to the start
    if (!this.hall && this.town && this.body.under(this.world, this.body.x, this.body.y) > this.body.z + 0.3) this.body.place(START.x, START.y, this.world);
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

  // where you stand on the map: off a roof or out of a treetop, the nearest free spot on the
  // ground; out in the land past the board, the nearest spot on it
  private groundPos(): Pos {
    const x = Math.max(0.5, Math.min(N - 0.5, this.body.x)), y = Math.max(0.5, Math.min(N - 0.5, this.body.y));
    if (free(this.places, x, y)) return { x, y };
    const under = this.places.find(pl => {
      const f = footprint(pl);
      return x > f.x - 0.3 && x < f.x + f.w + 0.3 && y > f.y - 0.3 && y < f.y + f.d + 0.3;
    });
    const d = under && doorOf(this.places, under);
    if (d) return d;
    for (let r = 0.25; r < 5; r += 0.25) for (let i = 0; i < 16; i++) {
      const a = i / 16 * Math.PI * 2, px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
      if (free(this.places, px, py)) return { x: px, y: py };
    }
    return { ...START };
  }

  // ---------- the halls ----------

  // into a building: the view fades to its name, the hall is built from its data, and you
  // stand inside the door with its machines in front of you
  private async enterHall(pl: Placement) {
    if (this.entering || this.hall) return;
    this.entering = true;
    this.keys.clear();
    this.outside = doorOf(this.places, pl) ?? this.groundPos();
    this.ev.veil(placementName(pl));
    const [data] = await Promise.all([
      this.ev.hall(pl).catch((): HallData => ({ sheet: null, lines: [], jobs: [], gpus: null, plant: null, shelf: null, roster: null })),
      sleep(380),
    ]);
    this.entering = false;
    if (this.gone || !this.eyes) { this.ev.veil(null); return; } // left for the map meanwhile
    this.showHall(pl, data, true);
    this.ev.inside(pl);
    this.ev.veil(null);
  }

  private showHall(pl: Placement, data: HallData, fresh: boolean) {
    const keep = this.hall && !fresh ? this.pos : null;
    this.scene.add(this.me); // out of the old hall before it goes
    this.hall?.dispose();
    const hall = this.hall = buildHall(pl, data, this.mats, this.font, this.fonts);
    this.hallSig = JSON.stringify(data);
    hall.scene.add(this.me);
    if (keep) {
      this.body.x = keep.x; this.body.y = keep.y;
    } else {
      this.body.place(hall.spawn.x, hall.spawn.y, hall.world);
      this.heading = hall.spawn.heading;
      this.pitch = hall.spawn.pitch;
      this.third = false;
    }
    this.polled = performance.now();
    this.renderer.shadowMap.autoUpdate = true; // things move in here
    this.setTarget(null);
    this.wake();
  }

  // the hall again, if what it shows has changed (a GPU got busy, a stage finished)
  private async refreshHall() {
    const hall = this.hall;
    if (!hall) return;
    const data = await this.ev.hall(hall.pl).catch(() => null);
    if (!data || this.hall !== hall || JSON.stringify(data) === this.hallSig) return;
    this.showHall(hall.pl, data, false);
  }

  // back out at the door you went in by, facing away from the building
  private leaveHall(veil = true) {
    const hall = this.hall;
    if (!hall) return;
    const done = () => {
      if (this.hall !== hall) return;
      this.scene.add(this.me);
      hall.dispose();
      this.hall = null;
      const at = this.outside ?? this.groundPos();
      this.body.place(at.x, at.y, this.world);
      const f = footprint(hall.pl);
      this.heading = Math.atan2(at.y - (f.y + f.d / 2), at.x - (f.x + f.w / 2));
      this.pitch = -0.05;
      this.renderer.shadowMap.autoUpdate = false;
      this.renderer.shadowMap.needsUpdate = true;
      this.setTarget(null);
      this.ev.inside(null);
      savePos(this.pos);
      this.wake();
    };
    if (!veil) { done(); return; }
    this.keys.clear();
    this.ev.veil('');
    setTimeout(() => { done(); this.ev.veil(null); }, 320);
  }

  // ---------- the camera ----------

  // the map's own view, from the air: same centre, same width on screen
  private air(v: MapView): Orbit {
    const gx = (v.cx / 32 + v.cy / 16) / 2, gy = (v.cy / 16 - v.cx / 32) / 2;
    const d = v.w / MAP_PX / (2 * Math.tan(FOV_AIR / 2 * Math.PI / 180) * this.camera.aspect);
    return { t: new THREE.Vector3(gx, 0, gy), d, az: AIR_AZ, el: AIR_EL, fov: FOV_AIR };
  }

  // through your eyes: an orbit of a point a few tiles ahead, from right behind it; seen from
  // outside, an orbit of your head from a little way back, pulled in where something is in the way
  private eye(): Orbit {
    const cp = Math.cos(this.pitch);
    const f = new THREE.Vector3(Math.cos(this.heading) * cp, Math.sin(this.pitch), Math.sin(this.heading) * cp);
    const walking = this.body.ground ? Math.sin(this.bob) * 0.012 : 0;
    const e = new THREE.Vector3(this.pos.x, this.body.eye + (this.opt.bob ? walking : 0), this.pos.y);
    const o = { az: Math.atan2(-f.z, -f.x), el: Math.asin(-f.y), fov: this.opt.fov };
    if (!this.third) return { t: e.addScaledVector(f, 3), d: 3, ...o };
    const back = f.clone().negate();
    this.ray.set(e, back);
    this.ray.far = BEHIND;
    const hit = this.ray.intersectObjects(this.hall ? this.hall.pick : this.town?.pick ?? [], false)[0];
    let d = hit ? Math.max(0.4, hit.distance - 0.15) : BEHIND;
    const [x0, y0, x1, y1] = this.world.bounds, room = this.hall ? this.world.ceiling - 0.05 : Infinity;
    for (let s = d; s > 0.4; s -= 0.05) { // and keep the camera inside a hall's walls
      const c = e.clone().addScaledVector(back, s);
      if (c.x > x0 + 0.05 && c.x < x1 - 0.05 && c.z > y0 + 0.05 && c.z < y1 - 0.05 && c.y < room && c.y > 0.05) break;
      d = s - 0.05;
    }
    return { t: e, d: Math.max(0.4, d), ...o };
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
    fog.near = o.d + 6 + Math.max(0, c.position.y - 3) * 0.6; // flying high, you see further
    fog.far = o.d + 44 + Math.max(0, c.position.y - 3) * 1.4;
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
    if (this.hall) this.leaveHall(false);
    let p = loadPos();
    if (!free(this.places, p.x, p.y)) p = { ...START };
    this.body.place(p.x, p.y, this.world);
    this.heading = HEADING;
    this.pitch = -0.05;
    this.third = false;
    this.setEyes(false);
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
    await this.fly(() => this.eye(), this.opt.calm ? 1200 : 2100);
    this.setEyes(true);
  }

  // back up to the map's angle, over where you stand; the map takes over from there
  async up(): Promise<MapView> {
    document.exitPointerLock?.();
    this.keys.clear();
    this.offUnload();
    if (this.hall) this.leaveHall(false);
    const g = this.groundPos();
    this.body.place(g.x, g.y, this.world);
    savePos(g);
    this.third = false;
    this.nightTo = 0; // the map is drawn by day: the flight brings the morning
    this.setEyes(false);
    const v = { cx: (g.x - g.y) * 32, cy: (g.x + g.y) * 16, w: this.width };
    await this.fly(() => this.air(v), this.opt.calm ? 900 : 1500);
    return v;
  }

  setShown(on: boolean) { this.shown = on; this.wake(); }

  setOptions(o: EngineOptions) {
    const was = this.opt;
    this.opt = { ...o };
    if (o.quality !== was.quality || !this.started) {
      this.started = true;
      const size = SHADOW[o.quality];
      this.renderer.setPixelRatio(Math.min(o.quality === 'high' ? 2 : o.quality === 'mid' ? 1.5 : 1, devicePixelRatio));
      this.resize();
      // lit materials pick up a light that stops or starts casting by themselves
      this.sun.castShadow = size > 0;
      if (size && this.sun.shadow.mapSize.x !== size) {
        this.sun.shadow.mapSize.set(size, size);
        this.sun.shadow.map?.dispose();
        this.sun.shadow.map = null;
      }
      this.renderer.shadowMap.needsUpdate = true;
    }
    this.wake();
  }

  private setEyes(on: boolean) {
    if (this.eyes === on) return;
    this.eyes = on;
    this.ev.eyes(on);
  }

  // take the mouse for looking round; needs a click (or a key) the browser counts as the user's
  lock() {
    const p = this.renderer.domElement.requestPointerLock?.() as Promise<void> | undefined;
    p?.catch?.(() => {}); // refused: a click on the town tries again
  }

  setActive(on: boolean) {
    this.active = on;
    if (!on) {
      this.keys.clear();
      this.offUnload();
      // a room, the chat or the status view came up: give the mouse back (not while flying in,
      // when the app has just locked it for the walk ahead)
      if (this.eyes && this.locked) document.exitPointerLock?.();
      this.setTarget(null);
    }
    this.wake();
  }

  private resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.hand.setAspect(w / h);
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
      if (this.active) this.move(dt);
      this.orbit = this.eye();
    }
    this.place(this.orbit);
    if (this.eyes && this.active && !this.flight) this.aim();
    this.dusk(dt);
    const town = this.town, hall = this.hall, air = clamp01((this.orbit.d - 4) / 16);
    if (hall) {
      hall.update(this.clock, dt);
      if (this.active && now - this.polled > 20000) { this.polled = now; void this.refreshHall(); }
    } else if (town) {
      // a building rising or settling moves its shadow; a few times a second is enough
      const focus = this.target?.kind === 'building' ? this.target.pl.id : null;
      if (town.update(this.clock, dt, focus) && now - this.shadowed > 120) {
        this.shadowed = now;
        this.renderer.shadowMap.needsUpdate = true;
      }
      this.life?.update(this.clock, dt, new THREE.Vector3(this.body.x, this.body.z, this.body.y), this.night, air);
      // the land round the town, built out further the higher you fly
      town.setAir(air);
      this.land.setAir(air);
      const reach = Math.min(110, REACH_LAND[this.opt.quality] + Math.max(0, this.camera.position.y - 3) * 1.2);
      this.land.update(this.body.x, this.body.y, this.clock, reach);
    }
    // you are seen from the air and from behind, not through your own eyes
    const me = this.me;
    me.position.set(this.body.x, this.body.feet, this.body.y);
    me.scale.set(1, 1 - 0.28 * this.body.low, 1);
    me.rotation.y = -this.heading;
    me.visible = (!this.eyes || this.third || !!this.flight) && this.camera.position.distanceTo(new THREE.Vector3(this.body.x, this.body.eye, this.body.y)) > 0.6;
    this.renderer.render(hall ? hall.scene : this.scene, this.camera);
    const v = this.body.ground ? this.body.speed : 0;
    this.hand.update(dt, { show: this.opt.hand && this.eyes && !this.third, walk: this.opt.bob ? v / WALK : 0, phase: this.bob, t: this.clock });
    this.hand.render(this.renderer);
    this.drawTags();
    this.drawMarker();
    this.tellMode();
    const animate = this.active || this.flight || Math.abs(this.night - this.nightTo) > 0.001;
    if (this.shown && animate) this.raf = requestAnimationFrame(this.frame);
    else this.last = 0;
  };

  private move(dt: number) {
    const k = this.keys, has = (...c: string[]) => c.some(x => k.has(x));
    if (has('ArrowLeft')) this.heading -= TURN * dt;
    if (has('ArrowRight')) this.heading += TURN * dt;
    const inp: Input = {
      fwd: (has('KeyW', 'ArrowUp') ? 1 : 0) - (has('KeyS', 'ArrowDown') ? 1 : 0),
      side: (has('KeyD') ? 1 : 0) - (has('KeyA') ? 1 : 0),
      run: has('ShiftLeft', 'ShiftRight'),
      up: has('Space'),
      down: has('ControlLeft', 'ControlRight', 'KeyC'),
    };
    const moving = this.body.step(dt, this.heading, inp, this.world);
    if (!moving) return;
    if (this.body.ground) this.bob += this.body.speed * dt * 6.5;
    const now = performance.now();
    if (!this.hall && now - this.saved > 600 && this.body.z < 0.05) {
      this.saved = now;
      if (free(this.places, this.body.x, this.body.y)) savePos(this.pos);
    }
    this.ev.moved();
  }

  // the light: by day the paper's own; at night a deep blue, a moon instead of the sun, and
  // every window and lamp lit
  private dusk(dt: number) {
    const rate = this.flight ? 3 : 0.9;
    if (Math.abs(this.night - this.nightTo) < 0.001) this.night = this.nightTo;
    else this.night += (this.nightTo - this.night) * (1 - Math.exp(-dt * rate));
    const n = this.night;
    const sky = new THREE.Color(PAPER).lerp(NIGHT, n);
    (this.scene.background as THREE.Color).copy(sky);
    (this.scene.fog as THREE.Fog).color.copy(sky);
    this.ambient.intensity = lerp(0.5, 0.24, n) * Math.PI;
    this.fill.intensity = lerp(0.44, 0.1, n) * Math.PI;
    this.sun.intensity = lerp(0.79, 0.2, n) * Math.PI;
    this.sun.color.copy(WHITE).lerp(MOON, n);
    this.town?.setNight(n);
    this.land.setNight(n);
  }

  // ---------- what you are looking at ----------

  // what F or a click acts on: in the town, the building or person under the crosshair up
  // close, or else the door you stand at; in a hall, the machine you aim at, or the way out
  private aim() {
    const ray = this.ray;
    ray.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    ray.far = AIM + (this.third ? BEHIND : 0);
    if (this.hall) {
      const h = ray.intersectObjects(this.hall.pick, false)[0];
      const thing = (h?.object.userData.thing as Thing | undefined) ?? null;
      const ex = this.hall.exit.at, near = Math.hypot(ex.x - this.body.x, ex.z - this.body.y) < 0.9;
      this.setTarget(thing ? { kind: 'thing', thing } : near ? { kind: 'thing', thing: this.hall.exit } : null);
      return;
    }
    if (!this.town) return;
    const h = ray.intersectObjects([...this.town.pick, ...(this.life?.pick ?? [])], false)[0];
    const walker = h?.object.userData.walker as Walker | undefined;
    if (walker) { this.setTarget({ kind: 'walker', walker }); return; }
    const id = h?.object.userData.id as string | undefined;
    const look = (id && this.places.find(p => p.id === id)) || null;
    const door = look || this.body.z > 0.3 ? null : this.doorAhead();
    this.setTarget(look ? { kind: 'building', pl: look, how: 'look' } : door ? { kind: 'building', pl: door, how: 'door' } : null);
  }

  // the door you stand at; with two in reach, the one you face
  private doorAhead() {
    let best: Placement | null = null, score = Infinity;
    for (const p of this.places) {
      const d = gap(this.body.x, this.body.y, p) - (p.core ? 0.3 : 0);
      if (d >= REACH) continue;
      const f = footprint(p), a = Math.atan2(f.y + f.d / 2 - this.body.y, f.x + f.w / 2 - this.body.x);
      const s = d - 0.6 * Math.cos(a - this.heading);
      if (s < score) { score = s; best = p; }
    }
    return best;
  }

  private setTarget(t: Target | null) {
    const key = (x: Target | null) => !x ? '' : x.kind === 'building' ? `b:${x.pl.id}:${x.how}` : x.kind === 'thing' ? `t:${x.thing.title}:${x.thing.sub}` : `w:${x.walker.key}`;
    if (key(t) === key(this.target)) return;
    this.target = t;
    this.ev.target(t);
  }

  private screen(p: THREE.Vector3) {
    const r = this.renderer.domElement.getBoundingClientRect(), q = p.clone().project(this.camera);
    return { x: r.left + (q.x + 1) / 2 * r.width, y: r.top + (1 - q.y) / 2 * r.height };
  }

  // F, or a click on what you aim at
  private act(byClick: boolean) {
    const t = this.target;
    if (!t || (byClick && t.kind === 'building' && t.how === 'door')) return;
    this.hand.swing();
    if (t.kind === 'walker') { t.walker.hop(); return; }
    if (t.kind === 'building') { void this.enterHall(t.pl); return; }
    const a = t.thing.act;
    if (a.kind === 'exit') { this.leaveHall(); return; }
    this.keys.clear();
    this.offUnload();
    if (this.locked) document.exitPointerLock?.();
    this.ev.open(a.building, this.screen(t.thing.at), a.line);
  }

  // stand at a building's door without going in (a click on it in the minimap)
  toDoor(id: string) {
    if (this.hall) this.leaveHall(false);
    // a step further off than on the map, so the front is in view, still within reach of the door
    const pl = this.places.find(p => p.id === id), d = pl && (doorOf(this.places, pl, 1.0) ?? doorOf(this.places, pl));
    if (!d) return;
    this.body.place(d.x, d.y, this.world);
    // face the building, the crosshair on its middle
    const f = this.town?.buildings.get(id)?.mid;
    if (f) {
      this.heading = Math.atan2(f.z - d.y, f.x - d.x);
      this.pitch = Math.max(-0.3, Math.min(0.3, Math.atan2(Math.max(f.y, 0.35) - this.body.eye, Math.hypot(f.z - d.y, f.x - d.x))));
    }
    savePos(this.pos);
    this.ev.moved();
    this.wake();
  }

  // jump to a spot (a click on the minimap)
  teleport(x: number, y: number) {
    if (!free(this.places, x, y)) return false;
    if (this.hall) this.leaveHall(false);
    this.body.place(x, y, this.world);
    savePos(this.pos);
    this.ev.moved();
    this.wake();
    return true;
  }

  private tellMode() {
    const m: Mode = { fly: this.body.fly, low: this.body.low > 0.5, third: this.third, night: this.nightTo > 0.5 };
    const s = `${+m.fly}${+m.low}${+m.third}${+m.night}`;
    if (s === this.modeSig) return;
    this.modeSig = s;
    this.ev.mode(m);
  }

  // ---------- tags and the minimap marker ----------

  private drawTags() {
    if (!this.town) return;
    this.tagHost.style.visibility = this.hall ? 'hidden' : '';
    if (this.hall) return;
    const r = this.renderer.domElement.getBoundingClientRect(), cam = this.camera;
    const high = Math.min(1, Math.max(0, (this.orbit.d - 4) / 6)); // up in the air the map's labels show
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
    const on = this.target?.kind === 'building' ? this.target.pl.id : null;
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
      el.classList.toggle('on', on === id);
    }
  }

  private drawMarker() {
    const m = this.marker;
    if (!m) return;
    // out past the board, the marker waits at its edge
    const at = this.hall ? this.outside ?? this.pos : this.pos, x = Math.max(0, Math.min(N, at.x)), y = Math.max(0, Math.min(N, at.y));
    const c = Math.cos(this.heading), s = Math.sin(this.heading);
    m.classList.toggle('away', x !== at.x || y !== at.y);
    const deg = Math.atan2((c + s) * 16, (c - s) * 32) * 180 / Math.PI; // the heading as drawn on the map
    m.setAttribute('transform', `translate(${((x - y) * 32).toFixed(1)},${((x + y) * 16).toFixed(1)}) rotate(${deg.toFixed(1)})`);
  }

  // ---------- input ----------

  private onKey = (e: KeyboardEvent) => {
    if (!this.active || !this.eyes || this.flight || typing(e) || e.metaKey || e.altKey) return;
    const c = e.code;
    if (c === 'KeyF') {
      e.preventDefault();
      if (!e.repeat) this.act(false);
      return;
    }
    if (c === 'KeyM' && !e.repeat) { e.preventDefault(); this.ev.leave(); return; }
    if (c === 'KeyV' && !e.repeat) { e.preventDefault(); this.third = !this.third; this.wake(); return; }
    if (c === 'KeyT' && !e.repeat && !this.hall) { e.preventDefault(); this.nightTo = this.nightTo ? 0 : 1; this.wake(); return; }
    if (c === 'Space') {
      e.preventDefault();
      if (!e.repeat) {
        // one tap jumps; a second one right after takes off, or lands you if you are flying
        const now = performance.now();
        if (now - this.tapped < TAP) { this.body.setFly(!this.body.fly); this.tapped = 0; }
        else { this.tapped = now; this.body.jump(); }
      }
    } else if (c === 'ControlLeft' || c === 'ControlRight') {
      // held for crouching, Ctrl turns W into a key that closes the tab on some systems: ask first
      addEventListener('beforeunload', this.onUnload);
    }
    if (/^(Key[WASDC]|Arrow(Up|Down|Left|Right)|Shift(Left|Right)|Control(Left|Right)|Space)$/.test(c)) {
      e.preventDefault();
      this.keys.add(c);
      this.wake();
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
    if (e.code === 'ControlLeft' || e.code === 'ControlRight') this.offUnload();
  };
  // a key let go while the browser had the keyboard (leaving full screen, the mouse let go
  // with Esc, another window) never sends its keyup: forget what was held
  private onBlur = () => { this.keys.clear(); this.offUnload(); };
  private onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
  private offUnload() { removeEventListener('beforeunload', this.onUnload); }

  // with the mouse locked, moving it turns your head; a click acts on what you aim at.
  // Unlocked, a click on the town takes the mouse back.
  private onMove = (e: MouseEvent) => {
    if (!this.locked || !this.active || !this.eyes) return;
    const clamp = (v: number) => Math.max(-160, Math.min(160, v)); // browsers now and then report a wild jump
    const k = LOOK * this.opt.sensitivity;
    this.hand.look(clamp(e.movementX), clamp(e.movementY) * (this.opt.invertY ? -1 : 1));
    this.heading += clamp(e.movementX) * k;
    this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch - clamp(e.movementY) * k * (this.opt.invertY ? -1 : 1)));
  };

  private onDown = (e: MouseEvent) => {
    if (e.button !== 0 || !this.active || !this.eyes) return;
    if (this.locked) {
      e.preventDefault();
      if (!this.flight) this.act(true);
    } else if (e.target === this.renderer.domElement) {
      if (this.opt.fullscreen) enterFull();
      this.lock();
    }
  };

  // a Ctrl-click on a Mac is a right click: no menu while you walk
  private onMenu = (e: MouseEvent) => { if (this.eyes && this.active && (this.locked || e.target === this.renderer.domElement)) e.preventDefault(); };

  private onLock = () => {
    this.onBlur();
    this.locked = !!document.pointerLockElement;
    this.ev.lock(this.locked);
    this.wake();
  };
}
