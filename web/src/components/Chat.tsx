// The chat (B): a box at the bottom of every page for telling the town's workers what to do.
// Closed it is one line to write in, with a light for every department at work. Open, it grows
// upward into the conversation with whoever you write to: the town (a new idea goes to the
// hatchery), a department (its worker answers), or a project's coding or writing agent, which
// takes what you send into the work in hand (steer) or after it (queue). Along its top run all
// the departments and what each is doing; the line and the trace are a tab away.

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, fileUrl, listen, type Agent, type AgentEvent, type Department, type DeptAgent, type Line, type Llm, type Message, type Placement, type SayMode, type TraceRow } from '../api';
import { Ava, Item, ROLE_NAMES } from '../art';
import { Icon } from '../console/icons';
import { tr } from '../i18n';
import { Entry, fold, paseoTool, piTool, Text, Tool, Trail, UserMsg, usePaseoTalk, usePiTalk } from './AgentRoom';
import { AGENT_STATUS, STATUS } from './MillRoom';
import '../dock.css';

export type Composer = { kind: 'idea' } | { kind: 'ask'; building: string; name: string } | { kind: 'adjust'; lineId: string }
  | { kind: 'agent'; agentId: string; name: string };
export type Tab = 'chat' | 'line' | 'trace';

interface Props {
  view: string;
  open: boolean;
  setOpen: (open: boolean) => void;
  away: boolean; // in a room or on the 3D walk, where it shows only while open
  tab: Tab;
  onTab: (t: Tab) => void;
  messages: Message[];
  trace: TraceRow[];
  lines: Line[];
  placements: Placement[];
  composer: Composer;
  setComposer: (c: Composer) => void;
  focusKey: number;
  busy: boolean;
  tick: number;
  onSend: (text: string, budget: number) => Promise<void>;
  onHatch: (lineId: string) => void;
  onResume: (lineId: string) => void;
  onRoom: (id: string, lineId?: string | null) => void;
  toast: (text: string) => void;
}

const BUDGETS = [0.5, 1, 2];
const MODE = 'pt-say-mode';

export function traceRow(t: TraceRow) {
  return (
    <div className="tr" key={t.id} title={t.ts}>
      <span className={`k k-${t.kind.toLowerCase()}`}>{t.kind}</span><code>{t.label}</code><em>{t.detail}</em>
    </div>
  );
}

function Who({ m, placements }: { m: Message; placements: Placement[] }) {
  const w = m.worker;
  const at = placements.find(p => p.id === (m.body?.from ?? ''));
  if (!w) return <div className="who"><b>Papertown</b>{m.kind === 'error' && <span className="chip bad">{tr('出错')}</span>}</div>;
  return (
    <div className="who">
      <Ava role={w.role} level={w.level} code={w.id} />
      <b>{ROLE_NAMES[w.role]} {w.id}</b>
      {m.kind === 'report' ? <span className="chip ok">{tr('撞车报告')}</span> : at ? <span className="chip">{at.name}</span> : null}
    </div>
  );
}

const VERDICT_CHIP: Record<string, string> = { 可孵化: 'ok', 需调整: 'warn', 已被做过: 'bad' };

function Report({ m, line, onHatch, onAdjust }: { m: Message; line?: Line; onHatch: () => void; onAdjust: () => void }) {
  const r = m.body.report ?? {};
  const waiting = line?.status === 'waiting' && line.verdict === r.verdict;
  return (
    <>
      <p>{tr('检索了图书馆')} {tr('{0} 篇、arXiv', r.sources?.library ?? 0)} {tr('{0} 篇，最接近的工作：', r.sources?.arxiv ?? 0)}</p>
      {r.similar?.length ? (
        <ul className="sim">
          {r.similar.map((x: any) => (
            <li key={x.paper_id} title={x.note}>
              <a href={x.url} target="_blank" rel="noreferrer">{x.title}</a>
              <i style={{ ['--v' as any]: x.similarity }} /><b>{Number(x.similarity).toFixed(2)}</b>
            </li>
          ))}
        </ul>
      ) : <p className="muted">{tr('没有检索到相近的工作。')}</p>}
      <p className="verdict"><span className={`chip ${VERDICT_CHIP[r.verdict] ?? ''}`}>{r.verdict}</span>{r.gap}</p>
      {r.suggestions?.length > 0 && <ul className="sugg">{r.suggestions.map((s: string) => <li key={s}>{s}</li>)}</ul>}
      {waiting && (
        <div className="btns">
          <button className="btn pri" onClick={onHatch}>{tr('孵化并立项')}</button>
          <button className="btn" onClick={onAdjust}>{tr('调整 idea')}</button>
        </div>
      )}
      <div className="cost">
        {m.body.steps} {tr('步 · $')}{Number(m.body.cost ?? 0).toFixed(4)} {tr('· skills：')}{(m.body.skills ?? []).join(', ') || '—'} {tr('· 检索方式')} {r.sources?.method}
        {m.body.degraded && <> · <span className="warn-t">{m.body.degraded}</span></>}
        {r.verdict_note && <> · {r.verdict_note}</>}
      </div>
    </>
  );
}

