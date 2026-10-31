// One job in full, as a sheet over the right of the console. The header takes the colour of the
// job's state, and what the state makes most worth reading comes first: why it failed, how far
// it has got, what it waits for, or the numbers it gave back. Then where and how long it ran,
// its note, its whole result grouped by key, its command, and the events nvidb logged for it.
// Read only, like the rest of nvidb here.

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type Job, type NvJobFull } from '../api';
import { gb, useGpus } from '../components/Gpus';
import { tr } from '../i18n';
import { ST, fmtNum, stOf, useNow, when } from './charts';
import { Icon } from './icons';
import { ago, bytes, dur, flat, headline, lastLine, pctOf, tails } from './util';

interface Props { id: string; onClose: () => void; onJob: (id: string) => void; nav?: { prev?: string; next?: string } }

// what nvidb's event kinds mean for the eye: done, gone wrong, needs a look, under way
const evTone = (k: string) => /fail|lost|timeout|error|unschedul/.test(k) ? 'bad' : /held|retr|overdue|alert/.test(k) ? 'warn'
  : /complet|finish|result/.test(k) ? 'ok' : /start|launch|dispatch|stag|run/.test(k) ? 'run' : '';

export function JobDrawer({ id, onClose, onJob, nav }: Props) {
  const [nv, setNv] = useState<NvJobFull | null>(null);
  const [farm, setFarm] = useState<Job | null>(null);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState('');
  const nvId = id.startsWith('nvidb-') ? Number(id.slice(6)) : null;
  const cards = useGpus(); // the same live reading as the cluster: where a running job's processes are now
  const now = useNow(5000);

  useEffect(() => {
    let live = true;
    setNv(null); setFarm(null); setErr('');
    (nvId != null ? api.nvJob(nvId).then(j => live && setNv(j)) : api.job(id).then(j => live && setFarm(j)))
      .catch(e => live && setErr((e as Error).message));
    return () => { live = false; };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc closes the sheet before anything else; ←/→ walk the list it was opened from
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && ['INPUT', 'TEXTAREA'].includes(t.tagName)) return;
      if (e.key === 'Escape') { e.stopImmediatePropagation(); onClose(); }
      else if (e.key === 'ArrowLeft' && nav?.prev) onJob(nav.prev);
      else if (e.key === 'ArrowRight' && nav?.next) onJob(nav.next);
    };
    addEventListener('keydown', key, true);
    return () => removeEventListener('keydown', key, true);
  }, [onClose, onJob, nav]);

  const copy = (what: string, text: string) => {
    navigator.clipboard?.writeText(text).then(() => { setCopied(what); setTimeout(() => setCopied(''), 1400); }).catch(() => {});
  };

  const host = document.querySelector('.p-console');
  if (!host) return null;
  const name = nv?.name ?? farm?.name ?? '…';
  const st = stOf(nv?.state ?? farm?.status);
  const result = nv?.result ?? farm?.result;
  const cut = result && typeof result === 'object' && '_truncated' in result ? String((result as { _truncated: string })._truncated) : null;
  const rows = result && typeof result === 'object' && !cut ? flat(result) : [];
  const top = headline(cut ? null : result, 4);
  const keys = new Set(top.map(([k]) => k)), topNames = tails(top.map(([k]) => k));

  // the same few facts for an nvidb job and a farm job
  const where = nv ? (nv.node ? `${nv.node}${nv.gpu_ids.length ? ` · GPU ${nv.gpu_ids.join(',')}` : ` · ${tr('不占卡')}`}` : nv.lane ?? (nv.pool ? tr('池 {0}', nv.pool) : tr('等分配')))
    : farm ? (farm.backend === 'sim' ? tr('模拟电厂') : farm.backend) : '';
  const started = nv?.started_at ?? farm?.started_at ?? null;
  const ended = nv?.finished_at ?? farm?.ended_at ?? null;
  const took = st === 'running' && started ? (now - Date.parse(started)) / 1000
    : nv?.elapsed_s ?? (started ? ((ended ? Date.parse(ended) : now) - Date.parse(started)) / 1000 : null);
  const procs = nv && st === 'running' ? (cards?.nodes ?? []).flatMap(n => n.gpus.flatMap(x => x.procs.filter(p => p.job_id === nv.id)
    .map(p => ({ ...p, where: `${n.name} · GPU ${x.index}` })))) : [];
  const limit = nv?.max_runtime_s ?? null;
  const exit = nv?.exit_code ?? null;
  const error = nv?.last_error ?? '';
  const pct = st === 'running' ? (nv ? pctOf(nv.progress) : farm?.progress ?? null) : null;
  const loaded = !!(nv || farm);

  return createPortal(
    <>
      <div className="jd-back" onClick={onClose} />
      <aside className={`jd s-${st}`} role="dialog" aria-label={name}>
        <header className="jd-h">
          <div className="jd-t">
            <span className="jd-id">
              <span className={`jd-pill${ST[st].hollow ? ' hollow' : ''}`}><i>{ST[st].sign}</i>{ST[st].label}</span>
              <span className="muted small">{nvId != null ? `nvidb #${nvId}` : id}{nv?.submitter ? ` · ${nv.submitter}` : ''}</span>
            </span>
            <h3 title={name}>{name}</h3>
            {loaded && (
              <span className="jd-kv">
                {where && <span><Icon n="gpu" size={13} />{where}</span>}
                {took != null && <span><Icon n="clock" size={13} />{dur(took)}{st === 'running' ? ` · ${tr('还在跑')}` : ''}</span>}
                {exit != null && <span className={exit ? 'bad' : ''}>{tr('退出码 {0}', exit)}</span>}
                {ended && <span className="muted">{ago(ended)}</span>}
              </span>
            )}
          </div>
          <div className="jd-nav">
            <button className="ib" disabled={!nav?.prev} onClick={() => nav?.prev && onJob(nav.prev)} title={tr('上一个（←）')}><Icon n="left" size={16} /></button>
            <button className="ib" disabled={!nav?.next} onClick={() => nav?.next && onJob(nav.next)} title={tr('下一个（→）')}><Icon n="right" size={16} /></button>
            <button className="ib" onClick={onClose} title={tr('关闭（Esc）')}><Icon n="close" size={16} /></button>
          </div>
        </header>
        <div className="jd-body" key={id}>
          {err && <p className="warn-box small">{err}</p>}
          {!loaded && !err && <p className="muted">{tr('读取中…')}</p>}

          {/* what this state makes most worth reading, first */}
          {loaded && st === 'failed' && (
            <section className="jd-call bad">
              <h4>{tr('为什么失败')}</h4>
              {error ? <><p className="jd-why mono">{lastLine(error)}</p>{error.trim().includes('\n') && <Tail text={error} />}</>
                : <p className="jd-why">{exit != null ? tr('退出码 {0}，没有留下出错信息', exit) : tr('没有留下出错信息')}</p>}
            </section>
          )}
          {loaded && st === 'running' && (
            <section className="jd-call run">
              <h4>{tr('进度')}{pct != null && <b>{Math.round(pct)}%</b>}</h4>
              {pct != null && <span className="jd-bar"><i style={{ width: `${Math.min(100, pct)}%` }} /></span>}
              {nv?.progress && <p className="mono jd-line">{nv.progress}{nv.progress_at ? <em> · {ago(nv.progress_at)}</em> : null}</p>}
              {limit != null && took != null && (
                <p className="small jd-lim">
                  <span className="jd-bar thin"><i style={{ width: `${Math.min(100, (100 * took) / limit)}%` }} /></span>
                  {tr('已跑 {0} / 上限 {1}', dur(took), dur(limit))}
                </p>
              )}
            </section>
          )}
          {nv && st === 'queued' && (
            <section className={`jd-call ${nv.held ? 'warn' : 'wait'}`}>
              <h4>{nv.held ? tr('挂起：依赖没跑成，等人决定') : tr('在等什么')}</h4>
              <p className="jd-line">
                {(nv.depends_on?.length ?? 0) > 0 ? tr('等这些任务先跑完：') : nv.lane ? tr('排在 {0} 这条队列里', nv.lane) : tr('等一张放得下它的卡')}
              </p>
              {(nv.depends_on?.length ?? 0) > 0 && <span className="jd-deps">{nv.depends_on!.map(d => <button key={d} className="chip" onClick={() => onJob(`nvidb-${d}`)}>#{d}</button>)}</span>}
              {nv.held_reason && <p className="small jd-line">{nv.held_reason}</p>}
            </section>
          )}
          {top.length > 0 && (
            <section className="jd-top">
              {top.map(([k, v], i) => <span key={k} title={k}><strong>{fmtNum(v)}</strong><em>{topNames[i]}</em></span>)}
            </section>
          )}

          {loaded && (
            <section className="jd-grid">
              <span><em>{tr('在哪')}</em><b>{where || '—'}</b></span>
              {nv && <span><em>{tr('显存预留')}</em><b>{nv.vram_mb ? bytes(nv.vram_mb * 1024 * 1024) : '—'}{nv.gpus ? ` · ${tr('{0} 张卡', nv.gpus)}` : ''}</b></span>}
              {st !== 'queued' && <span><em>{tr('开始')}</em><b>{started ? when(Date.parse(started)) : '—'}</b></span>}
              {st !== 'queued' && <span><em>{tr('结束')}</em><b>{ended ? when(Date.parse(ended)) : st === 'running' ? tr('还在跑') : '—'}</b></span>}
              {st === 'queued' && <span><em>{tr('提交')}</em><b>{nv?.created_at ? `${when(Date.parse(nv.created_at))} · ${ago(nv.created_at)}` : '—'}</b></span>}
              <span><em>{st === 'queued' ? tr('上限') : tr('用时')}</em><b>{st === 'queued' ? (limit ? dur(limit) : '—') : <>{dur(took)}{limit ? <i className="muted"> / {dur(limit)}</i> : null}</>}</b>
                {limit != null && took != null && <span className="jd-bar thin"><i style={{ width: `${Math.min(100, (100 * took) / limit)}%` }} /></span>}</span>
              {nv && st !== 'queued' && <span><em>{tr('退出码')}</em><b className={exit ? 'bad-t' : ''}>{exit ?? '—'}{nv.attempt && nv.attempt > 1 ? ` · ${tr('第 {0} 次尝试', nv.attempt)}` : ''}</b></span>}
              {nv?.progress && st !== 'running' && <span className="wide"><em>{tr('状态行')}</em><b className="mono">{nv.progress}</b></span>}
              {procs.length > 0 && (
                <span className="wide"><em>{tr('卡上的进程（实时）')}</em>
                  {procs.map(p => <b key={`${p.where}${p.pid}`} className="jd-proc">{p.where} · {p.user ?? '?'} · pid {p.pid ?? '?'} · {gb(p.mem_mb)}</b>)}</span>
              )}
              {nv && st !== 'queued' && (nv.depends_on?.length ?? 0) > 0 && (
                <span className="wide"><em>{tr('依赖')}</em><span className="jd-deps">{nv.depends_on!.map(d => <button key={d} className="chip" onClick={() => onJob(`nvidb-${d}`)}>#{d}</button>)}</span></span>
              )}
            </section>
          )}

          {(nv?.notes || farm?.note) && <section className="jd-s note"><h4><i />{tr('说明')}</h4><p className="jd-note">{nv?.notes || farm?.note}</p></section>}

          {rows.length > 0 && (
            <section className="jd-s res">
              <h4><i />{tr('结果')}<span className="muted">{tr('{0} 项', rows.length)}</span>
                <button className="lnk" onClick={() => copy('result', JSON.stringify(result, null, 2))}>{copied === 'result' ? tr('已复制') : tr('复制 JSON')}</button></h4>
              <ResultTable rows={rows.slice(0, 160)} keys={keys} />
            </section>
          )}
          {cut && <section className="jd-s res"><h4><i />{tr('结果')}<span className="muted small">{tr('太长，nvidb 只交回了前一部分')}</span></h4><pre className="jd-pre">{cut}…</pre></section>}

          {(nv?.command || farm?.command) && (
            <section className="jd-s cmd">
              <h4><i />{tr('命令')}<button className="lnk" onClick={() => copy('cmd', nv?.command ?? farm?.command ?? '')}>{copied === 'cmd' ? tr('已复制') : tr('复制')}</button></h4>
              <pre className="jd-pre code">{nv?.command ?? farm?.command}</pre>
            </section>
          )}
          {error && st !== 'failed' && <section className="jd-s err"><h4><i />{tr('出错信息')}</h4><pre className="jd-pre bad">{error}</pre></section>}
          {farm?.log && <section className="jd-s cmd"><h4><i />{tr('日志')}</h4><pre className="jd-pre">{farm.log}</pre></section>}
          {(nv?.events.length ?? 0) > 0 && (
            <section className="jd-s ev">
              <h4><i />{tr('事件')}</h4>
              <ol className="jd-ev">{nv!.events.slice().reverse().map((e, i) => (
                <li key={i} className={evTone(e.kind)}>
                  <span className="muted small">{e.ts ? when(Date.parse(e.ts)) : ''}</span><b>{e.kind.replace(/^job_/, '')}</b><span>{e.message}</span>
                </li>
              ))}</ol>
            </section>
          )}
          <p className="muted small jd-ro">{tr('只读：要改这个任务，用 nvidb 的命令（nvidb job …）。')}</p>
        </div>
        <i className="jd-edge" />
      </aside>
    </>,
    host,
  );
}

// an error's tail, scrolled to its end, where a traceback says what went wrong
function Tail({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [text]);
  return <pre ref={ref} className="jd-pre bad">{text}</pre>;
}

// the result, keys sharing a first part under one heading, the headline numbers lit
function ResultTable({ rows, keys }: { rows: [string, unknown][]; keys: Set<string> }) {
  const pre = (k: string) => (k.includes('.') ? k.slice(0, k.indexOf('.')) : '');
  const n = new Map<string, number>();
  for (const [k] of rows) n.set(pre(k), (n.get(pre(k)) ?? 0) + 1);
  const group = (k: string) => ((n.get(pre(k)) ?? 0) > 1 ? pre(k) : '');
  const groups = new Map<string, [string, unknown][]>();
  for (const r of rows) groups.set(group(r[0]), [...(groups.get(group(r[0])) ?? []), r]);
  const ordered = [...groups.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : 0));
  // bars measure against the largest number in their own group, not against a byte count elsewhere
  const topOf = (rs: [string, unknown][]) => Math.max(...rs.map(([, v]) => (typeof v === 'number' ? Math.abs(v) : 0)), 1e-12);
  return (
    <table className="ctab jd-res">
      <tbody>{ordered.map(([g, rs]) => { const top = topOf(rs); return (
        <Fragment key={g || '·'}>
          {g && <tr className="jd-g"><td colSpan={2}>{g}<em>{rs.length}</em></td></tr>}
          {rs.map(([k, v]) => (
            <tr key={k} className={`${keys.has(k) ? 'key' : ''}${typeof v === 'number' ? '' : ' txt'}`}>
              <td className="mono">{g ? k.slice(g.length + 1) : k}</td>
              <td>{typeof v === 'number'
                ? <><span className="rbar"><i style={{ ['--v' as string]: Math.abs(v) / top }} /></span><b>{fmtNum(v)}</b></>
                : <span className="jd-str">{typeof v === 'string' ? v : JSON.stringify(v)}</span>}</td>
            </tr>
          ))}
        </Fragment>
      ); })}</tbody>
    </table>
  );
}
