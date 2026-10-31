// A project's jobs, in the format that suits how many there are and what they are doing: a
// table to sort and search; cards with each job's progress, numbers or error laid out; a board
// with a column per state, to see how far a batch has got; groups, for sweeps named alike or
// submitted together, with how much of each has finished and its highest number; and a grid of
// small squares a day to a row, for hundreds at once. "Auto" picks one from the jobs in view.
// The choice is remembered in this browser. Any job opens in full.

import { Fragment, useMemo, useState } from 'react';
import type { Job } from '../api';
import { tr } from '../i18n';
import { ST, StateTag, Tip, elapsed, fmtNum, useNow, useTip, when, type St } from './charts';
import { Icon, type IconName } from './icons';
import { byBatch, byName, dayName, dayOf, lastAt, placeOf, ranFor, resOf, startOf, stj, t, type Group } from './jobs';
import { ago, headline, headlines, lastLine, pctOf, tails } from './util';

type Kind = 'table' | 'cards' | 'board' | 'groups' | 'grid';
type View = 'auto' | Kind;
const VIEWS: [Kind, string, IconName, string][] = [
  ['table', tr('表格'), 'rows', tr('一行一个任务，可以按列排序：任务多、要找某一个的时候')],
  ['cards', tr('卡片'), 'cards', tr('一张卡一个任务，进度、结果、出错直接摊开：同时在跑的不多的时候')],
  ['board', tr('看板'), 'board', tr('按状态分成四栏：看一批任务走到了哪一步')],
  ['groups', tr('分组'), 'stack', tr('同一组参数扫描、同一批提交的归在一起：看每组跑完多少、数字最高的是哪个')],
  ['grid', tr('方格'), 'dots', tr('一个任务一个小方块，一天一行：几百个任务时看全貌')],
];
const KEY = 'papertown.exp.view';
const RANK: Record<St, number> = { running: 0, queued: 1, failed: 2, done: 3, cancelled: 4 };

// few jobs read best as cards; many in flight, as a board; hundreds, as a grid; otherwise a table
function autoKind(jobs: Job[]): Kind {
  const live = jobs.filter(j => RANK[stj(j)] < 2).length;
  return jobs.length <= 12 ? 'cards' : live >= 4 ? 'board' : jobs.length > 200 ? 'grid' : 'table';
}

interface Props { jobs: Job[]; open: string | null; onOpen: (id: string, order: string[]) => void; onData: () => void }

export function JobViews({ jobs, open, onOpen, onData }: Props) {
  const [view, setView] = useState<View>(() => { try { return (localStorage.getItem(KEY) as View) || 'auto'; } catch { return 'auto'; } });
  const pick = (v: View) => { setView(v); try { localStorage.setItem(KEY, v); } catch { /* private mode */ } };
  const kind = view === 'auto' || !VIEWS.some(([k]) => k === view) ? autoKind(jobs) : view as Kind;
  const now = useNow(15_000);
  const p = { jobs, open, onOpen, now };
  return (
    <section className="cs jv">
      <div className="cs-h jv-h">
        <span className="cs-ic"><Icon n={VIEWS.find(([k]) => k === kind)![2]} size={15} /></span><h3>{tr('任务 · {0}', jobs.length)}</h3>
        <div className="jv-sw" role="tablist" aria-label={tr('任务的显示方式')}>
          <button className={view === 'auto' ? 'on' : ''} onClick={() => pick('auto')} title={tr('按眼下的任务自动挑：少的用卡片，在跑的多用看板，几百个用方格，其余用表格')}>
            <Icon n="wand" size={13} />{tr('自动')}{view === 'auto' && <em>{VIEWS.find(([k]) => k === kind)![1]}</em>}
          </button>
          {VIEWS.map(([k, name, ic, hint]) => (
            <button key={k} className={view === k ? 'on' : ''} onClick={() => pick(k)} title={hint}><Icon n={ic} size={13} />{name}</button>
          ))}
        </div>
        <button className="lnk" onClick={onData}>{tr('结果和数据')} →</button>
      </div>
      <p className="jv-hint muted small">{VIEWS.find(([k]) => k === kind)![3]}</p>
      {!jobs.length ? <p className="muted small">{tr('没有符合条件的任务。')}</p>
        : kind === 'table' ? <Table {...p} /> : kind === 'cards' ? <Cards {...p} /> : kind === 'board' ? <Board {...p} />
          : kind === 'groups' ? <Groups {...p} /> : <Grid {...p} />}
    </section>
  );
}

