import { useEffect, useMemo, useRef, useState } from 'react';
import { api, listen, type Agent, type AgentRole, type Bucket, type Line, type Loose, type Overview, type ProjectCard, type Report, type Terminal } from '../api';
import { Conversation, Text } from '../components/AgentRoom';
import { AGENT_STATUS } from '../components/MillRoom';
import { AskCard } from '../console/LeadChat';
import { ago } from '../console/util';
import { tr } from '../i18n';
import { grouped, SORTS } from '../progress/Progress';
import { useSettings } from '../settings';
import { follow, go, href, query, usePath } from '../route';
import { refreshOverview, useOverview } from './overview';
import { agentName, BUCKETS, bucketOf, kindName, WatchStatus } from './watch';
import { TerminalContext, TerminalRoom } from './Terminal';
import './agents.css';
import { UsageStrip } from '../usage/Usage';

type Group = Overview['groups'][number] & { other?: boolean };
type Row = Agent | Terminal;
export const agentsPath = (id?: string, filter = '') => `/agents${id ? `/${encodeURIComponent(id)}` : ''}${filter ? `?f=${filter}` : ''}`;
const priority = (a: Row) => BUCKETS.findIndex(([b]) => b === bucketOf(a));
const urgent = (a: Row, b: Row) => priority(a) - priority(b) || (Date.parse(b.watch?.since ?? '') || 0) - (Date.parse(a.watch?.since ?? '') || 0);

