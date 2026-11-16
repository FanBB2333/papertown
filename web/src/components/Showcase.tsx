// The style showcase: what the current look is made of, its glass, controls, menus and colours.

import { Badge, Banner, Button, Checkbox, Dialog, Input, Meter, Popover, Radio, Select, Tabs, Tooltip } from '@cloudflare/kumo';
import { CheckCircleIcon, FolderIcon, PlusIcon, TrashIcon, WarningIcon } from '@phosphor-icons/react';
import { useRef, useState } from 'react';
import { bends, useLens } from '../glass';
import { tr } from '../i18n';
import { setSettings, type Settings as S } from '../settings';
import { Card, Note, Range, Row, Toggle } from './controls';
import { LookPicker, Scene } from './looks';

const PLATES: [string, number][] = [[tr('清透'), .18], [tr('标准'), .5], [tr('着色'), .86]];

function Material() {
  const glass = useLens<HTMLDivElement>(30, 72);
  const stage = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ x: .32, y: .5 });
  const follow = (e: React.PointerEvent) => {
    const r = stage.current!.getBoundingClientRect();
    const fit = (v: number) => Math.min(.92, Math.max(.08, v));
    setAt({ x: fit((e.clientX - r.left) / r.width), y: fit((e.clientY - r.top) / r.height) });
  };
  return (
    <>
      <div ref={stage} className="sc-stage" onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); follow(e); }} onPointerMove={e => { if (e.buttons) follow(e); }}>
        <Scene />
        <div ref={glass} className="sc-lens" style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%` }}>{tr('拖动这块玻璃')}</div>
        <div className="sc-plates">
          {PLATES.map(([name, a]) => <span key={name} className="sc-plate" style={{ ['--plate' as string]: a }}>{name}</span>)}
        </div>
      </div>
      <p className="sc-note"><Note>{bends
        ? tr('玻璃的边缘会折射后面的内容，这个效果在 Chrome 和 Edge 里才有；Safari 和 Mac App 里是模糊和高光。')
        : tr('这个浏览器不支持折射，这里是模糊和高光；Chrome 和 Edge 里玻璃的边缘还会折射后面的内容。')}</Note></p>
    </>
  );
}

function Controls() {
  const [on, setOn] = useState(true), [tick, setTick] = useState(true), [pick, setPick] = useState('a'), [tab, setTab] = useState('day'), [v, setV] = useState(60), [list, setList] = useState('need');
  return (
    <>
      <Row label={tr('按钮')}>
        <div className="sc-line">
          <Button variant="primary">{tr('主要')}</Button>
          <Button variant="secondary">{tr('普通')}</Button>
          <Button variant="ghost">{tr('无边框')}</Button>
          <Button variant="destructive" icon={TrashIcon}>{tr('删除')}</Button>
          <Button variant="secondary" shape="square" icon={PlusIcon} aria-label={tr('添加')} />
        </div>
      </Row>
      <Row label={tr('分段控件')}>
        <Tabs variant="segmented" value={tab} onValueChange={setTab} tabs={[{ value: 'day', label: tr('今天') }, { value: 'week', label: tr('本周') }, { value: 'all', label: tr('全部') }]} />
      </Row>
      <Row label={tr('开关和选择')}>
        <div className="sc-line">
          <Toggle label={tr('开关')} value={on} onChange={setOn} />
          <Checkbox aria-label={tr('勾选')} checked={tick} onCheckedChange={setTick} />
          <Radio.Group aria-label={tr('单选')} orientation="horizontal" value={pick} onValueChange={x => setPick(x as string)}>
            <Radio.Legend className="sr-only">{tr('单选')}</Radio.Legend>
            <Radio.Item value="a" label="A" />
            <Radio.Item value="b" label="B" />
          </Radio.Group>
        </div>
      </Row>
      <Row label={tr('滑块')}>
        <Range label={tr('滑块')} value={v} min={0} max={100} fmt={x => `${x}%`} onChange={setV} />
      </Row>
      <Row label={tr('列表')}>
        <Select aria-label={tr('列表')} value={list} items={{ need: tr('等你的在前'), recent: tr('最近更新'), number: tr('编号') }} onValueChange={x => x != null && setList(x as string)} className="kc-select" />
      </Row>
      <Row label={tr('文本框')}><Input aria-label={tr('文本框')} placeholder={tr('写点什么')} className="sc-input" /></Row>
      <Row label={tr('标记和进度')}>
        <div className="sc-line sc-tags">
          <Badge variant="neutral">{tr('普通')}</Badge>
          <Badge variant="info">{tr('进行中')}</Badge>
          <Badge variant="success">{tr('完成')}</Badge>
          <Badge variant="warning">{tr('等你')}</Badge>
          <Badge variant="error">{tr('卡住了')}</Badge>
          <Meter label={tr('进度')} value={62} className="sc-meter" />
        </div>
      </Row>
    </>
  );
}

function Overlays() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Row label={tr('菜单')}>
        <Popover>
          <Popover.Trigger render={<Button variant="secondary" />}>{tr('打开菜单')}</Popover.Trigger>
          <Popover.Content side="bottom" align="end">
            <ul className="sc-menu">
              <li><FolderIcon size={16} />{tr('打开项目')}</li>
              <li><CheckCircleIcon size={16} />{tr('标记完成')}</li>
              <li className="bad"><TrashIcon size={16} />{tr('删除')}</li>
            </ul>
          </Popover.Content>
        </Popover>
      </Row>
      <Row label={tr('提示')}><Tooltip content={tr('把鼠标停在控件上看到的说明')}><Button variant="secondary">{tr('停在这里')}</Button></Tooltip></Row>
      <Row label={tr('对话框')}>
        <Dialog.Root open={open} onOpenChange={setOpen}>
          <Dialog.Trigger render={<Button variant="secondary" />}>{tr('打开对话框')}</Dialog.Trigger>
          <Dialog size="sm" className="st-dlg">
            <Dialog.Title>{tr('这是一个对话框')}</Dialog.Title>
            <Dialog.Description>{tr('需要你确认的事情，都这样问。')}</Dialog.Description>
            <div className="st-btns">
              <Button variant="secondary" onClick={() => setOpen(false)}>{tr('取消')}</Button>
              <Button variant="primary" onClick={() => setOpen(false)}>{tr('好')}</Button>
            </div>
          </Dialog>
        </Dialog.Root>
      </Row>
      <div className="sc-banners">
        <Banner size="sm" variant="alert" icon={<WarningIcon />} description={tr('这样提醒你注意一件事。')} />
      </div>
    </>
  );
}

export function Showcase({ s }: { s: S }) {
  return (
    <>
      <Card title={tr('换一种风格看看')}><LookPicker s={s} /></Card>
      <Card title="Liquid Glass">
        {s.ui === 'macos'
          ? <Material />
          : <div className="sc-off"><Note>{tr('这是 macOS 风格的材质：玻璃会模糊和折射后面的内容。')}</Note><Button variant="secondary" onClick={() => setSettings({ ui: 'macos' })}>{tr('换到 macOS 风格')}</Button></div>}
      </Card>
      <Card title={tr('控件')}><Controls /></Card>
      <Card title={tr('菜单和弹窗')}><Overlays /></Card>
      <Card title={tr('颜色和文字')}>
        <div className="sc-colors">
          {[['brand', tr('强调')], ['success', tr('成功')], ['warning', tr('注意')], ['danger', tr('危险')]].map(([k, n]) => <span key={k} style={{ ['--c' as string]: `var(--color-kumo-${k})` }}><i />{n}</span>)}
        </div>
        <div className="sc-type"><b>{tr('标题的样子')}</b><p>{tr('正文的样子，一段讲清楚一件事。')}</p><small>{tr('次要的说明文字')}</small></div>
      </Card>
    </>
  );
}
