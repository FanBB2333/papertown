// A decision is immutable. Rewriting it creates a successor and keeps both records.
import { Button, Dialog, Select, Textarea } from '@cloudflare/kumo';
import { useState } from 'react';
import { api, type Decision, type Line, type ProjectCard, type Work } from '../api';
import { Icon } from '../console/icons';
import { usePanelNote } from '../console/page';
import { useFetch } from '../console/util';
import { FLOW, PART, type FlowPart } from '../flow';
import { tr, trx } from '../i18n';
import { conversationPath, decidedPath, go, jobPath, provPath, query } from '../route';
import { loopPath } from './loop';
import { DecisionNumbers, DetailHeading, Materials, MatterFacts, ModSelect, ReadState, RecordLink, RecordPage, Stamp, useRecordTick } from './Records';

const SOURCE = { idea: tr('立项想法'), written: tr('直接写下'), answer: tr('回答事项'), chat: tr('对话原文') };
const STATE = { active: tr('有效'), replaced: tr('已取代'), withdrawn: tr('已撤回') };
const WORK = { job: tr('实验'), output: tr('工序产出'), tell: tr('派活'), task: tr('任务'), prov: tr('溯源记录') };

function WorkList({ seq, items, line, decision }: { seq: number; items: Work[]; line: Line | null; decision?: string }) {
  const work = items.filter(w => w?.id != null && w.kind in WORK);
  if (!work.length) return <p className="small muted">{tr('暂无工作记录')}</p>;
  return <ul className="rec-work">{work.map(w => {
    const id = String(w.id);
    let to: string;
    switch (w.kind) {
      case 'job': to = jobPath(seq, id); break;
      case 'prov': to = provPath(seq, { node: id }); break;
      case 'task': to = loopPath(seq, id.replace(/^#/, '')); break;
      case 'tell': to = conversationPath(seq, { event: id, at: w.at ?? undefined, decision }); break;
      case 'output': {
        const stage = line?.items?.find(item => item.id === id)?.stage;
        to = loopPath(seq, stage ? `stage:${stage}` : undefined);
        break;
      }
    }
    return <li key={`${w.kind}:${id}`}><RecordLink to={to}><span className="rec-meta">{WORK[w.kind]}</span>
      <span>{w.title || id}</span><small>{trx(w.who)} <Stamp compact at={w.at} /></small><Icon n="right" size={12} /></RecordLink></li>;
  })}</ul>;
}

function DecisionForm({ line, decisions, rewrite, onClose, onSaved }: {
  line: string; decisions: Decision[]; rewrite?: Decision; onClose: () => void; onSaved: (d: Decision) => void;
}) {
  const [mod, setMod] = useState<FlowPart>(rewrite?.mod ?? 'overview');
  const [text, setText] = useState(rewrite?.text ?? ''), [replaces, setReplaces] = useState(rewrite?.id ?? '');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true); setError('');
    try { onSaved(await api.writeDecision(line, { mod, text, ...(replaces ? { replaces } : {}) })); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose(); }}><Dialog size="base" className="st-dlg rec-dialog">
    <Dialog.Title>{rewrite ? tr('改写决定') : tr('写下决定')}</Dialog.Title>
    <form onSubmit={save}>
      <div className="rec-fields"><ModSelect value={mod} onChange={setMod} disabled={busy} />
        <Select label={tr('取代的决定')} size="sm" value={replaces} disabled={busy}
          items={{ '': tr('单独成条'), ...Object.fromEntries(decisions.filter(d => d.state === 'active').map(d => [d.id, `D${d.n} · ${d.text?.slice(0, 40) ?? ''}`])) }}
          onValueChange={v => setReplaces(String(v ?? ''))} /></div>
      <Textarea className={text ? 'em-bar' : undefined} autoFocus label={tr('决定原文')} rows={5} value={text} disabled={busy} onChange={e => setText(e.target.value)} />
      {error && <p className="dc-err em-state" data-tone="bad" role="alert">{error}</p>}
      <div className="rec-actions"><Button type="button" onClick={onClose} disabled={busy}>{tr('取消')}</Button>
        <Button type="submit" variant="primary" disabled={!text.trim() || busy}>{tr('定下来')}</Button></div>
    </form>
  </Dialog></Dialog.Root>;
}

