// The console: everything the town does, as one screen of panels, for anyone who would rather
// click than walk. Projects are folders along the top, in a path like Finder's; the rail drops
// down to pick another project or paper and folds away again. The research stages and the
// town's configuration run down the left, and the one picked fills the right: the survey to
// read, the code and the paper to edit, the experiments and their data, the project's agents,
// the skills, MCP servers and library. The town, 2D or 3D, is the same work walked through.
// The assistant opens in a sidebar on the right and is told what you are looking at. When Paseo
// starts offering a new model, a card asks whether the assistant and the leads should switch.
//
// On a phone the same console in one column: the project is the bar along the top (tap it for
// the list, which rises from the bottom), the panels most looked at are tabs along the bottom
// with the rest under 更多, and the assistant takes the whole screen.
//
//   #view=console&line=line_2&m=paper   — open a project's panel directly

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, listen, type Line, type Placement, type Report, type ShowTarget } from '../api';
import { AgentDesk } from '../components/AgentRoom';
import type { RoomActions } from '../components/Interior';
import { McpRoom } from '../components/McpRoom';
import { STATUS } from '../components/MillRoom';
import { RagRoom } from '../components/RagRoom';
import { SkillRoom } from '../components/SkillRoom';
import { tr, trx } from '../i18n';
import { Assistant } from './Assistant';
import { Bounds } from './Bounds';
import { Code } from './Code';
import { Data } from './Data';
import { EdPicker } from './EdPicker';
import { Experiments } from './Experiments';
import { Icon, type IconName } from './icons';
import { NewModels } from './NewModels';
import { Overview, STAGE_MOD } from './Overview';
import { flash, setPlace, usePanelNote } from './page';
import { Paper } from './Paper';
import { Survey } from './Survey';
import { gist, PHONE, revealX, useFetch, useMedia } from './util';
import '../console.css';

export type ModId = 'overview' | 'survey' | 'code' | 'exp' | 'data' | 'paper' | 'agents' | 'skills' | 'mcp' | 'rag' | 'rules';

const MODS: { id: ModId; name: string; sub: string; icon: IconName; town?: boolean }[] = [
  { id: 'overview', name: tr('概览'), sub: tr('项目走到哪一步、在等你做什么'), icon: 'compass' },
  { id: 'survey', name: tr('调研'), sub: tr('查重结论、空白点、最接近的工作和方法，一页读完'), icon: 'lens' },
  { id: 'code', name: tr('代码仓库'), sub: tr('项目的代码：浏览、修改、对比改动'), icon: 'code' },
  { id: 'exp', name: tr('实验'), sub: tr('nvidb 上正在跑的、接下来要跑的任务'), icon: 'flask' },
  { id: 'data', name: tr('数据'), sub: tr('实验的元数据、结果和数据文件'), icon: 'table' },
  { id: 'paper', name: tr('论文'), sub: tr('LaTeX 源码和排出的 PDF，左右对照'), icon: 'doc' },
  { id: 'agents', name: tr('员工'), sub: tr('这个项目的负责人、代码员工和写作员工'), icon: 'people' },
  { id: 'skills', name: 'Skills', sub: tr('给全局、项目、对话配 skill'), icon: 'spark', town: true },
  { id: 'mcp', name: 'MCP', sub: tr('小镇接的 MCP server 和它们给的工具'), icon: 'plug', town: true },
  { id: 'rag', name: tr('图书馆'), sub: tr('馆藏、RAG 检索设置和检索试验台'), icon: 'books', town: true },
  { id: 'rules', name: tr('工作边界'), sub: tr('全局、项目、员工三层：必须完成、不能做、需要询问'), icon: 'shield', town: true },
];
const IDS = MODS.map(m => m.id);
const isMod = (s: unknown): s is ModId => IDS.includes(s as ModId);
// a phone's tabs along the bottom: the panels you look at most away from your desk
const PHONE_TABS: ModId[] = ['overview', 'survey', 'exp', 'paper'];
// the panels that do their own layout edge to edge, with no heading over them
const BLEED = new Set<ModId>(['code', 'paper', 'agents', 'skills', 'mcp', 'rag']);

// a building of the town, and the panel here that does its work
const BY_BUILDING: Record<string, ModId> = {
  mill: 'overview', hatchery: 'survey', customs: 'survey', genealogy: 'survey', depot: 'code', workshop: 'code', farm: 'exp',
  power: 'exp', power_sim: 'exp', coldstore: 'data', press: 'paper', qa: 'paper', market: 'agents', academy: 'skills', exchange: 'mcp', library: 'rag',
};

