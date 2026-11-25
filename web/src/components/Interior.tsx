// A building from the inside, full screen: the four core buildings' rooms (shop floor and details),
// the three configuration rooms, and a production sheet for every other building.

import { Guard } from './Guard';
import { useState } from 'react';
import { BUILDINGS } from '@design/sprites.js';
import type { Line, Placement } from '../api';
import { Sprite } from '../art';
import { AgentRoom } from './AgentRoom';
import { FarmRoom } from './FarmRoom';
import { Floor, type CoreType } from './Floor';
import { McpRoom } from './McpRoom';
import { MillRoom } from './MillRoom';
import { RagRoom } from './RagRoom';
import { Sheet } from './Sheet';
import { SkillRoom } from './SkillRoom';
import { tr } from '../i18n';

export interface RoomActions {
  onOpen: (id: string, lineId?: string) => void;
  onIdea: () => void;
  onAsk: (id: string, name: string) => void;
  toast: (text: string, error?: boolean) => void;
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
  mill: { title: tr('造纸厂'), sub: tr('大本营：所有项目均在此立项、编排工序并出厂') },
  farm: { title: tr('实验农场'), sub: tr('各项目的实验任务在此排队与运行，由看田员监测进度') },
  press: { title: tr('印刷厂'), sub: tr('每个项目一位论文写作 agent（Paseo、终端或本机 pi），文稿位于印刷厂目录') },
  depot: { title: tr('仓库'), sub: tr('每个项目一位编程 agent（Paseo、终端或本机 pi）：编写代码、运行测试，并将实验提交至农场') },
};

// the configuration rooms: one view each, no shop floor
const CONFIG: Record<string, { title: string; sub: string }> = {
  academy: { title: tr('技能学堂'), sub: tr('使用 skim 为各项目与对话配置 skill：全局 → 项目 → 对话，较窄层级覆盖较宽层级') },
  exchange: { title: tr('接线局'), sub: tr('小镇接入的各 MCP server：接通、停用、重连，查看其向员工提供的工具') },
  library: { title: tr('图书馆'), sub: tr('小镇的 RAG：馆藏、检索设置与检索测试') },
};

export function Interior(p: Props) {
  const pl = p.placements.find(x => x.id === p.id) ?? p.placements.find(x => x.type === p.id);
  const type = pl?.type ?? p.id;
  const room = ROOMS[type];
  const conf = CONFIG[type];
  const info = conf ?? room;
  const [view, setView] = useState<'floor' | 'detail'>(p.focus ? 'detail' : 'floor');
  const [picked, setPicked] = useState<string | null>(null);

  if (!info) {
    return (
      <div className={`interior in-sheet m-${p.motion}`} role="dialog" aria-modal="true">
        <Guard onClose={p.onClose}>
          <Sheet id={p.id} tick={p.tick} placements={p.placements} focus={p.focus} onClose={p.onClose} onOpen={p.onOpen}
            onAsk={p.onAsk} />
        </Guard>
      </div>
    );
  }

  const q = { ...p, focus: picked ?? p.focus };
  const body = conf ? (type === 'academy' ? <SkillRoom {...p} /> : type === 'exchange' ? <McpRoom {...p} /> : <RagRoom {...p} />)
    : view === 'floor' ? <Floor type={type as CoreType} lines={p.lines} tick={p.tick} onPick={id => { setPicked(id); setView('detail'); }} />
      : type === 'mill' ? <MillRoom key={q.focus} {...q} />
        : type === 'farm' ? <FarmRoom key={q.focus} {...q} />
          : <AgentRoom key={q.focus} {...q} role={type === 'press' ? 'writer' : 'coder'} />;

  return (
    <div className={`interior in-${type} m-${p.motion}`} role="dialog" aria-modal="true" style={{ ['--accent' as string]: pl?.accent ?? BUILDINGS[type]?.accent }}>
      <header className="in-head">
        <button className="in-back" onClick={p.onClose}><span aria-hidden>←</span> {tr('返回小镇')} <kbd>Esc</kbd></button>
        <div className="in-title">
          <span className="in-art"><Sprite type={type} label={pl?.label} accent={pl?.accent} /></span>
          <div><h1>{info.title}</h1><p>{info.sub}</p></div>
        </div>
        {room && (
          <div className="seg in-view" role="tablist" title={tr('车间查看各项目 Agent 工作状态，明细查看项目、对话与任务全部内容')}>
            <button className={view === 'floor' ? 'on' : ''} onClick={() => setView('floor')}>{tr('车间')}</button>
            <button className={view === 'detail' ? 'on' : ''} onClick={() => setView('detail')}>{tr('明细')}</button>
          </div>
        )}
        <div className="in-tools">
          {type === 'mill' && <button className="btn pri" onClick={p.onIdea}>{tr('放入一颗新 idea')}</button>}
          <button className="btn" onClick={() => p.onAsk(pl?.id ?? type, info.title)}>{tr('向此处员工提问')}</button>
        </div>
      </header>
      <div className="in-body"><Guard key={`${view}:${q.focus ?? ''}`}>{body}</Guard></div>
    </div>
  );
}
