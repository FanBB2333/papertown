// What the console shows, for the assistant in the sidebar. The console says which project and
// panel are open; each panel says what it has set and what it has open (usePanelNote); what
// you point at is read off the page itself. Parts of the page that stand for something carry a
// data-ref ("job:nvidb-4860", "gpu:406:1", "file:code:src/train.py") and, when their text is
// not a good name, a data-ref-label; pointing takes the nearest of those, or else the block
// under the mouse and the heading over it.

import { useEffect, useSyncExternalStore } from 'react';
import type { Focus, PageCtx } from '../api';

type Note = Record<string, string | number | boolean | null | undefined>;

let at: { line: PageCtx['line']; mod: string; name: string } = { line: null, mod: '', name: '' };
const notes = new Map<string, Map<string, Note>>(); // panel -> part of it -> what it says
const subs = new Set<() => void>();
const changed = () => subs.forEach(f => f());

export function onPageChange(fn: () => void) {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

export function setPlace(line: PageCtx['line'], mod: string, name: string) {
  if (at.line?.id === line?.id && at.mod === mod && at.name === name) return;
  at = { line, mod, name };
  changed();
}
export const usePlace = () => useSyncExternalStore(onPageChange, () => at);

// a panel's settings and what it has open, in words the assistant reads ("时间范围": "7 天")
export function usePanelNote(mod: string, part: string, note: Note) {
  const key = JSON.stringify(note);
  useEffect(() => {
    const m = notes.get(mod) ?? new Map<string, Note>();
    m.set(part, note);
    notes.set(mod, m);
    changed();
  }, [mod, part, key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { notes.get(mod)?.delete(part); changed(); }, [mod, part]);
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const squash = (s: string) => s.replace(/[ \t ]+/g, ' ').replace(/\s*\n[\s\n]*/g, '\n').trim();
const panel = () => document.querySelector<HTMLElement>('.p-console .cm-mod.on');
const textOf = (el: Element) => (el as HTMLElement).innerText ?? el.textContent ?? '';
const worded = (s: string) => /\p{L}/u.test(s);

// a part's name: its first line, or as many first lines as it takes to say something in words
// ("11", then "已取消")
function nameOf(text: string) {
  const lines = text.split('\n').filter(Boolean);
  let n = 1;
  while (n < Math.min(lines.length, 4) && !worded(lines.slice(0, n).join(''))) n++;
  return clip(lines.slice(0, n).join(' '), 80);
}

function labelOf(el: Element) {
  const h = el as HTMLElement;
  return nameOf(squash(h.dataset?.refLabel || h.getAttribute('aria-label') || textOf(h)));
}

// the heading of the part of the panel an element sits in
const HEAD = ':scope > :is(h2, h3, h4, h5, header, legend, .cs-h, .sec-h)';
function whereOf(el: Element): string | undefined {
  const top = panel()?.parentElement;
  for (let n = el.parentElement; n && n !== top; n = n.parentElement) {
    const h = n.querySelector<HTMLElement>(HEAD);
    if (h && !h.contains(el)) return clip(squash(h.innerText).replace(/\n/g, ' ').replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+\d+$/, ''), 40) || undefined;
  }
  return undefined;
}

// what pointing lands on: the nearest part that stands for something, else the block it is in.
// A bare number or sign says nothing on its own, so it takes the part around it that has words.
const BLOCK = 'button, a, li, tr, th, td, figure, pre, p, h2, h3, h4, h5, label, [role=button], .card, .pnl';
const EDGE = '.cm-mod, .jd, .p-console, .asst';
export function pickable(target: Element) {
  let el = target.closest('[data-ref]') ?? target.closest(BLOCK) ?? target;
  for (let i = 0; i < 4 && !worded(textOf(el)) && el.parentElement && !el.parentElement.matches(EDGE); i++) el = el.parentElement;
  return el;
}

export function describe(target: Element): Focus {
  const el = pickable(target), ref = el.getAttribute('data-ref') ?? undefined;
  const text = clip(squash(textOf(el)), 400);
  return { ref, label: ref ? labelOf(el) : nameOf(text) || el.tagName.toLowerCase(), where: whereOf(el), text };
}

// text you selected, and the part of the page it is in
export interface Selected { text: string; at: Focus | null }

// everything the sidebar tells the assistant, with the message or when you move
export function snapshot(focus: Focus | null, sel: Selected | null = null): PageCtx {
  const p = panel();
  const state: Record<string, string> = {};
  for (const n of notes.get(at.mod)?.values() ?? []) {
    for (const [k, v] of Object.entries(n)) if (v !== null && v !== undefined && v !== '' && v !== false) state[k] = String(v);
  }
  const seen = new Set<string>(), refs: PageCtx['refs'] = [];
  for (const el of p?.querySelectorAll('[data-ref]') ?? []) {
    const ref = el.getAttribute('data-ref')!;
    if (seen.has(ref)) continue;
    seen.add(ref);
    refs.push({ ref, label: labelOf(el) });
    if (refs.length >= 80) break;
  }
  // code and the paper are files the assistant reads itself; elsewhere the page's text helps
  const text = p && !['code', 'paper'].includes(at.mod) ? clip(squash(p.innerText), 8000) : '';
  return { line: at.line, mod: at.mod, mod_name: at.name, state, focus, refs, text, ...(sel?.text ? { selection: sel.text, selection_at: sel.at } : {}) };
}

// text you select in the console (not in the sidebar), now and as you select it, with the part
// of the page a short one is in ("11" in "已取消 11"); null once you clear it there. Moving into
// the sidebar to write keeps it.
export function onSelect(fn: (sel: Selected | null) => void) {
  const on = () => {
    const s = getSelection();
    const n = s?.anchorNode instanceof Element ? s.anchorNode : s?.anchorNode?.parentElement;
    if (!s || !n?.closest('.p-console') || n.closest('.asst')) return;
    const text = s.isCollapsed ? '' : s.toString().trim().slice(0, 4000);
    if (text.length < 2) return fn(null);
    const c = s.getRangeAt(0).commonAncestorContainer, el = c instanceof Element ? c : c.parentElement;
    fn({ text, at: el && text.length < 200 ? describe(el) : null });
  };
  on();
  document.addEventListener('selectionchange', on);
  return () => document.removeEventListener('selectionchange', on);
}

// light up a part of the page the assistant talks about, once it has rendered
export function flash(ref: string, tries = 24) {
  const el = document.querySelector(`.p-console [data-ref="${CSS.escape(ref)}"]`);
  if (!el) {
    if (tries > 0) setTimeout(() => flash(ref, tries - 1), 150);
    return;
  }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('pt-flash');
  void (el as HTMLElement).offsetWidth;
  el.classList.add('pt-flash');
  setTimeout(() => el.classList.remove('pt-flash'), 2600);
}
