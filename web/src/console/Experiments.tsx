// The experiments panel: filters, counts per state, what to look at first, a timeline of the
// project's jobs per GPU, the live cluster (Cluster.tsx) and the jobs (JobViews.tsx). Read only.

import { useEffect, useMemo, useState } from 'react';
import { api, type Job } from '../api';
import { tr } from '../i18n';
import { Gantt, Legend, ST, fmtNum, when, type GJob, type St } from './charts';
import { Cluster } from './Cluster';
import { Icon } from './icons';
import { JobDrawer } from './JobDrawer';
import { JobViews } from './JobViews';
import { endOf, jobRef, lineOf, placeOf, resOf, startOf, stj, t } from './jobs';
import { usePanelNote } from './page';
import { ago, dur, headline, headlines, pctOf, useFetch } from './util';

interface Props { lineId: string; tick: number; onData: () => void }

type Range = '1d' | '7d' | '30d' | 'all';
const SPAN: Record<Exclude<Range, 'all'>, number> = { '1d': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5 };
const RANGES: [Range, string][] = [['1d', tr('24 小时')], ['7d', tr('7 天')], ['30d', tr('30 天')], ['all', tr('全部')]];
const STATES: St[] = ['running', 'queued', 'done', 'failed', 'cancelled'];

export function Experiments(p: Props) {
  const [beat, setBeat] = useState(0);
  useEffect(() => { const i = setInterval(() => setBeat(b => b + 1), 15000); return () => clearInterval(i); }, []);
  const board = useFetch(() => api.jobs(p.lineId), p.lineId, p.tick + beat);
  const [range, setRange] = useState<Range>('7d');
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const [st, setSt] = useState<St | null>(null);
  const [q, setQ] = useState('');
  const [open, setOpenAt] = useState<{ id: string; list: string[] } | null>(null);
  const openAt = (id: string, list: string[]) => setOpenAt({ id, list });
  const openIn = (list: string[]) => (id: string) => openAt(id, list);
  const now = Date.now();

  const jobs = board.data?.jobs ?? [];
  const [r0, r1] = useMemo((): [number, number] => {
    if (range !== 'all') return [now - SPAN[range], now + SPAN[range] * 0.02];
    const first = Math.min(...jobs.map(j => startOf(j)).filter(Number.isFinite), now - 864e5);
    return [first, now + (now - first) * 0.02];
  }, [range, jobs.length, Math.floor(now / 60000)]); // eslint-disable-line react-hooks/exhaustive-deps
  const [d0, d1] = zoom ?? [r0, r1];

  const inRange = jobs.filter(j => {
    const s = stj(j);
    if (s === 'queued' || s === 'running') return true;
    const e = endOf(j), b = startOf(j);
    return (Number.isFinite(e) ? e : t(j.created_at)) >= d0 && (Number.isFinite(b) ? b : t(j.created_at)) <= d1;
  });
  const needle = q.trim().toLowerCase();
  const shown = inRange.filter(j => (!st || stj(j) === st)
    && (!needle || `${j.id} ${j.name} ${j.nvidb?.notes ?? ''} ${placeOf(j)}`.toLowerCase().includes(needle)));
  const gpuHours = inRange.reduce((a, j) => {
    const b = startOf(j), cards = j.nvidb ? j.nvidb.gpu_ids.length : 0;
    if (!Number.isFinite(b) || !cards) return a;
    const e = Number.isFinite(endOf(j)) ? endOf(j) : now;
    return a + Math.max(0, Math.min(e, d1) - Math.max(b, d0)) * cards / 3600e3;
  }, 0);
  const gh = gpuHours < 10 ? gpuHours.toFixed(1) : Math.round(gpuHours);

  const gjobs: GJob[] = shown.filter(j => Number.isFinite(startOf(j))).map(j => {
    const s = stj(j), b = startOf(j), e = endOf(j);
    const res = headline(resOf(j), 2);
    return {
      id: j.id, name: j.name, st: s, row: placeOf(j), start: b, end: s === 'running' ? null : Number.isFinite(e) ? e : b + 60e3,
      tip: [{ v: ST[s].label, k: tr('状态'), key: ST[s].c }, { v: dur(j.nvidb?.elapsed_s ?? (Number.isFinite(e) ? (e - b) / 1000 : null)), k: tr('用时') },
        { v: `${when(b)} → ${Number.isFinite(e) ? when(e) : tr('现在')}`, k: '' }, { v: placeOf(j), k: tr('在哪') },
        ...res.map(([k, v]) => ({ v: fmtNum(v), k }))],
    };
  });

  const at = open ? open.list.indexOf(open.id) : -1;
  usePanelNote('exp', 'filters', {
    时间范围: zoom ? `${when(d0)} – ${when(d1)}（在时间线上框选放大的）` : RANGES.find(([k]) => k === range)![1],
    状态: st ? ST[st].label : null, 搜索: q.trim(), 符合的任务: `${shown.length} 个（这段时间共 ${inRange.length} 个）`, 打开着详情的任务: open?.id,
  });
  useEffect(() => {
    const show = (e: Event) => setOpenAt({ id: (e as CustomEvent<string>).detail, list: [] });
    addEventListener('pt-open-job', show);
    return () => removeEventListener('pt-open-job', show);
  }, []);

  return (
    <div className="cm-page exp">
      <div className="xf">
        <div className="seg mini" role="tablist" aria-label={tr('时间范围')}>
          {RANGES.map(([k, name]) => <button key={k} className={range === k && !zoom ? 'on' : ''} onClick={() => { setRange(k); setZoom(null); }}>{name}</button>)}
        </div>
        {zoom && <button className="xf-zoom" onClick={() => setZoom(null)}>{when(d0)} – {when(d1)}<Icon n="close" size={12} /></button>}
        {st && (
          <button className="xf-zoom xf-pick" onClick={() => setSt(null)} style={{ ['--c' as string]: ST[st].c }} title={tr('不再只看这个状态')}>
            <i className={ST[st].hollow ? 'hollow' : ''} />{tr('只看{0}', ST[st].label)}<Icon n="close" size={12} />
          </button>
        )}
        <label className="xf-q"><Icon n="lens" size={14} /><input placeholder={tr('搜任务名、编号、说明')} value={q} onChange={e => setQ(e.target.value)} /></label>
      </div>

      <div className="tiles">
        {STATES.map(s => {
          const n = inRange.filter(j => stj(j) === s).length;
          return (
            <button key={s} className={`tile pick st s-${s}${st === s ? ' on' : ''}${n ? '' : ' zero'}`} onClick={() => setSt(x => (x === s ? null : s))}
              data-ref={`count:${s}`} data-ref-label={`${ST[s].label} ${n}`}>
              <b>{n}</b><span><i className="tile-key" style={{ ['--c' as string]: ST[s].c }}>{ST[s].sign}</i>{ST[s].label}</span>
            </button>
          );
        })}
        <div className="tile gh" title={tr('这段时间里这个项目的任务占卡的时长，按卡数累加')} data-ref="count:gpu-hours"
          data-ref-label={`${tr('GPU 小时')} ${gh}`}><b>{gh}</b><span><Icon n="gpu" size={13} />{tr('GPU 小时')}</span></div>
      </div>
      {board.err && <p className="warn-box small">{board.err}</p>}

      <Focus jobs={inRange} onOpen={openAt} />

      <section className="cs">
        <div className="cs-h">
          <span className="cs-ic"><Icon n="clock" size={15} /></span><h3>{tr('时间线')}</h3>
          <Legend states={['running', 'done', 'failed', 'cancelled']} />
          <span className="muted small">{tr('拖动框选放大 · 双击还原 · 点一个任务看详情')}</span>
        </div>
        {gjobs.length ? <Gantt jobs={gjobs} domain={[d0, d1]} now={now} onZoom={setZoom} onPick={openIn([...gjobs].sort((a, b) => a.start - b.start).map(x => x.id))} />
          : <p className="muted small">{jobs.length ? tr('这段时间里没有符合条件的任务。换一个时间范围试试。') : tr('这个项目还没有实验任务。代码员工会把实验提交到 nvidb（或者模拟电厂），到时候进度就在这里。')}</p>}
      </section>

      <Cluster mine={new Set(jobs.map(j => j.nvidb?.id).filter((x): x is number => x != null))} onOpen={openIn([])} />

      <JobViews jobs={shown} open={open?.id ?? null} onOpen={openAt} onData={p.onData} />

      {open && <JobDrawer id={open.id} onClose={() => setOpenAt(null)} onJob={id => setOpenAt(o => ({ id, list: o?.list ?? [] }))}
        nav={at >= 0 ? { prev: open.list[at - 1], next: open.list[at + 1] } : undefined} />}
    </div>
  );
}

