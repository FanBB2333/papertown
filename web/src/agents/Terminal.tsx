import { Button } from '@cloudflare/kumo';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, listen, type Agent, type AgentEvent, type PaseoItem, type TermPrompt, type Terminal, type Transcript } from '../api';
import { fold, PaseoLog } from '../components/AgentRoom';
import { ago } from '../console/util';
import { tr } from '../i18n';
import { Compose, type ComposeAdapter } from './Compose';
import { useReadReceipt } from './live';
import { PromptDialog, promptDismissed } from './Prompt';
import { bucketOf, isWorking, kindName, WatchStatus, type Watched } from './watch';

const KEYS = [['enter', 'Enter'], ['esc', 'Esc'], ['up', '↑'], ['down', '↓'], ['1', '1'], ['2', '2'], ['3', '3'], ['y', 'y'], ['n', 'n']];
const UNSURE = tr('发送结果未确认，请查看终端后决定是否再次发送。');
const STEER = tr('消息将直接发送至终端，处理方式由终端内的 agent 决定。');

type Subject = Watched & { id: string };
interface Reading<T> { subject: T; queued: AgentEvent[]; text?: string; prompt?: TermPrompt | null; items?: PaseoItem[]; transcript?: Transcript }
// What a conversation in a terminal needs from where it runs. Employees in herdr or tmux and herdr sessions that
// are not employees both plug in here, and a further backend only has to supply these.
interface Source<T extends Subject> {
  first: T; name: (x: T) => string; about: (x: T) => string;
  blocked: (x: T) => boolean; exited: (x: T) => boolean;
  read: (want: { chat: boolean; screen: boolean }) => Promise<Reading<T>>;
  mine: (e: any) => boolean; // a bus event about this conversation
  compose: ComposeAdapter; keys: (keys: string[]) => Promise<unknown>; answer: (digest: string, option: number) => Promise<unknown>;
  restart?: () => Promise<unknown>;
}

const tail = (text: string, lines = 18) => text.split('\n').filter(l => l.trim()).slice(-lines).join('\n');

