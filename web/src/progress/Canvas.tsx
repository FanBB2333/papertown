// A project's research loop (研究回路) at /progress/<number>/loop (and the older /canvas): the whole window is a free
// graph laid over three lanes. The soft layer on top (the soft spec, the hard clamp, the sentinels watching stages),
// the spine in the middle (stations and the hard gates between them), the loop back below (rework tickets a gate
// sent back, corrections a sentinel asked for, your tasks and notes, the human gate). The lanes are where things
// start and where 按回路规整 puts them back; nothing holds a node in one. Lines say what they do: the flow (grey
// and locked past a gate that blocks), a sentinel watching, the spec injected, the clamp, a gate's rework loop, a
// sentinel's correction. Only the flow and what is under way are always drawn; the quieter lines (a sentinel
// watching, the spec, the clamp, the way to the human gate) show for the node under the pointer or the open one, in
// the view they belong to, or all at once when you ask (更多). Drag a node to move it, drag from the dot on its rim to wire it to another (or to empty
// space, to make a new node wired to it), double-click empty space for a new one, double-click a line to write on
// it, right-click anything for what can be done with it. A line that would pass through a node it does not join goes
// round it (avoid.ts). The keyboard does what it does elsewhere: copy, cut,
// paste and duplicate tasks and notes (text from outside pastes as a note), Delete, select all, arrows to nudge,
// undo for what can be taken back (moves, lines, new and pasted nodes, nodes taken off). The bar narrows the loop to what blocks or warns, to the
// hard side or the soft side, or lays out 前后对比; the open node's inspector is beside it (CanvasSide.tsx).
// How much the nodes say follows the zoom: the flow carries the zoom (--z), by which canvas.css sizes type, and
// one of three faces (data-lod): everything, no small print, or a name and a figure. A face changes at a threshold,
// with a short fade, never part-way, so the loop reads whole wherever the zoom stops. As on a map, the furthest out
// is the whole loop filling the window: the zoom stops there, the loop cannot be dragged out of sight, and a view
// that shows all of it keeps showing all of it as the window (or the inspector beside it) changes its size. Loaded
// on demand, with the graph library.

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Popover } from '@cloudflare/kumo';
import {
  Background, BackgroundVariant, BaseEdge, ConnectionMode, Controls, EdgeLabelRenderer, getBezierPath, MiniMap, Panel, Position,
  getViewportForBounds, ReactFlow, ReactFlowProvider, useEdgesState, useInternalNode, useNodesInitialized, useNodesState, useOnViewportChange, useReactFlow, ViewportPortal,
  type Connection, type Edge, type EdgeProps, type InternalNode, type OnConnectEnd,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api, type CanvasEdge, type CanvasNode, type CanvasView, type NewNode, type ProjectCard, type TaskTo } from '../api';
import { flash, usePanelNote } from '../console/page';
import { Icon, type IconName } from '../console/icons';
import { tr, trx } from '../i18n';
import { follow, href } from '../route';
import { Inspector, KIND, label, Mark, NewForm, WHO, type Draft, type Kind } from './CanvasSide';
import { status, type Act } from './Checks';
import { LoopReport } from './LoopReport';
import { LoopSummary, SIZE, useCanvas, wanted } from './LoopCard';
import { kindOf, mine, nodeTypes, OpsCtx, type FNode, type Ops } from './LoopNodes';
import { around, crosses, halfway, rounded, type Box, type Pt } from './avoid';
import { gateLook, needs, side } from './loop';
import type { ConsoleTarget } from './Project';

type FEdge = Edge<{ bow: boolean; arrow: boolean; tee: boolean; step: boolean; hidden: boolean; label: string; tag: string; tone: string }>;
type Filter = 'all' | 'todo' | 'hard' | 'soft';
type Item = { icon: IconName; label: string; run: () => void; danger?: boolean; off?: boolean; key?: string } | null;
type Spots = Record<string, [number, number]>;
// what was copied: tasks and notes, to paste as new ones, and the same as text for anywhere else
interface Held { text: string; items: { kind: 'task' | 'note'; title?: string; text?: string; to?: TaskTo; dx: number; dy: number }[] }
const MOD = navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl ';
const copyable = (n: CanvasNode) => n.kind === 'task' || n.kind === 'note';
const spots = (ns: CanvasNode[]): Spots => Object.fromEntries(ns.map(n => [n.id, [n.x, n.y]]));
interface Prefs { map: boolean; snap: boolean; hint: boolean; legend: boolean; lines: boolean }
// which of the quiet lines show: all of them, a node's own (under the pointer, or open), a view's
interface Shown { all: boolean; hot: string | null; sel: string | null; filter: Filter }

const NEW = '__new';
// the lines drawn: the ones on the loop, and from each task to the card of the agent it is for (when that card is on)
const virtual = (id: string) => id === NEW || id.startsWith('as:');
function wires(v: CanvasView): CanvasEdge[] {
  const ids = new Set(v.nodes.map(n => n.id)), joined = new Set(v.edges.flatMap(e => [`${e.source}>${e.target}`, `${e.target}>${e.source}`]));
  const extra = v.nodes.flatMap(n => {
    const to = `info:agent:${n.to}`;
    return n.kind === 'task' && ids.has(to) && !joined.has(`${n.id}>${to}`) ? [{ id: `as:${n.id}`, source: n.id, target: to }] : [];
  });
  return [...v.edges, ...extra];
}
const hay = (n: CanvasNode) => [label(n), n.text, n.id, n.check?.id, n.check && trx(n.check.text), n.to && WHO[n.to], n.gate?.name].filter(Boolean).join(' ').toLowerCase();
const typing = (e: Event) => !!(e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable=true]');

function usePrefs() {
  const base: Prefs = { map: false, snap: false, hint: true, legend: true, lines: false };
  const [p, setP] = useState<Prefs>(() => {
    try { return { ...base, ...JSON.parse(localStorage.getItem('pt-canvas') ?? '{}') }; } catch { return base; }
  });
  const set = (x: Partial<Prefs>) => setP(old => {
    const next = { ...old, ...x };
    try { localStorage.setItem('pt-canvas', JSON.stringify(next)); } catch { /* a convenience only */ }
    return next;
  });
  return [p, set] as const;
}

// a correction a sentinel asks for: written here, for you to read before it goes out
function fixSeed(n: CanvasNode): Draft['seed'] {
  const c = n.check!, last = c.last;
  const lines = [trx(c.text)];
  if (last?.note) lines.push('', tr('负责人的判断：{0}', last.note));
  lines.push('', tr('按这个判断纠偏，做完说明改了什么。'));
  const to: TaskTo = c.stage === 'exp' ? 'coder' : ['write', 'review'].includes(c.stage) ? 'writer' : 'lead';
  return { title: `${tr('纠偏：')}${trx(c.title)}`.slice(0, 58), text: lines.join('\n'), to };
}

// ---------- lines: from rim to rim, wherever the two nodes are, and round the nodes in between ----------

const BoxCtx = createContext<Box[]>([]); // where every node is, for the lines to keep off
const boxOf = (n: InternalNode): Box => ({ id: n.id, x: n.internals.positionAbsolute.x, y: n.internals.positionAbsolute.y, w: n.measured.width ?? 0, h: n.measured.height ?? 0 });

const centre = (n: InternalNode) => ({ x: n.internals.positionAbsolute.x + (n.measured.width ?? 0) / 2, y: n.internals.positionAbsolute.y + (n.measured.height ?? 0) / 2 });
function rim(n: InternalNode, to: { x: number; y: number }) {
  const c = centre(n), w = (n.measured.width ?? 0) / 2 + 3, h = (n.measured.height ?? 0) / 2 + 3, dx = to.x - c.x, dy = to.y - c.y;
  if (!dx && !dy) return { ...c, side: Position.Bottom };
  const sx = dx ? w / Math.abs(dx) : Infinity, sy = dy ? h / Math.abs(dy) : Infinity, s = Math.min(sx, sy);
  return { x: c.x + dx * s, y: c.y + dy * s, side: sx < sy ? (dx > 0 ? Position.Right : Position.Left) : dy > 0 ? Position.Bottom : Position.Top };
}
const TURN: Record<Position, number> = { [Position.Left]: 0, [Position.Top]: 90, [Position.Right]: 180, [Position.Bottom]: 270 };

