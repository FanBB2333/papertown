// The GPUs on your own machines, from nvidb: a card per machine and a tile per GPU, its
// memory split into what the queue's jobs hold, what other work holds, what is promised to
// jobs and what is left; and one machine in full, with the lanes that feed each card. Read
// only; jobs are still submitted with `nvidb job submit`.

import { useEffect, useRef, useState } from 'react';
import { api, type Gpu, type GpuNode, type GpuStatus, type NvJob, type NvLane } from '../api';
import '../gpus.css';
import { tr } from '../i18n';

const POLL = 10_000;
const STATE: Record<Gpu['state'], string> = { idle: tr('空闲'), room: tr('有空'), full: tr('满') };

export const gb = (mb: number) => mb >= 10240 ? `${Math.round(mb / 1024)}G` : `${(mb / 1024).toFixed(1)}G`;

function ago(ts: string | null | undefined) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
  return s < 60 ? tr('{0} 秒前', Math.round(s)) : s < 3600 ? tr('{0} 分钟前', Math.floor(s / 60)) : tr('{0} 小时前', Math.floor(s / 3600));
}

// one reading every few seconds while the page is visible
export function useGpus() {
  const [g, setG] = useState<GpuStatus | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => { if (!document.hidden) api.gpus().then(x => live && setG(x)).catch(() => {}); };
    read();
    const t = setInterval(read, POLL);
    document.addEventListener('visibilitychange', read);
    return () => { live = false; clearInterval(t); document.removeEventListener('visibilitychange', read); };
  }, []);
  return g;
}

function MemBar({ g }: { g: Gpu }) {
  const t = Math.max(1, g.mem_total_mb);
  const promised = Math.max(0, g.reserved_mb - g.queue_mem_mb);
  const part = (mb: number) => `${Math.min(100, 100 * mb / t)}%`;
  return (
    <span className="mem" title={tr('队列任务 {0} · 其他程序 {1} · 已预留未用 {2} · 可排 {3} / {4}', gb(g.queue_mem_mb), gb(g.external_mem_mb), gb(promised), gb(g.free_mb), gb(g.mem_total_mb))}>
      <i className="m-q" style={{ width: part(g.queue_mem_mb) }} />
      <i className="m-x" style={{ width: part(g.external_mem_mb) }} />
      <i className="m-r" style={{ width: part(promised) }} />
    </span>
  );
}

function GpuTile({ g, i }: { g: Gpu; i: number }) {
  const who = g.procs.map(p => p.job_name ?? `${p.user ?? '?'} · ${p.name}`);
  return (
    <div className={`gpu gpu-${g.state}`} style={{ ['--i' as string]: i }}>
      <div className="g-top">
        <b>GPU {g.index}</b>
        <span className="g-st">{STATE[g.state]}</span>
      </div>
      <span className="g-name" title={g.name}>{g.name}</span>
      <MemBar g={g} />
      <div className="g-nums">
        <span>{tr('可排')} <b>{gb(g.free_mb)}</b> / {gb(g.mem_total_mb)}</span>
        <span>{g.util_percent}%{g.temperature_c != null ? ` · ${g.temperature_c}°C` : ''}</span>
      </div>
      <div className="g-util" style={{ ['--u' as string]: g.util_percent / 100 }}><i /></div>
      <p className="g-who" title={who.join('\n')}>
        {who.length ? who.slice(0, 2).join(tr('、')) + (who.length > 2 ? tr(' 等 {0} 个', who.length) : '') : tr('没有程序')}
        {g.attribution === 'blind' && <em title={tr('这张卡的驱动（WSL）报不出各进程的显存，队列与其他程序的划分是估的')}> {tr('· 估算')}</em>}
      </p>
    </div>
  );
}

