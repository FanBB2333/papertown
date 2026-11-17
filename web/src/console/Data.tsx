// The data panel: the experiments' setup, a chart per result metric, what each nvidb run handed
// back, and the repository's result files, with same-named files in sibling folders lined up as one table.

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type DataRun, type LineData } from '../api';
import { tr } from '../i18n';
import { Select } from '../components/Select';
import { Bars, StateTag, Tip, fmtNum, stOf, useTip } from './charts';
import { Icon } from './icons';
import { JobDrawer } from './JobDrawer';
import { usePanelNote } from './page';
import { ago, base, bytes, ext, flat, headlines, toggled, useFetch } from './util';

interface Props { lineId: string; tick: number; onOpenFile: (path: string) => void }

const KIND_NAME: Record<string, string> = { processed: tr('处理好的结果'), raw: tr('原始数据'), other: tr('其他') };
const SETTING = /^(config|args|params|hparams|settings|cfg)\./i;
const SCORE = /(overall|score|acc|pass@|f1|bleu|rouge|exact|mean|avg|win|success|reward|auc|recall|precision)/i;

export function Data(p: Props) {
  const d = useFetch(() => api.data(p.lineId), p.lineId, p.tick);
  const [job, setJob] = useState<string | null>(null);
  const [file, setFile] = useState<string | null>(null);
  usePanelNote('data', 'open', { 打开着详情的任务: job, 打开着的数据文件: file });
  if (!d.data) return <div className="cm-page"><p className="muted">{d.err || tr('加载中…')}</p></div>;
  const { meta, results, runs, files } = d.data;
  const withResult = runs.filter(r => r.result && typeof r.result === 'object');
  const none = !results && !runs.length && !files.length && !meta.datasets.length;
  return (
    <div className="cm-page data">
      {none && <div className="cm-empty in"><Icon n="table" size={30} /><h3>{tr('还没有实验数据')}</h3>
        <p>{tr('方法设计定下数据集和指标，实验跑完后结果会出现在这里，代码仓库里的 results/、outputs/ 等目录也会列出来。')}</p></div>}

      {(meta.datasets.length > 0 || meta.metrics.length > 0) && (
        <div className="meta-line">
          {meta.datasets.length > 0 && <span><em>{tr('数据集')}</em>{[...new Set(meta.datasets)].map(x => <span key={x} className="chip">{x}</span>)}</span>}
          {meta.baselines.length > 0 && <span><em>Baseline</em>{meta.baselines.map(x => <span key={x} className="chip">{x}</span>)}</span>}
          <span><em>{tr('规模')}</em>{[meta.seeds != null && tr('{0} 个种子', meta.seeds), meta.gpu_hours != null && tr('约 {0} GPU 小时', meta.gpu_hours), meta.backend].filter(Boolean).join(' · ') || '—'}</span>
        </div>
      )}

      {results && <Results r={results} />}
      {withResult.length > 0 && <RunResults runs={withResult} onOpen={setJob} />}
      {files.length > 0 && <Files lineId={p.lineId} files={files} onOpen={setFile} />}

      {job && <JobDrawer id={job} onClose={() => setJob(null)} onJob={setJob} />}
      {file && <FileSheet lineId={p.lineId} path={file} onClose={() => setFile(null)} onCode={() => { setFile(null); p.onOpenFile(file); }} />}
    </div>
  );
}

