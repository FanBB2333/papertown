// The assistant in the floating window on every page: an agent (Paseo or pi) told with every message what you
// are looking at, which can ask you back, open and light up things, and ask leave to act in the town. Its
// message box also takes a new idea straight to the hatchery, or a rewrite of an idea waiting on you.

import { modelText } from '../emphasis';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, listen, type Agent, type AgentEvent, type AssistantConv, type AssistantView, type Focus, type PaseoItem, type PaseoPermission, type ShowTarget, type StartOpts } from '../api';
import { HostedRoom } from '../agents/Terminal';
import { TerminalPick } from '../agents/TerminalPick';
import { fold, paseoTool, PaseoPick, piTool, PiSwitch, Text, Tool, Trail, UserMsg, usePaseoTalk, usePiTalk, type Item, type Linker, type ToolSt } from '../components/AgentRoom';
import { AGENT_STATUS } from '../components/MillRoom';
import { tr, trx } from '../i18n';
import { useNow } from './charts';
import { Icon } from './icons';
import { Earlier, History } from './Convs';
import { describe, onPageChange, onSelect, pickable, SCOPE, snapshot, usePlace, type Selected } from './page';
import { enterSends } from './util';

const ID = 'assistant';

// What the message box sends: a message to the assistant or a new idea.
export type Target = { kind: 'assistant'; draft?: string } | { kind: 'idea' };

// starter questions: per panel, on any panel, about what you point at, about what you selected
const ASK: Record<string, string[]> = {
  overview: [tr('当前进展至哪一步？'), tr('下一步应当做什么？'), tr('有什么待我处理的？')],
  survey: [tr('与最相近的几篇相比，创新点何在？'), tr('哪篇最值得细读？')],
  code: [tr('这个仓库是如何组织的？'), tr('训练的入口在哪？'), tr('近期有何修改？')],
  exp: [tr('最近失败任务的原因是什么？'), tr('当前有哪些任务在运行？'), tr('哪组结果最好？')],
  data: [tr('这些数字说明了什么？'), tr('哪组结果最好？')],
  paper: [tr('论文还缺什么？'), tr('请代为编译论文')],
  agents: [tr('员工们在做什么？'), tr('有人受阻吗？')],
  skills: [tr('这些 skill 各自有何用途？')],
  mcp: [tr('这些 MCP 服务器均已连接吗？')],
  rag: [tr('图书馆中有哪些与本项目相关的论文？')],
};
const ASK_ANY = [tr('本页内容是什么？'), tr('有什么待我处理的？'), tr('各项目当前进展如何？')];
const ASK_AT = [tr('这是什么？'), tr('这里有问题吗？')];
const ASK_SEL = [tr('解释这段内容'), tr('这段有什么问题？')];

