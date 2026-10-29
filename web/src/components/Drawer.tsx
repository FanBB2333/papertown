// The workbench (layout B) as a drawer: chat with the town's workers, the active paper's
// line, and the trace of every skill / MCP / RAG / LLM call.

import { useEffect, useRef, useState } from 'react';
import { fileUrl, type Line, type Message, type Placement, type TraceRow } from '../api';
import { Ava, ROLE_NAMES } from '../art';

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
  if (!w) return <div className="who"><b>Papertown</b>{m.kind === 'error' && <span className="chip bad">出错</span>}</div>;
  return (
    <div className="who">
      <Ava role={w.role} level={w.level} code={w.id} />
      <b>{ROLE_NAMES[w.role]} {w.id}</b>
      {m.kind === 'report' ? <span className="chip ok">撞车报告</span> : at ? <span className="chip">{at.name}</span> : null}
    </div>
  );
}

const VERDICT_CHIP: Record<string, string> = { 可孵化: 'ok', 需调整: 'warn', 已被做过: 'bad' };

function Report({ m, line, onHatch, onAdjust }: { m: Message; line?: Line; onHatch: () => void; onAdjust: () => void }) {
  const r = m.body.report ?? {};
  const waiting = line?.status === 'waiting' && line.verdict === r.verdict;
  return (
    <>
      <p>检索了图书馆 {r.sources?.library ?? 0} 篇、arXiv {r.sources?.arxiv ?? 0} 篇，最接近的工作：</p>
      {r.similar?.length ? (
        <ul className="sim">
          {r.similar.map((x: any) => (
            <li key={x.paper_id} title={x.note}>
              <a href={x.url} target="_blank" rel="noreferrer">{x.title}</a>
              <i style={{ ['--v' as any]: x.similarity }} /><b>{Number(x.similarity).toFixed(2)}</b>
            </li>
          ))}
        </ul>
      ) : <p className="muted">没有检索到相近的工作。</p>}
      <p className="verdict"><span className={`chip ${VERDICT_CHIP[r.verdict] ?? ''}`}>{r.verdict}</span>{r.gap}</p>
      {r.suggestions?.length > 0 && <ul className="sugg">{r.suggestions.map((s: string) => <li key={s}>{s}</li>)}</ul>}
      {waiting && (
        <div className="btns">
          <button className="btn pri" onClick={onHatch}>孵化并立项</button>
          <button className="btn" onClick={onAdjust}>调整 idea</button>
        </div>
      )}
      <div className="cost">
        {m.body.steps} 步 · ${Number(m.body.cost ?? 0).toFixed(4)} · skills：{(m.body.skills ?? []).join(', ') || '—'} · 检索方式 {r.sources?.method}
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
      {m.kind === 'team' && m.body.mill && <div className="btns"><button className="btn pri" onClick={() => onOpen(m.body.mill)}>去造纸厂</button></div>}
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
  if (!line) return <div className="pane-pad"><p className="muted">还没有论文在生产。到「对话」里写下一个 idea。</p></div>;
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
            <i>{i + 1}</i><b>{s.name}{s.status === 'wait' ? ' · 等你决定' : s.status === 'run' && s.pct ? ` · ${s.pct}%` : ''}</b>
            <span>{name(s.building)}</span>
          </li>
        ))}
      </ol>
      {line.reason && <p className="muted small" style={{ marginTop: 10 }}>编队：{line.reason}</p>}
      <p className="muted small">已花 ${line.spent.toFixed(4)} / ${line.budget.toFixed(2)}{line.note ? ` · ${line.note}` : ''}</p>
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
  const placeholder = c.kind === 'ask' ? `问问${c.name}的员工…` : c.kind === 'adjust' ? '改写你的 idea，孵化员会重新查重…'
    : '写下你的 idea，孵化员会先帮你查重…';
  return (
    <aside className="p-drawer pnl" data-show={p.tab}>
      <div className="bench-tabs">
        {(['chat', 'line', 'trace'] as Tab[]).map(t => (
          <a key={t} className={p.tab === t ? 'on' : ''} onClick={() => p.onTab(t)}>{{ chat: '对话', line: '流水线', trace: '调用轨迹' }[t]}</a>
        ))}
        <button className="bench-x" title="收起 Esc" onClick={p.onClose}>×</button>
      </div>
      <div className="bench-pane" data-pane="chat">
        <div className="chat" ref={chat}>
          {p.messages.length === 0 && <div className="msg bot"><p>这里是 Papertown。写下一个研究 idea，孵化员会去图书馆和 arXiv 查重，再决定要不要建一座造纸厂。</p></div>}
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
          <h5>最近的调用</h5>
          <div className="trace-rows">{p.trace.length ? [...p.trace].reverse().map(traceRow) : <p className="muted">还没有调用。</p>}</div>
        </div>
      </div>
      {c.kind !== 'idea' && (
        <div className="mode">
          <span className="chip pri">{c.kind === 'ask' ? `问 ${c.name}` : '调整 idea'}</span>
          <button className="bench-x" onClick={() => { p.setComposer({ kind: 'idea' }); setText(''); }} title="改回写新 idea">×</button>
        </div>
      )}
      <div className="composer">
        <input ref={input} value={text} placeholder={placeholder} onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) send(); }} />
        {c.kind === 'idea' && (
          <select className="budget" value={budget} onChange={e => setBudget(Number(e.target.value))} title="这篇论文的预算">
            {BUDGETS.map(b => <option key={b} value={b}>${b.toFixed(2)}</option>)}
          </select>
        )}
        <button className="btn pri" onClick={send} disabled={sending}>{sending ? '发送中' : '发送'}</button>
      </div>
    </aside>
  );
}
