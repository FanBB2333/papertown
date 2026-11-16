// A project in full at /progress/<number>: its card, experiments, outputs, repositories and memory,
// beside boxes for asking it and for the pages its agents wrote.

import { useEffect, useState } from 'react';
import { type Hit, type PaseoDefaults, type ProjectCard } from '../api';
import { StatusTag } from '../components/MillRoom';
import { Icon } from '../console/icons';
import { ago } from '../console/util';
import { tr } from '../i18n';
import { follow, href, PATHS } from '../route';
import { AskBox, askPath } from './Ask';
import { PagesBox } from './Pages';
import { MemorySection, MemoryViewer } from './Memory';
import { Meter, noCardText, OUT_STATE, repoLine, runText, Stages, UpdateButton, useCardActs, Who } from './parts';

export interface ConsoleTarget { mod?: string; file?: string; job?: string }
type Open = (lineId: string, t?: ConsoleTarget) => void;

const LISTS = [['need_you', tr('要你决定')], ['blockers', tr('卡点和风险')], ['next', tr('接下来')], ['done', tr('最近完成')]] as const;

// where a piece found for a question opens: its file, its job, its conversation, or the card
export function hitOpener(lineId: string, onConsole: Open, onMemory: (id: string, msg?: number) => void, onCard: () => void) {
  return (h: Hit) => {
    if (h.ref.file) onConsole(lineId, { file: h.ref.file });
    else if (h.ref.job) onConsole(lineId, { job: h.ref.job });
    else if (h.ref.memory) onMemory(h.ref.memory, h.ref.msg);
    else if (h.ref.card) onCard();
    else onConsole(lineId, { mod: 'overview' });
  };
}

