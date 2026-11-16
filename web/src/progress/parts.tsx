// The pieces of a project's card shared by the grid, the rows and the project's page: panes, stages,
// health, the lead and the buttons that ask it for a new card.

import { useState } from 'react';
import { api, type Card, type CardRepo, type CardRun, type Health, type OutputState, type Pane, type PaseoDefaults, type ProjectCard } from '../api';
import { AGENT_STATUS } from '../components/MillRoom';
import { Icon, type IconName } from '../console/icons';
import { ago } from '../console/util';
import { tr } from '../i18n';
import { follow, go, href } from '../route';
import { askPath } from './Ask';

const HEALTH: Record<Health, string> = { ok: tr('顺利'), risk: tr('有风险'), blocked: tr('卡住了') };
export const OUT_STATE: Record<OutputState, string> = { todo: tr('还没开始'), doing: tr('在做'), done: tr('完成') };
// each pane: its name in the picker, its short label on a card, its icon
export const PANES: Record<Pane, [string, string, IconName]> = {
  summary: [tr('进展摘要'), tr('进展'), 'cards'],
  attention: [tr('要你决定和卡点'), tr('要你'), 'bell'],
  milestone: [tr('下一个里程碑'), tr('里程碑'), 'target'],
  metrics: [tr('关键数字'), tr('数字'), 'table'],
  running: [tr('在跑的实验'), tr('在跑'), 'play'],
  planned: [tr('规划中的实验'), tr('规划'), 'flask'],
  outputs: [tr('预期产出'), tr('产出'), 'doc'],
  code: [tr('代码仓库'), tr('代码'), 'code'],
  paper: [tr('论文仓库'), tr('论文'), 'books'],
  memory: [tr('导入的记忆'), tr('记忆'), 'chat'],
};
export const PANE_KEYS = Object.keys(PANES) as Pane[];

export const youNeeded = (c: ProjectCard) => c.asks > 0 || !!c.card?.need_you.length || ['waiting', 'paused', 'failed'].includes(c.line.status);

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
const STAGE_ST: Record<'todo' | 'run' | 'wait' | 'done', string> = { done: tr('完成'), run: tr('进行中'), wait: tr('等你'), todo: tr('还没开始') };

// what a card's buttons do, the same on the card and on the project's page
export function useCardActs(r: ProjectCard, toast: (t: string) => void, onChange: (r: ProjectCard) => void) {
  const [busy, setBusy] = useState(false);
  const { line, lead } = r;
  async function run(fn: () => Promise<ProjectCard>, done?: string) {
    setBusy(true);
    try {
      onChange(await fn());
      if (done) toast(done);
      return true;
    } catch (e) { toast((e as Error).message); return false; } finally { setBusy(false); }
  }
  return {
    busy,
    update: (note = '') => run(() => api.updateCard(line.id, note.trim()), tr('已经请 #{0} 的负责人更新卡片。', line.seq)),
    cancel: () => run(() => api.cancelCard(line.id)),
    hire: () => run(async () => {
      const a = lead ?? await api.openAgent(line.id, 'lead');
      await api.startAgent(a.id, { runtime: 'paseo' });
      return api.card(line.id);
    }, tr('#{0} 的负责人在 Paseo 里启动了，等它读完项目再按「更新」。', line.seq)),
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
        {line.stage ? `${line.stage.name} · ${line.stage.status === 'wait' ? tr('等你') : line.stage.status === 'todo' ? tr('还没开始') : `${line.stage.pct}%`}` : tr('全部完成')}
        {!!r.jobs.failed && <> · <b className="bad-t">{tr('{0} 个失败', r.jobs.failed)}</b></>}
        {r.asks > 0 && <> · <b className="pg-wait">{tr('{0} 个问题等你', r.asks)}</b></>}
        {!!r.checks?.hard.fail && <> · <b className="bad-t" title={tr('研究画布上必须满足的硬检查')}>{tr('{0} 项硬检查没过', r.checks.hard.fail)}</b></>}
      </span>
    </div>
  );
}

