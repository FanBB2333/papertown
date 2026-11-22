// One dialog for whatever an agent waits on: a prompt on its terminal screen or a permission request.
import { Banner, Button, Dialog } from '@cloudflare/kumo';
import { useEffect, useState } from 'react';
import { tr } from '../i18n';

export interface Choice { label: string; tone?: 'primary' | 'danger'; pick: () => Promise<unknown> | void }

// A terminal wraps its text at the screen's width: put the lines of one sentence back together, and leave a
// line without spaces (a path, a command) on its own.
function paragraphs(lines: string[]) {
  const out: string[] = [];
  for (const line of lines) {
    const last = out[out.length - 1];
    if (last && /\s/.test(last) && /\s/.test(line) && !/[.?!:。？！：]$/.test(last)) out[out.length - 1] = `${last} ${line}`;
    else out.push(line);
  }
  return out;
}

// what was closed without an answer stays closed until the prompt itself changes
const dismissed = new Set<string>();
export const promptDismissed = (key: string) => dismissed.has(key);

export function PromptDialog({ id, who, title, body = [], code, choices, hint, children, onClose }: {
  id: string; who: string; title: string; body?: string[]; code?: string; choices: Choice[]; hint?: string;
  children?: React.ReactNode; onClose: () => void;
}) {
  const [busy, setBusy] = useState(-1), [error, setError] = useState('');
  const close = () => { dismissed.add(id); onClose(); };
  async function run(i: number) {
    if (busy >= 0 || !choices[i]) return;
    setBusy(i); setError('');
    try { await choices[i].pick(); close(); } catch (e) { setError((e as Error).message); } finally { setBusy(-1); }
  }
  // the digits answer as they do in the terminal
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing || (e.target as HTMLElement).closest('input, textarea')) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= choices.length) { e.preventDefault(); void run(n - 1); }
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  });
  return <Dialog.Root open onOpenChange={v => { if (!v && busy < 0) close(); }}>
    <Dialog size="base" className="st-dlg aw-prompt">
      <p className="aw-prompt-who"><i aria-hidden="true" />{who}</p>
      <Dialog.Title>{title}</Dialog.Title>
      {!!body.length && <div className="aw-prompt-body">{paragraphs(body).map((line, i) => <p key={i}>{line}</p>)}</div>}
      {code && <pre className="aw-prompt-code">{code}</pre>}
      {!!choices.length && <div className="aw-prompt-choices" role="group" aria-label={tr('可选回答')}>
        {choices.map((c, i) => <Button key={i} className="aw-prompt-choice" variant={c.tone === 'primary' ? 'primary' : c.tone === 'danger' ? 'secondary-destructive' : 'secondary'}
          loading={busy === i} disabled={busy >= 0 && busy !== i} onClick={() => run(i)}>
          <kbd aria-hidden="true">{i + 1}</kbd><span>{c.label}</span>
        </Button>)}
      </div>}
      {hint && <p className="aw-prompt-hint">{hint}</p>}
      {children}
      {error && <Banner variant="error" description={error} />}
      <div className="st-btns"><Button disabled={busy >= 0} onClick={close}>{tr('稍后处理')}</Button></div>
    </Dialog>
  </Dialog.Root>;
}
