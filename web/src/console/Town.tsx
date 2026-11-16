// Two of the console's town panels: what every department is doing (its projects, staff and experiments),
// and the town's latest model and tool calls.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, listen, type Department, type DeptAgent, type TraceRow } from '../api';
import { Ava, ROLE_NAMES } from '../art';
import { AGENT_STATUS, STATUS } from '../components/MillRoom';
import { tr } from '../i18n';
import { Icon } from './icons';

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
const agentSub = (a: DeptAgent) => `${AGENT_STATUS[a.status] ?? a.status} · ${a.runtime === 'paseo' ? 'Paseo' : 'pi'}`;

function DeptCard({ d, onRoom, onAgent, onHatch, onResume, onAdjust }: {
  d: Department; onRoom: (id: string, lineId?: string | null) => void; onAgent: (a: DeptAgent) => void;
  onHatch: (id: string) => void; onResume: (id: string) => void; onAdjust: (id: string) => void;
}) {
  return (
    <section className="dp-dept" style={{ ['--dc' as string]: d.color }}>
      <header>
        <i className={`dp-st s-${d.state}`} />
        <h4>{d.name}</h4>
        <span className="dp-district">{d.district}</span>
        <button className="dp-op" onClick={() => onRoom(d.id)}>{tr('进去看看')}<Icon n="right" size={14} /></button>
      </header>
      <p className="dp-job">{d.jobs.length ? brief(d) : d.job}</p>
      {(d.lines.length > 0 || d.agents.length > 0 || d.jobs.length > 0) && (
        <div className="dp-rows">
          {d.lines.map(l => (
            <div key={l.id} className="dp-row">
              <i className={`dp-ld d-${l.status}`} />
              <button className="dp-rt" onClick={() => onRoom(d.id, l.id)} title={l.title}><b>#{l.seq}</b>{l.title}</button>
              <span className="dp-rs">{l.stage} · {STATUS[l.status] ?? l.status}</span>
              {l.status === 'waiting' && <span className="dp-ra">
                <button className="btn pri" onClick={() => onHatch(l.id)}>{tr('孵化并立项')}</button>
                <button className="btn" onClick={() => onAdjust(l.id)}>{tr('调整 idea')}</button>
              </span>}
              {l.status === 'paused' && <span className="dp-ra"><button className="btn" onClick={() => onResume(l.id)}>{tr('继续')}</button></span>}
            </div>
          ))}
          {d.agents.map(a => (
            <div key={a.id} className="dp-row">
              <span className={`dot s-${a.status}`} />
              <button className="dp-rt" onClick={() => onAgent(a)} title={a.last?.text ?? ''}>
                <b>{agentName(a)}</b>{a.last?.text && <em>{a.last.kind === 'user' ? tr('你：') : ''}{a.last.text}</em>}
              </button>
              <span className="dp-rs">{agentSub(a)}</span>
              <span className="dp-ra"><button className="btn" onClick={() => onAgent(a)}>{tr('跟它说')}</button></span>
            </div>
          ))}
          {d.jobs.slice(0, 5).map(j => (
            <div key={j.id} className="dp-row">
              <i className={`dp-ld j-${j.status}`} />
              <button className="dp-rt" onClick={() => onRoom(d.id, j.line_id)} title={j.name}><b>{j.name}</b></button>
              <span className="dp-rs">{j.status === 'running' ? `${j.progress}%` : tr('排队中')} · {j.backend}</span>
            </div>
          ))}
          {d.jobs.length > 5 && <p className="dp-more">{tr('还有 {0} 个', d.jobs.length - 5)}</p>}
        </div>
      )}
      {d.worker && (
        <p className="dp-asker">
          <Ava role={d.worker.role} level={d.worker.level} code={d.worker.id} />
          {tr('在这里值班的是{0}', ` ${ROLE_NAMES[d.worker.role] ?? d.worker.role} ${d.worker.id} · Lv.${d.worker.level}`)}
        </p>
      )}
    </section>
  );
}

export function Departments({ tick, onRoom, onAgent, onHatch, onResume, onAdjust }: {
  tick: number; onRoom: (id: string, lineId?: string | null) => void; onAgent: (a: DeptAgent) => void;
  onHatch: (id: string) => void; onResume: (id: string) => void; onAdjust: (id: string) => void;
}) {
  const depts = useDepartments(tick);
  return (
    <div className="cm-page dp-page">
      {!depts.length ? <p className="muted">{tr('加载中…')}</p>
        : depts.map(d => <DeptCard key={d.id} d={d} onRoom={onRoom} onAgent={onAgent} onHatch={onHatch} onResume={onResume} onAdjust={onAdjust} />)}
    </div>
  );
}

export function Trace() {
  const [rows, setRows] = useState<TraceRow[] | null>(null);
  useEffect(() => {
    api.trace().then(setRows).catch(() => setRows([]));
    return listen(e => { if (e.type === 'trace') setRows(t => [...(t ?? []), e.row].slice(-200)); });
  }, []);
  return (
    <div className="cm-page">
      <div className="trace-rows">
        {rows == null ? <p className="muted">{tr('加载中…')}</p> : rows.length ? [...rows].reverse().map(t => (
          <div className="tr" key={t.id} title={t.ts}>
            <span className={`k k-${t.kind.toLowerCase()}`}>{t.kind}</span><code>{t.label}</code><em>{t.detail}</em>
          </div>
        )) : <p className="muted">{tr('还没有调用。')}</p>}
      </div>
    </div>
  );
}
