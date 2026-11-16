// The cluster, live and read only: every card nvidb knows, who is on it and what is lined up for
// it, by card or by person, then what waits for a card.

import { useMemo, useState } from 'react';
import type { Gpu, GpuNode, GpuProc, GpuStatus, NvJob } from '../api';
import { gb, refreshGpus, useGpus } from '../components/Gpus';
import { tr } from '../i18n';
import { Meter, SPARK, ST, Spark, Tip, useNow, useTip, when, type St } from './charts';
import { Icon } from './icons';
import { t } from './jobs';
import { usePanelNote } from './page';
import { dur, pctOf, toggled } from './util';

interface Props { mine: Set<number>; onOpen: (id: string) => void }

// someone on a card: a queue job, or one person's run of one program the queue did not start
interface Occ {
  key: string; kind: 'job' | 'ext'; user: string; what: string; mem: number; since: number | null; atLeast: boolean;
  job?: NvJob; procs: GpuProc[]; node: string; gpu: number;
}

// thor-CloudRendering-f0825767cd50… → thor-CloudRendering
const prog = (name: string) => name.replace(/-[0-9a-f]{12,}$/i, '');

function occupants(g: GpuStatus, n: GpuNode, x: Gpu): Occ[] {
  const out: Occ[] = [];
  const jobs = g.jobs.filter(j => j.state === 'running' && j.node === n.name && j.gpu_ids.includes(x.index));
  for (const j of jobs) {
    const ps = x.procs.filter(p => p.job_id === j.id);
    out.push({ key: `j${j.id}`, kind: 'job', user: ps[0]?.user ?? j.submitter ?? '?', what: j.name, mem: ps.reduce((a, p) => a + p.mem_mb, 0),
      since: t(j.started_at), atLeast: false, job: j, procs: ps, node: n.name, gpu: x.index });
  }
  const rest = new Map<string, GpuProc[]>();
  for (const p of x.procs) {
    if (p.job_id != null && jobs.some(j => j.id === p.job_id)) continue;
    const k = `${p.user ?? '?'}\u0000${p.managed ? p.job_name ?? p.name : prog(p.name)}`;
    rest.set(k, [...(rest.get(k) ?? []), p]);
  }
  for (const [k, ps] of rest) {
    const firsts = ps.map(p => t(p.seen_since)).filter(Number.isFinite);
    out.push({ key: `x${k}`, kind: ps[0].managed ? 'job' : 'ext', user: ps[0].user ?? '?', mem: ps.reduce((a, p) => a + p.mem_mb, 0),
      what: (ps[0].managed ? ps[0].job_name ?? prog(ps[0].name) : prog(ps[0].name)) + (ps.length > 1 ? ` ×${ps.length}` : ''),
      since: firsts.length ? Math.min(...firsts) : null, atLeast: ps.some(p => p.earlier), procs: ps, node: n.name, gpu: x.index });
  }
  return out.sort((a, b) => b.mem - a.mem);
}

// a job's time from its start, anything else's from when Papertown first saw it ("≥" if already there)
const lasted = (o: Occ, now: number) => (o.since == null || !Number.isFinite(o.since) ? '—'
  : `${o.atLeast ? '≥ ' : ''}${dur(Math.max(0, (now - o.since) / 1000))}`);
const secsAgo = (ms: number) => (ms < 90e3 ? tr('{0} 秒前', Math.max(0, Math.round(ms / 1000))) : ms < 5400e3 ? tr('{0} 分钟前', Math.round(ms / 60e3)) : tr('{0} 小时前', (ms / 3600e3).toFixed(1)));