export function Meter({ r }: { r: ProjectCard }) {
  const card = r.card!;
  const delta = card.progress != null && r.prev != null ? card.progress - r.prev : 0;
  return (
    <div className="pc-meter">
      <span className={`pc-health h-${card.health}`}><i />{HEALTH[card.health]}</span>
      {card.progress != null && <>
        <span className="pc-bar" role="meter" aria-valuenow={card.progress} aria-valuemin={0} aria-valuemax={100} aria-label={tr('完成度')}><i style={{ width: `${card.progress}%` }} /></span>
        <b className="pc-pct">{card.progress}%</b>
        {delta !== 0 && <em className={`pc-delta${delta < 0 ? ' down' : ''}`} title={tr('比上一张卡片')}>{delta > 0 ? '+' : ''}{delta}</em>}
      </>}
    </div>
  );
}

export function Who({ r, full }: { r: ProjectCard; full?: boolean }) {
  const live = r.lead?.started ? r.lead : null;
  return (
    <span className="pc-who small muted">
      {live && <i className={`dot s-${live.status}`} />}
      <span title={r.card ? tr('卡片{0}更新', ago(r.card.at)) : undefined}>{live ? `${tr('负责人')} ${AGENT_STATUS[live.status]}` : tr('没有负责人')}{full && r.card && ` · ${tr('卡片{0}更新', ago(r.card.at))}`}</span>
    </span>
  );
}

// the card's main button: update, the update in flight, or a lead to set up
export function UpdateButton({ r, acts, defs, note }: { r: ProjectCard; acts: CardActs; defs: PaseoDefaults | null; note?: string }) {
  const d = defs?.lead;
  if (r.pending) {
    return (
      <span className="pc-pend">
        <span className="pc-pending" title={[tr('{0}请负责人更新的，等它写好', ago(r.pending.at)), r.pending.note && tr('附言：{0}', r.pending.note)].filter(Boolean).join('\n')}>
          <i />{tr('更新中')}
        </span>
        <button className="ib" disabled={acts.busy} onClick={e => { e.stopPropagation(); acts.cancel(); }} title={tr('取消这次更新')} aria-label={tr('取消')}><Icon n="close" size={14} /></button>
      </span>
    );
  }
  if (r.lead?.started) {
    return (
      <button className="btn pri" disabled={acts.busy} onClick={e => { e.stopPropagation(); acts.update(note); }} title={tr('请负责人读一遍项目，重写这张卡片')}>
        <Icon n="refresh" size={14} />{tr('更新')}
      </button>
    );
  }
  return (
    <button className="btn pri" disabled={acts.busy} onClick={e => { e.stopPropagation(); acts.hire(); }}
      title={d?.provider ? tr('在 Paseo 里用 {0} 启动', [d.provider, d.model, d.thinking].filter(Boolean).join(' / ')) : undefined}>
      {acts.busy ? tr('启动中…') : tr('配负责人')}
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
  return [j.where, j.line ?? (j.progress != null && j.progress > 0 && j.progress < 100 ? `${j.progress}%` : null)].filter(Boolean).join(' · ');
}

export function repoLine(x: CardRepo, which: 'code' | 'paper') {
  if (x.missing) return tr('找不到这个目录');
  const bits = which === 'code'
    ? [x.branch, x.dirty ? tr('{0} 处改动', x.dirty) : x.git ? tr('干净') : null, x.files ? tr('{0} 个文件', x.files) : null]
    : [x.main, x.words ? tr('{0} 词', k(x.words)) : null, x.pdf ? 'PDF' : null, x.dirty ? tr('{0} 处改动', x.dirty) : null];
  return bits.filter(Boolean).join(' · ');
}

// what a project without a card says in its place
export const noCardText = (r: ProjectCard) =>
  r.lead?.started ? tr('还没有卡片。按「更新」，负责人读完项目后会写第一张。') : tr('这个项目还没有负责人。配一个以后，按「更新」让它把进展写成卡片。');

// a card or row opens its project's page on a click, Enter or Space; its title links there
export function opens(line: ProjectCard['line']) {
  const to = `/progress/${line.seq}`;
  const open = () => go(to);
  return {
    box: {
      onClick: open, tabIndex: 0, 'aria-label': tr('#{0} {1}，看详情', line.seq, line.title),
      onKeyDown: (e: React.KeyboardEvent) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); open(); } },
    },
    title: <h3 title={line.title}><a href={href(to)} onClick={e => { e.stopPropagation(); follow(e, to); }} tabIndex={-1}>{line.title}</a></h3>,
  };
}

