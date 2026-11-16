// The editor's looks, chosen the way VS Code chooses them: a colour theme for the code panel and
// the paper's source (the file list, the tabs, the editor and its status bar), and a file icon
// theme for the lists of files. A theme is a set of CSS variables set on the panel; the editor
// marks each token with a class (pt-…) whose colour is one of those variables, so switching, or
// previewing while you move through the list, needs no editor rebuilt (the classes are in
// highlight.ts, with the editor, so that nothing here loads CodeMirror). Kept in settings.ts.

import { useSyncExternalStore, type CSSProperties } from 'react';
import { getSettings, onSettings, setSettings } from '../settings';
import { tr } from '../i18n';

// the roles a token can play, each a colour in every theme
type Tok = 'kw' | 'ctl' | 'str' | 'esc' | 'num' | 'con' | 'com' | 'fn' | 'type' | 'var' | 'prop' | 'op' | 'punc' | 'tag' | 'macro' | 'attr'
  | 'head' | 'link' | 'label' | 'math' | 'mathCmd' | 'mathDelim' | 'meta' | 'bad' | 'quote' | 'mono' | 'list';

interface Ui {
  bg: string; fg: string; side: string; tabs: string; tabOn: string; border: string; muted: string; gutter: string; gutterOn: string;
  line: string; sel: string; cursor: string; match: string; bracket: string; hover: string; rowOn: string; input: string; accent: string;
  status: string; statusFg: string; add: string; del: string; gitMod: string; gitAdd: string; gitDel: string; pdf: string;
}

export interface EdTheme { id: string; name: string; dark: boolean; ui: Ui; tok: Record<Tok, string>; italic?: boolean }

const dk = (ui: Omit<Ui, 'add' | 'del' | 'pdf'>, pdf = '#1a1a1a'): Ui => ({ ...ui, add: 'rgba(80, 200, 120, .14)', del: 'rgba(240, 90, 80, .16)', pdf });
const lt = (ui: Omit<Ui, 'add' | 'del' | 'pdf'>, pdf = '#e9e5df'): Ui => ({ ...ui, add: 'rgba(60, 160, 80, .14)', del: 'rgba(220, 60, 50, .12)', pdf });

