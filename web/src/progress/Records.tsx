// Shared links and summaries for project decisions and provenance.
import { modelText, type Tone } from '../emphasis';
import { Button, Select } from '@cloudflare/kumo';
import { useEffect, useReducer, type ComponentProps, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { listen, type DecisionStats, type Material, type Op, type ProjectCard, type ProvStats } from '../api';
import { Icon } from '../console/icons';
import { FLOW, type FlowPart } from '../flow';
import { tr, trx } from '../i18n';
import { conversationPath, decidedPath, filePath, follow, href, jobPath, provPath } from '../route';
import { loopPath } from './loop';
import './decided.css';

export function RecordLink({ to, children, ...props }: Omit<ComponentProps<'a'>, 'href' | 'onClick'> & { to: string }) {
  return <a {...props} href={href(to)} onClick={e => follow(e, to)}>{children}</a>;
}

export function DetailHeading({ children, to }: { children: ReactNode; to: string }) {
  return <header className="rec-detail-head"><div>{children}</div>
    <RecordLink className="rec-close" aria-label={tr('收起详情')} title={tr('收起详情')} to={to}><Icon n="close" size={15} /></RecordLink>
  </header>;
}

export function useRecordTick(line: string, kind: 'decided' | 'prov') {
  const [tick, reload] = useReducer(n => n + 1, 0);
  useEffect(() => listen(e => {
    if (e.line_id === line && e.type === kind) reload();
    else if (kind === 'decided' && ((['prov', 'canvas'].includes(e.type) && e.line_id === line) || e.job?.line_id === line ||
      e.report?.line_id === line || e.line?.id === line || (e.event?.kind === 'sent' && e.event.data?.line_id === line))) reload();
  }), [line, kind]);
  return [tick, reload] as const;
}

export function RecordPage({ r, title, stats, actions, listPath, children }: {
  r: ProjectCard; title: string; stats?: ReactNode; actions: ReactNode; listPath?: string; children: ReactNode;
}) {
  return createPortal(<main className="ak records" data-detail={listPath ? true : undefined} role="dialog" aria-modal="true" aria-label={title}>
    <header className="rec-top"><nav className="rec-wrap">
      <RecordLink className="ak-back" to={`/progress/${r.line.seq}`}><Icon n="left" size={14} />{tr('返回项目')}</RecordLink>
      {listPath && <RecordLink className="ak-back rec-list-back" to={listPath}><Icon n="left" size={14} />{tr('返回列表')}</RecordLink>}
      <span className="rec-project"><code>#{r.line.seq}</code> {r.line.title}</span>
    </nav></header>
    <div className="rec-body rec-wrap">
      <header className="rec-heading pj-title"><h1>{title}</h1>{stats}{actions}</header>
      {children}
    </div>
  </main>, document.querySelector('.proto') ?? document.body);
}

export function ReadState({ err, retry }: { err: string; retry: () => void }) {
  return err ? <div className="rec-error kumo-ui" role="alert"><span className="em-state" data-tone="bad">{err}</span><Button size="sm" onClick={retry}>{tr('重试')}</Button></div>
    : <p className="small muted" role="status">{tr('加载中…')}</p>;
}

const dateFormat = new Intl.DateTimeFormat(document.documentElement.lang || undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const shortDate = new Intl.DateTimeFormat(document.documentElement.lang || undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
export function Stamp({ at, compact }: { at?: string | null; compact?: boolean }) {
  if (!at) return null;
  const time = Date.parse(at);
  return <time dateTime={at} title={at}>{Number.isFinite(time) ? (compact ? shortDate : dateFormat).format(time) : at}</time>;
}

function Stats({ items, prefix, empty }: { items: [string, number | string | undefined, Tone?][]; prefix?: string; empty?: string }) {
  const visible = items.filter(([, value]) => value);
  if (!visible.length) return empty ? <span className="rec-empty-stat">{empty}</span> : null;
  return <span className="rec-stats">{prefix && <span className="rec-prefix">{prefix}</span>}
    {visible.map(([label, value, tone]) => <span className="rec-stat" key={label}>{label} <em className="em-num" data-tone={tone ?? 'info'}>{value}</em></span>)}
  </span>;
}
export function DecisionNumbers({ stats, project }: { stats?: DecisionStats; project?: boolean }) {
  return <Stats prefix={project && !stats?.total ? tr('决定') : undefined} empty={project ? tr('暂无决定') : undefined} items={[
    [tr('决定'), stats?.total], [tr('有效'), project ? undefined : stats?.active], [tr('有据'), stats?.anchored, 'good'], [tr('无据'), stats?.loose, 'warn'],
  ]} />;
}
export function ProvNumbers({ stats, project }: { stats?: ProvStats; project?: boolean }) {
  const floats = stats?.floats, numbers = stats?.numbers, changed = stats?.changed, ops = stats?.ops;
  return <Stats prefix={project ? tr('溯源') : undefined} empty={project ? tr('暂无溯源记录') : undefined} items={[
    [tr('表和图'), floats?.total && `${floats.tagged ?? '—'}/${floats.total}`, floats?.tagged === floats?.total ? 'good' : 'warn'], [tr('数字'), numbers?.total && `${numbers.ok ?? '—'}/${numbers.total}`, numbers?.ok === numbers?.total ? 'good' : 'warn'],
    [tr('改过'), changed, 'warn'], [tr('操作'), ops],
  ]} />;
}

export function OpLine({ op, seq, selected }: { op: Op; seq: number; selected?: boolean }) {
  if (!op?.id) return null;
  return <RecordLink className="rec-op" aria-current={selected ? 'true' : undefined} to={provPath(seq, { op: op.id })}>
    <span className="rec-op-time"><Stamp compact at={op.ts} /></span>
    <span className="rec-op-who">{trx(op.who) || tr('归属待核实')}</span><code>{op.short || op.id.slice(0, 7)}</code>
    <span title={tr('{0} 个文件', op.files ?? '—')}>{op.files ?? '—'}</span>
    <span className="rec-lines"><i data-n={op.added || undefined}>+{op.added ?? '—'}</i> <i data-n={op.removed || undefined}>−{op.removed ?? '—'}</i></span>
  </RecordLink>;
}

export function Basis({ seq, ids }: { seq: number; ids?: string[] }) {
  return <span className="rec-basis">{ids?.length ? ids.map(id =>
    <RecordLink key={id} to={id.startsWith('#') ? loopPath(seq, id.slice(1)) : decidedPath(seq, id)}>{id}</RecordLink>)
    : <span className="em-state" data-tone="warn">{tr('暂无依据')}</span>}</span>;
}

export function ModSelect({ value, onChange, disabled, compact }: { value: FlowPart; onChange: (v: FlowPart) => void; disabled?: boolean; compact?: boolean }) {
  return <Select {...(compact ? { 'aria-label': tr('分项') } : { label: tr('分项') })} size="sm" value={value} disabled={disabled}
    items={Object.fromEntries(FLOW.map(p => [p.id, p.name]))} onValueChange={v => v && onChange(v as FlowPart)} />;
}

function materialPath(seq: number, m: Material) {
  if (m.kind === 'page') return `/progress/${seq}/pages/${encodeURIComponent(m.ref)}`;
  if (m.kind === 'report') return conversationPath(seq, { report: m.ref });
  if (m.kind === 'job') return jobPath(seq, m.ref);
  if (m.kind === 'prov') return provPath(seq, { node: m.ref });
  const file = /^(code|paper)[:/](.+)$/.exec(m.ref);
  if (file) return filePath(seq, file[1] as 'code' | 'paper', file[2]);
  if (m.kind === 'file') return filePath(seq, 'code', m.ref);
  return null;
}

export function Materials({ seq, items }: { seq: number; items?: Material[] }) {
  if (!items?.length) return null;
  return <section className="rec-section"><h4>{tr('材料')}</h4><ul className="rec-materials">{items.map((m, i) => {
    const arxiv = m.ref.startsWith('arxiv:') ? m.ref.slice(6) : m.kind === 'arxiv' ? m.ref : null;
    const external = /^https?:\/\//i.test(m.ref) ? m.ref : arxiv ? `https://arxiv.org/abs/${arxiv.split('/').map(encodeURIComponent).join('/')}` : null;
    const to = external ? null : materialPath(seq, m);
    const label = m.title || m.ref;
    return <li key={i}>{external ? <a href={external} target="_blank" rel="noreferrer">{label}</a> : to ? <RecordLink to={to}>{label}</RecordLink> : label}
      {m.title && m.ref !== m.title && <code>{m.ref}</code>}</li>;
  })}</ul></section>;
}

export function MatterFacts({ facts, options, choose }: { facts?: string[]; options?: string[]; choose?: (text: string) => void }) {
  return <>
    {!!facts?.length && <section className="rec-section"><h4>{tr('事实')}</h4><ul>{facts.map((s, i) => <li key={i}>{modelText(s)}</li>)}</ul></section>}
    {!!options?.length && <section className="rec-section"><h4>{tr('可能的做法')}</h4>
      {choose ? <div className="rec-options kumo-ui">{options.map((s, i) => <Button type="button" size="sm" key={i} onClick={() => choose(s)}>{modelText(s)}</Button>)}</div>
        : <ul>{options.map((s, i) => <li key={i}>{modelText(s)}</li>)}</ul>}
    </section>}
  </>;
}