function Head({ g, onFresh }: { g: GpuStatus; onFresh?: () => void }) {
  const s = g.summary!;
  const run = g.counts.running ?? 0, wait = g.counts.pending ?? 0;
  return (
    <div className="gpus-head">
      <div className="gpus-sum">
        <div><b>{s.gpus}</b><span>{tr('张卡')}</span></div>
        <div className="k-idle"><b>{s.idle}</b><span>{tr('空闲')}</span></div>
        <div className="k-room"><b>{s.room - s.idle}</b><span>{tr('还有空')}</span></div>
        <div><b>{gb(s.free_mb)}</b><span>{tr('可排显存')}</span></div>
        <div><b>{run}</b><span>{tr('在跑')}</span></div>
        <div><b>{wait}</b><span>{tr('排队')}</span></div>
      </div>
      <p className="muted small">
        nvidb · {s.up}/{s.nodes} {tr('台在线 ·')} {ago(g.ticked ?? g.at)}{tr('更新')}{g.alerts ? tr(' · {0} 条告警没确认', g.alerts) : ''} {tr('· 只读，提交任务用')} <code>nvidb job submit</code>
        {onFresh && <button className="lnk" onClick={onFresh}>{tr('刷新')}</button>}
      </p>
    </div>
  );
}

// the whole board: for the farm's details and the power plant. focus `node:<name>` (or
// `node:<name>/<gpu>`) opens that machine straight away, as its cabinet in the 3D walk does
export function GpuBoard({ focus }: { focus?: string | null }) {
  const polled = useGpus();
  const [fresh, setFresh] = useState<GpuStatus | null>(null);
  useEffect(() => setFresh(null), [polled]);
  const want = /^node:(.+?)(?:\/(\d+))?$/.exec(focus ?? '');
  const [open, setOpen] = useState<{ name: string; gpu: number | null } | null>(want ? { name: want[1], gpu: want[2] ? +want[2] : null } : null);
  const g = fresh ?? polled;
  if (!g) return <section className="gpus"><p className="muted small">{tr('正在读 nvidb…')}</p></section>;
  if (!g.ok) return <section className="gpus off"><h4>{tr('显卡 · nvidb')}</h4><p className="muted small">{g.note}</p></section>;
  const node = open && g.nodes.find(n => n.name === open.name);
  if (node) return <section className="gpus"><NodeDetail g={g} n={node} gpu={open.gpu} onBack={() => setOpen(null)} /></section>;
  return (
    <section className="gpus">
      <h4>{tr('显卡 · 本机能用的 GPU')}</h4>
      <Head g={g} onFresh={() => api.gpus(true).then(setFresh).catch(() => {})} />
      <div className="nodes">
        {g.nodes.map(n => (
          <div key={n.name} className={`node${n.state === 'up' ? '' : ' down'}`}>
            <div className="proj-top">
              <b>{n.name}</b>
              <span className="node-q muted small">{nodeLine(g, n)}</span>
              <span className={`pst ${n.state === 'up' ? 'pst-done' : 'pst-failed'}`}>{n.state === 'up' ? tr('{0} 张卡', n.gpus.length) : n.state}</span>
              <button className="lnk" onClick={() => setOpen({ name: n.name, gpu: null })}>{tr('详情')} →</button>
            </div>
            {n.last_error && n.state !== 'up' && <p className="warn-box small">{n.last_error}</p>}
            <div className="gpu-grid">{n.gpus.map((x, i) => <GpuTile key={x.index} g={x} i={i} />)}</div>
          </div>
        ))}
      </div>
      <div className="mem-key muted small">
        <span><i className="m-q" />{tr('队列任务')}</span><span><i className="m-x" />{tr('其他程序')}</span><span><i className="m-r" />{tr('已预留')}</span><span><i className="m-f" />{tr('可排')}</span>
      </div>
    </section>
  );
}

