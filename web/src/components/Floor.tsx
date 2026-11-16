// The shop floor of a core building: one lane per project with stations along it and the agents
// working them, dressed as the mill's conveyor, the depot's rack, the farm's field row or the press.

import { useEffect, useMemo, useState } from 'react';
import { api, listen, type Agent, type Job, type Line, type RosterRow } from '../api';
import { Ava, Item, ROLE_NAMES } from '../art';
import '../floor.css';
import { GpuStrip } from './Gpus';
import { AGENT_STATUS, STATUS } from './MillRoom';
import { tr } from '../i18n';

type WState = 'working' | 'waiting' | 'resting' | 'error' | 'done' | 'off';
type SState = 'run' | 'wait' | 'done' | 'todo' | 'rest' | 'bad';

interface Worker { id: string; role: string; level?: number; state: WState; title: string; say?: string }
interface Station { key: string; name: string; state: SState; art: React.ReactNode; workers: Worker[]; note?: string }
interface Lane { id: string; seq: number; title: string; status: string; tag: string; note?: string; stations: Station[]; at: number; token?: React.ReactNode; moving: boolean }

export type CoreType = 'mill' | 'depot' | 'farm' | 'press';

const THEME: Record<CoreType, { title: string; how: string; empty: string }> = {
  mill: { title: tr('生产车间'), how: tr('每条生产线是一篇论文，八道工序排在传送带上；工位上站的是负责这道工序的 Agent，论文跟着传送带走到它现在的工序。'), empty: tr('还没有论文上线。放入一颗 idea，孵化后它会在这里占一条生产线。') },
  depot: { title: tr('货架区'), how: tr('每个项目一排货架：读代码、写代码、跑测试，打包好的实验箱子发往实验农场。站在货架前的是这个项目的代码员工。'), empty: tr('还没有项目。项目立项后，仓库会给它一排货架和一位代码员工。') },
  farm: { title: tr('试验田'), how: tr('每个项目一垄田，每个实验任务是一块地：排队是种子，运行中按进度长高，跑完结穗，失败就枯了。看田员在田边盯着。'), empty: tr('田里还空着。流水线跑到实验工序、或代码员工提交任务后，这里就会种上。') },
  press: { title: tr('印刷车间'), how: tr('每篇论文一台印刷机：排字、开印、校对、装订出厂。机器旁是写这篇论文的员工，纸张停在它正在做的那一步。'), empty: tr('还没有稿子。项目立项后，印刷厂会给它一台印刷机和一位写作员工。') },
};

// which kind of worker a stage needs, for the empty places on a line
const STAGE_ROLE: Record<string, string> = { hatch: 'hatcher', method: 'designer', exp: 'experimenter', write: 'writer', review: 'reviewer' };
const AGENT_ROLE: Record<string, string> = { coder: 'keeper', writer: 'writer', monitor: 'experimenter' };
const AGENT_NAME: Record<string, string> = { coder: tr('代码员工'), writer: tr('写作员工'), monitor: tr('看田员') };

function agentState(a: Agent | null | undefined): WState {
  if (!a) return 'off';
  return ({ working: 'working', starting: 'working', watching: 'working', idle: 'resting', error: 'error', stopped: 'off' } as Record<string, WState>)[a.status] ?? 'resting';
}

function agentWorker(a: Agent | null | undefined, role: string, say?: string): Worker {
  const st = agentState(a);
  return {
    id: a?.id ?? `${role}-none`, role: AGENT_ROLE[role], state: st, say,
    title: `${AGENT_NAME[role]} · ${a ? AGENT_STATUS[a.status] ?? a.status : tr('还没配')}${a?.model ? ` · ${a.model}` : ''}`,
  };
}

