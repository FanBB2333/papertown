// A project's memory from before Papertown: agent conversations and notes found in its repositories
// on this machine, imported on request and searched by questions and the agents (pt recall).

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, listen, type MemoryFound, type MemoryFull, type MemoryItem, type MemorySource } from '../api';
import { Icon } from '../console/icons';
import { ago, bytes } from '../console/util';
import { tr } from '../i18n';

const SOURCE: Record<MemorySource, string> = { claude: 'Claude Code', codex: 'Codex', 'claude-memory': tr('Claude 记忆'), repo: tr('仓库说明') };
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
    if (!confirm(tr('从此项目中移除「{0}」？仅删除 Papertown 导入的副本，原对话保持不变。', m.title))) return;
    try { await api.memoryRemove(lineId, m.id); load(); } catch (e) { toast((e as Error).message); }
  }
  const sessions = (items ?? []).filter(m => m.kind === 'session'), notes = (items ?? []).filter(m => m.kind === 'note');
  return (
    <section className="psec" id="memory">
      <header className="psec-h">
        <h3><Icon n="chat" size={16} />{tr('记忆')}</h3>
        <span className="muted small">{tr('历史 agent 对话与笔记，提问时将一并检索')}</span>
        <button className="btn" onClick={() => setImporting(true)}><Icon n="plus" size={14} />{tr('从本机导入…')}</button>
      </header>
      {!items ? <p className="muted small">{tr('加载中…')}</p> : !items.length ? (
        <p className="psec-empty muted">{tr('尚未导入。Papertown 将在本机查找该项目代码与论文仓库中的 Claude Code、Codex 对话、Claude Code 记忆及 CLAUDE.md、AGENTS.md。')}</p>
      ) : (
        <div className="mem-cols">
          {([[tr('对话'), sessions], [tr('笔记'), notes]] as [string, MemoryItem[]][]).filter(([, xs]) => xs.length).map(([name, xs]) => (
            <div key={name}>
              <h4 className="mem-h">{name} <span className="muted">{xs.length}</span></h4>
              <ul className="mem-list">
                {xs.map(m => (
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

function Overlay({ label, className, onClose, children }: { label: string; className: string; onClose: () => void; children: React.ReactNode }) {
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

function ImportDialog({ lineId, toast, onClose, onDone }: { lineId: string; toast: (t: string) => void; onClose: () => void; onDone: () => void }) {
  const [scan, setScan] = useState<Awaited<ReturnType<typeof api.memoryScan>> | null>(null);
  const [err, setErr] = useState('');
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.memoryScan(lineId).then(s => {
      setScan(s);
      setPick(new Set(s.found.filter(x => !x.imported || x.changed).map(x => x.key)));
    }, e => setErr((e as Error).message));
  }, [lineId]);
  const groups = useMemo(() => (scan?.roots ?? []).map(r => ({ ...r, items: scan!.found.filter(x => x.repo === r.repo) })), [scan]);
  const toggle = (keys: string[], on: boolean) => setPick(p => { const s = new Set(p); for (const k of keys) { if (on) s.add(k); else s.delete(k); } return s; });

  async function run() {
    setBusy(true);
    try {
      const r = await api.memoryImport(lineId, [...pick]);
      toast(r.failed.length ? tr('已导入 {0} 项，{1} 项失败：{2}', r.imported.length, r.failed.length, r.failed[0].why) : tr('已导入 {0} 项。提问时将一并检索。', r.imported.length));
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
        <p className="small muted">{tr('仅导入对话内容（你的提问与 agent 的回复），跳过工具调用、思考过程与自动注入的上下文，密钥和 token 将脱敏，原文件保持不变。')}</p>
        {err && <p className="warn-box small">{err}</p>}
        {!scan && !err && <p className="muted">{tr('查找中…')}</p>}
        {scan && !scan.roots.length && <p className="muted">{tr('该项目暂无代码或论文仓库。')}</p>}
        {groups.map(g => (
          <section key={g.repo} className="mem-g">
            <header>
              <b>{REPO[g.repo]}</b><code className="small">{g.path}</code>
              {g.items.length > 0 && (
                <label className="small"><input type="checkbox" checked={g.items.every(x => pick.has(x.key))}
                  onChange={e => toggle(g.items.map(x => x.key), e.target.checked)} />{tr('全选')}</label>
              )}
            </header>
            {!g.items.length ? <p className="muted small">{tr('未找到该仓库中的 agent 对话或记忆。')}</p> : (
              <ul className="mem-pick">
                {g.items.map(x => <Found key={x.key} x={x} on={pick.has(x.key)} toggle={on => toggle([x.key], on)} />)}
              </ul>
            )}
          </section>
        ))}
        {scan && (!scan.sources.claude || !scan.sources.codex) && (
          <p className="small muted">{[!scan.sources.claude && tr('本机未找到 Claude Code 对话目录'), !scan.sources.codex && tr('无 Codex 对话目录')].filter(Boolean).join(tr('，'))}</p>
        )}
      </div>
      <footer className="pd-foot">
        <div className="pd-row">
          <span className="small muted">{tr('已选 {0} 项', pick.size)}</span>
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
