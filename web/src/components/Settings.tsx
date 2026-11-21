// The settings page at /settings/<section>, drawn with Kumo whichever look the app has: browser
// settings (settings.ts) and the server's model, agents, access and demo samples.

import { Autocomplete, Badge, Banner, Button, Dialog, Input, LayerCard, Select, Sidebar, Table, Text } from '@cloudflare/kumo';
import { ArrowCounterClockwiseIcon, CodeIcon, GraphIcon, CpuIcon, CubeIcon, FlaskIcon, KeyboardIcon, LockKeyIcon, MagnifyingGlassIcon, MapTrifoldIcon, PaletteIcon, RobotIcon, RowsIcon, SwatchesIcon, XIcon, type Icon as Phosphor } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, listen, type AuthState, type Hud, type Llm, type PaseoDefault, type PaseoInfo, type Roster } from '../api';
import { Logo } from '../art';
import { DEFAULTS, resetSettings, useSettings, type Settings as S } from '../settings';
import { IconRow, Sample } from '../console/EdPicker';
import { ICON_THEMES, THEMES, autoTheme, chooseLook } from '../console/edthemes';
import { Card, Note, OptionControl, Pick, PROGRESS_OPTIONS, Range, Row, set, Toggle } from './controls';
import { AccentPicker, GlassSlider, GlassStage, LookPicker, ModePicker, WallPicker } from './looks';
import { Showcase } from './Showcase';
import { layer } from '../kumo';
import '../settings.css';
import { LANG, LANGS, setLang, tr } from '../i18n';
import { go } from '../route';

// each section: its address, name, what is in it, icon, and the colour of its tile in the macOS look
type Section = 'look' | 'showcase' | 'progress' | 'loop' | 'editor' | 'map' | 'walk' | 'model' | 'agents' | 'access' | 'demo' | 'keys';
const GROUPS: [string, [Section, string, string, Phosphor, string][]][] = [
  [tr('界面'), [
    ['look', tr('外观与动效'), tr('界面风格、明暗、语言和动画'), PaletteIcon, '#5856d6'],
    ['showcase', tr('风格展示'), tr('每种风格的材质、控件和配色'), SwatchesIcon, '#ff2d55'],
    ['progress', tr('进展页'), tr('块或行、排序、分组、密度'), RowsIcon, '#007aff'],
    ['loop', tr('研究回路'), tr('平移缩放、网格、吸附、连线和图例'), GraphIcon, '#34c759'],
    ['editor', tr('编辑器'), tr('颜色主题和文件图标'), CodeIcon, '#af52de'],
  ]],
  [tr('小镇'), [
    ['map', tr('平面地图'), tr('缩放、拖动、建筑名字'), MapTrifoldIcon, '#28a745'],
    ['walk', tr('3D 漫游'), tr('鼠标、视野、手、画质'), CubeIcon, '#30b0c7'],
  ]],
  [tr('模型与员工'), [
    ['model', tr('模型'), tr('小镇员工用的大模型'), CpuIcon, '#ff9500'],
    ['agents', tr('员工 Agent'), tr('Paseo 和本机 pi'), RobotIcon, '#a2845e'],
  ]],
  [tr('系统'), [
    ['access', tr('访问与登录'), tr('手机和其他设备的访问密码'), LockKeyIcon, '#8e8e93'],
    ['demo', tr('展示模式'), tr('样例项目和调研文章'), FlaskIcon, '#e6a700'],
    ['keys', tr('快捷键'), tr('所有按键一览'), KeyboardIcon, '#636366'],
  ]],
];
const SECTIONS = GROUPS.flatMap(g => g[1]);

