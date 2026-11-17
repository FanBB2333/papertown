// A project's research loop (研究回路) at /progress/<number>/loop (and the older /canvas): the whole window is a free
// graph laid over three lanes. The soft layer on top (the soft spec, the hard clamp, the sentinels watching stages),
// the spine in the middle (stations and the hard gates between them), the loop back below (rework tickets a gate
// sent back, corrections a sentinel asked for, your tasks and notes, the human gate). The lanes are where things
// start and where 按回路规整 puts them back; nothing holds a node in one. Lines say what they do: the flow (grey
// and locked past a gate that blocks), a sentinel watching, the spec injected, the clamp, a gate's rework loop, a
// sentinel's correction. Drag a node to move it, drag from the dot on its rim to wire it to another (or to empty
// space, to make a new node wired to it), double-click empty space for a new one, double-click a line to write on
// it, right-click anything for what can be done with it. The bar narrows the loop to what blocks or warns, to the
// hard side or the soft side, or lays out 前后对比; the open node's inspector is beside it (CanvasSide.tsx).
// Loaded on demand, with the graph library.

import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Popover } from '@cloudflare/kumo';
import {
  Background, BackgroundVariant, BaseEdge, ConnectionMode, Controls, EdgeLabelRenderer, getBezierPath, MiniMap, Panel, Position,
  ReactFlow, ReactFlowProvider, useEdgesState, useInternalNode, useNodesInitialized, useNodesState, useReactFlow, ViewportPortal,
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
import { gateLook, needs, side } from './loop';
import type { ConsoleTarget } from './Project';

type FEdge = Edge<{ bow: boolean; arrow: boolean; tee: boolean; label: string; tag: string; tone: string }>;
type Filter = 'all' | 'todo' | 'hard' | 'soft';
type Item = { icon: IconName; label: string; run: () => void; danger?: boolean; off?: boolean; key?: string } | null;
interface Prefs { map: boolean; snap: boolean; hint: boolean; legend: boolean }

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
  const base: Prefs = { map: false, snap: false, hint: true, legend: true };
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

// ---------- lines: from rim to rim, wherever the two nodes are ----------

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
  const o = useContext(OpsCtx);
  if (!a || !b) return null;
  const ca = centre(a), cb = centre(b);
  let path: string, lx: number, ly: number, end: { x: number; y: number }, turn: number;
  if (data?.bow) { // a loop back, or the way back between two nodes already joined: an arc beside the straight line
    const len = Math.hypot(cb.x - ca.x, cb.y - ca.y) || 1, bend = Math.min(110, len * 0.3);
    const ctrl = { x: (ca.x + cb.x) / 2 + ((cb.y - ca.y) / len) * bend * 2, y: (ca.y + cb.y) / 2 - ((cb.x - ca.x) / len) * bend * 2 };
    const p = rim(a, ctrl), q = rim(b, ctrl);
    path = `M${p.x},${p.y} Q${ctrl.x},${ctrl.y} ${q.x},${q.y}`;
    lx = 0.25 * p.x + 0.5 * ctrl.x + 0.25 * q.x; ly = 0.25 * p.y + 0.5 * ctrl.y + 0.25 * q.y;
    end = q; turn = (Math.atan2(q.y - ctrl.y, q.x - ctrl.x) * 180) / Math.PI;
  } else {
    const p = rim(a, cb), q = rim(b, ca);
    end = q; turn = TURN[q.side];
    if (data?.arrow || data?.tee) [path, lx, ly] = getBezierPath({ sourceX: p.x, sourceY: p.y, sourcePosition: p.side, targetX: q.x, targetY: q.y, targetPosition: q.side });
    else { path = `M${p.x},${p.y} L${q.x},${q.y}`; lx = (p.x + q.x) / 2; ly = (p.y + q.y) / 2; }
  }
  const text = data?.label ?? '', at = { transform: `translate(-50%,-50%) translate(${lx}px,${ly}px)` };
  return (
    <>
      <BaseEdge id={id} path={path} interactionWidth={20} />
      {data?.arrow && <path className="cv-arrow" d="M1,0 L-8,-4.5 L-8,4.5 Z" transform={`translate(${end.x},${end.y}) rotate(${turn})`} />}
      {data?.tee && <path className="cv-tee" d="M0,-7 L0,7" transform={`translate(${end.x},${end.y}) rotate(${turn})`} />}
      {o && !virtual(id) && (o.editing === id || text || data?.tag || selected) && (
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
    ...(old.get(n.id) ?? {}), id: n.id, type: n.kind, position: { x: moved[n.id]?.[0] ?? n.x, y: moved[n.id]?.[1] ?? n.y }, data: { n }, selected: n.id === sel,
    className: lit && !lit.has(n.id) ? 'dim' : '',
  }));
  if (draft) {
    out.push({ ...(old.get(NEW) ?? {}), id: NEW, type: 'ghost', position: { x: draft.x, y: draft.y }, selectable: false, connectable: false,
      data: { n: { id: NEW, kind: 'note', x: draft.x, y: draft.y, title: KIND[draft.kind] } } });
  }
  return out;
}

