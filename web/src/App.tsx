// The app behind the landing, in two tabs: 进展 (every project at a glance, and talking to each) and
// 小镇 (each project in detail: the console's panels, the 2D map or the 3D walk), with the chat,
// building rooms and settings over them. Hash params open a state directly: #open=<building>[&line=<id>], #chat, #3d.

import { typing } from './components/walk';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, listen, subscribe, type Line, type ShowTarget, type WorldState } from './api';
import { Logo } from './art';
import { DemoWelcome, RepoLink } from './components/Demo';
import { Dock } from './components/Dock';
import { Interior } from './components/Interior';
import { SettingsPage } from './components/Settings';
import type { Target } from './console/Assistant';
import { Console } from './console/Console';
import { setPlace } from './console/page';
import { Icon } from './console/icons';
import { Progress } from './progress/Progress';
import { WorldMap, type MapApi, type MapView } from './components/WorldMap';
import { follow, go, href, path, PATHS, type Route, type View } from './route';
import { getSettings, useSettings } from './settings';
import { DEMO } from './demo';
import { enterFull, holdEscape, leaveFull } from './fullscreen';
import { tr } from './i18n';
import './mobile.css';

const Town3D = lazy(() => import('./components/Town3D'));

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

const TABS: ['cards' | 'town', string, string][] = [
  ['cards', tr('进展'), tr('每个项目的进展、风险和要你决定的事；和负责人对话')],
  ['town', tr('小镇'), tr('每个项目的细节：中控屏的面板，或者在小镇里走动')],
];

type Mode = 'board' | '2d' | '3d';
const MODES: [Mode, 'board' | 'map' | 'cube', string, string][] = [
  ['board', 'board', tr('中控屏'), tr('每个项目的细节摆成面板，不用走动')],
  ['2d', 'map', tr('平面'), tr('小镇的平面地图，走到建筑门口办事')],
  ['3d', 'cube', tr('3D 漫游'), tr('在 3D 的小镇里走动，人站在同一个地方')],
];

function Gear() {
  return (
    <svg className="gear" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3.2l1.6 2.1 2.6-.6.6 2.6 2.4 1.2-1 2.5 1 2.5-2.4 1.2-.6 2.6-2.6-.6L12 20.8l-1.6-2.1-2.6.6-.6-2.6-2.4-1.2 1-2.5-1-2.5 2.4-1.2.6-2.6 2.6.6z" />
      <circle cx="12" cy="12" r="3.2" />
    </svg>
  );
}

