// The settings page at /settings/<section>, drawn with Kumo whichever look the app has: browser
// settings (settings.ts) and the server's model, agents, access and demo samples.

import { StateWord } from '../emphasis';
import { Badge, Button, Dialog, Input, LayerCard, Select, Sidebar, Table, Text } from '@cloudflare/kumo';
import { ArrowCounterClockwiseIcon, CodeIcon, GraphIcon, CubeIcon, FlaskIcon, InfoIcon, KeyboardIcon, LockKeyIcon, MagnifyingGlassIcon, MapTrifoldIcon, PaletteIcon, RobotIcon, RowsIcon, ShieldCheckIcon, SwatchesIcon, XIcon, type Icon as Phosphor } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type AccessKey, type AccountView, type DefaultRuntime, type AuthState, type NetworkSettings, type NetworkView, type SourceKind, type Hud, type HerdrInfo, type PaseoDefault, type PaseoInfo, type Roster } from '../api';
import { Logo } from '../art';
import telettyLogo from '@teletty/web/logo.svg';
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
import { UsageSettings } from '../usage/Settings';
import { envLabel } from '../agents/AccountPick';

// each section: its address, name, what is in it, icon, and the colour of its tile in the macOS look
type Section = 'look' | 'showcase' | 'progress' | 'loop' | 'editor' | 'map' | 'walk' | 'agents' | 'network' | 'access' | 'demo' | 'keys' | 'about';
const GROUPS: [string, [Section, string, string, Phosphor, string][]][] = [
  [tr('界面'), [
    ['look', tr('外观与动效'), tr('界面风格、明暗、语言和动画'), PaletteIcon, '#5856d6'],
    ['showcase', tr('风格展示'), tr('每种风格的材质、控件和配色'), SwatchesIcon, '#ff2d55'],
    ['progress', tr('进展页'), tr('块或行、排序、分组、密度'), RowsIcon, '#007aff'],
    ['loop', tr('研究回路'), tr('平移缩放、网格、吸附、连线和图例'), GraphIcon, '#34c759'],
    ['editor', tr('编辑器'), tr('颜色主题和文件图标'), CodeIcon, '#af52de'],
  ]],
  [tr('小镇'), [
    ['map', tr('平面地图'), tr('缩放、拖动、建筑名称'), MapTrifoldIcon, '#28a745'],
    ['walk', tr('3D 漫游'), tr('鼠标、视野、手、画质'), CubeIcon, '#30b0c7'],
  ]],
  [tr('模型与员工'), [
    ['agents', tr('员工 Agent'), tr('Paseo、herdr、本机 pi 和 CLIppet 账号'), RobotIcon, '#a2845e'],
  ]],
  [tr('系统'), [
    ['network', tr('网络与安全'), tr('监听地址、端口、允许的来源和登录方式'), ShieldCheckIcon, '#0a84ff'],
    ['access', tr('访问与登录'), tr('其他设备的访问密码与 App 访问密钥'), LockKeyIcon, '#8e8e93'],
    ['demo', tr('展示模式'), tr('样例项目和调研文章'), FlaskIcon, '#e6a700'],
    ['keys', tr('快捷键'), tr('所有按键一览'), KeyboardIcon, '#636366'],
    ['about', tr('关于'), tr('版本与开源组件'), InfoIcon, '#8e8e93'],
  ]],
];
const SECTIONS = GROUPS.flatMap(g => g[1]);

const Warn = ({ children, bad }: { children: React.ReactNode; bad?: boolean }) => <p role={bad ? 'alert' : undefined} className="small em-state" data-tone={bad ? 'bad' : 'warn'}>{children}</p>;
function Look({ s }: { s: S }) {
  const mac = s.ui === 'macos', flat = s.ui !== 'paper';
  return (
    <>
      <Card title={tr('界面风格')}><LookPicker s={s} /></Card>
      {flat && (
        <Card>
          <Row label={tr('外观')} desc={tr('自动：电脑切换深色时同步切换')}><ModePicker s={s} /></Row>
          {mac && <div className="st-row st-glass">
            <div className="st-l"><b>Liquid Glass</b><span>{tr('左移更清透，右移着色更深、文字更清晰')}</span></div>
            <div className="st-c"><GlassStage /><GlassSlider value={s.glass} /></div>
          </div>}
        </Card>
      )}
      {mac && (
        <Card title={tr('主题')}>
          <Row label={tr('强调色')}><AccentPicker s={s} /></Row>
          <Row label={tr('壁纸')}><WallPicker s={s} /></Row>
          <Row label={tr('窗口背景跟随壁纸着色')} desc={tr('关闭后窗口为纯色，玻璃更素净')}>
            <Toggle label={tr('窗口背景跟随壁纸着色')} value={s.wallTint} onChange={set('wallTint')} />
          </Row>
        </Card>
      )}
      {s.ui === 'paper' && (
        <Card>
          <Row label={tr('纸纹')} desc={tr('覆盖整个页面的纸张纹理')}>
            <Range label={tr('纸纹')} value={s.grain} min={0} max={1} step={0.05} fmt={v => v ? `${Math.round(v * 100)}%` : tr('关')} onChange={set('grain')} />
          </Row>
        </Card>
      )}
      <Card title={tr('语言与动效')}>
        <Row label={tr('语言')} desc={tr('界面语言，切换后将重新加载页面')}>
          <Pick label={tr('语言')} value={LANG} options={LANGS} onChange={setLang} />
        </Row>
        <Row label={tr('动画')} desc={tr('柔和：动画更短更轻，适用于投影或易眩晕时')}>
          <Pick label={tr('动画')} value={s.motion} options={[['full', tr('完整')], ['calm', tr('柔和')]]} onChange={set('motion')} />
        </Row>
        <Row label={tr('打开页面时')} desc={tr('下次打开页面时的默认视图：中控屏为全局面板总览，小镇支持平面或 3D')}>
          <Pick label={tr('打开页面时')} value={s.start} options={[['cards', tr('进展')], ['console', tr('小镇 · 中控屏')], ['2d', tr('小镇 · 平面')], ['3d', tr('小镇 · 3D 漫游')]]} onChange={set('start')} />
        </Row>
      </Card>
    </>
  );
}

