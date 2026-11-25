// The app behind the landing, in three tabs: progress, agents and the town. The town shows
// each project in detail: the console panels, the 2D map or the 3D walk, with the chat,
// building rooms and settings over them. Hash params open a state directly: #open=<building>[&line=<id>], #chat, #3d.

import { typing } from './components/walk';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, listen, subscribe, type Hud, type Line, type ShowTarget, type WorldState } from './api';
import { Logo } from './art';
import { DemoWelcome, RepoLink } from './components/Demo';
import { Dock } from './components/Dock';
import { Interior } from './components/Interior';
import { Guard } from './components/Guard';
import { SettingsPage } from './components/Settings';
import type { Target } from './console/Assistant';
import { Console } from './console/Console';
import { setPlace } from './console/page';
import { Icon } from './console/icons';
import { Progress } from './progress/Progress';
import { Agents } from './agents/Agents';
import { useOverview } from './agents/overview';
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
const TICK_EVENTS = new Set(['line', 'world', 'building', 'agent', 'library', 'skills']);

function useToasts() {
  const [toasts, setToasts] = useState<{ id: number; text: string; error?: boolean }[]>([]);
  const push = useCallback((text: string, error?: boolean) => {
    const id = Date.now() + Math.random();
    setToasts(t => [...t, { id, text, error }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4200);
  }, []);
  return { toasts, push };
}

const TABS: ['cards' | 'agents' | 'town', string, string][] = [
  ['cards', tr('进展'), tr('每个项目的进展、风险与待你决定的事项，并可与负责人对话')],
  ['agents', tr('员工'), tr('查看员工状态、处理请求并参与对话')],
  ['town', tr('小镇'), tr('每个项目的详情：中控屏面板，或在小镇中漫游')],
];

type Mode = 'board' | '2d' | '3d';
const MODES: [Mode, 'board' | 'map' | 'cube', string, string][] = [
  ['board', 'board', tr('中控屏'), tr('以面板展示各项目详情，全局总览')],
  ['2d', 'map', tr('平面'), tr('小镇平面地图，至建筑门口处理事项')],
  ['3d', 'cube', tr('3D 漫游'), tr('在 3D 小镇中漫游，立足当前位置')],
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
// The colour of the HUD's lead count: green when every lead that is on is running, orange while some are still
// starting, red when one should run and cannot, grey when no project in progress has its lead on.
function leadTone(h: Hud): { tone: 'ok' | 'warn' | 'bad' | 'off'; tip: string } {
  const { on, running, blocked = 0 } = h.leads;
  if (!on) return { tone: 'off', tip: h.lines.running ? tr('进行中的项目都没有开启常驻负责人') : tr('目前没有进行中的项目') };
  if (blocked) return { tone: 'bad', tip: tr('{0} 位负责人无法运行，需要处理', blocked) };
  if (running < on) return { tone: 'warn', tip: tr('{0} 位负责人正在启动', on - running) };
  return { tone: 'ok', tip: tr('开启常驻的 {0} 位负责人都在运行', on) };
}

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
  const { data: overview } = useOverview();
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
    api.world().then(setWorld).catch(e => push(tr('无法连接服务器：{0}', e.message), true));
    api.lines().then(ls => { setLines(ls); setLinesIn(true); }).catch(() => {});
  }, [push]);
  // The subscriptions' quotas are read when the page opens and on the refresh button only. Their CLIs may ask to sign
  // in again, so the server never reads them on its own.
  useEffect(() => { api.refreshUsage().catch(() => {}); }, []);

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
    if (running) n.mill = tr('{0} 个项目运行中', running);
    return n;
  }, [world]);

  // The floating assistant, opened for a question or a new idea.
  const openDock = useCallback((t: Target) => {
    setChatOpen(true);
    setTarget(t);
    setFocusKey(k => k + 1);
  }, []);

  const onIdea = async (text: string) => {
    try {
      const line = await api.idea(text);
      load();
      setSheet(null);
      push(tr('项目 #{0} 已创建，负责人正在启动。', line.seq));
      setChatOpen(false);
      go(`/progress/${line.seq}`);
      return true;
    } catch (e) { push((e as Error).message, true); return false; }
  };
  const newIdea = () => openDock({ kind: 'idea' });
  const askAt = async (id: string, name: string) => {
    const draft = tr('关于{0}：', name);
    const q = new URLSearchParams({ draft });
    try {
      const staff = await api.staffAt(id);
      if (staff.who === 'lead' && staff.line) { setSheet(null); setChatOpen(false); go(`/progress/${staff.line.seq}/ask?${q}`); return; }
      if ((staff.who === 'coder' || staff.who === 'writer') && staff.agent) { setSheet(null); setChatOpen(false); go(`/agents/${encodeURIComponent(staff.agent.id)}?${q}`); return; }
    } catch { /* The assistant remains available when staff lookup fails. */ }
    openDock({ kind: 'assistant', draft });
  };

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
    if (route.view === 'console' && (route.seq !== seq || route.mod !== mod)) go(`/console/${seq}/${mod}`, true);
  }, [route.view, route.seq, route.mod]);

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
    const pages = { canvas: tr('研究回路'), decided: tr('你的决定'), prov: tr('溯源'), ask: tr('对话'), pages: tr('汇报与讲解') };
    const sub = l && route.sub;
    setPlace(l ? { id: l.id, seq: l.seq, title: l.title } : null, sub || (view === 'cards' ? 'progress' : view === 'agents' ? 'agents' : 'town'),
      sub ? pages[sub] : view === 'cards' ? tr('进展') : view === 'agents' ? tr('员工') : tr('小镇地图'));
  }, [view, route, lines]);

  // commands from the macOS app's menus (macos/)
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ type?: string; view?: string; text?: string }>).detail ?? {};
      if (d.type === 'settings') openSettings();
      else if (d.type === 'view' && (d.view === 'cards' || d.view === 'agents' || d.view === 'console' || d.view === 'world')) go(d.view === 'console' ? boardAt.current : PATHS[d.view]);
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
  const leads = hud && leadTone(hud);
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
      <Guard key={`cards:${route.view === 'cards' ? `${route.seq ?? ''}/${route.sub ?? ''}/${route.page ?? ''}` : ''}`}><Progress active={view === 'cards' && !covered} seq={route.view === 'cards' ? route.seq : undefined} sub={route.view === 'cards' ? route.sub : undefined} page={route.view === 'cards' ? route.page : undefined} toast={push} onOpen={openProject} /></Guard>
      {view === 'agents' && <Guard key={`agents:${route.agent ?? ''}`}><Agents id={route.agent} active={!covered && !settingsOpen} lines={lines} toast={push} /></Guard>}
      {consoleUp && (
        <Guard key={`console:${route.view === 'console' ? `${route.seq ?? ''}/${route.mod ?? ''}` : ''}`}><Console active={view === 'console' && !covered} at={route.view === 'console' ? route : undefined} onPlace={onPlace}
          lines={lines} ready={linesIn} placements={world?.placements ?? []} tick={tick} toast={push}
          onRoom={room} onIdea={newIdea} onAsk={askAt} /></Guard>
      )}

      <header className="hud">
        <a className="brand" href={href('/')} onClick={e => follow(e, '/')} title={tr('返回首页')}><Logo /><b>Papertown</b></a>
        <nav className="seg" ref={tabs} aria-label={tr('视图')}>
          {TABS.map(([t, name, tip]) => {
            const on = t === 'town' ? view === 'console' || view === 'world' : view === t, to = t === 'town' ? townAt.current : PATHS[t];
            return <a key={t} href={href(to)} className={on ? 'on' : ''} aria-current={on ? 'page' : undefined} title={tip} onClick={e => follow(e, to)}>{name}</a>;
          })}
        </nav>
        <div className="seg modes" role="radiogroup" aria-label={tr('查看方式')}>
          {MODES.map(([m, icon, name, tip]) => (
            <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? 'on' : ''} title={tip} aria-label={name} onClick={() => show(m)}>
              <Icon n={icon} size={15} /><span>{name}</span>
            </button>
          ))}
        </div>
        {hud && leads && <div className="hud-quiet">
          <span className={hud.lines.running ? 'hq-live' : undefined}><b>{hud.lines.running}</b> {tr('个项目进行中')}</span>
          <span className={`hq-leads hq-${leads.tone}`} title={leads.tip}>
            <i className="hq-dot" aria-hidden="true" /><b className={hud.leads.on ? 'em-num' : undefined} data-tone={hud.leads.running < hud.leads.on ? 'warn' : 'info'}>{hud.leads.running}/{hud.leads.on}</b> {tr('位负责人在岗')}</span>
        </div>}
        <div className="hud-r">
          {!!overview?.counts.needs && <a className="aw-count em-bar" data-tone="warn" href={href('/agents?f=needs')} onClick={e => follow(e, '/agents?f=needs')}>{tr('待处理 {0}', overview.counts.needs)}</a>}
          {hud && <span className={!online ? 'hq-connection em-state small' : 'hq-connection muted small'} data-tone="bad">
            {!online ? tr('连接已断开') : DEMO ? tr('静态演示') : tr('已连接')}</span>}
          {DEMO && <RepoLink />}
          <button className="btn hud-gear" title={tr('设置（,）')} aria-label={tr('设置')} onClick={openSettings}><Gear />{tr('设置')}</button>
          <button className={`btn hud-chat${chatOpen ? ' on' : ''}`} title={tr('询问本页内容、交由小助手处理，或输入新 idea（/）')}
            onClick={() => { if (chatOpen) setChatOpen(false); else { setChatOpen(true); setFocusKey(k => k + 1); } }}>{tr('小助手')}</button>
        </div>
      </header>

      {running.length > 0 && (
        <aside className="running w-only">
          {running.map((r, i) => (
            <div key={r.id} className="rn" style={{ ['--i' as string]: i }} data-open={r.mill_id ?? r.building} data-line={r.id}>
              <div>
                <b>#{r.seq} {r.title}</b>
                <div className="rn-row">{r.stage} <span className="em-num">{r.pct}%</span><div className="bar"><i style={{ width: `${r.pct}%` }} /></div></div>
              </div>
            </div>
          ))}
        </aside>
      )}

      {dim === '2d' && st.walkHint && <div className={`walk-hint w-only${hint ? '' : ' gone'}`}><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> {tr('移动 · 至门口按')} <kbd>F</kbd> {tr('进入 · 也可直接点击建筑')}</div>}

      <Dock view={view} open={chatOpen} setOpen={setChatOpen} away={!!sheet || (view === 'world' && dim !== '2d')}
        target={target} setTarget={setTarget} focusKey={focusKey} onIdea={onIdea} toast={push} />

      {sheet && (
        <Interior key={`${sheet}:${swap}`} id={sheet} focus={focus} tick={tick} placements={world?.placements ?? []} lines={lines}
          motion={leaving ? 'leave' : swap ? 'swap' : 'enter'} onClose={leaveRoom}
          onOpen={room} onIdea={newIdea} onAsk={askAt} toast={push} />
      )}
      {settingsOpen && <Guard key={`settings:${at.mod ?? ''}`} onClose={closeSettings}><SettingsPage section={at.mod} hud={hud ?? null} onClose={closeSettings} /></Guard>}
      <div className="toasts">{toasts.map(t => <div key={t.id} className="toast"><span role={t.error ? 'alert' : 'status'} className={t.error ? 'em-state' : undefined} data-tone="bad">{t.text}</span></div>)}</div>
      {DEMO && <DemoWelcome />}
    </div>
  );
}
