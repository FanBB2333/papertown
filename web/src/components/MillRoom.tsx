// The mill as the base camp: every project at a glance on the left, the chosen one's
// production line and outputs on the right.

import { useEffect, useMemo, useState } from 'react';
import { api, listen, type Agent, type Line, type Placement } from '../api';
import type { RoomActions } from './Interior';
import { MillDetail } from './Sheet';
import { tr } from '../i18n';

interface Props extends RoomActions {
  focus: string | null;
  placements: Placement[];
  lines: Line[];
  tick: number;
}

export const STATUS: Record<string, string> = {
  hatching: tr('查重中'), waiting: tr('等你决定'), running: tr('生产中'), paused: tr('已暂停'), failed: tr('出错'), done: tr('已出厂'), dropped: tr('已放弃'),
  linked: tr('本地项目'),
};
export function StatusTag({ status }: { status: string }) {
  return <span className={`pst pst-${status}`}>{STATUS[status] ?? status}</span>;
}
export const AGENT_STATUS: Record<string, string> = {
  stopped: tr('未启动'), starting: tr('启动中'), idle: tr('待命'), working: tr('工作中'), error: tr('出错'), watching: tr('值守'), offline: tr('连不上'),
};

const REAL = tr('工序按顺序走：方法设计在造纸厂，代码和实验在仓库与实验农场，写作在印刷厂，最后经质检所出厂。');

export function MillRoom(p: Props) {
  const [sel, setSel] = useState<string | null>(p.focus);
  const [line, setLine] = useState<Line | null>(null);
  const [crew, setCrew] = useState<Record<string, Agent>>({});
  const [jobs, setJobs] = useState<Record<string, number>>({});
  const [bump, setBump] = useState(0);

  const lines = useMemo(() => [...p.lines].sort((a, b) => b.seq - a.seq), [p.lines]);
  const cur = sel ?? lines[0]?.id ?? null;

  useEffect(() => listen(e => { if (['agent', 'job'].includes(e.type)) setBump(b => b + 1); }), []);
  useEffect(() => {
    const t = setTimeout(async () => {
      const [c, w, board] = await Promise.all([api.roster('coder'), api.roster('writer'), api.jobs()]).catch(() => [null, null, null]);
      if (!c || !w || !board) return;
      const m: Record<string, Agent> = {};
      for (const r of [...c.roster, ...w.roster]) if (r.agent) m[r.agent.id] = r.agent;
      setCrew(m);
      const n: Record<string, number> = {};
      for (const j of board.jobs) if (j.line_id && ['queued', 'running'].includes(j.status)) n[j.line_id] = (n[j.line_id] ?? 0) + 1;
      setJobs(n);
    }, 150);
    return () => clearTimeout(t);
  }, [bump, p.tick]);

  useEffect(() => {
    if (!cur) { setLine(null); return; }
    let live = true;
    api.line(cur).then(l => live && setLine(l)).catch(() => {});
    return () => { live = false; };
  }, [cur, p.tick]);

  const count = (st: string[]) => lines.filter(l => st.includes(l.status)).length;
  const spent = lines.reduce((s, l) => s + l.spent, 0);
  const typeOf = (id: string) => p.placements.find(x => x.id === id)?.type ?? id;

  if (!lines.length) {
    return (
      <div className="room-empty">
        <h2>{tr('还没有项目')}</h2>
        <p>{tr('放入一颗 idea，孵化场查完重、你点了「孵化并立项」，它就会出现在这里。')}</p>
        <button className="btn pri" onClick={p.onIdea}>{tr('放入一颗新 idea')}</button>
      </div>
    );
  }

  return (
    <div className="room room-mill">
      <aside className="room-side">
        <div className="tally">
          <div><b>{count(['running', 'hatching'])}</b><span>{tr('在跑')}</span></div>
          <div><b>{count(['waiting', 'paused', 'failed'])}</b><span>{tr('等你')}</span></div>
          <div><b>{count(['done'])}</b><span>{tr('已出厂')}</span></div>
          <div><b>${spent.toFixed(2)}</b><span>{tr('小镇 API 总花费')}</span></div>
        </div>
        <div className="plist">
          {lines.map((l, i) => {
            const coder = crew[`coder-${l.id}`], writer = crew[`writer-${l.id}`];
            return (
              <button key={l.id} className={`proj${l.id === cur ? ' on' : ''}`} style={{ ['--i' as string]: i }} onClick={() => setSel(l.id)}>
                <div className="proj-top"><b>#{l.seq}</b><StatusTag status={l.status} /></div>
                <h3>{l.title}</h3>
                <div className="dots" aria-label={`${l.pct}%`}>
                  {l.stages.map(s => <i key={s.key} className={`d-${s.status}`} title={s.name} />)}
                </div>
                <div className="proj-meta">
                  <span>{l.current?.name ?? (l.status === 'done' ? tr('已出厂') : STATUS[l.status])}</span>
                  <span>{l.linked ? l.linked.code?.name ?? l.linked.paper?.name : tr('小镇 API：${0} / ${1}', l.spent.toFixed(2), l.budget.toFixed(2))}</span>
                </div>
                <div className="crew">
                  <span className={`crew-a s-${coder?.status ?? 'none'}`}>{tr('代码员工 ·')} {coder ? AGENT_STATUS[coder.status] : '—'}</span>
                  <span className={`crew-a s-${writer?.status ?? 'none'}`}>{tr('写作员工 ·')} {writer ? AGENT_STATUS[writer.status] : '—'}</span>
                  {jobs[l.id] ? <span className="crew-a s-working">{tr('实验')} {jobs[l.id]}</span> : null}
                </div>
              </button>
            );
          })}
        </div>
      </aside>
      <section className="room-main">
        {line ? (
          <>
            <div className="proj-head">
              <div>
                <StatusTag status={line.status} />
                <h2>#{line.seq} {line.title}</h2>
                <p>{line.idea}</p>
              </div>
              <div className="go-row">
                <button className="btn" onClick={() => p.onOpen('depot', line.id)}>{tr('去仓库 · 代码')}</button>
                <button className="btn" onClick={() => p.onOpen('farm', line.id)}>{tr('去农场 · 实验')}</button>
                <button className="btn" onClick={() => p.onOpen('press', line.id)}>{tr('去印刷厂 · 论文')}</button>
              </div>
            </div>
            <div className="lc">
              <MillDetail line={line} typeOf={typeOf} real={REAL} tick={p.tick} onOpen={id => p.onOpen(id, line.id)} onHatch={p.onHatch}
                onResume={p.onResume} onAdjust={p.onAdjust} onAsk={() => p.onAsk('mill', tr('造纸厂'))} />
            </div>
          </>
        ) : <p className="muted">{tr('加载中…')}</p>}
      </section>
    </div>
  );
}
