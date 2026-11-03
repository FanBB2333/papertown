// 进展: every project as one card, the same on a phone and a desk. The top of each card is what
// Papertown knows itself (its stages, its jobs, the questions waiting for you); the body is the
// card its lead wrote: how it goes, how far along, the next milestone, the key numbers, what was
// done, what comes next, what is in the way and what is yours to decide. Nothing rewrites a
// card on its own: 更新 sends the lead a request, and the card changes when it has written it
// back. A project without a lead gets one from here, on the model set in the settings. Every card in
// the grid is the same height and holds a summary; clicking one opens all of it.

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, listen, type Card, type Health, type PaseoDefaults, type ProjectCard } from '../api';
import { AGENT_STATUS, STATUS } from '../components/MillRoom';
import { tr } from '../i18n';
import { Icon } from '../console/icons';
import { ago } from '../console/util';
import './progress.css';

type Filter = 'all' | 'you' | 'run' | 'done';
const HEALTH: Record<Health, string> = { ok: tr('顺利'), risk: tr('有风险'), blocked: tr('卡住了') };
const LISTS: [keyof Pick<Card, 'need_you' | 'blockers' | 'next' | 'done'>, string][] = [
  ['need_you', tr('要你决定')], ['blockers', tr('卡点和风险')], ['next', tr('接下来')], ['done', tr('最近完成')],
];
const youNeeded = (c: ProjectCard) => c.asks > 0 || !!c.card?.need_you.length || ['waiting', 'paused', 'failed'].includes(c.line.status);
const FILTERS: [Filter, string, (c: ProjectCard) => boolean][] = [
  ['all', tr('全部'), () => true],
  ['you', tr('等你'), youNeeded],
  ['run', tr('在做'), c => !['done', 'waiting'].includes(c.line.status)],
  ['done', tr('已完成'), c => c.line.status === 'done'],
];
// what needs you first, then what is stuck, then what is moving; finished ones last
const rank = (c: ProjectCard) => (c.line.status === 'done' ? 9 : youNeeded(c) ? 0 : c.card?.health === 'blocked' ? 1 : c.card?.health === 'risk' ? 2 : 3);

