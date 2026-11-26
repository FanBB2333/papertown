// The research loop's nodes (Canvas.tsx draws them), each shaped by what it does. A stage is a station: how far it
// is, who works there, what it has made. A hard gate is a chamfered octagon with a plate (the stage's hard checks,
// one square each, before → after); opened, each check is a small octagon of its own. A soft sentinel is a capsule
// with a breathing ring and the lead's last word. The soft spec is a violet dashed letter, the hard clamp a dark-
// headed bar, the human gate an amber hexagon. A task is a ticket with a thick left edge: crimson when a gate sent
// it back, amber when a sentinel did. How much a node says follows the zoom (Canvas.tsx sets it on the flow, canvas.css
// reads it): everything up close; further out the small print fades and the name, state and figure grow; from far
// away <Far> fades in over the rest: a name and one figure in large type, the state as its colour.

import { modelText, StateWord, stateTone } from '../emphasis';
import { createContext, useContext } from 'react';
import { writePath, href, follow } from '../route';
import { Handle, NodeToolbar, Position, type Node, type NodeProps } from '@xyflow/react';
import type { CanvasNode, CanvasView, ProjectCard, TaskStatus, TaskTo } from '../api';
import { ago } from '../console/util';
import { Icon } from '../console/icons';
import { tr, trx } from '../i18n';
import { InfoBody, INFO_ICON, infoKind, InfoState } from './CanvasInfo';
import { clip, label, TASK, WHO, type Kind } from './CanvasSide';
import { status } from './Checks';
import { bad, gateChecks, gateLook, GATE_ST, level, LEVEL, ROLE, stationLine, VERDICT } from './loop';

export type FNode = Node<{ n: CanvasNode }>;

// what the nodes and lines can do, from wherever they are drawn
export interface Ops {
  busy: boolean; agents: CanvasView['agents'] | null; editing: string | null; r: ProjectCard; v: CanvasView | null;
  edit: (edgeId: string | null) => void; relabel: (edgeId: string, text: string) => void; cut: (edgeId: string) => void;
  order: (edgeId: string, b: { order?: boolean; flip?: boolean }) => void; // make a line between two tasks an order line or a plain one, or turn it round
  fix: (n: CanvasNode) => void; ask: (n: CanvasNode) => void; send: (n: CanvasNode, chain?: boolean) => void; gate: (stage: string, what: 'open' | 'close' | 'rework') => void;
  beside: (n: CanvasNode, k: Kind) => void; dup: (n: CanvasNode) => void; drop: (n: CanvasNode) => void;
}
export const OpsCtx = createContext<Ops | null>(null);
export const mine = (n: CanvasNode) => n.kind === 'task' || n.kind === 'note' || !!n.check?.custom;
const KIND_OF: Record<CanvasNode['kind'], string> = {
  stage: tr('工序'), gate: tr('硬卡口'), hard: tr('硬检查'), soft: tr('软巡检'), spec: tr('软限制'), clamp: tr('硬边界'), human: tr('人类拍板'),
  task: tr('任务节点'), note: tr('备注'), info: tr('资料卡'),
};
export const kindOf = (n: CanvasNode) => (n.kind === 'task' && n.loop === 'hard' ? tr('修补单') : n.kind === 'task' && n.loop === 'soft' ? tr('纠偏任务') : KIND_OF[n.kind]);
// what the assistant can point at and light up (console/page.ts): every node, by its id
const refOf = (n: CanvasNode) => ({ 'data-ref': `node:${n.id}`, 'data-ref-label': `${kindOf(n)}「${label(n)}」（${n.id}）` });
const STAGES = ['idea', 'hatch', 'team', 'method', 'exp', 'write', 'review', 'ship'];

// what a node says from far away, in place of everything else in it
const Far = ({ t, x }: { t?: React.ReactNode; x?: React.ReactNode }) => <div className="cv-far"><b>{t}</b>{x ? <em>{x}</em> : null}</div>;

const SIDES = [Position.Top, Position.Right, Position.Bottom, Position.Left];
const Ports = () => <>{SIDES.map(p => <Handle key={p} id={p} type="source" position={p} />)}</>;