export const THEMES: EdTheme[] = [
  {
    id: 'paper', name: tr('纸墨'), dark: false, italic: true,
    ui: {
      bg: '#fdfaf4', fg: 'var(--ink)', side: 'var(--side)', tabs: 'var(--side)', tabOn: '#fdfaf4', border: 'var(--line)', muted: 'var(--muted)',
      gutter: 'color-mix(in srgb, var(--muted) 70%, transparent)', gutterOn: 'var(--ink)', line: 'color-mix(in srgb, var(--brand) 5%, transparent)',
      sel: 'color-mix(in srgb, var(--brand) 22%, transparent)', cursor: 'var(--brand)', match: 'color-mix(in srgb, var(--warn) 18%, transparent)',
      bracket: 'color-mix(in srgb, var(--ok) 22%, transparent)', hover: 'color-mix(in srgb, var(--ink) 5%, transparent)',
      rowOn: 'color-mix(in srgb, var(--brand) 14%, transparent)', input: 'var(--panel)', accent: 'var(--brand)',
      status: 'color-mix(in srgb, var(--brand) 78%, var(--ink))', statusFg: '#fff8ef', add: 'color-mix(in srgb, var(--ok) 15%, transparent)',
      del: 'color-mix(in srgb, var(--bad) 13%, transparent)', gitMod: 'var(--warn)', gitAdd: 'var(--ok)', gitDel: 'var(--bad)',
      pdf: 'color-mix(in srgb, var(--ink) 9%, var(--bg))',
    },
    tok: {
      kw: '#a5482c', ctl: '#9a3f63', str: '#5b7a37', esc: '#b9543f', num: '#a06a14', con: '#a06a14', com: '#a3927b', fn: '#2f6390',
      type: '#2e7472', var: 'var(--ink)', prop: '#7a4f93', op: '#6b5a46', punc: '#6b5a46', tag: '#a5482c', macro: '#2f6390', attr: '#7a4f93',
      head: '#2f261d', link: '#2f6390', label: '#2e7472', math: '#7a4f93', mathCmd: '#a5482c', mathDelim: '#a06a14', meta: '#857560',
      bad: '#b9543f', quote: '#857560', mono: '#a5482c', list: '#a06a14',
    },
  },
  {
    id: 'light', name: tr('经典浅色'), dark: false,
    ui: lt({
      bg: '#ffffff', fg: '#3b3b3b', side: '#f8f8f8', tabs: '#f8f8f8', tabOn: '#ffffff', border: '#e5e5e5', muted: '#6f6f6f', gutter: '#6e7681',
      gutterOn: '#171184', line: 'rgba(0, 0, 0, .035)', sel: '#add6ff', cursor: '#000000', match: 'rgba(234, 92, 0, .2)', bracket: 'rgba(0, 100, 0, .12)',
      hover: '#efefef', rowOn: '#e4e6f1', input: '#ffffff', accent: '#005fb8', status: '#007acc', statusFg: '#ffffff',
      gitMod: '#895503', gitAdd: '#587c0c', gitDel: '#ad0707',
    }),
    tok: {
      kw: '#0000ff', ctl: '#af00db', str: '#a31515', esc: '#ee0000', num: '#098658', con: '#0000ff', com: '#008000', fn: '#795e26', type: '#267f99',
      var: '#001080', prop: '#001080', op: '#3b3b3b', punc: '#3b3b3b', tag: '#800000', macro: '#0000ff', attr: '#e50000', head: '#800000',
      link: '#0451a5', label: '#0070c1', math: '#098658', mathCmd: '#795e26', mathDelim: '#af00db', meta: '#795e26', bad: '#cd3131',
      quote: '#0451a5', mono: '#a31515', list: '#0451a5',
    },
  },
  {
    id: 'dark', name: tr('经典深色'), dark: true,
    ui: dk({
      bg: '#1e1e1e', fg: '#d4d4d4', side: '#252526', tabs: '#252526', tabOn: '#1e1e1e', border: '#2b2b2b', muted: '#9d9d9d', gutter: '#858585',
      gutterOn: '#c6c6c6', line: 'rgba(255, 255, 255, .04)', sel: '#264f78', cursor: '#aeafad', match: 'rgba(234, 92, 0, .33)',
      bracket: 'rgba(0, 160, 0, .28)', hover: '#2a2d2e', rowOn: '#37373d', input: '#3c3c3c', accent: '#0078d4', status: '#007acc', statusFg: '#ffffff',
      gitMod: '#e2c08d', gitAdd: '#73c991', gitDel: '#c74e39',
    }),
    tok: {
      kw: '#569cd6', ctl: '#c586c0', str: '#ce9178', esc: '#d7ba7d', num: '#b5cea8', con: '#569cd6', com: '#6a9955', fn: '#dcdcaa', type: '#4ec9b0',
      var: '#9cdcfe', prop: '#9cdcfe', op: '#d4d4d4', punc: '#d4d4d4', tag: '#569cd6', macro: '#569cd6', attr: '#9cdcfe', head: '#569cd6',
      link: '#4daafc', label: '#d7ba7d', math: '#9cdcfe', mathCmd: '#dcdcaa', mathDelim: '#c586c0', meta: '#dcdcaa', bad: '#f44747',
      quote: '#6a9955', mono: '#ce9178', list: '#6796e6',
    },
  },
  {
    id: 'one-dark', name: 'One Dark', dark: true, italic: true,
    ui: dk({
      bg: '#282c34', fg: '#abb2bf', side: '#21252b', tabs: '#21252b', tabOn: '#282c34', border: '#181a1f', muted: '#7f848e', gutter: '#495162',
      gutterOn: '#abb2bf', line: '#2c313c', sel: '#3e4451', cursor: '#528bff', match: 'rgba(97, 175, 239, .2)', bracket: 'rgba(97, 175, 239, .28)',
      hover: '#2c313a', rowOn: '#323842', input: '#1d1f23', accent: '#61afef', status: '#21252b', statusFg: '#9da5b4',
      gitMod: '#e5c07b', gitAdd: '#98c379', gitDel: '#e06c75',
    }, '#1d2026'),
    tok: {
      kw: '#c678dd', ctl: '#c678dd', str: '#98c379', esc: '#56b6c2', num: '#d19a66', con: '#d19a66', com: '#7f848e', fn: '#61afef', type: '#e5c07b',
      var: '#e06c75', prop: '#e06c75', op: '#56b6c2', punc: '#abb2bf', tag: '#e06c75', macro: '#c678dd', attr: '#d19a66', head: '#e06c75',
      link: '#61afef', label: '#d19a66', math: '#56b6c2', mathCmd: '#61afef', mathDelim: '#e5c07b', meta: '#61afef', bad: '#ff616e',
      quote: '#7f848e', mono: '#98c379', list: '#e06c75',
    },
  },
  {
    id: 'monokai', name: 'Monokai', dark: true,
    ui: dk({
      bg: '#272822', fg: '#f8f8f2', side: '#1e1f1c', tabs: '#1e1f1c', tabOn: '#272822', border: '#151612', muted: '#a59f85', gutter: '#90908a',
      gutterOn: '#f8f8f2', line: '#3e3d32', sel: '#49483e', cursor: '#f8f8f0', match: 'rgba(255, 255, 255, .1)', bracket: 'rgba(166, 226, 46, .25)',
      hover: '#2d2e28', rowOn: '#414339', input: '#414339', accent: '#f92672', status: '#414339', statusFg: '#f8f8f2',
      gitMod: '#e6db74', gitAdd: '#a6e22e', gitDel: '#f92672',
    }, '#1a1b17'),
    tok: {
      kw: '#f92672', ctl: '#f92672', str: '#e6db74', esc: '#ae81ff', num: '#ae81ff', con: '#ae81ff', com: '#88846f', fn: '#a6e22e', type: '#66d9ef',
      var: '#f8f8f2', prop: '#f8f8f2', op: '#f92672', punc: '#f8f8f2', tag: '#f92672', macro: '#66d9ef', attr: '#a6e22e', head: '#a6e22e',
      link: '#66d9ef', label: '#e6db74', math: '#fd971f', mathCmd: '#66d9ef', mathDelim: '#f92672', meta: '#a6e22e', bad: '#f44747',
      quote: '#88846f', mono: '#e6db74', list: '#fd971f',
    },
  },
  {
    id: 'solarized-light', name: tr('Solarized 浅色'), dark: false, italic: true,
    ui: lt({
      bg: '#fdf6e3', fg: '#586e75', side: '#eee8d5', tabs: '#eee8d5', tabOn: '#fdf6e3', border: '#ddd6c1', muted: '#839496', gutter: '#93a1a1',
      gutterOn: '#586e75', line: 'rgba(147, 161, 161, .12)', sel: 'rgba(38, 139, 210, .2)', cursor: '#657b83', match: 'rgba(181, 137, 0, .2)',
      bracket: 'rgba(133, 153, 0, .25)', hover: 'rgba(147, 161, 161, .16)', rowOn: 'rgba(38, 139, 210, .14)', input: '#fdf6e3', accent: '#2aa198',
      status: '#eee8d5', statusFg: '#586e75', gitMod: '#b58900', gitAdd: '#859900', gitDel: '#dc322f',
    }, '#e8e1cd'),
    tok: {
      kw: '#859900', ctl: '#859900', str: '#2aa198', esc: '#dc322f', num: '#d33682', con: '#cb4b16', com: '#93a1a1', fn: '#268bd2', type: '#b58900',
      var: '#268bd2', prop: '#6c71c4', op: '#859900', punc: '#657b83', tag: '#268bd2', macro: '#cb4b16', attr: '#93a1a1', head: '#268bd2',
      link: '#2aa198', label: '#d33682', math: '#6c71c4', mathCmd: '#268bd2', mathDelim: '#dc322f', meta: '#cb4b16', bad: '#dc322f',
      quote: '#93a1a1', mono: '#2aa198', list: '#b58900',
    },
  },
  {
    id: 'solarized-dark', name: tr('Solarized 深色'), dark: true, italic: true,
    ui: dk({
      bg: '#002b36', fg: '#93a1a1', side: '#00212b', tabs: '#00212b', tabOn: '#002b36', border: '#073642', muted: '#839496', gutter: '#586e75',
      gutterOn: '#93a1a1', line: '#073642', sel: '#274642', cursor: '#d30102', match: 'rgba(181, 137, 0, .25)', bracket: 'rgba(133, 153, 0, .3)',
      hover: '#073642', rowOn: '#004454', input: '#003847', accent: '#2aa198', status: '#00212b', statusFg: '#93a1a1',
      gitMod: '#b58900', gitAdd: '#859900', gitDel: '#dc322f',
    }, '#001e26'),
    tok: {
      kw: '#859900', ctl: '#859900', str: '#2aa198', esc: '#dc322f', num: '#d33682', con: '#cb4b16', com: '#586e75', fn: '#268bd2', type: '#b58900',
      var: '#268bd2', prop: '#6c71c4', op: '#859900', punc: '#839496', tag: '#268bd2', macro: '#cb4b16', attr: '#93a1a1', head: '#268bd2',
      link: '#2aa198', label: '#d33682', math: '#6c71c4', mathCmd: '#268bd2', mathDelim: '#dc322f', meta: '#cb4b16', bad: '#dc322f',
      quote: '#586e75', mono: '#2aa198', list: '#b58900',
    },
  },
  {
    id: 'nord', name: 'Nord', dark: true, italic: true,
    ui: dk({
      bg: '#2e3440', fg: '#d8dee9', side: '#2b303b', tabs: '#2b303b', tabOn: '#3b4252', border: '#3b4252', muted: '#8c96aa', gutter: '#4c566a',
      gutterOn: '#d8dee9', line: '#3b4252', sel: '#434c5e', cursor: '#d8dee9', match: 'rgba(136, 192, 208, .22)', bracket: 'rgba(136, 192, 208, .28)',
      hover: '#353b49', rowOn: '#434c5e', input: '#3b4252', accent: '#88c0d0', status: '#3b4252', statusFg: '#d8dee9',
      gitMod: '#ebcb8b', gitAdd: '#a3be8c', gitDel: '#bf616a',
    }, '#252a33'),
    tok: {
      kw: '#81a1c1', ctl: '#81a1c1', str: '#a3be8c', esc: '#ebcb8b', num: '#b48ead', con: '#81a1c1', com: '#616e88', fn: '#88c0d0', type: '#8fbcbb',
      var: '#d8dee9', prop: '#d8dee9', op: '#81a1c1', punc: '#eceff4', tag: '#81a1c1', macro: '#88c0d0', attr: '#8fbcbb', head: '#88c0d0',
      link: '#88c0d0', label: '#8fbcbb', math: '#ebcb8b', mathCmd: '#88c0d0', mathDelim: '#81a1c1', meta: '#d08770', bad: '#bf616a',
      quote: '#616e88', mono: '#a3be8c', list: '#81a1c1',
    },
  },
];