export function Cluster({ mine, onOpen }: Props) {
  const g = useGpus();
  const now = useNow();
  const [view, setView] = useState<'cards' | 'people'>(() => { try { return localStorage.getItem('papertown.exp.cluster') === 'people' ? 'people' : 'cards'; } catch { return 'cards'; } });
  const pick = (v: 'cards' | 'people') => { setView(v); try { localStorage.setItem('papertown.exp.cluster', v); } catch { /* private mode */ } };
  const [onlyMine, setOnlyMine] = useState(false);
  usePanelNote('exp', 'gpus', { GPU与队列: view === 'people' ? '按使用者看' : '按卡看', 只看这个项目: onlyMine ? '是' : null });
  const [hover, setHover] = useState<number | null>(null);
  const tip = useTip();
  const byId = useMemo(() => new Map((g?.jobs ?? []).map(j => [j.id, j])), [g]);
  const lit = useMemo(() => {
    if (hover == null) return null;
    const s = new Set<number>([hover]);
    const up = (id: number, d: number) => { for (const x of byId.get(id)?.depends_on ?? []) if (!s.has(x) && d < 6) { s.add(x); up(x, d + 1); } };
    const down = (id: number, d: number) => { for (const j of byId.values()) if (j.depends_on?.includes(id) && !s.has(j.id) && d < 6) { s.add(j.id); down(j.id, d + 1); } };
    up(hover, 0); down(hover, 0);
    return s;
  }, [hover, byId]);

  const head = <span className="cs-ic"><Icon n="gpu" size={15} /></span>;
  if (!g || !g.ok) return <section className="cs"><div className="cs-h">{head}<h3>{tr('GPU 与队列')}</h3></div><p className="muted small">{g ? g.note : tr('正在读 nvidb…')}</p></section>;

  const up = g.nodes.filter(n => n.state === 'up');
  const probed = Math.max(...up.map(n => t(n.probed_at ?? n.last_seen)).filter(Number.isFinite), 0);
  const age = probed ? now - probed : NaN;
  const stale = !Number.isFinite(age) || age > 120e3;
  const running = g.jobs.filter(j => j.state === 'running').length, pending = g.jobs.filter(j => j.state === 'pending').length;
  const ctx: Ctx = { g, now, mine, lit, hover, setHover, onOpen, tip };

  return (
    <section className="cs queue cl">
      <div className="cs-h">
        {head}<h3>{tr('GPU 与队列')}</h3>
        <span className={`live${stale ? ' stale' : ''}`} title={tr('nvidb 的 keeper 定时去各台机器读卡；Papertown 每 {0} 秒从 nvidb 取一次最新的读数', g.poll_s ?? 10)}>
          <i />{stale ? (probed ? tr('nvidb 已经 {0} 没有新读数', dur(age / 1000)) : tr('还没有读数')) : tr('实时 · {0}读的卡', secsAgo(age))}
        </span>
        <button className="ib" onClick={refreshGpus} title={tr('现在就从 nvidb 取一次')}><Icon n="refresh" size={14} /></button>
        <div className="seg mini cl-sw">
          <button className={view === 'cards' ? 'on' : ''} onClick={() => pick('cards')}>{tr('按卡')}</button>
          <button className={view === 'people' ? 'on' : ''} onClick={() => pick('people')}>{tr('按使用者')}</button>
        </div>
      </div>
      <p className="cl-sum muted small">
        {tr('{0} 张卡 · {1} 张还放得下 · {2} 个在跑 · {3} 个排队', g.summary?.gpus ?? 0, g.summary?.room ?? 0, running, pending)}
        {g.alerts ? <span className="warn-t"> · {tr('{0} 条告警没确认', g.alerts)}</span> : null}
        <label className={`qb-mine${mine.size ? '' : ' off'}`} title={mine.size ? '' : tr('这个项目眼下没有任务在队列里')}>
          <input type="checkbox" checked={onlyMine} disabled={!mine.size} onChange={e => setOnlyMine(e.target.checked)} />{tr('只看这个项目')}
        </label>
      </p>
      {view === 'cards' ? <ByCard ctx={ctx} onlyMine={onlyMine} /> : <ByPerson ctx={ctx} onlyMine={onlyMine} />}
      {view === 'cards' && <Waiting ctx={ctx} onlyMine={onlyMine} />}
      <Tip tip={tip.tip} />
    </section>
  );
}

interface Ctx {
  g: GpuStatus; now: number; mine: Set<number>; lit: Set<number> | null; hover: number | null; setHover: (id: number | null) => void;
  onOpen: (id: string) => void; tip: ReturnType<typeof useTip>;
}

