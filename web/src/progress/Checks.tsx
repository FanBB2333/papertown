// A project's checkpoint map (关卡图), on its page in 进展: the research loop's stages on a track that fills as the
// project moves, and under each stage the checks that hang on it. ◆ hard checks are code (counts, patterns, fixed
// formats) that must pass; ● soft checks are questions the lead answers by reading the project, asked again every
// so often. A node opens its detail: what it checks, its result and history, where it fails, and its settings.

import { useEffect, useMemo, useState } from 'react';
import { api, listen, type Check, type CheckMap, type CheckStatus, type ProjectCard } from '../api';
import { Select } from '../components/Select';
import { Icon } from '../console/icons';
import { ago } from '../console/util';
import { tr, trx } from '../i18n';
import type { ConsoleTarget } from './Project';
import './checks.css';

const ST: Record<CheckStatus, string> = { pass: tr('通过'), warn: tr('有问题'), fail: tr('没过'), none: tr('没有可查的'), wait: tr('等负责人判断') };
const EVERY = [6, 12, 24, 48, 72, 168];
const status = (c: Check): CheckStatus => c.last?.status ?? (c.kind === 'soft' ? 'wait' : 'none');
// a count in the unit the check counts in
const count = (unit: string | undefined, n: number) =>
  unit === '篇' ? tr('{0} 篇', n) : unit === '个' ? tr('{0} 个任务', n) : unit === '个词' ? tr('{0} 个词', n) : unit === '项' ? tr('{0} 项不满足', n) : tr('{0} 处', n);

export function useChecks(lineId: string) {
  const [m, setM] = useState<CheckMap | null>(null);
  const [bump, setBump] = useState(0);
  useEffect(() => listen(e => {
    if ((e.type === 'checks' && e.line_id === lineId) || (e.type === 'line' && e.line?.id === lineId)) setBump(b => b + 1);
  }), [lineId]);
  useEffect(() => {
    let alive = true;
    api.checks(lineId).then(x => alive && setM(x)).catch(() => alive && setM(null));
    return () => { alive = false; };
  }, [lineId, bump]);
  return [m, setM] as const;
}

