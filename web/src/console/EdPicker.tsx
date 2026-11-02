// Picking the editor's colour theme or file icon theme, the way VS Code does: a list at the top of
// the page, light themes then dark ones, ↑↓ trying each on the editor as you go, Enter keeping it,
// Esc putting back what was there. Tab switches between colours and icons. Opened from the tab
// bar's palette button or with ⌘K ⌘T in the editor; the settings page shows the same choices.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { tr } from '../i18n';
import { getSettings } from '../settings';
import { ICON_THEMES, THEMES, chooseLook, closePicker, previewLook, themeVars, useLook, type EdTheme, type IconTheme } from './edthemes';
import { FileIcon, FolderIcon } from './fileicons';

type Item = { kind: 'theme'; th: EdTheme } | { kind: 'icons'; id: IconTheme; name: string; desc: string } | { kind: 'head'; label: string };

export function EdPicker() {
  const { picker } = useLook();
  // on the page's own root (where its colours and font are set), so that no panel it is opened
  // from decides where it sits
  return picker ? createPortal(<Picker mode={picker} />, document.querySelector('[class*="theme-"]') ?? document.body) : null;
}

function Picker({ mode }: { mode: 'theme' | 'icons' }) {
  const look = useLook();
  const [tab, setTab] = useState(mode);
  const [q, setQ] = useState('');
  const saved = getSettings();
  const back = useRef<Element | null>(document.activeElement);

  const items = useMemo<Item[]>(() => {
    const has = (s: string) => s.toLowerCase().includes(q.trim().toLowerCase());
    if (tab === 'icons') return ICON_THEMES.filter(([id, n, d]) => has(id + n + d)).map(([id, name, desc]) => ({ kind: 'icons', id, name, desc }));
    const out: Item[] = [];
    for (const [dark, label] of [[false, tr('浅色主题')], [true, tr('深色主题')]] as const) {
      const xs = THEMES.filter(th => th.dark === dark && has(th.id + th.name));
      if (xs.length) out.push({ kind: 'head', label }, ...xs.map(th => ({ kind: 'theme' as const, th })));
    }
    return out;
  }, [tab, q]);
  const pickable = items.flatMap((x, i) => (x.kind === 'head' ? [] : [i]));
  const savedAt = items.findIndex(x => (x.kind === 'theme' ? x.th.id === saved.edTheme : x.kind === 'icons' && x.id === saved.edIcons));
  const [at, setAt] = useState(-1);
  const cur = at >= 0 && pickable.includes(at) ? at : savedAt >= 0 ? savedAt : pickable[0] ?? -1;

  const close = () => { closePicker(); (back.current as HTMLElement | null)?.focus?.(); };
  const keep = (x: Item | undefined) => {
    if (!x || x.kind === 'head') return;
    chooseLook(x.kind === 'theme' ? { theme: x.th.id } : { icons: x.id });
    close();
  };
  // moving through the list tries each one; the list being filtered or switched does not
  const move = (d: number) => {
    if (!pickable.length) return;
    const k = pickable.indexOf(cur);
    const next = pickable[(k + d + pickable.length) % pickable.length];
    setAt(next);
    const x = items[next];
    previewLook(x.kind === 'theme' ? { theme: x.th.id } : x.kind === 'icons' ? { icons: x.id } : null);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); move(e.key === 'ArrowDown' ? 1 : -1); }
    else if (e.key === 'Enter') { e.preventDefault(); keep(items[cur]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') { e.preventDefault(); setTab(t => (t === 'theme' ? 'icons' : 'theme')); setQ(''); setAt(-1); previewLook(null); }
  };
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { list.current?.querySelector('.edp-it.cur')?.scrollIntoView({ block: 'nearest' }); }, [cur, tab]);

  return (
    <div className="edp-back" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div className={`edp${look.theme.dark ? ' dark' : ''}`} style={themeVars(look.theme)} role="dialog" aria-label={tr('编辑器外观')}>
        <div className="edp-tabs" role="tablist">
          {(['theme', 'icons'] as const).map(t => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onMouseDown={e => e.preventDefault()}
              onClick={() => { setTab(t); setQ(''); setAt(-1); previewLook(null); }}>
              {t === 'theme' ? tr('颜色主题') : tr('文件图标主题')}
            </button>
          ))}
          <span className="edp-k">{tr('Tab 切换')}</span>
        </div>
        <input className="edp-q" autoFocus value={q} onChange={e => { setQ(e.target.value); setAt(-1); }} onKeyDown={onKey}
          placeholder={tab === 'theme' ? tr('选择颜色主题（↑↓ 预览，Enter 确定，Esc 取消）') : tr('选择文件图标主题（↑↓ 预览，Enter 确定，Esc 取消）')} />
        <div className="edp-list" ref={list} role="listbox">
          {items.map((x, i) => x.kind === 'head'
            ? <div key={`h${i}`} className="edp-h">{x.label}</div>
            : (
              <button key={x.kind === 'theme' ? x.th.id : x.id} role="option" aria-selected={i === cur}
                className={`edp-it${i === cur ? ' cur' : ''}${i === savedAt ? ' saved' : ''}`} onMouseDown={e => e.preventDefault()} onClick={() => keep(x)}>
                {x.kind === 'theme' ? <Swatch th={x.th} /> : <IconRow id={x.id} />}
                <span className="edp-n">{x.kind === 'theme' ? x.th.name : x.name}</span>
                {x.kind === 'icons' && <span className="edp-d">{x.desc}</span>}
                {i === savedAt && <span className="edp-now">{tr('当前')}</span>}
              </button>
            ))}
          {!pickable.length && <p className="edp-none">{tr('没有匹配的主题')}</p>}
        </div>
      </div>
    </div>
  );
}

