// The workbench (layout B) as a drawer: chat with the town's workers, the active paper's
// line, and the trace of every skill / MCP / RAG / LLM call.

import { useEffect, useRef, useState } from 'react';
import { api, fileUrl, listen, type Line, type Llm, type Message, type Placement, type TraceRow } from '../api';
import { Ava, ROLE_NAMES } from '../art';
import { tr } from '../i18n';

export type Composer = { kind: 'idea' } | { kind: 'ask'; building: string; name: string } | { kind: 'adjust'; lineId: string };
export type Tab = 'chat' | 'line' | 'trace';

interface Props {
  open: boolean;
  tab: Tab;
  onTab: (t: Tab) => void;
  onClose: () => void;
  messages: Message[];
  trace: TraceRow[];
  lines: Line[];
  placements: Placement[];
  composer: Composer;
  setComposer: (c: Composer) => void;
  focusKey: number;
  busy: boolean;
  onSend: (text: string, budget: number) => Promise<void>;
  onHatch: (lineId: string) => void;
  onOpen: (id: string) => void;
}

const BUDGETS = [0.5, 1, 2];

export function traceRow(t: TraceRow) {
  return (
    <div className="tr" key={t.id} title={t.ts}>
      <span className={`k k-${t.kind.toLowerCase()}`}>{t.kind}</span><code>{t.label}</code><em>{t.detail}</em>
    </div>
  );
}

function Who({ m, placements }: { m: Message; placements: Placement[] }) {
  const w = m.worker;
  const at = placements.find(p => p.id === (m.body?.from ?? ''));
  if (!w) return <div className="who"><b>Papertown</b>{m.kind === 'error' && <span className="chip bad">{tr('出错')}</span>}</div>;
  return (
    <div className="who">
      <Ava role={w.role} level={w.level} code={w.id} />
      <b>{ROLE_NAMES[w.role]} {w.id}</b>
      {m.kind === 'report' ? <span className="chip ok">{tr('撞车报告')}</span> : at ? <span className="chip">{at.name}</span> : null}
    </div>
  );
}

const VERDICT_CHIP: Record<string, string> = { 可孵化: 'ok', 需调整: 'warn', 已被做过: 'bad' };

function Report({ m, line, onHatch, onAdjust }: { m: Message; line?: Line; onHatch: () => void; onAdjust: () => void }) {
  const r = m.body.report ?? {};
  const waiting = line?.status === 'waiting' && line.verdict === r.verdict;
  return (
    <>
      <p>{tr('检索了图书馆')} {tr('{0} 篇、arXiv', r.sources?.library ?? 0)} {tr('{0} 篇，最接近的工作：', r.sources?.arxiv ?? 0)}</p>
      {r.similar?.length ? (
        <ul className="sim">
          {r.similar.map((x: any) => (
            <li key={x.paper_id} title={x.note}>
              <a href={x.url} target="_blank" rel="noreferrer">{x.title}</a>
              <i style={{ ['--v' as any]: x.similarity }} /><b>{Number(x.similarity).toFixed(2)}</b>
            </li>
          ))}
        </ul>
      ) : <p className="muted">{tr('没有检索到相近的工作。')}</p>}
      <p className="verdict"><span className={`chip ${VERDICT_CHIP[r.verdict] ?? ''}`}>{r.verdict}</span>{r.gap}</p>
      {r.suggestions?.length > 0 && <ul className="sugg">{r.suggestions.map((s: string) => <li key={s}>{s}</li>)}</ul>}
      {waiting && (
        <div className="btns">
          <button className="btn pri" onClick={onHatch}>{tr('孵化并立项')}</button>
          <button className="btn" onClick={onAdjust}>{tr('调整 idea')}</button>
        </div>
      )}
      <div className="cost">
        {m.body.steps} {tr('步 · $')}{Number(m.body.cost ?? 0).toFixed(4)} {tr('· skills：')}{(m.body.skills ?? []).join(', ') || '—'} {tr('· 检索方式')} {r.sources?.method}
        {m.body.degraded && <> · <span className="warn-t">{m.body.degraded}</span></>}
        {r.verdict_note && <> · {r.verdict_note}</>}
      </div>
    </>
  );
}

function Bubble({ m, lines, placements, onHatch, onAdjust, onOpen }: {
  m: Message; lines: Line[]; placements: Placement[]; onHatch: (id: string) => void; onAdjust: (id: string) => void; onOpen: (id: string) => void;
}) {
  if (m.role === 'user') return <div className="msg mine">{m.body.to ? `@${placements.find(p => p.id === m.body.to)?.name ?? m.body.to} ` : ''}{m.body.text}</div>;
  const line = lines.find(l => l.id === m.line_id);
  return (
    <div className={`msg bot${m.kind === 'error' ? ' err' : ''}`}>
      <Who m={m} placements={placements} />
      {m.kind === 'report'
        ? <Report m={m} line={line} onHatch={() => onHatch(m.line_id!)} onAdjust={() => onAdjust(m.line_id!)} />
        : <p>{m.body.text}</p>}
      {m.kind === 'team' && m.body.mill && <div className="btns"><button className="btn pri" onClick={() => onOpen(m.body.mill)}>{tr('去造纸厂')}</button></div>}
      {m.kind === 'paper' && m.line_id && (
        <div className="btns">
          {(m.body.files ?? []).filter((f: string) => f !== 'refs.bib').map((f: string) => (
            <a key={f} className={`btn${f === 'main.pdf' ? ' pri' : ''}`} href={fileUrl(m.line_id!, f)} target="_blank" rel="noreferrer">{f}</a>
          ))}
        </div>
      )}
    </div>
  );
}