// a sent message split into what went along with it and your words, or a note from the town
type Said = { text: string; where?: string; pointed?: string; selected?: string; selectedAt?: string; projects?: string[]; event?: string };
function parse(t: string): Said {
  // Paseo drops the <start> mark from a conversation's first prompt, so its opening words mark it too
  if (/^(<start>|你是 Papertown 中控屏的小助手)/.test(t)) return { text: '', event: tr('小助手已启动，首先读取了其说明。') };
  const ev = /^<event>\n?([\s\S]*?)\n?<\/event>\s*$/.exec(t);
  if (ev) return { text: '', event: ev[1].trim() };
  if (/^<bounds>/.test(t)) return { text: '', event: tr('你修改了工作边界，小助手已收到更新。') };
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

// a conversation row, whichever runtime it came from
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
// keyed by place in line, so a message sent then confirmed, or a reply streamed then finished, stays one row
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

// a job or file named in a reply opens on click; the assistant's own files (OWN) are left alone
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

interface Side {
  view: AssistantView;
  head: (a: Agent) => React.ReactNode;
  send: (text: string) => Promise<boolean>;
  toast: (text: string, error?: boolean) => void;
  focus: Focus | null;
  setFocus: (f: Focus | null) => void;
  sel: Selected | null;
  setSel: (s: Selected | null) => void;
  pointing: boolean;
  point: (then: (f: Focus) => void) => void;
  unpoint: () => void;
  // set by the conversation on screen: sends a message from the box, keeping the log at its end
  submit: React.MutableRefObject<((text: string) => void) | null>;
  // why it cannot be reached now (Paseo is not running, say), as the conversation on screen finds it; empty when it can
  down: string;
  setDown: (why: string) => void;
  // start it again another way (in a terminal, when Paseo cannot be reached)
  start: (o: StartOpts) => void;
  busy: boolean;
}

export function Assistant({ toast, onClose, target, setTarget, focusKey, onIdea }: {
  toast: (t: string, error?: boolean) => void; onClose: () => void; target: Target; setTarget: (t: Target) => void; focusKey: number;
  onIdea: (text: string) => Promise<boolean>;
}) {
  const [view, setView] = useState<AssistantView | null>(null);
  const [err, setErr] = useState('');
  const [bump, setBump] = useState(0);
  const [focus, setFocusState] = useState<Focus | null>(null);
  const [sel, setSelState] = useState<Selected | null>(null);
  const [pointing, setPointing] = useState<((f: Focus) => void) | null>(null);
  const [history, setHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [down, setDown] = useState('');
  const submit = useRef<((text: string) => void) | null>(null);
  const focusRef = useRef<Focus | null>(null), selRef = useRef<Selected | null>(null);
  const last = useRef<{ focus: Focus | null; sel: Selected | null }>({ focus: null, sel: null });
  const setFocus = (f: Focus | null) => { focusRef.current = f; setFocusState(f); };
  const setSel = (s: Selected | null) => { selRef.current = s; setSelState(s); };
  const place = usePlace();
  const reload = () => setBump(b => b + 1);

  useEffect(() => {
    api.assistant().then(v => { setView(v); setErr(''); }, e => setErr((e as Error).message));
  }, [bump]);
  useEffect(() => listen(e => {
    if (e.type === 'agent' && e.agent?.id === ID) setView(v => (v ? { ...v, agent: e.agent } : v));
    else if (e.type === 'agent_event' && e.event.agent_id === ID && ['ask', 'act'].includes(e.event.kind)) setBump(b => b + 1);
  }), []);

  useEffect(() => {
    setFocus(null);
    setSel(null);
    last.current = { focus: null, sel: null };
  }, [place.line?.id, place.mod]);
  useEffect(() => onSelect(setSel), []); // eslint-disable-line react-hooks/exhaustive-deps

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
      if (view?.agent.runtime === 'pi' && text.startsWith('/')) await api.say(ID, text);
      else {
        const f = focusRef.current, s = selRef.current;
        last.current = { focus: f, sel: s };
        setFocus(null);
        setSel(null);
        await api.assistantSay(text, snapshot(f, s));
      }
      return true;
    } catch (e) {
      toast((e as Error).message, true);
      return false;
    }
  }
  async function start(o: StartOpts) {
    setBusy(true);
    try { await api.startAgent(ID, o); reload(); } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  }
  async function resume(c: AssistantConv) {
    setHistory(false);
    try { await api.resumeConv(ID, c.id); reload(); } catch (e) { toast((e as Error).message, true); }
  }
  function fresh() {
    setHistory(false);
    api.newConv(ID).then(reload, e => toast((e as Error).message, true));
  }
  const point = (then: (f: Focus) => void) => setPointing(() => (f: Focus) => { setPointing(null); then(f); });

  const head = (a?: Agent) => (
    <header className="as-head">
      <span className={`dot s-${a?.started ? a.status : 'stopped'}`} />
      <div className="as-who">
        <b>{tr('小助手')}</b>
        {a?.started && <span>{AGENT_STATUS[a.status] ?? a.status}{a.model ? ` · ${a.model}` : ''}</span>}
      </div>
      <button className={`ib as-hist${history ? ' on' : ''}`} title={tr('历史对话')} aria-expanded={history} onClick={() => setHistory(h => !h)}><Icon n="clock" size={16} /></button>
      {a?.started && <button className="ib" title={tr('新对话：可切换模型重新开始')} onClick={fresh}><Icon n="compose" size={16} /></button>}
      {a?.started && a.runtime === 'paseo' && (
        <button className="ib" title={tr('在 Paseo 桌面端打开这段对话')} onClick={() => api.openInPaseo(ID).catch(e => toast((e as Error).message, true))}><Icon n="ext" size={16} /></button>
      )}
      <button className="ib" title={tr('收起（Esc）')} onClick={onClose}><Icon n="down" size={16} /></button>
    </header>
  );

  const a = view?.agent;
  const side: Side | null = view && {
    view, head, send, toast, focus, setFocus, sel, setSel, submit,
    pointing: !!pointing, point, unpoint: () => setPointing(null), down, setDown, start, busy,
  };
  return (
    <div className="asst">
      {!side || !a ? (
        <>{head()}<p className={`as-wait${err ? ' warn-box small' : ''}`}>{err || tr('加载中…')}</p></>
      ) : !a.started ? (
        <>
          {head(a)}
          <div className="as-start">
            <p className="as-lead">{tr('本地 agent，与员工一样运行于 Paseo 或 pi。小助手可感知你当前页面及指向内容，并读取页面数据来源作答。由其执行的操作，须先在此经你确认。')}</p>
            <Earlier limit={3} title={tr('继续此前对话')} onPick={resume} />
            <div className="hire-card">
              <h3>Paseo</h3>
              <PaseoPick busy={busy} onStart={start} role="assistant" />
            </div>
            <div className="hire-card"><h3>{tr('终端')}</h3><TerminalPick busy={busy} onStart={start} role="assistant" agentId="assistant" /></div>
            <div className="hire-card">
              <h3>{tr('pi · 后台终端')}</h3>
              <button className="btn" disabled={busy} onClick={() => start({ runtime: 'pi' })}>{busy ? tr('启动中…') : tr('启动 pi')}</button>
            </div>
          </div>
        </>
      ) : a.term ? <HostedRoom agent={a} toast={toast} /> : a.runtime === 'paseo'
        ? <PaseoSide key={a.ext_id ?? 'paseo'} agent={a} side={side} />
        : <PiSide key="pi" agent={a} side={side} />}
      {side && a && (!a.term || target.kind === 'idea') && <Composer agent={a} side={side} target={target} setTarget={setTarget} focusKey={focusKey} onIdea={onIdea} />}
      {history && <History onPick={resume} onClose={() => setHistory(false)} />}
      {pointing && <Pointer onPick={pointing} onCancel={() => setPointing(null)} />}
    </div>
  );
}

