// The console's assistant, in a sidebar on the right: an agent like the depot's and the
// press's (Paseo or pi), told with every message what you are looking at: the panel, what you
// point at, the text you selected. It can ask you back, open things and light them up for you,
// and ask to do things in the town, which wait here until you allow them. A job or a file it
// names in a reply opens when clicked, and its earlier conversations in Paseo can be taken up
// again.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, listen, type Agent, type AgentEvent, type AssistantConv, type AssistantView, type Focus, type PaseoItem, type PaseoPermission, type ShowTarget, type StartOpts } from '../api';
import { fold, paseoTool, PaseoPick, piTool, PiSwitch, Text, Tool, Trail, UserMsg, usePaseoTalk, usePiTalk, type Item, type Linker, type ToolSt } from '../components/AgentRoom';
import type { RoomActions } from '../components/Interior';
import { AGENT_STATUS } from '../components/MillRoom';
import { tr, trx } from '../i18n';
import { Icon } from './icons';
import { describe, onPageChange, onSelect, pickable, snapshot, usePlace, type Selected } from './page';
import { ago } from './util';

const ID = 'assistant';
const WIDTH = 'pt-assistant-w';

// what to ask first, by the panel you are on; and about what you point at or select
const ASK: Record<string, string[]> = {
  overview: [tr('这个项目走到哪一步了？'), tr('接下来最该做什么？'), tr('有什么要我处理的？')],
  survey: [tr('和最接近的几篇比，我们新在哪？'), tr('哪篇最值得细读？')],
  code: [tr('这个仓库是怎么组织的？'), tr('训练的入口在哪？'), tr('最近改了什么？')],
  exp: [tr('最近失败的任务是怎么回事？'), tr('现在有哪些任务在跑？'), tr('哪组结果最好？')],
  data: [tr('这些数字说明了什么？'), tr('哪组结果最好？')],
  paper: [tr('论文还缺什么？'), tr('帮我编译一下论文')],
  agents: [tr('员工们在做什么？'), tr('有谁卡住了吗？')],
  skills: [tr('这些 skill 都是做什么的？')],
  mcp: [tr('这些 MCP 服务器都连上了吗？')],
  rag: [tr('图书馆里有哪些和这个项目相关的论文？')],
};
const ASK_ANY = [tr('这一页在讲什么？'), tr('有什么要我处理的？'), tr('各个项目现在怎么样？')];
const ASK_AT = [tr('这是什么？'), tr('这里有问题吗？')];
const ASK_SEL = [tr('解释一下这段'), tr('这段有什么问题？')];

