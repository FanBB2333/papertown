// The press and the depot: one coding agent per project, in one of two places.
// - Paseo: any provider Paseo hosts (Claude Code, Codex, OpenCode, Pi, ...). The room embeds
//   Paseo's own page for the agent, so its commands, model switches and permission prompts
//   are all there.
// - pi in a background tmux terminal: the conversation here is the same one running in the
//   terminal, both ways and live. Its model and thinking level can be switched here, and
//   pi's slash commands typed here run in pi (the ones that need its terminal UI open there).

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, fileUrl, listen, type Agent, type AgentEvent, type AgentRole, type Job, type Line, type PaseoInfo, type PiState, type Roster, type StartOpts } from '../api';
import { AGENT_STATUS, STATUS } from './MillRoom';
import type { RoomActions } from './Interior';

interface Props extends RoomActions {
  role: AgentRole;
  focus: string | null;
  lines: Line[];
  tick: number;
}

const ROLE = {
  coder: { name: '代码员工', place: '仓库', job: '写代码、跑测试，再把实验提交到实验农场' },
  writer: { name: '写作员工', place: '印刷厂', job: '读实验结果，在 main.tex 里写论文并编译' },
  monitor: { name: '看田员', place: '实验农场', job: '' },
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
        <h2>还没有项目</h2>
        <p>项目在造纸厂立项后，{r.place}会为它配一个{r.name}。</p>
        <button className="btn pri" onClick={p.onIdea}>放入一颗新 idea</button>
      </div>
    );
  }

  return (
    <div className="room room-agents">
      <aside className="room-side">
        <h4 className="side-h">{r.name} <span className="muted small">每个项目一个，{r.job}</span></h4>
        {rows.map(({ line, agent }, i) => (
          <button key={line.id} className={`mon${cur?.line.id === line.id ? ' on' : ''}`} style={{ ['--i' as string]: i }} onClick={() => setSel(line.id)}>
            <div className="proj-top"><b>#{line.seq} {line.title}</b><span className={`dot s-${agent?.status ?? 'none'}`} title={agent ? AGENT_STATUS[agent.status] : '未创建'} /></div>
            <p className="mon-note">{agent?.last ? lastLine(agent.last) : agent ? '还没有对话。' : '还没有配员工。'}</p>
            <span className="muted small">{STATUS[line.status] ?? line.status}{agent ? ` · ${AGENT_STATUS[agent.status]}` : ''}</span>
          </button>
        ))}
        {roster && !roster.available.ok && <p className="warn-box small">{roster.available.note}，没法启动 pi。装好后重启服务即可。</p>}
      </aside>
      {cur && (cur.agent?.started
        ? <AgentChat key={cur.agent.id} {...p} agent={cur.agent} line={p.lines.find(l => l.id === cur.line.id)} />
        : <Hire key={cur.line.id} line={cur.line} role={p.role} agent={cur.agent} ok={!!roster?.available.ok} toast={p.toast} onDone={() => setBump(b => b + 1)} />)}
    </div>
  );
}

function lastLine(e: AgentEvent): string {
  const t = String(e.data?.text ?? '').trim().split('\n').find(Boolean) ?? '';
  return (e.kind === 'user' ? '你：' : '') + (t.length > 60 ? t.slice(0, 60) + '…' : t);
}