function millLanes(lines: Line[]): Lane[] {
  return lines.map(l => {
    const parked = ['paused', 'failed'].includes(l.status);
    const nextTodo = l.stages.findIndex(s => s.status !== 'done');
    const at = l.status === 'done' ? l.stages.length - 1 : Math.max(0, l.stages.findIndex(s => s.status === 'run' || s.status === 'wait'), parked ? nextTodo : -1);
    const stations: Station[] = l.stages.map((s, i) => {
      const here = i === at && l.status !== 'done';
      let state: SState = s.status === 'done' ? 'done' : s.status === 'run' ? 'run' : s.status === 'wait' ? 'wait' : 'todo';
      if (here && parked) state = l.status === 'failed' ? 'bad' : 'rest';
      const wstate: WState = state === 'run' ? 'working' : state === 'wait' ? 'waiting' : state === 'rest' ? 'resting' : state === 'bad' ? 'error' : state === 'done' ? 'done' : 'off';
      const say = state === 'run' ? `${s.name}${s.pct ? ` ${s.pct}%` : ''}` : state === 'wait' ? tr('等你决定') : state === 'rest' ? tr('歇着，点继续') : state === 'bad' ? tr('出错了') : undefined;
      let workers: Worker[] = stageWorkers(s, wstate, say);
      if (!workers.length && STAGE_ROLE[s.key] && (state === 'todo' || state === 'rest' || state === 'bad')) {
        const ids = l.team?.[s.key] ?? [];
        workers = (ids.length ? ids : ['']).slice(0, 2).map((id, k) => ({
          id: id || `${s.key}-${k}`, role: STAGE_ROLE[s.key], state: state === 'todo' ? 'off' : wstate, say: k ? undefined : say,
          title: `${ROLE_NAMES[STAGE_ROLE[s.key]]}${id ? ` ${id}` : ''} · ${state === 'todo' ? tr('还没轮到') : say}`,
        }));
      }
      return { key: s.key, name: s.name, state, art: <Item k={s.out} />, workers, note: s.note ?? undefined };
    });
    const cur = l.stages[at];
    // a linked project moves only while its experiments run in nvidb
    const linked = l.linked && [l.linked.code?.name, l.linked.paper?.name].filter(Boolean).join(' + ');
    return {
      id: l.id, seq: l.seq, title: l.title, status: l.status, tag: STATUS[l.status] ?? l.status,
      note: linked ? tr('本地仓库 {0}', linked) : l.note ?? (l.status === 'done' ? tr('已出厂') : cur ? tr('在「{0}」', cur.name) : undefined),
      stations, at, token: <Item k={cur?.out ?? 'egg'} />,
      moving: l.status === 'running' || l.status === 'hatching' || !!l.linked && l.stages.some(s => s.key === 'exp' && s.status === 'run'),
    };
  });
}

// the method stage's baseline search, two bays for the coding agent, and the jobs shipped to the farm
const DEPOT = [['find', tr('找 baseline'), 'notes'], ['write', tr('写代码'), 'draft'], ['test', tr('跑测试'), 'table'], ['ship', tr('发往农场'), 'crate']] as const;

// which bay the coding agent is at, from what it did last
function coderBay(a: Agent | null | undefined) {
  if (!a || a.status !== 'working') return 1;
  const t = JSON.stringify(a.last?.data ?? '').toLowerCase();
  return /pytest|test|make |cargo |npm run|pnpm |submit/.test(t) ? 2 : 1;
}

function stageWorkers(s: Line['stages'][number] | undefined, state: WState, say?: string): Worker[] {
  return (s?.workers ?? []).map((w, k) => ({ id: w.id, role: w.role, level: w.level, state, say: k ? undefined : say, title: `${w.title ?? ROLE_NAMES[w.role]} ${w.id} Lv.${w.level}` }));
}

function depotLanes(rows: RosterRow[], jobs: Job[], lines: Line[]): Lane[] {
  return rows.map(({ line, agent }) => {
    const l = lines.find(x => x.id === line.id);
    const method = l?.stages.find(s => s.key === 'method');
    const mine = jobs.filter(j => j.line_id === line.id);
    const live = mine.filter(j => ['queued', 'running'].includes(j.status));
    const st = agentState(agent), bay = coderBay(agent);
    const coder = agentWorker(agent, 'coder', st === 'working' ? DEPOT[bay][1] : st === 'error' ? tr('出错了') : undefined);
    const find: SState = method?.status === 'done' ? 'done' : method?.status === 'run' ? 'run' : 'todo';
    const coding: SState = st === 'working' ? 'run' : st === 'error' ? 'bad' : st === 'resting' ? 'rest' : find === 'done' ? 'wait' : 'todo';
    const ship: SState = live.length ? 'run' : mine.some(j => j.status === 'done') ? 'done' : mine.some(j => j.status === 'failed') ? 'bad' : 'todo';
    const stations: Station[] = DEPOT.map(([key, name, item], i) => ({
      key, name, art: key === 'ship' ? <Crates n={mine.length} live={live.length} /> : <Item k={item} />,
      state: i === 0 ? find : i === 3 ? ship : i === bay ? coding : 'todo',
      workers: i === 0 ? stageWorkers(method, find === 'run' ? 'working' : find === 'done' ? 'done' : 'off', find === 'run' ? tr('翻仓库') : undefined)
        : i === bay ? [coder] : [],
      note: i === 3 ? (mine.length ? tr('{0} {1} 箱实验，{2} 箱在排队或在跑', l?.linked ? tr('nvidb 里') : tr('发出'), mine.length, live.length) : tr('还没发货'))
        : i === 0 ? (l?.linked ? method?.note ?? undefined : find === 'done' ? tr('方法设计时在仓库群里找过 baseline') : tr('方法设计工序会来这里找 baseline')) : undefined,
    }));
    const at = live.length ? 3 : st !== 'off' ? bay : find === 'done' ? 1 : 0;
    return {
      id: line.id, seq: line.seq, title: line.title, status: l?.status ?? line.status,
      tag: agent?.started ? AGENT_STATUS[agent.status] ?? agent.status : tr('还没配代码员工'),
      note: [l?.linked?.code ? `${l.linked.code.path} · ${l.linked.code.branch ?? ''}${l.linked.code.dirty ? tr(' · {0} 处没提交', l.linked.code.dirty) : ''}` : '',
        agent?.started ? `${agent.runtime === 'paseo' ? 'Paseo' : 'pi'}${agent.model ? ` · ${agent.model}` : ''}` : l?.linked ? '' : tr('在「明细」里给它配一位代码员工')].filter(Boolean).join(' · '),
      stations, at, token: <Item k="crate" />, moving: st === 'working' || live.length > 0,
    };
  });
}