// a message as it went out: the page it was written on, where the projects you named stood, then
// your words; or a note from the town. Paseo drops the <start> mark from a conversation's first
// prompt, so its opening words mark it too.
type Said = { text: string; where?: string; pointed?: string; selected?: string; selectedAt?: string; projects?: string[]; event?: string };
export function parse(t: string): Said {
  if (/^(<start>|你是 Papertown 中控屏的小助手)/.test(t)) return { text: '', event: tr('小助手启动了，先读了一遍它的说明。') };
  const ev = /^<event>\n?([\s\S]*?)\n?<\/event>\s*$/.exec(t);
  if (ev) return { text: '', event: ev[1].trim() };
  if (/^<bounds>/.test(t)) return { text: '', event: tr('你改了工作边界，它收到了新的一份。') };
  const pg = /^<page>\n([\s\S]*?)\n<\/page>\n*/.exec(t);
  const rest = pg ? t.slice(pg[0].length) : t;
  const pj = /^<projects>\n([\s\S]*?)\n<\/projects>\n*/.exec(rest);
  const projects = pj ? [...pj[1].matchAll(/^项目 #(\d+)「/gm)].map(m => m[1]) : undefined;
  const text = pj ? rest.slice(pj[0].length) : rest;
  if (!pg) return { text, projects };
  const lines = pg[1].split('\n'), get = (k: string) => lines.find(l => l.startsWith(k))?.slice(k.length);
  return {
    text, projects, where: get('在看：')?.replace(/（.*）$/, ''), pointed: get('指着：')?.split('〔')[0],
    selected: get('选中：')?.replace(/（\d+ 行，全文在 page\.md）$/, '').replace(/^「([\s\S]*)」$/, '$1'), selectedAt: get('选中的地方：')?.split(/〔|，在「/)[0],
  };
}

// the conversation as the sidebar shows it, whichever runtime it is in
type YouRow = { k: 'you'; text: string; ctx: Said; sending?: boolean };
type ItRow = { k: 'it'; text: string; err?: boolean; live?: boolean };
type Row = { key: string } & (YouRow | ItRow
  | { k: 'tools'; tools: { name: string; arg?: string; st: ToolSt; note?: string }[]; detail?: Item[] }
  | { k: 'ev'; text: string }
  | { k: 'note'; text: string; err?: boolean });

const said = (key: string, text: string, sending?: boolean): Row => {
  const m = parse(text);
  return m.event !== undefined ? { key, k: 'ev', text: m.event } : { key, k: 'you', text: m.text, ctx: m, sending };
};
// your messages and its replies are keyed by their place in line, so a message sent and then
// confirmed, or a reply streamed and then finished, stays the same row
function keyed(rows: Row[]): Row[] {
  const n = { you: 0, it: 0 };
  return rows.map(r => (r.k === 'you' || r.k === 'it' ? { ...r, key: `${r.k}${n[r.k]++}` } : r));
}
function paseoRows(items: PaseoItem[] | null, sent: string[]): Row[] {
  const rows = fold(items ?? [], i => i.kind === 'tool').map((x, i): Row => Array.isArray(x)
    ? { key: `t${i}`, k: 'tools', tools: x.map(paseoTool) }
    : x.kind === 'user' ? said(`u${i}`, x.text ?? '')
      : x.kind === 'assistant' ? { key: '', k: 'it', text: x.text ?? '' }
        : { key: `n${i}`, k: 'note', text: x.text ?? '', err: x.kind === 'error' });
  return keyed([...rows, ...sent.map((t): Row => ({ key: '', k: 'you', text: t, ctx: { text: t }, sending: true }))]);
}
const lastOf = (rows: Row[], k: Row['k']) => {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].k === k) return i;
  return -1;
};
function piRows(items: Item[], live: string): Row[] {
  const rows: Row[] = [];
  for (const x of fold(items, i => i.ev.kind === 'tool')) {
    if (Array.isArray(x)) {
      rows.push({ key: `t${x[0].ev.id}`, k: 'tools', tools: x.map(piTool), detail: x });
      continue;
    }
    const { ev } = x, d = ev.data ?? {}, key = `e${ev.id}`;
    if (ev.kind === 'user') rows.push(d.cmd ? { key, k: 'note', text: d.text } : said(key, d.text ?? '', d.origin === 'web' && !d.delivered));
    else if (ev.kind === 'assistant' && (d.text || d.error)) rows.push({ key, k: 'it', text: d.text || d.error, err: !!d.error });
    else if (ev.kind === 'note') rows.push({ key, k: 'note', text: d.text, err: !!d.error });
  }
  if (live) rows.push({ key: '', k: 'it', text: live, live: true });
  return keyed(rows);
}

