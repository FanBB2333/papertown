// The data panel: what the experiments were set up with (datasets, baselines, metrics, seeds),
// the results they came to, each run's own result from nvidb, and the data files in the
// repository, which open here as tables.

import { useMemo, useState } from 'react';
import { api, type LineData } from '../api';
import { tr } from '../i18n';
import { Icon } from './icons';
import { ago, base, bytes, dur, ext, useFetch } from './util';

interface Props { lineId: string; tick: number }

const KIND_NAME: Record<string, string> = { processed: tr('处理好的结果'), raw: tr('原始数据'), other: tr('其他') };

export function Data(p: Props) {
  const d = useFetch(() => api.data(p.lineId), p.lineId, p.tick);
  const [pick, setPick] = useState<string | null>(null);
  if (!d.data) return <div className="cm-page"><p className="muted">{d.err || tr('加载中…')}</p></div>;
  const { meta, results, runs, files } = d.data;
  const none = !results && !runs.length && !files.length && !meta.datasets.length;
  return (
    <div className="cm-page data">
      {none && <div className="cm-empty in"><Icon n="table" size={30} /><h3>{tr('还没有实验数据')}</h3>
        <p>{tr('方法设计定下数据集和指标，实验跑完后结果会出现在这里；代码仓库里的 results/、outputs/ 等目录也会列出来。')}</p></div>}

      {(meta.datasets.length > 0 || meta.metrics.length > 0) && (
        <section className="cs meta">
          <h3>{tr('元数据')}</h3>
          <dl className="meta-kv">
            {meta.datasets.length > 0 && <><dt>{tr('数据集')}</dt><dd>{[...new Set(meta.datasets)].map(x => <span key={x} className="chip">{x}</span>)}</dd></>}
            {meta.baselines.length > 0 && <><dt>Baseline</dt><dd>{meta.baselines.map(x => <span key={x} className="chip">{x}</span>)}</dd></>}
            {meta.metrics.length > 0 && <><dt>{tr('指标')}</dt><dd>{meta.metrics.map(x => <span key={x} className="chip">{x}</span>)}</dd></>}
            <dt>{tr('规模')}</dt><dd className="small">{[meta.seeds != null && tr('{0} 个种子', meta.seeds), meta.gpu_hours != null && tr('约 {0} GPU 小时', meta.gpu_hours), meta.backend].filter(Boolean).join(' · ') || '—'}</dd>
          </dl>
        </section>
      )}

      {results && <Results r={results} />}

      {runs.length > 0 && (
        <section className="cs">
          <h3>{tr('运行记录 · {0}', runs.length)}</h3>
          <table className="ctab">
            <thead><tr><th>{tr('任务')}</th><th>{tr('状态')}</th><th>{tr('在哪')}</th><th>{tr('用时')}</th><th>{tr('结束')}</th><th>{tr('结果')}</th></tr></thead>
            <tbody>{runs.map(r => (
              <tr key={r.id}>
                <td><b>{r.name}</b></td>
                <td><span className={`pst pst-${r.state === 'completed' ? 'done' : r.state === 'failed' ? 'failed' : 'running'}`}>{r.state}{r.exit_code ? ` · ${r.exit_code}` : ''}</span></td>
                <td className="muted">{r.where ?? '—'}</td>
                <td>{dur(r.elapsed_s)}</td>
                <td className="muted">{ago(r.finished_at)}</td>
                <td>{r.result ? <Json v={r.result} small /> : <span className="muted">—</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        </section>
      )}

      {files.length > 0 && (
        <section className="cs">
          <h3>{tr('数据文件 · {0}', files.length)}</h3>
          <div className="dfiles">
            <div className="df-list">
              {(['processed', 'raw', 'other'] as const).map(k => {
                const fs = files.filter(f => f.kind === k);
                return fs.length > 0 && (
                  <div key={k} className="df-group">
                    <span className="ide-t">{KIND_NAME[k]} · {fs.length}</span>
                    {fs.slice(0, 200).map(f => (
                      <button key={f.path} className={`df${pick === f.path ? ' on' : ''}`} onClick={() => setPick(f.path)} title={f.path}>
                        <span className="df-p">{f.path}</span><span className="muted small">{bytes(f.size)} · {ago(f.mtime)}</span>
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
            <div className="df-view">
              {pick ? <Preview key={pick} lineId={p.lineId} path={pick} /> : <div className="fv-note"><Icon n="table" size={28} /><p className="muted small">{tr('挑一个文件，CSV 和 JSON 会排成表。')}</p></div>}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function Results({ r }: { r: NonNullable<LineData['results']> }) {
  // each metric's column scaled to its own best, for the bars
  const max = r.metrics.map((_, i) => Math.max(...r.rows.map(x => Math.abs(x.values[i] ?? 0)), 1e-9));
  const best = r.metrics.map((_, i) => Math.max(...r.rows.map(x => x.values[i] ?? -Infinity)));
  return (
    <section className="cs">
      <div className="cs-h"><h3>{tr('结果')}</h3>{r.simulated && <span className="chip warn">{tr('模拟结果，不是真实实验')}</span>}</div>
      <table className="ctab res">
        <thead><tr><th>{tr('方法')}</th>{r.metrics.map(m => <th key={m}>{m}</th>)}</tr></thead>
        <tbody>{r.rows.map((x, ri) => (
          <tr key={x.method} className={x.ours ? 'ours' : ''} style={{ ['--i' as string]: ri }}>
            <td>{x.method}{x.ours && <span className="chip pri">{tr('我们')}</span>}</td>
            {x.values.map((v, i) => (
              <td key={i} className={v === best[i] ? 'best' : ''}>
                <span className="rbar"><i style={{ ['--v' as string]: Math.abs(v) / max[i] }} /></span>{v}
              </td>
            ))}
          </tr>
        ))}</tbody>
      </table>
      {r.analysis && <p className="small res-note">{r.analysis}</p>}
      {(r.concerns?.length ?? 0) > 0 && <ul className="concerns">{r.concerns!.map(c => <li key={c}>{c}</li>)}</ul>}
    </section>
  );
}

function Json({ v, small }: { v: unknown; small?: boolean }) {
  const [open, setOpen] = useState(false);
  const s = JSON.stringify(v, null, 2);
  if (small && !open) return <button className="lnk" onClick={() => setOpen(true)}>{s.length > 60 ? `${s.replace(/\s+/g, ' ').slice(0, 56)}…` : s.replace(/\s+/g, ' ')}</button>;
  return <pre className="json" onClick={() => small && setOpen(false)}>{s.length > 20000 ? `${s.slice(0, 20000)}\n…` : s}</pre>;
}

// a CSV line into its cells, quotes and all
function cells(line: string, sep: string) {
  const out: string[] = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === sep) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// a record's values with the keys that lead to them, "a.b.c"; null when it holds lists of records
function leaves(v: object, pre = '', out: string[][] = [], depth = 0): string[][] | null {
  for (const [k, x] of Object.entries(v)) {
    const key = pre ? `${pre}.${k}` : k;
    if (x && typeof x === 'object' && !Array.isArray(x) && depth < 4) { if (!leaves(x, key, out, depth + 1)) return null; }
    else if (Array.isArray(x) && x.some(y => y && typeof y === 'object')) return null;
    else out.push([key, typeof x === 'number' && !Number.isInteger(x) ? String(+x.toFixed(6)) : Array.isArray(x) ? JSON.stringify(x) : String(x)]);
  }
  return out;
}

function Grid({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="grid-wrap">
      <table className="ctab grid">
        <thead><tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{head.map((_, k) => <td key={k}>{r[k] ?? ''}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function Preview({ lineId, path }: { lineId: string; path: string }) {
  const f = useFetch(() => api.wsFile(lineId, 'code', path), path);
  const view = useMemo(() => {
    const t = f.data?.text;
    if (t == null) return null;
    const e = ext(path);
    if (e === 'csv' || e === 'tsv') {
      const ls = t.split(/\r?\n/).filter(Boolean);
      const sep = e === 'tsv' ? '\t' : ',';
      return { grid: { head: cells(ls[0] ?? '', sep), rows: ls.slice(1, 301).map(l => cells(l, sep)) }, more: Math.max(0, ls.length - 301) };
    }
    if (e === 'json' || e === 'jsonl') {
      try {
        const v = e === 'jsonl' ? t.split('\n').filter(Boolean).map(l => JSON.parse(l)) : JSON.parse(t);
        const rows = Array.isArray(v) ? v : null;
        if (rows?.length && rows.every(x => x && typeof x === 'object' && !Array.isArray(x))) {
          const head = [...new Set(rows.flatMap(x => Object.keys(x)))].slice(0, 14);
          const show = (x: unknown) => (x == null ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x));
          return { grid: { head, rows: rows.slice(0, 300).map(x => head.map(h => show(x[h]))) }, more: Math.max(0, rows.length - 300) };
        }
        // a record, nested or not, reads best as two columns: each value under its dotted key
        const flat = v && typeof v === 'object' && !Array.isArray(v) ? leaves(v) : null;
        if (flat && flat.length <= 400) return { grid: { head: [tr('键'), tr('值')], rows: flat }, more: 0 };
        return { json: v };
      } catch { return { text: t }; }
    }
    return { text: t };
  }, [f.data, path]);
  return (
    <div className="pv">
      <div className="pv-h"><b>{base(path)}</b><span className="muted small">{path}</span></div>
      {f.err ? <p className="warn-box small">{f.err}</p>
        : !f.data ? <p className="muted small">{tr('读取中…')}</p>
          : f.data.binary || f.data.too_big ? <p className="muted small">{f.data.binary ? tr('二进制文件（{0}），这里不能打开。', bytes(f.data.size)) : tr('文件太大（{0}），请在本地打开。', bytes(f.data.size))}</p>
            : view?.grid ? <><Grid {...view.grid} />{view.more > 0 && <p className="muted small">{tr('只显示前 300 行，还有 {0} 行。', view.more)}</p>}</>
              : view?.json !== undefined ? <Json v={view.json} />
                : <pre className="json">{(view?.text ?? '').slice(0, 20000)}</pre>}
    </div>
  );
}
