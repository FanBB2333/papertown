// What the research loop's pieces (Canvas.tsx, LoopNodes.tsx, CanvasSide.tsx, LoopCard.tsx, LoopReport.tsx) say
// about it in common: the words for a gate's state and a sentinel's verdict, a gate's checks, what wants you.

import type { CanvasNode, CanvasView, Check, Gate, GateState, TaskTo } from '../api';
import { tr, trx } from '../i18n';
import { status } from './Checks';

export const loopPath = (seq: number) => `/progress/${seq}/loop`;
export const GATE_ST: Record<GateState, string> = { pass: tr('放行'), warn: tr('告警'), block: tr('阻断'), none: tr('还没查'), off: tr('已关闭') };
export const LEVEL: Record<string, string> = { block: tr('阻断'), warn: tr('告警') };
export const VERDICT: Record<string, string> = { pass: tr('契合'), warn: tr('预警'), fail: tr('偏离'), wait: tr('待判断'), none: tr('待判断') };
export const ROLE: Record<TaskTo, string> = { lead: tr('负责人'), coder: tr('代码员工'), writer: tr('写作员工') };

export const checkMap = (v: CanvasView) => new Map(v.checks.map(c => [c.id, c]));
export const gateChecks = (v: CanvasView, g: Gate) => g.checks.map(id => v.checks.find(c => c.id === id)).filter((c): c is Check => !!c);
export const bad = (c: Check) => c.on && ['fail', 'warn'].includes(status(c));
// how many places a hard check finds beyond what it allows: what the loop drives down to nothing
export const over = (c: Check, value: number | null | undefined) => (value != null && value > (c.max ?? 0) ? value : 0);
// a hard check at its gate: passes, only warns, or blocks the next stage
export const level = (c: Check): 'pass' | 'warn' | 'block' | 'none' | 'off' =>
  !c.on ? 'off' : bad(c) ? (c.gate === 'block' ? 'block' : 'warn') : status(c) === 'pass' ? 'pass' : 'none';
// a gate's state for what you see: one you let through reads as let through
export const gateLook = (g: Gate): GateState => (g.waived && g.state === 'block' ? 'warn' : g.state);

// the first round's count, the rounds since and now: R1 → … → Rn of the whole loop
export function trail(v: CanvasView): number[] {
  const pts = v.trend.map(p => p.found);
  const out: number[] = [];
  for (const n of pts) if (out[out.length - 1] !== n) out.push(n);
  return out.length > 5 ? [out[0], ...out.slice(-4)] : out;
}
export const drop = (a: number | null, b: number | null) => (a && b != null && a > b ? Math.round(((a - b) / a) * 100) : 0);

// what on the loop wants you: a gate that blocks or warns, a check that fails or is due, a task not finished, a stage
// waiting on you or locked, the human gate with something on it
export const needs = (n: CanvasNode) => {
  if (n.kind === 'gate') return !!n.gate && ['block', 'warn'].includes(gateLook(n.gate));
  if (n.check) return n.check.on && (['fail', 'warn'].includes(status(n.check)) || !!n.check.due);
  if (n.kind === 'task') return n.status !== 'done' || !!n.stale; // a result to be looked at again is yours to settle
  if (n.kind === 'stage') return n.status === 'wait' || !!n.locked;
  if (n.kind === 'human') return !!n.items?.length;
  return false;
};
// which side of the loop a node is on, for the 硬卡口 and 软巡检 views
export const side = (n: CanvasNode): 'hard' | 'soft' | 'both' | 'none' =>
  n.kind === 'gate' || n.kind === 'hard' || n.kind === 'clamp' || n.loop === 'hard' ? 'hard'
    : n.kind === 'soft' || n.kind === 'spec' || n.loop === 'soft' ? 'soft'
      : n.kind === 'stage' || n.kind === 'human' ? 'both' : 'none';

// the line a station shows under its name: what its stage has produced, from the project's card
export function stationLine(n: CanvasNode, r: import('../api').ProjectCard, v: CanvasView): string {
  const k = n.ref, paper = r.repos.paper, code = r.repos.code;
  if (n.locked) return tr('等「{0}」卡口清零', trx(n.locked.title));
  if (k === 'exp' && (r.jobs.done || r.jobs.running || r.jobs.queued || r.jobs.failed)) {
    return [r.jobs.done && tr('{0} 完成', r.jobs.done), r.jobs.running && tr('{0} 在跑', r.jobs.running), r.jobs.queued && tr('{0} 排队', r.jobs.queued),
      r.jobs.failed && tr('{0} 失败', r.jobs.failed)].filter(Boolean).join(' · ');
  }
  if ((k === 'write' || k === 'ship') && paper && !paper.missing) {
    const words = paper.words ? (paper.words >= 1000 ? `${(paper.words / 1000).toFixed(1)}k` : String(paper.words)) : '';
    return k === 'write' ? [paper.main, words && tr('{0} 词', words), paper.pdf ? 'PDF' : ''].filter(Boolean).join(' · ')
      : paper.pdf ? tr('PDF + 源码') : tr('还没有 PDF');
  }
  if (k === 'method' && code && !code.missing) return [code.branch, code.files && tr('{0} 个文件', code.files)].filter(Boolean).join(' · ');
  if (k === 'team') return (['lead', 'coder', 'writer'] as const).filter(x => v.agents[x].there).map(x => ROLE[x]).join(' · ') || tr('还没有 agent');
  return trx(n.note ?? '');
}
