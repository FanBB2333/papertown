// The console's assistant, in a sidebar on the right: an agent like the depot's and the
// press's (Paseo or pi), told with every message what you are looking at. Point at the page to
// say what you mean; it can ask you back, open things and light them up for you, and ask to do
// things in the town, which wait here until you allow them.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, listen, type AgentEvent, type AssistantView, type Focus, type StartOpts } from '../api';
import { AgentChat, PaseoChat, PaseoPick, Text, type ChatHooks } from '../components/AgentRoom';
import type { RoomActions } from '../components/Interior';
import { tr } from '../i18n';
import { Icon } from './icons';
import { describe, onPageChange, pickable, snapshot, usePlace } from './page';

const WIDTH = 'pt-assistant-w';
const QUICK = [tr('这一页在讲什么？'), tr('任务现在怎么样了？'), tr('有什么要我处理的？')];

// a message as it went out: the page it was written on, then your words; or a note from the town
export function parse(t: string): { text: string; where?: string; pointed?: string; event?: string } {
  if (t.startsWith('<start>')) return { text: '', event: tr('小助手启动了，先读了一遍它的说明。') };
  const ev = /^<event>\n?([\s\S]*?)\n?<\/event>\s*$/.exec(t);
  if (ev) return { text: '', event: ev[1].trim() };
  const pg = /^<page>\n([\s\S]*?)\n<\/page>\n*/.exec(t);
  if (!pg) return { text: t };
  const lines = pg[1].split('\n'), get = (k: string) => lines.find(l => l.startsWith(k))?.slice(k.length);
  return { text: t.slice(pg[0].length), where: get('在看：')?.replace(/（.*）$/, ''), pointed: get('指着：')?.split('〔')[0] };
}

