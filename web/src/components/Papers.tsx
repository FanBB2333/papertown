// Papers from the library, as cards: the library's shelves (by topic, or a search), and
// what one paper read and cites (the hatchery's survey and the press's references).

import { useEffect, useState } from 'react';
import { api, type PaperCard, type Shelf } from '../api';

export function Card({ p, i = 0 }: { p: PaperCard; i?: number }) {
  return (
    <a className={`pcard${p.closest ? ' close' : ''}`} href={p.url} target="_blank" rel="noreferrer" style={{ ['--i' as string]: i }}>
      <div className="pc-top">
        {p.topic && <span className="pc-topic">{p.topic}</span>}
        <span className="muted small">{[p.year, p.arxiv_id && `arXiv ${p.arxiv_id}`].filter(Boolean).join(' · ')}</span>
      </div>
      <b>{p.title}</b>
      <span className="pc-au">{p.authors}</span>
      {p.note ? <p className="pc-note">{p.note}</p> : <p className="pc-snip">{p.snippet}</p>}
      {p.similarity != null && (
        <span className="pc-sim" title="和这篇论文的 idea 有多接近">
          <i style={{ ['--v' as string]: Math.max(0, Math.min(1, p.similarity)) }} />{p.similarity.toFixed(2)}
        </span>
      )}
    </a>
  );
}

// the library: topics down the side, the cards on the chosen shelf, a search over all of it
export function LibraryShelf({ tick }: { tick: number }) {
  const [topic, setTopic] = useState('');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [shelf, setShelf] = useState<Shelf | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    let live = true;
    api.library(query, topic, 60).then(s => { if (live) { setShelf(s); setErr(''); } }).catch(e => live && setErr((e as Error).message));
    return () => { live = false; };
  }, [query, topic, tick]);

  return (
    <section className="shelf">
      <div className="shelf-head">
        <h4>馆藏 · {shelf?.total ?? '…'} 篇</h4>
        <input className="shelf-q" placeholder="搜标题和摘要，中文也行：稀疏注意力、审稿、场景图…" value={q} onChange={e => setQ(e.target.value)} />
      </div>
      <div className="shelf-topics">
        <button className={!topic ? 'on' : ''} onClick={() => setTopic('')}>全部</button>
        {shelf?.topics.map(t => (
          <button key={t.label} className={t.label === topic ? 'on' : ''} onClick={() => setTopic(t.label === topic ? '' : t.label)}>
            {t.label}<span>{t.n}</span>
          </button>
        ))}
      </div>
      {err && <p className="warn-box small">{err}</p>}
      <div className="pcards">
        {shelf?.papers.map((p, i) => <Card key={p.paper_id} p={p} i={Math.min(i, 12)} />)}
        {shelf && !shelf.papers.length && <p className="muted">这一格是空的。</p>}
      </div>
    </section>
  );
}

// one paper's reading list: what the hatchery found close to the idea, and what the paper cites
export function LinePapers({ lineId, tick }: { lineId: string; tick: number }) {
  const [got, setGot] = useState<{ survey: PaperCard[]; references: PaperCard[] } | null>(null);
  const [tab, setTab] = useState<'survey' | 'references'>('survey');
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => api.papersOf(lineId).then(g => live && setGot(g)).catch(() => {}), 200);
    return () => { live = false; clearTimeout(t); };
  }, [lineId, tick]);
  if (!got || (!got.survey.length && !got.references.length)) return null;
  // a project that never went through the hatchery has only what its paper cites
  const shown = tab === 'survey' && !got.survey.length ? 'references' : tab;
  const list = shown === 'survey' ? got.survey : got.references;
  return (
    <section className="line-papers">
      <div className="shelf-head">
        <h4>调研文章</h4>
        <div className="out-tabs">
          <a className={shown === 'survey' ? 'on' : ''} onClick={() => setTab('survey')}>孵化场查到的 · {got.survey.length}</a>
          <a className={shown === 'references' ? 'on' : ''} onClick={() => setTab('references')}>论文里引用的 · {got.references.length}</a>
        </div>
      </div>
      {list.length ? <div className="pcards">{list.map((p, i) => <Card key={p.paper_id} p={p} i={i} />)}</div>
        : <p className="muted small">{shown === 'references' ? '还没写到论文，印刷厂排版后这里会列出 refs.bib 里的文章。' : '—'}</p>}
    </section>
  );
}
