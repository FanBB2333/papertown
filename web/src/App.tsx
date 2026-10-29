// Papertown: the world map is home (A). Chat slides in from the side (B), a building
// opens as its production line (C), and the status view (D) sits beside the world.
//
//   #view=status   #open=hatchery   #chat   — open a state directly (screenshots, demos)

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BUILDINGS, DISTRICTS } from '@design/sprites.js';
import { api, subscribe, type Line, type Message, type ServerEvent, type TraceRow, type WorldState } from './api';
import { Item, Logo, Sprite } from './art';
import { Drawer, type Composer, type Tab } from './components/Drawer';
import { Sheet } from './components/Sheet';
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
  const [sheet, setSheet] = useState<string | null>(hp.get('open'));
  const [legend, setLegend] = useState(false);
  const [tick, setTick] = useState(0);
  const [online, setOnline] = useState(true);
  const [asking, setAsking] = useState(false);
  const { toasts, push } = useToasts();
  const refresh = useRef<number>();

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
    } else if (e.type === 'world' && e.built) {
      push('一座新的造纸厂建好了');
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

  // keep the newest mill in view: highlight it while it is working
  const highlight = useMemo(() => {
    const busy = world?.running.find(r => r.status === 'running' && r.mill_id);
    return busy?.mill_id ?? null;
  }, [world]);
  const notes = useMemo(() => {
    const n: Record<string, string> = {};
    for (const r of world?.running ?? []) {
      if (r.mill_id) n[r.mill_id] = r.stage;
      else if (r.status === 'hatching') n.hatchery = '查重中';
      else if (r.status === 'waiting') n.hatchery = '等你决定';
    }
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

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (sheet) setSheet(null);
      else if (chatOpen) setChatOpen(false);
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [sheet, chatOpen]);

  // anything with data-open opens that building (stations, goods, list rows)
  function onRootClick(e: React.MouseEvent) {
    const t = e.target as Element;
    if (t.classList.contains('p-modal')) { setSheet(null); return; }
    const el = t.closest('[data-open]');
    if (el && !t.closest('.p-world')) setSheet(el.getAttribute('data-open'));
  }

  const hud = world?.hud;
  const busy = asking || lines.some(l => l.status === 'hatching');
  const stats: [string, React.ReactNode][] = !hud ? [] : view === 'world' ? [
    ['世界时间', <>第 {hud.day} 天 · {new Date().toTimeString().slice(0, 5)}</>],
    ['银行', <>${hud.bank.week.toFixed(2)} <em>/ ${hud.bank.budget}</em></>],
    ['流水线', <>{hud.lines.running} <em>条运行中</em></>],
    [hud.plant.name, <>{hud.plant.load}% <em>负荷</em></>],
  ] : [
    ['日期', <>{new Date().getMonth() + 1} 月 {new Date().getDate()} 日</>],
    ['本周花费', <>${hud.bank.week.toFixed(2)} <em>/ ${hud.bank.budget}</em></>],
    ['项目', <>{hud.lines.running} <em>个运行中</em></>],
    ['GPU（模拟）', <>{hud.plant.load}% <em>占用</em></>],
  ];
  const ticker = messages.filter(m => m.role !== 'user').slice(-4).reverse().map(m => m.body?.text).filter(Boolean).join(' · ');

  return (
    <div className={`proto la glow theme-paper${chatOpen ? ' chat-open' : ''}`} data-mode={view} onClick={onRootClick}>
      {world && <WorldMap placements={world.placements} highlight={highlight} notes={notes} onOpen={setSheet} />}
      <StatusView tick={tick} active={view === 'status'} />

      <header className="hud pnl">
        <div className="brand"><Logo /><b>Papertown</b></div>
        <div className="seg" role="tablist">
          <button className={view === 'world' ? 'on' : ''} onClick={() => setView('world')}>世界</button>
          <button className={view === 'status' ? 'on' : ''} onClick={() => setView('status')}>运行状态</button>
        </div>
        <div className="hud-stats">{stats.map(([k, v]) => <div key={k}><i>{k}</i><b>{v}</b></div>)}</div>
        <div className="hud-r">
          {hud && <span className={`chip ${!online ? 'bad' : hud.offline ? 'warn' : 'ok'}`} title={hud.offline ? '没有配置模型 key，员工按 skill 的步骤调用真实工具，文字部分用模板' : hud.model}>
            {!online ? '连接断开' : hud.offline ? '离线模式' : hud.provider}</span>}
          <button className="btn" onClick={() => chatOpen ? setChatOpen(false) : openChat()}>对话</button>
          <span className="me">你</span>
        </div>
      </header>

      <div className="lg-bar w-only">
        <button className="btn" onClick={() => setLegend(l => !l)}>图例</button>
        <span className="p-hint pnl">点建筑看流水线 · 拖动平移 · 滚轮缩放</span>
      </div>
      {legend && (
        <aside className="legend pnl w-only">
          <h4>区域</h4>
          {Object.values(DISTRICTS).map(d => <div key={d.name} className="lg-row"><i style={{ background: d.color }} />{d.name}<em>{d.dir}</em></div>)}
          <h4>核心建筑</h4>
          {world?.placements.filter(p => p.core).map(p => (
            <div key={p.id} className="lg-row lg-core" data-open={p.id}><i style={{ background: p.accent ?? BUILDINGS[p.type].accent }} />{p.name}</div>
          ))}
        </aside>
      )}

      <aside className="running pnl w-only">
        <h4>进行中</h4>
        {!world?.running.length && <p className="muted small rn-empty">还没有项目。点左下角放入一颗 idea。</p>}
        {world?.running.map(r => (
          <div key={r.id} className="rn" data-open={r.mill_id ?? r.building}>
            <Sprite type={world.placements.find(p => p.id === (r.mill_id ?? r.building))?.type ?? 'hatchery'} />
            <div>
              <b>#{r.seq} · {r.title}</b>
              <div className="rn-row">{r.status === 'waiting' ? '等你决定' : r.status === 'paused' ? '已暂停' : r.stage}<div className="bar"><i style={{ width: `${r.pct}%` }} /></div></div>
            </div>
          </div>
        ))}
      </aside>

      <button className="newidea btn pri w-only" onClick={() => openChat({ kind: 'idea' }, true)}><Item k="egg" />放入一颗新 idea</button>
      <div className="ticker pnl w-only" onClick={() => setView('status')} title="打开运行状态">
        <b>世界日报</b><span>{ticker || `图书馆馆藏 ${hud?.library ?? 0} 篇 · 写下一个 idea，孵化员会去查重`}</span>
      </div>

      <Drawer open={chatOpen} tab={tab} onTab={setTab} onClose={() => setChatOpen(false)} messages={messages} trace={trace}
        lines={lines} placements={world?.placements ?? []} composer={composer} setComposer={setComposer} focusKey={focusKey}
        busy={busy} onSend={onSend} onOpen={setSheet}
        onHatch={id => act(() => api.hatch(id))} />

      {sheet && (
        <div className="p-modal">
          <Sheet id={sheet} tick={tick} placements={world?.placements ?? []} onClose={() => setSheet(null)} onOpen={setSheet}
            onAsk={(id, name) => openChat({ kind: 'ask', building: id, name }, true)}
            onHatch={id => act(() => api.hatch(id))} onResume={id => act(() => api.resume(id))}
            onAdjust={id => openChat({ kind: 'adjust', lineId: id }, true)} />
        </div>
      )}
      <div className="toasts">{toasts.map(t => <div key={t.id} className="toast pnl">{t.text}</div>)}</div>
    </div>
  );
}
