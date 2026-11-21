import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, listen, type AgentEvent, type Terminal, type TerminalDetail } from '../api';
import { ago } from '../console/util';
import { tr } from '../i18n';
import { Compose, type ComposeAdapter } from './Compose';
import { useReadReceipt } from './live';
import { kindName, WatchStatus } from './watch';

const KEYS = [['enter', 'Enter'], ['esc', 'Esc'], ['up', '↑'], ['down', '↓'], ['1', '1'], ['2', '2'], ['3', '3'], ['y', 'y'], ['n', 'n']];

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
    {current.watch.bucket === 'needs' ? <div className="terminal-keys">
      <p>{tr('请根据终端画面选择按键，处理当前对话框。')}</p>
      <div className="btns" role="group" aria-label={tr('终端按键')}>{KEYS.map(([key, name]) => <button className="btn" key={key} disabled={busy || !!error} onClick={() => press(key)}>{tr(name)}</button>)}</div>
    </div> : <Compose agent={{ ...current, down: error || null }} queued={queued} adapter={adapter} toast={toast} value={draft} onChange={setDraft} onChanged={() => reload.current()} />}
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