function Hire({ line, role, agent, ok, toast, onDone }: {
  line: { id: string; seq: number; title: string }; role: AgentRole; agent: Agent | null; ok: boolean; toast: (t: string) => void; onDone: () => void;
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
    }).catch(e => setInfo({ status: { ok: false, note: `连不上 Paseo：${(e as Error).message}` }, providers: [] }));
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
        <h2>#{line.seq} 还没有{r.name}</h2>
        <p className="muted">选一种运行方式。工作目录都是这个项目在{r.place}的目录，启动时会先把项目简报发给它。</p>
        <div className="hire-opts">
          <div className="hire-card">
            <h3>Paseo <span className="chip">推荐</span></h3>
            <p className="muted small">Claude Code、Codex、OpenCode、Pi 等都可以。对话用的是 Paseo 自己的界面，命令、模型切换和权限审批都照旧。</p>
            {!info ? <p className="muted small">正在连本机的 Paseo…</p> : !info.status.ok ? <p className="warn-box small">{info.status.note}</p> : (
              <>
                <label className="field">供应商
                  <select value={prov} onChange={e => pick(info, e.target.value)}>
                    {info.providers.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
                  </select>
                </label>
                {!!pv?.models.length && (
                  <label className="field">模型
                    <select value={model} onChange={e => pick(info, prov, e.target.value)}>
                      {pv.models.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                  </label>
                )}
                {!!m && m.thinking.length > 1 && (
                  <label className="field">思考强度
                    <select value={think} onChange={e => setThink(e.target.value)}>
                      {m.thinking.map(x => <option key={x} value={x}>{x}</option>)}
                    </select>
                  </label>
                )}
                {!info.status.web && <p className="muted small">Paseo 的网页端没开，房间里显示不了对话，可以去 Paseo 桌面端看。打开方法：<code>paseo daemon config set features.webUi.enabled true</code>，再 <code>paseo daemon restart</code>。</p>}
                <button className="btn pri" disabled={busy || !prov} onClick={() => go({ runtime: 'paseo', provider: prov, model: model || undefined, thinking: think || undefined })}>
                  {busy ? '启动中…' : '在 Paseo 里启动'}
                </button>
              </>
            )}
          </div>
          <div className="hire-card">
            <h3>pi · 后台终端</h3>
            <p className="muted small">本机的 pi 跑在 tmux 里，终端和这里的对话实时同步。这里能切换模型和思考强度，输入 / 可以用 pi 的命令。它用 pi 自己的模型设置和登录。</p>
            <button className="btn" disabled={!ok || busy} onClick={() => go({ runtime: 'pi' })}>{busy ? '启动中…' : '启动 pi'}</button>
            {!ok && <p className="muted small">本机没有 pi 或 tmux。</p>}
          </div>
        </div>
      </div>
    </section>
  );
}

// pi's slash commands: [name, what it does, needs pi's terminal UI]
const PI_COMMANDS: [string, string, boolean?][] = [
  ['model', '切换模型：/model 供应商/模型'], ['thinking', '思考强度：/thinking high'], ['compact', '压缩上下文，可以附一句要求'],
  ['new', '开始新会话'], ['clone', '复制当前会话，在副本里继续'], ['name', '给会话起名'], ['session', '会话信息：消息数、token 和花费'],
  ['reload', '重新加载扩展、skills、提示模板和上下文文件'], ['copy', '把最后一条回复复制到剪贴板', true],
  ['export', '导出会话（HTML 或 .jsonl）', true], ['fork', '从某条消息分叉出新会话', true], ['tree', '在会话树里跳转', true],
  ['resume', '恢复别的会话', true], ['settings', '设置', true], ['scoped-models', 'Ctrl+P 循环的模型', true],
  ['login', '登录供应商', true], ['logout', '退出登录', true], ['hotkeys', '快捷键', true], ['changelog', '更新日志', true],
  ['share', '分享会话', true], ['import', '导入 .jsonl 会话', true], ['trust', '项目信任设置', true], ['quit', '停止 pi'],
];

type Item = { ev: AgentEvent; end?: AgentEvent };