interface V { jobs: Job[]; open: string | null; onOpen: (id: string, order: string[]) => void; now: number }

// what a job has to say for itself in a line: its status line, what it waits for, why it failed
function lineOf(j: Job) {
  const s = stj(j), n = j.nvidb;
  if (s === 'running') return n?.progress || placeOf(j);
  if (s === 'queued') return n?.held ? n.held_reason || tr('挂起') : n?.depends_on?.length ? tr('等 {0}', n.depends_on.map(x => `#${x}`).join(' '))
    : n?.lane ? tr('排在 {0}', n.lane) : tr('等一张放得下它的卡');
  if (s === 'failed') return lastLine(n?.last_error) || (n?.exit_code != null ? tr('退出码 {0}', n.exit_code) : tr('没有留下出错信息'));
  return '';
}
const pctFor = (j: Job) => (stj(j) !== 'running' ? null : j.nvidb ? pctOf(j.nvidb.progress) : j.progress);
const shortKey = (k: string) => tails([k])[0];

// ---------- table ----------

function Table({ jobs, open, onOpen }: V) {
  const [sort, setSort] = useState<{ k: 'id' | 'name' | 'st' | 'where' | 'start' | 'dur'; up: boolean }>({ k: 'start', up: false });
  const [more, setMore] = useState(30);
  const sorted = useMemo(() => {
    const key = (j: Job): string | number => sort.k === 'id' ? (j.nvidb?.id ?? 0) : sort.k === 'name' ? j.name : sort.k === 'st' ? RANK[stj(j)]
      : sort.k === 'where' ? placeOf(j) : sort.k === 'start' ? (startOf(j) || t(j.created_at) || 0) : (ranFor(j) ?? 0);
    return [...jobs].sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * (sort.up ? 1 : -1); });
  }, [jobs, sort]);
  const order = sorted.map(j => j.id);
  // sorted by when they started, the table breaks into days, each with its count
  const byDay = sort.k === 'start';
  const dayKey = (j: Job) => dayOf(startOf(j) || t(j.created_at));
  const days = useMemo(() => {
    const m = new Map<number, { n: number; done: number; failed: number }>();
    if (byDay) for (const j of sorted) {
      const d = dayKey(j), x = m.get(d) ?? { n: 0, done: 0, failed: 0 }, s = stj(j);
      x.n++; if (s === 'done') x.done++; if (s === 'failed') x.failed++;
      m.set(d, x);
    }
    return m;
  }, [sorted, byDay]);
  const th = (k: typeof sort.k, label: string) => (
    <th className={`sortable${sort.k === k ? ` on ${sort.up ? 'up' : 'down'}` : ''}`} onClick={() => setSort(s => ({ k, up: s.k === k ? !s.up : k === 'name' || k === 'where' }))}>{label}</th>
  );
  return (
    <>
      <table className="ctab xt">
        <thead><tr>{th('id', '#')}{th('name', tr('任务'))}{th('st', tr('状态'))}{th('where', tr('在哪'))}{th('start', tr('开始'))}{th('dur', tr('用时'))}<th>{tr('结果')}</th></tr></thead>
        <tbody>{sorted.slice(0, more).map((j, i, all) => {
          const s = stj(j);
          const day = byDay ? dayKey(j) : null;
          const head = day != null && (i === 0 || !Object.is(dayKey(all[i - 1]), day));
          const tally = head ? days.get(day!) : null;
          return (
            <Fragment key={j.id}>
              {head && tally && (
                <tr className="xt-day"><td colSpan={7}>
                  <b>{Number.isFinite(day) ? dayName(day!) : tr('还没开始')}</b><em>{tr('{0} 个', tally.n)}</em>
                  {tally.failed > 0 && <em className="bad-t">✕ {tally.failed}</em>}{tally.done > 0 && <em>✓ {tally.done}</em>}
                </td></tr>
              )}
              <tr className={`s-${s}${open === j.id ? ' on' : ''}`} onClick={() => onOpen(j.id, order)}>
                <td className="muted mono">{j.nvidb?.id ?? '—'}</td>
                <td><b className="xt-n" title={j.nvidb?.notes || j.name}>{j.name}</b></td>
                <td><StateTag s={s} /></td>
                <td className="muted nw">{placeOf(j)}</td>
                <td className="muted nw">{Number.isFinite(startOf(j)) ? when(startOf(j)) : '—'}</td>
                <td>{s === 'running' && j.nvidb?.progress ? <span className="mono small">{j.nvidb.progress}</span>
                  : s === 'failed' && j.nvidb?.last_error ? <><span>{elapsed(j.nvidb.elapsed_s)}</span><span className="xt-err" title={j.nvidb.last_error}>{lastLine(j.nvidb.last_error)}</span></>
                  : elapsed(ranFor(j))}</td>
                <td className="xt-res">{headlines(resOf(j), 2).map(h => <span key={h.k} title={h.k}><i>{h.name}</i><b>{fmtNum(h.v)}</b></span>)}</td>
              </tr>
            </Fragment>
          );
        })}</tbody>
      </table>
      {sorted.length > more && <button className="btn xt-more" onClick={() => setMore(m => m + 50)}>{tr('再显示 {0} 个', Math.min(50, sorted.length - more))}</button>}
    </>
  );
}

