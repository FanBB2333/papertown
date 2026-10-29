// You, walking the town: a small figure on the map moved with WASD or the arrow keys.
// It cannot walk through buildings or into the sea, the camera follows it, and next
// to a building a hint offers E (or Enter / Space) to go inside.

import { useCallback, useEffect, useRef, useState } from 'react';
import { iso } from '@design/sprites.js';
import { footprint, tileMat } from '@design/world.js';
import type { Placement } from '../api';

const N = 24;
const SPEED = 4.2; // tiles per second
const R = 0.22; // body radius in tiles
const REACH = 1.1; // how close counts as "at the door"
const STORE = 'pt-avatar-2'; // bumped when the town is laid out anew
const START = { x: 7.5, y: 4.5 }; // on the ring road, at the mill's door

// screen-aligned directions on the isometric grid
const DIRS: Record<string, [number, number]> = {
  up: [-1, -1], down: [1, 1], left: [-1, 1], right: [1, -1],
};
const KEYS: Record<string, keyof typeof DIRS> = {
  ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
};

const FIGURE = `
<ellipse class="av-shadow" cx="0" cy="0" rx="10" ry="4.5"/>
<g class="av-fig">
  <rect class="av-leg l" x="-4.6" y="-12" width="3.8" height="12" rx="1.9"/>
  <rect class="av-leg r" x="0.8" y="-12" width="3.8" height="12" rx="1.9"/>
  <path class="av-coat" d="M-8 -10.5C-8.6 -20 -6 -26.5 0 -26.8C6 -26.5 8.6 -20 8 -10.5C5 -9 -5 -9 -8 -10.5Z"/>
  <path class="av-scarf" d="M-6.4 -25.2C-2 -22.4 2 -22.4 6.4 -25.2L6.8 -22.6C2.4 -19.4 -2.4 -19.4 -6.8 -22.6Z"/>
  <circle class="av-head" cx="0" cy="-32.5" r="6.6"/>
  <path class="av-hair" d="M-6.7 -33.4C-6.6 -40.4 -1 -41.6 2.4 -40.6C6 -39.6 7.4 -36.4 6.6 -32.6C3.6 -36.2 -1.6 -36.8 -6.7 -33.4Z"/>
</g>
<g class="av-hint"><rect rx="10" ry="10" height="20" y="-66"/><text y="-52" text-anchor="middle"></text></g>`;

function load(): { x: number; y: number } {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? 'null');
    if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) return v;
  } catch { /* private mode or bad data */ }
  return { ...START };
}

function save(p: { x: number; y: number }) {
  try { localStorage.setItem(STORE, JSON.stringify({ x: +p.x.toFixed(2), y: +p.y.toFixed(2) })); } catch { /* ignore */ }
}

const foot = (p: Placement) => footprint(p);

// distance from a point to a footprint rectangle, in tiles
function gap(px: number, py: number, p: Placement) {
  const f = foot(p);
  const dx = Math.max(f.x - px, 0, px - (f.x + f.w)), dy = Math.max(f.y - py, 0, py - (f.y + f.d));
  return Math.hypot(dx, dy);
}

interface Opts {
  host: React.RefObject<HTMLElement>;
  placements: Placement[];
  markup: string; // re-mount the figure whenever the map markup is replaced
  active: boolean; // false while a building is open
  onEnter: (id: string) => void;
  follow: (sx: number, sy: number, k: number) => void;
}