function ProgressPage({ s }: { s: S }) {
  return (
    <>
      <Card title={tr('排列方式')}>
        <Row label={tr('视图')} desc={tr('块为每项目一张卡片，行为每项目一行，便于纵向对比，也可在进展页直接切换')}>
          <Pick label={tr('视图')} value={s.pgView} options={[['blocks', tr('块')], ['rows', tr('行')]]} onChange={set('pgView')} />
        </Row>
        {PROGRESS_OPTIONS.slice(0, 2).map(o => <Row key={o.key} label={o.label} desc={o.desc}><OptionControl o={o} s={s} /></Row>)}
      </Card>
      <Card title={tr('显示')}>
        {PROGRESS_OPTIONS.slice(2).map(o => <Row key={o.key} label={o.label} desc={o.desc}><OptionControl o={o} s={s} /></Row>)}
      </Card>
      <Note>{tr('卡片与每行的显示字段可在进展页的「显示」中选择。')}</Note>
    </>
  );
}

// the code and paper editors' looks: the same choices as the pick at the top of the editor (⌘K ⌘T)
function Editor({ s }: { s: S }) {
  return (
    <>
      <Card title={tr('颜色主题')}>
        <Note>{tr('代码与论文编辑器的配色，含文件列表、标签页及状态栏。在编辑器内按 ⌘K ⌘T 可实时预览切换')}</Note>
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
        <Note>{tr('文件列表与标签页中文件名前的图标')}</Note>
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
        <Row label={tr('触控板双指和滚轮')} desc={tr('平移：双指滑动或滚轮移动画布，捏合或按住 ⌘（Windows 为 Ctrl）滚动缩放。缩放：双指滑动或滚轮直接缩放。滚轮每格步进缩放，速率随「滚轮缩放速度」')}>
          <Pick label={tr('触控板双指和滚轮')} value={s.cvScroll} options={[['pan', tr('平移')], ['zoom', tr('缩放')]]} onChange={set('cvScroll')} />
        </Row>
        <Row label={tr('随缩放调整节点')} desc={tr('缩小时字体放大、细节折叠，远距仅显示名称与一项数值')}>
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
        <Row label={tr('对齐网格')} desc={tr('拖动节点时按网格步进')}>
          <Toggle label={tr('对齐网格')} value={s.cvSnapGrid} onChange={set('cvSnapGrid')} />
        </Row>
        <Row label={tr('吸附到其他节点')} desc={tr('拖动节点时，边缘或中线靠近其他节点自动对齐并显示参考线')}>
          <Toggle label={tr('吸附到其他节点')} value={s.cvGuides} onChange={set('cvGuides')} />
        </Row>
        {s.cvGuides && (
          <Row label={tr('吸附距离')} desc={tr('触发吸附的距离阈值，按屏幕像素计')}>
            <Range label={tr('吸附距离')} value={s.cvGuideDist} min={4} max={16} step={1} fmt={v => `${v}px`} onChange={set('cvGuideDist')} />
          </Row>
        )}
      </Card>
      <Card title={tr('连线')}>
        <Row label={tr('显示全部连线')} desc={tr('关闭时，巡检、规范、边界与升级连线仅在悬停或打开节点时显示')}>
          <Toggle label={tr('显示全部连线')} value={s.cvLines} onChange={set('cvLines')} />
        </Row>
        <Row label={tr('连线绕开节点')} desc={tr('连线经过非端点节点时，沿节点间隙绕行')}>
          <Toggle label={tr('连线绕开节点')} value={s.cvAvoid} onChange={set('cvAvoid')} />
        </Row>
        <Row label={tr('流动动画')} desc={tr('已派发任务与退回中的修补单连线显示流动虚线')}>
          <Toggle label={tr('流动动画')} value={s.cvMarch} onChange={set('cvMarch')} />
        </Row>
      </Card>
      <Card title={tr('画布上显示')}>
        <Row label={tr('分块')} desc={tr('按「研究流程」分项为节点添加背景框与标题')}>
          <Toggle label={tr('分块')} value={s.cvLanes} onChange={set('cvLanes')} />
        </Row>
        <Row label={tr('图例')}><Toggle label={tr('图例')} value={s.cvLegend} onChange={set('cvLegend')} /></Row>
        <Row label={tr('小地图')}><Toggle label={tr('小地图')} value={s.cvMap} onChange={set('cvMap')} /></Row>
        <Row label={tr('操作提示')} desc={tr('画布顶部「双击空白处新建…」提示')}>
          <Toggle label={tr('操作提示')} value={s.cvHint} onChange={set('cvHint')} />
        </Row>
      </Card>
    </>
  );
}