// `asked`: the projects with a question from their agents waiting for your answer
type Filter = 'all' | 'run' | 'you' | 'done' | 'local';
const FILTERS: [Filter, string, (l: Line, asked: Set<string>) => boolean][] = [
  ['all', tr('全部'), () => true],
  ['run', tr('在跑'), l => ['running', 'hatching'].includes(l.status)],
  ['you', tr('等你'), (l, asked) => ['waiting', 'paused', 'failed'].includes(l.status) || asked.has(l.id)],
  ['done', tr('已完成'), l => l.status === 'done'],
  ['local', tr('本地项目'), l => !!l.linked],
];
const needsYou = FILTERS[2][2];
// the 员工 panel's tabs: [what the assistant reads, the tab, what it does]
const ROLES = {
  lead: ['项目负责人', tr('项目负责人'), tr('盯着项目进度、催员工干活，有要紧的事向你汇报、问你')],
  coder: ['代码员工', tr('代码员工'), tr('在代码仓库里写代码、跑测试，再把实验提交出去')],
  writer: ['写作员工', tr('写作员工'), tr('在论文目录里写稿、改稿、排版')],
} as const;
const hasPaper = (l: Line) => !!l.linked?.paper || l.files.includes('main.tex');

const KEY = 'pt-console';
type Reveal = { root: 'code' | 'paper'; path: string; line?: number; n: number };
function remembered(): { line?: string; mod?: ModId; narrow?: boolean; side?: boolean } {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {}; } catch { return {}; }
}

interface Props extends Omit<RoomActions, 'onOpen'> {
  active: boolean;
  lines: Line[];
  ready: boolean; // the list of projects has loaded
  placements: Placement[];
  tick: number;
  onRoom: (id: string, lineId?: string | null) => void; // a building's own room, over the console
}

