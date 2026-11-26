// Trace a passage to its sources, or inspect the file changes recorded in an operation.
import { modelText } from '../emphasis';
import { Button } from '@cloudflare/kumo';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, type Op, type ProjectCard, type ProvDetail, type ProvNode, type ProvRef, type ProvView } from '../api';
import { DiffLines } from '../console/DiffLines';
import { Icon, type IconName } from '../console/icons';
import { usePanelNote } from '../console/page';
import { useFetch, useMedia, PHONE } from '../console/util';
import { tr, trx } from '../i18n';
import { conversationPath, filePath, jobPath, provPath, query } from '../route';
import { Basis, DetailHeading, OpLine, ProvNumbers, ReadState, RecordLink, RecordPage, Stamp, useRecordTick } from './Records';
import './prov.css';

const KIND = { passage: tr('文字'), artifact: tr('中间产物'), result: tr('结果文件'), source: tr('外部来源') };
const KIND_ICON: Record<ProvNode['kind'], IconName> = { passage: 'doc', artifact: 'table', result: 'flask', source: 'books' };
const ISSUE = { moved: tr('行号变了'), changed: tr('改过'), missing: tr('缺失') };
const TRIGGER: Record<string, string> = { turn: tr('回合结束'), before: tr('送达消息前'), submit: tr('提交实验'), job: tr('任务结束'),
  add: tr('登记溯源'), tick: tr('巡检'), manual: tr('手动记录'), base: tr('开始记录前已有') };
const ROLE: Record<string, string> = { lead: tr('项目负责人'), coder: tr('代码员工'), writer: tr('写作员工'), assistant: tr('小助手') };
type Nodes = Record<string, ProvNode>;

function Checks({ n, compact }: { n: Partial<ProvNode>; compact?: boolean }) {
  const nums = n.numbers ?? [], matched = nums.filter(x => x.ok).length;
  const issues = [
    n.state && n.state !== 'ok' && { text: ISSUE[n.state], missing: n.state === 'missing' },
    matched < nums.length && { text: tr('数字 {0}/{1}', matched, nums.length), missing: false },
    !!n.gaps?.length && { text: tr('来历不全'), missing: false },
  ].filter(x => !!x);
  if (!issues.length) return null;
  return <span className="pr-checks" title={issues.map(i => i.text).join(' · ')}>
    {(compact ? issues.slice(0, 1) : issues).map(i => <span key={i.text} className="em-tag" data-tone={i.missing ? 'bad' : 'warn'}>{i.text}</span>)}
  </span>;
}

function NodeRow({ n, seq, current }: { n: Pick<ProvNode, 'id'> & Partial<ProvNode>; seq: number; current?: boolean }) {
  const title = n.title || n.path || n.id, who = n.made && (trx(n.made.who) || n.made.agent || tr('归属待核实'));
  const slash = title === n.path ? title.lastIndexOf('/') : -1;
  return <RecordLink className="pr-node" aria-current={current ? 'true' : undefined} to={provPath(seq, { node: n.id })}>
    <span className="pr-kind" role="img" aria-label={n.kind && KIND[n.kind]} title={n.kind && KIND[n.kind]}><Icon n={n.kind ? KIND_ICON[n.kind] : 'file'} size={14} /></span>
    <code>{n.tag || n.id}</code><span className="pr-node-title" title={title}>{slash < 0 ? title : <>
      <span className="pr-dir">{title.slice(0, slash)}</span><span className="pr-name">{title.slice(slash)}</span></>}</span><Checks n={n} compact />
    <span className="pr-node-meta">{who && <span title={who}>{who}</span>}<Stamp compact at={n.made?.at || n.created_at} /></span>
  </RecordLink>;
}