export function Assistant({ actions, onClose }: { actions: RoomActions; onClose: () => void }) {
  const [view, setView] = useState<AssistantView | null>(null);
  const [err, setErr] = useState('');
  const [bump, setBump] = useState(0);
  const [focus, setFocusState] = useState<Focus | null>(null);
  const [pointing, setPointing] = useState<((f: Focus) => void) | null>(null);
  const [busy, setBusy] = useState(false);
  const [w, setW] = useState(() => { try { return Number(localStorage.getItem(WIDTH)) || 400; } catch { return 400; } });
  const focusRef = useRef<Focus | null>(null);
  const setFocus = (f: Focus | null) => { focusRef.current = f; setFocusState(f); };
  const place = usePlace();

  useEffect(() => {
    api.assistant().then(v => { setView(v); setErr(''); }, e => setErr((e as Error).message));
  }, [bump]);
  useEffect(() => listen(e => {
    if (e.type === 'agent' && e.agent?.id === 'assistant') setView(v => (v ? { ...v, agent: e.agent } : v));
    else if (e.type === 'agent_event' && e.event.agent_id === 'assistant' && ['ask', 'act'].includes(e.event.kind)) setBump(b => b + 1);
  }), []);
  useEffect(() => { try { localStorage.setItem(WIDTH, String(w)); } catch { /* private mode */ } }, [w]);
  // what opens over the panels (a job's drawer) stops short of the sidebar
  useLayoutEffect(() => {
    const host = document.querySelector<HTMLElement>('.p-console');
    host?.style.setProperty('--asst-w', `${w}px`);
    return () => { host?.style.removeProperty('--asst-w'); };
  }, [w]);

  // page.md follows you while it runs: the page you are on, a moment after you move
  const started = !!view?.agent.started;
  useEffect(() => {
    if (!started) return;
    let t = 0;
    const sync = () => { clearTimeout(t); t = window.setTimeout(() => api.assistantPage(snapshot(focusRef.current)).catch(() => {}), 1500); };
    sync();
    const off = onPageChange(sync);
    return () => { off(); clearTimeout(t); };
  }, [started, focus]);

  async function start(o: StartOpts) {
    setBusy(true);
    try { await api.startAgent('assistant', o); setBump(b => b + 1); } catch (e) { actions.toast((e as Error).message); } finally { setBusy(false); }
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

  const a = view?.agent;
  const close = <button className="ib" title={tr('收起小助手')} onClick={onClose}><Icon n="sideR" size={16} /></button>;
  const hooks: ChatHooks = {
    send: text => {
      const page = snapshot(focusRef.current);
      setFocus(null);
      return api.assistantSay(text, page);
    },
    body: t => parse(t).text,
    user: t => <Said text={t} />,
    entry: ev => (ev.kind === 'ask' || ev.kind === 'act' ? null : undefined), // they are the cards below
    tail: send => view && <Cards view={view} send={send} toast={actions.toast} onPoint={then => point(f => { setFocus(f); then(); })} />,
    tools: (send, typed) => (
      <div className="as-bar">
        <div className="as-at">
          <button className={`as-point${pointing ? ' on' : ''}`} onClick={() => (pointing ? setPointing(null) : point(setFocus))}
            title={tr('在页面上点一下你想问的地方')}><Icon n="target" size={14} />{pointing ? tr('点页面上的一处…') : tr('指给它看')}</button>
          {focus
            ? <span className="as-chip" title={focus.text}><b>{focus.label}</b>{focus.where && <em>{focus.where}</em>}
                <button onClick={() => setFocus(null)} aria-label={tr('不指了')}><Icon n="close" size={11} /></button></span>
            : <span className="as-here" title={tr('每条消息都会带上你在看的页面')}>{place.line ? `#${place.line.seq} · ` : ''}{place.name}</span>}
        </div>
        {!typed && !focus && <div className="as-quick">{QUICK.map(q => <button key={q} onClick={() => send(q)}>{q}</button>)}</div>}
      </div>
    ),
    head: <>
      <button className="ib" title={tr('新对话：可以换一个模型重新开始')} onClick={() => api.assistantNew().then(() => setBump(b => b + 1), e => actions.toast((e as Error).message))}><Icon n="compose" size={15} /></button>
      {close}
    </>,
    placeholder: tr('问这一页的事，或者请它帮你办；Enter 发送'),
  };

  return (
    <aside className="asst" style={{ width: w }}>
      <span className="as-grip" onPointerDown={resize} title={tr('拖动改变宽度')} />
      {!view || !a ? (
        <div className="as-start"><header className="as-top"><b>{tr('小助手')}</b><span className="sp" />{close}</header>
          {err ? <p className="warn-box small">{err}</p> : <p className="muted">{tr('加载中…')}</p>}</div>
      ) : !a.started ? (
        <div className="as-start">
          <header className="as-top"><Icon n="chat" size={16} /><b>{tr('小助手')}</b><span className="sp" />{close}</header>
          <p className="as-lead">{tr('一个本地 agent，和员工一样跑在 Paseo 或 pi 里。它知道你在看哪一页、指着什么，会去读这一页数据的出处来回答；要它办的事，先在这里请你点头。')}</p>
          <div className="hire-card">
            <h3>Paseo</h3>
            <PaseoPick busy={busy} onStart={start} />
          </div>
          <div className="hire-card">
            <h3>{tr('pi · 后台终端')}</h3>
            <button className="btn" disabled={busy} onClick={() => start({ runtime: 'pi' })}>{busy ? tr('启动中…') : tr('启动 pi')}</button>
          </div>
        </div>
      ) : (
        <div className="as-chat">
          {a.runtime === 'paseo'
            ? <PaseoChat key={a.ext_id ?? 'p'} {...actions} agent={a} role="assistant" hooks={hooks} />
            : <AgentChat key="pi" {...actions} agent={a} role="assistant" hooks={hooks} />}
        </div>
      )}
      {pointing && <Pointer onPick={pointing} onCancel={() => setPointing(null)} />}
    </aside>
  );
}

// one of your messages: the page it was written on as a quiet line, then what you wrote
function Said({ text }: { text: string }) {
  const m = parse(text);
  if (m.event) return <div className="as-ev"><Icon n="bell" size={13} /><Text text={m.event} /></div>;
  return (
    <div className="msg-u as-said">
      {m.where && <span className="as-ctx">{m.where}{m.pointed && <em><Icon n="target" size={11} />{m.pointed}</em>}</span>}
      <Text text={m.text} />
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
  const acts = view.acts.filter(e => e.data.status === 'pending' || done[e.id]);
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
            <span className="as-k">{d.status === 'pending' ? tr('它想替你做') : d.status === 'done' ? tr('已经做了') : d.status === 'denied' ? tr('你没让它做') : tr('没做成')}</span>
            <p><b>{d.title}</b></p>
            {d.why && d.status === 'pending' && <p className="muted small">{d.why}</p>}
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
