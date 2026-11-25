// 前后对比 on the research loop (Canvas.tsx): every hard gate's rules from the first round to now and every sentinel's
// latest verdict, as one report over the canvas, to copy as Markdown or publish as one of the project's pages.

import { modelText, StateWord, stateTone } from '../emphasis';
import { useState } from 'react';
import { api, type CanvasView } from '../api';
import { Icon } from '../console/icons';
import { ago } from '../console/util';
import { tr, trx } from '../i18n';
import { follow, href } from '../route';
import { status } from './Checks';
import { drop, gateChecks, gateLook, GATE_ST, level, LEVEL, VERDICT } from './loop';

export function LoopReport({ v, onPick, onClose, toast }: { v: CanvasView; onPick: (id: string) => void; onClose: () => void; toast: (t: string, error?: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const gates = v.nodes.filter(n => n.kind === 'gate' && n.gate);
  const soft = v.checks.filter(c => c.kind === 'soft' && c.on);
  const pages = `/progress/${v.seq}/pages`, f = v.found;
  const copy = async () => {
    try {
      const r = await api.loopReport(v.line_id);
      await navigator.clipboard.writeText(r.markdown);
      toast(tr('已复制：Markdown 表格'));
    } catch (e) { toast((e as Error).message, true); }
  };
  const publish = async () => {
    setBusy(true);
    try {
      const p = await api.publishReport(v.line_id);
      toast(tr('已发布为汇报页「{0}」', p.title));
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  return (
    <div className="lr" role="region" aria-label={tr('前后对比')}>
      <header className="lr-h">
        <div>
          <h3>{tr('前后对比')}<small>{tr('第 {0} 轮', v.rounds)}{f.first != null && f.now != null && ` · ${tr('硬卡口违规 {0} → {1} 处', f.first, f.now)}${f.first > f.now ? ` ↓${drop(f.first, f.now)}%` : ''}`}</small></h3>
          <p className="small muted">{tr('硬卡口各规则首轮检出与当前结果，加上负责人对各项软巡检的最新判断，即构成此轮进展汇报的质控部分。')}</p>
        </div>
        <button className="btn" onClick={copy}><Icon n="copy" size={13} />{tr('复制 Markdown')}</button>
        <button className="btn pri" disabled={busy} onClick={publish}><Icon n="doc" size={13} />{tr('发布为汇报页')}</button>
        <button className="ib" title={tr('收起')} aria-label={tr('收起')} onClick={onClose}><Icon n="close" size={15} /></button>
      </header>
      <section>
        <h4><i className="cv-dia" />{tr('硬限制质控')}<span>Code Rule · Before → After</span></h4>
        <table className="lr-t">
          <thead><tr><th>{tr('卡口')}</th><th>{tr('规则')}</th><th>{tr('要求')}</th><th>R1</th><th>{tr('现在')}</th><th>{tr('门禁')}</th><th>{tr('修补单')}</th></tr></thead>
          <tbody>
            {gates.flatMap(n => {
              const g = n.gate!, cs = gateChecks(v, g).filter(c => c.on);
              return cs.map((c, i) => {
                const lv = level(c);
                return (
                  <tr key={c.id} className={`l-${lv}`}>
                    {i === 0 && <td rowSpan={cs.length} className="lr-g"><button className="lnk" onClick={() => onPick(n.id)}>{g.name}</button><small><StateWord state={gateLook(g)}>{GATE_ST[gateLook(g)]}</StateWord></small></td>}
                    <td>{trx(c.title)}<small className="muted"> · {trx(c.rule)}</small></td>
                    <td>{c.prio} · ≤{c.max ?? 0}</td>
                    <td>{c.first?.value ?? '—'}</td>
                    <td><b className={c.first?.value != null && c.last?.value != null && c.first.value !== c.last.value ? 'em-mark' : 'em-num'} data-tone={stateTone(lv)}>{c.last?.value ?? '—'}</b></td>
                    <td><StateWord state={lv}>{lv === 'pass' ? tr('放行 ✓') : lv === 'none' ? tr('尚未检查') : LEVEL[lv]}</StateWord></td>
                    <td>{i === 0 && g.ticket ? <button className="lnk" onClick={() => onPick(g.ticket!)}>{g.ticket} · {tr('第 {0} 轮', g.round)}</button> : ''}</td>
                  </tr>
                );
              });
            })}
          </tbody>
        </table>
      </section>
      <section>
        <h4><i className="cv-ring2" />{tr('软检测航向')}<span>{tr('负责人语义巡检结论')}</span></h4>
        <table className="lr-t">
          <thead><tr><th>{tr('巡检')}</th><th>{tr('判断')}</th><th>{tr('判词')}</th><th>{tr('时间')}</th></tr></thead>
          <tbody>
            {soft.map(c => {
              const k = status(c);
              return (
                <tr key={c.id}>
                  <td><button className="lnk" onClick={() => onPick(`check:${c.id}`)}>{trx(c.title)}</button></td>
                  <td><StateWord state={k}>{VERDICT[k]}</StateWord></td>
                  <td className="lr-note">{modelText(c.last?.note) || <span className="muted">{trx(c.text)}</span>}</td>
                  <td className="muted">{c.last ? ago(c.last.ts) : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      <p className="small muted">{tr('汇报页已发布至')} <a className="lnk" href={href(pages)} onClick={e => follow(e, pages)}>{tr('汇报与讲解')}</a>{tr('，可全屏演示。')}</p>
    </div>
  );
}