function TreeNode({ id, nodes, seq, selected, ancestors = [] }: { id: string; nodes: Nodes; seq: number; selected: string | null; ancestors?: string[] }) {
  const [open, setOpen] = useState(ancestors.length < 2);
  const n = nodes[id], src = n?.src ?? [];
  const children = src.filter(key => key !== id && !ancestors.includes(key));
  return <li>
    <div className="pr-tree-row">
      {children.length > 0 && <button className="pr-toggle" aria-label={open ? tr('收起来源') : tr('展开来源')} aria-expanded={open} onClick={() => setOpen(v => !v)}>
        <Icon n={open ? 'down' : 'right'} size={13} /></button>}
      <NodeRow n={n ?? { id }} seq={seq} current={id === selected} />
    </div>
    {open && !!children.length && <ul>{children.map(key => <TreeNode key={key} id={key} nodes={nodes} seq={seq} selected={selected} ancestors={[...ancestors, id]} />)}</ul>}
  </li>;
}

function ArticleTree({ v, seq, selected, file }: { v: ProvView; seq: number; selected: string | null; file: string | null }) {
  const current = useRef<HTMLElement>(null), phone = useMedia(PHONE);
  useEffect(() => { if (file && !phone) current.current?.scrollIntoView({ block: 'nearest' }); }, [file, phone]);
  const nodes = v.nodes ?? {};
  const list = (ids?: string[]) => !!ids?.length && <ul className="pr-tree">{ids.map(id => <TreeNode key={id} id={id} nodes={nodes} selected={selected} seq={seq} />)}</ul>;
  const section = (s: ProvView['files'][number]['sections'][number]) => <section key={`${s.line}:${s.title}`} className="pr-section">
      <h4>{s.title || tr('正文')} {s.line > 0 && <small>L{s.line}</small>}</h4>{list(s.nodes)}
      {!!s.rest?.length && <p className="pr-rest">{tr('其余文字')}<span>{s.rest.map(x => tr('{0} {1} 行', trx(x.who), x.lines)).join(' · ')}</span></p>}
    </section>;
  return <div className="pr-files">{v.files.map(f => {
    const rest = f.sections.filter(s => !s.nodes.length);
    return <section key={f.path} className="pr-file" data-selected={f.path === file || undefined} ref={f.path === file ? current : undefined}>
      <h3><RecordLink to={provPath(seq, { file: f.path })}><Icon n="file" size={15} /><span>{f.path}</span>{f.title && f.title !== f.path && <small>{f.title}</small>}</RecordLink></h3>
      {f.sections.filter(s => s.nodes.length).map(section)}
      {!!rest.length && <details className="pr-other"><summary>{tr('其余 {0} 个小节', rest.length)}</summary>{rest.map(section)}</details>}
    </section>;
  })}
    {!!v.loose?.length && <section className="pr-file"><h3>{tr('还没用到的结果')}</h3>{list(v.loose)}</section>}
    {!v.files?.length && !v.loose?.length && <p className="rec-empty">{tr('暂无溯源记录')}</p>}
  </div>;
}

