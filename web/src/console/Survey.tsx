// The survey panel, for reading from above: the hatchery's verdict in one line, the gaps, the
// suggestions and the risks as a few short points each (any of them opens to its full text),
// the closest work as bars, the method at a glance, and the reading list as one table.
// A local project that never went through the hatchery shows its paper's own summary.

import { useEffect, useMemo, useState } from 'react';
import { api, type Line, type PaperCard } from '../api';
import { tr } from '../i18n';
import { Icon } from './icons';
import { gist, points, useFetch } from './util';

interface Props { line: Line | null; tick: number; onHatch: (id: string) => void; onAdjust: (id: string) => void }

const TONE: Record<string, string> = { 可孵化: 'ok', 需调整: 'warn', 已被做过: 'bad' };

// a short point that opens to its whole text
function Point({ text, n = 64, i }: { text: string; n?: number; i: number }) {
  const [open, setOpen] = useState(false);
  const short = gist(text, n);
  const more = short !== text.replace(/\s+/g, ' ').trim();
  return (
    <li style={{ ['--i' as string]: i }} className={more ? 'more' : ''} onClick={() => more && setOpen(o => !o)} title={more && !open ? tr('点开看全文') : undefined}>
      {open ? text : short}
    </li>
  );
}

function Card({ title, icon, items, tone, empty }: { title: string; icon: string; items: string[]; tone: string; empty: string }) {
  return (
    <div className={`sv-card t-${tone}`}>
      <h4><span className="sv-ic">{icon}</span>{title}{items.length > 3 && <em>{tr('共 {0} 条', items.length)}</em>}</h4>
      {items.length ? <ul>{items.slice(0, 3).map((x, i) => <Point key={x} text={x} i={i} />)}</ul> : <p className="muted small">{empty}</p>}
    </div>
  );
}

