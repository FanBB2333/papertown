// A project's files as an editor sees them, shared by the code and the paper panels: the tree
// with git's marks, the open files as tabs, and each file's text as read, as edited, as saved.

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type WsEntry, type WsRoot } from '../api';
import { DEMO } from '../demo';
import { tr } from '../i18n';
import type { Doc } from './Editor';
import { openPicker, useLook } from './edthemes';
import { FileIcon, FolderIcon } from './fileicons';
import { Icon } from './icons';
import { base, bytes, ext, revealX, useFetch } from './util';

const Editor = lazy(() => import('./Editor'));

export interface Open {
  path: string; size: number; text: string | null; saved: string | null; rev: number;
  loading: boolean; binary?: boolean; tooBig?: boolean; err?: string;
}
export const isDirty = (o: Open) => o.text != null && o.saved != null && o.text !== o.saved;

export function useFiles(lineId: string, root: WsRoot, tick: number, toast: (t: string) => void) {
  const tree = useFetch(() => api.wsTree(lineId, root), `${lineId}:${root}`, tick);
  const [open, setOpen] = useState<Open[]>([]);
  const [cur, setCur] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const ref = useRef(open);
  ref.current = open;

  const read = useCallback((path: string, again = false) => {
    setOpen(os => {
      const had = os.find(o => o.path === path);
      if (had && !again) return os;
      const stub: Open = { path, size: had?.size ?? 0, text: null, saved: null, rev: (had?.rev ?? 0) + 1, loading: true };
      return had ? os.map(o => (o.path === path ? stub : o)) : [...os, stub];
    });
    api.wsFile(lineId, root, path).then(
      f => setOpen(os => os.map(o => (o.path === path ? { ...o, size: f.size, text: f.text, saved: f.text, loading: false, binary: f.binary, tooBig: f.too_big } : o))),
      e => setOpen(os => os.map(o => (o.path === path ? { ...o, loading: false, err: (e as Error).message } : o))),
    );
  }, [lineId, root]);

  const show = useCallback((path: string) => { read(path); setCur(path); }, [read]);
  const edit = useCallback((path: string, text: string) => setOpen(os => os.map(o => (o.path === path ? { ...o, text } : o))), []);

  // the open files with unsaved changes, written back one by one; false when one of them failed
  const save = useCallback(async (only?: string) => {
    const todo = ref.current.filter(o => isDirty(o) && (!only || o.path === only));
    if (!todo.length) return true;
    if (DEMO) { toast(tr('这是只读的演示，改动不会保存。')); return false; }
    setSaving(true);
    try {
      for (const o of todo) {
        const text = o.text!;
        await api.wsSave(lineId, root, o.path, text);
        setOpen(os => os.map(x => (x.path === o.path ? { ...x, saved: text } : x)));
      }
      tree.reload();
      return true;
    } catch (e) {
      toast((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  }, [lineId, root, toast, tree]);

  const close = useCallback((path: string) => {
    const o = ref.current.find(x => x.path === path);
    if (o && isDirty(o) && !confirm(tr('{0} 还没保存，关掉会丢掉这些修改。', base(path)))) return;
    const i = ref.current.findIndex(x => x.path === path);
    const rest = ref.current.filter(x => x.path !== path);
    setOpen(rest);
    setCur(c => (c === path ? rest[Math.min(i, rest.length - 1)]?.path ?? null : c));
  }, []);

  // read again from disk what has no unsaved changes: an agent may have written to it meanwhile
  const reread = useCallback(() => {
    for (const o of ref.current) if (!isDirty(o)) read(o.path, true);
    tree.reload();
  }, [read, tree]);

  const status = useMemo(() => new Map((tree.data?.files ?? []).map(f => [f.path, f.status])), [tree.data]);
  const dirty = open.filter(isDirty).length;
  return { tree, open, cur, setCur, show, edit, save, close, reread, saving, status, dirty, now: open.find(o => o.path === cur) ?? null };
}
export type Files = ReturnType<typeof useFiles>;

// ---------- the tree ----------

interface Dir { name: string; path: string; dirs: Map<string, Dir>; files: WsEntry[] }

function build(files: WsEntry[]): Dir {
  const top: Dir = { name: '', path: '', dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let d = top;
    for (const p of parts.slice(0, -1)) {
      if (!d.dirs.has(p)) d.dirs.set(p, { name: p, path: d.path ? `${d.path}/${p}` : p, dirs: new Map(), files: [] });
      d = d.dirs.get(p)!;
    }
    d.files.push(f);
  }
  return top;
}

const MARK: Record<string, [string, string]> = {
  modified: ['M', tr('已修改')], added: ['A', tr('新加入暂存')], deleted: ['D', tr('已删除')], renamed: ['R', tr('改了名')], untracked: ['U', tr('未跟踪的新文件')],
};

export function Tree({ files, cur, onOpen, dirty, filter = '', openDirs, root }: {
  files: WsEntry[]; cur: string | null; onOpen: (path: string) => void; dirty: Set<string>; filter?: string; openDirs?: string[];
  root?: WsRoot; // which tree, for the parts of the page the assistant can point at
}) {
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? files.filter(f => f.path.toLowerCase().includes(q)) : files;
  }, [files, filter]);
  const top = useMemo(() => build(shown), [shown]);
  const [opened, setOpened] = useState<Set<string>>(() => new Set(openDirs ?? []));
  // the folders down to the open file open with it
  useEffect(() => {
    if (!cur) return;
    const parts = cur.split('/').slice(0, -1);
    setOpened(s => {
      const n = new Set(s);
      parts.forEach((_, i) => n.add(parts.slice(0, i + 1).join('/')));
      return n.size === s.size ? s : n;
    });
  }, [cur]);
  const toggle = (p: string) => setOpened(s => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  const all = !!filter.trim();
  const { icons } = useLook();

  // a folder is marked when anything inside it is
  const marked = useMemo(() => {
    const m = new Set<string>();
    for (const f of files) if (f.status) { const parts = f.path.split('/'); for (let i = 1; i < parts.length; i++) m.add(parts.slice(0, i).join('/')); }
    return m;
  }, [files]);

  function rows(d: Dir, depth: number): React.ReactNode[] {
    const out: React.ReactNode[] = [];
    for (const sub of [...d.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const on = all || opened.has(sub.path);
      out.push(
        <button key={`d:${sub.path}`} className={`tr-row tr-dir${on ? ' open' : ''}${marked.has(sub.path) ? ' marked' : ''}`} style={{ ['--d' as string]: depth }} onClick={() => toggle(sub.path)}>
          <Icon n="chevron" size={13} className="tr-chev" /><FolderIcon name={sub.name} open={on} theme={icons} /><span className="tr-name">{sub.name}</span>
        </button>,
      );
      if (on) out.push(...rows(sub, depth + 1));
    }
    for (const f of [...d.files].sort((a, b) => base(a.path).localeCompare(base(b.path)))) {
      const m = f.status && MARK[f.status];
      out.push(
        <button key={f.path} className={`tr-row tr-file${f.path === cur ? ' on' : ''}${f.status ? ` st-${f.status}` : ''}`} style={{ ['--d' as string]: depth }}
          onClick={() => onOpen(f.path)} title={`${f.path} · ${bytes(f.size)}`} data-ref={root ? `file:${root}:${f.path}` : undefined} data-ref-label={f.path}>
          <FileIcon path={f.path} theme={icons} /><span className="tr-name">{base(f.path)}</span>
          {dirty.has(f.path) && <i className="tr-dirty" title={tr('还没保存')} />}
          {m && <em className="tr-mark" title={m[1]}>{m[0]}</em>}
        </button>,
      );
    }
    return out;
  }
  return <div className={`tree ic-${icons}`}>{rows(top, 0)}{!shown.length && <p className="muted small tr-none">{filter ? tr('没有匹配的文件。') : tr('这里还没有文件。')}</p>}</div>;
}

// ---------- tabs and the open file ----------

export function Tabs({ f, extra }: { f: Files; extra?: React.ReactNode }) {
  const bar = useRef<HTMLDivElement>(null);
  const { icons } = useLook();
  useEffect(() => revealX(bar.current, bar.current?.querySelector('.tab.on')), [f.cur, f.open.length]);
  return (
    <div className="etabs">
      <div className="tabs-in" ref={bar}>
        {f.open.map(o => (
          <div key={o.path} className={`tab${o.path === f.cur ? ' on' : ''}${isDirty(o) ? ' dirty' : ''}`} title={o.path}
            onClick={() => f.setCur(o.path)} onAuxClick={e => { if (e.button === 1) f.close(o.path); }}>
            <FileIcon path={o.path} theme={icons} />
            <span>{base(o.path)}</span>
            <button className="tab-x" aria-label={tr('关闭')} onClick={e => { e.stopPropagation(); f.close(o.path); }}>
              <i className="tab-dot" /><Icon n="close" size={12} />
            </button>
          </div>
        ))}
      </div>
      <div className="tabs-r">
        {extra}
        <button className="ib" title={tr('颜色主题和文件图标（⌘K ⌘T）')} onClick={() => openPicker('theme')}><Icon n="palette" size={15} /></button>
      </div>
    </div>
  );
}

export function FileView({ f, onRun, onCursor, goto, empty }: {
  f: Files; onRun?: () => void; onCursor?: (ln: number, col: number, picked: string) => void; goto?: { line: number; n: number } | null; empty: React.ReactNode;
}) {
  const o = f.now;
  const doc: Doc | null = o && o.text != null ? { id: o.path, path: o.path, text: o.text, rev: o.rev } : null;
  const note = !o ? empty
    : o.loading ? <p className="muted">{tr('读取中…')}</p>
      : o.err ? <p className="warn-box small">{o.err}</p>
        : o.binary ? <div className="fv-note"><Icon n="file" size={30} /><b>{base(o.path)}</b><p className="muted small">{tr('二进制文件（{0}），这里不能打开。', bytes(o.size))}</p></div>
          : o.tooBig ? <div className="fv-note"><Icon n="file" size={30} /><b>{base(o.path)}</b><p className="muted small">{tr('文件太大（{0}），请在本地打开。', bytes(o.size))}</p></div>
            : null;
  return (
    <div className="fv">
      <Suspense fallback={<p className="muted fv-wait">{tr('正在载入编辑器…')}</p>}>
        <Editor doc={doc} readOnly={DEMO} onChange={f.edit} onSave={() => { f.save(); }} onRun={onRun} onCursor={onCursor} goto={goto} />
      </Suspense>
      {note && <div className="fv-over">{note}</div>}
    </div>
  );
}

const LANG: Record<string, string> = {
  py: 'Python', ipynb: 'Jupyter', js: 'JavaScript', mjs: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript React', jsx: 'JavaScript React',
  json: 'JSON', jsonl: 'JSON Lines', md: 'Markdown', css: 'CSS', html: 'HTML', c: 'C', h: 'C', cpp: 'C++', hpp: 'C++', cu: 'CUDA',
  yaml: 'YAML', yml: 'YAML', toml: 'TOML', sh: 'Shell', bash: 'Shell', tex: 'LaTeX', bib: 'BibTeX', sty: 'LaTeX', cls: 'LaTeX',
  csv: 'CSV', tsv: 'TSV', txt: tr('纯文本'), log: tr('日志'),
};
export const langOf = (path: string) => LANG[ext(path)] ?? (ext(path) ? ext(path).toUpperCase() : tr('纯文本'));
