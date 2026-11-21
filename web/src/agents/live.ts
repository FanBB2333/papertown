import { useCallback, useEffect, useRef } from 'react';
import { listen, type Agent } from '../api';
import { feedLive, markSeen } from './overview';
import { isWorking } from './watch';

// Serialize reads. A bus event asks for a fresh read, at most one a second, and a slow poll covers what
// events miss. `pushed`: the caller applies the bus events itself (pi), so only the poll reads again.
export function useTalkPoll(agent: Agent, read: () => Promise<void>, pushed = false) {
  const latest = useRef({ agent, read }); latest.current = { agent, read };
  const reload = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true, busy = false, dirty = false, timer = 0, last = 0;
    const wait = () => {
      const a = latest.current.agent;
      // without the live feed the poll is all a working Paseo conversation has
      return !isWorking(a) ? 15000 : a.runtime === 'paseo' && !feedLive() ? 2000 : 5000;
    };
    const tick = async () => {
      if (busy) { dirty = true; return; }
      clearTimeout(timer); busy = true; last = Date.now();
      try { await latest.current.read(); } finally {
        busy = false;
        if (alive) {
          if (dirty) { dirty = false; soon(); }
          else timer = window.setTimeout(tick, wait());
        }
      }
    };
    const soon = () => {
      if (busy) { dirty = true; return; }
      clearTimeout(timer);
      timer = window.setTimeout(tick, Math.max(0, 1000 - (Date.now() - last)));
    };
    reload.current = () => { void tick(); };
    void tick();
    const off = pushed ? () => {} : listen(e => {
      if ((e.type === 'agent_live' && e.agent_id === agent.id) || (e.type === 'agent_event' && e.event?.agent_id === agent.id)
        || (e.type === 'agent' && e.agent?.id === agent.id)) soon();
    });
    return () => { alive = false; off(); clearTimeout(timer); reload.current = () => {}; };
  }, [agent.id, pushed]);
  return useCallback(() => reload.current(), []);
}

// Focus alone never acknowledges content that arrived in the background.
export function useReadReceipt(id: string, content: string | null) {
  const ref = useRef<HTMLDivElement | null>(null), ready = useRef(content !== null);
  ready.current = content !== null;
  const visible = () => {
    const el = ref.current;
    return !!el && !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden'
      && !el.closest('[aria-hidden=true]') && !document.querySelector('.demo-veil, .st-page')
      && document.visibilityState === 'visible' && document.hasFocus();
  };
  useEffect(() => {
    if (content === null || !visible()) return;
    // Coalesce streamed fragments, and check the foreground again before acknowledging them.
    const timer = setTimeout(() => { if (visible()) markSeen(id); }, 200);
    return () => clearTimeout(timer);
  }, [id, content]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let shown = !!el.getClientRects().length;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !shown && ready.current && visible()) markSeen(id);
      shown = entry.isIntersecting;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [id]);
  return ref;
}