// one small chart per metric, ours against the best baseline
function Results({ r }: { r: NonNullable<LineData['results']> }) {
  return (
    <section className="cs">
      <div className="cs-h"><span className="cs-ic"><Icon n="spark" size={15} /></span><h3>{tr('结果')}</h3>{r.simulated && <span className="chip warn">{tr('模拟结果，不是真实实验')}</span>}
        <span className="muted small">{tr('每个指标一张图，从高到低，橙色是我们的方法')}</span></div>
      <div className="sm-grid">
        {r.metrics.map((m, i) => {
          const ours = r.rows.find(x => x.ours)?.values[i];
          const best = Math.max(...r.rows.filter(x => !x.ours).map(x => x.values[i]));
          const delta = ours != null && Number.isFinite(best) ? ours - best : null;
          return (
            <div key={m} className="sm" style={{ ['--i' as string]: i }}>
              <h4 title={m}>{m}</h4>
              {delta != null && <p className={`sm-d ${delta >= 0 ? 'up' : 'down'}`}>{delta >= 0 ? '▲' : '▼'} {delta >= 0 ? tr('比最好的 baseline 高 {0}', fmtNum(delta)) : tr('比最好的 baseline 低 {0}', fmtNum(-delta))}</p>}
              <Bars bars={r.rows.map(x => ({ id: x.method, label: x.method, v: x.values[i], hi: x.ours, sub: m })).sort((a, b) => b.v - a.v)} />
            </div>
          );
        })}
      </div>
      {r.analysis && <p className="small res-note">{r.analysis}</p>}
      {!!r.concerns?.length && <ul className="concerns">{r.concerns.map(c => <li key={c}>{c}</li>)}</ul>}
    </section>
  );
}

// what each nvidb run handed back, and one measure compared across runs
function RunResults({ runs, onOpen }: { runs: DataRun[]; onOpen: (id: string) => void }) {
  const shared = useMemo(() => {
    const n = new Map<string, number>();
    for (const r of runs) for (const [k, v] of flat(r.result)) if (typeof v === 'number' && !SETTING.test(k)) n.set(k, (n.get(k) ?? 0) + 1);
    return [...n].filter(([, c]) => c >= 2).map(([k]) => k).sort((a, b) => Number(SCORE.test(b)) - Number(SCORE.test(a)));
  }, [runs]);
  const [pick, setPick] = useState<string | null>(null);
  return (
    <section className="cs">
      <div className="cs-h"><span className="cs-ic"><Icon n="flask" size={15} /></span><h3>{tr('运行结果 · {0}', runs.length)}</h3><span className="muted small">{tr('nvidb 任务交回的 result.json，点一张卡看全部')}</span></div>
      <div className="rcards">
        {runs.map((r, i) => {
          const h = headlines(r.result, 4);
          return (
            <button key={r.id} className={`rc s-${stOf(r.state)}`} style={{ ['--i' as string]: Math.min(i, 10) }} onClick={() => onOpen(r.id)}
              data-ref={`job:${r.id}`} data-ref-label={`${tr('任务')} ${r.name}`}>
              <span className="rc-h"><StateTag s={stOf(r.state)} /><span className="muted small">{ago(r.finished_at)}</span></span>
              <b className="rc-n" title={r.name}>{r.name}</b>
              {h.length ? <span className="rc-m">{h.map(x => <span key={x.k}><strong>{fmtNum(x.v)}</strong><em title={x.k}>{x.name}</em></span>)}</span>
                : '_truncated' in (r.result as object) ? <span className="muted small rc-s">{tr('结果太长，nvidb 只交回了前一部分，点开看')}</span>
                  : <span className="muted small rc-s">{JSON.stringify(r.result).slice(0, 120)}</span>}
            </button>
          );
        })}
      </div>
      {shared.length > 0 && (
        <div className="rc-cmp">
          <span className="ide-t">{tr('按一个指标对比')}</span>
          <div className="chips">{shared.slice(0, 16).map(s => <button key={s} className={`chip pick${pick === s ? ' on' : ''}`} onClick={() => setPick(x => (x === s ? null : s))}>{s}</button>)}</div>
          {pick && <Bars onPick={onOpen} bars={runs.map(r => ({ id: r.id, label: r.name, v: flat(r.result).find(([x]) => x === pick)?.[1] as number, sub: pick }))
            .filter(b => typeof b.v === 'number').sort((a, b) => b.v - a.v)} />}
        </div>
      )}
    </section>
  );
}

type DFile = LineData['files'][number];
interface Family { key: string; members: { path: string; tag: string }[] }

// files that differ in one folder only: the same output, once per run or configuration
function families(files: DFile[]): Family[] {
  const m = new Map<string, { path: string; tag: string }[]>();
  for (const f of files) {
    if (!/\.jsonl?$/i.test(f.path)) continue;
    const parts = f.path.split('/');
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts.map((x, k) => (k === i ? '*' : x)).join('/');
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push({ path: f.path, tag: parts[i] });
    }
  }
  return [...m].filter(([, ms]) => ms.length >= 3).map(([key, members]) => ({ key, members }))
    .sort((a, b) => b.members.length - a.members.length).slice(0, 12);
}

