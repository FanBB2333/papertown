// 进展 as rows: a project to a line, in the columns you picked. It never scrolls sideways: when the
// columns do not fit the width, a project folds in two, the parts under its name.

import { useEffect, useRef, useState } from 'react';
import type { Pane, PaseoDefaults, ProjectCard } from '../api';
import { StatusTag } from '../components/MillRoom';
import { Icon } from '../console/icons';
import { tr } from '../i18n';
import { UsageMark } from '../usage/Usage';
import { AskButton, CardPane, opens, PANES, Stages, UpdateButton, useCardActs, Who } from './parts';

export interface Group { key: string; name: string; items: ProjectCard[] }

// each column: the least it can be, and its share of what is left
const COLS: Record<Pane, [number, number]> = {
  summary: [230, 2.4], attention: [160, 1.6], milestone: [150, 1.4], metrics: [220, 1.6], running: [150, 1.3],
  planned: [130, 1.1], outputs: [140, 1.2], code: [170, 1.3], paper: [170, 1.3], memory: [140, 1],
};
const NAME = 220, STAGE = 136, ACTS = 176, GAP = 14, PAD = 38;

type Props = { defs: PaseoDefaults | null; toast: (t: string) => void; onChange: (r: ProjectCard) => void };

export function ProjectRows({ groups, cols, ...rest }: { groups: Group[]; cols: Pane[] } & Props) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(box.current!);
    return () => ro.disconnect();
  }, []);
  const need = NAME + STAGE + ACTS + cols.reduce((n, c) => n + COLS[c][0], 0) + GAP * (cols.length + 2) + PAD;
  const folded = w > 0 && w < need;
  const template = `minmax(${NAME}px, 1.5fr) ${STAGE}px ${cols.map(c => `minmax(${COLS[c][0]}px, ${COLS[c][1]}fr)`).join(' ')} max-content`;
  let i = 0;
  return (
    <div ref={box} className={`pg-rows${folded ? ' folded' : ''}`} style={{ ['--cols' as string]: template }} role="table" aria-label={tr('项目')}>
      {!folded && (
        <div className="pr-head" role="row">
          <span role="columnheader">{tr('项目')}</span>
          <span role="columnheader">{tr('工序')}</span>
          {cols.map(c => <span key={c} role="columnheader"><Icon n={PANES[c][2]} size={13} />{PANES[c][1]}</span>)}
          <span role="columnheader" aria-label={tr('操作')} />
        </div>
      )}
      {groups.map(g => (
        <div key={g.key} className="pr-group" role="rowgroup">
          {g.name && <h2 className="pg-gh">{g.name}<span>{g.items.length}</span></h2>}
          {g.items.map(r => <ProjectRow key={r.line.id} r={r} i={i++} cols={cols} {...rest} />)}
        </div>
      ))}
    </div>
  );
}

function ProjectRow({ r, i, cols, defs, toast, onChange }: { r: ProjectCard; i: number; cols: Pane[] } & Props) {
  const acts = useCardActs(r, toast, onChange);
  const { line, card } = r;
  const o = opens(line);
  return (
    <div className={`pr${card ? ` h-${card.health}` : ''}`} style={{ ['--i' as string]: i }} role="row" {...o.box}>
      <div className="pr-name" role="cell">
        <span className="pc-seq">#{line.seq}</span>
        <div className="pr-t">
          {o.title}
          <span className="pr-sub"><StatusTag status={line.status} sample={line.sample} /><UsageMark state={line.usage_state} /><Who r={r} /></span>
        </div>
      </div>
      <div className="pr-stage" role="cell"><Stages r={r} /></div>
      <div className="pr-cells">{cols.map(p => <CardPane key={p} pane={p} r={r} bare />)}</div>
      <div className="pc-acts pr-acts" role="cell" onClick={e => e.stopPropagation()}>
        <AskButton seq={line.seq} />
        <UpdateButton r={r} acts={acts} defs={defs} />
      </div>
    </div>
  );
}
