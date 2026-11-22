// The town in 3D, walked in first person (town3d/engine.ts does the work), flying in from and
// back out to the map's view. Loaded on demand, so the map does not carry three.js.

import { useEffect, useMemo, useRef, useState } from 'react';
import { BUILDINGS } from '@design/sprites.js';
import { placementName, renderMap } from '@design/world.js';
import { api, type Placement } from '../api';
import { leaveFull } from '../fullscreen';
import { useSettings } from '../settings';
import { Engine, type Mode, type Target } from '../town3d/engine';
import type { HallData } from '../town3d/halls';
import '../town3d.css';
import { where, type MapView } from './WorldMap';
import { tr } from '../i18n';

type Phase = 'enter' | 'live' | 'leave' | 'off';

interface Props {
  placements: Placement[];
  notes: Record<string, string>;
  phase: Phase;
  from: MapView | null; // where the map was looking when 3D was asked for
  active: boolean; // walking (no room, chat or status view in front)
  onOpen: (id: string, at: { x: number; y: number }, line?: string | null) => void;
  onCovered: () => void; // the 3D town now fully covers the map
  onLeft: (v: MapView) => void; // back at the map's angle over you: the map can take over
  onLeave: () => void; // asked from inside the town (M) to go back to the map
  onFail: (msg: string) => void;
}

const FADE = 450;
const MINI_VB = '-800 -140 1600 940';

// what a building's hall is built from: its sheet and the projects, plus what its machines show
async function hallData(pl: Placement): Promise<HallData> {
  const t = pl.type, soft = <T,>(p: Promise<T>) => p.catch(() => null);
  const [sheet, lines, board, gpus, shelf, roster] = await Promise.all([
    soft(api.building(pl.id)), soft(api.lines()),
    t === 'farm' ? soft(api.jobs()) : null,
    t === 'power' ? soft(api.gpus()) : null,
    t === 'library' ? soft(api.library('', '', 1)) : null,
    t === 'depot' ? soft(api.roster('coder')) : null,
  ]);
  return { sheet, lines: lines ?? [], jobs: board?.jobs ?? [], gpus, shelf, roster };
}

const K = ({ k }: { k: string }) => <kbd>{k}</kbd>;

