// A check, as the canvas shows it (Canvas.tsx, CanvasSide.tsx): ◆ hard checks are code (counts, patterns, fixed formats) that must
// pass; ● soft checks are questions the lead answers by reading the project, asked again every so often. Here is
// what a check's node opens beside the canvas: what it checks, its result and history, where it fails, its settings.

import { useState } from 'react';
import { api, type CanvasView, type Check, type CheckStatus } from '../api';
import { Select } from '../components/Select';
import { Icon } from '../console/icons';
import { ago } from '../console/util';
import { tr, trx } from '../i18n';
import type { ConsoleTarget } from './Project';

export const ST: Record<CheckStatus, string> = { pass: tr('通过'), warn: tr('有问题'), fail: tr('没过'), none: tr('没有可查的'), wait: tr('等负责人判断') };
export const STAGE: Record<string, string> = { todo: tr('没开始'), run: tr('进行中'), wait: tr('等你'), done: tr('完成'), fail: tr('出错') };
const EVERY = [6, 12, 24, 48, 72, 168];
export const status = (c: Check): CheckStatus => c.last?.status ?? (c.kind === 'soft' ? 'wait' : 'none');
// a count in the unit the check counts in
const count = (unit: string | undefined, n: number) =>
  unit === '篇' ? tr('{0} 篇', n) : unit === '个' ? tr('{0} 个任务', n) : unit === '个词' ? tr('{0} 个词', n) : unit === '项' ? tr('{0} 项不满足', n) : tr('{0} 处', n);

export type Act = (fn: () => Promise<unknown>, done?: string) => Promise<void>;

