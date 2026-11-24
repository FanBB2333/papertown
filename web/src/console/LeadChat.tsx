// Talking to a project's lead: one conversation group wherever it opens (the console's sidebar beside a
// project, the conversation page in 进展, the 员工 panel): its conversations in Paseo, a new one, an earlier
// one; what it waits on you for, pinned above the message box.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, type Agent, type AgentEvent, type AssistantConv, type Report, type StartOpts } from '../api';
import { fold, PaseoLog, PiLog, RuntimePick, usePiTalk, usePaseoTalk } from '../components/AgentRoom';
import { HostedRoom } from '../agents/Terminal';
import { Compose } from '../agents/Compose';
import { ResidentControl, ResidentMark, useResidentLine } from '../components/Resident';
import { tr, trx } from '../i18n';
import { Earlier, History } from './Convs';
import { Icon } from './icons';
import { useLead } from './Lead';
import { ago, enterSends } from './util';

type Layout = 'side' | 'page';

export function LeadChat({ lineId, seq, layout, onClose, toast }: {
  lineId: string; seq: number; layout: Layout; onClose?: () => void; toast: (t: string) => void;
}) {
  const [v, again] = useLead(lineId);
  const [history, setHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const a = v?.agent ?? null;
  const [line] = useResidentLine(lineId);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [eventError, setEventError] = useState('');
  useEffect(() => {
    let alive = true;
    setEvents([]); setEventError('');
    if (a && v?.resident.state !== 'running') api.events(a.id).then(es => { if (alive) setEvents(es); }, e => { if (alive) setEventError((e as Error).message); });
    return () => { alive = false; };
  }, [a?.id, a?.updated_at, v?.resident.state]);
  const run = async (fn: () => Promise<unknown>) => {
    setHistory(false);
    try { await fn(); again(); } catch (e) { toast((e as Error).message); }
  };
  async function start(o: StartOpts) {
    setBusy(true);
    try {
      const x = a ?? await api.openAgent(lineId, 'lead');
      await api.startAgent(x.id, o);
      await api.setLead(lineId, { on: true });
      again();
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  }
  const resume = (c: AssistantConv) => a && run(() => api.resumeConv(a.id, c.id));

  const head = (x: Agent | null) => (
    <header className="as-head">
      {v && <ResidentMark resident={v.resident} />}
      <div className="as-who">
        <b>{tr('项目负责人')}{layout === 'side' ? ` · #${seq}` : ''}</b>
        {x?.started && <span>{x.model}</span>}
      </div>
      {x?.runtime === 'paseo' && <button className={`ib as-hist${history ? ' on' : ''}`} title={tr('历史对话')} aria-expanded={history} onClick={() => setHistory(h => !h)}><Icon n="clock" size={16} /></button>}
      {x?.started && x.runtime === 'paseo' && <button className="ib" title={tr('新对话：负责人使用同一模型重新开始')} onClick={() => run(() => api.newConv(x.id))}><Icon n="compose" size={16} /></button>}
      {x?.started && x.runtime === 'paseo' && <button className="ib" title={tr('在 Paseo 桌面端打开这段对话')} onClick={() => api.openInPaseo(x.id).catch(e => toast((e as Error).message))}><Icon n="ext" size={16} /></button>}
      {onClose && <button className="ib" title={tr('收起（⌘J）')} onClick={onClose}><Icon n="sideR" size={16} /></button>}
    </header>
  );

  return (
    <div className={`asst lc lc-${layout}`}>
      {!v ? <>{head(null)}<p className="as-wait">{tr('加载中…')}</p></>
        : !a?.started || v.resident.state !== 'running' ? (
          <>
            {head(a)}
            <div className="as-start">
              {events.length > 0 && <section className="resident-history">
                <h3>{line?.sample ? tr('样例对话（占位内容）') : tr('历史对话')}</h3>
                <PiLog rows={events.filter(e => ['user', 'assistant', 'note'].includes(e.kind)).map(ev => ({ ev }))} live="" working={false} />
              </section>}
              {eventError && <p className="note err">{eventError}</p>}
              {v.asks.length > 0 && <div className="lc-asks">{v.asks.slice(0, 3).map(q => <AskCard key={q.id} q={q} toast={toast} onDone={again} />)}</div>}
              <ResidentControl lineId={lineId} resident={v.resident} sample={line?.sample} model={a?.model} toast={toast} onChanged={again} />
              {v.resident.state === 'starting' && <p className="as-wait">{tr('等待负责人启动。')}</p>}
              <p className="as-lead">{tr('负责人推进此项目：启动员工、派发任务、提交工序产出、收尾并向你汇报。工作目录为 Papertown 自有目录。')}</p>
              {a && <Earlier agent={a.id} at={a.ext_id} limit={3} title={tr('继续此前对话')} onPick={resume} />}
              {['off', 'blocked'].includes(v.resident.state) && <details className="hire-card">
                <summary>{tr('选择方式启动')}</summary>
                <RuntimePick busy={busy} onStart={start} role="lead" />
              </details>}
            </div>
          </>
        ) : a.term ? <HostedRoom agent={a} toast={toast} /> : a.runtime === 'pi' ? <PiTalk agent={a} head={head} toast={toast} /> : <Talk key={a.ext_id ?? a.id} agent={a} asks={v.asks} head={head} toast={toast} onAnswered={again} />}
      {history && a && <History agent={a.id} onPick={resume} onClose={() => setHistory(false)} />}
    </div>
  );
}

function PiTalk({ agent, head, toast }: { agent: Agent; head: (a: Agent) => React.ReactNode; toast: (s: string) => void }) {
  const t = usePiTalk(agent);
  return <>{head(t.agent)}<div className="as-mid"><div className="as-log lc-log" ref={t.readRef}>
    {t.err && <p className="note err">{t.err}</p>}
    <PiLog rows={fold(t.items, i => i.ev.kind === 'tool')} live={t.live} working={t.agent.status === 'working'} />
  </div></div><Compose agent={t.agent} queued={t.queued} toast={toast} onChanged={t.reload} /></>;
}

function Talk({ agent: initial, asks, head, toast, onAnswered }: {
  agent: Agent; asks: Report[]; head: (a: Agent) => React.ReactNode; toast: (t: string) => void; onAnswered: () => void;
}) {
  const t = usePaseoTalk(initial);
  const rows = useMemo(() => fold(t.items ?? [], i => i.kind === 'tool'), [t.items]);
  const scroll = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const working = t.agent.status === 'working';

  useLayoutEffect(() => {
    const el = scroll.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [rows, t.sent.length, t.asks.length, working]);
  return (
    <>
      {head(t.agent)}
      <div className="as-mid">
        <div className="as-log lc-log" ref={el => { scroll.current = el; t.readRef.current = el; }} onScroll={e => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}>
          {t.err && <div className="note err">{t.err}</div>}
          {t.items === null && !t.err && <p className="as-wait">{tr('加载中…')}</p>}
          {t.items && !t.items.length && !t.sent.length && <p className="as-wait">{tr('暂无对话。可向负责人询问项目情况，或派发任务。')}</p>}
          <PaseoLog rows={rows} sent={t.sent} asks={t.asks} working={working}
            onPermit={(id, allow) => { api.permit(t.agent.id, id, allow).then(() => t.answered(id)).catch(e => toast((e as Error).message)); }} />
        </div>
      </div>
      {asks.length > 0 && (
        <div className="lc-asks">
          {asks.slice(0, 2).map(q => <AskCard key={q.id} q={q} toast={toast} onDone={onAnswered} />)}
          {asks.length > 2 && <p className="muted small">{tr('尚有 {0} 项待你回复', asks.length - 2)}</p>}
        </div>
      )}
      <Compose agent={t.agent} queued={t.queued} permission={t.asks.length > 0} toast={toast} onChanged={t.reload}
        onSent={(event, text) => { stick.current = true; if (event.data.delivered) t.wrote(text); }} />
    </>
  );
}

// what an agent of the project asks you: one of its choices, or a few words
export function AskCard({ q, toast, onDone }: { q: Report; toast: (t: string) => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const choices = q.data.choices ?? [];
  useEffect(() => setText(''), [q.id]);
  async function answer(s: string) {
    if (!s.trim() || busy) return;
    setBusy(true);
    try { await api.answer(q.id, s.trim()); setText(''); onDone(); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="lc-ask">
      <span className="lc-k"><Icon n="bell" size={13} />{tr('{0}向你提问', trx(q.data.who ?? ''))} · {ago(q.ts)}</span>
      <p>{q.data.question}</p>
      {choices.length > 0 && (
        <div className="lc-choices">
          {choices.map((c, i) => <button key={c} className={`btn${i === 0 && q.data.act ? ' pri' : ''}`} disabled={busy} onClick={() => answer(c)}>{c}</button>)}
        </div>
      )}
      <div className="lc-reply">
        <input value={text} disabled={busy} placeholder={choices.length ? tr('或输入内容') : tr('输入你的回答')}
          onChange={e => setText(e.target.value)} onKeyDown={enterSends(() => answer(text))} />
        <button className="btn" disabled={busy || !text.trim()} onClick={() => answer(text)}>{tr('回答')}</button>
      </div>
    </div>
  );
}
