// A project's research loop (研究回路), as its page in 进展 shows it: how far along the loop is, which gate holds
// it and which round of rework it is in, and what the hard and the soft checks found. Above, the loop on three
// tracks: the sentinels, the spine of stages and gates, the loops back that are under way; below, the hard checks
// before → after and the sentinels' verdicts, which is the report. Anything on it opens the full loop (Canvas.tsx)
// at that node.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, listen, type CanvasNode, type CanvasView, type Check, type ProjectCard } from '../api';
import { Icon } from '../console/icons';
import { ago } from '../console/util';
import { tr, trx } from '../i18n';
import { follow, go, href } from '../route';
import { status } from './Checks';
import { bad, drop, gateChecks, gateLook, GATE_ST, level, loopPath, over, trail, VERDICT } from './loop';
import './canvas.css';

export function useCanvas(lineId: string) {
  const [v, setV] = useState<CanvasView | null>(null);
  const [bump, setBump] = useState(0);
  useEffect(() => listen(e => {
    const x = e as { type: string; line_id?: string; line?: { id: string }; agent?: { line_id?: string | null } };
    if (((x.type === 'canvas' || x.type === 'checks') && x.line_id === lineId) || (x.type === 'line' && x.line?.id === lineId)
      || (x.type === 'agent' && x.agent?.line_id === lineId)) setBump(b => b + 1);
  }), [lineId]);
  useEffect(() => {
    let alive = true;
    api.canvas(lineId).then(x => alive && setV(x)).catch(() => {});
    return () => { alive = false; };
  }, [lineId, bump]);
  return [v, setV, useCallback(() => setBump(b => b + 1), [])] as const;
}

// how big each kind of node is drawn: where new nodes go beside it, and the lanes' width
export const SIZE: Record<CanvasNode['kind'], [number, number]> = {
  stage: [230, 92], gate: [250, 96], hard: [210, 76], soft: [290, 96], spec: [270, 92], clamp: [270, 92], human: [300, 104],
  task: [290, 108], note: [200, 80], info: [250, 130],
};

// a node the loop should open at once, when it is opened from elsewhere (this card, the assistant)
export const wanted: { node: string | null } = { node: null };
export function openAt(seq: number, node?: string) {
  wanted.node = node ?? null;
  go(loopPath(seq));
}

// the counts across the top: hard gates, sentinels, the rounds
export function LoopSummary({ v, short }: { v: CanvasView; short?: boolean }) {
  const h = v.summary.hard, s = v.summary.soft;
  const blocking = v.checks.filter(c => c.kind === 'hard' && level(c) === 'block').length;
  const f = v.found;
  return (
    <span className="cg-sum">
      <span><i className="cv-dia" />{tr('硬卡口')} <b>{h.pass}/{h.total - h.none}</b>{blocking > 0 && <em className="bad-t">{tr('{0} 阻断', blocking)}</em>}
        {!short && f.first != null && f.now != null && f.first > f.now && <em className="muted">{tr('违规 {0}→{1} 处 ↓{2}%', f.first, f.now, drop(f.first, f.now))}</em>}</span>
      <span><i className="cv-ring2" />{tr('软巡检')} <b>{s.pass}/{s.total}</b>{s.warn + s.fail > 0 && <em className="warn-t">{tr('{0} 预警', s.warn + s.fail)}</em>}</span>
    </span>
  );
}

// the violations after each round that changed something
export function Spark({ v }: { v: CanvasView }) {
  const pts = trail(v);
  if (pts.length < 2) return null;
  const W = 96, H = 26, top = Math.max(...pts, 1);
  const x = (i: number) => 4 + (i * (W - 8)) / (pts.length - 1), y = (n: number) => H - 4 - (n / top) * (H - 8);
  return (
    <span className={`lp-spark${pts[pts.length - 1] > pts[0] ? ' up' : ''}`}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={tr('违规收敛：{0}', pts.join(' → '))}>
        <polyline points={pts.map((p, i) => `${x(i)},${y(p)}`).join(' ')} />
        {pts.map((p, i) => <circle key={i} cx={x(i)} cy={y(p)} r={i === pts.length - 1 ? 3 : 2} className={i === 0 ? 'a' : i === pts.length - 1 ? 'z' : ''} />)}
      </svg>
      <b>{pts.join(' → ')}</b>
    </span>
  );
}

