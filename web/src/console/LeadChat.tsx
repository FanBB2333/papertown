// Talking to a project's lead: one conversation group wherever it opens (the console's sidebar beside a
// project, the conversation page in 进展, the 员工 panel): its conversations in Paseo, a new one, an earlier
// one; what it waits on you for, pinned above the message box.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, type Agent, type AssistantConv, type Report, type SayMode, type StartOpts } from '../api';
import { fold, PaseoLog, PaseoPick, usePaseoTalk } from '../components/AgentRoom';
import { AGENT_STATUS } from '../components/MillRoom';
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
  const run = async (fn: () => Promise<unknown>) => {
    setHistory(false);
    try { await fn(); again(); } catch (e) { toast((e as Error).message); }
  };
  async function start(o: StartOpts) {
    setBusy(true);
    try {
      const x = a ?? await api.openAgent(lineId, 'lead');
      await api.startAgent(x.id, { ...o, runtime: 'paseo' });
      again();
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  }
  const resume = (c: AssistantConv) => a && run(() => api.resumeConv(a.id, c.id));

  const head = (x: Agent | null) => (
    <header className="as-head">
      <span className={`dot s-${x?.started ? x.status : 'stopped'}`} />
      <div className="as-who">
        <b>{tr('项目负责人')}{layout === 'side' ? ` · #${seq}` : ''}</b>
        {x?.started && <span>{AGENT_STATUS[x.status] ?? x.status}{x.model ? ` · ${x.model}` : ''}</span>}
      </div>
      {x && <button className={`ib as-hist${history ? ' on' : ''}`} title={tr('之前的对话')} aria-expanded={history} onClick={() => setHistory(h => !h)}><Icon n="clock" size={16} /></button>}
      {x?.started && <button className="ib" title={tr('新对话：负责人用同一个模型重新开始')} onClick={() => run(() => api.newConv(x.id))}><Icon n="compose" size={16} /></button>}
      {x?.started && <button className="ib" title={tr('在 Paseo 桌面端打开这段对话')} onClick={() => api.openInPaseo(x.id).catch(e => toast((e as Error).message))}><Icon n="ext" size={16} /></button>}
      {onClose && <button className="ib" title={tr('收起（⌘J）')} onClick={onClose}><Icon n="sideR" size={16} /></button>}
    </header>
  );

  return (
    <div className={`asst lc lc-${layout}`}>
      {!v ? <>{head(null)}<p className="as-wait">{tr('加载中…')}</p></>
        : !a?.started ? (
          <>
            {head(a)}
            <div className="as-start">
              <p className="as-lead">{tr('负责人盯着这个项目：有动静时看一眼，催员工干活、给他们派活，有要紧的事向你汇报、问你。它只跑在 Paseo 里。')}</p>
              {a && <Earlier agent={a.id} at={a.ext_id} limit={3} title={tr('接着之前的对话')} onPick={resume} />}
              <div className="hire-card">
                <h3>Paseo</h3>
                <PaseoPick busy={busy} onStart={start} role="lead" />
              </div>
            </div>
          </>
        ) : <Talk key={a.ext_id ?? a.id} agent={a} asks={v.asks} head={head} toast={toast} onAnswered={again} />}
      {history && a && <History agent={a.id} onPick={resume} onClose={() => setHistory(false)} />}
    </div>
  );
}

