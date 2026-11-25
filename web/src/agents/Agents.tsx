import { modelText } from '../emphasis';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, listen, type Agent, type AgentRole, type Bucket, type Line, type Loose, type Overview, type ProjectCard, type Report, type Terminal } from '../api';
import { Conversation, Text } from '../components/AgentRoom';
import { AGENT_STATUS } from '../components/MillRoom';
import { Icon, type IconName } from '../console/icons';
import { AskCard } from '../console/LeadChat';
import { ago } from '../console/util';
import { tr } from '../i18n';
import { grouped, SORTS } from '../progress/Progress';
import { useSettings } from '../settings';
import { follow, go, href, query, usePath } from '../route';
import { HireDialog } from './Hire';
import { refreshOverview, useOverview } from './overview';
import { PromptDialog, promptDismissed } from './Prompt';
import { agentName, BUCKETS, bucketOf, kindName, WatchStatus } from './watch';
import { HostedContext, TerminalContext, TerminalRoom } from './Terminal';
import './agents.css';
import { UsageStrip } from '../usage/Usage';

type Group = Overview['groups'][number] & { other?: boolean };
type Row = Agent | Terminal;
export const agentsPath = (id?: string, filter = '') => `/agents${id ? `/${encodeURIComponent(id)}` : ''}${filter ? `?f=${filter}` : ''}`;
const priority = (a: Row) => BUCKETS.findIndex(([b]) => b === bucketOf(a));
const urgent = (a: Row, b: Row) => priority(a) - priority(b) || (Date.parse(b.watch?.since ?? '') || 0) - (Date.parse(a.watch?.since ?? '') || 0);
const ROLE_ICON: Record<AgentRole, IconName> = { coder: 'code', writer: 'doc', monitor: 'eye', lead: 'compass', assistant: 'spark' };
const SIDE = 'papertown.agents.context';
const stored = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
function activity(d?: { kind: string; text: string } | null) {
  if (!d?.text) return null;
  if (d.kind === 'user') return <span className="user-words em-bar">{d.text}</span>;
  return modelText(d.text.replace(/^#+\s+/, ''));
}

function useNarrow(query: string) {
  const [hit, setHit] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query), on = () => setHit(m.matches);
    m.addEventListener('change', on); on();
    return () => m.removeEventListener('change', on);
  }, [query]);
  return hit;
}

