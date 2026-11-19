// Per-browser settings, kept in localStorage; components read them through useSettings() so a change shows at once.

import { useSyncExternalStore } from 'react';
import type { Pane } from './api';

export type PgSort = 'need' | 'recent' | 'progress' | 'number';
export type PgGroup = 'none' | 'state' | 'stage';
export type Accent = 'blue' | 'purple' | 'pink' | 'red' | 'orange' | 'yellow' | 'green' | 'graphite';
export type Wall = 'dawn' | 'lagoon' | 'dusk' | 'forest' | 'paper' | 'graphite';

export interface Settings {
  ui: 'cloudflare' | 'macos' | 'paper';
  mode: 'light' | 'dark' | 'system';
  accent: Accent;
  wall: Wall;
  wallTint: boolean;
  glass: number;
  motion: 'full' | 'calm';
  grain: number;
  start: 'cards' | 'console' | '2d' | '3d';
  smoothMap: boolean;
  zoomSpeed: number;
  mapLabels: 'key' | 'all';
  walkHint: boolean;
  sensitivity: number;
  invertY: boolean;
  fov: number;
  hand: boolean;
  bob: boolean;
  quality: 'low' | 'mid' | 'high';
  fullscreen3d: boolean;
  tags3d: boolean;
  minimap: boolean;
  edTheme: string;
  edIcons: 'dots' | 'glyphs' | 'badges' | 'none';
  pgView: 'blocks' | 'rows';
  pgSort: PgSort;
  pgGroup: PgGroup;
  pgDensity: 'roomy' | 'tight';
  pgCard: 'narrow' | 'mid' | 'wide';
  pgText: 'small' | 'mid' | 'large';
  pgWidth: 'narrow' | 'mid' | 'full';
  pgStages: boolean;
  pgDone: boolean;
  pgCols: Pane[];
  // the research loop
  cvScroll: 'pan' | 'zoom';
  cvBg: 'dots' | 'lines' | 'none';
  cvGap: '16' | '22' | '32';
  cvSnapGrid: boolean;
  cvGuides: boolean;
  cvGuideDist: number;
  cvLines: boolean;
  cvAvoid: boolean;
  cvMarch: boolean;
  cvAdapt: boolean;
  cvLanes: boolean;
  cvLegend: boolean;
  cvMap: boolean;
  cvHint: boolean;
}

// the macOS app defaults to the macOS look; index.html's inline script must decide the same way
const inApp = /\bPapertown\//.test(navigator.userAgent);

export const DEFAULTS: Settings = {
  ui: inApp ? 'macos' : 'cloudflare', mode: 'light', accent: 'blue', wall: 'dawn', wallTint: true, glass: 0.45, motion: 'full', grain: 0.5, start: 'cards',
  smoothMap: true, zoomSpeed: 1, mapLabels: 'key', walkHint: true,
  sensitivity: 1, invertY: false, fov: 68, hand: true, bob: true, quality: 'high', fullscreen3d: true, tags3d: true, minimap: true,
  edTheme: 'auto', edIcons: 'dots',
  pgView: 'blocks', pgSort: 'need', pgGroup: 'none', pgDensity: 'roomy', pgCard: 'mid', pgText: 'mid', pgWidth: 'mid', pgStages: true, pgDone: true,
  pgCols: ['summary', 'attention', 'running', 'planned'],
  cvScroll: 'pan', cvBg: 'dots', cvGap: '22', cvSnapGrid: false, cvGuides: true, cvGuideDist: 8, cvLines: false, cvAvoid: true, cvMarch: true,
  cvAdapt: true, cvLanes: true, cvLegend: true, cvMap: false, cvHint: true,
};

// the loop's switches used to be kept on their own, under pt-canvas
function oldLoop(): Partial<Settings> {
  try {
    const o = JSON.parse(localStorage.getItem('pt-canvas') ?? 'null');
    if (!o || typeof o !== 'object') return {};
    const b = (k: string) => (typeof o[k] === 'boolean' ? o[k] : undefined);
    const out: Partial<Settings> = { cvMap: b('map'), cvSnapGrid: b('snap'), cvHint: b('hint'), cvLegend: b('legend'), cvLines: b('lines') };
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
  } catch { return {}; }
}

const KEY = 'pt-settings';
// Saves hold every setting, so old defaults persist: v2 moves start 'console' to 'cards', v3 edTheme 'paper' to 'auto'.
const VERSION = 3;
let current: Settings = load();
const subs = new Set<() => void>();

const darkOS = matchMedia('(prefers-color-scheme: dark)');
// The look as classes and data attributes on <html> (index.html does the same before first paint);
// the macOS look builds on the Cloudflare one, so ui-cf stays on under it.
function applyLook() {
  const { ui, mode, accent, wall, wallTint, glass } = current, h = document.documentElement;
  const flat = ui !== 'paper', mac = ui === 'macos';
  const dark = flat && (mode === 'dark' || (mode === 'system' && darkOS.matches));
  h.classList.toggle('ui-cf', flat);
  h.classList.toggle('ui-mac', mac);
  h.dataset.mode = dark ? 'dark' : 'light';
  if (mac) {
    h.dataset.accent = accent;
    h.dataset.wall = wallTint ? wall : 'none';
    h.style.setProperty('--g', String(glass));
  } else {
    delete h.dataset.accent;
    delete h.dataset.wall;
    h.style.removeProperty('--g');
  }
  const bar = !flat ? '#f4eee2' : mac ? (dark ? '#1c1c1e' : '#f5f5f7') : dark ? '#171717' : '#ffffff';
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', bar);
  (window as Window & { webkit?: { messageHandlers?: { look?: { postMessage(m: unknown): void } } } }).webkit?.messageHandlers?.look?.postMessage({ ui, dark, bar });
}
applyLook();
darkOS.addEventListener('change', () => { if (current.mode === 'system') setSettings({}); });

function load(): Settings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (v && typeof v === 'object') {
      const { v: ver = 1, ...saved } = v;
      return { ...DEFAULTS, ...('cvLines' in saved ? {} : oldLoop()), ...saved, ...(ver < 2 && saved.start === 'console' ? { start: 'cards' } : {}), ...(ver < 3 && saved.edTheme === 'paper' ? { edTheme: 'auto' } : {}) };
    }
  } catch { /* storage blocked or bad data */ }
  return { ...DEFAULTS, ...oldLoop() };
}

export function getSettings() { return current; }

export function setSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify({ ...current, v: VERSION })); } catch { /* storage blocked */ }
  applyLook();
  for (const f of subs) f();
}

export function resetSettings() { setSettings(DEFAULTS); }

export function onSettings(f: () => void) {
  subs.add(f);
  return () => { subs.delete(f); };
}

export function useSettings(): Settings {
  return useSyncExternalStore(onSettings, getSettings);
}