export function AskButton({ seq }: { seq: number }) {
  return <button className="btn pc-ask" onClick={() => go(askPath(seq))} title={tr('和这个项目对话：提问、交代负责人、回它的问题')}><Icon n="chat" size={14} /><span>{tr('对话')}</span></button>;
}

// one pane on a card; `bare` in a row, where the column names it and an empty cell is a dash
export function CardPane({ pane, r, bare }: { pane: Pane; r: ProjectCard; bare?: boolean }) {
  const c: Card | null = r.card;
  const none = (t: string) => <span className="pp-none" title={bare ? t : undefined}>{bare ? '—' : t}</span>;
  const noCard = () => none(r.lead?.started ? tr('负责人还没写') : tr('配负责人后由它填写'));
  switch (pane) {
    case 'summary':
      return (
        <section className="pp pp-summary">
          {c ? <><Meter r={r} /><p className="pc-sum">{c.summary}</p></>
            : bare ? <p className="pc-empty muted small">{r.lead?.started ? tr('还没有卡片') : tr('还没有负责人')}</p>
            : <p className="pc-empty muted small">{noCardText(r)}</p>}
        </section>
      );
    case 'attention': {
      const first = c?.need_you.length ? ['need_you', c.need_you] as const : c?.blockers.length ? ['blockers', c.blockers] as const : null;
      return (
        <Row pane="attention" extra={first && first[1].length > 1 ? `+${first[1].length - 1}` : undefined}>
          {first ? <span className={`pp-one l-${first[0]}`}><b>{first[0] === 'need_you' ? tr('决定') : tr('卡点')}</b>{first[1][0]}</span>
            : c ? none(tr('没有要你决定的')) : noCard()}
        </Row>
      );
    }
    case 'milestone':
      return <Row pane="milestone">{c?.milestone ? <span className="pp-one">{c.milestone}</span> : c ? none(tr('没写')) : noCard()}</Row>;
    case 'metrics':
      return (
        <section className="pp pp-metrics">
          {c?.metrics.length ? (
            <dl className="pc-metrics">{c.metrics.slice(0, 3).map(m => <div key={m.name}><dt>{m.name}</dt><dd>{m.value}</dd></div>)}</dl>
          ) : <Row pane="metrics">{c ? none(tr('没有关键数字')) : noCard()}</Row>}
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
          ) : none(r.queued.length ? tr('没有在跑的 · {0} 个排队', r.queued.length) : tr('没有在跑的实验'))}
        </Row>
      );
    case 'planned':
      return (
        <Row pane="planned" extra={c?.plans.length ? <b className="pp-n">{c.plans.length}</b> : undefined}>
          {c?.plans.length ? (
            <ul className="pp-list">{c.plans.slice(0, 2).map((p, i) => <li key={i}><b>{p.name}</b>{p.when && <span className="muted">{p.when}</span>}</li>)}</ul>
          ) : c ? none(tr('没有规划中的实验')) : noCard()}
        </Row>
      );
    case 'outputs':
      return (
        <Row pane="outputs" extra={c?.outputs.length ? <b className="pp-n">{c.outputs.filter(o => o.state === 'done').length}/{c.outputs.length}</b> : undefined}>
          {c?.outputs.length ? (
            <ul className="pp-list">
              {c.outputs.slice(0, 2).map((o, i) => <li key={i}><i className={`pp-st st-${o.state}`} title={OUT_STATE[o.state]} /><b>{o.name}</b>{o.due && <span className="muted">{o.due}</span>}</li>)}
            </ul>
          ) : c ? none(tr('没写预期产出')) : noCard()}
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
          ) : none(pane === 'code' ? tr('还没有代码仓库') : tr('还没有论文仓库'))}
        </Row>
      );
    }
    case 'memory': {
      const m = r.memory;
      return (
        <Row pane="memory">
          {m.sessions || m.notes ? <span className="pp-one">{tr('{0} 段对话 · {1} 条记忆', m.sessions, m.notes)}<span className="muted"> · {tr('{0}导入', ago(m.at))}</span></span>
            : none(tr('还没有导入'))}
        </Row>
      );
    }
  }
}
