// The info cards on a project's canvas (Canvas.tsx): nodes that show the project live, each in the block of the part
// it shows. The progress card and the expected outputs, the three agents with the canvas tasks each holds, the related
// work and the method, the code, the experiment jobs and their results (each run with the file of the code that ran
// it), the datasets, the paper. On the canvas a card is brief and as big as the server says (canvas.py INFO_SIZE);
// opened in the inspector (CanvasSide.tsx) it says everything, with the way to the console panel behind it.

import { createContext, useContext, useEffect, useState } from 'react';
import { api, type CanvasNode, type CanvasView, type CardRepo, type Health, type Line, type LineData, type PaperCard, type ProjectCard, type TaskTo } from '../api';
import { AGENT_STATUS } from '../components/MillRoom';
import { Icon, type IconName } from '../console/icons';
import { ago, base, gist } from '../console/util';
import { tr } from '../i18n';
import { noCardText, OUT_STATE, repoLine, runText } from './parts';

const HEALTH: Record<Health, string> = { ok: tr('顺利'), risk: tr('有风险'), blocked: tr('卡住了') };
const JOBS: [string, string, string][] = [['running', tr('在跑'), 'run'], ['queued', tr('排队'), ''], ['done', tr('完成'), 'ok'], ['failed', tr('失败'), 'bad']];
export const INFO_ICON: Record<string, IconName> = { card: 'cards', agent: 'person', runs: 'flask', code: 'code', paper: 'doc', outputs: 'target',
  survey: 'lens', method: 'map', results: 'spark', datasets: 'table' };
// the console panel behind a card (the results are on the data panel there)
export const INFO_MOD: Record<string, string> = { card: 'overview', agent: 'agents', runs: 'exp', code: 'code', paper: 'paper', outputs: 'overview',
  survey: 'survey', method: 'survey', results: 'data', datasets: 'data' };

// What the cards read beyond the project's card and the canvas: the project itself (its survey and method), the papers
// it found and cites, and its data (datasets, results, runs). Read when the loop opens and again as the project moves on.
export interface More { line: Line | null; data: LineData | null; papers: { survey: PaperCard[]; references: PaperCard[] } | null }
const NO_MORE: More = { line: null, data: null, papers: null };
export const MoreCtx = createContext<More>(NO_MORE);
export function useMore(lineId: string, key: string): More {
  const [m, setM] = useState<More & { id: string }>({ ...NO_MORE, id: lineId });
  useEffect(() => {
    let live = true;
    const get = () => Promise.all([api.line(lineId).catch(() => null), api.data(lineId).catch(() => null), api.papersOf(lineId).catch(() => null)])
      .then(([line, data, papers]) => { if (live) setM(o => ({ id: lineId, line: line ?? (o.id === lineId ? o.line : null), data: data ?? (o.id === lineId ? o.data : null), papers: papers ?? (o.id === lineId ? o.papers : null) })); });
    get();
    const t = window.setInterval(get, 90_000);
    return () => { live = false; window.clearInterval(t); };
  }, [lineId, key]);
  return m.id === lineId ? m : NO_MORE;
}
// the verdict arrives in the page's language
const verdictTone = (verdict: string) => ({ [tr('可孵化')]: 'pass', [tr('需调整')]: 'warn', [tr('已被做过')]: 'fail' } as Record<string, string>)[verdict] ?? 'warn';
const uniq = (xs: string[]) => [...new Set(xs)];
const fmt = (x: number) => (Number.isInteger(x) ? String(x) : Math.abs(x) >= 100 ? x.toFixed(1) : x.toFixed(Math.abs(x) < 1 ? 3 : 2));
export const infoKind = (n: CanvasNode) => (n.ref ?? '').split(':')[0];
const roleOf = (n: CanvasNode) => (n.ref ?? '').split(':')[1] as TaskTo;
const tasksOf = (v: CanvasView, role: TaskTo) => v.nodes.filter(x => x.kind === 'task' && x.to === role);

