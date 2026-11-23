// The library as the town's RAG: what is in it, a bench to try a query and see why each paper came
// back, how retrieval runs, and the shelves.

import { useEffect, useState } from 'react';
import { api, type RagOpts, type RagResult, type RagView } from '../api';
import type { RoomActions } from './Interior';
import { LibraryShelf } from './Papers';
import '../config-rooms.css';
import { tr } from '../i18n';

interface Props extends RoomActions { tick: number }

const SOURCES: Record<string, string> = { seed: tr('种子论文'), arxiv: tr('arXiv 码头'), sample: tr('样例'), manual: tr('手动导入') };

export function RagRoom(p: Props) {
  const [v, setV] = useState<RagView | null>(null);
  const [opts, setOpts] = useState<RagOpts | null>(null);
  const [q, setQ] = useState('');
  const [res, setRes] = useState<RagResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.rag().then(r => { setV(r); setOpts(r.opts); }).catch(e => p.toast((e as Error).message)); }, [p.tick]);

  async function save() {
    if (!opts) return;
    try {
      const r = await api.ragSet(opts);
      setV(r); setOpts(r.opts);
      p.toast(tr('检索设置已保存，员工下次检索将按此执行'));
    } catch (e) {
      p.toast((e as Error).message);
    }
  }

  async function search() {
    if (!q.trim()) return;
    setBusy(true);
    try { setRes(await api.ragSearch(q.trim())); } catch (e) { p.toast((e as Error).message); } finally { setBusy(false); }
  }

  if (!v || !opts) return <div className="room-empty"><p>{tr('清点馆藏中…')}</p></div>;
  const dirty = JSON.stringify(opts) !== JSON.stringify(v.opts);

  return (
    <div className="room-solo">
      <div className="rag-stats">
        <div><b>{v.stats.papers}</b><span>{tr('篇馆藏')}</span></div>
        {Object.entries(v.stats.sources).map(([k, n]) => <div key={k}><b>{n}</b><span>{SOURCES[k] ?? k}</span></div>)}
        <div><b>{v.stats.terms}</b><span>{tr('个索引词')}</span></div>
      </div>

      <div className="rag-grid">
        <section className="pnl-s rag-bench">
          <h4>{tr('测试检索')}</h4>
          <div className="rag-q">
            <input className="shelf-q" value={q} placeholder={tr('支持中文：稀疏注意力的 KV cache 压缩')} onChange={e => setQ(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) search(); }} />
            <button className="btn pri" disabled={busy || !q.trim()} onClick={search}>{busy ? tr('检索中…') : tr('检索')}</button>
          </div>
          {res && (
            <>
              <p className="muted small">
                {tr('关键词覆盖率排序')} {tr('· 检索词：')}{res.terms.map(t => <code key={t}>{t}</code>)}
                {res.expanded !== res.query && <> {tr('· 扩展为「')}{res.expanded}{tr('」')}</>}
              </p>
              <ol className="rag-hits">
                {res.hits.map((h, i) => (
                  <li key={h.paper_id} style={{ ['--i' as string]: i }}>
                    <span className="rag-sim" title={tr('相似度')}><i style={{ ['--v' as string]: Math.max(0, Math.min(1, h.similarity ?? 0)) }} />{(h.similarity ?? 0).toFixed(2)}</span>
                    <div>
                      <a href={h.url} target="_blank" rel="noreferrer"><b>{h.title}</b></a>
                      <span className="muted small">{h.year} · {h.authors}</span>
                      {h.matched.length > 0 && <span className="rag-terms">{h.matched.map(t => <em key={t}>{t}</em>)}</span>}
                    </div>
                  </li>
                ))}
                {!res.hits.length && <p className="muted small">{tr('未找到。请尝试更换英文关键词。')}</p>}
              </ol>
            </>
          )}
        </section>
        <details className="pnl-s rag-opts" open={dirty || undefined}>
          <summary>
            <h4>{tr('检索机制')}</h4>
            <span className="muted small">{tr('返回 {0} 篇 · 召回 {1} 篇候选并评分 · {2}', v.opts.top_k, v.opts.candidates, tr('关键词覆盖率排序'))}</span>
          </summary>
          <p className="muted small">{v.index}{tr('。孵化场查重、造纸厂找 baseline、印刷厂找引用均采用此流程。')}</p>
          <label className="field">{tr('默认返回篇数')} <b>{opts.top_k}</b>
            <input type="range" min={v.limits.top_k[0]} max={v.limits.top_k[1]} value={opts.top_k} onChange={e => setOpts({ ...opts, top_k: +e.target.value })} />
          </label>
          <label className="field">{tr('评分前全文召回候选篇数')} <b>{opts.candidates}</b>
            <input type="range" min={v.limits.candidates[0]} max={v.limits.candidates[1]} step={5} value={opts.candidates} onChange={e => setOpts({ ...opts, candidates: +e.target.value })} />
          </label>
          <div className="btns">
            <button className="btn pri" disabled={!dirty} onClick={save}>{tr('保存')}</button>
            {dirty && <button className="btn" onClick={() => setOpts(v.opts)}>{tr('还原')}</button>}
          </div>
        </details>

      </div>

      <LibraryShelf tick={p.tick} />
    </div>
  );
}
