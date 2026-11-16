// Small pieces the console's panels share: loading per project, and plain formatting.

import { useEffect, useRef, useState } from 'react';
import { tr } from '../i18n';

// Loads `fn` for project `id`, again on every tick; switching `id` starts empty.
export function useFetch<T>(fn: () => Promise<T>, id: string, tick = 0, delay = 160) {
  const [s, setS] = useState<{ id: string; data: T | null; err: string }>({ id: '', data: null, err: '' });
  const [bump, setBump] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const mine = s.id === id;
  useEffect(() => {
    if (!id) return;
    let live = true;
    const t = setTimeout(() => fnRef.current().then(
      data => { if (live) setS({ id, data, err: '' }); },
      e => { if (live) setS(o => ({ id, data: o.id === id ? o.data : null, err: (e as Error).message })); },
    ), mine ? delay : 0);
    return () => { live = false; clearTimeout(t); };
  }, [id, tick, bump]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data: mine ? s.data : null, err: mine ? s.err : '', reload: () => setBump(b => b + 1) };
}

// a phone held upright (mobile.css)
export const PHONE = '(max-width: 720px)';

export function useMedia(query: string) {
  const [on, setOn] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query), f = () => setOn(m.matches);
    f();
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, [query]);
  return on;
}

export function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
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

// Enter sends, Shift+Enter breaks the line, and neither while an IME is composing
export const enterSends = (send: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
};

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, Math.floor(n) - 1))}…` : s);

export const toggled = <T>(s: Set<T>, k: T) => {
  const x = new Set(s);
  if (x.has(k)) x.delete(k); else x.add(k);
  return x;
};

// the first sentence of a long text, cut to about n characters
export function gist(text: string | null | undefined, n = 90) {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const m = /^(.+?[。！？!?；;]|.+?\.(?=\s|$))/.exec(t);
  const first = m ? m[1] : t;
  return first.length > n ? `${first.slice(0, n - 1).trimEnd()}…` : first;
}

// a text split into its sentences
export function points(text: string | null | undefined): string[] {
  return (text ?? '').replace(/\s+/g, ' ').split(/(?<=[。！？!?；;])|(?<=\.)\s+/).map(s => s.trim()).filter(s => s.length > 1);
}

export const ext = (path: string) => (path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '');
export const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);

// Scrolls el into view sideways inside box only: scrollIntoView would also scroll the ancestors,
// the page's overflow-hidden root included.
export function revealX(box: HTMLElement | null, el: Element | null | undefined, center = false) {
  if (!box || !el) return;
  const b = box.getBoundingClientRect(), r = el.getBoundingClientRect();
  const left = r.left - b.left + box.scrollLeft;
  const to = center ? left - (box.clientWidth - r.width) / 2
    : r.left < b.left ? left - 16 : r.right > b.right ? left + r.width - box.clientWidth + 16 : box.scrollLeft;
  if (to !== box.scrollLeft) box.scrollTo({ left: to, behavior: 'smooth' });
}

// a record's values under dotted keys ("a.b.c"), a few levels down; arrays stay whole
export function flat(v: unknown, pre = '', out: [string, unknown][] = [], depth = 0): [string, unknown][] {
  if (v && typeof v === 'object' && !Array.isArray(v) && depth < 5) {
    for (const [k, x] of Object.entries(v)) flat(x, pre ? `${pre}.${k}` : k, out, depth + 1);
  } else if (pre) out.push([pre, v]);
  return out;
}

// the numbers worth showing first from a result: scores before counts and settings
const SCORE = /(overall|score|acc|accuracy|pass@1|pass_at_1|f1|bleu|rouge|em\b|exact|mean|avg|average|win|success|reward|auc|map\b|ndcg|recall|precision)/i;
const NOISE = /(^|\.)(rows|n|count|total|id|seed|step|steps|epoch|epochs|pid|time|elapsed|batch|size|samples|n_samples|top_k|top_p|temperature|port|gpu|gpus|lr)$/i;
export function headline(v: unknown, n = 4): [string, number][] {
  const nums = flat(v).filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1]) && !/^(config|args|params|hparams)\./i.test(e[0]));
  const good = nums.filter(([k]) => SCORE.test(k) && !NOISE.test(k));
  const rest = nums.filter(([k]) => !SCORE.test(k) && !NOISE.test(k));
  return [...good, ...rest].slice(0, n);
}

// Each key by its shortest dotted tail no other key shares (ChartQA.overall, TextVQA.overall…);
// a generic last part keeps its parent.
const GENERIC = /^(overall|score|scores|acc|accuracy|mean|avg|average|value|total|result|f1|em|exact|all)$/i;
export function tails(keys: string[]): string[] {
  const parts = keys.map(k => k.split('.'));
  return parts.map((p, i) => {
    for (let n = GENERIC.test(p[p.length - 1]) && p.length > 1 ? 2 : 1; n <= p.length; n++) {
      const tail = p.slice(-n).join('.');
      if (parts.every((q, j) => j === i || q.slice(-n).join('.') !== tail)) return tail;
    }
    return keys[i];
  });
}
export const headlines = (v: unknown, n = 4) => {
  const h = headline(v, n), names = tails(h.map(([k]) => k));
  return h.map(([k, x], i) => ({ k, name: names[i], v: x }));
};

// a status line's progress: "42%", "epoch 3/10"
export function pctOf(line: string | null | undefined): number | null {
  const m = /(\d+(?:\.\d+)?)\s*%/.exec(line ?? '') ?? /(\d+)\s*\/\s*(\d+)/.exec(line ?? '');
  if (!m) return null;
  return m[2] ? (100 * +m[1]) / Math.max(1, +m[2]) : +m[1];
}

// the last non-empty line of an error, where a traceback says what went wrong
export const lastLine = (s: string | null | undefined) => (s ?? '').split('\n').map(x => x.trim()).filter(Boolean).at(-1) ?? '';
