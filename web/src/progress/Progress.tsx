// 进展: every project as a card in a grid or as a row (Rows.tsx), and the routes under
// /progress/<number>: the project in full, asking it (/ask), the pages its agents wrote (/pages) and its canvas (/canvas).

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { api, listen, type CardLayout, type Pane, type PaperCard, type PaseoDefaults, type ProjectCard } from '../api';
import { StatusTag } from '../components/MillRoom';
import { Icon } from '../console/icons';
import { tr } from '../i18n';
import { UsageMark } from '../usage/Usage';
import { follow, go, href, type Route } from '../route';
import { setSettings, useSettings, type PgGroup, type PgSort, type Settings as S } from '../settings';
import { AskPage } from './Ask';
import { DisplayMenu, rowCols } from './Display';
import { pagesPath, PagesView, type PageOpen } from './Pages';
import { AskButton, CardPane, opens, UpdateButton, Stages, useCardActs, Who, youNeeded } from './parts';
import { Project, type ConsoleTarget } from './Project';
import { ProjectRows, type Group } from './Rows';

const CanvasPage = lazy(() => import('./Canvas'));
const DecidedPage = lazy(() => import('./Decided'));
const ProvPage = lazy(() => import('./Prov'));
import './progress.css';

type Filter = 'all' | 'you' | 'run' | 'done';
const FILTERS: [Filter, string, (c: ProjectCard) => boolean][] = [
  ['all', tr('全部'), () => true],
  ['you', tr('待处理'), youNeeded],
  ['run', tr('进行中'), c => ['running', 'linked'].includes(c.line.status)],
  ['done', tr('已完成'), c => c.line.status === 'done'],
];
// what needs you first, then what is stuck, then what is moving; finished ones last
const rank = (c: ProjectCard) => (c.line.status === 'done' ? 9 : youNeeded(c) ? 0 : c.card?.health === 'blocked' ? 1 : c.card?.health === 'risk' ? 2 : 3);
const STATE: Record<number, string> = { 0: tr('待处理'), 1: tr('受阻'), 2: tr('有风险'), 3: tr('进行中'), 9: tr('已完成') };
const moved = (c: ProjectCard) => Math.max(Date.parse(c.line.updated_at) || 0, Date.parse(c.card?.at ?? '') || 0);
// how far along: what its lead says, else the share of its stages that are done
const far = (c: ProjectCard) => c.card?.progress ?? Math.round(100 * c.line.stages.filter(x => x.status === 'done').length / Math.max(1, c.line.stages.length));
export const SORTS: Record<PgSort, (a: ProjectCard, b: ProjectCard) => number> = {
  need: (a, b) => rank(a) - rank(b) || b.line.seq - a.line.seq,
  recent: (a, b) => moved(b) - moved(a),
  progress: (a, b) => far(b) - far(a) || b.line.seq - a.line.seq,
  number: (a, b) => a.line.seq - b.line.seq,
};
// the list in sections, in their own order; the sort still holds inside each
export function grouped(list: ProjectCard[], by: PgGroup): Group[] {
  if (by === 'none') return [{ key: 'all', name: '', items: list }];
  const found = new Map<string, Group & { at: number }>();
  for (const c of list) {
    const { stage, stages } = c.line;
    const [at, name] = by === 'state' ? [rank(c), STATE[rank(c)]] : stage ? [stages.findIndex(x => x.name === stage.name), stage.name] : [99, tr('全部完成')];
    if (!found.has(name)) found.set(name, { key: name, name, at, items: [] });
    found.get(name)!.items.push(c);
  }
  return [...found.values()].sort((a, b) => a.at - b.at);
}
const SIZES = {
  pgCard: { narrow: '250px', mid: '300px', wide: '400px' }, pgText: { small: .92, mid: 1, large: 1.1 }, pgWidth: { narrow: '1240px', mid: '1840px', full: 'none' },
};
const pageLook = (s: S) => ({ ['--pg-min' as string]: SIZES.pgCard[s.pgCard], ['--pg-zoom' as string]: SIZES.pgText[s.pgText], ['--pg-max' as string]: SIZES.pgWidth[s.pgWidth] });

type Open = (lineId: string, t?: ConsoleTarget) => void;