// the few things a selected node can do at once, above it
function Tools({ n, on }: { n: CanvasNode; on: boolean }) {
  const o = useContext(OpsCtx);
  if (!o) return null;
  const g = n.gate, hardGate = n.kind === 'hard' && n.check?.stage ? o.v?.nodes.find(x => x.id === `gate:${n.check!.stage}`) : null;
  return (
    <NodeToolbar isVisible={on} position={Position.Top} offset={10} className="cv-tb" onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
      {g && g.state === 'block' && <button className="t" disabled={o.busy} onClick={() => o.gate(g.stage, 'rework')} title={tr('将未通过规则生成修补单，派发给该工序员工')}><Icon n="refresh" size={13} />{g.ticket ? tr('退回一轮') : tr('派发修补单')}</button>}
      {g && g.checks.length > 1 && <button className="t" disabled={o.busy} onClick={() => o.gate(g.stage, g.open ? 'close' : 'open')}>{g.open ? tr('收起') : tr('展开 {0} 条', g.checks.length)}</button>}
      {hardGate?.gate?.state === 'block' && n.check && bad(n.check) && <button className="t" disabled={o.busy} onClick={() => o.gate(hardGate.gate!.stage, 'rework')}><Icon n="refresh" size={13} />{tr('派发修补单')}</button>}
      {n.kind === 'soft' && n.check && bad(n.check) && <button className="t" onClick={() => o.fix(n)} title={tr('创建纠偏任务并关联至监测工序，确认后派发')}><Icon n="wand" size={13} />{tr('指派纠偏')}</button>}
      {n.check?.on && n.check.kind === 'soft' && <button className="t" disabled={o.busy} onClick={() => o.ask(n)}><Icon n="send" size={13} />{tr('立即询问')}</button>}
      {n.kind === 'task' && n.status === 'draft' && (
        <button className="t" disabled={o.busy || !(n.agent_id ? n.agent?.started : o.agents?.[n.to ?? 'lead'].there)} onClick={() => o.send(n)}><Icon n="send" size={13} />{tr('发送')}</button>
      )}
      <button title={tr('在旁派发任务')} aria-label={tr('在旁派发任务')} onClick={() => o.beside(n, 'task')}><Icon n="plus" size={14} /></button>
      {(n.kind === 'task' || n.kind === 'note') && <button title={tr('创建副本')} aria-label={tr('创建副本')} onClick={() => o.dup(n)}><Icon n="copy" size={13} /></button>}
      <button className="danger" title={mine(n) ? tr('删掉') : tr('从回路上拿掉')} aria-label={mine(n) ? tr('删掉') : tr('从回路上拿掉')} onClick={() => o.drop(n)}><Icon n="close" size={13} /></button>
    </NodeToolbar>
  );
}

// ---------- the spine ----------

function StageNode({ data: { n }, selected, dragging }: NodeProps<FNode>) {
  const o = useContext(OpsCtx);
  const st = n.status ?? 'todo', pct = st === 'done' ? 100 : n.pct ?? 0, who = n.role && o?.v ? o.v.agents[n.role] : null;
  const line = o?.v ? stationLine(n, o.r, o.v) : '';
  return (
    <div className={`cv-n cv-st st-${st}${n.locked ? ' locked' : ''}${selected ? ' on' : ''}`} {...refOf(n)}>
      <span className="cv-ring" style={{ ['--pct' as string]: `${pct}%` }}>
        {n.locked ? <Icon n="lock" size={13} /> : st === 'done' ? <Icon n="check" size={14} /> : <b className="em-num">{pct}<small>%</small></b>}
      </span>
      <div className="cv-st-b">
        <small>STAGE {String(STAGES.indexOf(n.ref ?? '') + 1).padStart(2, '0')}</small>
        <b>{n.title}</b>
        {line && <p title={line} className={n.locked ? 'em-state' : undefined} data-tone="bad">{modelText(line)}</p>}
      </div>
      {n.role && <em className="cv-who" title={who?.there ? '' : tr('尚未启动')}><i className={`dot s-${who?.there ? who.status : 'stopped'}`} />{ROLE[n.role as TaskTo]}</em>}
      {st === 'run' && <span className="cv-st-bar"><i style={{ width: `${pct}%` }} /></span>}
      <Far t={n.title} x={n.locked ? <StateWord state="blocked">{tr('锁住')}</StateWord> : st === 'run' ? <span className="em-num">{pct}%</span> : ''} />
      <Ports /><Tools n={n} on={selected && !dragging} />
    </div>
  );
}

const prios = (xs: { prio: string }[]) => [...new Set(xs.map(c => c.prio).filter(Boolean))].sort().join('/');

