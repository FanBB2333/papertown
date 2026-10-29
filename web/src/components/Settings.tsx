// Settings: one sheet for everything you can set from the page. Looks and motion, the 2D
// map, the 3D walk (kept in this browser, see settings.ts), the town's own model and the
// agents' runtimes (on the server), the demo samples, and the keys.

import { useEffect, useState } from 'react';
import { api, listen, type Hud, type Llm, type PaseoInfo, type Roster } from '../api';
import { DEFAULTS, resetSettings, setSettings, useSettings, type Settings as S } from '../settings';
import { LlmForm } from './Drawer';
import '../settings.css';

type Tab = 'look' | 'map' | 'walk' | 'model' | 'agents' | 'demo' | 'keys';
const TABS: [Tab, string, string][] = [
  ['look', '外观与动效', '动画、纸纹、打开时的视图'],
  ['map', '平面地图', '缩放、拖动、建筑名字'],
  ['walk', '3D 漫游', '鼠标、视野、手、画质'],
  ['model', '模型', '小镇员工用的大模型'],
  ['agents', '员工 Agent', 'Paseo 和本机 pi'],
  ['demo', '展示模式', '样例项目和调研文章'],
  ['keys', '快捷键', '所有按键一览'],
];

function Row({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="st-row">
      <div className="st-l"><b>{label}</b>{desc && <span>{desc}</span>}</div>
      <div className="st-c">{children}</div>
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
      <Row label="动画" desc="柔和：动画更短更轻，适合投影或容易晕的时候">
        <Pick value={s.motion} options={[['full', '完整'], ['calm', '柔和']]} onChange={set('motion')} />
      </Row>
      <Row label="纸纹" desc="盖在整个页面上的纸张纹理">
        <Slider value={s.grain} min={0} max={1} step={0.05} fmt={v => v ? `${Math.round(v * 100)}%` : '关'} onChange={set('grain')} />
      </Row>
      <Row label="打开小镇时" desc="下次打开页面先看到哪种视图">
        <Pick value={s.start} options={[['2d', '平面地图'], ['3d', '3D 漫游']]} onChange={set('start')} />
      </Row>
    </>
  );
}

function MapTab({ s }: { s: S }) {
  return (
    <>
      <Row label="顺滑缩放和拖动" desc="缩放带缓动，松手后地图会顺势滑一小段">
        <Toggle value={s.smoothMap} onChange={set('smoothMap')} />
      </Row>
      <Row label="滚轮缩放速度">
        <Slider value={s.zoomSpeed} min={0.5} max={2} step={0.1} fmt={v => `${v.toFixed(1)}×`} onChange={set('zoomSpeed')} />
      </Row>
      <Row label="建筑名字" desc="主要：四座核心建筑和几处地标；全部：每栋都标">
        <Pick value={s.mapLabels} options={[['key', '主要'], ['all', '全部']]} onChange={set('mapLabels')} />
      </Row>
      <Row label="走动提示" desc="地图底部的按键提示">
        <Toggle value={s.walkHint} onChange={set('walkHint')} />
      </Row>
    </>
  );
}

