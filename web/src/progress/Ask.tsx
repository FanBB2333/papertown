// A project's conversation, full window, at /progress/<number>/ask: talking to its lead, the same conversation
// group as the console's sidebar and 员工 panel; its conversations and latest reports on the left, what it asks
// you above the box.
// On the project's page, a message to its lead and the lead's latest reports.

import { modelText } from '../emphasis';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type Agent, type AssistantConv, type ProjectCard, type Report } from '../api';
import { Compose } from '../agents/Compose';
import { Text, UserMsg, usePaseoTalk } from '../components/AgentRoom';
import { StatusTag } from '../components/MillRoom';
import { Earlier } from '../console/Convs';
import { Icon } from '../console/icons';
import { useLead } from '../console/Lead';
import { LeadChat } from '../console/LeadChat';
import { ago, useFetch } from '../console/util';
import { tr, trx } from '../i18n';
import { conversationPath, follow, go, href, query } from '../route';
import { ReadState, RecordLink, RecordPage, Stamp, useRecordTick } from './Records';
import { QuoteDecision } from './QuoteDecision';
import { pagesPath } from './Pages';
import './ask.css';

export const askPath = (seq: number) => `/progress/${seq}/ask`;

const latest = (rs: Report[] | undefined, n: number) => (rs ?? []).filter(x => x.kind === 'report' || x.kind === 'usage').slice(-n).reverse();
const oneLine = (s?: string) => (s ?? '').replace(/[`#>]/g, '').replace(/\s*\n+\s*(?:[-•]\s+)?/g, ' ');

type AskProps = { r: ProjectCard; rows: ProjectCard[]; toast: (t: string, error?: boolean) => void };
export function AskPage(props: AskProps) {
  const q = query();
  return ['report', 'event', 'session', 'agent'].some(k => q.has(k))
    ? <ConversationRecord r={props.r} params={q} /> : <LeadPage {...props} />;
}

function LeadPage({ r, rows, toast }: AskProps) {
  const { line } = r;
  const [lv, again] = useLead(line.id);
  const [nav, setNav] = useState(false);
  const lead = lv?.agent?.started ? lv.agent : null;
  const reports = latest(lv?.reports, 8);
  const back = `/progress/${line.seq}`;
  const run = (fn: () => Promise<unknown>) => { setNav(false); fn().then(again, e => toast((e as Error).message, true)); };

  return createPortal(
    <div className="ak" role="dialog" aria-modal="true" aria-label={tr('与 #{0} 对话', line.seq)}>
      {nav && <div className="ak-scrim" onClick={() => setNav(false)} />}
      <aside className={`ak-side${nav ? ' open' : ''}`}>
        <a className="ak-back" href={href(back)} onClick={e => follow(e, back)}><Icon n="left" size={15} />{tr('返回项目')}</a>
        <button className="ak-new" disabled={!lead} onClick={() => lead && run(() => api.newConv(lead.id))} title={tr('新对话：负责人使用同一模型重新开始')}>
          <Icon n="compose" size={16} />{tr('新对话')}
        </button>
        <a className="ak-link" href={href(pagesPath(line.seq))} onClick={e => follow(e, pagesPath(line.seq))}><Icon n="doc" size={15} />{tr('汇报与讲解')}</a>
        <nav className="ak-hist" aria-label={tr('历史对话')}>
          <section>
            <h4>{tr('对话')}</h4>
            {lv?.agent ? <Earlier agent={lv.agent.id} at={lv.agent.ext_id} onPick={(c: AssistantConv) => lead && run(() => api.resumeConv(lead.id, c.id))} />
              : <p className="ak-none">{tr('负责人尚未启动。')}</p>}
          </section>
          {reports.length > 0 && (
            <section className="ak-reps">
              <h4>{tr('最近的汇报')}</h4>
              {reports.map(x => (
                <details key={x.id} className={x.data.key ? 'em-bar' : undefined}>
                  <summary><span>{modelText(oneLine(x.data.text))}</span><small>{x.data.key ? `${tr('要紧')} · ` : ''}{trx(x.data.who ?? '')} · {ago(x.ts)}</small></summary>
                  <div className="ak-rep"><Text text={x.data.text ?? ''} /></div>
                </details>
              ))}
            </section>
          )}
        </nav>
        {rows.length > 1 && (
          <section className="ak-projs">
            <h4>{tr('其他项目')}</h4>
            <ul>
              {rows.map(x => {
                const to = askPath(x.line.seq);
                return (
                  <li key={x.line.id}>
                    <a className={x.line.id === line.id ? 'on' : ''} href={href(to)} onClick={e => follow(e, to)} aria-current={x.line.id === line.id ? 'page' : undefined}>
                      <span className="pc-seq">#{x.line.seq}</span><span>{x.line.title}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </aside>

      <main className="ak-main">
        <header className="ak-top">
          <button className="ib ak-menu" onClick={() => setNav(true)} title={tr('历史对话')} aria-label={tr('历史对话')}><Icon n="sidebar" size={18} /></button>
          <div className="ak-title">
            <span className="pc-seq">#{line.seq}</span><b title={line.title}>{line.title}</b>
            <StatusTag status={line.status} sample={line.sample} />
          </div>
          <a className="ib ak-x" href={href(back)} onClick={e => follow(e, back)} title={tr('返回项目')} aria-label={tr('关闭')}><Icon n="close" size={18} /></a>
        </header>
        <LeadChat key={line.id} lineId={line.id} seq={line.seq} layout="page" toast={toast} />
      </main>
    </div>,
    document.querySelector('.proto') ?? document.body,
  );
}

// The project teaser links each report to its original record.
export function ChatBox({ r, toast }: { r: ProjectCard; toast: (t: string, error?: boolean) => void }) {
  const { line } = r;
  const [lv] = useLead(line.id);
  const lead = lv?.agent?.started ? lv.agent : null;
  const reports = latest(lv?.reports, 3);
  const page = askPath(line.seq);
  return (
    <section className="psec pj-ask">
      <header className="psec-h">
        <h3><Icon n="chat" size={16} />{tr('对话')}</h3>
        <a className="btn" href={href(page)} onClick={e => follow(e, page)}>{tr('打开')}</a>
      </header>
      {lead ? (
        <QuickCompose agent={lead} page={page} toast={toast} />
      ) : lv && <p className="muted small">{tr('负责人尚未启动。请在项目页开启负责人开关。')}</p>}
      {reports.length > 0 && (
        <ul className="pj-recent">
          {reports.map(x => (
            <li key={x.id} className={x.data.key ? 'em-bar' : undefined}><RecordLink to={conversationPath(line.seq, { report: String(x.id) })}>
              <span>{modelText(oneLine(x.data.text))}</span>
              <span className="small muted">{x.data.key ? `${tr('要紧')} · ` : ''}{trx(x.data.who ?? '')} · {ago(x.ts)}</span>
            </RecordLink></li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface ChatRecord { kind: string; text: string; at?: string | null; event?: number; origin?: string; decided?: string; key?: boolean }

// Open a recorded conversation without resuming or switching a worker's live session.
async function readConversation(line: string, q: URLSearchParams): Promise<ChatRecord[]> {
  const event = q.get('event'), agent = q.get('agent'), session = q.get('session'), report = q.get('report');
  if (report) {
    const v = await api.reports(line);
    const row = [...v.reports, ...v.asks].find(x => String(x.id) === report);
    if (!row) return [];
    const records: ChatRecord[] = [{ kind: row.data.who || tr('汇报'), text: row.data.text || row.data.question || '', at: row.ts, key: row.data.key }];
    if (row.data.answer) records.push({ kind: row.data.by && row.data.by !== 'you' ? tr('小助手') : 'user', text: row.data.answer, at: row.data.answered_at });
    return records;
  }
  if (session) {
    const memories = await api.memory(line).catch(() => null);
    const memory = memories?.items?.find(x => x.kind === 'session' && (x.id === session || x.key === session || x.key === `${x.source}:${session}`));
    if (memory && !event) return ((await api.memoryItem(line, memory.id)).messages ?? []).map(m => ({ kind: m.role, text: m.text, at: m.at }));
  }
  const agents = new Set<string>();
  if (agent) agents.add(agent);
  else {
    const [group, lead] = await Promise.all([api.overview().catch(() => null), api.lead(line).catch(() => null)]);
    group?.groups.filter(g => g.line?.id === line).forEach(g => g.agents.forEach(a => agents.add(a.id)));
    if (lead?.agent) agents.add(lead.agent.id);
    // Dispatches from the town assistant are stored with the project ID on the event.
    if (event) agents.add('assistant');
  }
  const logs = await Promise.all([...agents].map(id => api.agent(id).catch(() => null)));
  for (const log of logs) {
    if (!log) continue;
    const projectLog = log.agent.line_id === line;
    let events = projectLog ? log.events : log.events.filter(e => e.data.line_id === line);
    if (!projectLog && !events.length) continue;
    if (event) {
      const i = events.findIndex(e => String(e.id) === event);
      if (i < 0) continue;
      events = events.slice(Math.max(0, i - 3), i + 4);
    } else if (session) {
      if (projectLog && [log.agent.session_id, log.agent.ext_id, log.agent.state?.session.id].includes(session)) {
        const timeline = await api.timeline(log.agent.id).catch(() => null);
        if (timeline?.items.length) return timeline.items.filter(x => x.text).map(x => ({ kind: x.kind, text: x.user_text ?? x.data?.user_text ?? x.text!, at: x.ts,
          event: x.event_id ?? x.data?.event_id, origin: x.origin ?? x.data?.origin, decided: x.decided ?? x.data?.decided }));
      }
      events = events.filter(e => (e.data.session_id ?? e.data.session) === session);
      if (!events.length) continue;
    }
    return events.filter(e => e.data.text).map(e => ({ kind: e.kind, text: e.data.user_text ?? e.data.text, at: e.ts, event: e.id, origin: e.data.origin, decided: e.data.decided }));
  }
  // The event feed has a bounded window. Older assignments still have their own record in the decision.
  if (event) {
    const decision = q.get('decision');
    const work = decision ? (await api.decision(line, decision)).work?.tells : (await api.decided(line)).loose;
    const tell = work?.find(w => w.kind === 'tell' && String(w.id) === event);
    if (tell) return [{ kind: 'sent', text: tell.title, at: tell.at, event: Number(event) }];
  }
  return [];
}

function ConversationRecord({ r, params }: { r: ProjectCard; params: URLSearchParams }) {
  const key = r.line.id + '?' + params.toString();
  const [tick] = useRecordTick(r.line.id, 'decided');
  const { data, err, reload } = useFetch(() => readConversation(r.line.id, params), key, tick);
  const event = params.get('event'), at = Date.parse(params.get('at') ?? ''), anchor = useRef<HTMLElement>(null);
  const nearest = data?.reduce((best, m, i) => Math.abs(Date.parse(m.at ?? '') - at) < Math.abs(Date.parse(data[best].at ?? '') - at) ? i : best, 0);
  useEffect(() => { anchor.current?.scrollIntoView({ block: 'center' }); }, [data, key]);
  return <RecordPage r={r} title={params.has('report') ? tr('汇报') : tr('对话记录')} actions={<RecordLink className="btn" to={askPath(r.line.seq)}>{tr('打开对话')}</RecordLink>}>
    {params.has('session') && <code className="small muted">{params.get('session')}</code>}
    {(!data || err) && <ReadState err={err} retry={reload} />}
    {data?.length === 0 && <p className="small muted">{tr('暂无这段对话的记录')}</p>}
    {data?.map((m, i) => {
      const selected = event ? String(m.event) === event : Number.isFinite(at) && i === nearest;
      const label = m.kind === 'user' ? (m.origin && !['web', 'terminal'].includes(m.origin) ? tr('系统消息') : tr('你')) :
        m.kind === 'sent' ? tr('派活') : m.kind === 'assistant' ? tr('员工') : trx(m.kind);
      return <article className="psec rec-message" key={m.event ?? i} ref={selected ? anchor : undefined} data-selected={selected || undefined}>
        <header className="rec-meta">{label} <Stamp at={m.at} /></header>{m.kind === 'user' && (!m.origin || ['web', 'terminal'].includes(m.origin))
          ? <div className="user-words em-bar">{m.text}</div>
          : m.kind === 'user' ? <UserMsg text={m.text} origin={m.origin} /> : <div className={m.key ? 'em-bar' : undefined}><Text text={m.text} /></div>}
        {m.kind === 'user' && <QuoteDecision line={r.line.id} event={m.event} origin={m.origin} decided={m.decided} text={m.text} />}
      </article>;
    })}
  </RecordPage>;
}

// The project teaser sends through the same modes, then opens the full conversation.
function QuickCompose({ agent, page, toast }: { agent: Agent; page: string; toast: (s: string, error?: boolean) => void }) {
  const t = usePaseoTalk(agent);
  return <Compose agent={t.agent} queued={t.queued} permission={t.asks.length > 0} toast={toast} onChanged={t.reload} onSent={() => go(page)} />;
}