export function useAvatar({ host, placements, markup, active, onEnter, follow }: Opts) {
  const pos = useRef(load());
  const keys = useRef(new Set<keyof typeof DIRS>());
  const el = useRef<SVGGElement | null>(null);
  const nearRef = useRef<Placement | null>(null);
  const [near, setNear] = useState<Placement | null>(null);
  const opts = useRef({ placements, active, onEnter, follow });
  opts.current = { placements, active, onEnter, follow };

  const blocked = useCallback((x: number, y: number) => {
    if (x < 0.2 || y < 0.2 || x > N - 0.2 || y > N - 0.2) return true;
    if (tileMat(Math.floor(x), Math.floor(y)) === 'water') return true;
    for (const p of opts.current.placements) {
      const f = foot(p);
      if (x > f.x - 0.05 && x < f.x + f.w + 0.05 && y > f.y - 0.05 && y < f.y + f.d + 0.05) return true;
    }
    return false;
  }, []);
  const free = useCallback((x: number, y: number) =>
    !blocked(x - R, y - R) && !blocked(x + R, y - R) && !blocked(x - R, y + R) && !blocked(x + R, y + R), [blocked]);

  // painter order: slot the figure between the buildings behind it and those in front
  const place = useCallback(() => {
    const g = el.current, svg = g?.ownerSVGElement;
    if (!g || !svg) return;
    const { x, y } = pos.current;
    const [sx, sy] = iso(x, y);
    g.setAttribute('transform', `translate(${sx.toFixed(1)},${sy.toFixed(1)})`);
    const k = x + y;
    let before: Element | null = null;
    for (const b of svg.querySelectorAll('.bld[data-id]')) {
      const p = opts.current.placements.find(q => q.id === b.getAttribute('data-id'));
      if (!p) continue;
      const f = foot(p);
      if (f.x + f.w / 2 + f.y + f.d / 2 > k) { before = b; break; }
    }
    before ??= svg.querySelector('.dlbl, .blbl');
    if (before && before.previousSibling !== g) svg.insertBefore(g, before);
    else if (!before && g.parentNode !== svg) svg.appendChild(g);
  }, []);

  const hint = useCallback((p: Placement | null) => {
    const g = el.current;
    if (!g) return;
    g.classList.toggle('has-hint', !!p);
    if (!p) return;
    const t = g.querySelector('.av-hint text')!, r = g.querySelector('.av-hint rect')!;
    t.textContent = `E 进入${p.name}`;
    const w = [...t.textContent].reduce((s, ch) => s + (/[　-鿿＀-￯]/.test(ch) ? 12 : 7), 0) + 18;
    r.setAttribute('width', String(w));
    r.setAttribute('x', String(-w / 2));
  }, []);

  const updateNear = useCallback(() => {
    const { x, y } = pos.current;
    let best: Placement | null = null, bd = REACH;
    for (const p of opts.current.placements) {
      const d = gap(x, y, p) - (p.core ? 0.3 : 0);
      if (d < bd) { bd = d; best = p; }
    }
    if (best?.id !== nearRef.current?.id) {
      nearRef.current = best;
      setNear(best);
      hint(best);
    }
  }, [hint]);

  // mount the figure into each new map svg
  useEffect(() => {
    const svg = host.current?.querySelector('svg');
    if (!svg) return;
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'avatar');
    g.innerHTML = FIGURE;
    svg.appendChild(g); // place() sorts it among the buildings
    el.current = g;
    if (!free(pos.current.x, pos.current.y)) pos.current = { ...START };
    place();
    hint(nearRef.current);
    return () => { g.remove(); if (el.current === g) el.current = null; };
  }, [markup, host, free, place, hint]);

  // the walking loop
  useEffect(() => {
    let raf = 0, last = 0, walking = false, saved = 0;
    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, last ? (t - last) / 1000 : 0);
      last = t;
      let dx = 0, dy = 0;
      for (const k of keys.current) { dx += DIRS[k][0]; dy += DIRS[k][1]; }
      const moving = opts.current.active && (dx || dy);
      if (moving) {
        const len = Math.hypot(dx, dy), step = SPEED * dt;
        const nx = pos.current.x + dx / len * step, ny = pos.current.y + dy / len * step;
        // slide along walls: try both axes, then each alone
        if (free(nx, ny)) pos.current = { x: nx, y: ny };
        else if (free(nx, pos.current.y)) pos.current = { ...pos.current, x: nx };
        else if (free(pos.current.x, ny)) pos.current = { ...pos.current, y: ny };
        const sdx = (dx - dy); // screen x direction
        if (sdx) el.current?.classList.toggle('face-left', sdx < 0);
        place();
        updateNear();
        const [sx, sy] = iso(pos.current.x, pos.current.y);
        opts.current.follow(sx, sy - 20, 1 - Math.pow(0.0015, dt));
        if (t - saved > 600) { saved = t; save(pos.current); }
      }
      if (!!moving !== walking) {
        walking = !!moving;
        el.current?.classList.toggle('walking', walking);
        if (!walking) save(pos.current);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [free, place, updateNear]);

  useEffect(() => {
    const typing = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
    };
    const down = (e: KeyboardEvent) => {
      if (!opts.current.active || typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const d = KEYS[e.code];
      if (d) { keys.current.add(d); e.preventDefault(); return; }
      if ((e.code === 'KeyE' || e.code === 'Enter' || e.code === 'Space') && nearRef.current) {
        e.preventDefault();
        keys.current.clear();
        opts.current.onEnter(nearRef.current.id);
      }
    };
    const up = (e: KeyboardEvent) => { const d = KEYS[e.code]; if (d) keys.current.delete(d); };
    const blur = () => keys.current.clear();
    addEventListener('keydown', down);
    addEventListener('keyup', up);
    addEventListener('blur', blur);
    return () => { removeEventListener('keydown', down); removeEventListener('keyup', up); removeEventListener('blur', blur); };
  }, []);

  useEffect(() => { if (!active) keys.current.clear(); }, [active]);
  useEffect(updateNear, [placements, updateNear]);

  // stand at a building's door (after clicking it on the map)
  const goTo = useCallback((id: string) => {
    const p = opts.current.placements.find(q => q.id === id);
    if (!p) return;
    const f = foot(p);
    const spots = [[f.x + f.w / 2, f.y + f.d + 0.6], [f.x + f.w + 0.6, f.y + f.d / 2], [f.x + f.w / 2, f.y - 0.6], [f.x - 0.6, f.y + f.d / 2]];
    const spot = spots.find(([x, y]) => free(x, y));
    if (!spot) return;
    pos.current = { x: spot[0], y: spot[1] };
    save(pos.current);
    place();
    updateNear();
  }, [free, place, updateNear]);

  const where = useCallback(() => iso(pos.current.x, pos.current.y), []);
  return { near, goTo, where };
}
