// The pieces of a project's card shared by the grid, the rows and the project's page: panes, stages,
// health, the lead and the buttons that ask it for a new card.

import { Deadline, modelText } from '../emphasis';
import { useState } from 'react';
import { api, type Card, type CardRepo, type CardRun, type Health, type OutputState, type Pane, type PaseoDefaults, type ProjectCard } from '../api';
import { ResidentMark } from '../components/Resident';
import { Icon, type IconName } from '../console/icons';
import { ago } from '../console/util';
import { tr } from '../i18n';
import { follow, go, href } from '../route';
import { askPath } from './Ask';
import { DecideLine, openDecisions } from './Decide';

const HEALTH: Record<Health, string> = { ok: tr('正常'), risk: tr('有风险'), blocked: tr('受阻') };
export const OUT_STATE: Record<OutputState, string> = { todo: tr('尚未开始'), doing: tr('进行中'), done: tr('完成') };
// each pane: its name in the picker, its short label on a card, its icon
export const PANES: Record<Pane, [string, string, IconName]> = {
  summary: [tr('进展摘要'), tr('进展'), 'cards'],
  attention: [tr('待你决定与卡点'), tr('待处理'), 'bell'],
  milestone: [tr('下一个里程碑'), tr('里程碑'), 'target'],
  metrics: [tr('关键数字'), tr('数字'), 'table'],
  running: [tr('运行中的实验'), tr('运行中'), 'play'],
  planned: [tr('规划中的实验'), tr('规划'), 'flask'],
  outputs: [tr('预期产出'), tr('产出'), 'doc'],
  code: [tr('代码仓库'), tr('代码'), 'code'],
  paper: [tr('论文仓库'), tr('论文'), 'books'],
  memory: [tr('导入的记忆'), tr('记忆'), 'chat'],
};
export const PANE_KEYS = Object.keys(PANES) as Pane[];

export const youNeeded = (c: ProjectCard) => openDecisions(c).length > 0 || c.asks > 0 || c.line.lead.state === 'blocked';

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
const STAGE_ST: Record<'todo' | 'run' | 'done', string> = { done: tr('完成'), run: tr('进行中'), todo: tr('尚未开始') };

// what a card's buttons do, the same on the card and on the project's page
export function useCardActs(r: ProjectCard, toast: (t: string, error?: boolean) => void, onChange: (r: ProjectCard) => void) {
  const [busy, setBusy] = useState(false);
  const { line } = r;
  async function run(fn: () => Promise<ProjectCard>, done?: string) {
    setBusy(true);
    try {
      onChange(await fn());
      if (done) toast(done);
      return true;
    } catch (e) { toast((e as Error).message, true); return false; } finally { setBusy(false); }
  }
  return {
    busy,
    update: (note = '') => run(() => api.updateCard(line.id, note.trim()), tr('已请 #{0} 的负责人更新卡片。', line.seq)),
    cancel: () => run(() => api.cancelCard(line.id)),
    hire: () => run(async () => {
      await api.setLead(line.id, { on: true });
      await api.lead(line.id);
      return api.card(line.id);
    }, tr('项目 #{0} 的负责人正在启动。', line.seq)),
  };
}
type CardActs = ReturnType<typeof useCardActs>;

export function Stages({ r }: { r: ProjectCard }) {
  const { line } = r;
  return (
    <div className="pc-facts">
      <ol className="pc-stages" aria-label={tr('工序')}>
        {line.stages.map(s => <li key={s.key} className={`s-${s.status}`} title={`${s.name} · ${STAGE_ST[s.status]}`} />)}
      </ol>
      <span className="small muted pc-stage">
        {line.stage ? <>{line.stage.name} · {line.stage.status === 'todo' ? tr('尚未开始') : `${line.stage.pct}%`}</> : tr('全部完成')}
        {!!r.jobs.failed && <> · <b className="pc-bad">{tr('{0} 个失败', r.jobs.failed)}</b></>}
        {r.asks > 0 && <> · <b className="pc-wait">{tr('{0} 个问题待回复', r.asks)}</b></>}
        {!!r.checks?.hard.fail && <> · <b className="pc-bad" title={tr('研究回路上必须满足的硬检查')}>{tr('{0} 项硬检查未通过', r.checks.hard.fail)}</b></>}
      </span>
    </div>
  );
}

