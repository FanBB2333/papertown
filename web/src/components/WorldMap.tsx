// The world map (layout A): the shared isometric SVG renderer, with drag to pan, wheel
// to zoom, a hover card per building, and a minimap that jumps on click. Kept quiet on
// purpose: no goods flows, few trees, and the core buildings highlighted.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BUILDINGS, DISTRICTS } from '@design/sprites.js';
import { renderMap } from '@design/world.js';
import type { Placement } from '../api';

const BASE = { x: -790, y: -150, w: 1580, h: 950 };
const MIN_W = 420, MAX_W = BASE.w * 1.5;

interface Props {
  placements: Placement[];
  highlight: string | null;
  notes: Record<string, string>;
  onOpen: (id: string) => void;
}

export function WorldMap({ placements, highlight, notes, onOpen }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const mini = useRef<HTMLDivElement>(null);
  const vb = useRef({ ...BASE });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; id: number; moved: boolean } | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; pl: Placement } | null>(null);

  const markup = useMemo(
    () => renderMap({ placements, labels: 'key', highlight, notes, anim: true, flows: false, decor: 'light', vb: `${BASE.x} ${BASE.y} ${BASE.w} ${BASE.h}` }),
    [placements, highlight, notes],
  );
  const miniMarkup = useMemo(
    () => renderMap({ placements, objects: false, flows: false, districts: false, anim: false, labels: 'none' })
      .replace('</svg>', '<rect class="mm-rect"/></svg>'),
    [placements],
  );
  const byId = useMemo(() => new Map(placements.map(p => [p.id, p])), [placements]);

  const svg = () => host.current?.querySelector('svg') ?? null;

  function aspect() {
    const r = svg()?.getBoundingClientRect();
    return r && r.width ? r.height / r.width : BASE.h / BASE.w;
  }

  function apply() {
    const v = vb.current, s = svg();
    if (!s) return;
    const cx = v.x + v.w / 2, cy = v.y + v.h / 2;
    v.w = Math.min(MAX_W, Math.max(MIN_W, v.w));
    v.h = v.w * aspect();
    // keep the centre over the board
    const ncx = Math.min(BASE.x + BASE.w, Math.max(BASE.x, cx)), ncy = Math.min(BASE.y + BASE.h, Math.max(BASE.y, cy));
    v.x = ncx - v.w / 2; v.y = ncy - v.h / 2;
    s.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
    const r = mini.current?.querySelector('.mm-rect');
    if (r) for (const [k, val] of Object.entries({ x: v.x, y: v.y, width: v.w, height: v.h })) r.setAttribute(k, String(val));
  }

  function fit() {
    const a = aspect(), v = vb.current;
    v.w = Math.max(BASE.w, BASE.h / a) * 0.98;
    v.h = v.w * a;
    v.x = BASE.x + BASE.w / 2 - v.w / 2;
    v.y = BASE.y + BASE.h / 2 - v.h / 2 + 30;
    apply();
  }

  function toSvg(el: SVGSVGElement, cx: number, cy: number) {
    const p = el.createSVGPoint();
    p.x = cx; p.y = cy;
    return p.matrixTransform(el.getScreenCTM()!.inverse());
  }

  function zoomAt(k: number, cx: number, cy: number) {
    const s = svg();
    if (!s) return;
    const v = vb.current, before = toSvg(s, cx, cy);
    const nw = Math.min(MAX_W, Math.max(MIN_W, v.w * k)), f = nw / v.w;
    v.x = before.x - (before.x - v.x) * f;
    v.y = before.y - (before.y - v.y) * f;
    v.w = nw;
    apply();
  }

  function zoomCenter(k: number) {
    const r = svg()?.getBoundingClientRect();
    if (r) zoomAt(k, r.left + r.width / 2, r.top + r.height / 2);
  }

  // a new map markup replaces the <svg>: carry the current view over
  useLayoutEffect(apply, [markup, miniMarkup]);

  useEffect(() => {
    fit();
    const el = host.current!;
    const wheel = (e: WheelEvent) => { e.preventDefault(); zoomAt(Math.exp(e.deltaY * 0.0015), e.clientX, e.clientY); };
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      drag.current = { x: e.clientX, y: e.clientY, vx: vb.current.x, vy: vb.current.y, id: e.pointerId, moved: false };
    };
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      if (!d.moved) { d.moved = true; el.setPointerCapture(d.id); el.closest('.proto')?.classList.add('panning'); setTip(null); }
      const s = vb.current.w / (svg()?.getBoundingClientRect().width || 1);
      vb.current.x = d.vx - dx * s; vb.current.y = d.vy - dy * s;
      apply();
    };
    const up = () => {
      el.closest('.proto')?.classList.remove('panning');
      setTimeout(() => { drag.current = null; });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('pointerdown', down);
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('resize', apply);
    return () => {
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('pointerdown', down);
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('resize', apply);
    };
  }, []);

  function onClick(e: React.MouseEvent) {
    const g = (e.target as Element).closest('[data-id]');
    if (g && !drag.current?.moved) onOpen(g.getAttribute('data-id')!);
  }

  function onMove(e: React.MouseEvent) {
    if (drag.current?.moved) return;
    const g = (e.target as Element).closest('[data-id]');
    const pl = g && byId.get(g.getAttribute('data-id')!);
    setTip(pl ? { x: Math.min(e.clientX + 16, innerWidth - 300), y: Math.min(e.clientY + 16, innerHeight - 150), pl } : null);
  }

  function onMini(e: React.MouseEvent) {
    const s = mini.current?.querySelector('svg');
    if (!s) return;
    const p = toSvg(s, e.clientX, e.clientY);
    vb.current.x = p.x - vb.current.w / 2; vb.current.y = p.y - vb.current.h / 2;
    apply();
  }

  const b = tip && BUILDINGS[tip.pl.type];
  return (
    <>
      <section className="p-world map-bg w-only" ref={host} onClick={onClick} onMouseMove={onMove} onMouseLeave={() => setTip(null)}
        dangerouslySetInnerHTML={{ __html: markup }} />
      <div className="minimap pnl w-only">
        <div ref={mini} onClick={onMini} style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: miniMarkup }} />
        <div className="mm-zoom">
          <button title="放大" onClick={() => zoomCenter(0.7)}>＋</button>
          <button title="缩小" onClick={() => zoomCenter(1.4)}>－</button>
          <button title="复位" onClick={fit}>⟲</button>
        </div>
      </div>
      {tip && b && (
        <div className="ptip pnl" style={{ left: tip.x, top: tip.y }}>
          <b>{tip.pl.name}</b><span>{DISTRICTS[b.district]?.name}</span>
          <p>{b.rep}</p>
          <em>{tip.pl.live ? `${tip.pl.tech} · 点击查看流水线` : '还没接入 · 点击查看计划'}</em>
        </div>
      )}
    </>
  );
}
