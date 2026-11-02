// Your own settings for the town: how it looks and moves, the 2D map, the 3D walk. They
// live in this browser (localStorage) and every part of the page reads them through
// useSettings, so a change shows at once.

import { useSyncExternalStore } from 'react';

export interface Settings {
  // look and motion
  motion: 'full' | 'calm'; // calm: shorter, gentler animations
  grain: number; // paper grain over the page, 0..1
  start: 'console' | '2d' | '3d'; // what the page opens on: the console, or the town in 2D or 3D
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
  edTheme: string; // a colour theme's id
  edIcons: 'dots' | 'glyphs' | 'badges' | 'none'; // the file icon theme
}

export const DEFAULTS: Settings = {
  motion: 'full', grain: 0.5, start: 'console',
  smoothMap: true, zoomSpeed: 1, mapLabels: 'key', walkHint: true,
  sensitivity: 1, invertY: false, fov: 68, hand: true, bob: true, quality: 'high', fullscreen3d: true, tags3d: true, minimap: true,
  edTheme: 'paper', edIcons: 'dots',
};

const KEY = 'pt-settings';
let current: Settings = load();
const subs = new Set<() => void>();

function load(): Settings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (v && typeof v === 'object') return { ...DEFAULTS, ...v };
  } catch { /* private mode or bad data */ }
  return { ...DEFAULTS };
}

export function getSettings() { return current; }

export function setSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* ignore */ }
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
