// The console's text editor (CodeMirror 6), for code and for TeX. One view stays mounted and
// each open file keeps its own state in it, so switching tabs keeps each file's undo
// history, selection and scroll. Mod-S saves, Mod-Enter runs (the paper: compile), Mod-K Mod-T
// picks a colour theme. Tokens are drawn by class and coloured by the theme's variables
// (edthemes.ts), so a theme change reaches every open file at once.

import { useEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { indentWithTab } from '@codemirror/commands';
import { python } from '@codemirror/lang-python';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { cpp } from '@codemirror/lang-cpp';
import { yaml } from '@codemirror/lang-yaml';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { openPicker } from './edthemes';
import { highlighter } from './highlight';
import { bibtex, latex } from './latex';

export interface Doc { id: string; path: string; text: string; rev: number }

interface Props {
  doc: Doc | null;
  readOnly?: boolean;
  onChange?: (id: string, text: string) => void;
  onSave?: () => void;
  onRun?: () => void;
  onCursor?: (line: number, col: number, picked: string) => void; // picked: the selected text, if any
  goto?: { line: number; n: number } | null; // asked from outside: put the cursor on this line
}

const ext = (path: string) => path.slice(path.lastIndexOf('.') + 1).toLowerCase();

function language(path: string): Extension[] {
  switch (ext(path)) {
    case 'py': case 'pyi': return [python()];
    case 'js': case 'mjs': case 'cjs': case 'jsx': return [javascript({ jsx: true })];
    case 'ts': case 'tsx': case 'mts': return [javascript({ typescript: true, jsx: ext(path) === 'tsx' })];
    case 'json': case 'jsonl': case 'ipynb': return [json()];
    case 'md': case 'markdown': return [markdown(), EditorView.lineWrapping];
    case 'css': case 'scss': return [css()];
    case 'html': case 'htm': case 'vue': case 'svelte': return [html()];
    case 'c': case 'cc': case 'cpp': case 'cxx': case 'h': case 'hpp': case 'cu': case 'cuh': return [cpp()];
    case 'yaml': case 'yml': return [yaml()];
    case 'tex': case 'sty': case 'cls': case 'bbx': case 'cbx': case 'ltx': return [latex, EditorView.lineWrapping];
    case 'bib': return [bibtex, EditorView.lineWrapping];
    case 'sh': case 'bash': case 'zsh': return [StreamLanguage.define(shell)];
    case 'toml': case 'cfg': case 'ini': return [StreamLanguage.define(toml)];
    case 'txt': case 'log': case 'csv': case 'tsv': return [EditorView.lineWrapping];
    default: return [];
  }
}

// the editor's own parts, in the panel's theme (--ed-… from edthemes.ts)
const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--ed-bg)', color: 'var(--ed-fg)' },
  '.cm-scroller': { fontFamily: '"SF Mono", "JetBrains Mono", Menlo, Consolas, monospace', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--ed-cursor)', padding: '10px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ed-cursor)', borderLeftWidth: '2px' },
  '.cm-gutters': { backgroundColor: 'var(--ed-bg)', color: 'var(--ed-gutter)', border: 'none', paddingLeft: '6px' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ed-gutterOn)' },
  '.cm-activeLine': { backgroundColor: 'var(--ed-line)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--ed-sel) !important' },
  '.cm-selectionMatch': { backgroundColor: 'var(--ed-match)' },
  '.cm-searchMatch': { backgroundColor: 'var(--ed-match)', outline: '1px solid color-mix(in srgb, var(--ed-accent) 45%, transparent)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--ed-sel)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--ed-bracket)', outline: 'none' },
  '.cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket': { color: 'var(--tk-bad)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--ed-tabs)', border: 'none', color: 'var(--ed-muted)' },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--ed-gutter)' },
  '.cm-tooltip': { backgroundColor: 'var(--ed-side)', color: 'var(--ed-fg)', border: '1px solid var(--ed-border)', borderRadius: '8px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--ed-sel)', color: 'var(--ed-fg)' },
  '.cm-panels': { backgroundColor: 'var(--ed-side)', color: 'var(--ed-fg)' },
  '.cm-panels-top': { borderBottom: '1px solid var(--ed-border)' },
  '.cm-panels-bottom': { borderTop: '1px solid var(--ed-border)' },
  '.cm-textfield': { backgroundColor: 'var(--ed-input)', color: 'var(--ed-fg)', border: '1px solid var(--ed-border)', borderRadius: '5px' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--ed-input)', color: 'var(--ed-fg)', border: '1px solid var(--ed-border)', borderRadius: '5px' },
  '.cm-panel button[name=close]': { color: 'var(--ed-muted)' },
  '&.cm-focused': { outline: 'none' },
});

export default function Editor({ doc, readOnly = false, onChange, onSave, onRun, onCursor, goto }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const saved = useRef(new Map<string, { state: EditorState; top: number; rev: number }>());
  const cur = useRef<Doc | null>(null);
  const fns = useRef({ onChange, onSave, onRun, onCursor });
  fns.current = { onChange, onSave, onRun, onCursor };

  const make = (d: Doc) => EditorState.create({
    doc: d.text,
    extensions: [
      basicSetup,
      Prec.highest(keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => { fns.current.onSave?.(); return true; } },
        { key: 'Mod-Enter', preventDefault: true, run: () => { fns.current.onRun?.(); return true; } },
        { key: 'Mod-k Mod-t', preventDefault: true, run: () => { openPicker('theme'); return true; } },
        indentWithTab,
      ])),
      syntaxHighlighting(highlighter),
      theme,
      language(d.path),
      EditorState.readOnly.of(readOnly),
      EditorView.updateListener.of(u => {
        if (u.docChanged && cur.current) fns.current.onChange?.(cur.current.id, u.state.doc.toString());
        if (u.selectionSet || u.docChanged) {
          const m = u.state.selection.main, ln = u.state.doc.lineAt(m.head);
          fns.current.onCursor?.(ln.number, m.head - ln.from + 1, m.empty ? '' : u.state.sliceDoc(m.from, Math.min(m.to, m.from + 2000)));
        }
      }),
    ],
  });

  useEffect(() => {
    view.current = new EditorView({ parent: host.current! });
    return () => { view.current?.destroy(); view.current = null; };
  }, []);

  // another file, or the same one read again (rev): keep the one we leave, bring back the one we open
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const prev = cur.current;
    if (prev && prev.id !== doc?.id) saved.current.set(prev.id, { state: v.state, top: v.scrollDOM.scrollTop, rev: prev.rev });
    cur.current = doc;
    if (!doc) { v.setState(EditorState.create({ doc: '' })); return; }
    const keep = saved.current.get(doc.id);
    if (keep && keep.rev === doc.rev) {
      v.setState(keep.state);
      requestAnimationFrame(() => { v.scrollDOM.scrollTop = keep.top; });
    } else if (!prev || prev.id !== doc.id || prev.rev !== doc.rev) {
      v.setState(make(doc));
    }
    const h = v.state.selection.main.head, ln = v.state.doc.lineAt(h);
    fns.current.onCursor?.(ln.number, h - ln.from + 1, '');
  }, [doc?.id, doc?.rev, readOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  // after the file is in: the line asked for, in the middle of the view
  const went = useRef(0);
  useEffect(() => {
    const v = view.current;
    if (!v || !doc || !goto || went.current === goto.n) return;
    went.current = goto.n;
    const at = v.state.doc.line(Math.min(Math.max(1, goto.line), v.state.doc.lines)).from;
    v.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }) });
  }, [goto?.n, doc?.id, doc?.rev]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div className="ed" ref={host} />;
}
