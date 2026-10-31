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

// a record's values under the keys that lead to them, "a.b.c", up to a few levels down;
// lists of records stay whole, as one value
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

// Each key by its shortest dotted tail that no other key in the set shares, so three
// "…overall"s read as ChartQA.overall, TextVQA.overall…; a generic last part keeps its parent.
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
// a result's headline numbers with the names to show them by
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

// the line of an error that says what went wrong: a traceback ends with it
export const lastLine = (s: string | null | undefined) => (s ?? '').split('\n').map(x => x.trim()).filter(Boolean).at(-1) ?? '';
