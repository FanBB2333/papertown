// You, walking the town: a small figure on the map moved with WASD or the arrow keys.
// It cannot walk through buildings or into the sea, the camera follows it, and next
// to a building a hint offers E (or Enter / Space) to go inside.

import { useCallback, useEffect, useRef, useState } from 'react';
import { iso } from '@design/sprites.js';
import { footprint } from '@design/world.js';
import type { Placement } from '../api';
import { START, doorOf, free as freeAt, loadPos, nearest, savePos, slide } from './walk';

const SPEED = 4.2; // tiles per second

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

const foot = (p: Placement) => footprint(p);

interface Opts {
  host: React.RefObject<HTMLElement>;
  placements: Placement[];
  markup: string; // re-mount the figure whenever the map markup is replaced
  active: boolean; // false while a building is open
  onEnter: (id: string) => void;
  follow: (sx: number, sy: number, k: number) => void;
}

export function useAvatar({ host, placements, markup, active, onEnter, follow }: Opts) {
  const pos = useRef(loadPos());
  const keys = useRef(new Set<keyof typeof DIRS>());
  const el = useRef<SVGGElement | null>(null);
  const nearRef = useRef<Placement | null>(null);
  const [near, setNear] = useState<Placement | null>(null);
  const opts = useRef({ placements, active, onEnter, follow });
  opts.current = { placements, active, onEnter, follow };

  const free = useCallback((x: number, y: number) => freeAt(opts.current.placements, x, y), []);

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
    const best = nearest(opts.current.placements, pos.current.x, pos.current.y);
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
        pos.current = slide(opts.current.placements, pos.current, pos.current.x + dx / len * step, pos.current.y + dy / len * step);
        const sdx = (dx - dy); // screen x direction
        if (sdx) el.current?.classList.toggle('face-left', sdx < 0);
        place();
        updateNear();
        const [sx, sy] = iso(pos.current.x, pos.current.y);
        opts.current.follow(sx, sy - 20, 1 - Math.pow(0.0015, dt));
        if (t - saved > 600) { saved = t; savePos(pos.current); }
      }
      if (!!moving !== walking) {
        walking = !!moving;
        el.current?.classList.toggle('walking', walking);
        if (!walking) savePos(pos.current);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [place, updateNear]);

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

  // back on the map (from a room or the 3D town): stand wherever you were last
  useEffect(() => {
    if (!active) { keys.current.clear(); return; }
    pos.current = loadPos();
    if (!free(pos.current.x, pos.current.y)) pos.current = { ...START };
    place();
    updateNear();
  }, [active, free, place, updateNear]);
  useEffect(updateNear, [placements, updateNear]);

  // stand at a building's door (after clicking it on the map)
  const goTo = useCallback((id: string) => {
    const p = opts.current.placements.find(q => q.id === id);
    const spot = p && doorOf(opts.current.placements, p);
    if (!spot) return;
    pos.current = spot;
    savePos(pos.current);
    place();
    updateNear();
  }, [place, updateNear]);

  const where = useCallback(() => iso(pos.current.x, pos.current.y), []);
  return { near, goTo, where };
}
