// A project's research loop (研究回路) at /progress/<number>/loop (and the older /canvas): the whole window is a free
// graph framed by the parts of the project's research flow, the ones the console lists (flow.ts: 概览, 调研, 代码仓库,
// 实验, 数据, 论文, 员工). Each part is a block: a frame round the nodes that belong to it, with a header that says
// how the part stands and opens its panel in the console. In a block, the sentinels sit over the stages they watch,
// then the stages and the hard gates between them, then what was sent back (rework tickets, corrections) and your
// tasks and notes; the overview holds the soft spec, the hard clamp and the human gate. So the loop reads at two
// levels: far out, the blocks and what each says; closer, a block's own nodes. A block is where its nodes start and
// where 按分块规整 puts them back; nothing holds a node in one, a task or a note dropped in another frame joins that
// block, and a block dragged by its header moves whole. Lines say what they do: the flow (grey
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

import { query } from '../route';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Popover } from '@cloudflare/kumo';
import {
  Background, BackgroundVariant, BaseEdge, ConnectionMode, Controls, EdgeLabelRenderer, getBezierPath, MiniMap, Panel, Position,
  getViewportForBounds, ReactFlow, ReactFlowProvider, useEdgesState, useInternalNode, useNodesInitialized, useNodesState, useOnViewportChange, useReactFlow, ViewportPortal,
  type Connection, type Edge, type EdgeProps, type InternalNode, type NodeChange, type OnConnectEnd,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api, type CanvasEdge, type CanvasNode, type CanvasView, type NewNode, type ProjectCard, type TaskTo } from '../api';
import { PART, type FlowPart } from '../flow';
import { flash, usePanelNote } from '../console/page';
import { Icon, type IconName } from '../console/icons';
import { tr, trx } from '../i18n';
import { setSettings, useSettings } from '../settings';
import { follow, go, href } from '../route';
import { clip, Inspector, KIND, label, Mark, NewForm, orderOf, sentWord, WHO, type Draft, type Kind } from './CanvasSide';
import { status, type Act } from './Checks';
import { LoopReport } from './LoopReport';
import { LoopSummary, sizeOf, useCanvas, wanted } from './LoopCard';
import { MoreCtx, useMore } from './CanvasInfo';
import { kindOf, mine, nodeTypes, OpsCtx, type FNode, type Ops } from './LoopNodes';
import { around, crosses, halfway, rounded, type Box, type Pt } from './avoid';
import { blockPills, gateLook, needs, partLine, side } from './loop';
import type { ConsoleTarget } from './Project';

type FEdge = Edge<{ bow: boolean; arrow: boolean; tee: boolean; step: boolean; hidden: boolean; label: string; tag: string; tone: string; order?: boolean; can?: boolean }>; // order: an order line; can: between two tasks, so it can be one
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
    return n.kind === 'task' && !n.agent_id && ids.has(to) && !joined.has(`${n.id}>${to}`) ? [{ id: `as:${n.id}`, source: n.id, target: to }] : [];
  });
  return [...v.edges, ...extra];
}
const hay = (n: CanvasNode) => [label(n), n.text, n.id, n.check?.id, n.check && trx(n.check.text), n.to && WHO[n.to], n.gate?.name].filter(Boolean).join(' ').toLowerCase();
const typing = (e: Event) => !!(e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable=true]');

// the loop's switches, kept with the browser's settings (the settings page's 研究回路 section)
function usePrefs() {
  const s = useSettings();
  const p: Prefs = { map: s.cvMap, snap: s.cvSnapGrid, hint: s.cvHint, legend: s.cvLegend, lines: s.cvLines };
  const KEYS = { map: 'cvMap', snap: 'cvSnapGrid', hint: 'cvHint', legend: 'cvLegend', lines: 'cvLines' } as const;
  const set = (x: Partial<Prefs>) => setSettings(Object.fromEntries(Object.entries(x).map(([k, v]) => [KEYS[k as keyof Prefs], v])));
  return [p, set, s] as const;
}

// a correction a sentinel asks for: written here, for you to read before it goes out
function fixSeed(n: CanvasNode): Draft['seed'] {
  const c = n.check!, last = c.last;
  const lines = [trx(c.text)];
  if (last?.note) lines.push('', tr('负责人的判断：{0}', last.note));
  lines.push('', tr('按此判断纠偏，完成后说明修改内容。'));
  const to: TaskTo = c.stage === 'exp' ? 'coder' : ['write', 'review'].includes(c.stage) ? 'writer' : 'lead';
  return { title: `${tr('纠偏：')}${trx(c.title)}`.slice(0, 58), text: lines.join('\n'), to };
}

// ---------- lines: from rim to rim, wherever the two nodes are, and round the nodes in between ----------

const NONE: Box[] = [];
const BoxCtx = createContext<Box[]>(NONE); // where every node is, for the lines to keep off
type Rect = { x: number; y: number; w: number; h: number };
const FrameCtx = createContext<Map<string, Rect>>(new Map()); // the frame of the block each node is in, for the flow to go round
const boxOf = (n: InternalNode): Box => ({ id: n.id, x: n.internals.positionAbsolute.x, y: n.internals.positionAbsolute.y, w: n.measured.width ?? 0, h: n.measured.height ?? 0 });

const centre = (n: InternalNode) => ({ x: n.internals.positionAbsolute.x + (n.measured.width ?? 0) / 2, y: n.internals.positionAbsolute.y + (n.measured.height ?? 0) / 2 });
function rim(n: InternalNode, to: { x: number; y: number }) {
  const c = centre(n), w = (n.measured.width ?? 0) / 2 + 3, h = (n.measured.height ?? 0) / 2 + 3, dx = to.x - c.x, dy = to.y - c.y;
  if (!dx && !dy) return { ...c, side: Position.Bottom };
  const sx = dx ? w / Math.abs(dx) : Infinity, sy = dy ? h / Math.abs(dy) : Infinity, s = Math.min(sx, sy);
  return { x: c.x + dx * s, y: c.y + dy * s, side: sx < sy ? (dx > 0 ? Position.Right : Position.Left) : dy > 0 ? Position.Bottom : Position.Top };
}
const TURN: Record<Position, number> = { [Position.Left]: 0, [Position.Top]: 90, [Position.Right]: 180, [Position.Bottom]: 270 };
// the flow's way between two blocks in different rows (see Wire), or null when a node stands in it
function between(ba: Box, bb: Box, ca: Pt, cb: Pt, fa: Rect, fb: Rect, others: Box[], frames: Map<string, Rect>) {
  let pts: Pt[], side: Position;
  if (fb.y >= fa.y + fa.h) {
    const px = ca.x + Math.min(40, ba.w / 4), gy = fb.y - 18, q = { x: bb.x - 3, y: cb.y };
    const first = !others.some(x => frames.get(x.id) === fb && x.x < bb.x && x.y < bb.y + bb.h && x.y + x.h > bb.y); // nothing left of it in its block
    const xl = first ? fb.x - 28 : bb.x - 40;
    pts = [{ x: px, y: ba.y + ba.h + 3 }, { x: px, y: gy }, { x: xl, y: gy }, { x: xl, y: q.y }, q];
    side = Position.Left;
  } else {
    const qx = cb.x - Math.min(40, bb.w / 4), gy = fb.y + fb.h + 18;
    pts = [{ x: ca.x, y: ba.y - 3 }, { x: ca.x, y: gy }, { x: qx, y: gy }, { x: qx, y: bb.y + bb.h + 3 }];
    side = Position.Bottom;
  }
  if (crosses(pts, others, 6)) return null;
  return { pts, side, lx: (pts[1].x + pts[2].x) / 2, ly: pts[1].y };
}

