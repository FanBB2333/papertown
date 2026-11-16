// Select and Combo: lists drawn like the page instead of the browser's menus, placed on the page's
// root so a panel that scrolls or clips does not cut them off. Keys work as in a native select.
import { Fragment, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../console/icons';
import '../select.css';

export interface Opt<T extends string | number = string> { value: T; label: string; hint?: string; group?: string }

const GAP = 6, EDGE = 10, TALL = 320;
const root = () => document.querySelector('.theme-sketch') ?? document.body;
const printable = (e: React.KeyboardEvent) => e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey;

// keeps an open list beside what opened it, its active option in view, and closes it on a click elsewhere
function usePop(open: boolean, at: number, anchor: React.RefObject<HTMLElement>, pop: React.RefObject<HTMLDivElement>, close: () => void) {
  useLayoutEffect(() => {
    if (!open) return;
    const place = (e?: Event) => {
      const a = anchor.current, el = pop.current;
      if (!a || !el || (e?.target instanceof Node && el.contains(e.target))) return;
      const r = a.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) return close();
      const below = innerHeight - r.bottom - GAP - EDGE, above = r.top - GAP - EDGE;
      const up = Math.min(el.scrollHeight + 2, TALL) > below && above > below;
      el.classList.toggle('up', up);
      el.style.minWidth = `${r.width}px`;
      el.style.maxHeight = `${Math.min(TALL, up ? above : below)}px`;
      el.style.top = up ? '' : `${r.bottom + GAP}px`;
      el.style.bottom = up ? `${innerHeight - r.top + GAP}px` : '';
      el.style.left = `${Math.max(EDGE, Math.min(r.left, innerWidth - el.offsetWidth - EDGE))}px`;
    };
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!anchor.current?.contains(t) && !pop.current?.contains(t)) close();
    };
    place();
    addEventListener('resize', place);
    addEventListener('scroll', place, true);
    addEventListener('pointerdown', down, true);
    return () => { removeEventListener('resize', place); removeEventListener('scroll', place, true); removeEventListener('pointerdown', down, true); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = pop.current, o = el?.querySelector<HTMLElement>('.sel-o.at');
    if (!el || !o) return;
    if (o.offsetTop < el.scrollTop) el.scrollTop = o.offsetTop - 5;
    else if (o.offsetTop + o.offsetHeight > el.scrollTop + el.clientHeight) el.scrollTop = o.offsetTop + o.offsetHeight - el.clientHeight + 5;
  }, [open, at]); // eslint-disable-line react-hooks/exhaustive-deps
}

function List<T extends string | number>({ id, options, value, at, pop, onAt, onPick }: {
  id: string; options: Opt<T>[]; value: T; at: number; pop: React.RefObject<HTMLDivElement>; onAt: (i: number) => void; onPick: (v: T) => void;
}) {
  // a click in the list leaves the focus where it was, so the keys keep working
  return createPortal(
    <div ref={pop} id={id} className="sel-pop" role="listbox" onMouseDown={e => e.preventDefault()}>
      {options.map((o, i) => (
        <Fragment key={String(o.value)}>
          {o.group && o.group !== options[i - 1]?.group && <h6>{o.group}</h6>}
          <div id={`${id}-${i}`} role="option" aria-selected={o.value === value} className={`sel-o${i === at ? ' at' : ''}`}
            onMouseMove={() => { if (i !== at) onAt(i); }} onClick={() => onPick(o.value)}>
            <span>{o.label}</span>{o.hint && <em>{o.hint}</em>}{o.value === value && <Icon n="check" size={14} />}
          </div>
        </Fragment>
      ))}
    </div>,
    root(),
  );
}

