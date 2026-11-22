// The progress page's 显示 menu. Card panes are kept on the server and shared by everyone, so every
// card is as tall as the others; row columns, like the rest of the menu, belong to this browser.

import { Button, Checkbox, Popover } from '@cloudflare/kumo';
import { CaretDownIcon, CaretUpIcon } from '@phosphor-icons/react';
import type { CardLayout, Pane } from '../api';
import { OptionControl, PROGRESS_OPTIONS } from '../components/controls';
import { Icon } from '../console/icons';
import { tr } from '../i18n';
import { DEFAULTS, setSettings, type Settings as S } from '../settings';
import { PANE_KEYS, PANES } from './parts';

const PAGE_KEYS = PROGRESS_OPTIONS.map(o => o.key);

export const rowCols = (s: S) => {
  const cols = s.pgCols.filter(c => c in PANES);
  return cols.length ? cols : DEFAULTS.pgCols;
};

function PaneList({ on, onChange }: { on: Pane[]; onChange: (p: Pane[]) => void }) {
  const off = PANE_KEYS.filter(p => !on.includes(p));
  const move = (p: Pane, d: -1 | 1) => {
    const i = on.indexOf(p), x = [...on];
    [x[i], x[i + d]] = [x[i + d], x[i]];
    onChange(x);
  };
  return (
    <ol className="dm-list">
      {on.map((p, i) => (
        <li key={p}>
          <Checkbox label={PANES[p][0]} checked disabled={on.length === 1} onCheckedChange={() => onChange(on.filter(x => x !== p))} />
          <span className="dm-mv">
            <Button variant="ghost" size="xs" shape="square" icon={CaretUpIcon} disabled={i === 0} onClick={() => move(p, -1)} aria-label={tr('上移')} />
            <Button variant="ghost" size="xs" shape="square" icon={CaretDownIcon} disabled={i === on.length - 1} onClick={() => move(p, 1)} aria-label={tr('下移')} />
          </span>
        </li>
      ))}
      {off.map(p => <li key={p} className="off"><Checkbox label={PANES[p][0]} checked={false} onCheckedChange={() => onChange([...on, p])} /></li>)}
    </ol>
  );
}

export function DisplayMenu({ s, layout, onPanes }: { s: S; layout: CardLayout; onPanes: (p: Pane[] | null) => void }) {
  const rows = s.pgView === 'rows';
  const cols = rowCols(s);
  const same = PAGE_KEYS.every(k => s[k] === DEFAULTS[k]) && (rows ? cols.join() === DEFAULTS.pgCols.join() : layout.panes.join() === layout.default.join());
  function reset() {
    setSettings({ ...Object.fromEntries(PAGE_KEYS.map(k => [k, DEFAULTS[k]])), ...(rows ? { pgCols: DEFAULTS.pgCols } : {}) });
    if (!rows) onPanes(null);
  }
  return (
    <Popover.Root>
      <Popover.Trigger render={<button className="btn" title={tr('显示设置')} />}><Icon n="rows" size={14} />{tr('显示')}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} collisionPadding={12}>
          <Popover.Popup className="dm">
            <div className="dm-cols">
              <section>
                <h4>{tr('这一页')}</h4>
                {PROGRESS_OPTIONS.filter(o => !o.only || o.only === s.pgView).map(o => (
                  <div key={o.key} className="dm-row" title={o.desc}><span>{o.label}</span><OptionControl o={o} s={s} small /></div>
                ))}
              </section>
              <section>
                <h4>{rows ? tr('每行的列') : tr('卡片上显示')}</h4>
                <p>{rows ? tr('按从左到右顺序排列。列数过多时，单个项目将折为两层。') : tr('所有卡片显示相同内容以保持等高，按从上到下顺序排列。')}</p>
                {rows ? <PaneList on={cols} onChange={pgCols => setSettings({ pgCols })} /> : <PaneList on={layout.panes} onChange={onPanes} />}
              </section>
            </div>
            <footer>
              <Button size="sm" variant="ghost" disabled={same} onClick={reset}>{tr('恢复默认')}</Button>
              <Popover.Close render={<Button size="sm" variant="primary" />}>{tr('好')}</Popover.Close>
            </footer>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