// the default goes with the look of the page: ink on paper, or plain light or dark with Cloudflare's
function fitting() {
  const h = document.documentElement;
  return !h.classList.contains('ui-cf') ? 'paper' : h.dataset.mode === 'dark' ? 'dark' : 'light';
}
// on a Mac the window's own surfaces and accent go round the code, whose colours stay the theme's
const onMac = (th: EdTheme): EdTheme => ({
  ...th,
  ui: {
    ...th.ui, bg: 'light-dark(#fff, #1e1e20)', tabOn: 'light-dark(#fff, #1e1e20)', side: 'light-dark(#f6f6f8, #262629)', tabs: 'light-dark(#f6f6f8, #262629)',
    border: 'var(--mac-sep)', input: 'var(--mac-panel)', accent: 'var(--mac-accent)', status: 'var(--mac-accent)', statusFg: 'var(--mac-accent-ink)',
    rowOn: 'color-mix(in srgb, var(--mac-accent) 18%, transparent)', cursor: 'var(--mac-accent)',
  },
});
export function themeOf(id: string) {
  const th = THEMES.find(x => x.id === (id === 'auto' ? fitting() : id)) ?? THEMES[0];
  return id === 'auto' && document.documentElement.classList.contains('ui-mac') ? onMac(th) : th;
}
export const autoTheme = (): EdTheme => ({ ...themeOf('auto'), id: 'auto', name: tr('跟随界面（默认）') });