const Warn = ({ children, bad }: { children: React.ReactNode; bad?: boolean }) => <Banner size="sm" variant={bad ? 'error' : 'alert'} description={children} />;
function Look({ s }: { s: S }) {
  const mac = s.ui === 'macos', flat = s.ui !== 'paper';
  return (
    <>
      <Card title={tr('界面风格')}><LookPicker s={s} /></Card>
      {flat && (
        <Card>
          <Row label={tr('外观')} desc={tr('自动：电脑切到深色，这里也跟着变')}><ModePicker s={s} /></Row>
          {mac && <div className="st-row st-glass">
            <div className="st-l"><b>Liquid Glass</b><span>{tr('拖到左边更清透，拖到右边着色更多，字也更清楚')}</span></div>
            <div className="st-c"><GlassStage /><GlassSlider value={s.glass} /></div>
          </div>}
        </Card>
      )}
      {mac && (
        <Card title={tr('主题')}>
          <Row label={tr('强调色')}><AccentPicker s={s} /></Row>
          <Row label={tr('壁纸')}><WallPicker s={s} /></Row>
          <Row label={tr('窗口背景跟随壁纸着色')} desc={tr('关掉后窗口是纯色，玻璃也更安静')}>
            <Toggle label={tr('窗口背景跟随壁纸着色')} value={s.wallTint} onChange={set('wallTint')} />
          </Row>
        </Card>
      )}
      {s.ui === 'paper' && (
        <Card>
          <Row label={tr('纸纹')} desc={tr('盖在整个页面上的纸张纹理')}>
            <Range label={tr('纸纹')} value={s.grain} min={0} max={1} step={0.05} fmt={v => v ? `${Math.round(v * 100)}%` : tr('关')} onChange={set('grain')} />
          </Row>
        </Card>
      )}
      <Card title={tr('语言与动效')}>
        <Row label={tr('语言')} desc={tr('界面文字的语言，切换后页面会重新载入')}>
          <Pick label={tr('语言')} value={LANG} options={LANGS} onChange={setLang} />
        </Row>
        <Row label={tr('动画')} desc={tr('柔和：动画更短更轻，适合投影或容易晕的时候')}>
          <Pick label={tr('动画')} value={s.motion} options={[['full', tr('完整')], ['calm', tr('柔和')]]} onChange={set('motion')} />
        </Row>
        <Row label={tr('打开页面时')} desc={tr('下次打开页面先看到哪种视图：中控屏是一眼看全的面板，小镇可以平面或 3D')}>
          <Pick label={tr('打开页面时')} value={s.start} options={[['cards', tr('进展')], ['console', tr('小镇 · 中控屏')], ['2d', tr('小镇 · 平面')], ['3d', tr('小镇 · 3D 漫游')]]} onChange={set('start')} />
        </Row>
      </Card>
    </>
  );
}

function ProgressPage({ s }: { s: S }) {
  return (
    <>
      <Card title={tr('项目怎么排')}>
        <Row label={tr('视图')} desc={tr('块是每个项目一张卡片，行是每个项目一行，能顺着一列往下比。进展页上也能直接换')}>
          <Pick label={tr('视图')} value={s.pgView} options={[['blocks', tr('块')], ['rows', tr('行')]]} onChange={set('pgView')} />
        </Row>
        {PROGRESS_OPTIONS.slice(0, 2).map(o => <Row key={o.key} label={o.label} desc={o.desc}><OptionControl o={o} s={s} /></Row>)}
      </Card>
      <Card title={tr('显示')}>
        {PROGRESS_OPTIONS.slice(2).map(o => <Row key={o.key} label={o.label} desc={o.desc}><OptionControl o={o} s={s} /></Row>)}
      </Card>
      <Note>{tr('卡片和每行显示哪些部分，在进展页的「显示」里选。')}</Note>
    </>
  );
}

// the code and paper editors' looks: the same choices as the pick at the top of the editor (⌘K ⌘T)
function Editor({ s }: { s: S }) {
  return (
    <>
      <Card title={tr('颜色主题')}>
        <Note>{tr('代码和论文编辑器的配色，连同文件列表、标签页和状态栏。在编辑器里按 ⌘K ⌘T 可以边看边换')}</Note>
        <div className="st-themes" role="radiogroup" aria-label={tr('颜色主题')}>
          {[autoTheme(), ...THEMES].map(th => (
            <button key={th.id} role="radio" aria-checked={th.id === s.edTheme} className={`st-theme${th.id === s.edTheme ? ' on' : ''}`} onClick={() => chooseLook({ theme: th.id })}>
              <Sample th={th} />
              <span><b>{th.name}</b><em>{th.dark ? tr('深色') : tr('浅色')}</em></span>
            </button>
          ))}
        </div>
      </Card>
      <Card title={tr('文件图标')}>
        <Note>{tr('文件列表和标签页里，文件名前面的图标')}</Note>
        <div className="st-themes" role="radiogroup" aria-label={tr('文件图标')}>
          {ICON_THEMES.map(([id, name, desc]) => (
            <button key={id} role="radio" aria-checked={id === s.edIcons} className={`st-icon${id === s.edIcons ? ' on' : ''}`} onClick={() => chooseLook({ icons: id })}>
              <IconRow id={id} />
              <b>{name}</b><span>{desc}</span>
            </button>
          ))}
        </div>
      </Card>
    </>
  );
}

