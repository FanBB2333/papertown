// The overview panel: where the project stands and what it waits on you for. The eight
// stages as one line of steps (each opens the panel that does its work), what each part
// of the project has come to so far, and the mill's full sheet folded away underneath.

import type { Line, Placement, WsInfo } from '../api';
import { MillDetail } from '../components/Sheet';
import { STATUS } from '../components/MillRoom';
import { tr } from '../i18n';
import { Icon, type IconName } from './icons';
import type { ModId } from './Console';
import { gist } from './util';

interface Props {
  line: Line | null; info: WsInfo | null; tick: number; placements: Placement[]; go: (m: ModId) => void;
  onHatch: (id: string) => void; onResume: (id: string) => void; onAdjust: (id: string) => void; onAsk: () => void; onOpen: (id: string) => void;
}

export const STAGE_MOD: Record<string, ModId> = {
  idea: 'survey', hatch: 'survey', team: 'agents', method: 'survey', exp: 'exp', write: 'paper', review: 'paper', ship: 'paper',
};
const REAL = tr('工序按顺序走：方法设计在造纸厂，代码和实验在仓库与实验农场，写作在印刷厂，最后经质检所出厂。');

export function Overview(p: Props) {
  const l = p.line;
  if (!l) return <div className="cm-page"><p className="muted">{tr('加载中…')}</p></div>;
  const done = l.stages.filter(s => s.status === 'done').length;
  const h = l.outputs?.hatch;
  const exp = l.stages.find(s => s.key === 'exp');
  const typeOf = (id: string) => p.placements.find(x => x.id === id)?.type ?? id;
  const money = (v: number) => (v > 0 && v < 0.01 ? '<$0.01' : `$${v.toFixed(2)}`);

  const ask = l.status === 'waiting' ? { t: tr('查重报告出来了，等你决定'), d: gist(h?.summary, 80) || tr('看过调研后，决定立项还是调整 idea。'), btns: <>
    <button className="btn pri" onClick={() => p.onHatch(l.id)}>{tr('孵化并立项')}</button>
    <button className="btn" onClick={() => p.onAdjust(l.id)}>{tr('调整 idea')}</button>
    <button className="btn" onClick={() => p.go('survey')}>{tr('先看调研')}</button></> }
    : l.status === 'paused' || l.status === 'failed' ? { t: l.status === 'failed' ? tr('流水线出错停下了') : tr('流水线暂停了'), d: l.note ?? l.current?.note ?? l.reason ?? '', btns: <>
      <button className="btn pri" onClick={() => p.onResume(l.id)}>{tr('继续')}</button>
      <button className="btn" onClick={() => p.onAdjust(l.id)}>{tr('调整方向')}</button></> }
      : null;

  const parts: { m: ModId; icon: IconName; t: string; v: string; s?: string }[] = [
    { m: 'survey', icon: 'lens', t: tr('调研'), v: h?.verdict ?? (l.linked?.paper?.title ? tr('本地项目') : '—'), s: h ? tr('最接近 {0} 篇', h.similar?.length ?? 0) : undefined },
    { m: 'code', icon: 'code', t: tr('代码仓库'), v: p.info?.code ? p.info.code.name : tr('暂无'), s: p.info?.code ? [p.info.code.branch, p.info.code.dirty ? tr('{0} 处改动', p.info.code.dirty) : tr('无改动')].filter(Boolean).join(' · ') : undefined },
    { m: 'exp', icon: 'flask', t: tr('实验'), v: exp ? { done: tr('完成'), run: tr('进行中'), wait: tr('等你决定'), todo: tr('还没开始') }[exp.status] : '—', s: exp?.note ? gist(exp.note, 36) : undefined },
    { m: 'paper', icon: 'doc', t: tr('论文'), v: p.info?.paper ? p.info.paper.main ?? p.info.paper.name : tr('暂无'), s: p.info?.paper ? (p.info.paper.pdf ? tr('有 PDF') : tr('还没编译')) : undefined },
  ];

  return (
    <div className="cm-page overview">
      <section className="ov-hero">
        <div className="ov-title">
          <span className="ov-seq">#{l.seq}</span>
          <h2>{l.title}</h2>
          <span className={`pst pst-${l.status}`}>{STATUS[l.status] ?? l.status}</span>
        </div>
        {l.idea && <p className="ov-idea">{gist(l.idea, 140)}</p>}
      </section>

      {ask && (
        <section className="ov-ask">
          <Icon n="bell" size={20} />
          <div><b>{ask.t}</b>{ask.d && <p className="small">{ask.d}</p>}</div>
          <div className="btns">{ask.btns}</div>
        </section>
      )}

      <section className="cs">
        <div className="cs-h">
          <h3>{tr('研究进度')}</h3>
          <span className="muted small">{tr('{0}/{1} 站完成', done, l.stages.length)}</span>
          {!l.linked && (
            <span className="ov-spend small" title={tr('预算')}>
              {tr('已花 {0} / {1}', money(l.spent), money(l.budget))}
              <i className="bar"><i style={{ width: `${Math.min(100, (100 * l.spent) / Math.max(l.budget, 1e-9))}%` }} /></i>
            </span>
          )}
        </div>
        <ol className="ov-steps" style={{ ['--done' as string]: done, ['--n' as string]: l.stages.length }}>
          {l.stages.map((s, i) => (
            <li key={s.key} className={`ov-step s-${s.status}`} style={{ ['--i' as string]: i }} data-ref={`stage:${s.key}`} data-ref-label={`${tr('工序')} ${s.name}`}>
              <button onClick={() => p.go(STAGE_MOD[s.key] ?? 'overview')} title={s.note ?? s.out}>
                <span className="ov-dot">{s.status === 'done' ? '✓' : i + 1}</span>
                <b>{s.name}</b>
                <span className="muted small">{s.status === 'run' ? `${s.pct}%` : s.status === 'wait' ? tr('等你') : '\u00a0'}</span>
              </button>
            </li>
          ))}
        </ol>
      </section>

      <div className="ov-parts">
        {parts.map((x, i) => (
          <button key={x.m} className="ov-part" style={{ ['--i' as string]: i }} onClick={() => p.go(x.m)}>
            <Icon n={x.icon} size={20} />
            <span className="ov-pt">{x.t}</span>
            <b>{x.v}</b>
            {x.s && <span className="muted small">{x.s}</span>}
            <Icon n="right" size={14} className="ov-go" />
          </button>
        ))}
      </div>

      <details className="cs fold">
        <summary><Icon n="table" size={16} />{tr('完整工序明细')}</summary>
        <div className="ov-mill">
          <MillDetail line={l} typeOf={typeOf} real={REAL} tick={p.tick} onOpen={p.onOpen} onHatch={p.onHatch} onResume={p.onResume} onAdjust={p.onAdjust} onAsk={p.onAsk} />
        </div>
      </details>
    </div>
  );
}