function GateNode({ data: { n }, selected, dragging }: NodeProps<FNode>) {
  const o = useContext(OpsCtx);
  const g = n.gate;
  if (!g || !o?.v) return null;
  const cs = gateChecks(o.v, g), on = cs.filter(c => c.on), look = gateLook(g), one = cs.length === 1 ? cs[0] : null;
  const val = one?.last?.value;
  return (
    <div className={`cv-gw g-${look}${selected ? ' on' : ''}`} {...refOf(n)}>
      <div className="cv-n cv-gate">
        <header><i className="cv-dia" /><span>HARD · {prios(on) || 'P1'}</span><em className="cv-chip"><StateWord state={look}>{g.waived && g.state === 'block' ? tr('已放行') : GATE_ST[look]}</StateWord></em></header>
        <p className="cv-gate-t">
          <b>{one ? trx(one.title) : tr('{0}卡口组', g.name)}</b>
          <span className="cv-num em-num" data-tone={stateTone(look) ?? 'info'}>{one ? (val != null ? `${val} / ≤${one.max ?? 0}` : '—') : tr('{0}/{1} 过', g.pass, g.total)}</span>
        </p>
        {!one && <span className="cv-matrix">{cs.map(c => <i key={c.id} className={`m-${level(c)}`} title={`${trx(c.title)} · ${c.on ? (level(c) === 'pass' ? tr('放行') : level(c) === 'none' ? tr('尚未检查') : LEVEL[level(c)]) : tr('已关闭')}`} />)}</span>}
        <small><span className={g.before !== g.now ? 'em-mark' : undefined}>{g.before !== g.now ? tr('R1:{0}处 → R{1}:{2}处', g.before, o.v.rounds, g.now) : g.now ? tr('剩余 {0} 处', g.now) : look === 'none' ? tr('暂无可查项') : tr('全部放行')}</span>
          {g.ticket && g.round > 0 && !g.waived && look === 'block' && <> · {tr('第 {0} 轮', g.round)}</>}</small>
        <Far t={one ? trx(one.title) : tr('{0}卡口', g.name)} x={one && val != null ? <span className="em-num" data-tone={stateTone(look)}>{val}/{one.max ?? 0}</span> : g.total ? <span className="em-num">{g.pass}/{g.total}</span> : ''} />
      </div>
      <Ports /><Tools n={n} on={selected && !dragging} />
    </div>
  );
}

const ruleNo = (rule: string) => rule.replace(/^lastcheck\s*/, '');

function HardNode({ data: { n }, selected, dragging }: NodeProps<FNode>) {
  const c = n.check;
  if (!c) return null;
  const lv = level(c), val = c.last?.value, first = c.first?.value;
  return (
    <div className={`cv-gw g-${lv === 'none' ? 'none' : lv} small${selected ? ' on' : ''}`} {...refOf(n)}>
      <div className="cv-n cv-gate">
        <header><i className="cv-dia" /><span>HARD · {ruleNo(trx(c.rule))} {c.prio}</span><em className="cv-chip"><StateWord state={lv}>{lv === 'pass' ? tr('放行') : lv === 'off' ? tr('已关闭') : lv === 'none' ? tr('尚未检查') : LEVEL[lv]}</StateWord></em></header>
        <p className="cv-gate-t"><b>{trx(c.title)}</b><span className="cv-num em-num" data-tone={stateTone(lv) ?? 'info'}>{val != null ? `${val} / ≤${c.max ?? 0}` : '—'}</span></p>
        <small>{first != null && val != null && first !== val ? <mark className="em-mark">{tr('R1:{0} → 当前:{1}', first, val)}</mark> : c.last?.findings[0]?.file ? `${c.last.findings[0].file}:${c.last.findings[0].line}` : trx(c.rule)}
          {first && val === 0 ? ` · ${tr('清零')}` : ''}</small>
        <Far t={trx(c.title)} x={val != null ? <span className="em-num" data-tone={stateTone(lv)}>{val}/{c.max ?? 0}</span> : ''} />
      </div>
      <Ports /><Tools n={n} on={selected && !dragging} />
    </div>
  );
}

// ---------- the soft layer ----------

