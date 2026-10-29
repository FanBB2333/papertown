// The experiment farm: one board for every job, whoever submitted it, and one monitor
// per project writing down what its jobs are doing. Under the backends strip, the GPUs
// nvidb sees on your machines; a linked project's jobs in nvidb's queue are on the board
// too, read only.

import { useEffect, useMemo, useState } from 'react';
import { api, listen, type Job, type JobBoard, type Line, type RosterRow } from '../api';
import { GpuBoard, gb } from './Gpus';
import type { RoomActions } from './Interior';

interface Props extends RoomActions {
  focus: string | null;
  lines: Line[];
  tick: number;
}

const JOB_STATUS: Record<string, string> = { queued: '排队', running: '运行中', done: '完成', failed: '失败', cancelled: '已取消' };
const WHO = (by: string | null) => !by ? '—' : by === 'pipeline' ? '流水线' : by === 'you' ? '你' : by.startsWith('coder-') ? '代码员工' : by;

// a linked project's experiments are its jobs in nvidb, counted on its experiment stage
const linkedNote = (l?: Line) => l?.linked ? l.stages.find(s => s.key === 'exp')?.note ?? 'nvidb 里还没有它的任务。' : undefined;

function ago(ts: string | null) {
  if (!ts) return '';
  const s = (Date.now() - Date.parse(ts)) / 1000;
  return s < 60 ? '刚刚' : s < 3600 ? `${Math.floor(s / 60)} 分钟前` : s < 86400 ? `${Math.floor(s / 3600)} 小时前` : `${Math.floor(s / 86400)} 天前`;
}

function JobDetail({ id, onClose, toast }: { id: string; onClose: () => void; toast: (t: string) => void }) {
  const [j, setJ] = useState<Job | null>(null);
  const [bump, setBump] = useState(0);
  useEffect(() => listen(e => { if (e.type === 'job' && e.job.id === id) setBump(b => b + 1); }), [id]);
  useEffect(() => {
    const t = setTimeout(() => api.job(id).then(setJ).catch(() => {}), 120);
    return () => clearTimeout(t);
  }, [id, bump]);
  if (!j) return <div className="job-detail"><p className="muted">加载中…</p></div>;
  return (
    <div className="job-detail">
      <div className="jd-head">
        <div><h3>{j.name}</h3><p className="muted small">{j.id} · {j.backend} · {WHO(j.submitted_by)}提交 · {ago(j.created_at)}</p></div>
        <div className="btns">
          {['queued', 'running'].includes(j.status) && j.backend === 'local' &&
            <button className="btn" onClick={() => api.cancelJob(j.id).catch(e => toast(e.message))}>取消</button>}
          <button className="sh-x" onClick={onClose} title="关闭">×</button>
        </div>
      </div>
      <div className="bar big"><i style={{ width: `${j.progress}%` }} /></div>
      <p className="small">{JOB_STATUS[j.status]} · {j.progress}%{j.note && !j.nvidb ? ` · ${j.note}` : ''}</p>
      {j.nvidb && <NvidbJob n={j.nvidb} />}
      {j.command && <><h4>命令</h4><pre className="code">{j.command}</pre></>}
      {j.result && <><h4>结果{j.result.simulated ? '（模拟）' : ''}</h4><Result r={j.result} /></>}
      {j.nvidb ? <><h4>日志</h4><p className="muted small">日志留在 nvidb 里，这里不去节点上读：<code>nvidb job logs {j.nvidb.id} -n 200</code></p></>
        : j.backend !== 'sim' && <><h4>日志</h4><pre className="code log-box">{j.log || '（还没有输出）'}</pre></>}
    </div>
  );
}

function dur(s: number | null) {
  if (s == null) return '—';
  return s < 60 ? `${Math.round(s)} 秒` : s < 3600 ? `${Math.floor(s / 60)} 分钟` : `${Math.floor(s / 3600)} 小时 ${Math.floor(s % 3600 / 60)} 分`;
}

// a job in nvidb's queue: where it runs and what it reported, managed with nvidb itself
function NvidbJob({ n }: { n: NonNullable<Job['nvidb']> }) {
  return (
    <>
      <p className="muted small">nvidb 队列里的任务，在这里只读；要取消、改预留或看事件，用 <code>nvidb job show {n.id}</code>。</p>
      <dl className="kv">
        <dt>在哪</dt><dd>{n.node ? `${n.node} · GPU ${n.gpu_ids.join(', ') || '—'}` : n.lane ? `排在 ${n.lane}` : '还没分配'}</dd>
        <dt>预留显存</dt><dd>{n.vram_mb ? gb(n.vram_mb) : '不占显存'}</dd>
        {n.progress && <><dt>状态行</dt><dd>{n.progress}</dd></>}
        <dt>用时</dt><dd>{dur(n.elapsed_s)}{n.exit_code != null ? ` · 退出码 ${n.exit_code}` : ''}</dd>
        {n.held && <><dt>卡住了</dt><dd className="warn">依赖的任务没有成功结束，在等人决定</dd></>}
        {n.workdir && <><dt>目录</dt><dd className="brk">{n.workdir}</dd></>}
      </dl>
      {n.notes && <><h4>说明</h4><p className="small nv-notes">{n.notes}</p></>}
      {n.last_error && <><h4>出错</h4><pre className="code">{n.last_error}</pre></>}
    </>
  );
}