function MapSection({ s }: { s: S }) {
  return (
    <Card>
      <Row label={tr('顺滑缩放和拖动')} desc={tr('缩放带缓动，停止拖动后地图惯性滑行')}>
        <Toggle label={tr('顺滑缩放和拖动')} value={s.smoothMap} onChange={set('smoothMap')} />
      </Row>
      <Row label={tr('滚轮缩放速度')}>
        <Range label={tr('滚轮缩放速度')} value={s.zoomSpeed} min={0.5} max={2} step={0.1} fmt={v => `${v.toFixed(1)}×`} onChange={set('zoomSpeed')} />
      </Row>
      <Row label={tr('建筑名称')} desc={tr('「主要」仅标注四座核心建筑与数处地标，「全部」均标注')}>
        <Pick label={tr('建筑名称')} value={s.mapLabels} options={[['key', tr('主要')], ['all', tr('全部')]]} onChange={set('mapLabels')} />
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
        <Row label={tr('鼠标灵敏度')} desc={tr('鼠标锁定在画面中心时的视角转动幅度')}>
          <Range label={tr('鼠标灵敏度')} value={s.sensitivity} min={0.3} max={3} step={0.05} fmt={v => `${v.toFixed(2)}×`} onChange={set('sensitivity')} />
        </Row>
        <Row label={tr('上下反转')} desc={tr('前推鼠标向下俯视')}>
          <Toggle label={tr('上下反转')} value={s.invertY} onChange={set('invertY')} />
        </Row>
        <Row label={tr('全屏漫游')} desc={tr('进入 3D 时自动全屏。面板开启时按 Esc 先关闭面板，否则退出全屏，点击画面继续时返回全屏')}>
          <Toggle label={tr('全屏漫游')} value={s.fullscreen3d} onChange={set('fullscreen3d')} />
        </Row>
      </Card>
      <Card title={tr('画面')}>
        <Row label={tr('视野')} desc={tr('越大视野越广，边缘拉伸越明显')}>
          <Range label={tr('视野')} value={s.fov} min={55} max={95} step={1} fmt={v => `${v}°`} onChange={set('fov')} />
        </Row>
        <Row label={tr('画质')} desc={tr('低：关闭阴影并降低分辨率，旧设备更流畅')}>
          <Pick label={tr('画质')} value={s.quality} options={[['low', tr('低')], ['mid', tr('中')], ['high', tr('高')]]} onChange={set('quality')} />
        </Row>
        <Row label={tr('显示手')} desc={tr('右下角显示手部与铅笔，行走时随步摆动')}>
          <Toggle label={tr('显示手')} value={s.hand} onChange={set('hand')} />
        </Row>
        <Row label={tr('行走时晃动')} desc={tr('视角随步伐轻微起伏')}>
          <Toggle label={tr('行走时晃动')} value={s.bob} onChange={set('bob')} />
        </Row>
        <Row label={tr('建筑名称')} desc={tr('建筑上方悬浮名称')}>
          <Toggle label={tr('建筑名称')} value={s.tags3d} onChange={set('tags3d')} />
        </Row>
        <Row label={tr('小地图')} desc={tr('右下角小地图，点击即可前往')}>
          <Toggle label={tr('小地图')} value={s.minimap} onChange={set('minimap')} />
        </Row>
      </Card>
    </>
  );
}

// what the assistant or a project's lead starts on, picked from what Paseo lists now
const ENV = { assistant: 'PAPERTOWN_ASSISTANT_MODEL', lead: 'PAPERTOWN_LEAD_MODEL', worker: 'PAPERTOWN_WORKER_MODEL' } as const;
function DefaultModel({ role, name, info, onSaved }: { role: 'assistant' | 'lead' | 'worker'; name: string; info: PaseoInfo; onSaved: (i: PaseoInfo) => void }) {
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
      <Row label={tr('{0}默认使用', name)} desc={d.set ? tr('此处所选将在启动时预选') : tr('未选择，使用环境变量 {0}', ENV[role])}>
        <div className="st-models">
          <Select aria-label={tr('供应商')} size="sm" placeholder={tr('选择供应商')} value={v.provider || undefined} items={Object.fromEntries(info.providers.map(p => [p.id, p.label]))} onValueChange={id => to(String(id))} />
          {!!pv?.models.length && <Select aria-label={tr('模型')} size="sm" value={v.model} items={Object.fromEntries(pv.models.map(x => [x.id, x.name]))} onValueChange={id => to(v.provider, String(id))} />}
          {!!m && m.thinking.length > 1 && <Select aria-label={tr('思考强度')} size="sm" value={v.thinking} items={Object.fromEntries(m.thinking.map(x => [x, x]))} onValueChange={t => setV(x => ({ ...x, thinking: String(t) }))} />}
          {changed && <Button size="sm" variant="primary" disabled={busy || !v.provider} onClick={() => save({ provider: v.provider, model: v.model || null, thinking: v.thinking || null })}>{tr('保存')}</Button>}
          {!changed && d.set && <Button size="sm" disabled={busy} onClick={() => save({ provider: null })} title={ENV[role]}>{tr('恢复环境变量')}</Button>}
        </div>
      </Row>
      {gone && !changed && <Warn>{tr('Paseo 当前无 {0}，启动时将回退至该供应商的首个模型。', [d.provider, d.model].filter(Boolean).join(' / '))}</Warn>}
      {err && <Warn bad>{err}</Warn>}
    </>
  );
}

