// A project's agent at the depot, the press or the mill: hiring it in Paseo or in pi (a background
// tmux terminal), then its conversation. The assistant and the lead's chat reuse the hooks and pieces here.

import { HostedRoom, HostedContext } from '../agents/Terminal';
import { TerminalPick } from '../agents/TerminalPick';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { api, linkedPdfUrl, listen, type Agent, type AgentEvent, type AgentRole, type Job, type Line, type PaseoConversation, type PaseoInfo, type PaseoItem, type PaseoPermission, type PiState, type Roster, type StartOpts } from '../api';
import { AGENT_STATUS, STATUS } from './MillRoom';
import type { RoomActions } from './Interior';
import { Select, type Opt } from './Select';
import { FileLinks } from './Sheet';
import { ConvSkills } from './SkillRoom';
import { History } from '../console/Convs';
import { LeadAside } from '../console/Lead';
import { Compose } from '../agents/Compose';
import { useReadReceipt, useTalkPoll } from '../agents/live';
import { agentName, isWorking, TurnTime, WatchStatus } from '../agents/watch';
import { ago } from '../console/util';
import { tr, trx } from '../i18n';

interface Props extends RoomActions {
  role: AgentRole;
  focus: string | null;
  lines: Line[];
  tick: number;
}

const ROLE = {
  coder: { name: tr('代码员工'), place: tr('仓库'), job: tr('编写代码、运行测试，并将实验提交至实验农场') },
  writer: { name: tr('写作员工'), place: tr('印刷厂'), job: tr('读取实验结果，在 main.tex 撰写论文并编译') },
  monitor: { name: tr('看田员'), place: tr('实验农场'), job: '' },
  assistant: { name: tr('小助手'), place: tr('中控屏'), job: '' },
  lead: { name: tr('项目负责人'), place: tr('造纸厂'), job: tr('跟进进度、督促员工、向你汇报') },
} as const;