export function Console(p: Props) {
  const first = useRef(remembered()).current;
  const hp = new URLSearchParams(location.hash.slice(1));
  const [want, setWant] = useState<string | null>(hp.get('line') ?? first.line ?? null);
  const [mod, setMod] = useState<ModId>(isMod(hp.get('m')) ? hp.get('m') as ModId : first.mod ?? 'overview');
  const [narrow, setNarrow] = useState(!!first.narrow);
  const [side, setSide] = useState(!!first.side); // the assistant's sidebar
  const opened = useRef(false); // you opened it, so its box takes the keys; one left open last time does not
  const toggleSide = () => setSide(o => { opened.current ||= !o; return !o; });
  const [dir, setDir] = useState(1);
  const [rail, setRail] = useState(false);
  const [railTab, setRailTab] = useState<'projects' | 'papers'>('projects');
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [role, setRole] = useState<'lead' | 'coder' | 'writer'>('lead');
  const [asks, setAsks] = useState<Report[]>([]); // questions from the projects' agents, waiting for you
  const [reveal, setReveal] = useState<Reveal | null>(null); // a file to open in the code or paper panel
  const [hist, setHist] = useState<{ back: [string, ModId][]; fwd: [string, ModId][] }>({ back: [], fwd: [] });
  const phone = useMedia(PHONE);
  const dirty = useRef({ code: 0, paper: 0 });
  const searchRef = useRef<HTMLInputElement>(null);

  const lines = useMemo(() => [...p.lines].sort((a, b) => b.seq - a.seq), [p.lines]);
  const asked = useMemo(() => new Set(asks.map(a => a.line_id)), [asks]);
  // the project asked for, else the first that needs you, else the newest
  const cur = lines.find(l => l.id === want) ?? lines.find(l => needsYou(l, asked)) ?? lines.find(l => l.status === 'running') ?? lines[0] ?? null;
  const id = cur?.id ?? '';
  const full = useFetch(() => api.line(id), id, p.tick);
  const ws = useFetch(() => api.ws(id), id, p.tick);
  const line = full.data ?? null;

  useEffect(() => {
    if (!cur) return; // still loading: keep the project remembered last time
    try { localStorage.setItem(KEY, JSON.stringify({ line: cur.id, mod, narrow, side })); } catch { /* private mode */ }
  }, [cur?.id, mod, narrow, side]); // eslint-disable-line react-hooks/exhaustive-deps
  // a narrow window with the assistant open folds the drawer to its icons, to leave the panel room
  const squeezed = useMedia('(max-width: 1320px)') && side;
  useEffect(() => setPlace(cur ? { id: cur.id, seq: cur.seq, title: cur.title } : null, mod, MODS.find(m => m.id === mod)!.name), [cur?.id, cur?.title, mod]); // eslint-disable-line react-hooks/exhaustive-deps
  usePanelNote('agents', 'role', { 员工: mod === 'agents' ? ROLES[role][0] : null });

  // what the projects' agents ask you, and what they report as key, wherever you are
  useEffect(() => {
    let alive = true;
    const load = () => api.reports().then(r => alive && setAsks(r.asks)).catch(() => {});
    load();
    const off = listen(e => {
      if (e.type !== 'report') return;
      const r = e.report as Report, l = p.lines.find(x => x.id === r.line_id);
      if (r.kind === 'ask' && r.data.open) p.toast(tr('#{0} 的{1}在问你：{2}', l?.seq ?? '?', trx(r.data.who ?? ''), gist(r.data.question, 80)));
      else if (r.kind === 'report' && r.data.key) p.toast(tr('#{0} 的{1}：{2}', l?.seq ?? '?', trx(r.data.who ?? ''), gist(r.data.text, 80)));
      if (r.kind === 'ask') load();
    });
    return () => { alive = false; off(); };
  }, [p.lines]); // eslint-disable-line react-hooks/exhaustive-deps

  // the panels that keep their state while another is shown: their editors, open files and edits
  const [kept, setKept] = useState<Set<ModId>>(new Set());
  useEffect(() => { setKept(new Set()); setReveal(null); }, [id]);
  useEffect(() => { if (mod === 'code' || mod === 'paper') setKept(k => (k.has(mod) ? k : new Set([...k, mod]))); }, [mod, id]);

  const unsaved = () => dirty.current.code + dirty.current.paper;
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (unsaved()) { e.preventDefault(); e.returnValue = ''; } };
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, []);

  const go = useCallback((to: { line?: string; mod?: ModId }, record = true) => {
    const nextLine = to.line ?? id, nextMod = to.mod ?? mod;
    if (nextLine === id && nextMod === mod) return;
    if (nextLine !== id && unsaved() && !confirm(tr('有文件还没保存，换项目会丢掉这些修改。继续吗？'))) return;
    if (record && id) setHist(h => ({ back: [...h.back.slice(-40), [id, mod]], fwd: [] }));
    setDir(IDS.indexOf(nextMod) >= IDS.indexOf(mod) ? 1 : -1);
    if (nextLine !== id) dirty.current = { code: 0, paper: 0 };
    setWant(nextLine);
    setMod(nextMod);
  }, [id, mod]);
  const back = () => {
    const last = hist.back[hist.back.length - 1];
    if (!last) return;
    setHist(h => ({ back: h.back.slice(0, -1), fwd: [[id, mod], ...h.fwd] }));
    go({ line: last[0], mod: last[1] }, false);
  };
  const fwd = () => {
    const next = hist.fwd[0];
    if (!next) return;
    setHist(h => ({ back: [...h.back, [id, mod]], fwd: h.fwd.slice(1) }));
    go({ line: next[0], mod: next[1] }, false);
  };

  // what the assistant opens for you, or a job or file named in its reply that you click: a panel,
  // a file at a line, a job's details, a part of the page lit up
  const show = useCallback((t: ShowTarget) => {
    const job = t.job && /^\d+$/.test(t.job) ? `nvidb-${t.job}` : t.job;
    const [root, path, ln] = t.file ? (/^(code|paper):(.+?)(?::(\d+))?$/.exec(t.file) ?? []).slice(1) : [];
    const m = isMod(t.mod) ? t.mod : job ? 'exp' : root === 'paper' ? 'paper' : root ? 'code' : undefined;
    go({ line: t.line, mod: m });
    if ((root === 'code' || root === 'paper') && path) setReveal(r => ({ root, path, line: ln ? Number(ln) : undefined, n: (r?.n ?? 0) + 1 }));
    if (job) setTimeout(() => dispatchEvent(new CustomEvent('pt-open-job', { detail: job })), 80);
    const ref = t.ref ?? (job ? `job:${job}` : path ? `file:${root}:${path}` : undefined);
    if (ref) setTimeout(() => flash(ref), 200);
  }, [go]);
  useEffect(() => listen(e => { if (e.type === 'assistant_show') show(e.target ?? {}); }), [show]);
  useEffect(() => {
    const on = (e: Event) => show((e as CustomEvent<ShowTarget>).detail);
    addEventListener('pt-show', on);
    return () => removeEventListener('pt-show', on);
  }, [show]);

  // a building asked for from inside a panel: its panel here when there is one, else its room
  const typeOf = (bid: string) => p.placements.find(x => x.id === bid)?.type ?? bid;
  const openBuilding = useCallback((bid: string, lineId?: string | null) => {
    const m = BY_BUILDING[typeOf(bid)];
    if (m) go({ mod: m, line: lineId ?? undefined });
    else p.onRoom(bid, lineId);
  }, [go, p.placements, p.onRoom]); // eslint-disable-line react-hooks/exhaustive-deps
  function onClick(e: React.MouseEvent) {
    const el = (e.target as Element).closest('[data-open]');
    if (!el) return;
    e.stopPropagation();
    openBuilding(el.getAttribute('data-open')!, el.getAttribute('data-line'));
  }

  // keys: ⌘K finds a project, ⌘J opens and closes the assistant, 1–9 and 0 pick a panel, Esc folds the rail
  useEffect(() => {
    if (!p.active) return;
    const key = (e: KeyboardEvent) => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      const typing = !!t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.getAttribute('role') === 'combobox' || !!t.closest('.cm-editor'));
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setRail(true); requestAnimationFrame(() => searchRef.current?.focus()); return; }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'j') { e.preventDefault(); toggleSide(); return; }
      if (e.key === 'Escape' && rail) { e.stopImmediatePropagation(); setRail(false); return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('.interior, .proto.chat-open, .settings')) return;
      const n = '1234567890'.indexOf(e.key);
      if (n >= 0 && IDS[n]) { e.preventDefault(); go({ mod: IDS[n] }); }
    };
    addEventListener('keydown', key, true);
    return () => removeEventListener('keydown', key, true);
  }, [p.active, rail, go]);

  const actions: RoomActions = { ...p, onOpen: (bid, lineId) => openBuilding(bid, lineId) };
  const here = MODS.find(m => m.id === mod)!;
  const waiting = lines.filter(l => needsYou(l, asked)).length;
  const pick = (l: Line, m?: ModId) => { go({ line: l.id, mod: m }); setTimeout(() => setRail(false), 160); };

  if (!cur && !p.ready) return <main className="p-console"><p className="cm-loading muted">{tr('加载中…')}</p></main>;
  if (!cur) return (
    <main className="p-console">
      <div className="cm-empty first">
        <Icon n="folder" size={40} />
        <h3>{tr('还没有项目')}</h3>
        <p>{tr('放入一颗 idea，孵化场会先查重，再按工序做下去。也可以在 projects.json 里接入你自己的代码和论文仓库。')}</p>
        <button className="btn pri" onClick={p.onIdea}><Icon n="plus" size={14} />{tr('放入一颗新 idea')}</button>
      </div>
    </main>
  );

  return (
    <main className={`p-console${rail ? ' rail-open' : ''}`} onClick={onClick}>
      <div className="fbar">
        <div className="fb-nav">
          <button className="ib" disabled={!hist.back.length} onClick={back} title={tr('后退')}><Icon n="left" size={16} /></button>
          <button className="ib" disabled={!hist.fwd.length} onClick={fwd} title={tr('前进')}><Icon n="right" size={16} /></button>
        </div>
        <nav className="fb-path" aria-label={tr('位置')}>
          <button className="crumb home" onClick={() => { setRailTab('projects'); setFilter('all'); setRail(r => !r); }} title={tr('全部项目')}>
            <Icon n="folder" size={16} /><span className="crumb-l">{tr('全部项目')}</span>
          </button>
          <Icon n="chevron" size={13} className="fb-sep" />
          <button className={`crumb cur${rail ? ' open' : ''}`} onClick={() => setRail(r => !r)} title={tr('换一个项目（⌘K）')}>
            <i className={`fb-dot d-${cur.status}`} /><b>#{cur.seq}</b><span className="crumb-t">{cur.title}</span>
            <Icon n="down" size={14} className="fb-chev" />
          </button>
          <Icon n="chevron" size={13} className="fb-sep" />
          <span className="crumb leaf" key={mod}><Icon n={here.icon} size={15} />{here.name}</span>
        </nav>
        <div className="fb-r">
          {waiting > 0 && (
            <button className="fb-wait" onClick={() => { setRailTab('projects'); setFilter('you'); setRail(true); }} title={tr('{0} 个项目等你', waiting)}>
              <i /><span className="fb-wl">{tr('{0} 个项目等你', waiting)}</span><b className="fb-wn">{waiting}</b>
            </button>
          )}
          <label className="fb-q">
            <Icon n="lens" size={15} />
            <input ref={searchRef} placeholder={tr('找项目或论文')} value={q} onChange={e => { setQ(e.target.value); setRail(true); }}
              onFocus={() => setRail(true)} />
            <kbd>⌘K</kbd>
          </label>
          <button className="btn pri fb-new" onClick={p.onIdea}><Icon n="plus" size={14} />{tr('新 idea')}</button>
          <button className={`fb-side${side ? ' on' : ''}`} onClick={toggleSide} title={side ? tr('收起小助手（⌘J）') : tr('小助手：问这一页的事，请它帮你办（⌘J）')}
            aria-pressed={side}><Icon n="chat" size={16} /><span>{tr('小助手')}</span></button>
        </div>
      </div>

      <div className="rail-back" onClick={() => setRail(false)} />
      <Rail open={rail} lines={lines} cur={cur} tab={railTab} setTab={setRailTab} filter={filter} setFilter={setFilter} q={q} setQ={setQ}
        asked={asked} phone={phone} onPick={pick} onIdea={() => { setRail(false); p.onIdea(); }} onClose={() => setRail(false)} />

      <div className="cbody">
        {!phone && <Drawer mod={mod} narrow={narrow || squeezed} locked={squeezed} setNarrow={setNarrow} line={line} code={ws.data?.code?.dirty ?? 0} onPick={m => go({ mod: m })} />}
        <div className="cm" key={id}>
          {!kept.has(mod) && (
            <section className={`cm-mod on${BLEED.has(mod) ? ' bleed' : ''}`} key={mod} style={{ ['--dir' as string]: dir }}>
              {mod === 'overview' ? <Overview line={line} info={ws.data} tick={p.tick} placements={p.placements} go={m => go({ mod: m })}
                onHatch={p.onHatch} onResume={p.onResume} onAdjust={p.onAdjust} onAsk={() => p.onAsk('mill', tr('造纸厂'))} onOpen={bid => openBuilding(bid, id)}
                toast={p.toast} onLead={() => { setRole('lead'); go({ mod: 'agents' }); }} />
                : mod === 'survey' ? <Survey line={line} tick={p.tick} onHatch={p.onHatch} onAdjust={p.onAdjust} />
                  : mod === 'exp' ? <Experiments lineId={id} tick={p.tick} onData={() => go({ mod: 'data' })} />
                    : mod === 'data' ? <Data lineId={id} tick={p.tick} onOpenFile={path => { setReveal(r => ({ root: 'code', path, n: (r?.n ?? 0) + 1 })); go({ mod: 'code' }); }} />
                      : mod === 'agents' ? (
                        <div className="cm-agents">
                          <div className="cm-sub">
                            <div className="seg" role="tablist">
                              {(Object.keys(ROLES) as (keyof typeof ROLES)[]).map(r => <button key={r} className={role === r ? 'on' : ''} onClick={() => setRole(r)}>{ROLES[r][1]}</button>)}
                            </div>
                            <span className="muted small">{ROLES[role][2]}</span>
                          </div>
                          <AgentDesk key={`${role}:${id}`} {...actions} role={role} focus={id} lines={p.lines} tick={p.tick} lineId={id} />
                        </div>
                      )
                        : mod === 'skills' ? <SkillRoom key={id} {...actions} focus={id} tick={p.tick} />
                          : mod === 'mcp' ? <McpRoom {...actions} tick={p.tick} />
                            : mod === 'rag' ? <RagRoom {...actions} tick={p.tick} />
                              : mod === 'rules' ? <Bounds line={line} toast={p.toast} /> : null}
            </section>
          )}
          {kept.has('code') && (
            <section className={`cm-mod bleed${mod === 'code' ? ' on' : ''}`} style={{ ['--dir' as string]: dir }}>
              <Code lineId={id} info={ws.data} tick={p.tick} toast={p.toast} reveal={reveal?.root === 'code' ? reveal : null} onDirty={n => { dirty.current.code = n; }} onAgents={() => { setRole('coder'); go({ mod: 'agents' }); }} />
            </section>
          )}
          {kept.has('paper') && (
            <section className={`cm-mod bleed${mod === 'paper' ? ' on' : ''}`} style={{ ['--dir' as string]: dir }}>
              <Paper lineId={id} info={ws.data} tick={p.tick} toast={p.toast} reveal={reveal?.root === 'paper' ? reveal : null} onDirty={n => { dirty.current.paper = n; }} onAgents={() => { setRole('writer'); go({ mod: 'agents' }); }} />
            </section>
          )}
        </div>
        {side && <Assistant actions={actions} autoFocus={opened.current} onClose={() => setSide(false)} />}
      </div>
      {phone && <PhoneTabs mod={mod} line={line} code={ws.data?.code?.dirty ?? 0} onPick={m => { setSide(false); go({ mod: m }); }} />}
      {p.active && <NewModels toast={p.toast} />}
      <EdPicker />
    </main>
  );
}

