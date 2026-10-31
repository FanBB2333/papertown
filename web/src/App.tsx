// Papertown: the console is home for anyone who would rather click than walk: every project
// and everything the town does, as panels. The world map is the same town, walked as a small
// figure. Chat slides in from the side (B), a building opens full screen from the inside (C),
// and the status view (D) sits beside the world. The town can be walked in 3D too, through
// your own eyes; the camera flies between the map's view and yours, so either hands over to
// the other.
//
//   #view=console&line=line_2&m=paper   #view=status   #open=farm   #open=depot&line=line_1   #chat   #3d
//   — open a state directly

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, subscribe, type Line, type Message, type ServerEvent, type TraceRow, type WorldState } from './api';
import { Item, Logo } from './art';
import { DemoWelcome, RepoLink } from './components/Demo';
import { Drawer, type Composer, type Tab } from './components/Drawer';
import { Interior } from './components/Interior';
import { SettingsPanel } from './components/Settings';
import { StatusView } from './components/StatusView';
import { Console } from './console/Console';
import { WorldMap, type MapApi, type MapView } from './components/WorldMap';
import { getSettings, useSettings } from './settings';
import { DEMO } from './demo';
import { enterFull, holdEscape, leaveFull } from './fullscreen';
import { tr } from './i18n';

const Town3D = lazy(() => import('./components/Town3D'));

type View = 'console' | 'world' | 'status';
// the map, the 3D town, and the flights between them
type Dim = '2d' | 'to3d' | '3d' | 'to2d';
const PHASE = { '2d': 'off', to3d: 'enter', '3d': 'live', to2d: 'leave' } as const;
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

function Gear() {
  return (
    <svg className="gear" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3.2l1.6 2.1 2.6-.6.6 2.6 2.4 1.2-1 2.5 1 2.5-2.4 1.2-.6 2.6-2.6-.6L12 20.8l-1.6-2.1-2.6.6-.6-2.6-2.4-1.2 1-2.5-1-2.5 2.4-1.2.6-2.6 2.6.6z" />
      <circle cx="12" cy="12" r="3.2" />
    </svg>
  );
}