// A slot as wide as the widest thing it could hold, so the same slot lines up from one row or card to the next
// whatever it holds in each. The ghosts are laid over it, invisible.
export function Fit({ ghosts, className, children }: { ghosts: React.ReactNode[]; className?: string; children?: React.ReactNode }) {
  return (
    <span className={className ? `fit ${className}` : 'fit'}>
      {children}
      {ghosts.map((g, i) => <span key={i} className="fit-g" aria-hidden="true">{g}</span>)}
    </span>
  );
}

const HEALTH_GHOSTS = (Object.keys(HEALTH) as Health[]).map(h => <span className={`pc-health h-${h}`}><i />{HEALTH[h]}</span>);

export function Meter({ r }: { r: ProjectCard }) {
  const card = r.card!;
  const delta = card.progress != null && r.prev != null ? card.progress - r.prev : 0;
  return (
    <div className="pc-meter">
      <Fit ghosts={HEALTH_GHOSTS}><span className={`pc-health h-${card.health}`}><i />{HEALTH[card.health]}</span></Fit>
      {card.progress != null && <>
        <span className="pc-bar" role="meter" aria-valuenow={card.progress} aria-valuemin={0} aria-valuemax={100} aria-label={tr('完成度')}><i style={{ width: `${card.progress}%` }} /></span>
        <Fit className="fit-end" ghosts={[<b className="pc-pct">100%</b>]}><b className="pc-pct">{card.progress}%</b></Fit>
        <Fit ghosts={[<em className="pc-delta">+100</em>]}>
          {delta !== 0 && <em className={`pc-delta${delta < 0 ? ' down' : ''}`} title={tr('较上一张卡片')}>{delta > 0 ? '+' : ''}{delta}</em>}
        </Fit>
      </>}
    </div>
  );
}

export function Who({ r, full }: { r: ProjectCard; full?: boolean }) {
  return <span className="pc-who small muted"><span>{tr('负责人')}</span><ResidentMark resident={r.line.lead} />{full && r.card && <span>{tr('卡片{0}更新', ago(r.card.at))}</span>}</span>;
}

// the card's main button: update, the update in flight, or a lead to set up
export function UpdateButton({ r, acts, defs, note, secondary }: { r: ProjectCard; acts: CardActs; defs: PaseoDefaults | null; note?: string; secondary?: boolean }) {
  const d = defs?.lead;
  const style = secondary ? 'btn' : 'btn pri';
  if (r.pending) {
    return (
      <span className="pc-pend">
        <span className="pc-pending" tabIndex={r.pending.note ? 0 : undefined} title={tr('{0}请负责人更新，等待撰写完成', ago(r.pending.at))}>
          <i />{tr('更新中')}
          {r.pending.note && <span role="tooltip" className="pc-note-pop em-bar" data-tone="info">{tr('附言：{0}', r.pending.note)}</span>}
        </span>
        <button className="ib" disabled={acts.busy} onClick={e => { e.stopPropagation(); acts.cancel(); }} title={tr('取消本次更新')} aria-label={tr('取消')}><Icon n="close" size={14} /></button>
      </span>
    );
  }
  if (r.line.lead.state === 'ended') return null;
  if (r.lead?.started && r.line.lead.state === 'running') {
    return (
      <button className={style} disabled={acts.busy} onClick={e => { e.stopPropagation(); acts.update(note); }} title={tr('请负责人读取项目并重写此卡片')}>
        <Icon n="refresh" size={14} />{tr('更新')}
      </button>
    );
  }
  return (
    <button className={style} disabled={acts.busy} onClick={e => { e.stopPropagation(); acts.hire(); }}
      title={d?.provider ? tr('使用默认运行方式启动：{0}', [d.provider, d.model, d.thinking].filter(Boolean).join(' / ')) : undefined}>
      {acts.busy ? tr('启动中…') : tr('开启负责人')}
    </button>
  );
}

function Row({ pane, extra, children }: { pane: Pane; extra?: React.ReactNode; children: React.ReactNode }) {
  const [, label, ic] = PANES[pane];
  return (
    <section className={`pp pp-${pane}`}>
      <h4><Icon n={ic} size={13} />{label}</h4>
      <div className="pp-b">{children}</div>
      {extra != null && <span className="pp-x">{extra}</span>}
    </section>
  );
}