function Crates({ n, live }: { n: number; live: number }) {
  return (
    <span className="crates" title={tr('{0} 箱', n)}>
      {Array.from({ length: Math.min(4, Math.max(1, n)) }, (_, i) => <i key={i} className={i < live ? 'go' : n ? '' : 'none'} />)}
      {n > 4 && <em>+{n - 4}</em>}
    </span>
  );
}

function Plant({ status, pct }: { status: Job['status'] | 'none'; pct: number }) {
  const g = status === 'done' ? 1 : status === 'running' ? 0.25 + 0.75 * pct / 100 : status === 'failed' ? 0.7 : status === 'queued' ? 0.08 : 0;
  const cls = status === 'failed' ? 'wither' : status === 'done' ? 'ripe' : status === 'cancelled' ? 'gone' : '';
  return (
    <svg className={`plant ${cls}${status === 'running' ? ' grow' : ''}`} viewBox="0 0 60 60" style={{ ['--g' as string]: g }} aria-hidden>
      <ellipse className="mound" cx="30" cy="53" rx="22" ry="5" />
      {status === 'queued' && <circle className="seed" cx="30" cy="50" r="2.8" />}
      {g > 0.1 && (
        <g className="stalk">
          <path d="M30 52 C30 40 30 26 30 12" />
          <path className="leaf" d="M30 42 C21 39 15 32 13 26 C22 27 29 33 30 42Z" />
          <path className="leaf" d="M30 32 C39 29 45 22 47 16 C38 17 31 23 30 32Z" />
          <path className="leaf" d="M30 24 C24 21 21 16 20 12 C26 13 29 17 30 24Z" />
          {status === 'done' && <><path className="ear" d="M30 14 C25 9 26 2 30 -3 C34 2 35 9 30 14Z" /><path className="ear" d="M30 20 C24 18 21 13 21 8 C27 10 30 14 30 20Z" /></>}
        </g>
      )}
    </svg>
  );
}

const PLOTS = 5;

