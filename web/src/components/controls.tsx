// The controls of the settings page and of the progress page's display menu, in Cloudflare's
// components (Kumo): a value from a few is a segmented control, from more a list, on or off a
// switch. Each option of the progress page is written once here, and both places show it.

import { Select, Switch, Tabs } from '@cloudflare/kumo';
import { tr } from '../i18n';
import { setSettings, type Settings as S } from '../settings';

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

export const set = <K extends keyof S>(k: K) => (v: S[K]) => setSettings({ [k]: v } as Partial<S>);

interface Option { key: keyof S; label: string; desc: string; options?: [string, string][]; only?: S['pgView'] }

export const PROGRESS_OPTIONS: Option[] = [
  { key: 'pgSort', label: tr('排序'), desc: tr('项目的先后。等你的在前：要你决定的、卡住的、有风险的依次排在前面'),
    options: [['need', tr('等你的在前')], ['recent', tr('最近更新')], ['progress', tr('进度')], ['number', tr('编号')]] },
  { key: 'pgGroup', label: tr('分组'), desc: tr('把项目分成几段：按状况是等你、卡住了、有风险、在做、已完成，按工序是现在走到哪一步'),
    options: [['none', tr('不分组')], ['state', tr('按状况')], ['stage', tr('按工序')]] },
  { key: 'pgDensity', label: tr('密度'), desc: tr('紧凑：卡片更矮，一行只留一行字'), options: [['roomy', tr('舒适')], ['tight', tr('紧凑')]] },
  { key: 'pgCard', label: tr('卡片宽度'), desc: tr('卡片最窄多宽，决定一排放几张'), options: [['narrow', tr('窄')], ['mid', tr('中')], ['wide', tr('宽')]], only: 'blocks' },
  { key: 'pgText', label: tr('文字大小'), desc: tr('这一页和项目页里所有的字'), options: [['small', tr('小')], ['mid', tr('中')], ['large', tr('大')]] },
  { key: 'pgWidth', label: tr('页面宽度'), desc: tr('大屏幕上内容最宽铺到哪里'), options: [['narrow', tr('窄')], ['mid', tr('标准')], ['full', tr('铺满')]] },
  { key: 'pgStages', label: tr('工序条'), desc: tr('每个项目标题下面那条分段的进度') },
  { key: 'pgDone', label: tr('已完成的项目'), desc: tr('关掉后列表里不放已完成的，点「已完成」时还看得到') },
];

export function OptionControl({ o, s, small }: { o: Option; s: S; small?: boolean }) {
  if (!o.options) return <Switch aria-label={o.label} size={small ? 'sm' : 'base'} checked={s[o.key] as boolean} onCheckedChange={v => setSettings({ [o.key]: v })} />;
  return <Pick label={o.label} small={small} value={s[o.key] as string} options={o.options} onChange={v => setSettings({ [o.key]: v })} />;
}
