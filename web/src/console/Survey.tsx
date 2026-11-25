// The survey panel: the hatchery's verdict, gaps, suggestions and risks as short points, the method
// at a glance and the reading list; a local project without a hatch shows its paper's own summary.

import { hitText, modelText } from '../emphasis';
import { useEffect, useMemo, useState } from 'react';
import { api, type Line, type PaperCard } from '../api';
import { tr } from '../i18n';
import { Icon } from './icons';
import { gist, points, useFetch } from './util';

interface Props { line: Line | null; tick: number }

// the verdict arrives in the page's language, hence the tr()'d keys
const tone = (verdict: string) => ({ [tr('可孵化')]: 'ok', [tr('需调整')]: 'warn', [tr('已被做过')]: 'bad' } as Record<string, string>)[verdict] ?? 'warn';

// the hatchery's one-line summary without the verdict it starts with, which sits beside it
function besides(summary: string, verdict: string) {
  const s = (summary ?? '').trim();
  if (!s.startsWith(verdict)) return s;
  const rest = s.slice(verdict.length).trim().replace(/^[：:，,。.\s]+/, '').replace(/^[（(]([^（）()]*)[）)]/, '$1');
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

// a short point that opens to its whole text
function Point({ text, n = 64, i, source = false }: { text: string; n?: number; i: number; source?: boolean }) {
  const [open, setOpen] = useState(false);
  const short = gist(text, n);
  const more = short !== text.replace(/\s+/g, ' ').trim();
  return (
    <li style={{ ['--i' as string]: i }} className={more ? 'more' : ''} onClick={() => more && setOpen(o => !o)} title={more && !open ? tr('点击查看全文') : undefined}>
      {source ? (open ? text : short) : modelText(text.replace(/\s+/g, ' ').trim(), open ? undefined : n)}
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
        <section className={`sv-tldr t-${tone(h.verdict)}`}>
          <span className="sv-verdict em-key">{h.verdict}</span>
          <div>
            <p className="sv-line">{modelText(besides(h.summary, h.verdict) || h.gap, 70)}</p>
            <span className="muted small">{[h.sources?.library != null && tr('图书馆 {0}', h.sources.library), h.sources?.arxiv != null && `arXiv ${h.sources.arxiv}`].filter(Boolean).join(' · ')}</span>
          </div>
        </section>
      ) : lp ? (
        <section className="sv-tldr t-ok">
          <span className="sv-verdict">{tr('本地项目')}</span>
          <div>
            <p className="sv-line">{[lp.sections?.length && tr('{0} 节', lp.sections.length), lp.figures && tr('{0} 张图', lp.figures), lp.tables && tr('{0} 张表', lp.tables),
              lp.words && tr('约 {0} 词', lp.words), lp.bib && tr('{0} 条参考文献', lp.bib)].filter(Boolean).join(' · ') || tr('论文暂无内容')}</p>
            {lp.title && lp.title !== l.title && <span className="muted small">{lp.title}</span>}
          </div>
        </section>
      ) : (
        <div className="cm-empty in">
          <Icon n="lens" size={30} />
          <h3>{tr('该项目暂无调研')}</h3>
          <p>{tr('放入 idea 后，孵化场将先查重，识别最相近的工作、空白点与建议，并汇总在此处。')}</p>
        </div>
      )}

      {h && (
        <div className="sv-cards">
          <Card title={tr('空白点')} icon="◎" tone="brand" items={h.gap?.includes('**') ? [h.gap] : points(h.gap)} empty={tr('未找到明显的空白点。')} />
          <Card title={tr('建议')} icon="→" tone="ok" items={h.suggestions ?? []} empty={tr('暂无建议。')} />
          <Card title={tr('风险')} icon="!" tone="bad" items={m?.risks ?? []} empty={m ? tr('未列出风险。') : tr('方法设计后生成。')} />
        </div>
      )}

      {!h && lp?.abstract && (
        <section className="cs">
          <h3>{tr('摘要要点')}</h3>
          <ul className="sv-abs">{points(lp.abstract).slice(0, 4).map((x, i) => <Point key={x} text={x} source n={110} i={i} />)}</ul>
          {!!lp.sections?.length && <div className="sv-secs">{lp.sections.map((s, i) => <span key={s} className="chip" style={{ ['--i' as string]: i }}>{s}</span>)}</div>}
        </section>
      )}

      {(h?.similar?.length ?? 0) > 0 && papers.data && !papers.data.survey.length && (
        <section className="cs">
          <h3>{tr('最接近的工作')}</h3>
          <ol className="sv-sim">
            {h.similar.slice(0, 5).map((x: any, i: number) => (
              <li key={x.paper_id} style={{ ['--i' as string]: i, ['--v' as string]: Math.max(0, Math.min(1, Number(x.similarity))) }}>
                <span className="sv-bar"><i /></span>
                <b className="sv-v em-num">{Number(x.similarity).toFixed(2)}</b>
                <div className="sv-t">
                  <a href={x.url} target="_blank" rel="noreferrer">{x.title}</a>
                  <span className="muted small">{x.year}{x.year && x.note && ' · '}{modelText(x.note, 48)}</span>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {m && (
        <section className="cs sv-method">
          <h3>{tr('方法速览')}</h3>
          <p className="sv-prob"><b>{tr('问题')}</b>{modelText(m.problem, 120)}</p>
          {(m.mechanism?.length ?? 0) > 0 && <ol className="sv-steps">{m.mechanism.slice(0, 4).map((x: string, i: number) => <Point key={x} text={x} n={56} i={i} />)}</ol>}
          <div className="sv-row">
            {m.baselines?.length > 0 && <div><span className="ide-t">Baseline</span>{m.baselines.map((b: any) => <span key={b.name} className="chip" title={b.source}>{b.name}</span>)}</div>}
            {m.datasets?.length > 0 && <div><span className="ide-t">{tr('数据集')}</span>{[...new Set<string>(m.datasets)].map(x => <span key={x} className="chip">{x}</span>)}</div>}
            {m.metrics?.length > 0 && <div><span className="ide-t">{tr('指标')}</span>{m.metrics.map((x: string) => <span key={x} className="chip">{x}</span>)}</div>}
          </div>
        </section>
      )}

      {papers.data && (papers.data.survey.length > 0 || papers.data.references.length > 0) && (
        <Reading got={papers.data} why={Object.fromEntries((h?.similar ?? []).map((x: any) => [x.paper_id, x.note]))} />
      )}
    </div>
  );
}

// every paper the project read or cites, one row each, searchable
function Reading({ got, why }: { got: { survey: PaperCard[]; references: PaperCard[] }; why: Record<string, string | undefined> }) {
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
          {got.survey.length > 0 && <button className={tab === 'survey' ? 'on' : ''} onClick={() => setTab('survey')}>{tr('调研所得 · {0}', got.survey.length)}</button>}
          {got.references.length > 0 && <button className={tab === 'references' ? 'on' : ''} onClick={() => setTab('references')}>{tr('论文引用的 · {0}', got.references.length)}</button>}
        </div>
        <input className="ide-filter sv-q" placeholder={tr('搜索标题、作者')} value={q} onChange={e => setQ(e.target.value)} />
      </div>
      <table className="ctab sv-refs">
        <thead><tr><th>{tr('标题')}</th><th>{tr('年份')}</th><th>{tr('方向')}</th>{tab === 'survey' && <th>{tr('相似度')}</th>}</tr></thead>
        <tbody>{shown.slice(0, 80).map(x => (
          <tr key={x.paper_id} className={x.closest ? 'ours' : ''}>
            <td><a href={x.url} target="_blank" rel="noreferrer">{hitText(x.title, q)}</a>
              <span className="muted small sv-au">{hitText(gist(x.authors, 40), q)}{tab === 'survey' && x.closest && why[x.paper_id] && <> · {modelText(why[x.paper_id], 60)}</>}</span></td>
            <td className="muted">{x.year}</td>
            <td>{x.topic && <span className="chip">{x.topic}</span>}</td>
            {tab === 'survey' && (
              <td className="sv-simc">{x.similarity != null
                ? <><span className="sv-bar" style={{ ['--v' as string]: Math.max(0, Math.min(1, x.similarity)) }}><i /></span><span className="em-num">{x.similarity.toFixed(2)}</span></> : '—'}</td>
            )}
          </tr>
        ))}</tbody>
      </table>
      {shown.length > 80 && <p className="muted small">{tr('仅列出前 80 篇。')}</p>}
    </section>
  );
}