function LinePane({ lines, placements, onOpen }: { lines: Line[]; placements: Placement[]; onOpen: (id: string) => void }) {
  const [sel, setSel] = useState<string | null>(null);
  const line = lines.find(l => l.id === sel) ?? lines.find(l => ['running', 'hatching', 'waiting', 'paused'].includes(l.status)) ?? lines[0];
  if (!line) return <div className="pane-pad"><p className="muted">{tr('还没有论文在生产。到「对话」里写下一个 idea。')}</p></div>;
  const name = (id: string) => placements.find(p => p.id === id)?.name ?? id;
  return (
    <div className="pane-pad">
      {lines.length > 1 && (
        <select className="line-pick" value={line.id} onChange={e => setSel(e.target.value)}>
          {lines.map(l => <option key={l.id} value={l.id}>#{l.seq} {l.title}</option>)}
        </select>
      )}
      <h5>#{line.seq} · {line.title}</h5>
      <p className="muted small">{line.idea}</p>
      <ol className="steps">
        {line.stages.map((s, i) => (
          <li key={s.key} className={s.status === 'wait' ? 'run' : s.status} onClick={() => onOpen(s.building)}>
            <i>{i + 1}</i><b>{s.name}{s.status === 'wait' ? tr(' · 等你决定') : s.status === 'run' && s.pct ? ` · ${s.pct}%` : ''}</b>
            <span>{name(s.building)}</span>
          </li>
        ))}
      </ol>
      {line.reason && <p className="muted small" style={{ marginTop: 10 }}>{tr('编队：')}{line.reason}</p>}
      <p className="muted small">{tr('已花 $')}{line.spent.toFixed(4)} / ${line.budget.toFixed(2)}{line.note ? ` · ${line.note}` : ''}</p>
    </div>
  );
}

// which provider and models the town's workers use; switching lasts until the server restarts
// the town's own model: provider, the strong and the cheap model, effort (in the drawer and in settings)
export function LlmForm({ llm, onDone }: { llm: Llm; onDone: (l: Llm | null) => void }) {
  const [draft, setDraft] = useState({ provider: llm.provider, model_strong: llm.model_strong, model_cheap: llm.model_cheap, effort: llm.effort });
  const [err, setErr] = useState('');
  const pv = llm.providers.find(x => x.id === draft.provider);
  async function apply() {
    try {
      const changed = draft.provider !== llm.provider;
      let out = await api.setLlm(changed ? { provider: draft.provider } : draft);
      if (changed && (draft.model_strong || draft.model_cheap)) out = await api.setLlm({ model_strong: draft.model_strong, model_cheap: draft.model_cheap, effort: draft.effort });
      onDone(out);
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <div className="llm-form">
      <label className="field">{tr('供应商')}
        <select value={draft.provider} onChange={e => {
          const id = e.target.value, d = llm.providers.find(x => x.id === id);
          setDraft(x => ({ ...x, provider: id, model_strong: d?.models[0] ?? '', model_cheap: d?.models[d.models.length > 2 ? 2 : 0] ?? '' }));
        }}>
          {llm.providers.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </label>
      <label className="field">{tr('强模型（Lv.3 以上的员工、最终回答）')}
        <input list="llm-models" value={draft.model_strong} onChange={e => setDraft(x => ({ ...x, model_strong: e.target.value }))} />
      </label>
      <label className="field">{tr('便宜模型（其余员工）')}
        <input list="llm-models" value={draft.model_cheap} onChange={e => setDraft(x => ({ ...x, model_cheap: e.target.value }))} />
      </label>
      <datalist id="llm-models">{pv?.models.map(m => <option key={m} value={m} />)}</datalist>
      {draft.provider === 'anthropic' && (
        <label className="field">effort
          <select value={draft.effort} onChange={e => setDraft(x => ({ ...x, effort: e.target.value }))}>
            {['low', 'medium', 'high', 'xhigh', 'max'].map(x => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
      )}
      <p className="muted small">{tr('key 照旧从环境变量读取。切换只在这次运行里有效，重启服务后按环境变量重新决定。')}{draft.provider === 'openai' ? tr(' 接口：{0}', llm.openai_base_url) : ''}</p>
      {err && <p className="warn-box small">{err}</p>}
      <div className="btns"><button className="btn pri" onClick={apply}>{tr('应用')}</button><button className="btn" onClick={() => onDone(null)}>{tr('取消')}</button></div>
    </div>
  );
}

function LlmSwitch({ shown }: { shown: boolean }) {
  const [llm, setLlm] = useState<Llm | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (!shown) setOpen(false); }, [shown]); // closing the drawer folds the picker too

  useEffect(() => { api.llm().then(setLlm).catch(() => {}); }, []);
  useEffect(() => listen(e => { if (e.type === 'llm') setLlm(e.llm); }), []);
  if (!llm) return null;

  const name = llm.providers.find(x => x.id === llm.provider)?.name ?? llm.provider;
  return (
    <div className="llm-switch">
      <button className={`llm-btn${open ? ' on' : ''}`} onClick={() => setOpen(o => !o)} title={tr('员工用的模型')}>{name} · {llm.model_strong}</button>
      {open && (
        <div className="llm-pop pnl">
          <LlmForm key={`${llm.provider}:${llm.model_strong}:${llm.model_cheap}`} llm={llm} onDone={l => { if (l) setLlm(l); setOpen(false); }} />
        </div>
      )}
    </div>
  );
}

export function Drawer(p: Props) {
  const chat = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [budget, setBudget] = useState(1);
  const [sending, setSending] = useState(false);

  useEffect(() => { chat.current?.scrollTo({ top: chat.current.scrollHeight }); }, [p.messages.length, p.open, p.tab, p.busy]);
  useEffect(() => {
    if (p.focusKey) setTimeout(() => input.current?.focus(), 280);
  }, [p.focusKey]);
  useEffect(() => {
    if (p.composer.kind === 'adjust') {
      const ln = p.lines.find(l => l.id === (p.composer as { lineId: string }).lineId);
      if (ln) setText(ln.idea);
    }
  }, [p.composer]);

  async function send() {
    const v = text.trim();
    if (!v || sending) return;
    setSending(true);
    try {
      await p.onSend(v, budget);
      setText('');
    } finally {
      setSending(false);
    }
  }

  const c = p.composer;
  const placeholder = c.kind === 'ask' ? tr('问问{0}的员工…', c.name) : c.kind === 'adjust' ? tr('改写你的 idea，孵化员会重新查重…')
    : tr('写下你的 idea，孵化员会先帮你查重…');
  return (
    <aside className="p-drawer pnl" data-show={p.tab}>
      <div className="bench-tabs">
        {(['chat', 'line', 'trace'] as Tab[]).map(t => (
          <a key={t} className={p.tab === t ? 'on' : ''} onClick={() => p.onTab(t)}>{{ chat: tr('对话'), line: tr('流水线'), trace: tr('调用轨迹') }[t]}</a>
        ))}
        <LlmSwitch shown={p.open} />
        <button className="bench-x" title={tr('收起 Esc')} onClick={p.onClose}>×</button>
      </div>
      <div className="bench-pane" data-pane="chat">
        <div className="chat" ref={chat}>
          {p.messages.length === 0 && <div className="msg bot"><p>{tr('这里是 Papertown。写下一个研究 idea，孵化员会去图书馆和 arXiv 查重，再决定要不要建一座造纸厂。')}</p></div>}
          {p.messages.map(m => (
            <Bubble key={m.id} m={m} lines={p.lines} placements={p.placements} onHatch={p.onHatch} onOpen={p.onOpen}
              onAdjust={id => p.setComposer({ kind: 'adjust', lineId: id })} />
          ))}
          {p.busy && <div className="msg bot"><span className="typing"><i /><i /><i /></span></div>}
        </div>
      </div>
      <div className="bench-pane" data-pane="line"><LinePane lines={p.lines} placements={p.placements} onOpen={p.onOpen} /></div>
      <div className="bench-pane" data-pane="trace">
        <div className="pane-pad">
          <h5>{tr('最近的调用')}</h5>
          <div className="trace-rows">{p.trace.length ? [...p.trace].reverse().map(traceRow) : <p className="muted">{tr('还没有调用。')}</p>}</div>
        </div>
      </div>
      {c.kind !== 'idea' && (
        <div className="mode">
          <span className="chip pri">{c.kind === 'ask' ? tr('问 {0}', c.name) : tr('调整 idea')}</span>
          <button className="bench-x" onClick={() => { p.setComposer({ kind: 'idea' }); setText(''); }} title={tr('改回写新 idea')}>×</button>
        </div>
      )}
      <div className="composer">
        <input ref={input} value={text} placeholder={placeholder} onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) send(); }} />
        {c.kind === 'idea' && (
          <select className="budget" value={budget} onChange={e => setBudget(Number(e.target.value))} title={tr('这篇论文的预算')}>
            {BUDGETS.map(b => <option key={b} value={b}>${b.toFixed(2)}</option>)}
          </select>
        )}
        <button className="btn pri" onClick={send} disabled={sending}>{sending ? tr('发送中') : tr('发送')}</button>
      </div>
    </aside>
  );
}