// the CSS variables a theme sets on the panel it colours
export function themeVars(th: EdTheme): CSSProperties {
  const v: Record<string, string> = {};
  for (const [k, c] of Object.entries(th.ui)) v[`--ed-${k}`] = c;
  for (const [k, c] of Object.entries(th.tok)) v[`--tk-${k}`] = c;
  v['--tk-com-style'] = th.italic ? 'italic' : 'normal';
  // a theme of its own colours also stands in for the page's, so what the panel borrows from the
  // page (buttons, notes, muted text) follows it; the paper theme is made of the page's colours
  if (!th.ui.fg.startsWith('var(')) Object.assign(v, { '--ink': th.ui.fg, '--muted': th.ui.muted, '--line': th.ui.border, '--panel': th.ui.input, '--panel2': th.ui.side, '--side': th.ui.side });
  return v as CSSProperties;
}

// ---------- file icon themes ----------

export type IconTheme = 'dots' | 'glyphs' | 'badges' | 'none';
export const ICON_THEMES: [IconTheme, string, string][] = [
  ['dots', tr('色点'), tr('文件名前一个小色块，最安静（默认）')],
  ['glyphs', tr('字标'), tr('彩色的类型缩写，像 Seti')],
  ['badges', tr('徽章'), tr('实心的文件和文件夹图标，常见文件夹各有颜色')],
  ['none', tr('无图标'), tr('只有文件名')],
];