// what a reply names, made to click: a job opens in the experiments panel, a file in the code or
// paper panel at its line. The assistant's own files are left alone.
const JOB = /(#\d{3,}|nvidb-\d+|job_[0-9a-z]{6,})/;
const ONLY_JOB = new RegExp(`^${JOB.source}$`);
const FILE = /^(?:\.\/)?((?:[\w.-]+\/)*[\w-][\w.-]*\.(?:py|ipynb|sh|js|mjs|ts|tsx|jsx|json|jsonl|ya?ml|toml|cfg|ini|txt|csv|tsv|md|tex|bib|sty|cls|c|cc|cpp|h|hpp|cu|rs|go|java|r|jl|lua|sql))(?::(\d+))?$/i;
const OWN = /^\.|^(AGENTS|page|actions)\.md$/;
const show = (t: ShowTarget) => dispatchEvent(new CustomEvent('pt-show', { detail: t }));
function target(s: string): ShowTarget | null {
  if (ONLY_JOB.test(s)) return { job: s.replace(/^#/, '') };
  const m = FILE.exec(s);
  if (!m || OWN.test(m[1]) || m[1].split('/').includes('..')) return null;
  return { file: `${/\.(tex|bib|sty|cls)$/i.test(m[1]) ? 'paper' : 'code'}:${m[1]}${m[2] ? `:${m[2]}` : ''}` };
}
const LINK: Linker = {
  text: s => s.split(JOB).map((x, i) => (i % 2
    ? <button key={i} className="as-ref" title={tr('打开这个任务')} onClick={() => show({ job: x.replace(/^#/, '') })}>{x}</button>
    : x)),
  code: s => {
    const t = target(s.trim());
    return t && <button className="as-ref as-code" title={t.job ? tr('打开这个任务') : tr('打开这个文件')} onClick={() => show(t)}>{s}</button>;
  },
};

// what the sidebar's parts share: the header, sending, and what goes along with a message
interface Side {
  view: AssistantView;
  head: (a: Agent) => React.ReactNode;
  send: (text: string) => Promise<boolean>;
  toast: (text: string) => void;
  focus: Focus | null;
  setFocus: (f: Focus | null) => void;
  sel: Selected | null;
  setSel: (s: Selected | null) => void;
  pointing: boolean;
  point: (then: (f: Focus) => void) => void;
  unpoint: () => void;
  autoFocus?: boolean;
}

export function Assistant({ actions, onClose, autoFocus }: { actions: RoomActions; onClose: () => void; autoFocus?: boolean }) {
  const [view, setView] = useState<AssistantView | null>(null);
  const [err, setErr] = useState('');
  const [bump, setBump] = useState(0);
  const [focus, setFocusState] = useState<Focus | null>(null);
  const [sel, setSelState] = useState<Selected | null>(null);
  const [pointing, setPointing] = useState<((f: Focus) => void) | null>(null);
  const [history, setHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [w, setW] = useState(() => { try { return Number(localStorage.getItem(WIDTH)) || 400; } catch { return 400; } });
  const focusRef = useRef<Focus | null>(null), selRef = useRef<Selected | null>(null);
  const last = useRef<{ focus: Focus | null; sel: Selected | null }>({ focus: null, sel: null }); // what went with your last message
  const setFocus = (f: Focus | null) => { focusRef.current = f; setFocusState(f); };
  const setSel = (s: Selected | null) => { selRef.current = s; setSelState(s); };
  const place = usePlace();
  const toast = actions.toast;
  const reload = () => setBump(b => b + 1);

  useEffect(() => {
    api.assistant().then(v => { setView(v); setErr(''); }, e => setErr((e as Error).message));
  }, [bump]);
  useEffect(() => listen(e => {
    if (e.type === 'agent' && e.agent?.id === ID) setView(v => (v ? { ...v, agent: e.agent } : v));
    else if (e.type === 'agent_event' && e.event.agent_id === ID && ['ask', 'act'].includes(e.event.kind)) setBump(b => b + 1);
  }), []);
  useEffect(() => { try { localStorage.setItem(WIDTH, String(w)); } catch { /* private mode */ } }, [w]);
  // what opens over the panels (a job's drawer) stops short of the sidebar
  useLayoutEffect(() => {
    const host = document.querySelector<HTMLElement>('.p-console');
    host?.style.setProperty('--asst-w', `${w}px`);
    return () => { host?.style.removeProperty('--asst-w'); };
  }, [w]);

  // what you point at and select belongs to the page it is on: moving on drops it
  useEffect(() => {
    setFocus(null);
    setSel(null);
    last.current = { focus: null, sel: null };
  }, [place.line?.id, place.mod]);
  useEffect(() => onSelect(setSel), []); // eslint-disable-line react-hooks/exhaustive-deps

  // page.md follows you while it runs: the page you are on, a moment after you move, with what
  // went along with your last message until you move on
  const started = !!view?.agent.started;
  useEffect(() => {
    if (!started) return;
    let t = 0;
    const sync = () => {
      clearTimeout(t);
      t = window.setTimeout(() => api.assistantPage(snapshot(focusRef.current ?? last.current.focus, selRef.current ?? last.current.sel)).catch(() => {}), 1500);
    };
    sync();
    const off = onPageChange(sync);
    return () => { off(); clearTimeout(t); };
  }, [started, focus]);

  async function send(text: string) {
    try {
      if (view?.agent.runtime === 'pi' && text.startsWith('/')) await api.say(ID, text); // pi's own commands go as they are
      else {
        const f = focusRef.current, s = selRef.current;
        last.current = { focus: f, sel: s };
        setFocus(null);
        setSel(null);
        await api.assistantSay(text, snapshot(f, s));
      }
      return true;
    } catch (e) {
      toast((e as Error).message);
      return false;
    }
  }
  async function start(o: StartOpts) {
    setBusy(true);
    try { await api.startAgent(ID, o); reload(); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  }
  async function resume(c: AssistantConv) {
    setHistory(false);
    try { await api.assistantResume(c.id); reload(); } catch (e) { toast((e as Error).message); }
  }
  function fresh() {
    setHistory(false);
    api.assistantNew().then(reload, e => toast((e as Error).message));
  }
  const point = (then: (f: Focus) => void) => setPointing(() => (f: Focus) => { setPointing(null); then(f); });

  // drag the left edge to make it wider
  function resize(e: React.PointerEvent) {
    const x0 = e.clientX, w0 = w;
    const move = (ev: PointerEvent) => setW(Math.min(720, Math.max(320, w0 + x0 - ev.clientX)));
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); document.body.classList.remove('pt-resizing'); };
    document.body.classList.add('pt-resizing');
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  // who it is and how it is, then buttons of one size: earlier conversations, a new one, Paseo, close
  const head = (a?: Agent) => (
    <header className="as-head">
      <span className={`dot s-${a?.started ? a.status : 'stopped'}`} />
      <div className="as-who">
        <b>{tr('小助手')}</b>
        {a?.started && <span>{AGENT_STATUS[a.status] ?? a.status}{a.model ? ` · ${a.model}` : ''}</span>}
      </div>
      <button className={`ib as-hist${history ? ' on' : ''}`} title={tr('之前的对话')} aria-expanded={history} onClick={() => setHistory(h => !h)}><Icon n="clock" size={16} /></button>
      {a?.started && <button className="ib" title={tr('新对话：可以换一个模型重新开始')} onClick={fresh}><Icon n="compose" size={16} /></button>}
      {a?.started && a.runtime === 'paseo' && (
        <button className="ib" title={tr('在 Paseo 桌面端打开这段对话')} onClick={() => api.openInPaseo(ID).catch(e => toast((e as Error).message))}><Icon n="ext" size={16} /></button>
      )}
      <button className="ib" title={tr('收起小助手（⌘J）')} onClick={onClose}><Icon n="sideR" size={16} /></button>
    </header>
  );

  const a = view?.agent;
  const side: Side | null = view && {
    view, head, send, toast, focus, setFocus, sel, setSel, autoFocus,
    pointing: !!pointing, point, unpoint: () => setPointing(null),
  };
  return (
    <aside className="asst" style={{ width: w }}>
      <span className="as-grip" onPointerDown={resize} title={tr('拖动改变宽度')} />
      {!side || !a ? (
        <>{head()}<p className={`as-wait${err ? ' warn-box small' : ''}`}>{err || tr('加载中…')}</p></>
      ) : !a.started ? (
        <>
          {head(a)}
          <div className="as-start">
            <p className="as-lead">{tr('一个本地 agent，和员工一样跑在 Paseo 或 pi 里。它知道你在看哪一页、指着什么，会去读这一页数据的出处来回答；要它办的事，先在这里请你点头。')}</p>
            <Earlier limit={3} title={tr('接着之前的对话')} onPick={resume} />
            <div className="hire-card">
              <h3>Paseo</h3>
              <PaseoPick busy={busy} onStart={start} role="assistant" />
            </div>
            <div className="hire-card">
              <h3>{tr('pi · 后台终端')}</h3>
              <button className="btn" disabled={busy} onClick={() => start({ runtime: 'pi' })}>{busy ? tr('启动中…') : tr('启动 pi')}</button>
            </div>
          </div>
        </>
      ) : a.runtime === 'paseo'
        ? <PaseoSide key={a.ext_id ?? 'paseo'} agent={a} side={side} />
        : <PiSide key="pi" agent={a} side={side} />}
      {history && <History onPick={resume} onClose={() => setHistory(false)} />}
      {pointing && <Pointer onPick={pointing} onCancel={() => setPointing(null)} />}
    </aside>
  );
}

function PaseoSide({ agent, side }: { agent: Agent; side: Side }) {
  const t = usePaseoTalk(agent, s => parse(s).text);
  const rows = useMemo(() => paseoRows(t.items, t.sent), [t.items, t.sent]);
  return (
    <Talk side={side} agent={t.agent} rows={rows} loading={t.items === null} err={t.err} perms={t.asks} onSent={t.wrote}
      onPermit={(id, allow) => { t.answered(id); api.permit(ID, id, allow).catch(e => side.toast((e as Error).message)); }} />
  );
}

function PiSide({ agent, side }: { agent: Agent; side: Side }) {
  const t = usePiTalk(agent);
  const rows = useMemo(() => piRows(t.items, t.live), [t.items, t.live]);
  return <Talk side={side} agent={t.agent} rows={rows} />;
}

function Talk({ side, agent, rows, loading, err, perms = [], onPermit, onSent }: {
  side: Side; agent: Agent; rows: Row[]; loading?: boolean; err?: string;
  perms?: PaseoPermission[]; onPermit?: (id: string, allow: boolean) => void; onSent?: (text: string) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [stuck, setStuck] = useState(true);
  const place = usePlace();
  const working = agent.status === 'working';
  const tail = rows[rows.length - 1];
  const asked = lastOf(rows, 'you'), replied = lastOf(rows, 'it');
  const question = asked >= 0 ? (rows[asked] as Row & YouRow).text : '';

  function submit(text: string) {
    stick.current = true;
    if (!(agent.runtime === 'pi' && text.startsWith('/'))) onSent?.(text);
    side.send(text);
  }
  // stay at the latest while you are there, also when the box below grows; scrolled up, a
  // button brings you back
  useLayoutEffect(() => {
    const el = scroll.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [rows, perms.length, side.view, working]);
  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { if (stick.current) el.scrollTop = el.scrollHeight; });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <>
      {side.head(agent)}
      {agent.runtime === 'pi' && agent.state && (
        <div className="as-sub"><PiSwitch s={agent.state} send={t => api.say(ID, t).catch(e => side.toast((e as Error).message))} /></div>
      )}
      <div className="as-mid">
        <div className="as-log" ref={scroll} onScroll={e => {
          const el = e.currentTarget, near = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          stick.current = near;
          setStuck(near);
        }}>
          {err && <div className="note err">{err}</div>}
          {loading && <p className="as-wait">{tr('加载中…')}</p>}
          {rows.map((r, i) => r.k === 'you' ? <YouMsg key={r.key} r={r} />
            : r.k === 'it' ? <ReplyMsg key={r.key} r={r} last={i === replied}
              again={i === replied && i > asked && asked >= 0 && !working ? () => submit(question) : undefined} />
              : r.k === 'tools' ? <Trail key={r.key} tools={r.tools}>{r.detail && <div className="trail-list">{r.detail.map(t => <Tool key={t.ev.id} {...t} />)}</div>}</Trail>
                : r.k === 'ev' ? <div key={r.key} className="as-ev"><Icon n="bell" size={13} /><div><Text text={r.text} link={LINK} /></div></div>
                  : <div key={r.key} className={`note${r.err ? ' err' : ''}`}>{r.text}</div>)}
          {!loading && asked < 0 && <Hello mod={place.mod} onAsk={submit} />}
          {perms.map(q => (
            <div key={q.id} className="as-card as-perm">
              <span className="as-k">{tr('它想')}{q.name === 'Bash' ? tr('运行命令') : tr('用 {0}', q.name)}</span>
              {q.title && q.title !== q.name && <p>{q.title}</p>}
              {q.arg && <pre className="code">{q.arg}</pre>}
              <div className="as-choices">
                <button className="btn pri" onClick={() => onPermit?.(q.id, true)}>{tr('允许')}</button>
                <button className="btn" onClick={() => onPermit?.(q.id, false)}>{tr('拒绝')}</button>
              </div>
            </div>
          ))}
          <Cards view={side.view} send={submit} toast={side.toast} onPoint={then => side.point(f => { side.setFocus(f); then(); })} />
          {working && !perms.length && !(tail?.k === 'it' && tail.live) && <Busy tail={tail} />}
        </div>
        {!stuck && (
          <button className="as-down" title={tr('回到最新')} onClick={() => scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' })}>
            <Icon n="down" size={16} />
          </button>
        )}
      </div>
      <Composer agent={agent} side={side} onSubmit={submit} />
    </>
  );
}

// one of your messages: what went along with it in small type, then your words
function YouMsg({ r }: { r: YouRow }) {
  const { where, pointed, selected, selectedAt, projects } = r.ctx;
  return (
    <div className="as-you">
      {(where || pointed || selected || projects?.length) && (
        <div className="as-said">
          {where && <span title={trx(where)}><Icon n="eye" size={11} /><i>{trx(where)}</i></span>}
          {pointed && <span className="on" title={trx(pointed)}><Icon n="target" size={11} /><i>{trx(pointed)}</i></span>}
          {selected && <span className="on" title={selected}><Icon n="quote" size={11} /><i>{selected}{selectedAt && <em> · {trx(selectedAt)}</em>}</i></span>}
          {!!projects?.length && <span title={tr('Papertown 把这些项目刚读的进展附在了消息里')}><Icon n="compass" size={11} /><i>{tr('附上了 {0} 的进展', projects.map(n => `#${n}`).join(' '))}</i></span>}
        </div>
      )}
      <UserMsg text={r.text} />
      {r.sending && <span className="as-meta">{tr('发送中')}</span>}
    </div>
  );
}

// one of its replies, on the page rather than in a box; what it names opens when clicked
function ReplyMsg({ r, last, again }: { r: ItRow; last: boolean; again?: () => void }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard?.writeText(r.text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }, () => {});
  }
  return (
    <div className={`msg-a as-it${r.err ? ' err' : ''}${last ? ' last' : ''}${r.live ? ' streaming' : ''}`}>
      <Text text={r.text} link={LINK} />
      {r.live ? <i className="caret" /> : (
        <div className="as-ops">
          <button className="as-op" title={tr('复制这段回答')} onClick={copy}><Icon n="copy" size={13} />{copied && tr('已复制')}</button>
          {again && <button className="as-op" title={tr('把上一个问题再问一次')} onClick={again}><Icon n="refresh" size={13} />{tr('再问一次')}</button>}
        </div>
      )}
    </div>
  );
}

// before your first question: what it is for, and questions to start with on this panel
function Hello({ mod, onAsk }: { mod: string; onAsk: (text: string) => void }) {
  return (
    <div className="as-hello">
      <p>{tr('问这一页的事，或者请它帮你办。它看得到你在哪一页；想问得更准，就指给它看，或者先在页面上选中一段字。')}</p>
      <div className="as-asks">{(ASK[mod] ?? ASK_ANY).map(q => <button key={q} onClick={() => onAsk(q)}><Icon n="chat" size={14} />{q}</button>)}</div>
    </div>
  );
}

// while it works: what it is doing right now
function Busy({ tail }: { tail?: Row }) {
  const tool = tail?.k === 'tools' ? [...tail.tools].reverse().find(t => t.st === 'run') : undefined;
  return <div className="as-busy"><span className="thinking"><i /><i /><i /></span>{tool ? tr('在用 {0}', tool.name) : tr('在想…')}</div>;
}

// the box you write in, with what goes along with your message: the page, what you point at, the
// text you selected. While it works and you have written nothing, send turns into stop.
function Composer({ agent, side, onSubmit }: { agent: Agent; side: Side; onSubmit: (text: string) => void }) {
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const place = usePlace();
  const { focus, sel } = side;
  const working = agent.status === 'working', typed = !!text.trim();
  const hints = typed ? null : sel ? ASK_SEL : focus ? ASK_AT : null;
  const lines = sel ? sel.text.split('\n').length : 0;

  // the box grows with what you write, up to about eight lines
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);
  useEffect(() => { if (side.autoFocus) box.current?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function go(t: string) {
    const s = t.trim();
    if (!s) return;
    setText('');
    onSubmit(s);
  }
  return (
    <div className="as-foot">
      {hints && <div className="as-hint">{hints.map(q => <button key={q} onClick={() => go(q)}>{q}</button>)}</div>}
      <div className="as-box" onMouseDown={e => { if (e.target === e.currentTarget) { e.preventDefault(); box.current?.focus(); } }}>
        <div className="as-ctx">
          <span className="as-pill" title={tr('每条消息都会带上你在看的页面')}><Icon n="eye" size={12} /><b>{place.line ? `#${place.line.seq} · ` : ''}{place.name || tr('中控屏')}</b></span>
          {focus && (
            <span className="as-pill on" title={focus.text}><Icon n="target" size={12} /><b>{focus.label}</b>{focus.where && <em>{focus.where}</em>}
              <button onClick={() => side.setFocus(null)} aria-label={tr('不指了')}><Icon n="close" size={10} /></button></span>
          )}
          {sel && (
            <span className="as-pill on" title={sel.at ? `${sel.text}\n· ${sel.at.label}` : sel.text}><Icon n="quote" size={12} /><b>{sel.text.replace(/\s+/g, ' ')}</b>{lines > 1 && <em>{tr('{0} 行文字', lines)}</em>}
              <button onClick={() => side.setSel(null)} aria-label={tr('不带这段')}><Icon n="close" size={10} /></button></span>
          )}
        </div>
        <textarea ref={box} rows={1} value={text}
          placeholder={!working ? tr('问这一页的事，或者请它帮你办') : agent.runtime === 'pi' ? tr('它在忙，发出的消息会排在它手上的事之后') : tr('它在忙，发出的消息会插进它手上的事')}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); go(text); } }} />
        <div className="as-tools">
          <button className={`as-tool${side.pointing ? ' on' : ''}`} title={tr('在页面上点一下你想问的地方')}
            onClick={() => (side.pointing ? side.unpoint() : side.point(side.setFocus))}>
            <Icon n="target" size={15} />{side.pointing ? tr('点页面上的一处…') : tr('指给它看')}
          </button>
          {working && !typed
            ? <button className="as-send stop" title={tr('打断它手上的事')} onClick={() => api.abort(ID).catch(e => side.toast((e as Error).message))}><Icon n="stop" size={14} /></button>
            : <button className="as-send" disabled={!typed} title={tr('发送（Enter）')} onClick={() => go(text)}><Icon n="send" size={16} /></button>}
        </div>
      </div>
    </div>
  );
}

// its question for you, and what it asked to do, each answered here
function Cards({ view, send, toast, onPoint }: {
  view: AssistantView; send: (t: string) => void; toast: (t: string) => void; onPoint: (then: () => void) => void;
}) {
  const [done, setDone] = useState<Record<number, AgentEvent>>({});
  const shown = useRef(new Set<Element>());
  const seen = (el: HTMLDivElement | null) => {
    if (el && !shown.current.has(el)) { shown.current.add(el); requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })); }
  };
  const ask = view.asks[0];
  // what it did on its own (a message, an answer passed on) shows for a moment too
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(t); }, []);
  const fresh = (e: AgentEvent) => e.data.auto && now - Date.parse(e.data.decided_at ?? e.ts) < 15000;
  const acts = view.acts.filter(e => e.data.status === 'pending' || done[e.id] || fresh(e));
  async function decide(e: AgentEvent, allow: boolean) {
    try {
      const r = await api.decide(e.id, allow);
      setDone(d => ({ ...d, [e.id]: r }));
      setTimeout(() => setDone(d => { const { [e.id]: _, ...rest } = d; return rest; }), 8000);
    } catch (x) { toast((x as Error).message); }
  }
  if (!ask && !acts.length) return null;
  return (
    <>
      {ask && (
        <div className="as-card as-ask" ref={seen}>
          <span className="as-k">{tr('它问你')}</span>
          <p>{ask.data.question}</p>
          {(ask.data.choices?.length > 0 || ask.data.point) && <div className="as-choices">
            {(ask.data.choices as string[]).map(c => <button key={c} className="btn" onClick={() => send(c)}>{c}</button>)}
            {ask.data.point && <button className="btn pri" onClick={() => onPoint(() => send(tr('是这里。')))}><Icon n="target" size={14} />{tr('在页面上点一下')}</button>}
          </div>}
        </div>
      )}
      {acts.map(e => {
        const d = (done[e.id] ?? e).data;
        return (
          <div key={e.id} className={`as-card as-act st-${d.status}`} ref={seen}>
            <span className="as-k">{d.status === 'pending' ? tr('它想替你做') : d.status === 'done' ? (d.auto ? tr('已替你做了') : tr('已经做了')) : d.status === 'denied' ? tr('你没让它做') : tr('没做成')}</span>
            <p><b>{d.title}</b></p>
            {d.why && d.status === 'pending' && <p className="muted small">{d.why}</p>}
            {d.rule && d.status === 'pending' && <p className="muted small">{tr('按你的工作边界要先问你：{0}', d.rule)}</p>}
            {d.result && <p className="small">{d.result}</p>}
            {d.status === 'pending' && <div className="as-choices">
              <button className="btn pri" onClick={() => decide(e, true)}>{tr('允许')}</button>
              <button className="btn" onClick={() => decide(e, false)}>{tr('不要')}</button>
            </div>}
          </div>
        );
      })}
    </>
  );
}

