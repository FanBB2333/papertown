// Beside the research loop (Canvas.tsx): the open node as an inspector with a few tabs, and the form for a new node.
// A gate has its policy and its rules before → after, with where they still fail, the curve of its rounds and its
// rules' settings; a check its result, history and settings; a task its brief (to edit, send, send back) and its
// log; the spec and the clamp the work boundaries behind them; the human gate what waits for you; every node the
// list of what it is wired to.

import { useMemo, useState } from 'react';
import { api, type CanvasEdge, type CanvasNode, type CanvasView, type Check, type NewNode, type ProjectCard, type TaskLog, type TaskStatus, type TaskTo } from '../api';
import { AGENT_STATUS } from '../components/MillRoom';
import { Select } from '../components/Select';
import { Icon } from '../console/icons';
import { ago } from '../console/util';
import { tr, trx } from '../i18n';
import { follow, href } from '../route';
import { INFO_MOD, InfoBody, infoKind, InfoState } from './CanvasInfo';
import { CheckHistory, CheckResult, CheckSettings, ST, STAGE, status, type Act } from './Checks';
import { bad, gateChecks, gateLook, GATE_ST, level, LEVEL, over, ROLE, VERDICT } from './loop';
import type { ConsoleTarget } from './Project';
import { NodeConversation } from './NodeConversation';

export type Kind = NewNode['kind'];
export interface Draft { kind: Kind; x: number; y: number; link: string | null; seed?: { title?: string; text?: string; to?: TaskTo } }

