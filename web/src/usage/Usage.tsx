// Global subscription windows and project session billing statistics.
import { Banner, Button, Dialog, Input } from '@cloudflare/kumo';
import { useEffect, useState } from 'react';
import { api, listen, type LineUsage, type UsageBudget, type UsageProviderId, type UsageState, type UsageView, type UsageWindow, type UsageTokens } from '../api';
import { tr } from '../i18n';
import './usage.css';

export const PROVIDERS: [UsageProviderId, string][] = [['claude', 'Claude'], ['codex', 'Codex'], ['antigravity', 'Antigravity']];
const STATES: Record<UsageState, string> = { none: tr('未设预算'), ok: tr('正常'), near: tr('接近预算'), over: tr('超出预算') };
const date = (s: string | null) => s ? new Date(s).toLocaleString() : tr('尚未开始');
const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 })}`;
const providerName = (id: UsageProviderId) => PROVIDERS.find(p => p[0] === id)?.[1] || id;
// Providers report whole percents, Antigravity reports fractions: show at most one decimal.
const pct = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)}%`;
const resetDate = (s: string | null) => s ? new Date(s).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : tr('尚未开始');

function Bar({ value, state = 'ok', label }: { value: number; state?: UsageState; label: string }) {
  return <div className={`usage-bar usage-${state}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, value)} aria-valuetext={pct(value)}>
    <i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
  </div>;
}

export function UsageMark({ state }: { state?: UsageState }) {
  return state === 'near' || state === 'over' ? <span className={`usage-mark usage-${state}`}>{STATES[state]}</span> : null;
}

function Window({ w }: { w: UsageWindow }) {
  const label = w.id === 'weekly' ? tr('每周额度') : w.id === 'five_hour' ? tr('5 小时额度') : tr(w.label);
  return <div className="usage-window">
    <div className="usage-between"><span>{w.group ? tr('{0} · {1}', tr(w.group), label) : label}</span><b>{pct(w.used)}</b></div>
    <Bar value={w.used} label={label} />
    <small>{tr('剩余 {0} · 重置 {1}', pct(w.left), date(w.resets_at))}</small>
  </div>;
}

export function UsageStrip({ active }: { active: boolean }) {
  const [view, setView] = useState<UsageView | null>(null), [error, setError] = useState('');
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const load = () => api.usage().then(v => { if (alive) { setView(v); setError(''); } }, e => alive && setError((e as Error).message));
    void load();
    const off = listen(e => { if (e.type === 'usage') void load(); });
    const timer = setInterval(load, 30000);
    return () => { alive = false; off(); clearInterval(timer); };
  }, [active]);
  async function refresh() {
    setBusy(true);
    try { setView(await api.refreshUsage()); setError(''); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  // one line per weekly window: the strip sits under the employee list and opens upward for the rest
  const weekly = (view?.providers ?? []).flatMap(p => p.windows.filter(w => w.id === 'weekly' || w.label === '每周额度').map(w => ({ p, w })));
  return <section className={`usage-strip${open ? ' open' : ''}`} aria-label={tr('订阅用量')}>
    <div id="usage-details" className="usage-details" hidden={!open}>
      {view?.providers.map(p => <div className="usage-provider" key={p.id}>
        <div className="usage-between"><b>{p.label}</b><span>{p.plan || tr('套餐未提供')}</span></div>
        <small>{tr('读取于 {0}', p.fetched_at ? date(p.fetched_at) : tr('尚未读取'))}</small>
        {p.windows.map(w => <Window w={w} key={w.key} />)}
        {!p.windows.length && <small>{tr('尚无用量读数')}</small>}
        {p.status === 'stale' && <small className="usage-error">{tr('显示最近成功读数')}</small>}
        {p.error && <p className="usage-error">{tr(p.error)}</p>}
        {p.balances.map(b => <p key={b.id}>{tr(b.label)} · {tr('额外余额：{0} {1}', b.remaining ?? '—', b.unit)}</p>)}
        {view.logs && <p>{tr('本周本机折合 {0}，其中项目 {1}', money(p.week.cost), money(p.week.projects))}</p>}
        {view.logs && !!p.week.unpriced.length && <small>{tr('以下模型缺价格，未计入金额：{0}', p.week.unpriced.join('、'))}</small>}
        {p.notes.map(n => <small key={n}>{tr('另有一个登录读取失败：{0}', tr(n))}</small>)}
      </div>)}
      <p>{view?.logs ? tr('按 API 价格折算。本周从周一零点起算。') : tr('本机会话日志读取已关闭，项目用量统计已暂停。')}</p>
      {view?.log_error && <p className="usage-error">{tr(view.log_error)}</p>}
      <div className="usage-between usage-foot">
        {view?.next_at ? <small>{tr('下次轮询：{0}', date(view.next_at))}</small> : <span />}
        <button className="btn" disabled={busy} onClick={refresh} title={tr('每个订阅每分钟至多强制刷新一次')}>{busy ? tr('读取中…') : tr('刷新')}</button>
      </div>
    </div>
    <button className="usage-toggle" aria-expanded={open} aria-controls="usage-details" onClick={() => setOpen(!open)}>
      <span>{tr('订阅用量')}</span><i className="usage-chevron" aria-hidden="true" />
    </button>
    {error && <p role="alert" className="usage-error">{tr(error)}</p>}
    {!view && !error && <p className="usage-wait">{tr('加载中…')}</p>}
    {!open && <ul className="usage-mini">
      {weekly.map(({ p, w }) => <li key={w.key} title={`${w.group ? tr('{0} · {1}', p.label, tr(w.group)) : p.label} · ${tr('重置：{0}', resetDate(w.resets_at))}`}>
        <span>{w.group ? tr('{0} · {1}', p.label, tr(w.group)) : p.label}</span>
        <Bar value={w.used} label={tr('{0} · {1}', p.label, tr('每周额度'))} />
        <b>{pct(w.used)}</b>
      </li>)}
      {view?.providers.filter(p => !p.windows.length || p.error).map(p => <li key={p.id} className="usage-mini-note"><span>{p.label}</span><small>{p.error ? tr(p.error) : tr('尚无用量读数')}</small></li>)}
    </ul>}
  </section>;
}

export function BudgetFields({ value, onChange, disabled }: { value: UsageBudget; onChange: (v: UsageBudget) => void; disabled?: boolean }) {
  return <div className="usage-fields"><Input label={tr('预计 Agent 用量（按 API 价格折算，美元）')} type="number" min={0.000001} step="any" disabled={disabled}
    value={value ?? ''} placeholder={tr('不设预算')} onChange={e => onChange(e.target.value === '' ? null : Number(e.target.value))} /></div>;
}

export function BudgetDialog({ title, initial, confirm, onSave, onClose }: {
  title: string; initial: UsageBudget; confirm: string; onSave: (v: UsageBudget) => Promise<unknown>; onClose: () => void;
}) {
  const [value, setValue] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try { await onSave(value); onClose(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <Dialog.Root open onOpenChange={v => { if (!v && !busy) onClose(); }}>
    <Dialog size="sm" className="st-dlg usage-dialog">
      <Dialog.Title>{title}</Dialog.Title>
      <Dialog.Description>{tr('留空表示不设预算。金额按 API 价格折算，用于衡量 Agent 用量。')}</Dialog.Description>
      <form onSubmit={save}>
        <BudgetFields value={value} onChange={setValue} disabled={busy} />
        {error && <Banner variant="error" description={tr(error)} />}
        <div className="usage-actions"><Button type="button" disabled={busy} onClick={onClose}>{tr('取消')}</Button><Button type="submit" variant="primary" loading={busy}>{confirm}</Button></div>
      </form>
    </Dialog>
  </Dialog.Root>;
}

export function HatchDialog({ lineId, onDone, onClose }: { lineId: string; onDone: () => void; onClose: () => void }) {
  const [defaults, setDefaults] = useState<UsageBudget | undefined>(undefined), [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    api.usageSettings().then(s => { if (alive) setDefaults(s.default_budget); }, e => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, []);
  if (defaults === undefined) return <Dialog.Root open onOpenChange={v => { if (!v) onClose(); }}><Dialog size="sm" className="st-dlg">
    <Dialog.Title>{tr('开启项目')}</Dialog.Title><Dialog.Description>{error ? tr(error) : tr('正在读取默认预算…')}</Dialog.Description>
    <Button onClick={onClose}>{tr('取消')}</Button>
  </Dialog></Dialog.Root>;
  return <BudgetDialog title={tr('开启项目')} initial={defaults} confirm={tr('开启项目')} onClose={onClose} onSave={async budget => { await api.hatch(lineId, budget); onDone(); }} />;
}

export function ProjectUsage({ lineId }: { lineId: string }) {
  const [value, setValue] = useState<LineUsage | null>(null), [error, setError] = useState(''), [editing, setEditing] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () => api.lineUsage(lineId).then(v => { if (alive) { setValue(v); setError(''); } }, e => alive && setError((e as Error).message));
    void load();
    const off = listen(e => { if (e.type === 'usage') void load(); });
    return () => { alive = false; off(); };
  }, [lineId]);
  return <section className="pj-box usage-project">
    <header className="usage-between"><h2>{tr('用量与预算')}</h2><button className="btn" disabled={!value} onClick={() => setEditing(true)}>{tr('修改预算')}</button></header>
    {error && <p role="alert" className="usage-error">{tr(error)}</p>}
    {!value && !error && <p>{tr('加载中…')}</p>}
    {value && <>
      <p>{tr('Agent 用量：{0} / 预算 {1}（{2}）', money(value.spent), value.budget === null ? tr('未设预算') : money(value.budget), STATES[value.state])}</p>
      {value.budget !== null && <Bar value={value.spent / value.budget * 100} state={value.state} label={tr('Agent 预算使用比例')} />}
      <p>{tr('本周 Agent 用量：{0}', money(value.week))}</p>
      <small>{tr('自 {0} 起累计，按 API 价格折算。本周从周一零点起算。', date(value.since))}</small>
      {!value.logs && <p>{tr('本机会话日志读取已关闭，项目用量统计已暂停。')}</p>}
      <h3>{tr('订阅与模型')}</h3>
      {value.providers.map(p => <div className="usage-provider" key={p.id}>
        <div className="usage-between"><b>{providerName(p.id)}</b><span>{money(p.cost)}</span></div>
        <Tokens tokens={p.tokens} />
        {value.models.filter(m => m.provider === p.id).map(m => <div className="usage-model" key={m.model}>
          <div className="usage-between"><span>{m.model}</span><span>{m.priced ? money(m.cost) : tr('缺价格')}</span></div>
          <Tokens tokens={m.tokens} />
        </div>)}
      </div>)}
      {!value.providers.length && <p>{tr('尚无项目会话用量')}</p>}
      {value.models.some(m => !m.priced) && <small>{tr('缺价格的模型仅计入 token，金额暂未计入合计。')}</small>}
      <h3>{tr('会话明细')}</h3>
      {value.sessions.map(s => <div className="usage-provider" key={`${s.provider}/${s.session}`}>
        <div className="usage-between"><b>{s.owner.kind === 'dir' ? tr('目录会话') : tr(s.owner.name)}</b><span>{money(s.cost)}</span></div>
        <small>{providerName(s.provider)} · {s.session}</small>
        <small className="usage-path">{s.cwd}</small>
        <Tokens tokens={s.tokens} />
        <small>{tr('最近用量：{0}', date(s.last_at))}</small>
      </div>)}
    </>}
    {editing && value && <BudgetDialog title={tr('修改预算')} initial={value.budget} confirm={tr('保存')} onClose={() => setEditing(false)} onSave={async budget => setValue(await api.setUsageBudget(lineId, budget))} />}
  </section>;
}

function Tokens({ tokens }: { tokens: UsageTokens }) {
  return <p className="usage-tokens">{tr('token：输入 {0} · 缓存写入 {1} · 缓存读取 {2} · 输出 {3}',
    ...[tokens.input, tokens.cache_write, tokens.cache_read, tokens.output].map(n => n.toLocaleString()))}</p>;
}
