// The console's charts: a pointer tooltip, job-state marks, a GPU timeline of jobs, bars for one
// measure across rows, a thin meter, and a card's last hour as a sparkline.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { tr } from '../i18n';
import { clip } from './util';

export interface TipRow { v: string; k: string; key?: string }
export interface TipData { x: number; y: number; title: string; rows: TipRow[]; foot?: string }

export function useTip() {
  const [tip, setTip] = useState<TipData | null>(null);
  return {
    tip,
    show: (e: { clientX: number; clientY: number }, d: Omit<TipData, 'x' | 'y'>) => setTip({ x: e.clientX, y: e.clientY, ...d }),
    hide: () => setTip(null),
  };
}

// Portalled into the themed root, not the body: the body carries none of the page's colours.
export function Tip({ tip }: { tip: TipData | null }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!tip || !box.current) { setPos(null); return; }
    const r = box.current.getBoundingClientRect();
    const left = tip.x + 14 + r.width > innerWidth - 8 ? tip.x - 14 - r.width : tip.x + 14;
    const top = Math.min(innerHeight - r.height - 8, Math.max(8, tip.y - r.height / 2));
    setPos({ left, top });
  }, [tip]);
  if (!tip) return null;
  return createPortal(
    <div className="ctip" ref={box} style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 }}>
      <b className="ctip-t">{tip.title}</b>
      {tip.rows.map((r, i) => (
        <div key={i} className="ctip-r">{r.key && <i style={{ background: r.key }} />}<strong>{r.v}</strong><span>{r.k}</span></div>
      ))}
      {tip.foot && <p className="ctip-f">{tip.foot}</p>}
    </div>,
    document.querySelector('.theme-sketch') ?? document.body,
  );
}

export type St = 'running' | 'queued' | 'done' | 'failed' | 'cancelled';
// colour, sign and word per state (colours validated as CVD-safe)
export const ST: Record<St, { c: string; sign: string; label: string; hollow?: boolean }> = {
  running: { c: '#d0743a', sign: '▶', label: tr('运行中') },
  done: { c: '#3a76b0', sign: '✓', label: tr('完成') },
  failed: { c: '#a8325e', sign: '✕', label: tr('失败') },
  queued: { c: '#a3927b', sign: '◷', label: tr('排队'), hollow: true },
  cancelled: { c: '#a3927b', sign: '⊘', label: tr('已取消'), hollow: true },
};
export const stOf = (s: string | null | undefined): St =>
  s === 'running' ? 'running' : s === 'pending' || s === 'queued' ? 'queued' : s === 'completed' || s === 'done' ? 'done'
    : s === 'cancelled' ? 'cancelled' : 'failed';

export function StateTag({ s }: { s: St }) {
  return <span className={`stag s-${s}`}><i style={{ ['--c' as string]: ST[s].c }}>{ST[s].sign}</i>{ST[s].label}</span>;
}

export function Legend({ states }: { states: St[] }) {
  return (
    <div className="clegend">
      {states.map(s => <span key={s}><i className={ST[s].hollow ? 'hollow' : ''} style={{ ['--c' as string]: ST[s].c }} />{ST[s].sign} {ST[s].label}</span>)}
    </div>
  );
}