export function Survey(p: Props) {
  const l = p.line;
  const papers = useFetch(() => api.papersOf(l!.id), l?.id ?? '', p.tick);
  if (!l) return <div className="cm-page"><p className="muted">{tr('加载中…')}</p></div>;
  const h = l.outputs?.hatch;
  const m = l.outputs?.method;
  const lp = l.linked?.paper;

  return (
    <div className="cm-page survey">
      {h ? (
        <section className={`sv-tldr t-${TONE[h.verdict] ?? 'warn'}`}>
          <span className="sv-verdict">{h.verdict}</span>
          <div>
            <p className="sv-line">{gist(h.summary, 70) || gist(h.gap, 70)}</p>
            <span className="muted small">{[h.candidates?.length && tr('查了 {0} 篇候选', h.candidates.length), h.sources?.library != null && tr('图书馆 {0}', h.sources.library),
              h.sources?.arxiv != null && `arXiv ${h.sources.arxiv}`, h.similar?.[0] && tr('最高相似度 {0}', Number(h.similar[0].similarity).toFixed(2))].filter(Boolean).join(' · ')}</span>
          </div>
          {l.status === 'waiting' && <div className="sv-act">
            <button className="btn pri" onClick={() => p.onHatch(l.id)}>{tr('孵化并立项')}</button>
            <button className="btn" onClick={() => p.onAdjust(l.id)}>{tr('调整 idea')}</button>
          </div>}
        </section>
      ) : lp ? (
        <section className="sv-tldr t-ok">
          <span className="sv-verdict">{tr('本地项目')}</span>
          <div>
            <p className="sv-line">{lp.title ?? l.title}</p>
            <span className="muted small">{[lp.sections?.length && tr('{0} 节', lp.sections.length), lp.figures && tr('{0} 张图', lp.figures), lp.tables && tr('{0} 张表', lp.tables),
              lp.words && tr('约 {0} 词', lp.words), lp.bib && tr('{0} 条参考文献', lp.bib)].filter(Boolean).join(' · ')}</span>
          </div>
        </section>
      ) : (
        <div className="cm-empty in">
          <Icon n="lens" size={30} />
          <h3>{l.status === 'hatching' ? tr('孵化场正在查重…') : tr('这个项目还没有调研')}</h3>
          <p>{tr('放入 idea 后孵化场会先查重：找最相近的工作、空白点和建议，结果整理在这里。')}</p>
        </div>
      )}

      {h && (
        <div className="sv-cards">
          <Card title={tr('空白点')} icon="◎" tone="brand" items={points(h.gap)} empty={tr('没有找到明显的空白点。')} />
          <Card title={tr('建议')} icon="→" tone="ok" items={h.suggestions ?? []} empty={tr('没有建议。')} />
          <Card title={tr('风险')} icon="!" tone="bad" items={m?.risks ?? []} empty={m ? tr('没有列出风险。') : tr('方法设计之后才有。')} />
        </div>
      )}

      {!h && lp?.abstract && (
        <section className="cs">
          <h3>{tr('摘要要点')}</h3>
          <ul className="sv-abs">{points(lp.abstract).slice(0, 4).map((x, i) => <Point key={x} text={x} n={110} i={i} />)}</ul>
          {(lp.sections?.length ?? 0) > 0 && <div className="sv-secs">{lp.sections!.map((s, i) => <span key={s} className="chip" style={{ ['--i' as string]: i }}>{s}</span>)}</div>}
        </section>
      )}

      {(h?.similar?.length ?? 0) > 0 && (
        <section className="cs">
          <h3>{tr('最接近的工作')}</h3>
          <ol className="sv-sim">
            {h.similar.slice(0, 5).map((x: any, i: number) => (
              <li key={x.paper_id} style={{ ['--i' as string]: i, ['--v' as string]: Math.max(0, Math.min(1, Number(x.similarity))) }}>
                <span className="sv-bar"><i /></span>
                <b className="sv-v">{Number(x.similarity).toFixed(2)}</b>
                <div className="sv-t">
                  <a href={x.url} target="_blank" rel="noreferrer">{x.title}</a>
                  <span className="muted small">{[x.year, gist(x.note, 48)].filter(Boolean).join(' · ')}</span>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {m && (
        <section className="cs sv-method">
          <h3>{tr('方法速览')}</h3>
          <p className="sv-prob"><b>{tr('问题')}</b>{gist(m.problem, 120)}</p>
          {(m.mechanism?.length ?? 0) > 0 && <ol className="sv-steps">{m.mechanism.slice(0, 4).map((x: string, i: number) => <Point key={x} text={x} n={56} i={i} />)}</ol>}
          <div className="sv-row">
            {m.baselines?.length > 0 && <div><span className="ide-t">Baseline</span>{m.baselines.map((b: any) => <span key={b.name} className="chip" title={b.source}>{b.name}</span>)}</div>}
            {m.datasets?.length > 0 && <div><span className="ide-t">{tr('数据集')}</span>{[...new Set<string>(m.datasets)].map(x => <span key={x} className="chip">{x}</span>)}</div>}
            {m.metrics?.length > 0 && <div><span className="ide-t">{tr('指标')}</span>{m.metrics.map((x: string) => <span key={x} className="chip">{x}</span>)}</div>}
          </div>
        </section>
      )}

      {papers.data && (papers.data.survey.length > 0 || papers.data.references.length > 0) && <Reading got={papers.data} />}
    </div>
  );
}

// every paper the project read or cites, one row each, searchable
function Reading({ got }: { got: { survey: PaperCard[]; references: PaperCard[] } }) {
  const [tab, setTab] = useState<'survey' | 'references'>(got.survey.length ? 'survey' : 'references');
  const [q, setQ] = useState('');
  useEffect(() => { if (tab === 'survey' && !got.survey.length) setTab('references'); }, [got, tab]);
  const list = tab === 'survey' ? got.survey : got.references;
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? list.filter(x => `${x.title} ${x.authors} ${x.topic ?? ''}`.toLowerCase().includes(t)) : list;
  }, [list, q]);
  return (
    <section className="cs">
      <div className="cs-h">
        <h3>{tr('文献')}</h3>
        <div className="seg mini" role="tablist">
          {got.survey.length > 0 && <button className={tab === 'survey' ? 'on' : ''} onClick={() => setTab('survey')}>{tr('调研到的 · {0}', got.survey.length)}</button>}
          {got.references.length > 0 && <button className={tab === 'references' ? 'on' : ''} onClick={() => setTab('references')}>{tr('论文引用的 · {0}', got.references.length)}</button>}
        </div>
        <input className="ide-filter sv-q" placeholder={tr('搜标题、作者')} value={q} onChange={e => setQ(e.target.value)} />
      </div>
      <table className="ctab sv-refs">
        <thead><tr><th>{tr('标题')}</th><th>{tr('年份')}</th><th>{tr('方向')}</th>{tab === 'survey' && <th>{tr('相似度')}</th>}</tr></thead>
        <tbody>{shown.slice(0, 80).map(x => (
          <tr key={x.paper_id} className={x.closest ? 'ours' : ''}>
            <td><a href={x.url} target="_blank" rel="noreferrer">{x.title}</a><span className="muted small sv-au">{gist(x.authors, 40)}</span></td>
            <td className="muted">{x.year}</td>
            <td>{x.topic && <span className="chip">{x.topic}</span>}</td>
            {tab === 'survey' && <td>{x.similarity != null ? x.similarity.toFixed(2) : '—'}</td>}
          </tr>
        ))}</tbody>
      </table>
      {shown.length > 80 && <p className="muted small">{tr('只列出前 80 篇。')}</p>}
    </section>
  );
}