function Walk({ s }: { s: S }) {
  return (
    <>
      <Row label="鼠标灵敏度" desc="鼠标锁在画面中间时，移动多少转多少">
        <Slider value={s.sensitivity} min={0.3} max={3} step={0.05} fmt={v => `${v.toFixed(2)}×`} onChange={set('sensitivity')} />
      </Row>
      <Row label="上下反转" desc="鼠标往前推是低头">
        <Toggle value={s.invertY} onChange={set('invertY')} />
      </Row>
      <Row label="视野" desc="越大看得越广，边缘拉伸也越明显">
        <Slider value={s.fov} min={55} max={95} step={1} fmt={v => `${v}°`} onChange={set('fov')} />
      </Row>
      <Row label="显示手" desc="画面右下角你的手和铅笔，走路时会跟着摆">
        <Toggle value={s.hand} onChange={set('hand')} />
      </Row>
      <Row label="走路时晃动" desc="视角随步子轻轻上下">
        <Toggle value={s.bob} onChange={set('bob')} />
      </Row>
      <Row label="画质" desc="低：不画阴影、降低分辨率，老电脑更流畅">
        <Pick value={s.quality} options={[['low', '低'], ['mid', '中'], ['high', '高']]} onChange={set('quality')} />
      </Row>
      <Row label="建筑名字" desc="悬在建筑上方的名字">
        <Toggle value={s.tags3d} onChange={set('tags3d')} />
      </Row>
      <Row label="小地图" desc="右下角的小地图，点一下就过去">
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
  if (!llm) return <p className="muted">读取中…</p>;
  const name = llm.providers.find(x => x.id === llm.provider)?.name ?? llm.provider;
  return (
    <>
      <p className="st-note">现在：<b>{name}</b> · {llm.model_strong}{llm.model_cheap !== llm.model_strong ? ` / ${llm.model_cheap}` : ''}{llm.offline ? '（离线模式，员工按 skill 的步骤调用工具，文字用模板）' : ''}</p>
      <LlmForm key={n} llm={llm} onDone={l => { if (l) setLlm(l); setN(x => x + 1); }} />
      <p className="muted small">仓库和印刷厂里的代码、写作员工用的是 Paseo 或 pi 自己的模型，在各自的房间里切换。</p>
    </>
  );
}

function Agents() {
  const [paseo, setPaseo] = useState<PaseoInfo | null | 'err'>(null);
  const [pi, setPi] = useState<Roster['available'] | null>(null);
  useEffect(() => {
    api.paseo().then(setPaseo).catch(() => setPaseo('err'));
    api.roster('coder').then(r => setPi(r.available)).catch(() => {});
  }, []);
  const st = paseo && paseo !== 'err' ? paseo.status : null;
  return (
    <>
      <Row label="Paseo" desc="托管 Claude Code、Codex、OpenCode 等 agent 的本机守护进程">
        <span className={`chip ${st?.ok ? 'ok' : 'warn'}`}>{paseo === null ? '检查中…' : st?.ok ? `已连接${st.version ? ` · ${st.version}` : ''}` : '未连接'}</span>
      </Row>
      {st && !st.ok && <p className="warn-box small">{st.note}</p>}
      {st?.ok && (
        <>
          <Row label="网页端" desc="房间里「完整界面」嵌入的就是它">
            <span className="muted small">{st.web ?? '没开：paseo daemon config set features.webUi.enabled true'}</span>
          </Row>
          <Row label="可用的供应商">
            <span className="st-tags">{paseo !== 'err' && paseo?.providers.map(p => <span key={p.id} className="chip">{p.label} · {p.models.length} 个模型</span>)}</span>
          </Row>
        </>
      )}
      <Row label="本机 pi" desc="跑在 tmux 里的后台终端 agent">
        <span className={`chip ${pi?.ok ? 'ok' : 'warn'}`}>{pi === null ? '检查中…' : pi.ok ? '可用' : '不可用'}</span>
      </Row>
      {pi && !pi.ok && <p className="warn-box small">{pi.note}</p>}
      <p className="muted small">雇员工、导入 Paseo 里已有的对话、切换模型和思考强度，都在仓库和印刷厂的房间里。</p>
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
      <Row label="现在" desc="没有配置模型 key 时就是展示模式">
        <span className={`chip ${hud?.offline ? 'warn' : 'ok'}`}>{hud ? (hud.offline ? '展示模式（离线）' : `在线 · ${hud.provider}`) : '…'}</span>
      </Row>
      <Row label="样例项目" desc="放入几篇写到不同工序的样例论文：有的已出厂，有的停在实验或写作前，有的等你决定孵不孵化">
        <button className="btn pri" disabled={busy || !hud?.offline} onClick={seed}>{busy ? '放入中…' : '放入样例项目'}</button>
      </Row>
      {!hud?.offline && <p className="muted small">接了模型以后样例也会真的调用模型、花钱，所以只在展示模式里提供。</p>}
      {msg && <p className="st-note">{msg}</p>}
      <Row label="调研文章" desc="图书馆的馆藏，样例项目查重和写方法时从这里找相近工作">
        <span className="muted small">馆藏 {hud?.library ?? '…'} 篇 · 在小镇里进图书馆翻看</span>
      </Row>
    </>
  );
}

const KEYS: [string, string][] = [
  ['W A S D / 方向键', '走动（3D 里 ←/→ 转身）'], ['Shift', '3D 里跑'], ['E / Enter / 空格', '进门口或准星对着的建筑'],
  ['鼠标', '3D 里转视角；平面上拖动地图、滚轮缩放'], ['点击', '平面上进建筑；3D 里进准星对着的建筑'],
  ['M', '3D 里回到平面'], ['Esc', '放开鼠标 / 关闭对话 / 回到小镇 / 关闭设置'], [',', '打开设置'],
];

export function SettingsPanel({ open, hud, onClose }: { open: boolean; hud: Hud | null; onClose: () => void }) {
  const s = useSettings();
  const [tab, setTab] = useState<Tab>('look');
  const changed = JSON.stringify(s) !== JSON.stringify(DEFAULTS);
  if (!open) return null;
  return (
    <div className="st-back" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="settings pnl" role="dialog" aria-modal="true" aria-label="设置">
        <nav className="st-nav">
          <h2>设置</h2>
          {TABS.map(([k, name, sub]) => (
            <button key={k} className={k === tab ? 'on' : ''} onClick={() => setTab(k)}><b>{name}</b><span>{sub}</span></button>
          ))}
          <button className="btn st-reset" disabled={!changed} onClick={resetSettings} title="外观、地图和 3D 的设置回到默认">恢复默认</button>
        </nav>
        <section className="st-body" key={tab}>
          <header><h3>{TABS.find(t => t[0] === tab)![1]}</h3><button className="sh-x" onClick={onClose} title="关闭（Esc）">×</button></header>
          {tab === 'look' && <Look s={s} />}
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
