// A project's lead in the console: what it reported, the questions waiting for your answer
// (its own and its workers'), and whether it gets check-ins. The overview shows these at the
// top of the project; the 员工 panel beside the lead's conversation.

import { useEffect, useState } from 'react';
import { api, listen, type LeadView, type Report } from '../api';
import { Text } from '../components/AgentRoom';
import { AGENT_STATUS } from '../components/MillRoom';
import { Select } from '../components/Select';
import { tr, trx } from '../i18n';
import { Icon } from './icons';
import { ago } from './util';

const EVERY = [15, 30, 60, 120, 240, 480];

export function useLead(lineId: string) {
  const [v, setV] = useState<LeadView | null>(null);
  const [bump, setBump] = useState(0);
  useEffect(() => listen(e => {
    if ((e.type === 'report' && e.report?.line_id === lineId) || (e.type === 'agent' && e.agent?.id === `lead-${lineId}`)) setBump(b => b + 1);
  }), [lineId]);
  useEffect(() => {
    let alive = true;
    api.lead(lineId).then(x => alive && setV(x)).catch(() => alive && setV(null));
    return () => { alive = false; };
  }, [lineId, bump]);
  return [v, () => setBump(b => b + 1)] as const;
}

// on the overview: the lead in a line, what waits for your answer, its latest reports
export function LeadCard({ lineId, toast, onOpen }: { lineId: string; toast: (t: string) => void; onOpen: () => void }) {
  const [v, again] = useLead(lineId);
  if (!v) return null;
  const a = v.agent?.started ? v.agent : null;
  const reps = v.reports.filter(r => r.kind === 'report');
  return (
    <section className="cs ld-card" data-ref="lead" data-ref-label={tr('项目负责人')}>
      <div className="cs-h">
        <h3>{tr('项目负责人')}</h3>
        {a && <span className="ld-who small"><i className={`dot s-${a.status}`} />{AGENT_STATUS[a.status]}{a.model ? ` · ${a.model}` : ''}{!v.settings.supervise && ` · ${tr('巡检关着')}`}</span>}
        <button className="lnk small" onClick={onOpen}>{a ? tr('和它说话') : tr('去配一个')}<Icon n="right" size={12} /></button>
      </div>
      {!a && !v.asks.length && <p className="muted small ld-none">{tr('还没有负责人。配一个以后，它会盯着这个项目、催员工干活，有要紧的事在这里向你汇报、问你。')}</p>}
      {v.asks.map(q => <AskCard key={q.id} q={q} toast={toast} onDone={again} />)}
      {reps.length > 0 && <Reports rows={reps} limit={3} />}
      {a && !reps.length && !v.asks.length && <p className="muted small ld-none">{tr('还没有汇报。项目有动静时它会看一眼，有你该知道的才写。')}</p>}
    </section>
  );
}

// next to the lead's conversation: whether it gets check-ins, then the same questions and reports
export function LeadAside({ lineId, toast }: { lineId: string; toast: (t: string) => void }) {
  const [v, again] = useLead(lineId);
  if (!v) return null;
  const set = (o: { supervise?: boolean; every?: number }) => api.setLead(lineId, o).then(again).catch(e => toast((e as Error).message));
  const reps = v.reports.filter(r => r.kind === 'report' || !r.data.open);
  return (
    <>
      <div className="pnl-s">
        <h4>{tr('巡检')}</h4>
        <label className="ld-sw">
          <input type="checkbox" checked={v.settings.supervise} onChange={e => set({ supervise: e.target.checked })} />
          <span>{tr('项目有动静时（实验结束或失败、员工结束一轮、工序变了、你回答了问题）发消息给它')}</span>
        </label>
        <label className="field">{tr('项目没动静时，最多隔多久也看一眼')}
          <Select value={v.settings.every} disabled={!v.settings.supervise} onChange={m => set({ every: m })}
            options={EVERY.map(m => ({ value: m, label: m < 60 ? tr('{0} 分钟', m) : tr('{0} 小时', m / 60) }))} />
        </label>
        <p className="muted small">{tr('接连三次没有新动静就不再来，直到项目又有变化。')}</p>
      </div>
      {v.asks.length > 0 && <div className="pnl-s"><h4>{tr('等你回答')}</h4>{v.asks.map(q => <AskCard key={q.id} q={q} toast={toast} onDone={again} />)}</div>}
      <div className="pnl-s">
        <h4>{tr('汇报')}</h4>
        {reps.length ? <Reports rows={reps} limit={12} /> : <p className="muted small">{tr('还没有。')}</p>}
      </div>
    </>
  );
}

// a question from the project, answered with one of its choices or in your own words
export function AskCard({ q, toast, onDone }: { q: Report; toast: (t: string) => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  async function answer(t: string) {
    if (!t.trim() || busy) return;
    setBusy(true);
    try { await api.answer(q.id, t.trim()); setText(''); onDone(); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="ld-ask">
      <span className="ld-k"><Icon n="bell" size={14} />{tr('{0}在问你', trx(q.data.who ?? ''))} · {ago(q.ts)}</span>
      <p>{q.data.question}</p>
      {!!q.data.choices?.length && <div className="btns">
        {q.data.choices.map((c, i) => <button key={c} className={`btn${i === 0 && q.data.act ? ' pri' : ''}`} disabled={busy} onClick={() => answer(c)}>{c}</button>)}
      </div>}
      <div className="ld-reply">
        <input value={text} placeholder={q.data.choices?.length ? tr('或者写几句') : tr('写下你的回答')} onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) answer(text); }} />
        <button className="btn" disabled={busy || !text.trim()} onClick={() => answer(text)}>{tr('回答')}</button>
      </div>
    </div>
  );
}

// the reports, the latest first; what matters is marked, and a question shows with its answer
export function Reports({ rows, limit }: { rows: Report[]; limit: number }) {
  const [all, setAll] = useState(false);
  const shown = rows.slice(all ? 0 : -limit).reverse();
  return (
    <ul className="ld-reps">
      {shown.map(r => (
        <li key={r.id} className={`ld-rep${r.data.key ? ' key' : ''}`}>
          <span className="ld-when">{r.data.key && <b>{tr('要紧')}</b>}{trx(r.data.who ?? '')} · {ago(r.ts)}</span>
          {r.kind === 'report'
            ? <Text text={r.data.text ?? ''} />
            : <p className="small"><span className="muted">{tr('问：')}</span>{r.data.question}<br /><span className="muted">{r.data.by === 'assistant' ? tr('小助手转达：') : tr('你答：')}</span>{r.data.answer}
              {r.data.result && <span className="muted"> · {r.data.result}</span>}</p>}
        </li>
      ))}
      {rows.length > limit && <li><button className="lnk small" onClick={() => setAll(a => !a)}>{all ? tr('收起') : tr('全部 {0} 条', rows.length)}</button></li>}
    </ul>
  );
}