// the few words in a card's header: how the thing stands
export function InfoState({ n, r, v }: { n: CanvasNode; r: ProjectCard; v: CanvasView }) {
  const k = infoKind(n), m = useContext(MoreCtx);
  if (k === 'survey') { const h = m.line?.outputs?.hatch; return h?.verdict ? <span className={`cg-pill s-${verdictTone(h.verdict)}`}>{h.verdict}</span> : null; }
  if (k === 'results') { const runs = m.data?.runs ?? []; return runs.length ? <span className="ci-st">{tr('{0} 次运行', runs.length)}</span> : null; }
  if (k === 'datasets') { const sets = uniq(m.data?.meta.datasets ?? []); return sets.length ? <span className="ci-st">{sets.length}</span> : null; }
  if (k === 'card') return r.card ? <span className={`cg-pill h-${r.card.health}`}>{HEALTH[r.card.health]}</span> : null;
  if (k === 'agent') {
    const a = v.agents[roleOf(n)];
    return <span className="ci-st"><i className={`dot s-${a.there ? a.status : 'stopped'}`} />{a.there ? AGENT_STATUS[a.status ?? ''] ?? a.status : tr('还没启动')}</span>;
  }
  if (k === 'runs') return r.jobs.running ? <span className="cg-pill st-run">{tr('{0} 个在跑', r.jobs.running)}</span> : null;
  if (k === 'code' || k === 'paper') {
    const x = r.repos[k];
    return x && !x.missing && x.dirty ? <span className="cg-pill s-warn">{tr('{0} 处改动', x.dirty)}</span> : null;
  }
  if (k === 'outputs') {
    const o = r.card?.outputs ?? [];
    return o.length ? <span className="ci-st">{o.filter(x => x.state === 'done').length}/{o.length}</span> : null;
  }
  return null;
}

function List({ title, items, cls, most }: { title: string; items: string[]; cls?: string; most?: number }) {
  if (!items.length) return null;
  const shown = most ? items.slice(0, most) : items;
  return (
    <div className={`ci-list ${cls ?? ''}`}>
      <h6>{title}{items.length > 1 && <em>{items.length}</em>}</h6>
      <ul>{shown.map((x, i) => <li key={i}>{x}</li>)}</ul>
    </div>
  );
}

function Repo({ x, which, full }: { x: CardRepo | null; which: 'code' | 'paper'; full?: boolean }) {
  if (!x) return <p className="muted">{which === 'code' ? tr('还没有代码仓库') : tr('还没有论文')}</p>;
  const counts = which === 'paper'
    ? [x.sections && tr('{0} 节', x.sections), x.figures && tr('{0} 图', x.figures), x.tables && tr('{0} 表', x.tables), x.bib && tr('{0} 篇引用', x.bib)].filter(Boolean).join(' · ')
    : (x.langs ?? []).slice(0, full ? 6 : 3).map(l => `${l.ext} ${l.n}`).join(' · ');
  return (
    <>
      <p className="ci-name">{(which === 'paper' && x.title) || x.name}</p>
      <p>{repoLine(x, which)}</p>
      {counts && <p className="muted">{counts}</p>}
      {which === 'paper' && !x.missing && <p className="muted">{x.pdf_at ? tr('PDF {0}编译', ago(x.pdf_at)) : tr('还没有编译出 PDF')}</p>}
      {x.commit && <p className="muted ci-commit"><Icon n="branch" size={11} />{x.commit.subject} · {ago(x.commit.when)}</p>}
      {full && <p className="muted ci-path">{x.path}</p>}
    </>
  );
}

