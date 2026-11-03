// Settings: one sheet for everything you can set from the page. Looks and motion, the 2D
// map, the 3D walk (kept in this browser, see settings.ts), the town's own model and the
// agents' runtimes (on the server), the demo samples, and the keys.

import { useEffect, useState } from 'react';
import { api, listen, type Hud, type Llm, type PaseoDefault, type PaseoInfo, type Roster } from '../api';
import { DEFAULTS, resetSettings, setSettings, useSettings, type Settings as S } from '../settings';
import { IconRow, Sample } from '../console/EdPicker';
import { ICON_THEMES, THEMES, chooseLook } from '../console/edthemes';
import { LlmForm } from './Chat';
import { Select } from './Select';
import '../settings.css';
import { LANG, LANGS, setLang, tr } from '../i18n';

type Tab = 'look' | 'editor' | 'map' | 'walk' | 'model' | 'agents' | 'demo' | 'keys';
const TABS: [Tab, string, string][] = [
  ['look', tr('外观与动效'), tr('动画、纸纹、打开时的视图')],
  ['editor', tr('编辑器'), tr('颜色主题和文件图标')],
  ['map', tr('平面地图'), tr('缩放、拖动、建筑名字')],
  ['walk', tr('3D 漫游'), tr('鼠标、视野、手、画质')],
  ['model', tr('模型'), tr('小镇员工用的大模型')],
  ['agents', tr('员工 Agent'), tr('Paseo 和本机 pi')],
  ['demo', tr('展示模式'), tr('样例项目和调研文章')],
  ['keys', tr('快捷键'), tr('所有按键一览')],
];

function Row({ label, desc, children }: { label: string; desc?: string; children?: React.ReactNode }) {
  return (
    <div className="st-row">
      <div className="st-l"><b>{label}</b>{desc && <span>{desc}</span>}</div>
      {children && <div className="st-c">{children}</div>}
    </div>
  );
}

function Pick<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="st-pick" role="radiogroup">
      {options.map(([v, l]) => <button key={v} role="radio" aria-checked={v === value} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>{l}</button>)}
    </div>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return <button role="switch" aria-checked={value} className={`st-sw${value ? ' on' : ''}`} onClick={() => onChange(!value)}><i /></button>;
}

function Slider({ value, min, max, step, fmt, onChange }: { value: number; min: number; max: number; step: number; fmt: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <div className="st-slide">
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))}
        style={{ ['--p' as string]: `${((value - min) / (max - min)) * 100}%` }} />
      <output>{fmt(value)}</output>
    </div>
  );
}

const set = <K extends keyof S>(k: K) => (v: S[K]) => setSettings({ [k]: v } as Partial<S>);

function Look({ s }: { s: S }) {
  return (
    <>
      <Row label={tr('语言')} desc={tr('界面文字的语言，切换后页面会重新载入')}>
        <Pick value={LANG} options={LANGS} onChange={setLang} />
      </Row>
      <Row label={tr('动画')} desc={tr('柔和：动画更短更轻，适合投影或容易晕的时候')}>
        <Pick value={s.motion} options={[['full', tr('完整')], ['calm', tr('柔和')]]} onChange={set('motion')} />
      </Row>
      <Row label={tr('纸纹')} desc={tr('盖在整个页面上的纸张纹理')}>
        <Slider value={s.grain} min={0} max={1} step={0.05} fmt={v => v ? `${Math.round(v * 100)}%` : tr('关')} onChange={set('grain')} />
      </Row>
      <Row label={tr('打开页面时')} desc={tr('下次打开页面先看到哪种视图：中控屏是不用走动的面板，小镇可以平面或 3D')}>
        <Pick value={s.start} options={[['console', tr('中控屏')], ['2d', tr('平面地图')], ['3d', tr('3D 漫游')]]} onChange={set('start')} />
      </Row>
    </>
  );
}

