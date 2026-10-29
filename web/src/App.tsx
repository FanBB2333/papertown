// Papertown: the world map is home (A), walked as a small figure. Chat slides in from
// the side (B), a building opens full screen from the inside (C), and the status view
// (D) sits beside the world.
//
//   #view=status   #open=farm   #open=depot&line=line_1   #chat   — open a state directly

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, subscribe, type Line, type Message, type ServerEvent, type TraceRow, type WorldState } from './api';
import { Item, Logo } from './art';
import { Drawer, type Composer, type Tab } from './components/Drawer';
import { Interior } from './components/Interior';
import { StatusView } from './components/StatusView';
import { WorldMap } from './components/WorldMap';

type View = 'world' | 'status';
const TICK_EVENTS = new Set(['line', 'world', 'building', 'bank', 'power', 'workers', 'library', 'skills']);

function useToasts() {
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);
  const push = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setToasts(t => [...t, { id, text }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4200);
  }, []);
  return { toasts, push };
}

export function App() {
  const hp = new URLSearchParams(location.hash.slice(1));
  const [view, setView] = useState<View>(hp.get('view') === 'status' ? 'status' : 'world');
  const [world, setWorld] = useState<WorldState | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [trace, setTrace] = useState<TraceRow[]>([]);
  const [chatOpen, setChatOpen] = useState(hp.has('chat'));
  const [tab, setTab] = useState<Tab>('chat');
  const [composer, setComposer] = useState<Composer>({ kind: 'idea' });
  const [focusKey, setFocusKey] = useState(0);
  const [sheet, setSheetId] = useState<string | null>(hp.get('open'));
  const [focus, setFocus] = useState<string | null>(hp.get('line'));
  const [tick, setTick] = useState(0);
  const [online, setOnline] = useState(true);
  const [asking, setAsking] = useState(false);
  const { toasts, push } = useToasts();
  const refresh = useRef<number>();
  const setSheet = useCallback((id: string | null, lineId?: string | null) => {
    setSheetId(id);
    setFocus(lineId ?? null);
  }, []);

  const load = useCallback(() => {
    clearTimeout(refresh.current);
    refresh.current = window.setTimeout(() => {
      api.world().then(setWorld).catch(() => {});
      api.lines().then(setLines).catch(() => {});
    }, 200);
  }, []);

  useEffect(() => {
    api.world().then(setWorld).catch(e => push(`连不上服务器：${e.message}`));
    api.lines().then(setLines).catch(() => {});
    api.messages().then(setMessages).catch(() => {});
    api.trace().then(setTrace).catch(() => {});
  }, [push]);

  useEffect(() => subscribe((e: ServerEvent) => {
    if (e.type === 'message') {
      setMessages(m => m.some(x => x.id === e.message.id) ? m : [...m, e.message].slice(-300));
      if (e.message.role === 'worker' && e.message.body?.from) setAsking(false);
      if (e.message.kind === 'error') setAsking(false);
    } else if (e.type === 'trace') {
      setTrace(t => [...t, e.row].slice(-200));
    } else if (e.type === 'line') {
      setLines(ls => {
        const i = ls.findIndex(l => l.id === e.line.id);
        return i < 0 ? [e.line, ...ls] : ls.map(l => l.id === e.line.id ? { ...l, ...e.line } : l);
      });
    } else if (e.type === 'skills') {
      if (e.added?.length) push(`新 skill 上岗：${e.added.join('、')}`);
      if (e.removed?.length) push(`skill 下线：${e.removed.join('、')}`);
    }
    if (TICK_EVENTS.has(e.type)) {
      setTick(t => t + 1);
      load();
    }
  }, ok => {
    setOnline(ok);
    if (ok) load();
  }), [load, push]);

  const notes = useMemo(() => {
    const n: Record<string, string> = {};
    const running = world?.running.filter(r => r.status === 'running').length ?? 0;
    if (running) n.mill = `${running} 个项目在跑`;
    return n;
  }, [world]);

  const openChat = useCallback((c: Composer = { kind: 'idea' }, focus = false) => {
    setChatOpen(true);
    setTab('chat');
    setComposer(c);
    if (focus) setFocusKey(k => k + 1);
  }, []);

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      load();
    } catch (e) {
      push((e as Error).message);
    }
  }

  async function onSend(text: string, budget: number) {
    if (composer.kind === 'ask') {
      setAsking(true);
      await act(() => api.ask(text, composer.building));
    } else if (composer.kind === 'adjust') {
      const id = composer.lineId;
      await act(() => api.adjust(id, text));
      setComposer({ kind: 'idea' });
    } else {
      await act(() => api.idea(text, budget));
    }
  }

  // going inside: the room opens like ink spreading from the door you came through, and
  // folds back into it when you leave; room to room is a plain cross-fade
  const [door, setDoor] = useState<{ x: number; y: number } | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [swap, setSwap] = useState(0);
  const leaveTimer = useRef<number>();
  const openRoom = useCallback((id: string, lineId?: string | null, at?: { x: number; y: number }) => {
    clearTimeout(leaveTimer.current);
    setLeaving(false);
    if (sheetRef.current) setSwap(n => n + 1);
    else setDoor(at ?? { x: innerWidth / 2, y: innerHeight / 2 });
    setSheet(id, lineId);
  }, [setSheet]);
  const sheetRef = useRef(sheet);
  sheetRef.current = sheet;
  const leaveRoom = useCallback(() => {
    setLeaving(true);
    clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => { setSheet(null); setLeaving(false); setSwap(0); }, 460);
  }, [setSheet]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (chatOpen) setChatOpen(false);
      else if (sheet) leaveRoom();
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [sheet, chatOpen, leaveRoom]);

  // anything with data-open opens that building (stations, goods, list rows); data-line picks the project
  function onRootClick(e: React.MouseEvent) {
    const t = e.target as Element;
    const el = t.closest('[data-open]');
    if (!el || t.closest('.p-world')) return;
    const r = el.getBoundingClientRect();
    openRoom(el.getAttribute('data-open')!, el.getAttribute('data-line'), { x: r.left + r.width / 2, y: r.top + r.height / 2 });
  }

  // the walking hint fades once you have moved or after a while
  const [hint, setHint] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setHint(false), 9000);
    const k = (e: KeyboardEvent) => { if (/^(Arrow|Key[WASD])/.test(e.code)) setHint(false); };
    addEventListener('keydown', k);
    return () => { clearTimeout(t); removeEventListener('keydown', k); };
  }, []);

  const hud = world?.hud;
  const busy = asking || lines.some(l => l.status === 'hatching');
  const running = world?.running ?? [];

  return (
    <div className={`proto la theme-sketch${chatOpen ? ' chat-open' : ''}${sheet && !leaving ? ' in-room' : ''}`} data-mode={view} onClick={onRootClick}
      style={door ? { ['--ox' as string]: `${door.x}px`, ['--oy' as string]: `${door.y}px` } : undefined}>
      {world && <WorldMap placements={world.placements} highlight={null} notes={notes} active={!sheet && view === 'world' && !chatOpen}
        onOpen={(id, at) => openRoom(id, null, at)} />}
      <StatusView tick={tick} active={view === 'status'} />

      <header className="hud">
        <div className="brand"><Logo /><b>Papertown</b></div>
        <div className="seg" role="tablist">
          <button className={view === 'world' ? 'on' : ''} onClick={() => setView('world')}>小镇</button>
          <button className={view === 'status' ? 'on' : ''} onClick={() => setView('status')}>运行状态</button>
        </div>
        {hud && <div className="hud-quiet">
          <span><b>{hud.lines.running}</b> 个项目在跑</span>
          <span>本周 <b>${hud.bank.week.toFixed(2)}</b></span>
        </div>}
        <div className="hud-r">
          {hud && <span className={`chip ${!online ? 'bad' : hud.offline ? 'warn' : 'ok'}`} title={hud.offline ? '没有配置模型 key，流水线的员工按 skill 的步骤调用真实工具，文字部分用模板；仓库和印刷厂的 pi 用 pi 自己的设置' : hud.model}>
            {!online ? '连接断开' : hud.offline ? '离线模式' : hud.provider}</span>}
          <button className="btn" onClick={() => chatOpen ? setChatOpen(false) : openChat()}>对话</button>
        </div>
      </header>

      {running.length > 0 && (
        <aside className="running w-only">
          {running.map((r, i) => (
            <div key={r.id} className="rn" style={{ ['--i' as string]: i }} data-open={r.mill_id ?? r.building} data-line={r.id}>
              <div>
                <b>#{r.seq} {r.title}</b>
                <div className="rn-row">{r.status === 'waiting' ? '等你决定' : r.status === 'paused' ? '已暂停' : r.stage}<div className="bar"><i style={{ width: `${r.pct}%` }} /></div></div>
              </div>
            </div>
          ))}
        </aside>
      )}

      <button className="newidea btn pri w-only" onClick={() => openChat({ kind: 'idea' }, true)}><Item k="egg" />放入一颗新 idea</button>
      <div className={`walk-hint w-only${hint ? '' : ' gone'}`}><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 走动 · 到门口按 <kbd>E</kbd> 进去 · 也可以直接点建筑</div>

      <Drawer open={chatOpen} tab={tab} onTab={setTab} onClose={() => setChatOpen(false)} messages={messages} trace={trace}
        lines={lines} placements={world?.placements ?? []} composer={composer} setComposer={setComposer} focusKey={focusKey}
        busy={busy} onSend={onSend} onOpen={id => openRoom(id)}
        onHatch={id => act(() => api.hatch(id))} />

      {sheet && (
        <Interior key={`${sheet}:${swap}`} id={sheet} focus={focus} tick={tick} placements={world?.placements ?? []} lines={lines}
          motion={leaving ? 'leave' : swap ? 'swap' : 'enter'} onClose={leaveRoom}
          onOpen={(id, lineId) => openRoom(id, lineId)} onIdea={() => openChat({ kind: 'idea' }, true)}
          onAsk={(id, name) => openChat({ kind: 'ask', building: id, name }, true)}
          onHatch={id => act(() => api.hatch(id))} onResume={id => act(() => api.resume(id))}
          onAdjust={id => openChat({ kind: 'adjust', lineId: id }, true)} toast={push} />
      )}
      <div className="toasts">{toasts.map(t => <div key={t.id} className="toast">{t.text}</div>)}</div>
    </div>
  );
}
