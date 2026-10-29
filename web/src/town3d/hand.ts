// Your own hand in the 3D town, as in a block-building game: a square arm in a sleeve of
// the town's colour, holding a pencil, at the bottom right of the view. It has a scene
// and a camera of its own and is drawn over the town after the depth is cleared, so it
// never pokes into a wall. It rises into view once you have landed, bobs with your steps,
// trails a little behind the mouse, and swings when you click.

import * as THREE from 'three';
import { THEMES } from '@design/theme.js';
import { INK, inkLines } from './scene';

const BRAND = (THEMES.sketch as { ui: { brand: string } }).ui.brand;
const SKIN = '#eecaa2', CUFF = '#e7ca7b';
const W = 0.15, L = 0.66; // the arm's square side and its length
const REST = new THREE.Euler(-0.95, 0, 0.6); // from the bottom right corner, forward, up and in towards the middle
const P = 0.72; // the pencil's size against the arm
const SWING = 0.3; // seconds

export interface HandPose {
  show: boolean;
  walk: number; // 0 standing .. 1 walking .. 2 running
  phase: number; // the step cycle
  t: number; // seconds, for breathing
}

export class Hand {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.01, 5);
  private root = new THREE.Group(); // where the shoulder is in view
  private arm = new THREE.Group(); // turned about the shoulder
  private mats: THREE.Material[] = [];
  private geos: THREE.BufferGeometry[] = [];
  private vis = 0; // 0 out of view .. 1 in
  private lag = new THREE.Vector2(); // how far the hand trails the look
  private swingAt = -1;
  private aspect = 1.6;

  constructor() {
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.46 * Math.PI));
    const key = new THREE.DirectionalLight(0xffffff, 0.48 * Math.PI);
    key.position.set(-0.35, 0.85, 0.45);
    const fill = new THREE.DirectionalLight(0xffffff, 0.2 * Math.PI);
    fill.position.set(0.6, -0.2, 0.7);
    this.scene.add(key, fill);

    const ink: number[] = [];
    const part = (g: THREE.BufferGeometry, color: string, at: THREE.Matrix4, flat = false) => {
      g.applyMatrix4(at);
      const m = new THREE.MeshLambertMaterial({ color, flatShading: flat });
      this.geos.push(g);
      this.mats.push(m);
      this.arm.add(new THREE.Mesh(g, m));
      const e = new THREE.EdgesGeometry(g, 25);
      ink.push(...(e.getAttribute('position').array as Float32Array));
      e.dispose();
    };
    const at = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);

    // the arm runs up its own y from the shoulder (0) to the knuckles (L)
    part(new THREE.BoxGeometry(W, L, W), SKIN, at(0, L / 2, 0));
    part(new THREE.BoxGeometry(W + 0.03, 0.4, W + 0.03), BRAND, at(0, 0.2, 0));
    part(new THREE.BoxGeometry(W + 0.036, 0.04, W + 0.036), CUFF, at(0, 0.395, 0));

    // the pencil, gripped a third of the way up, standing out of the fist and leaning away
    const grip = new THREE.Matrix4().compose(
      new THREE.Vector3(0, L - 0.07, 0.01),
      new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0.8, 0.55).normalize()),
      new THREE.Vector3(P, P, P),
    );
    const along = (y0: number, y1: number) => grip.clone().multiply(at(0, (y0 + y1) / 2 - 0.1, 0));
    const r = 0.026;
    part(new THREE.CylinderGeometry(r, r, 0.04, 6), '#e5a29a', along(0, 0.04), true); // eraser
    part(new THREE.CylinderGeometry(r * 1.08, r * 1.08, 0.03, 6), '#b8ad9a', along(0.04, 0.07), true); // ferrule
    part(new THREE.CylinderGeometry(r, r, 0.22, 6), '#f2cf63', along(0.07, 0.29), true); // the yellow body
    part(new THREE.CylinderGeometry(0.008, r, 0.055, 6), '#e8c9a0', along(0.29, 0.345), true); // sharpened wood
    part(new THREE.CylinderGeometry(0, 0.008, 0.016, 6), '#3a332c', along(0.345, 0.361), true); // the lead

    const lineMat = new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0.8 });
    this.mats.push(lineMat);
    const lines = inkLines(ink, lineMat);
    this.geos.push(lines.geometry);
    this.arm.add(lines);

    this.arm.rotation.copy(REST);
    this.root.add(this.arm);
    this.root.visible = false;
    this.scene.add(this.root);
  }

  setAspect(a: number) {
    this.aspect = a;
    this.camera.aspect = a;
    this.camera.updateProjectionMatrix();
  }

  // mouse movement this frame, in pixels: the hand lags a little behind where you look
  look(dx: number, dy: number) {
    this.lag.x = THREE.MathUtils.clamp(this.lag.x + dx * 0.0009, -0.12, 0.12);
    this.lag.y = THREE.MathUtils.clamp(this.lag.y + dy * 0.0009, -0.1, 0.1);
  }

  swing(now = performance.now()) {
    // a new swing only once the last one is well on its way back
    if (this.swingAt < 0 || now - this.swingAt > SWING * 600) this.swingAt = now;
  }

  // true while it is still moving by itself (rising, settling, swinging)
  update(dt: number, p: HandPose, now = performance.now()) {
    this.vis += ((p.show ? 1 : 0) - this.vis) * (1 - Math.exp(-dt * (p.show ? 6 : 10)));
    if (!p.show && this.vis < 0.01) this.vis = 0;
    this.root.visible = this.vis > 0.001;
    if (!this.root.visible) return false;

    this.lag.multiplyScalar(Math.exp(-dt * 7));
    const out = 1 - this.vis, rise = out * out * (3 - 2 * out); // eased: quick to start, soft to settle
    const step = Math.min(2, p.walk);
    const bx = Math.sin(p.phase * 0.5) * 0.022 * step, by = -Math.abs(Math.cos(p.phase * 0.5)) * 0.026 * step;
    const breathe = Math.sin(p.t * 1.7) * 0.004 * (1 - Math.min(1, step));

    // keep the knuckles at about the same place across the screen whatever its shape
    const x = 0.373 + 0.154 * this.aspect;
    this.root.position.set(x + bx - this.lag.x * 0.6, -0.57 + by + breathe - rise * 0.5 + this.lag.y * 0.5, -0.5);
    this.root.rotation.set(this.lag.y * 0.8 - rise * 0.5, this.lag.x * 1.2, 0);

    // the swing: down and across, out fast and back slower, as in a block game
    let s = this.swingAt < 0 ? 1 : (now - this.swingAt) / 1000 / SWING;
    if (s >= 1) { s = 1; this.swingAt = -1; }
    const f1 = Math.sin(s * s * Math.PI), f2 = Math.sin(Math.sqrt(s) * Math.PI);
    this.arm.rotation.set(REST.x - f2 * 0.75, REST.y - f1 * 0.25, REST.z + f2 * 0.3);
    this.root.position.z -= f2 * 0.07;
    return this.swingAt >= 0 || Math.abs(this.vis - (p.show ? 1 : 0)) > 0.002;
  }

  render(r: THREE.WebGLRenderer) {
    if (!this.root.visible) return;
    r.autoClear = false;
    r.clearDepth();
    r.render(this.scene, this.camera);
    r.autoClear = true;
  }

  dispose() {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
  }
}
