import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { api, type Agent, type AgentEvent, type SayMode } from '../api';
import { tr } from '../i18n';
import { useSettings } from '../settings';
import { markSeen } from './overview';
import { isWorking, type Watched } from './watch';
import './agents.css';

const MODES: [SayMode, string, string, string][] = [
  ['steer', tr('插话'), tr('补充当前任务的指令'), tr('当前步骤完成后，消息将进入正在运行的这一轮。')],
  ['queue', tr('排队'), tr('安排下一轮任务'), tr('当前一轮结束后发送这条消息。')],
  ['interrupt', tr('打断并发送'), tr('停止当前任务并发送新指令'), tr('停止当前这一轮，立即发送这条消息。')],
];

export interface ComposeAdapter {
  send: (text: string, mode?: SayMode) => Promise<void>;
  queue: (id: number, what: 'now' | 'drop') => Promise<void>;
  stop: () => Promise<void>;
  steerHint: string;
}

export function Compose({ agent, queued = [], permission = false, toast, onSent, onChanged, value, onChange, onKeyDown, children, placeholder, prepare, inputRef, adapter }: {
  agent: Watched & Pick<Agent, 'id'>; queued?: AgentEvent[]; permission?: boolean; toast: (s: string) => void;
  onSent?: (event: AgentEvent, text: string) => void; onChanged?: () => void;
  value?: string; onChange?: (s: string) => void; onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  children?: React.ReactNode; placeholder?: string;
  prepare?: (text: string) => Promise<string>; inputRef?: React.MutableRefObject<HTMLTextAreaElement | null>;
  adapter?: ComposeAdapter;
}) {
  const settings = useSettings();
  const [mode, setMode] = useState<SayMode>(settings.agentSend);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false), box = useRef<HTMLTextAreaElement | null>(null);
  const hint = useId(), text = value ?? draft, setText = onChange ?? setDraft;
  const current = useRef(text); current.current = text;
  const working = isWorking(agent) || permission, off = !!agent.down || ['offline', 'stopped'].includes(agent.status ?? '');
  const choice = MODES.find(x => x[0] === mode) ?? MODES[0];
  useEffect(() => setMode(settings.agentSend), [settings.agentSend]);
  useLayoutEffect(() => {
    const el = box.current;
    if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 180)}px`; }
  }, [text]);

  async function run(fn: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try { await fn(); onChanged?.(); } catch (e) { toast((e as Error).message); }
    finally { pending.current = false; setBusy(false); }
  }
  function send(how: SayMode | undefined = working ? mode : undefined) {
    const s = text.trim();
    if (!s || off) return;
    void run(async () => {
      const message = prepare ? await prepare(s) : s;
      const event = adapter ? await adapter.send(message, how) : await api.say(agent.id, message, how);
      markSeen(agent.id);
      if (event) onSent?.(event, s);
      if (current.current.trim() === s) setText('');
    });
  }
  function queue(event: AgentEvent, what: 'now' | 'drop') {
    void run(async () => {
      if (adapter) await adapter.queue(event.id, what);
      else await api.queueAct(agent.id, event.id, what);
      if (what === 'drop') {
        setText([current.current, String(event.data.text ?? '')].filter(Boolean).join('\n'));
        box.current?.focus();
      } else markSeen(agent.id);
    });
  }
  return <div className="agent-compose">
    {!!queued.length && <ul className="ac-queue" aria-label={tr('排队中的消息')}>
      {queued.map(event => <li key={event.id}>
        <div><span className="small muted">{tr('排队')}</span><p>{String(event.data.text ?? '')}</p>{event.data.error && <p className="ac-error">{String(event.data.error)}</p>}</div>
        <button className="btn" disabled={busy || off} onClick={() => queue(event, 'now')}>{tr('现在发')}</button>
        <button className="btn" disabled={busy} onClick={() => queue(event, 'drop')}>{tr('撤回')}</button>
      </li>)}
    </ul>}
    <div className="ac-input">
      {children}
      <textarea ref={el => { box.current = el; if (inputRef) inputRef.current = el; }} data-agent-compose={agent.id} aria-label={tr('消息')} aria-describedby={hint} rows={2} value={text}
        placeholder={working ? choice[2] : placeholder ?? tr('输入消息，开始新一轮任务')}
        onChange={e => setText(e.target.value)} onKeyDown={e => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          onKeyDown?.(e);
          if (e.defaultPrevented || e.key !== 'Enter' || e.shiftKey || e.altKey) return;
          e.preventDefault(); if (e.metaKey || e.ctrlKey) send('queue'); else send();
        }} />
      <div className="ac-tools">
        {working && <div className="seg mini" role="radiogroup" aria-label={tr('发送方式')}>
          {MODES.map(([m, name, , tip]) => <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? 'on' : ''} title={m === 'steer' && adapter ? adapter.steerHint : tip} onClick={() => setMode(m)}>{name}</button>)}
        </div>}
        <div className="btns">
          {working && <button className="btn" disabled={busy || off} onClick={() => run(async () => { if (adapter) await adapter.stop(); else await api.abort(agent.id); })}>{tr('停止')}</button>}
          <button className="btn pri" disabled={busy || off || !text.trim()} onClick={() => send()}>{tr('发送')}</button>
        </div>
      </div>
    </div>
    <p id={hint} className="ac-hint">{working ? mode === 'steer' && adapter ? adapter.steerHint : choice[3] : tr('Enter 发送，Shift+Enter 换行。')}</p>
    {(permission || !!agent.watch?.permissions.length) && <p className="ac-permission">{tr('插话会先拒绝当前权限请求，再发送消息。请优先使用权限卡片上的「允许」或「拒绝」。')}</p>}
  </div>;
}
