// Research decisions keep the user's words. Permissions retain the controls supplied by the agent.

import { modelText } from '../emphasis';
import { Button, Input, Popover, Textarea } from '@cloudflare/kumo';
import { useEffect, useRef, useState } from 'react';
import { api, type CardDecision, type ProjectCard } from '../api';
import { Icon, type IconName } from '../console/icons';
import { ago } from '../console/util';
import { tr, trx } from '../i18n';
import { go, query, usePath, writePath } from '../route';
import { askPath } from './Ask';
import { Materials, MatterFacts, ModSelect, RecordLink } from './Records';
import { PART, type FlowPart } from '../flow';

const KIND: Record<CardDecision['kind'], [string, IconName]> = {
  matter: [tr('待定的事'), 'compose'],
  ask: [tr('提问'), 'chat'], permission: [tr('权限请求'), 'shield'], prompt: [tr('终端对话框'), 'term'], need: [tr('卡片上要你决定'), 'cards'],
};
// the server's fixed choices, in the page's language; an agent's own choices are its words
const FIXED: Record<string, string> = { 允许: tr('允许'), 拒绝: tr('拒绝'), 同意: tr('同意'), 不同意: tr('不同意') };
const keyOf = (d: CardDecision) => `${d.kind}:${d.agent ?? ''}:${d.id}`;
const needsWords = (d: CardDecision) => d.kind === 'matter' || d.kind === 'need';
// one line for it: a permission request's tool alone (Bash) says little, so its command comes along
const question = (d: CardDecision) => needsWords(d) || (d.kind === 'ask' && !d.act) ? d.title : trx(d.title);
const lineOf = (d: CardDecision) => d.kind === 'permission' && d.detail ? `${question(d)} · ${d.detail.split('\n')[0]}` : question(d);

// answered here: out of sight while the agent's state catches up (the server waits 30 seconds as well)
const gone = new Map<string, number>();
export const openDecisions = (r: ProjectCard) => (r.decisions ?? []).filter(d => Date.now() - (gone.get(r.line.id + keyOf(d)) ?? 0) >= 45_000);

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
        <b className="em-bar" data-tone="warn"><Icon n="bell" size={12} />{tr('待你决定')}{list.length > 1 && <span className="dc-n">{list.length}</span>}</b>
        <span className="dc-t">{lineOf(first)}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} collisionPadding={12}>
          <Popover.Popup className="dc-pop" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
            <header className="dc-head"><span>{tr('#{0} 待你决定', r.line.seq)}</span></header>
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
  const done = (d: CardDecision) => { gone.set(r.line.id + keyOf(d), Date.now()); redraw(n => n + 1); onGone?.(); };
  const groups = [[tr('待定的事'), shown.filter(d => d.kind === 'matter')], [tr('卡片上等你定的事'), shown.filter(d => d.kind === 'need')],
    [tr('许可'), shown.filter(d => !needsWords(d))]] as const;
  return <>{groups.map(([name, items]) => !!items.length && <section className="dc-group" key={name}><h4>{name}</h4><ul className="dc-list">
    {items.map(d => d.kind === 'matter' || d.kind === 'need'
      ? <li className="dc-item" key={keyOf(d)}>
        {kumo ? <><p className="dc-q em-bar" data-tone="warn">{modelText(d.title)}</p><RecordLink className="dc-write-link" to={writePath(r.line.seq, d.kind, d.id)}>{tr('前往写下决定')}</RecordLink></>
          : <WriteAnswer d={d} r={r} onDone={() => done(d)} />}</li>
      : <Item key={keyOf(d)} d={d} r={r} kumo={!!kumo} onDone={() => done(d)} />)}
  </ul></section>)}</>;
}