export function Select<T extends string | number>({ value, options, onChange, className = '', title, label, placeholder = '', disabled }: {
  value: T; options: Opt<T>[]; onChange: (v: T) => void; className?: string; title?: string; label?: string; placeholder?: string; disabled?: boolean;
}) {
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const seek = useRef({ s: '', t: 0 });
  const here = options.findIndex(o => o.value === value);
  const close = () => setOpen(false);
  usePop(open, at, btn, pop, close);

  function show(i = here) { setAt(Math.max(0, i)); setOpen(true); }
  function pick(v: T) {
    setOpen(false);
    btn.current?.focus();
    if (v !== value) onChange(v);
  }
  // typing jumps to the option that starts with what was typed; the same letter again steps through them
  function find(ch: string) {
    const now = Date.now(), s = now - seek.current.t > 700 ? ch : seek.current.s + ch;
    seek.current = { s, t: now };
    const q = s.toLowerCase(), again = [...q].every(c => c === q[0]), from = open ? at : here;
    for (let j = 0, n = options.length; j < n; j++) {
      const x = (from + (again ? 1 : 0) + j + n) % n;
      if (options[x].label.toLowerCase().startsWith(again ? q[0] : q)) return x;
    }
    return -1;
  }

  function onKey(e: React.KeyboardEvent) {
    const k = e.key, last = options.length - 1;
    const word = printable(e) && (k !== ' ' || Date.now() - seek.current.t < 700);
    if (!open) {
      if (word) { const j = find(k); show(j >= 0 ? j : here); }
      else if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(k)) show();
      else if (!k.startsWith('Arrow')) return;
    } else if (word) { const j = find(k); if (j >= 0) setAt(j); }
    else if (k === 'ArrowDown') setAt(a => Math.min(last, a + 1));
    else if (k === 'ArrowUp') setAt(a => Math.max(0, a - 1));
    else if (k === 'PageDown') setAt(a => Math.min(last, a + 8));
    else if (k === 'PageUp') setAt(a => Math.max(0, a - 8));
    else if (k === 'Home') setAt(0);
    else if (k === 'End') setAt(last);
    else if (k === 'Enter' || k === ' ') { if (options[at]) pick(options[at].value); }
    else if (k === 'Escape') close();
    else if (k === 'Tab') return close();
    else if (!k.startsWith('Arrow')) return;
    // the keys stay here: Esc does not close the room around it, arrows do not walk the town
    e.preventDefault();
    e.stopPropagation();
  }

  return (
    <>
      <button ref={btn} type="button" className={`sel ${className}${open ? ' open' : ''}`} disabled={disabled} title={title}
        role="combobox" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined}
        aria-activedescendant={open && options[at] ? `${id}-${at}` : undefined}
        onClick={() => { btn.current?.focus(); if (open) close(); else show(); }}
        onKeyDown={onKey} onKeyUp={e => { if (e.key === ' ') e.preventDefault(); }}
        onBlur={e => { if (e.relatedTarget && !pop.current?.contains(e.relatedTarget as Node)) close(); }}>
        <span className={`sel-v${here < 0 && value === '' ? ' muted' : ''}`}>{options[here]?.label ?? (String(value) || placeholder)}</span>
        <Icon n="down" size={14} className="sel-chev" />
      </button>
      {open && <List id={id} options={options} value={value} at={at} pop={pop} onAt={setAt} onPick={pick} />}
    </>
  );
}

// free text, with suggestions: the whole list until you type, then the ones containing what you typed
export function Combo({ value, options, onChange, className = '', placeholder, label }: {
  value: string; options: string[]; onChange: (v: string) => void; className?: string; placeholder?: string; label?: string;
}) {
  const id = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  const box = useRef<HTMLInputElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState(false);
  const [at, setAt] = useState(-1);
  const q = value.trim().toLowerCase();
  const shown = (typed && q ? options.filter(o => o.toLowerCase().includes(q)) : options).map(o => ({ value: o, label: o }));
  const up = open && shown.length > 0;
  const close = () => setOpen(false);
  usePop(up, at, wrap, pop, close);

  function show() { setTyped(false); setAt(options.indexOf(value)); setOpen(true); }
  function pick(v: string) { setOpen(false); if (v !== value) onChange(v); }

  function onKey(e: React.KeyboardEvent) {
    const k = e.key;
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      if (!up) show();
      else setAt(a => (k === 'ArrowDown' ? Math.min(shown.length - 1, a + 1) : Math.max(0, a - 1)));
    } else if (k === 'Enter' && up && shown[at]) pick(shown[at].value);
    else if (k === 'Escape' && up) close();
    else {
      if (k === 'Tab') close();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  return (
    <span ref={wrap} className={`combo ${className}${up ? ' open' : ''}`}>
      <input ref={box} type="text" value={value} placeholder={placeholder} aria-label={label} autoComplete="off" spellCheck={false}
        role="combobox" aria-autocomplete="list" aria-expanded={up} aria-controls={up ? id : undefined}
        aria-activedescendant={up && shown[at] ? `${id}-${at}` : undefined}
        onChange={e => { onChange(e.target.value); setTyped(true); setAt(-1); setOpen(true); }}
        onKeyDown={onKey} onBlur={close} onMouseDown={() => { if (!open) show(); }} />
      <button type="button" className="combo-b" tabIndex={-1} aria-hidden="true"
        onMouseDown={e => { e.preventDefault(); box.current?.focus(); if (up) close(); else show(); }}>
        <Icon n="down" size={14} />
      </button>
      {up && <List id={id} options={shown} value={value} at={at} pop={pop} onAt={setAt} onPick={pick} />}
    </span>
  );
}
