import type { ReactNode } from 'react';
import './emphasis.css';

export type Tone = 'info' | 'good' | 'warn' | 'bad';

export function figures(text: string, tone: Tone = 'info') {
  return text.split(/([−+-]?\d+(?:[,.]\d+)*(?:\/\d+(?:[,.]\d+)*)?%?)/g).map((part, i) =>
    i % 2 ? <span key={i} className="em-num" data-tone={tone}>{part}</span> : part);
}

export function stateTone(state?: string | null): Tone | undefined {
  switch (state) {
    case 'bad': case 'err': case 'down': case 'failed': case 'error': case 'fail': case 'block': case 'blocked': case 'missing':
    case 'over': case 'lost': case 'timeout': case 'offline': return 'bad';
    case 'warn': case 'risk': case 'near': case 'stale': case 'held': case 'changed': case 'moved': return 'warn';
  }
}

export function StateWord({ state, children }: { state?: string | null; children: ReactNode }) {
  const tone = stateTone(state);
  return <span className={tone ? 'em-state' : 'muted'} data-tone={tone}>{children}</span>;
}

// Some summaries are clipped on the canvas. Count visible text, never the delimiters.
export function modelText(text?: string | null, limit?: number): ReactNode {
  if (!text) return text;
  const parts = text.split(/(`{3}[\s\S]*?`{3}|`[^`\n]+`|\*\*[^\s*](?:[^*]*?[^\s*])?\*\*)/g);
  let left = limit ?? Infinity;
  const result: ReactNode[] = [];
  for (let i = 0; i < parts.length; i++) {
    const marked = i % 2 === 1 && parts[i].startsWith('**');
    const value = marked ? parts[i].slice(2, -2) : parts[i];
    if (!value) continue;
    const visible = value.slice(0, left);
    if (visible) result.push(marked ? <strong key={i} className="em-mark">{visible}</strong> : visible);
    if (visible.length < value.length) { result.push('…'); break; }
    left -= visible.length;
  }
  return result;
}

export function hitText(text: string, query: string) {
  const q = query.trim();
  if (!q) return text;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.split(new RegExp(`(${escaped})`, 'gi')).map((part, i) => i % 2 ? <mark className="em-mark" key={i}>{part}</mark> : part);
}

// Free-form dates can also say "after the review". Only explicit days have a deadline tone.
export function Deadline({ text, done = false }: { text: string; done?: boolean }) {
  const date = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})(?:日|(?=T|\s|$))/.exec(text.trim());
  const today = new Date();
  const day = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const days = date ? (Date.UTC(+date[1], +date[2] - 1, +date[3]) - day) / 86400000 : Infinity;
  const relative = /^(?:今天|今日|明天|明日|today|tomorrow)$/i.test(text.trim());
  return !done && (relative || days <= 7) ? <span className="em-state" data-icon="clock" data-tone={days < 0 ? 'bad' : 'warn'}>{text}</span> : <>{text}</>;
}
