// The shop floor of a core building: one lane per project with stations along it and the agents
// working them, dressed as the mill's conveyor, the depot's rack, the farm's field row or the press.

import { Tooltip } from '@cloudflare/kumo';
import { figures, modelText, StateWord } from '../emphasis';
import { useEffect, useMemo, useState } from 'react';
import { api, listen, type Agent, type Job, type Line, type StageAgent, type RosterRow } from '../api';
import { Ava, Item } from '../art';
import '../floor.css';
import { GpuStrip } from './Gpus';
import { eventPreview } from './AgentRoom';
import { AGENT_STATUS, STATUS } from './MillRoom';
import { POST_NAMES } from './Resident';
import { tr } from '../i18n';

type WState = 'working' | 'waiting' | 'resting' | 'error' | 'done' | 'off';
type SState = 'run' | 'wait' | 'done' | 'todo' | 'rest' | 'bad';

interface Worker { id: string; role: string; post?: string; state: WState; title: string; say?: string }
interface Station { key: string; name: string; state: SState; art: React.ReactNode; workers: Worker[]; note?: React.ReactNode }
interface Lane { id: string; seq: number; title: string; status: string; tag: string; note?: React.ReactNode; stations: Station[]; at: number; token?: React.ReactNode; moving: boolean }

export type CoreType = 'mill' | 'depot' | 'farm' | 'press';

const THEME: Record<CoreType, { title: string; how: string; empty: string }> = {
  mill: { title: tr('生产车间'), how: tr('每条生产线对应一篇论文，八道工序沿传送带排列，工位由负责该工序的 Agent 值守，论文随传送带推进至当前工序。'), empty: tr('提交 idea 后，项目负责人将在此处推进各道工序。') },
  depot: { title: tr('货架区'), how: tr('每个项目一排货架：读取代码、编写代码、运行测试，已打包的实验箱发往实验农场。货架前为该项目的代码员工。'), empty: tr('暂无项目。项目立项后，仓库将为其配置一排货架与一位代码员工。') },
  farm: { title: tr('试验田'), how: tr('每个项目一垄田，每项实验任务为一块地：排队为种子，运行中随进度生长，完成后结穗，失败则枯萎。看田员在田边监测。'), empty: tr('田地尚空。代码员工提交实验任务后，此处将立即播种。') },
  press: { title: tr('印刷车间'), how: tr('每篇论文配一台印刷机：排字、开印、校对、装订出厂。机器旁为撰写该论文的员工，纸张停留在当前所处步骤。'), empty: tr('暂无文稿。项目立项后，印刷厂将为其配置一台印刷机与一位写作员工。') },
};

// which kind of worker a stage needs, for the empty places on a line
const AGENT_ROLE: Record<string, string> = { lead: 'designer', coder: 'keeper', writer: 'writer', monitor: 'experimenter' };
const AGENT_NAME: Record<string, string> = { lead: tr('项目负责人'), coder: tr('代码员工'), writer: tr('写作员工'), monitor: tr('看田员') };

function agentState(a: Pick<StageAgent, 'status' | 'id' | 'model'> | null | undefined): WState {
  if (!a) return 'off';
  return ({ working: 'working', starting: 'working', watching: 'working', idle: 'resting', error: 'error', stopped: 'off' } as Record<string, WState>)[a.status] ?? 'resting';
}

function agentWorker(a: Pick<StageAgent, 'status' | 'id' | 'model'> | null | undefined, role: string, say?: string): Worker {
  const st = agentState(a);
  return {
    id: a?.id ?? `${role}-none`, role: AGENT_ROLE[role], state: st, say,
    title: `${AGENT_NAME[role]} · ${a ? AGENT_STATUS[a.status] ?? a.status : tr('尚未配置')}${a?.model ? ` · ${a.model}` : ''}`,
  };
}