function Bubble({ m, lines, placements, onHatch, onAdjust, onRoom }: {
  m: Message; lines: Line[]; placements: Placement[]; onHatch: (id: string) => void; onAdjust: (id: string) => void; onRoom: (id: string) => void;
}) {
  if (m.role === 'user') return <div className="msg mine">{m.body.to ? `@${placements.find(p => p.id === m.body.to)?.name ?? m.body.to} ` : ''}{m.body.text}</div>;
  const line = lines.find(l => l.id === m.line_id);
  return (
    <div className={`msg bot${m.kind === 'error' ? ' err' : ''}`}>
      <Who m={m} placements={placements} />
      {m.kind === 'report'
        ? <Report m={m} line={line} onHatch={() => onHatch(m.line_id!)} onAdjust={() => onAdjust(m.line_id!)} />
        : <p>{m.body.text}</p>}
      {m.kind === 'team' && m.body.mill && <div className="btns"><button className="btn pri" onClick={() => onRoom(m.body.mill)}>{tr('去造纸厂')}</button></div>}
      {m.kind === 'paper' && m.line_id && (
        <div className="btns">
          {(m.body.files ?? []).filter((f: string) => f !== 'refs.bib').map((f: string) => (
            <a key={f} className={`btn${f === 'main.pdf' ? ' pri' : ''}`} href={fileUrl(m.line_id!, f)} target="_blank" rel="noreferrer">{f}</a>
          ))}
        </div>
      )}
    </div>
  );
}

