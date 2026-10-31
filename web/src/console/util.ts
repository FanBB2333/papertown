// Small pieces the console's panels share: loading per project, and plain formatting.

import { useEffect, useRef, useState } from 'react';
import { tr } from '../i18n';

// Loads `fn` for one project (`id`), again whenever the town ticks. The last answer stays up
// while the next one comes, but never another project's: switching `id` starts empty.
export function useFetch<T>(fn: () => Promise<T>, id: string, tick = 0, delay = 160) {
  const [s, setS] = useState<{ id: string; data: T | null; err: string }>({ id: '', data: null, err: '' });
  const [bump, setBump] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const mine = s.id === id;
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => fnRef.current().then(
      data => { if (live) setS({ id, data, err: '' }); },
      e => { if (live) setS(o => ({ id, data: o.id === id ? o.data : null, err: (e as Error).message })); },
    ), mine ? delay : 0);
    return () => { live = false; clearTimeout(t); };
  }, [id, tick, bump]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data: mine ? s.data : null, err: mine ? s.err : '', loading: !mine, reload: () => setBump(b => b + 1) };
}

export function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// an ISO time or seconds since the epoch, as "how long ago"
export function ago(ts: string | number | null | undefined) {
  if (ts == null || ts === '') return '—';
  const t = typeof ts === 'number' ? ts * 1000 : Date.parse(ts);
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return tr('刚刚');
  if (s < 3600) return tr('{0} 分钟前', Math.round(s / 60));
  if (s < 86400) return tr('{0} 小时前', Math.round(s / 3600));
  return tr('{0} 天前', Math.round(s / 86400));
}

export function dur(s: number | null | undefined) {
  if (s == null) return '—';
  if (s < 90) return tr('{0} 秒', Math.round(s));
  if (s < 5400) return tr('{0} 分钟', Math.round(s / 60));
  return tr('{0} 小时', (s / 3600).toFixed(1));
}

// the first sentence of a long text, cut to about n characters: what a reader takes in at a glance
export function gist(text: string | null | undefined, n = 90) {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const m = /^(.+?[。！？!?；;]|.+?\.(?=\s|$))/.exec(t);
  const first = m ? m[1] : t;
  return first.length > n ? `${first.slice(0, n - 1).trimEnd()}…` : first;
}

// a text split into its sentences, for lists of short points
export function points(text: string | null | undefined): string[] {
  return (text ?? '').replace(/\s+/g, ' ').split(/(?<=[。！？!?；;])|(?<=\.)\s+/).map(s => s.trim()).filter(s => s.length > 1);
}

export const ext = (path: string) => (path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '');
export const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);

// brings el into view inside its own scrolling row, sideways only: scrollIntoView would scroll
// every box around it too, the page's own (overflow hidden) included
export function revealX(box: HTMLElement | null, el: Element | null | undefined, center = false) {
  if (!box || !el) return;
  const b = box.getBoundingClientRect(), r = el.getBoundingClientRect();
  const left = r.left - b.left + box.scrollLeft;
  const to = center ? left - (box.clientWidth - r.width) / 2
    : r.left < b.left ? left - 16 : r.right > b.right ? left + r.width - box.clientWidth + 16 : box.scrollLeft;
  if (to !== box.scrollLeft) box.scrollTo({ left: to, behavior: 'smooth' });
}