export default function Town3D({ placements, notes, phase, from, active, onOpen, onCovered, onLeft, onLeave, onFail }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const tags = useRef<HTMLDivElement>(null);
  const marker = useRef<SVGGElement>(null);
  const eng = useRef<Engine | null>(null);
  const cb = useRef({ onOpen, onCovered, onLeft, onLeave, onFail });
  cb.current = { onOpen, onCovered, onLeft, onLeave, onFail };
  const [on, setOn] = useState(false);
  const [target, setTarget] = useState<Target | null>(null);
  const [locked, setLocked] = useState(false);
  const [eyes, setEyes] = useState(false);
  const [help, setHelp] = useState(true);
  const [inside, setInside] = useState<Placement | null>(null);
  const [veil, setVeil] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ fly: false, low: false, third: false, night: false });
  const helpTimer = useRef<number>();
  const st = useSettings();

  useEffect(() => {
    try {
      eng.current = new Engine(host.current!, tags.current!, marker.current, {
        target: setTarget,
        lock: setLocked,
        eyes: setEyes,
        open: (id, at, line) => cb.current.onOpen(id, at, line),
        hall: hallData,
        inside: setInside,
        veil: setVeil,
        mode: setMode,
        leave: () => cb.current.onLeave(),
        moved: () => { if (helpTimer.current === undefined) helpTimer.current = window.setTimeout(() => setHelp(false), 2500); },
      });
    } catch (e) {
      cb.current.onFail(tr('当前设备无法打开 3D 小镇（WebGL 不可用）：{0}', (e as Error).message));
      return;
    }
    return () => { eng.current?.dispose(); eng.current = null; clearTimeout(helpTimer.current); };
  }, []);

  useEffect(() => { eng.current?.setPlaces(placements, notes); }, [placements, notes]);
  useEffect(() => {
    eng.current?.setOptions({ sensitivity: st.sensitivity, invertY: st.invertY, fov: st.fov, hand: st.hand, bob: st.bob, quality: st.quality, calm: st.motion === 'calm', fullscreen: st.fullscreen3d });
  }, [st.sensitivity, st.invertY, st.fov, st.hand, st.bob, st.quality, st.motion, st.fullscreen3d]);
  useEffect(() => { if (!st.fullscreen3d) leaveFull(); }, [st.fullscreen3d]);

  useEffect(() => {
    const e = eng.current;
    if (!e) return;
    if (phase === 'enter' && from) {
      e.enter(from);
      setHelp(true);
      helpTimer.current = undefined;
      requestAnimationFrame(() => setOn(true));
      const t = window.setTimeout(() => { cb.current.onCovered(); e.down(); }, FADE);
      return () => clearTimeout(t);
    }
    if (phase === 'leave') {
      let gone = false;
      e.up().then(v => { if (!gone) cb.current.onLeft(v); });
      return () => { gone = true; };
    }
    if (phase === 'off') {
      setOn(false);
      const t = window.setTimeout(() => e.setShown(false), FADE);
      return () => clearTimeout(t);
    }
  }, [phase, from]);

  useEffect(() => { eng.current?.setActive(active && phase === 'live'); }, [active, phase]);

  const mapKey = placements.map(p => `${p.id}:${p.type}:${p.x}:${p.y}:${p.accent}`).join('|');
  const mini = useMemo(
    () => renderMap({ placements, labels: 'none', anim: false, flows: false, decor: 'none', districts: false, dashes: false, vb: MINI_VB }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mapKey],
  );

  function onMini(ev: React.MouseEvent) {
    const e = eng.current, svg = (ev.currentTarget as HTMLElement).querySelector('svg');
    if (!e || !svg) return;
    const id = (ev.target as Element).closest('[data-id]')?.getAttribute('data-id');
    if (id) { e.toDoor(id); return; }
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX; pt.y = ev.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    e.teleport((p.x / 32 + p.y / 16) / 2, (p.y / 16 - p.x / 32) / 2);
  }

  const pl = target?.kind === 'building' ? target.pl : null, b = pl && BUILDINGS[pl.type];
  const live = phase === 'live' && active && eyes;
  const hot = !!target && (target.kind !== 'building' || target.how === 'look');
  const press = (what: string) => locked && hot ? <>{tr('点击或按')} <K k="F" /> {what}</> : <>{tr('按')} <K k="F" /> {what}</>;
  const chips = [mode.fly && tr('飞行中'), mode.low && tr('下蹲'), mode.third && tr('第三人称'), mode.night && tr('夜晚')].filter(Boolean) as string[];
  return (
    <div ref={host} className={`t3 w-only${on ? ' on' : ''}${locked ? ' locked' : ''}${inside ? ' in-hall' : ''}${st.tags3d ? '' : ' no-tags'}${st.minimap ? '' : ' no-mini'}`}>
      <div ref={tags} className="t3-tags" />
      {live && locked && <div className={`t3-cross${hot ? ' hot' : ''}`} />}
      {live && (inside || chips.length > 0) && (
        <div className="t3-top">
          {inside && <span className="pnl t3-where"><b>{placementName(inside)}</b>{tr('行至门口按')} <K k="F" /> {tr('出去')}</span>}
          {chips.map(c => <span key={c} className="t3-chip">{c}</span>)}
          {mode.fly && <span className="t3-chip soft"><K k={tr('空格')} /> {tr('上升')} · <K k="Ctrl" /> {tr('下降')} · {tr('双击空格降落')}</span>}
        </div>
      )}
      {live && !locked && (
        <div className="pnl t3-resume">
          <b>{tr('点击画面继续漫游')}</b>
          <span>{tr('鼠标锁定画面中心：移动鼠标转动视角，')}<kbd>Esc</kbd> {tr('释放')}</span>
        </div>
      )}
      {live && pl && b && (
        <div className="pnl t3-card" key={pl.id}>
          <b>{placementName(pl)}</b><span>{where(b.district)}</span>
          <p>{b.rep}</p>
          <em>{pl.live ? (pl.tech && pl.tech !== '—' ? `${pl.tech} · ` : '') : tr('尚未接入，进入查看计划 ·')}{press(tr('进去'))}</em>
        </div>
      )}
      {live && target?.kind === 'thing' && (
        <div className="pnl t3-card" key={`${target.thing.title}|${target.thing.sub}`}>
          <b>{target.thing.title}</b>
          <p>{target.thing.sub}</p>
          {target.thing.note && <p className="muted">{target.thing.note}</p>}
          <em>{press(target.thing.act.kind === 'exit' ? tr('返回小镇') : target.thing.verb ?? tr('打开面板'))}</em>
        </div>
      )}
      {live && target?.kind === 'walker' && (
        <div className="pnl t3-card" key={target.walker.key}>
          <b>{target.walker.name}</b>
          <p>{target.walker.rep}</p>
          <em>{press(tr('问候'))}</em>
        </div>
      )}
      {veil !== null && <div className="t3-veil">{veil && <b>{veil}</b>}</div>}
      {live && locked && st.walkHint && (
        <div className={`walk-hint t3-help${help ? '' : ' gone'}`}>
          <span>{tr('移动鼠标环视 ·')} <K k="W" /><K k="A" /><K k="S" /><K k="D" /> {tr('走 ·')} <K k="Shift" /> {tr('跑 ·')} <K k={tr('空格')} /> {tr('跳，双击飞行 ·')} <K k="Ctrl" /> {tr('下蹲')}</span>
          <span>{tr('对准建筑点击或按')} <K k="F" /> {tr('进入 ·')} <K k="V" /> {tr('视角 ·')} <K k="T" /> {tr('昼夜 ·')} <K k="M" /> {tr('返回平面 ·')} <K k="Esc" /> {tr('释放鼠标')}</span>
        </div>
      )}
      <div className="pnl t3-mini" title={tr('点击前往该处，点击建筑前往门口')} onClick={onMini}>
        <div dangerouslySetInnerHTML={{ __html: mini }} />
        <svg className="t3-me" viewBox={MINI_VB} preserveAspectRatio="xMidYMid meet">
          <g ref={marker}><path className="cone" d="M0,0L130,-60A143,143 0 0 1 130,60Z" /><circle r="24" /></g>
        </svg>
      </div>
    </div>
  );
}
