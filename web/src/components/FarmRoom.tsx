// The experiment farm: one board for every job, a monitor per project noting what its jobs do, the
// backends and the GPUs nvidb sees. A linked project's jobs in nvidb's queue are shown read only.

import { useEffect, useMemo, useState } from 'react';
import { api, listen, type Job, type JobBoard, type Line, type RosterRow } from '../api';
import { GpuBoard, gb } from './Gpus';
import type { RoomActions } from './Interior';
import { tr } from '../i18n';

interface Props extends RoomActions {
  focus: string | null;
  lines: Line[];
  tick: number;
}

const JOB_STATUS: Record<string, string> = { queued: tr('排队'), running: tr('运行中'), done: tr('完成'), failed: tr('失败'), cancelled: tr('已取消') };
const WHO = (by: string | null) => !by ? '—' : by === 'you' ? tr('你') : by.startsWith('coder-') ? tr('代码员工') : by;

// a linked project's experiments are its jobs in nvidb, counted on its experiment stage
const linkedNote = (l?: Line) => l?.linked ? l.stages.find(s => s.key === 'exp')?.note ?? tr('nvidb 中暂无其任务。') : undefined;

function ago(ts: string | null) {
  if (!ts) return '';
  const s = (Date.now() - Date.parse(ts)) / 1000;
  return s < 60 ? tr('刚刚') : s < 3600 ? tr('{0} 分钟前', Math.floor(s / 60)) : s < 86400 ? tr('{0} 小时前', Math.floor(s / 3600)) : tr('{0} 天前', Math.floor(s / 86400));
}

function JobDetail({ id, onClose, toast }: { id: string; onClose: () => void; toast: (t: string) => void }) {
  const [j, setJ] = useState<Job | null>(null);
  const [bump, setBump] = useState(0);
  useEffect(() => listen(e => { if (e.type === 'job' && e.job.id === id) setBump(b => b + 1); }), [id]);
  useEffect(() => {
    const t = setTimeout(() => api.job(id).then(setJ).catch(() => {}), 120);
    return () => clearTimeout(t);
  }, [id, bump]);
  if (!j) return <div className="job-detail"><p className="muted">{tr('加载中…')}</p></div>;
  return (
    <div className="job-detail">
      <div className="jd-head">
        <div><h3>{j.name}</h3><p className="muted small">{j.id} · {j.backend} · {WHO(j.submitted_by)}{tr('提交 ·')} {ago(j.created_at)}</p></div>
        <div className="btns">
          {['queued', 'running'].includes(j.status) && j.backend === 'local' &&
            <button className="btn" onClick={() => api.cancelJob(j.id).catch(e => toast(e.message))}>{tr('取消')}</button>}
          <button className="sh-x" onClick={onClose} title={tr('关闭')}>×</button>
        </div>
      </div>
      <div className="bar big"><i style={{ width: `${j.progress}%` }} /></div>
      <p className="small">{JOB_STATUS[j.status]} · {j.progress}%{j.note && !j.nvidb ? ` · ${j.note}` : ''}</p>
      {j.nvidb && <NvidbJob n={j.nvidb} />}
      {j.command && <><h4>{tr('命令')}</h4><pre className="code">{j.command}</pre></>}
      {j.result && <><h4>{tr('结果')}{j.result.simulated ? tr('样例结果（占位内容）') : ''}</h4><Result r={j.result} /></>}
      {j.nvidb ? <><h4>{tr('日志')}</h4><p className="muted small">{tr('日志保存在 nvidb 中，本页不从节点读取：')}<code>nvidb job logs {j.nvidb.id} -n 200</code></p></>
        : j.backend !== 'sim' && <><h4>{tr('日志')}</h4><pre className="code log-box">{j.log || tr('（暂无输出）')}</pre></>}
    </div>
  );
}

function dur(s: number | null) {
  if (s == null) return '—';
  return s < 60 ? tr('{0} 秒', Math.round(s)) : s < 3600 ? tr('{0} 分钟', Math.floor(s / 60)) : tr('{0} 小时 {1} 分', Math.floor(s / 3600), Math.floor(s % 3600 / 60));
}