export function CheckMapSection({ r, toast, onConsole }: { r: ProjectCard; toast: (t: string) => void; onConsole: (lineId: string, t?: ConsoleTarget) => void }) {
  const { line } = r;
  const [m, setM] = useChecks(line.id);
  const [sel, setSel] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const cur = m?.checks.find(c => c.id === sel) ?? null;
  const act = async (fn: () => Promise<CheckMap | unknown>, done?: string) => {
    setBusy(true);
    try {
      const x = await fn();
      if (x && typeof x === 'object' && 'checks' in x) setM(x as CheckMap);
      if (done) toast(done);
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  if (!m) return null;
  const h = m.summary.hard, s = m.summary.soft;
  const checked = h.total - h.none;

  return (
    <section className="psec cg" id="checks" aria-label={tr('关卡图')}>
      <header className="psec-h cg-h">
        <h3><Icon n="map" size={16} />{tr('关卡图')}</h3>
        <span className="cg-sum">
          <span><i className="cg-shape k-hard s-pass" />{tr('硬检查')} <b>{h.pass}/{checked}</b>{h.fail > 0 && <em className="bad-t">{tr('{0} 项没过', h.fail)}</em>}</span>
          <span><i className="cg-shape k-soft s-pass" />{tr('软检查')} <b>{s.pass}/{s.total}</b>{s.warn + s.fail > 0 && <em className="warn-t">{tr('{0} 项有问题', s.warn + s.fail)}</em>}</span>
          {m.rounds > 0 && <span className="muted" title={tr('论文和实验每变一次、查出的结果有变化，算一轮')}>{tr('第 {0} 轮', m.rounds)}</span>}
          {m.ran && <span className="muted">{tr('{0}查过', ago(m.ran))}</span>}
        </span>
        <Trend points={m.trend} />
        <div className="cg-acts">
          <button className="btn" disabled={busy} onClick={() => act(() => api.runChecks(line.id))} title={tr('硬检查平时在论文、实验有变化时自动重跑')}>
            <Icon n="refresh" size={14} />{tr('现在查一遍')}
          </button>
          <button className={`btn${adding ? ' on' : ''}`} aria-expanded={adding} onClick={() => setAdding(a => !a)}><Icon n="plus" size={14} />{tr('加检查')}</button>
        </div>
      </header>
      <p className="cg-legend small muted">
        <span><i className="cg-shape k-hard s-none" />{tr('硬检查：用代码查（计数、格式、固定输出），必须满足')}</span>
        <span><i className="cg-shape k-soft s-none" />{tr('软检查：负责人读项目判断，到期再查')}</span>
        <span className="cg-keys">{(['pass', 'warn', 'fail'] as const).map(k => <span key={k}><i className={`cg-dotc s-${k}`} />{ST[k]}</span>)}</span>
      </p>
      {adding && <AddCheck m={m} busy={busy} onAdd={b => act(() => api.addCheck(line.id, b), tr('加好了')).then(() => setAdding(false))} onCancel={() => setAdding(false)} />}

      <div className="cg-map" style={{ ['--n' as string]: m.stages.length }}>
        {m.stages.map((st, i) => {
          const mine = m.checks.filter(c => c.stage === st.key);
          return (
            <div key={st.key} className={`cg-col st-${st.status}`}>
              <div className="cg-stage" title={`${st.name} · ${STAGE[st.status]}`}>
                <span className="cg-dot" style={st.status === 'run' ? { ['--pct' as string]: `${st.pct}%` } : undefined}>
                  {st.status === 'done' ? <Icon n="check" size={13} /> : st.status === 'wait' ? <Icon n="bell" size={12} /> : i + 1}
                </span>
                <b>{st.name}</b>
                <small>{st.status === 'run' ? `${st.pct}%` : STAGE[st.status]}</small>
              </div>
              {mine.length > 0 && (
                <ul className="cg-nodes">
                  {mine.map(c => {
                    const k = status(c), v = c.last?.value;
                    return (
                      <li key={c.id}>
                        <button className={`cg-n k-${c.kind} s-${k}${sel === c.id ? ' on' : ''}${c.on ? '' : ' off'}${c.due ? ' due' : ''}`}
                          aria-pressed={sel === c.id} onClick={() => setSel(x => (x === c.id ? null : c.id))}
                          title={`${c.kind === 'hard' ? tr('硬检查') : tr('软检查')} · ${trx(c.title)} · ${c.on ? ST[k] : tr('已关闭')}`}>
                          <i className={`cg-shape k-${c.kind} s-${c.on ? k : 'none'}`} />
                          <span>{trx(c.title)}</span>
                          {c.on && c.kind === 'hard' && v != null && v > 0 && <em>{v}</em>}
                          {c.on && c.due && <em className="cg-due">{tr('到期')}</em>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {cur && <Detail key={cur.id} c={cur} m={m} busy={busy} act={act} lineId={line.id} onConsole={onConsole} onClose={() => setSel(null)} />}
    </section>
  );
}

const STAGE: Record<string, string> = { todo: tr('没开始'), run: tr('进行中'), wait: tr('等你'), done: tr('完成') };

// how many hard checks passed after each round that changed something
function Trend({ points }: { points: CheckMap['trend'] }) {
  if (points.length < 2) return null;
  const W = 120, H = 28, top = Math.max(...points.map(p => p.total), 1);
  const x = (i: number) => 3 + (i * (W - 6)) / (points.length - 1), y = (v: number) => H - 3 - (v / top) * (H - 6);
  const last = points[points.length - 1];
  return (
    <svg className="cg-trend" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={tr('硬检查通过数：{0}/{1}', last.pass, last.total)}>
      <polyline points={points.map((p, i) => `${x(i)},${y(p.pass)}`).join(' ')} />
      {points.map((p, i) => <circle key={i} cx={x(i)} cy={y(p.pass)} r={i === points.length - 1 ? 3 : 1.6}><title>{`${ago(p.ts)} · ${p.pass}/${p.total}`}</title></circle>)}
    </svg>
  );
}

function Detail({ c, m, busy, act, lineId, onConsole, onClose }: {
  c: Check; m: CheckMap; busy: boolean; lineId: string; onClose: () => void;
  act: (fn: () => Promise<CheckMap | unknown>, done?: string) => Promise<void>; onConsole: (lineId: string, t?: ConsoleTarget) => void;
}) {
  const k = status(c), last = c.last;
  const stage = m.stages.find(s => s.key === c.stage)?.name ?? c.stage;
  const open = (f: { file: string; line: number; hit: string }) => {
    if (c.id === 'results') onConsole(lineId, { job: f.hit });
    else if (f.file) onConsole(lineId, { file: `paper:${f.file}${f.line ? `:${f.line}` : ''}` });
  };
  return (
    <div className={`cg-detail k-${c.kind}`}>
      <div className="cg-d-main">
        <header className="cg-d-h">
          <i className={`cg-shape k-${c.kind} s-${c.on ? k : 'none'}`} />
          <h4>{trx(c.title)}</h4>
          <span className={`cg-pill s-${c.on ? k : 'none'}`}>{c.on ? ST[k] : tr('已关闭')}</span>
          <button className="ib" title={tr('收起')} aria-label={tr('收起')} onClick={onClose}><Icon n="close" size={15} /></button>
        </header>
        <p className="cg-meta small muted">
          {c.kind === 'hard' ? tr('硬检查 · 用代码查') : tr('软检查 · 负责人判断')} · {stage}
          {c.prio && ` · ${c.prio}`}{c.rule && ` · ${trx(c.rule)}`}
          {c.kind === 'soft' && ` · ${tr('每 {0} 小时复查', c.every ?? 24)}`}
        </p>
        <p className="cg-what">{trx(c.text)}</p>

        {c.kind === 'hard' ? (
          last ? (
            <p className="cg-now">
              {last.value == null ? trx(last.note) || ST.none
                : <>{tr('查出 {0}，最多允许 {1}', count(c.unit, last.value), c.max ?? 0)}{last.note && <span className="muted"> · {trx(last.note)}</span>}</>}
              <span className="muted small"> · {tr('{0}查过', ago(last.seen))}</span>
            </p>
          ) : <p className="cg-now muted">{tr('还没查过')}</p>
        ) : last ? (
          <blockquote className={`cg-verdict s-${last.status}`}>
            <p>{last.note}</p>
            <footer className="small muted">{last.by} · {ago(last.ts)}</footer>
          </blockquote>
        ) : (
          <p className="cg-now muted">{c.asked ? tr('{0}问过负责人，还没回', ago(c.asked)) : m.lead ? tr('负责人还没判断过：到期时它会随巡检收到这个问题') : tr('配了负责人才有人判断软检查')}</p>
        )}

        {c.kind === 'hard' && last && last.findings.length > 0 && (
          <div className="cg-finds">
            <table>
              <thead><tr><th>#</th><th>{tr('位置')}</th><th>{tr('原文')}</th><th>{tr('建议')}</th></tr></thead>
              <tbody>
                {last.findings.map((f, i) => (
                  <tr key={i}>
                    <td className="muted">{i + 1}</td>
                    <td className="cg-at">
                      {f.file || c.id === 'results'
                        ? <button className="lnk" onClick={() => open(f)} title={tr('在中控屏里打开')}>{f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : f.hit}</button>
                        : <span className="muted">—</span>}
                    </td>
                    <td><Marked text={f.text} hit={f.hit} /></td>
                    <td className="cg-hint">{trx(f.hint)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {last.total > last.findings.length && <p className="small muted">{tr('只列出前 {0} 处，共 {1} 处', last.findings.length, last.total)}</p>}
          </div>
        )}
      </div>

      <aside className="cg-d-side">
        <h5>{c.kind === 'hard' ? tr('历次结果') : tr('历次判断')}</h5>
        <History c={c} />
        {c.kind === 'soft' && c.on && (
          <button className="btn pri" disabled={busy || !m.lead} title={m.lead ? '' : tr('先配一位项目负责人')}
            onClick={() => act(() => api.askCheck(lineId, c.id), tr('已经发给负责人，它判断完会出现在这里'))}>
            <Icon n="send" size={13} />{tr('让负责人现在查')}
          </button>
        )}
        <Settings c={c} busy={busy} act={act} lineId={lineId} onRemoved={onClose} />
      </aside>
    </div>
  );
}

function Marked({ text, hit }: { text: string; hit: string }) {
  const i = hit ? text.toLowerCase().indexOf(hit.toLowerCase()) : -1;
  if (i < 0) return <span>{text}</span>;
  return <span>{text.slice(0, i)}<mark>{text.slice(i, i + hit.length)}</mark>{text.slice(i + hit.length)}</span>;
}

// a hard check's count over its rounds, with the line it must stay under; a soft check's verdicts in a row
function History({ c }: { c: Check }) {
  const pts = c.history;
  if (!pts.length) return <p className="small muted">{tr('还没有记录')}</p>;
  if (c.kind === 'soft') {
    return (
      <ol className="cg-verdicts">
        {pts.map((p, i) => <li key={i} className={`s-${p.status}`} title={`${ago(p.ts)} · ${ST[p.status]}`} />)}
      </ol>
    );
  }
  const vals = pts.map(p => p.value ?? 0), most = c.max ?? 0;
  const W = 240, H = 72, top = Math.max(...vals, most, 1);
  const x = (i: number) => (pts.length === 1 ? W / 2 : 8 + (i * (W - 16)) / (pts.length - 1)), y = (v: number) => H - 14 - (v / top) * (H - 26);
  return (
    <svg className="cg-hist" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={tr('历次结果')}>
      <line className="cg-axis" x1={0} x2={W} y1={y(0)} y2={y(0)} />
      {most > 0 && <line className="cg-max" x1={0} x2={W} y1={y(most)} y2={y(most)}><title>{tr('最多允许 {0}', most)}</title></line>}
      {pts.length > 1 && <polyline points={vals.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />}
      {pts.map((p, i) => (
        <circle key={i} className={`s-${p.status}`} cx={x(i)} cy={y(vals[i])} r={4}>
          <title>{`${ago(p.ts)} · ${p.value ?? '—'} · ${ST[p.status]}`}</title>
        </circle>
      ))}
      <text x={x(pts.length - 1)} y={y(vals[vals.length - 1]) - 8} textAnchor={pts.length === 1 ? 'middle' : 'end'}>{vals[vals.length - 1]}</text>
    </svg>
  );
}

function Settings({ c, busy, act, lineId, onRemoved }: {
  c: Check; busy: boolean; lineId: string; onRemoved: () => void; act: (fn: () => Promise<CheckMap | unknown>, done?: string) => Promise<void>;
}) {
  const [max, setMax] = useState(String(c.max ?? 0));
  const [params, setParams] = useState<Record<string, string>>(() => Object.fromEntries((c.params ?? []).map(p => [p.key, String(p.value)])));
  const [prompt, setPrompt] = useState(c.text);
  const dirty = c.kind === 'hard'
    ? max !== String(c.max ?? 0) || (c.params ?? []).some(p => params[p.key] !== String(p.value))
    : prompt.trim() !== c.text;
  const save = () => act(() => api.setCheck(lineId, c.id, c.kind === 'hard'
    ? { params: { max: Number(max), ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, Number(v)])) } }
    : { prompt: prompt.trim() }), tr('保存了'));
  return (
    <div className="cg-set">
      <h5>{tr('设置')}</h5>
      <label className="ld-sw">
        <input type="checkbox" checked={c.on} disabled={busy} onChange={e => act(() => api.setCheck(lineId, c.id, { on: e.target.checked }))} />
        <span>{tr('启用这项检查')}</span>
      </label>
      {c.kind === 'hard' ? (
        <>
          <label className="field">{tr('最多允许几处')}
            <input type="number" min={0} value={max} onChange={e => setMax(e.target.value)} />
          </label>
          {(c.params ?? []).map(p => (
            <label key={p.key} className="field">{trx(p.label)}
              <input type="number" min={0} step="any" value={params[p.key] ?? ''} onChange={e => setParams(x => ({ ...x, [p.key]: e.target.value }))} />
            </label>
          ))}
        </>
      ) : (
        <>
          <label className="field">{tr('问负责人的问题（写进你的要求）')}
            <textarea rows={4} value={prompt} maxLength={2000} onChange={e => setPrompt(e.target.value)} />
          </label>
          <label className="field">{tr('多久复查一次')}
            <Select value={c.every ?? 24} onChange={v => act(() => api.setCheck(lineId, c.id, { every: v }))}
              options={EVERY.map(h => ({ value: h, label: h < 24 ? tr('{0} 小时', h) : tr('{0} 天', h / 24) }))} />
          </label>
        </>
      )}
      <div className="cg-set-btns">
        {dirty && <button className="btn pri" disabled={busy} onClick={save}>{tr('保存')}</button>}
        {c.custom && <button className="btn" disabled={busy} onClick={() => act(() => api.dropCheck(lineId, c.id), tr('删掉了')).then(onRemoved)}>{tr('删掉')}</button>}
      </div>
    </div>
  );
}

function AddCheck({ m, busy, onAdd, onCancel }: {
  m: CheckMap; busy: boolean; onCancel: () => void;
  onAdd: (b: { kind: 'hard' | 'soft'; stage: string; title: string; text: string; prio: string; max: number }) => void;
}) {
  const [kind, setKind] = useState<'hard' | 'soft'>('soft');
  const [stage, setStage] = useState('exp');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [prio, setPrio] = useState('P1');
  const stages = useMemo(() => m.stages.map(s => ({ value: s.key, label: s.name })), [m.stages]);
  const ok = title.trim() && text.trim();
  return (
    <form className="cg-add" onSubmit={e => { e.preventDefault(); if (ok) onAdd({ kind, stage, title: title.trim(), text: text.trim(), prio, max: 0 }); }}>
      <div className="seg" role="radiogroup" aria-label={tr('检查的种类')}>
        <button type="button" role="radio" aria-checked={kind === 'soft'} className={kind === 'soft' ? 'on' : ''} onClick={() => setKind('soft')}>{tr('软检查 · 一个问题')}</button>
        <button type="button" role="radio" aria-checked={kind === 'hard'} className={kind === 'hard' ? 'on' : ''} onClick={() => setKind('hard')}>{tr('硬检查 · 一条规则')}</button>
      </div>
      <label className="field">{tr('挂在哪道工序')}<Select value={stage} onChange={setStage} options={stages} /></label>
      <label className="field">{tr('名字')}<input value={title} maxLength={20} placeholder={kind === 'soft' ? tr('比如「要有消融」') : tr('比如「不写 novel」')} onChange={e => setTitle(e.target.value)} /></label>
      <label className="field cg-add-text">{kind === 'soft' ? tr('问负责人什么') : tr('论文里不能出现的（正则表达式，不分大小写）')}
        {kind === 'soft'
          ? <textarea rows={2} value={text} maxLength={2000} placeholder={tr('比如「每个模块都有消融实验吗？缺哪个列出来」')} onChange={e => setText(e.target.value)} />
          : <input value={text} maxLength={500} placeholder={'\\bnovel\\b'} onChange={e => setText(e.target.value)} />}
      </label>
      {kind === 'hard' && (
        <label className="field">{tr('要求')}<Select value={prio} onChange={setPrio} options={[{ value: 'P0', label: tr('P0 · 必须过') }, { value: 'P1', label: tr('P1 · 尽量过') }]} /></label>
      )}
      <div className="cg-set-btns">
        <button className="btn pri" type="submit" disabled={busy || !ok}>{tr('加上')}</button>
        <button className="btn" type="button" onClick={onCancel}>{tr('取消')}</button>
      </div>
    </form>
  );
}