function Wire({ id, source, target, data, selected }: EdgeProps<FEdge>) {
  const a = useInternalNode(source), b = useInternalNode(target);
  const o = useContext(OpsCtx), boxes = useContext(BoxCtx);
  if (!a || !b) return null;
  const ca = centre(a), cb = centre(b);
  let path: string, lx: number, ly: number, end: { x: number; y: number }, turn: number, drawn: Pt[]; // drawn: the line as points, to see what it passes through
  if (data?.bow) { // a loop back, or the way back between two nodes already joined: an arc beside the straight line
    const len = Math.hypot(cb.x - ca.x, cb.y - ca.y) || 1, bend = Math.min(110, len * 0.3);
    const ctrl = { x: (ca.x + cb.x) / 2 + ((cb.y - ca.y) / len) * bend * 2, y: (ca.y + cb.y) / 2 - ((cb.x - ca.x) / len) * bend * 2 };
    const p = rim(a, ctrl), q = rim(b, ctrl);
    path = `M${p.x},${p.y} Q${ctrl.x},${ctrl.y} ${q.x},${q.y}`;
    lx = 0.25 * p.x + 0.5 * ctrl.x + 0.25 * q.x; ly = 0.25 * p.y + 0.5 * ctrl.y + 0.25 * q.y;
    end = q; turn = (Math.atan2(q.y - ctrl.y, q.x - ctrl.x) * 180) / Math.PI;
    drawn = Array.from({ length: 13 }, (_, i) => { const t = i / 12, s = 1 - t; return { x: s * s * p.x + 2 * s * t * ctrl.x + t * t * q.x, y: s * s * p.y + 2 * s * t * ctrl.y + t * t * q.y }; });
  } else if (data?.step && cb.y - ca.y - ((a.measured.height ?? 0) + (b.measured.height ?? 0)) / 2 > 56 && Math.abs(cb.x - ca.x) > 160) {
    // the flow going down to the next row: out of the bottom, along the gap between the rows, into the top
    const p = { x: ca.x, y: ca.y + (a.measured.height ?? 0) / 2 + 3 }, q = { x: cb.x, y: cb.y - (b.measured.height ?? 0) / 2 - 3 };
    const mid = (p.y + q.y) / 2, r = 16, dir = Math.sign(q.x - p.x);
    path = `M${p.x},${p.y} L${p.x},${mid - r} Q${p.x},${mid} ${p.x + dir * r},${mid} L${q.x - dir * r},${mid} Q${q.x},${mid} ${q.x},${mid + r} L${q.x},${q.y}`;
    lx = (p.x + q.x) / 2; ly = mid; end = q; turn = TURN[Position.Top];
    drawn = [p, { x: p.x, y: mid }, { x: q.x, y: mid }, q];
  } else {
    const p = rim(a, cb), q = rim(b, ca);
    end = q; turn = TURN[q.side]; drawn = [p, q];
    if (data?.arrow || data?.tee) {
      [path, lx, ly] = getBezierPath({ sourceX: p.x, sourceY: p.y, sourcePosition: p.side, targetX: q.x, targetY: q.y, targetPosition: q.side });
      const c = path.match(/-?\d+(\.\d+)?(e-?\d+)?/g)?.map(Number) ?? [];
      if (c.length === 8) drawn = Array.from({ length: 15 }, (_, i) => {
        const t = i / 14, s = 1 - t;
        return { x: s * s * s * c[0] + 3 * s * s * t * c[2] + 3 * s * t * t * c[4] + t * t * t * c[6], y: s * s * s * c[1] + 3 * s * s * t * c[3] + 3 * s * t * t * c[5] + t * t * t * c[7] };
      });
    } else { path = `M${p.x},${p.y} L${q.x},${q.y}`; lx = (p.x + q.x) / 2; ly = (p.y + q.y) / 2; }
  }
  // through a node it does not join: round it instead, by the gaps between the nodes
  const others = data?.hidden ? [] : boxes.filter(x => x.id !== source && x.id !== target);
  if (others.length && crosses(drawn, others, 12)) {
    const way = around(ca, cb, others);
    if (way) {
      const ba = boxOf(a), bb = boxOf(b), inA = (p: Pt) => p.x > ba.x - 4 && p.x < ba.x + ba.w + 4 && p.y > ba.y - 4 && p.y < ba.y + ba.h + 4, inB = (p: Pt) => p.x > bb.x - 4 && p.x < bb.x + bb.w + 4 && p.y > bb.y - 4 && p.y < bb.y + bb.h + 4;
      const via = way.slice(1, -1);
      while (via.length && inA(via[0])) via.shift();
      while (via.length && inB(via[via.length - 1])) via.pop();
      const p = rim(a, via[0] ?? cb), q = rim(b, via[via.length - 1] ?? ca), pts = [p, ...via, q], before = pts[pts.length - 2], h = halfway(pts);
      path = rounded(pts); lx = h.x; ly = h.y; end = q; turn = (Math.atan2(q.y - before.y, q.x - before.x) * 180) / Math.PI;
    }
  }
  const text = data?.label ?? '', at = { transform: `translate(-50%,-50%) translate(${lx}px,${ly}px)` };
  return (
    <>
      <BaseEdge id={id} path={path} interactionWidth={20} />
      {data?.arrow && <g transform={`translate(${end.x},${end.y}) rotate(${turn})`}><path className="cv-arrow" d="M1,0 L-8,-4.5 L-8,4.5 Z" /></g>}
      {data?.tee && <g transform={`translate(${end.x},${end.y}) rotate(${turn})`}><path className="cv-tee" d="M0,-7 L0,7" /></g>}
      {o && !virtual(id) && !data?.hidden && (o.editing === id || text || data?.tag || selected) && (
        <EdgeLabelRenderer>
          {o.editing === id ? (
            <input className="cv-el edit nodrag nopan" style={at} autoFocus defaultValue={text} maxLength={40} placeholder={tr('这条线的意思')}
              onBlur={e => o.relabel(id, e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') { e.stopPropagation(); o.edit(null); } }} />
          ) : (
            <div className={`cv-el nodrag nopan${selected ? ' on' : ''}${!text && data?.tag ? ` tag t-${data.tone}` : ''}`} style={at} onDoubleClick={() => o.edit(id)}>
              {(text || data?.tag) && <span>{!text && (data?.tone === 'lock' || data?.tone === 'hard') && <Icon n="lock" size={10} />}{text || data?.tag}</span>}
              {selected && <button title={tr('在线上写几个字')} aria-label={tr('在线上写几个字')} onClick={() => o.edit(id)}><Icon n="compose" size={12} /></button>}
              {selected && <button className="danger" title={tr('断开这条线')} aria-label={tr('断开这条线')} onClick={() => o.cut(id)}><Icon n="close" size={12} /></button>}
            </div>
          )}
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const edgeTypes = { wire: Wire };

function toNodes(v: CanvasView, sel: string | null, draft: Draft | null, lit: Set<string> | null, prev: FNode[], moved: Record<string, [number, number]>): FNode[] {
  const old = new Map(prev.map(p => [p.id, p]));
  const out: FNode[] = v.nodes.map(n => ({
    ...(old.get(n.id) ?? {}), id: n.id, type: n.kind, position: { x: moved[n.id]?.[0] ?? n.x, y: moved[n.id]?.[1] ?? n.y }, data: { n }, selected: sel ? n.id === sel : !!old.get(n.id)?.selected,
    className: lit && !lit.has(n.id) ? 'dim' : '',
  }));
  if (draft) {
    out.push({ ...(old.get(NEW) ?? {}), id: NEW, type: 'ghost', position: { x: draft.x, y: draft.y }, selectable: false, connectable: false,
      data: { n: { id: NEW, kind: 'note', x: draft.x, y: draft.y, title: KIND[draft.kind] } } });
  }
  return out;
}

// how a line is drawn: by what it does, and how the things at its ends stand
function look(e: CanvasEdge, a: CanvasNode, b: CanvasNode): { cls: string; arrow: boolean; tee: boolean; bow: boolean; step: boolean; quiet: boolean; tag: string; tone: string } {
  const task = [a, b].find(x => x.kind === 'task');
  const none = { arrow: false, tee: false, bow: false, step: false, quiet: false, tag: '', tone: '' };
  switch (e.kind) {
    case 'flow': {
      const g = a.gate, lock = !!g && g.state === 'block' && !g.waived;
      const ok = a.kind === 'stage' ? a.status === 'done' : !!g && gateLook(g) === 'pass';
      return { ...none, cls: `w-flow${lock ? ' lock' : ok ? ' ok' : g && gateLook(g) === 'warn' ? ' warn' : ''}`, arrow: true, step: true, tag: lock ? tr('锁死') : '', tone: lock ? 'lock' : '' };
    }
    case 'watch': { // a sentinel that is content keeps its line to itself
      const k = a.check?.on ? status(a.check) : 'none';
      return { ...none, cls: `w-watch v-${k}`, arrow: true, quiet: !['warn', 'fail'].includes(k) };
    }
    case 'spec': return { ...none, cls: 'w-spec', arrow: true, quiet: true };
    case 'clamp': return { ...none, cls: 'w-clamp', tee: true, quiet: true };
    case 'escalate': {
      const on = !!(b.items?.length || a.items?.length);
      return { ...none, cls: `w-esc${on ? ' on' : ''}`, arrow: true, quiet: !on };
    }
    case 'member': return { ...none, cls: 'w-member' };
    case 'hard_loop': {
      const t = task ?? a, head = a.kind === 'gate';
      const tag = head ? (t.converged ? tr('✓ {0} 轮收敛', t.round || 1) : tr('没过，打回重改 · 第 {0} 轮', t.round || 1)) : '';
      return { ...none, cls: `w-hard${t.converged ? ' old' : t.status === 'sent' ? ' run' : ''}`, arrow: true, bow: true, tag, tone: t.converged ? 'old' : 'hard' };
    }
    case 'soft_loop': {
      const t = task ?? b;
      return { ...none, cls: `w-soft t-${t.status}${t.status === 'done' ? ' old' : ''}`, arrow: true, bow: true, tag: a.kind === 'soft' ? tr('! 软巡检纠偏') : '', tone: 'soft' };
    }
    default: {
      const cls = a.kind === 'note' || b.kind === 'note' ? 'w-note' : task ? `w-task t-${task.status}` : a.kind === 'info' || b.kind === 'info' ? 'w-info' : 'w-link';
      return { ...none, cls };
    }
  }
}

const VIEW_LINES: Record<Filter, string[]> = { all: [], todo: [], hard: ['clamp'], soft: ['watch', 'spec'] };

function toEdges(v: CanvasView, draft: Draft | null, lit: Set<string> | null, focus: string | null, shown: Shown, prev: FEdge[]): FEdge[] {
  const by = new Map(v.nodes.map(n => [n.id, n]));
  const chosen = new Set(prev.filter(e => e.selected).map(e => e.id)), seen = new Set<string>();
  const blank = { bow: false, arrow: false, tee: false, step: false, hidden: false, label: '', tag: '', tone: '' };
  const out: FEdge[] = wires(v).flatMap((e): FEdge[] => {
    const a = by.get(e.source), b = by.get(e.target);
    if (!a || !b) return [];
    const on = !lit || (lit.has(a.id) && lit.has(b.id) && (!focus || a.id === focus || b.id === focus));
    if (virtual(e.id)) { // a task to its agent's card: drawn, not yours to cut
      return [{ id: e.id, source: e.source, target: e.target, type: 'wire', className: `w-assign t-${a.status}${on ? '' : ' dim'}`, selectable: false, deletable: false, focusable: false, data: blank }];
    }
    const twin = seen.has(`${e.target}>${e.source}`);
    seen.add(`${e.source}>${e.target}`);
    const l = look(e, a, b);
    const mine = [a.id, b.id].some(id => id === shown.hot || id === shown.sel);
    const hidden = l.quiet && !shown.all && !mine && !VIEW_LINES[shown.filter].includes(e.kind ?? '');
    return [{ id: e.id, source: e.source, target: e.target, type: 'wire', className: `${l.cls}${on ? '' : ' dim'}${hidden ? ' quiet' : ''}`, selected: !hidden && chosen.has(e.id),
      data: { bow: l.bow || twin, arrow: l.arrow, tee: l.tee, step: l.step, hidden, label: e.label ?? '', tag: l.tag, tone: l.tone } }];
  });
  if (draft?.link && by.has(draft.link)) out.push({ id: NEW, source: draft.link, target: NEW, type: 'wire', className: 'w-task t-draft', selectable: false, data: blank });
  return out;
}

// the three lanes under the nodes, as wide as what is on them
function Lanes({ v }: { v: CanvasView }) {
  if (!v.nodes.length) return null;
  const x0 = Math.min(...v.nodes.map(n => n.x)) - 70, x1 = Math.max(...v.nodes.map(n => n.x + SIZE[n.kind][0])) + 70;
  return (
    <ViewportPortal>
      <div className="cv-lanes" aria-hidden>
        {v.lanes.map(l => (
          <div key={l.key} className={`cv-lane l-${l.key}`} style={{ transform: `translate(${x0}px, ${l.y0}px)`, width: x1 - x0, height: l.y1 - l.y0 }}>
            <span>{trx(l.title)}</span>
          </div>
        ))}
      </div>
    </ViewportPortal>
  );
}

// two shapes and four colours; a colour means the same on a node and on a line
function Legend({ onClose }: { onClose: () => void }) {
  return (
    <Panel position="bottom-left" className="cv-legend">
      <header><b>{tr('图例')}</b><button className="ib" title={tr('收起')} aria-label={tr('收起')} onClick={onClose}><Icon n="close" size={12} /></button></header>
      <p><span><i className="cv-dia" />{tr('卡口：用代码查')}</span><span><i className="cv-ring2" />{tr('巡检：负责人判断')}</span></p>
      <p><span><i className="lg c-pass" />{tr('通过')}</span><span><i className="lg c-warn" />{tr('要留意')}</span><span><i className="lg c-bad" />{tr('没过，打回重改')}</span><span><i className="lg c-wait" />{tr('还没查，或在等前面')}</span></p>
      <p className="more">{tr('节点和线用同一套颜色。其余的线平时收着，鼠标移到节点上或点开它就能看到。')}</p>
    </Panel>
  );
}

// ---------- the bar's parts ----------

// find a node by what it says: what wants you first; choosing one opens it and brings it into view
function Find({ v, q, setQ, onPick }: { v: CanvasView | null; q: string; setQ: (s: string) => void; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const box = useRef<HTMLInputElement>(null);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase(), all = (v?.nodes ?? []).filter(n => !s || hay(n).includes(s));
    return [...all.filter(needs), ...all.filter(n => !needs(n))].slice(0, 40);
  }, [v, q]);
  useEffect(() => setAt(0), [q]);
  const choose = (n?: CanvasNode) => { if (!n) return; onPick(n.id); setQ(''); setOpen(false); box.current?.blur(); };
  return (
    <div className="cv-find" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}>
      <Icon n="lens" size={14} />
      <input id="cv-find" ref={box} value={q} placeholder={tr('找节点')} aria-label={tr('找节点')} autoComplete="off"
        onFocus={() => setOpen(true)} onChange={e => { setQ(e.target.value); setOpen(true); }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setAt(i => Math.min(list.length - 1, i + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setAt(i => Math.max(0, i - 1)); }
          else if (e.key === 'Enter') choose(list[at]);
          else if (e.key === 'Escape') { setQ(''); setOpen(false); e.currentTarget.blur(); }
        }} />
      <kbd>{navigator.platform.startsWith('Mac') ? '⌘F' : 'Ctrl F'}</kbd>
      {open && (
        <ul role="listbox">
          {list.map((n, i) => (
            <li key={n.id}>
              <button tabIndex={-1} role="option" aria-selected={i === at} className={i === at ? 'on' : ''} onMouseDown={e => e.preventDefault()} onMouseEnter={() => setAt(i)} onClick={() => choose(n)}>
                <Mark n={n} /><span>{label(n)}</span>{needs(n) && <i className="cv-need" title={tr('要处理')} />}<small>{kindOf(n)}</small>
              </button>
            </li>
          ))}
          {!list.length && <li className="muted small">{tr('没有这样的节点')}</li>}
        </ul>
      )}
    </div>
  );
}

function Menu({ cls, title, label: text, children }: { cls: string; title?: string; label: React.ReactNode; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger render={<button className={cls} title={title} aria-label={title} />}>{text}</Popover.Trigger>
      <Popover.Portal container={document.querySelector<HTMLElement>('.cv')}>
        <Popover.Positioner side="bottom" align="end" sideOffset={6} collisionPadding={10} className="cv-pop">
          <Popover.Popup className="cv-menu">{children(() => setOpen(false))}</Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

const Row = ({ it, close }: { it: Item; close: () => void }) => (it
  ? <button className={`cv-mi${it.danger ? ' danger' : ''}`} disabled={it.off} onClick={() => { close(); it.run(); }}><Icon n={it.icon} size={14} /><span>{it.label}</span>{it.key && <kbd>{it.key}</kbd>}</button>
  : <hr />);

// ---------- the page ----------

export default function CanvasPage(p: { r: ProjectCard; toast: (t: string) => void; onConsole: (lineId: string, t?: ConsoleTarget) => void }) {
  return <ReactFlowProvider><Board {...p} /></ReactFlowProvider>;
}

function Board({ r, toast, onConsole }: { r: ProjectCard; toast: (t: string) => void; onConsole: (lineId: string, t?: ConsoleTarget) => void }) {
  const { line } = r;
  const [v, setV, reload] = useCanvas(line.id);
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [wide, setWide] = useState(false);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [report, setReport] = useState(false);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; items: Item[] } | null>(null);
  const [hot, setHot] = useState<string | null>(null);
  const [prefs, setPrefs] = usePrefs();
  const [nodes, setNodes, onNodesChange] = useNodesState<FNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FEdge>([]);
  const rf = useReactFlow();
  const ready = useNodesInitialized();
  const wrap = useRef<HTMLDivElement>(null);
  const fitted = useRef(false), dragging = useRef(false), moved = useRef<Record<string, [number, number]>>({});
  const back = `/progress/${line.seq}`;
  const cur = v?.nodes.find(n => n.id === sel) ?? null;
  const dark = document.documentElement.dataset.mode === 'dark';
  const todo = useMemo(() => v?.nodes.filter(needs).length ?? 0, [v]);
  const loopY = v?.lanes.find(l => l.key === 'loop');

  // what stays bright: what you search for, what the view keeps, or the open node and what it is wired to
  const [lit, focus] = useMemo<[Set<string> | null, string | null]>(() => {
    if (!v) return [null, null];
    const s = q.trim().toLowerCase();
    const keep = s ? v.nodes.filter(n => hay(n).includes(s)) : filter === 'todo' ? v.nodes.filter(needs)
      : filter === 'hard' ? v.nodes.filter(n => ['hard', 'both'].includes(side(n))) : filter === 'soft' ? v.nodes.filter(n => ['soft', 'both'].includes(side(n))) : null;
    if (keep) return [new Set([...keep.map(n => n.id), ...(sel ? [sel] : [])]), null];
    if (!sel) return [null, null];
    const near = new Set([sel]);
    for (const e of wires(v)) { if (e.source === sel) near.add(e.target); if (e.target === sel) near.add(e.source); }
    return [near, sel];
  }, [v, q, filter, sel]);

  useEffect(() => {
    if (!v || dragging.current) return;
    setNodes(prev => toNodes(v, sel, draft, lit, prev, moved.current));
  }, [v, sel, draft, lit, setNodes]);
  useEffect(() => {
    if (!v || dragging.current) return;
    setEdges(prev => toEdges(v, draft, lit, focus, { all: prefs.lines, hot, sel, filter }, prev));
  }, [v, sel, draft, lit, focus, hot, filter, prefs.lines, setEdges]);
  // how far out the loop is seen from: canvas.css sizes type by the zoom and picks what the nodes say by the face.
  // Each face is left a little past where it is entered, so a zoom resting on a threshold does not flicker.
  const face = useRef<'near' | 'mid' | 'far'>('near');
  const scale = (zoom: number) => {
    const el = wrap.current;
    if (!el) return;
    el.style.setProperty('--z', zoom.toFixed(3));
    const was = face.current;
    const now = was === 'near' ? (zoom < 0.45 ? 'far' : zoom < 0.7 ? 'mid' : 'near')
      : was === 'mid' ? (zoom < 0.45 ? 'far' : zoom > 0.75 ? 'near' : 'mid')
        : zoom > 0.75 ? 'near' : zoom > 0.5 ? 'mid' : 'far';
    face.current = now;
    if (el.dataset.lod !== now) el.dataset.lod = now;
  };
  useOnViewportChange({ onChange: vp => scale(vp.zoom) });
  // the whole loop: its lanes and whatever has been dragged beyond them
  const frame = useMemo(() => {
    if (!v?.nodes.length) return null;
    const x0 = Math.min(...v.nodes.map(n => n.x)) - 70, x1 = Math.max(...v.nodes.map(n => n.x + SIZE[n.kind][0])) + 70;
    const y0 = Math.min(...v.lanes.map(l => l.y0), ...v.nodes.map(n => n.y - 30)), y1 = Math.max(...v.lanes.map(l => l.y1), ...v.nodes.map(n => n.y + SIZE[n.kind][1] + 30));
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }, [v]);
  const frameKey = frame ? `${frame.x},${frame.y},${frame.width},${frame.height}` : '';
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox(b => (b.w === el.clientWidth && b.h === el.clientHeight ? b : { w: el.clientWidth, h: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // all of it in the window: where the loop opens, what 适应窗口 goes back to, and the furthest out the zoom goes
  const whole = useMemo(() => (frame && box.w && box.h ? getViewportForBounds(frame, box.w, box.h, 0.02, 1.25, 0.03) : null), [frameKey, box.w, box.h]); // eslint-disable-line react-hooks/exhaustive-deps
  const floor = Math.min(1, whole?.zoom ?? 0.12);
  const extent = useMemo<[[number, number], [number, number]] | undefined>(() => frame
    ? [[frame.x - frame.width * 0.35, frame.y - frame.height * 0.35], [frame.x + frame.width * 1.35, frame.y + frame.height * 1.35]] : undefined, [frameKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const auto = useRef(true); // showing all of it, until you zoom or pan yourself
  const fit = (ms = 300) => {
    if (!whole) return;
    auto.current = true;
    rf.setViewport(whole, { duration: ms });
    if (!ms) scale(whole.zoom);
  };
  useEffect(() => {
    if (!ready || !whole || !nodes.length) return;
    if (!fitted.current) { fitted.current = true; fit(0); }
    else if (auto.current || rf.getZoom() < floor - 0.002) fit(200);
  }, [ready, whole, nodes.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const act: Act = async (fn, done) => {
    setBusy(true);
    try {
      const x = await fn();
      if (x && typeof x === 'object' && 'nodes' in x) setV(x as CanvasView); else reload();
      if (done) toast(done);
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  // ---------- what the keyboard and the menus share ----------
  // what can be taken back, newest last: each is how to put things as they were
  const undos = useRef<{ what: string; run: () => Promise<unknown> }[]>([]);
  const remember = (what: string, run: () => Promise<unknown>) => { undos.current = [...undos.current.slice(-39), { what, run }]; };
  const undo = () => {
    const u = undos.current.pop();
    if (u) act(u.run, tr('撤销了：{0}', u.what)); else toast(tr('没有可以撤销的'));
  };
  // where nodes are: here at once, on the server after
  const before = useRef<Spots>({}), saving = useRef<{ at: Spots; timer: number } | null>(null);
  const put = (at: Spots) => {
    Object.assign(moved.current, at);
    setV(x => x && { ...x, nodes: x.nodes.map(n => (at[n.id] ? { ...n, x: at[n.id][0], y: at[n.id][1] } : n)) });
  };
  const store = (at: Spots) => api.moveNodes(line.id, at).catch(e => toast((e as Error).message))
    .finally(() => { for (const k of Object.keys(at)) if (moved.current[k] === at[k]) delete moved.current[k]; });
  const place = (at: Spots) => { put(at); return store(at); };
  // the arrows: a step at a time, saved once the keys rest, taken back as one move
  const nudge = (ns: CanvasNode[], dx: number, dy: number) => {
    if (!saving.current) { const was = spots(ns); remember(tr('移动'), async () => { await place(was); }); }
    const at: Spots = Object.fromEntries(ns.map(n => [n.id, [n.x + dx, n.y + dy]]));
    put(at);
    window.clearTimeout(saving.current?.timer);
    const all = { ...saving.current?.at, ...at };
    saving.current = { at: all, timer: window.setTimeout(() => { saving.current = null; store(all); }, 350) };
  };
  useEffect(() => () => { if (saving.current) { window.clearTimeout(saving.current.timer); api.moveNodes(line.id, saving.current.at).catch(() => {}); } }, [line.id]);
  // the selection: the open node, or what is selected on the graph (a box drawn with Shift, ⌘-clicks, select all)
  const picked = (): CanvasNode[] => {
    const ids = new Set(nodes.filter(n => n.selected && n.id !== NEW).map(n => n.id));
    if (sel) ids.add(sel);
    return (v?.nodes ?? []).filter(n => ids.has(n.id));
  };
  const select = (ids: string[] | 'all' | null) => {
    setSel(ids && ids !== 'all' && ids.length === 1 ? ids[0] : null);
    setNodes(ns => ns.map(n => ({ ...n, selected: n.id !== NEW && (ids === 'all' || !!ids?.includes(n.id)) })));
  };
  // new nodes without the form: pasted, duplicated
  const make = async (items: NewNode[], what: string, done: string) => {
    if (!items.length) return;
    setBusy(true);
    try {
      const ids: string[] = [];
      let x: CanvasView | null = null;
      for (const b of items) { x = await api.addNode(line.id, b); if (x.added) ids.push(x.added); }
      if (x) setV(x);
      setDraft(null);
      setReport(false);
      remember(what, async () => { let y: CanvasView | undefined; for (const id of ids) y = await api.dropNode(line.id, id); return y; });
      setTimeout(() => select(ids), 60);
      toast(done);
    } catch (e) { toast((e as Error).message); reload(); } finally { setBusy(false); }
  };
  const held = useRef<Held | null>(null), pointer = useRef<{ x: number; y: number } | null>(null), landed = useRef({ x: 0, y: 0, n: 0 });
  const copy = (ns: CanvasNode[], quiet = false) => {
    if (!ns.length) return;
    const own = ns.filter(copyable), x0 = Math.min(...own.map(n => n.x)), y0 = Math.min(...own.map(n => n.y));
    const text = ns.map(n => (n.kind === 'note' ? n.text ?? '' : [label(n), n.text].filter(Boolean).join('\n'))).join('\n\n');
    held.current = own.length ? { text, items: own.map(n => ({ kind: n.kind as 'task' | 'note', title: n.title, text: n.text, to: n.to, dx: n.x - x0, dy: n.y - y0 })) } : null;
    navigator.clipboard?.writeText(text).catch(() => {});
    if (!quiet) toast(own.length ? tr('复制了 {0} 个节点', own.length) : tr('复制了文字（只有任务和备注能粘贴成新节点）'));
  };
  // where a paste lands: under the pointer (or where the menu was opened), a step further each time it has not moved
  const landing = (at?: { x: number; y: number }) => {
    const s = at ?? pointer.current, p = s ? rf.screenToFlowPosition(s) : middle();
    const same = Math.abs(p.x - landed.current.x) < 2 && Math.abs(p.y - landed.current.y) < 2;
    landed.current = { x: p.x, y: p.y, n: same ? landed.current.n + 1 : 0 };
    return { x: Math.round(p.x - 40 + landed.current.n * 28), y: Math.round(p.y - 20 + landed.current.n * 28) };
  };
  const paste = (at?: { x: number; y: number }) => {
    const h = held.current;
    if (!h) return false;
    const o = landing(at);
    make(h.items.map(i => ({ kind: i.kind, x: o.x + i.dx, y: o.y + i.dy, title: i.title, text: i.text, to: i.to })), tr('粘贴'), tr('粘贴了 {0} 个节点', h.items.length));
    return true;
  };
  const pasteText = (text: string, at?: { x: number; y: number }) => {
    const o = landing(at);
    make([{ kind: 'note', x: o.x, y: o.y, text: text.trim().slice(0, 2000) }], tr('粘贴'), tr('粘贴成了一张备注'));
  };
  const pasteAny = async (at?: { x: number; y: number }) => { // from a menu, where there is no paste event to read
    if (paste(at)) return;
    try {
      const t = await navigator.clipboard.readText();
      if (t.trim()) pasteText(t, at); else toast(tr('剪贴板里没有可以粘贴的'));
    } catch { toast(tr('读不到剪贴板，按 {0}V 粘贴', MOD)); }
  };
  const dup = (ns: CanvasNode[]) => {
    const own = ns.filter(copyable);
    if (!own.length) { toast(tr('只有任务和备注能复制成新节点')); return; }
    const one = own.length === 1;
    make(own.map(n => ({ kind: n.kind as 'task' | 'note', x: n.x + (one ? 36 : 44), y: n.y + (one ? SIZE[n.kind][1] + 28 : 44), title: n.title, text: n.text, to: n.to })),
      tr('复制一份'), tr('复制了 {0} 个节点', own.length));
  };
  const snip = (ns: CanvasNode[]) => {
    const own = ns.filter(copyable);
    if (!own.length) { toast(tr('只有任务和备注能剪切')); return; }
    copy(own, true);
    remove(own, false, tr('剪切了 {0} 个节点，{1}V 粘贴', own.length, MOD));
  };
  // several nodes in a line
  const align = (ns: CanvasNode[], how: 'left' | 'top' | 'row' | 'column') => {
    if (ns.length < 2) return;
    const by = how === 'left' || how === 'column' ? 'y' : 'x', sorted = [...ns].sort((a, b) => a[by] - b[by]);
    const first = sorted[0], last = sorted[sorted.length - 1], k = sorted.length - 1;
    const at: Spots = Object.fromEntries(sorted.map((n, i) => [n.id,
      how === 'left' ? [Math.min(...ns.map(x => x.x)), n.y] : how === 'top' ? [n.x, Math.min(...ns.map(x => x.y))]
        : how === 'row' ? [Math.round(first.x + ((last.x - first.x) * i) / k), n.y] : [n.x, Math.round(first.y + ((last.y - first.y) * i) / k)]]));
    const was = spots(ns);
    remember(tr('对齐'), async () => { await place(was); });
    place(at);
  };
  const centre = (n: CanvasNode) => {
    auto.current = false;
    rf.setCenter(n.x + SIZE[n.kind][0] / 2, n.y + SIZE[n.kind][1] / 2, { zoom: Math.max(rf.getZoom(), 0.8), duration: 300 });
  };
  const zoomTo = (how: 'in' | 'out' | 'one') => {
    auto.current = false;
    if (how === 'one') rf.zoomTo(1, { duration: 200 }); else if (how === 'in') rf.zoomIn({ duration: 150 }); else rf.zoomOut({ duration: 150 });
  };

  const boxes = useMemo<Box[]>(() => nodes.filter(n => n.id !== NEW).map(n => ({ id: n.id, x: n.position.x, y: n.position.y,
    w: n.measured?.width ?? SIZE[n.data.n.kind][0], h: n.measured?.height ?? SIZE[n.data.n.kind][1] })), [nodes]);
  const begin = (d: Draft) => { select(null); setReport(false); setDraft(d); };
  const pick = (id: string) => {
    setDraft(null);
    setReport(false);
    setSel(id);
    setTimeout(() => { // once the inspector has opened beside the canvas, bring the node back into view if that hid it
      const n = rf.getNode(id), box = wrap.current?.getBoundingClientRect();
      if (!n || !box) return;
      const cx = n.position.x + (n.measured?.width ?? 0) / 2, cy = n.position.y + (n.measured?.height ?? 0) / 2, at = rf.flowToScreenPosition({ x: cx, y: cy });
      const side = document.querySelector('.cv-side')?.getBoundingClientRect();
      const bottom = side && side.left <= box.left + 1 ? side.top : box.bottom; // on a phone the inspector lies over the canvas's lower part
      if (at.x < box.left + 40 || at.x > box.right - 40 || at.y < box.top + 40 || at.y > bottom - 40) {
        const zoom = Math.max(rf.getZoom(), 0.6);
        auto.current = false;
        rf.setViewport({ x: box.width / 2 - cx * zoom, y: (bottom - box.top) / 2 - cy * zoom, zoom }, { duration: 300 });
      }
    }, 320);
  };
  const middle = () => {
    const b = wrap.current?.getBoundingClientRect();
    return rf.screenToFlowPosition({ x: (b?.left ?? 0) + (b?.width ?? 800) / 2, y: (b?.top ?? 0) + (b?.height ?? 600) / 2 });
  };
  const here = (x: number, y: number, kind: Kind, link: string | null = null) => {
    const p = rf.screenToFlowPosition({ x, y });
    begin({ kind, x: Math.round(p.x - 100), y: Math.round(p.y - 24), link });
  };
  const add = (kind: Kind) => { const p = middle(); begin({ kind, x: Math.round(p.x - 100), y: Math.round(p.y - 30), link: null }); };
  const beside = (n: CanvasNode, kind: Kind, seed?: Draft['seed']) => begin({ kind, x: n.x + SIZE[n.kind][0] + 70, y: n.y + 50, link: n.id, seed });
  async function create(b: NewNode) {
    setBusy(true);
    try {
      const x = await api.addNode(line.id, b);
      setV(x);
      setDraft(null);
      if (x.added) setSel(x.added);
      const id = x.added;
      if (id && !b.send) remember(tr('新建节点'), () => api.dropNode(line.id, id));
      toast(b.kind === 'task' && b.send ? tr('加上了，也发给它了') : tr('加上了'));
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  }
  // one node of your own to delete asks first; what Papertown put on the loop is only taken off, and can come back
  const remove = (ns: CanvasNode[], ask = true, done?: string) => {
    if (!ns.length) return;
    const own = ns.filter(mine), rest = ns.filter(n => !mine(n));
    if (ask && own.length && !confirm(own.length === 1 ? tr('删掉「{0}」？', label(own[0])) : tr('删掉这 {0} 个任务、备注或自己加的检查？', own.length))) return;
    act(async () => { let x: CanvasView | undefined; for (const n of ns) x = await api.dropNode(line.id, n.id); return x; },
      done ?? (rest.length ? tr('拿掉了，可以在「更多」里放回来') : tr('删掉了'))).then(() => setSel(s => (s && ns.some(n => n.id === s) ? null : s)));
    if (rest.length) remember(tr('拿掉节点'), async () => { let x: CanvasView | undefined; for (const n of rest) x = await api.restoreNode(line.id, n.id); return x; });
  };
  const drop = (n: CanvasNode) => remove([n]);
  const cut = (edgeId: string) => {
    const e = v?.edges.find(x => x.id === edgeId);
    if (!e || virtual(edgeId)) return;
    act(() => api.disconnect(line.id, edgeId));
    if (!e.kind) remember(tr('断开连线'), async () => { // only a line of your own comes back as it was
      const x = await api.connect(line.id, e.source, e.target), back = x.edges.find(y => y.source === e.source && y.target === e.target);
      return e.label && back ? api.labelEdge(line.id, back.id, e.label) : x;
    });
  };
  const gate = (stage: string, what: 'open' | 'close' | 'rework') =>
    act(() => api.gateAct(line.id, stage, what), what === 'rework' ? tr('修补单发出去了') : undefined).then(() => { if (what !== 'rework') setTimeout(() => fit(), 80); });
  const ops: Ops = {
    busy, agents: v?.agents ?? null, r, v, editing, edit: setEditing, cut, gate,
    relabel: (edgeId, text) => {
      setEditing(null);
      const was = v?.edges.find(e => e.id === edgeId)?.label ?? '';
      if (was !== text.trim()) { act(() => api.labelEdge(line.id, edgeId, text.trim())); remember(tr('改线上的字'), () => api.labelEdge(line.id, edgeId, was)); }
    },
    fix: n => {
      if (n.kind === 'gate' && n.gate) gate(n.gate.stage, 'rework');
      else if (n.kind === 'hard' && n.check?.stage) gate(n.check.stage, 'rework');
      else if (n.check?.kind === 'soft') begin({ kind: 'task', x: n.x, y: (loopY?.y0 ?? n.y + 200) + 60, link: n.id, seed: fixSeed(n) });
    },
    ask: n => { if (n.check) act(() => api.askCheck(line.id, n.check!.id), tr('已经发给负责人，它判断完会出现在这里')); },
    send: n => { act(() => api.sendNode(line.id, n.id), tr('发给{0}了', WHO[n.to ?? 'lead'])); },
    beside: (n, k) => beside(n, k),
    dup: n => dup([n]),
    drop,
  };

  const onConnect = (c: Connection) => {
    const { source, target } = c;
    if (!source || !target || target === NEW) return;
    act(async () => {
      const had = new Set(v?.edges.map(e => e.id)), x = await api.connect(line.id, source, target), e = x.edges.find(y => !had.has(y.id));
      if (e) remember(tr('连线'), () => api.disconnect(line.id, e.id));
      return x;
    });
  };
  const onConnectEnd: OnConnectEnd = (e, s) => {
    if (s.toNode || !s.fromNode || s.fromNode.id === NEW) return;
    const pt = 'changedTouches' in e ? e.changedTouches[0] : e;
    here(pt.clientX, pt.clientY, 'task', s.fromNode.id);
  };
  const onDragStop = (_e: unknown, _n: FNode, all: FNode[]) => {
    dragging.current = false;
    const real = all.filter(n => n.id !== NEW);
    const ghost = all.find(n => n.id === NEW);
    if (ghost) setDraft(d => d && { ...d, x: Math.round(ghost.position.x), y: Math.round(ghost.position.y) });
    if (!real.length) return;
    const at: Spots = Object.fromEntries(real.map(n => [n.id, [Math.round(n.position.x), Math.round(n.position.y)]]));
    const was = Object.fromEntries(Object.entries(before.current).filter(([id]) => at[id]));
    if (Object.keys(was).some(id => was[id][0] !== at[id][0] || was[id][1] !== at[id][1])) remember(tr('移动'), async () => { await place(was); });
    place(at);
  };
  const tidy = () => {
    if (!confirm(tr('按回路规整：工序、卡口、巡检、软限制和硬边界放回各自的泳道，修补单放到卡口下面？你的任务、备注和画的线不动。'))) return;
    const was = spots(v?.nodes ?? []);
    remember(tr('按回路规整'), async () => { await place(was); });
    act(() => api.tidyCanvas(line.id)).then(() => setTimeout(() => fit(), 60));
  };
  const runAll = () => act(() => api.runChecks(line.id), tr('查完了'));

  // right-click: what can be done with the thing under the pointer
  const menuAt = (e: { clientX: number; clientY: number; preventDefault: () => void }, items: Item[]) => {
    e.preventDefault();
    const tall = Math.min(items.filter(Boolean).length * 33 + items.filter(x => !x).length * 9 + 14, window.innerHeight - 24);
    setCtx({ x: Math.min(e.clientX, window.innerWidth - 262), y: Math.max(12, Math.min(e.clientY, window.innerHeight - tall - 12)), items });
  };
  const setTask = (n: CanvasNode, to: 'draft' | 'done') => act(() => api.setNode(line.id, n.id, { status: to }));
  const toggle = (n: CanvasNode) => { if (n.check) act(() => api.setCheck(line.id, n.check!.id, { on: !n.check!.on }), n.check.on ? tr('关掉了') : tr('打开了')); };
  const several = (ns: CanvasNode[]): Item[] => [
    { icon: 'copy', label: tr('复制 {0} 个节点', ns.length), run: () => copy(ns), key: `${MOD}C` },
    { icon: 'split', label: tr('剪切'), run: () => snip(ns), key: `${MOD}X`, off: !ns.some(copyable) },
    { icon: 'stack', label: tr('复制一份'), run: () => dup(ns), key: `${MOD}D`, off: !ns.some(copyable) },
    null,
    { icon: 'rows', label: tr('左对齐'), run: () => align(ns, 'left') },
    { icon: 'rows', label: tr('顶部对齐'), run: () => align(ns, 'top') },
    { icon: 'cards', label: tr('横向等距'), run: () => align(ns, 'row'), off: ns.length < 3 },
    { icon: 'cards', label: tr('纵向等距'), run: () => align(ns, 'column'), off: ns.length < 3 },
    null,
    { icon: 'close', label: tr('删掉这 {0} 个', ns.length), run: () => remove(ns), danger: true, key: '⌫' },
  ];
  const nodeItems = (n: CanvasNode): Item[] => {
    const g = n.gate, c = n.check, soft = c?.kind === 'soft', st = n.status;
    const acts: Item[] = [
      ...(g?.state === 'block' ? [{ icon: 'refresh', label: g.ticket ? tr('打回一轮') : tr('派修补单'), run: () => gate(g.stage, 'rework') } as Item] : []),
      ...(g?.escalated ? [{ icon: 'plus', label: tr('再给两轮'), run: () => act(() => api.gateAct(line.id, g.stage, 'more'), tr('再打回两轮')) } as Item] : []),
      ...(g?.state === 'block' && !g.waived ? [{ icon: 'play', label: tr('先放行'), run: () => act(() => api.gateAct(line.id, g.stage, 'waive'), tr('先放行了')) } as Item] : []),
      ...(g && g.checks.length > 1 ? [{ icon: 'split', label: g.open ? tr('收回卡口组') : tr('展开为 {0} 个独立节点', g.checks.length), run: () => gate(g.stage, g.open ? 'close' : 'open') } as Item] : []),
      ...(g || n.kind === 'hard' ? [{ icon: 'refresh', label: tr('跑一遍代码硬检查'), run: runAll } as Item] : []),
      ...(soft && c.on && ['fail', 'warn'].includes(status(c)) ? [{ icon: 'wand', label: tr('派人纠偏'), run: () => ops.fix(n) } as Item] : []),
      ...(soft && c.on ? [{ icon: 'send', label: tr('让负责人现在查'), run: () => ops.ask(n), off: !v?.lead } as Item] : []),
      ...(c ? [{ icon: c.on ? 'stop' : 'play', label: c.on ? tr('关掉这项检查') : tr('打开这项检查'), run: () => toggle(n) } as Item] : []),
      ...(n.kind === 'task' ? [{ icon: 'send', label: st === 'draft' ? tr('发给{0}', WHO[n.to ?? 'lead']) : tr('再发一次'), run: () => ops.send(n), off: !v?.agents[n.to ?? 'lead'].there } as Item] : []),
      ...(n.kind === 'task' && st === 'sent' ? [{ icon: 'check', label: tr('标成完成'), run: () => setTask(n, 'done') } as Item] : []),
      ...(n.kind === 'task' && (st === 'done' || st === 'blocked') ? [{ icon: 'refresh', label: tr('重新打开'), run: () => setTask(n, 'draft') } as Item] : []),
    ];
    return [
      { icon: 'eye', label: tr('看详情'), run: () => pick(n.id) },
      { icon: 'target', label: tr('移到画面中间'), run: () => centre(n) },
      ...(acts.length ? [null, ...acts] : []),
      null,
      { icon: 'plus', label: tr('在它旁边派任务'), run: () => beside(n, 'task') },
      { icon: 'plus', label: tr('在它旁边加备注'), run: () => beside(n, 'note') },
      ...(n.kind === 'stage' ? [{ icon: 'plus', label: tr('加一项盯着它的软巡检'), run: () => beside(n, 'soft') } as Item, { icon: 'plus', label: tr('给它的卡口加一条硬规则'), run: () => beside(n, 'hard') } as Item] : []),
      null,
      { icon: 'copy', label: copyable(n) ? tr('复制') : tr('复制名称和内容'), run: () => copy([n]), key: `${MOD}C` },
      ...(copyable(n) ? [{ icon: 'split', label: tr('剪切'), run: () => snip([n]), key: `${MOD}X` } as Item, { icon: 'stack', label: tr('复制一份'), run: () => dup([n]), key: `${MOD}D` } as Item] : []),
      null,
      { icon: 'close', label: mine(n) ? tr('删掉') : tr('从回路上拿掉'), run: () => drop(n), danger: true, key: '⌫' },
    ];
  };
  const paneItems = (x: number, y: number): Item[] => [
    { icon: 'plus', label: tr('在这里派任务'), run: () => here(x, y, 'task'), key: 'N' },
    { icon: 'plus', label: tr('在这里加备注'), run: () => here(x, y, 'note'), key: '⇧N' },
    { icon: 'plus', label: tr('在这里加软巡检'), run: () => here(x, y, 'soft') },
    { icon: 'plus', label: tr('在这里加硬规则'), run: () => here(x, y, 'hard') },
    null,
    { icon: 'doc', label: held.current ? tr('粘贴 {0} 个节点', held.current.items.length) : tr('粘贴'), run: () => pasteAny({ x, y }), key: `${MOD}V` },
    { icon: 'board', label: tr('全选'), run: () => select('all'), key: `${MOD}A` },
    { icon: 'left', label: undos.current.length ? tr('撤销：{0}', undos.current[undos.current.length - 1].what) : tr('撤销'), run: undo, key: `${MOD}Z`, off: !undos.current.length },
    null,
    { icon: 'target', label: tr('适应窗口'), run: () => fit(), key: 'F' },
    { icon: 'lens', label: tr('缩放到 100%'), run: () => zoomTo('one'), key: '0' },
    { icon: 'wand', label: tr('按回路规整'), run: tidy },
    { icon: prefs.lines ? 'check' : 'eye', label: prefs.lines ? tr('收起次要的连线') : tr('显示全部连线'), run: () => setPrefs({ lines: !prefs.lines }) },
    null,
    { icon: 'refresh', label: tr('立即全检'), run: runAll },
  ];
  const edgeItems = (id: string): Item[] => {
    const e = v?.edges.find(x => x.id === id), a = v?.nodes.find(n => n.id === e?.source), b = v?.nodes.find(n => n.id === e?.target);
    return [
      { icon: 'compose', label: e?.label ? tr('改线上的字') : tr('在线上写几个字'), run: () => setEditing(id) },
      ...(a ? [{ icon: 'eye', label: tr('看「{0}」', label(a)), run: () => pick(a.id) } as Item] : []),
      ...(b ? [{ icon: 'eye', label: tr('看「{0}」', label(b)), run: () => pick(b.id) } as Item] : []),
      null,
      { icon: 'close', label: tr('断开这条线'), run: () => cut(id), danger: true, key: '⌫' },
    ];
  };
  // the assistant in its floating window: told what is open here, and able to bring a node up (show --ref node:<id>)
  usePanelNote('canvas', 'board', {
    [tr('选中的节点')]: cur ? `${cur.id}「${label(cur)}」` : null,
    [tr('视角')]: report ? tr('前后对比') : filter === 'todo' ? tr('阻断与预警') : filter === 'hard' ? tr('硬卡口') : filter === 'soft' ? tr('软巡检') : null,
    [tr('在找')]: q.trim() || null,
  });
  const want = useRef<string | null>(wanted.node);
  useEffect(() => { wanted.node = null; }, []);
  const bring = () => {
    const id = want.current;
    if (!id || !v?.nodes.some(n => n.id === id)) return;
    want.current = null;
    pick(id);
    flash(`node:${id}`);
  };
  useEffect(() => {
    const on = (e: Event) => { want.current = (e as CustomEvent<string>).detail; bring(); };
    addEventListener('pt-canvas-show', on);
    return () => removeEventListener('pt-canvas-show', on);
  });
  useEffect(() => { if (ready) bring(); }, [v, ready]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!ctx) return;
    const away = (e: Event) => { if (!(e.target as HTMLElement).closest?.('.cv-ctx')) setCtx(null); };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [ctx]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
      if (mod && k === 'f') { e.preventDefault(); document.getElementById('cv-find')?.focus(); return; }
      if (typing(e) || e.altKey) return;
      const ns = picked();
      if (mod) { // copy leaves text you have selected on the page (in the inspector, say) to the browser
        if (k === 'c' && ns.length && !window.getSelection()?.toString()) { e.preventDefault(); copy(ns); }
        else if (k === 'x' && ns.length) { e.preventDefault(); snip(ns); }
        else if (k === 'd' && ns.length) { e.preventDefault(); dup(ns); }
        else if (k === 'a') { e.preventDefault(); setDraft(null); select('all'); }
        else if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
        return;
      }
      if (e.key === 'Escape') { if (ctx) setCtx(null); else if (draft) setDraft(null); else if (report) setReport(false); else select(null); }
      else if (k === 'n') { e.preventDefault(); add(e.shiftKey ? 'note' : 'task'); }
      else if (k === 'f') fit();
      else if (k === '0') zoomTo('one');
      else if (k === '=' || k === '+') zoomTo('in');
      else if (k === '-') zoomTo('out');
      else if (e.key.startsWith('Arrow') && ns.length && !draft) {
        e.preventDefault();
        const d = e.shiftKey ? 50 : 10;
        nudge(ns, e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0, e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0);
      }
    };
    // ⌘V: what was copied here comes back as nodes; text from anywhere else lands as a note
    const onPaste = (e: ClipboardEvent) => {
      if (typing(e)) return;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (held.current && (!text || text === held.current.text)) { e.preventDefault(); paste(); }
      else if (text.trim()) { e.preventDefault(); pasteText(text); }
    };
    window.addEventListener('keydown', key);
    window.addEventListener('paste', onPaste);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('paste', onPaste); };
  });

  const views: [Filter | 'report', string, number?][] = [['all', tr('全部回路')], ['todo', tr('阻断与预警'), todo], ['hard', tr('硬卡口')], ['soft', tr('软巡检')], ['report', tr('前后对比')]];
  return createPortal(
    <div className="cv" role="dialog" aria-modal="true" aria-label={tr('#{0} 的研究回路', line.seq)}>
      <header className="cv-top">
        <a className="cv-back" href={href(back)} onClick={e => follow(e, back)} title={tr('回到项目页')}><Icon n="left" size={15} /><span>#{line.seq}</span><b>{line.title}</b></a>
        <h2>{tr('研究回路')}{v && <em className="cv-r">Loop R{v.rounds}</em>}</h2>
        <div className="seg cv-filter" role="radiogroup" aria-label={tr('回路上亮着哪些')}>
          {views.map(([k, t, n]) => {
            const on = k === 'report' ? report : !report && filter === k;
            return (
              <button key={k} role="radio" aria-checked={on} className={on ? 'on' : ''} onClick={() => { if (k === 'report') setReport(x => !x); else { setReport(false); setFilter(k); } }}
                title={k === 'todo' ? tr('阻断或告警的卡口、没过或到期的巡检、没做完的任务、被锁或等你的工序、等你拍板的事') : undefined}>
                {t}{!!n && <em>{n}</em>}
              </button>
            );
          })}
        </div>
        <Find v={v} q={q} setQ={setQ} onPick={pick} />
        {v && <LoopSummary v={v} short />}
        <div className="cv-acts">
          <button className="btn" disabled={busy || !v} onClick={runAll} title={tr('把这个项目的硬检查现在全部跑一遍')}><Icon n="refresh" size={14} />{tr('立即全检')}</button>
          <Menu cls="btn pri" label={<><Icon n="plus" size={14} />{tr('新建回路节点')}</>}>
            {close => (
              <>
                {([['task', tr('一件交给 agent 的事'), 'N'], ['soft', tr('一个让负责人判断的问题'), ''], ['hard', tr('一条用代码查的规则'), ''], ['note', tr('一张便签'), '']] as const).map(([k, d, key]) => (
                  <button key={k} className="cv-mi two" disabled={!v} onClick={() => { close(); add(k); }}>
                    <i className={k === 'task' ? 'cv-tdot' : k === 'note' ? 'cv-ndot' : k === 'hard' ? 'cv-dia' : 'cv-ring2'} /><span><b>{KIND[k]}</b><small>{d}</small></span>{key && <kbd>{key}</kbd>}
                  </button>
                ))}
              </>
            )}
          </Menu>
          <Menu cls="btn" label={<>{tr('更多')}<Icon n="down" size={13} /></>}>
            {close => (
              <>
                <Row close={close} it={{ icon: 'target', label: tr('适应窗口'), run: () => fit(), key: 'F' }} />
                <Row close={close} it={{ icon: 'wand', label: tr('按回路规整'), run: tidy, off: busy || !v }} />
                <Row close={close} it={{ icon: 'doc', label: tr('前后对比'), run: () => setReport(true), off: !v }} />
                <hr />
                <label className="cv-mi"><input type="checkbox" checked={prefs.lines} onChange={e => setPrefs({ lines: e.target.checked })} /><span>{tr('显示全部连线')}</span></label>
                <label className="cv-mi"><input type="checkbox" checked={prefs.legend} onChange={e => setPrefs({ legend: e.target.checked })} /><span>{tr('图例')}</span></label>
                <label className="cv-mi"><input type="checkbox" checked={prefs.map} onChange={e => setPrefs({ map: e.target.checked })} /><span>{tr('小地图')}</span></label>
                <label className="cv-mi"><input type="checkbox" checked={prefs.snap} onChange={e => setPrefs({ snap: e.target.checked })} /><span>{tr('拖动时对齐网格')}</span></label>
                {v && v.spare.length > 0 && (
                  <>
                    <hr />
                    <h6>{tr('资料卡：实时显示项目的一部分')}</h6>
                    {v.spare.map(g => (
                      <div key={g.id} className="cv-mi"><span>{trx(g.title)}</span><button className="lnk" disabled={busy} onClick={() => act(() => api.restoreNode(line.id, g.id), tr('放上来了'))}>{tr('放上回路')}</button></div>
                    ))}
                  </>
                )}
                {v && v.gone.length > 0 && (
                  <>
                    <hr />
                    <h6>{tr('拿掉的节点')}</h6>
                    {v.gone.map(g => (
                      <div key={g.id} className="cv-mi"><span>{trx(g.title)}</span><button className="lnk" disabled={busy} onClick={() => act(() => api.restoreNode(line.id, g.id), tr('放回来了'))}>{tr('放回回路')}</button></div>
                    ))}
                  </>
                )}
                <hr />
                <h6>{tr('怎么用')}</h6>
                <ul className="cv-help">
                  <li>{tr('双击空白处，或右键：新建节点')}</li>
                  <li>{tr('从节点边上的圆点拖出：连线；拖到空白处：新建并连上')}</li>
                  <li>{tr('双击一条线：在线上写字；选中后按 Delete：断开')}</li>
                  <li>{tr('按住 Shift 拖动：框选多个节点一起移动；右键对齐')}</li>
                  <li>{tr('{0}C 复制、{0}X 剪切、{0}V 粘贴、{0}D 复制一份（任务和备注）；别处复制的文字粘贴成备注', MOD)}</li>
                  <li>{tr('Delete 删掉；{0}A 全选；方向键挪一小步（按住 Shift 挪一大步）；{0}Z 撤销', MOD)}</li>
                  <li>{tr('N 新任务、⇧N 新备注；F 适应窗口、0 回到 100%、+ − 缩放')}</li>
                  <li>{tr('按 / 叫出小助手，让它改回路、解释卡口为什么没放行')}</li>
                </ul>
              </>
            )}
          </Menu>
        </div>
      </header>

      <div className="cv-body">
        <div className={`cv-flow${lit ? ' has-dim' : ''}`} ref={wrap} onMouseMove={e => { pointer.current = { x: e.clientX, y: e.clientY }; }} onMouseLeave={() => { pointer.current = null; }} onDoubleClick={e => { if ((e.target as HTMLElement).classList.contains('react-flow__pane')) here(e.clientX, e.clientY, 'task'); }}>
          <OpsCtx.Provider value={ops}><BoxCtx.Provider value={boxes}>
            <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
              connectionMode={ConnectionMode.Loose} colorMode={dark ? 'dark' : 'light'} minZoom={floor * 0.98} maxZoom={1.8} translateExtent={extent} zoomOnDoubleClick={false}
              snapToGrid={prefs.snap} snapGrid={[22, 22]} deleteKeyCode={['Backspace', 'Delete']} multiSelectionKeyCode={['Meta', 'Control', 'Shift']} disableKeyboardA11y
              onBeforeDelete={async d => { // Delete on nodes goes through remove (it asks, and only takes the loop's own nodes off); lines go as they are
                const ns = d.nodes.filter(n => n.id !== NEW).map(n => n.data.n);
                if (ns.length) remove(ns);
                return !ns.length;
              }}
              onEdgesDelete={gone => gone.forEach(e => cut(e.id))} onEdgeDoubleClick={(_, e) => { if (!virtual(e.id)) setEditing(e.id); }}
              onNodeClick={(e, n) => { if (n.id === NEW) return; if (e.metaKey || e.ctrlKey || e.shiftKey) setSel(null); else pick(n.id); }}
              onSelectionStart={() => setSel(null)} onPaneClick={() => { setSel(null); setEditing(null); }} onMoveStart={e => { setCtx(null); if (e) auto.current = false; }}
              onNodeDragStart={(_, _n, all) => { dragging.current = true; setCtx(null); before.current = Object.fromEntries(all.map(n => [n.id, [Math.round(n.position.x), Math.round(n.position.y)]])); }}
              onNodeDragStop={onDragStop}
              onSelectionDragStart={(_, all) => { dragging.current = true; before.current = Object.fromEntries(all.map(n => [n.id, [Math.round(n.position.x), Math.round(n.position.y)]])); }}
              onSelectionDragStop={(e, all) => onDragStop(e, all[0], all)}
              onSelectionContextMenu={(e, all) => menuAt(e, several(all.filter(n => n.id !== NEW).map(n => n.data.n)))}
              onNodeMouseEnter={(_, n) => setHot(n.id)} onNodeMouseLeave={() => setHot(null)}
              onConnect={onConnect} onConnectEnd={onConnectEnd}
              onPaneContextMenu={e => menuAt(e, paneItems(e.clientX, e.clientY))}
              onNodeContextMenu={(e, n) => {
                if (n.id === NEW) return;
                const ns = picked();
                menuAt(e, ns.length > 1 && ns.some(x => x.id === n.id) ? several(ns) : nodeItems(n.data.n));
              }}
              onEdgeContextMenu={(e, edge) => { if (!virtual(edge.id)) menuAt(e, edgeItems(edge.id)); }}>
              <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} />
              {v && <Lanes v={v} />}
              <Controls showInteractive={false} />
              {prefs.map && <MiniMap pannable zoomable nodeClassName={n => `mm-${n.type}`} />}
              {prefs.legend && !report && <Legend onClose={() => setPrefs({ legend: false })} />}
              {prefs.hint && (
                <Panel position="top-center" className="cv-hint">
                  <span>{tr('双击空白处新建 · 从节点边上的圆点拖出连线 · 右键看能做什么')}</span>
                  <button className="ib" title={tr('知道了')} aria-label={tr('知道了')} onClick={() => setPrefs({ hint: false })}><Icon n="close" size={12} /></button>
                </Panel>
              )}
            </ReactFlow>
          </BoxCtx.Provider></OpsCtx.Provider>
          {v && report && <LoopReport v={v} onPick={pick} onClose={() => setReport(false)} toast={toast} />}
          {!v && <p className="cv-wait muted">{tr('加载中…')}</p>}
        </div>

        {v && draft && <NewForm key={`${draft.link}:${draft.seed?.title ?? ''}`} d={draft} v={v} busy={busy} onKind={kind => setDraft({ ...draft, kind })} onAdd={create} onCancel={() => setDraft(null)} />}
        {v && cur && !draft && (
          <Inspector key={cur.id} n={cur} v={v} r={r} line={line} wide={wide} onWide={() => setWide(w => !w)} busy={busy} act={act} onConsole={onConsole}
            onPick={pick} onCut={cut} onNew={k => beside(cur, k)} onFix={() => ops.fix(cur)} onDup={() => ops.dup(cur)} onDrop={() => drop(cur)} onClose={() => select(null)} />
        )}
      </div>

      {ctx && (
        <div className="cv-menu cv-ctx" style={{ left: ctx.x, top: ctx.y }} role="menu" onContextMenu={e => e.preventDefault()}>
          {ctx.items.map((it, i) => <Row key={i} it={it} close={() => setCtx(null)} />)}
        </div>
      )}
    </div>,
    document.querySelector('.proto') ?? document.body, // the app's root: where the look's colours are
  );
}
