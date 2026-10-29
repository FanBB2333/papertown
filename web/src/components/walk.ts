// Walking the town, shared by the map's small figure (useAvatar) and the 3D town: where
// you stand (kept across reloads and across the two views), what you bump into, and
// which building's door you are at. Positions are in tile units.

import { footprint, tileMat } from '@design/world.js';
import type { Placement } from '../api';

const N = 24;
export const R = 0.22; // body radius
export const REACH = 1.1; // how close counts as "at the door"
const STORE = 'pt-avatar-2'; // bumped when the town is laid out anew
export const START = { x: 7.5, y: 4.5 }; // on the ring road, at the mill's door

export interface Pos { x: number; y: number }

export function loadPos(): Pos {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? 'null');
    if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) return v;
  } catch { /* private mode or bad data */ }
  return { ...START };
}

export function savePos(p: Pos) {
  try { localStorage.setItem(STORE, JSON.stringify({ x: +p.x.toFixed(2), y: +p.y.toFixed(2) })); } catch { /* ignore */ }
}

function blocked(places: Placement[], x: number, y: number) {
  if (x < 0.2 || y < 0.2 || x > N - 0.2 || y > N - 0.2) return true;
  if (tileMat(Math.floor(x), Math.floor(y)) === 'water') return true;
  for (const p of places) {
    const f = footprint(p);
    if (x > f.x - 0.05 && x < f.x + f.w + 0.05 && y > f.y - 0.05 && y < f.y + f.d + 0.05) return true;
  }
  return false;
}

export function free(places: Placement[], x: number, y: number) {
  return !blocked(places, x - R, y - R) && !blocked(places, x + R, y - R) && !blocked(places, x - R, y + R) && !blocked(places, x + R, y + R);
}

// one step towards (nx, ny), sliding along walls: both axes, then each alone
export function slide(places: Placement[], p: Pos, nx: number, ny: number): Pos {
  if (free(places, nx, ny)) return { x: nx, y: ny };
  if (free(places, nx, p.y)) return { x: nx, y: p.y };
  if (free(places, p.x, ny)) return { x: p.x, y: ny };
  return p;
}

// distance from a point to a building's footprint
export function gap(px: number, py: number, p: Placement) {
  const f = footprint(p);
  const dx = Math.max(f.x - px, 0, px - (f.x + f.w)), dy = Math.max(f.y - py, 0, py - (f.y + f.d));
  return Math.hypot(dx, dy);
}

// the building whose door you stand at, if any (the core ones reach a little further)
export function nearest(places: Placement[], x: number, y: number): Placement | null {
  let best: Placement | null = null, bd = REACH;
  for (const p of places) {
    const d = gap(x, y, p) - (p.core ? 0.3 : 0);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

// a free spot just outside a building (`away` tiles off its wall), front first
export function doorOf(places: Placement[], p: Placement, away = 0.6): Pos | null {
  const f = footprint(p);
  const spots = [[f.x + f.w / 2, f.y + f.d + away], [f.x + f.w + away, f.y + f.d / 2], [f.x + f.w / 2, f.y - away], [f.x - away, f.y + f.d / 2]];
  const spot = spots.find(([x, y]) => free(places, x, y));
  return spot ? { x: spot[0], y: spot[1] } : null;
}