export function App() {
  const hp = new URLSearchParams(location.hash.slice(1));
  // a link into the town (a building, the chat, the 3D walk) opens the town; else the view you start on
  const [view, setView] = useState<View>(() => {
    const v = hp.get('view');
    if (v === 'status' || v === 'console' || v === 'world') return v;
    return hp.has('open') || hp.has('3d') || hp.has('chat') || getSettings().start !== 'console' ? 'world' : 'console';
  });
  const [consoleUp, setConsoleUp] = useState(view === 'console'); // mounted once shown, and kept
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
  const [dim, setDim] = useState<Dim>('2d');
  const [from3d, setFrom3d] = useState<MapView | null>(null);
  const [want3d, setWant3d] = useState(false); // the 3D code has been asked for
  const mapApi = useRef<MapApi | null>(null);
  const hash3d = useRef(hp.has('3d') || (getSettings().start === '3d' && !hp.has('open') && view === 'world'));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const st = useSettings();
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
    api.world().then(setWorld).catch(e => push(tr('连不上服务器：{0}', e.message)));
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
      if (e.added?.length) push(tr('新 skill 上岗：{0}', e.added.join(tr('、'))));
      if (e.removed?.length) push(tr('skill 下线：{0}', e.removed.join(tr('、'))));
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
    if (running) n.mill = tr('{0} 个项目在跑', running);
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
      const t = e.target as HTMLElement | null;
      if (e.key === ',' && !e.metaKey && !e.ctrlKey && !e.altKey && !(t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)))) {
        e.preventDefault();
        setSettingsOpen(o => !o);
        return;
      }
      if (e.key !== 'Escape') return;
      if (settingsOpen) setSettingsOpen(false);
      else if (chatOpen) setChatOpen(false);
      else if (sheet) leaveRoom();
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [sheet, chatOpen, settingsOpen, leaveRoom]);

  // over the 3D walk in full screen, Esc closes what is open before it leaves full screen
  useEffect(() => holdEscape(dim === '3d' && (!!sheet || chatOpen || settingsOpen)), [dim, sheet, chatOpen, settingsOpen]);

  // anything with data-open opens that building (stations, goods, list rows); data-line picks the project
  function onRootClick(e: React.MouseEvent) {
    const t = e.target as Element;
    const el = t.closest('[data-open]');
    if (!el || t.closest('.p-world, .p-console')) return;
    const r = el.getBoundingClientRect();
    openRoom(el.getAttribute('data-open')!, el.getAttribute('data-line'), { x: r.left + r.width / 2, y: r.top + r.height / 2 });
  }

  const root = useRef<HTMLDivElement>(null);
  // lock: take the mouse for looking round right away (this runs in the click on the switch,
  // which the browser requires); from a link there is no click, and the town asks for one
  const go3d = useCallback((lock = true) => {
    if (dim !== '2d') return;
    if (lock) {
      enterFull();
      (root.current?.requestPointerLock?.() as Promise<void> | undefined)?.catch?.(() => {});
    }
    setChatOpen(false); // the chat and the settings belong to the view they were opened in
    setSettingsOpen(false);
    setFrom3d(mapApi.current?.view() ?? null);
    setWant3d(true);
    setDim('to3d');
  }, [dim]);
  const go2d = useCallback(() => {
    if (dim !== '3d') return;
    leaveFull();
    setChatOpen(false);
    setSettingsOpen(false);
    setDim('to2d');
  }, [dim]);
  useEffect(() => {
    if (world && hash3d.current) { hash3d.current = false; go3d(false); }
  }, [world, go3d]);
  // the console is not part of the walk: going there from the 3D town lands back on the map
  const show = useCallback((v: View) => {
    if (v === 'console') { setConsoleUp(true); go2d(); }
    setView(v);
  }, [go2d]);

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
  const walking = !sheet && view === 'world' && !chatOpen && !settingsOpen;
  const running = world?.running ?? [];

  return (
    <div ref={root} className={`proto la theme-sketch${chatOpen ? ' chat-open' : ''}${sheet && !leaving ? ' in-room' : ''}${dim !== '2d' ? ' in-3d' : ''}${st.motion === 'calm' ? ' calm' : ''}`} data-mode={view} onClick={onRootClick}
      style={{ ['--grain-k' as string]: st.grain, ...(door ? { ['--ox' as string]: `${door.x}px`, ['--oy' as string]: `${door.y}px` } : {}) }}>
      {world && <WorldMap placements={world.placements} highlight={null} notes={notes} active={walking && dim === '2d'}
        hidden={dim === '3d' || dim === 'to2d'} api={mapApi} onOpen={(id, at) => openRoom(id, null, at)} />}
      {world && want3d && (
        <Suspense fallback={null}>
          <Town3D placements={world.placements} notes={notes} phase={PHASE[dim]} from={from3d}
            active={walking && dim === '3d'}
            onOpen={(id, at, line) => openRoom(id, line ?? null, at)}
            onCovered={() => setDim(d => d === 'to3d' ? '3d' : d)}
            onLeft={v => { mapApi.current?.setView(v); setDim('2d'); }}
            onLeave={go2d}
            onFail={msg => { push(msg); leaveFull(); setWant3d(false); setDim('2d'); }} />
        </Suspense>
      )}
      <StatusView tick={tick} active={view === 'status'} />
      {consoleUp && (
        <Console active={view === 'console'} lines={lines} placements={world?.placements ?? []} tick={tick} toast={push}
          onRoom={(id, lineId) => openRoom(id, lineId)} onIdea={() => openChat({ kind: 'idea' }, true)}
          onAsk={(id, name) => openChat({ kind: 'ask', building: id, name }, true)}
          onHatch={id => act(() => api.hatch(id))} onResume={id => act(() => api.resume(id))}
          onAdjust={id => openChat({ kind: 'adjust', lineId: id }, true)} />
      )}

      <header className="hud">
        <div className="brand"><Logo /><b>Papertown</b></div>
        <div className="seg" role="tablist">
          <button className={view === 'console' ? 'on' : ''} onClick={() => show('console')} title={tr('不用走动：所有项目和小镇的功能都在面板里')}>{tr('中控屏')}</button>
          <button className={view === 'world' ? 'on' : ''} onClick={() => show('world')} title={tr('在小镇里走动，进建筑办事；可以平面或 3D')}>{tr('小镇')}</button>
          <button className={view === 'status' ? 'on' : ''} onClick={() => show('status')}>{tr('运行状态')}</button>
        </div>
        <div className="seg w-only" role="tablist" title={tr('平面地图和 3D 漫游之间切换，人站在同一个地方')}>
          <button className={dim === '2d' || dim === 'to2d' ? 'on' : ''} onClick={go2d}>{tr('平面')}</button>
          <button className={dim === '3d' || dim === 'to3d' ? 'on' : ''} onClick={() => go3d()}>{tr('3D 漫游')}</button>
        </div>
        {hud && <div className="hud-quiet">
          <span><b>{hud.lines.running}</b> {tr('个项目在跑')}</span>
          <span>{tr('本周')} <b>${hud.bank.week.toFixed(2)}</b></span>
        </div>}
        <div className="hud-r">
          {hud && <span className={`chip ${!online ? 'bad' : hud.offline ? 'warn' : 'ok'}`} title={hud.offline ? tr('没有配置模型 key，流水线的员工按 skill 的步骤调用真实工具，文字部分用模板；仓库和印刷厂的 pi 用 pi 自己的设置') : hud.model}>
            {!online ? tr('连接断开') : DEMO ? tr('静态演示') : hud.offline ? tr('离线模式') : hud.provider}</span>}
          {DEMO && <RepoLink />}
          <button className="btn hud-gear" title={tr('设置（,）')} aria-label={tr('设置')} onClick={() => setSettingsOpen(true)}><Gear />{tr('设置')}</button>
          <button className="btn" onClick={() => chatOpen ? setChatOpen(false) : openChat()}>{tr('对话')}</button>
        </div>
      </header>

      {running.length > 0 && (
        <aside className="running w-only">
          {running.map((r, i) => (
            <div key={r.id} className="rn" style={{ ['--i' as string]: i }} data-open={r.mill_id ?? r.building} data-line={r.id}>
              <div>
                <b>#{r.seq} {r.title}</b>
                <div className="rn-row">{r.status === 'waiting' ? tr('等你决定') : r.status === 'paused' ? tr('已暂停') : r.stage}<div className="bar"><i style={{ width: `${r.pct}%` }} /></div></div>
              </div>
            </div>
          ))}
        </aside>
      )}

      <button className="newidea btn pri w-only" onClick={() => openChat({ kind: 'idea' }, true)}><Item k="egg" />{tr('放入一颗新 idea')}</button>
      {dim === '2d' && st.walkHint && <div className={`walk-hint w-only${hint ? '' : ' gone'}`}><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> {tr('走动 · 到门口按')} <kbd>F</kbd> {tr('进去 · 也可以直接点建筑')}</div>}

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
      <SettingsPanel open={settingsOpen} hud={hud ?? null} onClose={() => setSettingsOpen(false)} />
      <div className="toasts">{toasts.map(t => <div key={t.id} className="toast">{t.text}</div>)}</div>
      {DEMO && <DemoWelcome />}
    </div>
  );
}