const PAGE_SIZE = 40;
function Operations({ line, seq, selected, tick }: { line: string; seq: number; selected: string | null; tick: number }) {
  const first = useFetch(() => api.provOps(line, { limit: PAGE_SIZE }), line, tick);
  const [extra, setExtra] = useState<Op[]>([]), [end, setEnd] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const ops = [...new Map([...(first.data ?? []), ...extra].map(o => [o.id, o])).values()];
  async function more() {
    const before = ops.at(-1)?.id;
    if (!before || busy) return;
    setBusy(true); setError('');
    try {
      const next = await api.provOps(line, { before, limit: PAGE_SIZE });
      setExtra(old => [...old, ...next]);
      setEnd(next.length < PAGE_SIZE || next.every(o => ops.some(p => p.id === o.id)));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <><div className="rec-op-list">{!!ops.length && <div className="rec-op-head"><span>{tr('时间')}</span><span>{tr('员工')}</span>
    <span>{tr('操作')}</span><span>{tr('文件数')}</span><span>{tr('增删行数')}</span></div>}
    {ops.map(op => <OpLine key={op.id} op={op} seq={seq} selected={selected === op.id} />)}</div>
    {(!first.data || first.err) && <ReadState err={first.err} retry={first.reload} />}
    {first.data && !ops.length && <p className="rec-empty">{tr('暂无操作记录')}</p>}
    {!end && (first.data?.length ?? 0) >= PAGE_SIZE && <div className="kumo-ui"><Button size="sm" disabled={busy} onClick={more}>{tr('查看更多')}</Button></div>}
    {error && <p className="dc-err em-state" data-tone="bad" role="alert">{error}</p>}
  </>;
}

function Info({ label, children }: { label: string; children?: ReactNode }) {
  return children != null && children !== '' && <div><dt>{label}</dt><dd>{children}</dd></div>;
}
function RefList({ title, refs, nodes, seq }: { title: string; refs: string[] | ProvRef[]; nodes: Nodes; seq: number }) {
  if (!refs?.length) return null;
  return <section className="rec-section pr-refs"><h4>{title}</h4>{refs.map(ref => {
    const id = typeof ref === 'string' ? ref : ref.id;
    return <NodeRow key={id} seq={seq} n={nodes[id] ?? (typeof ref === 'string' ? { id } : ref)} />;
  })}</section>;
}

function Content({ n }: { n: ProvDetail }) {
  const [view, setView] = useState<'diff' | 'then' | 'now'>(n.state === 'missing' && !n.diff ? 'then' : 'diff');
  const compare = n.state === 'changed' || n.state === 'missing';
  const original = n.then ?? n.span?.text;
  const value = compare ? view === 'then' ? original : n.now : n.now ?? original;
  const views = [['diff', tr('差异')], ['then', tr('登记时')], ['now', tr('当前')]] as const;
  return <section className="rec-section pr-content"><header><h4>{tr('内容')}</h4>
    {n.state === 'ok' && <span className="small muted">{tr('内容一致')}</span>}
    {compare && <div className="pr-versions" role="group" aria-label={tr('内容版本')}>{views.map(([key, label]) =>
      <button key={key} aria-pressed={key === view} onClick={() => setView(key)}>{label}</button>)}</div>}</header>
    {compare && view === 'diff' ? <Diff value={n.diff} /> : value == null ? <p className="small muted">{tr('暂无可显示的内容')}</p>
      : value === '' ? <p className="small muted">{tr('空文件')}</p> : <pre>{value}</pre>}
  </section>;
}
function Diff({ value }: { value?: string }) {
  return value ? <div className="pr-diff"><DiffLines text={value} /></div> : <p className="small muted">{tr('暂无差异')}</p>;
}

function NodeDetail({ n, seq, nodes }: { n: ProvDetail; seq: number; nodes: Nodes }) {
  const m = n.made, job = m?.job;
  const location = n.path && `${n.path}${n.span ? `:${n.span.start}–${n.span.end}` : ''}`;
  return <>
    <DetailHeading to={provPath(seq)}><h2><code>{n.tag}</code> {n.title || n.path || n.id}</h2><Checks n={n} /></DetailHeading>
    <dl className="pr-info">
      <Info label={tr('种类')}>{KIND[n.kind]}</Info>
      <Info label={tr('位置')}>{n.path && n.root ? <RecordLink to={filePath(seq, n.root, n.path, n.span?.start)}>{location}</RecordLink> : location}</Info>
      {!!n.gaps?.length && <Info label={tr('来历不全')}>{n.gaps.map(gap => trx(gap)).join(' · ')}</Info>}
    </dl>
    {!!n.numbers?.length && <details className="pr-numbers"><summary>{tr('查看数字')}</summary><ul>{n.numbers.map((x, i) =>
      <li key={i}><code className="em-num" data-tone={x.ok ? 'good' : 'bad'}>{x.text}</code> <span>{x.ok ? tr('对得上') : tr('未匹配')}</span> <code>{x.where}</code></li>)}</ul></details>}
    <Content n={n} />
    <section className="rec-section"><h4>{tr('这次操作')}</h4><dl className="pr-info">
      <Info label={tr('操作')}>{n.op && <RecordLink to={provPath(seq, { op: n.op })}><code title={n.op}>{n.op.slice(0, 8)}</code></RecordLink>}</Info>
      <Info label={tr('员工')}>{trx(m?.who) || m?.agent}</Info><Info label={tr('岗位')}>{m?.role && (ROLE[m.role] ?? trx(m.role))}</Info>
      <Info label={tr('模型')}>{m?.model}</Info>
      <Info label={tr('对话')}>{(m?.session || m?.agent) && <RecordLink to={conversationPath(seq, { session: m.session, agent: m.agent, at: m.at || n.created_at })}>{m.session || tr('查看对话')}</RecordLink>}</Info>
      <Info label={tr('时间')}><Stamp at={m?.at || n.created_at} /></Info>
    </dl></section>
    <section className="rec-section"><h4>{tr('怎么来的')}</h4><dl className="pr-info">
      <Info label={tr('做法')}>{m?.how && <code>{m.how}</code>}</Info>
      <Info label={tr('任务')}>{job && <RecordLink to={jobPath(seq, job.id)}>{job.name || job.id}</RecordLink>}</Info>
      <Info label={tr('命令')}>{job?.command && <code>{job.command}</code>}</Info>
      <Info label={tr('节点')}>{job?.node}</Info>
      <Info label={tr('工作目录')}>{job?.cwd && <code>{job.cwd}</code>}</Info>
      <Info label={tr('运行时间')}>{job?.started_at && <><Stamp at={job.started_at} /> – <Stamp at={job.ended_at} /></>}</Info>
      <Info label={tr('代码版本')}>{job?.op && <RecordLink to={provPath(seq, { op: job.op })}><code title={job.op}>{job.op.slice(0, 8)}</code></RecordLink>}</Info>
      <Info label={tr('依据')}><Basis seq={seq} ids={m?.basis} /></Info>
    </dl></section>
    {n.note && <p className="rec-original">{modelText(n.note)}</p>}
    <RefList title={tr('来源')} refs={n.src} nodes={nodes} seq={seq} />
    <RefList title={tr('用到它的记录')} refs={n.used} nodes={nodes} seq={seq} />
    <RefList title={tr('历史记录')} refs={n.history} nodes={nodes} seq={seq} />
  </>;
}

function OperationDetail({ line, seq, id, tick }: { line: string; seq: number; id: string; tick: number }) {
  const { data: o, err, reload } = useFetch(() => api.provOp(line, id), `${line}/${id}`, tick);
  if (err || !o) return <ReadState err={err} retry={reload} />;
  return <><DetailHeading to={provPath(seq, { view: 'ops' })}><h2><code>{o.short || (o.id || id).slice(0, 7)}</code> {trx(o.summary) || tr('操作详情')}</h2></DetailHeading>
    <dl className="pr-info"><Info label={tr('员工')}>{trx(o.who) || o.agent}</Info><Info label={tr('岗位')}>{o.role && (ROLE[o.role] ?? trx(o.role))}</Info>
      <Info label={tr('记录时机')}>{o.trigger && (TRIGGER[o.trigger] || o.trigger)}</Info>
      <Info label={tr('时间')}><Stamp at={o.ts} /></Info><Info label={tr('仓库')}>{o.root}</Info>
      <Info label={tr('对话')}>{(o.session || o.agent) && <RecordLink to={conversationPath(seq, { agent: o.agent, session: o.session, at: o.ts })}>{o.session || tr('查看对话')}</RecordLink>}</Info>
      <Info label={tr('依据')}><Basis seq={seq} ids={o.basis} /></Info>
    </dl>
    <section className="rec-section"><h4>{tr('改动的文件')} · {o.files?.length ?? 0}</h4>
      {(o.files ?? []).map(f => <details className="pr-patch" key={f.path} open><summary><code>{f.path}</code> <span className="rec-lines"><i data-n={f.added || undefined}>+{f.added}</i> <i data-n={f.removed || undefined}>−{f.removed}</i></span></summary><Diff value={f.diff} /></details>)}
    </section></>;
}

function FileDetail({ line, seq, file, tick }: { line: string; seq: number; file: string; tick: number }) {
  const blame = useFetch(() => api.provBlame(line, 'paper', file), `${line}/${file}`, tick);
  return <><DetailHeading to={provPath(seq)}><h2>{file}</h2></DetailHeading>
    <RecordLink className="btn" to={filePath(seq, 'paper', file)}>{tr('打开论文')}</RecordLink>
    <h4>{tr('逐行来历')}</h4>{blame.data?.map(b => <div className="pr-blame" key={b.start}>
      <code>L{b.start}–{b.end}</code> {trx(b.who)} <Stamp at={b.at} />
      {b.op && <RecordLink to={provPath(seq, { op: b.op })}>{b.op.slice(0, 7)}</RecordLink>}
      {b.commit && <span title={b.commit}>{tr('项目提交')} <code>{b.commit.slice(0, 7)}</code> {b.author} <Stamp at={b.date} /></span>}
      {b.node && <RecordLink to={provPath(seq, { node: b.node })}>{tr('查看记录')}</RecordLink>}
    </div>)}
    {(!blame.data || blame.err) && <ReadState err={blame.err} retry={blame.reload} />}
    {blame.data?.length === 0 && <p className="small muted">{tr('暂无操作记录')}</p>}</>;
}

export default function ProvPage({ r }: { r: ProjectCard }) {
  const { id, seq } = r.line, q = query();
  const [tick, reload] = useRecordTick(id, 'prov'), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const tree = useFetch(() => api.prov(id), id, tick);
  const selected = q.get('node'), op = q.get('op'), file = q.get('file');
  const ops = !!op || q.get('view') === 'ops';
  const nodes = tree.data?.nodes ?? {};
  const nid = selected && (nodes[selected]?.id ?? Object.values(nodes).find(n => n.tag === selected)?.id ?? selected);
  const node = useFetch(() => api.provNode(id, nid!), nid ? `${id}/${nid}` : '', tick);
  const detail = op || nid || file;
  usePanelNote('prov', 'record', { [tr('溯源标签')]: node.data?.tag || selected, [tr('操作')]: op, [tr('文件')]: file });
  async function snap() {
    if (busy) return;
    setBusy(true); setNotice('');
    try { await api.provSnap(id); reload(); setNotice(tr('已完成记录检查')); }
    catch (e) { setNotice((e as Error).message); } finally { setBusy(false); }
  }
  return <RecordPage r={r} title={tr('溯源')} stats={<ProvNumbers stats={tree.data?.stats ?? r.prov} />}
    listPath={detail ? provPath(seq, ops ? { view: 'ops' } : {}) : undefined}
    actions={<button className="btn pri" disabled={busy} onClick={snap}><Icon n="plus" size={15} />{tr('现在记一次')}</button>}>
    {notice && <p className="small" role="status">{notice}</p>}
    <nav className="rec-tabs" aria-label={tr('溯源视图')}>
      <RecordLink aria-current={!ops ? 'page' : undefined} to={provPath(seq)}>{tr('从文章往下')}</RecordLink>
      <RecordLink aria-current={ops ? 'page' : undefined} to={provPath(seq, { view: 'ops' })}>{tr('操作记录')}</RecordLink>
    </nav>
    <div className="rec-layout"><section className="rec-index pr-index">
      {ops ? <Operations line={id} seq={seq} selected={op} tick={tick} /> : tree.data ? <ArticleTree v={tree.data} seq={seq} selected={nid} file={file} /> : null}
      {!ops && (!tree.data || tree.err) && <ReadState err={tree.err} retry={tree.reload} />}
    </section>
    {detail && <section className="rec-detail pr-detail" key={detail} aria-label={tr('溯源详情')}>
      {op ? <OperationDetail line={id} seq={seq} id={op} tick={tick} /> : nid ? node.err || !node.data ? <ReadState err={node.err} retry={node.reload} />
        : <NodeDetail n={node.data} nodes={nodes} seq={seq} /> : file && <FileDetail line={id} seq={seq} file={file} tick={tick} />}
    </section>}</div>
  </RecordPage>;
}