function farmLanes(rows: RosterRow[], jobs: Job[], lines: Line[]): Lane[] {
  const ids = [...new Set([...rows.map(r => r.line.id), ...jobs.map(j => j.line_id).filter(Boolean) as string[]])];
  return ids.map(id => {
    const row = rows.find(r => r.line.id === id), ln = lines.find(l => l.id === id);
    const all = jobs.filter(j => j.line_id === id);
    const mine = all.slice(0, PLOTS).reverse();
    const running = mine.findIndex(j => j.status === 'running');
    const at = running >= 0 ? running : Math.max(0, mine.length - 1);
    const watcher = agentWorker(row?.agent, 'monitor', running >= 0 ? tr('盯着 {0}%', mine[running].progress) : undefined);
    watcher.state = running >= 0 ? 'working' : watcher.state === 'off' ? 'off' : mine.length ? 'done' : 'resting';
    const stations: Station[] = mine.map((j, i) => ({
      key: j.id, name: j.name, art: <Plant status={j.status} pct={j.progress} />,
      state: j.status === 'running' ? 'run' : j.status === 'done' ? 'done' : j.status === 'failed' ? 'bad' : j.status === 'queued' ? 'wait' : 'todo',
      workers: i === at ? [watcher] : [],
      note: `${j.backend} · ${{ queued: tr('排队'), running: tr('运行中 {0}%', j.progress), done: tr('跑完了'), failed: tr('失败'), cancelled: tr('已取消') }[j.status]}`,
    }));
    while (stations.length < PLOTS) {
      const k = stations.length;
      stations.push({ key: `empty-${k}`, name: tr('空地'), art: <Plant status="none" pct={0} />, state: 'todo', workers: !mine.length && !k ? [watcher] : [] });
    }
    return {
      id, seq: ln?.seq ?? row?.line.seq ?? 0, title: ln?.title ?? row?.line.title ?? id, status: running >= 0 ? 'running' : all.some(j => j.status === 'queued') ? 'waiting' : all.length ? 'done' : '',
      tag: running >= 0 ? tr('有实验在跑') : all.some(j => j.status === 'queued') ? tr('在排队') : all.length ? tr('收了 {0} 茬', all.filter(j => j.status === 'done').length) : tr('还没种'),
      note: row?.agent?.last?.data?.text ? String(row.agent.last.data.text).split('\n')[0].slice(0, 60)
        : ln?.linked ? ln.stages.find(s => s.key === 'exp')?.note ?? tr('nvidb 里还没有它的任务') : tr('流水线跑到实验工序、或代码员工提交任务后就会种上'),
      stations, at, moving: running >= 0,
    };
  }).sort((a, b) => b.seq - a.seq);
}

// set the type (the write stage), print (typeset and compiled), proof (review), bind and ship
const PRESS = [['set', tr('排字'), 'tex', 'write'], ['print', tr('开印'), 'tex', 'write'], ['proof', tr('校对'), 'pdf', 'review'], ['bind', tr('装订出厂'), 'pdf', 'ship']] as const;

function pressLanes(rows: RosterRow[], lines: Line[]): Lane[] {
  return rows.map(({ line, agent }) => {
    const l = lines.find(x => x.id === line.id);
    const stage = (k: string) => l?.stages.find(s => s.key === k);
    const paper = l?.linked?.paper;
    const printed = paper ? !!paper.pdf : !!l?.files.some(f => f === 'main.pdf' || f === 'main.tex');
    const parked = !!l && ['paused', 'failed'].includes(l.status);
    const next = l?.stages.find(s => s.status !== 'done')?.key;
    // a linked paper is still being written while its PDF is already printed
    const done = (i: number) => i === 1 ? printed && (!!paper || stage('write')?.status === 'done') : stage(PRESS[i][3])?.status === 'done';
    let at = PRESS.findIndex((_, i) => !done(i));
    if (at < 0) at = PRESS.length - 1;
    const writer = agentWorker(agent, 'writer', agent?.status === 'working' ? tr('在写稿') : undefined);
    const stations: Station[] = PRESS.map(([key, name, item, sk], i) => {
      const s = stage(sk);
      let state: SState = done(i) ? 'done' : 'todo';
      if (i === at && !done(i)) {
        state = s?.status === 'run' ? 'run' : parked && next === sk ? (l!.status === 'failed' ? 'bad' : 'rest') : 'todo';
      }
      const ws: WState = state === 'run' ? 'working' : state === 'rest' ? 'resting' : state === 'bad' ? 'error' : 'off';
      let crew: Worker[] = [];
      if (i === at && state !== 'todo' && (i !== 1 || state === 'run')) {
        crew = stageWorkers(s, ws, state === 'run' ? name : state === 'rest' ? tr('歇着，点继续') : undefined);
        if (!crew.length && state === 'rest') {
          const role = sk === 'review' ? 'reviewer' : 'writer';
          crew = (l?.team?.[sk] ?? ['']).slice(0, 2).map((id, k) => ({ id: id || `${sk}-${k}`, role, state: ws, say: k ? undefined : tr('歇着，点继续'), title: `${ROLE_NAMES[role]}${id ? ` ${id}` : ''}` }));
        }
      }
      if (i === 0) crew.unshift(writer);
      return { key, name, state, art: <Item k={item} />, workers: crew, note: i === 2 ? s?.note || undefined : undefined };
    });
    return {
      id: line.id, seq: line.seq, title: line.title, status: l?.status ?? line.status, tag: l ? STATUS[l.status] ?? l.status : line.status,
      note: [paper ? tr('{0} · 约 {1} 词', paper.path, paper.words ?? 0) : '', agent?.started ? tr('写作员工：{0}', agent.runtime === 'paseo' ? 'Paseo' : 'pi') : '',
        l?.revisions ? tr('改过 {0} 版', l.revisions) : printed ? tr('稿子已经排出来了') : tr('还没开印')].filter(Boolean).join(' · '),
      stations, at, token: <span className="sheets">{Array.from({ length: Math.min(4, 1 + (l?.revisions ?? 0) + (printed ? 1 : 0)) }, (_, i) => <i key={i} />)}</span>,
      moving: l?.status === 'running',
    };
  });
}

