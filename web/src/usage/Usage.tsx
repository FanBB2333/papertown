// Global subscription windows and project session billing statistics.
import { StateWord, stateTone } from '../emphasis';
import { Button, Dialog, Input } from '@cloudflare/kumo';
import { Fragment, useEffect, useState } from 'react';
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

// A translated sentence with its {0}, {1}… filled by nodes, so the numbers in it can stand out.
function rich(s: string, ...parts: React.ReactNode[]) {
  return s.split(/\{(\d+)\}/).map((x, i) => i % 2 ? <Fragment key={i}>{parts[+x]}</Fragment> : x);
}
// A figure in a rounded tile: a small label above, the value large, an optional line below.
function Stat({ label, value, note, tone, empty }: { label: string; value: React.ReactNode; note?: React.ReactNode; tone?: UsageState; empty?: boolean }) {
  return <div className={`usage-stat${tone ? ` usage-${tone}` : ''}${empty ? ' empty' : ''}`}><small>{label}</small><b className={empty ? undefined : 'em-num'} data-tone={stateTone(tone)}>{value}</b>{note && <span>{note}</span>}</div>;
}
const shortDate = (s: string | null) => s ? new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'numeric', day: 'numeric' }) : tr('尚未开始');

function Bar({ value, state = 'ok', label }: { value: number; state?: UsageState; label: string }) {
  return <div className={`usage-bar usage-${state}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, value)} aria-valuetext={pct(value)}>
    <i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
  </div>;
}

export function UsageMark({ state }: { state?: UsageState }) {
  return state === 'near' || state === 'over' ? <StateWord state={state}>{STATES[state]}</StateWord> : null;
}

// A quota window the way a terminal status line shows it: 5h or 7d, ten segments, the percent coloured by how
// much is used, and the time left until it resets.
const isFive = (w: UsageWindow) => w.id === 'five_hour' || /(^|[-_])5h$/.test(w.id) || w.label === '5 小时额度' || w.label === 'Session';
const isWeek = (w: UsageWindow) => w.id.includes('weekly') || w.label === '每周额度' || w.label.startsWith('Weekly');
const span = (w: UsageWindow) => isFive(w) ? '5h' : isWeek(w) ? '7d' : '';
// what a window counts beyond its span: a model group (Antigravity) or one model (Claude's "Weekly · Fable")
const GROUPS: Record<string, string> = { 'Gemini Models': 'Gemini', 'Claude and GPT models': 'Claude/GPT' };
const scope = (w: UsageWindow) => w.group ? GROUPS[w.group] ?? tr(w.group) : w.label.includes('·') ? w.label.split('·').pop()!.trim() : '';
const windowName = (w: UsageWindow) => {
  const base = isFive(w) ? tr('5 小时额度') : isWeek(w) ? tr('每周额度') : tr(w.label), s = scope(w);
  return s ? tr('{0} · {1}', base, s) : base;
};
const level = (n: number) => n >= 80 ? 'high' : n >= 50 ? 'mid' : 'low';
function until(at: string | null): string {
  if (!at) return tr('未开始');
  const m = Math.round((new Date(at).getTime() - Date.now()) / 60000);
  if (m <= 0) return tr('已重置');
  const d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60);
  return d ? `${d}d${h}h` : h ? `${h}h${m % 60}m` : `${m}m`;
}
const quotaTone = (used: number) => used >= 100 ? 'bad' : used >= 80 ? 'warn' : 'info';
const order = (w: UsageWindow) => (scope(w) ? 10 : 0) + (isFive(w) ? 0 : isWeek(w) ? 1 : 2);

// ten cells like the Claude Code status bar: ▰ for each tenth used (rounded half up, so 3% draws none), ▱ for the rest
function Segments({ value, label, wide }: { value: number; label: string; wide?: boolean }) {
  const on = Math.min(10, Math.max(0, Math.floor((Math.round(value) * 10 + 50) / 100)));
  return <span className={`usage-seg${wide ? ' wide' : ''}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100}
    aria-valuenow={Math.min(100, value)} aria-valuetext={pct(value)}>
    {Array.from({ length: 10 }, (_, i) => <i key={i} className={i < on ? 'on' : undefined} style={{ ['--i' as string]: i }} />)}
  </span>;
}