export function InfoBody({ n, r, v, full, onPick }: { n: CanvasNode; r: ProjectCard; v: CanvasView; full?: boolean; onPick?: (id: string) => void }) {
  const k = infoKind(n), c = r.card, m = useContext(MoreCtx);
  if (k === 'card') { // what the project is, then how it stands; on the canvas the one list that matters most
    const first = c && (c.need_you.length ? 'need' : c.blockers.length ? 'bad' : 'next');
    return (
      <>
        <p className={`ci-what${full ? '' : ' ci-clamp2'}`}>{r.line.title}</p>
        {!c ? <p className="muted">{noCardText(r)}</p> : (
          <>
            <p className={full ? '' : 'ci-clamp2'}>{c.summary}</p>
            {c.progress != null && (
              <div className="ci-prog"><div className="cg-bar"><i style={{ width: `${c.progress}%` }} /></div><small>{c.progress}%{c.milestone && ` · ${c.milestone}`}</small></div>
            )}
            {(full || first === 'need') && <List title={tr('要你决定')} items={c.need_you} cls="warn" most={full ? 0 : 2} />}
            {(full || first === 'bad') && <List title={tr('卡点和风险')} items={c.blockers} cls="bad" most={full ? 0 : 2} />}
            {(full || first === 'next') && <List title={tr('接下来')} items={c.next} most={full ? 0 : 2} />}
            {full && <List title={tr('最近完成')} items={c.done} />}
            {full && <p className="muted ci-foot">{tr('{0}更新', ago(c.at))}{c.by && ` · ${c.by}`}</p>}
          </>
        )}
      </>
    );
  }
  if (k === 'survey') { // the verdict in a line, then the closest work
    const h = m.line?.outputs?.hatch, lp = m.line?.linked?.paper;
    const found = m.papers?.survey ?? [], cited = m.papers?.references ?? [];
    const near: { title: string; similarity?: number; year?: string }[] = found.length ? found : h?.similar ?? [];
    if (!m.line) return <p className="muted">{tr('加载中…')}</p>;
    if (!h && !near.length && !cited.length) return <p className="muted">{lp?.abstract ? gist(lp.abstract, 120) : tr('放入 idea 后孵化场会先查重，最接近的工作列在这里。')}</p>;
    const line = h ? gist(h.gap || h.summary, full ? 300 : 80) : '';
    return (
      <>
        {line && <p className={full ? '' : 'ci-clamp2'}>{line}</p>}
        {(full ? near.slice(0, 12) : near.slice(0, line ? 3 : 4)).map((x, i) => (
          <p key={i} className="ci-paper" title={x.title}>{x.similarity != null && <b>{Number(x.similarity).toFixed(2)}</b>}<span>{x.title}</span>{full && x.year && <small>{x.year}</small>}</p>
        ))}
        {!near.length && cited.slice(0, full ? 12 : 3).map((x, i) => <p key={i} className="ci-paper" title={x.title}><span>{x.title}</span></p>)}
        <p className="muted ci-foot">{[found.length && tr('调研到 {0} 篇', found.length), cited.length && tr('论文引用 {0} 篇', cited.length)].filter(Boolean).join(' · ')}</p>
      </>
    );
  }
  if (k === 'method') {
    const md = m.line?.outputs?.method;
    if (!m.line) return <p className="muted">{tr('加载中…')}</p>;
    if (!md) return <p className="muted">{tr('方法设计完成后，问题、做法和 baseline 列在这里。')}</p>;
    const steps: string[] = md.mechanism ?? [], bases: string[] = (md.baselines ?? []).map((b: { name: string } | string) => (typeof b === 'string' ? b : b.name));
    return (
      <>
        {md.problem && <p className={full ? '' : 'ci-clamp2'}>{full ? md.problem : gist(md.problem, 90)}</p>}
        {steps.length > 0 && <ol className="ci-steps">{(full ? steps : steps.slice(0, 3)).map((x, i) => <li key={i}>{full ? x : gist(x, 60)}</li>)}</ol>}
        {bases.length > 0 && <p className="muted ci-line">Baseline · {bases.join('、')}</p>}
        {(md.metrics?.length ?? 0) > 0 && <p className="muted ci-line">{tr('指标')} · {md.metrics.join('、')}</p>}
      </>
    );
  }
  if (k === 'results') { // what the runs gave, and the code each came from
    const d = m.data;
    if (!d) return <p className="muted">{tr('加载中…')}</p>;
    const res = d.results, runs = d.runs, inRepo = runs.filter(x => x.script).length, scripts = uniq(runs.map(x => x.script ?? '').filter(Boolean));
    const made = d.files.filter(f => f.kind === 'processed').length;
    if (!res && !runs.length && !made) return <p className="muted">{tr('实验跑完后，结果和产出它的代码列在这里。')}</p>;
    const ours = res?.rows.find(x => x.ours), others = res?.rows.filter(x => !x.ours) ?? [];
    return (
      <>
        {res && ours && (
          <div className="ci-metrics top">
            {res.metrics.slice(0, full ? 12 : 3).map((name, i) => {
              const best = others.length ? Math.max(...others.map(x => x.values[i])) : null;
              return <p key={name}><span>{name}</span><b>{fmt(ours.values[i])}</b>{best != null && <small>{tr('baseline 最好 {0}', fmt(best))}</small>}</p>;
            })}
          </div>
        )}
        {res?.simulated && <p className="muted">{tr('模拟结果，不是真实实验')}</p>}
        {(full ? runs.slice(0, 20) : runs.slice(0, res ? 1 : 3)).map(x => (
          <p key={x.id} className={`ci-ran s-${x.state}`}><i /><span>{x.name}</span>
            {x.script ? <code title={x.script}>{full ? x.script : base(x.script)}</code>
              : x.entry && <code className="out" title={tr('当前关联的代码仓库里没有这个文件')}>{full ? x.entry : base(x.entry).split('.').pop()}</code>}</p>
        ))}
        <p className="muted ci-foot">{[runs.length && (inRepo ? tr('{0} 次运行，{1} 次出自仓库里的 {2} 个脚本', runs.length, inRepo, scripts.length) : tr('{0} 次运行', runs.length)),
          made && tr('{0} 个结果文件', made)].filter(Boolean).join(' · ')}</p>
      </>
    );
  }
  if (k === 'datasets') {
    const d = m.data;
    if (!d) return <p className="muted">{tr('加载中…')}</p>;
    const sets = uniq(d.meta.datasets), raw = d.files.filter(f => f.kind === 'raw');
    const dirs = uniq(raw.map(f => f.path.split('/').slice(0, 2).join('/')));
    if (!sets.length && !raw.length) return <p className="muted">{tr('方法设计定下数据集后列在这里，代码仓库 data/ 目录里的文件也会列出来。')}</p>;
    return (
      <>
        {sets.length > 0 && <p className="ci-chips">{(full ? sets : sets.slice(0, 6)).map(x => <span key={x}>{x}</span>)}{!full && sets.length > 6 && <em>+{sets.length - 6}</em>}</p>}
        {(full ? dirs.slice(0, 20) : dirs.slice(0, sets.length ? 2 : 4)).map(x => <p key={x} className="ci-path">{x}</p>)}
        {raw.length > 0 && <p className="muted ci-foot">{tr('仓库里 {0} 个数据文件', raw.length)}</p>}
        {d.meta.seeds != null && full && <p className="muted">{tr('{0} 个种子', d.meta.seeds)}</p>}
      </>
    );
  }
  if (k === 'agent') {
    const role = roleOf(n), a = v.agents[role], mine = tasksOf(v, role);
    const by = (s: string) => mine.filter(x => x.status === s).length;
    const bits = [by('sent') && tr('{0} 件在做', by('sent')), by('blocked') && tr('{0} 件卡住', by('blocked')), by('draft') && tr('{0} 件还没发', by('draft')), by('done') && tr('{0} 件完成', by('done'))].filter(Boolean);
    return (
      <>
        {a.there && a.model && <p className="muted">{a.model}</p>}
        <p>{bits.length ? bits.join(' · ') : <span className="muted">{tr('回路上没有给它的任务')}</span>}</p>
        {full && mine.length > 0 && (
          <ul className="cv-links">
            {mine.map(t => (
              <li key={t.id}><button className="cv-link" onClick={() => onPick?.(t.id)}><i className={`cv-tdot t-${t.status}`} /><span>{t.title}</span></button></li>
            ))}
          </ul>
        )}
      </>
    );
  }
  if (k === 'runs') {
    const counts = JOBS.filter(([key]) => r.jobs[key]);
    const runs = full ? r.running : r.running.slice(0, 3);
    return (
      <>
        {counts.length ? <p className="ci-counts">{counts.map(([key, name, cls]) => <span key={key} className={cls}><b>{r.jobs[key]}</b>{name}</span>)}</p>
          : <p className="muted">{tr('还没有实验任务')}</p>}
        {runs.map(j => (
          <div key={j.id} className="ci-run">
            <p><span>{j.name}</span><small>{runText(j)}</small></p>
            {j.progress != null && <div className="cg-bar"><i style={{ width: `${j.progress}%` }} /></div>}
          </div>
        ))}
        {!full && r.running.length > 3 && <p className="muted">{tr('还有 {0} 个在跑', r.running.length - 3)}</p>}
        {full && r.queued.length > 0 && <List title={tr('排队')} items={r.queued.map(j => [j.name, runText(j)].filter(Boolean).join(' · '))} />}
      </>
    );
  }
  if (k === 'code' || k === 'paper') return <Repo x={r.repos[k]} which={k} full={full} />;
  if (k === 'outputs') {
    const outs = c?.outputs ?? [], metrics = c?.metrics ?? [];
    if (!outs.length && !metrics.length) return <p className="muted">{tr('由负责人在卡片上填写：论文、主表、图、模型…')}</p>;
    return (
      <>
        {(full ? outs : outs.slice(0, 4)).map((o, i) => (
          <p key={i} className={`ci-out o-${o.state}`}><i /><span>{o.name}</span><small>{[o.due, OUT_STATE[o.state]].filter(Boolean).join(' · ')}</small></p>
        ))}
        {metrics.length > 0 && (
          <div className="ci-metrics">
            {(full ? metrics : metrics.slice(0, 3)).map((m, i) => <p key={i} title={m.note}><span>{m.name}</span><b>{m.value}</b></p>)}
          </div>
        )}
      </>
    );
  }
  return null;
}