function PaseoSide({ agent, side }: { agent: Agent; side: Side }) {
  const t = usePaseoTalk(agent, s => parse(s).text);
  const rows = useMemo(() => paseoRows(t.items, t.sent), [t.items, t.sent]);
  // the conversation cannot be read, or Paseo is known to be down: it shows as unreachable until a read gets through
  const why = t.err || t.agent.down || '', { setDown } = side;
  useEffect(() => { setDown(why); return () => setDown(''); }, [why, setDown]);
  return (
    <Talk side={side} agent={why ? { ...t.agent, status: 'offline' } : t.agent} rows={rows} loading={t.items === null && !why} err={why} perms={t.asks} onSent={t.wrote}
      onPermit={(id, allow) => { api.permit(ID, id, allow).then(() => t.answered(id)).catch(e => side.toast((e as Error).message, true)); }} />
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
  useEffect(() => {
    side.submit.current = submit;
    return () => { side.submit.current = null; };
  });
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
        <div className="as-sub"><PiSwitch s={agent.state} send={t => api.say(ID, t).catch(e => side.toast((e as Error).message, true))} /></div>
      )}
      <div className="as-mid">
        <div className="as-log" ref={scroll} onScroll={e => {
          const el = e.currentTarget, near = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          stick.current = near;
          setStuck(near);
        }}>
          {err && (
            <div className="as-off" role="status">
              <b>{tr('无法连接 Paseo，小助手当前无法收消息')}</b>
              <p>{err}</p>
              <p className="muted">{tr('可以在下方改用终端启动小助手。撰写新 idea 正常可用。')}</p>
            </div>
          )}
          {err && <div className="hire-card"><h3>{tr('改用终端启动')}</h3><TerminalPick busy={side.busy} onStart={side.start} role="assistant" agentId="assistant" /></div>}
          {loading && <p className="as-wait">{tr('加载中…')}</p>}
          {rows.map((r, i) => r.k === 'you' ? <YouMsg key={r.key} r={r} />
            : r.k === 'it' ? <ReplyMsg key={r.key} r={r} last={i === replied}
              again={i === replied && i > asked && asked >= 0 && !working ? () => submit(question) : undefined} />
              : r.k === 'tools' ? <Trail key={r.key} tools={r.tools}>{r.detail && <div className="trail-list">{r.detail.map(t => <Tool key={t.ev.id} {...t} />)}</div>}</Trail>
                : r.k === 'ev' ? <div key={r.key} className="as-ev"><Icon n="bell" size={13} /><div><Text text={r.text} link={LINK} /></div></div>
                  : <div key={r.key} className={`note${r.err ? ' err' : ''}`}>{r.text}</div>)}
          {!loading && !err && asked < 0 && <Hello mod={place.mod} onAsk={submit} />}
          {perms.map(q => (
            <div key={q.id} className="as-card as-perm">
              <span className="as-k em-bar" data-tone="warn">{tr('请求')}{q.name === 'Bash' ? tr('运行命令') : tr('使用 {0}', q.name)}</span>
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
          <button className="as-down" title={tr('返回最新')} onClick={() => scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' })}>
            <Icon n="down" size={16} />
          </button>
        )}
      </div>
    </>
  );
}