export function Progress({ active, toast, onOpen }: { active: boolean; toast: (t: string) => void; onOpen: (lineId: string) => void }) {
  const [rows, setRows] = useState<ProjectCard[] | null>(null);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [defs, setDefs] = useState<PaseoDefaults | null>(null);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<string | null>(null); // the card open in full
  const [, setNow] = useState(0);
  const again = useRef(0);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const load = () => api.cards().then(r => { if (alive) { setRows(r.cards); setErr(''); } }, e => alive && setErr((e as Error).message));
    load();
    api.modelNews().then(r => alive && setDefs(r.defaults)).catch(() => {});
    // a card written comes whole; the facts around it (stages, jobs, questions, the lead) are read again shortly after they move
    const off = listen(e => {
      if (e.type === 'card' && e.card) setRows(rs => rs && rs.map(r => (r.line.id === e.card.line.id ? e.card : r)));
      else if (['line', 'job', 'report'].includes(e.type) || (e.type === 'agent' && e.agent?.role === 'lead')) {
        clearTimeout(again.current);
        again.current = window.setTimeout(load, 1500);
      }
      if (e.type === 'paseo_models' && e.defaults) setDefs(e.defaults);
    });
    const t = setInterval(() => setNow(n => n + 1), 30000); // how long an update has been waiting
    return () => { alive = false; off(); clearInterval(t); clearTimeout(again.current); };
  }, [active]);

  const sorted = useMemo(() => [...(rows ?? [])].sort((a, b) => rank(a) - rank(b) || b.line.seq - a.line.seq), [rows]);
  const shown = sorted.filter(FILTERS.find(f => f[0] === filter)![2]);
  const put = (r: ProjectCard) => setRows(rs => rs && rs.map(x => (x.line.id === r.line.id ? r : x)));
  const leads = (rows ?? []).filter(r => r.lead?.started && !r.pending).length;
  const waiting = (rows ?? []).filter(youNeeded).length;
  const open = active ? rows?.find(r => r.line.id === detail) ?? null : null;

  async function updateAll() {
    setBusy(true);
    try {
      const r = await api.updateCards();
      toast(r.sent.length ? tr('已经请 {0} 个项目的负责人更新卡片，写好后卡片会自己换上。', r.sent.length) : tr('没有可以更新的：先给项目配负责人。'));
      setRows((await api.cards()).cards);
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <main className="p-prog">
      <div className="pg-wrap">
        <header className="pg-head">
          <div className="pg-title">
            <h1>{tr('项目进展')}</h1>
            <p className="muted small">
              {rows ? tr('{0} 个项目', rows.length) : '…'}{waiting > 0 && <> · <b className="pg-wait">{tr('{0} 个等你', waiting)}</b></>}
              {' · '}{tr('卡片由各项目的负责人填写，按「更新」才会改')}
            </p>
          </div>
          <div className="pg-tools">
            <div className="seg mini" role="tablist">
              {FILTERS.map(([k, name, f]) => <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{name}{rows && k !== 'all' ? ` ${rows.filter(f).length}` : ''}</button>)}
            </div>
            <button className="btn pri" disabled={busy || !leads} onClick={updateAll} title={tr('请每个有负责人的项目更新卡片')}>
              <Icon n="refresh" size={14} />{busy ? tr('发送中…') : tr('全部更新')}
            </button>
          </div>
        </header>
        {err && <p className="warn-box small">{err}</p>}
        {!rows && !err && <p className="muted">{tr('加载中…')}</p>}
        {rows && !rows.length && <p className="muted pg-none">{tr('还没有项目。在中控屏里放入 idea，或者在 projects.json 里接入你自己的项目。')}</p>}
        {rows && rows.length > 0 && !shown.length && <p className="muted pg-none">{tr('没有符合的项目。')}</p>}
        <div className="pg-grid">
          {shown.map((r, i) => <ProjectBox key={r.line.id} r={r} i={i} defs={defs} toast={toast} onChange={put} onOpen={() => onOpen(r.line.id)} onDetail={() => setDetail(r.line.id)} />)}
        </div>
        {open && <Detail key={open.line.id} r={open} defs={defs} toast={toast} onChange={put} onOpen={() => { setDetail(null); onOpen(open.line.id); }} onClose={() => setDetail(null)} />}
      </div>
    </main>
  );
}

// what a card's buttons do, the same on the card and in its detail
function useCardActs(r: ProjectCard, toast: (t: string) => void, onChange: (r: ProjectCard) => void) {
  const [busy, setBusy] = useState(false);
  const { line, lead } = r;
  async function run(fn: () => Promise<ProjectCard | unknown>, done?: string) {
    setBusy(true);
    try {
      const x = await fn();
      if (x && typeof x === 'object' && 'line' in x) onChange(x as ProjectCard);
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
      return api.cards().then(x => x.cards.find(y => y.line.id === line.id));
    }, tr('#{0} 的负责人在 Paseo 里启动了，等它读完项目再按「更新」。', line.seq)),
  };
}

function Stages({ r }: { r: ProjectCard }) {
  const { line } = r;
  return (
    <div className="pc-facts">
      <ol className="pc-stages" aria-label={tr('工序')}>
        {line.stages.map(s => <li key={s.key} className={`s-${s.status}`} title={`${s.name} · ${{ done: tr('完成'), run: tr('进行中'), wait: tr('等你'), todo: tr('还没开始') }[s.status]}`} />)}
      </ol>
      <span className="small muted pc-stage">
        {line.stage ? `${line.stage.name} · ${line.stage.status === 'wait' ? tr('等你') : line.stage.status === 'todo' ? tr('还没开始') : `${line.stage.pct}%`}` : tr('全部完成')}
        {!!r.jobs.running && <> · {tr('{0} 个任务在跑', r.jobs.running)}</>}
        {!!r.jobs.failed && <> · <b className="bad-t">{tr('{0} 个失败', r.jobs.failed)}</b></>}
        {r.asks > 0 && <> · <b className="pg-wait">{tr('{0} 个问题等你', r.asks)}</b></>}
      </span>
    </div>
  );
}