function DecisionDetail({ line, seq, id, tick, all, project, rewrite, changed }: {
  line: string; seq: number; id: string; tick: number; all: Decision[]; project: Line | null; rewrite: (d: Decision) => void; changed: () => void;
}) {
  const { data: d, err, reload } = useFetch(() => api.decision(line, id), `${line}/${id}`, tick);
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const number = (key: string) => { const x = all.find(d => d.id === key); return x ? `D${x.n}` : key; };
  async function withdraw() {
    if (busy || !d) return;
    setBusy(true); setError('');
    try { await api.withdrawDecision(line, d.id); setConfirm(false); changed(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <section className="rec-detail" aria-label={tr('决定详情')}>
    <DetailHeading to={decidedPath(seq)}><h2>{d ? <><code>D{d.n}</code> {PART[d.mod]?.name ?? d.mod}</> : tr('决定详情')}</h2></DetailHeading>
    {err || !d ? <ReadState err={err} retry={reload} /> : <>
      <p className="rec-original em-bar" data-tone="info">{d.text}</p>
      <p className="rec-meta"><span>{SOURCE[d.source]}</span>{d.state !== 'active' && <span>{STATE[d.state]}</span>}<Stamp at={d.created_at} />
        {d.ended_at && <span>{tr('结束于')} <Stamp at={d.ended_at} /></span>}</p>
      {d.matter?.question && <section className="rec-section"><h4>{tr('当时的问题')}</h4><p>{d.matter.question}</p></section>}
      <MatterFacts facts={d.matter?.facts} options={d.matter?.options} />
      <Materials seq={seq} items={d.materials?.length ? d.materials : d.matter?.materials} />
      <section className="rec-section"><h4>{tr('照它展开的工作')}</h4><WorkList seq={seq} items={Object.values(d.work ?? {}).flat()} line={project} decision={d.id} /></section>
      {(d.replaces || d.replaced_by) && <div className="rec-meta">
        {d.replaces && <RecordLink to={decidedPath(seq, d.replaces)}>{tr('取代 {0}', number(d.replaces))}</RecordLink>}
        {d.replaced_by && <RecordLink to={decidedPath(seq, d.replaced_by)}>{tr('由 {0} 取代', number(d.replaced_by))}</RecordLink>}
      </div>}
      {d.state === 'active' && <div className="rec-actions"><button className="btn" onClick={() => rewrite(d)}>{tr('改写')}</button>
        <button className="btn" onClick={() => setConfirm(true)}>{tr('撤回')}</button></div>}
      {confirm && <Dialog.Root open onOpenChange={open => { if (!open && !busy) setConfirm(false); }}><Dialog size="sm" className="st-dlg rec-dialog">
        <Dialog.Title>{tr('撤回 D{0}？', d.n)}</Dialog.Title><Dialog.Description>{tr('撤回后，这条决定将保留在历史记录中。')}</Dialog.Description>
        {error && <p className="dc-err em-state" data-tone="bad" role="alert">{error}</p>}
        <div className="rec-actions"><Button disabled={busy} onClick={() => setConfirm(false)}>{tr('取消')}</Button>
          <Button disabled={busy} variant="destructive" onClick={withdraw}>{tr('撤回决定')}</Button></div>
      </Dialog></Dialog.Root>}
    </>}
  </section>;
}

export default function DecidedPage({ r }: { r: ProjectCard }) {
  const { id, seq } = r.line;
  const [tick, reload] = useRecordTick(id, 'decided');
  const { data, err } = useFetch(() => api.decided(id), id, tick);
  const project = useFetch(() => api.line(id), id, tick);
  const [form, setForm] = useState<Decision | 'new' | null>(null);
  const [filter, setFilter] = useState<FlowPart | 'all' | 'loose'>('all');
  const selected = query().get('decision');
  const all = data?.decisions ?? [];
  const selectedDecision = all.find(d => d.id === selected || `D${d.n}` === selected);
  const selectedId = selectedDecision?.id ?? selected;
  const filters: { id: typeof filter; name: string; count: number }[] = [
    { id: 'all', name: tr('全部'), count: all.length },
    ...FLOW.map(p => ({ ...p, count: all.filter(d => d.mod === p.id).length })).filter(p => p.count > 0),
  ];
  if (data?.loose?.length) filters.push({ id: 'loose', name: tr('无据的工作'), count: data.loose.length });
  const current = filters.some(f => f.id === filter) && (!selectedDecision || selectedDecision.mod === filter) ? filter : 'all';
  const list = all.filter(d => current === 'all' || d.mod === current).sort((a, b) =>
    (Date.parse(b.created_at ?? '') || 0) - (Date.parse(a.created_at ?? '') || 0) || b.n - a.n);
  const history = list.filter(d => d.state !== 'active');
  const inHistory = history.some(d => d.id === selectedId);
  usePanelNote('decided', 'decision', { [tr('决定')]: selected });
  const row = (d: Decision) => <RecordLink key={d.id} className="rec-decision" to={decidedPath(seq, d.id)} aria-current={d.id === selectedId ? 'true' : undefined}>
    <span className="rec-decision-id"><code>D{d.n}</code><span>{PART[d.mod]?.name ?? d.mod}</span></span>
    <span className="rec-excerpt user-words em-bar" data-tone="info">{d.text}</span><Stamp compact at={d.created_at} />
  </RecordLink>;
  return <RecordPage r={r} title={tr('你的决定')} stats={<DecisionNumbers stats={data?.stats ?? r.decided} />} listPath={selectedId ? decidedPath(seq) : undefined}
    actions={<button className="btn pri" onClick={() => setForm('new')}><Icon n="compose" size={15} />{tr('写下决定')}</button>}>
    {(err || !data) && <ReadState err={err} retry={reload} />}
    {data && (all.length > 0 || !!data.loose?.length) && <nav className="rec-tabs" aria-label={tr('筛选分项')}>{filters.map(f =>
      <button key={f.id} aria-pressed={current === f.id} onClick={() => { setFilter(f.id); if (selectedId) go(decidedPath(seq)); }}>
        {f.name}{f.count > 0 && <span>{f.count}</span>}
      </button>)}</nav>}
    <div className="rec-layout">
    {data && <section className="rec-index" aria-label={tr('你的决定')}>
      {current === 'loose' ? <WorkList seq={seq} items={data.loose} line={project.data} /> : <>
        {list.filter(d => d.state === 'active').map(row)}
        {!!history.length && <details className="rec-history" key={`${current}/${inHistory}`} open={inHistory || undefined}>
          <summary><Icon n="right" size={13} />{tr('已取代和撤回（{0}）', history.length)}</summary>{history.map(row)}</details>}
        {!list.length && <p className="rec-empty">{tr('暂无决定')}</p>}
      </>}
    </section>}
    {selectedId && (data || !/^D\d+$/i.test(selectedId)) && <DecisionDetail key={selectedId} id={selectedId} line={id} seq={seq} all={all}
      tick={tick} project={project.data} rewrite={setForm} changed={reload} />}
    </div>
    {form && <DecisionForm line={id} decisions={all} rewrite={form === 'new' ? undefined : form} onClose={() => setForm(null)}
      onSaved={d => { setForm(null); setFilter('all'); reload(); if (d?.id) go(decidedPath(seq, d.id)); }} />}
  </RecordPage>;
}

