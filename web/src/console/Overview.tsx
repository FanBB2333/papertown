// The overview panel: the project's stages (each opening the panel its work is in: the stage says which), its parts and the
// mill's full sheet folded away underneath. How it is going, deciding and talking to its lead are in 进展.

import { Tooltip } from '@cloudflare/kumo';
import { figures, modelText } from '../emphasis';
import type { Line, WsInfo } from '../api';
import { MillDetail } from '../components/Sheet';
import { StatusTag } from '../components/MillRoom';
import { tr } from '../i18n';
import { follow, href } from '../route';
import { Icon, type IconName } from './icons';
import type { ModId } from './Console';
import { gist } from './util';

interface Props {
  line: Line | null; info: WsInfo | null; tick: number; typeOf: (id: string) => string; go: (m: ModId) => void; onAsk: () => void; onOpen: (id: string) => void;
}

const REAL = tr('工序依次推进：方法设计在造纸厂，代码与实验在仓库和实验农场，写作在印刷厂，最终经质检所出厂。');

export function Overview(p: Props) {
  const l = p.line;
  if (!l) return <div className="cm-page"><p className="muted">{tr('加载中…')}</p></div>;
  const done = l.stages.filter(s => s.status === 'done').length;
  const h = l.outputs?.hatch;
  const exp = l.stages.find(s => s.key === 'exp');

  const brief = `/progress/${l.seq}`;
  const ask = l.lead.state === 'blocked' ? l.lead.note : null;

  const parts: { m: ModId; icon: IconName; t: string; v: string; s?: string }[] = [
    { m: 'survey', icon: 'lens', t: tr('调研'), v: h?.verdict ?? (l.linked?.paper?.title ? tr('本地项目') : '—'), s: h ? tr('最接近 {0} 篇', h.similar?.length ?? 0) : undefined },
    { m: 'code', icon: 'code', t: tr('代码仓库'), v: p.info?.code ? p.info.code.name : tr('暂无'), s: p.info?.code ? [p.info.code.branch, p.info.code.dirty ? tr('{0} 处改动', p.info.code.dirty) : tr('无改动')].filter(Boolean).join(' · ') : undefined },
    { m: 'exp', icon: 'flask', t: tr('实验'), v: exp ? { done: tr('完成'), run: tr('进行中'), todo: tr('尚未开始') }[exp.status] : '—', s: exp?.note ? gist(exp.note, 36) : undefined },
    { m: 'paper', icon: 'doc', t: tr('论文'), v: p.info?.paper ? p.info.paper.main ?? p.info.paper.name : tr('暂无'), s: p.info?.paper ? (p.info.paper.pdf ? tr('有 PDF') : tr('尚未编译')) : undefined },
  ];

  return (
    <div className="cm-page overview">
      <section className="ov-hero">
        <div className="ov-title">
          <span className="ov-seq">#{l.seq}</span>
          <h2>{l.title}</h2>
          <StatusTag status={l.status} />
          <a className="ov-brief small" href={href(brief)} onClick={e => follow(e, brief)} title={tr('进展、卡片和对话')}>{tr('进展中查看')}<Icon n="right" size={12} /></a>
        </div>
        {l.idea && <p className="ov-idea user-words em-bar">{l.idea}</p>}
      </section>

      {ask && (
        <a className="ov-ask" href={href(brief)} onClick={e => follow(e, brief)}>
          <Icon n="bell" size={20} />
          <div className="em-bar" data-tone="warn"><b>{modelText(ask)}</b><p className="small">{tr('在「进展」中决定，也可在此与负责人沟通')}</p></div>
          <Icon n="right" size={16} />
        </a>
      )}

      <section className="cs">
        <div className="cs-h">
          <span className="cs-ic"><Icon n="branch" size={15} /></span><h3>{tr('研究进度')}</h3>
          <span className="muted small">{figures(tr('{0}/{1} 站完成', done, l.stages.length))}</span>
        </div>
        <ol className="ov-steps" style={{ ['--done' as string]: done, ['--n' as string]: l.stages.length }}>
          {l.stages.map((s, i) => (
            <li key={s.key} className={`ov-step s-${s.status}`} style={{ ['--i' as string]: i }} data-ref={`stage:${s.key}`} data-ref-label={`${tr('工序')} ${s.name}`}>
              <Tooltip content={<span className="research-tip">{s.note ? modelText(s.note) : s.out}</span>} disabled={!s.note && !s.out} render={<button onClick={() => p.go(s.mod as ModId)} />}>
                <span className="ov-dot">{s.status === 'done' ? '✓' : i + 1}</span>
                <b>{s.name}</b>
                <span className={s.status === 'run' ? 'em-num small' : 'muted small'}>{s.status === 'run' ? `${s.pct}%` : '\u00a0'}</span>
              </Tooltip>
            </li>
          ))}
        </ol>
      </section>

      <div className="ov-parts">
        {parts.map((x, i) => (
          <button key={x.m} className="ov-part" style={{ ['--i' as string]: i }} onClick={() => p.go(x.m)}>
            <Icon n={x.icon} size={20} />
            <span className="ov-pt">{x.t}</span>
            <b>{x.m === 'survey' && h?.verdict ? <span className="em-tag ov-tag" data-tone={({ [tr('可孵化')]: 'good', [tr('已被做过')]: 'bad' } as Record<string, string>)[h.verdict] ?? 'warn'}>{x.v}</span> : x.v}</b>
            {x.s && <span className="muted small">{modelText(x.s)}</span>}
            <Icon n="right" size={14} className="ov-go" />
          </button>
        ))}
      </div>

      <details className="cs fold">
        <summary><Icon n="table" size={16} />{tr('完整工序明细')}</summary>
        <div className="ov-mill">
          <MillDetail line={l} typeOf={p.typeOf} real={REAL} tick={p.tick} onOpen={p.onOpen} onAsk={p.onAsk} />
        </div>
      </details>
    </div>
  );
}
