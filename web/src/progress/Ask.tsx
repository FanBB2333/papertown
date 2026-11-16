// A project's conversation, full window, at /progress/<number>/ask: talking to its lead, the same conversation
// group as the console's sidebar and 员工 panel; its conversations and latest reports on the left, what it asks
// you above the box.
// On the project's page, a box with what waits on you, the start of a message and the lead's latest reports.

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type AssistantConv, type ProjectCard, type Report } from '../api';
import { Text } from '../components/AgentRoom';
import { StatusTag } from '../components/MillRoom';
import { Earlier } from '../console/Convs';
import { Icon } from '../console/icons';
import { useLead } from '../console/Lead';
import { AskCard, LeadChat } from '../console/LeadChat';
import { ago, enterSends } from '../console/util';
import { tr, trx } from '../i18n';
import { follow, go, href } from '../route';
import { pagesPath } from './Pages';
import './ask.css';

export const askPath = (seq: number) => `/progress/${seq}/ask`;

const latest = (rs: Report[] | undefined, n: number) => (rs ?? []).filter(x => x.kind === 'report').slice(-n).reverse();
const oneLine = (s?: string) => (s ?? '').replace(/[*`#>]/g, '').replace(/\s*\n+\s*(?:[-•]\s+)?/g, ' ');

export function AskPage({ r, rows, toast }: { r: ProjectCard; rows: ProjectCard[]; toast: (t: string) => void }) {
  const { line } = r;
  const [lv, again] = useLead(line.id);
  const [nav, setNav] = useState(false);
  const lead = lv?.agent?.started ? lv.agent : null;
  const reports = latest(lv?.reports, 8);
  const back = `/progress/${line.seq}`;
  const run = (fn: () => Promise<unknown>) => { setNav(false); fn().then(again, e => toast((e as Error).message)); };

  return createPortal(
    <div className="ak" role="dialog" aria-modal="true" aria-label={tr('和 #{0} 对话', line.seq)}>
      {nav && <div className="ak-scrim" onClick={() => setNav(false)} />}
      <aside className={`ak-side${nav ? ' open' : ''}`}>
        <a className="ak-back" href={href(back)} onClick={e => follow(e, back)}><Icon n="left" size={15} />{tr('回到项目')}</a>
        <button className="ak-new" disabled={!lead} onClick={() => lead && run(() => api.newConv(lead.id))} title={tr('新对话：负责人用同一个模型重新开始')}>
          <Icon n="compose" size={16} />{tr('新对话')}
        </button>
        <a className="ak-link" href={href(pagesPath(line.seq))} onClick={e => follow(e, pagesPath(line.seq))}><Icon n="doc" size={15} />{tr('汇报与讲解')}</a>
        <nav className="ak-hist" aria-label={tr('之前的对话')}>
          <section>
            <h4>{tr('对话')}</h4>
            {lv?.agent ? <Earlier agent={lv.agent.id} at={lv.agent.ext_id} onPick={(c: AssistantConv) => lead && run(() => api.resumeConv(lead.id, c.id))} />
              : <p className="ak-none">{tr('还没有负责人。')}</p>}
          </section>
          {reports.length > 0 && (
            <section className="ak-reps">
              <h4>{tr('最近的汇报')}</h4>
              {reports.map(x => (
                <details key={x.id} className={x.data.key ? 'key' : undefined}>
                  <summary><span>{oneLine(x.data.text)}</span><small>{x.data.key ? `${tr('要紧')} · ` : ''}{trx(x.data.who ?? '')} · {ago(x.ts)}</small></summary>
                  <div className="ak-rep"><Text text={x.data.text ?? ''} /></div>
                </details>
              ))}
            </section>
          )}
        </nav>
        {rows.length > 1 && (
          <section className="ak-projs">
            <h4>{tr('别的项目')}</h4>
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
          <button className="ib ak-menu" onClick={() => setNav(true)} title={tr('之前的对话')} aria-label={tr('之前的对话')}><Icon n="sidebar" size={18} /></button>
          <div className="ak-title">
            <span className="pc-seq">#{line.seq}</span><b title={line.title}>{line.title}</b>
            <StatusTag status={line.status} />
          </div>
          <a className="ib ak-x" href={href(back)} onClick={e => follow(e, back)} title={tr('回到项目')} aria-label={tr('关闭')}><Icon n="close" size={18} /></a>
        </header>
        <LeadChat key={line.id} lineId={line.id} seq={line.seq} layout="page" toast={toast} />
      </main>
    </div>,
    document.querySelector('.proto') ?? document.body,
  );
}

// on the project's page: what its agents wait on you for, a message to the lead, and its latest reports
export function ChatBox({ r, toast }: { r: ProjectCard; toast: (t: string) => void }) {
  const { line } = r;
  const [lv, again] = useLead(line.id);
  const [text, setText] = useState('');
  const lead = lv?.agent?.started ? lv.agent : null;
  const asks = lv?.asks ?? [];
  const reports = latest(lv?.reports, 3);
  const page = askPath(line.seq);
  async function send() {
    const s = text.trim();
    if (!s || !lead) return;
    try { await api.say(lead.id, s); setText(''); go(page); } catch (e) { toast((e as Error).message); }
  }
  return (
    <section className="psec pj-ask">
      <header className="psec-h">
        <h3><Icon n="chat" size={16} />{tr('对话')}</h3>
        <a className="btn" href={href(page)} onClick={e => follow(e, page)}>{tr('打开')}</a>
      </header>
      {asks.slice(0, 2).map(q => <AskCard key={q.id} q={q} toast={toast} onDone={again} />)}
      {asks.length > 2 && <a className="small" href={href(page)} onClick={e => follow(e, page)}>{tr('还有 {0} 件等你回答', asks.length - 2)}</a>}
      {lead ? (
        <form className="ak-comp mini" onSubmit={e => { e.preventDefault(); send(); }}>
          <textarea rows={2} value={text} maxLength={4000} placeholder={tr('问负责人项目的事，或者交代它一件事…')}
            onChange={e => setText(e.target.value)} onKeyDown={enterSends(send)} />
          <div className="ak-comp-row">
            <span className="small muted">{lead.model ?? tr('项目负责人')}</span>
            <button className="ak-send" type="submit" disabled={!text.trim()} aria-label={tr('发送')}><Icon n="send" size={15} /></button>
          </div>
        </form>
      ) : lv && <p className="muted small">{tr('还没有负责人。打开对话就能给这个项目配一个。')}</p>}
      {reports.length > 0 && (
        <ul className="pj-recent">
          {reports.map(x => (
            <li key={x.id}><a href={href(page)} onClick={e => follow(e, page)}>
              <span>{oneLine(x.data.text)}</span>
              <span className="small muted">{x.data.key ? `${tr('要紧')} · ` : ''}{trx(x.data.who ?? '')} · {ago(x.ts)}</span>
            </a></li>
          ))}
        </ul>
      )}
    </section>
  );
}