function millLanes(lines: Line[]): Lane[] {
  return lines.map(l => {
    const parked = l.lead.state !== 'running';
    const nextTodo = l.stages.findIndex(s => s.status !== 'done');
    const at = l.status === 'done' ? l.stages.length - 1 : Math.max(0, l.stages.findIndex(s => s.status === 'run'), parked ? nextTodo : -1);
    const stations: Station[] = l.stages.map((s, i) => {
      const here = i === at && l.status !== 'done';
      let state: SState = s.status === 'done' ? 'done' : s.status === 'run' ? 'run' : 'todo';
      if (here && parked) state = l.lead.state === 'blocked' ? 'bad' : 'rest';
      const workers = stageWorkers(s, state === 'run' ? 'working' : 'off', state === 'run' ? `${s.name} ${s.pct}%` : undefined);
      return { key: s.key, name: s.name, state, art: <Item k={s.out} />, workers, note: s.note ?? undefined };
    });
    const cur = l.stages[at];
    // a linked project moves only while its experiments run in nvidb
    const linked = l.linked && [l.linked.code?.name, l.linked.paper?.name].filter(Boolean).join(' + ');
    return {
      id: l.id, seq: l.seq, title: l.title, status: l.status, tag: STATUS[l.status] ?? l.status,
      note: linked ? tr('本地仓库 {0}', linked) : modelText(l.note) ?? (l.status === 'done' ? tr('已出厂') : cur ? tr('在「{0}」', cur.name) : undefined),
      stations, at, token: <Item k={cur?.out ?? 'egg'} />,
      moving: l.lead.state === 'running' && l.stages.some(s => s.status === 'run'),
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

function stageWorkers(s: Line['stages'][number] | undefined, _state: WState, say?: string): Worker[] {
  if (!s) return [];
  if (!s.agents.length) return [{ id: `${s.key}-post`, role: AGENT_ROLE[s.owner], post: POST_NAMES[s.owner], state: 'off', title: POST_NAMES[s.owner] }];
  return s.agents.map(a => ({ ...agentWorker(a, a.role, a.status === 'working' ? say : undefined), title: [a.name, AGENT_STATUS[a.status] ?? a.status, a.runtime, a.model].filter(Boolean).join(' · ') }));
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
      workers: i === 0 ? stageWorkers(method, find === 'run' ? 'working' : find === 'done' ? 'done' : 'off', find === 'run' ? tr('浏览仓库') : undefined)
        : i === bay ? [coder] : [],
      note: i === 3 ? (mine.length ? tr('{0} {1} 箱实验，{2} 箱排队或运行中', l?.linked ? tr('nvidb 里') : tr('发出'), mine.length, live.length) : tr('尚未发货'))
        : i === 0 ? (l?.linked ? method?.note ?? undefined : find === 'done' ? tr('方法设计时在仓库群中查找过 baseline') : tr('方法设计工序将在此查找 baseline')) : undefined,
    }));
    const at = live.length ? 3 : st !== 'off' ? bay : find === 'done' ? 1 : 0;
    const code = l?.linked?.code;
    const employee = agent?.started ? `${agent.runtime === 'paseo' ? 'Paseo' : agent.runtime || 'pi'}${(agent.term?.model || agent.model) ? ` · ${agent.term?.model || agent.model}` : ''}` : l?.linked ? '' : tr('在「明细」中为其配置一位代码员工');
    return {
      id: line.id, seq: line.seq, title: line.title, status: agent?.started ? agent.status : '',
      tag: agent?.started ? AGENT_STATUS[agent.status] ?? agent.status : tr('尚未配置代码员工'),
      note: code ? <>{code.path} · {code.branch}{!!code.dirty && <mark className="em-mark" data-tone="warn">{tr('· {0} 处未提交', code.dirty)}</mark>}{employee && ' · '}{employee}</> : employee,
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
    const watcher = agentWorker(row?.agent, 'monitor', running >= 0 ? tr('监测 {0}%', mine[running].progress) : undefined);
    watcher.state = running >= 0 ? 'working' : watcher.state === 'off' ? 'off' : mine.length ? 'done' : 'resting';
    const stations: Station[] = mine.map((j, i) => ({
      key: j.id, name: j.name, art: <Plant status={j.status} pct={j.progress} />,
      state: j.status === 'running' ? 'run' : j.status === 'done' ? 'done' : j.status === 'failed' ? 'bad' : j.status === 'queued' ? 'wait' : 'todo',
      workers: i === at ? [watcher] : [],
      note: <>{j.backend} · {{ queued: tr('排队'), running: figures(tr('运行中 {0}%', j.progress)), done: tr('运行完成'), failed: <StateWord state="failed">{tr('失败')}</StateWord>, cancelled: tr('已取消') }[j.status]}</>,
    }));
    while (stations.length < PLOTS) {
      const k = stations.length;
      stations.push({ key: `empty-${k}`, name: tr('空地'), art: <Plant status="none" pct={0} />, state: 'todo', workers: !mine.length && !k ? [watcher] : [] });
    }
    return {
      id, seq: ln?.seq ?? row?.line.seq ?? 0, title: ln?.title ?? row?.line.title ?? id, status: running >= 0 ? 'running' : all.some(j => j.status === 'queued') ? 'waiting' : all.length ? 'done' : '',
      tag: running >= 0 ? tr('实验运行中') : all.some(j => j.status === 'queued') ? tr('排队中') : all.length ? tr('已收获 {0} 茬', all.filter(j => j.status === 'done').length) : tr('尚未播种'),
      note: eventPreview(row?.agent?.last, 60) ?? (ln?.linked ? modelText(ln.stages.find(s => s.key === 'exp')?.note) ?? tr('nvidb 中暂无其任务') : tr('代码员工提交实验任务后随即播种')),
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
    const parked = !!l && l.lead.state !== 'running';
    const next = l?.stages.find(s => s.status !== 'done')?.key;
    // a linked paper is still being written while its PDF is already printed
    const done = (i: number) => i === 1 ? printed && (!!paper || stage('write')?.status === 'done') : stage(PRESS[i][3])?.status === 'done';
    let at = PRESS.findIndex((_, i) => !done(i));
    if (at < 0) at = PRESS.length - 1;
    const writer = agentWorker(agent, 'writer', agent?.status === 'working' ? tr('撰稿中') : undefined);
    const stations: Station[] = PRESS.map(([key, name, item, sk], i) => {
      const s = stage(sk);
      let state: SState = done(i) ? 'done' : 'todo';
      if (i === at && !done(i)) {
        state = s?.status === 'run' ? 'run' : parked && next === sk ? (l!.lead.state === 'blocked' ? 'bad' : 'rest') : 'todo';
      }
      const ws: WState = state === 'run' ? 'working' : state === 'rest' ? 'resting' : state === 'bad' ? 'error' : 'off';
      let crew: Worker[] = [];
      if (i === at && state !== 'todo' && (i !== 1 || state === 'run')) {
        crew = stageWorkers(s, ws, state === 'run' ? name : state === 'rest' ? tr('负责人已暂停') : undefined);

      }
      if (i === 0 && agent?.started && !crew.some(w => w.id === agent.id)) crew.unshift(writer);
      if (!crew.length && s) crew = stageWorkers(s, 'off');
      return { key, name, state, art: <Item k={item} />, workers: crew, note: i === 2 ? s?.note || undefined : undefined };
    });
    return {
      id: line.id, seq: line.seq, title: line.title, status: l?.status ?? line.status, tag: l ? STATUS[l.status] ?? l.status : line.status,
      note: [paper ? tr('{0} · 约 {1} 词', paper.path, paper.words ?? 0) : '', agent?.started ? tr('写作员工：{0}', agent.runtime === 'paseo' ? 'Paseo' : agent.runtime || 'pi') : '',
        printed ? tr('文稿已完成排版') : tr('尚未开印')].filter(Boolean).join(' · '),
      stations, at, token: <span className="sheets">{Array.from({ length: Math.min(4, 1 + (printed ? 1 : 0)) }, (_, i) => <i key={i} />)}</span>,
      moving: l?.status === 'running',
    };
  });
}

const CREW = 3; // workers drawn at one station; the rest are counted

function AgentFig({ w }: { w: Worker }) {
  if (w.post) return <span className="muted small">{w.post}</span>;
  return (
    <span className={`wk w-${w.state}`} title={w.title}>
      {w.say && <em className="bub">{w.say.endsWith('%') ? figures(w.say) : modelText(w.say)}</em>}
      {w.state === 'resting' && !w.say && <em className="bub z">z</em>}
      <Ava role={w.role} />
    </span>
  );
}

function LaneRow({ lane, i, onPick }: { lane: Lane; i: number; onPick: (id: string) => void }) {
  const n = lane.stations.length;
  return (
    <button className={`lane ls-${lane.status}${lane.moving ? ' moving' : ''}`} style={{ ['--i' as string]: i }} onClick={() => onPick(lane.id)} title={tr('查看该项目明细')}>
      <div className="ln-tag">
        <div className="proj-top"><b>#{lane.seq}</b><StateWord state={lane.status}>{lane.tag}</StateWord></div>
        <h4>{lane.title}</h4>
        {lane.note && <small>{lane.note}</small>}
      </div>
      <div className="ln-track" style={{ ['--n' as string]: n, ['--at' as string]: lane.at }}>
        <div className="ln-rail" />
        {lane.token && <div className="ln-token">{lane.token}</div>}
        {lane.stations.map(s => (
          <Tooltip key={s.key} content={<span className="research-tip">{s.note ? <>{s.name} · {typeof s.note === 'string' ? modelText(s.note) : s.note}</> : s.name}</span>} render={<div className={`fst st-${s.state}`} />}>
            <div className="fst-crew">
              {s.workers.slice(0, CREW).map(w => <AgentFig key={w.id} w={w} />)}
              {s.workers.length > CREW && <span className="wk-more" title={s.workers.slice(CREW).map(w => w.title).join('\n')}>+{s.workers.length - CREW}</span>}
            </div>
            <div className="fst-art">{s.art}</div>
            <span className={s.state === 'bad' ? 'fst-name em-state' : 'fst-name'} data-tone="bad">{s.name}</span>
          </Tooltip>
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
          <span><i className="k-working" />{tr('工作中')} {count(l => l.stations.some(s => s.workers.some(w => w.state === 'working')))}</span>
          <span><i className="k-waiting" />{tr('待处理')}</span>
          <span><i className="k-resting" />{tr('待命')}</span>
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