// one line of it, for the top of the farm's floor
export function GpuStrip() {
  const g = useGpus();
  if (!g) return null;
  if (!g.ok) return <div className="gstrip off"><b>{tr('显卡')}</b><span className="muted small">{g.note}</span></div>;
  const s = g.summary!;
  return (
    <div className="gstrip" title={tr('来自 nvidb 的 GPU 队列；在「明细」里看每张卡')}>
      <b>{tr('显卡')}</b>
      <span className="small">{s.gpus} {tr('张 ·')} <em className="k-idle">{s.idle} {tr('空闲')}</em> {tr('· 可排')} {gb(s.free_mb)}</span>
      <span className="gs-cells">
        {g.nodes.filter(n => n.state === 'up').map(n => (
          <span key={n.name} className="gs-node" title={n.name}>
            {n.gpus.map(x => <i key={x.index} className={`gpu-${x.state}`} title={tr('{0}:{1} {2} · {3} · 可排 {4} · {5}%', n.name, x.index, x.name, STATE[x.state], gb(x.free_mb), x.util_percent)} />)}
          </span>
        ))}
      </span>
    </div>
  );
}

// ---------- one machine in full ----------

const JOB_ST: Record<string, [string, string]> = {
  running: [tr('在跑'), 'pst-running'], pending: [tr('排队'), ''], held: [tr('被卡住'), 'pst-failed'], completed: [tr('完成'), 'pst-done'],
  failed: [tr('失败'), 'pst-failed'], lost: [tr('丢失'), 'pst-failed'], timeout: [tr('超时'), 'pst-failed'], cancelled: [tr('已取消'), ''],
};
const span = (s: number) => s < 90 ? tr('{0} 秒', Math.round(s)) : s < 5400 ? tr('{0} 分钟', Math.round(s / 60)) : tr('{0} 小时', (s / 3600).toFixed(1));

// what runs and waits on a machine, for its card on the board
function nodeLine(g: GpuStatus, n: GpuNode) {
  const run = g.jobs.filter(j => j.state === 'running' && j.node === n.name).length;
  const wait = (g.lanes ?? []).filter(l => l.node === n.name).reduce((a, l) => a + l.queued.length, 0);
  return run || wait ? tr('在跑 {0} · 队列里 {1}', run, wait) : '';
}

function where(j: NvJob) {
  if (j.node) return `${j.node}:${j.gpu_ids.join(',')}`;
  if (j.lane) return tr('队列 {0}', j.lane);
  if (j.pool) return tr('卡池 {0}', j.pool);
  return j.node_constraint ? tr('等 {0} 上有空', j.node_constraint) : tr('等任意一张卡有空');
}

// one job, opened for its note and command; pos: its place in a lane; on: the card it could go to
function JobRow({ j, pos, on }: { j: NvJob; pos?: number; on?: Gpu }) {
  const [label, cls] = JOB_ST[j.held ? 'held' : j.state] ?? [j.state, ''];
  const cards = j.gpus ?? 1;
  const meta = [j.vram_mb ? gb(j.vram_mb) : tr('不预留显存'), cards > 1 ? tr('{0} 张卡', cards) : '', j.submitter ?? '',
    j.state === 'running' ? (j.elapsed_s != null ? tr('跑了 {0}', span(j.elapsed_s)) : '') : j.created_at ? tr('{0}提交', ago(j.created_at)) : ''];
  return (
    <details className="nd-job">
      <summary>
        <div className="nd-l1">
          {pos != null && <span className="nd-pos" title={tr('在这条队列里排第 {0}', pos)}>{pos}</span>}
          <b>#{j.id}</b><span className="nd-jn" title={j.name}>{j.name}</span>
        </div>
        <div className="nd-l2">
          <span className={`pst ${cls}`}>{label}</span>
          {on && <span className={`nd-fit${j.vram_mb <= on.free_mb ? ' ok' : ''}`}>{j.vram_mb <= on.free_mb ? tr('现在放得下') : tr('还差 {0}', gb(j.vram_mb - on.free_mb))}</span>}
          <span className="nd-meta">{meta.filter(Boolean).join(' · ')}</span>
        </div>
        {j.state === 'running' && j.progress && <div className="nd-prog" title={j.progress}>{j.progress}</div>}
      </summary>
      <dl className="kv">
        <dt>{tr('位置')}</dt><dd>{where(j)}</dd>
        {j.held_reason && <><dt>{tr('卡在')}</dt><dd className="warn">{j.held_reason}</dd></>}
        {!!j.depends_on?.length && <><dt>{tr('等这些')}</dt><dd>{j.depends_on.map(d => `#${d}`).join(' ')}</dd></>}
        {j.gpu_mem_mb != null && <><dt>{tr('实际显存')}</dt><dd>{gb(j.gpu_mem_mb)}</dd></>}
        {j.max_runtime_s != null && <><dt>{tr('限时')}</dt><dd>{span(j.max_runtime_s)}</dd></>}
        {!!j.priority && <><dt>{tr('优先级')}</dt><dd>{j.priority}</dd></>}
        {j.workdir && <><dt>{tr('目录')}</dt><dd className="brk">{j.workdir}</dd></>}
      </dl>
      {j.notes && <p className="nv-notes small">{j.notes}</p>}
      {j.command && <pre className="nd-cmd">{j.command}</pre>}
    </details>
  );
}