function Files({ lineId, files, onOpen }: { lineId: string; files: DFile[]; onOpen: (path: string) => void }) {
  const fams = useMemo(() => families(files), [files]);
  const [fam, setFam] = useState<string | null>(fams[0]?.key ?? null);
  const [kind, setKind] = useState<string>('all');
  const [q, setQ] = useState('');
  const [sortBy, setSortBy] = useState<'mtime' | 'name' | 'size'>('mtime');
  const [shut, setShut] = useState<Set<string>>(new Set());
  usePanelNote('data', 'files', { 对比的文件组: fam, 文件种类: kind === 'all' ? null : KIND_NAME[kind], 搜文件: q.trim() });
  const cur = fams.find(f => f.key === fam);

  const needle = q.trim().toLowerCase();
  const dirs = useMemo(() => {
    const shown = files.filter(f => (kind === 'all' || f.kind === kind) && (!needle || f.path.toLowerCase().includes(needle)));
    const m = new Map<string, DFile[]>();
    for (const f of shown) { const d = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '.'; m.set(d, [...(m.get(d) ?? []), f]); }
    const order = (a: DFile, b: DFile) => (sortBy === 'name' ? a.path.localeCompare(b.path) : sortBy === 'size' ? b.size - a.size : b.mtime - a.mtime);
    return [...m].map(([d, fs]) => [d, fs.sort(order)] as const).sort((a, b) => (sortBy === 'name' ? a[0].localeCompare(b[0]) : order(a[1][0], b[1][0])));
  }, [files, kind, needle, sortBy]);

  return (
    <section className="cs">
      <div className="cs-h"><span className="cs-ic"><Icon n="folder" size={15} /></span><h3>{tr('结果文件 · {0}', files.length)}</h3><span className="muted small">{tr('代码仓库里 results/、outputs/ 等目录下的数据')}</span></div>
      {fams.length > 0 && <>
        <div className="fam-pick">
          <span className="ide-t">{tr('同名文件对比')}</span>
          <div className="chips">{fams.map(f => (
            <button key={f.key} className={`chip pick${fam === f.key ? ' on' : ''}`} onClick={() => setFam(x => (x === f.key ? null : f.key))} title={f.key}>
              <span>{f.key.split('/').slice(-3).map((s, i) => <span key={i} className={s === '*' ? 'star' : ''}>{i ? '/' : ''}{s}</span>)}</span><em>{f.members.length}</em>
            </button>
          ))}</div>
        </div>
        {cur && <Compare key={cur.key} lineId={lineId} fam={cur} onOpen={onOpen} />}
      </>}
      <div className="fb">
        <div className="fb-bar">
          <label className="xf-q"><Icon n="lens" size={14} /><input placeholder={tr('按路径筛选')} value={q} onChange={e => setQ(e.target.value)} /></label>
          <div className="seg mini">{['all', 'processed', 'raw', 'other'].filter(k => k === 'all' || files.some(f => f.kind === k)).map(k => (
            <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{k === 'all' ? tr('全部') : KIND_NAME[k]}</button>))}</div>
          <Select className="fb-sort" value={sortBy} onChange={setSortBy} label={tr('排序')}
            options={[{ value: 'mtime', label: tr('最近修改') }, { value: 'name', label: tr('名称') }, { value: 'size', label: tr('大小') }]} />
        </div>
        <div className="fb-list">
          {dirs.map(([d, fs]) => {
            const closed = shut.has(d);
            return (
              <div key={d} className="fb-dir">
                <button className={`fb-dh${closed ? '' : ' open'}`} onClick={() => setShut(s => toggled(s, d))}>
                  <Icon n="chevron" size={12} className="tr-chev" /><Icon n="folder" size={14} /><span>{d}</span><em>{fs.length}</em>
                </button>
                {!closed && fs.map(f => (
                  <button key={f.path} className="fb-f" onClick={() => onOpen(f.path)} title={f.path} data-ref={`file:code:${f.path}`} data-ref-label={f.path}>
                    <span>{base(f.path)}</span><span className="muted small">{bytes(f.size)}</span><span className="muted small">{ago(f.mtime)}</span>
                  </button>
                ))}
              </div>
            );
          })}
          {!dirs.length && <p className="muted small">{tr('没有匹配的文件。')}</p>}
        </div>
      </div>
    </section>
  );
}