function LoopSection({ s }: { s: S }) {
  return (
    <>
      <Card title={tr('移动和缩放')}>
        <Row label={tr('触控板双指和滚轮')} desc={tr('平移：双指移动在画布上走，捏合或按住 ⌘ 滚动缩放。缩放：双指移动直接缩放')}>
          <Pick label={tr('触控板双指和滚轮')} value={s.cvScroll} options={[['pan', tr('平移')], ['zoom', tr('缩放')]]} onChange={set('cvScroll')} />
        </Row>
        <Row label={tr('随缩放调整节点')} desc={tr('缩小时字跟着放大、细节收起，远看只留名字和一个数字')}>
          <Toggle label={tr('随缩放调整节点')} value={s.cvAdapt} onChange={set('cvAdapt')} />
        </Row>
      </Card>
      <Card title={tr('网格和吸附')}>
        <Row label={tr('背景')}>
          <Pick label={tr('背景')} value={s.cvBg} options={[['dots', tr('点')], ['lines', tr('网格线')], ['none', tr('空白')]]} onChange={set('cvBg')} />
        </Row>
        <Row label={tr('网格大小')}>
          <Pick label={tr('网格大小')} value={s.cvGap} options={[['16', tr('小')], ['22', tr('中')], ['32', tr('大')]]} onChange={set('cvGap')} />
        </Row>
        <Row label={tr('对齐网格')} desc={tr('拖动节点时一格一格地走')}>
          <Toggle label={tr('对齐网格')} value={s.cvSnapGrid} onChange={set('cvSnapGrid')} />
        </Row>
        <Row label={tr('吸附到其他节点')} desc={tr('拖动节点时，边或中线靠近别的节点就自动对齐，并画出参考线')}>
          <Toggle label={tr('吸附到其他节点')} value={s.cvGuides} onChange={set('cvGuides')} />
        </Row>
        {s.cvGuides && (
          <Row label={tr('吸附距离')} desc={tr('离多近开始吸附，按屏幕上的像素算')}>
            <Range label={tr('吸附距离')} value={s.cvGuideDist} min={4} max={16} step={1} fmt={v => `${v}px`} onChange={set('cvGuideDist')} />
          </Row>
        )}
      </Card>
      <Card title={tr('连线')}>
        <Row label={tr('显示全部连线')} desc={tr('关着时，巡检、规范、边界和升级的线只在指到节点或打开它时出现')}>
          <Toggle label={tr('显示全部连线')} value={s.cvLines} onChange={set('cvLines')} />
        </Row>
        <Row label={tr('连线绕开节点')} desc={tr('线碰到两端以外的节点时，从节点之间的空隙绕过去')}>
          <Toggle label={tr('连线绕开节点')} value={s.cvAvoid} onChange={set('cvAvoid')} />
        </Row>
        <Row label={tr('流动动画')} desc={tr('发出去的任务和正在打回的修补单，线上有流动的虚线')}>
          <Toggle label={tr('流动动画')} value={s.cvMarch} onChange={set('cvMarch')} />
        </Row>
      </Card>
      <Card title={tr('画布上显示')}>
        <Row label={tr('分块')} desc={tr('按「研究流程」的各项给节点加上背景框和标题')}>
          <Toggle label={tr('分块')} value={s.cvLanes} onChange={set('cvLanes')} />
        </Row>
        <Row label={tr('图例')}><Toggle label={tr('图例')} value={s.cvLegend} onChange={set('cvLegend')} /></Row>
        <Row label={tr('小地图')}><Toggle label={tr('小地图')} value={s.cvMap} onChange={set('cvMap')} /></Row>
        <Row label={tr('操作提示')} desc={tr('画布上方那行「双击空白处新建…」')}>
          <Toggle label={tr('操作提示')} value={s.cvHint} onChange={set('cvHint')} />
        </Row>
      </Card>
    </>
  );
}

function MapSection({ s }: { s: S }) {
  return (
    <Card>
      <Row label={tr('顺滑缩放和拖动')} desc={tr('缩放带缓动，松手后地图会顺势滑一小段')}>
        <Toggle label={tr('顺滑缩放和拖动')} value={s.smoothMap} onChange={set('smoothMap')} />
      </Row>
      <Row label={tr('滚轮缩放速度')}>
        <Range label={tr('滚轮缩放速度')} value={s.zoomSpeed} min={0.5} max={2} step={0.1} fmt={v => `${v.toFixed(1)}×`} onChange={set('zoomSpeed')} />
      </Row>
      <Row label={tr('建筑名字')} desc={tr('「主要」只标四座核心建筑和几处地标，「全部」每栋都标')}>
        <Pick label={tr('建筑名字')} value={s.mapLabels} options={[['key', tr('主要')], ['all', tr('全部')]]} onChange={set('mapLabels')} />
      </Row>
      <Row label={tr('走动提示')} desc={tr('地图底部的按键提示')}>
        <Toggle label={tr('走动提示')} value={s.walkHint} onChange={set('walkHint')} />
      </Row>
    </Card>
  );
}

