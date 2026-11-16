// UI language: English (default, from i18n/en.json keyed by the Simplified Chinese source), Simplified,
// or Traditional (converted with OpenCC). tr() is for the app's strings, localize() for server data.
// Switching reloads the page, because modules compute tr() strings once when they load.
import EN from './i18n/en.json';

export type Lang = 'en' | 'zh-Hans' | 'zh-Hant';
export const LANGS: [Lang, string][] = [['en', 'English'], ['zh-Hans', '简体中文'], ['zh-Hant', '繁體中文']];

const KEY = 'papertown.lang';
const DICT = EN as Record<string, string>;
const CJK = /[　-〿一-鿿＀-￯]/;

function stored(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'en' || v === 'zh-Hans' || v === 'zh-Hant') return v;
  } catch { /* storage blocked */ }
  return 'en';
}

export const LANG: Lang = stored();
let hant: ((s: string) => string) | null = null;

// Must finish before the app's modules load: the OpenCC converter and the font's glyph set.
export async function loadLang() {
  document.documentElement.lang = LANG;
  if (LANG === 'zh-Hant') {
    const [{ Converter }] = await Promise.all([import('opencc-js/cn2t'), import('lxgw-wenkai-screen-webfont/lxgwwenkaiscreen.css')]);
    hant = Converter({ from: 'cn', to: 'twp' });
  } else {
    await import('lxgw-wenkai-screen-webfont/lxgwwenkaigbscreen.css');
  }
}

export function setLang(lang: Lang) {
  if (lang === LANG) return;
  try { localStorage.setItem(KEY, lang); } catch { /* storage blocked */ }
  location.reload();
}

// {0}, {1}… are the arguments; {0|paper|papers} picks a word by the number in {0}
function fill(s: string, args: unknown[]) {
  if (!args.length) return s;
  return s.replace(/\{(\d+)(?:\|([^|{}]*)\|([^|{}]*))?\}/g, (m, i, one, many) => {
    if (+i >= args.length) return m;
    return one === undefined ? String(args[+i]) : Number(args[+i]) === 1 ? one : many;
  });
}

const toHant = (s: string) => (hant && CJK.test(s) ? hant(s) : s);

export function tr(key: string, ...args: unknown[]): string {
  if (LANG === 'en') return fill(DICT[key] ?? key, args);
  return fill(LANG === 'zh-Hant' ? toHant(key) : key, args);
}