export function Agents({ id, active, lines, toast }: { id?: string; active: boolean; lines: Line[]; toast: (s: string) => void }) {
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
      if (document.querySelector('.st-page, .interior, .dock.open')) return;
      if (e.key === 'Enter' && (selected || selectedTerminal)) {
        e.preventDefault(); root.current?.querySelector<HTMLElement>('[data-agent-compose], .terminal-keys button')?.focus(); return;
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
  const groupHead = (g: Group) => g.line ? <a href={href(`/progress/${g.line.seq}`)} onClick={e => follow(e, `/progress/${g.line!.seq}`)}>#{g.line.seq} {g.line.title}</a> : g.other ? tr('其他终端') : tr('小助手');
  const loose = (g: Group) => g.line && g.loose.length > 0 && <div className="aw-loose">
    <h4>{tr('未接入的会话')}</h4>
    {g.loose.map(a => <LooseRow key={a.id} session={a} line={g.line!} toast={toast} onJoined={a => go(agentsPath(a.id))} />)}
  </div>;
  const row = (a: Row, g: Group) => 'terminal_id' in a
    ? <TerminalRow key={a.id} terminal={a} selected={id === a.id} filter={filter} project={sort === 'urgent' ? g.line : undefined} />
    : <AgentRow key={a.id} agent={a} selected={id === a.id} filter={filter} project={sort === 'urgent' ? g.line : undefined} toast={toast} />;
  return <div className={`aw${id ? ' aw-selected' : ''}`} ref={root} hidden={!active}>
    <aside className="aw-list" aria-label={tr('员工列表')}>
      <UsageStrip active={active} />
      <header className="aw-top">
        <h1>{tr('员工')}</h1>
        <div className="aw-filters" aria-label={tr('按状态筛选')}>
          <a className={`chip${filter ? '' : ' on'}`} href={href(agentsPath(id))} onClick={e => follow(e, agentsPath(id))} aria-current={!filter ? 'true' : undefined}>{tr('全部')} {data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : '—'}</a>
          {BUCKETS.map(([b, name]) => <a key={b} className={`chip aw-${b}${filter === b ? ' on' : ''}`} href={href(agentsPath(id, b))}
            onClick={e => follow(e, agentsPath(id, b))} aria-current={filter === b ? 'true' : undefined}>{name} {data?.counts[b] ?? 0}</a>)}
        </div>
        <input type="search" value={search} aria-label={tr('搜索员工')} placeholder={tr('搜索项目、任务、模型或目录')} onChange={e => setSearch(e.target.value)} />
        <label className="aw-sort">{tr('排序')}<select value={sort} onChange={e => setSort(e.target.value as typeof sort)}>
          <option value="project">{tr('按项目')}</option><option value="urgent">{tr('按紧急程度')}</option>
        </select></label>
      </header>
      <div className="aw-rows">
        {error && <div className="aw-notice" role="alert"><p>{error}</p><button className="btn" onClick={() => refreshOverview()}>{tr('重试')}</button></div>}
        {!data && !error && <p className="aw-empty">{tr('加载中…')}</p>}
        {data && !data.paseo.ok && <p className="aw-notice">{tr('连不上 Paseo：{0}', data.paseo.note)}</p>}
        {data && !groups.length && <p className="aw-empty">{search || filter ? tr('没有符合条件的员工。') : tr('尚无已启动的员工。请在项目中启动员工或接入已有会话。')}</p>}
        {sort === 'project' ? groups.map(g => <section key={g.line?.id ?? (g.other ? 'terminals' : 'assistant')} className="aw-group">
          <h2>{groupHead(g)}</h2>{[...g.agents, ...g.terminals].map(a => row(a, g))}{loose(g)}
        </section>) : <>{rows.map(({ agent, group }) => row(agent, group))}{groups.filter(g => g.loose.length).map(g => <section key={g.line?.id} className="aw-group"><h2>{groupHead(g)}</h2>{loose(g)}</section>)}</>}
        {herdrInstalled && data && !data.herdr.ok && <p className="aw-herdr-note">{tr(data.herdr.note)}</p>}
      </div>
      <p className="aw-keys">{tr('↑/↓ 或 j/k 选择，Enter 输入消息')}</p>
    </aside>
    <main className="aw-main" aria-label={tr('员工对话')}>
      <a className="aw-back" href={href(agentsPath(undefined, filter))} onClick={e => follow(e, agentsPath(undefined, filter))}>{tr('返回员工列表')}</a>
      {selectedTerminal ? <TerminalRoom key={selectedTerminal.id} terminal={selectedTerminal} toast={toast} /> : selected ? <>
        {!!selected.watch?.asks.length && <div className="aw-asks">{selected.watch.asks.map(q => <AskCard key={q.id} q={q} toast={toast} onDone={() => { void refreshOverview(); }} />)}</div>}
        <Conversation key={selected.id} agent={selected} toast={toast} />
      </> : <div className="aw-empty"><h2>{id && data ? tr('未找到这名员工') : tr('选择员工，查看对话')}</h2><p>{tr('可在左侧处理权限请求，或打开会话发送指令。')}</p></div>}
    </main>
    {selectedTerminal && <TerminalContext terminal={selectedTerminal} />}
    {selected && selectedGroup && <Context key={selected.id} agent={selected} group={selectedGroup} line={lines.find(l => l.id === selected.line_id)} toast={toast} />}
  </div>;
}

function AgentRow({ agent: a, selected, filter, project, toast }: { agent: Agent; selected: boolean; filter: string; project?: Group['line']; toast: (s: string) => void }) {
  const [busy, setBusy] = useState(false);
  async function permit(id: string, allow: boolean) {
    setBusy(true);
    try { await api.permit(a.id, id, allow); await refreshOverview(); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  }
  const to = agentsPath(a.id, filter);
  return <article className={`aw-row${selected ? ' on' : ''}`}>
    <a href={href(to)} onClick={e => follow(e, to)} aria-current={selected ? 'page' : undefined}>
      <div className="aw-row-top"><b>{agentName(a)}</b><span>{ago(a.watch?.since)}</span></div>
      <div className="aw-row-meta"><WatchStatus agent={a} /><span>{a.model ?? tr('模型未指定')}</span>{!!a.watch?.queued && <span>{tr('排队 {0}', a.watch.queued)}</span>}</div>
      {project && <small>#{project.seq} {project.title}</small>}
      {/* a waiting question is the row's line: the activity line would repeat it */}
      {a.watch?.asks.length ? a.watch.asks.map(q => <p className="aw-question" key={q.id}>{q.data.question}</p>)
        : <p className="aw-doing">{a.watch?.doing?.text || a.down || tr('暂无动态')}</p>}
    </a>
    {a.watch?.permissions.map(q => <div className="aw-permit" key={q.id}>
      {a.watch!.permissions.length > 1 && <p>{[q.title || q.name, q.arg].filter(Boolean).join(' ')}</p>}
      <div className="btns"><button className="btn pri" disabled={busy} onClick={() => permit(q.id, true)}>{tr('允许')}</button><button className="btn" disabled={busy} onClick={() => permit(q.id, false)}>{tr('拒绝')}</button></div>
    </div>)}
  </article>;
}

function TerminalRow({ terminal: t, selected, filter, project }: { terminal: Terminal; selected: boolean; filter: string; project?: Group['line'] }) {
  const to = agentsPath(t.id, filter);
  return <article className={`aw-row${selected ? ' on' : ''}`}>
    <a href={href(to)} onClick={e => follow(e, to)} aria-current={selected ? 'page' : undefined}>
      <div className="aw-row-top"><b>{t.name || kindName(t.kind) || tr('终端')}</b><span>{ago(t.watch.since)}</span></div>
      <div className="aw-row-meta"><WatchStatus agent={t} /><span>{kindName(t.kind) || tr('未指定')}</span><span className="aw-terminal-tag">{tr('终端')}</span>{!!t.watch.queued && <span>{tr('排队 {0}', t.watch.queued)}</span>}</div>
      {project && <small>#{project.seq} {project.title}</small>}
      <p className="aw-doing">{t.title || tr('暂无动态')}</p>
    </a>
  </article>;
}

function LooseRow({ session: s, line, toast, onJoined }: { session: Loose; line: NonNullable<Group['line']>; toast: (s: string) => void; onJoined: (a: Agent) => void }) {
  const [role, setRole] = useState<AgentRole>('coder'), [busy, setBusy] = useState(false);
  async function join() {
    setBusy(true);
    try { const a = await api.importAgent(line.id, role, s.id); await refreshOverview(); onJoined(a); }
    catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  }
  return <div className="aw-loose-row">
    <b>{s.title || tr('（没有标题）')}</b><span>{s.provider} · {s.model} · {AGENT_STATUS[s.status] ?? s.status}</span>
    <small className="path">{s.cwd}</small>
    <div className="btns"><select aria-label={tr('接入岗位')} value={role} onChange={e => setRole(e.target.value as AgentRole)} disabled={busy}>
      <option value="coder">{tr('代码员工')}</option><option value="writer">{tr('写作员工')}</option>
    </select><button className="btn" disabled={busy} onClick={join}>{tr('接入')}</button></div>
  </div>;
}

function Context({ agent, group, line, toast }: { agent: Agent; group: Group; line?: Line; toast: (s: string) => void }) {
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
  return <aside className="aw-context" aria-label={tr('员工上下文')}>
    <h2>{tr('上下文')}</h2>
    <dl>
      <dt>{tr('所属项目')}</dt><dd>{project ? <a href={href(projectPath)} onClick={e => follow(e, projectPath)}>#{project.seq} {project.title}</a> : tr('小助手')}</dd>
      {stage && <><dt>{tr('工序')}</dt><dd><a href={href(projectPath)} onClick={e => follow(e, projectPath)}>{stage}</a></dd></>}
      {agent.task && <><dt>{tr('节点任务')}</dt><dd><a href={href(nodePath)} onClick={e => follow(e, nodePath)}>{agent.task.title}</a></dd></>}
      <dt>{tr('工作目录')}</dt><dd className="path">{agent.cwd || tr('未指定')}</dd>
      <dt>{tr('模型')}</dt><dd>{agent.model || tr('模型未指定')}</dd>
    </dl>
    {agent.runtime === 'paseo' && <button className="btn" onClick={() => api.openInPaseo(agent.id).catch(e => toast((e as Error).message))}>{tr('在 Paseo 中打开')}</button>}
    <h3>{tr('最近的汇报与提问')}</h3>
    {error && <p role="alert" className="ac-error">{error}</p>}
    {!reports.length && !error && <p className="muted small">{tr('暂无汇报或提问。')}</p>}
    {reports.map(r => <details key={r.id} className="aw-report">
      <summary><span>{r.data.question || r.data.text}</span><small>{r.kind === 'ask' ? tr('提问') : tr('汇报')} · {ago(r.ts)}</small></summary>
      <Text text={r.data.question || r.data.text || ''} />{r.data.answer && <p>{tr('你的回答')} · {r.data.answer}</p>}
    </details>)}
  </aside>;
}