// ---------- the module drawer ----------

// each research panel's mark: how its stages stand
function markOf(line: Line | null, m: ModId) {
  const st = (line?.stages ?? []).filter(s => STAGE_MOD[s.key] === m && s.key !== 'idea').map(s => s.status);
  if (m === 'data') return line?.stages.find(s => s.key === 'exp')?.status === 'done' ? 'done' : '';
  if (!st.length) return '';
  return st.includes('run') ? 'run' : st.includes('wait') ? 'wait' : st.every(s => s === 'done') ? 'done' : '';
}

function Drawer({ mod, narrow, locked, setNarrow, line, code, onPick }: {
  mod: ModId; narrow: boolean; locked: boolean; setNarrow: (f: (n: boolean) => boolean) => void; line: Line | null; code: number; onPick: (m: ModId) => void;
}) {
  const box = useRef<HTMLElement>(null);
  const [pill, setPill] = useState<{ y: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = box.current?.querySelector<HTMLElement>(`[data-m="${mod}"]`);
    if (el) setPill({ y: el.offsetTop, h: el.offsetHeight });
  }, [mod, narrow]);

  const item = (m: typeof MODS[number], i: number) => {
    const k = markOf(line, m.id);
    return (
      <button key={m.id} data-m={m.id} className={`cd-item${m.id === mod ? ' on' : ''}`} onClick={() => onPick(m.id)}
        title={`${m.name} · ${m.sub}${i < 10 ? `  (${(i + 1) % 10})` : ''}`} style={{ ['--i' as string]: i }}>
        <Icon n={m.icon} size={18} />
        <span className="cd-name">{m.name}</span>
        {m.id === 'code' && code > 0 ? <em className="cd-n" title={tr('{0} 处改动', code)}>{code}</em> : k && <i className={`cd-dot k-${k}`} />}
      </button>
    );
  };
  return (
    <nav className={`cdrawer${narrow ? ' narrow' : ''}`} ref={box}>
      {pill && <span className="cd-pill" style={{ transform: `translateY(${pill.y}px)`, height: pill.h }} />}
      <h6>{tr('研究流程')}</h6>
      {MODS.filter(m => !m.town).map(item)}
      <h6>{tr('小镇配置')}</h6>
      {MODS.filter(m => m.town).map((m, i) => item(m, i + 7))}
      <span className="sp" />
      {!locked && <button className="cd-fold" onClick={() => setNarrow(n => !n)} title={narrow ? tr('展开') : tr('收起')}>
        <Icon n={narrow ? 'right' : 'left'} size={15} /><span className="cd-name">{tr('收起')}</span>
      </button>}
    </nav>
  );
}