// where the loop is: the round, and what it is busy with
function phase(v: CanvasView) {
  const gates = v.nodes.filter(n => n.kind === 'gate' && n.gate).map(n => n.gate!);
  const healing = v.nodes.find(n => n.kind === 'task' && n.loop === 'hard' && !n.converged && n.status !== 'done' && !n.escalated);
  const human = v.nodes.find(n => n.kind === 'human')?.items?.length ?? 0;
  if (healing) return tr('{0}自愈中', gates.find(g => g.stage === healing.stage)?.name ?? '');
  const held = gates.find(g => gateLook(g) === 'block');
  if (held) return tr('{0}卡口阻断', held.name);
  if (human) return tr('{0} 件等你拍板', human);
  if (gates.length && gates.every(g => ['pass', 'off', 'none'].includes(gateLook(g)))) return tr('卡口全部放行');
  return tr('巡检中');
}

// the spine, small: done stages run together, each gate a box of its own
type Box = { id: string; kind: 'stage' | 'gate'; nodes: CanvasNode[] };
function boxes(v: CanvasView): Box[] {
  const keys = ['idea', 'hatch', 'team', 'method', 'exp', 'write', 'review', 'ship'];
  const by = new Map(v.nodes.map(n => [n.id, n]));
  const watched = new Set(v.edges.filter(e => e.kind === 'watch').map(e => e.target));
  const out: Box[] = [];
  for (const k of keys) {
    const s = by.get(`stage:${k}`), g = by.get(`gate:${k}`);
    if (s) {
      const last = out[out.length - 1];
      const join = last?.kind === 'stage' && s.status === 'done' && last.nodes.every(x => x.status === 'done') && !watched.has(s.id) && !last.nodes.some(x => watched.has(x.id));
      if (join) last.nodes.push(s); else out.push({ id: s.id, kind: 'stage', nodes: [s] });
    }
    if (g) out.push({ id: g.id, kind: 'gate', nodes: [g] });
  }
  return out;
}

function SpineBox({ b, v, r }: { b: Box; v: CanvasView; r: ProjectCard }) {
  const n = b.nodes[0], seq = v.seq;
  if (b.kind === 'gate') {
    const g = n.gate!, cs = gateChecks(v, g), look = gateLook(g), one = cs.length === 1 ? cs[0] : null;
    return (
      <button className={`lp-gate g-${look}`} data-box={b.id} onClick={() => openAt(seq, n.id)} title={`${g.name} · ${GATE_ST[look]}`}>
        <b><i className="cv-dia" />{one ? trx(one.title) : tr('{0}卡口', g.name)}</b>
        <small>{look === 'block' && !g.waived && <Icon n="lock" size={10} />}{one ? (one.last?.value != null ? `${one.last.value} / ≤${one.max ?? 0}` : GATE_ST[look])
          : g.now && look !== 'pass' ? tr('{0}/{1}（剩 {2} 处）', g.pass, g.total, g.now) : `${g.pass}/${g.total} ${look === 'pass' ? '✓' : ''}`}</small>
      </button>
    );
  }
  const num = (x: CanvasNode) => String(['idea', 'hatch', 'team', 'method', 'exp', 'write', 'review', 'ship'].indexOf(x.ref ?? '') + 1).padStart(2, '0');
  const last = b.nodes[b.nodes.length - 1], st = n.status ?? 'todo';
  const name = b.nodes.length === 1 ? n.title : b.nodes.length === 2 ? `${n.title} › ${last.title}` : `${n.title} … ${last.title}`;
  const sub = b.nodes.length > 1 ? tr('已完成') : n.locked ? tr('卡口阻断中') : st === 'run' ? tr('进行中 {0}%', n.pct ?? 0)
    : st === 'wait' ? tr('等你') : st === 'done' ? (n.ref === 'exp' && r.jobs.done ? tr('{0} 完成', r.jobs.done) : tr('完成')) : tr('待开始');
  return (
    <button className={`lp-st st-${n.locked ? 'locked' : b.nodes.length > 1 ? 'done' : st}`} data-box={b.id} onClick={() => openAt(seq, n.id)}>
      <b><em>{b.nodes.length > 1 ? `${num(n)}–${num(last)}` : num(n)}</em>{name}</b>
      <small>{sub}</small>
    </button>
  );
}

