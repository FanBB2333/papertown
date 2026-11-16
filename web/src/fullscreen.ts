// Full screen for the 3D walk. Chromium's Keyboard Lock keeps the walk's keys (Ctrl+W crouches instead
// of closing the tab); while something is open over the walk Esc is held too, so it closes that first.

import { getSettings } from './settings';

const KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyC', 'KeyF', 'KeyM', 'KeyT', 'KeyV', 'Space', 'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight'];
let ours = false;
let esc = false;

type KeyboardLock = { lock?(codes: string[]): Promise<void>; unlock?(): void };
const keyboard = () => (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;
const lockKeys = () => { void keyboard()?.lock?.(esc ? [...KEYS, 'Escape'] : KEYS)?.catch(() => {}); };

export function enterFull() {
  if (!getSettings().fullscreen3d || document.fullscreenElement || !document.documentElement.requestFullscreen) return;
  ours = true;
  document.documentElement.requestFullscreen({ navigationUI: 'hide' })
    .then(lockKeys)
    .catch(() => { ours = false; });
}

export function leaveFull() {
  if (!ours) return;
  ours = false;
  keyboard()?.unlock?.();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

export function holdEscape(on: boolean) {
  if (esc === on) return;
  esc = on;
  if (ours && document.fullscreenElement) lockKeys();
}

document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) ours = false; });
