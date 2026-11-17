// The info cards on a project's canvas (Canvas.tsx): nodes that show the project live. Its progress card, its three
// agents with the canvas tasks each holds, its experiment jobs, code, paper and expected outputs. On the canvas a card
// is brief; opened in the inspector (CanvasSide.tsx) it says everything, with the way to the console panel behind it.

import type { CanvasNode, CanvasView, CardRepo, Health, ProjectCard, TaskTo } from '../api';
import { AGENT_STATUS } from '../components/MillRoom';
import { Icon, type IconName } from '../console/icons';
import { ago } from '../console/util';
import { tr } from '../i18n';
import { noCardText, OUT_STATE, repoLine, runText } from './parts';

const HEALTH: Record<Health, string> = { ok: tr('顺利'), risk: tr('有风险'), blocked: tr('卡住了') };
const JOBS: [string, string, string][] = [['running', tr('在跑'), 'run'], ['queued', tr('排队'), ''], ['done', tr('完成'), 'ok'], ['failed', tr('失败'), 'bad']];
export const INFO_ICON: Record<string, IconName> = { card: 'cards', agent: 'person', runs: 'flask', code: 'code', paper: 'doc', outputs: 'target' };
// the console panel behind a card
export const INFO_MOD: Record<string, string> = { card: 'overview', agent: 'agents', runs: 'exp', code: 'code', paper: 'paper', outputs: 'overview' };
export const infoKind = (n: CanvasNode) => (n.ref ?? '').split(':')[0];
const roleOf = (n: CanvasNode) => (n.ref ?? '').split(':')[1] as TaskTo;
const tasksOf = (v: CanvasView, role: TaskTo) => v.nodes.filter(x => x.kind === 'task' && x.to === role);

// the few words in a card's header: how the thing stands
export function InfoState({ n, r, v }: { n: CanvasNode; r: ProjectCard; v: CanvasView }) {
  const k = infoKind(n);
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
  const k = infoKind(n), c = r.card;
  if (k === 'card') {
    if (!c) return <p className="muted">{noCardText(r)}</p>;
    return (
      <>
        <p className={full ? '' : 'ci-clamp'}>{c.summary}</p>
        {c.progress != null && (
          <div className="ci-prog"><div className="cg-bar"><i style={{ width: `${c.progress}%` }} /></div><small>{c.progress}%{c.milestone && ` · ${c.milestone}`}</small></div>
        )}
        <List title={tr('要你决定')} items={c.need_you} cls="warn" most={full ? 0 : 2} />
        <List title={tr('卡点和风险')} items={c.blockers} cls="bad" most={full ? 0 : 2} />
        <List title={tr('接下来')} items={c.next} most={full ? 0 : 2} />
        {full && <List title={tr('最近完成')} items={c.done} />}
        <p className="muted ci-foot">{tr('{0}更新', ago(c.at))}{c.by && ` · ${c.by}`}</p>
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
