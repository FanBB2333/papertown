// A project at /progress/<number>, in brief: what waits on you, its canvas in small (the stages, checks and tasks,
// opening the full-window canvas), its card, experiments, outputs, repositories and memory, each linking to the console panel with the
// detail; beside them its conversation and the pages its agents wrote.

import { Deadline, figures, modelText } from '../emphasis';
import { useEffect, useState } from 'react';
import { api, type PaseoDefaults, type ProjectCard } from '../api';
import { agentsPath } from '../agents/Agents';
import { HireDialog } from '../agents/Hire';
import { ResidentControl, useResidentLine } from '../components/Resident';
import { StatusTag } from '../components/MillRoom';
import { Icon } from '../console/icons';
import { ago } from '../console/util';
import { tr } from '../i18n';
import { ProjectUsage } from '../usage/Usage';
import { decidedPath, follow, go, href, PATHS, provPath, query } from '../route';
import { askPath, ChatBox } from './Ask';
import { DecideList, openDecisions } from './Decide';
import { DecisionNumbers, ProvNumbers, RecordLink } from './Records';
import { LoopCard } from './LoopCard';
import { PagesBox } from './Pages';
import { MemorySection, MemoryViewer } from './Memory';
import { Meter, noCardText, OUT_STATE, repoLine, runText, UpdateButton, useCardActs, Who } from './parts';

export interface ConsoleTarget { mod?: string; file?: string; job?: string }
type Open = (lineId: string, t?: ConsoleTarget) => void;

// what the card says it needs from you is under 待你决定 above, with its choices
const LISTS = [['blockers', tr('卡点和风险')], ['next', tr('接下来')], ['done', tr('最近完成')]] as const;