// a machine: its lanes, then each card with what runs on it, what waits in its lanes in
// running order, and the jobs not yet given a card that it could take
function NodeDetail({ g, n, gpu, onBack }: { g: GpuStatus; n: GpuNode; gpu: number | null; onBack: () => void }) {
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = gpu != null ? top.current?.querySelector(`[data-gpu="${gpu}"]`) : top.current;
    el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [n.name, gpu]);
  useEffect(() => { // Esc closes this before the room
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); onBack(); } };
    addEventListener('keydown', k, true);
    return () => removeEventListener('keydown', k, true);
  }, [onBack]);
  const byId = new Map(g.jobs.map(j => [j.id, j]));
  const lanes = (g.lanes ?? []).filter(l => l.node === n.name);
  const mine = (pre: string | null | undefined) => !!pre && n.name.startsWith(pre); // nvidb matches node names by prefix
  const running = g.jobs.filter(j => j.state === 'running' && j.node === n.name);
  const inPool = (pool: string, i: number) => !!g.pools?.find(p => p.name === pool)?.members.some(m => m.node === n.name && m.gpus.includes(i));
  const loose = g.jobs.filter(j => j.state === 'pending' && !j.lane && !j.held && (j.gpus ?? 1) > 0)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id - b.id);
  const could = (x: Gpu) => loose.filter(j => (!j.node_constraint || mine(j.node_constraint)) && (!j.gpu_constraint?.length || j.gpu_constraint.includes(x.index))
    && (!j.pool || inPool(j.pool, x.index)) && (j.gpus ?? 1) <= n.gpus.length && j.vram_mb <= x.mem_total_mb);
  const held = g.jobs.filter(j => j.held && j.state === 'pending' && !j.lane && mine(j.node_constraint));
  const total = n.gpus.reduce((a, x) => a + x.mem_total_mb, 0), free = n.gpus.reduce((a, x) => a + x.free_mb, 0);
  const util = n.gpus.length ? Math.round(n.gpus.reduce((a, x) => a + x.util_percent, 0) / n.gpus.length) : 0;
  const laneState = (l: NvLane): [string, string] => l.paused ? [tr('暂停'), 'pst-paused'] : l.blocked ? [tr('卡住了'), 'pst-failed']
    : l.running.length ? [tr('在跑'), 'pst-running'] : l.queued.length ? [tr('待启动'), 'pst-waiting'] : [tr('空着'), ''];
  const jobsOf = (ids: number[]) => ids.map(id => byId.get(id)).filter((j): j is NvJob => !!j);
  const stuck = held.length + lanes.flatMap(l => jobsOf(l.queued)).filter(j => j.held).length; // in its lanes too
  return (
    <div className="nd" ref={top}>
      <div className="nd-head">
        <button className="btn" onClick={onBack}><span aria-hidden>←</span> {tr('全部机器')} <kbd>Esc</kbd></button>
        <div className="nd-title">
          <h4>{n.name}</h4>
          <p className="muted small">{[tr('{0} 张卡', n.gpus.length), tr('平均利用率 {0}%', util), tr('可排 {0} / {1}', gb(free), gb(total)),
            n.last_seen ? tr('{0}更新', ago(n.last_seen)) : ''].filter(Boolean).join(' · ')}</p>
        </div>
        <span className={`pst ${n.state === 'up' ? 'pst-done' : 'pst-failed'}`}>{n.state === 'up' ? tr('在线') : n.state}{n.enabled ? '' : tr(' · 不再派新任务')}</span>
      </div>
      {n.last_error && n.state !== 'up' && <p className="warn-box small">{n.last_error}</p>}
      <div className="gpus-sum">
        <div><b>{running.length}</b><span>{tr('在跑')}</span></div>
        <div><b>{lanes.reduce((a, l) => a + l.queued.length, 0)}</b><span>{tr('队列里')}</span></div>
        <div><b>{lanes.length}</b><span>{tr('条队列', lanes.length)}</span></div>
        <div className={stuck ? 'k-room' : ''}><b>{stuck}</b><span>{tr('被卡住')}</span></div>
      </div>

      <h5 className="nd-h">{tr('队列（lane）')}</h5>
      {lanes.length ? (
        <div className="nd-lanes">
          {lanes.map(l => {
            const [t, c] = laneState(l);
            return (
              <div key={l.name} className="nd-lane">
                <b>{l.name}</b><span className={`pst ${c}`}>{t}</span>
                <span className="muted small">{tr('卡 {0}', l.gpu_ids.join(', '))}{l.concurrency > 1 ? tr(' · 同时跑 {0} 个', l.concurrency) : ''} · {tr('在跑 {0} · 排队 {1}', l.running.length, l.queued.length)}</span>
                {l.blocked && !l.paused && <span className="nd-why small">{l.blocked}</span>}
              </div>
            );
          })}
        </div>
      ) : <p className="muted small">{tr('这台机器还没有队列：提交任务时加 --lane 才会排进去')}</p>}

      <h5 className="nd-h">{tr('每张卡')}</h5>
      <div className="nd-gpus">
        {n.gpus.map((x, i) => {
          const now = running.filter(j => j.gpu_ids.includes(x.index));
          const other = x.procs.filter(p => !p.managed);
          const feed = lanes.filter(l => l.gpu_ids.includes(x.index) && l.queued.length);
          const cand = could(x);
          return (
            <div key={x.index} className={`nd-gpu${gpu === x.index ? ' hot' : ''}`} data-gpu={x.index}>
              <GpuTile g={x} i={i} />
              <div className="nd-groups">
                <div>
                  <h6>{tr('正在跑')}</h6>
                  {now.map(j => <JobRow key={j.id} j={j} />)}
                  {other.map((p, k) => <div key={k} className="nd-proc"><span>{p.user ?? '?'} · {p.name}</span><span className="muted">{gb(p.mem_mb)} · {tr('不是队列的')}</span></div>)}
                  {!now.length && !other.length && <p className="muted small">{tr('没有任务')}</p>}
                </div>
                <div>
                  <h6>{tr('排在这张卡的队列里')}</h6>
                  {feed.map(l => (
                    <div key={l.name} className="nd-feed">
                      <span className="nd-lname">{l.name}{l.paused ? tr(' · 暂停') : ''}</span>
                      {jobsOf(l.queued).map((j, k) => <JobRow key={j.id} j={j} pos={k + 1} />)}
                    </div>
                  ))}
                  {!feed.length && <p className="muted small">{tr('没有排队的任务')}</p>}
                </div>
                <div>
                  <h6>{tr('还能派到这里')}</h6>
                  {cand.slice(0, 5).map(j => <JobRow key={j.id} j={j} on={x} />)}
                  {cand.length > 5 && <p className="muted small">{tr('还有 {0} 个', cand.length - 5)}</p>}
                  {!cand.length && <p className="muted small">{tr('没有等分配、放得进这张卡的任务')}</p>}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {held.length > 0 && <>
        <h5 className="nd-h">{tr('指定这台机器、但被卡住的任务')}</h5>
        <div className="nd-held">{held.map(j => <JobRow key={j.id} j={j} />)}</div>
      </>}
      <p className="muted small nd-foot">{tr('只读。调顺序、暂停队列、放行被卡住的任务，用 nvidb 的命令：')}<code>nvidb queue lanes --node {n.name}</code></p>
    </div>
  );
}
