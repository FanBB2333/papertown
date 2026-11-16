// The floating window on every page: the town's assistant. Closed, a line at the bottom to click (or press /);
// open, the conversation with it, whose message box also takes a new idea or the rewrite of one.

import { useEffect, useLayoutEffect, useState } from 'react';
import { Assistant, type Target } from '../console/Assistant';
import { Icon } from '../console/icons';
import { useLens } from '../glass';
import { tr } from '../i18n';
import { typing } from './walk';
import '../dock.css';

export function Dock({ view, open, setOpen, away, target, setTarget, focusKey, onIdea, onAdjust, toast }: {
  view: string; open: boolean; setOpen: (open: boolean) => void; away: boolean;
  target: Target; setTarget: (t: Target) => void; focusKey: number;
  onIdea: (text: string, budget: number) => Promise<boolean>; onAdjust: (lineId: string, text: string) => Promise<boolean>;
  toast: (t: string) => void;
}) {
  const lens = useLens<HTMLDivElement>(14, 30);
  const col = useColumn(view);
  const [shown, setShown] = useState(open);
  const [nudge, setNudge] = useState(0);
  const wake = () => { setOpen(true); setNudge(n => n + 1); };

  useEffect(() => {
    if (open) { setShown(true); return; }
    const t = setTimeout(() => setShown(false), 520);
    return () => clearTimeout(t);
  }, [open]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || (away && !open) || document.querySelector('.settings')) return;
      if (typing(e, '.cm-editor')) return;
      e.preventDefault();
      wake();
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [away, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const style = col ? { left: col.x, ['--dk-room' as string]: `${col.w}px` } : undefined;
  return (
    <div className={`dock${open ? ' open' : ''}${away ? ' away' : ''}`} style={style}>
      {/* on a phone the closed window is this button in the corner (mobile.css) */}
      <button className="dk-fab" onClick={wake} aria-label={tr('小助手')}><Icon n="chat" size={22} /></button>
      <div className="dk-shell" ref={lens}>
        <div className="dk-grow" aria-hidden={!open}>
          <div className="dk-panel">
            {shown && (
              <div className="dk-in">
                <Assistant toast={toast} onClose={() => setOpen(false)} target={target} setTarget={setTarget} focusKey={focusKey + nudge}
                  onIdea={onIdea} onAdjust={onAdjust} />
              </div>
            )}
          </div>
        </div>
        {!open && (
          <button className="dk-call" onClick={wake} title={tr('问这一页的事、请它帮你办，或者写一个新 idea（/）')}>
            <Icon n="chat" size={17} /><span>{tr('问小助手，或者写一个新 idea')}</span><kbd className="dk-kbd">/</kbd>
          </button>
        )}
      </div>
    </div>
  );
}

// in the console the window sits over the panel column, not the whole width; on a project's canvas (progress/Canvas.tsx)
// over the canvas, clear of the inspector beside it
function useColumn(view: string) {
  const [col, setCol] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    if (view === 'console') return;
    const root = document.querySelector<HTMLElement>('.proto');
    if (!root) { setCol(null); return; }
    const ro = new ResizeObserver(measure);
    let seen: Element | null = null;
    function measure() {
      const flow = root!.querySelector<HTMLElement>(':scope > .cv .cv-flow');
      if (flow !== seen) { ro.disconnect(); seen = flow; if (flow) ro.observe(flow); }
      if (!flow) { setCol(null); return; }
      const b = flow.getBoundingClientRect(), o = root!.getBoundingClientRect();
      const x = Math.round(b.left - o.left + b.width / 2), w = Math.round(b.width);
      setCol(c => (c && c.x === x && c.w === w ? c : { x, w }));
    }
    const mo = new MutationObserver(measure);
    mo.observe(root, { childList: true });
    measure();
    return () => { ro.disconnect(); mo.disconnect(); };
  }, [view]);
  useLayoutEffect(() => {
    if (view !== 'console') return;
    const host = document.querySelector<HTMLElement>('.p-console');
    if (!host) return;
    function measure() {
      const cm = host!.querySelector<HTMLElement>('.cbody > .cm');
      if (!cm) return;
      const x = Math.round(cm.offsetLeft + cm.offsetWidth / 2), w = cm.offsetWidth;
      setCol(c => (c && c.x === x && c.w === w ? c : { x, w }));
    }
    const ro = new ResizeObserver(measure);
    const mo = new MutationObserver(watch);
    function watch() {
      ro.disconnect();
      const body = host!.querySelector<HTMLElement>('.cbody'), cm = body?.querySelector<HTMLElement>(':scope > .cm');
      if (body) { ro.observe(body); mo.observe(body, { childList: true }); }
      if (cm) ro.observe(cm);
      measure();
    }
    mo.observe(host, { childList: true });
    watch();
    return () => { ro.disconnect(); mo.disconnect(); };
  }, [view]);
  return col;
}