function Meter({ r }: { r: ProjectCard }) {
  const card = r.card!;
  const delta = card.progress != null && r.prev != null ? card.progress - r.prev : 0;
  return (
    <div className="pc-meter">
      <span className={`pc-health h-${card.health}`}><i />{HEALTH[card.health]}</span>
      {card.progress != null && <>
        <span className="pc-bar" role="meter" aria-valuenow={card.progress} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${card.progress}%` }} /></span>
        <b className="pc-pct">{card.progress}%</b>
        {delta !== 0 && <em className={`pc-delta${delta < 0 ? ' down' : ''}`}>{delta > 0 ? '+' : ''}{delta}</em>}
      </>}
    </div>
  );
}

// the card's buttons: update, or the update in flight, or a lead to set up; and the way into the console
function Acts({ r, acts, defs, note, onOpen }: { r: ProjectCard; acts: ReturnType<typeof useCardActs>; defs: PaseoDefaults | null; note?: string; onOpen: () => void }) {
  const live = r.lead?.started, d = defs?.lead;
  return (
    <div className="pc-acts" onClick={e => e.stopPropagation()}>
      {r.pending ? (
        <>
          <span className="pc-pending"><i />{tr('更新中 · {0}', ago(r.pending.at))}</span>
          <button className="btn" disabled={acts.busy} onClick={acts.cancel}>{tr('取消')}</button>
        </>
      ) : live ? (
        <button className="btn pri" disabled={acts.busy} onClick={() => acts.update(note)} title={tr('请负责人读一遍项目，重写这张卡片')}><Icon n="refresh" size={14} />{tr('更新')}</button>
      ) : (
        <button className="btn pri" disabled={acts.busy} onClick={acts.hire} title={d?.provider ? tr('在 Paseo 里用 {0} 启动', [d.provider, d.model, d.thinking].filter(Boolean).join(' / ')) : undefined}>
          {acts.busy ? tr('启动中…') : tr('配负责人')}
        </button>
      )}
      <button className="ib pc-go" onClick={onOpen} title={tr('在中控屏里打开这个项目')} aria-label={tr('打开')}><Icon n="right" size={16} /></button>
    </div>
  );
}

function Who({ r }: { r: ProjectCard }) {
  const live = r.lead?.started ? r.lead : null;
  return (
    <span className="pc-who small muted">
      {live && <i className={`dot s-${live.status}`} />}
      <span>{live ? `${tr('负责人')} ${AGENT_STATUS[live.status]}` : tr('没有负责人')}{r.card && ` · ${tr('{0}更新', ago(r.card.at))}`}</span>
    </span>
  );
}

// a card in the grid: all of them the same height, so it holds a summary of the card; the rest
// is in its detail
function ProjectBox({ r, i, defs, toast, onChange, onOpen, onDetail }: {
  r: ProjectCard; i: number; defs: PaseoDefaults | null; toast: (t: string) => void; onChange: (r: ProjectCard) => void; onOpen: () => void; onDetail: () => void;
}) {
  const acts = useCardActs(r, toast, onChange);
  const { line, card } = r;
  // the one line that wants you most: what to decide, else what is in the way
  const first = card?.need_you.length ? ['need_you', card.need_you] as const : card?.blockers.length ? ['blockers', card.blockers] as const : null;
  return (
    <article className={`pc${card ? ` h-${card.health}` : ''}`} style={{ ['--i' as string]: i }} onClick={onDetail}
      tabIndex={0} onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); onDetail(); } }}
      aria-label={tr('#{0} {1}，看详情', line.seq, line.title)}>
      <header className="pc-head">
        <span className="pc-name"><span className="pc-seq">#{line.seq}</span><h3 title={line.title}>{line.title}</h3></span>
        <span className={`pst pst-${line.status}`}>{STATUS[line.status] ?? line.status}</span>
      </header>
      <Stages r={r} />
      <div className="pc-body">
        {card ? (
          <>
            <Meter r={r} />
            <p className="pc-sum">{card.summary}</p>
            {first && (
              <p className={`pc-first l-${first[0]}`}>
                <b>{first[0] === 'need_you' ? tr('要你决定') : tr('卡点')}</b><span>{first[1][0]}</span>
                {first[1].length > 1 && <em>+{first[1].length - 1}</em>}
              </p>
            )}
            {card.milestone && <p className="pc-ms"><Icon n="target" size={14} /><span>{card.milestone}</span></p>}
            {card.metrics.length > 0 && (
              <dl className="pc-metrics">
                {card.metrics.slice(0, 3).map(m => <div key={m.name}><dt>{m.name}</dt><dd>{m.value}</dd></div>)}
              </dl>
            )}
          </>
        ) : (
          <p className="pc-empty muted small">
            {r.lead?.started ? tr('还没有卡片。按「更新」，负责人读完项目后会写第一张。') : tr('这个项目还没有负责人。配一个以后，按「更新」让它把进展写成卡片。')}
          </p>
        )}
      </div>
      <footer className="pc-foot">
        <Who r={r} />
        <Acts r={r} acts={acts} defs={defs} onOpen={onOpen} />
      </footer>
    </article>
  );
}

// a card in full, over the page: every number and every list, and a word for the lead with 更新
function Detail({ r, defs, toast, onChange, onOpen, onClose }: {
  r: ProjectCard; defs: PaseoDefaults | null; toast: (t: string) => void; onChange: (r: ProjectCard) => void; onOpen: () => void; onClose: () => void;
}) {
  const acts = useCardActs(r, toast, onChange);
  const [note, setNote] = useState('');
  const { line, card, pending } = r;
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); onClose(); } };
    addEventListener('keydown', k, true);
    return () => removeEventListener('keydown', k, true);
  }, [onClose]);
  const lists = LISTS.filter(([k]) => card?.[k].length);
  return (
    <div className="pd-back" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <section className={`pd${card ? ` h-${card.health}` : ''}`} role="dialog" aria-modal="true" aria-label={`#${line.seq} ${line.title}`}>
        <span className="sheet-grip" />
        <header className="pc-head">
          <span className="pc-name"><span className="pc-seq">#{line.seq}</span><h3>{line.title}</h3></span>
          <span className={`pst pst-${line.status}`}>{STATUS[line.status] ?? line.status}</span>
          <button className="ib pd-x" onClick={onClose} title={tr('关闭（Esc）')} aria-label={tr('关闭')}><Icon n="close" size={16} /></button>
        </header>
        <div className="pd-body">
          <Stages r={r} />
          {card ? (
            <>
              <Meter r={r} />
              <p className="pc-sum">{card.summary}</p>
              {card.milestone && <p className="pc-ms"><Icon n="target" size={14} /><span><span className="muted">{tr('下一个里程碑')}</span> {card.milestone}</span></p>}
              {card.metrics.length > 0 && (
                <dl className="pc-metrics full">
                  {card.metrics.map(m => <div key={m.name}><dt>{m.name}</dt><dd>{m.value}</dd>{m.note && <span className="muted small">{m.note}</span>}</div>)}
                </dl>
              )}
              {lists.map(([k, name]) => (
                <section key={k} className={`pc-list l-${k}`}>
                  <h4>{name}</h4>
                  <ul>{card[k].map((t, j) => <li key={j}>{t}</li>)}</ul>
                </section>
              ))}
              <p className="small muted">{tr('{0}由 {1} 写', ago(card.at), card.by)}</p>
            </>
          ) : (
            <p className="pc-empty muted small">
              {r.lead?.started ? tr('还没有卡片。按「更新」，负责人读完项目后会写第一张。') : tr('这个项目还没有负责人。配一个以后，按「更新」让它把进展写成卡片。')}
            </p>
          )}
          {pending?.note && <p className="small muted">{tr('附言：{0}', pending.note)}</p>}
        </div>
        <footer className="pd-foot">
          {r.lead?.started && !pending && (
            <input value={note} maxLength={300} placeholder={tr('给负责人附一句（可选），比如「重点看实验」')} onChange={e => setNote(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) acts.update(note).then(ok => ok && setNote('')); }} />
          )}
          <div className="pd-row">
            <Who r={r} />
            <Acts r={r} acts={acts} defs={defs} note={note} onOpen={onOpen} />
          </div>
        </footer>
      </section>
    </div>
  );
}