function Result({ r }: { r: any }) {
  if (r?.rows && r?.metrics) {
    return (
      <table className="rtab"><thead><tr><th>方法</th>{r.metrics.map((m: string) => <th key={m}>{m}</th>)}</tr></thead>
        <tbody>{r.rows.map((x: any) => <tr key={x.method} className={x.ours ? 'ours' : ''}><td>{x.method}</td>{x.values.map((v: number, i: number) => <td key={i}>{v}</td>)}</tr>)}</tbody>
      </table>
    );
  }
  return <pre className="code">{JSON.stringify(r, null, 2)}</pre>;
}

export function FarmRoom(p: Props) {
  const [board, setBoard] = useState<JobBoard | null>(null);
  const [monitors, setMonitors] = useState<RosterRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [only, setOnly] = useState<string | null>(p.focus);
  const [bump, setBump] = useState(0);

  useEffect(() => listen(e => {
    if (e.type === 'job') {
      setBoard(b => b && { ...b, jobs: b.jobs.some(j => j.id === e.job.id) ? b.jobs.map(j => j.id === e.job.id ? e.job : j) : [e.job, ...b.jobs] });
    }
    if (e.type === 'agent_event' || e.type === 'agent') setBump(b => b + 1);
  }), []);
  useEffect(() => { api.jobs().then(setBoard).catch(() => {}); }, [p.tick]);
  useEffect(() => {
    const t = setTimeout(() => api.roster('monitor').then(r => setMonitors(r.roster)).catch(() => {}), 200);
    return () => clearTimeout(t);
  }, [bump, p.tick]);

  const active = (backend: string) => (board?.jobs ?? []).filter(j => j.backend === backend && ['queued', 'running'].includes(j.status)).length;
  const seq = useMemo(() => Object.fromEntries(p.lines.map(l => [l.id, l.seq])), [p.lines]);
  const jobs = (board?.jobs ?? []).filter(j => !only || j.line_id === only);
  const groups: [string, Job[]][] = [
    ['运行中', jobs.filter(j => j.status === 'running')],
    ['排队', jobs.filter(j => j.status === 'queued')],
    ['已结束', jobs.filter(j => !['running', 'queued'].includes(j.status))],
  ];

  return (
    <div className="room room-farm">
      <aside className="room-side">
        <h4 className="side-h">看田员 <span className="muted small">每个项目一位，盯实验进度</span></h4>
        <button className={`mon${!only ? ' on' : ''}`} onClick={() => setOnly(null)}>
          <b>全部项目</b><span className="muted small">{board?.jobs.length ?? 0} 个任务</span>
        </button>
        {monitors.map(({ line, agent }, i) => (
          <button key={line.id} className={`mon${only === line.id ? ' on' : ''}`} style={{ ['--i' as string]: i }} onClick={() => setOnly(line.id)}>
            <div className="proj-top"><b>#{line.seq} {line.title}</b>
              <span className={`pulse${(board?.jobs ?? []).some(j => j.line_id === line.id && j.status === 'running') ? ' on' : ''}`} /></div>
            <p className="mon-note">{agent?.last?.data?.text ?? linkedNote(p.lines.find(l => l.id === line.id)) ?? '还没有实验。代码员工提交任务后，这里会写下进度。'}</p>
            {agent?.last && <span className="muted small">{ago(agent.last.ts)}</span>}
          </button>
        ))}
      </aside>
      <section className="room-main">
        <div className="backends">
          {(board?.backends ?? []).map(b => (
            <div key={b.id} className={`backend${b.ready ? '' : ' off'}`}>
              <div className="proj-top"><b>{b.name}</b><span className={`pst ${b.ready ? 'pst-running' : 'pst-paused'}`}>{b.ready ? `${b.id === 'nvidb' ? b.active : active(b.id)} 个在跑` : '未接入'}</span></div>
              <p className="muted small">{b.note}</p>
            </div>
          ))}
        </div>
        <GpuBoard />
        <div className="board">
          {!jobs.length && <div className="room-empty small-empty"><p>还没有任务。仓库里的代码员工提交实验（pi 用 <code>papertown_submit_job</code>，Paseo 里的 agent 用 <code>.papertown/pt submit</code>），或者流水线跑到实验工序时，任务会出现在这里。</p></div>}
          {groups.map(([name, list]) => list.length > 0 && (
            <div key={name} className="jgroup">
              <h4>{name} <span className="muted">{list.length}</span></h4>
              {list.map(j => (
                <button key={j.id} className={`job s-${j.status}${open === j.id ? ' on' : ''}`} onClick={() => setOpen(j.id)}>
                  <span className="job-name"><b>{j.name}</b><small>#{j.line_id ? seq[j.line_id] ?? '?' : '-'} · {WHO(j.submitted_by)}</small></span>
                  <span className="chip">{j.backend}</span>
                  <span className="bar"><i style={{ width: `${j.progress}%` }} /></span>
                  <span className="job-st">{JOB_STATUS[j.status]}</span>
                  <span className="muted small">{ago(j.ended_at ?? j.started_at ?? j.created_at)}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </section>
      {open && <JobDetail id={open} onClose={() => setOpen(null)} toast={p.toast} />}
    </div>
  );
}