export function Progress({ active, seq, sub, page, toast, onOpen }: {
  active: boolean; seq?: number; sub?: Route['sub']; page?: string; toast: (t: string, error?: boolean) => void; onOpen: Open;
}) {
  const [rows, setRows] = useState<ProjectCard[] | null>(null);
  const [layout, setLayout] = useState<CardLayout | null>(null);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [defs, setDefs] = useState<PaseoDefaults | null>(null);
  const [busy, setBusy] = useState(false);
  const [, setNow] = useState(0);
  const again = useRef(0);
  const s = useSettings();

  // an agent's change that moves 待你决定: the lead's, or any agent's that starts or stops waiting on you
  const deciding = useRef(new Set<string>());
  deciding.current = new Set((rows ?? []).filter(r => r.decisions?.length).map(r => r.line.id));
  const asking = (a?: { role?: string; line_id?: string | null; watch?: { bucket?: string } }) =>
    !!a && (a.role === 'lead' || a.watch?.bucket === 'needs' || (!!a.line_id && deciding.current.has(a.line_id)));

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const load = () => api.cards().then(r => { if (alive) { setRows(r.cards); setLayout(r.layout); setErr(''); } }, e => alive && setErr((e as Error).message));
    load();
    api.modelNews().then(r => alive && setDefs(r.defaults)).catch(() => {});
    const off = listen(e => {
      if (e.type === 'card' && e.card) setRows(rs => rs && rs.map(r => (r.line.id === e.card.line.id ? { ...e.card, line: { ...e.card.line, lead: r.line.lead, sample: r.line.sample } } : r)));
      else if (e.type === 'card_layout' && e.layout) setLayout(e.layout);
      else if (['line', 'job', 'report', 'memory', 'usage', 'decided', 'prov'].includes(e.type) || (e.type === 'agent' && asking(e.agent))) {
        clearTimeout(again.current);
        again.current = window.setTimeout(load, 1500);
      }
      if (e.type === 'paseo_models' && e.defaults) setDefs(e.defaults);
    });
    const t = setInterval(() => setNow(n => n + 1), 30000); // keeps how long an update has waited current
    return () => { alive = false; off(); clearInterval(t); clearTimeout(again.current); };
  }, [active]);

  const sorted = useMemo(() => [...(rows ?? [])].sort(SORTS[s.pgSort]), [rows, s.pgSort]);
  const shown = sorted.filter(FILTERS.find(f => f[0] === filter)![2]).filter(c => s.pgDone || filter === 'done' || c.line.status !== 'done');
  const groups = grouped(shown, s.pgGroup);
  const put = (r: ProjectCard) => setRows(rs => rs && rs.map(x => (x.line.id === r.line.id ? r : x)));
  const leads = (rows ?? []).filter(r => r.lead?.started && !r.pending).length;
  const waiting = (rows ?? []).filter(youNeeded).length;
  const project = seq != null ? rows?.find(r => r.line.seq === seq) : undefined;
  const panes = layout?.panes ?? [];

  const opener = (p: ProjectCard) => (o: PageOpen) => {
    if (o.file) onOpen(p.line.id, { file: /^(code|paper):/.test(o.file) ? o.file : `code:${o.file}` });
    else if (o.job) onOpen(p.line.id, { job: o.job });
    else if (o.page) go(pagesPath(p.line.seq, o.page));
  };

  async function updateAll() {
    setBusy(true);
    try {
      const r = await api.updateCards();
      toast(r.sent.length ? tr('已请 {0} 个项目的负责人更新卡片，完成后将自动刷新。', r.sent.length) : tr('暂无可更新项：请先开启项目负责人。'));
      setRows((await api.cards()).cards);
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  }
  async function choose(next: Pane[] | null) {
    const before = layout;
    if (layout && next) setLayout({ ...layout, panes: next });
    try { setLayout(await api.setLayout(next)); } catch (e) { setLayout(before); toast((e as Error).message, true); }
  }

  return (
    <main className="p-prog" data-density={s.pgDensity} data-stages={s.pgStages ? 'on' : 'off'} style={pageLook(s)}>
      <div className="pg-wrap">
        {seq != null ? (
          project && sub ? null
          : project ? <Project key={project.line.id} r={project} defs={defs} toast={toast} onChange={put} onConsole={onOpen} />
            : <p className="muted pg-none">{rows ? <>{tr('未找到项目 #{0}。', seq)} <a href={href('/progress')} onClick={e => follow(e, '/progress')}>{tr('查看全部项目')}</a></> : tr('加载中…')}</p>
        ) : (
          <>
            <header className="pg-head">
              <div className="pg-title">
                <h1>{tr('项目进展')}</h1>
                <p className="muted small">
                  {rows ? tr('{0} 个项目', rows.length) : '…'}{waiting > 0 && <> · <b className="em-bar" data-tone="warn">{tr('{0} 项待处理', waiting)}</b></>}
                  {' · '}{tr('卡片由各项目负责人填写，点击「更新」后刷新')}
                </p>
              </div>
              <div className="pg-tools">
                <div className="seg mini" role="tablist">
                  {FILTERS.map(([k, name, f]) => <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{name}{rows && k !== 'all' ? ` ${rows.filter(f).length}` : ''}</button>)}
                </div>
                <div className="seg mini pg-view" role="radiogroup" aria-label={tr('排列方式')}>
                  {(['blocks', 'rows'] as const).map(v => (
                    <button key={v} role="radio" aria-checked={s.pgView === v} className={s.pgView === v ? 'on' : ''} onClick={() => setSettings({ pgView: v })}
                      title={v === 'blocks' ? tr('每个项目一张卡片') : tr('每个项目一行')}><Icon n={v === 'blocks' ? 'cards' : 'rows'} size={14} />{v === 'blocks' ? tr('块') : tr('行')}</button>
                  ))}
                </div>
                {layout && <DisplayMenu s={s} layout={layout} onPanes={choose} />}
                <button className="btn pri" disabled={busy || !leads} onClick={updateAll} title={tr('请每个有负责人的项目更新卡片')}>
                  <Icon n="refresh" size={14} />{busy ? tr('发送中…') : tr('全部更新')}
                </button>
              </div>
            </header>
            {err && <p className="small em-state" data-tone="bad">{err}</p>}
            {!rows && !err && <p className="muted">{tr('加载中…')}</p>}
            {rows && !rows.length && <p className="muted pg-none">{tr('暂无项目。在中控屏中放入 idea，或在 projects.json 中接入自有项目。')}</p>}
            {rows && rows.length > 0 && !shown.length && <p className="muted pg-none">{tr('暂无匹配项目。')}</p>}
            {shown.length > 0 && (s.pgView === 'rows' ? <ProjectRows groups={groups} cols={rowCols(s)} defs={defs} toast={toast} onChange={put} />
              : groups.map(g => (
                <section key={g.key} className="pg-sec">
                  {g.name && <h2 className="pg-gh">{g.name}<span>{g.items.length}</span></h2>}
                  <div className="pg-grid">
                    {g.items.map((r, i) => <ProjectBox key={r.line.id} r={r} i={i} panes={panes} defs={defs} toast={toast} onChange={put} />)}
                  </div>
                </section>
              )))}
            {rows && rows.length > 0 && <Fresh />}
          </>
        )}
      </div>
      {active && project && sub === 'ask' && (
        <AskPage r={project} rows={sorted} toast={toast} />
      )}
      {active && project && sub === 'canvas' && <Suspense fallback={null}><CanvasPage r={project} toast={toast} onConsole={onOpen} /></Suspense>}
      {active && project && sub === 'pages' && <PagesView r={project} pid={page} toast={toast} onOpen={opener(project)} />}
      {active && project && sub === 'decided' && <Suspense fallback={null}><DecidedPage r={project} /></Suspense>}
      {active && project && sub === 'prov' && <Suspense fallback={null}><ProvPage r={project} /></Suspense>}
    </main>
  );
}

