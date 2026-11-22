import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, listen, type Agent, type AgentEvent, type Terminal, type TerminalDetail } from '../api';
import { ago } from '../console/util';
import { tr } from '../i18n';
import { Compose, type ComposeAdapter } from './Compose';
import { useReadReceipt } from './live';
import { kindName, WatchStatus } from './watch';

const KEYS = [['enter', 'Enter'], ['esc', 'Esc'], ['up', '↑'], ['down', '↓'], ['1', '1'], ['2', '2'], ['3', '3'], ['y', 'y'], ['n', 'n']];


function TerminalKeys({ disabled, press }: { disabled: boolean; press: (key: string) => void }) {
  return <div className="terminal-keys">
    <p>{tr('请根据终端画面选择按键，处理当前对话框。')}</p>
    <div className="btns" role="group" aria-label={tr('终端按键')}>{KEYS.map(([key, name]) => <button className="btn" key={key} disabled={disabled} onClick={() => press(key)}>{tr(name)}</button>)}</div>
  </div>;
}

export function TerminalRoom({ terminal, toast }: { terminal: Terminal; toast: (s: string) => void }) {
  const [data, setData] = useState<TerminalDetail | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const current = data?.terminal ?? terminal;
  const latest = useRef(current); latest.current = current;
  const reload = useRef<() => void>(() => {}), bottom = useRef(true), screen = useRef<HTMLPreElement>(null);
  const receipt = useReadReceipt(terminal.id, data ? `${data.text}\n${data.terminal.watch.bucket}\n${data.terminal.watch.since}` : null);
  useEffect(() => {
    let alive = true, reading = false, dirty = false, timer = 0;
    const load = async () => {
      if (reading) { dirty = true; return; }
      clearTimeout(timer); reading = true;
      try {
        const result = await api.terminal(terminal.id);
        if (alive) { latest.current = result.terminal; setData(result); setError(''); }
      } catch (e) { if (alive) setError((e as Error).message); }
      finally {
        reading = false;
        if (alive) {
          timer = window.setTimeout(load, dirty ? 0 : latest.current.watch.bucket === 'working' ? 2000 : 10000);
          dirty = false;
        }
      }
    };
    reload.current = () => { void load(); };
    void load();
    const off = listen(e => { if (e.type === 'terminal' && e.id === terminal.id) void load(); });
    return () => { alive = false; off(); clearTimeout(timer); reload.current = () => {}; };
  }, [terminal.id]);
  useLayoutEffect(() => {
    const el = screen.current;
    if (el && bottom.current) el.scrollTop = el.scrollHeight;
  }, [data?.text]);
  const adapter: ComposeAdapter = {
    send: async (text, mode) => { await api.terminalSay(terminal.id, text, mode); },
    queue: async (id, what) => { await api.terminalQueue(terminal.id, id, what); },
    stop: async () => { await api.terminalKeys(terminal.id, ['esc']); },
    steerHint: tr('消息将直接发送到终端，处理方式由终端里的 agent 决定。'),
  };
  const queued: AgentEvent[] = (data?.queued ?? []).map(q => ({ id: q.id, agent_id: terminal.id, ts: q.created_at, kind: 'user',
    data: { text: q.text, error: ['failed', 'sending'].includes(q.state) ? tr('发送结果未确认，请查看终端后决定是否再次发送。') : undefined } }));
  async function press(key: string) {
    if (busy) return;
    setBusy(true);
    try { await api.terminalKeys(terminal.id, [key]); reload.current(); }
    catch (e) { toast((e as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="terminal-room" ref={receipt}>
    <header className="terminal-head">
      <div><WatchStatus agent={current} /><b>{current.name || kindName(current.kind) || tr('终端')}</b><span className="muted small">{ago(current.watch.since)}</span></div>
      {current.title && <p>{current.title}</p>}
    </header>
    {error && <div className="aw-notice" role="alert"><p>{error}</p><button className="btn" onClick={() => reload.current()}>{tr('重试')}</button></div>}
    <pre className="terminal-screen" ref={screen} tabIndex={0} aria-label={tr('终端内容')} onScroll={e => {
      const el = e.currentTarget; bottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    }}>{data ? data.text.replace(/\n(?:[ \t]*\n){2,}/g, '\n\n') || tr('终端暂未输出内容。') : tr('加载中…')}</pre>
    {current.watch.bucket === 'needs' ? <TerminalKeys disabled={busy || !!error} press={press} /> : <Compose agent={{ ...current, down: error || null }} queued={queued} adapter={adapter} toast={toast} value={draft} onChange={setDraft} onChanged={() => reload.current()} />}
  </div>;
}

export function TerminalContext({ terminal: t }: { terminal: Terminal }) {
  return <aside className="aw-context" aria-label={tr('终端上下文')}>
    <h2>{tr('上下文')}</h2>
    <dl>
      <dt>{tr('herdr 工作区')}</dt><dd>{t.workspace_id || tr('未指定')}</dd>
      <dt>{tr('标签页')}</dt><dd>{t.tab_id || tr('未指定')}</dd>
      <dt>{tr('窗格')}</dt><dd>{t.pane_id}</dd>
      <dt>{tr('工作目录')}</dt><dd className="path">{t.cwd || tr('未指定')}</dd>
      <dt>{tr('Agent 种类')}</dt><dd>{kindName(t.kind) || tr('未指定')}</dd>
    </dl>
  </aside>;
}


export function HostedRoom({ agent: initial, toast }: { agent: Agent; toast: (s: string) => void }) {
  const [agent, setAgent] = useState(initial), [text, setText] = useState(''), [error, setError] = useState('');
  const [queued, setQueued] = useState<AgentEvent[]>([]), [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const reload = useRef<() => void>(() => {}), screen = useRef<HTMLPreElement>(null), bottom = useRef(true);
  const receipt = useReadReceipt(agent.id, ready ? `${text}\n${agent.term?.seq}` : null);
  useEffect(() => {
    let alive = true, reading = false, timer = 0;
    async function load() {
      if (reading) return;
      reading = true; clearTimeout(timer);
      try {
        const s = await api.agentScreen(initial.id), d = await api.agent(initial.id);
        if (alive) { setText(s.text); setAgent(d.agent); setQueued(d.events.filter(e => e.kind === 'user' && e.data.held).map(e => e.data.sending ? { ...e, data: { ...e.data, error: tr('发送结果未确认，请查看终端后决定是否再次发送。') } } : e)); setError(''); setReady(true); }
      } catch (e) { if (alive) setError((e as Error).message); }
      finally { reading = false; if (alive) timer = window.setTimeout(load, 2000); }
    }
    reload.current = () => { void load(); }; void load();
    const off = listen(e => { if (e.type === 'agent' && e.agent?.id === initial.id) { setAgent(e.agent); void load(); } });
    return () => { alive = false; off(); clearTimeout(timer); reload.current = () => {}; };
  }, [initial.id]);
  useLayoutEffect(() => { if (screen.current && bottom.current) screen.current.scrollTop = screen.current.scrollHeight; }, [text]);
  const adapter: ComposeAdapter = {
    send: async (text, mode) => { await api.say(agent.id, text, mode); },
    queue: async (id, what) => { await api.queueAct(agent.id, id, what); },
    stop: async () => { await api.stopAgent(agent.id); },
    steerHint: tr('消息将直接发送到终端，处理方式由终端里的 agent 决定。'),
  };
  async function press(key: string) {
    setBusy(true);
    try { await api.agentKeys(agent.id, [key]); reload.current(); }
    catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  }
  return <div className="terminal-room" ref={receipt}>
    <header className="terminal-head"><div><WatchStatus agent={agent} /><b>{agent.name}</b><span>{agent.runtime} · {kindName(agent.term?.provider)}</span></div></header>
    {(error || agent.term?.note) && <p role="alert" className="aw-notice">{error || agent.term?.note}</p>}
    <pre className="terminal-screen" ref={screen} tabIndex={0} aria-label={tr('终端内容')} onScroll={e => {
      const el = e.currentTarget; bottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    }}>{text || tr('终端暂未输出内容。')}</pre>
    {agent.watch?.why === 'terminal' && <TerminalKeys disabled={busy || !!error} press={press} />}
    {agent.term?.status === 'exited' ? <button className="btn pri" disabled={busy} onClick={async () => {
      setBusy(true); try { await api.startAgent(agent.id); reload.current(); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
    }}>{tr('接着会话启动')}</button> : <Compose agent={agent} queued={queued} adapter={adapter} toast={toast} onChanged={() => reload.current()} />}
  </div>;
}

export function HostedContext({ agent, toast }: { agent: Agent; toast: (s: string) => void }) {
  const [busy, setBusy] = useState(false);
  return <>
    <dl>
      <dt>{tr('终端后端')}</dt><dd>{agent.runtime}</dd>
      <dt>{tr('CLI')}</dt><dd>{kindName(agent.term?.provider)}</dd>
      <dt>{tr('模型')}</dt><dd>{agent.model || tr('CLI 默认模型')}</dd>
      <dt>{tr('思考强度')}</dt><dd>{agent.term?.thinking || tr('未指定')}</dd>
      <dt>{tr('会话 ID')}</dt><dd className="path">{agent.session_id || tr('未指定')}</dd>
      <dt>{tr('接入方式')}</dt><dd className="path">{agent.attach || tr('未指定')}</dd>
    </dl>
    <button className="btn" disabled={busy || agent.term?.status === 'exited'} onClick={async () => {
      setBusy(true); try { await api.closeTerminal(agent.id); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
    }}>{tr('关闭终端')}</button>
  </>;
}
