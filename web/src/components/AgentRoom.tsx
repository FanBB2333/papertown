// The press and the depot: one pi agent per project. The conversation here is the same
// one running in the agent's terminal (tmux), both ways and live: what you type here is
// injected into pi, what you type in the terminal shows up here.

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, fileUrl, listen, type Agent, type AgentEvent, type AgentRole, type Job, type Line, type Roster } from '../api';
import { AGENT_STATUS, STATUS } from './MillRoom';
import type { RoomActions } from './Interior';

interface Props extends RoomActions {
  role: AgentRole;
  focus: string | null;
  lines: Line[];
  tick: number;
}

const ROLE = {
  coder: { name: '代码 pi', place: '仓库', job: '写代码、跑测试，再把实验提交到实验农场' },
  writer: { name: '写作 pi', place: '印刷厂', job: '读实验结果，在 main.tex 里写论文并编译' },
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
      {cur && (cur.agent
        ? <AgentChat key={cur.agent.id} {...p} agent={cur.agent} line={p.lines.find(l => l.id === cur.line.id)} />
        : <Hire line={cur.line} role={p.role} ok={!!roster?.available.ok} toast={p.toast} onDone={() => setBump(b => b + 1)} />)}
    </div>
  );
}

function lastLine(e: AgentEvent): string {
  const t = String(e.data?.text ?? '').trim().split('\n').find(Boolean) ?? '';
  return (e.kind === 'user' ? '你：' : '') + (t.length > 60 ? t.slice(0, 60) + '…' : t);
}

function Hire({ line, role, ok, toast, onDone }: { line: { id: string; seq: number; title: string }; role: AgentRole; ok: boolean; toast: (t: string) => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const r = ROLE[role];
  async function go() {
    setBusy(true);
    try {
      const a = await api.openAgent(line.id, role);
      await api.startAgent(a.id);
      onDone();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="room-main hire">
      <div className="room-empty">
        <h2>#{line.seq} 还没有{r.name}</h2>
        <p>启动后，pi 会在后台的 tmux 终端里运行，工作目录是这个项目在{r.place}的目录。它用你本机 pi 的模型设置和登录。</p>
        <button className="btn pri" disabled={!ok || busy} onClick={go}>{busy ? '启动中…' : `启动${r.name}`}</button>
      </div>
    </section>
  );
}

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

  return (
    <>
      <section className="room-main chat-main">
        <header className="chat-head">
          <div className="chat-who">
            <span className={`dot s-${agent.status}`} />
            <div><b>{r.name} · #{line?.seq ?? ''}</b><span className="muted small">{AGENT_STATUS[agent.status]}{agent.model ? ` · ${agent.model}` : ''}{agent.cost ? ` · $${agent.cost.toFixed(3)}` : ''}</span></div>
          </div>
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
          <textarea value={text} rows={2} placeholder={agent.status === 'working' ? '它在忙，发出的消息会排在它手上的事之后' : `对${r.name}说点什么，Enter 发送，Shift+Enter 换行`}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
          <button className="btn pri" disabled={!text.trim()} onClick={send}>发送</button>
        </div>
      </section>
      <aside className="room-aside">
        <div className="pnl-s">
          <h4>终端</h4>
          <p className="muted small">pi 在后台的 tmux 里运行，接上就能看到同一段对话，在那里输入也会同步到这里。</p>
          {agent.attach && <div className="copy"><code>{agent.attach}</code><button className="btn" onClick={() => {
            navigator.clipboard?.writeText(agent.attach!).then(() => toast('已复制'), () => toast(agent.attach!));
          }}>复制</button></div>}
          {agent.cwd && <p className="muted small path">目录：{agent.cwd}</p>}
        </div>
        {role === 'coder' && (
          <div className="pnl-s">
            <h4>提交到农场的实验</h4>
            {!jobs.length && <p className="muted small">还没有。pi 会用 papertown_submit_job 提交。</p>}
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
    </>
  );
}

function Entry({ ev, end }: Item) {
  const d = ev.data ?? {};
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

// plain text with ``` fences shown as code
function Text({ text }: { text: string }) {
  const parts = String(text ?? '').split(/```[a-zA-Z0-9_-]*\n?/);
  return <>{parts.map((t, i) => i % 2 ? <pre key={i} className="code">{t.replace(/\n$/, '')}</pre> : t.trim() && <p key={i}>{t.trim()}</p>)}</>;
}
