// A project's jobs as the experiments panel reads them, whichever backend ran them, and how they
// fall into days and groups.

import type { Job } from '../api';
import { LANG, tr } from '../i18n';
import { stOf } from './charts';
import { lastLine } from './util';

export const t = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);
// where a job ran: its machine and cards, or the backend that ran it
export const placeOf = (j: Job) => {
  const n = j.nvidb;
  if (!n) return j.backend;
  if (!n.node) return n.lane ?? (n.pool ? tr('池 {0}', n.pool) : tr('等分配'));
  return `${n.node} · ${n.gpu_ids.length ? `GPU ${n.gpu_ids.join(',')}` : 'CPU'}`;
};
export const startOf = (j: Job) => t(j.nvidb?.started_at ?? j.started_at);
export const endOf = (j: Job) => t(j.nvidb?.finished_at ?? j.ended_at);
export const stj = (j: Job) => stOf(j.nvidb?.state ?? j.status);
export const resOf = (j: Job) => j.nvidb?.result ?? j.result;
// what the assistant in the sidebar points at for a job, wherever the job is drawn
export const jobRef = (j: Job) => ({ 'data-ref': `job:${j.id}`, 'data-ref-label': `${tr('任务')} ${j.nvidb ? `#${j.nvidb.id} ` : ''}${j.name}` });
// when it last did something: finished, started, or was submitted
export const lastAt = (j: Job) => [endOf(j), startOf(j), t(j.created_at)].find(Number.isFinite) ?? 0;
// how long it has run: nvidb's count, or the clock for one still running
export const ranFor = (j: Job, now = Date.now()) => {
  const b = startOf(j);
  if (stj(j) === 'running' && Number.isFinite(b)) return (now - b) / 1000;
  return j.nvidb?.elapsed_s ?? (Number.isFinite(b) && Number.isFinite(endOf(j)) ? (endOf(j) - b) / 1000 : null);
};
// what a job has to say for itself in a line: its status line, what it waits for, why it failed
export function lineOf(j: Job) {
  const s = stj(j), n = j.nvidb;
  if (s === 'running') return n?.progress || placeOf(j);
  if (s === 'queued') return n?.held ? n.held_reason || tr('挂起') : n?.depends_on?.length ? tr('等 {0}', n.depends_on.map(x => `#${x}`).join(' '))
    : n?.lane ? tr('排在 {0}', n.lane) : tr('等一张放得下它的卡');
  if (s === 'failed') return lastLine(n?.last_error) || (n?.exit_code != null ? tr('退出码 {0}', n.exit_code) : tr('没有留下出错信息'));
  return '';
}

// a day's name: today, yesterday, then the date and weekday
export const dayOf = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
export function dayName(d: number) {
  const n = Math.round((dayOf(Date.now()) - d) / 864e5);
  const date = new Date(d);
  const wd = date.toLocaleDateString(LANG, { weekday: 'short' });
  return n === 0 ? tr('今天') : n === 1 ? tr('昨天') : `${date.getMonth() + 1}/${date.getDate()} ${wd}`;
}

export interface Group { key: string; label: string; hint: string; jobs: Job[] }
const SEP = /(?<=[-_.])/;

// By name: the longest start, at a "-", "_" or "." boundary, that at least three jobs share;
// what shares none falls into "other".
export function byName(jobs: Job[]): Group[] {
  const count = new Map<string, number>();
  const toks = new Map(jobs.map(j => [j.id, j.name.split(SEP)]));
  for (const ts of toks.values()) for (let k = 1; k < ts.length; k++) { const p = ts.slice(0, k).join(''); count.set(p, (count.get(p) ?? 0) + 1); }
  const out = new Map<string, Job[]>();
  for (const j of jobs) {
    const ts = toks.get(j.id)!;
    let key = '';
    for (let k = ts.length - 1; k >= 1 && !key; k--) { const p = ts.slice(0, k).join(''); if ((count.get(p) ?? 0) >= 3) key = p; }
    out.set(key, [...(out.get(key) ?? []), j]);
  }
  return [...out.entries()].map(([key, js]) => ({
    key: key || '·', label: key ? `${key}*` : tr('其他'), hint: key ? tr('名字以 {0} 开头', key) : tr('名字和别的任务都不像的'), jobs: js,
  }));
}

// By batch: jobs submitted within a few minutes of each other, which is how a sweep goes in
export function byBatch(jobs: Job[]): Group[] {
  const sorted = [...jobs].sort((a, b) => (t(a.created_at) || 0) - (t(b.created_at) || 0));
  const out: Job[][] = [];
  for (const j of sorted) {
    const g = out.at(-1);
    if (g && (t(j.created_at) || 0) - (t(g[g.length - 1].created_at) || 0) <= 5 * 60e3) g.push(j); else out.push([j]);
  }
  return out.map(js => {
    const at = t(js[0].created_at), common = commonStart(js.map(j => j.name));
    const time = Number.isFinite(at) ? `${dayName(dayOf(at))} ${new Date(at).toTimeString().slice(0, 5)}` : '';
    return { key: `b${js[0].id}`, label: common ? `${common}* · ${time}` : tr('{0} 提交的一批', time), hint: tr('{0} 前后几分钟里提交的', time), jobs: js };
  });
}

function commonStart(names: string[]) {
  if (names.length < 2) return '';
  const parts = names.map(n => n.split(SEP));
  let k = 0;
  while (parts.every(p => p.length > k + 1 && p[k] === parts[0][k])) k++;
  return parts[0].slice(0, k).join('');
}
