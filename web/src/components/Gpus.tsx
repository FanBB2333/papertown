// The GPUs on your own machines, read only from nvidb: a card per machine, a tile per GPU,
// and one machine in full with the lanes that feed each card.

import { figures, modelText, StateWord } from '../emphasis';
import { useEffect, useRef, useState } from 'react';
import { api, type Gpu, type GpuNode, type GpuStatus, type NvJob, type NvLane } from '../api';
import { stOf, type St } from '../console/charts';
import { dur } from '../console/util';
import '../gpus.css';
import { tr } from '../i18n';

const POLL = 5_000; // the server reads nvidb in the background; this only picks up its latest reading
const STATE: Record<Gpu['state'], string> = { idle: tr('空闲'), room: tr('有空'), full: tr('满') };

export const gb = (mb: number) => mb >= 10240 ? `${Math.round(mb / 1024)}G` : `${(mb / 1024).toFixed(1)}G`;

function ago(ts: string | null | undefined) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
  return s < 60 ? tr('{0} 秒前', Math.round(s)) : s < 3600 ? tr('{0} 分钟前', Math.floor(s / 60)) : tr('{0} 小时前', Math.floor(s / 3600));
}

// One reading shared by every view that shows the cards, polled while the page is visible.
let last: GpuStatus | null = null;
let timer = 0;
const subs = new Set<(g: GpuStatus) => void>();
const deal = (g: GpuStatus) => { last = g; subs.forEach(f => f(g)); };
const read = () => { if (!document.hidden) api.gpus().then(deal).catch(() => {}); };
export const refreshGpus = () => api.gpus(true).then(deal).catch(() => {});