function AgentChat({ agent: initial, line, role, toast, onOpen }: { agent: Agent; line?: Line; role: AgentRole } & RoomActions) {
  const [agent, setAgent] = useState(initial);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [live, setLive] = useState('');
  const [text, setText] = useState('');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [repos, setRepos] = useState<any[]>([]);
  const scroll = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const r = ROLE[role];

  useEffect(() => {
    let alive = true;
    api.agent(initial.id).then(d => { if (alive) { setAgent(d.agent); setEvents(d.events); } }).catch(() => {});
    if (role === 'coder') {
      api.jobs(initial.line_id).then(b => alive && setJobs(b.jobs)).catch(() => {});
      api.building('depot').then(s => alive && setRepos(s.repos ?? [])).catch(() => {});
    }
    return () => { alive = false; };
  }, [initial.id, initial.line_id, role]);

  useEffect(() => listen(e => {
    if (e.type === 'agent' && e.agent?.id === agent.id) setAgent(e.agent);
    else if (e.type === 'agent_event' && e.event.agent_id === agent.id) {
      setEvents(list => list.some(x => x.id === e.event.id) ? list.map(x => x.id === e.event.id ? e.event : x) : [...list, e.event]);
      if (e.event.kind === 'assistant') setLive('');
    } else if (e.type === 'agent_delta' && e.agent_id === agent.id) setLive(t => t + e.text);
    else if (e.type === 'job' && e.job.line_id === agent.line_id && role === 'coder') {
      setJobs(js => js.some(j => j.id === e.job.id) ? js.map(j => j.id === e.job.id ? e.job : j) : [e.job, ...js]);
    }
  }), [agent.id, agent.line_id, role]);

  // pair each tool call with its result
  const items = useMemo(() => {
    const ends = new Map(events.filter(e => e.kind === 'tool_end').map(e => [e.data.id, e]));
    return events.filter(e => e.kind !== 'tool_end').map(ev => ({ ev, end: ev.kind === 'tool' ? ends.get(ev.data.id) : undefined }) as Item);
  }, [events]);

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
  const files = line?.files ?? [];
  const pt = role === 'coder' ? '.papertown/pt submit' : '';

  const aside = (head: React.ReactNode) => (
    <aside className="room-aside">
      {head}
      {role === 'coder' && (
        <div className="pnl-s">
          <h4>提交到农场的实验</h4>
          {!jobs.length && <p className="muted small">还没有。{agent.runtime === 'paseo' ? `它会用 ${pt} 提交。` : 'pi 会用 papertown_submit_job 提交。'}</p>}
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
          <h4>参考仓库 <span className="chip">示例数据</span></h4>
          <p className="muted small">文档进了检索库，方法设计时从这里找 baseline 和指标。</p>
          {repos.map(x => <div key={x.id} className="repo"><b>{x.label}</b><span className="muted small">{x.desc}</span></div>)}
        </div>
      )}
      {role === 'writer' && (
        <div className="pnl-s">
          <h4>稿子</h4>
          {!files.length && <p className="muted small">印刷厂目录里还没有文件。</p>}
          <div className="btns">{files.map(f => <a key={f} className={`btn${f === 'main.pdf' ? ' pri' : ''}`} href={fileUrl(agent.line_id, f)} target="_blank" rel="noreferrer">{f}</a>)}</div>
        </div>
      )}
    </aside>
  );

  if (agent.runtime === 'paseo') {
    return (
      <>
        <section className="room-main chat-main paseo-main">
          <header className="chat-head">
            <div className="chat-who">
              <span className={`dot s-${agent.status}`} />
              <div><b>{r.name} · #{line?.seq ?? ''}</b><span className="muted small">Paseo · {AGENT_STATUS[agent.status]}{agent.model ? ` · ${agent.model}` : ''}</span></div>
            </div>
            <div className="btns">
              {agent.status === 'working' && <button className="btn" onClick={() => run(() => api.abort(agent.id))}>打断</button>}
              <button className="btn" onClick={() => run(() => api.brief(agent.id))}>发送项目简报</button>
              <button className="btn" onClick={() => run(() => api.openInPaseo(agent.id))}>在 Paseo 桌面端打开</button>
              {agent.web && <a className="btn" href={agent.web} target="_blank" rel="noreferrer">新窗口</a>}
            </div>
          </header>
          {agent.web
            ? <iframe className="paseo-frame" src={agent.web} title={`Paseo · ${r.place}`} allow="clipboard-read; clipboard-write; microphone" />
            : (
              <div className="room-empty">
                <h2>Paseo 的网页端没开</h2>
                <p>打开后对话会直接显示在这里：<code>paseo daemon config set features.webUi.enabled true</code>，再 <code>paseo daemon restart</code>。现在可以先在桌面端里看。</p>
                <button className="btn pri" onClick={() => run(() => api.openInPaseo(agent.id))}>在 Paseo 桌面端打开</button>
              </div>
            )}
        </section>
        {aside(
          <div className="pnl-s">
            <h4>Paseo</h4>
            <p className="muted small">对话、命令、模型切换和权限审批都在 Paseo 的界面里；手机上的 Paseo 也能看到同一个 agent。它用 <code>.papertown/pt</code> 读项目简报、提交实验。</p>
            {agent.ext_id && <p className="muted small path">agent：{agent.ext_id}</p>}
            {agent.cwd && <p className="muted small path">目录：{agent.cwd}</p>}
          </div>,
        )}
      </>
    );
  }

  const st = agent.state;
  const word = text.startsWith('/') && !/\s/.test(text) ? text.slice(1).toLowerCase() : null;
  const extra = (st?.commands ?? []).map(c => [c.name, c.description || ({ extension: '扩展命令', prompt: '提示模板', skill: 'skill' } as Record<string, string>)[c.source] || c.source] as [string, string]);
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
            {agent.status === 'working' && <button className="btn" onClick={() => run(() => api.abort(agent.id))}>打断</button>}
            <button className="btn" onClick={() => run(() => api.brief(agent.id))}>发送项目简报</button>
            {on ? <button className="btn" onClick={() => run(() => api.stopAgent(agent.id))}>停止</button>
              : <button className="btn pri" onClick={() => run(() => api.startAgent(agent.id))}>启动</button>}
          </div>
        </header>
        <div className="transcript" ref={scroll} onScroll={e => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}>
          {!items.length && !live && <div className="room-empty small-empty"><p>还没有对话。可以先「发送项目简报」，让它读一遍项目再开始。</p></div>}
          {items.map(({ ev, end }) => <Entry key={ev.id} ev={ev} end={end} />)}
          {live && <div className="msg-a streaming"><Text text={live} /><i className="caret" /></div>}
          {agent.status === 'working' && !live && <div className="thinking"><i /><i /><i /></div>}
        </div>
        <div className="chat-compose">
          {menu.length > 0 && (
            <div className="cmd-menu" role="listbox">
              {menu.map(([n, d, tui]) => (
                <button key={n} onMouseDown={e => { e.preventDefault(); setText(`/${n} `); }}>
                  <code>/{n}</code><span>{d}</span>{tui && <em>终端</em>}
                </button>
              ))}
            </div>
          )}
          <textarea value={text} rows={2} placeholder={agent.status === 'working' ? '它在忙，发出的消息会排在它手上的事之后' : `对${r.name}说点什么，输入 / 用 pi 的命令，Enter 发送`}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Tab' && menu.length) { e.preventDefault(); setText(`/${menu[0][0]} `); return; }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
            }} />
          <button className="btn pri" disabled={!text.trim()} onClick={send}>发送</button>
        </div>
      </section>
      {aside(
        <div className="pnl-s">
          <h4>终端</h4>
          <p className="muted small">pi 在后台的 tmux 里运行，接上就能看到同一段对话，在那里输入也会同步到这里。</p>
          {agent.attach && <div className="copy"><code>{agent.attach}</code><button className="btn" onClick={() => {
            navigator.clipboard?.writeText(agent.attach!).then(() => toast('已复制'), () => toast(agent.attach!));
          }}>复制</button></div>}
          {agent.cwd && <p className="muted small path">目录：{agent.cwd}</p>}
          {st?.session && <p className="muted small path">会话：{st.session.name ?? st.session.id}</p>}
        </div>,
      )}
    </>
  );
}