export function runText(j: CardRun) {
  const progress = j.line ? modelText(j.line) : j.progress != null && j.progress > 0 && j.progress < 100 ? `${j.progress}%` : null;
  return j.where || progress ? <>{j.where}{j.where && progress && ' · '}{progress}</> : null;
}

export function repoLine(x: CardRepo, which: 'code' | 'paper') {
  if (x.missing) return <span className="em-state" data-tone="bad">{tr('未找到该目录')}</span>;
  const bits = which === 'code'
    ? [x.branch, x.dirty ? tr('{0} 处改动', x.dirty) : x.git ? tr('干净') : null, x.files ? tr('{0} 个文件', x.files) : null]
    : [x.main, x.words ? tr('{0} 词', k(x.words)) : null, x.pdf ? 'PDF' : null, x.dirty ? tr('{0} 处改动', x.dirty) : null];
  return bits.some(Boolean) && bits.filter(Boolean).map((bit, i) => <span key={i}>{i > 0 && ' · '}{bit}</span>);
}

// what a project without a card says in its place
export const noCardText = (r: ProjectCard) =>
  r.lead?.started ? tr('暂无卡片。点击「更新」，负责人读取项目后将撰写第一张。') : tr('负责人尚未启动。开启开关后点击「更新」，由负责人将进展撰写为卡片。');

// a card or row opens its project's page on a click, Enter or Space; its title links there
export function opens(line: ProjectCard['line']) {
  const to = `/progress/${line.seq}`;
  const open = () => go(to);
  return {
    box: {
      onClick: open, tabIndex: 0, 'aria-label': tr('#{0} {1}，查看详情', line.seq, line.title),
      onKeyDown: (e: React.KeyboardEvent) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); open(); } },
    },
    title: <h3 title={line.title}><a href={href(to)} onClick={e => { e.stopPropagation(); follow(e, to); }} tabIndex={-1}>{line.title}</a></h3>,
  };
}

export function AskButton({ seq }: { seq: number }) {
  return <button className="btn pc-ask" onClick={() => go(askPath(seq))} title={tr('与该项目对话：提问、向负责人派发任务、回复提问')}><Icon n="chat" size={14} /><span>{tr('对话')}</span></button>;
}

// a pane with nothing to show: a card leaves it out and names it in one line at its foot
export function paneEmpty(pane: Pane, r: ProjectCard): boolean {
  const c = r.card;
  switch (pane) {
    case 'summary': return false;
    case 'attention': return !r.decisions?.length && !(!r.decisions && c?.need_you.length) && !c?.blockers.length;
    case 'milestone': return !c?.milestone;
    case 'metrics': return !c?.metrics.length;
    case 'running': return !r.running.length && !r.queued.length;
    case 'planned': return !c?.plans.length;
    case 'outputs': return !c?.outputs.length;
    case 'code': case 'paper': return !r.repos[pane];
    case 'memory': return !r.memory.sessions && !r.memory.notes;
  }
}