// The dictionary's templates ("{0} 个项目在跑") as regexes for filled-in strings; only those with enough
// Chinese fixed text, so free prose cannot match by accident. Longest first, so the most specific wins.
interface Pattern { re: RegExp; en: string }
let patterns: Pattern[] | null = null;
function compile(): Pattern[] {
  const out: Pattern[] = [];
  for (const [key, en] of Object.entries(DICT)) {
    if (!/\{\d+\}/.test(key)) continue;
    const fixed = key.replace(/\{\d+\}/g, '').replace(/\s/g, '');
    if (fixed.length < 3 || !CJK.test(fixed)) continue;
    const order: number[] = [];
    const parts = key.split(/(\{\d+\})/);
    const src = parts.map((part, i) => {
      const m = part.match(/^\{(\d+)\}$/);
      if (!m) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      order.push(+m[1]);
      // "{0}{1}": the first of two adjacent values is a whole sentence, or empty
      return parts[i + 1] === '' && /^\{\d+\}$/.test(parts[i + 2] ?? '') ? '((?:[\\s\\S]*?[。！？；.!?])?)' : '([\\s\\S]*?)';
    }).join('');
    out.push({ re: new RegExp(`^${src}$`), en: en.replace(/\{(\d+)/g, (_, i) => `{${order.indexOf(+i)}`) });
  }
  return out.sort((a, b) => b.re.source.length - a.re.source.length);
}

const SEPARATORS = /(\s+·\s+|；|、)/;
const PUNCT: Record<string, string> = { '；': '; ', '、': ', ', '：': ': ', '，': ', ', '。': '. ', '（': ' (', '）': ')', '「': '“', '」': '”' };
const punct = (s: string) => s.replace(/[；、：，。（）「」]/g, c => PUNCT[c]).replace(/ +$/, '');
const cache = new Map<string, string>();

function direct(s: string, depth: number): string | null {
  const hit = DICT[s];
  if (hit !== undefined) return hit;
  const trimmed = s.trim();
  if (trimmed !== s && DICT[trimmed] !== undefined) return s.replace(trimmed, DICT[trimmed]);
  patterns ??= compile();
  for (const p of patterns) {
    const m = s.match(p.re);
    if (m) return fill(p.en, m.slice(1).map(x => (CJK.test(x) ? english(x, depth + 1) : x)));
  }
  return null;
}

// Tries the whole string, then a truncated title, lines, runs of sentences, separators, "（…）",
// "label：text", and finally word by word when every Chinese word is in the dictionary.
function english(s: string, depth = 0): string {
  if (depth > 3 || s.length > 400) return DICT[s] ?? s;
  const whole = direct(s, depth);
  if (whole !== null) return whole;
  const sub = (x: string) => (CJK.test(x) ? english(x, depth + 1) : x);
  if (s.endsWith('…') && s.length > 12) {
    const head = s.slice(0, -1);
    const full = Object.keys(DICT).find(k => k.length > s.length && k.startsWith(head));
    if (full) { const en = DICT[full]; return en.length > 40 ? `${en.slice(0, 39).trimEnd()}…` : en; }
  }
  if (s.includes('\n')) return s.split('\n').map(sub).join('\n');
  const sen = s.split(/(?<=[。！？])/).filter(x => x.trim());
  if (sen.length > 1) {
    const out: string[] = [];
    for (let i = 0; i < sen.length;) {
      let j = sen.length, hit: string | null = null;
      for (; j > i + 1 && hit === null; j--) hit = direct(sen.slice(i, j).join(''), depth);
      if (hit !== null) j++; else hit = sub(sen[i]);
      out.push(hit.trim());
      i = j;
    }
    return out.join(' ');
  }
  const parts = s.split(SEPARATORS);
  if (parts.length > 1) return parts.map((x, i) => (i % 2 ? PUNCT[x] ?? x : sub(x))).join('');
  const paren = s.match(/^（([^（）]+)）$/);
  if (paren) return `(${sub(paren[1])})`;
  const colon = s.indexOf('：');
  if (colon > 0 && colon < s.length - 1) return `${sub(s.slice(0, colon))}: ${sub(s.slice(colon + 1))}`;
  const words = s.match(/[\u4e00-\u9fff]+/g) ?? [];
  if (words.length && words.every(w => DICT[w] !== undefined)) return punct(s.replace(/[\u4e00-\u9fff]+/g, w => DICT[w]));
  return s;
}

// a string from the server or the shared design sources
export function trx(s: string): string;
export function trx(s: string | null | undefined): string | null | undefined;
export function trx(s: string | null | undefined) {
  if (!s || LANG === 'zh-Hans' || !CJK.test(s)) return s;
  let v = cache.get(s);
  if (v === undefined) {
    v = LANG === 'en' ? english(s) : toHant(s);
    if (cache.size > 5000) cache.clear();
    cache.set(s, v);
  }
  return v;
}

// Translates every string value in place; objects that keep() accepts are left as written.
export function localize<T>(data: T, keep?: (v: object) => boolean): T {
  if (LANG === 'zh-Hans') return data;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return trx(v);
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = walk(v[i]); return v; }
    if (v && typeof v === 'object') {
      if (keep?.(v)) return v;
      for (const k of Object.keys(v)) (v as Record<string, unknown>)[k] = walk((v as Record<string, unknown>)[k]);
      return v;
    }
    return v;
  };
  return walk(data) as T;
}