// how a line is drawn: by what it does, and how the things at its ends stand
function look(e: CanvasEdge, a: CanvasNode, b: CanvasNode): { cls: string; arrow: boolean; tee: boolean; bow: boolean; tag: string; tone: string } {
  const task = [a, b].find(x => x.kind === 'task');
  const none = { arrow: false, tee: false, bow: false, tag: '', tone: '' };
  switch (e.kind) {
    case 'flow': {
      const g = a.gate, lock = !!g && g.state === 'block' && !g.waived;
      const ok = a.kind === 'stage' ? a.status === 'done' : !!g && gateLook(g) === 'pass';
      return { ...none, cls: `w-flow${lock ? ' lock' : ok ? ' ok' : g && gateLook(g) === 'warn' ? ' warn' : ''}`, arrow: true, tag: lock ? tr('锁死') : '', tone: lock ? 'lock' : '' };
    }
    case 'watch': return { ...none, cls: `w-watch v-${a.check ? (a.check.on ? status(a.check) : 'none') : 'none'}`, arrow: true };
    case 'spec': return { ...none, cls: 'w-spec', arrow: true };
    case 'clamp': return { ...none, cls: 'w-clamp', tee: true };
    case 'escalate': return { ...none, cls: `w-esc${b.items?.length || a.items?.length ? ' on' : ''}`, arrow: true };
    case 'member': return { ...none, cls: 'w-member' };
    case 'hard_loop': {
      const t = task ?? a, head = a.kind === 'gate';
      const tag = head ? (t.converged ? tr('✓ {0} 轮收敛', t.round || 1) : tr('阻断打回 · 内循环第 {0} 轮', t.round || 1)) : '';
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

function toEdges(v: CanvasView, draft: Draft | null, lit: Set<string> | null, focus: string | null, prev: FEdge[]): FEdge[] {
  const by = new Map(v.nodes.map(n => [n.id, n]));
  const chosen = new Set(prev.filter(e => e.selected).map(e => e.id)), seen = new Set<string>();
  const blank = { bow: false, arrow: false, tee: false, label: '', tag: '', tone: '' };
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
    return [{ id: e.id, source: e.source, target: e.target, type: 'wire', className: on ? l.cls : `${l.cls} dim`, selected: chosen.has(e.id),
      data: { bow: l.bow || twin, arrow: l.arrow, tee: l.tee, label: e.label ?? '', tag: l.tag, tone: l.tone } }];
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

function Legend({ onClose }: { onClose: () => void }) {
  return (
    <Panel position="bottom-left" className="cv-legend">
      <header><b>{tr('回路图例')}</b><button className="ib" title={tr('收起')} aria-label={tr('收起')} onClick={onClose}><Icon n="close" size={12} /></button></header>
      <p><i className="cv-dia g-block" />{tr('切角八边形 = 硬卡口：代码门禁，阻断时锁住下游')}</p>
      <p><i className="cv-ring2" />{tr('双环胶囊 = 软巡检：负责人语义审视，触发纠偏')}</p>
      <p><i className="lg l-hard" />{tr('硬打回自愈内环')}</p>
      <p><i className="lg l-soft" />{tr('软纠偏反馈弧')}</p>
      <p><i className="lg l-lock" />{tr('被阻断的下游')}</p>
      <p><i className="lg l-spec" />{tr('软限制注入')}<i className="lg l-clamp" />{tr('硬边界钳制')}</p>
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
    setEdges(prev => toEdges(v, draft, lit, focus, prev));
  }, [v, sel, draft, lit, focus, setNodes, setEdges]);
  const fit = (ms = 300) => rf.fitView({ padding: 0.08, maxZoom: 1, duration: ms });
  useEffect(() => {
    if (ready && !fitted.current && nodes.length) { fitted.current = true; rf.fitView({ padding: 0.08, maxZoom: 1 }); }
  }, [ready, nodes.length, rf]);

  const act: Act = async (fn, done) => {
    setBusy(true);
    try {
      const x = await fn();
      if (x && typeof x === 'object' && 'nodes' in x) setV(x as CanvasView); else reload();
      if (done) toast(done);
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const begin = (d: Draft) => { setSel(null); setReport(false); setDraft(d); };
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
      toast(b.kind === 'task' && b.send ? tr('加上了，也发给它了') : tr('加上了'));
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  }
  const drop = (n: CanvasNode) => {
    if (mine(n) && !confirm(tr('删掉「{0}」？', label(n)))) return;
    act(() => api.dropNode(line.id, n.id), mine(n) ? tr('删掉了') : tr('拿掉了，可以在「更多」里放回来')).then(() => setSel(s => (s === n.id ? null : s)));
  };
  const cut = (edgeId: string) => { if (!virtual(edgeId)) act(() => api.disconnect(line.id, edgeId)); };
  const gate = (stage: string, what: 'open' | 'close' | 'rework') =>
    act(() => api.gateAct(line.id, stage, what), what === 'rework' ? tr('修补单发出去了') : undefined).then(() => { if (what !== 'rework') setTimeout(() => fit(), 80); });
  const ops: Ops = {
    busy, agents: v?.agents ?? null, r, v, editing, edit: setEditing, cut, gate,
    relabel: (edgeId, text) => {
      setEditing(null);
      if ((v?.edges.find(e => e.id === edgeId)?.label ?? '') !== text.trim()) act(() => api.labelEdge(line.id, edgeId, text.trim()));
    },
    fix: n => {
      if (n.kind === 'gate' && n.gate) gate(n.gate.stage, 'rework');
      else if (n.kind === 'hard' && n.check?.stage) gate(n.check.stage, 'rework');
      else if (n.check?.kind === 'soft') begin({ kind: 'task', x: n.x, y: (loopY?.y0 ?? n.y + 200) + 60, link: n.id, seed: fixSeed(n) });
    },
    ask: n => { if (n.check) act(() => api.askCheck(line.id, n.check!.id), tr('已经发给负责人，它判断完会出现在这里')); },
    send: n => { act(() => api.sendNode(line.id, n.id), tr('发给{0}了', WHO[n.to ?? 'lead'])); },
    beside: (n, k) => beside(n, k),
    dup: n => begin({ kind: n.kind === 'note' ? 'note' : 'task', x: n.x + 36, y: n.y + SIZE[n.kind][1] + 28, link: null, seed: { title: n.title, text: n.text, to: n.to } }),
    drop,
  };

  const onConnect = (c: Connection) => { if (c.source && c.target && c.target !== NEW) act(() => api.connect(line.id, c.source, c.target)); };
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
    const at = Object.fromEntries(real.map(n => [n.id, [Math.round(n.position.x), Math.round(n.position.y)] as [number, number]]));
    Object.assign(moved.current, at);
    setV(x => x && { ...x, nodes: x.nodes.map(n => (at[n.id] ? { ...n, x: at[n.id][0], y: at[n.id][1] } : n)) });
    api.moveNodes(line.id, at).catch(e => toast((e as Error).message))
      .finally(() => { for (const k of Object.keys(at)) if (moved.current[k] === at[k]) delete moved.current[k]; });
  };
  const tidy = () => {
    if (!confirm(tr('按回路规整：工序、卡口、巡检、软限制和硬边界放回各自的泳道，修补单放到卡口下面？你的任务、备注和画的线不动。'))) return;
    act(() => api.tidyCanvas(line.id)).then(() => setTimeout(() => fit(), 60));
  };
  const runAll = () => act(() => api.runChecks(line.id), tr('查完了'));

  // right-click: what can be done with the thing under the pointer
  const menuAt = (e: { clientX: number; clientY: number; preventDefault: () => void }, items: Item[]) => {
    e.preventDefault();
    const rows = items.filter(Boolean).length;
    setCtx({ x: Math.min(e.clientX, window.innerWidth - 232), y: Math.min(e.clientY, window.innerHeight - rows * 34 - 28), items });
  };
  const nodeItems = (n: CanvasNode): Item[] => [
    { icon: 'eye', label: tr('看详情'), run: () => pick(n.id) },
    ...(n.gate?.state === 'block' ? [{ icon: 'refresh', label: tr('派修补单'), run: () => gate(n.gate!.stage, 'rework') } as Item] : []),
    ...(n.gate && n.gate.checks.length > 1 ? [{ icon: 'split', label: n.gate.open ? tr('收回卡口组') : tr('展开为 {0} 个独立节点', n.gate.checks.length), run: () => gate(n.gate!.stage, n.gate!.open ? 'close' : 'open') } as Item] : []),
    ...(n.check?.kind === 'soft' && ['fail', 'warn'].includes(status(n.check)) ? [{ icon: 'wand', label: tr('派人纠偏'), run: () => ops.fix(n) } as Item] : []),
    ...(n.check?.on && n.check.kind === 'soft' ? [{ icon: 'send', label: tr('让负责人现在查'), run: () => ops.ask(n), off: !v?.lead } as Item] : []),
    ...(n.kind === 'task' ? [{ icon: 'send', label: n.status === 'draft' ? tr('发给{0}', WHO[n.to ?? 'lead']) : tr('再发一次'), run: () => ops.send(n), off: !v?.agents[n.to ?? 'lead'].there } as Item] : []),
    null,
    { icon: 'plus', label: tr('在它旁边派任务'), run: () => beside(n, 'task') },
    { icon: 'plus', label: tr('在它旁边加备注'), run: () => beside(n, 'note') },
    ...(n.kind === 'task' || n.kind === 'note' ? [{ icon: 'copy', label: tr('复制一个'), run: () => ops.dup(n) } as Item] : []),
    null,
    { icon: 'close', label: mine(n) ? tr('删掉') : tr('从回路上拿掉'), run: () => drop(n), danger: true },
  ];
  const paneItems = (x: number, y: number): Item[] => [
    { icon: 'plus', label: tr('在这里派任务'), run: () => here(x, y, 'task'), key: 'N' },
    { icon: 'plus', label: tr('在这里加软巡检'), run: () => here(x, y, 'soft') },
    { icon: 'plus', label: tr('在这里加硬规则'), run: () => here(x, y, 'hard') },
    { icon: 'plus', label: tr('在这里加备注'), run: () => here(x, y, 'note') },
    null,
    { icon: 'target', label: tr('适应窗口'), run: () => fit(), key: 'F' },
  ];
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
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); document.getElementById('cv-find')?.focus(); return; }
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') { if (ctx) setCtx(null); else if (draft) setDraft(null); else if (report) setReport(false); else setSel(null); }
      else if (e.key.toLowerCase() === 'n') { e.preventDefault(); add('task'); }
      else if (e.key.toLowerCase() === 'f') fit();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
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
                  <li>{tr('按住 Shift 拖动：框选多个节点一起移动')}</li>
                  <li>{tr('按 / 叫出小助手，让它改回路、解释卡口为什么没放行')}</li>
                </ul>
              </>
            )}
          </Menu>
        </div>
      </header>

      <div className="cv-body">
        <div className={`cv-flow${lit ? ' has-dim' : ''}`} ref={wrap} onDoubleClick={e => { if ((e.target as HTMLElement).classList.contains('react-flow__pane')) here(e.clientX, e.clientY, 'task'); }}>
          <OpsCtx.Provider value={ops}>
            <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
              connectionMode={ConnectionMode.Loose} colorMode={dark ? 'dark' : 'light'} minZoom={0.12} maxZoom={1.8} zoomOnDoubleClick={false}
              snapToGrid={prefs.snap} snapGrid={[22, 22]} deleteKeyCode={['Backspace', 'Delete']} onBeforeDelete={async d => d.nodes.length === 0}
              onEdgesDelete={gone => gone.forEach(e => cut(e.id))} onEdgeDoubleClick={(_, e) => { if (!virtual(e.id)) setEditing(e.id); }}
              onNodeClick={(_, n) => { if (n.id !== NEW) pick(n.id); }} onPaneClick={() => { setSel(null); setEditing(null); }} onMoveStart={() => setCtx(null)}
              onNodeDragStart={() => { dragging.current = true; setCtx(null); }} onNodeDragStop={onDragStop}
              onConnect={onConnect} onConnectEnd={onConnectEnd}
              onPaneContextMenu={e => menuAt(e, paneItems(e.clientX, e.clientY))}
              onNodeContextMenu={(e, n) => { if (n.id !== NEW) menuAt(e, nodeItems(n.data.n)); }}
              onEdgeContextMenu={(e, edge) => { if (!virtual(edge.id)) menuAt(e, [
                { icon: 'compose', label: tr('在线上写几个字'), run: () => setEditing(edge.id) },
                { icon: 'close', label: tr('断开这条线'), run: () => cut(edge.id), danger: true }]); }}>
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
          </OpsCtx.Provider>
          {v && report && <LoopReport v={v} onPick={pick} onClose={() => setReport(false)} toast={toast} />}
          {!v && <p className="cv-wait muted">{tr('加载中…')}</p>}
        </div>

        {v && draft && <NewForm key={`${draft.link}:${draft.seed?.title ?? ''}`} d={draft} v={v} busy={busy} onKind={kind => setDraft({ ...draft, kind })} onAdd={create} onCancel={() => setDraft(null)} />}
        {v && cur && !draft && (
          <Inspector key={cur.id} n={cur} v={v} r={r} line={line} wide={wide} onWide={() => setWide(w => !w)} busy={busy} act={act} onConsole={onConsole}
            onPick={pick} onCut={cut} onNew={k => beside(cur, k)} onFix={() => ops.fix(cur)} onDup={() => ops.dup(cur)} onDrop={() => drop(cur)} onClose={() => setSel(null)} />
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