// the account each CLI runs as when neither the project nor the agent chooses one: a CLIppet env, or this machine's login
function Accounts() {
  const [v, setV] = useState<AccountView | null>(null), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { api.accounts(null, null, true).then(setV).catch(e => setErr((e as Error).message)); }, []);
  async function save(env: string | null) {
    setBusy(true); setErr('');
    try { setV(await api.setAccount('global', env)); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Card title={tr('账号（CLIppet）')}>
      <Row label={tr('连接')} desc={tr('CLIppet 为每个 env 保存独立的登录与会话，Claude Code、Codex、Antigravity 可同时以多个账号运行')}>
        <StateWord state={v && !v.ok ? 'warn' : undefined}>{!v ? tr('检查中…') : v.ok ? tr('{0} 个 env', v.envs.length) : tr('未连接')}</StateWord>
      </Row>
      {v && !v.ok && <Warn>{v.note}</Warn>}
      {v?.ok && <Row label={tr('全局默认账号')} desc={tr('项目和员工未单独选择时使用。与 skill 一样分层：全局 → 项目 → 员工，较窄层级优先，启动终端时可为项目和员工单独选择。')}>
        <Select aria-label={tr('全局默认账号')} disabled={busy} value={v.layers.global || '__local'}
          items={{ __local: tr('本机当前登录'), ...Object.fromEntries(v.envs.map(e => [e.name, envLabel(v, e.name)])) }}
          onValueChange={x => save(x === '__local' ? null : String(x))} />
      </Row>}
      {v?.ok && !v.envs.length && <Note>{tr('暂无 env。运行 clippet env create <名称> --from-current，再在其中登录一次。')}</Note>}
      {err && <Warn bad>{err}</Warn>}
    </Card>
  );
}

