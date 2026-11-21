// The parts of a project's research flow. The console lists them in this order (console/Console.tsx) and the research
// loop frames its nodes by them (progress/Canvas.tsx, progress/LoopCard.tsx), so a part reads the same in both. The
// server keeps the same list and says which part a stage's work is in (pipeline.py: MODULES, STAGE_MOD): a stage and
// a node of the loop carry it as `mod`.

import type { IconName } from './console/icons';
import { tr } from './i18n';

export type FlowPart = 'overview' | 'survey' | 'code' | 'exp' | 'data' | 'paper' | 'agents';
export const FLOW: { id: FlowPart; name: string; sub: string; icon: IconName }[] = [
  { id: 'overview', name: tr('概览'), sub: tr('项目走到哪一步、在等你做什么'), icon: 'compass' },
  { id: 'survey', name: tr('调研'), sub: tr('查重结论、空白点、最接近的工作和方法，一页读完'), icon: 'lens' },
  { id: 'code', name: tr('代码仓库'), sub: tr('项目的代码：浏览、修改、对比改动'), icon: 'code' },
  { id: 'exp', name: tr('实验'), sub: tr('nvidb 上正在跑的、接下来要跑的任务'), icon: 'flask' },
  { id: 'data', name: tr('数据'), sub: tr('实验的元数据、结果和数据文件'), icon: 'table' },
  { id: 'paper', name: tr('论文'), sub: tr('LaTeX 源码和排出的 PDF，左右对照'), icon: 'doc' },
  { id: 'agents', name: tr('员工'), sub: tr('这个项目的负责人、代码员工和写作员工'), icon: 'people' },
];
export const PART = Object.fromEntries(FLOW.map(p => [p.id, p])) as Record<FlowPart, (typeof FLOW)[number]>;
