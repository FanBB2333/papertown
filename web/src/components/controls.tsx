// The settings page's and the progress display menu's controls, in Cloudflare's Kumo components.
// The progress page's options are defined once here and shown in both places.

import { LayerCard, Select, Slider, Switch, Tabs, Text } from '@cloudflare/kumo';
import { tr } from '../i18n';
import { setSettings, type Settings as S } from '../settings';

export function Row({ label, desc, children }: { label: string; desc?: string; children?: React.ReactNode }) {
  return (
    <div className="st-row">
      <div className="st-l"><b>{label}</b>{desc && <span>{desc}</span>}</div>
      {children != null && <div className="st-c">{children}</div>}
    </div>
  );
}

export function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <LayerCard className="st-card">
      {title && <LayerCard.Secondary>{title}</LayerCard.Secondary>}
      <LayerCard.Primary>{children}</LayerCard.Primary>
    </LayerCard>
  );
}

export const Note = ({ children }: { children: React.ReactNode }) => <Text variant="secondary" size="sm">{children}</Text>;

export function Pick<T extends string>({ value, options, onChange, label, small }: {
  value: T; options: [T, string][]; onChange: (v: T) => void; label: string; small?: boolean;
}) {
  if (options.length > 3) {
    return (
      <Select aria-label={label} size={small ? 'sm' : 'base'} value={value} onValueChange={v => v != null && onChange(v as T)}
        items={Object.fromEntries(options)} className="kc-select" />
    );
  }
  return <Tabs variant="segmented" size={small ? 'sm' : 'base'} value={value} onValueChange={v => onChange(v as T)} tabs={options.map(([v, l]) => ({ value: v, label: l }))} />;
}

export const Toggle = ({ label, value, onChange, disabled }: { label: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) => <Switch aria-label={label} checked={value} onCheckedChange={onChange} disabled={disabled} />;

export function Range({ label, value, min, max, step, fmt, onChange }: { label: string; value: number; min: number; max: number; step?: number; fmt: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <div className="st-range">
      <Slider size="sm" value={value} min={min} max={max} step={step} getAriaLabel={() => label} onValueChange={v => onChange(v as number)} />
      <output>{fmt(value)}</output>
    </div>
  );
}

export const set = <K extends keyof S>(k: K) => (v: S[K]) => setSettings({ [k]: v } as Partial<S>);

interface Option { key: keyof S; label: string; desc: string; options?: [string, string][]; only?: S['pgView'] }

export const PROGRESS_OPTIONS: Option[] = [
  { key: 'pgSort', label: tr('排序'), desc: tr('项目排序。待处理优先：待你决定、受阻、有风险的依次排在前面'),
    options: [['need', tr('待处理优先')], ['recent', tr('最近更新')], ['progress', tr('进度')], ['number', tr('编号')]] },
  { key: 'pgGroup', label: tr('分组'), desc: tr('将项目分组：按状况为待处理、受阻、有风险、进行中、已完成，按工序为当前阶段'),
    options: [['none', tr('不分组')], ['state', tr('按状况')], ['stage', tr('按工序')]] },
  { key: 'pgDensity', label: tr('密度'), desc: tr('紧凑：减小卡片高度，每行仅显示一行'), options: [['roomy', tr('舒适')], ['tight', tr('紧凑')]] },
  { key: 'pgCard', label: tr('卡片宽度'), desc: tr('卡片最小宽度，决定每行排列数'), options: [['narrow', tr('窄')], ['mid', tr('中')], ['wide', tr('宽')]], only: 'blocks' },
  { key: 'pgText', label: tr('文字大小'), desc: tr('本页及项目页的全部文字'), options: [['small', tr('小')], ['mid', tr('中')], ['large', tr('大')]] },
  { key: 'pgWidth', label: tr('页面宽度'), desc: tr('大屏幕下内容的最大宽度'), options: [['narrow', tr('窄')], ['mid', tr('标准')], ['full', tr('铺满')]] },
  { key: 'pgStages', label: tr('工序条'), desc: tr('各项目标题下方的分段进度条') },
  { key: 'pgDone', label: tr('已完成的项目'), desc: tr('关闭后列表隐藏已完成项目，点击「已完成」仍可查看') },
];

export function OptionControl({ o, s, small }: { o: Option; s: S; small?: boolean }) {
  if (!o.options) return <Switch aria-label={o.label} size={small ? 'sm' : 'base'} checked={s[o.key] as boolean} onCheckedChange={v => setSettings({ [o.key]: v })} />;
  return <Pick label={o.label} small={small} value={s[o.key] as string} options={o.options} onChange={v => setSettings({ [o.key]: v })} />;
}