function SoftNode({ data: { n }, selected, dragging }: NodeProps<FNode>) {
  const v = useContext(OpsCtx)?.v;
  const c = n.check;
  if (!c) return null;
  const k = c.on ? status(c) : 'none', last = c.last;
  // its line to the stage it watches is drawn only when asked for, so the capsule says which
  const to = v?.edges.find(e => e.kind === 'watch' && e.source === n.id)?.target, stage = to ? v?.nodes.find(x => x.id === to) : null;
  return (
    <div className={`cv-n cv-sen v-${k}${c.on ? '' : ' off'}${selected ? ' on' : ''}`} {...refOf(n)}>
      <header>
        <i className="cv-ring2" /><span>SOFT · {stage ? tr('监测{0}', stage.title ?? '') : tr('持续询问')} · {tr('每 {0}h', c.every ?? 24)}</span>
        {c.due && <em className="cv-chip due">{tr('到期')}</em>}
        <em className="cv-chip"><StateWord state={k}>{c.on ? VERDICT[k] : tr('已关闭')}</StateWord></em>
      </header>
      <p className="cv-sen-t"><b>{trx(c.title)}</b><span className="cv-dots">{c.history.slice(-4).map((h, i) => <i key={i} className={`s-${h.status}`} />)}</span></p>
      <q>{last?.note ? modelText(last.note, 46) : clip(trx(c.text), 46)}</q>
      <Far t={trx(c.title)} x={c.on && ['pass', 'warn', 'fail'].includes(k) ? <StateWord state={k}>{VERDICT[k]}</StateWord> : ''} />
      <Ports /><Tools n={n} on={selected && !dragging} />
    </div>
  );
}

function SpecNode({ data: { n }, selected, dragging }: NodeProps<FNode>) {
  const rules = n.rules ?? [];
  return (
    <div className={`cv-n cv-spec${selected ? ' on' : ''}`} {...refOf(n)}>
      <header><i className="cv-spdot" /><span>SOFT SPEC · Prompt / AGENTS.md</span></header>
      <b className={rules.length ? 'em-bar' : undefined}>{rules.length ? clip(rules[0].text, 30) : tr('项目简报与 agent 要求')}</b>
      <small>{rules.length ? tr('{0} 条要求 · 概率引导，下游验证', rules.length) : tr('工作边界中尚未填写要求 · 概率引导')}</small>
      <Far t={tr('软限制')} x={rules.length ? tr('{0} 条', rules.length) : ''} />
      <Ports /><Tools n={n} on={selected && !dragging} />
    </div>
  );
}

function ClampNode({ data: { n }, selected, dragging }: NodeProps<FNode>) {
  const rules = n.rules ?? [];
  const what = rules.length ? rules.slice(0, 2).map(r => clip(r.text, 16)).join(' · ') : tr('暂无绑定动作的边界');
  return (
    <div className={`cv-n cv-clamp${selected ? ' on' : ''}`} {...refOf(n)}>
      <header><i /><span>HARD CLAMP · {tr('代码硬边界')}</span></header>
      <div><b>{what}</b><small>{tr('bounds.never / ask · {0} 条 · 服务端直接拦截', rules.length)}</small></div>
      <Far t={tr('硬边界')} x={rules.length ? tr('{0} 条', rules.length) : ''} />
      <Ports /><Tools n={n} on={selected && !dragging} />
    </div>
  );
}

// ---------- the loop back ----------

function HumanNode({ data: { n }, selected, dragging }: NodeProps<FNode>) {
  const items = n.items ?? [], seq = useContext(OpsCtx)?.r.line.seq;
  const matter = items.find(i => i.kind === 'matter');
  const to = seq && matter ? writePath(seq, 'matter', matter.ask ?? matter.id) : null;
  return (
    <div className={`cv-hw${items.length ? ' has' : ''}${selected ? ' on' : ''}`} {...refOf(n)}>
      <div className="cv-n cv-human">
        <header><Icon n="person" size={13} /><span>HUMAN GATE · {tr('人类拍板节点')}</span></header>
        <b className={items.length ? 'em-bar' : undefined} data-tone="warn">{items.length ? tr('{0} 件待你拍板', items.length) : tr('暂无待你拍板事项')}</b>
        <small>{to && matter ? <a className="nodrag nopan" href={href(to)} onClick={e => { e.stopPropagation(); follow(e, to); }}>{modelText(matter.text, 40)} ↗</a>
          : items.length ? modelText(items[0].text, 40) : tr('超轮次卡口、偏离巡检及 agent 提问将汇集在此处')}</small>
        <Far t={tr('人类拍板')} x={items.length ? <span className="em-num" data-tone="warn">{tr('{0} 件', items.length)}</span> : ''} />
      </div>
      <Ports /><Tools n={n} on={selected && !dragging} />
    </div>
  );
}

function nodeText(n: CanvasNode, limit: number) {
  return n.created_by === 'assistant' || n.created_by === 'papertown' ? modelText(n.text, limit) : clip(n.text, limit);
}

