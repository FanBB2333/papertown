// An agent's conversations in Paseo, for going back to one: the list, and the same list dropped down from a header.

import { useEffect, useRef, useState } from 'react';
import { api, type AssistantConv } from '../api';
import { tr } from '../i18n';
import { ago } from './util';

// an agent's conversations in Paseo, the latest first; `at` reloads them when its conversation changes
export function Earlier({ agent = 'assistant', at, onPick, limit, title }: {
  agent?: string; at?: string | null; onPick: (c: AssistantConv) => void; limit?: number; title?: string;
}) {
  const [list, setList] = useState<AssistantConv[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.convs(agent).then(r => setList(r.conversations), e => setErr((e as Error).message)); }, [agent, at]);
  const shown = limit ? (list ?? []).filter(c => !c.current).slice(0, limit) : list ?? [];
  if (limit && !shown.length) return null;
  return (
    <div className="as-convs">
      {title && <h4>{title}</h4>}
      {err ? <p className="as-none">{err}</p>
        : !list ? <p className="as-none">{tr('加载中…')}</p>
          : !shown.length ? <p className="as-none">{tr('暂无历史对话。')}</p>
            : shown.map(c => (
              <button key={c.id} className={`as-conv${c.current ? ' on' : ''}`} disabled={c.current} onClick={() => onPick(c)}>
                <b>{c.title || tr('（无标题）')}</b>
                <span>{c.current ? tr('正在进行') : ago(c.at)}{c.model ? ` · ${c.model}` : ''}</span>
              </button>
            ))}
    </div>
  );
}

// earlier conversations, dropped down from the header
export function History({ agent, onPick, onClose }: { agent?: string; onPick: (c: AssistantConv) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Element;
      if (!ref.current?.contains(t) && !t.closest('.as-hist')) onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    addEventListener('pointerdown', down, true);
    addEventListener('keydown', key, true);
    return () => { removeEventListener('pointerdown', down, true); removeEventListener('keydown', key, true); };
  }, [onClose]);
  return (
    <div className="as-pop" ref={ref} role="dialog" aria-label={tr('历史对话')}>
      <h5>{tr('历史对话')}</h5>
      <Earlier agent={agent} onPick={onPick} />
    </div>
  );
}
