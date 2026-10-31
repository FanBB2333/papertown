// The experiments panel: what this project has running and how far it has got, what runs
// next (each GPU's lane in nvidb, in running order, with this project's jobs picked out),
// what finished lately, and the GPUs themselves. Read only, like the rest of nvidb here.

import { useMemo, useState } from 'react';
import { api, type Job, type NvJob, type NvLane } from '../api';
import { GpuBoard, gb } from '../components/Gpus';
import { tr } from '../i18n';
import { Icon } from './icons';
import { ago, dur, useFetch } from './util';

interface Props { lineId: string; tick: number; onData: () => void }

const JOB_ST: Record<string, string> = { queued: tr('排队'), running: tr('运行中'), done: tr('完成'), failed: tr('失败'), cancelled: tr('已取消') };

// a job's result, as its first few numbers
function brief(r: unknown): [string, string][] {
  if (!r || typeof r !== 'object') return [];
  return Object.entries(r as Record<string, unknown>).filter(([, v]) => typeof v === 'number' || (typeof v === 'string' && v.length < 24))
    .slice(0, 4).map(([k, v]) => [k, typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : String(v)]);
}

export function Experiments(p: Props) {
  const board = useFetch(() => api.jobs(p.lineId), p.lineId, p.tick);
  const gpus = useFetch(() => api.gpus(), 'gpus', p.tick, 400);
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const jobs = board.data?.jobs ?? [];
  const g = gpus.data;

  const mine = useMemo(() => new Set(jobs.map(j => j.nvidb?.id).filter((x): x is number => x != null)), [jobs]);
  const nv = useMemo(() => new Map((g?.jobs ?? []).map(j => [j.id, j])), [g]);
  const running = jobs.filter(j => j.status === 'running');
  const queued = jobs.filter(j => j.status === 'queued');
  const ended = jobs.filter(j => !['running', 'queued'].includes(j.status))
    .sort((a, b) => (b.ended_at ?? b.created_at).localeCompare(a.ended_at ?? a.created_at)).slice(0, 8);
  const failed = jobs.filter(j => j.status === 'failed').length;

  // the lanes worth showing: with this project's jobs in them, or every busy one
  const only = scope === 'mine' && mine.size > 0;
  const lanes = (g?.lanes ?? []).filter(l => l.running.length + l.queued.length > 0 && (!only || [...l.running, ...l.queued].some(id => mine.has(id))));
  const inLane = new Set((g?.lanes ?? []).flatMap(l => [...l.running, ...l.queued]));
  const loose = (g?.jobs ?? []).filter(j => j.state === 'pending' && !inLane.has(j.id) && (!only || mine.has(j.id)));

  return (
    <div className="cm-page exp">
      <div className="tiles">
        <Tile n={running.length} label={tr('在跑')} tone="brand" />
        <Tile n={queued.length} label={tr('排队')} />
        <Tile n={jobs.filter(j => j.status === 'done').length} label={tr('完成')} tone="ok" />
        <Tile n={failed} label={tr('失败')} tone={failed ? 'bad' : undefined} />
        {g?.ok && g.summary && <Tile n={`${g.summary.idle}/${g.summary.gpus}`} label={tr('张卡空闲 · {0} 台机器在线', g.summary.up)} wide />}
      </div>
      {board.err && <p className="warn-box small">{board.err}</p>}

      <section className="cs">
        <h3>{tr('正在跑')}</h3>
        {running.length ? <div className="xr-list">{running.map((j, i) => <Running key={j.id} j={j} i={i} />)}</div>
          : <p className="muted small">{jobs.length ? tr('这个项目眼下没有在跑的任务。') : tr('这个项目还没有实验任务。代码员工会把实验提交到 nvidb（或者模拟电厂），到时候进度就在这里。')}</p>}
      </section>

      <section className="cs">
        <div className="cs-h">
          <h3>{tr('接下来')}</h3>
          {mine.size > 0 && <div className="seg mini" role="tablist">
            <button className={scope === 'mine' ? 'on' : ''} onClick={() => setScope('mine')}>{tr('这个项目')}</button>
            <button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>{tr('整个队列')}</button>
          </div>}
        </div>
        {!g ? <p className="muted small">{tr('正在读 nvidb…')}</p>
          : !g.ok ? <p className="muted small">{g.note}</p>
            : <>
              {queued.filter(j => !j.nvidb).length > 0 && <p className="small">{tr('另有 {0} 个任务在{1}排队。', queued.filter(j => !j.nvidb).length, board.data?.plant.name ?? '')}</p>}
              {lanes.length ? <div className="xq-lanes">{lanes.map((l, i) => <Lane key={l.name} l={l} i={i} nv={nv} mine={mine} />)}</div>
                : !loose.length && <p className="muted small">{only ? tr('这个项目的任务都不在队列里了。') : tr('nvidb 的队列是空的：没有在跑、也没有排着的任务。')}</p>}
              {loose.length > 0 && (
                <div className="loose">
                  <h4>{tr('还没分到卡的任务')}</h4>
                  {loose.slice(0, 12).map(j => (
                    <div key={j.id} className={`lj${mine.has(j.id) ? ' mine' : ''}`}>
                      <b>#{j.id} {j.name}</b>
                      <span className="muted small">{[j.pool && tr('池 {0}', j.pool), j.node_constraint && tr('限 {0}', j.node_constraint), j.vram_mb ? gb(j.vram_mb) : null,
                        j.depends_on?.length ? tr('等 {0}', j.depends_on.map(x => `#${x}`).join(' ')) : null].filter(Boolean).join(' · ')}</span>
                      {j.held && <span className="pst pst-paused">{j.held_reason ?? tr('挂起')}</span>}
                    </div>
                  ))}
                </div>
              )}
            </>}
      </section>

      <section className="cs">
        <div className="cs-h"><h3>{tr('最近结束')}</h3>{ended.length > 0 && <button className="lnk" onClick={p.onData}>{tr('结果和数据')} →</button>}</div>
        {ended.length ? (
          <div className="xe-list">
            {ended.map((j, i) => (
              <div key={j.id} className={`xe st-${j.status}`} style={{ ['--i' as string]: i }}>
                <span className="xe-dot" />
                <b title={j.command ?? ''}>{j.name}</b>
                <span className="muted small">{JOB_ST[j.status]}{j.nvidb?.exit_code != null && j.status === 'failed' ? ` · exit ${j.nvidb.exit_code}` : ''} · {ago(j.ended_at ?? j.created_at)}</span>
                <span className="xe-res">{brief(j.result ?? j.nvidb?.result).map(([k, v]) => <span key={k} className="chip"><i>{k}</i> {v}</span>)}</span>
              </div>
            ))}
          </div>
        ) : <p className="muted small">{tr('还没有跑完的任务。')}</p>}
      </section>

      <details className="cs fold">
        <summary><Icon n="gpu" size={16} />{tr('全部显卡和机器')}</summary>
        <GpuBoard />
      </details>
    </div>
  );
}

