// The press and the depot: one coding agent per project, in one of two places.
// - Paseo: any provider Paseo hosts (Claude Code, Codex, OpenCode, Pi, ...). The room embeds
//   Paseo's own page for the agent, so its commands, model switches and permission prompts
//   are all there.
// - pi in a background tmux terminal: the conversation here is the same one running in the
//   terminal, both ways and live. Its model and thinking level can be switched here, and
//   pi's slash commands typed here run in pi (the ones that need its terminal UI open there).

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, fileUrl, linkedPdfUrl, listen, type Agent, type AgentEvent, type AgentRole, type Job, type Line, type PaseoConversation, type PaseoInfo, type PaseoItem, type PaseoPermission, type PiState, type Roster, type StartOpts } from '../api';
import { AGENT_STATUS, STATUS } from './MillRoom';
import type { RoomActions } from './Interior';
import { tr } from '../i18n';

interface Props extends RoomActions {
  role: AgentRole;
  focus: string | null;
  lines: Line[];
  tick: number;
}

const ROLE = {
  coder: { name: tr('代码员工'), place: tr('仓库'), job: tr('写代码、跑测试，再把实验提交到实验农场') },
  writer: { name: tr('写作员工'), place: tr('印刷厂'), job: tr('读实验结果，在 main.tex 里写论文并编译') },
  monitor: { name: tr('看田员'), place: tr('实验农场'), job: '' },
} as const;

export function AgentRoom(p: Props) {
  const [roster, setRoster] = useState<Roster | null>(null);
  const [sel, setSel] = useState<string | null>(p.focus);
  const [bump, setBump] = useState(0);
  const r = ROLE[p.role];

  useEffect(() => listen(e => { if (e.type === 'agent' && e.agent?.role === p.role) setBump(b => b + 1); }), [p.role]);
  useEffect(() => {
    const t = setTimeout(() => api.roster(p.role).then(setRoster).catch(e => p.toast(e.message)), 120);
    return () => clearTimeout(t);
  }, [p.role, bump, p.tick]);

  const rows = roster?.roster ?? [];
  const cur = rows.find(x => x.line.id === sel) ?? rows[0];

  if (roster && !rows.length) {
    return (
      <div className="room-empty">
        <h2>{tr('还没有项目')}</h2>
        <p>{tr('项目在造纸厂立项后，')}{r.place}{tr('会为它配一个')}{r.name}{tr('。')}</p>
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
            <p className="mon-note">{agent?.last ? lastLine(agent.last) : agent ? tr('还没有对话。') : tr('还没有配员工。')}</p>
            <span className="muted small">{STATUS[line.status] ?? line.status}{agent ? ` · ${AGENT_STATUS[agent.status]}` : ''}</span>
          </button>
        ))}
        {roster && !roster.available.ok && <p className="warn-box small">{roster.available.note}{tr('，没法启动 pi。装好后重启服务即可。')}</p>}
      </aside>
      {cur && (cur.agent?.started
        ? cur.agent.runtime === 'paseo'
          ? <PaseoChat key={cur.agent.id} {...p} agent={cur.agent} line={p.lines.find(l => l.id === cur.line.id)} />
          : <AgentChat key={cur.agent.id} {...p} agent={cur.agent} line={p.lines.find(l => l.id === cur.line.id)} />
        : <Hire key={cur.line.id} line={cur.line} role={p.role} agent={cur.agent} ok={!!roster?.available.ok} toast={p.toast} onDone={() => setBump(b => b + 1)}
          repo={p.lines.find(l => l.id === cur.line.id)?.linked?.[p.role === 'writer' ? 'paper' : 'code']?.path} />)}
    </div>
  );
}

function lastLine(e: AgentEvent): string {
  const t = String(e.data?.text ?? '').trim().split('\n').find(Boolean) ?? '';
  return (e.kind === 'user' ? tr('你：') : '') + (t.length > 60 ? t.slice(0, 60) + '…' : t);
}