function LinePane({ lines, placements, onRoom }: { lines: Line[]; placements: Placement[]; onRoom: (id: string) => void }) {
  const [sel, setSel] = useState<string | null>(null);
  const line = lines.find(l => l.id === sel) ?? lines.find(l => ['running', 'hatching', 'waiting', 'paused'].includes(l.status)) ?? lines[0];
  if (!line) return <div className="pane-pad"><p className="muted">{tr('还没有论文在生产。到「对话」里写下一个 idea。')}</p></div>;
  const name = (id: string) => placements.find(p => p.id === id)?.name ?? id;
  return (
    <div className="pane-pad">
      {lines.length > 1 && (
        <select className="line-pick" value={line.id} onChange={e => setSel(e.target.value)}>
          {lines.map(l => <option key={l.id} value={l.id}>#{l.seq} {l.title}</option>)}
        </select>
      )}
      <h5>#{line.seq} · {line.title}</h5>
      <p className="muted small">{line.idea}</p>
      <ol className="steps">
        {line.stages.map((s, i) => (
          <li key={s.key} className={s.status === 'wait' ? 'run' : s.status} onClick={() => onRoom(s.building)}>
            <i>{i + 1}</i><b>{s.name}{s.status === 'wait' ? tr(' · 等你决定') : s.status === 'run' && s.pct ? ` · ${s.pct}%` : ''}</b>
            <span>{name(s.building)}</span>
          </li>
        ))}
      </ol>
      {line.reason && <p className="muted small" style={{ marginTop: 10 }}>{tr('编队：')}{line.reason}</p>}
      <p className="muted small">{tr('已花 $')}{line.spent.toFixed(4)} / ${line.budget.toFixed(2)}{line.note ? ` · ${line.note}` : ''}</p>
    </div>
  );
}

// the town's own model: provider, the strong and the cheap model, effort (in the chat and in settings);
// switching lasts until the server restarts
export function LlmForm({ llm, onDone }: { llm: Llm; onDone: (l: Llm | null) => void }) {
  const [draft, setDraft] = useState({ provider: llm.provider, model_strong: llm.model_strong, model_cheap: llm.model_cheap, effort: llm.effort });
  const [err, setErr] = useState('');
  const pv = llm.providers.find(x => x.id === draft.provider);
  async function apply() {
    try {
      const changed = draft.provider !== llm.provider;
      let out = await api.setLlm(changed ? { provider: draft.provider } : draft);
      if (changed && (draft.model_strong || draft.model_cheap)) out = await api.setLlm({ model_strong: draft.model_strong, model_cheap: draft.model_cheap, effort: draft.effort });
      onDone(out);
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <div className="llm-form">
      <label className="field">{tr('供应商')}
        <select value={draft.provider} onChange={e => {
          const id = e.target.value, d = llm.providers.find(x => x.id === id);
          setDraft(x => ({ ...x, provider: id, model_strong: d?.models[0] ?? '', model_cheap: d?.models[d.models.length > 2 ? 2 : 0] ?? '' }));
        }}>
          {llm.providers.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </label>
      <label className="field">{tr('强模型（Lv.3 以上的员工、最终回答）')}
        <input list="llm-models" value={draft.model_strong} onChange={e => setDraft(x => ({ ...x, model_strong: e.target.value }))} />
      </label>
      <label className="field">{tr('便宜模型（其余员工）')}
        <input list="llm-models" value={draft.model_cheap} onChange={e => setDraft(x => ({ ...x, model_cheap: e.target.value }))} />
      </label>
      <datalist id="llm-models">{pv?.models.map(m => <option key={m} value={m} />)}</datalist>
      {draft.provider === 'anthropic' && (
        <label className="field">effort
          <select value={draft.effort} onChange={e => setDraft(x => ({ ...x, effort: e.target.value }))}>
            {['low', 'medium', 'high', 'xhigh', 'max'].map(x => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
      )}
      <p className="muted small">{tr('key 照旧从环境变量读取。切换只在这次运行里有效，重启服务后按环境变量重新决定。')}{draft.provider === 'openai' ? tr(' 接口：{0}', llm.openai_base_url) : ''}</p>
      {err && <p className="warn-box small">{err}</p>}
      <div className="btns"><button className="btn pri" onClick={apply}>{tr('应用')}</button><button className="btn" onClick={() => onDone(null)}>{tr('取消')}</button></div>
    </div>
  );
}

function LlmSwitch({ shown }: { shown: boolean }) {
  const [llm, setLlm] = useState<Llm | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (!shown) setOpen(false); }, [shown]); // folding the chat away folds the picker too

  useEffect(() => { api.llm().then(setLlm).catch(() => {}); }, []);
  useEffect(() => listen(e => { if (e.type === 'llm') setLlm(e.llm); }), []);
  if (!llm) return null;

  const name = llm.providers.find(x => x.id === llm.provider)?.name ?? llm.provider;
  return (
    <div className="llm-switch">
      <button className={`llm-btn${open ? ' on' : ''}`} onClick={() => setOpen(o => !o)} title={tr('员工用的模型')}>{name} · {llm.model_strong}</button>
      {open && (
        <div className="llm-pop pnl">
          <LlmForm key={`${llm.provider}:${llm.model_strong}:${llm.model_cheap}`} llm={llm} onDone={l => { if (l) setLlm(l); setOpen(false); }} />
        </div>
      )}
    </div>
  );
}

// ---------- the departments ----------

// every department and what it is doing, read again soon after anything in the town moves
function useDepartments(tick: number) {
  const [depts, setDepts] = useState<Department[]>([]);
  const timer = useRef(0);
  const soon = useCallback(() => {
    if (timer.current) return;
    timer.current = window.setTimeout(() => {
      timer.current = 0;
      api.departments().then(setDepts).catch(() => {});
    }, 400);
  }, []);
  useEffect(soon, [tick, soon]);
  useEffect(() => listen(e => { if (e.type === 'agent' || e.type === 'job') soon(); }), [soon]);
  useEffect(() => {
    const t = setInterval(soon, 30000); // the GPUs move without telling the town
    return () => { clearInterval(t); clearTimeout(timer.current); timer.current = 0; };
  }, [soon]);
  return depts;
}

const count = <T,>(xs: T[], f: (x: T) => boolean) => xs.filter(f).length;

// what a department is doing, in a few words: what waits for you first, then what is moving
function brief(d: Department): string {
  const wait = count(d.lines, l => l.status === 'waiting');
  if (wait) return tr('{0} 个等你决定', wait);
  const working = count(d.agents, a => a.status === 'working' || a.status === 'starting');
  if (working) return tr('{0} 个员工在干活', working);
  const run = count(d.jobs, j => j.status === 'running'), queued = d.jobs.length - run;
  if (run) return queued ? tr('{0} 个实验在跑 · {1} 个排队', run, queued) : tr('{0} 个实验在跑', run);
  if (queued) return tr('{0} 个实验在排队', queued);
  const going = count(d.lines, l => l.status === 'running' || l.status === 'hatching');
  if (going) return tr('{0} 个项目在做', going);
  if (d.gpus) return d.gpus.running ? tr('{0} 个任务在跑', d.gpus.running) : tr('{0} 张卡空闲', d.gpus.idle);
  if (d.lines.length === 1) return `#${d.lines[0].seq} ${STATUS[d.lines[0].status] ?? d.lines[0].status}`;
  if (d.lines.length) return tr('{0} 个项目', d.lines.length);
  return d.state === 'off' ? tr('未接入') : d.job;
}

const agentName = (a: Pick<DeptAgent, 'name' | 'seq'>) => (a.seq ? `${a.name} · #${a.seq}` : a.name);
const runtimeOf = (a: Pick<DeptAgent, 'runtime' | 'model'>) => `${a.runtime === 'paseo' ? 'Paseo' : 'pi'}${a.model ? ` · ${a.model}` : ''}`;

function DeptCard({ d, onRoom, onAgent, onHatch, onResume, onAdjust }: {
  d: Department; onRoom: (id: string, lineId?: string | null) => void; onAgent: (a: DeptAgent) => void;
  onHatch: (id: string) => void; onResume: (id: string) => void; onAdjust: (id: string) => void;
}) {
  return (
    <section className="dk-dept" style={{ ['--dc' as string]: d.color }}>
      <header>
        <i className={`dk-st s-${d.state}`} />
        <h4>{d.name}</h4>
        <span className="dk-district">{d.district}</span>
        <button className="dk-op" onClick={() => onRoom(d.id)}>{tr('进去看看')}<Icon n="right" size={14} /></button>
      </header>
      <p className="dk-job">{d.jobs.length ? brief(d) : d.job}</p>
      {(d.lines.length > 0 || d.agents.length > 0 || d.jobs.length > 0) && (
        <div className="dk-rows">
          {d.lines.map(l => (
            <div key={l.id} className="dk-row">
              <i className={`dk-ld d-${l.status}`} />
              <button className="dk-rt" onClick={() => onRoom(d.id, l.id)} title={l.title}><b>#{l.seq}</b>{l.title}</button>
              <span className="dk-rs">{l.stage} · {STATUS[l.status] ?? l.status}</span>
              {l.status === 'waiting' && <span className="dk-ra">
                <button className="btn pri" onClick={() => onHatch(l.id)}>{tr('孵化并立项')}</button>
                <button className="btn" onClick={() => onAdjust(l.id)}>{tr('调整 idea')}</button>
              </span>}
              {l.status === 'paused' && <span className="dk-ra"><button className="btn" onClick={() => onResume(l.id)}>{tr('继续')}</button></span>}
            </div>
          ))}
          {d.agents.map(a => (
            <div key={a.id} className="dk-row">
              <span className={`dot s-${a.status}`} />
              <button className="dk-rt" onClick={() => onAgent(a)} title={a.last?.text ?? ''}>
                <b>{agentName(a)}</b>{a.last?.text && <em>{a.last.kind === 'user' ? tr('你：') : ''}{a.last.text}</em>}
              </button>
              <span className="dk-rs">{AGENT_STATUS[a.status] ?? a.status} · {a.runtime === 'paseo' ? 'Paseo' : 'pi'}</span>
              <span className="dk-ra"><button className="btn" onClick={() => onAgent(a)}>{tr('跟它说')}</button></span>
            </div>
          ))}
          {d.jobs.slice(0, 5).map(j => (
            <div key={j.id} className="dk-row">
              <i className={`dk-ld j-${j.status}`} />
              <button className="dk-rt" onClick={() => onRoom(d.id, j.line_id)} title={j.name}><b>{j.name}</b></button>
              <span className="dk-rs">{j.status === 'running' ? `${j.progress}%` : tr('排队中')} · {j.backend}</span>
            </div>
          ))}
          {d.jobs.length > 5 && <p className="dk-more">{tr('还有 {0} 个', d.jobs.length - 5)}</p>}
        </div>
      )}
      {d.worker && (
        <p className="dk-asker">
          <Ava role={d.worker.role} level={d.worker.level} code={d.worker.id} />
          {tr('在这里回答你的是{0}', ` ${ROLE_NAMES[d.worker.role] ?? d.worker.role} ${d.worker.id} · Lv.${d.worker.level}`)}
        </p>
      )}
    </section>
  );
}

// your questions to a department and its answers, with the error that came instead of an answer
function asked(messages: Message[], id: string): Message[] {
  const out: Message[] = [];
  let open = false;
  for (const m of messages) {
    if (m.body?.to === id || m.body?.from === id) {
      out.push(m);
      open = m.role === 'user';
    } else if (open && m.kind === 'error') {
      out.push(m);
      open = false;
    }
  }
  return out;
}

// the lights in the closed box: a dot for each department at work, what waits for you named
function Lights({ depts, onClick }: { depts: Department[]; onClick: () => void }) {
  if (!depts.length) return null;
  const wait = depts.filter(d => d.state === 'wait'), busy = depts.filter(d => d.state === 'busy'), lit = [...wait, ...busy];
  const label = wait.length ? (wait.length > 1 ? tr('{0} 处等你', wait.length) : tr('{0}等你', wait[0].name))
    : busy.length ? (busy.length > 1 ? tr('{0} 处在忙', busy.length) : tr('{0}在忙', busy[0].name)) : tr('都闲着');
  return (
    <button className={`dk-lights${wait.length ? ' wait' : ''}`} onClick={onClick}
      title={lit.length ? lit.map(d => `${d.name}：${brief(d)}`).join('\n') : tr('各部门都闲着')}>
      <span className="dk-dots">{(lit.length ? lit.slice(0, 3) : depts.slice(0, 1)).map(d => <i key={d.id} className={`dk-st s-${d.state}`} />)}</span>
      <span className="dk-ll">{label}</span>
      <Icon n="down" size={14} />
    </button>
  );
}

// ---------- whom you write to ----------

interface Opt { key: string; c: Composer; label: string; sub: string; group: string; color?: string; st?: string; icon?: 'egg' | 'compose' }

function options(depts: Department[], lines: Line[]): Opt[] {
  return [
    { key: 'idea', c: { kind: 'idea' }, label: tr('新 idea'), sub: tr('孵化员先去图书馆和 arXiv 查重'), group: tr('小镇'), icon: 'egg' },
    ...depts.map(d => ({ key: d.id, c: { kind: 'ask', building: d.id, name: d.name } as Composer, label: d.name, sub: brief(d), group: tr('部门'), color: d.color, st: d.state })),
    ...depts.flatMap(d => d.agents).map(a => ({
      key: a.id, c: { kind: 'agent', agentId: a.id, name: agentName(a) } as Composer, label: agentName(a),
      sub: `${AGENT_STATUS[a.status] ?? a.status} · ${a.runtime === 'paseo' ? 'Paseo' : 'pi'}`, group: tr('员工'), st: a.status,
    })),
    ...lines.filter(l => l.status === 'waiting').map(l => ({
      key: `adjust:${l.id}`, c: { kind: 'adjust', lineId: l.id } as Composer, label: tr('调整 #{0} 的 idea', l.seq), sub: l.title, group: tr('等你决定'), icon: 'compose' as const,
    })),
  ];
}

function Menu({ found, at, onPick, onHover }: { found: Opt[]; at: number; onPick: (o: Opt) => void; onHover: (i: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' }); }, [at]);
  return (
    <div className="dk-menu" role="listbox" ref={ref}>
      {found.map((o, i) => (
        <Fragment key={o.key}>
          {(i === 0 || found[i - 1].group !== o.group) && <h6>{o.group}</h6>}
          <button role="option" aria-selected={i === at} className={`dk-mi${i === at ? ' on' : ''}`}
            onMouseDown={e => { e.preventDefault(); onPick(o); }} onMouseMove={() => i !== at && onHover(i)}>
            {o.icon === 'egg' ? <Item k="egg" /> : o.icon === 'compose' ? <Icon n="compose" size={16} />
              : o.color ? <i className={`dk-sw s-${o.st}`} style={{ ['--dc' as string]: o.color }} /> : <span className={`dot s-${o.st}`} />}
            <b>{o.label}</b><span>{o.sub}</span>
          </button>
        </Fragment>
      ))}
      {!found.length && <p className="dk-none">{tr('没有对得上的部门或员工')}</p>}
    </div>
  );
}

// ---------- talking to a project's agent ----------

// what you sent a Paseo agent, until its conversation (open or opened later) shows it as sending
interface Out { id: number; agent: string; text: string }

// what waits in the town for a Paseo agent to be done (Paseo keeps no queue of its own)
function useHeld(id: string) {
  const [held, setHeld] = useState<AgentEvent[]>([]);
  useEffect(() => {
    let alive = true;
    api.agent(id).then(d => { if (alive) setHeld(d.events.filter(e => e.kind === 'user' && e.data?.held)); }).catch(() => {});
    const off = listen(e => {
      if (e.type !== 'agent_event' || e.event.agent_id !== id || e.event.kind !== 'user') return;
      const ev = e.event as AgentEvent;
      setHeld(hs => (ev.data?.held ? (hs.some(h => h.id === ev.id) ? hs : [...hs, ev]) : hs.filter(h => h.id !== ev.id)));
    });
    return () => { alive = false; off(); };
  }, [id]);
  return held;
}

function PaseoTalk({ agent, outbox, took, toast }: { agent: Agent; outbox: Out[]; took: (id: number) => void; toast: (t: string) => void }) {
  const { agent: a, items, asks, err, sent, wrote, answered } = usePaseoTalk(agent);
  const held = useHeld(agent.id);
  useEffect(() => {
    for (const o of outbox) { wrote(o.text); took(o.id); }
  }, [outbox]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => fold((items ?? []).slice(-80), i => i.kind === 'tool'), [items]);
  const permit = (id: string, allow: boolean) => {
    answered(id);
    api.permit(a.id, id, allow).catch(e => toast((e as Error).message));
  };
  if (!items && !err) return <div className="thinking"><i /><i /><i /></div>;
  return (
    <>
      {err && <div className="note err">{err}</div>}
      {items && !items.length && !sent.length && !held.length && <p className="dk-hint">{tr('还没有对话。写下第一件要它做的事。')}</p>}
      {rows.map((x, i) => Array.isArray(x)
        ? <Trail key={i} tools={x.map(paseoTool)} />
        : x.kind === 'user' ? <UserMsg key={i} text={x.text ?? ''} />
          : x.kind === 'assistant' ? <div key={i} className="msg-a"><Text text={x.text ?? ''} /></div>
            : <div key={i} className={`note${x.kind === 'error' ? ' err' : ''}`}>{x.text}</div>)}
      {sent.map((t, i) => <div key={`s${i}`} className="msg-u"><Text text={t} /><span className="meta">{tr('发送中')}</span></div>)}
      {held.map(h => <div key={h.id} className="msg-u held"><Text text={h.data.text} /><span className="meta">{tr('排队中 · 它做完手上的事就交给它')}</span></div>)}
      {asks.map(q => (
        <div key={q.id} className="ask">
          <p><b>{tr('它想')}{q.name === 'Bash' ? tr('运行命令') : tr('用 {0}', q.name)}</b>{q.title && q.title !== q.name ? ` · ${q.title}` : ''}</p>
          {q.arg && <pre className="code">{q.arg}</pre>}
          <div className="btns">
            <button className="btn pri" onClick={() => permit(q.id, true)}>{tr('允许')}</button>
            <button className="btn" onClick={() => permit(q.id, false)}>{tr('拒绝')}</button>
          </div>
        </div>
      ))}
      {a.status === 'working' && !asks.length && <div className="thinking"><i /><i /><i /></div>}
    </>
  );
}

function PiTalk({ agent }: { agent: Agent }) {
  const { agent: a, items, live } = usePiTalk(agent);
  const rows = useMemo(() => fold(items.slice(-80), x => x.ev.kind === 'tool'), [items]);
  return (
    <>
      {!items.length && !live && <p className="dk-hint">{tr('还没有对话。写下第一件要它做的事。')}</p>}
      {rows.map(x => Array.isArray(x)
        ? <Trail key={x[0].ev.id} tools={x.map(piTool)}><div className="trail-list">{x.map(t => <Tool key={t.ev.id} {...t} />)}</div></Trail>
        : <Entry key={x.ev.id} ev={x.ev} end={x.end} />)}
      {live && <div className="msg-a streaming"><Text text={live} /><i className="caret" /></div>}
      {a.status === 'working' && !live && <div className="thinking"><i /><i /><i /></div>}
    </>
  );
}

// ---------- where it stands ----------

// under the middle of the page, or of the console's panel column, whose width moves with the
// sidebars beside it and which is a new element for every project
function useColumn(view: string) {
  const [col, setCol] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    if (view !== 'console') { setCol(null); return; }
    const host = document.querySelector<HTMLElement>('.p-console');
    if (!host) return;
    function measure() {
      const cm = host!.querySelector<HTMLElement>('.cbody > .cm');
      if (!cm) return;
      const x = Math.round(cm.offsetLeft + cm.offsetWidth / 2), w = cm.offsetWidth;
      setCol(c => (c && c.x === x && c.w === w ? c : { x, w }));
    }
    const ro = new ResizeObserver(measure);
    const mo = new MutationObserver(watch);
    function watch() {
      ro.disconnect();
      const body = host!.querySelector<HTMLElement>('.cbody'), cm = body?.querySelector<HTMLElement>(':scope > .cm');
      if (body) { ro.observe(body); mo.observe(body, { childList: true }); }
      if (cm) ro.observe(cm);
      measure();
    }
    mo.observe(host, { childList: true });
    watch();
    return () => { ro.disconnect(); mo.disconnect(); };
  }, [view]);
  return col;
}

// ---------- the box ----------

export function Chat(p: Props) {
  const depts = useDepartments(p.tick);
  const col = useColumn(p.view);
  const box = useRef<HTMLTextAreaElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [outbox, setOutbox] = useState<Out[]>([]);
  const [text, setText] = useState('');
  const [budget, setBudget] = useState(1);
  const [sending, setSending] = useState(false);
  const [mode, setMode] = useState<SayMode>(() => { try { return localStorage.getItem(MODE) === 'queue' ? 'queue' : 'steer'; } catch { return 'steer'; } });
  const [menu, setMenu] = useState<{ q: string; at: number; typed: boolean } | null>(null);
  const [shown, setShown] = useState(p.open); // the inside stays while the box folds away
  const c = p.composer;

  const agents = useMemo(() => depts.flatMap(d => d.agents), [depts]);
  const agent = c.kind === 'agent' ? agents.find(a => a.id === c.agentId) : undefined;
  const dept = c.kind === 'ask' ? depts.find(d => d.id === c.building || d.type === c.building) : undefined;
  const line = c.kind === 'adjust' ? p.lines.find(l => l.id === c.lineId) : undefined;
  const working = agent?.status === 'working';
  const opts = useMemo(() => options(depts, p.lines), [depts, p.lines]);
  const found = useMemo(() => {
    const q = menu?.q.toLowerCase() ?? '';
    return q ? opts.filter(o => `${o.label} ${o.sub} ${o.key}`.toLowerCase().includes(q)) : opts;
  }, [opts, menu?.q]);

  useEffect(() => {
    if (p.open) { setShown(true); return; }
    const t = setTimeout(() => setShown(false), 520);
    return () => clearTimeout(t);
  }, [p.open]);
  useEffect(() => { if (p.focusKey) setTimeout(() => box.current?.focus(), 60); }, [p.focusKey]);
  useEffect(() => {
    if (c.kind !== 'adjust') return;
    const ln = p.lines.find(l => l.id === c.lineId);
    if (ln) setText(ln.idea);
  }, [c]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { try { localStorage.setItem(MODE, mode); } catch { /* private mode */ } }, [mode]);

  // "/" from anywhere on the page starts writing
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || (p.away && !p.open) || document.querySelector('.settings')) return;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.closest('.cm-editor'))) return;
      e.preventDefault();
      box.current?.focus();
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [p.away, p.open]);

  // the box grows with what you write, up to a few lines
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = '';
    if (text) el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [text, p.open]);

  // the conversation stays at its newest unless you have scrolled up to read
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const down = () => { if (stick.current) el.scrollTop = el.scrollHeight; };
    const mo = new MutationObserver(down);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    stick.current = true;
    down();
    return () => mo.disconnect();
  }, [shown, p.tab, c]);

  // a menu opened from the chip closes when you click elsewhere
  useEffect(() => {
    if (!menu || menu.typed) return;
    const off = (e: MouseEvent) => { if (!(e.target as Element).closest('.dk-menu, .dk-to')) setMenu(null); };
    addEventListener('mousedown', off);
    return () => removeEventListener('mousedown', off);
  }, [menu]);

  function choose(next: Composer) {
    if (c.kind === 'adjust' && next.kind !== 'adjust') setText('');
    else if (menu?.typed) setText('');
    setMenu(null);
    p.setComposer(next);
    p.onTab('chat');
    requestAnimationFrame(() => box.current?.focus());
  }

  async function send(v = text.trim()) {
    if (!v || sending) return;
    stick.current = true;
    if (c.kind === 'agent') {
      const how = working ? mode : undefined;
      setText('');
      p.setOpen(true);
      if (agent?.runtime === 'paseo' && how !== 'queue') setOutbox(xs => [...xs, { id: Date.now() + Math.random(), agent: c.agentId, text: v }]);
      try { await api.say(c.agentId, v, how); } catch (e) { p.toast((e as Error).message); }
      return;
    }
    setSending(true);
    try {
      await p.onSend(v, budget);
      setText('');
      p.setOpen(true);
    } finally {
      setSending(false);
    }
  }

  function write(v: string) {
    setText(v);
    const m = /^@(\S*)$/.exec(v);
    if (m) setMenu(x => ({ q: m[1], at: x?.typed && x.q === m[1] ? x.at : 0, typed: true }));
    else if (menu) setMenu(null);
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return;
    if (menu) {
      const n = found.length;
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n) {
        e.preventDefault();
        setMenu({ ...menu, at: (menu.at + (e.key === 'ArrowDown' ? 1 : n - 1)) % n });
        return;
      }
      if (e.key === 'Enter' || (e.key === 'Tab' && found[menu.at])) {
        e.preventDefault(); // "@xyz" that names no one is not sent as a message
        if (found[menu.at]) choose(found[menu.at].c);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (menu.typed) setText('');
        setMenu(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape' && !p.open) {
      box.current?.blur();
    }
  }

  const abort = (id: string) => api.abort(id).catch(e => p.toast((e as Error).message));
  const toAgent = (a: DeptAgent) => choose({ kind: 'agent', agentId: a.id, name: agentName(a) });

  const placeholder = c.kind === 'ask' ? tr('问问{0}的员工…', c.name)
    : c.kind === 'adjust' ? tr('改写你的 idea，孵化员会重新查重…')
      : c.kind === 'agent' ? (working ? (mode === 'steer' ? tr('插话，它做完这一步就会看到') : tr('排队，等它做完手上的事'))
        : agent?.status === 'stopped' && agent.runtime === 'pi' ? tr('它没在运行，发出去会先启动它') : tr('交给{0}一件事…', c.name))
        : tr('写一颗新 idea，或 @ 部门和员工');

  const chip = c.kind === 'idea' ? <><Item k="egg" /><b>{tr('新 idea')}</b></>
    : c.kind === 'ask' ? <><i className={`dk-sw s-${dept?.state ?? 'idle'}`} style={{ ['--dc' as string]: dept?.color }} /><b>{c.name}</b></>
      : c.kind === 'agent' ? <><span className={`dot s-${agent?.status ?? 'stopped'}`} /><b>{c.name}</b></>
        : <><Icon n="compose" size={16} /><b>{tr('调整 #{0}', line?.seq ?? '')}</b></>;

  function conversation() {
    if (c.kind === 'agent') {
      if (!agent) return <p className="dk-hint">{depts.length ? tr('找不到这个员工了。') : tr('加载中…')}</p>;
      const full = agent as unknown as Agent;
      return (
        <>
          <div className="dk-ahead">
            <span className={`dot s-${agent.status}`} />
            <div className="dk-who"><b>{agentName(agent)}</b><span>{AGENT_STATUS[agent.status] ?? agent.status} · {runtimeOf(agent)}</span></div>
            {working && <button className="dk-op" onClick={() => abort(agent.id)}><Icon n="stop" size={14} className="fill" />{tr('打断')}</button>}
            <button className="dk-op" onClick={() => p.onRoom(agent.role === 'coder' ? 'depot' : 'press', agent.line_id)}>
              {agent.role === 'coder' ? tr('去仓库看完整对话') : tr('去印刷厂看完整对话')}<Icon n="right" size={14} />
            </button>
          </div>
          {agent.runtime === 'paseo'
            ? <PaseoTalk key={agent.id} agent={full} outbox={outbox.filter(o => o.agent === agent.id)} took={id => setOutbox(xs => xs.filter(o => o.id !== id))} toast={p.toast} />
            : <PiTalk key={agent.id} agent={full} />}
        </>
      );
    }
    if (c.kind === 'ask') {
      const qa = asked(p.messages, dept?.id ?? c.building);
      return (
        <>
          {dept && <DeptCard d={dept} onRoom={p.onRoom} onAgent={toAgent} onHatch={p.onHatch} onResume={p.onResume}
            onAdjust={id => choose({ kind: 'adjust', lineId: id })} />}
          {qa.map(m => <Bubble key={m.id} m={m} lines={p.lines} placements={p.placements} onHatch={p.onHatch} onRoom={p.onRoom}
            onAdjust={id => choose({ kind: 'adjust', lineId: id })} />)}
          {!qa.length && !p.busy && (
            <div className="dk-asks">
              {[tr('现在在忙什么？'), tr('有什么要我决定的吗？')].map(q => <button key={q} onClick={() => send(q)}>{q}</button>)}
            </div>
          )}
          {p.busy && <div className="thinking"><i /><i /><i /></div>}
        </>
      );
    }
    return (
      <>
        {p.messages.length === 0 && <div className="msg bot"><p>{tr('这里是 Papertown。写下一个研究 idea，孵化员会去图书馆和 arXiv 查重，再决定要不要建一座造纸厂。')}</p></div>}
        {p.messages.map(m => (
          <Bubble key={m.id} m={m} lines={p.lines} placements={p.placements} onHatch={p.onHatch} onRoom={p.onRoom}
            onAdjust={id => choose({ kind: 'adjust', lineId: id })} />
        ))}
        {p.busy && <div className="thinking"><i /><i /><i /></div>}
      </>
    );
  }

  const style = col ? { left: col.x, ['--dk-room' as string]: `${col.w}px` } : undefined;
  return (
    <div className={`dock${p.open ? ' open' : ''}${p.away ? ' away' : ''}`} style={style}>
      <div className="dk-shell">
        <div className="dk-grow" aria-hidden={!p.open}>
          <div className="dk-panel">
            {shown && (
              <div className="dk-in">
                <div className="dk-head">
                  <div className="dk-tabs" role="tablist">
                    {(['chat', 'line', 'trace'] as Tab[]).map(t => (
                      <button key={t} role="tab" aria-selected={p.tab === t} className={p.tab === t ? 'on' : ''} onClick={() => p.onTab(t)}>
                        {{ chat: tr('对话'), line: tr('流水线'), trace: tr('调用轨迹') }[t]}
                      </button>
                    ))}
                  </div>
                  <LlmSwitch shown={p.open} />
                  <button className="dk-x" title={tr('收起（Esc）')} aria-label={tr('收起')} onClick={() => p.setOpen(false)}><Icon n="down" size={18} /></button>
                </div>
                <div className="dk-depts" role="list" aria-label={tr('各部门')}>
                  {depts.map((d, i) => {
                    const on = c.kind === 'ask' && dept?.id === d.id;
                    return (
                      <button key={d.id} role="listitem" className={`dk-chip s-${d.state}${on ? ' on' : ''}`} style={{ ['--dc' as string]: d.color, ['--i' as string]: i }}
                        onClick={() => choose(on ? { kind: 'idea' } : { kind: 'ask', building: d.id, name: d.name })} title={`${d.name} · ${d.district}\n${d.job}`}>
                        <b><i className={`dk-st s-${d.state}`} />{d.name}</b><span>{brief(d)}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="dk-body" ref={body} onScroll={e => {
                  const el = e.currentTarget;
                  stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
                }}>
                  {p.tab === 'line' ? <LinePane lines={p.lines} placements={p.placements} onRoom={id => p.onRoom(id)} />
                    : p.tab === 'trace' ? (
                      <div className="pane-pad">
                        <h5>{tr('最近的调用')}</h5>
                        <div className="trace-rows">{p.trace.length ? [...p.trace].reverse().map(traceRow) : <p className="muted">{tr('还没有调用。')}</p>}</div>
                      </div>
                    ) : conversation()}
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="dk-bar">
          {menu && <Menu found={found} at={menu.at} onPick={o => choose(o.c)} onHover={i => setMenu(m => (m ? { ...m, at: i } : m))} />}
          <button className={`dk-to${menu && !menu.typed ? ' on' : ''}`} aria-haspopup="listbox" aria-expanded={!!menu}
            title={tr('发给谁：新 idea、一个部门，或一个项目的员工（输入 @ 也能换）')}
            onClick={() => { setMenu(m => (m && !m.typed ? null : { q: '', at: 0, typed: false })); box.current?.focus(); }}>
            {chip}<Icon n="down" size={14} />
          </button>
          <textarea ref={box} rows={1} value={text} placeholder={placeholder} aria-label={tr('对话')}
            onChange={e => write(e.target.value)} onKeyDown={onKey} />
          {!text && <kbd className="dk-kbd" title={tr('在页面上任何地方按 / 开始写')}>/</kbd>}
          {c.kind === 'idea' && (
            <select className="dk-budget" value={budget} onChange={e => setBudget(Number(e.target.value))} title={tr('这篇论文的预算')}>
              {BUDGETS.map(b => <option key={b} value={b}>${b.toFixed(2)}</option>)}
            </select>
          )}
          {working && (
            <div className="dk-mode" role="radiogroup" aria-label={tr('它在忙时，消息怎么交给它')}>
              <button role="radio" aria-checked={mode === 'steer'} className={mode === 'steer' ? 'on' : ''} onClick={() => setMode('steer')}
                title={tr('插进它手上的事：做完当前这一步就会看到')}>{tr('插话')}</button>
              <button role="radio" aria-checked={mode === 'queue'} className={mode === 'queue' ? 'on' : ''} onClick={() => setMode('queue')}
                title={tr('等它把手上的事做完再交给它')}>{tr('排队')}</button>
            </div>
          )}
          {working && <button className="dk-stop" title={tr('打断它手上的事')} aria-label={tr('打断')} onClick={() => abort(agent!.id)}><Icon n="stop" size={15} className="fill" /></button>}
          {!p.open && <Lights depts={depts} onClick={() => {
            const wait = depts.find(d => d.state === 'wait');
            if (wait) choose({ kind: 'ask', building: wait.id, name: wait.name });
            p.setOpen(true);
          }} />}
          <button className="dk-send" disabled={!text.trim() || sending} onClick={() => send()} title={tr('发送（Enter）')} aria-label={tr('发送')}>
            <Icon n="send" size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