// how many hard checks passed after each round that changed something
export function Trend({ points }: { points: CanvasView['trend'] }) {
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

// what a check found: its count against what is allowed (hard) or the lead's verdict (soft), what to do about it,
// and where it fails
export function CheckResult({ c, lead, busy, act, lineId, onConsole, onFix }: {
  c: Check; lead: boolean; busy: boolean; lineId: string; act: Act; onConsole: (lineId: string, t?: ConsoleTarget) => void; onFix: () => void;
}) {
  const last = c.last, k = status(c), bad = c.on && (k === 'fail' || k === 'warn');
  const open = (f: { file: string; line: number; hit: string }) => {
    if (c.id === 'results') onConsole(lineId, { job: f.hit });
    else if (f.file) onConsole(lineId, { file: `paper:${f.file}${f.line ? `:${f.line}` : ''}` });
  };
  const most = c.max ?? 0, scale = Math.max(last?.value ?? 0, most, 1) * 1.25;
  return (
    <>
      <p className="cg-what">{trx(c.text)}</p>
      {c.kind === 'hard' && (
        <p className="small muted">{c.gate === 'block' ? tr('阻断级：没过时锁住下一道工序，并打回修补单') : tr('告警级：没过时只提醒，不锁工序')}
          {c.first?.value != null && last?.value != null && ` · ${tr('R1 {0} → 现在 {1}', c.first.value, last.value)}`}</p>
      )}
      {c.kind === 'hard' ? (
        last && last.value != null ? (
          <div className={`cg-meter s-${c.on ? k : 'none'}`}>
            <p><b>{last.value}</b><span>{tr('最多允许 {0}', most)}{last.note && ` · ${trx(last.note)}`}</span><small>{tr('{0}查过', ago(last.seen))}</small></p>
            <div className="cg-bar" role="img" aria-label={tr('查出 {0}，最多允许 {1}', count(c.unit, last.value), most)}>
              <i style={{ width: `${(last.value / scale) * 100}%` }} /><u style={{ left: `${(most / scale) * 100}%` }} />
            </div>
          </div>
        ) : <p className="cg-now muted">{last ? trx(last.note) || ST.none : tr('还没查过')}</p>
      ) : last ? (
        <blockquote className={`cg-verdict s-${last.status}`}>
          <p>{last.note}</p>
          <footer className="small muted">{last.by} · {ago(last.ts)}</footer>
        </blockquote>
      ) : (
        <p className="cg-now muted">{c.asked ? tr('{0}问过负责人，还没回', ago(c.asked)) : lead ? tr('负责人还没判断过：到期时它会随巡检收到这个问题') : tr('配了负责人才有人判断软检查')}</p>
      )}
      {c.on && (
        <div className="cv-row">
          {bad && <button className="btn pri" onClick={onFix} title={c.kind === 'soft' ? tr('建一个纠偏任务，连回它盯着的工序，你看过再发') : tr('把这道卡口没过的规则写成修补单，发给这道工序的员工')}>
            <Icon n={c.kind === 'soft' ? 'wand' : 'refresh'} size={13} />{c.kind === 'soft' ? tr('派人纠偏') : tr('派修补单')}</button>}
          {c.kind === 'soft'
            ? <button className={`btn${bad ? '' : ' pri'}`} disabled={busy || !lead} title={lead ? '' : tr('先配一位项目负责人')}
              onClick={() => act(() => api.askCheck(lineId, c.id), tr('已经发给负责人，它判断完会出现在这里'))}><Icon n="send" size={13} />{tr('让负责人现在查')}</button>
            : <button className="btn" disabled={busy} onClick={() => act(() => api.runChecks(lineId), tr('查完了'))}><Icon n="refresh" size={13} />{tr('再查一遍')}</button>}
        </div>
      )}

      {c.kind === 'hard' && last && last.findings.length > 0 && (
        <section className="cv-sec">
          <h5>{tr('没过的地方')}{last.total > last.findings.length && <span className="muted"> · {tr('只列出前 {0} 处，共 {1} 处', last.findings.length, last.total)}</span>}</h5>
          <ol className="cg-finds">
            {last.findings.map((f, i) => (
              <li key={i}>
                <span className="cg-num">{i + 1}</span>
                <div>
                  {(f.file || c.id === 'results') && (
                    <button className="lnk cg-at" onClick={() => open(f)} title={tr('在中控屏里打开')}>{f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : f.hit}</button>
                  )}
                  {f.text && <p><Marked text={f.text} hit={f.hit} /></p>}
                  {f.hint && <p className="cg-hint">{trx(f.hint)}</p>}
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}
    </>
  );
}

// every time the result changed (hard) or the lead judged (soft), newest first, under the chart of it
export function CheckHistory({ c }: { c: Check }) {
  const rows = [...c.history].reverse();
  return (
    <>
      <History c={c} />
      {rows.length > 0 && (
        <ul className="cg-rounds">
          {rows.map((p, i) => (
            <li key={i}>
              <i className={`cg-shape k-${c.kind} s-${p.status}`} />
              <b>{c.kind === 'hard' ? p.value ?? '—' : ST[p.status]}</b>
              <span className="muted">{c.kind === 'hard' ? ST[p.status] : ''}</span>
              <small className="muted">{ago(p.ts)}</small>
            </li>
          ))}
        </ul>
      )}
    </>
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

export function CheckSettings({ c, busy, act, lineId }: { c: Check; busy: boolean; lineId: string; act: Act }) {
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
      <label className="ld-sw">
        <input type="checkbox" checked={c.on} disabled={busy} onChange={e => act(() => api.setCheck(lineId, c.id, { on: e.target.checked }))} />
        <span>{tr('启用这项检查')}</span>
      </label>
      {c.kind === 'hard' && (
        <label className="field">{tr('没过时')}
          <Select value={c.gate ?? 'warn'} disabled={busy} onChange={g => act(() => api.setCheck(lineId, c.id, { gate: g }), tr('保存了'))}
            options={[{ value: 'block' as const, label: tr('阻断：锁住下一道工序并打回') }, { value: 'warn' as const, label: tr('告警：只提醒') }]} />
        </label>
      )}
      {c.kind === 'hard' ? (
        <div className="cg-nums">
          <label className="field">{tr('最多允许几处')}
            <input type="number" min={0} value={max} onChange={e => setMax(e.target.value)} />
          </label>
          {(c.params ?? []).map(p => (
            <label key={p.key} className="field">{trx(p.label)}
              <input type="number" min={0} step="any" value={params[p.key] ?? ''} onChange={e => setParams(x => ({ ...x, [p.key]: e.target.value }))} />
            </label>
          ))}
        </div>
      ) : (
        <>
          <label className="field">{tr('问负责人的问题（写进你的要求）')}
            <textarea rows={5} value={prompt} maxLength={2000} onChange={e => setPrompt(e.target.value)} />
          </label>
          <label className="field">{tr('多久复查一次')}
            <Select value={c.every ?? 24} onChange={v => act(() => api.setCheck(lineId, c.id, { every: v }))}
              options={EVERY.map(h => ({ value: h, label: h < 24 ? tr('{0} 小时', h) : tr('{0} 天', h / 24) }))} />
          </label>
        </>
      )}
      {dirty && <div className="cg-set-btns"><button className="btn pri" disabled={busy} onClick={save}>{tr('保存')}</button></div>}
    </div>
  );
}