// a JSON file's text as a record; a JSONL file's last record
function parse(text: string, path: string): unknown {
  try {
    if (ext(path) === 'jsonl') { const ls = text.trim().split('\n'); return JSON.parse(ls[ls.length - 1]); }
    return JSON.parse(text);
  } catch { return null; }
}

// the same file from each folder, side by side: one row per folder, one column per measure
function Compare({ lineId, fam, onOpen }: { lineId: string; fam: Family; onOpen: (path: string) => void }) {
  const [docs, setDocs] = useState<Map<string, unknown>>(new Map());
  const [done, setDone] = useState(0);
  const [cols, setCols] = useState<string[] | null>(null);
  const [sort, setSort] = useState<{ k: string; up: boolean } | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const { tip, show, hide } = useTip();
  const members = fam.members.slice(0, 40);

  useEffect(() => {
    let live = true;
    const todo = [...members];
    const work = async () => {
      for (let m = todo.shift(); m; m = todo.shift()) {
        const path = m.path;
        const f = await api.wsFile(lineId, 'code', path).catch(() => null);
        if (!live) return;
        const v = f?.text ? parse(f.text, path) : null;
        setDocs(d => new Map(d).set(path, v));
        setDone(n => n + 1);
      }
    };
    Promise.all([work(), work(), work(), work(), work(), work()]);
    return () => { live = false; };
  }, [fam.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const table = useMemo(() => {
    const rows = members.map(m => ({ ...m, vals: new Map(flat(docs.get(m.path)).filter((e): e is [string, number] => typeof e[1] === 'number')) }));
    const seen = new Map<string, Set<number>>();
    for (const r of rows) for (const [k, v] of r.vals) { if (!seen.has(k)) seen.set(k, new Set()); seen.get(k)!.add(v); }
    const keys = [...seen].filter(([k, vs]) => vs.size > 1 && rows.filter(r => r.vals.has(k)).length >= Math.max(2, rows.length / 2)).map(([k]) => k)
      .sort((a, b) => (Number(SETTING.test(a)) - Number(SETTING.test(b))) || (Number(SCORE.test(b)) - Number(SCORE.test(a))));
    return { rows, keys };
  }, [docs, fam.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownCols = (cols ?? table.keys.filter(k => !SETTING.test(k)).slice(0, 8)).filter(k => table.keys.includes(k));
  const range = new Map(shownCols.map(k => {
    const vs = table.rows.map(r => r.vals.get(k)).filter((v): v is number => v != null);
    return [k, [Math.min(...vs), Math.max(...vs)]] as const;
  }));
  const rows = sort ? [...table.rows].sort((a, b) => ((a.vals.get(sort.k) ?? -Infinity) - (b.vals.get(sort.k) ?? -Infinity)) * (sort.up ? 1 : -1)) : table.rows;
  const toggle = (k: string) => setCols(c => { const now = c ?? shownCols; return now.includes(k) ? now.filter(x => x !== k) : [...now, k]; });
  const short = (k: string) => k.split('.').slice(-2).join('.');

  return (
    <div className="cmp">
      {done < members.length && <div className="cmp-load"><i style={{ width: `${(100 * done) / members.length}%` }} /><span className="muted small">{tr('读取 {0}/{1}', done, members.length)}</span></div>}
      {table.keys.length > 0 && (
        <details className="cmp-cols">
          <summary>{tr('列：{0}/{1}', shownCols.length, table.keys.length)}</summary>
          <div className="chips">{table.keys.map(k => <button key={k} className={`chip pick${shownCols.includes(k) ? ' on' : ''}${SETTING.test(k) ? ' set' : ''}`} onClick={() => toggle(k)}>{k}</button>)}</div>
        </details>
      )}
      {focus && (
        <div className="cmp-chart">
          <span className="ide-t">{focus}<button className="lnk" onClick={() => setFocus(null)}>{tr('收起')}</button></span>
          <Bars onPick={onOpen} bars={table.rows.filter(r => r.vals.has(focus)).map(r => ({ id: r.path, label: r.tag, v: r.vals.get(focus)!, sub: focus }))
            .sort((a, b) => b.v - a.v)} />
        </div>
      )}
      {shownCols.length > 0 ? (
        <div className="grid-wrap cmp-wrap">
          <table className="ctab cmp-t">
            <thead><tr>
              <th className="cmp-tag">{tr('文件夹')}</th>
              {shownCols.map(k => (
                <th key={k} title={`${k}\n${tr('点一下排序，再点一下换方向，双击画成条形图')}`}
                  className={`sortable num${sort?.k === k ? ` on ${sort.up ? 'up' : 'down'}` : ''}${focus === k ? ' focus' : ''}`}
                  onClick={() => setSort(s => ({ k, up: s?.k === k ? !s.up : false }))} onDoubleClick={() => setFocus(k)}>{short(k)}</th>
              ))}
            </tr></thead>
            <tbody>{rows.map(r => (
              <tr key={r.path} onClick={() => onOpen(r.path)} data-ref={`file:code:${r.path}`} data-ref-label={r.path}>
                <td className="cmp-tag mono" title={r.path}>{r.tag}</td>
                {shownCols.map(k => {
                  const v = r.vals.get(k);
                  const [lo, hi] = range.get(k)!;
                  const h = v == null || hi === lo ? 0 : (v - lo) / (hi - lo);
                  return (
                    <td key={k} className={`num heat${v === hi && hi !== lo ? ' best' : ''}`} style={{ ['--h' as string]: h }}
                      onPointerMove={e => v != null && show(e, { title: r.tag, rows: [{ v: fmtNum(v), k }], foot: r.path })} onPointerLeave={hide}>
                      {v == null ? '—' : fmtNum(v)}
                    </td>
                  );
                })}
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : done >= members.length && <p className="muted small">{tr('这些文件里没有在各个文件夹之间不同的数值。')}</p>}
      <p className="muted small cmp-hint">{tr('颜色越深数值越大（每列各自比较）· 点表头排序 · 双击表头画成条形图 · 点一行打开那个文件')}</p>
      <Tip tip={tip} />
    </div>
  );
}

// one CSV/TSV line's cells, with quoted fields
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

function toGrid(text: string, path: string): { head: string[]; rows: string[][]; more: number } | null {
  const e = ext(path);
  if (e === 'csv' || e === 'tsv') {
    const sep = e === 'tsv' ? '\t' : ',';
    const ls = text.split(/\r?\n/).filter(Boolean);
    return { head: cells(ls[0] ?? '', sep), rows: ls.slice(1, 2001).map(l => cells(l, sep)), more: Math.max(0, ls.length - 2001) };
  }
  if (e !== 'json' && e !== 'jsonl') return null;
  let v: unknown;
  try { v = e === 'jsonl' ? text.split('\n').filter(Boolean).map(l => JSON.parse(l)) : JSON.parse(text); } catch { return null; }
  if (Array.isArray(v) && v.length && v.every(x => x && typeof x === 'object' && !Array.isArray(x))) {
    const recs = v as Record<string, unknown>[];
    const head = [...new Set(recs.flatMap(x => Object.keys(x)))].slice(0, 20);
    const show = (x: unknown) => (x == null ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x));
    return { head, rows: recs.slice(0, 2000).map(x => head.map(h => show(x[h]))), more: Math.max(0, recs.length - 2000) };
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return { head: [tr('键'), tr('值')], rows: flat(v).map(([k, x]) => [k, typeof x === 'object' ? JSON.stringify(x) : String(x)]), more: 0 };
  }
  return null;
}

function FileSheet({ lineId, path, onClose, onCode }: { lineId: string; path: string; onClose: () => void; onCode: () => void }) {
  const f = useFetch(() => api.wsFile(lineId, 'code', path), path);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); onClose(); } };
    addEventListener('keydown', key, true);
    return () => removeEventListener('keydown', key, true);
  }, [onClose]);
  const grid = useMemo(() => (f.data?.text != null ? toGrid(f.data.text, path) : null), [f.data, path]);
  const host = document.querySelector('.p-console');
  if (!host) return null;
  return createPortal(
    <>
      <div className="jd-back" onClick={onClose} />
      <aside className="jd wide" role="dialog" aria-label={path}>
        <header className="jd-h">
          <div className="jd-t"><h3>{base(path)}</h3><span className="muted small mono">{path}{f.data ? ` · ${bytes(f.data.size)}` : ''}</span></div>
          <div className="jd-nav">
            <button className="btn jd-btn" onClick={onCode}><Icon n="code" size={14} />{tr('在代码仓库中打开')}</button>
            <button className="ib" title={copied ? tr('已复制') : tr('复制路径')} onClick={() => navigator.clipboard?.writeText(path).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); })}>
              <Icon n={copied ? 'save' : 'file'} size={15} /></button>
            <button className="ib" onClick={onClose} title={tr('关闭（Esc）')}><Icon n="close" size={16} /></button>
          </div>
        </header>
        <div className="jd-body">
          {f.err ? <p className="warn-box small">{f.err}</p>
            : !f.data ? <p className="muted small">{tr('读取中…')}</p>
              : f.data.binary || f.data.too_big ? <p className="muted small">{f.data.binary ? tr('二进制文件（{0}），这里不能打开。', bytes(f.data.size)) : tr('文件太大（{0}），请在本地打开。', bytes(f.data.size))}</p>
                : grid ? <Sheet {...grid} /> : <pre className="json">{(f.data.text ?? '').slice(0, 40000)}</pre>}
        </div>
      </aside>
    </>,
    host,
  );
}

