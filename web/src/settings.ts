// Your own settings for the town: how it looks and moves, the 2D map, the 3D walk. They
// live in this browser (localStorage) and every part of the page reads them through
// useSettings, so a change shows at once.

import { useSyncExternalStore } from 'react';
import type { Pane } from './api';

export type PgSort = 'need' | 'recent' | 'progress' | 'number';
export type PgGroup = 'none' | 'state' | 'stage';

export interface Settings {
  // look and motion
  ui: 'cloudflare' | 'paper'; // the whole page: Cloudflare's components, or ink and paper
  mode: 'light' | 'dark' | 'system'; // light or dark, with Cloudflare's look
  motion: 'full' | 'calm'; // calm: shorter, gentler animations
  grain: number; // paper grain over the page, 0..1
  start: 'cards' | 'console' | '2d' | '3d'; // where going in from the landing leads: the projects' progress, the console, or the town in 2D or 3D
  // the map
  smoothMap: boolean; // eased zoom and a little glide after a drag
  zoomSpeed: number; // 0.5..2, wheel zoom per notch
  mapLabels: 'key' | 'all';
  walkHint: boolean;
  // the 3D walk
  sensitivity: number; // 0.3..3, times the default mouse speed
  invertY: boolean;
  fov: number; // degrees, 55..95
  hand: boolean; // your hand and pencil in view
  bob: boolean; // the view sways a little as you walk
  quality: 'low' | 'mid' | 'high';
  fullscreen3d: boolean; // the walk goes full screen
  tags3d: boolean; // building names over the town
  minimap: boolean;
  // the editor in the console (see console/edthemes.ts)
  edTheme: string; // a colour theme's id, or auto: the one that goes with the look of the page
  edIcons: 'dots' | 'glyphs' | 'badges' | 'none'; // the file icon theme
  // the progress page as this browser shows it; which parts a card shows is the server's (card_layout)
  pgView: 'blocks' | 'rows'; // a grid of cards, or a project to a line
  pgSort: PgSort;
  pgGroup: PgGroup;
  pgDensity: 'roomy' | 'tight';
  pgCard: 'narrow' | 'mid' | 'wide'; // the least a card's width may be
  pgText: 'small' | 'mid' | 'large';
  pgWidth: 'narrow' | 'mid' | 'full'; // how wide the page may grow on a big screen
  pgStages: boolean; // the bar of stages on each project
  pgDone: boolean; // finished projects in the list
  pgCols: Pane[]; // a row's columns, in order
}

export const DEFAULTS: Settings = {
  ui: 'cloudflare', mode: 'light', motion: 'full', grain: 0.5, start: 'cards',
  smoothMap: true, zoomSpeed: 1, mapLabels: 'key', walkHint: true,
  sensitivity: 1, invertY: false, fov: 68, hand: true, bob: true, quality: 'high', fullscreen3d: true, tags3d: true, minimap: true,
  edTheme: 'auto', edIcons: 'dots',
  pgView: 'blocks', pgSort: 'need', pgGroup: 'none', pgDensity: 'roomy', pgCard: 'mid', pgText: 'mid', pgWidth: 'mid', pgStages: true, pgDone: true,
  pgCols: ['summary', 'attention', 'running', 'planned'],
};

const KEY = 'pt-settings';
// every save writes all the settings, so what were defaults stay in old saves. Before version 2 the
// console was where to start and now the progress page is; before version 3 the editor's default
// was the paper theme and now it goes with the look of the page
const VERSION = 3;
let current: Settings = load();
const subs = new Set<() => void>();

// the look of the whole page, on <html>: index.html does the same before anything is painted
const darkOS = matchMedia('(prefers-color-scheme: dark)');
function applyLook() {
  const cf = current.ui === 'cloudflare', h = document.documentElement;
  h.classList.toggle('ui-cf', cf);
  h.dataset.mode = cf && (current.mode === 'dark' || (current.mode === 'system' && darkOS.matches)) ? 'dark' : 'light';
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', !cf ? '#f4eee2' : h.dataset.mode === 'dark' ? '#171717' : '#ffffff');
}
applyLook();
darkOS.addEventListener('change', () => { if (current.mode === 'system') setSettings({}); });

function load(): Settings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (v && typeof v === 'object') {
      const { v: ver = 1, ...saved } = v;
      return { ...DEFAULTS, ...saved, ...(ver < 2 && saved.start === 'console' ? { start: 'cards' } : {}), ...(ver < 3 && saved.edTheme === 'paper' ? { edTheme: 'auto' } : {}) };
    }
  } catch { /* private mode or bad data */ }
  return { ...DEFAULTS };
}

export function getSettings() { return current; }

export function setSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify({ ...current, v: VERSION })); } catch { /* ignore */ }
  applyLook();
  for (const f of subs) f();
}

export function resetSettings() { setSettings({ ...DEFAULTS }); }

export function onSettings(f: () => void) {
  subs.add(f);
  return () => { subs.delete(f); };
}

export function useSettings(): Settings {
  return useSyncExternalStore(onSettings, getSettings);
}