function Wire({ id, source, target, data, selected }: EdgeProps<FEdge>) {
  const a = useInternalNode(source), b = useInternalNode(target);
  const o = useContext(OpsCtx), boxes = useContext(BoxCtx), frames = useContext(FrameCtx);
  if (!a || !b) return null;
  const ca = centre(a), cb = centre(b), fa = frames.get(source), fb = frames.get(target);
  let path: string, lx: number, ly: number, end: { x: number; y: number }, turn: number, drawn: Pt[]; // drawn: the line as points, to see what it passes through
  let gutter = false; // a line laid along the gaps between the blocks keeps off the nodes as it is
  const ba = boxOf(a), bb = boxOf(b);
  // the flow from a block to one in another row keeps to the gaps. Going down: out of the bottom, along the gap over
  // the other row, down beside the stage it goes to and in from the left. Going up: out of the top, along the gap under
  // the other row and in from below. The two keep to their own half of the gap and of the node, so a stage the flow
  // comes up to and leaves again (立项编队) has them side by side.
  const far = data?.step && fa && fb && fa !== fb && (fb.y >= fa.y + fa.h || fa.y >= fb.y + fb.h) ? between(ba, bb, ca, cb, fa, fb, boxes.filter(x => x.id !== source && x.id !== target), frames) : null;
  if (far) {
    path = rounded(far.pts, 14); lx = far.lx; ly = far.ly; end = far.pts[far.pts.length - 1]; turn = TURN[far.side]; drawn = far.pts; gutter = true;
  } else if (data?.bow) { // a loop back, or the way back between two nodes already joined: an arc beside the straight line
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
  const others = data?.hidden || gutter ? [] : boxes.filter(x => x.id !== source && x.id !== target);
  if (others.length && crosses(drawn, others, 12)) {
    const way = around(ca, cb, others);
    if (way) {
      const inA = (p: Pt) => p.x > ba.x - 4 && p.x < ba.x + ba.w + 4 && p.y > ba.y - 4 && p.y < ba.y + ba.h + 4, inB = (p: Pt) => p.x > bb.x - 4 && p.x < bb.x + bb.w + 4 && p.y > bb.y - 4 && p.y < bb.y + bb.h + 4;
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
            <input className="cv-el edit nodrag nopan" style={at} autoFocus defaultValue={text} maxLength={40} placeholder={tr('连线含义')}
              onBlur={e => o.relabel(id, e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') { e.stopPropagation(); o.edit(null); } }} />
          ) : (
            <div className={`cv-el nodrag nopan${selected ? ' on' : ''}${!text && data?.tag ? ` tag t-${data.tone}` : ''}`} style={at} onDoubleClick={() => o.edit(id)}>
              {(text || data?.tag) && <span>{!text && (data?.tone === 'lock' || data?.tone === 'hard') && <Icon n="lock" size={10} />}{text || data?.tag}</span>}
              {selected && data?.can && <button className={data.order ? 'on' : ''} title={data.order ? tr('改为普通连线，仅提供上下文') : tr('设为顺序线，前序完成后派发后续')} aria-label={data.order ? tr('改为普通连线，仅提供上下文') : tr('设为顺序线，前序完成后派发后续')} aria-pressed={!!data.order} onClick={() => o.order(id, { order: !data.order })}><Icon n="right" size={12} /></button>}
              {selected && data?.order && <button title={tr('调换先后')} aria-label={tr('调换先后')} onClick={() => o.order(id, { flip: true })}><Icon n="refresh" size={12} /></button>}
              {selected && <button title={tr('添加连线文字')} aria-label={tr('添加连线文字')} onClick={() => o.edit(id)}><Icon n="compose" size={12} /></button>}
              {selected && <button className="danger" title={tr('断开连线')} aria-label={tr('断开连线')} onClick={() => o.cut(id)}><Icon n="close" size={12} /></button>}
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
      data: { n: { id: NEW, kind: 'note', x: draft.x, y: draft.y, mod: 'overview', title: KIND[draft.kind] } } });
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
      return { ...none, cls: `w-flow${lock ? ' lock' : ok ? ' ok' : g && gateLook(g) === 'warn' ? ' warn' : ''}`, arrow: true, step: true, tag: lock ? tr('已锁定') : '', tone: lock ? 'lock' : '' };
    }
    case 'watch': { // a sentinel that is content keeps its line to itself
      const k = a.check?.on ? status(a.check) : 'none';
      return { ...none, cls: `w-watch v-${k}`, arrow: true, quiet: !['warn', 'fail'].includes(k) };
    }
    case 'spec': return { ...none, cls: 'w-spec', arrow: true, quiet: true };
    case 'clamp': return { ...none, cls: 'w-clamp', tee: true, quiet: true };
    case 'escalate': {
      // lit when what waits at the human gate came up from this stage's gate, not for whatever else waits there
      const human = b.kind === 'human' ? b : a, from = b.kind === 'human' ? a : b;
      const on = !!human.items?.some(i => i.kind === 'escalated' && i.gate === from.ref);
      return { ...none, cls: `w-esc${on ? ' on' : ''}`, arrow: true, quiet: !on };
    }
    case 'member': return { ...none, cls: 'w-member' };
    case 'hard_loop': {
      const t = task ?? a, head = a.kind === 'gate';
      const tag = head ? (t.converged ? tr('✓ {0} 轮收敛', t.round || 1) : tr('未通过，退回修改 · 第 {0} 轮', t.round || 1)) : '';
      return { ...none, cls: `w-hard${t.converged ? ' old' : t.status === 'sent' ? ' run' : ''}`, arrow: true, bow: true, tag, tone: t.converged ? 'old' : 'hard' };
    }
    case 'soft_loop': {
      const t = task ?? b;
      return { ...none, cls: `w-soft t-${t.status}${t.status === 'done' ? ' old' : ''}`, arrow: true, bow: true, tag: a.kind === 'soft' ? tr('! 软巡检纠偏') : '', tone: 'soft' };
    }
    case 'order': { // the first before the second: how the first stands says whether the second may go
      const held = b.status === 'queued', stuck = a.status === 'blocked', again = !!a.stale;
      const tag = !held ? '' : stuck ? tr('前序受阻') : again ? tr('前序待复核') : tr('等待前序');
      return { ...none, cls: `w-order t-${a.status}${again ? ' stale' : ''}${held ? ' held' : ''}`, arrow: true, tag, tone: stuck ? 'bad' : again ? 'soft' : 'wait' };
    }
    default: {
      const cls = a.kind === 'note' || b.kind === 'note' ? 'w-note' : task ? `w-task t-${task.status}` : a.kind === 'info' || b.kind === 'info' ? 'w-info' : 'w-link';
      return { ...none, cls };
    }
  }
}

const ordered = (n: CanvasNode) => n.kind === 'task' && n.loop !== 'hard'; // a task whose turn you decide: a rework ticket goes by its gate
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
      data: { bow: l.bow || twin, arrow: l.arrow, tee: l.tee, step: l.step, hidden, label: e.label ?? '', tag: l.tag, tone: l.tone, order: e.kind === 'order', can: (!e.kind || e.kind === 'order') && ordered(a) && ordered(b) } }];
  });
  if (draft?.link && by.has(draft.link)) out.push({ id: NEW, source: draft.link, target: NEW, type: 'wire', className: 'w-task t-draft', selectable: false, data: blank });
  return out;
}

// ---------- the blocks: the parts of the research flow, each a frame round its nodes ----------

// A frame's margin round its nodes and the room its header takes, and the gap between two frames: canvas.py lays the
// blocks out with the same three (_fit, _block_at).
const PAD = 28, HEAD = 64, BGAP = 56;
interface Frame { key: FlowPart; x: number; y: number; w: number; h: number; ns: CanvasNode[] }
// Each block's frame: round its slot, which the server keeps round its nodes (a block is as tall as what is in it, and
// the rows under it make room), and round its nodes where they are now (`live`) while one is being dragged.
function framesOf(v: CanvasView, live?: Map<string, Box>): Frame[] {
  return v.blocks.map(b => {
    const ns = v.nodes.filter(n => n.mod === b.key);
    const at = [{ x: b.x, y: b.y, w: b.w, h: b.h }, ...(live ? ns.flatMap(n => live.get(n.id) ?? []) : [])];
    const x0 = Math.min(...at.map(p => p.x)), y0 = Math.min(...at.map(p => p.y));
    return { key: b.key, x: x0 - PAD, y: y0 - HEAD, w: Math.max(...at.map(p => p.x + p.w)) - x0 + 2 * PAD, h: Math.max(...at.map(p => p.y + p.h)) - y0 + HEAD + PAD, ns };
  });
}

