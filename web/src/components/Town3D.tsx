// The town in 3D, walked through your own eyes (town3d/engine.ts does the work). It
// takes over from the map and hands back to it: on the way in the camera starts exactly
// where the map was looking and flies down to where you stand; on the way out it flies
// back up over you and the map appears underneath. Rooms open from the building's door
// as on the map. Loaded on demand, so the map does not carry three.js.

import { useEffect, useMemo, useRef, useState } from 'react';
import { BUILDINGS, DISTRICTS } from '@design/sprites.js';
import { placementName, renderMap } from '@design/world.js';
import type { Placement } from '../api';
import { Engine, type Target } from '../town3d/engine';
import '../town3d.css';
import type { MapView } from './WorldMap';

export type Phase = 'enter' | 'live' | 'leave' | 'off';

interface Props {
  placements: Placement[];
  notes: Record<string, string>;
  phase: Phase;
  from: MapView | null; // where the map was looking when 3D was asked for
  active: boolean; // walking (no room, chat or status view in front)
  onOpen: (id: string, at: { x: number; y: number }) => void;
  onCovered: () => void; // the 3D town now fully covers the map
  onLeft: (v: MapView) => void; // back at the map's angle over you: the map can take over
  onFail: (msg: string) => void;
}

const FADE = 450;
const MINI_VB = '-800 -140 1600 940';

function where(key: string) {
  const d = DISTRICTS[key];
  return d ? (d.dir.includes('↔') ? `${d.name} · ${d.dir}` : d.name) : '';
}

export default function Town3D({ placements, notes, phase, from, active, onOpen, onCovered, onLeft, onFail }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const tags = useRef<HTMLDivElement>(null);
  const marker = useRef<SVGGElement>(null);
  const eng = useRef<Engine | null>(null);
  const cb = useRef({ onOpen, onCovered, onLeft, onFail });
  cb.current = { onOpen, onCovered, onLeft, onFail };
  const [on, setOn] = useState(false);
  const [target, setTarget] = useState<Target | null>(null);
  const [locked, setLocked] = useState(false);
  const [help, setHelp] = useState(true);
  const helpTimer = useRef<number>();

  useEffect(() => {
    try {
      eng.current = new Engine(host.current!, tags.current!, marker.current, {
        target: setTarget,
        lock: setLocked,
        open: (id, at) => cb.current.onOpen(id, at),
        moved: () => { if (helpTimer.current === undefined) helpTimer.current = window.setTimeout(() => setHelp(false), 2500); },
      });
    } catch (e) {
      cb.current.onFail(`这台设备打不开 3D 小镇（WebGL 不可用）：${(e as Error).message}`);
      return;
    }
    return () => { eng.current?.dispose(); eng.current = null; clearTimeout(helpTimer.current); };
  }, []);

  useEffect(() => { eng.current?.setPlaces(placements, notes); }, [placements, notes]);

  // in: show the map's own view in 3D, fade over the map, then fly down to your eyes
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

  // the minimap: the map itself, small and still, with you on it
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

  const pl = target?.pl, b = pl && BUILDINGS[pl.type];
  const live = phase === 'live' && active;
  return (
    <div ref={host} className={`t3 w-only${on ? ' on' : ''}${locked ? ' locked' : ''}`}>
      <div ref={tags} className="t3-tags" />
      {locked && <div className="t3-cross" />}
      {live && pl && b && (
        <div className="pnl t3-card" key={pl.id}>
          <b>{placementName(pl)}</b><span>{where(b.district)}</span>
          <p>{b.rep}</p>
          <em>{pl.live ? (pl.tech && pl.tech !== '—' ? `${pl.tech} · ` : '') : '还没接入，进去看计划 · '}{target!.how === 'hover' ? '点击进入' : <>按 <kbd>E</kbd> 进去</>}</em>
        </div>
      )}
      {live && (
        <div className={`walk-hint t3-help${help ? '' : ' gone'}`}>
          {locked
            ? <>移动鼠标看四周 · <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 走 · <kbd>Shift</kbd> 跑 · <kbd>Esc</kbd> 放开鼠标</>
            : <><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 走 · <kbd>Shift</kbd> 跑 · 拖动画面转头，点一下锁定鼠标 · 到门口按 <kbd>E</kbd> 进去</>}
        </div>
      )}
      <div className="pnl t3-mini" title="点一下就过去；点建筑到它门口" onClick={onMini}>
        <div dangerouslySetInnerHTML={{ __html: mini }} />
        <svg className="t3-me" viewBox={MINI_VB} preserveAspectRatio="xMidYMid meet">
          <g ref={marker}><path className="cone" d="M0,0L130,-60A143,143 0 0 1 130,60Z" /><circle r="24" /></g>
        </svg>
      </div>
    </div>
  );
}