function WriteAnswer({ d, r, onDone }: { d: CardDecision; r: ProjectCard; onDone: () => void }) {
  const [text, setText] = useState(''), [mod, setMod] = useState<FlowPart>(d.mod ?? 'overview');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const location = usePath();
  const target = query().get(d.kind);
  useEffect(() => {
    if (target === String(d.id)) { input.current?.focus({ preventScroll: true }); input.current?.scrollIntoView({ block: 'center' }); }
  }, [target, d.id, location]);
  const fill = (s: string) => { setText(s); input.current?.focus(); };
  const ready = !!text.trim() && !busy && d.ready;
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true); setError('');
    try {
      if (d.kind === 'need' && !d.write && !d.mod) {
        await api.decideCard(r.line.id, { kind: 'need', id: d.id, agent: d.agent, value: null, text });
      } else {
        await api.writeDecision(r.line.id, { mod, text, ...(d.kind === 'matter' ? { matter: Number(d.id) } : { need: d.id }) });
      }
      onDone();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <>
    {d.kind === 'matter' && (d.facts?.length || d.options_text?.length || d.materials?.length) ?
      <details className="dc-facts"><summary><span className="dc-q em-bar" data-tone="warn">{modelText(d.title)}</span><span className="dc-read"><Icon n="right" size={12} />{tr('查看事实')}</span></summary>
        <span className="dc-k">{[d.mod && PART[d.mod]?.name, trx(d.who), d.since && ago(d.since)].filter(Boolean).join(' · ')}</span>
        <MatterFacts facts={d.facts} options={d.options_text} choose={fill} /><Materials seq={r.line.seq} items={d.materials} /></details>
      : <p className="dc-q em-bar" data-tone="warn">{modelText(d.title)}</p>}
    <form className="rec-answer kumo-ui" onSubmit={save}>
      <Textarea className={text ? 'em-bar' : undefined} ref={input} aria-label={tr('写下决定')} placeholder={tr('写下你的决定')} size="sm" autoResize rows={1}
        value={text} onChange={e => setText(e.target.value)} disabled={busy} />
      <div className="rec-actions">
        {d.kind === 'need' && (d.write || d.mod) && <ModSelect compact value={mod} onChange={setMod} disabled={busy} />}
        <button type="submit" className={ready ? 'btn pri' : 'btn'} disabled={!ready}>{tr('定下来')}</button>
      </div>
      {error && <p className="dc-err em-state" data-tone="bad" role="alert">{error}</p>}
    </form>
  </>;
}

type BtnProps = { kumo: boolean; main?: boolean; disabled?: boolean; onClick?: () => void; type?: 'submit' | 'button'; children: React.ReactNode };
function Btn({ kumo, main, children, type = 'button', ...p }: BtnProps) {
  return kumo ? <Button size="sm" variant={main ? 'primary' : 'secondary'} type={type} {...p}>{children}</Button>
    : <button className={`btn${main ? ' pri' : ''}`} type={type} {...p}>{children}</button>;
}

function Item({ d, r, kumo, onDone }: { d: CardDecision; r: ProjectCard; kumo: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [writing, setWriting] = useState(d.free && !d.options.length);
  const [text, setText] = useState('');
  const [what, ic] = KIND[d.kind];
  async function pick(value: CardDecision['options'][number]['value'] | null, words?: string) {
    if (busy) return;
    setBusy(true); setErr('');
    try {
      await api.decideCard(r.line.id, { kind: d.kind, id: d.id, agent: d.agent, value, text: words });
      onDone();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  const off = busy || !d.ready;
  const label = (o: CardDecision['options'][number]) => (d.act && o.value === '可以' ? tr('允许') : d.act && o.value === '不可以' ? tr('拒绝') :
    d.kind === 'ask' || d.kind === 'prompt' ? o.label : FIXED[o.label] ?? o.label);
  return (
    <li className={`dc-item k-${d.kind}`}>
      <span className="dc-k"><Icon n={ic} size={12} />{[trx(d.who), what, d.since && ago(d.since)].filter(Boolean).join(' · ')}</span>
      <p className="dc-q em-bar" data-tone="warn">{question(d)}</p>
      {d.detail && <pre className="dc-d">{d.detail}</pre>}
      {d.options.length > 0 && (
        <div className={`dc-opts${d.kind === 'prompt' ? ' dc-col' : ''}`}>
          {d.options.map((o, i) => (
            <Btn key={i} kumo={kumo} main={kumo && o.main && d.kind !== 'prompt'} disabled={off} onClick={() => pick(o.value)}>
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
          {kumo ? <Input className={text ? 'em-bar' : undefined} autoFocus size="sm" aria-label={tr('写给它的回答')} value={text} maxLength={2000} disabled={busy} placeholder={tr('写给它的回答')} onChange={e => setText(e.target.value)} />
            : <input className={text ? 'em-bar' : undefined} autoFocus value={text} maxLength={2000} disabled={busy} placeholder={tr('写给它的回答')} onChange={e => setText(e.target.value)} />}
          <Btn kumo={kumo} main={kumo} type="submit" disabled={busy || !text.trim()}>{tr('发送')}</Btn>
        </form>
      )}
      {d.later && <p className="dc-note">{tr('负责人没在运行，这个决定会在下次请它更新卡片时一并交给它')}</p>}
      {err && <p className="dc-err em-state" data-tone="bad">{err}</p>}
    </li>
  );
}