// under the projects: the library's newest papers, the ones closest to a project in progress first
function Fresh() {
  const [ps, setPs] = useState<(PaperCard & { relevance: number })[]>([]);
  useEffect(() => { api.freshPapers().then(r => setPs(r.papers)).catch(() => {}); }, []);
  if (!ps.length) return null;
  return (
    <section className="pg-sec pg-fresh">
      <h2 className="pg-gh">{tr('新论文')}<span>{tr('按进行中项目相关度排序')}</span></h2>
      <ul>
        {ps.map(p => (
          <li key={p.paper_id}>
            <a href={p.url} target="_blank" rel="noreferrer">{p.title}</a>
            <span className="small muted">{[p.year, p.authors, p.relevance ? tr('相关度 {0}', p.relevance.toFixed(2)) : ''].filter(Boolean).join(' · ')}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// a project's card in the grid: the panes chosen for every card; the rest is on its page
function ProjectBox({ r, i, panes, defs, toast, onChange }: {
  r: ProjectCard; i: number; panes: Pane[]; defs: PaseoDefaults | null; toast: (t: string, error?: boolean) => void; onChange: (r: ProjectCard) => void;
}) {
  const acts = useCardActs(r, toast, onChange);
  const { line, card } = r;
  const o = opens(line);
  return (
    <article className={`pc${card ? ` h-${card.health}` : ''}${r.decisions?.length ? ' need' : ''}`} style={{ ['--i' as string]: i }} {...o.box}>
      <header className="pc-head">
        <span className="pc-name"><span className="pc-seq">#{line.seq}</span>{o.title}</span>
        <StatusTag status={line.status} sample={line.sample} />
        <UsageMark state={line.usage_state} />
      </header>
      <Stages r={r} />
      <div className="pc-panes">
        {panes.map(p => <CardPane key={p} pane={p} r={r} />)}
      </div>
      <footer className="pc-foot" onClick={e => e.stopPropagation()}>
        <Who r={r} />
        <div className="pc-acts">
          <AskButton seq={line.seq} />
          <UpdateButton r={r} acts={acts} defs={defs} />
        </div>
      </footer>
    </article>
  );
}
