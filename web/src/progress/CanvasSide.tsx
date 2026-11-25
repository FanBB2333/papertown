// Beside the research loop (Canvas.tsx): the open node as an inspector with a few tabs, and the form for a new node.
// A gate has its policy and its rules before → after, with where they still fail, the curve of its rounds and its
// rules' settings; a check its result, history and settings; a task its brief (to edit, send, send back) and its
// log; the spec and the clamp the work boundaries behind them; the human gate what waits for you; every node the
// list of what it is wired to.

import { figures, hitText, modelText, StateWord, stateTone } from '../emphasis';
import { useMemo, useState } from 'react';
import { api, type CanvasEdge, type CanvasNode, type CanvasView, type Check, type NewNode, type ProjectCard, type TaskLog, type TaskStatus, type TaskTo } from '../api';
import { AGENT_STATUS } from '../components/MillRoom';
import { Select } from '../components/Select';
import { Icon } from '../console/icons';
import { ago } from '../console/util';
import { tr, trx } from '../i18n';
import { follow, href, writePath } from '../route';
import { Basis, RecordLink } from './Records';
import { INFO_MOD, InfoBody, infoKind, InfoState } from './CanvasInfo';
import { CheckHistory, CheckResult, CheckSettings, ST, STAGE, status, type Act } from './Checks';
import { bad, gateChecks, gateLook, GATE_ST, level, LEVEL, over, ROLE, VERDICT } from './loop';
import type { ConsoleTarget } from './Project';
import { NodeConversation } from './NodeConversation';

export type Kind = NewNode['kind'];
export interface Draft { kind: Kind; x: number; y: number; link: string | null; seed?: { title?: string; text?: string; to?: TaskTo } }

export const TASK: Record<TaskStatus, string> = { draft: tr('尚未发送'), queued: tr('排队中'), sent: tr('进行中'), done: tr('完成'), blocked: tr('受阻') };
// the order lines round a task: the tasks before it, the ones after it, and every draft further down the chain
export const orderOf = (v: CanvasView, id: string) => {
  const by = new Map(v.nodes.map(n => [n.id, n])), lines = v.edges.filter(e => e.kind === 'order');
  const pick = (ids: string[]) => ids.map(x => by.get(x)).filter((x): x is CanvasNode => !!x);
  const seen = new Set([id]), todo = [id], down: string[] = [];
  while (todo.length) {
    const at = todo.shift()!;
    for (const e of lines) if (e.source === at && !seen.has(e.target)) { seen.add(e.target); todo.push(e.target); down.push(e.target); }
  }
  return { before: pick(lines.filter(e => e.target === id).map(e => e.source)), after: pick(lines.filter(e => e.source === id).map(e => e.target)), drafts: pick(down).filter(n => n.status === 'draft') };
};
// what to say once a task was dispatched: it went out, or it waits its turn
export const sentWord = (id: string, to: TaskTo) => (x: unknown) => {
  const view = x as CanvasView | undefined, n = view?.nodes?.find(k => k.id === id), queued = view?.nodes?.filter(k => k.kind === 'task' && k.status === 'queued').length ?? 0;
  return n?.status === 'queued' ? tr('已排队，轮到时自动派发') : queued ? tr('已派发给{0}，后续 {1} 个任务将按序派发', WHO[to], queued) : tr('已派发给{0}', WHO[to]);
};
export const WHO: Record<TaskTo, string> = { lead: tr('项目负责人'), coder: tr('代码员工'), writer: tr('写作员工') };
export const KIND: Record<Kind, string> = { task: tr('派任务'), soft: tr('软检查'), hard: tr('硬检查'), note: tr('备注') };
const LOG: Record<TaskLog['kind'], string> = {
  bound: tr('已绑定 Paseo 会话'),
  made: tr('已创建任务'), sent: tr('发出'), resent: tr('修改后重发'), done: tr('交回：完成'), blocked: tr('交回：受阻'), back: tr('退回重做'),
  marked: tr('标成完成'), reopened: tr('重新打开'), round: tr('再退回一轮'), escalated: tr('交由你拍板'), converged: tr('卡口放行，收敛'),
  queued: tr('进入排队'), unqueued: tr('取消排队'), relay: tr('轮到后自动派发'), stale: tr('结果待复核'), kept: tr('确认结果仍然有效'),
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
  if (n.check?.kind === 'soft') return <StateWord state={n.check.on ? status(n.check) : undefined}>{n.check.on ? VERDICT[status(n.check)] : tr('已关闭')}</StateWord>;
  if (n.check) {
    const lv = level(n.check);
    return <StateWord state={lv}>{lv === 'off' ? tr('已关闭') : lv === 'pass' ? tr('放行') : lv === 'none' ? ST.none : LEVEL[lv]}</StateWord>;
  }
  if (n.gate) {
    const look = gateLook(n.gate);
    return <StateWord state={look}>{n.gate.waived && n.gate.state === 'block' ? tr('已放行') : GATE_ST[look]}</StateWord>;
  }
  if (n.kind === 'human' && n.items?.length) return <span className="em-bar" data-tone="warn">{tr('{0} 待定', n.items.length)}</span>;
  if (n.kind === 'task' && n.converged) return <span className="muted">{tr('已收敛')}</span>;
  if (n.kind === 'task' && n.escalated) return <span className="em-bar" data-tone="warn">{tr('待你拍板')}</span>;
  if (n.kind === 'stage') return <span className="muted">{n.status === 'run' ? <>{STAGE.run} · <span className="em-num">{n.pct ?? 0}%</span></> : <StateWord state={n.status}>{STAGE[n.status ?? 'todo']}</StateWord>}</span>;
  if (n.kind === 'task') return <span className={stateTone(n.status) ? 'em-state' : 'muted'} data-tone={stateTone(n.status)}>{TASK[(n.status ?? 'draft') as TaskStatus]}</span>;
  return null;
}