// The block a task or a note put at a point joins: the one whose frame the point is in, or the nearest. Under a frame,
// down to where the next one's nodes start, is still the upper block's: where its next row of tasks goes (canvas.py
// decides the same way, _block_at).
function blockAt(frames: Frame[], x: number, y: number): FlowPart {
  const far = (f: Frame) => Math.max(f.x - x, 0, x - f.x - f.w) ** 2 + Math.max(f.y + HEAD - 16 - y, 0, y - (f.y + f.h + BGAP + HEAD - 16)) ** 2;
  return frames.reduce((a, b) => (far(b) < far(a) ? b : a)).key;
}

// The frames under the nodes. A header says how the part stands (its stages, gates, sentinels and tasks, and what the
// project has there), zooms to the block on a click and opens the part's panel.
function Blocks({ v, r, frames, into, onShow, onOpen }: {
  v: CanvasView; r: ProjectCard; frames: Frame[]; into: FlowPart | null; onShow: (key: FlowPart) => void; onOpen: (key: FlowPart) => void;
}) {
  return (
    <ViewportPortal>
      <div className="cv-blocks">
        {frames.map(f => {
          const p = PART[f.key], pills = blockPills(f.key, f.ns), line = partLine(f.key, r, v);
          return (
            <section key={f.key} className={`cv-block b-${f.key}${into === f.key ? ' into' : ''}`} style={{ transform: `translate(${f.x}px, ${f.y}px)`, width: f.w, height: f.h }} aria-label={p.name}>
              <header className="nopan nodrag" onClick={() => onShow(f.key)} title={tr('点击缩放至「{0}」', p.name)}>
                <b><Icon n={p.icon} size={15} />{p.name}</b>
                <span>
                  {pills.map(x => <em key={x.text} className={`t-${x.tone}`}>{x.text}</em>)}
                  {line && <small className={pills.length ? '' : 'only'}>{line}</small>}
                </span>
                <button className="ib" onClick={e => { e.stopPropagation(); onOpen(f.key); }} title={tr('在中控屏中打开「{0}」', p.name)} aria-label={tr('在中控屏中打开「{0}」', p.name)}>
                  <Icon n="board" size={13} />
                </button>
              </header>
            </section>
          );
        })}
      </div>
    </ViewportPortal>
  );
}

