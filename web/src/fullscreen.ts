// The 3D walk full screen (Settings › 3D walk). Asked for in the click that starts the walk,
// and again in the click that takes the mouse back after Esc; left when you go back to the
// map. While full screen the keys the walk uses are held for the page, so Ctrl+W crouches
// and walks instead of closing the tab (Chromium's keyboard lock; Esc still leaves). With a
// room, the chat or the settings open over the walk, Esc is held too, so it closes that
// first rather than the full screen (holding Esc down still leaves it).

import { getSettings } from './settings';

const KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyC', 'KeyF', 'KeyM', 'KeyT', 'KeyV', 'Space', 'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight'];
let ours = false; // full screen because the walk asked for it
let esc = false; // Esc held for the page as well

type KeyboardLock = { lock?(codes: string[]): Promise<void>; unlock?(): void };
const keyboard = () => (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;
const lockKeys = () => { void keyboard()?.lock?.(esc ? [...KEYS, 'Escape'] : KEYS)?.catch(() => {}); };

export function enterFull() {
  if (!getSettings().fullscreen3d || document.fullscreenElement || !document.documentElement.requestFullscreen) return;
  ours = true;
  document.documentElement.requestFullscreen({ navigationUI: 'hide' })
    .then(lockKeys)
    .catch(() => { ours = false; }); // no click to go on (a link to #3d), or the browser said no
}

export function leaveFull() {
  if (!ours) return;
  ours = false;
  keyboard()?.unlock?.();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

// something is open over the walk (on) or nothing is any more
export function holdEscape(on: boolean) {
  if (esc === on) return;
  esc = on;
  if (ours && document.fullscreenElement) lockKeys(); // a new lock replaces the old one
}

// left full screen some other way (Esc, F11): nothing of ours to undo then
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) ours = false; });
