// The console's text editor (CodeMirror 6), for code and for TeX. One view stays mounted and
// each open file keeps its own state in it, so switching tabs keeps each file's undo
// history, selection and scroll. Mod-S saves, Mod-Enter runs (the paper: compile).

import { useEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { indentWithTab } from '@codemirror/commands';
import { tags as t } from '@lezer/highlight';
import { python } from '@codemirror/lang-python';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { cpp } from '@codemirror/lang-cpp';
import { yaml } from '@codemirror/lang-yaml';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { toml } from '@codemirror/legacy-modes/mode/toml';

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
    case 'tex': case 'sty': case 'cls': case 'bib': case 'bbx': case 'cbx': return [StreamLanguage.define(stex), EditorView.lineWrapping];
    case 'sh': case 'bash': case 'zsh': return [StreamLanguage.define(shell)];
    case 'toml': case 'cfg': case 'ini': return [StreamLanguage.define(toml)];
    case 'txt': case 'log': case 'csv': case 'tsv': return [EditorView.lineWrapping];
    default: return [];
  }
}

// the paper's colours, quiet enough to read code on for a long time
const ink = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: '#a5482c' },
  { tag: [t.string, t.special(t.string), t.regexp], color: '#5b7a37' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#a06a14' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#a3927b', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#2f6390' },
  { tag: [t.typeName, t.className, t.namespace], color: '#2e7472' },
  { tag: [t.propertyName, t.attributeName], color: '#7a4f93' },
  { tag: [t.definition(t.variableName)], color: '#3a2c1e' },
  { tag: [t.tagName, t.macroName], color: '#a5482c' },
  { tag: [t.heading], color: '#2f261d', fontWeight: '700' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strong], fontWeight: '700' },
  { tag: [t.link, t.url], color: '#2f6390', textDecoration: 'underline' },
  { tag: [t.meta, t.processingInstruction], color: '#857560' },
  { tag: [t.bracket, t.paren, t.squareBracket, t.brace], color: '#6b5a46' },
  { tag: t.invalid, color: '#b9543f' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--ed-bg)', color: 'var(--ink)' },
  '.cm-scroller': { fontFamily: '"SF Mono", "JetBrains Mono", Menlo, Consolas, monospace', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--brand)', padding: '10px 0' },
  '.cm-cursor': { borderLeftColor: 'var(--brand)', borderLeftWidth: '2px' },
  '.cm-gutters': { backgroundColor: 'var(--ed-bg)', color: 'color-mix(in srgb, var(--muted) 70%, transparent)', border: 'none', paddingLeft: '6px' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ink)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--brand) 5%, transparent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'color-mix(in srgb, var(--brand) 22%, transparent) !important' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--warn) 18%, transparent)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--ok) 22%, transparent)', outline: 'none' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--panel2)', border: 'none', color: 'var(--muted)' },
  '.cm-tooltip': { backgroundColor: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '8px' },
  '.cm-panels': { backgroundColor: 'var(--panel2)', color: 'var(--ink)' },
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
        indentWithTab,
      ])),
      syntaxHighlighting(ink),
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