export const TASK: Record<TaskStatus, string> = { draft: tr('还没发'), sent: tr('在做'), done: tr('完成'), blocked: tr('卡住了') };
export const WHO: Record<TaskTo, string> = { lead: tr('项目负责人'), coder: tr('代码员工'), writer: tr('写作员工') };
export const KIND: Record<Kind, string> = { task: tr('派任务'), soft: tr('软检查'), hard: tr('硬检查'), note: tr('备注') };
const LOG: Record<TaskLog['kind'], string> = {
  bound: tr('绑定了 Paseo 会话'),
  made: tr('建了这个任务'), sent: tr('发出'), resent: tr('改了再发'), done: tr('交回：完成'), blocked: tr('交回：卡住了'), back: tr('退回重做'),
  marked: tr('标成完成'), reopened: tr('重新打开'), round: tr('又打回一轮'), escalated: tr('交给你拍板'), converged: tr('卡口放行，收敛'),
};
export const clip = (s: string | undefined, n: number) => { const t = (s ?? '').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
export const label = (n: CanvasNode) => (n.kind === 'note' ? clip(n.text, 26) : n.kind === 'hard' || n.kind === 'soft' ? trx(n.title ?? '')
  : n.kind === 'gate' ? tr('{0}硬卡口', n.title ?? '') : trx(n.title ?? ''));
const mine = (n: CanvasNode) => n.kind === 'task' || n.kind === 'note' || !!n.check?.custom;
export const neighbours = (n: CanvasNode, v: CanvasView) => v.edges.flatMap(e => {
  if (e.source !== n.id && e.target !== n.id) return [];
  const o = v.nodes.find(x => x.id === (e.source === n.id ? e.target : e.source));
  return o ? [{ e, o }] : [];
});

export function Mark({ n }: { n: CanvasNode }) {
  if (n.check) return <i className={`cg-shape k-${n.check.kind} s-${n.check.on ? status(n.check) : 'none'}`} />;
  if (n.gate) return <i className={`cv-dia g-${gateLook(n.gate)}`} />;
  if (n.kind === 'spec') return <i className="cv-spdot" />;
  if (n.kind === 'clamp') return <i className="cv-cldot" />;
  if (n.kind === 'human') return <i className="cv-hudot" />;
  if (n.kind === 'stage') return <i className={`cg-dot mini st-${n.status}`} />;
  if (n.kind === 'info') return <i className="cv-idot" />;
  return <i className={n.kind === 'task' ? `cv-tdot t-${n.status}` : 'cv-ndot'} />;
}

function Pill({ n }: { n: CanvasNode }) {
  if (n.check?.kind === 'soft') return <span className={`cg-pill s-${n.check.on ? status(n.check) : 'none'}`}>{n.check.on ? VERDICT[status(n.check)] : tr('已关闭')}</span>;
  if (n.check) {
    const lv = level(n.check);
    return <span className={`cg-pill g-${lv}`}>{lv === 'off' ? tr('已关闭') : lv === 'pass' ? tr('放行') : lv === 'none' ? ST.none : LEVEL[lv]}</span>;
  }
  if (n.gate) {
    const look = gateLook(n.gate);
    return <span className={`cg-pill g-${look}`}>{look === 'block' && <Icon n="lock" size={11} />}{n.gate.waived && n.gate.state === 'block' ? tr('已放行') : GATE_ST[look]}</span>;
  }
  if (n.kind === 'human' && n.items?.length) return <span className="cg-pill g-warn">{tr('{0} 待定', n.items.length)}</span>;
  if (n.kind === 'task' && n.converged) return <span className="cg-pill t-done">{tr('已收敛')}</span>;
  if (n.kind === 'task' && n.escalated) return <span className="cg-pill g-warn">{tr('等你拍板')}</span>;
  if (n.kind === 'stage') return <span className={`cg-pill st-${n.status}`}>{n.status === 'run' ? `${STAGE.run} · ${n.pct ?? 0}%` : STAGE[n.status ?? 'todo']}</span>;
  if (n.kind === 'task') return <span className={`cg-pill t-${n.status}`}>{TASK[(n.status ?? 'draft') as TaskStatus]}</span>;
  return null;
}

const about = (n: CanvasNode) => {
  const c = n.check;
  if (c) return [c.kind === 'hard' ? tr('硬检查 · HARD') : tr('软巡检 · SOFT SENTINEL'), c.prio, c.rule && trx(c.rule), c.kind === 'soft' && tr('每 {0} 小时复查', c.every ?? 24)].filter(Boolean).join(' · ');
  if (n.gate) return [n.gate.checks.length > 1 ? tr('硬卡口组') : tr('硬卡口'), 'HARD GATE', tr('{0} 条规则', n.gate.checks.length)].join(' · ');
  if (n.kind === 'task') return `${n.loop === 'hard' ? tr('硬打回修补单') : n.loop === 'soft' ? tr('软纠偏任务单') : tr('派给 agent 的任务')} · ${n.id}`;
  return { note: tr('备注'), info: tr('资料卡 · 实时显示项目的这部分'), spec: tr('软限制规范 · SOFT SPEC · Prompt 引导'), clamp: tr('硬边界夹 · HARD CLAMP · 代码拦截'),
    human: tr('人类拍板节点 · HUMAN GATE'), stage: tr('工序工位站 · STAGE') }[n.kind as string] ?? '';
};

export function Inspector({ n, v, r, line, wide, onWide, busy, act, onConsole, onPick, onCut, onNew, onFix, onDup, onDrop, onClose }: {
  n: CanvasNode; v: CanvasView; r: ProjectCard; line: { id: string; seq: number }; wide: boolean; onWide: () => void; busy: boolean; act: Act;
  onConsole: (lineId: string, t?: ConsoleTarget) => void; onPick: (id: string) => void; onCut: (edgeId: string) => void;
  onNew: (k: Kind) => void; onFix: () => void; onDup: () => void; onDrop: () => void; onClose: () => void;
}) {
  const [tab, setTab] = useState('main');
  const near = useMemo(() => neighbours(n, v), [n, v]);
  const tabs: [string, string][] = n.check
    ? [['main', tr('结果')], ['hist', n.check.history.length ? tr('历史 {0}', n.check.history.length) : tr('历史')], ['set', tr('设置')]]
    : n.gate ? [['main', tr('门禁与前后对比')], ['curve', tr('收敛曲线')], ['set', tr('代码规则设置')]]
      : n.kind === 'task' ? [['main', tr('任务')], ['chat', tr('对话')], ['log', tr('记录 {0}', n.log?.length ?? 0)]]
        : [['main', n.kind === 'note' ? tr('备注') : n.kind === 'stage' ? tr('工序') : tr('详情')]];
  tabs.push(['links', near.length ? tr('连着 {0}', near.length) : tr('连线')]);
  return (
    <aside className={`cv-side${wide ? ' wide' : ''}`}>
      <header className="cv-side-h">
        <div className="cv-side-t">
          <small><Mark n={n} />{about(n)}</small>
          <h3 title={label(n)}>{label(n)}</h3>
        </div>
        {n.kind === 'info' ? <InfoState n={n} r={r} v={v} /> : <Pill n={n} />}
        <button className="ib" title={wide ? tr('收窄') : tr('展开')} aria-pressed={wide} onClick={onWide}><Icon n={wide ? 'right' : 'left'} size={15} /></button>
        <button className="ib" title={tr('收起（Esc）')} aria-label={tr('收起')} onClick={onClose}><Icon n="close" size={15} /></button>
      </header>
      <nav className="cv-tabs" role="tablist">
        {tabs.map(([k, t]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{t}</button>)}
      </nav>
      <div className="cv-side-b" role="tabpanel">
        {tab === 'links' ? <Links near={near} busy={busy} onPick={onPick} onCut={onCut} onNew={onNew} />
          : n.gate ? (
            tab === 'curve' ? <GateCurve n={n} v={v} />
              : tab === 'set' ? <GateSettings n={n} v={v} busy={busy} act={act} lineId={line.id} />
                : <GateDetail n={n} v={v} busy={busy} act={act} lineId={line.id} onConsole={onConsole} onPick={onPick} />
          ) : n.kind === 'spec' || n.kind === 'clamp' ? <BoundsDetail n={n} onRules={() => onConsole(line.id, { mod: 'rules' })} />
          : n.kind === 'human' ? <HumanDetail n={n} v={v} busy={busy} act={act} line={line} onPick={onPick} />
          : n.check ? (
            tab === 'hist' ? <CheckHistory c={n.check} />
              : tab === 'set' ? <CheckSettings key={n.id} c={n.check} busy={busy} act={act} lineId={line.id} />
                : <CheckResult c={n.check} lead={v.lead} busy={busy} act={act} lineId={line.id} onConsole={onConsole} onFix={onFix} />
          ) : n.kind === 'task' ? (
            tab === 'chat' ? <NodeConversation key={n.id} node={n} lineId={line.id} busy={busy} act={act} />
              : tab === 'log' ? <TaskLogList log={n.log ?? []} />
                : <TaskDetail key={n.id} n={n} v={v} busy={busy} act={act} line={line} onAgents={() => onConsole(line.id, { mod: 'agents' })} onChat={() => setTab('chat')} onPick={onPick} />
          ) : n.kind === 'info' ? <InfoDetail n={n} v={v} r={r} line={line} onConsole={onConsole} onPick={onPick} />
            : n.kind === 'note' ? <NoteDetail key={n.id} n={n} busy={busy} act={act} lineId={line.id} />
            : <StageDetail n={n} near={near.map(x => x.o)} onPick={onPick} />}
      </div>
      <footer className="cv-side-f">
        {n.gate && <button className="btn pri" disabled={busy} onClick={() => act(() => api.runChecks(line.id), tr('查完了'))}><Icon n="refresh" size={13} />{tr('跑一遍代码硬检查')}</button>}
        {n.gate && n.gate.checks.length > 1 && (
          <button className="btn" disabled={busy} onClick={() => act(() => api.gateAct(line.id, n.gate!.stage, n.gate!.open ? 'close' : 'open'))}>
            {n.gate.open ? tr('收回卡口组') : tr('展开为 {0} 个独立节点', n.gate.checks.length)}
          </button>
        )}
        {(n.kind === 'task' || n.kind === 'note') && <button className="btn" disabled={busy} onClick={onDup}><Icon n="copy" size={13} />{tr('复制一个')}</button>}
        <button className="btn cv-danger" disabled={busy} onClick={onDrop} title={n.check && !n.check.custom ? tr('拿掉后这项检查也不再查，可以在「更多」里放回来') : ''}>
          {mine(n) ? tr('删掉') : tr('从回路上拿掉')}
        </button>
      </footer>
    </aside>
  );
}

// ---------- a gate ----------

const ruleNo = (rule: string) => trx(rule).replace(/^lastcheck\s*/, '');
const levelText = (c: Check) => { const lv = level(c); return lv === 'pass' ? tr('放行 ✓') : lv === 'off' ? tr('已关闭') : lv === 'none' ? tr('还没查') : lv === 'block' ? tr('阻断 ✗') : tr('告警 !'); };

// the gate's policy, its rules from the first round to now, and where they still fail
function GateDetail({ n, v, busy, act, lineId, onConsole, onPick }: {
  n: CanvasNode; v: CanvasView; busy: boolean; act: Act; lineId: string; onConsole: (lineId: string, t?: ConsoleTarget) => void; onPick: (id: string) => void;
}) {
  const g = n.gate!, cs = gateChecks(v, g), look = gateLook(g), who = v.nodes.find(x => x.id === g.ticket);
  const to: TaskTo = ({ exp: 'coder', write: 'writer', review: 'writer', ship: 'writer' } as Record<string, TaskTo>)[g.stage] ?? 'lead';
  const failing = cs.filter(bad).sort((a, b) => (a.gate === 'block' ? 0 : 1) - (b.gate === 'block' ? 0 : 1));
  const open = (c: Check, f: { file: string; line: number; hit: string }) => {
    if (c.id === 'results') onConsole(lineId, { job: f.hit });
    else if (f.file) onConsole(lineId, { file: `paper:${f.file}${f.line ? `:${f.line}` : ''}` });
  };
  const policy = (b: { auto?: boolean; rounds?: number }) => act(() => api.setLoop(lineId, g.stage, b), tr('保存了'));
  return (
    <>
      <div className={`gp-card g-${look}`}>
        <h5>{tr('回路控制策略（In-Loop Gate Policy）')}</h5>
        <p>{g.locks ? tr('阻断级的规则没清零时：锁住「{0}」的入口，把没过的地方写成修补单打回给{1}，它改完跑 pt checks run。', g.locks, ROLE[to])
          : tr('阻断级的规则没清零时：把没过的地方写成修补单打回给{0}，它改完跑 pt checks run。', ROLE[to])}</p>
        <div className="gp-ctl">
          <label className="field">{tr('修补单')}
            <Select value={g.policy.auto ? 'auto' : 'hold'} disabled={busy} onChange={x => policy({ auto: x === 'auto' })}
              options={[{ value: 'auto', label: tr('写好就自动发出') }, { value: 'hold', label: tr('先放着，我看过再发') }]} />
          </label>
          <label className="field">{tr('最多自动打回')}
            <Select value={g.policy.rounds} disabled={busy} onChange={x => policy({ rounds: x })} options={[1, 2, 3, 4, 5, 6, 8, 10].map(k => ({ value: k, label: tr('{0} 轮', k) }))} />
          </label>
        </div>
        <small>{g.ticket ? tr('当前第 {0} 轮（修补单 {1}），超过 {2} 轮升级到「人类拍板节点」', g.round, g.ticket, g.policy.rounds) : tr('超过 {0} 轮还没清零，升级到「人类拍板节点」等你决定', g.policy.rounds)}</small>
        {g.waived && <p className="small">{tr('你已经决定先放行：它不再锁住下一道工序、不再打回，等规则都过了自动恢复。')}</p>}
        {g.state === 'block' && (
          <div className="cv-row">
            <button className="btn pri" disabled={busy} onClick={() => act(() => api.gateAct(lineId, g.stage, 'rework'), tr('修补单发出去了'))}>
              <Icon n="refresh" size={13} />{g.ticket && g.ticket_status !== 'done' ? tr('把修补单发给{0}', ROLE[to]) : tr('写修补单并发给{0}', ROLE[to])}
            </button>
            {g.escalated && <button className="btn" disabled={busy} onClick={() => act(() => api.gateAct(lineId, g.stage, 'more'), tr('再打回两轮'))}>{tr('再给两轮')}</button>}
            {!g.waived && <button className="btn" disabled={busy} onClick={() => act(() => api.gateAct(lineId, g.stage, 'waive'), tr('先放行了'))}>{tr('先放行')}</button>}
          </div>
        )}
      </div>

      <section className="cv-sec">
        <h5>{tr('Before → After 轮次收敛表')}<span> · {tr('可以直接写进进展汇报')}</span></h5>
        <table className="gp-tab">
          <thead><tr><th>{tr('规则项')}</th><th>R1</th><th>{tr('现在')}</th><th>{tr('门禁')}</th></tr></thead>
          <tbody>
            {cs.map(c => (
              <tr key={c.id} className={`l-${level(c)}`}>
                <td><button className="lnk" onClick={() => onPick(`check:${c.id}`)} disabled={!v.nodes.some(x => x.id === `check:${c.id}`)}>{ruleNo(c.rule)} {trx(c.title)}</button></td>
                <td>{c.first?.value ?? '—'}</td>
                <td><b>{c.last?.value ?? '—'}</b></td>
                <td><span className={`gp-st l-${level(c)}`}>{c.prio} · {levelText(c)}</span></td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td>{tr('超出允许的合计')}</td><td>{g.before}</td><td><b>{g.now}</b></td><td>{g.pass}/{g.total} {tr('过')}</td></tr></tfoot>
        </table>
      </section>

      {failing.length > 0 && (
        <section className="cv-sec">
          <h5>{tr('剩余未过定位')}<span> · {tr('点位置跳到中控屏里的源码')}</span></h5>
          {failing.flatMap(c => (c.last?.findings ?? []).slice(0, 6).map((f, i) => (
            <div key={`${c.id}:${i}`} className={`gp-find l-${level(c)}`}>
              <header>
                <em>{c.prio} · {ruleNo(c.rule)} {trx(c.title)}</em>
                {(f.file || c.id === 'results') && <button className="lnk cg-at" onClick={() => open(c, f)}>{f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : f.hit} ↗</button>}
              </header>
              {f.text && <p className="gp-src">{f.text}</p>}
              {f.hint && <p className="muted">{tr('建议：{0}', trx(f.hint))}</p>}
              {who && who.status !== 'done' && <p className="gp-tk">↳ {tr('已写进修补单 {0}，{1}{2}', who.id, WHO[who.to ?? 'lead'], who.status === 'sent' ? tr('正在改') : TASK[(who.status ?? 'draft') as TaskStatus])}</p>}
            </div>
          )))}
          {failing.some(c => (c.last?.total ?? 0) > 6) && <p className="small muted">{tr('每条规则只列前 6 处，展开卡口后在每条规则的「结果」里看全部。')}</p>}
        </section>
      )}
    </>
  );
}

// how much the gate still finds after each round that changed something
function GateCurve({ n, v }: { n: CanvasNode; v: CanvasView }) {
  const cs = gateChecks(v, n.gate!).filter(c => c.on);
  const pts = useMemo(() => {
    const ev = cs.flatMap(c => c.history.map(h => ({ ...h, c }))).sort((a, b) => a.ts.localeCompare(b.ts));
    const now = new Map<string, number>(), out: { ts: string; n: number }[] = [];
    for (const e of ev) {
      now.set(e.c.id, ['fail', 'warn'].includes(e.status) ? over(e.c, e.value) : 0);
      const total = [...now.values()].reduce((a, b) => a + b, 0);
      if (out.length && out[out.length - 1].ts === e.ts) out[out.length - 1].n = total; else out.push({ ts: e.ts, n: total });
    }
    return out.filter((p, i) => i === 0 || p.n !== out[i - 1].n);
  }, [cs]);
  if (!pts.length) return <p className="small muted">{tr('还没有记录：规则查过以后，每一轮的结果都画在这里')}</p>;
  const W = 340, H = 140, top = Math.max(...pts.map(p => p.n), 1);
  const x = (i: number) => (pts.length === 1 ? W / 2 : 24 + (i * (W - 40)) / (pts.length - 1)), y = (k: number) => H - 22 - (k / top) * (H - 40);
  return (
    <>
      <svg className="gp-curve" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={tr('收敛曲线')}>
        <line className="ax" x1={16} x2={W - 8} y1={y(0)} y2={y(0)} />
        {pts.length > 1 && <polyline points={pts.map((p, i) => `${x(i)},${y(p.n)}`).join(' ')} />}
        {pts.map((p, i) => (
          <g key={i}>
            <circle cx={x(i)} cy={y(p.n)} r={4} className={p.n ? 'bad' : 'ok'}><title>{`R${i + 1} · ${ago(p.ts)} · ${p.n}`}</title></circle>
            <text x={x(i)} y={y(p.n) - 9} textAnchor="middle">{p.n}</text>
            <text className="r" x={x(i)} y={H - 6} textAnchor="middle">R{i + 1}</text>
          </g>
        ))}
      </svg>
      <ul className="cg-rounds">
        {[...pts].reverse().map((p, i) => <li key={i}><b>R{pts.length - i}</b><span>{tr('{0} 处', p.n)}</span><small className="muted">{ago(p.ts)}</small></li>)}
      </ul>
      <p className="small muted">{tr('每个点是规则结果有变化的一轮：这道卡口所有没过的规则超出允许的处数之和。')}</p>
    </>
  );
}

// each rule of the gate: on or off, blocks or only warns, what it allows
function GateSettings({ n, v, busy, act, lineId }: { n: CanvasNode; v: CanvasView; busy: boolean; act: Act; lineId: string }) {
  const cs = gateChecks(v, n.gate!);
  return (
    <div className="gp-rules">
      {cs.map(c => (
        <details key={c.id} className={`l-${level(c)}`}>
          <summary><i className={`cv-dia g-${level(c)}`} /><span>{ruleNo(c.rule)} {trx(c.title)}</span><small>{c.prio} · {c.gate === 'block' ? tr('阻断') : tr('告警')}{c.on ? '' : ` · ${tr('已关闭')}`}</small></summary>
          <p className="small muted">{trx(c.text)}</p>
          <CheckSettings key={`${c.id}:${c.gate}:${c.max}`} c={c} busy={busy} act={act} lineId={lineId} />
        </details>
      ))}
    </div>
  );
}

// ---------- the spec, the clamp, the human gate ----------

const BOUND: Record<string, string> = { must: tr('必须完成'), never: tr('不能做'), ask: tr('先问你') };
const FROM: Record<string, string> = { global: tr('全局'), project: tr('项目'), lead: tr('负责人'), coder: tr('代码员工'), writer: tr('写作员工') };

function BoundsDetail({ n, onRules }: { n: CanvasNode; onRules: () => void }) {
  const rules = n.rules ?? [], spec = n.kind === 'spec', b = n.budget;
  return (
    <>
      <p className="cg-what">{spec
        ? tr('写进每个 agent 的 AGENTS.md 和项目简报，作为上下文引导它们生成。模型是概率生成的，这些要求只能引导方向，执行得怎样由下游的硬卡口和软巡检验证。')
        : tr('绑定了动作的工作边界：不靠模型自觉，Papertown 的服务端直接拦下（不能做），或者停下来先问你（先问你）。')}</p>
      {rules.length ? (
        <ul className="gp-bounds">
          {rules.map(r => (
            <li key={r.id}><em className={`gp-bk k-${r.kind}`}>{BOUND[r.kind]}</em><span>{r.text}</span><small className="muted">{FROM[r.from] ?? r.from}{r.action ? ` · ${r.action}` : ''}</small></li>
          ))}
        </ul>
      ) : <p className="small muted">{spec ? tr('工作边界里还没有写给 agent 的要求：它们只按项目简报做。') : tr('还没有绑定动作的边界：Papertown 不拦任何动作。')}</p>}
      {!spec && b && b.budget > 0 && <p className="small">{tr('单线预算 ${0}，已用 ${1}', b.budget, Math.round(b.spent * 100) / 100)}</p>}
      <div className="cv-row"><button className="btn" onClick={onRules}><Icon n="shield" size={13} />{tr('在中控屏里改工作边界')}</button></div>
    </>
  );
}

function HumanDetail({ n, v, busy, act, line, onPick }: { n: CanvasNode; v: CanvasView; busy: boolean; act: Act; line: { id: string; seq: number }; onPick: (id: string) => void }) {
  const items = n.items ?? [], ask = `/progress/${line.seq}/ask`, home = `/progress/${line.seq}`;
  return (
    <>
      <p className="cg-what">{tr('软硬检测的异常最后升级到这里：超过轮数还没清零的硬卡口、卡住的任务、判为偏离的软巡检、agent 问你的问题。')}</p>
      {!items.length && <p className="small muted">{tr('现在没有等你拍板的事。')}</p>}
      <ul className="gp-human">
        {items.map(x => (
          <li key={`${x.kind}:${x.id}`} className={`k-${x.kind}`}>
            <p>{x.text}</p>
            <div className="cv-row">
              {x.kind === 'escalated' && x.gate && <>
                <button className="btn pri" disabled={busy} onClick={() => act(() => api.gateAct(line.id, x.gate!, 'more'), tr('再打回两轮'))}>{tr('再给两轮')}</button>
                <button className="btn" disabled={busy} onClick={() => act(() => api.gateAct(line.id, x.gate!, 'waive'), tr('先放行了'))}>{tr('先放行')}</button>
                <button className="lnk" onClick={() => onPick(`gate:${x.gate}`)}>{tr('看卡口')}</button>
              </>}
              {(x.kind === 'blocked' || x.kind === 'fail') && <button className="lnk" onClick={() => onPick(x.id)}>{x.kind === 'blocked' ? tr('看任务') : tr('看巡检')}</button>}
              {x.kind === 'ask' && <a className="lnk" href={href(ask)} onClick={e => follow(e, ask)}>{tr('去回答')}</a>}
              {x.kind === 'line' && <a className="lnk" href={href(home)} onClick={e => follow(e, home)}>{tr('回项目页处理')}</a>}
            </div>
          </li>
        ))}
      </ul>
      {v.nodes.some(x => x.kind === 'gate' && x.gate?.waived) && <p className="small muted">{tr('先放行的卡口：{0}', v.nodes.filter(x => x.gate?.waived).map(x => x.gate!.name).join('、'))}</p>}
    </>
  );
}

// an info card in full, and the way to where its data lives
function InfoDetail({ n, v, r, line, onConsole, onPick }: {
  n: CanvasNode; v: CanvasView; r: ProjectCard; line: { id: string; seq: number }; onConsole: (lineId: string, t?: ConsoleTarget) => void; onPick: (id: string) => void;
}) {
  const k = infoKind(n), ask = `/progress/${line.seq}/ask`;
  return (
    <>
      <div className="cv-info full"><InfoBody n={n} r={r} v={v} full onPick={onPick} /></div>
      <div className="cv-row">
        {n.ref === 'agent:lead'
          ? <a className="btn" href={href(ask)} onClick={e => follow(e, ask)}><Icon n="chat" size={13} />{tr('打开对话')}</a>
          : <button className="btn" onClick={() => onConsole(line.id, { mod: INFO_MOD[k] })}><Icon n="board" size={13} />{tr('在中控屏里打开')}</button>}
      </div>
      <p className="small muted">{tr('资料卡跟着项目自动更新。把任务连到它上面，agent 会知道这件事和项目的这部分有关。')}</p>
    </>
  );
}

function StageDetail({ n, near, onPick }: { n: CanvasNode; near: CanvasNode[]; onPick: (id: string) => void }) {
  const checks = near.filter(o => o.check || o.gate), tasks = near.filter(o => o.kind === 'task');
  const on = near.filter(o => o.check?.on), pass = on.filter(o => status(o.check!) === 'pass').length;
  const pct = n.status === 'done' ? 100 : n.status === 'run' ? n.pct ?? 0 : 0;
  const row = (o: CanvasNode) => (
    <li key={o.id}><button className="cv-link" onClick={() => onPick(o.id)}><Mark n={o} /><span>{label(o)}</span><Pill n={o} /></button></li>
  );
  return (
    <>
      <div className={`cg-meter st-${n.status}`}>
        <p><b>{pct}%</b><span>{STAGE[n.status ?? 'todo']}</span>{on.length > 0 && <small>{tr('连着的检查 {0}/{1} 通过', pass, on.length)}</small>}</p>
        <div className="cg-bar"><i style={{ width: `${pct}%` }} /></div>
      </div>
      {n.locked && <div className="gp-card g-block"><p>{tr('被「{0}」的硬卡口锁住：它的阻断级规则清零或你先放行之后才往下走。', trx(n.locked.title))}</p>
        <button className="lnk" onClick={() => onPick(`gate:${n.locked!.gate}`)}>{tr('看这道卡口')}</button></div>}
      {checks.length > 0 && <section className="cv-sec"><h5>{tr('连着的卡口和巡检')}</h5><ul className="cv-links">{checks.map(row)}</ul></section>}
      {tasks.length > 0 && <section className="cv-sec"><h5>{tr('连着的任务')}</h5><ul className="cv-links">{tasks.map(row)}</ul></section>}
      <p className="small muted">{tr('软巡检盯着哪道工序，就从项目走到那道工序开始问负责人，不连工序的一直会问。')}</p>
    </>
  );
}

function TaskDetail({ n, v, busy, act, line, onAgents, onChat, onPick }: {
  n: CanvasNode; v: CanvasView; busy: boolean; act: Act; line: { id: string; seq: number }; onAgents: () => void; onChat: () => void; onPick: (id: string) => void;
}) {
  const [title, setTitle] = useState(n.title ?? '');
  const [text, setText] = useState(n.text ?? '');
  const [to, setTo] = useState<TaskTo>(n.to ?? 'lead');
  const [back, setBack] = useState<string | null>(null);
  const st = (n.status ?? 'draft') as TaskStatus, who = n.agent_id ? { there: !!n.agent?.started, status: n.agent?.status } : v.agents[to], ask = `/progress/${line.seq}/ask`;
  const dirty = title.trim() !== (n.title ?? '') || text.trim() !== (n.text ?? '') || to !== n.to;
  const save = () => api.setNode(line.id, n.id, { title: title.trim(), text: text.trim(), to });
  const send = () => act(async () => { if (dirty) await save(); return api.sendNode(line.id, n.id); }, tr('发给{0}了', WHO[to]));
  const returned = (st === 'done' || st === 'blocked') && !!n.result;
  const gate = n.loop === 'hard' ? v.nodes.find(x => x.id === `gate:${n.stage}`) : null, from = n.loop === 'soft' ? v.nodes.find(x => x.id === `check:${n.from}`) : null;
  return (
    <>
      {n.loop === 'hard' && (
        <div className={`gp-card g-${n.converged ? 'pass' : 'block'}`}>
          <p>{n.converged ? tr('「{0}」硬卡口已经放行：{1} 轮收敛。', gate?.gate?.name ?? n.stage ?? '', n.round || 1)
            : tr('「{0}」硬卡口阻断时 Papertown 自动写的修补单，现在是第 {1} 轮。做完后卡口还没放行，会再打回一轮。', gate?.gate?.name ?? n.stage ?? '', n.round || 1)}</p>
          {(n.trail?.length ?? 0) > 0 && <p className="gp-trail">{tr('收敛进度：{0}', (n.trail ?? []).map(x => tr('{0} 处', x)).join(' → '))}</p>}
          {gate && <button className="lnk" onClick={() => onPick(gate.id)}>{tr('看这道卡口')}</button>}
        </div>
      )}
      {n.loop === 'soft' && from && (
        <p className="small muted">{tr('由软巡检「{0}」派出的纠偏任务，做完后连着的工序会被重新审视。', label(from))} <button className="lnk" onClick={() => onPick(from.id)}>{tr('看这项巡检')}</button></p>
      )}
      <p className="cv-agent">
        <span className={`dot s-${who.there ? who.status : 'stopped'}`} />
        <b>{n.agent_id ? `${WHO[to]} · ${n.id}` : WHO[to]}</b>
        <span className="muted">{who.there ? AGENT_STATUS[who.status ?? ''] ?? who.status : tr('还没启动')}{st === 'sent' && n.sent_at ? ` · ${tr('{0}发出', ago(n.sent_at))}` : ''}</span>
        {n.agent_id || n.agent?.runtime === 'paseo' ? <button className="lnk" onClick={onChat}>{tr('打开对话')}</button>
          : !who.there ? <>
            {st === 'draft' && <button className="lnk" onClick={onChat}>{tr('安排独立 Agent')}</button>}
            <button className="lnk" onClick={onAgents}>{tr('去启动')}</button>
          </>
          : to === 'lead' ? <a className="lnk" href={href(ask)} onClick={e => follow(e, ask)}>{tr('打开对话')}</a>
            : <button className="lnk" onClick={onAgents}>{tr('打开对话')}</button>}
      </p>
      {returned && (
        <blockquote className={`cg-verdict ${st === 'done' ? 's-pass' : 's-fail'}`}>
          <p>{n.result}</p>
          <footer className="small muted">{trx(n.by ?? '')}{n.done_at ? ` · ${ago(n.done_at)}` : ''}</footer>
        </blockquote>
      )}
      {returned && (back === null ? (
        <div className="cv-row">
          <button className="btn" disabled={busy || !who.there} onClick={() => setBack('')}><Icon n="quote" size={13} />{st === 'done' ? tr('退回重做') : tr('回复它，让它继续')}</button>
          {st === 'blocked' && <button className="btn" disabled={busy} onClick={() => act(() => api.setNode(line.id, n.id, { status: 'done' }))}>{tr('标成完成')}</button>}
          <button className="btn" disabled={busy} onClick={() => act(() => api.setNode(line.id, n.id, { status: 'draft' }))}>{tr('重新打开')}</button>
        </div>
      ) : (
        <div className="cv-form">
          <textarea autoFocus rows={3} value={back} maxLength={4000} placeholder={st === 'done' ? tr('哪里不行、要怎么改') : tr('回答它卡住的地方')} onChange={e => setBack(e.target.value)} />
          <div className="cv-row">
            <button className="btn pri" disabled={busy || !back.trim()} onClick={() => act(() => api.backNode(line.id, n.id, back.trim()), tr('发回去了')).then(() => setBack(null))}>
              <Icon n="send" size={13} />{tr('发回去')}
            </button>
            <button className="btn" onClick={() => setBack(null)}>{tr('取消')}</button>
          </div>
        </div>
      ))}
      <div className={`cv-form${returned ? ' cv-sec' : ''}`}>
        <label className="field">{tr('交给谁')}
          <div className="seg" role="radiogroup" aria-label={tr('交给谁')}>
            {(['lead', 'coder', 'writer'] as const).map(k => (
              <button key={k} type="button" role="radio" aria-checked={to === k} disabled={(st === 'sent' || !!n.agent_id) && k !== n.to} className={to === k ? 'on' : ''} onClick={() => setTo(k)}
                title={st === 'sent' && k !== n.to ? tr('已经发出去了，要换人先重新打开它') : ''}>{WHO[k]}</button>
            ))}
          </div>
        </label>
        <label className="field">{tr('名字')}<input value={title} maxLength={60} onChange={e => setTitle(e.target.value)} /></label>
        <label className="field">{tr('要它做什么')}
          <textarea rows={wideRows(text)} value={text} maxLength={4000} placeholder={tr('写清楚要做的事和做到什么算完成，它会连同这个节点连着的检查、工序一起收到')} onChange={e => setText(e.target.value)} />
        </label>
      </div>
      <div className="cv-row">
        <button className={`btn${returned && !dirty ? '' : ' pri'}`} disabled={busy || !who.there || !title.trim()} onClick={send}>
          <Icon n="send" size={13} />{st === 'draft' ? tr('发给{0}', WHO[to]) : dirty ? tr('改了，再发一次') : tr('再发一次')}
        </button>
        {dirty && <button className="btn" disabled={busy || !title.trim()} onClick={() => act(save, tr('保存了'))}>{tr('只保存')}</button>}
        {st === 'sent' && <button className="btn" disabled={busy} onClick={() => act(() => api.setNode(line.id, n.id, { status: 'done' }))}>{tr('标成完成')}</button>}
      </div>
      <p className="small muted">{tr('它做完会用 pt task {0} done 回一句结果，卡住了回 blocked。这句话也会成为一条汇报。', n.id)}</p>
    </>
  );
}
const wideRows = (text: string) => Math.min(14, Math.max(5, text.split('\n').length + 1));

function TaskLogList({ log }: { log: TaskLog[] }) {
  if (!log.length) return <p className="small muted">{tr('还没有记录')}</p>;
  return (
    <ol className="cv-log">
      {[...log].reverse().map((x, i) => (
        <li key={i} className={`l-${x.kind}`}>
          <p><b>{LOG[x.kind] ?? x.kind}</b><span className="muted">{trx(x.by)} · {ago(x.ts)}</span></p>
          {x.text && <p className="cv-log-t">{x.text}</p>}
        </li>
      ))}
    </ol>
  );
}

function NoteDetail({ n, busy, act, lineId }: { n: CanvasNode; busy: boolean; act: Act; lineId: string }) {
  const [text, setText] = useState(n.text ?? '');
  return (
    <>
      <div className="cv-form">
        <textarea rows={8} value={text} maxLength={2000} onChange={e => setText(e.target.value)} />
      </div>
      {text.trim() !== (n.text ?? '') && (
        <div className="cv-row"><button className="btn pri" disabled={busy || !text.trim()} onClick={() => act(() => api.setNode(lineId, n.id, { text: text.trim() }), tr('保存了'))}>{tr('保存')}</button></div>
      )}
      <p className="small muted">{tr('备注只给你自己看，连着任务时会一起发给 agent')}</p>
    </>
  );
}

function Links({ near, busy, onPick, onCut, onNew }: {
  near: { e: CanvasEdge; o: CanvasNode }[]; busy: boolean; onPick: (id: string) => void; onCut: (edgeId: string) => void; onNew: (k: Kind) => void;
}) {
  return (
    <>
      {near.length ? (
        <ul className="cv-links">
          {near.map(({ e, o }) => (
            <li key={e.id}>
              <button className="cv-link" onClick={() => onPick(o.id)}><Mark n={o} /><span>{label(o)}</span>{e.label && <em>{e.label}</em>}</button>
              <button className="ib" disabled={busy} title={tr('断开这条线')} aria-label={tr('断开这条线')} onClick={() => onCut(e.id)}><Icon n="close" size={13} /></button>
            </li>
          ))}
        </ul>
      ) : <p className="small muted">{tr('还没有连线：从它边上的圆点拖到另一个节点')}</p>}
      <section className="cv-sec">
        <h5>{tr('在它旁边新建，并连上')}</h5>
        <div className="cv-row">
          <button className="btn" onClick={() => onNew('task')}><Icon n="plus" size={13} />{tr('派任务')}</button>
          <button className="btn" onClick={() => onNew('soft')}><Icon n="plus" size={13} />{tr('加检查')}</button>
          <button className="btn" onClick={() => onNew('note')}><Icon n="plus" size={13} />{tr('加备注')}</button>
        </div>
      </section>
      <p className="small muted">{tr('双击一条线可以在线上写几个字，说明这条线的意思。连着任务的线，上面的字会一起发给 agent。')}</p>
    </>
  );
}

export function NewForm({ d, v, busy, onKind, onAdd, onCancel }: {
  d: Draft; v: CanvasView; busy: boolean; onKind: (k: Kind) => void; onAdd: (b: NewNode) => void; onCancel: () => void;
}) {
  const [title, setTitle] = useState(d.seed?.title ?? '');
  const [text, setText] = useState(d.seed?.text ?? '');
  const [to, setTo] = useState<TaskTo>(d.seed?.to ?? 'lead');
  const [prio, setPrio] = useState('P1');
  const from = d.link ? v.nodes.find(n => n.id === d.link) : null;
  const there = v.agents[to].there;
  const ok = d.kind === 'note' ? !!text.trim() : d.kind === 'task' ? !!title.trim() : !!title.trim() && !!text.trim();
  const body = (send: boolean): NewNode => ({ kind: d.kind, x: d.x, y: d.y, link: d.link, title: title.trim(), text: text.trim(), to, prio, send });
  return (
    <aside className="cv-side">
      <form className="cv-new" onSubmit={e => { e.preventDefault(); if (ok && !busy) onAdd(body(d.kind === 'task' && there)); }}>
        <header className="cv-side-h">
          <div className="cv-side-t">
            <small><i className="cv-ndot new" />{from ? tr('会连到「{0}」', label(from)) : tr('放在回路上虚线框的位置')}</small>
            <h3>{tr('新节点')}</h3>
          </div>
          <button type="button" className="ib" title={tr('取消（Esc）')} aria-label={tr('取消')} onClick={onCancel}><Icon n="close" size={15} /></button>
        </header>
        <nav className="cv-tabs" role="radiogroup" aria-label={tr('节点的种类')}>
          {(['task', 'soft', 'hard', 'note'] as const).map(k => (
            <button key={k} type="button" role="radio" aria-checked={d.kind === k} className={d.kind === k ? 'on' : ''} onClick={() => onKind(k)}>{KIND[k]}</button>
          ))}
        </nav>
        <div className="cv-side-b">
          <p className="small muted">
            {d.kind === 'task' ? tr('一件交给 agent 的事：发出去后它会收到这段话和这个节点连着的东西，做完回一句结果。')
              : d.kind === 'soft' ? tr('一个要负责人读完项目再判断的问题，隔一阵再问一次。')
                : d.kind === 'hard' ? tr('一条用代码查的规则：论文里不许出现的写法，每次论文有变化就重查。')
                  : tr('一张便签，写给自己，也可以连到任务上给 agent 看。')}
          </p>
          <div className="cv-form">
            {d.kind === 'task' && (
              <label className="field">{tr('交给谁')}
                <div className="seg" role="radiogroup" aria-label={tr('交给谁')}>
                  {(['lead', 'coder', 'writer'] as const).map(k => (
                    <button key={k} type="button" role="radio" aria-checked={to === k} className={to === k ? 'on' : ''} onClick={() => setTo(k)}>{WHO[k]}</button>
                  ))}
                </div>
              </label>
            )}
            {d.kind === 'task' && !there && <p className="small warn-t">{tr('这个项目的{0}还没有启动，任务会先留在回路上。', WHO[to])}</p>}
            {d.kind !== 'note' && (
              <label className="field">{tr('名字')}
                <input autoFocus value={title} maxLength={d.kind === 'task' ? 60 : 20} onChange={e => setTitle(e.target.value)}
                  placeholder={d.kind === 'task' ? tr('比如「补三个模块的消融」') : d.kind === 'soft' ? tr('比如「要有消融」') : tr('比如「不写 novel」')} />
              </label>
            )}
            <label className="field">
              {d.kind === 'task' ? tr('要它做什么') : d.kind === 'soft' ? tr('问负责人什么') : d.kind === 'hard' ? tr('论文里不能出现的（正则表达式，不分大小写）') : tr('备注')}
              {d.kind === 'hard'
                ? <input value={text} maxLength={500} placeholder={'\\bnovel\\b'} onChange={e => setText(e.target.value)} />
                : <textarea autoFocus={d.kind === 'note'} rows={d.kind === 'task' ? wideRows(text) : 4} value={text} maxLength={d.kind === 'task' ? 4000 : 2000} onChange={e => setText(e.target.value)}
                  placeholder={d.kind === 'task' ? tr('写清楚要做的事和做到什么算完成，它会连同这个节点连着的检查、工序一起收到')
                    : d.kind === 'soft' ? tr('比如「每个模块都有消融实验吗？缺哪个列出来」') : ''} />}
            </label>
            {d.kind === 'hard' && (
              <label className="field">{tr('要求')}<Select value={prio} onChange={setPrio} options={[{ value: 'P0', label: tr('P0 · 必须过') }, { value: 'P1', label: tr('P1 · 尽量过') }]} /></label>
            )}
          </div>
        </div>
        <footer className="cv-side-f">
          {d.kind === 'task' && there
            ? <><button className="btn pri" type="submit" disabled={busy || !ok}><Icon n="send" size={13} />{tr('加上并发给{0}', WHO[to])}</button>
              <button className="btn" type="button" disabled={busy || !ok} onClick={() => onAdd(body(false))}>{tr('先放着')}</button></>
            : <button className="btn pri" type="submit" disabled={busy || !ok}>{tr('加上')}</button>}
          <button className="btn" type="button" onClick={onCancel}>{tr('取消')}</button>
        </footer>
      </form>
    </aside>
  );
}