function Walk({ s }: { s: S }) {
  return (
    <>
      <Card title={tr('操作')}>
        <Row label={tr('鼠标灵敏度')} desc={tr('鼠标锁在画面中间时，移动多少转多少')}>
          <Range label={tr('鼠标灵敏度')} value={s.sensitivity} min={0.3} max={3} step={0.05} fmt={v => `${v.toFixed(2)}×`} onChange={set('sensitivity')} />
        </Row>
        <Row label={tr('上下反转')} desc={tr('鼠标往前推是低头')}>
          <Toggle label={tr('上下反转')} value={s.invertY} onChange={set('invertY')} />
        </Row>
        <Row label={tr('全屏漫游')} desc={tr('进入 3D 时自动全屏。开着面板时 Esc 先关面板，没有面板时退出全屏，再点画面继续时回到全屏')}>
          <Toggle label={tr('全屏漫游')} value={s.fullscreen3d} onChange={set('fullscreen3d')} />
        </Row>
      </Card>
      <Card title={tr('画面')}>
        <Row label={tr('视野')} desc={tr('越大看得越广，边缘拉伸也越明显')}>
          <Range label={tr('视野')} value={s.fov} min={55} max={95} step={1} fmt={v => `${v}°`} onChange={set('fov')} />
        </Row>
        <Row label={tr('画质')} desc={tr('低：不画阴影、降低分辨率，老电脑更流畅')}>
          <Pick label={tr('画质')} value={s.quality} options={[['low', tr('低')], ['mid', tr('中')], ['high', tr('高')]]} onChange={set('quality')} />
        </Row>
        <Row label={tr('显示手')} desc={tr('画面右下角你的手和铅笔，走路时会跟着摆')}>
          <Toggle label={tr('显示手')} value={s.hand} onChange={set('hand')} />
        </Row>
        <Row label={tr('走路时晃动')} desc={tr('视角随步子轻轻上下')}>
          <Toggle label={tr('走路时晃动')} value={s.bob} onChange={set('bob')} />
        </Row>
        <Row label={tr('建筑名字')} desc={tr('悬在建筑上方的名字')}>
          <Toggle label={tr('建筑名字')} value={s.tags3d} onChange={set('tags3d')} />
        </Row>
        <Row label={tr('小地图')} desc={tr('右下角的小地图，点一下就过去')}>
          <Toggle label={tr('小地图')} value={s.minimap} onChange={set('minimap')} />
        </Row>
      </Card>
    </>
  );
}

// a model's name: picked from what the provider lists, or written in
function ModelBox({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <Autocomplete items={options} label={label} value={value} onValueChange={v => onChange(String(v ?? ''))}>
      <Autocomplete.InputGroup />
      <Autocomplete.Content>
        <Autocomplete.List>{(m: string) => <Autocomplete.Item key={m} value={m}>{m}</Autocomplete.Item>}</Autocomplete.List>
      </Autocomplete.Content>
    </Autocomplete>
  );
}

type LlmDraft = Pick<Llm, 'provider' | 'model_strong' | 'model_cheap' | 'effort'>;

function withProvider(llm: Llm, draft: LlmDraft, id: string): LlmDraft {
  const d = llm.providers.find(x => x.id === id);
  return { ...draft, provider: id, model_strong: d?.models[0] ?? '', model_cheap: d?.models[d.models.length > 2 ? 2 : 0] ?? '' };
}

// choosing the town's own model: a new provider first, then what you picked for it
async function applyLlm(llm: Llm, draft: LlmDraft) {
  const changed = draft.provider !== llm.provider;
  const out = await api.setLlm(changed ? { provider: draft.provider } : draft);
  return changed && (draft.model_strong || draft.model_cheap) ? api.setLlm({ model_strong: draft.model_strong, model_cheap: draft.model_cheap, effort: draft.effort }) : out;
}

// the town's own model: the same as the switch in the chat, as a form on the page
function ModelForm({ llm, onDone }: { llm: Llm; onDone: (l: Llm) => void }) {
  const was = { provider: llm.provider, model_strong: llm.model_strong, model_cheap: llm.model_cheap, effort: llm.effort };
  const [draft, setDraft] = useState(was);
  const [err, setErr] = useState('');
  const pv = llm.providers.find(x => x.id === draft.provider);
  const changed = JSON.stringify(draft) !== JSON.stringify(was);
  async function apply() {
    setErr('');
    try { onDone(await applyLlm(llm, draft)); } catch (e) { setErr((e as Error).message); }
  }
  return (
    <div className="st-form">
      <Select label={tr('供应商')} hideLabel={false} value={draft.provider} items={Object.fromEntries(llm.providers.map(x => [x.id, x.name]))} onValueChange={id => setDraft(x => withProvider(llm, x, String(id)))} />
      <ModelBox label={tr('强模型（Lv.3 以上的员工、最终回答）')} value={draft.model_strong} options={pv?.models ?? []} onChange={v => setDraft(x => ({ ...x, model_strong: v }))} />
      <ModelBox label={tr('便宜模型（其余员工）')} value={draft.model_cheap} options={pv?.models ?? []} onChange={v => setDraft(x => ({ ...x, model_cheap: v }))} />
      {draft.provider === 'anthropic' && (
        <Select label="effort" hideLabel={false} value={draft.effort} items={Object.fromEntries(['low', 'medium', 'high', 'xhigh', 'max'].map(x => [x, x]))} onValueChange={v => setDraft(x => ({ ...x, effort: String(v) }))} />
      )}
      <Note>{tr('key 照旧从环境变量读取。切换只在这次运行里有效，重启服务后按环境变量重新决定。')}{draft.provider === 'openai' ? tr(' 接口：{0}', llm.openai_base_url) : ''}</Note>
      {err && <Warn bad>{err}</Warn>}
      <div className="st-btns">
        <Button variant="primary" disabled={!changed} onClick={apply}>{tr('应用')}</Button>
        {changed && <Button onClick={() => setDraft(was)}>{tr('取消')}</Button>}
      </div>
    </div>
  );
}

