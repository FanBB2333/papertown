// The language the town is shown in: English (the default), Simplified or Traditional Chinese.
// The sources and the server write Simplified Chinese; tr() turns one of the app's own strings
// into the chosen language and localize() does the same for what the server sends. English
// comes from the dictionary in i18n/en.json, keyed by the Chinese; Traditional Chinese is
// converted with OpenCC. Switching saves the choice and reloads the page, so the strings that
// are worked out once when a module loads are always in the language in use.
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
  } catch { /* storage blocked: the default */ }
  return 'en';
}

export const LANG: Lang = stored();
let hant: ((s: string) => string) | null = null;

// before the app's modules load: the converter for Traditional Chinese, and the font's glyph set
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
  try { localStorage.setItem(KEY, lang); } catch { /* the choice lasts this page only */ }
  location.reload();
}

// {0}, {1}… are the arguments; in English {0|paper|papers} picks a word by the number in {0}
function fill(s: string, args: unknown[]) {
  if (!args.length) return s;
  return s.replace(/\{(\d+)(?:\|([^|{}]*)\|([^|{}]*))?\}/g, (m, i, one, many) => {
    if (+i >= args.length) return m;
    return one === undefined ? String(args[+i]) : Number(args[+i]) === 1 ? one : many;
  });
}

const toHant = (s: string) => (hant && CJK.test(s) ? hant(s) : s);

// one of the app's own strings, written in Simplified Chinese in the source
export function tr(key: string, ...args: unknown[]): string {
  if (LANG === 'en') return fill(DICT[key] ?? key, args);
  return fill(LANG === 'zh-Hant' ? toHant(key) : key, args);
}

// ---------- what the server sends ----------

// the dictionary's templates ("{0} 个项目在跑"), as patterns that match a filled-in string; only
// those with enough fixed text, some of it Chinese, to be recognised, so that nobody's prose
// matches by accident
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
      // "{0}{1}": the first of two values side by side is a sentence of its own, or nothing
      return parts[i + 1] === '' && /^\{\d+\}$/.test(parts[i + 2] ?? '') ? '((?:[\\s\\S]*?[。！？；.!?])?)' : '([\\s\\S]*?)';
    }).join('');
    out.push({ re: new RegExp(`^${src}$`), en: en.replace(/\{(\d+)/g, (_, i) => `{${order.indexOf(+i)}`) });
  }
  // the longest fixed text first, so the most specific template wins
  return out.sort((a, b) => b.re.source.length - a.re.source.length);
}

const SEPARATORS = /(\s+·\s+|；|、)/;
const PUNCT: Record<string, string> = { '；': '; ', '、': ', ', '：': ': ', '，': ', ', '。': '. ', '（': ' (', '）': ')', '「': '“', '」': '”' };
const punct = (s: string) => s.replace(/[；、：，。（）「」]/g, c => PUNCT[c]).replace(/ +$/, '');
const cache = new Map<string, string>();

// the dictionary entry or template for the whole of s, or null
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

function english(s: string, depth = 0): string {
  if (depth > 3 || s.length > 400) return DICT[s] ?? s;
  const whole = direct(s, depth);
  if (whole !== null) return whole;
  const sub = (x: string) => (CJK.test(x) ? english(x, depth + 1) : x);
  // a long text cut short ("多智能体通过 model context pr…"), as the server titles a project by its idea
  if (s.endsWith('…') && s.length > 12) {
    const head = s.slice(0, -1);
    const full = Object.keys(DICT).find(k => k.length > s.length && k.startsWith(head));
    if (full) { const en = DICT[full]; return en.length > 40 ? `${en.slice(0, 39).trimEnd()}…` : en; }
  }
  // a line at a time
  if (s.includes('\n')) return s.split('\n').map(sub).join('\n');
  // a sentence at a time, the longest run of sentences that one entry covers first
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
  // "a · b", "a；b", "a、b": the parts one by one
  const parts = s.split(SEPARATORS);
  if (parts.length > 1) return parts.map((x, i) => (i % 2 ? PUNCT[x] ?? x : sub(x))).join('');
  // "（text）"
  const paren = s.match(/^（([^（）]+)）$/);
  if (paren) return `(${sub(paren[1])})`;
  // "label：text"
  const colon = s.indexOf('：');
  if (colon > 0 && colon < s.length - 1) return `${sub(s.slice(0, colon))}: ${sub(s.slice(colon + 1))}`;
  // names and terms among other text ("方法设计师 D-03 Lv.2"), only when every Chinese word is known
  const words = s.match(/[\u4e00-\u9fff]+/g) ?? [];
  if (words.length && words.every(w => DICT[w] !== undefined)) return punct(s.replace(/[\u4e00-\u9fff]+/g, w => DICT[w]));
  return s;
}

// one string from the server (or from the shared design sources) in the language in use
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

// every string in a server response, in place; keys are left alone
export function localize<T>(data: T): T {
  if (LANG === 'zh-Hans') return data;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return trx(v);
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = walk(v[i]); return v; }
    if (v && typeof v === 'object') { for (const k of Object.keys(v)) (v as Record<string, unknown>)[k] = walk((v as Record<string, unknown>)[k]); return v; }
    return v;
  };
  return walk(data) as T;
}