function TermChat<T extends Subject>({ source, toast, tools }: { source: Source<T>; toast: (s: string) => void; tools?: React.ReactNode }) {
  const [subject, setSubject] = useState(source.first), [queued, setQueued] = useState<AgentEvent[]>([]);
  const [text, setText] = useState<string | null>(null), [prompt, setPrompt] = useState<TermPrompt | null>(null);
  const [items, setItems] = useState<PaseoItem[] | null>(null), [transcript, setTranscript] = useState<Transcript | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [draft, setDraft] = useState('');
  const [tab, setTab] = useState<'chat' | 'screen'>('chat'), [asking, setAsking] = useState(false);
  const [sent, setSent] = useState<{ text: string; had: number; at: number }[]>([]);
  // the tab follows what can be shown until the user picks one
  const picked = useRef(false), view = useRef(tab); view.current = tab;
  const latest = useRef({ source, subject, items: items ?? [] }); latest.current = { source, subject, items: items ?? [] };
  const reload = useRef<() => void>(() => {}), pane = useRef<HTMLElement | null>(null), stick = useRef(true);
  const id = source.first.id, blocked = source.blocked(subject), exited = source.exited(subject), working = isWorking(subject);
  const receipt = useReadReceipt(id, text === null && items === null ? null : `${text}\n${items?.length}\n${bucketOf(subject)}\n${subject.watch?.since}`);
  const times = (list: PaseoItem[], t: string) => list.filter(i => i.kind === 'user' && (i.text ?? '').trim() === t).length;

  useEffect(() => {
    let alive = true, reading = false, dirty = false, timer = 0, once = true;
    const load = async () => {
      if (reading) { dirty = true; return; }
      clearTimeout(timer); reading = true;
      const { source: s, subject: x } = latest.current;
      try {
        const r = await s.read({ chat: once || view.current === 'chat', screen: once || view.current === 'screen' || s.blocked(x) });
        if (!alive) return;
        once = false;
        latest.current.subject = r.subject; setSubject(r.subject); setQueued(r.queued); setError('');
        if (r.text !== undefined) { setText(r.text); setPrompt(r.prompt ?? null); }
        if (r.transcript) {
          setTranscript(r.transcript); setItems(r.items ?? []);
          const list = r.items ?? [], ok = r.transcript.ok;
          setSent(xs => xs.filter(m => ok && times(list, m.text) <= m.had && Date.now() - m.at < 60000));
          if (!picked.current) setTab(ok ? 'chat' : 'screen');
        }
      } catch (e) { if (alive) setError((e as Error).message); }
      finally {
        reading = false;
        if (alive) {
          const x = latest.current.subject, quick = isWorking(x) || latest.current.source.blocked(x) || x.status === 'starting';
          timer = window.setTimeout(load, dirty ? 0 : quick ? 2000 : 8000);
          dirty = false;
        }
      }
    };
    reload.current = () => { void load(); };
    void load();
    const off = listen(e => { if (latest.current.source.mine(e)) void load(); });
    return () => { alive = false; off(); clearTimeout(timer); reload.current = () => {}; };
  }, [id]);
  useEffect(() => { reload.current(); }, [tab]);
  useLayoutEffect(() => { const el = pane.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [text, items?.length, sent.length, tab]);

  // a prompt opens once on its own, and again only when it changes
  const promptKey = `${id}:${prompt?.digest ?? 'screen'}`;
  useEffect(() => { setAsking(blocked && text !== null && !promptDismissed(promptKey)); }, [blocked, promptKey, text === null]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    try { await fn(); reload.current(); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  }
  const rows = useMemo(() => fold(items ?? [], i => i.kind === 'tool'), [items]);
  const choose = (next: 'chat' | 'screen') => { picked.current = true; stick.current = true; setTab(next); };
  const scrolled = (e: React.UIEvent<HTMLElement>) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; };

  return <section className="room-main chat-main term-main" ref={receipt as React.RefObject<HTMLElement>}>
    <header className="chat-head">
      <div className="chat-who">
        <WatchStatus agent={subject} />
        <div><b>{source.name(subject)}</b><span className="muted small">{source.about(subject)}</span></div>
      </div>
      <div className="btns">
        <div className="seg mini" role="tablist" aria-label={tr('显示内容')}>
          <button role="tab" aria-selected={tab === 'chat'} className={tab === 'chat' ? 'on' : ''} onClick={() => choose('chat')}>{tr('对话')}</button>
          <button role="tab" aria-selected={tab === 'screen'} className={tab === 'screen' ? 'on' : ''} onClick={() => choose('screen')}>{tr('终端')}</button>
        </div>
        {tools}
      </div>
    </header>
    {error && <div className="aw-notice" role="alert"><p>{error}</p><button className="btn" onClick={() => reload.current()}>{tr('重试')}</button></div>}
    {tab === 'chat' ? <div className="transcript" key="chat" ref={el => { pane.current = el; }} onScroll={scrolled}>
      {transcript && !transcript.ok && <div className="room-empty small-empty term-none">
        <p>{transcript.note ? tr(transcript.note) : tr('尚未找到这段会话的记录。')}</p>
        <button className="btn" onClick={() => choose('screen')}>{tr('查看终端画面')}</button>
      </div>}
      {transcript?.ok && !rows.length && !sent.length && <div className="room-empty small-empty"><p>{tr('暂无对话。')}</p></div>}
      {!transcript && !error && <div className="room-empty small-empty"><p>{tr('加载中…')}</p></div>}
      <PaseoLog rows={rows} sent={sent.map(m => m.text)} asks={[]} working={working && !blocked} onPermit={() => {}} />
    </div> : <pre className="terminal-screen" key="screen" ref={el => { pane.current = el; }} tabIndex={0} aria-label={tr('终端内容')} onScroll={scrolled}>
      {text === null ? tr('加载中…') : text.replace(/\n(?:[ \t]*\n){2,}/g, '\n\n') || tr('终端暂未输出内容。')}
    </pre>}
    {exited ? <div className="term-wait term-off" role="status">
      <div><b>{tr('终端已关闭')}</b><p>{tr('再次启动时将续接上次会话。')}</p></div>
      {source.restart && <button className="btn pri" disabled={busy} onClick={() => act(source.restart!)}>{tr('接着会话启动')}</button>}
    </div> : blocked ? <div className="term-wait" role="status">
      <i className="aw-dot" aria-hidden="true" />
      <div><b>{tr('终端中有提示待你处理')}</b><p>{prompt?.title || tr('请查看终端画面，选择回答或按键。')}</p></div>
      <button className="btn pri" onClick={() => setAsking(true)}>{tr('处理')}</button>
    </div> : <Compose agent={{ ...subject, down: error || subject.down || null }} queued={queued} adapter={source.compose} toast={toast} value={draft} onChange={setDraft}
      onChanged={() => reload.current()} onSent={(event, said) => {
        stick.current = true;
        if (event.data?.delivered !== false && transcript?.ok) setSent(xs => [...xs, { text: said, had: times(latest.current.items, said) + xs.filter(m => m.text === said).length, at: Date.now() }]);
      }} />}
    {asking && blocked && <PromptDialog id={promptKey} who={`${source.name(subject)} · ${source.about(subject)}`} onClose={() => setAsking(false)}
      title={prompt?.title || tr('终端有提示待你处理')} body={prompt?.body.filter(l => l !== prompt.title)} hint={prompt?.hint}
      code={prompt ? undefined : tail(text ?? '')}
      choices={(prompt?.options ?? []).map(o => ({ label: o.label, tone: o.current ? 'primary' as const : undefined,
        pick: async () => { await source.answer(prompt!.digest, o.index); reload.current(); } }))}>
      <details className="aw-prompt-more" open={!prompt}>
        <summary>{tr('直接按键')}</summary>
        <p>{tr('按键将原样发送至终端，可用于提示中未列出的操作。')}</p>
        {/* the dialog is in the Kumo layer, where the page's own buttons have no styles */}
        <div className="aw-prompt-keys" role="group" aria-label={tr('终端按键')}>
          {KEYS.map(([key, name]) => <Button key={key} size="sm" variant="secondary" disabled={busy || !!error} onClick={() => act(() => source.keys([key]))}>{tr(name)}</Button>)}
        </div>
      </details>
      <button type="button" className="aw-prompt-link" onClick={() => { choose('screen'); setAsking(false); }}>{tr('查看终端画面')}</button>
    </PromptDialog>}
  </section>;
}

const held = (e: AgentEvent) => e.data.sending ? { ...e, data: { ...e.data, error: UNSURE } } : e;

// a herdr session that is not an employee
export function TerminalRoom({ terminal, toast, tools }: { terminal: Terminal; toast: (s: string) => void; tools?: React.ReactNode }) {
  const id = terminal.id;
  const source = useMemo<Source<Terminal>>(() => ({
    first: terminal,
    name: t => t.name || kindName(t.kind) || tr('终端'),
    about: t => [kindName(t.kind), 'herdr', t.title, ago(t.watch.since)].filter(Boolean).join(' · '),
    blocked: t => t.watch.bucket === 'needs', exited: () => false,
    read: async ({ chat }) => {
      const [d, t] = await Promise.all([api.terminal(id), chat ? api.terminalTimeline(id).catch(() => null) : null]);
      const queued: AgentEvent[] = d.queued.map(q => ({ id: q.id, agent_id: id, ts: q.created_at, kind: 'user',
        data: { text: q.text, error: ['failed', 'sending'].includes(q.state) ? UNSURE : undefined } }));
      return { subject: d.terminal, queued, text: d.text, prompt: d.prompt ?? null,
        ...(chat ? { items: t?.items ?? [], transcript: t?.transcript ?? { ok: false, note: '这个终端会话没有可读取的对话记录。' } } : {}) };
    },
    mine: e => e.type === 'terminal' && e.id === id,
    compose: {
      send: async (text, mode) => { await api.terminalSay(id, text, mode); },
      queue: async (queueId, what) => { await api.terminalQueue(id, queueId, what); },
      stop: async () => { await api.terminalKeys(id, ['esc']); }, steerHint: STEER,
    },
    keys: keys => api.terminalKeys(id, keys), answer: (digest, option) => api.terminalPrompt(id, digest, option),
  }), [id]); // eslint-disable-line react-hooks/exhaustive-deps
  return <TermChat key={id} source={source} toast={toast} tools={tools} />;
}

// an employee that runs a CLI in a herdr tab, a tmux window or a background terminal
export function HostedRoom({ agent, toast, tools }: { agent: Agent; toast: (s: string) => void; tools?: React.ReactNode }) {
  const id = agent.id;
  const source = useMemo<Source<Agent>>(() => ({
    first: agent,
    name: a => a.name,
    about: a => [kindName(a.term?.provider), a.runtime, a.term?.model].filter(Boolean).join(' · '),
    blocked: a => a.watch?.why === 'terminal', exited: a => a.term?.status === 'exited',
    read: async ({ screen }) => {
      const [t, s] = await Promise.all([api.timeline(id), screen ? api.agentScreen(id) : null]);
      return { subject: t.agent, queued: t.queued.map(held), items: t.items, transcript: t.transcript ?? { ok: true, note: null },
        ...(s ? { text: s.text, prompt: s.prompt ?? null } : {}) };
    },
    mine: e => (e.type === 'agent' && e.agent?.id === id) || (e.type === 'agent_event' && e.event?.agent_id === id),
    compose: {
      send: (text, mode) => api.say(id, text, mode),
      queue: async (eventId, what) => { await api.queueAct(id, eventId, what); },
      stop: async () => { await api.stopAgent(id); }, steerHint: STEER,
    },
    keys: keys => api.agentKeys(id, keys), answer: (digest, option) => api.answerPrompt(id, digest, option),
    restart: () => api.startAgent(id),
  }), [id]); // eslint-disable-line react-hooks/exhaustive-deps
  return <TermChat key={id} source={source} toast={toast} tools={tools} />;
}

export function TerminalContext({ terminal: t }: { terminal: Terminal }) {
  return <dl className="aw-facts">
    <dt>{tr('Agent 种类')}</dt><dd>{kindName(t.kind) || tr('未指定')}</dd>
    <dt>{tr('herdr 工作区')}</dt><dd>{t.workspace_id || tr('未指定')}</dd>
    <dt>{tr('标签页')}</dt><dd>{t.tab_id || tr('未指定')}</dd>
    <dt>{tr('窗格')}</dt><dd>{t.pane_id}</dd>
    <dt>{tr('工作目录')}</dt><dd className="aw-path">{t.cwd || tr('未指定')}</dd>
  </dl>;
}

export function HostedContext({ agent, toast }: { agent: Agent; toast: (s: string) => void }) {
  const [busy, setBusy] = useState(false);
  return <>
    <dl className="aw-facts">
      <dt>{tr('终端后端')}</dt><dd>{agent.runtime}</dd>
      <dt>{tr('CLI')}</dt><dd>{kindName(agent.term?.provider)}</dd>
      <dt>{tr('模型')}</dt><dd>{agent.term?.model || tr('CLI 默认模型')}</dd>
      <dt>{tr('思考强度')}</dt><dd>{agent.term?.thinking || tr('未指定')}</dd>
      <dt>{tr('会话 ID')}</dt><dd className="aw-path">{agent.session_id || tr('未指定')}</dd>
      <dt>{tr('接入方式')}</dt><dd className="aw-path">{agent.attach || (agent.runtime === 'headless' ? tr('Papertown 后台终端，在此页面查看与操作') : tr('未指定'))}</dd>
    </dl>
    <button className="btn" disabled={busy || agent.term?.status === 'exited'} onClick={async () => {
      setBusy(true); try { await api.closeTerminal(agent.id); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
    }}>{tr('关闭终端')}</button>
  </>;
}