const about = (n: CanvasNode) => {
  const c = n.check;
  if (c) return [c.kind === 'hard' ? tr('硬检查 · HARD') : tr('软巡检 · SOFT SENTINEL'), c.prio, c.rule && trx(c.rule), c.kind === 'soft' && tr('每 {0} 小时复查', c.every ?? 24)].filter(Boolean).join(' · ');
  if (n.gate) return [n.gate.checks.length > 1 ? tr('硬卡口组') : tr('硬卡口'), 'HARD GATE', tr('{0} 条规则', n.gate.checks.length)].join(' · ');
  if (n.kind === 'task') return `${n.loop === 'hard' ? tr('硬退回修补单') : n.loop === 'soft' ? tr('软纠偏任务单') : tr('派给 agent 的任务')} · ${n.id}`;
  return { note: tr('备注'), info: tr('资料卡 · 实时显示项目对应内容'), spec: tr('软限制规范 · SOFT SPEC · Prompt 引导'), clamp: tr('硬边界夹 · HARD CLAMP · 代码拦截'),
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
  tabs.push(['links', near.length ? tr('连接 {0}', near.length) : tr('连线')]);
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
        {tab === 'main' && (n.kind === 'task' || n.kind === 'stage') && <section className="cv-sec"><h5>{tr('依据')}</h5><Basis seq={line.seq} ids={n.basis} /></section>}
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
        {n.gate && <button className="btn pri" disabled={busy} onClick={() => act(() => api.runChecks(line.id), tr('检查完毕'))}><Icon n="refresh" size={13} />{tr('运行代码硬检查')}</button>}
        {n.gate && n.gate.checks.length > 1 && (
          <button className="btn" disabled={busy} onClick={() => act(() => api.gateAct(line.id, n.gate!.stage, n.gate!.open ? 'close' : 'open'))}>
            {n.gate.open ? tr('收起卡口组') : tr('展开为 {0} 个独立节点', n.gate.checks.length)}
          </button>
        )}
        {(n.kind === 'task' || n.kind === 'note') && <button className="btn" disabled={busy} onClick={onDup}><Icon n="copy" size={13} />{tr('创建副本')}</button>}
        <button className="btn cv-danger" disabled={busy} onClick={onDrop} title={n.check && !n.check.custom ? tr('移除后该检查将停止执行，可在「更多」中恢复') : ''}>
          {mine(n) ? tr('删掉') : tr('从回路上拿掉')}
        </button>
      </footer>
    </aside>
  );
}

// ---------- a gate ----------