function Agents() {
  const [runtime, setRuntime] = useState<DefaultRuntime>('paseo'), [runtimeError, setRuntimeError] = useState('');
  const [savingRuntime, setSavingRuntime] = useState(false);
  // Paseo is offered once its chat is debugged ([paseo] paseo_chat)
  const [paseoChat, setPaseoChat] = useState(false);
  useEffect(() => { api.defaultRuntime().then(d => { setRuntime(d.runtime); setPaseoChat(d.paseo_chat !== false); }).catch(e => setRuntimeError((e as Error).message)); }, []);
  async function saveRuntime(value: DefaultRuntime) {
    setSavingRuntime(true);
    try { const d = await api.setDefaultRuntime(value); setRuntime(d.runtime); setRuntimeError(''); }
    catch (e) { setRuntimeError((e as Error).message); } finally { setSavingRuntime(false); }
  }
  const s = useSettings();
  const [paseo, setPaseo] = useState<PaseoInfo | null | 'err'>(null);
  const [herdr, setHerdr] = useState<HerdrInfo | null>(null);
  const [herdrError, setHerdrError] = useState('');
  const [pi, setPi] = useState<Roster['available'] | null>(null);
  const [n, setN] = useState(0);
  const [reading, setReading] = useState(false);
  useEffect(() => {
    api.paseo().then(setPaseo).catch(() => setPaseo('err'));
    api.roster('coder').then(r => setPi(r.available)).catch(() => {});
  }, []);
  useEffect(() => {
    let alive = true;
    const read = () => api.herdr().then(h => { if (alive) { setHerdr(h); setHerdrError(''); } }, e => { if (alive) setHerdrError((e as Error).message); });
    void read();
    const timer = setInterval(read, 10000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  const again = () => { setReading(true); api.paseo(true).then(i => { setPaseo(i); setN(x => x + 1); }).catch(() => setPaseo('err')).finally(() => setReading(false)); };
  const info = paseo && paseo !== 'err' ? paseo : null, st = info?.status;
  return (
    <>
      <Card title={tr('默认运行方式')}>
        <Row label={tr('默认运行方式')} desc={tr('自动启动的项目负责人、pt hire 招募的员工及新建 Agent 默认预选此运行方式，手动启动时仍可自由切换。')}>
          <Select aria-label={tr('默认运行方式')} disabled={savingRuntime} value={runtime} items={{ herdr: 'herdr', tmux: 'tmux', headless: 'headless', ...(paseoChat ? { paseo: 'Paseo' } : {}) }} onValueChange={v => saveRuntime(v as DefaultRuntime)} />
        </Row>
        {runtimeError && <Warn bad>{runtimeError}</Warn>}
      </Card>
      <Accounts />
      <Card title={tr('对话')}>
        <Row label={tr('默认发送方式')} desc={tr('员工工作时使用此方式发送消息，⌘/Ctrl+Enter 始终排队。')}>
          <Pick label={tr('默认发送方式')} value={s.agentSend} options={[['steer', tr('插话')], ['queue', tr('排队')], ['interrupt', tr('中断并发送')]]} onChange={set('agentSend')} />
        </Row>
      </Card>
      <UsageSettings />
      <Card title="Paseo">
        <Row label={tr('连接')} desc={tr('托管 Claude Code、Codex、OpenCode 等 agent 的本机守护进程')}>
          <StateWord state={paseo !== null && !st?.ok ? 'warn' : undefined}>{paseo === null ? tr('检查中…') : st?.ok ? tr('已连接{0}', st.version ? ` · ${st.version}` : '') : tr('未连接')}</StateWord>
        </Row>
        {st && !st.ok && <Warn>{st.note}</Warn>}
        {info?.status.ok && (
          <>
            <Row label={tr('网页端')} desc={tr('房间内「完整界面」即嵌入此页面')}>
              <Note>{info.status.web ?? tr('未开启：paseo daemon config set features.webUi.enabled true')}</Note>
            </Row>
            <Row label={tr('可用的供应商')} desc={tr('从 Paseo 读取并定期更新。有新模型时中控屏将询问是否切换')}>
              <span className="st-tags">
                {info.providers.map(p => <Badge key={p.id} variant="outline">{p.label} · {tr('{0} 个模型', p.models.length)}</Badge>)}
                <Button size="sm" loading={reading} onClick={again}>{reading ? tr('读取中…') : tr('重新读取')}</Button>
              </span>
            </Row>
            <div key={n}>
              <DefaultModel role="assistant" name={tr('小助手')} info={info} onSaved={setPaseo} />
              <DefaultModel role="lead" name={tr('项目负责人')} info={info} onSaved={setPaseo} />
              <DefaultModel role="worker" name={tr('员工（代码员工和写作员工）')} info={info} onSaved={setPaseo} />
            </div>
          </>
        )}
      </Card>
      <Card title={tr('herdr')}>
        <Row label={tr('状态')} desc={tr('读取和操作已有的终端 agent 会话')}>
          <StateWord state={herdrError || (herdr && !herdr.ok) ? 'warn' : undefined}>{herdr?.ok ? tr('运行中') : herdr ? tr(herdr.note) : herdrError ? tr('未连接') : tr('检查中…')}</StateWord>
        </Row>
        {herdrError && <Warn>{herdrError}</Warn>}
        {herdr && <>
          <Row label={tr('Socket 路径')}><Note>{herdr.socket}</Note></Row>
          <Row label={tr('终端 Agent 数量')}><span>{herdr.count}</span></Row>
        </>}
      </Card>
      <Card title={tr('本机 pi')}>
        <Row label={tr('状态')} desc={tr('运行于 tmux 的后台终端 agent')}>
          <StateWord state={pi && !pi.ok ? 'warn' : undefined}>{pi === null ? tr('检查中…') : pi.ok ? tr('可用') : tr('不可用')}</StateWord>
        </Row>
        {pi && !pi.ok && <Warn>{pi.note}</Warn>}
      </Card>
      <Note>{tr('招募员工、导入 Paseo 已有对话、切换模型与思考强度均在仓库和印刷厂房间内完成。小助手和项目负责人的默认模型仅适用于后续启动，运行中的保持不变。')}</Note>
    </>
  );
}

function Demo({ hud }: { hud: Hud | null }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | Error>('');
  async function seed() {
    setBusy(true);
    setMsg('');
    try {
      const r = await api.samples();
      setMsg(r.note);
    } catch (e) {
      setMsg(e as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <Row label={tr('样例项目')} desc={tr('样例项目是预制的状态，放入后负责人默认关闭。')}>
        <Button variant="primary" loading={busy} onClick={seed}>{busy ? tr('放入中…') : tr('放入样例项目')}</Button>
      </Row>
      {msg instanceof Error ? <Warn bad>{msg.message}</Warn> : msg && <Note>{msg}</Note>}
      <Row label={tr('调研文章')} desc={tr('图书馆馆藏，样例项目查重及方法设计时从中检索相近工作')}>
        <Note>{tr('馆藏')} {tr('{0} 篇 · 进入小镇图书馆浏览', hud?.library ?? '…')}</Note>
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
  const [msg, setMsg] = useState<string | Error>('');
  const load = () => api.authState().then(setA, e => setErr((e as Error).message));
  useEffect(() => { load(); }, []);
  async function run(fn: () => Promise<unknown>, done?: string) {
    setMsg('');
    try { await fn(); await load(); if (done) setMsg(done); return true; } catch (e) { setMsg(e as Error); return false; }
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (pw !== pw2) { setMsg(new Error(tr('两次输入不一致'))); return; }
    if (await run(() => api.setPassword(pw, a?.local ? undefined : old), tr('访问密码已保存。'))) { setForm(false); setOld(''); setPw(''); setPw2(''); }
  }
  if (err) return <Warn bad>{err}</Warn>;
  if (!a) return <Note>{tr('加载中…')}</Note>;
  return (
    <>
      <Card>
        <Row label={tr('这台设备')} desc={a.local ? tr('运行 Papertown 的电脑：直接进入') : tr('用访问密码登录的设备')}>
          {!a.local && <Button onClick={() => run(api.logout).then(() => go('/'))}>{tr('退出登录')}</Button>}
        </Row>
        <Row label={tr('访问密码')} desc={a.methods?.password === false ? tr('密码登录已在「网络与安全」中关闭') : a.password ? tr('手机及其他设备在首页用此密码登录') : tr('尚未设置：其他设备的浏览器无法登录')}>
          {!form && <Button onClick={() => setForm(true)}>{a.password ? tr('修改密码') : tr('设置密码')}</Button>}
        </Row>
        {form && (
          <form className="st-form" onSubmit={save}>
            {!a.local && <Input type="password" autoComplete="current-password" label={tr('当前密码')} value={old} onChange={e => setOld(e.target.value)} />}
            <Input type="password" autoComplete="new-password" label={tr('新的访问密码（至少 6 位）')} value={pw} onChange={e => setPw(e.target.value)} autoFocus />
            <Input type="password" autoComplete="new-password" label={tr('再次输入')} value={pw2} onChange={e => setPw2(e.target.value)} />
            <div className="st-btns">
              <Button variant="primary" type="submit" disabled={pw.length < 6 || !pw2}>{tr('保存')}</Button>
              <Button type="button" onClick={() => setForm(false)}>{tr('取消')}</Button>
            </div>
          </form>
        )}
        {a.password && (
          <Row label={tr('已登录设备')} desc={tr('{0} 个设备登录仍在有效期内（{1} 天）', a.sessions ?? 0, a.days ?? 30)}>
            <Button disabled={!a.sessions} onClick={() => run(api.logoutAll, tr('所有设备均需重新登录。'))}>{tr('全部退出登录')}</Button>
          </Row>
        )}
        {a.local && a.password && (
          <Row label={tr('取消密码')} desc={tr('此后仅本机可打开 Papertown')}>
            <Dialog.Root>
              <Dialog.Trigger render={p => <Button {...p} variant="secondary-destructive">{tr('取消密码')}</Button>} />
              <Dialog size="sm" className="st-dlg">
                <Dialog.Title>{tr('取消访问密码？')}</Dialog.Title>
                <Dialog.Description>{tr('已登录设备也将退出登录。')}</Dialog.Description>
                <div className="st-btns">
                  <Dialog.Close render={p => <Button {...p}>{tr('保留密码')}</Button>} />
                  <Dialog.Close render={p => <Button {...p} variant="destructive" onClick={() => run(api.clearPassword, tr('访问密码已取消。'))}>{tr('取消密码')}</Button>} />
                </div>
              </Dialog>
            </Dialog.Root>
          </Row>
        )}
        {msg instanceof Error ? <Warn bad>{msg.message}</Warn> : msg && <Note>{msg}</Note>}
      </Card>
      {(a.local || a.signed_in) && <AccessKeys off={a.methods?.keys === false} />}
      <Note>{tr('其他设备要打开 Papertown，先在「网络与安全」中把监听地址改为所有网络并重启服务，或用 tailscale serve 转发。之后在浏览器用访问密码登录，或在 App 中填写服务器地址和访问密钥。')}</Note>
    </>
  );
}

// where the server listens, which addresses may reach it at all, and how other devices sign in (network.py).
// Host and port wait for the next start; the rest holds from the next request
const PICK = (v: NetworkView): NetworkSettings => ({ host: v.host, port: v.port, sources: v.sources, password: v.password, keys: v.keys, days: v.days });
const PRESETS: [string, string, string][] = [
  ['lan', tr('局域网'), tr('10.0.0.0/8、172.16.0.0/12、192.168.0.0/16 等私有地址')],
  ['tailscale', 'Tailscale', tr('100.64.0.0/10，包括 tailscale serve 转发的访问')],
  ['any', tr('任意来源'), tr('包括公网，建议只在 HTTPS 反向代理之后开启')],
];
const KIND: Record<string, string> = { tailscale: 'Tailscale', lan: tr('局域网') };
const kindName = (k: SourceKind) => (k && KIND[k]) || tr('其他网络');

function Network() {
  const [v, setV] = useState<NetworkView | null>(null);
  const [d, setD] = useState<NetworkSettings | null>(null);
  const [add, setAdd] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState<string | Error>('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.network().then(r => { setV(r); setD(PICK(r)); }, e => setErr((e as Error).message)); }, []);
  if (err) return <Warn bad>{err}</Warn>;
  if (!v || !d) return <Note>{tr('加载中…')}</Note>;
  const ro = !v.can_edit;
  const edit = (x: Partial<NetworkSettings>) => { setMsg(''); setD({ ...d, ...x }); };
  const has = (s: string) => d.sources.includes(s);
  const flip = (s: string, on: boolean) => edit({ sources: on ? [...d.sources, s] : d.sources.filter(x => x !== s) });
  const custom = d.sources.filter(s => !(s in v.presets));
  const dirty = JSON.stringify(PICK(v)) !== JSON.stringify(d);
  const now = v.listening;
  const waits = now && (now.host !== v.host || now.port !== v.port);
  async function save() {
    setBusy(true); setMsg('');
    try {
      const r = await api.setNetwork(d!);
      const moved = r.host !== v!.host || r.port !== v!.port;
      setV(r); setD(PICK(r));
      setMsg(moved ? tr('已保存。监听地址和端口在重启服务后生效。') : tr('已保存。'));
    } catch (e) { setMsg(e as Error); }
    setBusy(false);
  }
  function addSource(e: React.FormEvent) {
    e.preventDefault();
    const s = add.trim();
    if (s && !d!.sources.includes(s)) edit({ sources: [...d!.sources, s] });
    setAdd('');
  }
  const urls = d.host === '127.0.0.1' ? [] : v.addresses;
  const [inFile, editable] = tr('以上设置保存在 {0}，也可直接编辑该文件。').split('{0}');
  return (
    <>
      <Card title={tr('监听')}>
        <Row label={tr('监听地址')} desc={tr('仅本机：只有这台电脑能打开。所有网络：允许来源内的设备可以连接，仍需登录')}>
          {ro ? <Text>{d.host === '127.0.0.1' ? tr('仅本机') : tr('所有网络')}</Text>
            : <Pick label={tr('监听地址')} value={d.host === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0'} options={[['127.0.0.1', tr('仅本机')], ['0.0.0.0', tr('所有网络')]]} onChange={h => edit({ host: h })} />}
        </Row>
        <Row label={tr('端口')} desc={tr('1024 到 65535')}>
          {ro ? <Text>{d.port}</Text>
            : <Input className="st-port" aria-label={tr('端口')} type="number" min={1024} max={65535} value={String(d.port)} onChange={e => edit({ port: Number(e.target.value) || 0 })} />}
        </Row>
        {waits && <Warn>{tr('当前监听 {0}:{1}，已保存的设置在重启服务后生效。启动命令中写了 --host 或 --port 时，以命令为准。', now!.host, now!.port)}</Warn>}
        <Row label={tr('其他设备的连接地址')} desc={d.host === '127.0.0.1' ? tr('仅本机监听时，其他设备无法连接') : tr('在其他设备的浏览器或 App 中填写')}>
          {urls.length > 0 && <div className="st-addr">{urls.map(a => <code key={a.ip} title={kindName(a.kind)}>{`http://${a.ip.includes(':') ? `[${a.ip}]` : a.ip}:${d.port}`}</code>)}</div>}
        </Row>
      </Card>
      <Card title={tr('允许的来源')}>
        <Note>{tr('这台电脑始终可以访问。来源不在范围内的设备会被直接拒绝，登录页也无法打开。')}</Note>
        {PRESETS.map(([k, name, about]) => (
          <Row key={k} label={name} desc={about}><Toggle label={name} value={has(k)} disabled={ro} onChange={on => flip(k, on)} /></Row>
        ))}
        {custom.map(s => (
          <Row key={s} label={s} desc={tr('手动添加')}>
            {!ro && <Button variant="secondary-destructive" onClick={() => flip(s, false)}>{tr('移除')}</Button>}
          </Row>
        ))}
        {!ro && (
          <form className="st-form st-src-new" onSubmit={addSource}>
            <Input label={tr('添加 IP 或网段')} placeholder={tr('例如 203.0.113.7 或 203.0.113.0/24')} value={add} maxLength={60} onChange={e => setAdd(e.target.value)} />
            <div className="st-btns"><Button type="submit" disabled={!add.trim()}>{tr('添加')}</Button></div>
          </form>
        )}
        <Row label={tr('你当前的来源')} desc={v.you.local ? tr('这台电脑') : `${v.you.ip ?? '?'} · ${kindName(v.you.kind)}`} />
      </Card>
      <Card title={tr('登录方式')}>
        <Row label={tr('密码登录')} desc={tr('其他设备的浏览器用访问密码登录。关闭后已登录的设备一并退出')}>
          <Toggle label={tr('密码登录')} value={d.password} disabled={ro} onChange={on => edit({ password: on })} />
        </Row>
        <Row label={tr('访问密钥')} desc={tr('iPhone 与 Mac App、脚本用访问密钥连接')}>
          <Toggle label={tr('访问密钥')} value={d.keys} disabled={ro} onChange={on => edit({ keys: on })} />
        </Row>
        <Row label={tr('登录有效期')} desc={tr('用密码登录后，多久需要重新登录')}>
          {ro ? <Text>{tr('{0} 天', d.days)}</Text>
            : <Pick label={tr('登录有效期')} value={String(d.days)} options={[['1', tr('1 天')], ['7', tr('7 天')], ['30', tr('30 天')], ['90', tr('90 天')]]} onChange={x => edit({ days: Number(x) })} />}
        </Row>
      </Card>
      {v.file && <Note>{inFile}<code className="st-file">{v.file}</code>{editable}</Note>}
      {ro ? <Note>{tr('只能在运行 Papertown 的电脑上，或用访问密码登录后修改。')}</Note> : (
        <div className="st-btns">
          <Button variant="primary" disabled={!dirty || busy} onClick={save}>{tr('保存')}</Button>
          <Button disabled={!dirty || busy} onClick={() => { setD(PICK(v)); setMsg(''); }}>{tr('还原')}</Button>
        </div>
      )}
      {msg instanceof Error ? <Warn bad>{msg.message}</Warn> : msg && <Note>{msg}</Note>}
    </>
  );
}

// keys for the iPhone and Mac apps (and scripts): one per device, shown once, revoked one by one
function AccessKeys({ off }: { off?: boolean }) {
  const [keys, setKeys] = useState<AccessKey[] | null>(null);
  const [name, setName] = useState('');
  const [made, setMade] = useState<AccessKey | null>(null);
  const [msg, setMsg] = useState<string | Error>('');
  const load = () => api.accessKeys().then(r => setKeys(r.keys), e => setMsg(e as Error));
  useEffect(() => { load(); }, []);
  async function create(e: React.FormEvent) {
    e.preventDefault();
    setMsg('');
    try { setMade(await api.createKey(name.trim())); setName(''); await load(); } catch (err) { setMsg(err as Error); }
  }
  async function revoke(k: AccessKey) {
    setMsg('');
    try { setKeys((await api.revokeKey(k.id)).keys); if (made?.id === k.id) setMade(null); setMsg(tr('已撤销「{0}」。', k.name)); } catch (err) { setMsg(err as Error); }
  }
  const when = (s: string | null) => s ? new Date(s).toLocaleString(undefined, { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : tr('从未使用');
  return (
    <Card>
      <Row label={tr('访问密钥')} desc={tr('iPhone 与 Mac App 用服务器地址加访问密钥连接。每个设备一个密钥，可单独撤销。')} />
      {off && <Warn>{tr('访问密钥已在「网络与安全」中关闭，现有密钥暂时无法连接。')}</Warn>}
      <form className="st-form st-key-new" onSubmit={create}>
        <Input label={tr('设备名称')} placeholder={tr('例如 iPhone')} value={name} maxLength={60} onChange={e => setName(e.target.value)} />
        <div className="st-btns"><Button variant="primary" type="submit">{tr('新建密钥')}</Button></div>
      </form>
      {made?.key && (
        <div className="st-key-made">
          <span className="em-bar" data-tone="warn">{tr('「{0}」的访问密钥只显示这一次，请现在复制到 App 中：', made.name)}</span>
          <div className="st-key-text">
            <code>{made.key}</code>
            <Button onClick={() => { navigator.clipboard?.writeText(made.key!); setMsg(tr('已复制。')); }}>{tr('复制')}</Button>
            <Button variant="ghost" onClick={() => setMade(null)}>{tr('完成')}</Button>
          </div>
        </div>
      )}
      {keys?.map(k => (
        <Row key={k.id} label={k.name} desc={tr('{0}… · 创建于 {1} · 最近使用 {2}', k.hint, when(k.at), when(k.seen))}>
          <Button variant="secondary-destructive" onClick={() => revoke(k)}>{tr('撤销密钥')}</Button>
        </Row>
      ))}
      {keys && !keys.length && <Note>{tr('还没有访问密钥。')}</Note>}
      {msg instanceof Error ? <Warn bad>{msg.message}</Warn> : msg && <Note>{msg}</Note>}
    </Card>
  );
}

const KEYS: [string, string][] = [
  [tr('W A S D / 方向键'), tr('移动（3D 中 ←/→ 转向）')], ['Shift', tr('3D 奔跑')],
  [tr('空格'), tr('3D 跳跃，双击起飞或降落，飞行时按住上升')], ['Ctrl / C', tr('3D 下蹲，蹲行至边缘不致坠落。飞行时下降')],
  ['F', tr('进入门口或准星所指建筑，室内则打开准星所指设备')],
  [tr('鼠标'), tr('3D 转动视角，平面拖动地图、滚轮缩放')], [tr('点击'), tr('平面进入建筑，3D 中同 F 键')],
  ['V', tr('3D 切换第一 / 第三人称')], ['T', tr('3D 切换白天 / 夜晚')],
  ['M', tr('3D 返回平面')], ['Esc', tr('释放鼠标（全屏时退出全屏）/ 关闭对话 / 返回小镇 / 关闭设置')], [',', tr('打开设置')],
  ['/', tr('在底部输入框开始输入')], ['@', tr('切换对话框收件人：部门或员工')],
  ['⌘K', tr('中控屏切换项目')], ['⌘J', tr('中控屏展开或收起小助手')], ['1 … 9, 0', tr('中控屏切换左侧面板')], ['⌘S / ⌘↵', tr('中控屏编辑器保存 / 重新编译论文')],
  ['⌘K ⌘T', tr('中控屏编辑器切换颜色主题与文件图标')],
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

// what Papertown is built on: its terminal core first, then the components it ships with
const PARTS: [string, string, string][] = [
  ['Cloudflare Kumo', 'https://github.com/cloudflare/kumo', tr('界面组件')],
  ['Phosphor Icons', 'https://phosphoricons.com/', tr('图标')],
  ['three.js', 'https://threejs.org/', tr('3D 小镇')],
  ['React · Vite', 'https://react.dev/', tr('网页')],
  ['FastAPI · SQLite', 'https://fastapi.tiangolo.com/', tr('服务端')],
];
const bare = (url: string) => url.replace(/^https:\/\//, '').replace(/\/$/, '');

function About() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => { api.health().then(h => setVersion(h.version ?? null), () => {}); }, []);
  const repo = (url: string) => <a className="st-repo" href={url} target="_blank" rel="noreferrer">{bare(url)}</a>;
  return (
    <>
      <Card>
        <div className="st-about">
          <Logo />
          <div className="st-l"><b>Papertown</b>{version && <span>{tr('版本 {0}', version)}</span>}</div>
          {repo('https://github.com/FanBB2333/papertown')}
        </div>
      </Card>
      <Card title={tr('终端核心')}>
        <div className="st-about">
          <img src={telettyLogo} alt="" />
          <div className="st-l"><b>teletty</b><span>{tr('在真实终端里运行 CLI，通过按键操作并实时读取画面。后台终端、tmux 和 herdr 都由它管理。')}</span></div>
          {repo('https://github.com/FanBB2333/teletty')}
        </div>
      </Card>
      <Card title={tr('开源组件')}>
        {PARTS.map(([name, url, what]) => <Row key={name} label={name} desc={what}>{repo(url)}</Row>)}
      </Card>
    </>
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
            <Button variant="ghost" size="sm" icon={ArrowCounterClockwiseIcon} disabled={!changed} onClick={resetSettings} title={tr('将当前浏览器设置恢复为默认')}>{tr('恢复默认')}</Button>
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
            {key === 'agents' && <Agents />}
            {key === 'network' && <Network />}
            {key === 'access' && <Access />}
            {key === 'demo' && <Demo hud={hud} />}
            {key === 'keys' && <Keys />}
            {key === 'about' && <About />}
          </section>
        </main>
      </Sidebar.Provider>
    </div>,
    layer,
  );
}