// a theme in a glance: its background with four of its token colours
export function Swatch({ th }: { th: EdTheme }) {
  return (
    <span className="edp-sw" style={{ background: th.ui.bg, borderColor: th.ui.border }}>
      {(['kw', 'str', 'fn', 'num'] as const).map(k => <i key={k} style={{ background: th.tok[k] }} />)}
    </span>
  );
}

export function IconRow({ id }: { id: IconTheme }) {
  return (
    <span className="edp-icons">
      {id === 'badges' || id === 'none' ? <FolderIcon name="src" open={false} theme={id} /> : null}
      {['a.py', 'main.tex', 'refs.bib', 'README.md', 'b.json'].map(p => <FileIcon key={p} path={p} theme={id} />)}
      {id === 'none' && <span className="edp-d">—</span>}
    </span>
  );
}

// a few lines of a paper and of code, drawn in a theme: what the settings page shows for each one
export function Sample({ th }: { th: EdTheme }) {
  const s = (c: string, x: string) => <span className={c}>{x}</span>;
  return (
    <pre className="edp-sample" style={themeVars(th)}>
      {s('pt-macro', '\\section')}{s('pt-punc', '{')}{s('pt-head', 'Method')}{s('pt-punc', '}')} {s('pt-com', '% the idea')}{'\n'}
      {s('pt-mathdelim', '$')}{s('pt-math', 'f')}{s('pt-op', '(')}{s('pt-math', 'x')}{s('pt-op', ')=')}{s('pt-mathcmd', '\\alpha')} {s('pt-math', 'x')}{s('pt-op', '^')}{s('pt-num', '2')}{s('pt-mathdelim', '$')} {s('pt-macro', '\\cite')}{s('pt-punc', '{')}{s('pt-label', 'he2016')}{s('pt-punc', '}')}{'\n'}
      {s('pt-kw', 'def')} {s('pt-fn', 'run')}{s('pt-punc', '(')}{s('pt-var', 'x')}{s('pt-punc', '):')} {s('pt-ctl', 'return')} {s('pt-str', '"ok"')}{'\n'}
    </pre>
  );
}