// the assistant's conversations in Paseo, the latest first, each named by the first thing asked
function Earlier({ onPick, limit, title }: { onPick: (c: AssistantConv) => void; limit?: number; title?: string }) {
  const [list, setList] = useState<AssistantConv[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.assistantHistory().then(r => setList(r.conversations), e => setErr((e as Error).message)); }, []);
  const shown = limit ? (list ?? []).filter(c => !c.current).slice(0, limit) : list ?? [];
  if (limit && !shown.length) return null;
  return (
    <div className="as-convs">
      {title && <h4>{title}</h4>}
      {err ? <p className="as-none">{err}</p>
        : !list ? <p className="as-none">{tr('加载中…')}</p>
          : !shown.length ? <p className="as-none">{tr('还没有之前的对话。')}</p>
            : shown.map(c => (
              <button key={c.id} className={`as-conv${c.current ? ' on' : ''}`} disabled={c.current} onClick={() => onPick(c)}>
                <b>{c.title || tr('（没有标题）')}</b>
                <span>{c.current ? tr('正在进行') : ago(c.at)}{c.model ? ` · ${c.model}` : ''}</span>
              </button>
            ))}
    </div>
  );
}

// earlier conversations, dropped from the header; a click elsewhere or Esc closes it
function History({ onPick, onClose }: { onPick: (c: AssistantConv) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Element;
      if (!ref.current?.contains(t) && !t.closest?.('.as-hist')) onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    addEventListener('pointerdown', down, true);
    addEventListener('keydown', key, true);
    return () => { removeEventListener('pointerdown', down, true); removeEventListener('keydown', key, true); };
  }, [onClose]);
  return (
    <div className="as-pop" ref={ref} role="dialog" aria-label={tr('之前的对话')}>
      <h5>{tr('之前的对话')}</h5>
      <Earlier onPick={onPick} />
    </div>
  );
}

