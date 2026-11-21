// What the research loop's pieces (Canvas.tsx, LoopNodes.tsx, CanvasSide.tsx, LoopCard.tsx, LoopReport.tsx) say
// about it in common: the words for a gate's state and a sentinel's verdict, a gate's checks, what wants you.

import type { CanvasNode, CanvasView, Check, Gate, GateState, ProjectCard, TaskTo } from '../api';
import type { FlowPart } from '../flow';
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

// A block of the loop (a part of the research flow, flow.ts) in a few words, for its header: how its stages stand, the
// worst of its gates, its sentinels' warnings, its tasks and, in the overview, what waits for you.
export interface Pill { text: string; tone: 'pass' | 'warn' | 'bad' | 'run' | 'none' }
export function blockPills(key: FlowPart, ns: CanvasNode[]): Pill[] {
  const out: Pill[] = [];
  const stages = ns.filter(n => n.kind === 'stage'), tasks = ns.filter(n => n.kind === 'task');
  if (stages.length) {
    const done = stages.filter(s => s.status === 'done').length;
    out.push({ text: tr('工序 {0}/{1}', done, stages.length), tone: stages.some(s => s.status === 'fail') ? 'bad' : done === stages.length ? 'pass'
      : stages.some(s => s.status === 'wait') ? 'warn' : stages.some(s => s.status === 'run') ? 'run' : 'none' });
  }
  const looks = ns.filter(n => n.kind === 'gate' && n.gate).map(n => gateLook(n.gate!));
  if (looks.includes('block')) out.push({ text: tr('卡口阻断'), tone: 'bad' });
  else if (looks.includes('warn')) out.push({ text: tr('卡口告警'), tone: 'warn' });
  else if (looks.length && looks.every(l => l === 'pass')) out.push({ text: tr('卡口放行'), tone: 'pass' });
  const off = ns.filter(n => n.kind === 'soft' && n.check?.on && ['warn', 'fail'].includes(status(n.check))).length;
  if (off) out.push({ text: tr('巡检预警 {0}', off), tone: 'warn' });
  if (tasks.length) {
    const open = tasks.filter(t => t.status !== 'done').length, stuck = tasks.filter(t => t.status === 'blocked' || t.stale).length;
    out.push({ text: stuck ? tr('任务 {0} · {1} 待处理', tasks.length, stuck) : open ? tr('任务 {0} · {1} 未完成', tasks.length, open) : tr('任务 {0} · 已完成', tasks.length),
      tone: stuck ? 'bad' : open ? 'run' : 'pass' });
  }
  const mine = key === 'overview' ? ns.find(n => n.kind === 'human')?.items?.length ?? 0 : 0;
  if (mine) out.push({ text: tr('{0} 件等你拍板', mine), tone: 'warn' });
  return out;
}
// what the project has in a part of the flow, as the console's overview says it: its repository, jobs, results, paper, agents
export function partLine(key: FlowPart, r: ProjectCard, v: CanvasView): string {
  const code = r.repos.code, paper = r.repos.paper, j = r.jobs, c = r.card;
  if (key === 'overview') return c ? [c.progress != null && `${c.progress}%`, c.milestone].filter(Boolean).join(' · ') : '';
  if (key === 'code') return code && !code.missing ? [code.name, code.branch, code.dirty ? tr('{0} 处改动', code.dirty) : ''].filter(Boolean).join(' · ') : tr('暂无代码仓库');
  if (key === 'exp') return [j.running && tr('{0} 在跑', j.running), j.queued && tr('{0} 排队', j.queued), j.done && tr('{0} 个有结果', j.done), j.failed && tr('{0} 失败', j.failed)].filter(Boolean).join(' · ');
  if (key === 'paper') return paper && !paper.missing ? [paper.main ?? paper.name, paper.pdf ? 'PDF' : tr('还没编译')].filter(Boolean).join(' · ') : tr('暂无论文仓库');
  if (key === 'agents') return (['lead', 'coder', 'writer'] as const).filter(x => v.agents[x].there).map(x => ROLE[x]).join(' · ') || tr('还没有 agent');
  return '';
}

// the line a station shows under its name: what its stage has produced, from the project's card
export function stationLine(n: CanvasNode, r: ProjectCard, v: CanvasView): string {
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
