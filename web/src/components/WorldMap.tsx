// The 2D world map: the shared isometric SVG with eased drag and wheel zoom, a hover card per
// building, and a walking figure (useAvatar); a click on a building goes straight inside.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BUILDINGS, DISTRICTS } from '@design/sprites.js';
import { renderMap } from '@design/world.js';
import type { Placement } from '../api';
import { useSettings } from '../settings';
import { useAvatar } from './useAvatar';
import { tr } from '../i18n';

const BASE = { x: -790, y: -150, w: 1580, h: 950 };

// a strip between two yards says which two it serves
export function where(key: string) {
  const d = DISTRICTS[key];
  return d ? (d.dir.includes('↔') ? `${d.name} · ${d.dir}` : d.name) : '';
}
const MIN_W = 420, MAX_W = BASE.w * 1.5;
const ZOOM_RATE = 13, GLIDE_RATE = 5; // how fast the view closes in on where it is heading, per second

// what part of the map is on screen: its centre and width in map (svg) units
export interface MapView { cx: number; cy: number; w: number }
export interface MapApi { view(): MapView; setView(v: MapView): void }

interface Props {
  placements: Placement[];
  notes: Record<string, string>;
  active: boolean;
  hidden?: boolean; // the 3D town is showing instead
  api: React.MutableRefObject<MapApi | null>;
  onOpen: (id: string, at: { x: number; y: number }) => void;
}