// a role's roster, read again on that role's agent events and on refresh()
function useRoster(role: AgentRole, tick: number, toast: (t: string) => void) {
  const [roster, setRoster] = useState<Roster | null>(null);
  const [bump, setBump] = useState(0);
  useEffect(() => listen(e => { if (e.type === 'agent' && e.agent?.role === role) setBump(b => b + 1); }), [role]);
  useEffect(() => {
    const t = setTimeout(() => api.roster(role).then(setRoster).catch(e => toast(e.message)), 120);
    return () => clearTimeout(t);
  }, [role, bump, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  return [roster, () => setBump(b => b + 1)] as const;
}

export function AgentRoom(p: Props) {
  const [roster, refresh] = useRoster(p.role, p.tick, p.toast);
  const [sel, setSel] = useState<string | null>(p.focus);
  const r = ROLE[p.role];

  const rows = roster?.roster ?? [];
  const cur = rows.find(x => x.line.id === sel) ?? rows[0];

  if (roster && !rows.length) {
    return (
      <div className="room-empty">
        <h2>{tr('暂无项目')}</h2>
        <p>{tr('项目立项后，由项目负责人启动{0}。', r.name)}</p>
        <button className="btn pri" onClick={p.onIdea}>{tr('放入一颗新 idea')}</button>
      </div>
    );
  }

  return (
    <div className="room room-agents">
      <aside className="room-side">
        <h4 className="side-h">{r.name} <span className="muted small">{tr('每个项目一个，')}{r.job}</span></h4>
        {rows.map(({ line, agent }, i) => (
          <button key={line.id} className={`mon${cur?.line.id === line.id ? ' on' : ''}`} style={{ ['--i' as string]: i }} onClick={() => setSel(line.id)}>
            <div className="proj-top"><b>#{line.seq} {line.title}</b><span className={`dot s-${agent?.status ?? 'none'}`} title={agent ? AGENT_STATUS[agent.status] : tr('未创建')} /></div>
            <p className="mon-note">{agent?.last ? lastLine(agent.last) : agent ? tr('暂无对话。') : tr('尚未配置员工。')}</p>
            <span className="muted small">{STATUS[line.status] ?? line.status}{agent ? ` · ${AGENT_STATUS[agent.status]}` : ''}</span>
          </button>
        ))}
        {roster && !roster.available.ok && <p className="warn-box small">{roster.available.note}{tr('，无法启动 pi。安装后重启服务即可。')}</p>}
      </aside>
      {cur && <Seat {...p} row={cur} ok={!!roster?.available.ok} onDone={refresh} />}
    </div>
  );
}

// a project's agent: its conversation once it has started, else hiring it
function Seat(p: Props & { row: Roster['roster'][number]; ok: boolean; onDone: () => void }) {
  const { row: cur } = p, line = p.lines.find(l => l.id === cur.line.id);
  return cur.agent?.started
    ? cur.agent.term ? <><HostedRoom key={cur.agent.id} agent={cur.agent} toast={p.toast} /><aside className="room-aside"><div className="pnl-s"><h4>{tr('终端')}</h4><HostedContext agent={cur.agent} toast={p.toast} /></div></aside></> : cur.agent.runtime === 'paseo'
      ? <PaseoChat key={cur.agent.ext_id ?? cur.agent.id} {...p} agent={cur.agent} line={line} />
      : <AgentChat key={cur.agent.id} {...p} agent={cur.agent} line={line} />
    : <Hire key={cur.line.id} line={cur.line} role={p.role} agent={cur.agent} ok={p.ok} toast={p.toast} onDone={p.onDone}
      repo={line?.linked?.[p.role === 'writer' ? 'paper' : 'code']?.path} />;
}

// one project's agent alone, for the console
export function AgentDesk(p: Props & { lineId: string }) {
  const [roster, refresh] = useRoster(p.role, p.tick, p.toast);
  const row = roster?.roster.find(x => x.line.id === p.lineId);
  if (!roster) return <p className="muted">{tr('加载中…')}</p>;
  return (
    <div className="room room-agents desk">
      {!roster.available.ok && <p className="warn-box small">{roster.available.note}{tr('，无法启动 pi。安装后重启服务即可。')}</p>}
      {row ? <Seat {...p} row={row} ok={roster.available.ok} onDone={refresh} /> : <p className="muted">{tr('该项目暂无法配置员工。')}</p>}
    </div>
  );
}

function lastLine(e: AgentEvent): string {
  const t = String(e.data?.text ?? '').trim().split('\n').find(Boolean) ?? '';
  return (e.kind === 'user' ? tr('你：') : '') + (t.length > 60 ? t.slice(0, 60) + '…' : t);
}

function Hire({ line, role, agent, ok, toast, onDone, repo }: {
  line: { id: string; seq: number; title: string }; role: AgentRole; agent: Agent | null; ok: boolean; toast: (t: string) => void; onDone: () => void;
  repo?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [paseo, setPaseo] = useState(false);
  const r = ROLE[role], lead = role === 'lead';

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      onDone();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const go = (o: StartOpts) => act(async () => {
    const a = agent ?? await api.openAgent(line.id, role);
    await api.startAgent(a.id, o);
  });

  return (
    <section className="room-main hire">
      <div className="hire-wrap">
        <h2>#{line.seq} {tr('暂无')}{r.name}</h2>
        {lead ? (
          <p className="muted">{tr('负责人跟进项目进度、分派任务并汇报。工作目录为 Papertown 自有目录。')}</p>
        ) : repo ? (
          <p className="warn-box">{tr('该项目从本地接入：员工将直接在')} <code>{repo}</code> {tr('中修改文件且真实生效。启动时令其先检查 git status，提交和推送前需先确认。说明与 pt 工具置于 Papertown 自有目录，不写入仓库。')}</p>
        ) : <p className="muted">{tr('选择运行方式。工作目录均为该项目在')}{r.place}{tr('的目录，启动时将先发送项目简报。')}</p>}
        <div className="hire-opts">
          <div className="hire-card">
            <h3>Paseo <span className="chip">{paseo ? tr('推荐') : tr('调试中')}</span></h3>
            <p className="muted small">{tr('支持 Claude Code、Codex、OpenCode、Pi 等，采用 Paseo 自有界面，命令、模型切换与权限审批均保持不变。')}</p>
            <PaseoPick busy={busy} onStart={go} onReady={setPaseo} role={lead ? 'lead' : undefined} />
          </div>
          <div className="hire-card"><h3>{tr('终端')}</h3><TerminalPick busy={busy} onStart={go} role={role} /></div>
          {!lead && <div className="hire-card">
            <h3>{tr('pi · 后台终端')}</h3>
            <p className="muted small">{tr('本机 pi 运行于 tmux 中，终端与此处对话实时同步。支持在此切换模型与思考强度，输入 / 可调用 pi 命令，沿用 pi 自身的模型设置与登录。')}</p>
            <button className="btn" disabled={!ok || busy} onClick={() => go({ runtime: 'pi' })}>{busy ? tr('启动中…') : tr('启动 pi')}</button>
            {!ok && <p className="muted small">{tr('本机未安装 pi 或 tmux。')}</p>}
          </div>}
          {paseo && !lead && <ImportCard busy={busy} onPick={id => act(() => api.importAgent(line.id, role, id))} />}
        </div>
      </div>
    </section>
  );
}

// a provider, model and thinking level from what Paseo lists, and the button that starts the agent
// there; the assistant and a lead start on what Papertown is set to give them, when Paseo has it
export function PaseoPick({ busy, onStart, onReady, role }: {
  busy: boolean; onStart: (o: StartOpts) => void; onReady?: (ok: boolean) => void; role?: 'assistant' | 'lead';
}) {
  const [info, setInfo] = useState<PaseoInfo | null>(null);
  const [prov, setProv] = useState('');
  const [model, setModel] = useState('');
  const [think, setThink] = useState('');

  useEffect(() => {
    api.paseo().then(i => {
      setInfo(i);
      onReady?.(i.status.ok && i.chat !== false);
      const d = role ? i.defaults?.[role] : undefined, own = i.providers.find(x => x.id === d?.provider);
      if (own) pick(i, own.id, d?.model, d?.thinking);
      else pick(i, (i.providers.find(x => x.id === 'claude') ?? i.providers[0])?.id ?? '');
    }).catch(e => setInfo({ status: { ok: false, note: tr('无法连接 Paseo：{0}', (e as Error).message) }, providers: [] }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function pick(i: PaseoInfo, id: string, mid?: string | null, th?: string | null) {
    const pv = i.providers.find(x => x.id === id), m = pv?.models.find(x => x.id === mid) ?? pv?.models[0];
    setProv(id);
    setModel(m?.id ?? '');
    setThink(th && m?.thinking.includes(th) ? th : m?.default_thinking ?? '');
  }

  const pv = info?.providers.find(x => x.id === prov), m = pv?.models.find(x => x.id === model);
  if (!info) return <p className="muted small">{tr('正在连接本机 Paseo…')}</p>;
  if (info.chat === false) return <p className="warn-box small">{tr('Paseo 接入正在调试，暂时停用。请使用终端启动。')}</p>;
  if (!info.status.ok) return <p className="warn-box small">{info.status.note}</p>;
  const d = role ? info.defaults?.[role] : undefined;
  return (
    <>
      {d?.provider && <p className="muted small">{tr('Papertown 为其配置了 {0}', [d.provider, d.model, d.thinking].filter(Boolean).join(' / '))}{info.providers.some(x => x.id === d.provider) ? '' : tr('，但 Paseo 中无此供应商')}</p>}
      <label className="field">{tr('供应商')}
        <Select value={prov} options={info.providers.map(x => ({ value: x.id, label: x.error ? tr('{0}（模型列表读取失败）', x.label) : x.label }))} onChange={id => pick(info, id)} />
      </label>
      {pv?.error && <p className="warn-box small">{tr('{0} 的模型列表读取失败：{1}。可使用默认模型启动，或选择其他供应商。', pv.label, pv.error)}</p>}
      {!!pv?.models.length && (
        <label className="field">{tr('模型')}
          <Select value={model} options={pv.models.map(x => ({ value: x.id, label: x.name }))} onChange={id => pick(info, prov, id)} />
        </label>
      )}
      {!!m && m.thinking.length > 1 && (
        <label className="field">{tr('思考强度')}
          <Select value={think} options={m.thinking.map(x => ({ value: x, label: x }))} onChange={setThink} />
        </label>
      )}
      {!info.status.web && <p className="muted small">{tr('Paseo 网页端未开启。此处仍可对话，也可在 Paseo 桌面端打开。')}</p>}
      <button className="btn pri" disabled={busy || !prov} onClick={() => onStart({ runtime: 'paseo', provider: prov, model: model || undefined, thinking: think || undefined })}>
        {busy ? tr('启动中…') : tr('在 Paseo 里启动')}
      </button>
    </>
  );
}

// Choosing Paseo or a hosted terminal backend (herdr, tmux, headless), preselected from the town's default runtime.
export function RuntimePick({ busy, onStart, role, allowPi }: {
  busy: boolean; onStart: (o: StartOpts) => void; role?: AgentRole; allowPi?: boolean;
}) {
  const [mode, setMode] = useState<'paseo' | 'terminal' | 'pi'>('terminal'), [paseoOn, setPaseoOn] = useState(false);
  useEffect(() => {
    let alive = true;
    api.defaultRuntime().then(d => { if (alive) { setPaseoOn(d.paseo_chat !== false); setMode(d.runtime === 'paseo' && d.paseo_chat !== false ? 'paseo' : 'terminal'); } }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return <>
    <div className="seg mini" role="radiogroup" aria-label={tr('运行方式')}>
      <button type="button" role="radio" aria-checked={mode === 'paseo'} className={mode === 'paseo' ? 'on' : ''} disabled={busy || !paseoOn} title={paseoOn ? undefined : tr('调试中，暂时停用')} onClick={() => setMode('paseo')}>Paseo{paseoOn ? '' : ` · ${tr('调试中')}`}</button>
      <button type="button" role="radio" aria-checked={mode === 'terminal'} className={mode === 'terminal' ? 'on' : ''} disabled={busy} onClick={() => setMode('terminal')}>{tr('终端')}</button>
      {allowPi && <button type="button" role="radio" aria-checked={mode === 'pi'} className={mode === 'pi' ? 'on' : ''} disabled={busy} onClick={() => setMode('pi')}>pi</button>}
    </div>
    {mode === 'paseo' ? <PaseoPick busy={busy} onStart={onStart} role={role === 'lead' || role === 'assistant' ? role : undefined} />
      : mode === 'terminal' ? <TerminalPick busy={busy} onStart={onStart} role={role} />
        : <button type="button" className="btn pri" disabled={busy} onClick={() => onStart({ runtime: 'pi' })}>{busy ? tr('启动中…') : tr('启动 pi')}</button>}
  </>;
}

// an existing Paseo conversation on this machine, taken over as this project's agent
export function ImportCard({ busy, onPick }: { busy: boolean; onPick: (id: string) => void }) {
  const [list, setList] = useState<PaseoConversation[] | null>(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => { api.conversations().then(d => setList(d.conversations)).catch(e => setErr((e as Error).message)); }, []);
  const k = q.trim().toLowerCase();
  const shown = (list ?? []).filter(c => !k || `${c.title ?? ''} ${c.provider} ${c.model ?? ''} ${c.cwd}`.toLowerCase().includes(k));
  return (
    <div className="hire-card import-card">
      <h3>{tr('导入 Paseo 中的已有对话')}</h3>
      <p className="muted small">{tr('选择本机 Paseo 对话关联至该项目，随后可在此继续对话，工作目录保持不变。')}</p>
      {err ? <p className="warn-box small">{err}</p> : !list ? <p className="muted small">{tr('正在读取 Paseo 的对话…')}</p> : !list.length ? <p className="muted small">{tr('Paseo 中暂无对话。')}</p> : (
        <>
          {list.length > 5 && <input className="conv-q" value={q} placeholder={tr('按标题、供应商或目录筛选')} onChange={e => setQ(e.target.value)} />}
          <div className="conv-list">
            {shown.map(c => (
              <button key={c.id} className="conv" disabled={busy || !!c.linked || !c.cwd} onClick={() => onPick(c.id)} title={c.cwd ?? undefined}>
                <b>{c.title || tr('（无标题）')}</b>
                <span className="muted small">{[c.provider, c.model].filter(Boolean).join(' · ')} · {c.cwd ? short(c.cwd) : tr('会话无工作目录，无法导入')} · {ago(c.last_user ?? c.updated)}</span>
                {c.linked && <em>{tr('已导入至')} {c.linked}</em>}
              </button>
            ))}
            {!shown.length && <p className="muted small">{tr('无匹配的对话。')}</p>}
          </div>
        </>
      )}
    </div>
  );
}

const short = (p: string) => p.replace(/^\/Users\/[^/]+/, '~').split('/').slice(-2).join('/');

// pi's slash commands: [name, what it does, needs pi's terminal UI]
const PI_COMMANDS: [string, string, boolean?][] = [
  ['model', tr('切换模型：/model 供应商/模型')], ['thinking', tr('思考强度：/thinking high')], ['compact', tr('压缩上下文，可附加说明')],
  ['new', tr('开始新会话')], ['clone', tr('复制当前会话并在副本中继续')], ['name', tr('命名会话')], ['session', tr('会话信息：消息数、token 与费用')],
  ['reload', tr('重新加载扩展、skills、提示模板和上下文文件')], ['copy', tr('复制最后一条回复至剪贴板'), true],
  ['export', tr('导出会话（HTML 或 .jsonl）'), true], ['fork', tr('从指定消息分叉新会话'), true], ['tree', tr('在会话树中跳转'), true],
  ['resume', tr('恢复其他会话'), true], ['settings', tr('设置'), true], ['scoped-models', tr('Ctrl+P 循环的模型'), true],
  ['login', tr('登录供应商'), true], ['logout', tr('退出登录'), true], ['hotkeys', tr('快捷键'), true], ['changelog', tr('更新日志'), true],
  ['share', tr('分享会话'), true], ['import', tr('导入 .jsonl 会话'), true], ['trust', tr('项目信任设置'), true], ['quit', tr('停止 pi')],
];

export type Item = { ev: AgentEvent; end?: AgentEvent };
export type ToolSt = 'run' | 'ok' | 'bad';

export const Thinking = () => <div className="thinking"><i /><i /><i /></div>;

// what the project has next to the chat: experiments for code, the manuscript for papers
function Aside({ agent, role, line, onOpen, toast, children }: { agent: Agent; role: AgentRole; line?: Line; onOpen: RoomActions['onOpen']; toast: (t: string) => void; children: React.ReactNode }) {
  const lid = agent.line_id ?? '';
  const [jobs, setJobs] = useState<Job[]>([]);
  const [repos, setRepos] = useState<any[]>([]);
  useEffect(() => {
    if (role !== 'coder') return;
    let alive = true;
    api.jobs(lid).then(b => alive && setJobs(b.jobs)).catch(() => {});
    api.building('depot').then(s => alive && setRepos(s.repos ?? [])).catch(() => {});
    const off = listen(e => {
      if (e.type === 'job' && e.job.line_id === lid) setJobs(js => js.some(j => j.id === e.job.id) ? js.map(j => j.id === e.job.id ? e.job : j) : [e.job, ...js]);
    });
    return () => { alive = false; off(); };
  }, [lid, role]);
  const files = line?.files ?? [];
  return (
    <aside className="room-aside">
      {children}
      {role === 'lead' ? <LeadAside lineId={lid} seq={line?.seq} toast={toast} /> : <ConvSkills lineId={lid} agentId={agent.id} onOpen={onOpen} />}
      {role === 'coder' && (
        <div className="pnl-s">
          <h4>{tr('提交至农场的实验')}</h4>
          {!jobs.length && <p className="muted small">{tr('暂无。')}{agent.runtime === 'paseo' ? tr('通过 .papertown/pt submit 提交。') : tr('pi 通过 papertown_submit_job 提交。')}</p>}
          {jobs.slice(0, 8).map(j => (
            <button key={j.id} className={`job mini s-${j.status}`} onClick={() => onOpen('farm', lid)}>
              <span className="job-name"><b>{j.name}</b><small>{j.backend}</small></span>
              <span className="bar"><i style={{ width: `${j.progress}%` }} /></span>
            </button>
          ))}
        </div>
      )}
      {role === 'coder' && repos.length > 0 && (
        <div className="pnl-s">
          <h4>{tr('参考仓库')} <span className="chip">{tr('示例数据')}</span></h4>
          <p className="muted small">{tr('文档已入检索库，方法设计时从中检索 baseline 与指标。')}</p>
          {repos.map(x => <div key={x.id} className="repo"><b>{x.label}</b><span className="muted small">{x.desc}</span></div>)}
        </div>
      )}
      {role === 'writer' && line?.linked?.paper && (
        <div className="pnl-s">
          <h4>{tr('稿子')}</h4>
          <p className="muted small path">{line.linked.paper.path}{line.linked.paper.main ? ` · ${line.linked.paper.main}` : ''}</p>
          {line.linked.paper.pdf ? <div className="btns"><a className="btn pri" href={linkedPdfUrl(line.id)} target="_blank" rel="noreferrer">{tr('看 PDF')}</a></div>
            : <p className="muted small">{tr('论文仓库中暂无已编译的 PDF。')}</p>}
        </div>
      )}
      {role === 'writer' && !line?.linked?.paper && (
        <div className="pnl-s">
          <h4>{tr('稿子')}</h4>
          {!files.length && <p className="muted small">{tr('印刷厂目录中暂无文件。')}</p>}
          <FileLinks lineId={lid} files={files} />
        </div>
      )}
    </aside>
  );
}

// A Paseo conversation follows live events and keeps a slow poll for missed updates.
export function usePaseoTalk(initial: Agent, own: (t: string) => string = t => t) {
  const [agent, setAgent] = useState(initial);
  const [items, setItems] = useState<PaseoItem[] | null>(null);
  const [asks, setAsks] = useState<PaseoPermission[]>([]);
  const [queued, setQueued] = useState<AgentEvent[]>([]);
  const [err, setErr] = useState('');
  const [sent, setSent] = useState<{ text: string; had: number }[]>([]);
  const mine = useRef(own), latest = useRef<PaseoItem[]>([]), alive = useRef(true);
  mine.current = own;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const times = (list: PaseoItem[], t: string) => list.filter(i => i.kind === 'user' && mine.current(i.text ?? '').trim() === t).length;
  const reload = useTalkPoll(agent, async () => {
    try {
      const d = await api.timeline(initial.id);
      if (!alive.current) return;
      setAgent(d.agent); setItems(d.items); latest.current = d.items;
      setAsks(d.agent.watch?.permissions ?? d.paseo?.permissions ?? []); setQueued(d.queued);
      setSent(xs => xs.filter(x => times(d.items, x.text) <= x.had)); setErr('');
    } catch (e) { if (alive.current) setErr((e as Error).message); }
  });
  useEffect(() => listen(e => { if (e.type === 'agent' && e.agent?.id === initial.id) setAgent(e.agent); }), [initial.id]);
  const readRef = useReadReceipt(initial.id, items === null ? null : JSON.stringify(items));
  const texts = useMemo(() => sent.map(x => x.text), [sent]);
  return {
    agent, items, asks, queued, err, sent: texts, reload, readRef,
    wrote: (t: string) => { setSent(xs => [...xs, { text: t, had: times(latest.current, t) + xs.filter(x => x.text === t).length }]); reload(); },
    answered: (id: string) => { setAsks(xs => xs.filter(x => x.id !== id)); reload(); },
  };
}

// a Paseo conversation's body: messages and tool trails, what is still sending, `children`, the
// permissions it asks for, and the dots while it works
export function PaseoLog({ rows, sent, asks, working, onPermit, children }: {
  rows: (PaseoItem | PaseoItem[])[]; sent: string[]; asks: PaseoPermission[]; working: boolean;
  onPermit: (id: string, allow: boolean) => void; children?: React.ReactNode;
}) {
  return (
    <>
      {rows.map((x, i) => Array.isArray(x)
        ? <Trail key={i} tools={x.map(paseoTool)} />
        : x.kind === 'user' ? <UserMsg key={i} text={x.text ?? ''} />
          : x.kind === 'assistant' ? <div key={i} className="msg-a"><Text text={x.text ?? ''} /></div>
            : <div key={i} className={`note${x.kind === 'error' ? ' err' : ''}`}>{x.text}</div>)}
      {sent.map((t, i) => <div key={`s${i}`} className="msg-u"><Text text={t} /><span className="meta">{tr('发送中')}</span></div>)}
      {children}
      {asks.map(q => (
        <div key={q.id} className="ask">
          <p><b>{tr('请求')}{q.name === 'Bash' ? tr('运行命令') : tr('使用 {0}', q.name)}</b>{q.title && q.title !== q.name ? ` · ${q.title}` : ''}</p>
          {q.arg && <pre className="code">{q.arg}</pre>}
          <div className="btns">
            <button className="btn pri" onClick={() => onPermit(q.id, true)}>{tr('允许')}</button>
            <button className="btn" onClick={() => onPermit(q.id, false)}>{tr('拒绝')}</button>
          </div>
        </div>
      ))}
      {working && !asks.length && <Thinking />}
    </>
  );
}

// tools: what the page around the conversation adds to its header
type ChatProps = { agent: Agent; line?: Line; role: AgentRole; toast: (t: string) => void; onOpen?: RoomActions['onOpen']; tools?: React.ReactNode };

// The standalone page supplies its own context column.
export function Conversation({ agent, toast, tools }: { agent: Agent; toast: (t: string) => void; tools?: React.ReactNode }) {
  if (agent.term) return <HostedRoom key={agent.id} agent={agent} toast={toast} tools={tools} />;
  return agent.runtime === 'paseo'
    ? <PaseoChat key={agent.ext_id ?? agent.id} agent={agent} role={agent.role} toast={toast} tools={tools} />
    : <AgentChat key={agent.id} agent={agent} role={agent.role} toast={toast} tools={tools} />;
}

function PaseoChat({ agent: initial, line, role, toast, onOpen, tools }: ChatProps) {
  const { agent, items, asks, queued, err, sent, wrote, answered, reload, readRef } = usePaseoTalk(initial);
  const [full, setFull] = useState(false);
  const [hist, setHist] = useState(false);
  const working = isWorking(agent);
  const scroll = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const r = ROLE[role];

  useEffect(() => {
    const el = scroll.current;
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [items?.length, sent.length, full]);

  const run = (fn: () => Promise<unknown>) => fn().then(() => reload()).catch(e => toast((e as Error).message));
  const rows = useMemo(() => fold(items ?? [], i => i.kind === 'tool'), [items]);
  return (
    <>
      <section className="room-main chat-main paseo-main">
        <header className="chat-head">
          <div className="chat-who">
            <WatchStatus agent={agent} />
            <div><b>{agentName(agent)}{line ? ` · #${line.seq}` : ''}</b><span className="muted small">{agent.model ?? 'Paseo'}</span><TurnTime agent={agent} /></div>
          </div>
          <div className="btns">
            <button className={`btn as-hist${hist ? ' on' : ''}`} aria-expanded={hist} onClick={() => setHist(h => !h)}>{tr('历史对话')}</button>
            <button className="btn" title={tr('新对话：使用同一模型重新开始')} onClick={() => run(() => api.newConv(agent.id))}>{tr('新对话')}</button>
            <button className="btn" disabled={!agent.web} title={agent.web ? tr('Paseo 自有界面：命令、模型切换、权限审批') : tr('Paseo 网页端未开启')} onClick={() => setFull(f => !f)}>{full ? tr('精简视图') : tr('完整界面')}</button>
            <button className="btn" onClick={() => run(() => api.openInPaseo(agent.id))}>{tr('桌面端')}</button>
            {tools}
            {hist && <History agent={agent.id} onPick={c => { setHist(false); run(() => api.resumeConv(agent.id, c.id)); }} onClose={() => setHist(false)} />}
          </div>
        </header>
        {full && agent.web
          ? <FullPaseo src={agent.web} title={`Paseo · ${r.place}`} />
          : (
            <>
              <div className="transcript" ref={el => { scroll.current = el; readRef.current = el; }} onScroll={e => {
                const el = e.currentTarget;
                stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
              }}>
                {err && <div className="note err">{err}</div>}
                {items && !items.length && !sent.length && <div className="room-empty small-empty"><p>{tr('暂无对话。')}</p></div>}
                <PaseoLog rows={rows} sent={sent} asks={asks} working={working}
                  onPermit={(id, allow) => run(async () => { await api.permit(agent.id, id, allow); answered(id); })} />
              </div>
              <Compose agent={agent} queued={queued} permission={asks.length > 0} toast={toast} onChanged={reload}
                onSent={(event, text) => { stick.current = true; if (event.data.delivered) wrote(text); }} />
            </>
          )}
      </section>
      {onOpen && <Aside agent={agent} role={role} line={line} onOpen={onOpen} toast={toast}>
        <div className="pnl-s">
          <h4>Paseo</h4>
          <p className="muted small">{tr('同一对话同步至 Paseo 桌面端与手机端。权限审批可在此直接操作，命令与模型切换位于「完整界面」。')}</p>
          <div className="btns"><button className="btn" onClick={() => run(() => api.brief(agent.id))}>{tr('发送项目简报')}</button></div>
          {agent.cwd && <p className="muted small path">{tr('目录：')}{agent.cwd}</p>}
        </div>
      </Aside>}
    </>
  );
}

// a Paseo tool call as a tool trail shows it
export const paseoTool = (t: PaseoItem) => ({ name: t.name ?? '', arg: t.arg, st: (t.status === 'running' ? 'run' : t.status === 'completed' ? 'ok' : 'bad') as ToolSt, note: t.error ?? undefined });

// what Papertown, not you, put into the conversation, wrapped in a tag that says what it is
const TAGGED = /^<(msg|checkin|answer|bounds|card)(?: from="([^"]*)")?>\n?([\s\S]*?)\n?<\/\1>\s*$/;
const someone = (w: string) => { const m = /^#(\d+) 的(.+)$/.exec(w); return m ? tr('#{0} 的{1}', m[1], trx(m[2])) : trx(w); };
function tagged(t: string) {
  const m = TAGGED.exec(t.trim());
  if (!m) return null;
  const label = m[1] === 'msg' ? tr('{0}发来的消息', someone(m[2] ?? '')) : { checkin: tr('Papertown：项目近况'), answer: tr('你的回答'), bounds: tr('工作边界已修改'), card: tr('你请求更新项目卡片') }[m[1]]!;
  return { k: m[1], label, body: m[3] };
}

// a long message from you (a project brief, a pasted log) shows its first lines until opened
export function UserMsg({ text: raw }: { text: string }) {
  const [open, setOpen] = useState(false);
  const tag = tagged(raw), text = tag?.body ?? raw;
  const lines = text.split('\n'), long = lines.length > 6 || text.length > 360;
  const shown = open || !long ? text : lines.slice(0, 4).join('\n').slice(0, 240).trimEnd() + '…';
  return (
    <div className={`msg-u${long ? ' long' : ''}${tag ? ` msg-tag t-${tag.k}` : ''}`}>
      {tag && <span className="mt-k">{tag.label}</span>}
      <Text text={shown} />
      {long && <button className="more" onClick={() => setOpen(o => !o)}>{open ? tr('收起') : tr('展开全部（{0} 行）', lines.length)}</button>}
    </div>
  );
}

// Paseo's own page for the agent. It shows its home for a few seconds before it jumps to the
// agent, so a veil covers it until then.
function FullPaseo({ src, title }: { src: string; title: string }) {
  const [ready, setReady] = useState(false);
  return (
    <div className="paseo-wrap">
      <iframe className="paseo-frame" src={src} title={title} allow="clipboard-read; clipboard-write; microphone"
        onLoad={() => window.setTimeout(() => setReady(true), 7000)} />
      <div className={`paseo-veil${ready ? ' gone' : ''}`}><span className="thinking"><i /><i /><i /></span><p>{tr('正在打开 Paseo 界面…')}</p></div>
    </div>
  );
}

// consecutive entries that match `is` come out as one array, the rest one by one
export function fold<T>(list: T[], is: (x: T) => boolean): (T | T[])[] {
  const out: (T | T[])[] = [];
  for (const x of list) {
    const last = out[out.length - 1];
    if (is(x) && Array.isArray(last)) last.push(x);
    else out.push(is(x) ? [x] : x);
  }
  return out;
}

// a run of tool calls as one quiet line; opens to the list
export function Trail({ tools, children }: { tools: { name: string; arg?: string; st: ToolSt; note?: string }[]; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const last = tools[tools.length - 1], bad = tools.filter(t => t.st === 'bad').length, busy = tools.some(t => t.st === 'run');
  return (
    <div className={`trail${open ? ' open' : ''}${busy ? ' t-run' : bad ? ' t-bad' : ''}`}>
      <button onClick={() => setOpen(o => !o)}>
        <span className="t-ic">{busy ? '…' : bad ? '!' : '✓'}</span>
        <b>{tools.length > 1 ? tr('{0} 个工具', tools.length) : last.name}</b>
        <span className="t-arg">{tools.length > 1 ? `${last.name} ${last.arg ?? ''}` : last.arg}</span>
        {bad > 0 && <em>{bad} {tr('个错误')}</em>}
      </button>
      {open && (children ?? <ul>{tools.map((t, i) => <li key={i} className={`t-${t.st}`}><b>{t.name}</b><span>{t.arg}</span>{t.note && <em>{t.note}</em>}</li>)}</ul>)}
    </div>
  );
}

// A pi agent's conversation: its events, each tool call paired with its result, and its reply as it streams in.
export function usePiTalk(initial: Agent) {
  const [agent, setAgent] = useState(initial);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [live, setLive] = useState('');

  const [err, setErr] = useState('');
  const [ready, setReady] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const reload = useTalkPoll(agent, async () => {
    try {
      const d = await api.agent(initial.id);
      if (alive.current) { setAgent(d.agent); setEvents(d.events); setReady(true); setErr(''); }
    } catch (e) { if (alive.current) setErr((e as Error).message); }
  }, true);
  const readRef = useReadReceipt(initial.id, ready ? JSON.stringify(events) + live : null);

  useEffect(() => listen(e => {
    if (e.type === 'agent' && e.agent?.id === initial.id) setAgent(e.agent);
    else if (e.type === 'agent_event' && e.event.agent_id === initial.id) {
      setEvents(list => list.some(x => x.id === e.event.id) ? list.map(x => x.id === e.event.id ? e.event : x) : [...list, e.event]);
      if (e.event.kind === 'assistant') setLive('');
    } else if (e.type === 'agent_delta' && e.agent_id === initial.id) setLive(t => t + e.text);
  }), [initial.id]);

  const items = useMemo(() => {
    const ends = new Map(events.filter(e => e.kind === 'tool_end').map(e => [e.data.id, e]));
    return events.filter(e => e.kind !== 'tool_end').map(ev => ({ ev, end: ev.kind === 'tool' ? ends.get(ev.data.id) : undefined }) as Item);
  }, [events]);
  const queued = events.filter(e => e.kind === 'user' && e.data.held && !e.data.delivered && !e.data.dropped);
  return { agent, items, live, queued, err, reload, readRef };
}

// a pi conversation's body: its entries and tool trails, the reply streaming in, the dots while it works
export function PiLog({ rows, live, working }: { rows: (Item | Item[])[]; live: string; working: boolean }) {
  return (
    <>
      {rows.map(x => Array.isArray(x)
        ? <Trail key={x[0].ev.id} tools={x.map(piTool)}><div className="trail-list">{x.map(t => <Tool key={t.ev.id} {...t} />)}</div></Trail>
        : <Entry key={x.ev.id} ev={x.ev} end={x.end} />)}
      {live && <div className="msg-a streaming"><Text text={live} /><i className="caret" /></div>}
      {working && !live && <Thinking />}
    </>
  );
}

function AgentChat({ agent: initial, line, role, toast, onOpen, tools }: ChatProps) {
  const { agent, items, live, queued, err, reload, readRef } = usePiTalk(initial);
  const [text, setText] = useState('');
  const scroll = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const r = ROLE[role];
  const rows = useMemo(() => fold(items, x => x.ev.kind === 'tool'), [items]);

  useEffect(() => {
    const el = scroll.current;
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [items.length, live]);

  const run = (fn: () => Promise<unknown>) => fn().then(() => reload()).catch(e => toast((e as Error).message));
  const on = ['idle', 'working', 'starting'].includes(agent.status);

  const st = agent.state;
  const word = text.startsWith('/') && !/\s/.test(text) ? text.slice(1).toLowerCase() : null;
  const extra = (st?.commands ?? []).map(c => [c.name, c.description || ({ extension: tr('扩展命令'), prompt: tr('提示模板'), skill: 'skill' } as Record<string, string>)[c.source] || c.source] as [string, string]);
  const menu = word === null ? [] : [...PI_COMMANDS, ...extra].filter(([n]) => n.toLowerCase().startsWith(word)).slice(0, 9);

  return (
    <>
      <section className="room-main chat-main">
        <header className="chat-head">
          <div className="chat-who">
            <WatchStatus agent={agent} />
            <div><b>{agentName(agent)}{line ? ` · #${line.seq}` : ''}</b><span className="muted small">{AGENT_STATUS[agent.status]}{!st && agent.model ? ` · ${agent.model}` : ''}{agent.cost ? ` · $${agent.cost.toFixed(3)}` : ''}</span><TurnTime agent={agent} /></div>
          </div>
          {st && on && <PiSwitch s={st} send={t => run(() => api.say(agent.id, t))} />}
          <div className="btns">
            <button className="btn" onClick={() => run(() => api.newConv(agent.id))}>{tr('新对话')}</button>
            <button className="btn" onClick={() => run(() => api.brief(agent.id))}>{tr('发送项目简报')}</button>
            {on ? <button className="btn" onClick={() => run(() => api.stopAgent(agent.id))}>{tr('关闭会话')}</button>
              : <button className="btn pri" onClick={() => run(() => api.startAgent(agent.id))}>{tr('启动')}</button>}
            {tools}
          </div>
        </header>
        <div className="transcript" ref={el => { scroll.current = el; readRef.current = el; }} onScroll={e => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}>
          {err && <p className="note err">{err}</p>}
          {!items.length && !live && <div className="room-empty small-empty"><p>{tr('暂无对话。可先「发送项目简报」，待其读取项目信息后再开始。')}</p></div>}
          <PiLog rows={rows} live={live} working={agent.status === 'working'} />
        </div>
        <Compose agent={agent} queued={queued} toast={toast} onChanged={reload} value={text} onChange={setText}
          placeholder={tr('向{0}输入内容，输入 / 调用 pi 命令，Enter 发送', r.name)}
          onSent={() => { stick.current = true; }} onKeyDown={e => {
            if (e.key === 'Tab' && menu.length) { e.preventDefault(); setText(`/${menu[0][0]} `); }
          }}>
          {menu.length > 0 && <div className="cmd-menu" role="listbox">
            {menu.map(([n, d, tui]) => <button key={n} onMouseDown={e => { e.preventDefault(); setText(`/${n} `); }}>
              <code>/{n}</code><span>{d}</span>{tui && <em>{tr('终端')}</em>}
            </button>)}
          </div>}
        </Compose>
      </section>
      {onOpen && <Aside agent={agent} role={role} line={line} onOpen={onOpen} toast={toast}>
        <div className="pnl-s">
          <h4>{tr('终端')}</h4>
          <p className="muted small">{tr('pi 在后台 tmux 中运行，接入即可查看同一对话，终端内的输入也将同步至此。')}</p>
          {agent.attach && <div className="copy"><code>{agent.attach}</code><button className="btn" onClick={() => {
            navigator.clipboard?.writeText(agent.attach!).then(() => toast(tr('已复制')), () => toast(agent.attach!));
          }}>{tr('复制')}</button></div>}
          {agent.cwd && <p className="muted small path">{tr('目录：')}{agent.cwd}</p>}
          {st?.session && <p className="muted small path">{tr('会话：')}{st.session.name ?? st.session.id}</p>}
        </div>
      </Aside>}
    </>
  );
}

// a pi tool call, paired with its result, as a tool trail shows it
export const piTool = ({ ev, end }: Item) => ({ name: ev.data.name as string, arg: toolArg(ev.data.args), st: (!end ? 'run' : end.data.error ? 'bad' : 'ok') as ToolSt });

function Entry({ ev, end }: Item) {
  const d = ev.data ?? {};
  if (ev.kind === 'user' && d.cmd) {
    return <div className="msg-u cmd"><code>{d.text}</code><span className="meta">{tr('命令')}{d.delivered ? '' : tr(' · 发送中')}</span></div>;
  }
  if (ev.kind === 'user') {
    return (
      <div className="msg-u">
        <Text text={d.text} />
        <span className="meta">{d.origin === 'terminal' ? tr('终端') : tr('网页')}{d.origin === 'web' ? (d.delivered ? (d.queued ? tr(' · 已排队') : d.steered ? tr(' · 已插话') : tr(' · 已送达')) : d.held ? tr(' · 排队中') : tr(' · 发送中')) : ''}</span>
      </div>
    );
  }
  if (ev.kind === 'assistant') {
    if (!d.text && !d.error) return null;
    return <div className={`msg-a${d.error ? ' err' : ''}`}><Text text={d.text || d.error} /></div>;
  }
  if (ev.kind === 'tool') return <Tool ev={ev} end={end} />;
  return <div className={`note${d.error ? ' err' : ''}`}>{d.text}</div>;
}

const toolArg = (a: any = {}) => String(a.command ?? a.path ?? a.file_path ?? a.name ?? a.query ?? (Object.keys(a).length ? JSON.stringify(a) : '')).slice(0, 160);

export function Tool({ ev, end }: Item) {
  const [open, setOpen] = useState(false);
  const { name, arg, st } = piTool({ ev, end });
  return (
    <div className={`tool t-${st}`}>
      <button onClick={() => setOpen(o => !o)}>
        <span className="t-ic">{st === 'run' ? '…' : st === 'ok' ? '✓' : '✕'}</span>
        <b>{name}</b><span className="t-arg">{arg.slice(0, 140)}</span>
        {end?.data.ms != null && <span className="muted small">{end.data.ms < 1000 ? `${end.data.ms}ms` : `${(end.data.ms / 1000).toFixed(1)}s`}</span>}
      </button>
      {open && end?.data.result && <pre className="code">{end.data.result}</pre>}
    </div>
  );
}

// pi's model and thinking level; changing them sends /model and /thinking
export function PiSwitch({ s, send }: { s: PiState; send: (t: string) => void }) {
  const cur = s.model ? `${s.model.provider}/${s.model.id}` : '';
  const groups = new Map<string, NonNullable<PiState['models']>>();
  for (const m of s.models ?? []) groups.set(m.provider, [...(groups.get(m.provider) ?? []), m]);
  const models: Opt[] = [...groups].flatMap(([p, ms]) => ms.map(m => ({ value: `${p}/${m.id}`, label: m.name, group: s.providers?.[p] ?? p })));
  // the model in use, even when pi does not list it
  if (cur && !models.some(m => m.value === cur)) models.unshift({ value: cur, label: cur });
  return (
    <div className="pi-switch">
      <Select value={cur} options={models} title={tr('模型（/model）')} label={tr('模型（/model）')} placeholder={tr('模型')} onChange={v => send(`/model ${v}`)} />
      {s.levels.length > 1 && (
        <Select value={s.thinking} options={s.levels.map(l => ({ value: l, label: l }))} title={tr('思考强度（/thinking）')} label={tr('思考强度（/thinking）')}
          onChange={v => send(`/thinking ${v}`)} />
      )}
      {s.context?.percent != null && <span className="muted small" title={tr('上下文用量')}>{tr('上下文')} {Math.round(s.context.percent)}%</span>}
    </div>
  );
}

// What agents write, built as elements and never as HTML: ``` fences as code, paragraphs, lists,
// rules, **bold**, `code` and links. A Linker turns plain text or a `code` span (null: leave it
// as code) into something to click.
export interface Linker {
  text?: (s: string) => React.ReactNode[];
  code?: (s: string) => React.ReactNode | null;
}
export function Text({ text, link }: { text: string; link?: Linker }) {
  const parts = String(text ?? '').split(/```[a-zA-Z0-9_-]*\n?/);
  return <>{parts.map((t, i) => i % 2 ? <pre key={i} className="code">{t.replace(/\n$/, '')}</pre> : <Blocks key={i} text={t} link={link} />)}</>;
}

const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
function Blocks({ text, link }: { text: string; link?: Linker }) {
  const blocks = text.split(/\n\s*\n/).map(b => b.replace(/^\n+|\n+$/g, '')).filter(b => b.trim());
  while (blocks.length && RULE.test(blocks[0])) blocks.shift();
  while (blocks.length && RULE.test(blocks[blocks.length - 1])) blocks.pop();
  return <>{blocks.map((b, i) => {
    if (RULE.test(b)) return <hr key={i} className="md-hr" />;
    const lines = b.split('\n');
    if (lines.every(l => /^\s*([-*•]|\d+[.)])\s+/.test(l))) {
      const items = lines.map(l => l.replace(/^\s*([-*•]|\d+[.)])\s+/, ''));
      return /^\s*\d/.test(lines[0])
        ? <ol key={i}>{items.map((x, k) => <li key={k}><Inline text={x} link={link} /></li>)}</ol>
        : <ul key={i}>{items.map((x, k) => <li key={k}><Inline text={x} link={link} /></li>)}</ul>;
    }
    const h = /^#{1,6}\s+(.*)$/.exec(lines[0]);
    if (h && lines.length === 1) return <p key={i} className="md-h"><Inline text={h[1]} link={link} /></p>;
    return <p key={i}><Inline text={b} link={link} /></p>;
  })}</>;
}

function Inline({ text, link }: { text: string; link?: Linker }) {
  const out: React.ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
  const plain = (s: string, k: number) => out.push(link?.text ? <Fragment key={`t${k}`}>{link.text(s)}</Fragment> : s);
  let at = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > at) plain(text.slice(at, m.index), at);
    out.push(m[1] != null ? <strong key={m.index}><Inline text={m[1]} link={link} /></strong>
      : m[2] != null ? <Fragment key={m.index}>{link?.code?.(m[2]) ?? <code className="md-c">{m[2]}</code>}</Fragment>
        : <a key={m.index} href={m[4]} target="_blank" rel="noreferrer">{m[3]}</a>);
    at = re.lastIndex;
  }
  if (at < text.length) plain(text.slice(at), at);
  return <>{out}</>;
}