export function Agents({ id, active, lines, toast }: { id?: string; active: boolean; lines: Line[]; toast: (s: string, error?: boolean) => void }) {
  usePath();
  const { data, error } = useOverview();
  const settings = useSettings();
  const [cards, setCards] = useState<ProjectCard[]>([]);
  useEffect(() => {
    if (!data) return;
    let alive = true;
    api.cards().then(d => { if (alive) setCards(d.cards); }).catch(() => {});
    return () => { alive = false; };
  }, [data]);
  const order = useMemo(() => new Map(grouped([...cards].sort(SORTS[settings.pgSort]), settings.pgGroup)
    .flatMap(g => g.items).map((r, i) => [r.line.id, i])), [cards, settings.pgSort, settings.pgGroup]);
  const raw = query().get('f'), filter = BUCKETS.some(([b]) => b === raw) ? raw as Bucket : '';
  const [search, setSearch] = useState(''), [sort, setSort] = useState<'project' | 'urgent'>('project');
  const root = useRef<HTMLDivElement>(null);
  const [, setNow] = useState(0);
  useEffect(() => { const t = setInterval(() => setNow(n => n + 1), 30000); return () => clearInterval(t); }, []);
  const [herdrInstalled, setHerdrInstalled] = useState(false);
  useEffect(() => { let alive = true; api.herdr().then(h => { if (alive) setHerdrInstalled(h.installed && h.enabled); }).catch(() => {}); return () => { alive = false; }; }, []);
  const [hiring, setHiring] = useState(false);
  // the context column stays as it was left on a wide window, and is a drawer that starts closed on a narrow one
  const narrow = useNarrow('(max-width: 1180px)');
  const [pinned, setPinned] = useState(() => stored(SIDE) !== '0'), [drawer, setDrawer] = useState(false);
  useEffect(() => setDrawer(false), [id, narrow]);
  const side = narrow ? drawer : pinned;
  const toggleSide = () => {
    if (narrow) return setDrawer(v => !v);
    setPinned(v => { try { localStorage.setItem(SIDE, v ? '0' : '1'); } catch { /* the choice lasts for this visit */ } return !v; });
  };

  const selectedGroup = data?.groups.find(g => [...g.agents, ...(g.terminals ?? [])].some(a => a.id === id));
  const selected = selectedGroup?.agents.find(a => a.id === id);
  const selectedTerminal = [...(selectedGroup?.terminals ?? []), ...(data?.others ?? [])].find(t => t.id === id);
  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all: Group[] = [...(data?.groups ?? []), { line: null, agents: [], loose: [], terminals: data?.others ?? [], other: true }];
    return all.sort((a, b) => (order.get(a.line?.id ?? '') ?? Infinity) - (order.get(b.line?.id ?? '') ?? Infinity)).map(g => ({ ...g,
      agents: g.agents.filter(a => (!filter || bucketOf(a) === filter) && (!q || [agentName(a), a.name, a.model, a.cwd, a.watch?.doing?.text, g.line?.title, g.line?.seq].join(' ').toLowerCase().includes(q))),
      terminals: (g.terminals ?? []).filter(t => (!filter || t.watch.bucket === filter) && (!q || [t.name, t.kind, t.title, t.cwd, g.line?.title, g.line?.seq, tr('终端')].join(' ').toLowerCase().includes(q))),
      loose: filter ? [] : g.loose.filter(a => !q || [a.title, a.provider, a.model, a.cwd, g.line?.title].join(' ').toLowerCase().includes(q)),
    })).filter(g => g.agents.length || g.terminals.length || g.loose.length);
  }, [data, search, filter, order]);
  const rows = useMemo(() => {
    const all = groups.flatMap(g => [...g.agents, ...g.terminals].map(agent => ({ agent, group: g })));
    return sort === 'urgent' ? all.sort((a, b) => urgent(a.agent, b.agent)) : all;
  }, [groups, sort]);
  useEffect(() => {
    if (!active) return;
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing || target.closest('input, textarea, select, button, [contenteditable=true], [role=dialog], .dock, .st-page')) return;
      if (document.querySelector('.st-page, .interior, .dock.open, .kumo-layer [role=dialog]')) return;
      if (e.key === 'Enter' && (selected || selectedTerminal)) {
        e.preventDefault(); root.current?.querySelector<HTMLElement>('[data-agent-compose], .term-wait .btn')?.focus(); return;
      }
      const d = e.key === 'ArrowDown' || e.key === 'j' ? 1 : e.key === 'ArrowUp' || e.key === 'k' ? -1 : 0;
      if (!d || !rows.length) return;
      e.preventDefault();
      const at = rows.findIndex(x => x.agent.id === id);
      go(agentsPath(rows[at < 0 ? d > 0 ? 0 : rows.length - 1 : Math.max(0, Math.min(rows.length - 1, at + d))].agent.id, filter));
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [rows, id, selected, selectedTerminal, filter, active]);
  useEffect(() => { root.current?.querySelector('.aw-row.on')?.scrollIntoView({ block: 'nearest' }); }, [id]);

  // a Paseo permission request of the open employee comes up as a dialog, like a prompt on a terminal does
  const permission = selected?.watch?.permissions[0], permissionKey = selected && permission ? `${selected.id}:${permission.id}` : '';
  const [asking, setAsking] = useState(false);
  useEffect(() => setAsking(!!permissionKey && !promptDismissed(permissionKey)), [permissionKey]);
  const permit = async (allow: boolean) => { await api.permit(selected!.id, permission!.id, allow); await refreshOverview(); };

  const total = data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : 0;
  const groupHead = (g: Group) => g.line ? <a href={href(`/progress/${g.line.seq}`)} onClick={e => follow(e, `/progress/${g.line!.seq}`)}><span>#{g.line.seq}</span>{g.line.title}</a> : g.other ? tr('其他终端') : tr('小助手');
  const loose = (g: Group) => g.line && g.loose.length > 0 && <div className="aw-loose">
    <h4>{tr('未接入的会话')}</h4>
    {g.loose.map(a => <LooseRow key={a.id} session={a} line={g.line!} toast={toast} onJoined={a => go(agentsPath(a.id))} />)}
  </div>;
  // rows come in one after another the first time they appear
  let nth = 0;
  const row = (a: Row, g: Group) => 'terminal_id' in a
    ? <TerminalRow key={a.id} nth={nth++} terminal={a} selected={id === a.id} filter={filter} project={sort === 'urgent' ? g.line : undefined} />
    : <AgentRow key={a.id} nth={nth++} agent={a} selected={id === a.id} filter={filter} project={sort === 'urgent' ? g.line : undefined} toast={toast} />;
  const sideButton = <button className={`ib aw-side-btn${side ? ' on' : ''}`} aria-pressed={side} title={side ? tr('收起上下文') : tr('展开上下文')} onClick={toggleSide}><Icon n="sidebar" size={17} /></button>;
  const shown = selected || selectedTerminal;

  return <div className={`aw${id ? ' aw-selected' : ''}${shown && side ? ' aw-sided' : ''}`} ref={root} hidden={!active}>
    <aside className="aw-list" aria-label={tr('员工列表')}>
      <header className="aw-top">
        <div className="aw-title">
          <h1>{tr('员工')}</h1>{data && <span className="aw-total" key={total}>{total}</span>}
          <button className="btn pri aw-new" onClick={() => setHiring(true)}><Icon n="plus" size={15} />{tr('新建员工')}</button>
        </div>
        <div className="aw-find">
          <label className="aw-search"><Icon n="lens" size={15} />
            <input type="search" value={search} aria-label={tr('搜索员工')} placeholder={tr('搜索项目、任务、模型或目录')} onChange={e => setSearch(e.target.value)} />
          </label>
          <button className={`ib${sort === 'urgent' ? ' on' : ''}`} aria-pressed={sort === 'urgent'} title={sort === 'urgent' ? tr('已按紧急程度排序，点击后按项目分组') : tr('按紧急程度排序')}
            onClick={() => setSort(sort === 'urgent' ? 'project' : 'urgent')}><Icon n="bell" size={16} /></button>
        </div>
        <nav className="aw-filters" aria-label={tr('按状态筛选')}>
          <a className={`aw-pill${filter ? '' : ' on'}`} href={href(agentsPath(id))} onClick={e => follow(e, agentsPath(id))} aria-current={!filter ? 'true' : undefined}>{tr('全部')}<b>{data ? total : '—'}</b></a>
          {/* a status nobody is in stays out of the way unless it is the one being filtered by */}
          {BUCKETS.filter(([b]) => data?.counts[b] || filter === b).map(([b, name]) => <a key={b} className={`aw-pill aw-${b}${filter === b ? ' on' : ''}`} href={href(agentsPath(id, filter === b ? '' : b))}
            onClick={e => follow(e, agentsPath(id, filter === b ? '' : b))} aria-current={filter === b ? 'true' : undefined}><i className="aw-dot" aria-hidden="true" />{name}<b key={data?.counts[b]}>{data?.counts[b] ?? 0}</b></a>)}
        </nav>
      </header>
      <div className="aw-rows">
        {error && <div className="aw-notice" role="alert"><p>{error}</p><button className="btn" onClick={() => refreshOverview()}>{tr('重试')}</button></div>}
        {!data && !error && <p className="aw-empty">{tr('加载中…')}</p>}
        {data && !data.paseo.ok && <p className="aw-notice">{tr('无法连接 Paseo：{0}', data.paseo.note)}</p>}
        {data && !groups.length && <div className="aw-empty">
          <p>{search || filter ? tr('暂无符合条件的员工。') : tr('暂无已启动的员工。')}</p>
          {!search && !filter && <button className="btn" onClick={() => setHiring(true)}>{tr('新建员工')}</button>}
        </div>}
        {sort === 'project' ? groups.map(g => <section key={g.line?.id ?? (g.other ? 'terminals' : 'assistant')} className="aw-group">
          <h2>{groupHead(g)}</h2>{[...g.agents, ...g.terminals].map(a => row(a, g))}{loose(g)}
        </section>) : <>{rows.map(({ agent, group }) => row(agent, group))}{groups.filter(g => g.loose.length).map(g => <section key={g.line?.id} className="aw-group"><h2>{groupHead(g)}</h2>{loose(g)}</section>)}</>}
        {herdrInstalled && data && !data.herdr.ok && <p className="aw-herdr-note em-state" data-tone="warn">{tr(data.herdr.note)}</p>}
      </div>
      <UsageStrip active={active} />
    </aside>
    <main className="aw-main" aria-label={tr('员工对话')}>
      <a className="aw-back" href={href(agentsPath(undefined, filter))} onClick={e => follow(e, agentsPath(undefined, filter))}><Icon n="left" size={15} />{tr('返回员工列表')}</a>
      {selectedTerminal ? <div className="aw-pane" key={selectedTerminal.id}><TerminalRoom terminal={selectedTerminal} toast={toast} tools={sideButton} /></div> : selected ? <div className="aw-pane" key={selected.id}>
        {!!selected.watch?.asks.length && <div className="aw-asks">{selected.watch.asks.map(q => <AskCard key={q.id} q={q} seq={selectedGroup?.line?.seq} toast={toast} onDone={() => { void refreshOverview(); }} />)}</div>}
        <Conversation key={selected.id} agent={selected} toast={toast} tools={sideButton} />
      </div> : <div className="aw-blank">
        <div className="aw-blank-art" aria-hidden="true"><span><Icon n="code" size={20} /></span><span><Icon n="chat" size={22} /></span><span><Icon n="doc" size={20} /></span></div>
        <h2>{id && data ? tr('未找到该员工') : tr('选择员工，查看对话')}</h2>
        <p>{tr('左侧按项目列出员工与终端会话。选中后可查看对话、发送指令并处理其请求。')}</p>
        <div className="btns"><button className="btn pri" onClick={() => setHiring(true)}><Icon n="plus" size={15} />{tr('新建员工')}</button></div>
        <p className="aw-keys">{tr('↑/↓ 或 j/k 选择，Enter 输入消息')}</p>
      </div>}
    </main>
    {shown && <aside className="aw-context" aria-label={selected ? tr('员工上下文') : tr('终端上下文')} aria-hidden={!side} ref={el => { if (el) el.inert = !side; }}>
      <div className="aw-context-in" key={shown.id}>
        <header className="aw-context-top"><h2>{tr('上下文')}</h2><button className="ib" title={tr('收起上下文')} onClick={toggleSide}><Icon n="close" size={16} /></button></header>
        {selectedTerminal && <section className="aw-card"><h3>{tr('终端')}</h3><TerminalContext terminal={selectedTerminal} /></section>}
        {selected && selectedGroup && <Context agent={selected} group={selectedGroup} line={lines.find(l => l.id === selected.line_id)} toast={toast} />}
      </div>
    </aside>}
    {narrow && side && shown && <button className="aw-scrim" aria-label={tr('收起上下文')} onClick={toggleSide} />}
    {hiring && <HireDialog lineId={selectedGroup?.line?.id} onClose={() => setHiring(false)}
      onStarted={a => { void refreshOverview().then(() => go(agentsPath(a.id))); }} onOpen={a => go(agentsPath(a.id))} />}
    {asking && selected && permission && <PromptDialog id={permissionKey} who={`${agentName(selected)}${selectedGroup?.line ? ` · #${selectedGroup.line.seq}` : ''}`}
      title={permission.name === 'Bash' ? tr('请求运行命令') : tr('请求使用 {0}', permission.name)}
      body={permission.title && permission.title !== permission.name ? [permission.title] : []} code={permission.arg || undefined}
      choices={[{ label: tr('允许'), tone: 'primary', pick: () => permit(true) }, { label: tr('拒绝'), tone: 'danger', pick: () => permit(false) }]}
      onClose={() => setAsking(false)} />}
  </div>;
}