function Hire({ line, role, agent, ok, toast, onDone, repo }: {
  line: { id: string; seq: number; title: string }; role: AgentRole; agent: Agent | null; ok: boolean; toast: (t: string) => void; onDone: () => void;
  repo?: string; // a linked project's own repository, which the agent works in
}) {
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<PaseoInfo | null>(null);
  const [prov, setProv] = useState('');
  const [model, setModel] = useState('');
  const [think, setThink] = useState('');
  const r = ROLE[role];

  useEffect(() => {
    api.paseo().then(i => {
      setInfo(i);
      pick(i, (i.providers.find(x => x.id === 'claude') ?? i.providers[0])?.id ?? '');
    }).catch(e => setInfo({ status: { ok: false, note: tr('连不上 Paseo：{0}', (e as Error).message) }, providers: [] }));
  }, []);

  function pick(i: PaseoInfo | null, id: string, mid?: string) {
    const pv = i?.providers.find(x => x.id === id), m = pv?.models.find(x => x.id === mid) ?? pv?.models[0];
    setProv(id);
    setModel(m?.id ?? '');
    setThink(m?.default_thinking ?? '');
  }

  async function go(o: StartOpts) {
    setBusy(true);
    try {
      const a = agent ?? await api.openAgent(line.id, role);
      await api.startAgent(a.id, o);
      onDone();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const pv = info?.providers.find(x => x.id === prov), m = pv?.models.find(x => x.id === model);
  return (
    <section className="room-main hire">
      <div className="hire-wrap">
        <h2>#{line.seq} {tr('还没有')}{r.name}</h2>
        {repo ? (
          <p className="warn-box">{tr('这是从本地接入的项目：员工会直接在')} <code>{repo}</code> {tr('里改文件，改动是真的。启动时会让它先看 git status、提交和推送前问你；它的说明和 pt 工具放在 Papertown 自己的目录里，不写进仓库。')}</p>
        ) : <p className="muted">{tr('选一种运行方式。工作目录都是这个项目在')}{r.place}{tr('的目录，启动时会先把项目简报发给它。')}</p>}
        <div className="hire-opts">
          <div className="hire-card">
            <h3>Paseo <span className="chip">{tr('推荐')}</span></h3>
            <p className="muted small">{tr('Claude Code、Codex、OpenCode、Pi 等都可以。对话用的是 Paseo 自己的界面，命令、模型切换和权限审批都照旧。')}</p>
            {!info ? <p className="muted small">{tr('正在连本机的 Paseo…')}</p> : !info.status.ok ? <p className="warn-box small">{info.status.note}</p> : (
              <>
                <label className="field">{tr('供应商')}
                  <select value={prov} onChange={e => pick(info, e.target.value)}>
                    {info.providers.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
                  </select>
                </label>
                {!!pv?.models.length && (
                  <label className="field">{tr('模型')}
                    <select value={model} onChange={e => pick(info, prov, e.target.value)}>
                      {pv.models.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                  </label>
                )}
                {!!m && m.thinking.length > 1 && (
                  <label className="field">{tr('思考强度')}
                    <select value={think} onChange={e => setThink(e.target.value)}>
                      {m.thinking.map(x => <option key={x} value={x}>{x}</option>)}
                    </select>
                  </label>
                )}
                {!info.status.web && <p className="muted small">{tr('Paseo 的网页端没开，房间里显示不了对话，可以去 Paseo 桌面端看。打开方法：')}<code>paseo daemon config set features.webUi.enabled true</code>{tr('，再')} <code>paseo daemon restart</code>{tr('。')}</p>}
                <button className="btn pri" disabled={busy || !prov} onClick={() => go({ runtime: 'paseo', provider: prov, model: model || undefined, thinking: think || undefined })}>
                  {busy ? tr('启动中…') : tr('在 Paseo 里启动')}
                </button>
              </>
            )}
          </div>
          <div className="hire-card">
            <h3>{tr('pi · 后台终端')}</h3>
            <p className="muted small">{tr('本机的 pi 跑在 tmux 里，终端和这里的对话实时同步。这里能切换模型和思考强度，输入 / 可以用 pi 的命令。它用 pi 自己的模型设置和登录。')}</p>
            <button className="btn" disabled={!ok || busy} onClick={() => go({ runtime: 'pi' })}>{busy ? tr('启动中…') : tr('启动 pi')}</button>
            {!ok && <p className="muted small">{tr('本机没有 pi 或 tmux。')}</p>}
          </div>
          {info?.status.ok && <ImportCard busy={busy} onPick={async id => {
            setBusy(true);
            try { await api.importAgent(line.id, role, id); onDone(); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
          }} />}
        </div>
      </div>
    </section>
  );
}

// an existing Paseo conversation on this machine, taken over as this project's agent
function ImportCard({ busy, onPick }: { busy: boolean; onPick: (id: string) => void }) {
  const [list, setList] = useState<PaseoConversation[] | null>(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => { api.conversations().then(d => setList(d.conversations)).catch(e => setErr((e as Error).message)); }, []);
  const k = q.trim().toLowerCase();
  const shown = (list ?? []).filter(c => !k || `${c.title ?? ''} ${c.provider} ${c.model ?? ''} ${c.cwd}`.toLowerCase().includes(k));
  return (
    <div className="hire-card import-card">
      <h3>{tr('导入 Paseo 里已有的对话')}</h3>
      <p className="muted small">{tr('选一段本机 Paseo 里的对话交给这个项目，之后在这里接着聊。它的工作目录不变。')}</p>
      {err ? <p className="warn-box small">{err}</p> : !list ? <p className="muted small">{tr('正在读取 Paseo 的对话…')}</p> : !list.length ? <p className="muted small">{tr('Paseo 里还没有对话。')}</p> : (
        <>
          {list.length > 5 && <input className="conv-q" value={q} placeholder={tr('按标题、供应商或目录筛选')} onChange={e => setQ(e.target.value)} />}
          <div className="conv-list">
            {shown.map(c => (
              <button key={c.id} className="conv" disabled={busy || !!c.linked} onClick={() => onPick(c.id)} title={c.cwd}>
                <b>{c.title || tr('（无标题）')}</b>
                <span className="muted small">{[c.provider, c.model].filter(Boolean).join(' · ')} · {short(c.cwd)} · {ago(c.last_user ?? c.updated)}</span>
                {c.linked && <em>{tr('已导入给')} {c.linked}</em>}
              </button>
            ))}
            {!shown.length && <p className="muted small">{tr('没有匹配的对话。')}</p>}
          </div>
        </>
      )}
    </div>
  );
}

const short = (p: string) => p.replace(/^\/Users\/[^/]+/, '~').split('/').slice(-2).join('/');
function ago(iso: string) {
  const m = Math.max(0, (Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? tr('刚刚') : m < 60 ? tr('{0} 分钟前', Math.round(m)) : m < 1440 ? tr('{0} 小时前', Math.round(m / 60)) : tr('{0} 天前', Math.round(m / 1440));
}

// pi's slash commands: [name, what it does, needs pi's terminal UI]
const PI_COMMANDS: [string, string, boolean?][] = [
  ['model', tr('切换模型：/model 供应商/模型')], ['thinking', tr('思考强度：/thinking high')], ['compact', tr('压缩上下文，可以附一句要求')],
  ['new', tr('开始新会话')], ['clone', tr('复制当前会话，在副本里继续')], ['name', tr('给会话起名')], ['session', tr('会话信息：消息数、token 和花费')],
  ['reload', tr('重新加载扩展、skills、提示模板和上下文文件')], ['copy', tr('把最后一条回复复制到剪贴板'), true],
  ['export', tr('导出会话（HTML 或 .jsonl）'), true], ['fork', tr('从某条消息分叉出新会话'), true], ['tree', tr('在会话树里跳转'), true],
  ['resume', tr('恢复别的会话'), true], ['settings', tr('设置'), true], ['scoped-models', tr('Ctrl+P 循环的模型'), true],
  ['login', tr('登录供应商'), true], ['logout', tr('退出登录'), true], ['hotkeys', tr('快捷键'), true], ['changelog', tr('更新日志'), true],
  ['share', tr('分享会话'), true], ['import', tr('导入 .jsonl 会话'), true], ['trust', tr('项目信任设置'), true], ['quit', tr('停止 pi')],
];

type Item = { ev: AgentEvent; end?: AgentEvent };

// what the project has next to the chat: experiments for code, the manuscript for papers
function Aside({ agent, role, line, onOpen, children }: { agent: Agent; role: AgentRole; line?: Line; onOpen: RoomActions['onOpen']; children: React.ReactNode }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [repos, setRepos] = useState<any[]>([]);
  useEffect(() => {
    if (role !== 'coder') return;
    let alive = true;
    api.jobs(agent.line_id).then(b => alive && setJobs(b.jobs)).catch(() => {});
    api.building('depot').then(s => alive && setRepos(s.repos ?? [])).catch(() => {});
    const off = listen(e => {
      if (e.type === 'job' && e.job.line_id === agent.line_id) setJobs(js => js.some(j => j.id === e.job.id) ? js.map(j => j.id === e.job.id ? e.job : j) : [e.job, ...js]);
    });
    return () => { alive = false; off(); };
  }, [agent.line_id, role]);
  const files = line?.files ?? [];
  return (
    <aside className="room-aside">
      {children}
      {role === 'coder' && (
        <div className="pnl-s">
          <h4>{tr('提交到农场的实验')}</h4>
          {!jobs.length && <p className="muted small">{tr('还没有。')}{agent.runtime === 'paseo' ? tr('它用 .papertown/pt submit 提交。') : tr('pi 会用 papertown_submit_job 提交。')}</p>}
          {jobs.slice(0, 8).map(j => (
            <button key={j.id} className={`job mini s-${j.status}`} onClick={() => onOpen('farm', agent.line_id)}>
              <span className="job-name"><b>{j.name}</b><small>{j.backend}</small></span>
              <span className="bar"><i style={{ width: `${j.progress}%` }} /></span>
            </button>
          ))}
        </div>
      )}
      {role === 'coder' && repos.length > 0 && (
        <div className="pnl-s">
          <h4>{tr('参考仓库')} <span className="chip">{tr('示例数据')}</span></h4>
          <p className="muted small">{tr('文档进了检索库，方法设计时从这里找 baseline 和指标。')}</p>
          {repos.map(x => <div key={x.id} className="repo"><b>{x.label}</b><span className="muted small">{x.desc}</span></div>)}
        </div>
      )}
      {role === 'writer' && line?.linked?.paper && (
        <div className="pnl-s">
          <h4>{tr('稿子')}</h4>
          <p className="muted small path">{line.linked.paper.path}{line.linked.paper.main ? ` · ${line.linked.paper.main}` : ''}</p>
          {line.linked.paper.pdf ? <div className="btns"><a className="btn pri" href={linkedPdfUrl(line.id)} target="_blank" rel="noreferrer">{tr('看 PDF')}</a></div>
            : <p className="muted small">{tr('论文仓库里还没有编译好的 PDF。')}</p>}
        </div>
      )}
      {role === 'writer' && !line?.linked?.paper && (
        <div className="pnl-s">
          <h4>{tr('稿子')}</h4>
          {!files.length && <p className="muted small">{tr('印刷厂目录里还没有文件。')}</p>}
          <div className="btns">{files.map(f => <a key={f} className={`btn${f === 'main.pdf' ? ' pri' : ''}`} href={fileUrl(agent.line_id, f)} target="_blank" rel="noreferrer">{f}</a>)}</div>
        </div>
      )}
    </aside>
  );
}

// a Paseo agent: its conversation trimmed to messages and folded tool trails, read through
// Paseo's SDK; the full Paseo page (commands, model switches, permissions) is one click away
function PaseoChat({ agent: initial, line, role, toast, onOpen }: { agent: Agent; line?: Line; role: AgentRole } & RoomActions) {
  const [agent, setAgent] = useState(initial);
  const [items, setItems] = useState<PaseoItem[] | null>(null);
  const [asks, setAsks] = useState<PaseoPermission[]>([]);
  const [full, setFull] = useState(false);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [sent, setSent] = useState<string[]>([]);
  const scroll = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const status = useRef(initial.status);
  const nudge = useRef(0);
  const r = ROLE[role];
  status.current = agent.status;

  // poll the timeline: every 2 s while it works or right after you wrote, else every 7 s
  useEffect(() => {
    let alive = true, t = 0;
    const tick = async () => {
      try {
        const d = await api.timeline(initial.id);
        if (!alive) return;
        setAgent(d.agent);
        setItems(d.items);
        setAsks(d.paseo?.permissions ?? []);
        setSent(xs => xs.filter(x => !d.items.some(i => i.kind === 'user' && i.text?.trim() === x)));
        setErr('');
      } catch (e) {
        if (alive) setErr((e as Error).message);
      }
      if (alive) t = window.setTimeout(tick, status.current === 'working' || Date.now() - nudge.current < 20000 ? 2000 : 7000);
    };
    tick();
    return () => { alive = false; clearTimeout(t); };
  }, [initial.id]);
  useEffect(() => listen(e => { if (e.type === 'agent' && e.agent?.id === initial.id) setAgent(e.agent); }), [initial.id]);

  useEffect(() => {
    const el = scroll.current;
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [items?.length, sent.length, full]);

  async function run(fn: () => Promise<unknown>) {
    try { await fn(); } catch (e) { toast((e as Error).message); }
  }
  function send() {
    const t = text.trim();
    if (!t) return;
    setText('');
    stick.current = true;
    nudge.current = Date.now();
    setSent(xs => [...xs, t]);
    run(() => api.say(agent.id, t));
  }

  const rows = useMemo(() => fold(items ?? [], i => i.kind === 'tool'), [items]);
  return (
    <>
      <section className="room-main chat-main paseo-main">
        <header className="chat-head">
          <div className="chat-who">
            <span className={`dot s-${agent.status}`} />
            <div><b>{r.name} · #{line?.seq ?? ''}</b><span className="muted small">{AGENT_STATUS[agent.status]} · {agent.model ?? 'Paseo'}</span></div>
          </div>
          <div className="btns">
            {agent.status === 'working' && <button className="btn" onClick={() => run(() => api.abort(agent.id))}>{tr('打断')}</button>}
            <button className="btn" disabled={!agent.web} title={agent.web ? tr('Paseo 自己的界面：命令、模型切换、权限审批') : tr('Paseo 的网页端没开')} onClick={() => setFull(f => !f)}>{full ? tr('精简视图') : tr('完整界面')}</button>
            <button className="btn" onClick={() => run(() => api.openInPaseo(agent.id))}>{tr('桌面端')}</button>
          </div>
        </header>
        {full && agent.web
          ? <FullPaseo src={agent.web} title={`Paseo · ${r.place}`} />
          : (
            <>
              <div className="transcript" ref={scroll} onScroll={e => {
                const el = e.currentTarget;
                stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
              }}>
                {err && <div className="note err">{err}</div>}
                {items && !items.length && !sent.length && <div className="room-empty small-empty"><p>{tr('还没有对话。')}</p></div>}
                {rows.map((x, i) => Array.isArray(x)
                  ? <Trail key={i} tools={x.map(t => ({ name: t.name ?? '', arg: t.arg, st: t.status === 'running' ? 'run' : t.status === 'completed' ? 'ok' : 'bad', note: t.error ?? undefined }))} />
                  : x.kind === 'user' ? <UserMsg key={i} text={x.text ?? ''} />
                    : x.kind === 'assistant' ? <div key={i} className="msg-a"><Text text={x.text ?? ''} /></div>
                      : <div key={i} className={`note${x.kind === 'error' ? ' err' : ''}`}>{x.text}</div>)}
                {sent.map((t, i) => <div key={`s${i}`} className="msg-u"><Text text={t} /><span className="meta">{tr('发送中')}</span></div>)}
                {asks.map(q => (
                  <div key={q.id} className="ask">
                    <p><b>{tr('它想')}{q.name === 'Bash' ? tr('运行命令') : tr('用 {0}', q.name)}</b>{q.title && q.title !== q.name ? ` · ${q.title}` : ''}</p>
                    {q.arg && <pre className="code">{q.arg}</pre>}
                    <div className="btns">
                      <button className="btn pri" onClick={() => { nudge.current = Date.now(); setAsks(xs => xs.filter(x => x.id !== q.id)); run(() => api.permit(agent.id, q.id, true)); }}>{tr('允许')}</button>
                      <button className="btn" onClick={() => { nudge.current = Date.now(); setAsks(xs => xs.filter(x => x.id !== q.id)); run(() => api.permit(agent.id, q.id, false)); }}>{tr('拒绝')}</button>
                    </div>
                  </div>
                ))}
                {agent.status === 'working' && !asks.length && <div className="thinking"><i /><i /><i /></div>}
              </div>
              <div className="chat-compose">
                <textarea value={text} rows={2} placeholder={agent.status === 'working' ? tr('它在忙，发出的消息会插进它手上的事') : tr('对{0}说点什么，Enter 发送', r.name)}
                  onChange={e => setText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
                <button className="btn pri" disabled={!text.trim()} onClick={send}>{tr('发送')}</button>
              </div>
            </>
          )}
      </section>
      <Aside agent={agent} role={role} line={line} onOpen={onOpen}>
        <div className="pnl-s">
          <h4>Paseo</h4>
          <p className="muted small">{tr('同一段对话也在 Paseo 的桌面端和手机上。权限审批在这里就能点；命令和模型切换在「完整界面」里。')}</p>
          <div className="btns"><button className="btn" onClick={() => run(() => api.brief(agent.id))}>{tr('发送项目简报')}</button></div>
          {agent.cwd && <p className="muted small path">{tr('目录：')}{agent.cwd}</p>}
        </div>
      </Aside>
    </>
  );
}

// a long message from you (a project brief, a pasted log) shows its first lines until opened
function UserMsg({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const lines = text.split('\n'), long = lines.length > 6 || text.length > 360;
  const shown = open || !long ? text : lines.slice(0, 4).join('\n').slice(0, 240).trimEnd() + '…';
  return (
    <div className={`msg-u${long ? ' long' : ''}`}>
      <Text text={shown} />
      {long && <button className="more" onClick={() => setOpen(o => !o)}>{open ? tr('收起') : tr('展开全部（{0} 行）', lines.length)}</button>}
    </div>
  );
}

// Paseo's own page for the agent. Its app takes a few seconds to boot and shows its home
// before it jumps to the agent, so a veil covers it until then.
function FullPaseo({ src, title }: { src: string; title: string }) {
  const [ready, setReady] = useState(false);
  return (
    <div className="paseo-wrap">
      <iframe className="paseo-frame" src={src} title={title} allow="clipboard-read; clipboard-write; microphone"
        onLoad={() => window.setTimeout(() => setReady(true), 7000)} />
      <div className={`paseo-veil${ready ? ' gone' : ''}`}><span className="thinking"><i /><i /><i /></span><p>{tr('正在打开 Paseo 的界面…')}</p></div>
    </div>
  );
}

// consecutive entries that match `is` come out as one array, the rest one by one
function fold<T>(list: T[], is: (x: T) => boolean): (T | T[])[] {
  const out: (T | T[])[] = [];
  for (const x of list) {
    const last = out[out.length - 1];
    if (is(x) && Array.isArray(last)) last.push(x);
    else out.push(is(x) ? [x] : x);
  }
  return out;
}

// a run of tool calls as one quiet line; opens to the list
function Trail({ tools, children }: { tools: { name: string; arg?: string; st: 'run' | 'ok' | 'bad'; note?: string }[]; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const last = tools[tools.length - 1], bad = tools.filter(t => t.st === 'bad').length, busy = tools.some(t => t.st === 'run');
  return (
    <div className={`trail${open ? ' open' : ''}${busy ? ' t-run' : bad ? ' t-bad' : ''}`}>
      <button onClick={() => setOpen(o => !o)}>
        <span className="t-ic">{busy ? '…' : bad ? '!' : '✓'}</span>
        <b>{tools.length > 1 ? tr('{0} 个工具', tools.length) : last.name}</b>
        <span className="t-arg">{tools.length > 1 ? `${last.name} ${last.arg ?? ''}` : last.arg}</span>
        {bad > 0 && <em>{bad} {tr('个出错')}</em>}
      </button>
      {open && (children ?? <ul>{tools.map((t, i) => <li key={i} className={`t-${t.st}`}><b>{t.name}</b><span>{t.arg}</span>{t.note && <em>{t.note}</em>}</li>)}</ul>)}
    </div>
  );
}

function AgentChat({ agent: initial, line, role, toast, onOpen }: { agent: Agent; line?: Line; role: AgentRole } & RoomActions) {
  const [agent, setAgent] = useState(initial);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [live, setLive] = useState('');
  const [text, setText] = useState('');
  const scroll = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const r = ROLE[role];

  useEffect(() => {
    let alive = true;
    api.agent(initial.id).then(d => { if (alive) { setAgent(d.agent); setEvents(d.events); } }).catch(() => {});
    return () => { alive = false; };
  }, [initial.id]);

  useEffect(() => listen(e => {
    if (e.type === 'agent' && e.agent?.id === agent.id) setAgent(e.agent);
    else if (e.type === 'agent_event' && e.event.agent_id === agent.id) {
      setEvents(list => list.some(x => x.id === e.event.id) ? list.map(x => x.id === e.event.id ? e.event : x) : [...list, e.event]);
      if (e.event.kind === 'assistant') setLive('');
    } else if (e.type === 'agent_delta' && e.agent_id === agent.id) setLive(t => t + e.text);
  }), [agent.id]);

  // pair each tool call with its result
  const items = useMemo(() => {
    const ends = new Map(events.filter(e => e.kind === 'tool_end').map(e => [e.data.id, e]));
    return events.filter(e => e.kind !== 'tool_end').map(ev => ({ ev, end: ev.kind === 'tool' ? ends.get(ev.data.id) : undefined }) as Item);
  }, [events]);
  const rows = useMemo(() => fold(items, x => x.ev.kind === 'tool'), [items]);

  useEffect(() => {
    const el = scroll.current;
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [items.length, live]);

  async function run(fn: () => Promise<unknown>) {
    try { await fn(); } catch (e) { toast((e as Error).message); }
  }

  function send() {
    const t = text.trim();
    if (!t) return;
    setText('');
    stick.current = true;
    run(() => api.say(agent.id, t));
  }

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
            <span className={`dot s-${agent.status}`} />
            <div><b>{r.name} · #{line?.seq ?? ''}</b><span className="muted small">{AGENT_STATUS[agent.status]}{!st && agent.model ? ` · ${agent.model}` : ''}{agent.cost ? ` · $${agent.cost.toFixed(3)}` : ''}</span></div>
          </div>
          {st && on && <PiSwitch s={st} send={t => run(() => api.say(agent.id, t))} />}
          <div className="btns">
            {agent.status === 'working' && <button className="btn" onClick={() => run(() => api.abort(agent.id))}>{tr('打断')}</button>}
            <button className="btn" onClick={() => run(() => api.brief(agent.id))}>{tr('发送项目简报')}</button>
            {on ? <button className="btn" onClick={() => run(() => api.stopAgent(agent.id))}>{tr('停止')}</button>
              : <button className="btn pri" onClick={() => run(() => api.startAgent(agent.id))}>{tr('启动')}</button>}
          </div>
        </header>
        <div className="transcript" ref={scroll} onScroll={e => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}>
          {!items.length && !live && <div className="room-empty small-empty"><p>{tr('还没有对话。可以先「发送项目简报」，让它读一遍项目再开始。')}</p></div>}
          {rows.map(x => Array.isArray(x)
            ? <Trail key={x[0].ev.id} tools={x.map(({ ev, end }) => ({ name: ev.data.name, arg: toolArg(ev.data.args), st: !end ? 'run' : end.data.error ? 'bad' : 'ok' }))}>
                <div className="trail-list">{x.map(t => <Tool key={t.ev.id} {...t} />)}</div>
              </Trail>
            : <Entry key={x.ev.id} ev={x.ev} end={x.end} />)}
          {live && <div className="msg-a streaming"><Text text={live} /><i className="caret" /></div>}
          {agent.status === 'working' && !live && <div className="thinking"><i /><i /><i /></div>}
        </div>
        <div className="chat-compose">
          {menu.length > 0 && (
            <div className="cmd-menu" role="listbox">
              {menu.map(([n, d, tui]) => (
                <button key={n} onMouseDown={e => { e.preventDefault(); setText(`/${n} `); }}>
                  <code>/{n}</code><span>{d}</span>{tui && <em>{tr('终端')}</em>}
                </button>
              ))}
            </div>
          )}
          <textarea value={text} rows={2} placeholder={agent.status === 'working' ? tr('它在忙，发出的消息会排在它手上的事之后') : tr('对{0}说点什么，输入 / 用 pi 的命令，Enter 发送', r.name)}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Tab' && menu.length) { e.preventDefault(); setText(`/${menu[0][0]} `); return; }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
            }} />
          <button className="btn pri" disabled={!text.trim()} onClick={send}>{tr('发送')}</button>
        </div>
      </section>
      <Aside agent={agent} role={role} line={line} onOpen={onOpen}>
        <div className="pnl-s">
          <h4>{tr('终端')}</h4>
          <p className="muted small">{tr('pi 在后台的 tmux 里运行，接上就能看到同一段对话，在那里输入也会同步到这里。')}</p>
          {agent.attach && <div className="copy"><code>{agent.attach}</code><button className="btn" onClick={() => {
            navigator.clipboard?.writeText(agent.attach!).then(() => toast(tr('已复制')), () => toast(agent.attach!));
          }}>{tr('复制')}</button></div>}
          {agent.cwd && <p className="muted small path">{tr('目录：')}{agent.cwd}</p>}
          {st?.session && <p className="muted small path">{tr('会话：')}{st.session.name ?? st.session.id}</p>}
        </div>
      </Aside>
    </>
  );
}

function Entry({ ev, end }: Item) {
  const d = ev.data ?? {};
  if (ev.kind === 'user' && d.cmd) {
    return <div className="msg-u cmd"><code>{d.text}</code><span className="meta">{tr('命令')}{d.delivered ? '' : tr(' · 发送中')}</span></div>;
  }
  if (ev.kind === 'user') {
    return (
      <div className="msg-u">
        <Text text={d.text} />
        <span className="meta">{d.origin === 'terminal' ? tr('终端') : tr('网页')}{d.origin === 'web' ? (d.delivered ? (d.queued ? tr(' · 已排队') : tr(' · 已送达')) : tr(' · 发送中')) : ''}</span>
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

function Tool({ ev, end }: Item) {
  const [open, setOpen] = useState(false);
  const d = ev.data, arg = toolArg(d.args);
  const st = !end ? 'run' : end.data.error ? 'bad' : 'ok';
  return (
    <div className={`tool t-${st}`}>
      <button onClick={() => setOpen(o => !o)}>
        <span className="t-ic">{st === 'run' ? '…' : st === 'ok' ? '✓' : '✕'}</span>
        <b>{d.name}</b><span className="t-arg">{String(arg).slice(0, 140)}</span>
        {end?.data.ms != null && <span className="muted small">{end.data.ms < 1000 ? `${end.data.ms}ms` : `${(end.data.ms / 1000).toFixed(1)}s`}</span>}
      </button>
      {open && end?.data.result && <pre className="code">{end.data.result}</pre>}
    </div>
  );
}

// pi's model and thinking level; changing them sends /model and /thinking
function PiSwitch({ s, send }: { s: PiState; send: (t: string) => void }) {
  const cur = s.model ? `${s.model.provider}/${s.model.id}` : '';
  const groups = new Map<string, NonNullable<PiState['models']>>();
  for (const m of s.models ?? []) groups.set(m.provider, [...(groups.get(m.provider) ?? []), m]);
  return (
    <div className="pi-switch">
      <select value={cur} title={tr('模型（/model）')} onChange={e => send(`/model ${e.target.value}`)}>
        {cur && !(s.models ?? []).some(m => `${m.provider}/${m.id}` === cur) && <option value={cur}>{cur}</option>}
        {[...groups].map(([p, ms]) => (
          <optgroup key={p} label={s.providers?.[p] ?? p}>
            {ms.map(m => <option key={m.id} value={`${p}/${m.id}`}>{m.name}</option>)}
          </optgroup>
        ))}
      </select>
      {s.levels.length > 1 && (
        <select value={s.thinking} title={tr('思考强度（/thinking）')} onChange={e => send(`/thinking ${e.target.value}`)}>
          {s.levels.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
      )}
      {s.context?.percent != null && <span className="muted small" title={tr('上下文用量')}>{tr('上下文')} {Math.round(s.context.percent)}%</span>}
    </div>
  );
}

// plain text with ``` fences shown as code
function Text({ text }: { text: string }) {
  const parts = String(text ?? '').split(/```[a-zA-Z0-9_-]*\n?/);
  return <>{parts.map((t, i) => i % 2 ? <pre key={i} className="code">{t.replace(/\n$/, '')}</pre> : t.trim() && <p key={i}>{t.trim()}</p>)}</>;
}
