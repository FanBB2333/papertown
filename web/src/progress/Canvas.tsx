// A project's canvas (研究画布) at /progress/<number>/canvas: the whole window is a free graph. Its nodes are the
// stages of the research loop, hard (◆) and soft (●) checks, tasks you give an agent, and notes; nothing fixes where
// a node sits or what it is wired to. Drag a node to move it, drag from the dot on its rim to wire it to another
// (or to empty space, to make a new node wired to it), double-click empty space for a new one. A node opens beside
// the canvas: a check's result, findings and settings; a task's brief, to edit and send to its agent, and what came
// of it. Loaded on demand, with the graph library.

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Background, BackgroundVariant, BaseEdge, ConnectionMode, Controls, EdgeLabelRenderer, getBezierPath, Handle, Panel, Position,
  ReactFlow, ReactFlowProvider, useEdgesState, useInternalNode, useNodesInitialized, useNodesState, useReactFlow,
  type Connection, type Edge, type EdgeProps, type InternalNode, type Node, type NodeProps, type OnConnectEnd,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api, type CanvasNode, type CanvasView, type NewNode, type ProjectCard, type TaskStatus, type TaskTo } from '../api';
import { Select } from '../components/Select';
import { Icon } from '../console/icons';
import { ago } from '../console/util';
import { tr, trx } from '../i18n';
import { follow, href } from '../route';
import { SIZE, Summary, tone, useCanvas } from './CanvasCard';
import { CheckDetail, ST, STAGE, status, Trend, type Act } from './Checks';
import type { ConsoleTarget } from './Project';

type FNode = Node<{ n: CanvasNode }>;
type FEdge = Edge<{ bow: boolean; arrow: boolean }>;
type Kind = NewNode['kind'];
interface Draft { kind: Kind; x: number; y: number; link: string | null }