export function Project({ r, defs, toast, onChange, onConsole }: {
  r: ProjectCard; defs: PaseoDefaults | null; toast: (t: string, error?: boolean) => void; onChange: (r: ProjectCard) => void; onConsole: Open;
}) {
  const acts = useCardActs(r, toast, onChange);
  const [note, setNote] = useState('');
  const [viewer, setViewer] = useState<{ id: string; msg?: number } | null>(null);
  const [hiring, setHiring] = useState<'coder' | 'writer' | 'lead' | null>(null);
  const { line, card } = r;
  const pending = openDecisions(r);
  const writing = pending.some(d => d.kind === 'matter' || d.kind === 'need');
  const ask = askPath(line.seq);
  const [liveLine, reloadLead] = useResidentLine(line.id);
  useEffect(() => { if (!query().has('matter') && !query().has('need')) document.querySelector('.p-prog')?.scrollTo({ top: 0 }); }, [line.id]);
  const more = (mod: string) => (
    <button className="lnk pj-more small" onClick={() => onConsole(line.id, { mod })} title={tr('在中控屏查看详情')}>{tr('详细')}<Icon n="right" size={12} /></button>
  );

  return (
    <div className="pj">
      <nav className="pj-crumb">
        <a href={href(PATHS.cards)} onClick={e => follow(e, PATHS.cards)}><Icon n="left" size={15} />{tr('全部项目')}</a>
      </nav>
      <header className="pj-head">
        <div className="pj-title">
          <span className="pc-seq">#{line.seq}</span>
          <h1 className="em-key">{line.title}</h1>
          <span className="pj-status"><StatusTag status={line.status} sample={line.sample} /></span>
          {card?.summary && <p className="pj-sum">{modelText(card.summary)}</p>}
        </div>
        <div className="pj-acts">
          <a className={writing ? 'btn' : 'btn pri'} href={href(ask)} onClick={e => follow(e, ask)}><Icon n="chat" size={14} />{tr('对话')}</a>
          <button className="btn" onClick={() => setHiring('coder')}><Icon n="plus" size={14} />{tr('新建员工')}</button>
          <button className="btn" onClick={() => onConsole(line.id)} title={tr('在中控屏查看该项目详情')}><Icon n="board" size={14} />{tr('中控屏')}</button>
        </div>
      </header>
      <ResidentControl lineId={line.id} resident={liveLine?.lead ?? line.lead} sample={liveLine?.sample ?? line.sample} model={liveLine?.team.find(a => a.role === 'lead')?.model ?? r.lead?.model} talk={ask} onStartWith={() => setHiring('lead')} toast={toast} onChanged={reloadLead} />
      <nav className="pj-records" aria-label={tr('项目记录')}>
        <RecordLink id="decided" to={decidedPath(line.seq)}><Icon n="compose" size={15} /><DecisionNumbers stats={r.decided} project /><Icon n="right" size={14} /></RecordLink>
        <RecordLink id="prov" to={provPath(line.seq)}><Icon n="branch" size={15} /><ProvNumbers stats={r.prov} project /><Icon n="right" size={14} /></RecordLink>
      </nav>
      {!!pending.length && <section className="psec pj-decide" id="decide">
        <header className="psec-h"><h3><Icon n="bell" size={16} />{tr('待你决定')}<span className="pj-n em-num" data-tone="warn">{pending.length}</span></h3></header>
        <DecideList r={r} onGone={() => api.card(line.id).then(onChange, e => toast((e as Error).message, true))} />
      </section>}
      <LoopCard r={r} toast={toast} />

      <div className="pj-grid">
        <div className="pj-main">
          <ProjectUsage lineId={line.id} />
          <section className={`psec pj-card${card ? ` h-${card.health}` : ''}`} id="card">
            <header className="psec-h">
              <h3><Icon n="cards" size={16} />{tr('进展')}</h3>
              <Who r={r} full />
              {more('overview')}
            </header>
            {card ? (
              <>
                <Meter r={r} />
                {card.milestone && <p className="pc-ms"><span><span className="muted">{tr('下一个里程碑')}</span> <span className="em-state" data-icon="clock" data-tone="warn">{modelText(card.milestone)}</span></span></p>}
                {card.metrics.length > 0 && (
                  <dl className="pc-metrics full">
                    {card.metrics.map(m => <div key={m.name}><dt>{m.name}</dt><dd>{figures(m.value)}</dd>{m.note && <span className="muted small">{modelText(m.note)}</span>}</div>)}
                  </dl>
                )}
                <div className="pj-lists">
                  {(r.decisions ? LISTS : [['need_you', tr('待你决定')] as const, ...LISTS]).filter(([k]) => card[k].length).map(([k, name]) => (
                    <section key={k} className={`pc-list l-${k}`}>
                      <h4>{name}</h4>
                      <ul>{card[k].map((t, j) => <li key={j} className={k === 'need_you' ? 'em-bar' : undefined} data-tone={k === 'need_you' ? 'warn' : undefined}>{k === 'blockers' ? <span className="em-state" data-tone="warn">{modelText(t)}</span> : modelText(t)}</li>)}</ul>
                    </section>
                  ))}
                </div>
                <p className="small muted">{tr('{0}由 {1} 撰写', ago(card.at), card.by)}</p>
              </>
            ) : (
              <p className="psec-empty muted">{noCardText(r)}</p>
            )}
            <div className="pj-upd">
              {r.lead?.started && !r.pending && (
                <input className={note ? 'em-bar' : undefined} value={note} maxLength={300} placeholder={tr('向负责人附言（可选），例如「重点关注实验」')} onChange={e => setNote(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) acts.update(note).then(ok => ok && setNote('')); }} />
              )}
              <UpdateButton r={r} acts={acts} defs={defs} note={note} secondary />
            </div>
          </section>

          <section className="psec" id="exp">
            <header className="psec-h">
              <h3><Icon n="flask" size={16} />{tr('实验')}</h3>
              <span className="muted small">{[tr('{0} 个运行中', r.running.length), r.queued.length ? tr('{0} 个排队', r.queued.length) : '', card?.plans.length ? tr('{0} 个规划中', card.plans.length) : ''].filter(Boolean).join(' · ')}</span>
              {more('exp')}
            </header>
            <div className="pj-exp">
              <div>
                <h4 className="pj-sub">{tr('运行中')}</h4>
                {r.running.length ? (
                  <ul className="pj-runs">
                    {r.running.map(j => (
                      <li key={j.id}>
                        <button onClick={() => onConsole(line.id, { job: j.id })}>
                          <span className="pj-run-h"><i className="pp-live" /><b>{j.name}</b><span className="muted small">{ago(j.since)}</span></span>
                          <span className="pj-run-b">
                            {j.progress != null && j.progress > 0 && <span className="pc-bar"><i style={{ width: `${j.progress}%` }} /></span>}
                            <span className="small muted">{runText(j) || tr('运行中')}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : <p className="muted small">{tr('暂无运行中的实验')}</p>}
                {r.queued.length > 0 && (
                  <p className="small muted pj-queued">{tr('排队：')}{r.queued.map(j => j.name).join(tr('、'))}</p>
                )}
              </div>
              <div>
                <h4 className="pj-sub">{tr('规划中')}</h4>
                {card?.plans.length ? (
                  <ul className="pj-plans">
                    {card.plans.map((p, i) => <li key={i}><b>{p.name}</b>{(p.goal || p.when) && <span className="small muted">{modelText(p.goal)}{p.goal && p.when && ' · '}{p.when && <Deadline text={p.when} />}</span>}</li>)}
                  </ul>
                ) : <p className="muted small">{card ? tr('负责人未填写规划中的实验') : tr('由负责人在卡片上填写')}</p>}
              </div>
            </div>
          </section>

          <section className="psec" id="outputs">
            <header className="psec-h">
              <h3><Icon n="doc" size={16} />{tr('预期产出')}</h3>
              {card?.outputs.length ? <span className="muted small">{figures(tr('{0}/{1} 完成', card.outputs.filter(o => o.state === 'done').length, card.outputs.length))}</span> : null}
            </header>
            {card?.outputs.length ? (
              <ul className="pj-outs">
                {card.outputs.map((o, i) => (
                  <li key={i} className={`st-${o.state}`}>
                    <i className={`pp-st st-${o.state}`} /><b>{o.name}</b>
                    {o.due && <span className="pj-due small"><Deadline text={o.due} done={o.state === 'done'} /></span>}
                    <span className="pj-state small">{OUT_STATE[o.state]}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="psec-empty muted small">{card ? tr('负责人未填写预期产出') : tr('由负责人在卡片上填写：论文、主表、图、模型…')}</p>}
          </section>

          <section className="psec" id="repos">
            <header className="psec-h"><h3><Icon n="branch" size={16} />{tr('仓库')}</h3></header>
            <div className="pj-repos">
              {(['code', 'paper'] as const).map(w => {
                const x = r.repos[w];
                return (
                  <article key={w} className="pj-repo">
                    <h4><Icon n={w === 'code' ? 'code' : 'books'} size={14} />{w === 'code' ? tr('代码仓库') : tr('论文仓库')}</h4>
                    {x ? (
                      <>
                        <b className="pj-repo-n">{x.name}</b>
                        <code className="small muted">{x.path}</code>
                        <span className="small">{repoLine(x, w)}</span>
                        {w === 'code' && x.remote && <span className="small muted">{x.remote}{x.langs?.length ? ` · ${x.langs.slice(0, 3).map(l => l.ext).join(' ')}` : ''}</span>}
                        {w === 'paper' && (x.title || x.sections) && (
                          <span className="small muted">{[x.title, x.sections ? tr('{0} 节', x.sections) : '', x.figures ? tr('{0} 图', x.figures) : '', x.tables ? tr('{0} 表', x.tables) : '', x.bib ? tr('{0} 篇引用', x.bib) : ''].filter(Boolean).join(' · ')}</span>
                        )}
                        {x.commit && <span className="pj-commit small"><code>{x.commit.hash}</code><span>{x.commit.subject}<span className="muted"> · {ago(x.commit.when)}</span></span></span>}
                        {!x.missing && <button className="btn" onClick={() => onConsole(line.id, { mod: w })}>{w === 'code' ? tr('打开代码') : tr('打开论文')}</button>}
                      </>
                    ) : <p className="muted small">{w === 'code' ? tr('暂无代码仓库') : tr('暂无论文仓库')}</p>}
                  </article>
                );
              })}
            </div>
          </section>

          <MemorySection lineId={line.id} toast={toast} open={(id, msg) => setViewer({ id, msg })} />
        </div>

        <aside className="pj-side">
          <ChatBox r={r} toast={toast} />
          <PagesBox r={r} toast={toast} />
        </aside>
      </div>
      {viewer && <MemoryViewer lineId={line.id} id={viewer.id} msg={viewer.msg} onClose={() => setViewer(null)} />}
      {hiring && <HireDialog lineId={line.id} initialPost={hiring} lockLine onClose={() => setHiring(null)}
        onStarted={a => { reloadLead(); go(agentsPath(a.id)); }} onOpen={a => go(agentsPath(a.id))} />}
    </div>
  );
}