function YouMsg({ r }: { r: YouRow }) {
  const { where, pointed, selected, selectedAt, projects } = r.ctx;
  return (
    <div className="as-you">
      {(where || pointed || selected || projects?.length) && (
        <div className="as-said">
          {where && <span title={trx(where)}><Icon n="eye" size={11} /><i>{trx(where)}</i></span>}
          {pointed && <span className="on" title={trx(pointed)}><Icon n="target" size={11} /><i>{trx(pointed)}</i></span>}
          {selected && <span className="on" title={selected}><Icon n="quote" size={11} /><i>{selected}{selectedAt && <em> · {trx(selectedAt)}</em>}</i></span>}
          {!!projects?.length && <span title={tr('Papertown 已将刚读取的项目进展附在消息中')}><Icon n="compass" size={11} /><i>{tr('已附上 {0} 的进展', projects.map(n => `#${n}`).join(' '))}</i></span>}
        </div>
      )}
      <UserMsg text={r.text} origin="web" />
      {r.sending && <span className="as-meta">{tr('发送中')}</span>}
    </div>
  );
}

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
          {again && <button className="as-op" title={tr('重新提问上一问题')} onClick={again}><Icon n="refresh" size={13} />{tr('重新提问')}</button>}
        </div>
      )}
    </div>
  );
}

// before your first question: what it is for, and starter questions for this panel
function Hello({ mod, onAsk }: { mod: string; onAsk: (text: string) => void }) {
  return (
    <div className="as-hello">
      <p>{tr('可就本页内容提问或由小助手代办。小助手可识别当前页面，若需更精准作答，可点选页面位置或先选中文字。')}</p>
      <div className="as-asks">{(ASK[mod] ?? ASK_ANY).map(q => <button key={q} onClick={() => onAsk(q)}><Icon n="chat" size={14} />{q}</button>)}</div>
    </div>
  );
}

function Busy({ tail }: { tail?: Row }) {
  const tool = tail?.k === 'tools' ? [...tail.tools].reverse().find(t => t.st === 'run') : undefined;
  return <div className="as-busy"><span className="thinking"><i /><i /><i /></span>{tool ? tr('正在使用 {0}', tool.name) : tr('思考中…')}</div>;
}