function Entry({ ev, end }: Item) {
  const d = ev.data ?? {};
  if (ev.kind === 'user' && d.cmd) {
    return <div className="msg-u cmd"><code>{d.text}</code><span className="meta">命令{d.delivered ? '' : ' · 发送中'}</span></div>;
  }
  if (ev.kind === 'user') {
    return (
      <div className="msg-u">
        <Text text={d.text} />
        <span className="meta">{d.origin === 'terminal' ? '终端' : '网页'}{d.origin === 'web' ? (d.delivered ? (d.queued ? ' · 已排队' : ' · 已送达') : ' · 发送中') : ''}</span>
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

function Tool({ ev, end }: Item) {
  const [open, setOpen] = useState(false);
  const d = ev.data, a = d.args ?? {};
  const arg = a.command ?? a.path ?? a.file_path ?? a.name ?? a.query ?? (Object.keys(a).length ? JSON.stringify(a) : '');
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
      <select value={cur} title="模型（/model）" onChange={e => send(`/model ${e.target.value}`)}>
        {cur && !(s.models ?? []).some(m => `${m.provider}/${m.id}` === cur) && <option value={cur}>{cur}</option>}
        {[...groups].map(([p, ms]) => (
          <optgroup key={p} label={s.providers?.[p] ?? p}>
            {ms.map(m => <option key={m.id} value={`${p}/${m.id}`}>{m.name}</option>)}
          </optgroup>
        ))}
      </select>
      {s.levels.length > 1 && (
        <select value={s.thinking} title="思考强度（/thinking）" onChange={e => send(`/thinking ${e.target.value}`)}>
          {s.levels.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
      )}
      {s.context?.percent != null && <span className="muted small" title="上下文用量">上下文 {Math.round(s.context.percent)}%</span>}
    </div>
  );
}

// plain text with ``` fences shown as code
function Text({ text }: { text: string }) {
  const parts = String(text ?? '').split(/```[a-zA-Z0-9_-]*\n?/);
  return <>{parts.map((t, i) => i % 2 ? <pre key={i} className="code">{t.replace(/\n$/, '')}</pre> : t.trim() && <p key={i}>{t.trim()}</p>)}</>;
}