function Model() {
  const [llm, setLlm] = useState<Llm | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => { api.llm().then(setLlm).catch(() => {}); }, []);
  useEffect(() => listen(e => { if (e.type === 'llm') setLlm(e.llm); }), []);
  if (!llm) return <Note>{tr('读取中…')}</Note>;
  const name = llm.providers.find(x => x.id === llm.provider)?.name ?? llm.provider;
  return (
    <>
      <Card title={tr('现在')}>
        <Row label={name} desc={`${llm.model_strong}${llm.model_cheap !== llm.model_strong ? ` / ${llm.model_cheap}` : ''}`}>
          <Badge variant={llm.offline ? 'warning' : 'success'}>{llm.offline ? tr('离线模式') : tr('在线')}</Badge>
        </Row>
        {llm.offline && <Note>{tr('（离线模式，员工按 skill 的步骤调用工具，文字用模板）')}</Note>}
      </Card>
      <Card title={tr('切换模型')}>
        <ModelForm key={n} llm={llm} onDone={l => { setLlm(l); setN(x => x + 1); }} />
      </Card>
      <Note>{tr('仓库和印刷厂里的代码、写作员工用的是 Paseo 或 pi 自己的模型，在各自的房间里切换。')}</Note>
    </>
  );
}

// what the assistant or a project's lead starts on, picked from what Paseo lists now
const ENV = { assistant: 'PAPERTOWN_ASSISTANT_MODEL', lead: 'PAPERTOWN_LEAD_MODEL' } as const;
function DefaultModel({ role, name, info, onSaved }: { role: 'assistant' | 'lead'; name: string; info: PaseoInfo; onSaved: (i: PaseoInfo) => void }) {
  const d: PaseoDefault = info.defaults?.[role] ?? { provider: null, model: null, thinking: null };
  const was = { provider: d.provider ?? '', model: d.model ?? '', thinking: d.thinking ?? '' };
  const [v, setV] = useState(was);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const pv = info.providers.find(p => p.id === v.provider), m = pv?.models.find(x => x.id === v.model);
  const dp = info.providers.find(p => p.id === d.provider);
  const gone = !!d.provider && (!dp || (!!d.model && !dp.models.some(x => x.id === d.model)));
  const changed = JSON.stringify(v) !== JSON.stringify(was);
  const to = (provider: string, model?: string) => {
    const p = info.providers.find(x => x.id === provider), mm = p?.models.find(x => x.id === model) ?? p?.models[0];
    setV(x => ({ provider, model: mm?.id ?? '', thinking: mm && mm.thinking.includes(x.thinking) ? x.thinking : mm?.default_thinking ?? '' }));
  };
  async function save(o: { provider: string | null; model?: string | null; thinking?: string | null }) {
    setBusy(true);
    setErr('');
    try {
      const defaults = await api.setPaseoDefault(role, o);
      onSaved({ ...info, defaults });
      const n = defaults[role];
      setV({ provider: n.provider ?? '', model: n.model ?? '', thinking: n.thinking ?? '' });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <>
      <Row label={tr('{0}默认用', name)} desc={d.set ? tr('在这里选的，启动时预先选好') : tr('没选过，用环境变量 {0}', ENV[role])}>
        <div className="st-models">
          <Select aria-label={tr('供应商')} size="sm" placeholder={tr('选供应商')} value={v.provider || undefined} items={Object.fromEntries(info.providers.map(p => [p.id, p.label]))} onValueChange={id => to(String(id))} />
          {!!pv?.models.length && <Select aria-label={tr('模型')} size="sm" value={v.model} items={Object.fromEntries(pv.models.map(x => [x.id, x.name]))} onValueChange={id => to(v.provider, String(id))} />}
          {!!m && m.thinking.length > 1 && <Select aria-label={tr('思考强度')} size="sm" value={v.thinking} items={Object.fromEntries(m.thinking.map(x => [x, x]))} onValueChange={t => setV(x => ({ ...x, thinking: String(t) }))} />}
          {changed && <Button size="sm" variant="primary" disabled={busy || !v.provider} onClick={() => save({ provider: v.provider, model: v.model || null, thinking: v.thinking || null })}>{tr('保存')}</Button>}
          {!changed && d.set && <Button size="sm" disabled={busy} onClick={() => save({ provider: null })} title={ENV[role]}>{tr('改回环境变量的')}</Button>}
        </div>
      </Row>
      {gone && !changed && <Warn>{tr('Paseo 里现在没有 {0}，启动时会退回到这个供应商的第一个模型。', [d.provider, d.model].filter(Boolean).join(' / '))}</Warn>}
      {err && <Warn bad>{err}</Warn>}
    </>
  );
}

function Agents() {
  const [paseo, setPaseo] = useState<PaseoInfo | null | 'err'>(null);
  const [pi, setPi] = useState<Roster['available'] | null>(null);
  const [n, setN] = useState(0);
  const [reading, setReading] = useState(false);
  useEffect(() => {
    api.paseo().then(setPaseo).catch(() => setPaseo('err'));
    api.roster('coder').then(r => setPi(r.available)).catch(() => {});
  }, []);
  const again = () => { setReading(true); api.paseo(true).then(i => { setPaseo(i); setN(x => x + 1); }).catch(() => setPaseo('err')).finally(() => setReading(false)); };
  const info = paseo && paseo !== 'err' ? paseo : null, st = info?.status;
  return (
    <>
      <Card title="Paseo">
        <Row label={tr('连接')} desc={tr('托管 Claude Code、Codex、OpenCode 等 agent 的本机守护进程')}>
          <Badge variant={st?.ok ? 'success' : paseo === null ? 'neutral' : 'warning'}>{paseo === null ? tr('检查中…') : st?.ok ? tr('已连接{0}', st.version ? ` · ${st.version}` : '') : tr('未连接')}</Badge>
        </Row>
        {st && !st.ok && <Warn>{st.note}</Warn>}
        {info?.status.ok && (
          <>
            <Row label={tr('网页端')} desc={tr('房间里「完整界面」嵌入的就是它')}>
              <Note>{info.status.web ?? tr('没开：paseo daemon config set features.webUi.enabled true')}</Note>
            </Row>
            <Row label={tr('可用的供应商')} desc={tr('从 Paseo 读出来的，每隔一阵重读一次。有新模型时中控屏会问你要不要换')}>
              <span className="st-tags">
                {info.providers.map(p => <Badge key={p.id} variant="outline">{p.label} · {tr('{0} 个模型', p.models.length)}</Badge>)}
                <Button size="sm" loading={reading} onClick={again}>{reading ? tr('读取中…') : tr('重新读取')}</Button>
              </span>
            </Row>
            <div key={n}>
              <DefaultModel role="assistant" name={tr('小助手')} info={info} onSaved={setPaseo} />
              <DefaultModel role="lead" name={tr('项目负责人')} info={info} onSaved={setPaseo} />
            </div>
          </>
        )}
      </Card>
      <Card title={tr('本机 pi')}>
        <Row label={tr('状态')} desc={tr('跑在 tmux 里的后台终端 agent')}>
          <Badge variant={pi?.ok ? 'success' : pi === null ? 'neutral' : 'warning'}>{pi === null ? tr('检查中…') : pi.ok ? tr('可用') : tr('不可用')}</Badge>
        </Row>
        {pi && !pi.ok && <Warn>{pi.note}</Warn>}
      </Card>
      <Note>{tr('雇员工、导入 Paseo 里已有的对话、切换模型和思考强度，都在仓库和印刷厂的房间里。小助手和项目负责人的默认模型只管以后启动的，已经在跑的保持原样。')}</Note>
    </>
  );
}

function Demo({ hud }: { hud: Hud | null }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  async function seed() {
    setBusy(true);
    setMsg('');
    try {
      const r = await api.samples();
      setMsg(r.note);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <Row label={tr('现在')} desc={tr('没有配置模型 key 时就是展示模式')}>
        <Badge variant={hud?.offline ? 'warning' : 'success'}>{hud ? (hud.offline ? tr('展示模式（离线）') : tr('在线 · {0}', hud.provider)) : '…'}</Badge>
      </Row>
      <Row label={tr('样例项目')} desc={tr('放入几篇写到不同工序的样例论文：有的已出厂，有的停在实验或写作前，有的等你决定孵不孵化')}>
        <Button variant="primary" loading={busy} disabled={!hud?.offline} onClick={seed}>{busy ? tr('放入中…') : tr('放入样例项目')}</Button>
      </Row>
      {!hud?.offline && <Note>{tr('接了模型以后样例也会真的调用模型、花钱，所以只在展示模式里提供。')}</Note>}
      {msg && <Note>{msg}</Note>}
      <Row label={tr('调研文章')} desc={tr('图书馆的馆藏，样例项目查重和写方法时从这里找相近工作')}>
        <Note>{tr('馆藏')} {tr('{0} 篇 · 在小镇里进图书馆翻看', hud?.library ?? '…')}</Note>
      </Row>
    </Card>
  );
}

// who may open the town from elsewhere: the access password, and the devices signed in with it
function Access() {
  const [a, setA] = useState<AuthState | null>(null);
  const [err, setErr] = useState('');
  const [form, setForm] = useState(false);
  const [old, setOld] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => api.authState().then(setA, e => setErr((e as Error).message));
  useEffect(() => { load(); }, []);
  async function run(fn: () => Promise<unknown>, done?: string) {
    setMsg('');
    try { await fn(); await load(); if (done) setMsg(done); return true; } catch (e) { setMsg((e as Error).message); return false; }
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (pw !== pw2) { setMsg(tr('两次输入的不一样')); return; }
    if (await run(() => api.setPassword(pw, a?.local ? undefined : old), tr('访问密码已保存。'))) { setForm(false); setOld(''); setPw(''); setPw2(''); }
  }
  if (err) return <Warn bad>{err}</Warn>;
  if (!a) return <Note>{tr('加载中…')}</Note>;
  return (
    <>
      <Card>
        <Row label={tr('这台设备')} desc={a.local ? tr('运行 Papertown 的电脑：直接就能进') : tr('用访问密码登录的设备')}>
          {!a.local && <Button onClick={() => run(api.logout).then(() => go('/'))}>{tr('退出登录')}</Button>}
        </Row>
        <Row label={tr('访问密码')} desc={a.password ? tr('手机和其他电脑在首页用它登录') : tr('还没有设置：除了这台电脑，别的设备都进不来')}>
          {!form && <Button onClick={() => setForm(true)}>{a.password ? tr('改密码') : tr('设置密码')}</Button>}
        </Row>
        {form && (
          <form className="st-form" onSubmit={save}>
            {!a.local && <Input type="password" autoComplete="current-password" label={tr('现在的密码')} value={old} onChange={e => setOld(e.target.value)} />}
            <Input type="password" autoComplete="new-password" label={tr('新的访问密码（至少 6 位）')} value={pw} onChange={e => setPw(e.target.value)} autoFocus />
            <Input type="password" autoComplete="new-password" label={tr('再输一次')} value={pw2} onChange={e => setPw2(e.target.value)} />
            <div className="st-btns">
              <Button variant="primary" type="submit" disabled={pw.length < 6 || !pw2}>{tr('保存')}</Button>
              <Button type="button" onClick={() => setForm(false)}>{tr('取消')}</Button>
            </div>
          </form>
        )}
        {a.password && (
          <Row label={tr('登录过的设备')} desc={tr('{0} 个设备的登录还在有效期内（30 天）', a.sessions ?? 0)}>
            <Button disabled={!a.sessions} onClick={() => run(api.logoutAll, tr('所有设备都要重新登录了。'))}>{tr('让它们都重新登录')}</Button>
          </Row>
        )}
        {a.local && a.password && (
          <Row label={tr('取消密码')} desc={tr('之后只有这台电脑能打开 Papertown')}>
            <Dialog.Root>
              <Dialog.Trigger render={p => <Button {...p} variant="secondary-destructive">{tr('取消密码')}</Button>} />
              <Dialog size="sm" className="st-dlg">
                <Dialog.Title>{tr('取消访问密码？')}</Dialog.Title>
                <Dialog.Description>{tr('已经登录的设备也会被退出。')}</Dialog.Description>
                <div className="st-btns">
                  <Dialog.Close render={p => <Button {...p}>{tr('保留密码')}</Button>} />
                  <Dialog.Close render={p => <Button {...p} variant="destructive" onClick={() => run(api.clearPassword, tr('访问密码取消了。'))}>{tr('取消密码')}</Button>} />
                </div>
              </Dialog>
            </Dialog.Root>
          </Row>
        )}
        {msg && <Note>{msg}</Note>}
      </Card>
      <Note>{tr('Papertown 默认只在本机监听。要用手机打开，先让它能从网络上访问（比如 tailscale serve 8000），再在手机上用这个密码登录。')}</Note>
    </>
  );
}

const KEYS: [string, string][] = [
  [tr('W A S D / 方向键'), tr('走动（3D 里 ←/→ 转身）')], ['Shift', tr('3D 里跑')],
  [tr('空格'), tr('3D 里跳，连按两下起飞或落地，飞行时按住上升')], ['Ctrl / C', tr('3D 里下蹲，蹲着走到边上不会掉下去。飞行时下降')],
  ['F', tr('进门口或准星对着的建筑，在建筑里打开准星对着的设备')],
  [tr('鼠标'), tr('3D 里转视角，平面上拖动地图、滚轮缩放')], [tr('点击'), tr('平面上进建筑，3D 里和 F 一样')],
  ['V', tr('3D 里切换第一 / 第三人称')], ['T', tr('3D 里切换白天 / 夜晚')],
  ['M', tr('3D 里回到平面')], ['Esc', tr('放开鼠标（全屏时同时退出全屏）/ 关闭对话 / 回到小镇 / 关闭设置')], [',', tr('打开设置')],
  ['/', tr('在底部的对话框里开始写')], ['@', tr('对话框里换收件人：部门或员工')],
  ['⌘K', tr('中控屏里换项目')], ['⌘J', tr('中控屏里打开或收起小助手')], ['1 … 9, 0', tr('中控屏里切换左边的面板')], ['⌘S / ⌘↵', tr('中控屏的编辑器里保存 / 重新编译论文')],
  ['⌘K ⌘T', tr('中控屏的编辑器里换颜色主题和文件图标')],
];

function Keys() {
  return (
    <LayerCard className="st-keys">
      <Table>
        <Table.Header><Table.Row><Table.Head>{tr('按键')}</Table.Head><Table.Head>{tr('做什么')}</Table.Head></Table.Row></Table.Header>
        <Table.Body>{KEYS.map(([k, v]) => <Table.Row key={k}><Table.Cell><kbd>{k}</kbd></Table.Cell><Table.Cell>{v}</Table.Cell></Table.Row>)}</Table.Body>
      </Table>
    </LayerCard>
  );
}

export function SettingsPage({ section, hud, onClose }: { section?: string; hud: Hud | null; onClose: () => void }) {
  const s = useSettings();
  const [key, name, sub] = SECTIONS.find(x => x[0] === section) ?? SECTIONS[0];
  const show = (k: Section) => go(`/settings/${k}`, true);
  const changed = JSON.stringify(s) !== JSON.stringify(DEFAULTS);
  const mac = s.ui === 'macos';
  const [q, setQ] = useState('');
  const find = useRef<HTMLInputElement>(null);
  const hit = (n: string, about: string) => (n + about).toLowerCase().includes(q.trim().toLowerCase());
  const found = GROUPS.map(([label, items]) => [label, items.filter(x => hit(x[1], x[2]))] as const).filter(g => g[1].length);
  // Esc empties the search first, then leaves the page, unless a list or dialog on it is open: that
  // takes the Esc itself. Read on the way down, before the list has shut
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || layer.querySelector('[data-base-ui-portal] [data-open]')) return;
      if (document.activeElement === find.current && find.current?.value) setQ('');
      else onClose();
    };
    addEventListener('keydown', esc, true);
    return () => removeEventListener('keydown', esc, true);
  }, [onClose]);
  return createPortal(
    <div className="st-page" role="dialog" aria-modal="true" aria-label={tr('设置')} onClick={e => { if (mac && e.target === e.currentTarget) onClose(); }}>
      <Sidebar.Provider contained defaultOpen collapsible="none" mobileBreakpoint={0} className="st-shell">
        <Sidebar className="st-nav">
          <Sidebar.Header>
            <span className="st-lights"><button type="button" onClick={onClose} aria-label={tr('关闭')} title={tr('关闭（Esc）')} /><i /><i /></span>
            <span className="st-brand"><Logo /><b>Papertown</b></span>
          </Sidebar.Header>
          <Sidebar.Content>
            <label className="st-find">
              <MagnifyingGlassIcon size={14} aria-hidden="true" />
              <input ref={find} type="search" value={q} placeholder={tr('搜索')} aria-label={tr('搜索设置')} onChange={e => setQ(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && found[0]) { show(found[0][1][0][0]); setQ(''); } }} />
            </label>
            {found.map(([label, items]) => (
              <Sidebar.Group key={label}>
                <Sidebar.GroupLabel>{label}</Sidebar.GroupLabel>
                <Sidebar.Menu>
                  {items.map(([k, n, , Ic, tile]) => (
                    <Sidebar.MenuButton key={k} active={k === key} onClick={() => show(k)} style={{ ['--tile' as string]: tile }}
                      icon={<Ic className="st-ic shrink-0 opacity-40 size-4" weight={mac ? 'fill' : 'regular'} />}>{n}</Sidebar.MenuButton>
                  ))}
                </Sidebar.Menu>
              </Sidebar.Group>
            ))}
            {!found.length && <p className="st-none">{tr('没有找到')}</p>}
          </Sidebar.Content>
          <Sidebar.Footer>
            <Button variant="ghost" size="sm" icon={ArrowCounterClockwiseIcon} disabled={!changed} onClick={resetSettings} title={tr('这个浏览器里的设置都回到默认')}>{tr('恢复默认')}</Button>
          </Sidebar.Footer>
        </Sidebar>
        <main className="st-main">
          <header className="st-top">
            <div className="st-where"><Text variant="heading" size="lg" as="h1">{name}</Text><Text variant="secondary" size="sm">{sub}</Text></div>
            <Button className="st-x" variant="ghost" shape="square" icon={XIcon} onClick={onClose} aria-label={tr('关闭')} title={tr('关闭（Esc）')} />
          </header>
          <div className="st-phone-nav">
            <Select aria-label={tr('设置')} value={key} items={Object.fromEntries(SECTIONS.map(x => [x[0], x[1]]))} onValueChange={k => show(k as Section)} />
          </div>
          <section className="st-body" key={key}>
            {key === 'look' && <Look s={s} />}
            {key === 'showcase' && <Showcase s={s} />}
            {key === 'progress' && <ProgressPage s={s} />}
            {key === 'loop' && <LoopSection s={s} />}
            {key === 'editor' && <Editor s={s} />}
            {key === 'map' && <MapSection s={s} />}
            {key === 'walk' && <Walk s={s} />}
            {key === 'model' && <Model />}
            {key === 'agents' && <Agents />}
            {key === 'access' && <Access />}
            {key === 'demo' && <Demo hud={hud} />}
            {key === 'keys' && <Keys />}
          </section>
        </main>
      </Sidebar.Provider>
    </div>,
    layer,
  );
}