// the message box: to the assistant, with the page, what you point at and the selected text going along; or a
// new idea for a resident lead.
function Composer({ agent, side, target, setTarget, focusKey, onIdea }: {
  agent: Agent; side: Side; target: Target; setTarget: (t: Target) => void; focusKey: number;
  onIdea: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const place = usePlace();
  const { focus, sel } = side;
  const asking = target.kind === 'assistant', started = !!agent.started;
  const off = asking && started && !!side.down; // it cannot be reached: nothing to send it
  const working = asking && started && !off && agent.status === 'working', typed = !!text.trim();
  const hints = !asking || typed || off ? null : sel ? ASK_SEL : focus ? ASK_AT : null;
  const lines = sel ? sel.text.split('\n').length : 0;
  const pointable = !!document.querySelector(SCOPE);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);
  useEffect(() => { if (focusKey) box.current?.focus(); }, [focusKey]);
  // A new question can bring a draft from the building.
  useEffect(() => {
    if (target.kind === 'assistant' && target.draft) setText(target.draft);
    box.current?.focus();
  }, [target]);

  async function go(t: string) {
    const s = t.trim();
    if (!s || sending) return;
    if (asking) {
      if (!side.submit.current || off) return;
      setText('');
      side.submit.current(s);
      return;
    }
    setSending(true);
    const ok = await onIdea(s);
    setSending(false);
    if (!ok) return;
    setText('');
  }
  const placeholder = target.kind === 'idea' ? tr('输入新 idea，项目负责人将开始调研…')
      : !started ? tr('请先在上方启动小助手，当前即可输入新 idea')
        : off ? tr('无法连接 Paseo，待启动后再提问（输入新 idea 正常可用）')
        : !working ? tr('就本页提问，或委托小助手代办') : agent.runtime === 'pi' ? tr('小助手忙碌中，新消息将排在当前任务之后') : tr('小助手忙碌中，新消息将插入当前任务');
  return (
    <div className="as-foot">
      {hints && <div className="as-hint">{hints.map(q => <button key={q} onClick={() => go(q)}>{q}</button>)}</div>}
      <div className="as-box" onMouseDown={e => { if (e.target === e.currentTarget) { e.preventDefault(); box.current?.focus(); } }}>
        {asking && (
          <div className="as-ctx">
            <span className="as-pill" title={tr('每条消息均附带当前浏览页面')}><Icon n="eye" size={12} /><b>{place.line ? `#${place.line.seq} · ` : ''}{place.name || tr('中控屏')}</b></span>
            {focus && (
              <span className="as-pill on" title={focus.text}><Icon n="target" size={12} /><b>{focus.label}</b>{focus.where && <em>{focus.where}</em>}
                <button onClick={() => side.setFocus(null)} aria-label={tr('取消指向')}><Icon n="close" size={10} /></button></span>
            )}
            {sel && (
              <span className="as-pill on" title={sel.at ? `${sel.text}\n· ${sel.at.label}` : sel.text}><Icon n="quote" size={12} /><b>{sel.text.replace(/\s+/g, ' ')}</b>{lines > 1 && <em>{tr('{0} 行文字', lines)}</em>}
                <button onClick={() => side.setSel(null)} aria-label={tr('移除此段')}><Icon n="close" size={10} /></button></span>
            )}
          </div>
        )}
        <textarea ref={box} rows={1} value={text} placeholder={placeholder}
          onChange={e => setText(e.target.value)}
          onKeyDown={enterSends(() => go(text))} />
        <div className="as-tools">
            <div className="seg mini as-to" role="radiogroup" aria-label={tr('发送至')}>
              <button role="radio" aria-checked={asking} className={asking ? 'on' : ''} onClick={() => setTarget({ kind: 'assistant' })}>{tr('小助手')}</button>
              <button role="radio" aria-checked={!asking} className={!asking ? 'on' : ''} onClick={() => setTarget({ kind: 'idea' })}
                title={tr('创建项目后，负责人自动启动并开展调研')}>{tr('新 idea')}</button>
            </div>
          {asking && pointable && (
            <button className={`as-tool${side.pointing ? ' on' : ''}`} title={tr('点击页面上需提问的位置')}
              onClick={() => (side.pointing ? side.unpoint() : side.point(side.setFocus))}>
              <Icon n="target" size={15} />{side.pointing ? tr('点击页面某处…') : tr('指向页面')}
            </button>
          )}
          {working && !typed
            ? <button className="as-send stop" title={tr('中断当前任务')} onClick={() => api.abort(ID).catch(e => side.toast((e as Error).message, true))}><Icon n="stop" size={14} /></button>
            : <button className="as-send" disabled={!typed || sending || (asking && (!started || off))} title={tr('发送（Enter）')} onClick={() => go(text)}><Icon n="send" size={16} /></button>}
        </div>
      </div>
    </div>
  );
}