// pointing: the part under the mouse is outlined and named; a click takes it, Esc gives up
function Pointer({ onPick, onCancel }: { onPick: (f: Focus) => void; onCancel: () => void }) {
  const [box, setBox] = useState<{ r: DOMRect; label: string } | null>(null);
  useEffect(() => {
    const scope = document.querySelector('.p-console');
    const ok = (t: EventTarget | null): t is Element => t instanceof Element && !!scope?.contains(t) && !t.closest('.asst');
    const move = (e: MouseEvent) => {
      if (!ok(e.target)) { setBox(null); return; }
      const el = pickable(e.target);
      setBox({ r: el.getBoundingClientRect(), label: describe(el).label });
    };
    const hold = (e: Event) => { if (ok(e.target)) { e.preventDefault(); e.stopPropagation(); } };
    const click = (e: MouseEvent) => { if (ok(e.target)) { hold(e); onPick(describe(e.target)); } };
    const menu = (e: MouseEvent) => { if (ok(e.target)) { hold(e); onCancel(); } };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); onCancel(); } };
    const gone = () => setBox(null);
    const held = ['pointerdown', 'mousedown', 'mouseup', 'dblclick'];
    document.body.classList.add('pt-pointing');
    addEventListener('mousemove', move, true);
    held.forEach(t => addEventListener(t, hold, true));
    addEventListener('click', click, true);
    addEventListener('contextmenu', menu, true);
    addEventListener('keydown', key, true);
    addEventListener('scroll', gone, true);
    return () => {
      document.body.classList.remove('pt-pointing');
      removeEventListener('mousemove', move, true);
      held.forEach(t => removeEventListener(t, hold, true));
      removeEventListener('click', click, true);
      removeEventListener('contextmenu', menu, true);
      removeEventListener('keydown', key, true);
      removeEventListener('scroll', gone, true);
    };
  }, [onPick, onCancel]);
  return createPortal(
    <div className="pt-pointer" aria-hidden="true">
      {box && <div className="pt-box" style={{ left: box.r.left - 3, top: box.r.top - 3, width: box.r.width + 6, height: box.r.height + 6 }}>
        <span className={box.r.top < 40 ? 'below' : ''}>{box.label}</span>
      </div>}
      <div className="pt-hint">{tr('点一下页面上你想问的地方')} · <kbd>Esc</kbd> {tr('取消')}</div>
    </div>,
    document.querySelector('.theme-sketch') ?? document.body,
  );
}