// the newest results, what runs or waits now, and the newest failures, a few of each
function Focus({ jobs, onOpen: open }: { jobs: Job[]; onOpen: (id: string, list: string[]) => void }) {
  const fin = (j: Job) => endOf(j) || 0;
  const withRes = jobs.filter(j => stj(j) === 'done' && headline(resOf(j), 1).length).sort((a, b) => fin(b) - fin(a));
  const live = jobs.filter(j => stj(j) === 'running' || stj(j) === 'queued').sort((a, b) => +(stj(a) !== 'running') - +(stj(b) !== 'running') || startOf(b) - startOf(a));
  const failed = jobs.filter(j => stj(j) === 'failed').sort((a, b) => fin(b) - fin(a));
  if (!withRes.length && !live.length && !failed.length) return null;
  const list = [...withRes.slice(0, 3), ...live.slice(0, 3), ...failed.slice(0, 3)].map(j => j.id);
  const onOpen = (id: string) => open(id, list);
  const head = (s: St, name: string, n: number) => <h4><i className="tile-key" style={{ ['--c' as string]: ST[s].c }}>{ST[s].sign}</i>{name}<span>{n}</span></h4>;
  const when_ = (j: Job) => ago(j.nvidb?.finished_at ?? j.ended_at ?? j.nvidb?.started_at ?? j.started_at);
  return (
    <section className="focus">
      <div className="focus-h"><span className="cs-ic"><Icon n="eye" size={15} /></span><h3>{tr('先看这里')}</h3></div>
      <div className="focus-g">
        {withRes.length > 0 && (
          <div className="fc s-done">
            {head('done', tr('最新结果'), withRes.length)}
            {withRes.slice(0, 3).map(j => (
              <button key={j.id} className="fc-j" {...jobRef(j)} onClick={() => onOpen(j.id)}>
                <span className="fc-t"><b title={j.name}>{j.name}</b><em>{when_(j)}</em></span>
                <span className="fc-m">{headlines(resOf(j), 3).map(h => <span key={h.k} title={h.k}><strong>{fmtNum(h.v)}</strong><em>{h.name}</em></span>)}</span>
              </button>
            ))}
          </div>
        )}
        {live.length > 0 && (
          <div className="fc s-running">
            {head('running', tr('在跑和排队'), live.length)}
            {live.slice(0, 3).map(j => {
              const run = stj(j) === 'running', pct = run ? pctOf(j.nvidb?.progress) : null;
              return (
                <button key={j.id} className="fc-j" {...jobRef(j)} onClick={() => onOpen(j.id)}>
                  <span className="fc-t"><b title={j.name}>{j.name}</b><em>{run ? dur(j.nvidb?.elapsed_s) : ST.queued.label}</em></span>
                  {pct != null && <span className="fc-bar"><i style={{ width: `${Math.min(100, pct)}%` }} /></span>}
                  <span className="fc-s mono">{j.nvidb?.progress || placeOf(j)}</span>
                </button>
              );
            })}
          </div>
        )}
        {failed.length > 0 && (
          <div className="fc s-failed">
            {head('failed', tr('最近失败'), failed.length)}
            {failed.slice(0, 3).map(j => (
              <button key={j.id} className="fc-j" {...jobRef(j)} onClick={() => onOpen(j.id)}>
                <span className="fc-t"><b title={j.name}>{j.name}</b><em>{when_(j)}</em></span>
                <span className="fc-s mono" title={j.nvidb?.last_error}>{lineOf(j)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