// ---------- the choice, and a preview while choosing ----------

let preview: { theme?: string; icons?: IconTheme } | null = null;
let picker: 'theme' | 'icons' | null = null;
const subs = new Set<() => void>();
const emit = () => { snap = null; for (const f of subs) f(); };
const subscribe = (f: () => void) => { subs.add(f); const off = onSettings(f); return () => { subs.delete(f); off(); }; };

export interface Look { theme: EdTheme; icons: IconTheme; picker: 'theme' | 'icons' | null }
let snap: Look | null = null;
let last: unknown = null;
function look(): Look {
  const s = getSettings();
  if (!snap || last !== s) {
    last = s;
    snap = { theme: themeOf(preview?.theme ?? s.edTheme), icons: preview?.icons ?? s.edIcons, picker };
  }
  return snap;
}

export const useLook = () => useSyncExternalStore(subscribe, look);
export const openPicker = (mode: 'theme' | 'icons' = 'theme') => { picker = mode; emit(); };
export const closePicker = () => { picker = null; preview = null; emit(); };
export const previewLook = (p: { theme?: string; icons?: IconTheme } | null) => { preview = p; emit(); };
export function chooseLook(p: { theme?: string; icons?: IconTheme }) {
  preview = null;
  setSettings({ ...(p.theme ? { edTheme: p.theme } : {}), ...(p.icons ? { edIcons: p.icons } : {}) });
  emit();
}