// the code and paper editors' looks: the same choices as the pick at the top of the editor (⌘K ⌘T)
function Editor({ s }: { s: S }) {
  return (
    <>
      <Row label={tr('颜色主题')} desc={tr('代码和论文编辑器的配色，连同文件列表、标签页和状态栏；在编辑器里按 ⌘K ⌘T 可以边看边换')} />
      <div className="st-themes" role="radiogroup">
        {THEMES.map(th => (
          <button key={th.id} role="radio" aria-checked={th.id === s.edTheme} className={`st-theme${th.id === s.edTheme ? ' on' : ''}`} onClick={() => chooseLook({ theme: th.id })}>
            <Sample th={th} />
            <span><b>{th.name}</b><em>{th.dark ? tr('深色') : tr('浅色')}</em></span>
          </button>
        ))}
      </div>
      <Row label={tr('文件图标')} desc={tr('文件列表和标签页里，文件名前面的图标')} />
      <div className="st-icons" role="radiogroup">
        {ICON_THEMES.map(([id, name, desc]) => (
          <button key={id} role="radio" aria-checked={id === s.edIcons} className={`st-icon${id === s.edIcons ? ' on' : ''}`} onClick={() => chooseLook({ icons: id })}>
            <IconRow id={id} />
            <b>{name}</b><span>{desc}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function MapTab({ s }: { s: S }) {
  return (
    <>
      <Row label={tr('顺滑缩放和拖动')} desc={tr('缩放带缓动，松手后地图会顺势滑一小段')}>
        <Toggle value={s.smoothMap} onChange={set('smoothMap')} />
      </Row>
      <Row label={tr('滚轮缩放速度')}>
        <Slider value={s.zoomSpeed} min={0.5} max={2} step={0.1} fmt={v => `${v.toFixed(1)}×`} onChange={set('zoomSpeed')} />
      </Row>
      <Row label={tr('建筑名字')} desc={tr('主要：四座核心建筑和几处地标；全部：每栋都标')}>
        <Pick value={s.mapLabels} options={[['key', tr('主要')], ['all', tr('全部')]]} onChange={set('mapLabels')} />
      </Row>
      <Row label={tr('走动提示')} desc={tr('地图底部的按键提示')}>
        <Toggle value={s.walkHint} onChange={set('walkHint')} />
      </Row>
    </>
  );
}

function Walk({ s }: { s: S }) {
  return (
    <>
      <Row label={tr('鼠标灵敏度')} desc={tr('鼠标锁在画面中间时，移动多少转多少')}>
        <Slider value={s.sensitivity} min={0.3} max={3} step={0.05} fmt={v => `${v.toFixed(2)}×`} onChange={set('sensitivity')} />
      </Row>
      <Row label={tr('上下反转')} desc={tr('鼠标往前推是低头')}>
        <Toggle value={s.invertY} onChange={set('invertY')} />
      </Row>
      <Row label={tr('视野')} desc={tr('越大看得越广，边缘拉伸也越明显')}>
        <Slider value={s.fov} min={55} max={95} step={1} fmt={v => `${v}°`} onChange={set('fov')} />
      </Row>
      <Row label={tr('显示手')} desc={tr('画面右下角你的手和铅笔，走路时会跟着摆')}>
        <Toggle value={s.hand} onChange={set('hand')} />
      </Row>
      <Row label={tr('走路时晃动')} desc={tr('视角随步子轻轻上下')}>
        <Toggle value={s.bob} onChange={set('bob')} />
      </Row>
      <Row label={tr('画质')} desc={tr('低：不画阴影、降低分辨率，老电脑更流畅')}>
        <Pick value={s.quality} options={[['low', tr('低')], ['mid', tr('中')], ['high', tr('高')]]} onChange={set('quality')} />
      </Row>
      <Row label={tr('建筑名字')} desc={tr('悬在建筑上方的名字')}>
        <Toggle value={s.tags3d} onChange={set('tags3d')} />
      </Row>
      <Row label={tr('全屏漫游')} desc={tr('进入 3D 时自动全屏；开着面板时 Esc 先关面板，没有面板时退出全屏；再点画面继续时回到全屏')}>
        <Toggle value={s.fullscreen3d} onChange={set('fullscreen3d')} />
      </Row>
      <Row label={tr('小地图')} desc={tr('右下角的小地图，点一下就过去')}>
        <Toggle value={s.minimap} onChange={set('minimap')} />
      </Row>
    </>
  );
}

function Model() {
  const [llm, setLlm] = useState<Llm | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => { api.llm().then(setLlm).catch(() => {}); }, []);
  useEffect(() => listen(e => { if (e.type === 'llm') setLlm(e.llm); }), []);
  if (!llm) return <p className="muted">{tr('读取中…')}</p>;
  const name = llm.providers.find(x => x.id === llm.provider)?.name ?? llm.provider;
  return (
    <>
      <p className="st-note">{tr('现在：')}<b>{name}</b> · {llm.model_strong}{llm.model_cheap !== llm.model_strong ? ` / ${llm.model_cheap}` : ''}{llm.offline ? tr('（离线模式，员工按 skill 的步骤调用工具，文字用模板）') : ''}</p>
      <LlmForm key={n} llm={llm} onDone={l => { if (l) setLlm(l); setN(x => x + 1); }} />
      <p className="muted small">{tr('仓库和印刷厂里的代码、写作员工用的是 Paseo 或 pi 自己的模型，在各自的房间里切换。')}</p>
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
  const gone = !!d.provider && (!info.providers.some(p => p.id === d.provider) || (!!d.model && !info.providers.find(p => p.id === d.provider)?.models.some(x => x.id === d.model)));
  const changed = JSON.stringify(v) !== JSON.stringify(was);
  // another provider or model keeps the thinking when it has it
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
          <Select value={v.provider} label={tr('供应商')} placeholder={tr('选供应商')} options={info.providers.map(p => ({ value: p.id, label: p.label }))} onChange={id => to(id)} />
          {!!pv?.models.length && <Select value={v.model} label={tr('模型')} options={pv.models.map(x => ({ value: x.id, label: x.name }))} onChange={id => to(v.provider, id)} />}
          {!!m && m.thinking.length > 1 && <Select value={v.thinking} label={tr('思考强度')} options={m.thinking.map(x => ({ value: x, label: x }))} onChange={t => setV(x => ({ ...x, thinking: t }))} />}
          {changed && <button className="btn pri" disabled={busy || !v.provider} onClick={() => save({ provider: v.provider, model: v.model || null, thinking: v.thinking || null })}>{tr('保存')}</button>}
          {!changed && d.set && <button className="btn" disabled={busy} onClick={() => save({ provider: null })} title={ENV[role]}>{tr('改回环境变量的')}</button>}
        </div>
      </Row>
      {gone && !changed && <p className="warn-box small">{tr('Paseo 里现在没有 {0}，启动时会退回到这个供应商的第一个模型。', [d.provider, d.model].filter(Boolean).join(' / '))}</p>}
      {err && <p className="warn-box small">{err}</p>}
    </>
  );
}

function Agents() {
  const [paseo, setPaseo] = useState<PaseoInfo | null | 'err'>(null);
  const [pi, setPi] = useState<Roster['available'] | null>(null);
  const [n, setN] = useState(0); // the default pickers start over from a new reading
  const [reading, setReading] = useState(false);
  useEffect(() => {
    api.paseo().then(setPaseo).catch(() => setPaseo('err'));
    api.roster('coder').then(r => setPi(r.available)).catch(() => {});
  }, []);
  const again = () => { setReading(true); api.paseo(true).then(i => { setPaseo(i); setN(x => x + 1); }).catch(() => setPaseo('err')).finally(() => setReading(false)); };
  const st = paseo && paseo !== 'err' ? paseo.status : null;
  return (
    <>
      <Row label="Paseo" desc={tr('托管 Claude Code、Codex、OpenCode 等 agent 的本机守护进程')}>
        <span className={`chip ${st?.ok ? 'ok' : 'warn'}`}>{paseo === null ? tr('检查中…') : st?.ok ? tr('已连接{0}', st.version ? ` · ${st.version}` : '') : tr('未连接')}</span>
      </Row>
      {st && !st.ok && <p className="warn-box small">{st.note}</p>}
      {st?.ok && (
        <>
          <Row label={tr('网页端')} desc={tr('房间里「完整界面」嵌入的就是它')}>
            <span className="muted small">{st.web ?? tr('没开：paseo daemon config set features.webUi.enabled true')}</span>
          </Row>
          <Row label={tr('可用的供应商')} desc={tr('从 Paseo 读出来的，每隔一阵重读一次；有新模型时中控屏会问你要不要换')}>
            <span className="st-tags">
              {paseo !== 'err' && paseo?.providers.map(p => <span key={p.id} className="chip">{p.label} · {tr('{0} 个模型', p.models.length)}</span>)}
              <button className="btn" disabled={reading} onClick={again}>{reading ? tr('读取中…') : tr('重新读取')}</button>
            </span>
          </Row>
          {paseo && paseo !== 'err' && <div key={n}>
            <DefaultModel role="assistant" name={tr('小助手')} info={paseo} onSaved={setPaseo} />
            <DefaultModel role="lead" name={tr('项目负责人')} info={paseo} onSaved={setPaseo} />
          </div>}
        </>
      )}
      <Row label={tr('本机 pi')} desc={tr('跑在 tmux 里的后台终端 agent')}>
        <span className={`chip ${pi?.ok ? 'ok' : 'warn'}`}>{pi === null ? tr('检查中…') : pi.ok ? tr('可用') : tr('不可用')}</span>
      </Row>
      {pi && !pi.ok && <p className="warn-box small">{pi.note}</p>}
      <p className="muted small">{tr('雇员工、导入 Paseo 里已有的对话、切换模型和思考强度，都在仓库和印刷厂的房间里。小助手和项目负责人的默认模型只管以后启动的，已经在跑的不受影响。')}</p>
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
    <>
      <Row label={tr('现在')} desc={tr('没有配置模型 key 时就是展示模式')}>
        <span className={`chip ${hud?.offline ? 'warn' : 'ok'}`}>{hud ? (hud.offline ? tr('展示模式（离线）') : tr('在线 · {0}', hud.provider)) : '…'}</span>
      </Row>
      <Row label={tr('样例项目')} desc={tr('放入几篇写到不同工序的样例论文：有的已出厂，有的停在实验或写作前，有的等你决定孵不孵化')}>
        <button className="btn pri" disabled={busy || !hud?.offline} onClick={seed}>{busy ? tr('放入中…') : tr('放入样例项目')}</button>
      </Row>
      {!hud?.offline && <p className="muted small">{tr('接了模型以后样例也会真的调用模型、花钱，所以只在展示模式里提供。')}</p>}
      {msg && <p className="st-note">{msg}</p>}
      <Row label={tr('调研文章')} desc={tr('图书馆的馆藏，样例项目查重和写方法时从这里找相近工作')}>
        <span className="muted small">{tr('馆藏')} {tr('{0} 篇 · 在小镇里进图书馆翻看', hud?.library ?? '…')}</span>
      </Row>
    </>
  );
}

const KEYS: [string, string][] = [
  [tr('W A S D / 方向键'), tr('走动（3D 里 ←/→ 转身）')], ['Shift', tr('3D 里跑')],
  [tr('空格'), tr('3D 里跳；连按两下起飞或落地，飞行时按住上升')], ['Ctrl / C', tr('3D 里下蹲，蹲着走到边上不会掉下去；飞行时下降')],
  ['F', tr('进门口或准星对着的建筑；在建筑里打开准星对着的设备')],
  [tr('鼠标'), tr('3D 里转视角；平面上拖动地图、滚轮缩放')], [tr('点击'), tr('平面上进建筑；3D 里和 F 一样')],
  ['V', tr('3D 里切换第一 / 第三人称')], ['T', tr('3D 里切换白天 / 夜晚')],
  ['M', tr('3D 里回到平面')], ['Esc', tr('放开鼠标（全屏时同时退出全屏）/ 关闭对话 / 回到小镇 / 关闭设置')], [',', tr('打开设置')],
  ['/', tr('在底部的对话框里开始写')], ['@', tr('对话框里换收件人：部门或员工')],
  ['⌘K', tr('中控屏里换项目')], ['⌘J', tr('中控屏里打开或收起小助手')], ['1 … 9, 0', tr('中控屏里切换左边的面板')], ['⌘S / ⌘↵', tr('中控屏的编辑器里保存 / 重新编译论文')],
  ['⌘K ⌘T', tr('中控屏的编辑器里换颜色主题和文件图标')],
];

export function SettingsPanel({ open, hud, onClose }: { open: boolean; hud: Hud | null; onClose: () => void }) {
  const s = useSettings();
  const [tab, setTab] = useState<Tab>('look');
  const changed = JSON.stringify(s) !== JSON.stringify(DEFAULTS);
  if (!open) return null;
  return (
    <div className="st-back" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="settings pnl" role="dialog" aria-modal="true" aria-label={tr('设置')}>
        <nav className="st-nav">
          <h2>{tr('设置')}</h2>
          {TABS.map(([k, name, sub]) => (
            <button key={k} className={k === tab ? 'on' : ''} onClick={() => setTab(k)}><b>{name}</b><span>{sub}</span></button>
          ))}
          <button className="btn st-reset" disabled={!changed} onClick={resetSettings} title={tr('外观、地图和 3D 的设置回到默认')}>{tr('恢复默认')}</button>
        </nav>
        <section className="st-body" key={tab}>
          <header><h3>{TABS.find(t => t[0] === tab)![1]}</h3><button className="sh-x" onClick={onClose} title={tr('关闭（Esc）')}>×</button></header>
          {tab === 'look' && <Look s={s} />}
          {tab === 'editor' && <Editor s={s} />}
          {tab === 'map' && <MapTab s={s} />}
          {tab === 'walk' && <Walk s={s} />}
          {tab === 'model' && <Model />}
          {tab === 'agents' && <Agents />}
          {tab === 'demo' && <Demo hud={hud} />}
          {tab === 'keys' && <div className="st-keys">{KEYS.map(([k, v]) => <div key={k}><kbd>{k}</kbd><span>{v}</span></div>)}</div>}
        </section>
      </div>
    </div>
  );
}