// ---------- cards ----------

function Cards({ jobs, open, onOpen, now }: V) {
  const [more, setMore] = useState(24);
  const list = useMemo(() => [...jobs].sort((a, b) => RANK[stj(a)] - RANK[stj(b)] || lastAt(b) - lastAt(a)), [jobs]);
  const order = list.map(j => j.id);
  return (
    <>
      <div className="jc-grid">
        {list.slice(0, more).map((j, i) => {
          const s = stj(j), pct = pctFor(j), res = headlines(resOf(j), 4), took = ranFor(j, now), line = lineOf(j);
          return (
            <button key={j.id} className={`jc s-${s}${open === j.id ? ' on' : ''}`} style={{ ['--i' as string]: Math.min(i, 12) }} onClick={() => onOpen(j.id, order)}>
              <span className="jc-h"><StateTag s={s} />{j.nvidb && <span className="muted small mono">#{j.nvidb.id}</span>}
                <em>{s === 'running' ? elapsed(took) : ago(j.nvidb?.finished_at ?? j.ended_at ?? j.created_at)}</em></span>
              <b className="jc-n" title={j.name}>{j.name}</b>
              {pct != null && <span className="jc-bar"><span><i style={{ width: `${Math.min(100, pct)}%` }} /></span><em>{Math.round(pct)}%</em></span>}
              {line && <span className={`jc-line${s === 'failed' ? ' err' : ''} mono`} title={s === 'failed' ? j.nvidb?.last_error : line}><span>{line}</span></span>}
              {res.length > 0 && <span className="jc-m">{res.map(h => <span key={h.k} title={h.k}><strong>{fmtNum(h.v)}</strong><em>{h.name}</em></span>)}</span>}
              <span className="jc-f"><span>{placeOf(j)}</span>{s !== 'running' && took != null && <span>{elapsed(took)}</span>}</span>
            </button>
          );
        })}
      </div>
      {list.length > more && <button className="btn xt-more" onClick={() => setMore(m => m + 24)}>{tr('再显示 {0} 个', Math.min(24, list.length - more))}</button>}
    </>
  );
}

// ---------- board ----------

const COLS: St[] = ['queued', 'running', 'done', 'failed'];

function Board({ jobs, open, onOpen, now }: V) {
  const [all, setAll] = useState<St[]>([]);
  const cols = COLS.map(s => {
    const js = jobs.filter(j => stj(j) === s);
    // what runs next and what has run longest first; what finished, newest first
    js.sort((a, b) => s === 'queued' ? (t(a.created_at) || 0) - (t(b.created_at) || 0) : s === 'running' ? startOf(a) - startOf(b) : lastAt(b) - lastAt(a));
    return [s, js] as const;
  });
  const cancelled = jobs.filter(j => stj(j) === 'cancelled').length;
  const order = cols.flatMap(([, js]) => js.map(j => j.id));
  return (
    <>
      <div className="jb">
        {cols.map(([s, js]) => (
          <div key={s} className={`jb-col s-${s}`}>
            <h4><i className="tile-key" style={{ ['--c' as string]: ST[s].c }}>{ST[s].sign}</i>{ST[s].label}<span>{js.length}</span></h4>
            <div className="jb-list">
              {js.slice(0, all.includes(s) ? 500 : 12).map(j => {
                const pct = pctFor(j), res = headline(resOf(j), 1)[0], line = lineOf(j);
                return (
                  <button key={j.id} className={`jb-j${open === j.id ? ' on' : ''}`} onClick={() => onOpen(j.id, order)}>
                    <b title={j.name}>{j.name}</b>
                    {pct != null && <span className="jc-bar thin"><span><i style={{ width: `${Math.min(100, pct)}%` }} /></span></span>}
                    {res && <span className="jb-r"><strong>{fmtNum(res[1])}</strong><em>{shortKey(res[0])}</em></span>}
                    {line && s !== 'done' && <span className={`jb-l mono${s === 'failed' ? ' err' : ''}`}>{line}</span>}
                    <span className="jb-m">{placeOf(j)} · {s === 'running' ? elapsed(ranFor(j, now)) : s === 'queued' ? ago(j.created_at) : ago(j.nvidb?.finished_at ?? j.ended_at)}</span>
                  </button>
                );
              })}
              {!js.length && <p className="muted small jb-none">{tr('没有')}</p>}
            </div>
            {js.length > 12 && !all.includes(s) && <button className="lnk jb-more" onClick={() => setAll(a => [...a, s])}>{tr('再显示 {0} 个', js.length - 12)}</button>}
          </div>
        ))}
      </div>
      {cancelled > 0 && <p className="muted small jb-foot">{tr('另有 {0} 个已取消，在表格里能看到。', cancelled)}</p>}
    </>
  );
}

// ---------- groups ----------

function Groups({ jobs, open, onOpen, now }: V) {
  const [by, setBy] = useState<'name' | 'batch'>('name');
  const [flip, setFlip] = useState<Set<string>>(new Set());
  const { tip, show, hide } = useTip();
  const groups = useMemo(() => (by === 'name' ? byName(jobs) : byBatch(jobs))
    .map(g => ({ ...g, jobs: [...g.jobs].sort((a, b) => RANK[stj(a)] - RANK[stj(b)] || lastAt(b) - lastAt(a)), last: Math.max(...g.jobs.map(lastAt)) }))
    .sort((a, b) => (a.key === '·' ? 1 : 0) - (b.key === '·' ? 1 : 0) || b.last - a.last), [jobs, by]);
  const order = groups.flatMap(g => g.jobs.map(j => j.id));
  // open by default: the first group and any with work in flight or a failure
  const isOpen = (g: Group, i: number) => (i === 0 || g.jobs.some(j => RANK[stj(j)] <= 2)) !== flip.has(g.key);
  return (
    <div className="jg-wrap">
      <div className="jg-by seg mini">
        <button className={by === 'name' ? 'on' : ''} onClick={() => setBy('name')}>{tr('按名字')}</button>
        <button className={by === 'batch' ? 'on' : ''} onClick={() => setBy('batch')}>{tr('按提交批次')}</button>
      </div>
      {groups.map((g, i) => {
        const n = (s: St) => g.jobs.filter(j => stj(j) === s).length;
        const top = highest(g.jobs);
        const on = isOpen(g, i);
        const pre = g.key !== '·' && by === 'name' ? g.key : '';
        return (
          <div key={g.key} className={`jg${on ? ' open' : ''}`} style={{ ['--i' as string]: Math.min(i, 10) }}>
            <button className="jg-h" onClick={() => setFlip(f => { const x = new Set(f); if (x.has(g.key)) x.delete(g.key); else x.add(g.key); return x; })} title={g.hint}>
              <Icon n="chevron" size={13} className="tr-chev" />
              <b className="mono">{g.label}</b>
              <span className="muted small">{tr('{0} 个', g.jobs.length)} · {ago(g.last / 1000)}</span>
              <span className="jg-bar" onPointerMove={e => show(e, { title: g.label, rows: (['done', 'failed', 'running', 'queued', 'cancelled'] as St[]).filter(n)
                .map(s => ({ v: String(n(s)), k: ST[s].label, key: ST[s].c })) })} onPointerLeave={hide}>
                {(['done', 'failed', 'running', 'queued', 'cancelled'] as St[]).filter(n).map(s => (
                  <i key={s} className={`s-${s}${ST[s].hollow ? ' hollow' : ''}`} style={{ flexGrow: n(s) }} />
                ))}
              </span>
              <span className="jg-n">{(['running', 'queued', 'failed', 'done'] as St[]).filter(n).map(s => <em key={s} className={`s-${s}`}>{ST[s].sign} {n(s)}</em>)}</span>
            </button>
            {top && (
              <p className="jg-top">{tr('最高')} <span className="muted">{shortKey(top.k)}</span> <strong>{fmtNum(top.v)}</strong>
                <button className="lnk" onClick={() => onOpen(top.j.id, order)}>{top.j.name}</button>
                <span className="muted small">{tr('（{0} 个交回了这一项）', top.n)}</span></p>
            )}
            {on && (
              <div className="jg-rows">
                {g.jobs.map(j => {
                  const s = stj(j), pct = pctFor(j), res = headline(resOf(j), 1)[0];
                  return (
                    <button key={j.id} className={`jg-r s-${s}${open === j.id ? ' on' : ''}`} onClick={() => onOpen(j.id, order)}>
                      {pct != null && <i className="jg-fill" style={{ width: `${Math.min(100, pct)}%` }} />}
                      <span className="jg-s">{ST[s].sign}</span>
                      <span className="jg-name" title={j.name}>{pre && j.name.startsWith(pre) ? <><em>{pre}</em>{j.name.slice(pre.length)}</> : j.name}</span>
                      <span className="jg-w muted">{placeOf(j)}</span>
                      <span className="jg-d">{s === 'running' ? elapsed(ranFor(j, now)) : s === 'queued' ? ST.queued.label : elapsed(ranFor(j))}</span>
                      <span className="jg-v">{res ? <><em>{shortKey(res[0])}</em>{fmtNum(res[1])}</> : s === 'failed' ? <em className="err" title={j.nvidb?.last_error}>{lineOf(j)}</em> : ''}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      <Tip tip={tip} />
    </div>
  );
}

// the number most of a group's jobs handed back, and the highest of it
function highest(jobs: Job[]) {
  const by = new Map<string, { v: number; j: Job }[]>();
  for (const j of jobs) for (const [k, v] of headline(resOf(j), 4)) by.set(k, [...(by.get(k) ?? []), { v, j }]);
  const [k, xs] = [...by.entries()].sort((a, b) => b[1].length - a[1].length)[0] ?? [];
  if (!k || !xs) return null;
  const best = xs.reduce((a, b) => (b.v > a.v ? b : a));
  return { k, v: best.v, j: best.j, n: xs.length };
}

// ---------- grid ----------

function Grid({ jobs, open, onOpen, now }: V) {
  const { tip, show, hide } = useTip();
  const days = useMemo(() => {
    const m = new Map<number, Job[]>();
    for (const j of jobs) { const d = dayOf(startOf(j) || t(j.created_at)); m.set(d, [...(m.get(d) ?? []), j]); }
    return [...m.entries()].sort((a, b) => (Number.isFinite(b[0]) ? b[0] : Infinity) - (Number.isFinite(a[0]) ? a[0] : Infinity))
      .map(([d, js]) => [d, js.sort((a, b) => (startOf(a) || t(a.created_at)) - (startOf(b) || t(b.created_at)))] as const);
  }, [jobs]);
  const order = days.flatMap(([, js]) => js.map(j => j.id));
  return (
    <div className="jgr">
      {days.map(([d, js]) => (
        <div key={d} className="jgr-row">
          <span className="jgr-d">{Number.isFinite(d) ? dayName(d) : tr('还没开始')}<em>{js.length}</em></span>
          <div className="jgr-cells">
            {js.map((j, i) => {
              const s = stj(j), res = headlines(resOf(j), 2);
              return (
                <button key={j.id} className={`jgr-c s-${s}${ST[s].hollow ? ' hollow' : ''}${res.length ? ' res' : ''}${open === j.id ? ' on' : ''}`}
                  style={{ ['--i' as string]: Math.min(i, 30) }} aria-label={j.name} onClick={() => { hide(); onOpen(j.id, order); }}
                  onPointerMove={e => show(e, { title: j.name, rows: [
                    { v: ST[s].label, k: j.nvidb ? `#${j.nvidb.id}` : '', key: ST[s].c },
                    { v: placeOf(j), k: tr('在哪') },
                    { v: Number.isFinite(startOf(j)) ? when(startOf(j)) : '—', k: tr('开始') },
                    { v: elapsed(ranFor(j, now)), k: tr('用时') },
                    ...res.map(h => ({ v: fmtNum(h.v), k: h.name }))],
                    foot: s === 'failed' ? lineOf(j) : s === 'running' ? j.nvidb?.progress ?? undefined : undefined })}
                  onPointerLeave={hide} />
              );
            })}
          </div>
        </div>
      ))}
      <div className="jgr-key muted small">
        {(['running', 'done', 'failed', 'queued', 'cancelled'] as St[]).map(s => (
          <span key={s}><i className={`jgr-c s-${s}${ST[s].hollow ? ' hollow' : ''}`} />{ST[s].label}</span>
        ))}
        <span><i className="jgr-c s-done res" />{tr('带点的交回了结果')}</span>
        <span>{tr('一天一行，从早到晚')}</span>
      </div>
      <Tip tip={tip} />
    </div>
  );
}