export function useGpus() {
  const [g, setG] = useState<GpuStatus | null>(last);
  useEffect(() => {
    subs.add(setG);
    if (subs.size === 1) {
      read();
      timer = window.setInterval(read, POLL);
      document.addEventListener('visibilitychange', read);
    } else if (last) setG(last);
    return () => {
      subs.delete(setG);
      if (!subs.size) { clearInterval(timer); document.removeEventListener('visibilitychange', read); }
    };
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
        <span className={g.state === 'full' ? 'g-st em-state' : 'g-st'} data-tone="warn">{STATE[g.state]}</span>
      </div>
      <span className="g-name" title={g.name}>{g.name}</span>
      <MemBar g={g} />
      <div className="g-nums">
        <span>{tr('可排')} <b className="em-num" data-tone={g.free_mb ? 'info' : 'warn'}>{gb(g.free_mb)}</b> / {gb(g.mem_total_mb)}</span>
        <span><b className="em-num">{g.util_percent}%</b>{g.temperature_c != null ? ` · ${g.temperature_c}°C` : ''}</span>
      </div>
      <div className="g-util" style={{ ['--u' as string]: g.util_percent / 100 }}><i /></div>
      <p className="g-who" title={who.join('\n')}>
        {who.length ? who.slice(0, 2).join(tr('、')) + (who.length > 2 ? tr(' 等 {0} 个', who.length) : '') : tr('暂无程序')}
        {g.attribution === 'blind' && <em title={tr('此卡驱动（WSL）无法报告各进程显存，队列与其他程序划分为估算值')}> {tr('· 估算')}</em>}
      </p>
    </div>
  );
}

function Head({ g }: { g: GpuStatus }) {
  const s = g.summary!;
  const run = g.counts.running ?? 0, wait = g.counts.pending ?? 0;
  return (
    <div className="gpus-head">
      <div className="gpus-sum">
        <div><b>{s.gpus}</b><span>{tr('张卡')}</span></div>
        <div><b className="em-num" data-tone={s.idle ? 'good' : 'info'}>{s.idle}</b><span>{tr('空闲')}</span></div>
        <div><b className="em-num">{s.room - s.idle}</b><span>{tr('有余量')}</span></div>
        <div><b className="em-num">{gb(s.free_mb)}</b><span>{tr('可排显存')}</span></div>
        <div><b className="em-num">{run}</b><span>{tr('运行中')}</span></div>
        <div><b className="em-num">{wait}</b><span>{tr('排队')}</span></div>
      </div>
      <p className="muted small">
        nvidb · <span className="em-num" data-tone={s.up < s.nodes ? 'warn' : 'info'}>{s.up}/{s.nodes}</span> {tr('台在线 ·')} {ago(g.ticked ?? g.at)}{tr('更新')}{g.alerts ? <span className="em-bar" data-tone="warn">{tr('· {0} 条告警未确认', g.alerts)}</span> : ''} {tr('· 只读，提交任务：')} <code>nvidb job submit</code>
        <button className="lnk" onClick={refreshGpus}>{tr('刷新')}</button>
      </p>
    </div>
  );
}

// focus `node:<name>` or `node:<name>/<gpu>` opens that machine straight away
export function GpuBoard({ focus }: { focus?: string | null }) {
  const g = useGpus();
  const want = /^node:(.+?)(?:\/(\d+))?$/.exec(focus ?? '');
  const [open, setOpen] = useState<{ name: string; gpu: number | null } | null>(want ? { name: want[1], gpu: want[2] ? +want[2] : null } : null);
  if (!g) return <section className="gpus"><p className="muted small">{tr('读取 nvidb 中…')}</p></section>;
  if (!g.ok) return <section className="gpus off"><h4>{tr('显卡 · nvidb')}</h4><p className="small em-state" data-tone="bad">{g.note}</p></section>;
  const node = open && g.nodes.find(n => n.name === open.name);
  if (node) return <section className="gpus"><NodeDetail g={g} n={node} gpu={open.gpu} onBack={() => setOpen(null)} /></section>;
  return (
    <section className="gpus">
      <h4>{tr('显卡 · 本机可用 GPU')}</h4>
      <Head g={g} />
      <div className="nodes">
        {g.nodes.map(n => (
          <div key={n.name} className={`node${n.state === 'up' ? '' : ' down'}`}>
            <div className="proj-top">
              <b>{n.name}</b>
              <span className="node-q muted small">{figures(nodeLine(g, n))}</span>
              <span className={n.state === 'up' ? 'muted small' : 'em-state small'} data-tone="bad">{n.state === 'up' ? tr('{0} 张卡', n.gpus.length) : n.state}</span>
              <button className="lnk" onClick={() => setOpen({ name: n.name, gpu: null })}>{tr('详情')} →</button>
            </div>
            {n.last_error && n.state !== 'up' && <p className="small em-state" data-tone="bad">{n.last_error}</p>}
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

// the board in one line, for the top of the farm's floor
export function GpuStrip() {
  const g = useGpus();
  if (!g) return null;
  if (!g.ok) return <div className="gstrip off"><b>{tr('显卡')}</b><span className="small em-state" data-tone="bad">{g.note}</span></div>;
  const s = g.summary!;
  return (
    <div className="gstrip" title={tr('来自 nvidb 的 GPU 队列，在「明细」查看每张卡')}>
      <b>{tr('显卡')}</b>
      <span className="small">{s.gpus} {tr('张 ·')} <b className="em-num" data-tone={s.idle ? 'good' : 'info'}>{s.idle}</b> {tr('空闲')} {tr('· 可排')} <b className="em-num">{gb(s.free_mb)}</b></span>
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

const JOB_ST: Record<string, string> = {
  running: tr('运行中'), pending: tr('排队'), held: tr('已受阻'), completed: tr('完成'), failed: tr('失败'), lost: tr('丢失'), timeout: tr('超时'), cancelled: tr('已取消'),
};
const queued = (lanes: NvLane[]) => lanes.reduce((a, l) => a + l.queued.length, 0);

// nvidb does not record when an outside process started, so this counts from when Papertown
// first saw it ("at least" when it was already there then)
function seenFor(p: { seen_since?: string; earlier?: boolean }) {
  if (!p.seen_since) return '';
  const s = Math.max(0, (Date.now() - Date.parse(p.seen_since)) / 1000);
  return p.earlier ? tr('至少 {0}', dur(s)) : dur(s);
}

function nodeLine(g: GpuStatus, n: GpuNode) {
  const run = g.jobs.filter(j => j.state === 'running' && j.node === n.name).length;
  const wait = queued((g.lanes ?? []).filter(l => l.node === n.name));
  return run || wait ? tr('运行 {0} · 队列 {1}', run, wait) : '';
}

function where(j: NvJob) {
  if (j.node) return `${j.node}:${j.gpu_ids.join(',')}`;
  if (j.lane) return tr('队列 {0}', j.lane);
  if (j.pool) return tr('卡池 {0}', j.pool);
  return j.node_constraint ? tr('等待 {0} 空余', j.node_constraint) : tr('等待任一卡空余');
}

// the start the names in a list share, up to a separator, so each name can show what sets it apart
function shared(names: string[]) {
  if (names.length < 2) return '';
  let p = names[0];
  for (const n of names) while (p && !n.startsWith(p)) p = p.slice(0, -1);
  return p.slice(0, Math.max(...['-', '_', '/', '.'].map(c => p.lastIndexOf(c))) + 1);
}

// how far a running job says it is, when its status line counts ("step 1420/1744")
function progressOf(s: string | null | undefined) {
  const m = /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/.exec(s ?? '');
  const done = m ? +m[1] : 0, all = m ? +m[2] : 0;
  return all > 0 && done <= all ? done / all : null;
}

// one job, opened for its note and command; pos: its place in a lane; on: the card it could go to;
// pre: the start of the name its list shares; quiet: the state its list already says
function JobRow({ j, pos, on, pre = '', quiet }: { j: NvJob; pos?: number; on?: Gpu; pre?: string; quiet?: St }) {
  const word = JOB_ST[j.held ? 'held' : j.state] ?? j.state;
  const st: St = j.held ? 'failed' : stOf(j.state);
  const cards = j.gpus ?? 1;
  const run = j.state === 'running';
  const fit = on ? j.vram_mb <= on.free_mb : null;
  const pct = run ? progressOf(j.progress) : null;
  const own = pre && j.name.startsWith(pre) ? j.name.slice(pre.length) : '';
  return (
    <details className={`nd-job s-${st}`}>
      <summary>
        <div className="nd-l1">
          {pos != null && <span className="nd-pos" title={pos === 1 ? tr('下一个运行') : tr('该队列第 {0} 位', pos)}>{pos}</span>}
          <span className="nd-jn" title={j.name}>{own ? <><span className="nd-pre">{pre}</span><b>{own}</b></> : <b>{j.name}</b>}</span>
          <span className="nd-id">#{j.id}</span>
        </div>
        <div className="nd-l2">
          {st !== quiet && <StateWord state={j.held ? 'held' : j.state}>{word}</StateWord>}
          {on && <span className={fit ? 'muted' : 'em-state'} data-tone="warn">{fit ? tr('当前可容纳') : tr('尚缺 {0}', gb(j.vram_mb - on.free_mb))}</span>}
          <span className={j.vram_mb ? 'em-num' : 'muted'} title={tr('预留显存')}>{j.vram_mb ? gb(j.vram_mb) : tr('未预留显存')}</span>
          {cards > 1 && <span>{figures(tr('{0} 张卡', cards))}</span>}
          {run ? j.elapsed_s != null && <span className="nd-when">{tr('已运行 {0}', dur(j.elapsed_s))}</span>
            : j.created_at && <span className="nd-meta">{tr('{0}提交', ago(j.created_at))}</span>}
          {j.submitter && <span className="nd-meta nd-who" title={j.submitter}>{j.submitter}</span>}
        </div>
        {run && j.progress && (
          <div className="nd-prog" title={j.progress}>
            {pct != null && <><span className="nd-pbar"><i style={{ width: `${pct * 100}%` }} /></span><b className="em-num">{Math.round(pct * 100)}%</b></>}
            <span>{j.progress}</span>
          </div>
        )}
      </summary>
      <dl className="kv">
        <dt>{tr('位置')}</dt><dd>{where(j)}</dd>
        {j.held_reason && <><dt>{tr('卡在')}</dt><dd className="em-bar" data-tone="warn">{j.held_reason}</dd></>}
        {!!j.depends_on?.length && <><dt>{tr('等待前序')}</dt><dd>{j.depends_on.map(d => <span key={d} className="nd-dep">#{d}</span>)}</dd></>}
        {j.gpu_mem_mb != null && <><dt>{tr('实际显存')}</dt><dd className="em-num">{gb(j.gpu_mem_mb)}</dd></>}
        {j.max_runtime_s != null && <><dt>{tr('限时')}</dt><dd>{dur(j.max_runtime_s)}</dd></>}
        {!!j.priority && <><dt>{tr('优先级')}</dt><dd>{j.priority}</dd></>}
        {j.workdir && <><dt>{tr('目录')}</dt><dd className="brk">{j.workdir}</dd></>}
      </dl>
      {j.notes && <p className="nv-notes small">{modelText(j.notes)}</p>}
      {j.command && <pre className="nd-cmd">{j.command}</pre>}
    </details>
  );
}

// a machine: its lanes, then each card with what runs on it, what waits for it, and what it could take
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
  const laneState = (l: NvLane) => l.paused ? tr('暂停') : l.blocked ? tr('受阻') : l.running.length ? tr('运行中') : l.queued.length ? tr('待启动') : tr('空着');
  const jobsOf = (ids: number[]) => ids.map(id => byId.get(id)).filter((j): j is NvJob => !!j);
  const stuck = held.length + lanes.flatMap(l => jobsOf(l.queued)).filter(j => j.held).length;
  const heldPre = shared(held.map(j => j.name));
  return (
    <div className="nd" ref={top}>
      <div className="nd-head">
        <button className="btn" onClick={onBack}><span aria-hidden>←</span> {tr('全部机器')} <kbd>Esc</kbd></button>
        <div className="nd-title">
          <h4>{n.name}</h4>
          <p className="muted small">{tr('{0} 张卡', n.gpus.length)} · {figures(tr('平均利用率 {0}%', util))} · {figures(tr('可排 {0} / {1}', gb(free), gb(total)))}{n.last_seen && <> · {tr('{0}更新', ago(n.last_seen))}</>}</p>
        </div>
        <span className={n.state === 'up' ? 'muted small' : 'em-state small'} data-tone="bad">{n.state === 'up' ? tr('在线') : n.state}{n.enabled ? '' : tr(' · 不再派新任务')}</span>
      </div>
      {n.last_error && n.state !== 'up' && <p className="small em-state" data-tone="bad">{n.last_error}</p>}
      <div className="gpus-sum">
        <div><b className="em-num">{running.length}</b><span>{tr('运行中')}</span></div>
        <div><b className="em-num">{queued(lanes)}</b><span>{tr('队列里')}</span></div>
        <div><b>{lanes.length}</b><span>{tr('条队列', lanes.length)}</span></div>
        <div><b className={stuck ? 'em-num' : 'muted'} data-tone="bad">{stuck}</b><span>{tr('已受阻')}</span></div>
      </div>

      <h5 className="nd-h">{tr('队列（lane）')}<em>{lanes.length}</em></h5>
      {lanes.length ? (
        <div className="nd-lanes">
          {lanes.map(l => {
            const next = jobsOf(l.queued)[0];
            return (
              <div key={l.name} className="nd-lane">
                <b>{l.name}</b><StateWord state={l.paused ? 'held' : l.blocked ? 'blocked' : undefined}>{laneState(l)}</StateWord>
                <span className="nd-lnum">{tr('卡 {0}', l.gpu_ids.join(', '))}{l.concurrency > 1 ? figures(tr('· 并发 {0} 个', l.concurrency)) : ''} · {figures(tr('运行 {0} · 排队 {1}', l.running.length, l.queued.length))}</span>
                {next && <span className="nd-next" title={next.name}><em>{tr('下一个')}</em><span>{next.name}</span><i>#{next.id}</i></span>}
                {l.blocked && !l.paused && <span className="nd-why small">{modelText(l.blocked)}</span>}
              </div>
            );
          })}
        </div>
      ) : <p className="muted small">{tr('此机器暂无队列，提交任务时指定 --lane 才能入队')}</p>}

      <h5 className="nd-h">{tr('每张卡')}<em>{n.gpus.length}</em></h5>
      <div className="nd-gpus">
        {n.gpus.map((x, i) => {
          const now = running.filter(j => j.gpu_ids.includes(x.index));
          const other = x.procs.filter(p => !p.managed);
          const feed = lanes.filter(l => l.gpu_ids.includes(x.index) && l.queued.length);
          const cand = could(x), shown = cand.slice(0, 5), shownPre = shared(shown.map(j => j.name));
          const fits = shown.some(j => j.vram_mb <= x.free_mb);
          return (
            <div key={x.index} className={`nd-gpu${gpu === x.index ? ' hot' : ''}`} data-gpu={x.index}>
              <GpuTile g={x} i={i} />
              <div className="nd-groups">
                <div>
                  <h6 className="nd-ch s-running"><i />{tr('运行中')}<em>{now.length + other.length}</em></h6>
                  {now.map(j => <JobRow key={j.id} j={j} quiet="running" />)}
                  {other.map((p, k) => <div key={k} className="nd-proc"><b>{p.user ?? '?'} · {p.name}</b><span className="muted">{gb(p.mem_mb)} · {tr('非队列占用')}{p.seen_since ? ` · ${seenFor(p)}` : ''}</span></div>)}
                  {!now.length && !other.length && <p className="muted small">{tr('没有任务')}</p>}
                </div>
                <div>
                  <h6 className="nd-ch s-queued"><i />{tr('在此卡队列中排队')}<em>{queued(feed)}</em></h6>
                  {feed.map(l => {
                    const js = jobsOf(l.queued), pre = shared(js.map(j => j.name));
                    return (
                      <div key={l.name} className="nd-feed">
                        <span className="nd-lname"><b>{l.name}</b>{l.paused ? tr(' · 暂停') : ''}</span>
                        {js.map((j, k) => <JobRow key={j.id} j={j} pos={k + 1} pre={pre} quiet="queued" />)}
                      </div>
                    );
                  })}
                  {!feed.length && <p className="muted small">{tr('暂无排队任务')}</p>}
                </div>
                <div>
                  <h6 className={`nd-ch ${!shown.length ? 's-queued' : fits ? 'c-ok' : 'c-warn'}`}><i />{tr('可调度至此')}<em>{cand.length}</em></h6>
                  {shown.map(j => <JobRow key={j.id} j={j} on={x} pre={shownPre} quiet="queued" />)}
                  {cand.length > 5 && <p className="muted small">{tr('还有 {0} 个', cand.length - 5)}</p>}
                  {!cand.length && <p className="muted small">{tr('暂无等分配且此卡可容纳的任务')}</p>}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {held.length > 0 && <>
        <h5 className="nd-h">{tr('指定此机器的受阻任务')}</h5>
        <div className="nd-held">{held.map(j => <JobRow key={j.id} j={j} pre={heldPre} quiet="failed" />)}</div>
      </>}
      <p className="muted small nd-foot">{tr('只读。调整顺序、暂停队列、放行受阻任务，使用 nvidb 命令：')}<code>nvidb queue lanes --node {n.name}</code></p>
    </div>
  );
}