export function WorldMap({ placements, notes, active, hidden, api, onOpen }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const vb = useRef({ ...BASE });
  const goal = useRef({ ...BASE });
  const anim = useRef({ raf: 0, last: 0, rate: ZOOM_RATE });
  const drag = useRef<{ x: number; y: number; gx: number; gy: number; id: number; moved: boolean; trail: { t: number; x: number; y: number }[] } | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; pl: Placement } | null>(null);
  const st = useSettings();
  const opt = useRef(st);
  opt.current = st;

  const markup = useMemo(
    () => renderMap({ placements, labels: st.mapLabels, highlight: null, notes, anim: true, flows: false, decor: 'light', districts: false, dashes: false, vb: `${BASE.x} ${BASE.y} ${BASE.w} ${BASE.h}` }),
    [placements, notes, st.mapLabels],
  );
  useEffect(() => { if (!active || hidden) setTip(null); }, [active, hidden]);
  const byId = useMemo(() => new Map(placements.map(p => [p.id, p])), [placements]);

  const svg = () => host.current?.querySelector('svg');

  function aspect() {
    const r = svg()?.getBoundingClientRect();
    return r && r.width ? r.height / r.width : BASE.h / BASE.w;
  }

  function write() {
    const v = vb.current, s = svg();
    if (!s) return;
    v.h = v.w * aspect();
    s.setAttribute('viewBox', `${v.x.toFixed(2)} ${v.y.toFixed(2)} ${v.w.toFixed(2)} ${v.h.toFixed(2)}`);
  }

  // keep where it is heading sensible: not too near or far, its centre over the board
  function settle() {
    const g = goal.current;
    const cx = g.x + g.w / 2, cy = g.y + g.h / 2;
    g.w = Math.min(MAX_W, Math.max(MIN_W, g.w));
    g.h = g.w * aspect();
    const ncx = Math.min(BASE.x + BASE.w, Math.max(BASE.x, cx)), ncy = Math.min(BASE.y + BASE.h, Math.max(BASE.y, cy));
    g.x = ncx - g.w / 2; g.y = ncy - g.h / 2;
  }

  // x, y and w ease at the same exponential rate, so the point under the pointer stays put
  function tick(now: number) {
    const a = anim.current, v = vb.current, g = goal.current;
    a.raf = 0;
    const dt = Math.min(0.05, Math.max(0, (now - a.last) / 1000));
    a.last = now;
    const k = 1 - Math.exp(-dt * a.rate);
    v.x += (g.x - v.x) * k; v.y += (g.y - v.y) * k; v.w += (g.w - v.w) * k;
    const done = Math.abs(g.x - v.x) + Math.abs(g.y - v.y) + Math.abs(g.w - v.w) < 0.15;
    if (done) { v.x = g.x; v.y = g.y; v.w = g.w; }
    write();
    if (!done) a.raf = requestAnimationFrame(tick);
  }

  function go(rate = ZOOM_RATE) {
    const a = anim.current;
    a.rate = rate;
    if (!opt.current.smoothMap) return jump();
    if (!a.raf) { a.last = performance.now(); a.raf = requestAnimationFrame(tick); }
  }

  function jump() {
    cancelAnimationFrame(anim.current.raf);
    anim.current.raf = 0;
    settle();
    Object.assign(vb.current, goal.current);
    write();
  }

  function fit(smooth = true) {
    const a = aspect(), g = goal.current;
    g.w = Math.max(BASE.w, BASE.h / a) * 0.98;
    g.h = g.w * a;
    g.x = BASE.x + BASE.w / 2 - g.w / 2;
    g.y = BASE.y + BASE.h / 2 - g.h / 2 + 30;
    if (smooth) { settle(); go(); } else jump();
  }

  function zoomAt(k: number, cx: number, cy: number) {
    const r = svg()?.getBoundingClientRect();
    if (!r?.width) return;
    const g = goal.current, fx = (cx - r.left) / r.width, fy = (cy - r.top) / r.height;
    const px = g.x + fx * g.w, py = g.y + fy * g.h;
    g.w = Math.min(MAX_W, Math.max(MIN_W, g.w * k));
    g.h = g.w * aspect();
    g.x = px - fx * g.w; g.y = py - fy * g.h;
    settle();
    go();
  }

  function zoomCenter(k: number) {
    const r = svg()?.getBoundingClientRect();
    if (r) zoomAt(k, r.left + r.width / 2, r.top + r.height / 2);
  }

  // a new map markup replaces the <svg>: carry the current view over
  useLayoutEffect(write, [markup]);

  api.current = {
    view: () => { const v = vb.current; return { cx: v.x + v.w / 2, cy: v.y + v.h / 2, w: v.w }; },
    setView: ({ cx, cy, w }) => { const g = goal.current; g.w = w; g.h = w * aspect(); g.x = cx - w / 2; g.y = cy - g.h / 2; jump(); },
  };

  // keeps the walking figure in the middle of the view; the walk is already smooth, so no easing
  function follow(sx: number, sy: number, k: number) {
    const g = goal.current, v = vb.current, mx = g.w * 0.3, my = g.h * 0.3;
    let tx = g.x, ty = g.y;
    if (sx < g.x + mx) tx = sx - mx; else if (sx > g.x + g.w - mx) tx = sx - g.w + mx;
    if (sy < g.y + my) ty = sy - my; else if (sy > g.y + g.h - my) ty = sy - g.h + my;
    if (tx === g.x && ty === g.y) return;
    const dx = (tx - g.x) * k, dy = (ty - g.y) * k;
    g.x += dx; g.y += dy;
    settle();
    if (anim.current.raf) { v.x += dx; v.y += dy; } else { v.x = g.x; v.y = g.y; write(); }
  }

  function screenOf(id: string) {
    const r = svg()?.querySelector(`.bld[data-id="${id}"]`)?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height * 0.62 } : { x: innerWidth / 2, y: innerHeight / 2 };
  }
  const avatar = useAvatar({ host, placements, markup, active, onEnter: id => onOpen(id, screenOf(id)), follow });
  useEffect(() => {
    const s = svg();
    s?.querySelectorAll('.bld.is-near').forEach(g => g.classList.remove('is-near'));
    if (avatar.near) s?.querySelector(`.bld[data-id="${avatar.near.id}"]`)?.classList.add('is-near');
  }, [avatar.near, markup]);

  useEffect(() => {
    fit(false);
    const el = host.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      setTip(null);
      // a trackpad pinch comes as ctrl + wheel in small steps; a mouse notch is ~100px
      const dy = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 800 : 1);
      const k = Math.exp(Math.max(-80, Math.min(80, dy)) * (e.ctrlKey ? 0.011 : 0.0016) * opt.current.zoomSpeed);
      zoomAt(k, e.clientX, e.clientY);
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      cancelAnimationFrame(anim.current.raf);
      anim.current.raf = 0;
      Object.assign(goal.current, vb.current);
      drag.current = { x: e.clientX, y: e.clientY, gx: vb.current.x, gy: vb.current.y, id: e.pointerId, moved: false, trail: [] };
    };
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      if (!d.moved) { d.moved = true; el.setPointerCapture(d.id); el.closest('.proto')?.classList.add('panning'); setTip(null); }
      const s = vb.current.w / (svg()?.getBoundingClientRect().width || 1), g = goal.current;
      g.x = d.gx - dx * s; g.y = d.gy - dy * s;
      settle();
      vb.current.x = g.x; vb.current.y = g.y;
      write();
      const now = performance.now();
      d.trail.push({ t: now, x: g.x, y: g.y });
      while (d.trail.length > 2 && now - d.trail[0].t > 90) d.trail.shift();
    };
    const up = () => {
      const d = drag.current;
      el.closest('.proto')?.classList.remove('panning');
      if (d?.moved && opt.current.smoothMap && d.trail.length > 1) {
        const a = d.trail[0], b = d.trail[d.trail.length - 1], dt = (b.t - a.t) / 1000;
        if (dt > 0.008 && performance.now() - b.t < 70) {
          const g = goal.current, sp = Math.hypot(b.x - a.x, b.y - a.y) / dt, cap = Math.min(1, 2400 / (sp || 1));
          const vx = (b.x - a.x) / dt * cap, vy = (b.y - a.y) / dt * cap;
          g.x += vx / GLIDE_RATE; g.y += vy / GLIDE_RATE;
          settle();
          go(GLIDE_RATE);
        }
      }
      setTimeout(() => { drag.current = null; });
    };
    const resize = () => { Object.assign(goal.current, vb.current); jump(); };
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('pointerdown', down);
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('resize', resize);
    return () => {
      cancelAnimationFrame(anim.current.raf);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('pointerdown', down);
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('resize', resize);
    };
  }, []);

  function onClick(e: React.MouseEvent) {
    const g = (e.target as Element).closest('[data-id]');
    if (g && !drag.current?.moved) {
      const id = g.getAttribute('data-id')!;
      avatar.goTo(id);
      onOpen(id, { x: e.clientX, y: e.clientY });
    }
  }

  function onMove(e: React.MouseEvent) {
    if (drag.current?.moved) return;
    const g = (e.target as Element).closest('[data-id]');
    const pl = g && byId.get(g.getAttribute('data-id')!);
    setTip(pl ? { x: Math.min(e.clientX + 16, innerWidth - 300), y: Math.min(e.clientY + 16, innerHeight - 150), pl } : null);
  }

  const b = tip && BUILDINGS[tip.pl.type];
  return (
    <>
      <section className={`p-world map-bg w-only${hidden ? ' is-hidden' : ''}`} ref={host} onClick={onClick} onMouseMove={onMove} onMouseLeave={() => setTip(null)}
        dangerouslySetInnerHTML={{ __html: markup }} />
      <div className={`zoom-ctl w-only${hidden ? ' is-hidden' : ''}`}>
        <button title={tr('放大')} onClick={() => zoomCenter(0.7)}>{tr('＋')}</button>
        <button title={tr('缩小')} onClick={() => zoomCenter(1.4)}>{tr('－')}</button>
        <button title={tr('看全图')} onClick={() => fit()}>⟲</button>
      </div>
      {tip && b && !hidden && (
        <div className="ptip pnl" style={{ left: tip.x, top: tip.y }}>
          <b>{tip.pl.name}</b><span>{where(b.district)}</span>
          <p>{b.rep}</p>
          <em>{tip.pl.live ? tr('{0} · 点击进入', tip.pl.tech) : tr('还没接入 · 点击查看计划')}</em>
        </div>
      )}
    </>
  );
}
