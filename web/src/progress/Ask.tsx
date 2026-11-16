// Asking a project anything, full window, at /progress/<number>/ask: answers from what the project
// holds, with numbered sources; its lead can answer too, often with a page (Pages.tsx).

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, listen, type Hit, type HitKind, type ProjectCard, type Question } from '../api';
import { StatusTag } from '../components/MillRoom';
import { Icon, type IconName } from '../console/icons';
import { ago, enterSends, useMedia } from '../console/util';
import { tr } from '../i18n';
import { follow, go, href, query } from '../route';
import { PageFrame, pagesPath, type PageOpen } from './Pages';
import './ask.css';

const HIT: Record<HitKind, [string, IconName]> = {
  card: [tr('进展卡片'), 'cards'], report: [tr('汇报'), 'bell'], line: [tr('项目'), 'compass'], job: [tr('实验'), 'flask'],
  code: [tr('代码'), 'code'], paper: [tr('论文'), 'books'], session: [tr('以前的对话'), 'chat'], note: [tr('记忆'), 'quote'],
};
const EXAMPLES: [IconName, string][] = [
  ['flask', tr('现在在跑哪些实验，各跑到哪了？')], ['table', tr('主要结果和 baseline 比怎么样？')],
  ['chat', tr('以前和 agent 讨论过哪些没做完的事？')], ['books', tr('论文还差哪几节？')],
];

type OpenHit = (h: Hit) => void;
export const askPath = (seq: number, q?: string) => `/progress/${seq}/ask${q ? `?q=${q}` : ''}`;

// a question typed on the project's page, asked once this page opens
let later: { lineId: string; q: string } | null = null;
function askLater(lineId: string, seq: number, q: string) {
  later = { lineId, q };
  go(askPath(seq));
}

// a project's questions, kept current
function useQuestions(lineId: string, toast: (t: string) => void) {
  const [qs, setQs] = useState<Question[] | null>(null);
  const [lead, setLead] = useState(false);
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    let alive = true;
    setQs(null);
    api.questions(lineId).then(r => { if (alive) { setQs(r.questions); setLead(r.lead); setOffline(r.offline); } }).catch(e => toast((e as Error).message));
    const off = listen(e => {
      if (e.type === 'question' && e.line_id === lineId) setQs(q => q && [...q.filter(x => x.id !== e.question.id), e.question].sort((a, b) => a.n - b.n));
      if (e.type === 'agent' && e.agent?.role === 'lead' && e.agent.line_id === lineId) setLead(!!e.agent.started);
    });
    return () => { alive = false; off(); };
  }, [lineId]); // eslint-disable-line react-hooks/exhaustive-deps
  const put = (r: Question) => setQs(x => [...(x ?? []).filter(y => y.id !== r.id), r].sort((a, b) => a.n - b.n));
  const drop = async (id: string) => {
    try { await api.dropQuestion(lineId, id); setQs(x => x && x.filter(y => y.id !== id)); } catch (e) { toast((e as Error).message); }
  };
  return { qs, lead, offline, put, drop };
}

// the questions newest first, under the day they were asked
function byDay(qs: Question[]): [string, Question[]][] {
  const day = 86400000, start = new Date().setHours(0, 0, 0, 0);
  const groups: [string, Question[]][] = [[tr('今天'), []], [tr('昨天'), []], [tr('最近 7 天'), []], [tr('更早'), []]];
  for (const q of [...qs].reverse()) {
    const t = Date.parse(q.at);
    groups[t >= start ? 0 : t >= start - day ? 1 : t >= start - 6 * day ? 2 : 3][1].push(q);
  }
  return groups.filter(g => g[1].length);
}

