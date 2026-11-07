// A project's memory from before Papertown: the conversations agents had in its code and paper
// repositories (Claude Code, Codex) and the notes they kept, found on this machine and imported
// when you pick them. The questions search them, and so do the project's agents (pt recall).
// Importing again brings a conversation that went on since up to date; removing one drops
// Papertown's copy only.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, listen, type MemoryFound, type MemoryFull, type MemoryItem, type MemorySource } from '../api';
import { Icon } from '../console/icons';
import { ago, bytes } from '../console/util';
import { tr } from '../i18n';

export const SOURCE: Record<MemorySource, string> = { claude: 'Claude Code', codex: 'Codex', 'claude-memory': tr('Claude 记忆'), repo: tr('仓库说明') };
const REPO = { code: tr('代码仓库'), paper: tr('论文仓库') };
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '');
const span = (a: string | null, b: string | null) => (day(a) && day(b) && day(a) !== day(b) ? `${day(a)} – ${day(b)}` : day(b) || day(a));

export function MemorySection({ lineId, toast, open }: { lineId: string; toast: (t: string) => void; open: (id: string, msg?: number) => void }) {
  const [items, setItems] = useState<MemoryItem[] | null>(null);
  const [importing, setImporting] = useState(false);
  const load = () => api.memory(lineId).then(r => setItems(r.items)).catch(e => toast((e as Error).message));
  useEffect(() => {
    setItems(null);
    load();
    return listen(e => { if (e.type === 'memory' && e.line_id === lineId) load(); });
  }, [lineId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function remove(m: MemoryItem) {
    if (!confirm(tr('从这个项目里移除「{0}」？只删 Papertown 导入的这一份，原来的对话不动。', m.title))) return;
    try { await api.memoryRemove(lineId, m.id); load(); } catch (e) { toast((e as Error).message); }
  }
  const sessions = (items ?? []).filter(m => m.kind === 'session'), notes = (items ?? []).filter(m => m.kind === 'note');
  return (
    <section className="psec" id="memory">
      <header className="psec-h">
        <h3><Icon n="chat" size={16} />{tr('记忆')}</h3>
        <span className="muted small">{tr('以前的 agent 对话和笔记，提问时会一起检索')}</span>
        <button className="btn" onClick={() => setImporting(true)}><Icon n="plus" size={14} />{tr('从本机导入…')}</button>
      </header>
      {!items ? <p className="muted small">{tr('加载中…')}</p> : !items.length ? (
        <p className="psec-empty muted">{tr('还没有导入。Papertown 会在这台电脑上找这个项目的代码和论文仓库里的 Claude Code、Codex 对话，Claude Code 的记忆，以及仓库里的 CLAUDE.md 和 AGENTS.md。')}</p>
      ) : (
        <div className="mem-cols">
          {[[tr('对话'), sessions], [tr('笔记'), notes]].filter(([, xs]) => (xs as MemoryItem[]).length).map(([name, xs]) => (
            <div key={name as string}>
              <h4 className="mem-h">{name as string} <span className="muted">{(xs as MemoryItem[]).length}</span></h4>
              <ul className="mem-list">
                {(xs as MemoryItem[]).map(m => (
                  <li key={m.id}>
                    <button className="mem-open" onClick={() => open(m.id)}>
                      <b>{m.title}</b>
                      <span className="small muted"><em className={`src s-${m.source}`}>{SOURCE[m.source]}</em>{REPO[m.repo]}
                        {m.kind === 'session' ? ` · ${tr('{0} 条', m.n)} · ${span(m.started, m.ended)}` : ''}</span>
                    </button>
                    <button className="ib mem-x" onClick={() => remove(m)} title={tr('移除')} aria-label={tr('移除')}><Icon n="close" size={13} /></button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {importing && <ImportDialog lineId={lineId} toast={toast} onClose={() => setImporting(false)} onDone={load} />}
    </section>
  );
}

function Overlay({ label, className = '', onClose, children }: { label: string; className?: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); onClose(); } };
    addEventListener('keydown', k, true);
    return () => removeEventListener('keydown', k, true);
  }, [onClose]);
  return createPortal(
    <div className="pd-back" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <section className={`pd ${className}`} role="dialog" aria-modal="true" aria-label={label}>
        <span className="sheet-grip" />
        {children}
      </section>
    </div>,
    document.querySelector('.theme-sketch') ?? document.body,
  );
}

// what there is on this machine, by repository, to pick from
function ImportDialog({ lineId, toast, onClose, onDone }: { lineId: string; toast: (t: string) => void; onClose: () => void; onDone: () => void }) {
  const [scan, setScan] = useState<Awaited<ReturnType<typeof api.memoryScan>> | null>(null);
  const [err, setErr] = useState('');
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.memoryScan(lineId).then(s => {
      setScan(s);
      setPick(new Set(s.found.filter(x => !x.imported || x.changed).map(x => x.key))); // what is new or went on since
    }, e => setErr((e as Error).message));
  }, [lineId]);
  const groups = useMemo(() => (scan?.roots ?? []).map(r => ({ ...r, items: scan!.found.filter(x => x.repo === r.repo) })), [scan]);
  const toggle = (keys: string[], on: boolean) => setPick(p => { const s = new Set(p); for (const k of keys) { if (on) s.add(k); else s.delete(k); } return s; });

  async function run() {
    setBusy(true);
    try {
      const r = await api.memoryImport(lineId, [...pick]);
      toast(r.failed.length ? tr('导入了 {0} 项，{1} 项没成功：{2}', r.imported.length, r.failed.length, r.failed[0].why) : tr('导入了 {0} 项。提问时会一起检索。', r.imported.length));
      onDone();
      onClose();
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Overlay label={tr('从本机导入记忆')} className="mem-dlg" onClose={onClose}>
      <header className="pd-h">
        <span className="pc-name"><h3>{tr('从本机导入记忆')}</h3></span>
        <button className="ib pd-x" onClick={onClose} title={tr('关闭（Esc）')} aria-label={tr('关闭')}><Icon n="close" size={16} /></button>
      </header>
      <div className="pd-body">
        <p className="small muted">{tr('只导入说过的话：你问的和 agent 答的。工具调用、思考过程和自动塞进去的上下文都不要，密钥和 token 会被遮掉。原来的文件不会被改动。')}</p>
        {err && <p className="warn-box small">{err}</p>}
        {!scan && !err && <p className="muted">{tr('正在找…')}</p>}
        {scan && !scan.roots.length && <p className="muted">{tr('这个项目还没有代码或论文仓库。')}</p>}
        {groups.map(g => (
          <section key={g.repo} className="mem-g">
            <header>
              <b>{REPO[g.repo]}</b><code className="small">{g.path}</code>
              {g.items.length > 0 && (
                <label className="small"><input type="checkbox" checked={g.items.every(x => pick.has(x.key))}
                  onChange={e => toggle(g.items.map(x => x.key), e.target.checked)} />{tr('全选')}</label>
              )}
            </header>
            {!g.items.length ? <p className="muted small">{tr('没找到这个仓库里的 agent 对话或记忆。')}</p> : (
              <ul className="mem-pick">
                {g.items.map(x => <Found key={x.key} x={x} on={pick.has(x.key)} toggle={on => toggle([x.key], on)} />)}
              </ul>
            )}
          </section>
        ))}
        {scan && (!scan.sources.claude || !scan.sources.codex) && (
          <p className="small muted">{[!scan.sources.claude && tr('这台电脑上没有 Claude Code 的对话目录'), !scan.sources.codex && tr('没有 Codex 的对话目录')].filter(Boolean).join(tr('，'))}</p>
        )}
      </div>
      <footer className="pd-foot">
        <div className="pd-row">
          <span className="small muted">{tr('选了 {0} 项', pick.size)}</span>
          <div className="btns">
            <button className="btn" onClick={onClose}>{tr('取消')}</button>
            <button className="btn pri" disabled={busy || !pick.size} onClick={run}>{busy ? tr('导入中…') : tr('导入')}</button>
          </div>
        </div>
      </footer>
    </Overlay>
  );
}

function Found({ x, on, toggle }: { x: MemoryFound; on: boolean; toggle: (on: boolean) => void }) {
  return (
    <li className={on ? 'on' : ''}>
      <label>
        <input type="checkbox" checked={on} onChange={e => toggle(e.target.checked)} />
        <span className="mem-t">
          <b>{x.title}</b>
          <span className="small muted">
            <em className={`src s-${x.source}`}>{SOURCE[x.source]}</em>
            {x.kind === 'session' ? `${span(x.started, x.ended)} · ${bytes(x.size)}` : tr('笔记')}
            {x.cwd && x.kind === 'session' && <> · <code>{x.cwd}</code></>}
          </span>
        </span>
        {x.imported && <span className={`mem-tag${x.changed ? ' new' : ''}`}>{x.changed ? tr('有更新') : tr('已导入')}</span>}
      </label>
    </li>
  );
}

// one imported conversation or note, read in full; a message asked for is picked out
export function MemoryViewer({ lineId, id, msg, onClose }: { lineId: string; id: string; msg?: number; onClose: () => void }) {
  const [m, setM] = useState<MemoryFull | null>(null);
  const [err, setErr] = useState('');
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { api.memoryItem(lineId, id).then(setM, e => setErr((e as Error).message)); }, [lineId, id]);
  useEffect(() => {
    if (m && msg != null) requestAnimationFrame(() => body.current?.querySelector(`[data-i="${msg}"]`)?.scrollIntoView({ block: 'center' }));
  }, [m, msg]);
  return (
    <Overlay label={m?.title ?? tr('记忆')} className="mem-view" onClose={onClose}>
      <header className="pd-h">
        <span className="pc-name"><h3>{m?.title ?? '…'}</h3></span>
        <button className="ib pd-x" onClick={onClose} title={tr('关闭（Esc）')} aria-label={tr('关闭')}><Icon n="close" size={16} /></button>
      </header>
      {m && (
        <p className="mem-meta small muted">
          <em className={`src s-${m.source}`}>{SOURCE[m.source]}</em>{REPO[m.repo]}
          {m.kind === 'session' && ` · ${tr('{0} 条', m.n)} · ${span(m.started, m.ended)}`} · {tr('{0}导入', ago(m.imported_at))}
          {m.cwd && <> · <code>{m.cwd}</code></>}
        </p>
      )}
      <div className="pd-body" ref={body}>
        {err && <p className="warn-box small">{err}</p>}
        {!m && !err && <p className="muted">{tr('加载中…')}</p>}
        {m?.text != null && <div className="mem-note">{m.text}</div>}
        {m?.messages && (
          <ol className="mem-chat">
            {m.messages.map((x, i) => (
              <li key={i} data-i={i} className={`${x.role}${msg === i || msg === i - 1 ? ' lit' : ''}`}>
                <span className="small muted">{x.role === 'user' ? tr('你') : SOURCE[m.source]}{x.at ? ` · ${x.at.slice(0, 16).replace('T', ' ')}` : ''}</span>
                <div>{x.text}</div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Overlay>
  );
}