// a job in nvidb's queue: where it runs and what it reported, managed with nvidb itself
function NvidbJob({ n }: { n: NonNullable<Job['nvidb']> }) {
  return (
    <>
      <p className="muted small">{tr('nvidb 队列中的任务在此只读。取消、修改预留或查看事件请用')} <code>nvidb job show {n.id}</code>{tr('。')}</p>
      <dl className="kv">
        <dt>{tr('在哪')}</dt><dd>{n.node ? `${n.node} · GPU ${n.gpu_ids.join(', ') || '—'}` : n.lane ? tr('排在 {0}', n.lane) : tr('尚未分配')}</dd>
        <dt>{tr('预留显存')}</dt><dd>{n.vram_mb ? gb(n.vram_mb) : tr('不占显存')}</dd>
        {n.progress && <><dt>{tr('状态行')}</dt><dd>{n.progress}</dd></>}
        <dt>{tr('用时')}</dt><dd>{dur(n.elapsed_s)}{n.exit_code != null ? tr(' · 退出码 {0}', n.exit_code) : ''}</dd>
        {n.held && <><dt>{tr('受阻')}</dt><dd className="warn">{tr('依赖任务未成功结束，待决定')}</dd></>}
        {n.workdir && <><dt>{tr('目录')}</dt><dd className="brk">{n.workdir}</dd></>}
      </dl>
      {n.notes && <><h4>{tr('说明')}</h4><p className="small nv-notes">{n.notes}</p></>}
      {n.last_error && <><h4>{tr('出错')}</h4><pre className="code">{n.last_error}</pre></>}
    </>
  );
}

function Result({ r }: { r: any }) {
  if (r.rows && r.metrics) {
    return (
      <table className="rtab"><thead><tr><th>{tr('方法')}</th>{r.metrics.map((m: string) => <th key={m}>{m}</th>)}</tr></thead>
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

  const all = board?.jobs ?? [];
  const active = (backend: string) => all.filter(j => j.backend === backend && ['queued', 'running'].includes(j.status)).length;
  const seq = useMemo(() => Object.fromEntries(p.lines.map(l => [l.id, l.seq])), [p.lines]);
  const jobs = all.filter(j => !only || j.line_id === only);
  const groups: [string, Job[]][] = [
    [tr('运行中'), jobs.filter(j => j.status === 'running')],
    [tr('排队'), jobs.filter(j => j.status === 'queued')],
    [tr('已结束'), jobs.filter(j => !['running', 'queued'].includes(j.status))],
  ];

  return (
    <div className="room room-farm">
      <aside className="room-side">
        <h4 className="side-h">{tr('看田员')} <span className="muted small">{tr('各项目一位，监测实验进度')}</span></h4>
        <button className={`mon${!only ? ' on' : ''}`} onClick={() => setOnly(null)}>
          <b>{tr('全部项目')}</b><span className="muted small">{tr('{0} 个任务', all.length)}</span>
        </button>
        {monitors.map(({ line, agent }, i) => (
          <button key={line.id} className={`mon${only === line.id ? ' on' : ''}`} style={{ ['--i' as string]: i }} onClick={() => setOnly(line.id)}>
            <div className="proj-top"><b>#{line.seq} {line.title}</b>
              <span className={`pulse${all.some(j => j.line_id === line.id && j.status === 'running') ? ' on' : ''}`} /></div>
            <p className="mon-note">{agent?.last?.data?.text ?? linkedNote(p.lines.find(l => l.id === line.id)) ?? tr('暂无实验。代码员工提交任务后，此处将记录进度。')}</p>
            {agent?.last && <span className="muted small">{ago(agent.last.ts)}</span>}
          </button>
        ))}
      </aside>
      <section className="room-main">
        <div className="backends">
          {(board?.backends ?? []).map(b => (
            <div key={b.id} className={`backend${b.ready ? '' : ' off'}`}>
              <div className="proj-top"><b>{b.name}</b><span className={`pst ${b.ready ? 'pst-running' : 'pst-paused'}`}>{b.ready ? tr('{0} 个运行中', b.id === 'nvidb' ? b.active : active(b.id)) : tr('未接入')}</span></div>
              <p className="muted small">{b.note}</p>
            </div>
          ))}
        </div>
        <GpuBoard />
        <div className="board">
          {!jobs.length && <div className="room-empty small-empty"><p>{tr('暂无任务。仓库中的代码员工提交实验（pi 使用')} <code>papertown_submit_job</code>{tr('，Paseo 中的 agent 使用')} <code>.papertown/pt submit</code>{tr('），或流水线推进至实验工序时，任务将显示在此处。')}</p></div>}
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