export function AskPage({ r, rows, toast, onOpenHit, onOpenPage }: {
  r: ProjectCard; rows: ProjectCard[]; toast: (t: string) => void; onOpenHit: OpenHit; onOpenPage: (o: PageOpen) => void;
}) {
  const { line } = r;
  const { qs, lead, offline, put, drop } = useQuestions(line.id, toast);
  const [text, setText] = useState('');
  const [toLead, setToLead] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  const [nav, setNav] = useState(false);
  const [lit, setLit] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const phone = useMedia('(max-width: 600px)');
  const back = `/progress/${line.seq}`;
  const empty = qs != null && !qs.length && !asking;

  async function send(q = text, withLead = toLead) {
    q = q.trim();
    if (!q || asking) return;
    setAsking(q);
    setText('');
    try { put(await api.askProject(line.id, q, withLead && lead)); } catch (e) { toast((e as Error).message); setText(q); } finally { setAsking(null); }
  }

  useEffect(() => {
    setLit(null); setNav(false); setText('');
    if (later?.lineId === line.id) { const q = later.q; later = null; send(q, false); }
    box.current?.focus();
  }, [line.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const count = (qs?.length ?? -1) + (asking ? 1 : 0);
  const first = useRef(true);
  useLayoutEffect(() => { first.current = true; }, [line.id]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || qs == null) return;
    const want = first.current ? query().get('q') : null;
    if (want && document.getElementById(`q-${want}`)) jump(want, false);
    else el.scrollTo({ top: el.scrollHeight, behavior: first.current ? 'auto' : 'smooth' });
    first.current = false;
  }, [count]); // eslint-disable-line react-hooks/exhaustive-deps

  function jump(id: string, smooth = true) {
    document.getElementById(`q-${id}`)?.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
    setLit(id);
    setNav(false);
    setTimeout(() => setLit(l => (l === id ? null : l)), 2400);
  }
  function fresh() {
    setNav(false);
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
    box.current?.focus();
  }

  const composer = <Composer box={box} seq={line.seq} text={text} setText={setText} lead={lead} toLead={toLead} setToLead={setToLead} busy={!!asking} onSend={() => send()} />;
  const groups = useMemo(() => byDay(qs ?? []), [qs]);

  return createPortal(
    <div className="ak" role="dialog" aria-modal="true" aria-label={tr('问 #{0}', line.seq)}>
      {nav && <div className="ak-scrim" onClick={() => setNav(false)} />}
      <aside className={`ak-side${nav ? ' open' : ''}`}>
        <a className="ak-back" href={href(back)} onClick={e => follow(e, back)}><Icon n="left" size={15} />{tr('回到项目')}</a>
        <button className="ak-new" onClick={fresh}><Icon n="compose" size={16} />{tr('新问题')}</button>
        <a className="ak-link" href={href(pagesPath(line.seq))} onClick={e => follow(e, pagesPath(line.seq))}><Icon n="doc" size={15} />{tr('汇报与讲解')}</a>
        <nav className="ak-hist" aria-label={tr('问过的')}>
          {groups.map(([name, list]) => (
            <section key={name}>
              <h4>{name}</h4>
              <ul>
                {list.map(q => (
                  <li key={q.id} className={lit === q.id ? 'on' : ''}>
                    <button className="ak-hq" onClick={() => jump(q.id)} title={q.q}>{q.q}</button>
                    <button className="ib ak-del" onClick={() => drop(q.id)} title={tr('删掉这个问题')} aria-label={tr('删掉')}><Icon n="close" size={12} /></button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {qs && !qs.length && <p className="ak-none">{tr('还没有问过这个项目。')}</p>}
        </nav>
        {rows.length > 1 && (
          <section className="ak-projs">
            <h4>{tr('问别的项目')}</h4>
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
          <button className="ib ak-menu" onClick={() => setNav(true)} title={tr('问过的')} aria-label={tr('问过的')}><Icon n="sidebar" size={18} /></button>
          <div className="ak-title">
            <span className="pc-seq">#{line.seq}</span><b title={line.title}>{line.title}</b>
            <StatusTag status={line.status} />
          </div>
          <a className="ib ak-x" href={href(back)} onClick={e => follow(e, back)} title={tr('回到项目')} aria-label={tr('关闭')}><Icon n="close" size={18} /></a>
        </header>

        <div className="ak-scroll" ref={scroller}>
          {qs == null ? <p className="ak-load">{tr('加载中…')}</p> : empty ? (
            <div className="ak-hello">
              <span className="ak-hello-ic"><Icon n="chat" size={24} /></span>
              <h1>{tr('关于「{0}」，想知道什么？', line.title)}</h1>
              <p>{tr('从这个项目的卡片、汇报、实验、代码和论文仓库，以及导入的 agent 对话里找答案，每一处都标出出处。')}</p>
              {!phone && composer}
              <div className="ak-ex">
                {EXAMPLES.map(([ic, x]) => <button key={x} onClick={() => send(x)}><Icon n={ic} size={16} /><span>{x}</span></button>)}
              </div>
              {!r.memory.sessions && !r.memory.notes && (
                <p className="ak-mem">{tr('以前和 agent 的对话还没有导入。')} <a href={href(back)} onClick={e => follow(e, back)}>{tr('在项目页导入')}</a></p>
              )}
            </div>
          ) : (
            <ol className="ak-thread">
              {qs.map(q => <Turn key={q.id} q={q} lit={lit === q.id} offline={offline} lineId={line.id} seq={line.seq}
                onOpenHit={onOpenHit} onOpenPage={onOpenPage} onDrop={() => drop(q.id)} toast={toast} />)}
              {asking && (
                <li className="ak-turn">
                  <div className="ak-you"><p>{asking}</p></div>
                  <div className="ak-ans">
                    <span className="ak-av"><Icon n="books" size={16} /></span>
                    <div className="ak-think"><span className="ak-dots"><i /><i /><i /></span>{tr('在项目里找…')}</div>
                  </div>
                </li>
              )}
            </ol>
          )}
        </div>

        {(!empty || phone) && (
          <footer className="ak-foot">
            {composer}
            <p className="ak-hint">{offline ? tr('离线模式：回答是从项目里摘出的原句。') : tr('回答只用这个项目里的内容，每一处都标出出处。')}</p>
          </footer>
        )}
      </main>
    </div>,
    document.querySelector('.proto') ?? document.body,
  );
}

function Composer({ box, seq, text, setText, lead, toLead, setToLead, busy, onSend }: {
  box: React.RefObject<HTMLTextAreaElement>; seq: number; text: string; setText: (t: string) => void;
  lead: boolean; toLead: boolean; setToLead: (v: boolean) => void; busy: boolean; onSend: () => void;
}) {
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text, box]);
  const on = toLead && lead;
  return (
    <form className="ak-comp" onSubmit={e => { e.preventDefault(); onSend(); }}>
      <textarea ref={box} rows={1} value={text} maxLength={1000} placeholder={tr('问 #{0} 任何问题：实验、结果、代码、论文、以前的讨论…', seq)}
        onChange={e => setText(e.target.value)}
        onKeyDown={enterSends(onSend)} />
      <div className="ak-comp-row">
        <button type="button" className={`ak-pill${on ? ' on' : ''}`} disabled={!lead} aria-pressed={on} onClick={() => setToLead(!toLead)}
          title={lead ? tr('负责人会读项目，用 pt reply 写回答') : tr('这个项目还没有负责人')}>
          <Icon n={on ? 'check' : 'person'} size={13} />{tr('也交给负责人回答')}
        </button>
        <button className="ak-send" type="submit" disabled={busy || !text.trim()} title={tr('提问（Enter）')} aria-label={tr('提问')}><Icon n="send" size={16} /></button>
      </div>
    </form>
  );
}

function Turn({ q, lit, offline, lineId, seq, onOpenHit, onOpenPage, onDrop, toast }: {
  q: Question; lit: boolean; offline: boolean; lineId: string; seq: number; onOpenHit: OpenHit; onOpenPage: (o: PageOpen) => void; onDrop: () => void; toast: (t: string) => void;
}) {
  const [src, setSrc] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  const cite = (n: number) => { setSrc(n); setAll(true); setTimeout(() => setSrc(s => (s === n ? null : s)), 2400); };
  const hits = all ? q.hits : q.hits.slice(0, 4);
  async function copy() {
    try { await navigator.clipboard.writeText([q.answer, q.lead?.text].filter(Boolean).join('\n\n')); toast(tr('已复制')); } catch { /* not allowed here */ }
  }
  return (
    <li className={`ak-turn${lit ? ' lit' : ''}`} id={`q-${q.id}`}>
      <div className="ak-you"><p>{q.q}</p></div>
      <div className="ak-ans">
        <span className="ak-av"><Icon n="books" size={16} /></span>
        <div className="ak-ans-b">
          {q.answer ? (
            <>
              <span className="ak-by">{q.by === '摘录' ? tr('摘自项目里的原话{0}', offline ? tr('（离线模式，没有模型来组织回答）') : '') : tr('{0} 根据找到的内容回答', q.by)}</span>
              <Prose text={q.answer} onCite={cite} />
            </>
          ) : <p className="ak-miss">{tr('在这个项目里没找到和这个问题有关的内容。换个说法，或者交给负责人：它能读整个项目。')}</p>}
          {q.lead && (
            <div className={`ak-lead${q.lead.at ? '' : ' wait'}`}>
              <span className="ak-by"><Icon n="person" size={13} />{q.lead.at ? tr('负责人的回答 · {0}', ago(q.lead.at)) : tr('已经交给负责人，等它读完项目回答 · {0}', ago(q.lead.asked))}</span>
              {q.lead.text && <Prose text={q.lead.text} onCite={cite} />}
              {q.lead.page && (
                <div className="ak-page">
                  <div className="ak-page-h">
                    <Icon n="doc" size={14} /><b>{q.lead.title}</b>
                    <a href={href(pagesPath(seq, q.lead.page))} onClick={e => follow(e, pagesPath(seq, q.lead!.page))}><Icon n="ext" size={13} />{tr('全屏看')}</a>
                  </div>
                  <PageFrame src={api.pageUrl(lineId, q.lead.page)} title={q.lead.title ?? ''} fit={6000} onOpen={onOpenPage} /> {/* as tall as the page: the thread scrolls, not the frame */}
                </div>
              )}
              {!q.lead.at && <span className="ak-dots"><i /><i /><i /></span>}
            </div>
          )}
          {q.hits.length > 0 && (
            <section className="ak-found">
              <h5>{tr('找到的 {0} 处', q.hits.length)}</h5>
              <ol className="ak-srcs">
                {hits.map(h => <Source key={h.n} h={h} lit={src === h.n} onOpen={() => onOpenHit(h)} />)}
              </ol>
              {q.hits.length > 4 && <button className="ak-more" onClick={() => setAll(a => !a)}>{all ? tr('收起') : tr('看全部 {0} 处', q.hits.length)}</button>}
            </section>
          )}
          <div className="ak-acts">
            <span>{ago(q.at)}</span>
            {(q.answer || q.lead?.text) && <button className="ib" onClick={copy} title={tr('复制')} aria-label={tr('复制')}><Icon n="copy" size={14} /></button>}
            <button className="ib" onClick={onDrop} title={tr('删掉这个问题')} aria-label={tr('删掉')}><Icon n="close" size={14} /></button>
          </div>
        </div>
      </div>
    </li>
  );
}

function Source({ h, lit, onOpen }: { h: Hit; lit: boolean; onOpen: () => void }) {
  const [name, ic] = HIT[h.kind];
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => { if (lit) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [lit]);
  const file = h.kind === 'code' || h.kind === 'paper';
  return (
    <li ref={ref} className={`ak-src${lit ? ' lit' : ''}`}>
      <button onClick={onOpen} title={tr('打开')}>
        <span className="ak-src-k"><em>{h.n}</em><Icon n={ic} size={12} />{file ? name : `${name}${h.where ? ` · ${h.where}` : ''}`}</span>
        <b>{file ? h.where : h.title}</b>
        <span className="ak-src-t"><Marked text={h.snippet} terms={h.terms} /></span>
      </button>
    </li>
  );
}

// the words of the question, picked out where they appear
function Marked({ text, terms }: { text: string; terms: string[] }) {
  const ts = terms.filter(t => t.length > 1).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!ts.length) return <>{text}</>;
  const re = new RegExp(`(${ts.join('|')})`, 'gi');
  return <>{text.split(re).map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p))}</>;
}

// an answer: paragraphs and "- " lists, with [n] as buttons to the pieces they cite
function Prose({ text, onCite }: { text: string; onCite: (n: number) => void }) {
  const inline = (s: string) => s.split(/(\[\d+\])/).map((p, i) => {
    const m = /^\[(\d+)\]$/.exec(p);
    return m ? <button key={i} className="cite" onClick={() => onCite(Number(m[1]))}>{m[1]}</button> : p;
  });
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) blocks.push(<ul key={blocks.length}>{list.map((x, i) => <li key={i}>{inline(x)}</li>)}</ul>); list = []; };
  for (const ln of text.split('\n')) {
    const m = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(ln);
    if (m) { list.push(m[1]); continue; }
    flush();
    if (ln.trim()) blocks.push(<p key={blocks.length}>{inline(ln)}</p>);
  }
  flush();
  return <div className="prose">{blocks}</div>;
}

// on the project's page: a box that starts a question on the page above, and the latest ones asked
export function AskBox({ r, toast }: { r: ProjectCard; toast: (t: string) => void }) {
  const { line } = r;
  const { qs } = useQuestions(line.id, toast);
  const [text, setText] = useState('');
  const start = (q: string) => { if (q.trim()) askLater(line.id, line.seq, q.trim()); };
  const latest = [...(qs ?? [])].reverse().slice(0, 4);
  const page = askPath(line.seq);
  return (
    <section className="psec pj-ask">
      <header className="psec-h">
        <h3><Icon n="chat" size={16} />{tr('提问')}</h3>
        <a className="btn" href={href(page)} onClick={e => follow(e, page)}>{qs?.length ? tr('全部 {0} 个问题', qs.length) : tr('打开')}</a>
      </header>
      <form className="ak-comp mini" onSubmit={e => { e.preventDefault(); start(text); }}>
        <textarea rows={2} value={text} maxLength={1000} placeholder={tr('问 #{0} 任何问题：实验、结果、代码、论文、以前的讨论…', line.seq)}
          onChange={e => setText(e.target.value)}
          onKeyDown={enterSends(() => start(text))} />
        <div className="ak-comp-row">
          <span className="small muted">{tr('在全屏里回答')}</span>
          <button className="ak-send" type="submit" disabled={!text.trim()} aria-label={tr('提问')}><Icon n="send" size={15} /></button>
        </div>
      </form>
      {latest.length ? (
        <ul className="pj-recent">
          {latest.map(q => {
            const to = askPath(line.seq, q.id);
            return (
              <li key={q.id}><a href={href(to)} onClick={e => follow(e, to)}>
                <span>{q.q}</span><span className="small muted">{ago(q.at)}{q.lead && !q.lead.at ? ` · ${tr('等负责人')}` : ''}</span>
              </a></li>
            );
          })}
        </ul>
      ) : qs && (
        <div className="pj-ex">{EXAMPLES.slice(0, 2).map(([ic, x]) => <button key={x} className="chip" onClick={() => start(x)}><Icon n={ic} size={13} />{x}</button>)}</div>
      )}
    </section>
  );
}
