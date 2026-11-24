// 待你决定: what a project's agents and its lead wait on, each with the choices that settle it (decisions.py).
// On a card it is one bright line. Hovering or clicking it floats the choices, and one click answers by the same
// path the agent asked by: its question, its native permission request, the dialog on its terminal. A line of the
// card goes to the lead as a message.

import { Button, Input, Popover } from '@cloudflare/kumo';
import { useState } from 'react';
import { api, type Decision, type ProjectCard } from '../api';
import { Icon, type IconName } from '../console/icons';
import { ago } from '../console/util';
import { tr, trx } from '../i18n';
import { go } from '../route';
import { askPath } from './Ask';

const KIND: Record<Decision['kind'], [string, IconName]> = {
  ask: [tr('提问'), 'chat'], permission: [tr('权限请求'), 'shield'], prompt: [tr('终端对话框'), 'term'], need: [tr('卡片上要你决定'), 'cards'],
};
// the server's fixed choices, in the page's language; an agent's own choices are its words
const FIXED: Record<string, string> = { 允许: tr('允许'), 拒绝: tr('拒绝'), 同意: tr('同意'), 不同意: tr('不同意') };
const keyOf = (d: Decision) => `${d.kind}:${d.agent ?? ''}:${d.id}`;
// one line for it: a permission request's tool alone (Bash) says little, so its command comes along
const lineOf = (d: Decision) => (d.kind === 'permission' && d.detail ? `${trx(d.title)} · ${d.detail.split('\n')[0]}` : trx(d.title));

// answered here: out of sight while the agent's state catches up (the server waits 30 seconds as well)
const gone = new Map<string, number>();
const answered = (d: Decision) => { const at = gone.get(keyOf(d)); return at != null && Date.now() - at < 45_000; };
export const openDecisions = (r: ProjectCard) => (r.decisions ?? []).filter(d => !answered(d));

// the card's pane: one line that floats the choices
export function DecideLine({ r }: { r: ProjectCard }) {
  const [, redraw] = useState(0);
  const list = openDecisions(r);
  const first = list[0];
  if (!first) return <span className="pp-one dc-done"><Icon n="check" size={12} />{tr('已决定，等它们接着做')}</span>;
  return (
    <Popover.Root>
      <Popover.Trigger openOnHover delay={120} closeDelay={260}
        render={<button className="dc-line" onClick={e => e.stopPropagation()} aria-label={tr('待你决定：{0} 件', list.length)} />}>
        <b><Icon n="bell" size={12} />{tr('待你决定')}{list.length > 1 && <span className="dc-n">{list.length}</span>}</b>
        <span className="dc-t">{lineOf(first)}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} collisionPadding={12}>
          <Popover.Popup className="dc-pop" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
            <header className="dc-head"><span>{tr('#{0} 待你决定', r.line.seq)}</span><small>{tr('点选项即完成决定')}</small></header>
            <DecideList r={r} kumo onGone={() => redraw(n => n + 1)} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

// every decision with its choices: in the floating panel (Kumo's layer, so Kumo's controls) and on the project's page
export function DecideList({ r, kumo, onGone }: { r: ProjectCard; kumo?: boolean; onGone?: () => void }) {
  const [, redraw] = useState(0);
  const shown = openDecisions(r);
  if (!shown.length) return <p className="dc-empty">{tr('已决定，等它们接着做')}</p>;
  const done = (d: Decision) => { gone.set(keyOf(d), Date.now()); redraw(n => n + 1); onGone?.(); };
  return <ul className="dc-list">{shown.map(d => <Item key={keyOf(d)} d={d} r={r} kumo={!!kumo} onDone={() => done(d)} />)}</ul>;
}

type BtnProps = { kumo: boolean; main?: boolean; disabled?: boolean; onClick?: () => void; type?: 'submit' | 'button'; children: React.ReactNode };
function Btn({ kumo, main, children, type = 'button', ...p }: BtnProps) {
  return kumo ? <Button size="sm" variant={main ? 'primary' : 'secondary'} type={type} {...p}>{children}</Button>
    : <button className={`btn${main ? ' pri' : ''}`} type={type} {...p}>{children}</button>;
}

function Item({ d, r, kumo, onDone }: { d: Decision; r: ProjectCard; kumo: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState('');
  const [what, ic] = KIND[d.kind];
  async function pick(value: Decision['options'][number]['value'] | null, words?: string) {
    if (busy) return;
    setBusy(true); setErr('');
    try {
      await api.decideCard(r.line.id, { kind: d.kind, id: d.id, agent: d.agent, value, text: words });
      onDone();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  const off = busy || !d.ready;
  const label = (o: Decision['options'][number]) => (d.kind === 'ask' ? trx(o.label) : d.kind === 'prompt' ? o.label : FIXED[o.label] ?? o.label);
  return (
    <li className={`dc-item k-${d.kind}`}>
      <span className="dc-k"><Icon n={ic} size={12} />{[trx(d.who), what, d.since && ago(d.since)].filter(Boolean).join(' · ')}</span>
      <p className="dc-q">{trx(d.title)}</p>
      {d.detail && <pre className="dc-d">{d.detail}</pre>}
      {d.options.length > 0 && (
        <div className={`dc-opts${d.kind === 'prompt' ? ' dc-col' : ''}`}>
          {d.options.map((o, i) => (
            <Btn key={i} kumo={kumo} main={o.main && d.kind !== 'prompt'} disabled={off} onClick={() => pick(o.value)}>
              {d.kind === 'prompt' && <span className="dc-num">{i + 1}</span>}{label(o)}
            </Btn>
          ))}
          {d.free && !writing && <Btn kumo={kumo} disabled={off} onClick={() => setWriting(true)}>{tr('其他回答…')}</Btn>}
        </div>
      )}
      {d.kind === 'permission' && !d.options.length && (
        <div className="dc-opts"><Btn kumo={kumo} onClick={() => go(askPath(r.line.seq))}>{tr('去对话里回答')}<Icon n="right" size={12} /></Btn></div>
      )}
      {writing && (
        <form className="dc-free" onSubmit={e => { e.preventDefault(); if (text.trim()) pick(null, text.trim()); }}>
          {kumo ? <Input autoFocus size="sm" aria-label={tr('写给它的回答')} value={text} maxLength={2000} disabled={busy} placeholder={tr('写给它的回答')} onChange={e => setText(e.target.value)} />
            : <input autoFocus value={text} maxLength={2000} disabled={busy} placeholder={tr('写给它的回答')} onChange={e => setText(e.target.value)} />}
          <Btn kumo={kumo} main type="submit" disabled={busy || !text.trim()}>{tr('发送')}</Btn>
        </form>
      )}
      {d.later && <p className="dc-note">{tr('负责人没在运行，这个决定会在下次请它更新卡片时一并交给它')}</p>}
      {err && <p className="dc-err">{err}</p>}
    </li>
  );
}