function Window({ w }: { w: UsageWindow }) {
  const name = windowName(w), s = scope(w);
  return <div className={`usage-window usage-q-${level(w.used)}`}>
    <div className="usage-between"><span className="usage-wname">{isFive(w) ? tr('5 小时额度') : isWeek(w) ? tr('每周额度') : tr(w.label)}{s && <span className="usage-chip">{s}</span>}</span>
      <span className="usage-q-num"><b className="em-num" data-tone={quotaTone(w.used)}>{pct(w.used)}</b><small className={w.resets_at ? 'em-state' : undefined} data-tone="warn" data-icon="clock">{until(w.resets_at)}</small></span></div>
    <Segments value={w.used} label={name} wide />
    <small>{w.resets_at ? rich(tr('剩余 {0} · {1} 重置'), <b className="em-num" data-tone={quotaTone(w.used)}>{pct(w.left)}</b>, <b className="em-state" data-tone="warn" data-icon="clock">{resetDate(w.resets_at)}</b>) : rich(tr('剩余 {0} · 尚未开始计时'), <b className="em-num" data-tone={quotaTone(w.used)}>{pct(w.left)}</b>)}</small>
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
  // one line per window, like a status line: a subscription's name on its first line only, a window not started yet left
  // to the details; the strip sits under the employee list and opens upward for the rest
  // a group with two windows writes its subscription on the first line and the group on the second, so neither is cut short
  const rows = (view?.providers ?? []).flatMap(p => {
    const ws = p.windows.filter(w => w.used > 0 || w.resets_at).sort((a, b) => order(a) - order(b));
    return ws.map(w => {
      const s = scope(w), same = ws.filter(x => scope(x) === s), at = same.indexOf(w), full = s ? tr('{0} · {1}', p.label, s) : p.label;
      const name = at === 0 ? (s && same.length > 1 ? p.label : full) : at === 1 && s ? s : '';
      return { p, w, full, name, sub: at === 1 && !!s };
    });
  });
  return <section className={`usage-strip${open ? ' open' : ''}`} aria-label={tr('订阅用量')}>
    <div id="usage-details" className="usage-details" hidden={!open}>
      {view?.providers.map(p => <div className="usage-provider" key={p.id}>
        <div className="usage-between usage-head"><b className="usage-name">{p.label}</b>{p.plan ? <span className="usage-plan" title={tr('套餐：{0}', p.plan)}>{p.plan}</span> : <span className="usage-plan-none">{tr('套餐未提供')}</span>}</div>
        <small>{tr('读取于 {0}', p.fetched_at ? date(p.fetched_at) : tr('尚未读取'))}</small>
        {[...p.windows].sort((a, b) => order(a) - order(b)).map(w => <Window w={w} key={w.key} />)}
        {!p.windows.length && <small>{tr('尚无用量读数')}</small>}
        {p.status === 'stale' && <p className="small em-state" data-tone="warn">{tr('显示最近成功读数')}</p>}
        {p.error && <p className="small em-state" data-tone="warn">{tr(p.error)}</p>}
        {p.balances.map(b => <p className="usage-balance" key={b.id}><span className="usage-chip">{tr(b.label)}</span>{rich(tr('额外余额：{0} {1}'), <b className="em-num">{b.remaining ?? '—'}</b>, b.unit)}</p>)}
        {view.logs && <div className="usage-stats">
          <Stat label={tr('本周本机折合')} value={money(p.week.cost)} />
          <Stat label={tr('其中项目')} value={money(p.week.projects)} />
        </div>}
        {view.logs && !!p.week.unpriced.length && <small>{tr('以下模型缺价格，未计入金额：{0}', p.week.unpriced.join('、'))}</small>}
        {p.notes.map(n => <p className="small em-state" data-tone="warn" key={n}>{tr('另有一个登录读取失败：{0}', tr(n))}</p>)}
      </div>)}
      <p>{view?.logs ? tr('按 API 价格折算。本周从周一零点起算。') : tr('本机会话日志读取已关闭，项目用量统计已暂停。')}</p>
      {view?.log_error && <p className="usage-error em-state" data-tone="bad">{tr(view.log_error)}</p>}
      <div className="usage-between usage-foot">
        {view?.polled_at ? <small>{tr('上次读取额度：{0}', date(view.polled_at))}</small> : <span />}
        <button className="btn" disabled={busy} onClick={refresh} title={tr('每个订阅每分钟至多强制刷新一次')}>{busy ? tr('读取中…') : tr('刷新')}</button>
      </div>
    </div>
    <button className="usage-toggle" aria-expanded={open} aria-controls="usage-details" onClick={() => setOpen(!open)}>
      <span>{tr('订阅用量')}</span><i className="usage-chevron" aria-hidden="true" />
    </button>
    {error && <p role="alert" className="usage-error em-state" data-tone="bad">{tr(error)}</p>}
    {!view && !error && <p className="usage-wait">{tr('加载中…')}</p>}
    {!open && <ul className="usage-mini">
      {rows.map(({ p, w, full, name, sub }) => <li key={w.key} className={`usage-q usage-q-${level(w.used)}`}
        title={`${p.plan ? tr('{0}（{1}）', p.label, p.plan) : p.label} · ${windowName(w)} · ${pct(w.used)} · ${tr('重置：{0}', resetDate(w.resets_at))}`}>
        <span className={`usage-q-name${sub ? ' sub' : ''}`}>{name}</span>
        <span className="usage-q-span">{span(w) || tr(w.label)}</span>
        <Segments value={w.used} label={tr('{0} · {1}', full, windowName(w))} />
        <b className="em-num" data-tone={quotaTone(w.used)}>{Math.round(w.used)}%</b>
        <small className={w.resets_at ? 'em-state' : undefined} data-tone="warn" data-icon="clock">{until(w.resets_at)}</small>
      </li>)}
      {view?.providers.filter(p => !p.windows.length || p.error).map(p => <li key={p.id} className="usage-mini-note"><span>{p.label}</span><small><StateWord state={p.error ? 'error' : undefined}>{p.error ? tr(p.error) : tr('尚无用量读数')}</StateWord></small></li>)}
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
        {error && <p role="alert" className="em-state" data-tone="bad">{tr(error)}</p>}
        <div className="usage-actions"><Button type="button" disabled={busy} onClick={onClose}>{tr('取消')}</Button><Button type="submit" variant="primary" loading={busy}>{confirm}</Button></div>
      </form>
    </Dialog>
  </Dialog.Root>;
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
    {error && <p role="alert" className="usage-error em-state" data-tone="bad">{tr(error)}</p>}
    {!value && !error && <p>{tr('加载中…')}</p>}
    {value && <>
      <div className="usage-stats">
        <Stat label={tr('Agent 累计用量')} value={money(value.spent)} note={tr('自 {0} 起', shortDate(value.since))} />
        <Stat label={tr('本周 Agent 用量')} value={money(value.week)} note={tr('从周一零点起算')} />
        <Stat label={tr('预算')} value={value.budget === null ? tr('未设预算') : money(value.budget)} empty={value.budget === null} tone={value.budget === null ? undefined : value.state}
          note={value.budget === null ? undefined : tr('已用 {0} · {1}', pct(Math.round(value.spent / value.budget * 1000) / 10), STATES[value.state])} />
      </div>
      {value.budget !== null && <Bar value={value.spent / value.budget * 100} state={value.state} label={tr('Agent 预算使用比例')} />}
      <small>{tr('金额按 API 价格折算。')}</small>
      {!value.logs && <p>{tr('本机会话日志读取已关闭，项目用量统计已暂停。')}</p>}
      <h3>{tr('订阅与模型')}</h3>
      {value.providers.map(p => <div className="usage-provider" key={p.id}>
        <div className="usage-between usage-head"><b className="usage-name">{providerName(p.id)}</b><span className="em-num usage-cost">{money(p.cost)}</span></div>
        <Tokens tokens={p.tokens} />
        {value.models.filter(m => m.provider === p.id).map(m => <div className="usage-model" key={m.model}>
          <div className="usage-between usage-head"><code className="usage-code">{m.model}</code>{m.priced ? <span className="em-num usage-cost sm">{money(m.cost)}</span> : <span className="em-state" data-tone="warn">{tr('缺价格')}</span>}</div>
          <Tokens tokens={m.tokens} />
        </div>)}
      </div>)}
      {!value.providers.length && <p>{tr('尚无项目会话用量')}</p>}
      {value.models.some(m => !m.priced) && <small>{tr('缺价格的模型仅计入 token，金额暂未计入合计。')}</small>}
      <h3>{tr('会话明细')}</h3>
      {value.sessions.map(s => <div className="usage-provider" key={`${s.provider}/${s.session}`}>
        <div className="usage-between usage-head"><b className="usage-name">{s.owner.kind === 'dir' ? tr('目录会话') : tr(s.owner.name)}</b><span className="em-num usage-cost">{money(s.cost)}</span></div>
        <div className="usage-meta"><span className="usage-chip">{providerName(s.provider)}</span><code className="usage-code dim" title={s.session}>{s.session}</code></div>
        <code className="usage-path">{s.cwd}</code>
        <Tokens tokens={s.tokens} />
        <small>{rich(tr('最近用量：{0}'), <b>{date(s.last_at)}</b>)}</small>
      </div>)}
    </>}
    {editing && value && <BudgetDialog title={tr('修改预算')} initial={value.budget} confirm={tr('保存')} onClose={() => setEditing(false)} onSave={async budget => setValue(await api.setUsageBudget(lineId, budget))} />}
  </section>;
}

// Token counts as label and figure pairs, the figure short (454.3M) with the exact count on hover.
const TOKEN_KINDS: [keyof UsageTokens, string][] = [['input', '输入'], ['cache_write', '缓存写入'], ['cache_read', '缓存读取'], ['output', '输出']];
function Tokens({ tokens }: { tokens: UsageTokens }) {
  return <p className="usage-tokens"><span className="usage-chip">token</span>
    {TOKEN_KINDS.map(([k, label]) => <span key={k} title={tokens[k].toLocaleString()}>{tr(label)} <b>{tokens[k].toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 })}</b></span>)}
  </p>;
}