const TASK: Record<TaskStatus, string> = { draft: tr('还没发'), sent: tr('在做'), done: tr('完成'), blocked: tr('卡住了') };
const WHO: Record<TaskTo, string> = { lead: tr('项目负责人'), coder: tr('代码员工'), writer: tr('写作员工') };
const KIND: Record<Kind, string> = { task: tr('派任务'), soft: tr('软检查'), hard: tr('硬检查'), note: tr('备注') };
const NEW = '__new';
const clip = (s: string | undefined, n: number) => { const t = (s ?? '').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const label = (n: CanvasNode) => (n.kind === 'note' ? clip(n.text, 26) : n.kind === 'hard' || n.kind === 'soft' ? trx(n.title ?? '') : n.title ?? '');

const Cut = createContext<(edgeId: string) => void>(() => {});

// ---------- nodes ----------

const SIDES = [Position.Top, Position.Right, Position.Bottom, Position.Left];
const Ports = () => <>{SIDES.map(p => <Handle key={p} id={p} type="source" position={p} />)}</>;

function StageNode({ data: { n }, selected }: NodeProps<FNode>) {
  const st = n.status ?? 'todo';
  return (
    <div className={`cv-n cv-stage st-${st}${selected ? ' on' : ''}`}>
      <span className="cg-dot" style={st === 'run' ? { ['--pct' as string]: `${n.pct ?? 0}%` } : undefined}>
        {st === 'done' ? <Icon n="check" size={13} /> : st === 'wait' ? <Icon n="bell" size={12} /> : null}
      </span>
      <div><b>{n.title}</b><small>{st === 'run' ? `${STAGE.run} · ${n.pct ?? 0}%` : STAGE[st]}</small></div>
      <Ports />
    </div>
  );
}

function CheckNode({ data: { n }, selected }: NodeProps<FNode>) {
  const c = n.check;
  if (!c) return null;
  const k = status(c), val = c.last?.value;
  return (
    <div className={`cv-n cv-check k-${c.kind} s-${c.on ? k : 'none'}${selected ? ' on' : ''}${c.on ? '' : ' off'}`}
      title={`${c.kind === 'hard' ? tr('硬检查') : tr('软检查')} · ${c.on ? ST[k] : tr('已关闭')}`}>
      <i className={`cg-shape k-${c.kind} s-${c.on ? k : 'none'}`} />
      <span>{trx(c.title)}</span>
      {c.on && c.kind === 'hard' && val != null && val > 0 && <em>{val}</em>}
      {c.on && c.due && <em className="cg-due">{tr('到期')}</em>}
      <Ports />
    </div>
  );
}

function TaskNode({ data: { n }, selected }: NodeProps<FNode>) {
  const st = (n.status ?? 'draft') as TaskStatus;
  return (
    <div className={`cv-n cv-task t-${st}${selected ? ' on' : ''}`}>
      <header><Icon n="person" size={12} /><span>{WHO[n.to ?? 'lead']}</span><em>{TASK[st]}</em></header>
      <b>{n.title}</b>
      {(n.result || n.text) && <p>{clip(n.result || n.text, 46)}</p>}
      <Ports />
    </div>
  );
}

function NoteNode({ data: { n }, selected }: NodeProps<FNode>) {
  return <div className={`cv-n cv-note${selected ? ' on' : ''}`}><p>{clip(n.text, 120)}</p><Ports /></div>;
}

// where a node being written will land
function GhostNode({ data: { n } }: NodeProps<FNode>) {
  return <div className="cv-n cv-ghost"><Icon n="plus" size={13} />{n.title}<Ports /></div>;
}

const nodeTypes = { stage: StageNode, hard: CheckNode, soft: CheckNode, task: TaskNode, note: NoteNode, ghost: GhostNode };

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
  const cut = useContext(Cut);
  if (!a || !b) return null;
  const ca = centre(a), cb = centre(b);
  let path: string, lx: number, ly: number, end: { x: number; y: number }, turn: number;
  if (data?.bow) { // the way back between two nodes already joined the other way: an arc beside the straight line
    const len = Math.hypot(cb.x - ca.x, cb.y - ca.y) || 1, bend = Math.min(90, len * 0.32);
    const ctrl = { x: (ca.x + cb.x) / 2 + ((cb.y - ca.y) / len) * bend * 2, y: (ca.y + cb.y) / 2 - ((cb.x - ca.x) / len) * bend * 2 };
    const p = rim(a, ctrl), q = rim(b, ctrl);
    path = `M${p.x},${p.y} Q${ctrl.x},${ctrl.y} ${q.x},${q.y}`;
    lx = 0.25 * p.x + 0.5 * ctrl.x + 0.25 * q.x; ly = 0.25 * p.y + 0.5 * ctrl.y + 0.25 * q.y;
    end = q; turn = (Math.atan2(q.y - ctrl.y, q.x - ctrl.x) * 180) / Math.PI;
  } else {
    const p = rim(a, cb), q = rim(b, ca);
    end = q; turn = TURN[q.side];
    if (data?.arrow) [path, lx, ly] = getBezierPath({ sourceX: p.x, sourceY: p.y, sourcePosition: p.side, targetX: q.x, targetY: q.y, targetPosition: q.side });
    else { path = `M${p.x},${p.y} L${q.x},${q.y}`; lx = (p.x + q.x) / 2; ly = (p.y + q.y) / 2; } // everything but the flow between stages: straight
  }
  return (
    <>
      <BaseEdge id={id} path={path} interactionWidth={20} />
      {data?.arrow && <path className="cv-arrow" d="M1,0 L-8,-4.5 L-8,4.5 Z" transform={`translate(${end.x},${end.y}) rotate(${turn})`} />}
      {selected && id !== NEW && (
        <EdgeLabelRenderer>
          <button className="cv-cut nodrag nopan" style={{ transform: `translate(-50%,-50%) translate(${lx}px,${ly}px)` }}
            title={tr('断开这条线')} aria-label={tr('断开这条线')} onClick={() => cut(id)}><Icon n="close" size={12} /></button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const edgeTypes = { wire: Wire };

function toNodes(v: CanvasView, sel: string | null, draft: Draft | null, prev: FNode[], moved: Record<string, [number, number]>): FNode[] {
  const old = new Map(prev.map(p => [p.id, p]));
  const out: FNode[] = v.nodes.map(n => ({
    ...(old.get(n.id) ?? {}), id: n.id, type: n.kind, position: { x: moved[n.id]?.[0] ?? n.x, y: moved[n.id]?.[1] ?? n.y }, data: { n }, selected: n.id === sel,
  }));
  if (draft) {
    out.push({ ...(old.get(NEW) ?? {}), id: NEW, type: 'ghost', position: { x: draft.x, y: draft.y }, selectable: false, connectable: false,
      data: { n: { id: NEW, kind: 'note', x: draft.x, y: draft.y, title: KIND[draft.kind] } } });
  }
  return out;
}

function toEdges(v: CanvasView, draft: Draft | null, prev: FEdge[]): FEdge[] {
  const by = new Map(v.nodes.map(n => [n.id, n]));
  const chosen = new Set(prev.filter(e => e.selected).map(e => e.id)), seen = new Set<string>();
  const out: FEdge[] = v.edges.flatMap(e => {
    const a = by.get(e.source), b = by.get(e.target);
    if (!a || !b) return [];
    const bow = seen.has(`${e.target}>${e.source}`);
    seen.add(`${e.source}>${e.target}`);
    const task = [a, b].find(x => x.kind === 'task'), check = [a, b].find(x => x.kind === 'hard' || x.kind === 'soft');
    const flow = a.kind === 'stage' && b.kind === 'stage';
    const cls = a.kind === 'note' || b.kind === 'note' ? 'w-note' : task ? `w-task t-${task.status}` : flow ? `w-flow st-${a.status}` : check ? `w-check ${tone(check)}` : 'w-check';
    return [{ id: e.id, source: e.source, target: e.target, type: 'wire', className: cls, selected: chosen.has(e.id), data: { bow, arrow: flow } }];
  });
  if (draft?.link && by.has(draft.link)) out.push({ id: NEW, source: draft.link, target: NEW, type: 'wire', className: 'w-task t-draft', selectable: false, data: { bow: false, arrow: false } });
  return out;
}

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
  const [nodes, setNodes, onNodesChange] = useNodesState<FNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FEdge>([]);
  const rf = useReactFlow();
  const ready = useNodesInitialized();
  const wrap = useRef<HTMLDivElement>(null);
  const fitted = useRef(false), dragging = useRef(false), moved = useRef<Record<string, [number, number]>>({});
  const back = `/progress/${line.seq}`;
  const cur = v?.nodes.find(n => n.id === sel) ?? null;
  const dark = document.documentElement.dataset.mode === 'dark';

  useEffect(() => {
    if (!v || dragging.current) return;
    setNodes(prev => toNodes(v, sel, draft, prev, moved.current));
    setEdges(prev => toEdges(v, draft, prev));
  }, [v, sel, draft, setNodes, setEdges]);
  useEffect(() => {
    if (ready && !fitted.current && nodes.length) { fitted.current = true; rf.fitView({ padding: 0.12, maxZoom: 1 }); }
  }, [ready, nodes.length, rf]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (draft) setDraft(null); else setSel(null); } };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [draft]);

  const act: Act = async (fn, done) => {
    setBusy(true);
    try {
      const x = await fn();
      if (x && typeof x === 'object' && 'nodes' in x) setV(x as CanvasView); else reload();
      if (done) toast(done);
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const begin = (d: Draft) => { setSel(null); setDraft(d); };
  const pick = (id: string) => {
    setDraft(null);
    setSel(id);
    setTimeout(() => { // once the detail has opened beside the canvas, bring the node back into view if that hid it
      const n = rf.getNode(id), box = wrap.current?.getBoundingClientRect();
      if (!n || !box) return;
      const cx = n.position.x + (n.measured?.width ?? 0) / 2, cy = n.position.y + (n.measured?.height ?? 0) / 2, at = rf.flowToScreenPosition({ x: cx, y: cy });
      const side = document.querySelector('.cv-side')?.getBoundingClientRect();
      const bottom = side && side.left <= box.left + 1 ? side.top : box.bottom; // on a phone the detail lies over the canvas's lower part
      if (at.x < box.left + 40 || at.x > box.right - 40 || at.y < box.top + 40 || at.y > bottom - 40) {
        const zoom = rf.getZoom();
        rf.setViewport({ x: box.width / 2 - cx * zoom, y: (bottom - box.top) / 2 - cy * zoom, zoom }, { duration: 300 });
      }
    }, 320);
  };
  const middle = () => {
    const b = wrap.current?.getBoundingClientRect();
    return rf.screenToFlowPosition({ x: (b?.left ?? 0) + (b?.width ?? 800) / 2, y: (b?.top ?? 0) + (b?.height ?? 600) / 2 });
  };
  const add = (kind: Kind) => { const p = middle(); begin({ kind, x: Math.round(p.x - 100), y: Math.round(p.y - 30), link: null }); };
  const beside = (n: CanvasNode, kind: Kind) => begin({ kind, x: n.x + SIZE[n.kind][0] + 70, y: n.y + 50, link: n.id });
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
    const mine = n.kind === 'task' || n.kind === 'note' || n.check?.custom;
    if (mine && !confirm(tr('删掉「{0}」？', label(n)))) return;
    act(() => api.dropNode(line.id, n.id), mine ? tr('删掉了') : tr('拿掉了，可以在上面「拿掉的」里放回来')).then(() => setSel(null));
  };
  const cut = (edgeId: string) => { act(() => api.disconnect(line.id, edgeId)); };
  const onConnect = (c: Connection) => { if (c.source && c.target && c.target !== NEW) act(() => api.connect(line.id, c.source, c.target)); };
  const onConnectEnd: OnConnectEnd = (e, s) => {
    if (s.toNode || !s.fromNode || s.fromNode.id === NEW) return;
    const pt = 'changedTouches' in e ? e.changedTouches[0] : e;
    const p = rf.screenToFlowPosition({ x: pt.clientX, y: pt.clientY });
    begin({ kind: 'task', x: Math.round(p.x - 100), y: Math.round(p.y - 24), link: s.fromNode.id });
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
    if (!confirm(tr('把工序和检查放回最初的位置？你画的线、任务和备注不动。'))) return;
    act(() => api.tidyCanvas(line.id)).then(() => setTimeout(() => rf.fitView({ padding: 0.12, maxZoom: 1, duration: 300 }), 60));
  };

  return createPortal(
    <div className={`cv${cur || draft ? ' has-side' : ''}`} role="dialog" aria-modal="true" aria-label={tr('#{0} 的研究画布', line.seq)}>
      <header className="cv-top">
        <a className="cv-back" href={href(back)} onClick={e => follow(e, back)} title={tr('回到项目页')}><Icon n="left" size={15} /><span>#{line.seq}</span><b>{line.title}</b></a>
        <h2><Icon n="map" size={16} />{tr('研究画布')}</h2>
        {v && <Summary v={v} />}
        {v && <Trend points={v.trend} />}
        <div className="cv-acts">
          <button className="btn pri" disabled={!v} onClick={() => add('task')}><Icon n="plus" size={14} />{tr('派任务')}</button>
          <button className="btn" disabled={!v} onClick={() => add('soft')}><Icon n="plus" size={14} />{tr('加检查')}</button>
          <button className="btn" disabled={!v} onClick={() => add('note')}><Icon n="plus" size={14} />{tr('加备注')}</button>
          <i className="cv-sep" />
          <button className="ib" disabled={busy || !v} title={tr('现在查一遍：硬检查平时在论文、实验有变化时自动重跑')} onClick={() => act(() => api.runChecks(line.id), tr('查完了'))}><Icon n="refresh" size={16} /></button>
          <button className="ib" disabled={busy || !v} title={tr('整理：把工序和检查放回最初的位置')} onClick={tidy}><Icon n="wand" size={16} /></button>
          {v && v.gone.length > 0 && (
            <details className="cv-gone">
              <summary className="btn">{tr('拿掉的 {0}', v.gone.length)}</summary>
              <ul>
                {v.gone.map(g => (
                  <li key={g.id}><span>{trx(g.title)}</span><button className="lnk" disabled={busy} onClick={() => act(() => api.restoreNode(line.id, g.id), tr('放回来了'))}>{tr('放回画布')}</button></li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </header>

      <div className="cv-body">
        <div className="cv-flow" ref={wrap} onDoubleClick={e => {
          if (!(e.target as HTMLElement).classList.contains('react-flow__pane')) return;
          const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
          begin({ kind: 'task', x: Math.round(p.x - 100), y: Math.round(p.y - 24), link: null });
        }}>
          <Cut.Provider value={cut}>
            <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
              connectionMode={ConnectionMode.Loose} colorMode={dark ? 'dark' : 'light'} minZoom={0.15} maxZoom={1.8} zoomOnDoubleClick={false}
              deleteKeyCode={['Backspace', 'Delete']} onBeforeDelete={async d => d.nodes.length === 0}
              onEdgesDelete={gone => gone.forEach(e => cut(e.id))}
              onNodeClick={(_, n) => { if (n.id !== NEW) pick(n.id); }} onPaneClick={() => setSel(null)}
              onNodeDragStart={() => { dragging.current = true; }} onNodeDragStop={onDragStop}
              onConnect={onConnect} onConnectEnd={onConnectEnd}>
              <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} />
              <Controls showInteractive={false} />
              <Panel position="bottom-center" className="cv-legend">
                <span><i className="cg-dot mini" />{tr('工序')}</span>
                <span><i className="cg-shape k-hard s-none" />{tr('硬检查：用代码查，必须满足')}</span>
                <span><i className="cg-shape k-soft s-none" />{tr('软检查：负责人判断')}</span>
                <span><i className="cv-tdot" />{tr('派给 agent 的任务')}</span>
                <span className="cv-how">{tr('双击空白处新建 · 从节点边上的圆点拖出连线 · 点节点看详情')}</span>
              </Panel>
            </ReactFlow>
          </Cut.Provider>
          {!v && <p className="cv-wait muted">{tr('加载中…')}</p>}
        </div>

        {v && draft && (
          <aside className="cv-side">
            <NewForm key={draft.link ?? "free"} d={draft} v={v} busy={busy} onKind={kind => setDraft({ ...draft, kind })} onAdd={create} onCancel={() => setDraft(null)} />
          </aside>
        )}
        {v && cur && !draft && (
          <aside className={`cv-side${wide ? ' wide' : ''}`}>
            <header className="cv-side-h">
              <Mark n={cur} />
              <h3>{label(cur)}</h3>
              <Pill n={cur} />
              <button className="ib" title={wide ? tr('收窄') : tr('展开')} aria-pressed={wide} onClick={() => setWide(w => !w)}><Icon n={wide ? 'right' : 'left'} size={15} /></button>
              <button className="ib" title={tr('收起（Esc）')} aria-label={tr('收起')} onClick={() => setSel(null)}><Icon n="close" size={15} /></button>
            </header>
            <div className="cv-side-b">
              {cur.check ? <CheckDetail key={cur.id} c={cur.check} lead={v.lead} busy={busy} act={act} lineId={line.id} onConsole={onConsole} />
                : cur.kind === 'task' ? <TaskDetail key={cur.id} n={cur} v={v} busy={busy} act={act} lineId={line.id} onAgents={() => onConsole(line.id, { mod: 'agents' })} />
                  : cur.kind === 'note' ? <NoteDetail key={cur.id} n={cur} busy={busy} act={act} lineId={line.id} />
                    : <StageDetail n={cur} v={v} />}
              <Links n={cur} v={v} busy={busy} onPick={pick} onCut={cut} onNew={kind => beside(cur, kind)} />
              <footer className="cv-side-f">
                <button className="btn" disabled={busy} onClick={() => drop(cur)}>
                  {cur.kind === 'task' || cur.kind === 'note' || cur.check?.custom ? tr('删掉') : tr('从画布上拿掉')}
                </button>
                {cur.check && !cur.check.custom && <span className="small muted">{tr('拿掉后这项检查也不再查')}</span>}
              </footer>
            </div>
          </aside>
        )}
      </div>
    </div>,
    document.querySelector('.proto') ?? document.body, // the app's root: where the look's colours are
  );
}

// ---------- beside the canvas ----------

function Mark({ n }: { n: CanvasNode }) {
  if (n.check) return <i className={`cg-shape k-${n.check.kind} s-${n.check.on ? status(n.check) : 'none'}`} />;
  if (n.kind === 'stage') return <i className={`cg-dot mini st-${n.status}`} />;
  return <i className={n.kind === 'task' ? `cv-tdot t-${n.status}` : 'cv-ndot'} />;
}

function Pill({ n }: { n: CanvasNode }) {
  if (n.check) return <span className={`cg-pill s-${n.check.on ? status(n.check) : 'none'}`}>{n.check.on ? ST[status(n.check)] : tr('已关闭')}</span>;
  if (n.kind === 'stage') return <span className={`cg-pill st-${n.status}`}>{n.status === 'run' ? `${STAGE.run} · ${n.pct ?? 0}%` : STAGE[n.status ?? 'todo']}</span>;
  if (n.kind === 'task') return <span className={`cg-pill t-${n.status}`}>{TASK[(n.status ?? 'draft') as TaskStatus]}</span>;
  return null;
}

function StageDetail({ n, v }: { n: CanvasNode; v: CanvasView }) {
  const near = neighbours(n, v).map(x => x.o);
  const checks = near.filter(o => o.check?.on), bad = checks.filter(o => ['fail', 'warn'].includes(status(o.check!)));
  const tasks = near.filter(o => o.kind === 'task');
  return (
    <>
      <p className="cg-meta small muted">{tr('工序')}</p>
      <p className="cg-what">
        {checks.length ? tr('连着 {0} 项检查，{1} 项通过', checks.length, checks.filter(o => status(o.check!) === 'pass').length) : tr('还没有连着的检查')}
        {bad.length > 0 && <span className="bad-t"> · {tr('{0} 项有问题', bad.length)}</span>}
        {tasks.length > 0 && <> · {tr('{0} 件任务', tasks.length)}</>}
      </p>
      <p className="small muted">{tr('软检查连着哪道工序，就从项目走到那道工序开始问负责人；不连工序的一直会问。')}</p>
    </>
  );
}

function TaskDetail({ n, v, busy, act, lineId, onAgents }: { n: CanvasNode; v: CanvasView; busy: boolean; act: Act; lineId: string; onAgents: () => void }) {
  const [title, setTitle] = useState(n.title ?? '');
  const [text, setText] = useState(n.text ?? '');
  const [to, setTo] = useState<TaskTo>(n.to ?? 'lead');
  const st = (n.status ?? 'draft') as TaskStatus;
  const dirty = title.trim() !== (n.title ?? '') || text.trim() !== (n.text ?? '') || to !== n.to;
  const save = () => api.setNode(lineId, n.id, { title: title.trim(), text: text.trim(), to });
  const send = () => act(async () => { if (dirty) await save(); return api.sendNode(lineId, n.id); }, tr('发给{0}了', WHO[to]));
  const there = v.agents[to];
  return (
    <>
      <p className="cg-meta small muted">
        {tr('派给 agent 的任务')} · {n.id}
        {st === 'sent' && n.sent_at && ` · ${tr('{0}发出', ago(n.sent_at))}`}
      </p>
      {(st === 'done' || st === 'blocked') && n.result && (
        <blockquote className={`cg-verdict ${st === 'done' ? 's-pass' : 's-fail'}`}>
          <p>{n.result}</p>
          <footer className="small muted">{trx(n.by ?? '')}{n.done_at ? ` · ${ago(n.done_at)}` : ''}</footer>
        </blockquote>
      )}
      <div className="cv-form">
        <label className="field">{tr('交给谁')}
          <div className="seg" role="radiogroup" aria-label={tr('交给谁')}>
            {(['lead', 'coder', 'writer'] as const).map(k => (
              <button key={k} type="button" role="radio" aria-checked={to === k} disabled={st === 'sent' && k !== n.to} className={to === k ? 'on' : ''} onClick={() => setTo(k)}
                title={st === 'sent' && k !== n.to ? tr('已经发出去了；要换人先重新打开它') : ''}>{WHO[k]}</button>
            ))}
          </div>
        </label>
        {!there && <p className="small warn-t">{tr('这个项目的{0}还没有启动，任务会先留在画布上。', WHO[to])} <button className="lnk" onClick={onAgents}>{tr('去启动')}</button></p>}
        <label className="field">{tr('名字')}<input value={title} maxLength={60} onChange={e => setTitle(e.target.value)} /></label>
        <label className="field">{tr('要它做什么')}
          <textarea rows={6} value={text} maxLength={4000} placeholder={tr('写清楚要做的事和做到什么算完成；它会连同这个节点连着的检查、工序一起收到')} onChange={e => setText(e.target.value)} />
        </label>
      </div>
      <div className="cv-row">
        <button className="btn pri" disabled={busy || !there || !title.trim()} onClick={send}>
          <Icon n="send" size={13} />{st === 'draft' ? tr('发给{0}', WHO[to]) : dirty ? tr('改了，再发一次') : tr('再发一次')}
        </button>
        {dirty && <button className="btn" disabled={busy || !title.trim()} onClick={() => act(save, tr('保存了'))}>{tr('只保存')}</button>}
        {st === 'sent' && <button className="btn" disabled={busy} onClick={() => act(() => api.setNode(lineId, n.id, { status: 'done' }))}>{tr('标成完成')}</button>}
        {(st === 'done' || st === 'blocked') && <button className="btn" disabled={busy} onClick={() => act(() => api.setNode(lineId, n.id, { status: 'draft' }))}>{tr('重新打开')}</button>}
      </div>
      <p className="small muted">{tr('它做完会用 pt task {0} done 回一句结果，卡住了回 blocked；这句话也会成为一条汇报。', n.id)}</p>
    </>
  );
}

function NoteDetail({ n, busy, act, lineId }: { n: CanvasNode; busy: boolean; act: Act; lineId: string }) {
  const [text, setText] = useState(n.text ?? '');
  return (
    <>
      <p className="cg-meta small muted">{tr('备注：只给你自己看；连着任务时会一起发给 agent')}</p>
      <div className="cv-form">
        <textarea rows={7} value={text} maxLength={2000} onChange={e => setText(e.target.value)} />
      </div>
      {text.trim() !== (n.text ?? '') && (
        <div className="cv-row"><button className="btn pri" disabled={busy || !text.trim()} onClick={() => act(() => api.setNode(lineId, n.id, { text: text.trim() }), tr('保存了'))}>{tr('保存')}</button></div>
      )}
    </>
  );
}

const neighbours = (n: CanvasNode, v: CanvasView) => v.edges.flatMap(e => {
  if (e.source !== n.id && e.target !== n.id) return [];
  const o = v.nodes.find(x => x.id === (e.source === n.id ? e.target : e.source));
  return o ? [{ e, o }] : [];
});

function Links({ n, v, busy, onPick, onCut, onNew }: {
  n: CanvasNode; v: CanvasView; busy: boolean; onPick: (id: string) => void; onCut: (edgeId: string) => void; onNew: (k: Kind) => void;
}) {
  const near = useMemo(() => neighbours(n, v), [n, v]);
  return (
    <section className="cv-sec">
      <h5>{tr('连着的节点')}</h5>
      {near.length ? (
        <ul className="cv-links">
          {near.map(({ e, o }) => (
            <li key={e.id}>
              <button className="cv-link" onClick={() => onPick(o.id)}><Mark n={o} /><span>{label(o)}</span></button>
              <button className="ib" disabled={busy} title={tr('断开这条线')} aria-label={tr('断开这条线')} onClick={() => onCut(e.id)}><Icon n="close" size={13} /></button>
            </li>
          ))}
        </ul>
      ) : <p className="small muted">{tr('还没有连线：从它边上的圆点拖到另一个节点')}</p>}
      <div className="cv-row">
        <button className="btn" onClick={() => onNew('task')}><Icon n="plus" size={13} />{tr('在这里派任务')}</button>
        <button className="btn" onClick={() => onNew('soft')}><Icon n="plus" size={13} />{tr('加检查')}</button>
        <button className="btn" onClick={() => onNew('note')}><Icon n="plus" size={13} />{tr('加备注')}</button>
      </div>
    </section>
  );
}

function NewForm({ d, v, busy, onKind, onAdd, onCancel }: {
  d: Draft; v: CanvasView; busy: boolean; onKind: (k: Kind) => void; onAdd: (b: NewNode) => void; onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [to, setTo] = useState<TaskTo>('lead');
  const [prio, setPrio] = useState('P1');
  const from = d.link ? v.nodes.find(n => n.id === d.link) : null;
  const ok = d.kind === 'note' ? !!text.trim() : d.kind === 'task' ? !!title.trim() : !!title.trim() && !!text.trim();
  const body = (send: boolean): NewNode => ({ kind: d.kind, x: d.x, y: d.y, link: d.link, title: title.trim(), text: text.trim(), to, prio, send });
  return (
    <form className="cv-new" onSubmit={e => { e.preventDefault(); if (ok && !busy) onAdd(body(d.kind === 'task' && v.agents[to])); }}>
      <header className="cv-side-h">
        <i className="cv-ndot new" />
        <h3>{tr('新节点')}</h3>
        <button type="button" className="ib" title={tr('取消（Esc）')} aria-label={tr('取消')} onClick={onCancel}><Icon n="close" size={15} /></button>
      </header>
      <div className="cv-side-b">
        <div className="seg" role="radiogroup" aria-label={tr('节点的种类')}>
          {(['task', 'soft', 'hard', 'note'] as const).map(k => (
            <button key={k} type="button" role="radio" aria-checked={d.kind === k} className={d.kind === k ? 'on' : ''} onClick={() => onKind(k)}>{KIND[k]}</button>
          ))}
        </div>
        <p className="small muted">
          {d.kind === 'task' ? tr('一件交给 agent 的事：发出去后它会收到这段话和这个节点连着的东西，做完回一句结果。')
            : d.kind === 'soft' ? tr('一个要负责人读完项目再判断的问题，隔一阵再问一次。')
              : d.kind === 'hard' ? tr('一条用代码查的规则：论文里不许出现的写法，每次论文有变化就重查。')
                : tr('一张便签，写给自己，也可以连到任务上给 agent 看。')}
          {from && <> {tr('会连到「{0}」。', label(from))}</>}
        </p>
        <div className="cv-form">
          {d.kind === 'task' && (
            <label className="field">{tr('交给谁')}
              <div className="seg" role="radiogroup" aria-label={tr('交给谁')}>
                {(['lead', 'coder', 'writer'] as const).map(k => (
                  <button key={k} type="button" role="radio" aria-checked={to === k} className={to === k ? 'on' : ''} onClick={() => setTo(k)}>{WHO[k]}</button>
                ))}
              </div>
            </label>
          )}
          {d.kind === 'task' && !v.agents[to] && <p className="small warn-t">{tr('这个项目的{0}还没有启动，任务会先留在画布上。', WHO[to])}</p>}
          {d.kind !== 'note' && (
            <label className="field">{tr('名字')}
              <input autoFocus value={title} maxLength={d.kind === 'task' ? 60 : 20} onChange={e => setTitle(e.target.value)}
                placeholder={d.kind === 'task' ? tr('比如「补三个模块的消融」') : d.kind === 'soft' ? tr('比如「要有消融」') : tr('比如「不写 novel」')} />
            </label>
          )}
          <label className="field">
            {d.kind === 'task' ? tr('要它做什么') : d.kind === 'soft' ? tr('问负责人什么') : d.kind === 'hard' ? tr('论文里不能出现的（正则表达式，不分大小写）') : tr('备注')}
            {d.kind === 'hard'
              ? <input value={text} maxLength={500} placeholder={'\\bnovel\\b'} onChange={e => setText(e.target.value)} />
              : <textarea autoFocus={d.kind === 'note'} rows={d.kind === 'task' ? 6 : 4} value={text} maxLength={d.kind === 'task' ? 4000 : 2000} onChange={e => setText(e.target.value)}
                placeholder={d.kind === 'task' ? tr('写清楚要做的事和做到什么算完成；它会连同这个节点连着的检查、工序一起收到')
                  : d.kind === 'soft' ? tr('比如「每个模块都有消融实验吗？缺哪个列出来」') : ''} />}
          </label>
          {d.kind === 'hard' && (
            <label className="field">{tr('要求')}<Select value={prio} onChange={setPrio} options={[{ value: 'P0', label: tr('P0 · 必须过') }, { value: 'P1', label: tr('P1 · 尽量过') }]} /></label>
          )}
        </div>
        <div className="cv-row">
          {d.kind === 'task' && v.agents[to]
            ? <><button className="btn pri" type="submit" disabled={busy || !ok}><Icon n="send" size={13} />{tr('加上并发给{0}', WHO[to])}</button>
              <button className="btn" type="button" disabled={busy || !ok} onClick={() => onAdd(body(false))}>{tr('先放着')}</button></>
            : <button className="btn pri" type="submit" disabled={busy || !ok}>{tr('加上')}</button>}
          <button className="btn" type="button" onClick={onCancel}>{tr('取消')}</button>
        </div>
      </div>
    </form>
  );
}