function ByCard({ ctx, onlyMine }: { ctx: Ctx; onlyMine: boolean }) {
  const { g, now, mine } = ctx;
  const [shut, setShut] = useState<Set<string>>(new Set());
  const first = Math.min(...g.nodes.flatMap(n => n.gpus.map(x => x.trend?.[0]?.[0] ?? Infinity)));
  const span = Math.max(600, Math.min(3600, Number.isFinite(first) ? now / 1000 - first + 30 : 600));
  const lanes = g.lanes ?? [];
  const next = (node: string, gpu: number) => lanes.filter(l => l.node === node && l.gpu_ids[0] === gpu).flatMap(l => l.queued);
  return (
    <>
      <div className="qb-key muted small">
        <span><i className="cl-k from-q" />{tr('队列里的任务（底色是进度）')}</span><span><i className="cl-k outside" />{tr('队列以外的程序')}</span>
        <span><i className="qk mine" />{tr('这个项目的')}</span>
        <span><i className="cl-k line" style={{ background: SPARK.util }} />{tr('利用率')}</span><span><i className="cl-k area" style={{ background: SPARK.mem }} />{tr('显存占用')}</span>
        <span>{tr('曲线：近 {0} 分钟', Math.round(span / 60))}</span>
      </div>
      {g.nodes.map(n => {
        const all = n.gpus.map(x => ({ x, occ: occupants(g, n, x), queued: next(n.name, x.index) }))
          .filter(r => !onlyMine || r.occ.some(o => o.job && mine.has(o.job.id)) || r.queued.some(id => mine.has(id)));
        const quiet = (r: typeof all[number]) => !r.occ.length && !r.queued.length && r.x.util_percent < 5 && r.x.mem_used_mb < 0.02 * r.x.mem_total_mb;
        const rows = all.filter(r => !quiet(r)), idle = all.filter(quiet);
        if (onlyMine && !all.length) return null;
        const closed = shut.has(n.name);
        const users = new Set(all.flatMap(r => r.occ.map(o => o.user)));
        const p = t(n.probed_at ?? n.last_seen);
        return (
          <div key={n.name} className={`qb-node${n.state === 'up' ? '' : ' down'}`}>
            <button className={`qb-nh${closed ? '' : ' open'}`} onClick={() => setShut(s => toggled(s, n.name))}>
              <Icon n="chevron" size={13} className="tr-chev" /><i className="qb-dot" /><b>{n.name}</b>
              {n.state === 'up' ? <>
                <span className="qb-pill">{tr('{0} 张卡', n.gpus.length)}</span>
                <span className={`qb-pill${users.size ? ' busy' : ''}`}>{tr('{0} 个人在用', users.size)}</span>
                {all.some(r => r.occ.some(o => o.job && mine.has(o.job.id))) && <span className="qb-pill mine">{tr('有这个项目的')}</span>}
              </> : <span className="qb-pill">{n.state}</span>}
              {Number.isFinite(p) && <span className="cl-age muted small">{tr('{0}读的', secsAgo(now - p))}</span>}
            </button>
            {!closed && rows.map(({ x, occ, queued }, i) => (
              <div key={x.index} className={`cl-row${occ.length || queued.length ? '' : ' idle'}${occ.some(o => o.job && mine.has(o.job.id)) ? ' has-mine' : ''}`} style={{ ['--i' as string]: i }}
                data-ref={`gpu:${n.name}:${x.index}`} data-ref-label={`${n.name} · GPU ${x.index}`}>
                <div className="cl-gpu">
                  <div className="cl-gh">
                    <b>GPU {x.index}</b><span className="muted small" title={x.name}>{x.name}</span>
                    <span className={`qb-util${x.util_percent > 80 ? ' hot' : ''}`} style={{ ['--u' as string]: x.util_percent / 100 }} title={tr('利用率')}>{x.util_percent}%</span>
                  </div>
                  <div className="cl-mem">
                    <Meter total={x.mem_total_mb} label={`${n.name} · GPU ${x.index} · ${gb(x.mem_total_mb)}`} parts={[
                      { v: x.queue_mem_mb, c: '#d0743a', name: tr('队列任务') }, { v: x.external_mem_mb, c: '#8a7a66', name: tr('其他程序') },
                      { v: Math.max(0, x.reserved_mb - x.queue_mem_mb), c: '#e8c9a8', name: tr('已预留') }, { v: x.free_mb, c: 'transparent', name: tr('可排') }]} />
                    <span className="small">{gb(x.mem_used_mb)} / {gb(x.mem_total_mb)}</span>
                  </div>
                  <Spark pts={x.trend ?? []} total={x.mem_total_mb} now={now} span={span} label={`${n.name} · GPU ${x.index}`} />
                </div>
                <div className="cl-who">
                  {occ.map(o => <OccRow key={o.key} o={o} ctx={ctx} />)}
                  {!occ.length && <p className="muted small cl-free">{x.attribution === 'blind' && x.mem_used_mb > 1024 ? tr('这张卡报不出进程（WSL），显存有人在用') : tr('空着')}</p>}
                  {queued.length > 0 && (
                    <div className="cl-next"><span className="muted small">{tr('接下来')}</span>{queued.map((id, k) => <NextChip key={id} id={id} k={k + 1} ctx={ctx} />)}</div>
                  )}
                </div>
              </div>
            ))}
            {!closed && idle.length > 0 && (
              <div className="cl-idle">
                <span className="muted small">{tr('空着')}</span>
                {idle.map(({ x }) => (
                  <span key={x.index} className="cl-ic" onPointerMove={e => ctx.tip.show(e, { title: `${n.name} · GPU ${x.index} · ${x.name}`, rows: [
                    { v: `${x.util_percent}%`, k: tr('利用率'), key: SPARK.util }, { v: `${gb(x.mem_used_mb)} / ${gb(x.mem_total_mb)}`, k: tr('显存占用'), key: SPARK.mem },
                    ...(x.temperature_c != null ? [{ v: `${x.temperature_c}°C`, k: tr('温度') }] : [])] })} onPointerLeave={ctx.tip.hide}>
                    GPU {x.index}<em>{gb(x.mem_total_mb)}</em>
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function OccRow({ o, ctx, where }: { o: Occ; ctx: Ctx; where?: boolean }) {
  const { now, mine, lit, hover, setHover, onOpen, tip } = ctx;
  const j = o.job;
  const pct = j ? pctOf(j.progress) : null;
  const ours = !!j && mine.has(j.id);
  const rows = [
    { v: o.user, k: tr('谁') },
    ...(j?.submitter ? [{ v: j.submitter, k: tr('提交者') }] : []),
    { v: lasted(o, now), k: j ? tr('已跑（从开始算）') : tr('从 Papertown 第一次看到算') },
    { v: o.mem ? gb(o.mem) : '—', k: tr('显存') },
    ...(j?.progress ? [{ v: j.progress, k: tr('状态行') }] : []),
    ...(j?.vram_mb ? [{ v: gb(j.vram_mb), k: tr('显存预留') }] : []),
    ...o.procs.slice(0, 4).map(p => ({ v: `pid ${p.pid ?? '?'} · ${gb(p.mem_mb)}`, k: p.name })),
    ...(o.procs.length > 4 ? [{ v: tr('还有 {0} 个进程', o.procs.length - 4), k: '' }] : []),
  ];
  return (
    <button className={`cl-o ${o.kind === 'job' ? 'from-q' : 'outside'}${ours ? ' mine' : ''}${j && lit && !lit.has(j.id) ? ' dim' : ''}${j && lit?.has(j.id) && j.id !== hover ? ' rel' : ''}`}
      onClick={j ? () => onOpen(`nvidb-${j.id}`) : undefined} aria-disabled={!j}
      data-ref={j ? `job:nvidb-${j.id}` : `proc:${o.node}:${o.gpu}:${o.key}`} data-ref-label={j ? `${tr('任务')} #${j.id} ${j.name}` : `${o.user} · ${o.what}`}
      onPointerEnter={() => j && setHover(j.id)}
      onPointerMove={e => tip.show(e, { title: j ? `#${j.id} ${j.name}` : `${o.what}`, rows, foot: j?.notes ? j.notes.slice(0, 160) : j ? undefined
        : `${tr('不是从队列启动的，Papertown 只能看到它占着卡')}${o.atLeast ? tr('；nvidb 不记它的开始时间，≥ 表示 Papertown 开始看时它已经在了') : ''}` })}
      onPointerLeave={() => { setHover(null); tip.hide(); }}>
      {pct != null && <i className="cl-fill" style={{ width: `${Math.min(100, pct)}%` }} />}
      <span className="cl-s">{o.kind === 'job' ? ST.running.sign : '⊙'}</span>
      <span className="cl-what">{j && <b className="mono">#{j.id}</b>}<span>{o.what}</span>{o.kind === 'ext' && <em>{tr('队列外')}</em>}
        {j && !o.procs.length && <em className="cl-none" title={tr('nvidb 说它在跑，但这张卡上没有它的进程：可能只用 CPU，或者已经退出了')}>{tr('卡上没有进程')}</em>}
        {where && <em>{o.node} · GPU {o.gpu}</em>}</span>
      <span className="cl-user"><i className="ub">{(o.user[0] ?? '?').toUpperCase()}</i>{o.user}</span>
      <span className="cl-m">{o.mem ? gb(o.mem) : '—'}</span>
      <span className="cl-d">{lasted(o, now)}</span>
    </button>
  );
}

function NextChip({ id, k, ctx }: { id: number; k: number; ctx: Ctx }) {
  const { g, mine, lit, hover, setHover, onOpen, tip } = ctx;
  const j = g.jobs.find(x => x.id === id);
  const s: St = j?.held ? 'failed' : 'queued';
  return (
    <button className={`qj${j?.held ? ' held' : ''}${mine.has(id) ? ' mine' : ' other'}${lit && !lit.has(id) ? ' dim' : ''}${lit?.has(id) && id !== hover ? ' rel' : ''}`}
      style={{ ['--k' as string]: Math.min(k, 12), ['--c' as string]: ST[s].c }} onClick={() => onOpen(`nvidb-${id}`)}
      onPointerEnter={() => setHover(id)}
      onPointerMove={e => tip.show(e, { title: j?.name ?? `#${id}`, rows: [
        { v: j?.held ? tr('挂起') : tr('第 {0} 个', k), k: `#${id}`, key: ST[s].c },
        ...(j?.vram_mb ? [{ v: gb(j.vram_mb), k: tr('显存预留') }] : []),
        ...(j?.depends_on?.length ? [{ v: j.depends_on.map(x => `#${x}`).join(' '), k: tr('依赖') }] : []),
        ...(j?.submitter ? [{ v: j.submitter, k: tr('提交者') }] : []),
        ...(j?.created_at ? [{ v: when(Date.parse(j.created_at)), k: tr('提交') }] : [])],
        foot: j?.notes ? j.notes.slice(0, 160) : undefined })}
      onPointerLeave={() => { setHover(null); tip.hide(); }}>
      <em>{j?.held ? '!' : k}</em><b>#{id}</b><span>{j?.name ?? ''}</span>
    </button>
  );
}

function ByPerson({ ctx, onlyMine }: { ctx: Ctx; onlyMine: boolean }) {
  const { g, now, mine } = ctx;
  const [open, setOpen] = useState<string | null>(null);
  const all = g.nodes.filter(n => n.state === 'up').flatMap(n => n.gpus.flatMap(x => occupants(g, n, x)))
    .filter(o => !onlyMine || (o.job && mine.has(o.job.id)));
  const total = g.nodes.filter(n => n.state === 'up').reduce((a, n) => a + n.gpus.reduce((b, x) => b + x.mem_total_mb, 0), 0);
  const people = [...all.reduce((m, o) => m.set(o.user, [...(m.get(o.user) ?? []), o]), new Map<string, Occ[]>())]
    .map(([user, os]) => ({ user, os, mem: os.reduce((a, o) => a + o.mem, 0), cards: [...new Set(os.map(o => `${o.node} · GPU ${o.gpu}`))],
      jobs: os.filter(o => o.kind === 'job').length, ext: os.filter(o => o.kind === 'ext').length,
      longest: os.reduce<Occ | null>((a, o) => (o.since != null && Number.isFinite(o.since) && (!a || o.since < (a.since ?? Infinity)) ? o : a), null) }))
    .sort((a, b) => b.mem - a.mem);
  if (!people.length) return <p className="muted small">{onlyMine ? tr('这个项目眼下没有任务在卡上。') : tr('眼下没有人在用这些卡。')}</p>;
  return (
    <div className="pp">
      <div className="pp-row pp-th muted small"><span>{tr('谁')}</span><span>{tr('在用的卡')}</span><span>{tr('显存')}</span><span>{tr('在跑什么')}</span><span>{tr('最久的已经')}</span></div>
      {people.map((p, i) => (
        <div key={p.user} className={`pp-p${open === p.user ? ' open' : ''}`} style={{ ['--i' as string]: Math.min(i, 10) }}>
          <button className="pp-row" onClick={() => setOpen(o => (o === p.user ? null : p.user))}>
            <span className="pp-u"><Icon n="chevron" size={12} className="tr-chev" /><i className="ub">{(p.user[0] ?? '?').toUpperCase()}</i><b>{p.user}</b></span>
            <span className="pp-cards">{p.cards.slice(0, 4).map(c => <em key={c}>{c}</em>)}{p.cards.length > 4 && <em>+{p.cards.length - 4}</em>}</span>
            <span className="pp-mem"><span className="pp-bar"><i style={{ width: `${Math.min(100, (100 * p.mem) / Math.max(1, total))}%` }} /></span>{gb(p.mem)}</span>
            <span className="small">{[p.jobs ? tr('{0} 个队列任务', p.jobs) : '', p.ext ? tr('{0} 个队列外程序', p.ext) : ''].filter(Boolean).join(' · ')}</span>
            <span className="small">{p.longest ? lasted(p.longest, now) : '—'}</span>
          </button>
          {open === p.user && <div className="pp-list">{p.os.map(o => <OccRow key={`${o.node}${o.gpu}${o.key}`} o={o} ctx={ctx} where />)}</div>}
        </div>
      ))}
      <p className="muted small pp-foot">{tr('显存条按全部在线卡的总显存算。队列外程序的时长从 Papertown 第一次看到它算起，带 ≥ 的表示 Papertown 开始看时它已经在了。')}</p>
    </div>
  );
}

function Waiting({ ctx, onlyMine }: { ctx: Ctx; onlyMine: boolean }) {
  const { g, mine, lit, setHover, onOpen } = ctx;
  const inLane = new Set((g.lanes ?? []).flatMap(l => [...l.running, ...l.queued]));
  const waiting = g.jobs.filter(j => j.state === 'pending' && !inLane.has(j.id) && (!onlyMine || mine.has(j.id)));
  if (!waiting.length) return null;
  const groups: [string, string, NvJob[]][] = [
    ['dep', tr('等依赖跑完'), waiting.filter(j => !j.held && (j.depends_on?.length ?? 0) > 0)],
    ['card', tr('等空卡'), waiting.filter(j => !j.held && !(j.depends_on?.length))],
    ['held', tr('挂起：依赖没跑成，等人决定'), waiting.filter(j => j.held)],
  ];
  return (
    <div className="qb-wait">
      {groups.filter(([, , js]) => js.length).map(([k, name, js]) => (
        <div key={k} className={`qw qw-${k}`}>
          <h4><i>{k === 'held' ? '!' : k === 'dep' ? '⛓' : ST.queued.sign}</i>{name}<span>{js.length}</span></h4>
          {js.slice(0, 14).map(j => (
            <button key={j.id} className={`qw-j${mine.has(j.id) ? ' mine' : ''}${lit && !lit.has(j.id) ? ' dim' : ''}`}
              onClick={() => onOpen(`nvidb-${j.id}`)} onPointerEnter={() => setHover(j.id)} onPointerLeave={() => setHover(null)}>
              <b>#{j.id} {j.name}</b>
              <span className="muted small">{k === 'held' ? j.held_reason : [j.depends_on?.length ? tr('等 {0}', j.depends_on.map(x => `#${x}`).join(' ')) : '',
                j.pool ? tr('池 {0}', j.pool) : '', j.node_constraint ? tr('限 {0}', j.node_constraint) : '', j.vram_mb ? gb(j.vram_mb) : '',
                j.submitter ?? '', j.created_at ? tr('{0}提交', secsAgo(Date.now() - Date.parse(j.created_at))) : ''].filter(Boolean).join(' · ')}</span>
            </button>
          ))}
          {js.length > 14 && <span className="muted small">{tr('还有 {0} 个', js.length - 14)}</span>}
        </div>
      ))}
    </div>
  );
}