const H = 3600e3, D = 24 * H;
const STEPS = [H, 2 * H, 3 * H, 6 * H, 12 * H, D, 2 * D, 7 * D, 14 * D, 30 * D];
const pad = (n: number) => String(n).padStart(2, '0');
export const when = (t: number, withDay = true) => {
  const d = new Date(t);
  return `${withDay ? `${d.getMonth() + 1}/${d.getDate()} ` : ''}${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// about n round local times across the span
function timeTicks(t0: number, t1: number, n: number) {
  const step = STEPS.find(s => (t1 - t0) / s <= n) ?? STEPS[STEPS.length - 1];
  const a = new Date(t0);
  if (step >= D) a.setHours(0, 0, 0, 0); else a.setMinutes(0, 0, 0);
  let t = a.getTime();
  if (step < D) while (new Date(t).getHours() % (step / H)) t += H;
  const out: { t: number; label: string }[] = [];
  for (; t <= t1; t += step) {
    if (t < t0) continue;
    const d = new Date(t);
    out.push({ t, label: step >= D || (d.getHours() === 0) ? `${d.getMonth() + 1}/${d.getDate()}` : `${pad(d.getHours())}:00` });
  }
  return out;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export interface GJob { id: string; name: string; st: St; row: string; start: number; end: number | null; tip: TipRow[] }

const LABEL = 144, TRACK = 18, GAP = 4, AXIS = 22;

// each job a bar from start to end, one band per GPU; drag to zoom, double-click to reset
export function Gantt({ jobs, domain, onZoom, onPick, now }: {
  jobs: GJob[]; domain: [number, number]; onZoom: (d: [number, number] | null) => void; onPick: (id: string) => void; now: number;
}) {
  const [box, width] = useWidth<HTMLDivElement>();
  const { tip, show, hide } = useTip();
  const [brush, setBrush] = useState<[number, number] | null>(null);
  const [d0, d1] = domain;
  const plot = Math.max(120, width - LABEL - 12);
  const x = (t: number) => LABEL + ((t - d0) / (d1 - d0)) * plot;
  const tAt = (px: number) => d0 + ((px - LABEL) / plot) * (d1 - d0);

  const bands = useMemo(() => {
    const by = new Map<string, GJob[]>();
    for (const j of jobs) {
      const e = j.end ?? now;
      if (e < d0 || j.start > d1) continue;
      by.set(j.row, [...(by.get(j.row) ?? []), j]);
    }
    let y = 0;
    return [...by.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([row, js]) => {
      const ends: number[] = [];
      const placed = js.sort((a, b) => a.start - b.start).map(j => {
        let k = ends.findIndex(e => e <= j.start);
        if (k < 0) { k = ends.length; ends.push(0); }
        ends[k] = j.end ?? now;
        return { j, k };
      });
      const h = ends.length * (TRACK + GAP) + GAP * 2;
      const band = { row, y, h, placed };
      y += h;
      return band;
    });
  }, [jobs, d0, d1, now]);
  const height = (bands.at(-1)?.y ?? 0) + (bands.at(-1)?.h ?? 0);
  const ticks = timeTicks(d0, d1, Math.max(3, Math.floor(plot / 110)));

  function down(e: React.PointerEvent<SVGRectElement>) {
    const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const a = e.clientX - r.left;
    setBrush([a, a]);
    const move = (ev: PointerEvent) => setBrush([a, Math.max(LABEL, Math.min(LABEL + plot, ev.clientX - r.left))]);
    const up = (ev: PointerEvent) => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      const b = Math.max(LABEL, Math.min(LABEL + plot, ev.clientX - r.left));
      setBrush(null);
      if (Math.abs(b - a) > 6) onZoom([tAt(Math.min(a, b)), tAt(Math.max(a, b))]);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  return (
    <div className="gantt" ref={box}>
      {width > 0 && (
        <svg width={width} height={height + AXIS} onDoubleClick={() => onZoom(null)} role="img" aria-label={tr('任务时间线')}>
          {bands.map((b, i) => (
            <g key={b.row} transform={`translate(0 ${b.y})`}>
              {i % 2 === 1 && <rect className="g-band" x={0} y={0} width={width} height={b.h} />}
              {i > 0 && <line className="g-sep" x1={0} x2={width} y1={0} y2={0} />}
              <text className="g-row" x={8} y={b.h / 2} dominantBaseline="middle">{rowLabel(b.row)}</text>
            </g>
          ))}
          {ticks.map(t => <line key={t.t} className="g-grid" x1={x(t.t)} x2={x(t.t)} y1={0} y2={height} />)}
          <rect className="g-hit" x={LABEL} y={0} width={plot} height={height} onPointerDown={down} />
          {bands.map(b => b.placed.map(({ j, k }) => {
            const a = Math.max(x(j.start), LABEL), e = Math.min(x(j.end ?? now), LABEL + plot);
            const w = Math.max(3, e - a);
            const s = ST[j.st];
            return (
              <g key={j.id} className={`g-bar s-${j.st}`} transform={`translate(${a} ${b.y + GAP + k * (TRACK + GAP)})`}
                data-ref={`job:${j.id}`} data-ref-label={`${tr('任务')} ${j.name}`}
                onPointerMove={ev => show(ev, { title: j.name, rows: j.tip, foot: tr('点击查看详情') })} onPointerLeave={hide}
                onClick={() => onPick(j.id)} tabIndex={0} onKeyDown={ev => { if (ev.key === 'Enter') onPick(j.id); }}>
                <rect className="g-pad" x={-3} y={-2} width={w + 6} height={TRACK + 4} />
                <rect width={w} height={TRACK} rx={4} style={s.hollow ? { fill: 'var(--panel)', stroke: s.c } : { fill: s.c }} />
                {j.st === 'running' && <rect className="g-run" width={w} height={TRACK} rx={4} />}
                {w > 46 && <text x={6} y={TRACK / 2 + 1} dominantBaseline="middle" className={s.hollow ? 'dark' : ''}>{s.sign} {clip(j.name, (w - 18) / 6.4)}</text>}
              </g>
            );
          }))}
          {now >= d0 && now <= d1 && <g className="g-now"><line x1={x(now)} x2={x(now)} y1={0} y2={height} /><text x={x(now)} y={height + 15} textAnchor="middle">{tr('现在')}</text></g>}
          {ticks.map(t => <text key={t.t} className="g-tick" x={x(t.t)} y={height + 15} textAnchor="middle">{Math.abs(x(t.t) - x(now)) > 28 ? t.label : ''}</text>)}
          {brush && <rect className="g-brush" x={Math.min(...brush)} y={0} width={Math.abs(brush[1] - brush[0])} height={height} />}
        </svg>
      )}
      <Tip tip={tip} />
    </div>
  );
}

// "node · GPU 3": the card in ink, its machine quieter before it
function rowLabel(row: string) {
  const i = row.lastIndexOf(' · ');
  if (i < 0) return <tspan className="g-gpu">{clip(row, 18)}</tspan>;
  return <><tspan className="g-node">{clip(row.slice(0, i), 14)} </tspan><tspan className="g-gpu">{row.slice(i + 3)}</tspan></>;
}

export interface Bar { id: string; label: string; v: number; hi?: boolean; benchmark?: boolean; sub?: string }

// Bars from zero; values close together far from zero become dots on an axis that does not start at zero.
export function Bars({ bars, onPick }: { bars: Bar[]; onPick?: (id: string) => void }) {
  const { tip, show, hide } = useTip();
  const vs = bars.map(b => b.v);
  const lo = Math.min(...vs), hi = Math.max(...vs);
  const dots = bars.length > 2 && lo > 0 && hi > lo && (hi - lo) / hi < 0.25;
  const pad = (hi - lo) * 0.08, a = lo - pad, z = hi + pad;
  const top = Math.max(...vs.map(Math.abs), 1e-12);
  return (
    <div className={`hbars${dots ? ' dots' : ''}`}>
      {dots && <div className="hb hb-axis"><span /><span className="hb-ax"><em>{fmtNum(a)}</em><em>{fmtNum(z)}</em></span><span className="hb-v muted">{tr('横轴不从 0 开始')}</span></div>}
      {bars.map((b, i) => (
        <button key={b.id} className={`hb${b.hi ? ' hi' : ''}${onPick ? ' pick' : ''}`} style={{ ['--i' as string]: Math.min(i, 14) }}
          onClick={() => onPick?.(b.id)} onPointerMove={e => show(e, { title: b.label, rows: [{ v: fmtNum(b.v), k: b.sub ?? '' }] })} onPointerLeave={hide}>
          <span className="hb-l" title={b.label}>{b.label}</span>
          <span className="hb-track">{dots ? <i className="hb-dot" style={{ ['--x' as string]: (b.v - a) / (z - a) }} /> : <i style={{ ['--v' as string]: Math.max(0, Math.abs(b.v) / top) }} />}</span>
          <span className={b.hi || b.benchmark ? 'hb-v em-num' : 'hb-v'}>{fmtNum(b.v)}</span>
        </button>
      ))}
      <Tip tip={tip} />
    </div>
  );
}

export function fmtNum(v: number) {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v)) return Math.abs(v) >= 10000 ? v.toLocaleString() : String(v);
  const a = Math.abs(v);
  return a >= 100 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

export function Meter({ parts, total, label }: { parts: { v: number; c: string; name: string }[]; total: number; label: string }) {
  const { tip, show, hide } = useTip();
  return (
    <span className="meter" onPointerMove={e => show(e, { title: label, rows: parts.map(p => ({ v: `${(p.v / 1024).toFixed(1)}G`, k: p.name, key: p.c })) })} onPointerLeave={hide}>
      {parts.filter(p => p.v > 0).map(p => <i key={p.name} style={{ width: `${(100 * p.v) / Math.max(total, 1)}%`, background: p.c }} />)}
      <Tip tip={tip} />
    </span>
  );
}

export const SPARK = { util: '#c2663f', mem: '#6c5fb0' }; // validated as a pair, CVD-safe, on the panel

export function Spark({ pts, total, now, label, span = 3600 }: {
  pts: [number, number, number][]; total: number; now: number; label: string; span?: number;
}) {
  const [box, w] = useWidth<HTMLDivElement>();
  const { tip, show, hide } = useTip();
  const [at, setAt] = useState<number | null>(null);
  const h = 26, t1 = now / 1000, t0 = t1 - span;
  const ps = pts.filter(p => p[0] >= t0 - 120);
  const x = (t: number) => Math.max(0, ((t - t0) / span) * w);
  const y = (pct: number) => h - 1 - (Math.max(0, Math.min(100, pct)) / 100) * (h - 3);
  const mem = (p: [number, number, number]) => (100 * p[2]) / Math.max(1, total);
  // a gap of more than five minutes breaks the line
  const segs: [number, number, number][][] = [];
  for (const p of ps) { const s = segs.at(-1); if (s && p[0] - s[s.length - 1][0] <= 300) s.push(p); else segs.push([p]); }
  const path = (s: [number, number, number][], v: (p: [number, number, number]) => number) => s.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)} ${y(v(p)).toFixed(1)}`).join('');
  const area = (s: [number, number, number][]) => `${path(s, mem)}L${x(s[s.length - 1][0]).toFixed(1)} ${h}L${x(s[0][0]).toFixed(1)} ${h}Z`;
  const pick = (e: React.PointerEvent) => {
    if (!ps.length || !box.current) return;
    const t = t0 + ((e.clientX - box.current.getBoundingClientRect().left) / w) * span;
    let i = 0;
    for (let k = 1; k < ps.length; k++) if (Math.abs(ps[k][0] - t) < Math.abs(ps[i][0] - t)) i = k;
    setAt(i);
    const p = ps[i];
    show(e, { title: `${label} · ${when(p[0] * 1000, false)}`, rows: [
      { v: `${p[1]}%`, k: tr('利用率'), key: SPARK.util },
      { v: `${(p[2] / 1024).toFixed(1)}G · ${Math.round(mem(p))}%`, k: tr('显存占用'), key: SPARK.mem },
    ] });
  };
  return (
    <div className={`spark${ps.length < 2 ? ' empty' : ''}`} ref={box} onPointerMove={pick} onPointerLeave={() => { setAt(null); hide(); }}>
      {ps.length < 2 ? <span>{tr('刚开始记录，稍后将显示曲线')}</span> : w > 0 && (
        <svg width={w} height={h} role="img" aria-label={tr('{0} 近一小时的利用率和显存', label)}>
          <line className="sp-base" x1={0} x2={w} y1={h - 0.5} y2={h - 0.5} />
          {segs.map((s, i) => <path key={`a${i}`} className="sp-area" d={area(s)} />)}
          {segs.map((s, i) => <path key={`m${i}`} className="sp-mem" d={path(s, mem)} />)}
          {segs.map((s, i) => <path key={`u${i}`} className="sp-util" d={path(s, p => p[1])} />)}
          {at != null && ps[at] && <g className="sp-at">
            <line x1={x(ps[at][0])} x2={x(ps[at][0])} y1={0} y2={h} />
            <circle cx={x(ps[at][0])} cy={y(ps[at][1])} r={2.5} />
          </g>}
        </svg>
      )}
      <Tip tip={tip} />
    </div>
  );
}

// the current time, re-read every `every` ms while mounted
export function useNow(every = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), every); return () => clearInterval(i); }, [every]);
  return now;
}