function Avatar({ icon, bucket }: { icon: IconName; bucket: Bucket }) {
  return <span className={`aw-avatar aw-${bucket}`} aria-hidden="true"><Icon n={icon} size={16} /><i className="aw-dot" /></span>;
}

function AgentRow({ agent: a, selected, filter, project, toast, nth }: { agent: Agent; selected: boolean; filter: string; project?: Group['line']; toast: (s: string, error?: boolean) => void; nth: number }) {
  const [busy, setBusy] = useState(false);
  async function permit(id: string, allow: boolean) {
    setBusy(true);
    try { await api.permit(a.id, id, allow); await refreshOverview(); } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  }
  const to = agentsPath(a.id, filter), bucket = bucketOf(a);
  return <article className={`aw-row${selected ? ' on' : ''}`} style={{ ['--i' as string]: Math.min(nth, 14) }}>
    <a href={href(to)} onClick={e => follow(e, to)} aria-current={selected ? 'page' : undefined}>
      <Avatar icon={a.node_id ? 'target' : ROLE_ICON[a.role]} bucket={bucket} />
      <div className="aw-row-body">
        <div className="aw-row-top"><b>{agentName(a)}</b><time>{ago(a.watch?.since)}</time></div>
        <div className="aw-row-meta"><WatchStatus agent={a} /><span className="aw-model">{a.term?.model || a.model || tr('模型未指定')}</span>{a.term && <span className="aw-tag">{a.runtime}</span>}{!!a.watch?.queued && <span className="aw-tag">{tr('排队 {0}', a.watch.queued)}</span>}</div>
        {project && <small>#{project.seq} {project.title}</small>}
        {/* a waiting question is the row's line: the activity line would repeat it */}
        {a.watch?.asks.length ? a.watch.asks.map(q => <p className="aw-question em-bar" data-tone="warn" key={q.id}>{modelText(q.data.question)}</p>)
          : <p className={`aw-doing${a.watch?.why === 'terminal' ? ' aw-question em-bar' : ''}`} data-tone="warn">{activity(a.watch?.doing) || a.down || tr('暂无动态')}</p>}
      </div>
    </a>
    {a.watch?.permissions.map(q => <div className="aw-permit em-bar" data-tone="warn" key={q.id}>
      {a.watch!.permissions.length > 1 && <p>{[q.title || q.name, q.arg].filter(Boolean).join(' ')}</p>}
      <div className="btns"><button className="btn pri" disabled={busy} onClick={() => permit(q.id, true)}>{tr('允许')}</button><button className="btn" disabled={busy} onClick={() => permit(q.id, false)}>{tr('拒绝')}</button></div>
    </div>)}
  </article>;
}

function TerminalRow({ terminal: t, selected, filter, project, nth }: { terminal: Terminal; selected: boolean; filter: string; project?: Group['line']; nth: number }) {
  const to = agentsPath(t.id, filter);
  return <article className={`aw-row${selected ? ' on' : ''}`} style={{ ['--i' as string]: Math.min(nth, 14) }}>
    <a href={href(to)} onClick={e => follow(e, to)} aria-current={selected ? 'page' : undefined}>
      <Avatar icon="term" bucket={t.watch.bucket} />
      <div className="aw-row-body">
        <div className="aw-row-top"><b>{t.name || kindName(t.kind) || tr('终端')}</b><time>{ago(t.watch.since)}</time></div>
        <div className="aw-row-meta"><WatchStatus agent={t} /><span className="aw-model">{kindName(t.kind) || tr('未指定')}</span><span className="aw-tag">herdr</span>{!!t.watch.queued && <span className="aw-tag">{tr('排队 {0}', t.watch.queued)}</span>}</div>
        {project && <small>#{project.seq} {project.title}</small>}
        <p className={`aw-doing${t.watch.bucket === 'needs' ? ' aw-question em-bar' : ''}`} data-tone="warn">{activity(t.watch.doing) || t.title || tr('暂无动态')}</p>
      </div>
    </a>
  </article>;
}

function LooseRow({ session: s, line, toast, onJoined }: { session: Loose; line: NonNullable<Group['line']>; toast: (s: string, error?: boolean) => void; onJoined: (a: Agent) => void }) {
  const [role, setRole] = useState<AgentRole>('coder'), [busy, setBusy] = useState(false);
  async function join() {
    setBusy(true);
    try { const a = await api.importAgent(line.id, role, s.id); await refreshOverview(); onJoined(a); }
    catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  }
  return <div className="aw-loose-row">
    <b>{s.title || tr('（无标题）')}</b><span>{s.provider} · {s.model} · {AGENT_STATUS[s.status] ?? s.status}</span>
    <small className="path">{s.cwd}</small>
    <div className="btns"><select aria-label={tr('接入岗位')} value={role} onChange={e => setRole(e.target.value as AgentRole)} disabled={busy}>
      <option value="coder">{tr('代码员工')}</option><option value="writer">{tr('写作员工')}</option>
    </select><button className="btn" disabled={busy} onClick={join}>{tr('接入')}</button></div>
  </div>;
}

function Context({ agent, group, line, toast }: { agent: Agent; group: Group; line?: Line; toast: (s: string, error?: boolean) => void }) {
  const [reports, setReports] = useState<Report[]>([]), [error, setError] = useState('');
  useEffect(() => {
    let alive = true, timer = 0;
    const load = () => api.reports(agent.line_id ?? undefined).then(d => {
      if (!alive) return;
      const found = new Map([...d.reports, ...d.asks].filter(r => r.agent_id === agent.id).map(r => [r.id, r]));
      setReports([...found.values()].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 8)); setError('');
    }, e => { if (alive) setError((e as Error).message); });
    void load();
    const off = listen(e => { if (e.type === 'report') { clearTimeout(timer); timer = window.setTimeout(load, 300); } });
    const poll = setInterval(load, 20000);
    return () => { alive = false; off(); clearTimeout(timer); clearInterval(poll); };
  }, [agent.id, agent.line_id]);
  const project = group.line, projectPath = project ? `/progress/${project.seq}` : '';
  const nodePath = project && agent.task ? `${projectPath}/loop?node=${encodeURIComponent(agent.task.id)}` : '';
  const stage = line?.stages.find(s => s.key === project?.stage)?.name ?? project?.stage;
  return <>
    <section className="aw-card">
      <h3>{tr('项目')}</h3>
      <dl className="aw-facts">
        <dt>{tr('所属项目')}</dt><dd>{project ? <a href={href(projectPath)} onClick={e => follow(e, projectPath)}>#{project.seq} {project.title}</a> : tr('小助手')}</dd>
        {stage && <><dt>{tr('工序')}</dt><dd><a href={href(projectPath)} onClick={e => follow(e, projectPath)}>{stage}</a></dd></>}
        {agent.task && <><dt>{tr('节点任务')}</dt><dd><a href={href(nodePath)} onClick={e => follow(e, nodePath)}>{agent.task.title}</a></dd></>}
        <dt>{tr('工作目录')}</dt><dd className="aw-path">{agent.cwd || tr('未指定')}</dd>
      </dl>
    </section>
    <section className="aw-card">
      <h3>{tr('运行')}</h3>
      {agent.term ? <HostedContext agent={agent} toast={toast} /> : <>
        <dl className="aw-facts">
          <dt>{tr('运行方式')}</dt><dd>{agent.runtime === 'paseo' ? 'Paseo' : agent.runtime}</dd>
          <dt>{tr('模型')}</dt><dd>{agent.model || tr('模型未指定')}</dd>
        </dl>
        {agent.runtime === 'paseo' && <button className="btn" onClick={() => api.openInPaseo(agent.id).catch(e => toast((e as Error).message, true))}><Icon n="ext" size={14} />{tr('在 Paseo 中打开')}</button>}
      </>}
    </section>
    <section className="aw-card">
      <h3>{tr('最近的汇报与提问')}</h3>
      {error && <p role="alert" className="ac-error em-state" data-tone="bad">{error}</p>}
      {!reports.length && !error && <p className="muted small">{tr('暂无汇报或提问。')}</p>}
      {reports.map(r => <details key={r.id} className="aw-report">
        <summary><span className={r.data.key || r.kind === 'ask' && r.data.open ? 'em-bar' : undefined} data-tone={r.kind === 'ask' ? 'warn' : 'info'}>{modelText(r.data.question || r.data.text)}</span><small>{r.kind === 'ask' ? tr('提问') : tr('汇报')} · {ago(r.ts)}</small></summary>
        <Text text={r.data.question || r.data.text || ''} />{r.data.answer && <p className={r.data.by && r.data.by !== 'you' ? undefined : 'user-words em-bar'}>{tr('你的回答')} · {r.data.by && r.data.by !== 'you' ? modelText(r.data.answer) : r.data.answer}</p>}
      </details>)}
    </section>
  </>;
}