// two shapes and four colours; a colour means the same on a node and on a line
function Legend({ onClose }: { onClose: () => void }) {
  return (
    <Panel position="bottom-left" className="cv-legend">
      <header><b>{tr('图例')}</b><button className="ib" title={tr('收起')} aria-label={tr('收起')} onClick={onClose}><Icon n="close" size={12} /></button></header>
      <p><span><i className="cv-dia" />{tr('卡口：代码检查')}</span><span><i className="cv-ring2" />{tr('巡检：负责人判断')}</span></p>
      <p><span><i className="lg c-pass" />{tr('通过')}</span><span><i className="lg c-warn" />{tr('需关注')}</span><span><i className="lg c-bad" />{tr('未通过，退回修改')}</span><span><i className="lg c-wait" />{tr('尚未检查或等待前序')}</span></p>
      <p><span><i className="lg-order" />{tr('顺序线：前序任务完成后，才能派发后续任务')}</span></p>
      <p><span><i className="lg-block" />{tr('分块：与中控屏「研究流程」的各项一一对应，高度随内容伸缩')}</span></p>
      <p className="more">{tr('节点与连线使用同套配色。其余连线默认折叠，悬停或点击节点即可显示。')}</p>
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
      <input id="cv-find" ref={box} value={q} placeholder={tr('查找节点')} aria-label={tr('查找节点')} autoComplete="off"
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
                <Mark n={n} /><span>{label(n)}</span>{needs(n) && <i className="cv-need" title={tr('待处理')} />}<small>{kindOf(n)}</small>
              </button>
            </li>
          ))}
          {!list.length && <li className="muted small">{tr('无匹配节点')}</li>}
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
  const [v, setV, reload, loadError] = useCanvas(line.id);
  const more = useMore(line.id, `${line.stages.map(x => x.status).join()}:${r.jobs.done ?? 0}:${r.jobs.failed ?? 0}`);
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
  const [prefs, setPrefs, cs] = usePrefs();
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
  const adapt = useRef(cs.cvAdapt);
  adapt.current = cs.cvAdapt;
  const scale = (zoom: number) => {
    const el = wrap.current;
    if (!el) return;
    el.style.setProperty('--zr', zoom.toFixed(3)); // the real zoom, for what must stay one pixel wide
    if (!adapt.current) zoom = 1; // nodes as they are at 100%, whatever the zoom
    el.style.setProperty('--z', zoom.toFixed(3));
    const was = face.current;
    const now = was === 'near' ? (zoom < 0.45 ? 'far' : zoom < 0.7 ? 'mid' : 'near')
      : was === 'mid' ? (zoom < 0.45 ? 'far' : zoom > 0.75 ? 'near' : 'mid')
        : zoom > 0.75 ? 'near' : zoom > 0.5 ? 'mid' : 'far';
    face.current = now;
    if (el.dataset.lod !== now) el.dataset.lod = now;
  };
  useOnViewportChange({ onChange: vp => scale(vp.zoom) });
  useEffect(() => { scale(rf.getZoom()); }, [cs.cvAdapt]); // eslint-disable-line react-hooks/exhaustive-deps
  // the whole loop: its blocks, wherever their nodes have been dragged
  const frame = useMemo(() => {
    if (!v?.nodes.length) return null;
    const fs = framesOf(v);
    const x0 = Math.min(...fs.map(f => f.x)) - 36, x1 = Math.max(...fs.map(f => f.x + f.w)) + 36;
    const y0 = Math.min(...fs.map(f => f.y)) - 30, y1 = Math.max(...fs.map(f => f.y + f.h)) + 30;
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
  // ---------- the wheel ----------
  // Zooming is done here, not by React Flow. ⌘ + wheel (Ctrl elsewhere), a trackpad pinch (which the browser sends
  // as a wheel with ctrlKey) and, when the setting says the wheel zooms, a plain wheel, zoom the loop about the
  // pointer. The page takes these over the whole loop, so the browser never zooms the page instead. A step follows
  // how far the wheel turned but is never more than STEP (about 8%, times the 滚轮缩放速度 setting): a notch of a
  // mouse wheel, or a fast spin the system speeds up, moves the zoom one small step, not a jump. A plain wheel is left
  // to React Flow, which pans.
  const page = useRef<HTMLDivElement>(null);
  const zooming = useRef({ min: 0.1, max: 1.8, extent, w: 0, h: 0, speed: 1, plain: false });
  zooming.current = { min: floor * 0.98, max: 1.8, extent, w: box.w, h: box.h, speed: cs.zoomSpeed || 1, plain: cs.cvScroll === 'zoom' };
  useEffect(() => {
    const el = page.current;
    if (!el) return;
    const STEP = 0.08, PINCH = 0.0139, WHEEL = 0.0014; // the last two as React Flow had them: a slow gesture feels as it did
    const wheel = (e: WheelEvent) => {
      const at = e.target instanceof Element ? e.target : null, graph = at?.closest('.react-flow__renderer');
      const key = e.metaKey || e.ctrlKey, o = zooming.current;
      if (!key && !(graph && o.plain)) return;
      e.preventDefault();
      if (!graph || at?.closest('.nowheel') || !wrap.current) return;
      e.stopPropagation();
      const dy = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 800 : 1);
      if (!dy) return;
      const step = Math.min(STEP, Math.abs(dy) * (e.ctrlKey ? PINCH : WHEEL)) * o.speed;
      const v0 = rf.getViewport(), zoom = Math.max(o.min, Math.min(o.max, v0.zoom * Math.exp(-Math.sign(dy) * step)));
      if (zoom === v0.zoom) return;
      const r = wrap.current.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      let x = px - ((px - v0.x) * zoom) / v0.zoom, y = py - ((py - v0.y) * zoom) / v0.zoom;
      if (o.extent && o.w && o.h) { // inside the same bounds a drag keeps to (d3-zoom's constrain)
        const [[x0, y0], [x1, y1]] = o.extent;
        const pull = (lo: number, hi: number) => (hi > lo ? (lo + hi) / 2 : Math.min(0, lo) || Math.max(0, hi));
        x += pull(-x / zoom - x0, (o.w - x) / zoom - x1) * zoom;
        y += pull(-y / zoom - y0, (o.h - y) / zoom - y1) * zoom;
      }
      auto.current = false;
      rf.setViewport({ x, y, zoom });
    };
    el.addEventListener('wheel', wheel, { passive: false, capture: true });
    return () => el.removeEventListener('wheel', wheel, { capture: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const act: Act = async (fn, done) => {
    setBusy(true);
    try {
      const x = await fn();
      if (x && typeof x === 'object' && 'nodes' in x) setV(x as CanvasView); else reload();
      const said = typeof done === 'function' ? done(x) : done;
      if (said) toast(said);
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  // ---------- what the keyboard and the menus share ----------
  // what can be taken back, newest last: each is how to put things as they were
  const undos = useRef<{ what: string; run: () => Promise<unknown> }[]>([]);
  const remember = (what: string, run: () => Promise<unknown>) => { undos.current = [...undos.current.slice(-39), { what, run }]; };
  const undo = () => {
    const u = undos.current.pop();
    if (u) act(u.run, tr('已撤销：{0}', u.what)); else toast(tr('暂无可撤销操作'));
  };
  // where nodes are: here at once, on the server after
  const before = useRef<Spots>({}), saving = useRef<{ at: Spots; timer: number } | null>(null);
  const put = (at: Spots) => {
    Object.assign(moved.current, at);
    setV(x => x && { ...x, nodes: x.nodes.map(n => (at[n.id] ? { ...n, x: at[n.id][0], y: at[n.id][1] } : n)) });
  };
  const settled = (at: Spots) => { for (const k of Object.keys(at)) if (moved.current[k] === at[k]) delete moved.current[k]; };
  // What the server answers once nodes are where they were put: a task or a note dropped in another block's frame
  // has joined it, the blocks are fitted round their nodes again, and the nodes that went with their block (the rows
  // under one that grew) are where it says.
  const settle = (x: Awaited<ReturnType<typeof api.moveNodes>> | undefined, say = true) => {
    if (!x) return;
    const went = x.at ?? {}, slots = x.blocks ?? {}, mods = x.mods ?? {};
    Object.assign(moved.current, went);
    setV(y => y && { ...y, nodes: y.nodes.map(n => (went[n.id] || mods[n.id] ? { ...n, x: went[n.id]?.[0] ?? n.x, y: went[n.id]?.[1] ?? n.y, mod: mods[n.id] ?? n.mod } : n)),
      blocks: y.blocks.map(b => { const t = slots[b.key]; return t ? { ...b, x: t[0], y: t[1], w: t[2], h: t[3] } : b; }) });
    for (const k of Object.keys(went)) if (moved.current[k] === went[k]) delete moved.current[k];
    const ids = Object.keys(mods);
    if (say && ids.length) toast(tr('已归入「{0}」分块', PART[mods[ids[0]]].name));
  };
  const store = (at: Spots) => api.moveNodes(line.id, at).then(x => settle(x)).catch(e => toast((e as Error).message)).finally(() => settled(at));
  const place = (at: Spots) => { put(at); return store(at); };
  // The whole layout put back as it was: every node and every block's slot. This is how a move is taken back, since
  // moving one node can move the rows under it.
  const placeAll = (at: Spots, slots: Record<string, number[]>) => {
    put(at);
    setV(x => x && { ...x, blocks: x.blocks.map(b => { const t = slots[b.key]; return t ? { ...b, x: t[0], y: t[1], w: t[2], h: t[3] } : b; }) });
    return api.moveNodes(line.id, at, slots).then(x => settle(x, false)).catch(e => toast((e as Error).message)).finally(() => settled(at));
  };
  const keep = () => {
    const was = spots(v?.nodes ?? []), slots = Object.fromEntries((v?.blocks ?? []).map(b => [b.key, [b.x, b.y, b.w, b.h]]));
    return async () => { await placeAll(was, slots); };
  };
  // the arrows: a step at a time, saved once the keys rest, taken back as one move
  const nudge = (ns: CanvasNode[], dx: number, dy: number) => {
    if (!saving.current) remember(tr('移动'), keep());
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
    if (!quiet) toast(own.length ? tr('已复制 {0} 个节点', own.length) : tr('已复制文本（仅任务与备注可粘贴为新节点）'));
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
    make(h.items.map(i => ({ kind: i.kind, x: o.x + i.dx, y: o.y + i.dy, title: i.title, text: i.text, to: i.to })), tr('粘贴'), tr('已粘贴 {0} 个节点', h.items.length));
    return true;
  };
  const pasteText = (text: string, at?: { x: number; y: number }) => {
    const o = landing(at);
    make([{ kind: 'note', x: o.x, y: o.y, text: text.trim().slice(0, 2000) }], tr('粘贴'), tr('已粘贴为备注'));
  };
  const pasteAny = async (at?: { x: number; y: number }) => { // from a menu, where there is no paste event to read
    if (paste(at)) return;
    try {
      const t = await navigator.clipboard.readText();
      if (t.trim()) pasteText(t, at); else toast(tr('剪贴板中暂无可粘贴内容'));
    } catch { toast(tr('无法读取剪贴板，按 {0}V 粘贴', MOD)); }
  };
  const dup = (ns: CanvasNode[]) => {
    const own = ns.filter(copyable);
    if (!own.length) { toast(tr('仅任务与备注可复制为新节点')); return; }
    const one = own.length === 1;
    make(own.map(n => ({ kind: n.kind as 'task' | 'note', x: n.x + (one ? 36 : 44), y: n.y + (one ? sizeOf(n)[1] + 28 : 44), title: n.title, text: n.text, to: n.to })),
      tr('创建副本'), tr('已复制 {0} 个节点', own.length));
  };
  const snip = (ns: CanvasNode[]) => {
    const own = ns.filter(copyable);
    if (!own.length) { toast(tr('仅任务与备注可剪切')); return; }
    copy(own, true);
    remove(own, false, tr('已剪切 {0} 个节点，{1}V 粘贴', own.length, MOD));
  };
  // several nodes in a line
  const align = (ns: CanvasNode[], how: 'left' | 'top' | 'row' | 'column') => {
    if (ns.length < 2) return;
    const by = how === 'left' || how === 'column' ? 'y' : 'x', sorted = [...ns].sort((a, b) => a[by] - b[by]);
    const first = sorted[0], last = sorted[sorted.length - 1], k = sorted.length - 1;
    const at: Spots = Object.fromEntries(sorted.map((n, i) => [n.id,
      how === 'left' ? [Math.min(...ns.map(x => x.x)), n.y] : how === 'top' ? [n.x, Math.min(...ns.map(x => x.y))]
        : how === 'row' ? [Math.round(first.x + ((last.x - first.x) * i) / k), n.y] : [n.x, Math.round(first.y + ((last.y - first.y) * i) / k)]]));
    remember(tr('对齐'), keep());
    place(at);
  };
  const centre = (n: CanvasNode) => {
    auto.current = false;
    rf.setCenter(n.x + sizeOf(n)[0] / 2, n.y + sizeOf(n)[1] / 2, { zoom: Math.max(rf.getZoom(), 0.8), duration: 300 });
  };
  const zoomTo = (how: 'in' | 'out' | 'one') => {
    auto.current = false;
    if (how === 'one') rf.zoomTo(1, { duration: 200 }); else if (how === 'in') rf.zoomIn({ duration: 150 }); else rf.zoomOut({ duration: 150 });
  };

  const boxes = useMemo<Box[]>(() => nodes.filter(n => n.id !== NEW).map(n => ({ id: n.id, x: n.position.x, y: n.position.y,
    w: n.measured?.width ?? sizeOf(n.data.n)[0], h: n.measured?.height ?? sizeOf(n.data.n)[1] })), [nodes]);
  // the blocks' frames, round the nodes where they are now
  const frames = useMemo(() => (v ? framesOf(v, new Map(boxes.map(b => [b.id, b]))) : []), [v, boxes]);
  const frameOf = useMemo(() => new Map(frames.flatMap(f => f.ns.map(n => [n.id, f as Rect] as const))), [frames]);
  // the block a task or a note being dragged would join if it were dropped now
  const [into, setInto] = useState<FlowPart | null>(null);
  const aim = (moving: FNode[]) => {
    const free = moving.map(n => n.data.n).filter(n => (n.kind === 'task' || n.kind === 'note') && !n.loop);
    if (!v || !free.length) { if (into) setInto(null); return; }
    const me = moving.find(n => n.id === free[0].id)!, [w, h] = sizeOf(free[0]);
    const to = blockAt(framesOf(v), me.position.x + (me.measured?.width ?? w) / 2, me.position.y + h / 2);
    const next = to !== free[0].mod ? to : null;
    if (next !== into) setInto(next);
  };
  const showBlock = (key: FlowPart) => {
    const f = frames.find(x => x.key === key);
    if (!f) return;
    auto.current = false;
    rf.fitBounds({ x: f.x, y: f.y, width: f.w, height: f.h }, { padding: 0.08, duration: 300 });
  };
  // dragging one node: its edges and middle lines snap to the other nodes' within a few pixels, with a guide drawn
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  const onNodes = (changes: NodeChange<FNode>[]) => {
    const moving = changes.filter(c => c.type === 'position' && c.dragging && c.position);
    if (!cs.cvGuides || moving.length !== 1) {
      if (guides.x != null || guides.y != null) setGuides({ x: null, y: null });
      onNodesChange(changes);
      return;
    }
    const c = moving[0] as Extract<NodeChange<FNode>, { type: 'position' }>, me = boxes.find(b => b.id === c.id);
    if (!me || !c.position) { onNodesChange(changes); return; }
    const reach = cs.cvGuideDist / rf.getZoom(), others = boxes.filter(b => b.id !== c.id);
    const best = (at: number, size: number, lines: (b: Box) => number[]) => {
      let hit: { to: number; line: number } | null = null, gap = reach;
      for (const off of [0, size / 2, size]) for (const b of others) for (const l of lines(b)) {
        const d = Math.abs(at + off - l);
        if (d < gap) { gap = d; hit = { to: l - off, line: l }; }
      }
      return hit;
    };
    const sx = best(c.position.x, me.w, b => [b.x, b.x + b.w / 2, b.x + b.w]), sy = best(c.position.y, me.h, b => [b.y, b.y + b.h / 2, b.y + b.h]);
    setGuides({ x: sx?.line ?? null, y: sy?.line ?? null });
    onNodesChange(changes.map(x => (x === c ? { ...c, position: { x: sx?.to ?? c.position!.x, y: sy?.to ?? c.position!.y } } : x)));
  };
  // several nodes laid out in rows, about as many across as down, in the order they read
  const grid = (ns: CanvasNode[]) => {
    if (ns.length < 2) return;
    const sorted = [...ns].sort((a, b) => a.y - b.y || a.x - b.x), across = Math.ceil(Math.sqrt(ns.length));
    const w = Math.max(...ns.map(n => sizeOf(n)[0])), h = Math.max(...ns.map(n => sizeOf(n)[1]));
    const x0 = Math.min(...ns.map(n => n.x)), y0 = Math.min(...ns.map(n => n.y));
    const at: Spots = Object.fromEntries(sorted.map((n, i) => [n.id, [x0 + (i % across) * (w + 40), y0 + Math.floor(i / across) * (h + 40)]]));
    remember(tr('网格排列'), keep());
    place(at);
  };

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
  const beside = (n: CanvasNode, kind: Kind, seed?: Draft['seed']) => begin({ kind, x: n.x + sizeOf(n)[0] + 70, y: n.y + 50, link: n.id, seed });
  async function create(b: NewNode) {
    setBusy(true);
    try {
      const x = await api.addNode(line.id, b);
      setV(x);
      setDraft(null);
      if (x.added) setSel(x.added);
      const id = x.added;
      if (id && !b.send) remember(tr('新建节点'), () => api.dropNode(line.id, id));
      const made = x.nodes.find(n => n.id === id);
      toast(b.kind === 'task' && b.send ? (made?.status === 'queued' ? tr('已添加并排队，轮到时自动派发') : tr('已添加并派发')) : tr('加上了'));
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  }
  // one node of your own to delete asks first; what Papertown put on the loop is only taken off, and can come back
  const remove = (ns: CanvasNode[], ask = true, done?: string) => {
    if (!ns.length) return;
    const own = ns.filter(mine), rest = ns.filter(n => !mine(n));
    if (ask && own.length && !confirm(own.length === 1 ? tr('删除「{0}」？', label(own[0])) : tr('删除这 {0} 个任务、备注或自定义检查？', own.length))) return;
    act(async () => { let x: CanvasView | undefined; for (const n of ns) x = await api.dropNode(line.id, n.id); return x; },
      done ?? (rest.length ? tr('已移除，可在「更多」中恢复') : tr('删掉了'))).then(() => setSel(s => (s && ns.some(n => n.id === s) ? null : s)));
    if (rest.length) remember(tr('移除节点'), async () => { let x: CanvasView | undefined; for (const n of rest) x = await api.restoreNode(line.id, n.id); return x; });
  };
  const drop = (n: CanvasNode) => remove([n]);
  const cut = (edgeId: string) => {
    const e = v?.edges.find(x => x.id === edgeId);
    if (!e || virtual(edgeId)) return;
    act(() => api.disconnect(line.id, edgeId));
    if (!e.kind || e.kind === 'order') remember(tr('断开连线'), async () => { // only a line of your own comes back as it was
      let x = await api.connect(line.id, e.source, e.target);
      const back = x.edges.find(y => y.source === e.source && y.target === e.target);
      if (back && (back.kind === 'order') !== (e.kind === 'order')) x = await api.orderEdge(line.id, back.id, { order: e.kind === 'order' });
      return e.label && back ? api.labelEdge(line.id, back.id, e.label) : x;
    });
  };
  const gate = (stage: string, what: 'open' | 'close' | 'rework') =>
    act(() => api.gateAct(line.id, stage, what), what === 'rework' ? tr('修补单已派发') : undefined).then(() => { if (what !== 'rework') setTimeout(() => fit(), 80); });
  const ops: Ops = {
    busy, agents: v?.agents ?? null, r, v, editing, edit: setEditing, cut, gate,
    order: (edgeId, b) => {
      const was = v?.edges.find(e => e.id === edgeId);
      act(() => api.orderEdge(line.id, edgeId, b), b.flip ? tr('已调换先后') : b.order ? tr('已设为顺序线：前序完成后派发后续') : tr('已改为普通连线'));
      if (was) remember(b.flip ? tr('调换先后') : tr('修改连线类型'), () => api.orderEdge(line.id, edgeId, b.flip ? { flip: true } : { order: was.kind === 'order' }));
    },
    relabel: (edgeId, text) => {
      setEditing(null);
      const was = v?.edges.find(e => e.id === edgeId)?.label ?? '';
      if (was !== text.trim()) { act(() => api.labelEdge(line.id, edgeId, text.trim())); remember(tr('改线上的字'), () => api.labelEdge(line.id, edgeId, was)); }
    },
    fix: n => {
      if (n.kind === 'gate' && n.gate) gate(n.gate.stage, 'rework');
      else if (n.kind === 'hard' && n.check?.stage) gate(n.check.stage, 'rework');
      else if (n.check?.kind === 'soft') begin({ kind: 'task', x: n.x, y: n.y + 280, link: n.id, seed: fixSeed(n) }); // under the stage it watches, in its block
    },
    ask: n => { if (n.check) act(() => api.askCheck(line.id, n.check!.id), tr('已发送至负责人，判断完成后将在此显示')); },
    send: (n, chain) => { act(() => api.sendNode(line.id, n.id, !!chain), sentWord(n.id, n.to ?? 'lead')); },
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
      const a = x.nodes.find(n => n.id === e?.source), b = x.nodes.find(n => n.id === e?.target);
      if (e && a && b && ordered(a) && ordered(b)) toast(e.kind === 'order' ? tr('顺序线：「{0}」完成后才能派发「{1}」。选中该连线可改为普通连线', clip(label(a), 12), clip(label(b), 12)) : tr('该连线会使先后顺序成环，已作为普通连线保留'));
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
    setInto(null);
    const real = all.filter(n => n.id !== NEW);
    const ghost = all.find(n => n.id === NEW);
    if (ghost) setDraft(d => d && { ...d, x: Math.round(ghost.position.x), y: Math.round(ghost.position.y) });
    if (!real.length) return;
    const at: Spots = Object.fromEntries(real.map(n => [n.id, [Math.round(n.position.x), Math.round(n.position.y)]]));
    const was = Object.fromEntries(Object.entries(before.current).filter(([id]) => at[id]));
    if (Object.keys(was).some(id => was[id][0] !== at[id][0] || was[id][1] !== at[id][1])) remember(tr('移动'), keep());
    place(at);
  };
  const tidy = () => {
    if (!confirm(tr('按分块规整：各分块内的资料卡、工序、卡口与巡检归位，修补单、任务与备注排列在其下方。连线保持不变。'))) return;
    remember(tr('按分块规整'), keep());
    act(() => api.tidyCanvas(line.id)).then(() => setTimeout(() => fit(), 60));
  };
  const runAll = () => act(() => api.runChecks(line.id), tr('检查完毕'));

  // right-click: what can be done with the thing under the pointer
  const menuAt = (e: { clientX: number; clientY: number; preventDefault: () => void }, items: Item[]) => {
    e.preventDefault();
    const tall = Math.min(items.filter(Boolean).length * 33 + items.filter(x => !x).length * 9 + 14, window.innerHeight - 24);
    setCtx({ x: Math.min(e.clientX, window.innerWidth - 262), y: Math.max(12, Math.min(e.clientY, window.innerHeight - tall - 12)), items });
  };
  const setTask = (n: CanvasNode, to: 'draft' | 'done') => act(() => api.setNode(line.id, n.id, { status: to }));
  const toggle = (n: CanvasNode) => { if (n.check) act(() => api.setCheck(line.id, n.check!.id, { on: !n.check!.on }), n.check.on ? tr('已关闭') : tr('已开启')); };
  const several = (ns: CanvasNode[]): Item[] => [
    { icon: 'copy', label: tr('复制 {0} 个节点', ns.length), run: () => copy(ns), key: `${MOD}C` },
    { icon: 'split', label: tr('剪切'), run: () => snip(ns), key: `${MOD}X`, off: !ns.some(copyable) },
    { icon: 'stack', label: tr('创建副本'), run: () => dup(ns), key: `${MOD}D`, off: !ns.some(copyable) },
    null,
    { icon: 'rows', label: tr('左对齐'), run: () => align(ns, 'left') },
    { icon: 'rows', label: tr('顶部对齐'), run: () => align(ns, 'top') },
    { icon: 'cards', label: tr('横向等距'), run: () => align(ns, 'row'), off: ns.length < 3 },
    { icon: 'cards', label: tr('纵向等距'), run: () => align(ns, 'column'), off: ns.length < 3 },
    { icon: 'board', label: tr('网格排列'), run: () => grid(ns) },
    null,
    { icon: 'close', label: tr('删除这 {0} 个', ns.length), run: () => remove(ns), danger: true, key: '⌫' },
  ];
  const nodeItems = (n: CanvasNode): Item[] => {
    const g = n.gate, c = n.check, soft = c?.kind === 'soft', st = n.status;
    const acts: Item[] = [
      ...(g?.state === 'block' ? [{ icon: 'refresh', label: g.ticket ? tr('退回一轮') : tr('派发修补单'), run: () => gate(g.stage, 'rework') } as Item] : []),
      ...(g?.escalated ? [{ icon: 'plus', label: tr('追加两轮'), run: () => act(() => api.gateAct(line.id, g.stage, 'more'), tr('再退回两轮')) } as Item] : []),
      ...(g?.state === 'block' && !g.waived ? [{ icon: 'play', label: tr('先放行'), run: () => act(() => api.gateAct(line.id, g.stage, 'waive'), tr('已暂时放行')) } as Item] : []),
      ...(g && g.checks.length > 1 ? [{ icon: 'split', label: g.open ? tr('收起卡口组') : tr('展开为 {0} 个独立节点', g.checks.length), run: () => gate(g.stage, g.open ? 'close' : 'open') } as Item] : []),
      ...(g || n.kind === 'hard' ? [{ icon: 'refresh', label: tr('运行代码硬检查'), run: runAll } as Item] : []),
      ...(soft && c.on && ['fail', 'warn'].includes(status(c)) ? [{ icon: 'wand', label: tr('指派纠偏'), run: () => ops.fix(n) } as Item] : []),
      ...(soft && c.on ? [{ icon: 'send', label: tr('让负责人现在查'), run: () => ops.ask(n), off: !v?.lead } as Item] : []),
      ...(c ? [{ icon: c.on ? 'stop' : 'play', label: c.on ? tr('关闭此项检查') : tr('开启此项检查'), run: () => toggle(n) } as Item] : []),
      ...(n.kind === 'task' && st !== 'queued' ? [{ icon: 'send', label: st === 'draft' ? tr('发送至{0}', WHO[n.to ?? 'lead']) : tr('再发一次'), run: () => ops.send(n), off: n.agent_id ? !n.agent?.started : !v?.agents[n.to ?? 'lead'].there } as Item] : []),
      ...(n.kind === 'task' && v && st !== 'done' && orderOf(v, n.id).drafts.length ? [{ icon: 'right', label: tr('连同后续 {0} 个按顺序派发', orderOf(v, n.id).drafts.length), run: () => ops.send(n, true), off: n.agent_id ? !n.agent?.started : !v.agents[n.to ?? 'lead'].there } as Item] : []),
      ...(n.kind === 'task' && st === 'queued' ? [{ icon: 'stop', label: tr('取消排队'), run: () => setTask(n, 'draft') } as Item] : []),
      ...(n.kind === 'task' && n.stale ? [{ icon: 'check', label: tr('结果仍然有效'), run: () => act(() => api.setNode(line.id, n.id, { stale: false }), tr('已确认结果有效')) } as Item] : []),
      ...(n.kind === 'task' && st === 'sent' ? [{ icon: 'check', label: tr('标成完成'), run: () => setTask(n, 'done') } as Item] : []),
      ...(n.kind === 'task' && (st === 'done' || st === 'blocked') ? [{ icon: 'refresh', label: tr('重新打开'), run: () => setTask(n, 'draft') } as Item] : []),
    ];
    return [
      { icon: 'eye', label: tr('看详情'), run: () => pick(n.id) },
      { icon: 'target', label: tr('移至画面中央'), run: () => centre(n) },
      ...(acts.length ? [null, ...acts] : []),
      null,
      { icon: 'plus', label: tr('在旁派发任务'), run: () => beside(n, 'task') },
      { icon: 'plus', label: tr('在旁添加备注'), run: () => beside(n, 'note') },
      ...(n.kind === 'stage' ? [{ icon: 'plus', label: tr('为其添加监测软巡检'), run: () => beside(n, 'soft') } as Item, { icon: 'plus', label: tr('为其卡口添加硬规则'), run: () => beside(n, 'hard') } as Item] : []),
      null,
      { icon: 'copy', label: copyable(n) ? tr('复制') : tr('复制名称和内容'), run: () => copy([n]), key: `${MOD}C` },
      ...(copyable(n) ? [{ icon: 'split', label: tr('剪切'), run: () => snip([n]), key: `${MOD}X` } as Item, { icon: 'stack', label: tr('创建副本'), run: () => dup([n]), key: `${MOD}D` } as Item] : []),
      null,
      { icon: 'close', label: mine(n) ? tr('删掉') : tr('从回路上拿掉'), run: () => drop(n), danger: true, key: '⌫' },
    ];
  };
  const paneItems = (x: number, y: number): Item[] => [
    { icon: 'plus', label: tr('在此派发任务'), run: () => here(x, y, 'task'), key: 'N' },
    { icon: 'plus', label: tr('在此添加备注'), run: () => here(x, y, 'note'), key: '⇧N' },
    { icon: 'plus', label: tr('在此添加软巡检'), run: () => here(x, y, 'soft') },
    { icon: 'plus', label: tr('在此添加硬规则'), run: () => here(x, y, 'hard') },
    null,
    { icon: 'doc', label: held.current ? tr('粘贴 {0} 个节点', held.current.items.length) : tr('粘贴'), run: () => pasteAny({ x, y }), key: `${MOD}V` },
    { icon: 'board', label: tr('全选'), run: () => select('all'), key: `${MOD}A` },
    { icon: 'left', label: undos.current.length ? tr('撤销：{0}', undos.current[undos.current.length - 1].what) : tr('撤销'), run: undo, key: `${MOD}Z`, off: !undos.current.length },
    null,
    { icon: 'target', label: tr('适应窗口'), run: () => fit(), key: 'F' },
    { icon: 'lens', label: tr('缩放到 100%'), run: () => zoomTo('one'), key: '0' },
    { icon: 'wand', label: tr('按分块规整'), run: tidy },
    { icon: prefs.lines ? 'check' : 'eye', label: prefs.lines ? tr('折叠次要连线') : tr('显示全部连线'), run: () => setPrefs({ lines: !prefs.lines }) },
    { icon: 'sliders', label: tr('画布设置…'), run: () => go('/settings/loop') },
    null,
    { icon: v?.rules?.exclusive ? 'check' : 'lock', label: v?.rules?.exclusive ? tr('同一工作目录每次仅运行一个任务：已开启') : tr('同一工作目录每次仅运行一个任务'), run: () => act(() => api.setLoopRules(line.id, !v?.rules?.exclusive), v?.rules?.exclusive ? tr('同目录任务已允许同时运行') : tr('同目录任务将逐个运行')) },
    { icon: 'refresh', label: tr('立即全检'), run: runAll },
  ];
  const edgeItems = (id: string): Item[] => {
    const e = v?.edges.find(x => x.id === id), a = v?.nodes.find(n => n.id === e?.source), b = v?.nodes.find(n => n.id === e?.target);
    const can = !!e && !!a && !!b && (!e.kind || e.kind === 'order') && ordered(a) && ordered(b), is = e?.kind === 'order';
    return [
      ...(can ? [{ icon: is ? 'rows' : 'right', label: is ? tr('改为普通连线（仅提供上下文）') : tr('设为顺序线（前序完成后派发后续）'), run: () => ops.order(id, { order: !is }) } as Item] : []),
      ...(can && is ? [{ icon: 'refresh', label: tr('调换先后'), run: () => ops.order(id, { flip: true }) } as Item, null] : can ? [null] : []),
      { icon: 'compose', label: e?.label ? tr('改线上的字') : tr('添加连线文字'), run: () => setEditing(id) },
      ...(a ? [{ icon: 'eye', label: tr('查看「{0}」', label(a)), run: () => pick(a.id) } as Item] : []),
      ...(b ? [{ icon: 'eye', label: tr('查看「{0}」', label(b)), run: () => pick(b.id) } as Item] : []),
      null,
      { icon: 'close', label: tr('断开连线'), run: () => cut(id), danger: true, key: '⌫' },
    ];
  };
  // the assistant in its floating window: told what is open here, and able to bring a node up (show --ref node:<id>)
  usePanelNote('canvas', 'board', {
    [tr('选中的节点')]: cur ? `${cur.id}「${label(cur)}」` : null,
    [tr('视角')]: report ? tr('前后对比') : filter === 'todo' ? tr('阻断与预警') : filter === 'hard' ? tr('硬卡口') : filter === 'soft' ? tr('软巡检') : null,
    [tr('正在查找')]: q.trim() || null,
  });
  const want = useRef<string | null>(wanted.node ?? query().get('node')), wantBlock = useRef<FlowPart | null>(wanted.block);
  useEffect(() => { wanted.node = null; wanted.block = null; }, []);
  const bring = () => {
    const id = want.current, block = wantBlock.current;
    if (block && !id && frames.length && ready) { wantBlock.current = null; setTimeout(() => showBlock(block), 80); }
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
    <MoreCtx.Provider value={more}>
    <div className="cv" ref={page} role="dialog" aria-modal="true" aria-label={tr('#{0} 的研究回路', line.seq)}>
      <header className="cv-top">
        <a className="cv-back" href={href(back)} onClick={e => follow(e, back)} title={tr('返回项目页')}><Icon n="left" size={15} /><span>#{line.seq}</span><b>{line.title}</b></a>
        <h2>{tr('研究回路')}{v && <em className="cv-r">Loop R{v.rounds}</em>}</h2>
        <div className="seg cv-filter" role="radiogroup" aria-label={tr('回路高亮项说明')}>
          {views.map(([k, t, n]) => {
            const on = k === 'report' ? report : !report && filter === k;
            return (
              <button key={k} role="radio" aria-checked={on} className={on ? 'on' : ''} onClick={() => { if (k === 'report') setReport(x => !x); else { setReport(false); setFilter(k); } }}
                title={k === 'todo' ? tr('阻断或告警卡口、未通过或到期巡检、未完成任务、锁定或待你处理工序、待你拍板事项') : undefined}>
                {t}{!!n && <em>{n}</em>}
              </button>
            );
          })}
        </div>
        <Find v={v} q={q} setQ={setQ} onPick={pick} />
        {v && <LoopSummary v={v} short />}
        <div className="cv-acts">
          <button className="btn" disabled={busy || !v} onClick={runAll} title={tr('立即运行该项目的全部硬检查')}><Icon n="refresh" size={14} />{tr('立即全检')}</button>
          <Menu cls="btn pri" label={<><Icon n="plus" size={14} />{tr('新建回路节点')}</>}>
            {close => (
              <>
                {([['task', tr('指派给 agent 的任务'), 'N'], ['soft', tr('由负责人判断的问题'), ''], ['hard', tr('通过代码检查的规则'), ''], ['note', tr('一张便签'), '']] as const).map(([k, d, key]) => (
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
                <Row close={close} it={{ icon: 'wand', label: tr('按分块规整'), run: tidy, off: busy || !v }} />
                <Row close={close} it={{ icon: 'doc', label: tr('前后对比'), run: () => setReport(true), off: !v }} />
                <hr />
                <label className="cv-mi"><input type="checkbox" checked={prefs.lines} onChange={e => setPrefs({ lines: e.target.checked })} /><span>{tr('显示全部连线')}</span></label>
                <label className="cv-mi"><input type="checkbox" checked={prefs.legend} onChange={e => setPrefs({ legend: e.target.checked })} /><span>{tr('图例')}</span></label>
                <label className="cv-mi"><input type="checkbox" checked={prefs.map} onChange={e => setPrefs({ map: e.target.checked })} /><span>{tr('小地图')}</span></label>
                <label className="cv-mi"><input type="checkbox" checked={cs.cvGuides} onChange={e => setSettings({ cvGuides: e.target.checked })} /><span>{tr('吸附到其他节点')}</span></label>
                <label className="cv-mi"><input type="checkbox" checked={prefs.snap} onChange={e => setPrefs({ snap: e.target.checked })} /><span>{tr('拖动时对齐网格')}</span></label>
                <Row close={close} it={{ icon: 'sliders', label: tr('画布设置…'), run: () => go('/settings/loop') }} />
                {v && v.spare.length > 0 && (
                  <>
                    <hr />
                    <h6>{tr('资料卡：实时显示项目部分信息')}</h6>
                    {v.spare.map(g => (
                      <div key={g.id} className="cv-mi"><span>{trx(g.title)}</span><button className="lnk" disabled={busy} onClick={() => act(() => api.restoreNode(line.id, g.id), tr('已添加'))}>{tr('添加至回路')}</button></div>
                    ))}
                  </>
                )}
                {v && v.gone.length > 0 && (
                  <>
                    <hr />
                    <h6>{tr('已移除节点')}</h6>
                    {v.gone.map(g => (
                      <div key={g.id} className="cv-mi"><span>{trx(g.title)}</span><button className="lnk" disabled={busy} onClick={() => act(() => api.restoreNode(line.id, g.id), tr('放回来了'))}>{tr('恢复至回路')}</button></div>
                    ))}
                  </>
                )}
                <hr />
                <h6>{tr('怎么用')}</h6>
                <ul className="cv-help">
                  <li>{tr('双击空白处，或右键：新建节点')}</li>
                  <li>{tr('从节点边缘圆点拖拽可连线，拖至空白处可新建并连接')}</li>
                  <li>{tr('双击连线可编辑文字，选中后按 Delete 断开')}</li>
                  <li>{tr('按住 Shift 拖动可框选多个节点一并移动，右键可对齐')}</li>
                  <li>{tr('{0}C 复制、{0}X 剪切、{0}V 粘贴、{0}D 创建副本（任务与备注），外部复制的文本将粘贴为备注', MOD)}</li>
                  <li>{tr('Delete 删除、{0}A 全选、{0}Z 撤销，方向键微移（按住 Shift 大幅移动）', MOD)}</li>
                  <li>{tr('N 新任务、⇧N 新备注、F 适应窗口、0 恢复 100%、+ − 缩放')}</li>
                  <li>{tr('触控板双指滑动或滚轮用于平移，双指捏合或按住 {0} 滚动用于缩放，滚轮每格微幅缩放', MOD.trim())}</li>
                  <li>{tr('按 / 打开小助手，协助修改回路或解释卡口未放行原因')}</li>
                </ul>
              </>
            )}
          </Menu>
        </div>
      </header>

      <div className="cv-body">
        <div className={`cv-flow${lit ? ' has-dim' : ''}${cs.cvMarch ? '' : ' still'}`} ref={wrap} onMouseMove={e => { pointer.current = { x: e.clientX, y: e.clientY }; }} onMouseLeave={() => { pointer.current = null; }} onDoubleClick={e => { if ((e.target as HTMLElement).classList.contains('react-flow__pane')) here(e.clientX, e.clientY, 'task'); }}>
          <OpsCtx.Provider value={ops}><BoxCtx.Provider value={cs.cvAvoid ? boxes : NONE}><FrameCtx.Provider value={frameOf}>
            <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodes} onEdgesChange={onEdgesChange}
              connectionMode={ConnectionMode.Loose} colorMode={dark ? 'dark' : 'light'} minZoom={floor * 0.98} maxZoom={1.8} translateExtent={extent} zoomOnDoubleClick={false} panOnScroll={cs.cvScroll === 'pan'} zoomOnPinch
              snapToGrid={prefs.snap} snapGrid={[+cs.cvGap, +cs.cvGap]} deleteKeyCode={['Backspace', 'Delete']} multiSelectionKeyCode={['Meta', 'Control', 'Shift']} disableKeyboardA11y
              onBeforeDelete={async d => { // Delete on nodes goes through remove (it asks, and only takes the loop's own nodes off); lines go as they are
                const ns = d.nodes.filter(n => n.id !== NEW).map(n => n.data.n);
                if (ns.length) remove(ns);
                return !ns.length;
              }}
              onEdgesDelete={gone => gone.forEach(e => cut(e.id))} onEdgeDoubleClick={(_, e) => { if (!virtual(e.id)) setEditing(e.id); }}
              onNodeClick={(e, n) => { if (n.id === NEW) return; if (e.metaKey || e.ctrlKey || e.shiftKey) setSel(null); else pick(n.id); }}
              onSelectionStart={() => setSel(null)} onPaneClick={() => { setSel(null); setEditing(null); }} onMoveStart={e => { setCtx(null); if (e) auto.current = false; }}
              onNodeDragStart={(_, _n, all) => { dragging.current = true; setCtx(null); before.current = Object.fromEntries(all.map(n => [n.id, [Math.round(n.position.x), Math.round(n.position.y)]])); }}
              onNodeDrag={(_, _n, all) => aim(all)}
              onNodeDragStop={(e, n, all) => { setGuides({ x: null, y: null }); onDragStop(e, n, all); }}
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
              {cs.cvBg !== 'none' && <Background variant={cs.cvBg === 'lines' ? BackgroundVariant.Lines : BackgroundVariant.Dots} gap={+cs.cvGap} size={cs.cvBg === 'lines' ? 1 : 1.4} />}
              {v && cs.cvLanes && <Blocks v={v} r={r} frames={frames} into={into} onShow={showBlock} onOpen={key => onConsole(line.id, { mod: key })} />}
              {(guides.x != null || guides.y != null) && frame && (
                <ViewportPortal>
                  {guides.x != null && <i className="cv-guide v" style={{ left: guides.x, top: frame.y - 400, height: frame.height + 800 }} />}
                  {guides.y != null && <i className="cv-guide h" style={{ top: guides.y, left: frame.x - 400, width: frame.width + 800 }} />}
                </ViewportPortal>
              )}
              <Controls showInteractive={false} />
              {prefs.map && <MiniMap pannable zoomable nodeClassName={n => `mm-${n.type}`} />}
              {prefs.legend && !report && <Legend onClose={() => setPrefs({ legend: false })} />}
              {prefs.hint && (
                <Panel position="top-center" className="cv-hint">
                  <span>{tr('双击空白处新建 · 从节点边缘圆点拖拽连线 · 右键查看更多操作')}</span>
                  <button className="ib" title={tr('确认')} aria-label={tr('确认')} onClick={() => setPrefs({ hint: false })}><Icon n="close" size={12} /></button>
                </Panel>
              )}
            </ReactFlow>
          </FrameCtx.Provider></BoxCtx.Provider></OpsCtx.Provider>
          {v && report && <LoopReport v={v} onPick={pick} onClose={() => setReport(false)} toast={toast} />}
          {loadError && <p className="cv-err" role="alert"><span>{loadError}</span><button className="lnk" onClick={reload}>{tr('重试')}</button></p>}
          {!v && !loadError && <p className="cv-wait muted">{tr('加载中…')}</p>}
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
    </div>
    </MoreCtx.Provider>,
    document.querySelector('.proto') ?? document.body, // the app's root: where the look's colours are
  );
}
