// The GPUs on your own machines, from nvidb: a card per machine and a tile per GPU, its
// memory split into what the queue's jobs hold, what other work holds, what is promised to
// jobs and what is left. Read only; jobs are still submitted with `nvidb job submit`.

import { useEffect, useState } from 'react';
import { api, type Gpu, type GpuStatus } from '../api';
import '../gpus.css';

const POLL = 10_000;
const STATE: Record<Gpu['state'], string> = { idle: '空闲', room: '有空', full: '满' };

export const gb = (mb: number) => mb >= 10240 ? `${Math.round(mb / 1024)}G` : `${(mb / 1024).toFixed(1)}G`;

function ago(ts: string | null | undefined) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
  return s < 60 ? `${Math.round(s)} 秒前` : s < 3600 ? `${Math.floor(s / 60)} 分钟前` : `${Math.floor(s / 3600)} 小时前`;
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
    <span className="mem" title={`队列任务 ${gb(g.queue_mem_mb)} · 其他程序 ${gb(g.external_mem_mb)} · 已预留未用 ${gb(promised)} · 可排 ${gb(g.free_mb)} / ${gb(g.mem_total_mb)}`}>
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
        <span>可排 <b>{gb(g.free_mb)}</b> / {gb(g.mem_total_mb)}</span>
        <span>{g.util_percent}%{g.temperature_c != null ? ` · ${g.temperature_c}°C` : ''}</span>
      </div>
      <div className="g-util" style={{ ['--u' as string]: g.util_percent / 100 }}><i /></div>
      <p className="g-who" title={who.join('\n')}>
        {who.length ? who.slice(0, 2).join('、') + (who.length > 2 ? ` 等 ${who.length} 个` : '') : '没有程序'}
        {g.attribution === 'blind' && <em title="这张卡的驱动（WSL）报不出各进程的显存，队列与其他程序的划分是估的"> · 估算</em>}
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
        <div><b>{s.gpus}</b><span>张卡</span></div>
        <div className="k-idle"><b>{s.idle}</b><span>空闲</span></div>
        <div className="k-room"><b>{s.room - s.idle}</b><span>还有空</span></div>
        <div><b>{gb(s.free_mb)}</b><span>可排显存</span></div>
        <div><b>{run}</b><span>在跑</span></div>
        <div><b>{wait}</b><span>排队</span></div>
      </div>
      <p className="muted small">
        nvidb · {s.up}/{s.nodes} 台在线 · {ago(g.ticked ?? g.at)}更新{g.alerts ? ` · ${g.alerts} 条告警没确认` : ''} · 只读，提交任务用 <code>nvidb job submit</code>
        {onFresh && <button className="lnk" onClick={onFresh}>刷新</button>}
      </p>
    </div>
  );
}

// the whole board: for the farm's details and the power plant
export function GpuBoard() {
  const polled = useGpus();
  const [fresh, setFresh] = useState<GpuStatus | null>(null);
  useEffect(() => setFresh(null), [polled]);
  const g = fresh ?? polled;
  if (!g) return <section className="gpus"><p className="muted small">正在读 nvidb…</p></section>;
  if (!g.ok) return <section className="gpus off"><h4>显卡 · nvidb</h4><p className="muted small">{g.note}</p></section>;
  return (
    <section className="gpus">
      <h4>显卡 · 本机能用的 GPU</h4>
      <Head g={g} onFresh={() => api.gpus(true).then(setFresh).catch(() => {})} />
      <div className="nodes">
        {g.nodes.map(n => (
          <div key={n.name} className={`node${n.state === 'up' ? '' : ' down'}`}>
            <div className="proj-top">
              <b>{n.name}</b>
              <span className={`pst ${n.state === 'up' ? 'pst-done' : 'pst-failed'}`}>{n.state === 'up' ? `${n.gpus.length} 张卡` : n.state}</span>
            </div>
            {n.last_error && n.state !== 'up' && <p className="warn-box small">{n.last_error}</p>}
            <div className="gpu-grid">{n.gpus.map((x, i) => <GpuTile key={x.index} g={x} i={i} />)}</div>
          </div>
        ))}
      </div>
      <div className="mem-key muted small">
        <span><i className="m-q" />队列任务</span><span><i className="m-x" />其他程序</span><span><i className="m-r" />已预留</span><span><i className="m-f" />可排</span>
      </div>
    </section>
  );
}

// one line of it, for the top of the farm's floor
export function GpuStrip() {
  const g = useGpus();
  if (!g) return null;
  if (!g.ok) return <div className="gstrip off"><b>显卡</b><span className="muted small">{g.note}</span></div>;
  const s = g.summary!;
  return (
    <div className="gstrip" title="来自 nvidb 的 GPU 队列；在「明细」里看每张卡">
      <b>显卡</b>
      <span className="small">{s.gpus} 张 · <em className="k-idle">{s.idle} 空闲</em> · 可排 {gb(s.free_mb)}</span>
      <span className="gs-cells">
        {g.nodes.filter(n => n.state === 'up').map(n => (
          <span key={n.name} className="gs-node" title={n.name}>
            {n.gpus.map(x => <i key={x.index} className={`gpu-${x.state}`} title={`${n.name}:${x.index} ${x.name} · ${STATE[x.state]} · 可排 ${gb(x.free_mb)} · ${x.util_percent}%`} />)}
          </span>
        ))}
      </span>
    </div>
  );
}