// the lines between the tracks, drawn once the boxes have their places
interface Link { from: string; to: string; cls: string; up?: boolean }
function useLinks(box: React.RefObject<HTMLDivElement | null>, links: Link[]) {
  const [paths, setPaths] = useState<{ d: string; cls: string }[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const key = JSON.stringify(links);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const draw = () => {
      const o = el.getBoundingClientRect();
      const at = (id: string) => el.querySelector<HTMLElement>(`[data-box="${CSS.escape(id)}"]`)?.getBoundingClientRect();
      const out: { d: string; cls: string }[] = [];
      for (const l of links) {
        const a = at(l.from), b = at(l.to);
        if (!a || !b) continue;
        const x1 = a.left + a.width / 2 - o.left + el.scrollLeft, x2 = b.left + b.width / 2 - o.left + el.scrollLeft;
        const [y1, y2] = l.up ? [a.top - o.top, b.bottom - o.top + 5] : [a.bottom - o.top, b.top - o.top - 5];
        const m = (y1 + y2) / 2;
        out.push({ d: `M${x1},${y1} C${x1},${m} ${x2},${m} ${x2},${y2}`, cls: l.cls });
      }
      setPaths(out);
      setSize({ w: el.scrollWidth, h: el.scrollHeight });
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(el);
    return () => ro.disconnect();
  }, [box, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return { paths, size };
}

function Track({ v, r }: { v: CanvasView; r: ProjectCard }) {
  const box = useRef<HTMLDivElement>(null);
  const [hot, setHot] = useState<string | null>(null);
  const spine = useMemo(() => boxes(v), [v]);
  const where = useMemo(() => new Map(spine.flatMap(b => b.nodes.map(n => [n.id, b.id] as const))), [spine]);
  const sentinels = v.nodes.filter(n => n.kind === 'soft' && n.check?.on);
  const watch = (id: string) => v.edges.find(e => e.kind === 'watch' && e.source === id)?.target;
  const loops = v.nodes.filter(n => n.kind === 'task' && n.loop && !n.converged && n.status !== 'done');
  const human = v.nodes.find(n => n.kind === 'human');
  const links: Link[] = [];
  for (const s of sentinels) {
    const t = watch(s.id);
    const k = status(s.check!);
    if (t && where.has(t) && (hot === s.id || k === 'warn' || k === 'fail')) links.push({ from: s.id, to: where.get(t)!, cls: `w-watch v-${k}` });
  }
  for (const t of loops) {
    if (t.loop === 'hard' && t.stage) {
      links.push({ from: `gate:${t.stage}`, to: t.id, cls: 'w-hard' });
      if (where.has(`stage:${t.stage}`)) links.push({ from: t.id, to: where.get(`stage:${t.stage}`)!, cls: 'w-hard', up: true });
    } else {
      const target = v.edges.find(e => e.kind === 'soft_loop' && e.source === t.id)?.target;
      if (target && where.has(target)) links.push({ from: t.id, to: where.get(target)!, cls: 'w-soft', up: true });
    }
  }
  const { paths, size } = useLinks(box, links);
  return (
    <div className="lp-track" ref={box}>
      <svg className="lp-wires" width={size.w} height={size.h} aria-hidden>
        <defs>
          {['watch', 'hard', 'soft'].map(k => (
            <marker key={k} id={`lp-a-${k}`} viewBox="0 0 10 10" refX="7" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" className={`lp-head h-${k}`} /></marker>
          ))}
        </defs>
        {paths.map((p, i) => <path key={i} d={p.d} className={p.cls} markerEnd={`url(#lp-a-${p.cls.split(' ')[0].slice(2)})`} />)}
      </svg>
      <div className="lp-row lp-soft">
        <span className="lp-lane">SOFT {tr('软巡检')}</span>
        {sentinels.map(s => {
          const c = s.check!, k = status(c);
          return (
            <button key={s.id} className={`lp-sen v-${k}`} data-box={s.id} onClick={() => openAt(v.seq, s.id)} title={c.last?.note || trx(c.text)}
              onMouseEnter={() => setHot(s.id)} onMouseLeave={() => setHot(null)} onFocus={() => setHot(s.id)} onBlur={() => setHot(null)}>
              <i className="cv-ring2" />{trx(c.title)}<em>{VERDICT[k]}{k === 'pass' ? ' ✓' : k === 'warn' || k === 'fail' ? ' !' : ''}</em>
            </button>
          );
        })}
        {!sentinels.length && <span className="muted small">{tr('没有开着的软巡检')}</span>}
      </div>
      <div className="lp-row lp-spine">
        <span className="lp-lane">SPINE {tr('主干')}</span>
        {spine.map((b, i) => (
          <span key={b.id} className="lp-step">
            {i > 0 && <i className={`lp-arrow${b.kind === 'stage' && b.nodes[0].locked ? ' lock' : ''}`} aria-hidden />}
            <SpineBox b={b} v={v} r={r} />
          </span>
        ))}
      </div>
      <div className="lp-row lp-loop">
        <span className="lp-lane">LOOP {tr('回路')}</span>
        {loops.map(t => (
          <button key={t.id} className={`lp-tk l-${t.loop}${t.escalated ? ' esc' : ''}`} data-box={t.id} onClick={() => openAt(v.seq, t.id)} title={t.title}>
            <Icon n={t.loop === 'hard' ? 'refresh' : 'spark'} size={12} />
            {t.loop === 'hard' ? tr('硬卡口打回重修 · 第 {0} 轮（{1}）', t.round || 1, t.id) : tr('软纠偏：{0}（{1}）', t.title ?? '', t.id)}
            {t.escalated && <em>{tr('等你拍板')}</em>}
          </button>
        ))}
        {human?.items?.length ? (
          <button className="lp-tk l-human" data-box={human.id} onClick={() => openAt(v.seq, human.id)}><Icon n="person" size={12} />{tr('人类拍板 · {0} 件待定', human.items.length)}</button>
        ) : null}
        {!loops.length && !human?.items?.length && <span className="muted small">{tr('没有在打回或纠偏的事')}</span>}
      </div>
    </div>
  );
}

// the report: the hard checks before → after, the sentinels' word
function HardReport({ v }: { v: CanvasView }) {
  const gates = v.nodes.filter(n => n.kind === 'gate' && n.gate).map(n => n.gate!);
  const ticketOf = (c: Check) => gates.find(g => g.stage === c.stage && g.ticket && g.ticket_status !== 'done');
  const hard = v.checks.filter(c => c.kind === 'hard' && c.on && c.last?.status !== 'none');
  const shown = hard.filter(c => bad(c) || (over(c, c.first?.value) > 0)).sort((a, b) => Number(bad(b)) - Number(bad(a)) || (a.prio < b.prio ? -1 : 1));
  const rest = hard.filter(c => !shown.includes(c));
  return (
    <section className="lp-rep-h">
      <header><h4><i className="cv-dia" />{tr('硬限制质控汇报')}<span>Code Rule · Before → After</span></h4><small className="muted">{v.ran ? tr('自动复检 · {0}', ago(v.ran)) : ''}</small></header>
      <ul>
        {shown.map(c => {
          const t = ticketOf(c), lv = level(c), first = c.first?.value, now = c.last?.value;
          const pill = lv === 'pass' ? ['ok', tr('已清零 ✓')] : t && lv === 'block' ? ['bad', tr('修补中 {0}', t.ticket ?? '')] : lv === 'block' ? ['bad', tr('阻断')] : t ? ['warn', tr('修补中 {0}', t.ticket ?? '')] : ['warn', tr('告警')];
          return (
            <li key={c.id}>
              <code>[{c.prio}]</code><span>{trx(c.rule)} {trx(c.title)}</span>
              <b>{first != null && first !== now ? tr('{0} 处 → {1} 处', first, now ?? 0) : tr('{0} 处', now ?? 0)}</b>
              <em className={`lp-pill ${pill[0]}`}>{pill[1]}</em>
            </li>
          );
        })}
        {rest.length > 0 && (
          <li className="rest"><code>[{[...new Set(rest.map(c => c.prio))].sort().join('/')}]</code><span>{rest.slice(0, 3).map(c => trx(c.title)).join('、')}{rest.length > 3 ? tr(' 等 {0} 项', rest.length) : ''}</span>
            <b>{tr('全部达标')}</b><em className="lp-pill ok">{tr('已放行 ✓')}</em></li>
        )}
        {!hard.length && <li className="muted small">{tr('还没有可查的结果：论文和实验有了以后自动查')}</li>}
      </ul>
    </section>
  );
}

function SoftReport({ v, lineId, toast }: { v: CanvasView; lineId: string; toast: (t: string) => void }) {
  const soft = v.checks.filter(c => c.kind === 'soft' && c.on);
  const order = (c: Check) => ({ fail: 0, warn: 1, wait: 2, none: 2, pass: 3 })[status(c)];
  const [busy, setBusy] = useState(false);
  return (
    <section className="lp-rep-s">
      <header><h4><i className="cv-ring2" />{tr('软检测航向汇报')}<span>{tr('负责人语义巡检结论')}</span></h4>
        <button className="lnk" disabled={busy || !v.lead} title={v.lead ? '' : tr('先配一位项目负责人')}
          onClick={() => { setBusy(true); api.askAll(lineId).then(x => toast(tr('已经请负责人复审 {0} 项', x.n))).catch(e => toast((e as Error).message)).finally(() => setBusy(false)); }}>
          {tr('让负责人现在复审')}<Icon n="refresh" size={12} />
        </button>
      </header>
      <ul>
        {[...soft].sort((a, b) => order(a) - order(b)).map(c => {
          const k = status(c);
          return (
            <li key={c.id}>
              <em className={`lp-pill v-${k}`}>{VERDICT[k]}{k === 'pass' ? ' ✓' : k === 'warn' || k === 'fail' ? ' !' : ''}</em>
              <div><b>{trx(c.title)}</b><p>{c.last?.note || (c.asked ? tr('{0}问过负责人，还没回', ago(c.asked)) : trx(c.text))}</p></div>
            </li>
          );
        })}
        {!soft.length && <li className="muted small">{tr('没有开着的软巡检')}</li>}
      </ul>
    </section>
  );
}

export function LoopCard({ r, toast }: { r: ProjectCard; toast: (t: string) => void }) {
  const [v] = useCanvas(r.line.id);
  const to = loopPath(r.line.seq);
  if (!v) return null;
  return (
    <section className="psec lp-card" id="loop" aria-label={tr('研究回路')}>
      <header className="lp-h">
        <h3><Icon n="map" size={16} />{tr('研究回路')}</h3>
        <span className="lp-round">{tr('第 {0} 轮', v.rounds)} · {phase(v)}</span>
        <LoopSummary v={v} />
        <Spark v={v} />
        <a className="btn pri cv-open" href={href(to)} onClick={e => { wanted.node = null; follow(e, to); }}>{tr('打开完整回路')}<Icon n="ext" size={13} /></a>
      </header>
      <Track v={v} r={r} />
      <div className="lp-rep">
        <HardReport v={v} />
        <SoftReport v={v} lineId={r.line.id} toast={toast} />
      </div>
    </section>
  );
}