// covered: the landing is shown over the app, which keeps its state meanwhile
export function App({ route: at, covered }: { route: Route; covered: boolean }) {
  const [hp] = useState(() => new URLSearchParams(location.hash.slice(1)));
  const settingsOpen = at.view === 'settings';
  const under = useRef(at), leaveTo = useRef('/progress'), cameIn = useRef(false);
  // where the 小镇 tab and its 中控屏 switch go back to
  const townAt = useRef(['2d', '3d'].includes(getSettings().start) ? PATHS.world : PATHS.console), boardAt = useRef(PATHS.console);
  if (!settingsOpen) {
    under.current = at;
    leaveTo.current = path();
    if (at.view === 'console') townAt.current = boardAt.current = leaveTo.current;
    else if (at.view === 'world') townAt.current = PATHS.world;
  }
  const route = under.current;
  const last = useRef<View>('cards');
  const view: View = route.view === 'landing' || route.view === 'settings' ? last.current : route.view;
  last.current = view;
  const [consoleUp, setConsoleUp] = useState(view === 'console');
  const [world, setWorld] = useState<WorldState | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [linesIn, setLinesIn] = useState(false);
  const [chatOpen, setChatOpen] = useState(hp.has('chat'));
  const [target, setTarget] = useState<Target>({ kind: 'assistant' });
  const [focusKey, setFocusKey] = useState(0);
  const [sheet, setSheetId] = useState<string | null>(hp.get('open'));
  const [focus, setFocus] = useState<string | null>(hp.get('line'));
  const [tick, setTick] = useState(0);
  const [online, setOnline] = useState(true);
  const { toasts, push } = useToasts();
  const refresh = useRef<number>();
  const [dim, setDim] = useState<Dim>('2d');
  const [from3d, setFrom3d] = useState<MapView | null>(null);
  const [want3d, setWant3d] = useState(false);
  const mapApi = useRef<MapApi | null>(null);
  const hash3d = useRef(hp.has('3d') || (getSettings().start === '3d' && !hp.has('open') && view === 'world'));
  const st = useSettings();
  const openSettings = useCallback(() => { cameIn.current = true; go('/settings'); }, []);
  const closeSettings = useCallback(() => {
    if (cameIn.current) history.back();
    else go(leaveTo.current, true);
    cameIn.current = false;
  }, []);
  const setSheet = useCallback((id: string | null, lineId?: string | null) => {
    setSheetId(id);
    setFocus(lineId ?? null);
  }, []);

  const load = useCallback(() => {
    clearTimeout(refresh.current);
    refresh.current = window.setTimeout(() => {
      api.world().then(setWorld).catch(() => {});
      api.lines().then(ls => { setLines(ls); setLinesIn(true); }).catch(() => {});
    }, 200);
  }, []);

  useEffect(() => {
    api.world().then(setWorld).catch(e => push(tr('连不上服务器：{0}', e.message)));
    api.lines().then(ls => { setLines(ls); setLinesIn(true); }).catch(() => {});
  }, [push]);

  useEffect(() => subscribe(e => {
    if (e.type === 'line') {
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

  // the floating assistant, opened to ask it, to write a new idea, or to rewrite a waiting one
  const openDock = useCallback((t: Target) => {
    setChatOpen(true);
    setTarget(t);
    setFocusKey(k => k + 1);
  }, []);

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      load();
      return true;
    } catch (e) {
      push((e as Error).message);
      return false;
    }
  }
  const onIdea = async (text: string, budget: number) =>
    (await act(() => api.idea(text, budget))) && (push(tr('孵化员去图书馆和 arXiv 查重了，结果出来后在「进展」里决定。')), true);
  const onAdjust = async (lineId: string, text: string) =>
    (await act(() => api.adjust(lineId, text))) && (push(tr('孵化员按改过的 idea 重新查重了。')), true);

  const hatch = (id: string) => act(() => api.hatch(id));
  const resume = (id: string) => act(() => api.resume(id));
  const newIdea = () => openDock({ kind: 'idea' });
  const askAt = (_id: string, name: string) => openDock({ kind: 'assistant', draft: tr('关于{0}：', name) });
  const adjust = (id: string) => {
    const l = lines.find(x => x.id === id);
    if (l) openDock({ kind: 'adjust', line: { id, seq: l.seq, idea: l.idea } });
  };
  const decide = { onHatch: hatch, onResume: resume, onAdjust: adjust };

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
  const room = (id: string, lineId?: string | null) => openRoom(id, lineId);
  const sheetRef = useRef(sheet);
  sheetRef.current = sheet;
  const leaveRoom = useCallback(() => {
    setLeaving(true);
    clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => { setSheet(null); setLeaving(false); setSwap(0); }, 460);
  }, [setSheet]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === ',' && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(e)) {
        e.preventDefault();
        if (settingsOpen) closeSettings();
        else openSettings();
        return;
      }
      if (e.key !== 'Escape') return;
      if (settingsOpen) return;
      if (chatOpen) setChatOpen(false);
      else if (sheet) leaveRoom();
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [sheet, chatOpen, settingsOpen, leaveRoom, openSettings, closeSettings]);

  useEffect(() => holdEscape(dim === '3d' && (!!sheet || chatOpen || settingsOpen)), [dim, sheet, chatOpen, settingsOpen]);

  // any [data-open] element outside the map and console opens that building; data-line picks the project
  function onRootClick(e: React.MouseEvent) {
    const t = e.target as Element;
    const el = t.closest('[data-open]');
    if (!el || t.closest('.p-world, .p-console')) return;
    const r = el.getBoundingClientRect();
    openRoom(el.getAttribute('data-open')!, el.getAttribute('data-line'), { x: r.left + r.width / 2, y: r.top + r.height / 2 });
  }

  const root = useRef<HTMLDivElement>(null);
  const tabs = useRef<HTMLElement>(null);
  // lock: pointer lock and full screen must be requested inside the click (user-gesture requirement)
  const go3d = useCallback((lock = true) => {
    if (dim !== '2d') return;
    if (lock) {
      enterFull();
      (root.current?.requestPointerLock?.() as Promise<void> | undefined)?.catch?.(() => {});
    }
    setChatOpen(false);
    setFrom3d(mapApi.current?.view() ?? null);
    setWant3d(true);
    setDim('to3d');
  }, [dim]);
  const go2d = useCallback(() => {
    if (dim !== '3d') return;
    leaveFull();
    setChatOpen(false);
    setDim('to2d');
  }, [dim]);
  useEffect(() => {
    if (world && hash3d.current) { hash3d.current = false; go3d(false); }
  }, [world, go3d]);
  // the console leaves the 3D walk
  useEffect(() => {
    if (view !== 'console') return;
    setConsoleUp(true);
    go2d();
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps

  const openProject = useCallback((lineId: string, t: { mod?: string; file?: string; job?: string } = {}) => {
    const seq = lines.find(l => l.id === lineId)?.seq;
    const mod = t.mod ?? (t.job ? 'exp' : t.file?.startsWith('paper:') ? 'paper' : t.file ? 'code' : 'overview');
    const wasUp = consoleUp;
    go(seq ? `/console/${seq}/${mod}` : PATHS.console);
    if (t.file || t.job) setTimeout(() => dispatchEvent(new CustomEvent('pt-show', { detail: { line: lineId, file: t.file, job: t.job } })), wasUp ? 80 : 400);
  }, [lines, consoleUp]);
  const onPlace = useCallback((seq: number, mod: string) => {
    if (route.view === 'console') go(`/console/${seq}/${mod}`, true);
  }, [route.view]);

  // what the assistant opens is in the console: from 进展 or the map, go there first, then show it
  const here = useRef({ view, lines, up: consoleUp });
  here.current = { view, lines, up: consoleUp };
  useEffect(() => {
    const away = (t: ShowTarget) => {
      const { view: v, lines: ls, up } = here.current;
      const l = t.line ? ls.find(x => x.id === t.line || `#${x.seq}` === t.line || String(x.seq) === t.line) : undefined;
      if (t.ref?.startsWith('node:') && l) { // a node on a project's research loop: go there, and the loop opens it
        const to = `/progress/${l.seq}/loop`, there = location.pathname.endsWith(to) || location.pathname.endsWith(`/progress/${l.seq}/canvas`);
        if (!there) go(to);
        setTimeout(() => dispatchEvent(new CustomEvent('pt-canvas-show', { detail: t.ref!.slice(5) })), there ? 0 : 900);
        return;
      }
      if (v === 'console') return;
      go(l ? `/console/${l.seq}` : boardAt.current);
      setTimeout(() => dispatchEvent(new CustomEvent('pt-show', { detail: { ...t, again: true } })), up ? 80 : 400);
    };
    const on = (e: Event) => { const d = (e as CustomEvent<ShowTarget & { again?: boolean }>).detail; if (d && !d.again) away(d); };
    addEventListener('pt-show', on);
    const off = listen(e => { if (e.type === 'assistant_show') away(e.target ?? {}); });
    return () => { removeEventListener('pt-show', on); off(); };
  }, []);
  // the page the assistant is told you are on, outside the console (which says so itself)
  useEffect(() => {
    if (view === 'console') return;
    const l = route.view === 'cards' && route.seq ? lines.find(x => x.seq === route.seq) : undefined;
    const canvas = route.view === 'cards' && route.sub === 'canvas' && !!l;
    setPlace(l ? { id: l.id, seq: l.seq, title: l.title } : null, canvas ? 'canvas' : view === 'cards' ? 'progress' : 'town',
      canvas ? tr('研究回路') : view === 'cards' ? tr('进展') : tr('小镇地图'));
  }, [view, route, lines]);

  // commands from the macOS app's menus (macos/)
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ type?: string; view?: string; text?: string }>).detail ?? {};
      if (d.type === 'settings') openSettings();
      else if (d.type === 'view' && (d.view === 'cards' || d.view === 'console' || d.view === 'world')) go(d.view === 'console' ? boardAt.current : PATHS[d.view]);
      else if (d.type === 'toast' && d.text) push(d.text);
    };
    addEventListener('papertown:command', on);
    return () => removeEventListener('papertown:command', on);
  }, [push, openSettings]);

  const [hint, setHint] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setHint(false), 9000);
    const k = (e: KeyboardEvent) => { if (/^(Arrow|Key[WASD])/.test(e.code)) setHint(false); };
    addEventListener('keydown', k);
    return () => { clearTimeout(t); removeEventListener('keydown', k); };
  }, []);

  // --tx/--tw place the macOS look's sliding pill under the open tab
  useLayoutEffect(() => {
    const nav = tabs.current!;
    const place = () => {
      const on = nav.querySelector<HTMLElement>('a.on')!;
      nav.style.setProperty('--tx', `${on.offsetLeft}px`);
      nav.style.setProperty('--tw', `${on.offsetWidth}px`);
    };
    place();
    const watch = new ResizeObserver(place);
    watch.observe(nav);
    return () => watch.disconnect();
  }, [view]);

  const mode: Mode = view === 'console' ? 'board' : dim === '3d' || dim === 'to3d' ? '3d' : '2d';
  function show(m: Mode) {
    if (m === 'board') go(boardAt.current);
    else if (view !== 'world') { go(PATHS.world); if (m === '3d') go3d(); }
    else if (m === '3d') go3d();
    else go2d();
  }

  const hud = world?.hud;
  const walking = !sheet && view === 'world' && !chatOpen && !settingsOpen;
  const running = world?.running ?? [];

  return (
    <div ref={root} className={`proto la theme-sketch${chatOpen ? ' chat-open' : ''}${sheet && !leaving ? ' in-room' : ''}${dim !== '2d' ? ' in-3d' : ''}${st.motion === 'calm' ? ' calm' : ''}`} data-mode={view} onClick={onRootClick}
      style={{ ['--grain-k' as string]: st.grain, ...(door ? { ['--ox' as string]: `${door.x}px`, ['--oy' as string]: `${door.y}px` } : {}) }}>
      {world && <WorldMap placements={world.placements} notes={notes} active={walking && dim === '2d'}
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
      <Progress active={view === 'cards' && !covered} seq={route.view === 'cards' ? route.seq : undefined} sub={route.view === 'cards' ? route.sub : undefined} page={route.view === 'cards' ? route.page : undefined} toast={push} onOpen={openProject}
        decide={decide} />
      {consoleUp && (
        <Console active={view === 'console' && !covered} at={route.view === 'console' ? route : undefined} onPlace={onPlace}
          lines={lines} ready={linesIn} placements={world?.placements ?? []} tick={tick} toast={push}
          onRoom={room} onIdea={newIdea} onAsk={askAt} onHatch={hatch} onResume={resume} onAdjust={adjust} />
      )}

      <header className="hud">
        <a className="brand" href={href('/')} onClick={e => follow(e, '/')} title={tr('回到首页')}><Logo /><b>Papertown</b></a>
        <nav className="seg" ref={tabs} aria-label={tr('视图')}>
          {TABS.map(([t, name, tip]) => {
            const on = (t === 'cards') === (view === 'cards'), to = t === 'cards' ? PATHS.cards : townAt.current;
            return <a key={t} href={href(to)} className={on ? 'on' : ''} aria-current={on ? 'page' : undefined} title={tip} onClick={e => follow(e, to)}>{name}</a>;
          })}
        </nav>
        <div className="seg modes" role="radiogroup" aria-label={tr('怎么看小镇')}>
          {MODES.map(([m, icon, name, tip]) => (
            <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? 'on' : ''} title={tip} aria-label={name} onClick={() => show(m)}>
              <Icon n={icon} size={15} /><span>{name}</span>
            </button>
          ))}
        </div>
        {hud && <div className="hud-quiet">
          <span><b>{hud.lines.running}</b> {tr('个项目在跑')}</span>
          <span>{tr('本周')} <b>${hud.bank.week.toFixed(2)}</b></span>
        </div>}
        <div className="hud-r">
          {hud && <span className={`chip ${!online ? 'bad' : hud.offline ? 'warn' : 'ok'}`} title={hud.offline ? tr('没有配置模型 key，流水线的员工按 skill 的步骤调用真实工具，文字部分用模板；仓库和印刷厂的 pi 用 pi 自己的设置') : hud.model}>
            {!online ? tr('连接断开') : DEMO ? tr('静态演示') : hud.offline ? tr('离线模式') : hud.provider}</span>}
          {DEMO && <RepoLink />}
          <button className="btn hud-gear" title={tr('设置（,）')} aria-label={tr('设置')} onClick={openSettings}><Gear />{tr('设置')}</button>
          <button className={`btn hud-chat${chatOpen ? ' on' : ''}`} title={tr('问这一页的事、请它帮你办，或者写一个新 idea（/）')}
            onClick={() => { if (chatOpen) setChatOpen(false); else { setChatOpen(true); setFocusKey(k => k + 1); } }}>{tr('小助手')}</button>
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

      {dim === '2d' && st.walkHint && <div className={`walk-hint w-only${hint ? '' : ' gone'}`}><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> {tr('走动 · 到门口按')} <kbd>F</kbd> {tr('进去 · 也可以直接点建筑')}</div>}

      <Dock view={view} open={chatOpen} setOpen={setChatOpen} away={!!sheet || (view === 'world' && dim !== '2d')}
        target={target} setTarget={setTarget} focusKey={focusKey} onIdea={onIdea} onAdjust={onAdjust} toast={push} />

      {sheet && (
        <Interior key={`${sheet}:${swap}`} id={sheet} focus={focus} tick={tick} placements={world?.placements ?? []} lines={lines}
          motion={leaving ? 'leave' : swap ? 'swap' : 'enter'} onClose={leaveRoom}
          onOpen={room} onIdea={newIdea} onAsk={askAt} onHatch={hatch} onResume={resume} onAdjust={adjust} toast={push} />
      )}
      {settingsOpen && <SettingsPage section={at.mod} hud={hud ?? null} onClose={closeSettings} />}
      <div className="toasts">{toasts.map(t => <div key={t.id} className="toast">{t.text}</div>)}</div>
      {DEMO && <DemoWelcome />}
    </div>
  );
}
