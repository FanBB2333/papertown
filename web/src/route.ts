// Client-side routing. The static demo keeps the path in the hash (#/progress).
//   /   (the landing)
//   /progress[/6[/ask|/pages[/p3]]]
//   /console[/6[/<panel>]]
//   /town   /status   /settings/<part>

import { useSyncExternalStore } from 'react';
import { DEMO } from './demo';

export type View = 'cards' | 'console' | 'world' | 'status';
export interface Route { view: View | 'landing' | 'settings'; seq?: number; mod?: string; sub?: 'ask' | 'pages'; page?: string }

export const PATHS: Record<View, string> = { cards: '/progress', console: '/console', world: '/town', status: '/status' };

function read(): string {
  if (DEMO) return location.hash.startsWith('#/') ? location.hash.slice(1).split('?')[0] : '/';
  return location.pathname.replace(/\/+$/, '') || '/';
}

let current = read();
const subs = new Set<() => void>();
const changed = () => {
  const p = read();
  if (p === current) return;
  current = p;
  for (const f of subs) f();
};
addEventListener('popstate', changed);
if (DEMO) addEventListener('hashchange', changed);

export function path() { return current; }

// to: a path, optionally with a query ("/?next=/progress")
export function go(to: string, replace = false) {
  const url = DEMO ? `#${to}` : to;
  if (url === (DEMO ? location.hash : location.pathname + location.search + location.hash)) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', url);
  changed();
}

export const href = (to: string) => (DEMO ? `#${to}` : to);

// a plain click navigates in the page; a modified click keeps the browser's default (new tab etc.)
export function follow(e: React.MouseEvent, to: string) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  go(to);
}

export function query(): URLSearchParams {
  return new URLSearchParams(DEMO ? location.hash.split('?')[1] ?? '' : location.search);
}

export function usePath(): string {
  return useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f); }; }, path);
}

export function parse(p: string): Route {
  const [, a, b, c, d] = p.split('/');
  if (!a) return { view: 'landing' };
  const seq = b && /^\d+$/.test(b) ? Number(b) : undefined;
  if (a === 'progress') return { view: 'cards', seq, sub: seq != null && (c === 'ask' || c === 'pages') ? c : undefined, page: c === 'pages' ? d || undefined : undefined };
  if (a === 'console') return { view: 'console', seq, mod: c || undefined };
  if (a === 'town') return { view: 'world' };
  if (a === 'status') return { view: 'status' };
  if (a === 'settings') return { view: 'settings', mod: b || undefined };
  return { view: 'cards' };
}

// the path for an old hash link (#view=…, #open=…, #3d, #chat), or null
export function legacy(): string | null {
  const hp = new URLSearchParams(location.hash.slice(1));
  const v = hp.get('view');
  if (v === 'console' || v === 'status' || v === 'cards') return PATHS[v];
  if (v === 'world' || hp.has('open') || hp.has('3d') || hp.has('chat')) return PATHS.world;
  return null;
}

// ?next= after sign-in, else start; only same-origin paths, so it cannot redirect off-site
export function next(start: string): string {
  const n = DEMO ? null : new URLSearchParams(location.search).get('next');
  return n && n.startsWith('/') && !n.startsWith('//') ? n : start;
}
