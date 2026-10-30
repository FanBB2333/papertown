// A building from the inside, full screen. The four core buildings have rooms of their
// own: the mill is the base camp for every project, the farm runs and watches the
// experiments, the press and the depot each keep one pi agent per project. Each of them
// opens on its shop floor (Floor: every paper's lane and the agents working it) and has
// the full details one switch away. The other buildings show their production sheet.

import { useState } from 'react';
import { BUILDINGS } from '@design/sprites.js';
import type { Line, Placement } from '../api';
import { Sprite } from '../art';
import { AgentRoom } from './AgentRoom';
import { FarmRoom } from './FarmRoom';
import { Floor, type CoreType } from './Floor';
import { MillRoom } from './MillRoom';
import { Sheet } from './Sheet';
import { tr } from '../i18n';

export interface RoomActions {
  onOpen: (id: string, lineId?: string) => void;
  onIdea: () => void;
  onAsk: (id: string, name: string) => void;
  onHatch: (lineId: string) => void;
  onResume: (lineId: string) => void;
  onAdjust: (lineId: string) => void;
  toast: (text: string) => void;
}

interface Props extends RoomActions {
  id: string;
  motion: 'enter' | 'leave' | 'swap';
  focus: string | null;
  placements: Placement[];
  lines: Line[];
  tick: number;
  onClose: () => void;
}

const ROOMS: Record<string, { title: string; sub: string }> = {
  mill: { title: tr('造纸厂'), sub: tr('大本营：所有项目都在这里立项、排工序、出厂') },
  farm: { title: tr('实验农场'), sub: tr('每个项目的实验任务在这里排队、运行，由看田员盯着进度') },
  press: { title: tr('印刷厂'), sub: tr('每个项目一个写论文的 agent（Paseo 或本机 pi），稿子就在印刷厂的目录里') },
  depot: { title: tr('仓库'), sub: tr('每个项目一个写代码的 agent（Paseo 或本机 pi）：写代码、跑测试，再把实验提交到农场') },
};

export function Interior(p: Props) {
  const pl = p.placements.find(x => x.id === p.id) ?? p.placements.find(x => x.type === p.id);
  const type = pl?.type ?? p.id;
  const room = ROOMS[type];
  // opened for one project (from the running list, another room): straight to its details
  const [view, setView] = useState<'floor' | 'detail'>(p.focus ? 'detail' : 'floor');
  const [picked, setPicked] = useState<string | null>(null);

  if (!room) {
    return (
      <div className={`interior in-sheet m-${p.motion}`} role="dialog" aria-modal="true">
        <Sheet id={p.id} tick={p.tick} placements={p.placements} onClose={p.onClose} onOpen={p.onOpen}
          onAsk={p.onAsk} onHatch={p.onHatch} onResume={p.onResume} onAdjust={p.onAdjust} />
      </div>
    );
  }

  const q = { ...p, focus: picked ?? p.focus };
  const body = view === 'floor' ? <Floor type={type as CoreType} lines={p.lines} tick={p.tick} onPick={id => { setPicked(id); setView('detail'); }} />
    : type === 'mill' ? <MillRoom key={q.focus} {...q} />
      : type === 'farm' ? <FarmRoom key={q.focus} {...q} />
        : <AgentRoom key={q.focus} {...q} role={type === 'press' ? 'writer' : 'coder'} />;

  return (
    <div className={`interior in-${type} m-${p.motion}`} role="dialog" aria-modal="true" style={{ ['--accent' as string]: pl?.accent ?? BUILDINGS[type]?.accent }}>
      <header className="in-head">
        <button className="in-back" onClick={p.onClose}><span aria-hidden>←</span> {tr('回到小镇')} <kbd>Esc</kbd></button>
        <div className="in-title">
          <span className="in-art"><Sprite type={type} label={pl?.label} accent={pl?.accent} /></span>
          <div><h1>{room.title}</h1><p>{room.sub}</p></div>
        </div>
        <div className="seg in-view" role="tablist" title={tr('车间：每个项目的 Agent 在做什么；明细：项目、对话和任务的全部内容')}>
          <button className={view === 'floor' ? 'on' : ''} onClick={() => setView('floor')}>{tr('车间')}</button>
          <button className={view === 'detail' ? 'on' : ''} onClick={() => setView('detail')}>{tr('明细')}</button>
        </div>
        <div className="in-tools">
          {type === 'mill' && <button className="btn pri" onClick={p.onIdea}>{tr('放入一颗新 idea')}</button>}
          <button className="btn" onClick={() => p.onAsk(pl?.id ?? type, room.title)}>{tr('问问这里的员工')}</button>
        </div>
      </header>
      <div className="in-body">{body}</div>
    </div>
  );
}