export function Project({ r, defs, toast, onChange, onConsole }: {
  r: ProjectCard; defs: PaseoDefaults | null; toast: (t: string) => void; onChange: (r: ProjectCard) => void; onConsole: Open;
}) {
  const acts = useCardActs(r, toast, onChange);
  const [note, setNote] = useState('');
  const [viewer, setViewer] = useState<{ id: string; msg?: number } | null>(null);
  const { line, card } = r;
  const ask = askPath(line.seq);
  useEffect(() => { document.querySelector('.p-prog')?.scrollTo({ top: 0 }); }, [line.id]);

  return (
    <div className="pj">
      <nav className="pj-crumb">
        <a href={href(PATHS.cards)} onClick={e => follow(e, PATHS.cards)}><Icon n="left" size={15} />{tr('全部项目')}</a>
      </nav>
      <header className="pj-head">
        <div className="pj-title">
          <span className="pc-seq">#{line.seq}</span>
          <h1>{line.title}</h1>
          <StatusTag status={line.status} />
        </div>
        <div className="pj-acts">
          <a className="btn pri" href={href(ask)} onClick={e => follow(e, ask)}><Icon n="chat" size={14} />{tr('提问')}</a>
          <button className="btn" onClick={() => onConsole(line.id)} title={tr('在中控屏里打开这个项目')}><Icon n="board" size={14} />{tr('中控屏')}</button>
        </div>
      </header>
      <Stages r={r} names />

      <div className="pj-grid">
        <div className="pj-main">
          <section className={`psec pj-card${card ? ` h-${card.health}` : ''}`} id="card">
            <header className="psec-h">
              <h3><Icon n="cards" size={16} />{tr('进展')}</h3>
              <Who r={r} full />
            </header>
            {card ? (
              <>
                <Meter r={r} />
                <p className="pj-sum">{card.summary}</p>
                {card.milestone && <p className="pc-ms"><Icon n="target" size={14} /><span><span className="muted">{tr('下一个里程碑')}</span> {card.milestone}</span></p>}
                {card.metrics.length > 0 && (
                  <dl className="pc-metrics full">
                    {card.metrics.map(m => <div key={m.name}><dt>{m.name}</dt><dd>{m.value}</dd>{m.note && <span className="muted small">{m.note}</span>}</div>)}
                  </dl>
                )}
                <div className="pj-lists">
                  {LISTS.filter(([k]) => card[k].length).map(([k, name]) => (
                    <section key={k} className={`pc-list l-${k}`}>
                      <h4>{name}</h4>
                      <ul>{card[k].map((t, j) => <li key={j}>{t}</li>)}</ul>
                    </section>
                  ))}
                </div>
                <p className="small muted">{tr('{0}由 {1} 写', ago(card.at), card.by)}</p>
              </>
            ) : (
              <p className="psec-empty muted">{noCardText(r)}</p>
            )}
            <div className="pj-upd">
              {r.lead?.started && !r.pending && (
                <input value={note} maxLength={300} placeholder={tr('给负责人附一句（可选），比如「重点看实验」')} onChange={e => setNote(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) acts.update(note).then(ok => ok && setNote('')); }} />
              )}
              <UpdateButton r={r} acts={acts} defs={defs} note={note} />
            </div>
          </section>

          <section className="psec" id="exp">
            <header className="psec-h">
              <h3><Icon n="flask" size={16} />{tr('实验')}</h3>
              <span className="muted small">{[tr('{0} 个在跑', r.running.length), r.queued.length ? tr('{0} 个排队', r.queued.length) : '', card?.plans.length ? tr('{0} 个规划中', card.plans.length) : ''].filter(Boolean).join(' · ')}</span>
              <button className="btn" onClick={() => onConsole(line.id, { mod: 'exp' })}>{tr('看全部任务')}</button>
            </header>
            <div className="pj-exp">
              <div>
                <h4 className="pj-sub">{tr('在跑')}</h4>
                {r.running.length ? (
                  <ul className="pj-runs">
                    {r.running.map(j => (
                      <li key={j.id}>
                        <button onClick={() => onConsole(line.id, { job: j.id })}>
                          <span className="pj-run-h"><i className="pp-live" /><b>{j.name}</b><span className="muted small">{ago(j.since)}</span></span>
                          <span className="pj-run-b">
                            {j.progress != null && j.progress > 0 && <span className="pc-bar"><i style={{ width: `${j.progress}%` }} /></span>}
                            <span className="small muted">{runText(j) || tr('在跑')}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : <p className="muted small">{tr('没有在跑的实验')}</p>}
                {r.queued.length > 0 && (
                  <p className="small muted pj-queued">{tr('排队：')}{r.queued.map(j => j.name).join(tr('、'))}</p>
                )}
              </div>
              <div>
                <h4 className="pj-sub">{tr('规划中')}</h4>
                {card?.plans.length ? (
                  <ul className="pj-plans">
                    {card.plans.map((p, i) => <li key={i}><b>{p.name}</b>{(p.goal || p.when) && <span className="small muted">{[p.goal, p.when].filter(Boolean).join(' · ')}</span>}</li>)}
                  </ul>
                ) : <p className="muted small">{card ? tr('负责人没写规划中的实验') : tr('由负责人在卡片上填写')}</p>}
              </div>
            </div>
          </section>

          <section className="psec" id="outputs">
            <header className="psec-h">
              <h3><Icon n="doc" size={16} />{tr('预期产出')}</h3>
              {card?.outputs.length ? <span className="muted small">{tr('{0}/{1} 完成', card.outputs.filter(o => o.state === 'done').length, card.outputs.length)}</span> : null}
            </header>
            {card?.outputs.length ? (
              <ul className="pj-outs">
                {card.outputs.map((o, i) => (
                  <li key={i} className={`st-${o.state}`}>
                    <i className={`pp-st st-${o.state}`} /><b>{o.name}</b>
                    {o.due && <span className="pj-due small"><Icon n="clock" size={12} />{o.due}</span>}
                    <span className="pj-state small">{OUT_STATE[o.state]}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="psec-empty muted small">{card ? tr('负责人没写预期产出') : tr('由负责人在卡片上填写：论文、主表、图、模型…')}</p>}
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
                    ) : <p className="muted small">{w === 'code' ? tr('还没有代码仓库') : tr('还没有论文仓库')}</p>}
                  </article>
                );
              })}
            </div>
          </section>

          <MemorySection lineId={line.id} toast={toast} open={(id, msg) => setViewer({ id, msg })} />
        </div>

        <aside className="pj-side">
          <AskBox r={r} toast={toast} />
          <PagesBox r={r} toast={toast} />
        </aside>
      </div>
      {viewer && <MemoryViewer lineId={line.id} id={viewer.id} msg={viewer.msg} onClose={() => setViewer(null)} />}
    </div>
  );
}