function TaskNode({ data: { n }, selected, dragging }: NodeProps<FNode>) {
  const st = (n.status ?? 'draft') as TaskStatus, role = useContext(OpsCtx)?.agents?.[n.to ?? 'lead'];
  const who = n.agent_id ? { there: !!n.agent?.started, status: n.agent?.status } : role;
  const when = st === 'sent' ? n.sent_at : st === 'draft' ? null : n.done_at;
  const head = n.loop === 'hard' ? tr('硬退回修补单 · 第 {0} 轮', n.round || 1) : n.loop === 'soft' ? tr('软纠偏任务单') : tr('任务');
  const wait = n.waits?.[0];
  const trail = n.trail ?? [];
  return (
    <div className={`cv-n cv-task t-${st} l-${n.loop ?? 'plain'}${n.converged ? ' conv' : ''}${n.escalated ? ' esc' : ''}${n.stale ? ' stale' : ''}${selected ? ' on' : ''}`} {...refOf(n)}>
      <header>
        {n.loop === 'hard' ? <Icon n="refresh" size={11} /> : n.loop === 'soft' ? <Icon n="spark" size={11} /> : <i className={`dot s-${who?.there ? who.status : 'stopped'}`} />}
        <span>{head} · {n.id} · {WHO[n.to ?? 'lead']}</span>
        <em className={n.escalated ? 'warn' : st === 'blocked' ? 'bad' : undefined}>{n.converged ? tr('已收敛') : n.escalated ? tr('待你拍板') : TASK[st]}</em>
      </header>
      <b>{n.title}</b>
      {st === 'queued' && <p className="turn"><Icon n="clock" size={11} />{n.wait_note ? tr('派发失败，将自动重试') : wait?.kind === 'dir' ? tr('等待 {0} 释放工作目录', wait.id) : wait ? tr('等待 {0} {1}', (n.waits ?? []).map(w => w.id).join('、'), wait.stale ? tr('复核') : tr('完成')) : tr('轮到时自动派发')}</p>}
      {n.stale && <p className="turn again em-bar" data-tone="warn"><Icon n="refresh" size={11} />{tr('前序已重做，结果待复核')}</p>}
      {n.loop === 'hard' && trail.length > 0
        ? <p>{tr('收敛进度：{0}', trail.map(x => tr('{0} 处', x)).join(' → '))}</p>
        : n.text && <p className={n.created_by === 'you' ? 'two user-words em-bar' : 'two'}>{nodeText(n, 96)}</p>}
      {n.result && <p className="res">{modelText(n.result, 60)}</p>}
      {when && <small>{st === 'sent' ? tr('{0}派发', ago(when)) : ago(when)}{(n.log?.length ?? 0) > 2 && ` · ${tr('{0} 条记录', n.log?.length ?? 0)}`}</small>}
      <Far t={n.title} x={n.converged ? tr('已收敛') : n.escalated || n.stale ? <span className="em-state" data-tone="warn">{n.escalated ? tr('待你拍板') : tr('待复核')}</span> : <StateWord state={st}>{TASK[st]}</StateWord>} />
      <Ports /><Tools n={n} on={selected && !dragging} />
    </div>
  );
}

function NoteNode({ data: { n }, selected, dragging }: NodeProps<FNode>) {
  const words = n.created_by === 'you' ? 'user-words em-bar' : undefined;
  return <div className={`cv-n cv-note${selected ? ' on' : ''}`} {...refOf(n)}><p className={words}>{nodeText(n, 120)}</p><Far t={<span className={words}>{nodeText(n, 24)}</span>} /><Ports /><Tools n={n} on={selected && !dragging} /></div>;
}

// the project live: its progress card, an agent, its jobs, code, paper or outputs (CanvasInfo.tsx)
function InfoNode({ data: { n }, selected, dragging }: NodeProps<FNode>) {
  const o = useContext(OpsCtx);
  if (!o?.v) return null;
  return (
    <div className={`cv-n cv-info i-${infoKind(n)}${selected ? ' on' : ''}`} style={{ width: n.w, height: n.h }} {...refOf(n)}>
      <header><Icon n={INFO_ICON[infoKind(n)] ?? 'doc'} size={13} /><b>{n.title}</b><InfoState n={n} r={o.r} v={o.v} /></header>
      <div className="ci-body"><InfoBody n={n} r={o.r} v={o.v} /></div>
      <Far t={n.title} />
      <Ports /><Tools n={n} on={selected && !dragging} />
    </div>
  );
}

// where a node being written will land
function GhostNode({ data: { n } }: NodeProps<FNode>) {
  return <div className="cv-n cv-ghost"><Icon n="plus" size={13} />{n.title}<Ports /></div>;
}

export const nodeTypes = {
  stage: StageNode, gate: GateNode, hard: HardNode, soft: SoftNode, spec: SpecNode, clamp: ClampNode, human: HumanNode,
  task: TaskNode, note: NoteNode, info: InfoNode, ghost: GhostNode,
};