// one pane on a card; `bare` in a row, where the column names it and an empty cell is a dash
export function CardPane({ pane, r, bare }: { pane: Pane; r: ProjectCard; bare?: boolean }) {
  const c: Card | null = r.card;
  const none = (t: string) => <span className="pp-none" title={bare ? t : undefined}>{bare ? '—' : t}</span>;
  const noCard = () => none(r.lead?.started ? tr('负责人尚未填写') : tr('负责人启动后填写'));
  switch (pane) {
    case 'summary':
      return (
        <section className="pp pp-summary">
          {c ? <><Meter r={r} /><p className="pc-sum">{modelText(c.summary)}</p></>
            : bare ? <p className="pc-empty muted small">{r.lead?.started ? tr('暂无卡片') : tr('负责人尚未启动')}</p>
            : <p className="pc-empty muted small">{noCardText(r)}</p>}
        </section>
      );
    case 'attention': {
      // what waits on you comes first, with its choices a hover away; else the first blocker
      if (r.decisions?.length) return <Row pane="attention"><DecideLine r={r} /></Row>;
      // a server from before decisions: the card's own line, as text
      if (!r.decisions && c?.need_you.length) {
        return <Row pane="attention"><span className="pp-one l-need_you"><b>{tr('决定')}</b>{modelText(c.need_you[0])}</span></Row>;
      }
      return (
        <Row pane="attention" extra={c && c.blockers.length > 1 ? `+${c.blockers.length - 1}` : undefined}>
          {c?.blockers.length ? <span className="pp-one l-blockers"><b>{tr('卡点')}</b>{modelText(c.blockers[0])}</span>
            : c ? none(tr('暂无待决定事项')) : noCard()}
        </Row>
      );
    }
    case 'milestone':
      return <Row pane="milestone">{c?.milestone ? <span className="pp-one">{modelText(c.milestone)}</span> : c ? none(tr('没写')) : noCard()}</Row>;
    case 'metrics':
      return (
        <section className="pp pp-metrics">
          {c?.metrics.length ? (
            <dl className="pc-metrics">{c.metrics.slice(0, 3).map(m => <div key={m.name}><dt>{m.name}</dt><dd>{m.value}</dd></div>)}</dl>
          ) : <Row pane="metrics">{c ? none(tr('暂无关键数字')) : noCard()}</Row>}
        </section>
      );
    case 'running':
      return (
        <Row pane="running" extra={r.running.length ? <b className="pp-n">{r.running.length}</b> : undefined}>
          {r.running.length ? (
            <ul className="pp-list">
              {r.running.slice(0, 2).map(j => <li key={j.id}><i className="pp-live" /><b>{j.name}</b><span className="muted">{runText(j)}</span></li>)}
              {(r.running.length > 2 || r.queued.length > 0) && (
                <li className="muted small">{[r.running.length > 2 ? tr('还有 {0} 个', r.running.length - 2) : '', r.queued.length ? tr('{0} 个排队', r.queued.length) : ''].filter(Boolean).join(' · ')}</li>
              )}
            </ul>
          ) : none(r.queued.length ? tr('暂无运行中 · {0} 个排队', r.queued.length) : tr('暂无运行中的实验'))}
        </Row>
      );
    case 'planned':
      return (
        <Row pane="planned" extra={c?.plans.length ? <b className="pp-n">{c.plans.length}</b> : undefined}>
          {c?.plans.length ? (
            <ul className="pp-list">{c.plans.slice(0, 2).map((p, i) => <li key={i}><b>{p.name}</b>{p.when && <span className="muted"><Deadline text={p.when} /></span>}</li>)}</ul>
          ) : c ? none(tr('暂无规划中的实验')) : noCard()}
        </Row>
      );
    case 'outputs':
      return (
        <Row pane="outputs" extra={c?.outputs.length ? <b className="pp-n">{c.outputs.filter(o => o.state === 'done').length}/{c.outputs.length}</b> : undefined}>
          {c?.outputs.length ? (
            <ul className="pp-list">
              {c.outputs.slice(0, 2).map((o, i) => <li key={i}><i className={`pp-st st-${o.state}`} title={OUT_STATE[o.state]} /><b>{o.name}</b>{o.due && <span className="muted"><Deadline text={o.due} done={o.state === 'done'} /></span>}</li>)}
            </ul>
          ) : c ? none(tr('未填写预期产出')) : noCard()}
        </Row>
      );
    case 'code':
    case 'paper': {
      const x = r.repos[pane];
      const info = x && repoLine(x, pane);
      return (
        <Row pane={pane}>
          {x ? (
            <span className="pp-repo">
              <span className="pp-one"><b>{x.name}</b>{info && <span className="muted"> · {info}</span>}</span>
              {x.commit && <span className="pp-one muted small">{x.commit.subject} · {ago(x.commit.when)}</span>}
            </span>
          ) : none(pane === 'code' ? tr('暂无代码仓库') : tr('暂无论文仓库'))}
        </Row>
      );
    }
    case 'memory': {
      const m = r.memory;
      return (
        <Row pane="memory">
          {m.sessions || m.notes ? <span className="pp-one">{tr('{0} 段对话 · {1} 条记忆', m.sessions, m.notes)}<span className="muted"> · {tr('{0}导入', ago(m.at))}</span></span>
            : none(tr('尚未导入'))}
        </Row>
      );
    }
  }
}
