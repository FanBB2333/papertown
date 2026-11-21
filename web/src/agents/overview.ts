// One overview subscription for the HUD and the page, including its fallback poll.
import { useEffect, useSyncExternalStore } from 'react';
import { api, listen, type Overview } from '../api';

let state: { data: Overview | null; error: string } = { data: null, error: '' };
const subs = new Set<() => void>();
let pending: Promise<void> | null = null, dirty = false, timer = 0, poll = 0, startedAt = 0;
let off: (() => void) | null = null;

export function refreshOverview(): Promise<void> {
  if (pending) { dirty = true; return pending; }
  startedAt = Date.now();
  pending = api.overview().then(data => { state = { data, error: '' }; }, e => {
    state = { ...state, error: (e as Error).message };
  }).finally(() => {
    pending = null;
    for (const f of subs) f();
    if (dirty && subs.size) { dirty = false; void refreshOverview(); }
  });
  return pending;
}

function subscribe(f: () => void) {
  subs.add(f);
  if (subs.size === 1) {
    dirty = false;
    if (!pending) void refreshOverview();
    off = listen(e => {
      if (!['agent', 'agent_event', 'report'].includes(e.type)) return;
      clearTimeout(timer);
      timer = window.setTimeout(refreshOverview, 300);
    });
    poll = window.setInterval(refreshOverview, 20000);
  }
  return () => {
    subs.delete(f);
    if (subs.size) return;
    off?.(); off = null;
    clearTimeout(timer); clearInterval(poll);
  };
}

export function useOverview() {
  const value = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    // Opening the page refreshes cached data without duplicating the HUD's initial request.
    if (!pending && Date.now() - startedAt > 300) void refreshOverview();
  }, []);
  return value;
}

// whether the server follows Paseo through its live feed (else it polls, and so do open conversations)
export const feedLive = () => !!state.data?.paseo.live;

export function markSeen(id: string) {
  // A failed read receipt must not turn a successful message into a send failure.
  void api.seen(id).catch(() => {});
}
