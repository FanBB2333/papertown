// A project's canvas (研究画布), as its page in 进展 shows it: how its checks and tasks stand, and a small picture of
// the graph that opens the full-window canvas (Canvas.tsx).

import { useCallback, useEffect, useState } from 'react';
import { api, listen, type CanvasNode, type CanvasView, type ProjectCard } from '../api';
import { Icon } from '../console/icons';
import { tr, trx } from '../i18n';
import { follow, href } from '../route';
import { status, Trend } from './Checks';
import './canvas.css';

export const canvasPath = (seq: number) => `/progress/${seq}/canvas`;

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

// how a node is drawn small: its size on the canvas and the colour of its state
export const SIZE: Record<CanvasNode['kind'], [number, number]> = { stage: [168, 58], hard: [176, 36], soft: [176, 36], task: [216, 78], note: [190, 76] };
export const tone = (n: CanvasNode) =>
  n.kind === 'stage' ? `st-${n.status}` : n.kind === 'task' ? `t-${n.status}` : n.kind === 'note' ? 'note'
    : n.check && !n.check.on ? 's-none' : `s-${n.check ? status(n.check) : 'none'}`;

export function Summary({ v }: { v: CanvasView }) {
  const h = v.summary.hard, s = v.summary.soft, t = v.tasks;
  return (
    <span className="cg-sum">
      <span><i className="cg-shape k-hard s-pass" />{tr('硬检查')} <b>{h.pass}/{h.total - h.none}</b>{h.fail > 0 && <em className="bad-t">{tr('{0} 项没过', h.fail)}</em>}</span>
      <span><i className="cg-shape k-soft s-pass" />{tr('软检查')} <b>{s.pass}/{s.total}</b>{s.warn + s.fail > 0 && <em className="warn-t">{tr('{0} 项有问题', s.warn + s.fail)}</em>}</span>
      {t.draft + t.sent + t.done + t.blocked > 0 && (
        <span><i className="cv-tdot" />{tr('派的任务')} <b>{t.done}/{t.draft + t.sent + t.done + t.blocked}</b>
          {t.sent > 0 && <em className="muted">{tr('{0} 件在做', t.sent)}</em>}{t.blocked > 0 && <em className="bad-t">{tr('{0} 件卡住', t.blocked)}</em>}</span>
      )}
      {v.rounds > 0 && <span className="muted" title={tr('论文和实验每变一次、查出的结果有变化，算一轮')}>{tr('第 {0} 轮', v.rounds)}</span>}
    </span>
  );
}

export function CanvasCard({ r }: { r: ProjectCard }) {
  const [v] = useCanvas(r.line.id);
  const to = canvasPath(r.line.seq);
  if (!v) return null;
  return (
    <section className="psec cv-card" id="canvas" aria-label={tr('研究画布')}>
      <header className="psec-h">
        <h3><Icon n="map" size={16} />{tr('研究画布')}</h3>
        <Summary v={v} />
        <Trend points={v.trend} />
        <a className="btn pri cv-open" href={href(to)} onClick={e => follow(e, to)}><Icon n="ext" size={14} />{tr('打开画布')}</a>
      </header>
      <div className="cv-card-b">
        <a className="cv-mini" href={href(to)} onClick={e => follow(e, to)} title={tr('打开画布：看每个节点的细节，加任务、改检查、连线')}>
          <Mini v={v} />
        </a>
        <Todo v={v} />
      </div>
    </section>
  );
}

// what on the canvas wants attention: checks that fail or have issues, soft checks that are due, tasks under way or stuck
function Todo({ v }: { v: CanvasView }) {
  const checks = v.nodes.flatMap(n => (n.check?.on ? [n.check] : []));
  const bad = checks.filter(c => ['fail', 'warn'].includes(status(c))).sort((a, b) => (status(a) === 'fail' ? 0 : 1) - (status(b) === 'fail' ? 0 : 1));
  const due = checks.filter(c => c.due && !bad.includes(c));
  const tasks = v.nodes.filter(n => n.kind === 'task' && n.status !== 'done');
  if (!bad.length && !due.length && !tasks.length) return <p className="cv-todo muted small">{tr('检查都通过了，画布上没有在做的任务。')}</p>;
  return (
    <ul className="cv-todo">
      {bad.map(c => (
        <li key={c.id}><i className={`cg-shape k-${c.kind} s-${status(c)}`} /><span>{trx(c.title)}</span>
          <em className={status(c) === 'fail' ? 'bad-t' : 'warn-t'}>{status(c) === 'fail' ? tr('没过') : tr('有问题')}{c.kind === 'hard' && c.last?.value ? ` · ${c.last.value}` : ''}</em></li>
      ))}
      {due.map(c => <li key={c.id}><i className={`cg-shape k-${c.kind} s-wait`} /><span>{trx(c.title)}</span><em className="muted">{tr('到期')}</em></li>)}
      {tasks.map(n => (
        <li key={n.id}><i className={`cv-tdot t-${n.status}`} /><span>{n.title}</span>
          <em className={n.status === 'blocked' ? 'bad-t' : 'muted'}>{n.status === 'blocked' ? tr('卡住了') : n.status === 'sent' ? tr('在做') : tr('还没发')}</em></li>
      ))}
    </ul>
  );
}

function Mini({ v }: { v: CanvasView }) {
  const box = (n: CanvasNode) => ({ x: n.x, y: n.y, w: SIZE[n.kind][0], h: SIZE[n.kind][1] });
  const at = new Map(v.nodes.map(n => [n.id, box(n)]));
  if (!v.nodes.length) return <p className="muted small">{tr('画布上还没有节点')}</p>;
  const xs = v.nodes.map(n => n.x), ys = v.nodes.map(n => n.y);
  const x0 = Math.min(...xs) - 30, y0 = Math.min(...ys) - 24;
  const w = Math.max(...v.nodes.map(n => n.x + SIZE[n.kind][0])) + 30 - x0, h = Math.max(...v.nodes.map(n => n.y + SIZE[n.kind][1])) + 24 - y0;
  return (
    <svg viewBox={`${x0} ${y0} ${w} ${h}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={tr('研究画布')}>
      {v.edges.map(e => {
        const a = at.get(e.source), b = at.get(e.target);
        return a && b ? <line key={e.id} x1={a.x + a.w / 2} y1={a.y + a.h / 2} x2={b.x + b.w / 2} y2={b.y + b.h / 2} /> : null;
      })}
      {v.nodes.map(n => {
        const b = box(n);
        return (
          <g key={n.id} className={`mn mn-${n.kind} ${tone(n)}`}>
            <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={n.kind === 'soft' ? b.h / 2 : n.kind === 'stage' ? 16 : 9} />
            {n.kind === 'stage' && <text x={b.x + b.w / 2} y={b.y + b.h / 2} dy=".35em" textAnchor="middle">{n.title}</text>}
          </g>
        );
      })}
    </svg>
  );
}