const CREW = 3; // workers drawn at one station; the rest are counted

function WorkerFig({ w }: { w: Worker }) {
  return (
    <span className={`wk w-${w.state}`} title={w.title}>
      {w.say && <em className="bub">{w.say}</em>}
      {w.state === 'resting' && !w.say && <em className="bub z">z</em>}
      <Ava role={w.role} level={w.level} />
    </span>
  );
}

function LaneRow({ lane, i, onPick }: { lane: Lane; i: number; onPick: (id: string) => void }) {
  const n = lane.stations.length;
  return (
    <button className={`lane ls-${lane.status}${lane.moving ? ' moving' : ''}`} style={{ ['--i' as string]: i }} onClick={() => onPick(lane.id)} title={tr('看这个项目的明细')}>
      <div className="ln-tag">
        <div className="proj-top"><b>#{lane.seq}</b><span className={`pst pst-${lane.status}`}>{lane.tag}</span></div>
        <h4>{lane.title}</h4>
        {lane.note && <small>{lane.note}</small>}
      </div>
      <div className="ln-track" style={{ ['--n' as string]: n, ['--at' as string]: lane.at }}>
        <div className="ln-rail" />
        {lane.token && <div className="ln-token">{lane.token}</div>}
        {lane.stations.map(s => (
          <div key={s.key} className={`fst st-${s.state}`} title={s.note ? `${s.name} · ${s.note}` : s.name}>
            <div className="fst-crew">
              {s.workers.slice(0, CREW).map(w => <WorkerFig key={w.id} w={w} />)}
              {s.workers.length > CREW && <span className="wk-more" title={s.workers.slice(CREW).map(w => w.title).join('\n')}>+{s.workers.length - CREW}</span>}
            </div>
            <div className="fst-art">{s.art}</div>
            <span className="fst-name">{s.name}</span>
          </div>
        ))}
      </div>
    </button>
  );
}

export function Floor({ type, lines, tick, onPick }: { type: CoreType; lines: Line[]; tick: number; onPick: (lineId: string) => void }) {
  const [rows, setRows] = useState<RosterRow[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [bump, setBump] = useState(0);
  const role = type === 'depot' ? 'coder' : type === 'press' ? 'writer' : type === 'farm' ? 'monitor' : null;

  useEffect(() => listen(e => { if (['agent', 'agent_event', 'job'].includes(e.type)) setBump(b => b + 1); }), []);
  useEffect(() => {
    if (!role) return;
    let live = true;
    const t = setTimeout(async () => {
      const [r, b] = await Promise.all([api.roster(role), type === 'press' ? null : api.jobs()]).catch(() => [null, null]);
      if (!live) return;
      if (r) setRows(r.roster);
      if (b) setJobs(b.jobs);
    }, 180);
    return () => { live = false; clearTimeout(t); };
  }, [role, type, bump, tick]);

  const sorted = useMemo(() => [...lines].sort((a, b) => b.seq - a.seq), [lines]);
  const lanes = type === 'mill' ? millLanes(sorted) : type === 'depot' ? depotLanes(rows, jobs, sorted)
    : type === 'farm' ? farmLanes(rows, jobs, sorted) : pressLanes(rows, sorted);
  const th = THEME[type];
  const count = (f: (l: Lane) => boolean) => lanes.filter(f).length;

  return (
    <div className={`floor floor-${type}`}>
      <div className="fl-head">
        <div>
          <h3>{th.title}</h3>
          <p>{th.how}</p>
        </div>
        <div className="fl-legend">
          <span><i className="k-working" />{tr('干活中')} {count(l => l.stations.some(s => s.workers.some(w => w.state === 'working')))}</span>
          <span><i className="k-waiting" />{tr('等你')}</span>
          <span><i className="k-resting" />{tr('歇着')}</span>
          <span><i className="k-error" />{tr('出错')}</span>
        </div>
      </div>
      {type === 'farm' && <GpuStrip />}
      <div className="fl-lanes">
        {lanes.length ? lanes.map((l, i) => <LaneRow key={l.id} lane={l} i={i} onPick={onPick} />)
          : <div className="room-empty"><p>{th.empty}</p></div>}
      </div>
    </div>
  );
}