// ---------- a phone's tabs ----------

// along the bottom, the four panels looked at most; the fifth tab is 更多, every panel in a sheet,
// and stands for the panel shown when it is one of those
function PhoneTabs({ mod, line, code, onPick }: { mod: ModId; line: Line | null; code: number; onPick: (m: ModId) => void }) {
  const [more, setMore] = useState(false);
  const other = PHONE_TABS.includes(mod) ? null : MODS.find(m => m.id === mod)!;
  const pick = (m: ModId) => { setMore(false); onPick(m); };
  const mark = (m: ModId) => (m === 'code' && code > 0 ? <em className="cd-n">{code}</em> : markOf(line, m) && <i className={`cd-dot k-${markOf(line, m)}`} />);
  // what waits under 更多 shows on its tab
  const behind = code > 0 || MODS.some(m => !PHONE_TABS.includes(m.id) && markOf(line, m.id) === 'wait');
  return (
    <>
      <nav className="mtabs" aria-label={tr('面板')}>
        {PHONE_TABS.map(id => {
          const m = MODS.find(x => x.id === id)!;
          return (
            <button key={id} className={`mt${mod === id && !more ? ' on' : ''}`} onClick={() => pick(id)} aria-current={mod === id}>
              <span className="mt-ic"><Icon n={m.icon} size={21} />{mark(id)}</span>
              <span className="mt-l">{m.name}</span>
            </button>
          );
        })}
        <button className={`mt${other || more ? ' on' : ''}`} onClick={() => setMore(o => !o)} aria-expanded={more}>
          <span className="mt-ic"><Icon n={other && !more ? other.icon : 'cards'} size={21} />{other && !more ? mark(other.id) : behind && <i className="cd-dot k-wait" />}</span>
          <span className="mt-l">{other && !more ? other.name : tr('更多')}</span>
        </button>
      </nav>
      {more && (
        <div className="msheet-back" onClick={() => setMore(false)}>
          <div className="msheet" role="dialog" aria-label={tr('全部面板')} onClick={e => e.stopPropagation()}>
            <span className="sheet-grip" />
            {[[tr('研究流程'), MODS.filter(m => !m.town)], [tr('小镇配置'), MODS.filter(m => m.town)]].map(([h, ms]) => (
              <section key={h as string}>
                <h6>{h as string}</h6>
                {(ms as typeof MODS).map(m => (
                  <button key={m.id} className={`ms-row${m.id === mod ? ' on' : ''}`} onClick={() => pick(m.id)}>
                    <Icon n={m.icon} size={20} />
                    <span className="ms-t"><b>{m.name}</b><span>{m.sub}</span></span>
                    {mark(m.id)}
                  </button>
                ))}
              </section>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ---------- the rail of folders ----------

function Rail({ open, lines, cur, tab, setTab, filter, setFilter, q, setQ, asked, phone, onPick, onIdea, onClose }: {
  open: boolean; lines: Line[]; cur: Line; tab: 'projects' | 'papers'; setTab: (t: 'projects' | 'papers') => void; asked: Set<string>;
  filter: Filter; setFilter: (f: Filter) => void; q: string; setQ: (q: string) => void; phone: boolean;
  onPick: (l: Line, m?: ModId) => void; onIdea: () => void; onClose: () => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [hi, setHi] = useState(0);
  const test = FILTERS.find(f => f[0] === filter)![2];
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return lines.filter(l => (tab === 'papers' ? hasPaper(l) : test(l, asked))
      && (!t || `#${l.seq} ${l.title} ${l.idea} ${l.linked?.paper?.title ?? ''}`.toLowerCase().includes(t)));
  }, [lines, tab, test, q, asked]);

  // opening: the current folder comes into view and takes the keys
  useEffect(() => {
    if (!open) return;
    const i = Math.max(0, shown.findIndex(l => l.id === cur.id));
    setHi(i);
    requestAnimationFrame(() => {
      const t = track.current, el = t?.children[i] as HTMLElement | undefined;
      // on a phone the folders run down, not across; the sheet is still rising, so by where they lie, not where they show
      if (phone) { if (t && el) t.scrollTop = Math.max(0, el.offsetTop + el.offsetHeight + 16 - t.clientHeight); }
      else revealX(t, el, true);
      if (!(document.activeElement instanceof HTMLInputElement)) track.current?.focus({ preventScroll: true });
    });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setHi(h => Math.min(h, Math.max(0, shown.length - 1))); }, [shown.length]);
  useEffect(() => revealX(track.current, track.current?.children[hi]), [hi]);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowRight') { e.preventDefault(); setHi(h => Math.min(shown.length - 1, h + 1)); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); setHi(h => Math.max(0, h - 1)); }
    else if (e.key === 'Enter' && shown[hi]) { e.preventDefault(); onPick(shown[hi], tab === 'papers' ? 'paper' : undefined); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  }
  const scroll = (d: number) => track.current?.scrollBy({ left: d * track.current.clientWidth * 0.8, behavior: 'smooth' });
  const counts = Object.fromEntries(FILTERS.map(([k, , f]) => [k, lines.filter(l => f(l, asked)).length]));

  return (
    <div className={`rail${open ? ' open' : ''}`} aria-hidden={!open} onKeyDown={onKey}>
      <div className="rail-head">
        <div className="seg rail-tabs" role="tablist">
          <button className={tab === 'projects' ? 'on' : ''} onClick={() => setTab('projects')}>{tr('项目')}</button>
          <button className={tab === 'papers' ? 'on' : ''} onClick={() => setTab('papers')}>{tr('论文')}</button>
        </div>
        {tab === 'projects' && <div className="rail-filters">
          {FILTERS.map(([k, name]) => counts[k] > 0 || k === 'all' ? (
            <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{name}<span>{counts[k]}</span></button>
          ) : null)}
        </div>}
        <span className="rail-keys muted small"><kbd>←</kbd><kbd>→</kbd> {tr('挑选')} · <kbd>Enter</kbd> {tr('打开')} · <kbd>Esc</kbd> {tr('收起')}</span>
        {phone && (
          <label className="rail-q">
            <Icon n="lens" size={16} />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder={tr('找项目或论文')} enterKeyHint="search" />
            {q && <button className="ib" onClick={() => setQ('')} aria-label={tr('清空')}><Icon n="close" size={14} /></button>}
          </label>
        )}
      </div>
      <div className="rail-wrap">
        <button className="rail-arrow l" onClick={() => scroll(-1)} aria-label={tr('向左')}><Icon n="left" size={18} /></button>
        <div className="rail-track" ref={track} tabIndex={-1}
          onWheel={e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY; }}>
          {shown.map((l, i) => tab === 'papers'
            ? <PaperCard key={l.id} l={l} i={i} on={l.id === cur.id} hi={i === hi} onPick={() => onPick(l, 'paper')} />
            : <Folder key={l.id} l={l} i={i} on={l.id === cur.id} hi={i === hi} onPick={() => onPick(l)} />)}
          {tab === 'projects' && filter === 'all' && !q && (
            <button className="fcard fnew" style={{ ['--i' as string]: shown.length }} onClick={onIdea}>
              <span className="fc-tab" /><span className="fc-body"><Icon n="plus" size={26} /><b>{tr('放入一颗新 idea')}</b></span>
            </button>
          )}
          {!shown.length && (q || filter !== 'all' || tab === 'papers') && <p className="muted rail-none">{tab === 'papers' && !q ? tr('还没有哪个项目写到论文。') : tr('没有符合的项目。')}</p>}
        </div>
        <button className="rail-arrow r" onClick={() => scroll(1)} aria-label={tr('向右')}><Icon n="right" size={18} /></button>
      </div>
    </div>
  );
}

function Folder({ l, i, on, hi, onPick }: { l: Line; i: number; on: boolean; hi: boolean; onPick: () => void }) {
  const done = l.stages.filter(s => s.status === 'done').length;
  return (
    <button className={`fcard d-${l.status}${on ? ' on' : ''}${hi ? ' hi' : ''}`} style={{ ['--i' as string]: i }} onClick={onPick} title={l.idea}>
      <span className="fc-tab" />
      <span className="fc-body">
        <span className="fc-top"><b>#{l.seq}</b><span className={`pst pst-${l.status}`}>{STATUS[l.status] ?? l.status}</span></span>
        <span className="fc-title">{l.title}</span>
        <span className="fc-stages" title={tr('{0}/{1} 站完成', done, l.stages.length)}>{l.stages.map(s => <i key={s.key} className={`k-${s.status}`} />)}</span>
        <span className="fc-foot muted small">{l.linked ? tr('本地项目 · {0}', l.linked.key) : l.current?.name ?? l.stage}</span>
      </span>
    </button>
  );
}

function PaperCard({ l, i, on, hi, onPick }: { l: Line; i: number; on: boolean; hi: boolean; onPick: () => void }) {
  const pp = l.linked?.paper;
  const write = l.stages.find(s => s.key === 'write');
  return (
    <button className={`pcard2${on ? ' on' : ''}${hi ? ' hi' : ''}`} style={{ ['--i' as string]: i }} onClick={onPick}>
      <span className="pp-fold" />
      <span className="pp-lines"><i /><i /><i /><i /></span>
      <b className="pp-title">{pp?.title ?? l.title}</b>
      <span className="pp-foot muted small">
        #{l.seq} · {pp ? (pp.main ?? pp.name) : 'main.tex'}
        {(pp?.pdf || l.files.includes('main.pdf')) && <em>PDF</em>}
        {write?.status === 'run' && <em className="run">{tr('写作中')}</em>}
      </span>
    </button>
  );
}
