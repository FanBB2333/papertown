// Your body in 3D: standing, walking, jumping, crouching and flying over whatever a World says is solid.
// Tile units, three's axes: x and y on the ground (three's x and z), z up.

const EYE = 0.55, EYE_LOW = 0.38;
const TALL = 0.64; // head room
const R = 0.22; // body radius
export const WALK = 1.8;
const RUN = 3.6, SNEAK = 0.75, FLY = 4.2, FLY_RUN = 8.5, CLIMB = 3.4, WADE = 0.55;
const STEP = 0.21; // the highest step you walk up without jumping
const GRAVITY = 11, JUMP = 3.05;
const SPOTS = [[0, 0], ...Array.from({ length: 8 }, (_, i) => [Math.cos(i * Math.PI / 4), Math.sin(i * Math.PI / 4)])];

// what a body walks in: how high the solid top is at a point, shallow water, and what carries you (a running belt)
export interface World {
  top(x: number, y: number): number;
  wet?(x: number, y: number): boolean;
  drift?(x: number, y: number, z: number): [number, number] | null;
  bounds: [number, number, number, number]; // x0, y0, x1, y1
  ceiling: number;
}

export interface Input { fwd: number; side: number; run: boolean; up: boolean; down: boolean }

export class Body {
  x = 0; y = 0; z = 0;
  vx = 0; vy = 0; vz = 0;
  ground = true;
  fly = false;
  wet = false;
  low = 0; // how far crouched, 0..1
  private shown = 0; // the feet as seen: a step up is climbed over a few frames

  place(x: number, y: number, w: World) {
    this.x = x; this.y = y;
    this.z = this.shown = this.under(w, x, y);
    this.vx = this.vy = this.vz = 0;
    this.ground = true;
    this.fly = false;
  }

  get feet() { return this.shown; }
  get eye() { return this.shown + EYE + (EYE_LOW - EYE) * this.low; }
  get speed() { return Math.hypot(this.vx, this.vy); }

  // the highest solid top under the body's disc
  under(w: World, x: number, y: number) {
    let h = -Infinity;
    for (const [a, b] of SPOTS) h = Math.max(h, w.top(x + a * R * 0.92, y + b * R * 0.92));
    return h;
  }

  private fits(w: World, x: number, y: number, edge: boolean) {
    const [x0, y0, x1, y1] = w.bounds;
    if (x < x0 + R || y < y0 + R || x > x1 - R || y > y1 - R) return false;
    const h = this.under(w, x, y);
    if (h > this.z + STEP) return false;
    if (h + TALL > w.ceiling) return false;
    return !edge || h >= this.z - STEP;
  }

  jump() {
    if (this.fly || !this.ground) return;
    this.vz = JUMP * (this.wet ? 0.7 : 1);
    this.ground = false;
  }

  setFly(on: boolean) {
    this.fly = on;
    if (on) { this.ground = false; this.vz = Math.max(this.vz, 0) * 0.3; }
  }

  // one frame; true while moving
  step(dt: number, heading: number, inp: Input, w: World) {
    this.low += ((inp.down && !this.fly ? 1 : 0) - this.low) * (1 - Math.exp(-dt * 14));
    const crouched = this.low > 0.5 && !this.fly;
    const speed = this.fly ? (inp.run ? FLY_RUN : FLY) : (crouched ? SNEAK : inp.run ? RUN : WALK) * (this.wet ? WADE : 1);
    const ch = Math.cos(heading), sh = Math.sin(heading);
    let wx = ch * inp.fwd - sh * inp.side, wy = sh * inp.fwd + ch * inp.side;
    const l = Math.hypot(wx, wy);
    if (l) { wx = wx / l * speed; wy = wy / l * speed; }
    const a = 1 - Math.exp(-dt * (this.ground || this.fly ? 11 : 3));
    this.vx += (wx - this.vx) * a;
    this.vy += (wy - this.vy) * a;
    if (Math.hypot(this.vx, this.vy) < 0.01) this.vx = this.vy = 0;

    if (this.fly) this.vz += (((inp.up ? 1 : 0) - (inp.down ? 1 : 0)) * CLIMB - this.vz) * (1 - Math.exp(-dt * 10));
    else this.vz -= GRAVITY * dt;

    const edge = crouched && this.ground;
    const carry = this.ground ? w.drift?.(this.x, this.y, this.z) : null;
    const nx = this.x + (this.vx + (carry?.[0] ?? 0)) * dt, ny = this.y + (this.vy + (carry?.[1] ?? 0)) * dt;
    const was = { x: this.x, y: this.y, z: this.z };
    if (this.fits(w, nx, ny, edge)) { this.x = nx; this.y = ny; }
    else if (this.fits(w, nx, this.y, edge)) { this.x = nx; this.vy = 0; }
    else if (this.fits(w, this.x, ny, edge)) { this.y = ny; this.vx = 0; }
    else { this.vx = this.vy = 0; }

    const floor = this.under(w, this.x, this.y);
    this.z += this.vz * dt;
    if (this.ground && !this.fly && this.vz <= 0 && this.z - floor < STEP) this.z = floor;
    if (this.z <= floor) {
      this.z = floor;
      if (this.vz <= 0) {
        if (this.fly && this.vz < -0.5) this.fly = false;
        this.vz = 0;
        this.ground = !this.fly;
      }
    } else if (this.z - floor > 0.002) {
      this.ground = false;
    }
    if (this.z + TALL > w.ceiling) { this.z = w.ceiling - TALL; this.vz = Math.min(this.vz, 0); }
    this.wet = !this.fly && this.z - floor < 0.01 && !!w.wet?.(this.x, this.y);

    this.shown = this.z > this.shown ? this.shown + (this.z - this.shown) * (1 - Math.exp(-dt * 22)) : this.z;
    return this.x !== was.x || this.y !== was.y || Math.abs(this.z - was.z) > 1e-4 || Math.abs(this.shown - this.z) > 1e-3;
  }
}