function Tile({ n, label, tone, wide }: { n: number | string; label: string; tone?: string; wide?: boolean }) {
  return <div className={`tile${tone ? ` t-${tone}` : ''}${wide ? ' wide' : ''}`}><b>{n}</b><span>{label}</span></div>;
}

function Running({ j, i }: { j: Job; i: number }) {
  const n = j.nvidb;
  const where = n ? [n.node, n.gpu_ids.length ? `GPU ${n.gpu_ids.join(',')}` : null].filter(Boolean).join(' · ') : j.backend;
  return (
    <div className="xr" style={{ ['--i' as string]: i }}>
      <div className="xr-top"><b>{j.name}</b><span className="muted small">{where}</span></div>
      <div className="bar xr-bar"><i style={{ width: `${Math.max(2, j.progress)}%` }} /></div>
      <div className="xr-foot muted small">
        <span>{j.progress}%</span>
        {n?.progress && <span className="xr-line" title={n.progress}>{n.progress}</span>}
        <span>{n?.elapsed_s != null ? dur(n.elapsed_s) : ago(j.started_at)}</span>
        {n?.vram_mb ? <span>{gb(n.vram_mb)}</span> : null}
      </div>
    </div>
  );
}

function Lane({ l, i, nv, mine }: { l: NvLane; i: number; nv: Map<number, NvJob>; mine: Set<number> }) {
  const seq = [...l.running.map(id => ({ id, run: true })), ...l.queued.map(id => ({ id, run: false }))];
  return (
    <div className="xq-lane" style={{ ['--i' as string]: i }}>
      <div className="xq-h">
        <b>{l.name}</b>
        {l.paused && <span className="pst pst-paused">{tr('已暂停')}</span>}
        {l.blocked && <span className="pst pst-failed" title={l.blocked}>{tr('卡住了')}</span>}
        <span className="muted small">{tr('{0} 个排着', l.queued.length)}</span>
      </div>
      <div className="xq-seq">
        {seq.map(({ id, run }, k) => {
          const j = nv.get(id);
          return (
            <span key={id} className={`lj-chip${run ? ' run' : ''}${mine.has(id) ? ' mine' : ''}`} style={{ ['--k' as string]: k }}
              title={j ? `${j.name}\n${j.submitter ?? ''}${j.notes ? `\n${j.notes}` : ''}` : `#${id}`}>
              {run && <i className="lj-pulse" />}
              <em>{run ? tr('在跑') : tr('第 {0}', k - l.running.length + 1)}</em>
              <b>#{id}</b>{j && <span>{j.name}</span>}
            </span>
          );
        })}
      </div>
    </div>
  );
}