// a table to read: filter the rows, sort by a column, numbers right-aligned with a bar of their size
function Sheet({ head, rows, more }: { head: string[]; rows: string[][]; more: number }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ k: number; up: boolean } | null>(null);
  const isNum = head.map((_, c) => rows.length > 0 && rows.slice(0, 200).every(r => !r[c] || !Number.isNaN(Number(r[c]))) && rows.some(r => !!r[c]));
  const top = head.map((_, c) => (isNum[c] ? Math.max(...rows.map(r => Math.abs(Number(r[c]) || 0)), 1e-12) : 0));
  const needle = q.trim().toLowerCase();
  let shown = needle ? rows.filter(r => r.some(x => x.toLowerCase().includes(needle))) : rows;
  if (sort) shown = [...shown].sort((a, b) => {
    const x = isNum[sort.k] ? Number(a[sort.k]) : a[sort.k], y = isNum[sort.k] ? Number(b[sort.k]) : b[sort.k];
    return (x < y ? -1 : x > y ? 1 : 0) * (sort.up ? 1 : -1);
  });
  return (
    <div className="sheet">
      <div className="fb-bar">
        <label className="xf-q"><Icon n="lens" size={14} /><input placeholder={tr('在表里找')} value={q} onChange={e => setQ(e.target.value)} /></label>
        <span className="muted small">{tr('{0} 行', shown.length)}{more ? ` · ${tr('只读了前面的，还有 {0} 行', more)}` : ''}</span>
      </div>
      <div className="grid-wrap">
        <table className="ctab grid">
          <thead><tr>{head.map((h, c) => (
            <th key={c} className={`sortable${isNum[c] ? ' num' : ''}${sort?.k === c ? ` on ${sort.up ? 'up' : 'down'}` : ''}`}
              onClick={() => setSort(s => ({ k: c, up: s?.k === c ? !s.up : !isNum[c] }))}>{h}</th>
          ))}</tr></thead>
          <tbody>{shown.slice(0, 600).map((r, i) => (
            <tr key={i}>{head.map((_, c) => (
              <td key={c} className={isNum[c] ? 'num' : ''}>
                {isNum[c] && r[c] ? <><span className="rbar"><i style={{ ['--v' as string]: Math.abs(Number(r[c])) / top[c] }} /></span>{fmtNum(Number(r[c]))}</> : r[c] ?? ''}
              </td>
            ))}</tr>
          ))}</tbody>
        </table>
      </div>
      {shown.length > 600 && <p className="muted small">{tr('只显示前 600 行，用上面的搜索缩小范围。')}</p>}
    </div>
  );
}