const ruleNo = (rule: string) => trx(rule).replace(/^lastcheck\s*/, '');
const levelText = (c: Check) => { const lv = level(c); return lv === 'pass' ? tr('放行 ✓') : lv === 'off' ? tr('已关闭') : lv === 'none' ? tr('尚未检查') : lv === 'block' ? tr('阻断 ✗') : tr('告警 !'); };

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
  const policy = (b: { auto?: boolean; rounds?: number }) => act(() => api.setLoop(lineId, g.stage, b), tr('已保存'));
  return (
    <>
      <div className={`gp-card g-${look}`}>
        <h5>{tr('回路控制策略（In-Loop Gate Policy）')}</h5>
        <p>{g.locks ? tr('阻断级规则未清零时：锁住「{0}」入口，将未通过项写入修补单退回{1}，修改后运行 pt checks run。', g.locks, ROLE[to])
          : tr('阻断级规则未清零时：将未通过项写入修补单退回{0}，修改后运行 pt checks run。', ROLE[to])}</p>
        <div className="gp-ctl">
          <label className="field">{tr('修补单')}
            <Select value={g.policy.auto ? 'auto' : 'hold'} disabled={busy} onChange={x => policy({ auto: x === 'auto' })}
              options={[{ value: 'auto', label: tr('生成后自动发送') }, { value: 'hold', label: tr('暂存，审核后发送') }]} />
          </label>
          <label className="field">{tr('最多自动退回')}
            <Select value={g.policy.rounds} disabled={busy} onChange={x => policy({ rounds: x })} options={[1, 2, 3, 4, 5, 6, 8, 10].map(k => ({ value: k, label: tr('{0} 轮', k) }))} />
          </label>
        </div>
        <small>{g.ticket ? tr('当前第 {0} 轮（修补单 {1}），超过 {2} 轮升级至「人类拍板节点」', g.round, g.ticket, g.policy.rounds) : tr('超过 {0} 轮尚未清零，升级至「人类拍板节点」待你决定', g.policy.rounds)}</small>
        {g.waived && <p className="small">{tr('你已决定先放行：该卡口不再锁住下一道工序或退回，规则全部通过后自动恢复。')}</p>}
        {g.state === 'block' && (
          <div className="cv-row">
            <button className="btn pri" disabled={busy} onClick={() => act(() => api.gateAct(lineId, g.stage, 'rework'), tr('修补单已派发'))}>
              <Icon n="refresh" size={13} />{g.ticket && g.ticket_status !== 'done' ? tr('将修补单派发给{0}', ROLE[to]) : tr('生成修补单派发给{0}', ROLE[to])}
            </button>
            {g.escalated && <button className="btn" disabled={busy} onClick={() => act(() => api.gateAct(lineId, g.stage, 'more'), tr('再退回两轮'))}>{tr('追加两轮')}</button>}
            {!g.waived && <button className="btn" disabled={busy} onClick={() => act(() => api.gateAct(lineId, g.stage, 'waive'), tr('已暂时放行'))}>{tr('先放行')}</button>}
          </div>
        )}
      </div>

      <section className="cv-sec">
        <h5>{tr('Before → After 轮次收敛表')}<span> · {tr('可直接写入进展汇报')}</span></h5>
        <table className="gp-tab">
          <thead><tr><th>{tr('规则项')}</th><th>R1</th><th>{tr('现在')}</th><th>{tr('门禁')}</th></tr></thead>
          <tbody>
            {cs.map(c => (
              <tr key={c.id} className={`l-${level(c)}`}>
                <td><button className="lnk" onClick={() => onPick(`check:${c.id}`)} disabled={!v.nodes.some(x => x.id === `check:${c.id}`)}>{ruleNo(c.rule)} {trx(c.title)}</button></td>
                <td>{c.first?.value ?? '—'}</td>
                <td><b className={c.last?.value != null && c.first?.value != null && c.first.value !== c.last.value ? 'em-mark' : 'em-num'} data-tone={stateTone(level(c))}>{c.last?.value ?? '—'}</b></td>
                <td><StateWord state={level(c)}>{c.prio} · {levelText(c)}</StateWord></td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td>{tr('超出允许的合计')}</td><td>{g.before}</td><td><b className={g.before !== g.now ? 'em-mark' : 'em-num'}>{g.now}</b></td><td>{g.pass}/{g.total} {tr('过')}</td></tr></tfoot>
        </table>
      </section>

      {failing.length > 0 && (
        <section className="cv-sec">
          <h5>{tr('剩余未过定位')}<span> · {tr('点击位置跳转至中控屏源码')}</span></h5>
          {failing.flatMap(c => (c.last?.findings ?? []).slice(0, 6).map((f, i) => (
            <div key={`${c.id}:${i}`} className={`gp-find l-${level(c)}`}>
              <header>
                <em>{c.prio} · {ruleNo(c.rule)} {trx(c.title)}</em>
                {(f.file || c.id === 'results') && <button className="lnk cg-at" onClick={() => open(c, f)}>{f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : f.hit} ↗</button>}
              </header>
              {f.text && <p className="gp-src">{hitText(f.text, f.hit)}</p>}
              {f.hint && <p className="muted">{tr('建议：{0}', trx(f.hint))}</p>}
              {who && who.status !== 'done' && <p className="gp-tk">↳ {tr('已写入修补单 {0}，{1}{2}', who.id, WHO[who.to ?? 'lead'], who.status === 'sent' ? tr('修改中') : TASK[(who.status ?? 'draft') as TaskStatus])}</p>}
            </div>
          )))}
          {failing.some(c => (c.last?.total ?? 0) > 6) && <p className="small muted">{tr('每条规则仅列前 6 处，展开卡口后在各规则「结果」中查看全部。')}</p>}
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
  if (!pts.length) return <p className="small muted">{tr('暂无记录：规则检查后，各轮结果将绘制在此处')}</p>;
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
      <p className="small muted">{tr('每个点代表结果变化的轮次：该卡口所有未通过规则超出允许的处数之和。')}</p>
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

const BOUND: Record<string, string> = { must: tr('必须完成'), never: tr('不能做'), ask: tr('需先确认') };
const FROM: Record<string, string> = { global: tr('全局'), project: tr('项目'), lead: tr('负责人'), coder: tr('代码员工'), writer: tr('写作员工') };

function BoundsDetail({ n, onRules }: { n: CanvasNode; onRules: () => void }) {
  const rules = n.rules ?? [], spec = n.kind === 'spec';
  return (
    <>
      <p className="cg-what">{spec
        ? tr('写入各 agent 的 AGENTS.md 与项目简报，作为上下文引导生成。模型为概率生成，此类要求仅作方向引导，实际执行由下游硬卡口与软巡检验证。')
        : tr('绑定动作的工作边界：不依赖模型自觉，由 Papertown 服务端直接拦截（不能做），或暂停询问（需先确认）。')}</p>
      {rules.length ? (
        <ul className="gp-bounds">
          {rules.map(r => (
            <li key={r.id}><em className={`gp-bk k-${r.kind}`}>{BOUND[r.kind]}</em><span className="em-bar">{r.text}</span><small className="muted">{FROM[r.from] ?? r.from}{r.action ? ` · ${r.action}` : ''}</small></li>
          ))}
        </ul>
      ) : <p className="small muted">{spec ? tr('工作边界中暂无针对 agent 的要求，仅按项目简报执行。') : tr('暂无绑定动作的边界：Papertown 不拦截任何动作。')}</p>}
      <div className="cv-row"><button className="btn" onClick={onRules}><Icon n="shield" size={13} />{tr('在中控屏中修改工作边界')}</button></div>
    </>
  );
}

function HumanDetail({ n, v, busy, act, line, onPick }: { n: CanvasNode; v: CanvasView; busy: boolean; act: Act; line: { id: string; seq: number }; onPick: (id: string) => void }) {
  const items = n.items ?? [], ask = `/progress/${line.seq}/ask`, home = `/progress/${line.seq}`;
  return (
    <>
      <p className="cg-what">{tr('软硬检测的异常最终升级至此：超轮次未清零的硬卡口、受阻任务、前序重做后待复核结果、偏离的软巡检及 agent 提问。')}</p>
      {!items.length && <p className="small muted">{tr('当前暂无待你拍板的事项。')}</p>}
      <ul className="gp-human">
        {items.map(x => (
          <li key={`${x.kind}:${x.id}`} className={`k-${x.kind}`}>
            <p className="em-bar" data-tone="warn">{modelText(x.text)}</p>
            <div className="cv-row">
              {x.kind === 'escalated' && x.gate && <>
                <button className="btn pri" disabled={busy} onClick={() => act(() => api.gateAct(line.id, x.gate!, 'more'), tr('再退回两轮'))}>{tr('追加两轮')}</button>
                <button className="btn" disabled={busy} onClick={() => act(() => api.gateAct(line.id, x.gate!, 'waive'), tr('已暂时放行'))}>{tr('先放行')}</button>
                <button className="lnk" onClick={() => onPick(`gate:${x.gate}`)}>{tr('查看卡口')}</button>
              </>}
              {x.kind === 'stale' && <button className="btn" disabled={busy} onClick={() => act(() => api.setNode(line.id, x.id, { stale: false }), tr('已确认结果有效'))}>{tr('结果仍然有效')}</button>}
              {(x.kind === 'blocked' || x.kind === 'stale' || x.kind === 'fail') && <button className="lnk" onClick={() => onPick(x.id)}>{x.kind === 'fail' ? tr('查看巡检') : tr('看任务')}</button>}
              {x.kind === 'ask' && <a className="lnk" href={href(ask)} onClick={e => follow(e, ask)}>{tr('前往回复')}</a>}
              {x.kind === 'matter' && <RecordLink className="lnk" to={writePath(line.seq, 'matter', x.ask ?? x.id)}>{tr('前往写下决定')}</RecordLink>}
              {x.kind === 'line' && <a className="lnk" href={href(home)} onClick={e => follow(e, home)}>{tr('返回项目页处理')}</a>}
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
          : <button className="btn" onClick={() => onConsole(line.id, { mod: INFO_MOD[k] })}><Icon n="board" size={13} />{tr('在中控屏中打开')}</button>}
      </div>
      <p className="small muted">{tr('资料卡随项目自动更新。将任务连接至资料卡，agent 即了解其与项目该部分的关联。')}</p>
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
        <p><b className="em-num">{pct}%</b><span>{STAGE[n.status ?? 'todo']}</span>{on.length > 0 && <small>{figures(tr('关联检查 {0}/{1} 通过', pass, on.length))}</small>}</p>
        <div className="cg-bar"><i style={{ width: `${pct}%` }} /></div>
      </div>
      {n.locked && <div className="gp-card g-block"><p>{tr('被「{0}」硬卡口锁住：阻断级规则清零或先放行后才能继续。', trx(n.locked.title))}</p>
        <button className="lnk" onClick={() => onPick(`gate:${n.locked!.gate}`)}>{tr('查看该卡口')}</button></div>}
      {checks.length > 0 && <section className="cv-sec"><h5>{tr('关联的卡口与巡检')}</h5><ul className="cv-links">{checks.map(row)}</ul></section>}
      {tasks.length > 0 && <section className="cv-sec"><h5>{tr('关联的任务')}</h5><ul className="cv-links">{tasks.map(row)}</ul></section>}
      <p className="small muted">{tr('软巡检监测指定工序，项目进入该工序后开始询问负责人，未关联工序则持续询问。')}</p>
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
  const send = (chain = false) => act(async () => { if (dirty) await save(); return api.sendNode(line.id, n.id, chain); }, sentWord(n.id, to));
  const returned = (st === 'done' || st === 'blocked') && !!n.result;
  const { before, after, drafts } = orderOf(v, n.id), waits = n.waits ?? [], dirWait = waits.some(w => w.kind === 'dir');
  const near = (x: CanvasNode) => (
    <button key={x.id} className="cv-near" onClick={() => onPick(x.id)} title={x.title}>
      <span>{x.id}「{clip(x.title, 14)}」</span><StateWord state={x.stale ? 'stale' : x.status}>{x.stale ? tr('待复核') : TASK[(x.status ?? 'draft') as TaskStatus]}</StateWord>
    </button>
  );
  const gate = n.loop === 'hard' ? v.nodes.find(x => x.id === `gate:${n.stage}`) : null, from = n.loop === 'soft' ? v.nodes.find(x => x.id === `check:${n.from}`) : null;
  return (
    <>
      {n.loop === 'hard' && (
        <div className={`gp-card g-${n.converged ? 'pass' : 'block'}`}>
          <p>{n.converged ? tr('「{0}」硬卡口已放行：{1} 轮收敛。', gate?.gate?.name ?? n.stage ?? '', n.round || 1)
            : tr('「{0}」硬卡口阻断时 Papertown 自动生成的修补单，当前为第 {1} 轮。完成后卡口仍未放行时，将再退回一轮。', gate?.gate?.name ?? n.stage ?? '', n.round || 1)}</p>
          {(n.trail?.length ?? 0) > 0 && <p className="gp-trail"><span className="em-mark">{tr('收敛进度：{0}', (n.trail ?? []).map(x => tr('{0} 处', x)).join(' → '))}</span></p>}
          {gate && <button className="lnk" onClick={() => onPick(gate.id)}>{tr('查看该卡口')}</button>}
        </div>
      )}
      {n.loop === 'soft' && from && (
        <p className="small muted">{tr('由软巡检「{0}」派发的纠偏任务，完成后关联工序将重新评估。', label(from))} <button className="lnk" onClick={() => onPick(from.id)}>{tr('查看该巡检')}</button></p>
      )}
      <p className="cv-agent">
        <span className={`dot s-${who.there ? who.status : 'stopped'}`} />
        <b>{n.agent_id ? `${WHO[to]} · ${n.id}` : WHO[to]}</b>
        <span className="muted">{who.there ? AGENT_STATUS[who.status ?? ''] ?? who.status : tr('尚未启动')}{st === 'sent' && n.sent_at ? ` · ${tr('{0}派发', ago(n.sent_at))}` : ''}</span>
        {n.agent_id || n.agent?.runtime === 'paseo' ? <button className="lnk" onClick={onChat}>{tr('打开对话')}</button>
          : !who.there ? <>
            {st === 'draft' && <button className="lnk" onClick={onChat}>{tr('安排独立 Agent')}</button>}
            <button className="lnk" onClick={onAgents}>{tr('前往启动')}</button>
          </>
          : to === 'lead' ? <a className="lnk" href={href(ask)} onClick={e => follow(e, ask)}>{tr('打开对话')}</a>
            : <button className="lnk" onClick={onAgents}>{tr('打开对话')}</button>}
      </p>
      {(before.length > 0 || after.length > 0) && (
        <div className="cv-order">
          {before.length > 0 && <p><b>{tr('前序')}</b>{before.map(near)}</p>}
          {after.length > 0 && <p><b>{tr('后续')}</b>{after.map(near)}</p>}
          <p className="small muted">{tr('前序全部完成后，该任务才派发。完成后，已排队的后续任务自动依次派发。')}</p>
        </div>
      )}
      {st === 'queued' && (
        <div className="cv-turn">
          <p><Icon n="clock" size={13} /><b>{tr('排队中')}</b><span className="muted">{dirWait ? tr('等待工作目录空闲') : waits.length ? tr('等待前序完成') : tr('轮到时自动派发')}</span></p>
          {waits.length > 0 && (
            <ul>{waits.map(w => (
              <li key={w.id}>
                <button className="lnk" onClick={() => onPick(w.id)}>{w.id}「{clip(w.title, 18)}」</button>
                <span className="muted">{w.kind === 'dir' ? tr('正在使用同一个工作目录') : w.stale ? tr('已完成，结果待复核') : TASK[w.status]}</span>
              </li>
            ))}</ul>
          )}
          {n.wait_note && <p className="small em-state" data-tone="bad">{tr('轮到时派发失败：{0}', trx(n.wait_note))}</p>}
          <div className="cv-row">
            <button className="btn" disabled={busy} onClick={() => act(() => api.setNode(line.id, n.id, { status: 'draft' }), tr('已取消排队'))}>{tr('取消排队')}</button>
            {n.wait_note && <button className="btn" disabled={busy} onClick={() => act(() => api.sendNode(line.id, n.id), sentWord(n.id, to))}>{tr('重试')}</button>}
            {dirWait && <button className="btn" disabled={busy} onClick={() => act(() => api.setLoopRules(line.id, false), tr('已允许同目录任务同时运行'))}>{tr('允许同目录任务同时运行')}</button>}
          </div>
        </div>
      )}
      {n.stale && (
        <div className="cv-turn stale em-bar" data-tone="warn">
          <p><Icon n="refresh" size={13} /><b>{tr('结果待复核')}</b></p>
          <p className="small">{tr('{0}。这份结果依据的是旧产出，后续任务将等待你确认。需要重做时，可退回或重新派发。', trx(n.stale))}</p>
          <div className="cv-row">
            <button className="btn pri" disabled={busy} onClick={() => act(() => api.setNode(line.id, n.id, { stale: false }), tr('已确认结果有效'))}>{tr('结果仍然有效')}</button>
          </div>
        </div>
      )}
      {returned && (
        <blockquote className={`cg-verdict ${st === 'done' ? 's-pass' : 's-fail'}`}>
          <p>{modelText(n.result)}</p>
          <footer className="small muted">{trx(n.by ?? '')}{n.done_at ? ` · ${ago(n.done_at)}` : ''}</footer>
        </blockquote>
      )}
      {returned && (back === null ? (
        <div className="cv-row">
          <button className="btn" disabled={busy || !who.there} onClick={() => setBack('')}><Icon n="quote" size={13} />{st === 'done' ? tr('退回重做') : tr('回复并继续')}</button>
          {st === 'blocked' && <button className="btn" disabled={busy} onClick={() => act(() => api.setNode(line.id, n.id, { status: 'done' }))}>{tr('标成完成')}</button>}
          <button className="btn" disabled={busy} onClick={() => act(() => api.setNode(line.id, n.id, { status: 'draft' }))}>{tr('重新打开')}</button>
        </div>
      ) : (
        <div className="cv-form">
          <textarea className={back ? 'em-bar' : undefined} autoFocus rows={3} value={back} maxLength={4000} placeholder={st === 'done' ? tr('哪里不行、要怎么改') : tr('解答受阻问题')} onChange={e => setBack(e.target.value)} />
          <div className="cv-row">
            <button className="btn pri" disabled={busy || !back.trim()} onClick={() => act(() => api.backNode(line.id, n.id, back.trim()), tr('已重新发送')).then(() => setBack(null))}>
              <Icon n="send" size={13} />{tr('重新发送')}
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
        <label className="field">{tr('任务内容')}
          <textarea className={n.created_by === 'you' ? 'em-bar' : undefined} rows={wideRows(text)} value={text} maxLength={4000} placeholder={tr('写明任务内容与完成标准，派发时将连同该节点关联的检查与工序一并发送')} onChange={e => setText(e.target.value)} />
        </label>
      </div>
      <div className="cv-row">
        {st === 'queued'
          ? <button className="btn" disabled><Icon n="clock" size={13} />{tr('已排队，轮到时自动派发')}</button>
          : <button className={`btn${returned && !dirty ? '' : ' pri'}`} disabled={busy || !who.there || !title.trim()} onClick={() => send()}>
            <Icon n="send" size={13} />{st === 'draft' ? tr('发送至{0}', WHO[to]) : dirty ? tr('修改并重新发送') : tr('再发一次')}
          </button>}
        {drafts.length > 0 && st !== 'done' && (
          <button className="btn" disabled={busy || !who.there || !title.trim()} onClick={() => send(true)} title={tr('该任务优先派发，后续任务依次排队，前序完成后自动派发下一项')}>
            <Icon n="right" size={13} />{tr('连同后续 {0} 个按顺序派发', drafts.length)}
          </button>
        )}
        {dirty && <button className="btn" disabled={busy || !title.trim()} onClick={() => act(save, tr('已保存'))}>{tr('仅保存')}</button>}
        {st === 'sent' && <button className="btn" disabled={busy} onClick={() => act(() => api.setNode(line.id, n.id, { status: 'done' }))}>{tr('标成完成')}</button>}
      </div>
      <p className="small muted">{tr('完成后通过 pt task {0} done 返回结果，受阻则返回 blocked，该说明同步记为汇报。', n.id)}</p>
    </>
  );
}
const wideRows = (text: string) => Math.min(14, Math.max(5, text.split('\n').length + 1));

function TaskLogList({ log }: { log: TaskLog[] }) {
  if (!log.length) return <p className="small muted">{tr('暂无记录')}</p>;
  return (
    <ol className="cv-log">
      {[...log].reverse().map((x, i) => (
        <li key={i} className={`l-${x.kind}`}>
          <p><b>{LOG[x.kind] ?? x.kind}</b><span className="muted">{trx(x.by)} · {ago(x.ts)}</span></p>
          {x.text && <p className={x.kind === 'back' ? 'cv-log-t em-bar' : 'cv-log-t'}>{x.kind === 'back' ? x.text : modelText(x.text)}</p>}
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
        <textarea className={n.created_by === 'you' ? 'em-bar' : undefined} rows={8} value={text} maxLength={2000} onChange={e => setText(e.target.value)} />
      </div>
      {text.trim() !== (n.text ?? '') && (
        <div className="cv-row"><button className="btn pri" disabled={busy || !text.trim()} onClick={() => act(() => api.setNode(lineId, n.id, { text: text.trim() }), tr('已保存'))}>{tr('保存')}</button></div>
      )}
      <p className="small muted">{tr('备注仅自己可见，关联任务时将一并发送给 agent')}</p>
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
              <button className="ib" disabled={busy} title={tr('断开连线')} aria-label={tr('断开连线')} onClick={() => onCut(e.id)}><Icon n="close" size={13} /></button>
            </li>
          ))}
        </ul>
      ) : <p className="small muted">{tr('暂无连线：从节点边缘圆点拖拽至另一节点')}</p>}
      <section className="cv-sec">
        <h5>{tr('在旁新建并连线')}</h5>
        <div className="cv-row">
          <button className="btn" onClick={() => onNew('task')}><Icon n="plus" size={13} />{tr('派任务')}</button>
          <button className="btn" onClick={() => onNew('soft')}><Icon n="plus" size={13} />{tr('添加检查')}</button>
          <button className="btn" onClick={() => onNew('note')}><Icon n="plus" size={13} />{tr('添加备注')}</button>
        </div>
      </section>
      <p className="small muted">{tr('双击连线可添加文字说明其含义。连接任务的连线，其说明将一并发送至 agent。')}</p>
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
            <small><i className="cv-ndot new" />{from ? tr('将连接至「{0}」', label(from)) : tr('放在回路的虚线框位置')}</small>
            <h3>{tr('新节点')}</h3>
          </div>
          <button type="button" className="ib" title={tr('取消（Esc）')} aria-label={tr('取消')} onClick={onCancel}><Icon n="close" size={15} /></button>
        </header>
        <nav className="cv-tabs" role="radiogroup" aria-label={tr('节点类型')}>
          {(['task', 'soft', 'hard', 'note'] as const).map(k => (
            <button key={k} type="button" role="radio" aria-checked={d.kind === k} className={d.kind === k ? 'on' : ''} onClick={() => onKind(k)}>{KIND[k]}</button>
          ))}
        </nav>
        <div className="cv-side-b">
          <p className="small muted">
            {d.kind === 'task' ? tr('派发给 agent 的任务：派发后将收到此描述与关联节点内容，完成后返回结果。')
              : d.kind === 'soft' ? tr('由负责人读取项目后判断的问题，将定期复查。')
                : d.kind === 'hard' ? tr('通过代码检测的规则：论文中禁止出现的内容，论文变更时重新检查。')
                  : tr('个人便签，也可关联至任务供 agent 查看。')}
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
            {d.kind === 'task' && !there && <p className="small warn-t">{tr('该项目的{0}尚未启动，任务将暂留于回路中。', WHO[to])}</p>}
            {d.kind !== 'note' && (
              <label className="field">{tr('名字')}
                <input autoFocus value={title} maxLength={d.kind === 'task' ? 60 : 20} onChange={e => setTitle(e.target.value)}
                  placeholder={d.kind === 'task' ? tr('例如「补三个模块的消融」') : d.kind === 'soft' ? tr('例如「要有消融」') : tr('例如「不写 novel」')} />
              </label>
            )}
            <label className="field">
              {d.kind === 'task' ? tr('任务内容') : d.kind === 'soft' ? tr('向负责人提问') : d.kind === 'hard' ? tr('论文禁用内容（正则表达式，不区分大小写）') : tr('备注')}
              {d.kind === 'hard'
                ? <input value={text} maxLength={500} placeholder={'\\bnovel\\b'} onChange={e => setText(e.target.value)} />
                : <textarea className={text ? 'em-bar' : undefined} autoFocus={d.kind === 'note'} rows={d.kind === 'task' ? wideRows(text) : 4} value={text} maxLength={d.kind === 'task' ? 4000 : 2000} onChange={e => setText(e.target.value)}
                  placeholder={d.kind === 'task' ? tr('写明任务内容与完成标准，派发时将连同该节点关联的检查与工序一并发送')
                    : d.kind === 'soft' ? tr('例如「每个模块都有消融实验吗？请列出缺失项」') : ''} />}
            </label>
            {d.kind === 'hard' && (
              <label className="field">{tr('要求')}<Select value={prio} onChange={setPrio} options={[{ value: 'P0', label: tr('P0 · 必须通过') }, { value: 'P1', label: tr('P1 · 尽量通过') }]} /></label>
            )}
          </div>
        </div>
        <footer className="cv-side-f">
          {d.kind === 'task' && there
            ? <><button className="btn pri" type="submit" disabled={busy || !ok}><Icon n="send" size={13} />{tr('添加并派发给{0}', WHO[to])}</button>
              <button className="btn" type="button" disabled={busy || !ok} onClick={() => onAdd(body(false))}>{tr('暂存')}</button></>
            : <button className="btn pri" type="submit" disabled={busy || !ok}>{tr('加上')}</button>}
          <button className="btn" type="button" onClick={onCancel}>{tr('取消')}</button>
        </footer>
      </form>
    </aside>
  );
}
