// Beside the canvas (Canvas.tsx): the open node as an inspector with a few tabs, and the form for a new node.
// A check has its result, history and settings; a task its brief (to edit, send, send back) and its log; every
// node the list of what it is wired to.

import { useMemo, useState } from 'react';
import { api, type CanvasEdge, type CanvasNode, type CanvasView, type NewNode, type TaskLog, type TaskStatus, type TaskTo } from '../api';
import { AGENT_STATUS } from '../components/MillRoom';
import { Select } from '../components/Select';
import { Icon } from '../console/icons';
import { ago } from '../console/util';
import { tr, trx } from '../i18n';
import { follow, href } from '../route';
import { CheckHistory, CheckResult, CheckSettings, ST, STAGE, status, type Act } from './Checks';
import type { ConsoleTarget } from './Project';

export type Kind = NewNode['kind'];
export interface Draft { kind: Kind; x: number; y: number; link: string | null; seed?: { title?: string; text?: string; to?: TaskTo } }

export const TASK: Record<TaskStatus, string> = { draft: tr('还没发'), sent: tr('在做'), done: tr('完成'), blocked: tr('卡住了') };
export const WHO: Record<TaskTo, string> = { lead: tr('项目负责人'), coder: tr('代码员工'), writer: tr('写作员工') };
export const KIND: Record<Kind, string> = { task: tr('派任务'), soft: tr('软检查'), hard: tr('硬检查'), note: tr('备注') };
const LOG: Record<TaskLog['kind'], string> = {
  made: tr('建了这个任务'), sent: tr('发出'), resent: tr('改了再发'), done: tr('交回：完成'), blocked: tr('交回：卡住了'), back: tr('退回重做'),
  marked: tr('标成完成'), reopened: tr('重新打开'),
};
export const clip = (s: string | undefined, n: number) => { const t = (s ?? '').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
export const label = (n: CanvasNode) => (n.kind === 'note' ? clip(n.text, 26) : n.kind === 'hard' || n.kind === 'soft' ? trx(n.title ?? '') : n.title ?? '');
const mine = (n: CanvasNode) => n.kind === 'task' || n.kind === 'note' || !!n.check?.custom;
// what on the canvas wants you: a check that fails, has issues or is due; a task not finished; a stage waiting on you
export const needs = (n: CanvasNode) =>
  n.check ? n.check.on && (['fail', 'warn'].includes(status(n.check)) || !!n.check.due) : n.kind === 'task' ? n.status !== 'done' : n.kind === 'stage' && n.status === 'wait';
export const neighbours = (n: CanvasNode, v: CanvasView) => v.edges.flatMap(e => {
  if (e.source !== n.id && e.target !== n.id) return [];
  const o = v.nodes.find(x => x.id === (e.source === n.id ? e.target : e.source));
  return o ? [{ e, o }] : [];
});

export function Mark({ n }: { n: CanvasNode }) {
  if (n.check) return <i className={`cg-shape k-${n.check.kind} s-${n.check.on ? status(n.check) : 'none'}`} />;
  if (n.kind === 'stage') return <i className={`cg-dot mini st-${n.status}`} />;
  return <i className={n.kind === 'task' ? `cv-tdot t-${n.status}` : 'cv-ndot'} />;
}

function Pill({ n }: { n: CanvasNode }) {
  if (n.check) return <span className={`cg-pill s-${n.check.on ? status(n.check) : 'none'}`}>{n.check.on ? ST[status(n.check)] : tr('已关闭')}</span>;
  if (n.kind === 'stage') return <span className={`cg-pill st-${n.status}`}>{n.status === 'run' ? `${STAGE.run} · ${n.pct ?? 0}%` : STAGE[n.status ?? 'todo']}</span>;
  if (n.kind === 'task') return <span className={`cg-pill t-${n.status}`}>{TASK[(n.status ?? 'draft') as TaskStatus]}</span>;
  return null;
}

const about = (n: CanvasNode) => {
  const c = n.check;
  if (c) return [c.kind === 'hard' ? tr('硬检查') : tr('软检查'), c.prio, c.rule && trx(c.rule), c.kind === 'soft' && tr('每 {0} 小时复查', c.every ?? 24)].filter(Boolean).join(' · ');
  if (n.kind === 'task') return `${tr('派给 agent 的任务')} · ${n.id}`;
  return n.kind === 'note' ? tr('备注') : tr('工序');
};

export function Inspector({ n, v, line, wide, onWide, busy, act, onConsole, onPick, onCut, onNew, onFix, onDup, onDrop, onClose }: {
  n: CanvasNode; v: CanvasView; line: { id: string; seq: number }; wide: boolean; onWide: () => void; busy: boolean; act: Act;
  onConsole: (lineId: string, t?: ConsoleTarget) => void; onPick: (id: string) => void; onCut: (edgeId: string) => void;
  onNew: (k: Kind) => void; onFix: () => void; onDup: () => void; onDrop: () => void; onClose: () => void;
}) {
  const [tab, setTab] = useState('main');
  const near = useMemo(() => neighbours(n, v), [n, v]);
  const tabs: [string, string][] = n.check
    ? [['main', tr('结果')], ['hist', n.check.history.length ? tr('历史 {0}', n.check.history.length) : tr('历史')], ['set', tr('设置')]]
    : n.kind === 'task' ? [['main', tr('任务')], ['log', tr('记录 {0}', n.log?.length ?? 0)]]
      : [['main', n.kind === 'note' ? tr('备注') : tr('工序')]];
  tabs.push(['links', near.length ? tr('连着 {0}', near.length) : tr('连线')]);
  return (
    <aside className={`cv-side${wide ? ' wide' : ''}`}>
      <header className="cv-side-h">
        <div className="cv-side-t">
          <small><Mark n={n} />{about(n)}</small>
          <h3 title={label(n)}>{label(n)}</h3>
        </div>
        <Pill n={n} />
        <button className="ib" title={wide ? tr('收窄') : tr('展开')} aria-pressed={wide} onClick={onWide}><Icon n={wide ? 'right' : 'left'} size={15} /></button>
        <button className="ib" title={tr('收起（Esc）')} aria-label={tr('收起')} onClick={onClose}><Icon n="close" size={15} /></button>
      </header>
      <nav className="cv-tabs" role="tablist">
        {tabs.map(([k, t]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{t}</button>)}
      </nav>
      <div className="cv-side-b" role="tabpanel">
        {tab === 'links' ? <Links near={near} busy={busy} onPick={onPick} onCut={onCut} onNew={onNew} />
          : n.check ? (
            tab === 'hist' ? <CheckHistory c={n.check} />
              : tab === 'set' ? <CheckSettings key={n.id} c={n.check} busy={busy} act={act} lineId={line.id} />
                : <CheckResult c={n.check} lead={v.lead} busy={busy} act={act} lineId={line.id} onConsole={onConsole} onFix={onFix} />
          ) : n.kind === 'task' ? (
            tab === 'log' ? <TaskLogList log={n.log ?? []} />
              : <TaskDetail key={n.id} n={n} v={v} busy={busy} act={act} line={line} onAgents={() => onConsole(line.id, { mod: 'agents' })} />
          ) : n.kind === 'note' ? <NoteDetail key={n.id} n={n} busy={busy} act={act} lineId={line.id} />
            : <StageDetail n={n} near={near.map(x => x.o)} onPick={onPick} />}
      </div>
      <footer className="cv-side-f">
        {(n.kind === 'task' || n.kind === 'note') && <button className="btn" disabled={busy} onClick={onDup}><Icon n="copy" size={13} />{tr('复制一个')}</button>}
        <button className="btn cv-danger" disabled={busy} onClick={onDrop} title={n.check && !n.check.custom ? tr('拿掉后这项检查也不再查，可以在「更多」里放回来') : ''}>
          {mine(n) ? tr('删掉') : tr('从画布上拿掉')}
        </button>
      </footer>
    </aside>
  );
}

function StageDetail({ n, near, onPick }: { n: CanvasNode; near: CanvasNode[]; onPick: (id: string) => void }) {
  const checks = near.filter(o => o.check), tasks = near.filter(o => o.kind === 'task');
  const on = checks.filter(o => o.check!.on), pass = on.filter(o => status(o.check!) === 'pass').length;
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
      {checks.length > 0 && <section className="cv-sec"><h5>{tr('连着的检查')}</h5><ul className="cv-links">{checks.map(row)}</ul></section>}
      {tasks.length > 0 && <section className="cv-sec"><h5>{tr('连着的任务')}</h5><ul className="cv-links">{tasks.map(row)}</ul></section>}
      <p className="small muted">{tr('软检查连着哪道工序，就从项目走到那道工序开始问负责人；不连工序的一直会问。')}</p>
    </>
  );
}

function TaskDetail({ n, v, busy, act, line, onAgents }: { n: CanvasNode; v: CanvasView; busy: boolean; act: Act; line: { id: string; seq: number }; onAgents: () => void }) {
  const [title, setTitle] = useState(n.title ?? '');
  const [text, setText] = useState(n.text ?? '');
  const [to, setTo] = useState<TaskTo>(n.to ?? 'lead');
  const [back, setBack] = useState<string | null>(null);
  const st = (n.status ?? 'draft') as TaskStatus, who = v.agents[to], ask = `/progress/${line.seq}/ask`;
  const dirty = title.trim() !== (n.title ?? '') || text.trim() !== (n.text ?? '') || to !== n.to;
  const save = () => api.setNode(line.id, n.id, { title: title.trim(), text: text.trim(), to });
  const send = () => act(async () => { if (dirty) await save(); return api.sendNode(line.id, n.id); }, tr('发给{0}了', WHO[to]));
  const returned = (st === 'done' || st === 'blocked') && !!n.result;
  return (
    <>
      <p className="cv-agent">
        <span className={`dot s-${who.there ? who.status : 'stopped'}`} />
        <b>{WHO[to]}</b>
        <span className="muted">{who.there ? AGENT_STATUS[who.status ?? ''] ?? who.status : tr('还没启动')}{st === 'sent' && n.sent_at ? ` · ${tr('{0}发出', ago(n.sent_at))}` : ''}</span>
        {!who.there ? <button className="lnk" onClick={onAgents}>{tr('去启动')}</button>
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
              <button key={k} type="button" role="radio" aria-checked={to === k} disabled={st === 'sent' && k !== n.to} className={to === k ? 'on' : ''} onClick={() => setTo(k)}
                title={st === 'sent' && k !== n.to ? tr('已经发出去了；要换人先重新打开它') : ''}>{WHO[k]}</button>
            ))}
          </div>
        </label>
        <label className="field">{tr('名字')}<input value={title} maxLength={60} onChange={e => setTitle(e.target.value)} /></label>
        <label className="field">{tr('要它做什么')}
          <textarea rows={wideRows(text)} value={text} maxLength={4000} placeholder={tr('写清楚要做的事和做到什么算完成；它会连同这个节点连着的检查、工序一起收到')} onChange={e => setText(e.target.value)} />
        </label>
      </div>
      <div className="cv-row">
        <button className={`btn${returned && !dirty ? '' : ' pri'}`} disabled={busy || !who.there || !title.trim()} onClick={send}>
          <Icon n="send" size={13} />{st === 'draft' ? tr('发给{0}', WHO[to]) : dirty ? tr('改了，再发一次') : tr('再发一次')}
        </button>
        {dirty && <button className="btn" disabled={busy || !title.trim()} onClick={() => act(save, tr('保存了'))}>{tr('只保存')}</button>}
        {st === 'sent' && <button className="btn" disabled={busy} onClick={() => act(() => api.setNode(line.id, n.id, { status: 'done' }))}>{tr('标成完成')}</button>}
      </div>
      <p className="small muted">{tr('它做完会用 pt task {0} done 回一句结果，卡住了回 blocked；这句话也会成为一条汇报。', n.id)}</p>
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
      <p className="small muted">{tr('备注：只给你自己看；连着任务时会一起发给 agent')}</p>
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
      <p className="small muted">{tr('双击一条线可以在线上写几个字，说明这条线的意思；连着任务的线，上面的字会一起发给 agent。')}</p>
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
            <small><i className="cv-ndot new" />{from ? tr('会连到「{0}」', label(from)) : tr('放在画布上虚线框的位置')}</small>
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
            {d.kind === 'task' && !there && <p className="small warn-t">{tr('这个项目的{0}还没有启动，任务会先留在画布上。', WHO[to])}</p>}
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
                  placeholder={d.kind === 'task' ? tr('写清楚要做的事和做到什么算完成；它会连同这个节点连着的检查、工序一起收到')
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