function Talk({ agent: initial, asks, head, toast, onAnswered }: {
  agent: Agent; asks: Report[]; head: (a: Agent) => React.ReactNode; toast: (t: string) => void; onAnswered: () => void;
}) {
  const t = usePaseoTalk(initial);
  const rows = useMemo(() => fold(t.items ?? [], i => i.kind === 'tool'), [t.items]);
  const [text, setText] = useState('');
  const [mode, setMode] = useState<SayMode>('steer');
  const scroll = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const working = t.agent.status === 'working', typed = !!text.trim();

  useLayoutEffect(() => {
    const el = scroll.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [rows, t.sent.length, t.asks.length, working]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  function send() {
    const s = text.trim();
    if (!s) return;
    stick.current = true;
    api.say(t.agent.id, s, working ? mode : undefined).then(event => {
      if (event.data.delivered) t.wrote(s);
      setText(current => current.trim() === s ? '' : current);
    }).catch(e => toast((e as Error).message));
  }
  return (
    <>
      {head(t.agent)}
      <div className="as-mid">
        <div className="as-log lc-log" ref={scroll} onScroll={e => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}>
          {t.err && <div className="note err">{t.err}</div>}
          {t.items === null && !t.err && <p className="as-wait">{tr('加载中…')}</p>}
          {t.items && !t.items.length && !t.sent.length && <p className="as-wait">{tr('还没有对话。问它项目的事，或者交代它一件事。')}</p>}
          <PaseoLog rows={rows} sent={t.sent} asks={t.asks} working={working}
            onPermit={(id, allow) => { api.permit(t.agent.id, id, allow).then(() => t.answered(id)).catch(e => toast((e as Error).message)); }} />
        </div>
      </div>
      {asks.length > 0 && (
        <div className="lc-asks">
          {asks.slice(0, 2).map(q => <AskCard key={q.id} q={q} toast={toast} onDone={onAnswered} />)}
          {asks.length > 2 && <p className="muted small">{tr('还有 {0} 件等你回答', asks.length - 2)}</p>}
        </div>
      )}
      <div className="as-foot">
        <div className="as-box" onMouseDown={e => { if (e.target === e.currentTarget) { e.preventDefault(); box.current?.focus(); } }}>
          <textarea ref={box} rows={1} value={text}
            placeholder={!working ? tr('问它项目的事，或者交代它一件事') : mode === 'steer' ? tr('插话，它做完这一步就会看到') : tr('排队，等它做完手上的事')}
            onChange={e => setText(e.target.value)} onKeyDown={enterSends(send)} />
          <div className="as-tools">
            {working && (
              <div className="seg mini" role="radiogroup" aria-label={tr('它在忙时，消息怎么交给它')}>
                <button role="radio" aria-checked={mode === 'steer'} className={mode === 'steer' ? 'on' : ''} onClick={() => setMode('steer')}
                  title={tr('插进它手上的事：做完当前这一步就会看到')}>{tr('插话')}</button>
                <button role="radio" aria-checked={mode === 'queue'} className={mode === 'queue' ? 'on' : ''} onClick={() => setMode('queue')}
                  title={tr('等它把手上的事做完再交给它')}>{tr('排队')}</button>
              </div>
            )}
            {working && !typed
              ? <button className="as-send stop" title={tr('打断它手上的事')} onClick={() => api.abort(t.agent.id).catch(e => toast((e as Error).message))}><Icon n="stop" size={14} /></button>
              : <button className="as-send" disabled={!typed} title={tr('发送（Enter）')} onClick={send}><Icon n="send" size={16} /></button>}
          </div>
        </div>
      </div>
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
      <span className="lc-k"><Icon n="bell" size={13} />{tr('{0}在问你', trx(q.data.who ?? ''))} · {ago(q.ts)}</span>
      <p>{q.data.question}</p>
      {choices.length > 0 && (
        <div className="lc-choices">
          {choices.map((c, i) => <button key={c} className={`btn${i === 0 && q.data.act ? ' pri' : ''}`} disabled={busy} onClick={() => answer(c)}>{c}</button>)}
        </div>
      )}
      <div className="lc-reply">
        <input value={text} disabled={busy} placeholder={choices.length ? tr('或者写几句') : tr('写下你的回答')}
          onChange={e => setText(e.target.value)} onKeyDown={enterSends(() => answer(text))} />
        <button className="btn" disabled={busy || !text.trim()} onClick={() => answer(text)}>{tr('回答')}</button>
      </div>
    </div>
  );
}
