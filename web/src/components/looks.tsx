// Pickers that show what they choose: the looks, and the macOS look's appearance, accent,
// wallpaper and Liquid Glass. Drawn in CSS (settings.css), so they look the same in every look.

import { Slider } from '@cloudflare/kumo';
import { CardsIcon, CopyIcon, DotsThreeIcon, MagnifyingGlassIcon, ShareFatIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { Sprite } from '../art';
import { useLens } from '../glass';
import { tr } from '../i18n';
import { setSettings, type Accent, type Settings as S, type Wall } from '../settings';

const LOOKS: [S['ui'], string, string][] = [
  ['macos', 'macOS', tr('Liquid Glass、壁纸和系统设置的样子，和 Mac 最搭')],
  ['cloudflare', 'Cloudflare', tr('干净的白底、细线和系统字体')],
  ['paper', tr('纸本'), tr('墨线、水彩和手写字，Papertown 原来的样子')],
];

const ACCENTS: [Accent, string][] = [
  ['blue', tr('蓝色')], ['purple', tr('紫色')], ['pink', tr('粉色')], ['red', tr('红色')],
  ['orange', tr('橙色')], ['yellow', tr('黄色')], ['green', tr('绿色')], ['graphite', tr('石墨色')],
];

const WALLS: [Wall, string][] = [
  ['dawn', tr('晨曦')], ['lagoon', tr('海湾')], ['dusk', tr('暮色')], ['forest', tr('山林')], ['paper', tr('纸镇')], ['graphite', tr('石墨')],
];

function Choice<T extends string>({ value, on, label, className, onPick, children }: {
  value: T; on: boolean; label: string; className: string; onPick: (v: T) => void; children: React.ReactNode;
}) {
  return <button type="button" role="radio" aria-checked={on} aria-label={label} className={`${className}${on ? ' on' : ''}`} onClick={() => onPick(value)}>{children}</button>;
}

function MiniWindow({ look }: { look: S['ui'] }) {
  return (
    <span className={`mw mw-${look}`} aria-hidden="true">
      <span className="mw-bar"><i /><i /><i /></span>
      <span className="mw-side"><i /><i /><i /><i /></span>
      <span className="mw-main"><i /><i /><i /><i /></span>
    </span>
  );
}

export function LookPicker({ s }: { s: S }) {
  return (
    <div className="lk" role="radiogroup" aria-label={tr('界面风格')}>
      {LOOKS.map(([id, name, desc]) => (
        <Choice key={id} value={id} on={s.ui === id} label={name} className="lk-one" onPick={ui => setSettings({ ui })}>
          <MiniWindow look={id} />
          <b>{name}</b><span>{desc}</span>
        </Choice>
      ))}
    </div>
  );
}

export function ModePicker({ s }: { s: S }) {
  const modes: [S['mode'], string][] = [['light', tr('浅色')], ['dark', tr('深色')], ['system', tr('自动')]];
  return (
    <div className="md" role="radiogroup" aria-label={tr('外观')}>
      {modes.map(([id, name]) => (
        <Choice key={id} value={id} on={s.mode === id} label={name} className="md-one" onPick={mode => setSettings({ mode })}>
          <span className={`md-pic md-${id}`} aria-hidden="true"><i /><u><em /><em /><em /></u></span>
          <b>{name}</b>
        </Choice>
      ))}
    </div>
  );
}

export function AccentPicker({ s }: { s: S }) {
  return (
    <div className="ac" role="radiogroup" aria-label={tr('强调色')}>
      {ACCENTS.map(([id, name]) => (
        <span key={id} className="ac-one">
          <Choice value={id} on={s.accent === id} label={name} className={`ac-dot ac-${id}`} onPick={accent => setSettings({ accent })}><i /></Choice>
          {s.accent === id && <em>{name}</em>}
        </span>
      ))}
    </div>
  );
}

export function WallPicker({ s }: { s: S }) {
  return (
    <div className="wp" role="radiogroup" aria-label={tr('壁纸')}>
      {WALLS.map(([id, name]) => (
        <Choice key={id} value={id} on={s.wall === id} label={name} className="wp-one" onPick={wall => setSettings({ wall, wallTint: true })}>
          <span className="wp-pic" style={{ backgroundImage: `var(--wall-${id})` }} aria-hidden="true" />
          <b>{name}</b>
        </Choice>
      ))}
    </div>
  );
}

// something with edges and colour for the glass to bend
export const Scene = () => <div className="gs-scene"><div className="gs-town theme-sketch"><Sprite type="mill" /><Sprite type="press" /><Sprite type="farm" /><Sprite type="depot" /></div></div>;

// the town through three pieces of glass, as the Appearance pane shows a picture through its own
export function GlassStage() {
  const a = useLens<HTMLSpanElement>(), b = useLens<HTMLSpanElement>(), c = useLens<HTMLSpanElement>();
  return (
    <div className="gs" aria-hidden="true">
      <Scene />
      <div className="gs-bar">
        <span ref={a} className="lg-cap"><ShareFatIcon size={17} /><DotsThreeIcon size={19} weight="bold" /></span>
        <span ref={b} className="lg-cap round"><CopyIcon size={17} /></span>
        <span ref={c} className="lg-cap wide"><MagnifyingGlassIcon size={15} />{tr('搜索')}</span>
      </div>
      <p className="gs-note">{tr('欢迎来到 Papertown')}</p>
    </div>
  );
}

// from clear to tinted, as on a Mac. While the knob moves only the page's --g changes; the setting
// is saved when it stops, so dragging doesn't redraw everything that reads the settings
export function GlassSlider({ value }: { value: number }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const live = (n: number) => { setV(n); document.documentElement.style.setProperty('--g', String(n)); };
  return (
    <div className="gc">
      <CardsIcon size={18} aria-hidden="true" />
      <Slider size="sm" value={v} min={0} max={1} step={0.01} getAriaLabel={() => tr('从清透到着色')} onValueChange={n => live(n as number)} onValueCommitted={n => setSettings({ glass: n as number })} />
      <CardsIcon size={18} weight="fill" aria-hidden="true" />
    </div>
  );
}