// its question for you and what it asks to do, each answered here
function Cards({ view, send, toast, onPoint }: {
  view: AssistantView; send: (t: string) => void; toast: (t: string, error?: boolean) => void; onPoint: (then: () => void) => void;
}) {
  const [done, setDone] = useState<Record<number, AgentEvent>>({});
  const shown = useRef(new Set<Element>());
  const seen = (el: HTMLDivElement | null) => {
    if (el && !shown.current.has(el)) { shown.current.add(el); requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })); }
  };
  const ask = view.asks[0];
  const now = useNow(5000);
  const fresh = (e: AgentEvent) => e.data.auto && now - Date.parse(e.data.decided_at ?? e.ts) < 15000;
  const acts = view.acts.filter(e => e.data.status === 'pending' || done[e.id] || fresh(e));
  async function decide(e: AgentEvent, allow: boolean) {
    try {
      const r = await api.decide(e.id, allow);
      setDone(d => ({ ...d, [e.id]: r }));
      setTimeout(() => setDone(d => { const { [e.id]: _, ...rest } = d; return rest; }), 8000);
    } catch (x) { toast((x as Error).message, true); }
  }
  if (!ask && !acts.length) return null;
  return (
    <>
      {ask && (
        <div className="as-card as-ask" ref={seen}>
          <span className="as-k">{tr('它问你')}</span>
          <p className="em-bar" data-tone="warn">{modelText(ask.data.question)}</p>
          {(ask.data.choices?.length > 0 || ask.data.point) && <div className="as-choices">
            {(ask.data.choices as string[]).map(c => <button key={c} className="btn" onClick={() => send(c)}>{c}</button>)}
            {ask.data.point && <button className="btn pri" onClick={() => onPoint(() => send(tr('此处。')))}><Icon n="target" size={14} />{tr('点击页面位置')}</button>}
          </div>}
        </div>
      )}
      {acts.map(e => {
        const d = (done[e.id] ?? e).data;
        return (
          <div key={e.id} className={`as-card as-act st-${d.status}`} ref={seen}>
            <span className={d.status === 'failed' ? 'as-k em-state' : 'as-k'} data-tone="bad">{d.status === 'pending' ? tr('请求代为执行') : d.status === 'done' ? (d.auto ? tr('已代为执行') : tr('已经做了')) : d.status === 'denied' ? tr('你未同意执行') : tr('失败')}</span>
            <p className={d.status === 'pending' ? 'em-bar' : undefined} data-tone="warn"><b>{d.title}</b></p>
            {d.why && d.status === 'pending' && <p className="muted small">{modelText(d.why)}</p>}
            {d.rule && d.status === 'pending' && <p className="muted small">{tr('按工作边界需先向你确认：{0}', d.rule)}</p>}
            {d.result && <p className="small">{modelText(d.result)}</p>}
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

// picking a part of the page: the part under the mouse is outlined and named, a click takes it
function Pointer({ onPick, onCancel }: { onPick: (f: Focus) => void; onCancel: () => void }) {
  const [box, setBox] = useState<{ r: DOMRect; label: string } | null>(null);
  useEffect(() => {
    const scopes = [...document.querySelectorAll(SCOPE)];
    const ok = (t: EventTarget | null): t is Element => t instanceof Element && scopes.some(s => s.contains(t)) && !t.closest('.asst, .dock');
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
      <div className="pt-hint">{tr('点击页面中需提问的位置')} · <kbd>Esc</kbd> {tr('取消')}</div>
    </div>,
    document.querySelector('.theme-sketch') ?? document.body,
  );
}
