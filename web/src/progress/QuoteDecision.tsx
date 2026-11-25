import { Button, Dialog } from '@cloudflare/kumo';
import { useState } from 'react';
import { api } from '../api';
import type { FlowPart } from '../flow';
import { tr } from '../i18n';
import { ModSelect } from './Records';

export function QuoteDecision({ line, event, origin, decided, text }: {
  line?: string | null; event?: number; origin?: string; decided?: string; text: string;
}) {
  const [open, setOpen] = useState(false), [saved, setSaved] = useState('');
  const [mod, setMod] = useState<FlowPart>('overview'), [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (decided || saved) return <div className="rec-quote"><code>{decided || saved}</code></div>;
  if (!line || !event || !text?.trim() || (origin !== 'web' && origin !== 'terminal')) return null;
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !line || !event) return;
    setBusy(true); setError('');
    try {
      const d = await api.quoteDecision(line, event, mod);
      const n = d?.n ?? (await api.decided(line).catch(() => null))?.decisions?.find(x => x.source === 'chat' && String(x.ref) === String(event))?.n;
      setSaved(n ? `D${n}` : tr('已记为决定')); setOpen(false);
    }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <div className="rec-quote"><Dialog.Root open={open} onOpenChange={v => { if (!busy) { setOpen(v); setError(''); } }}>
    <Dialog.Trigger render={<button className="lnk" />}>{tr('记为决定')}</Dialog.Trigger>
    <Dialog size="sm" className="st-dlg rec-dialog"><Dialog.Title>{tr('记为决定')}</Dialog.Title>
      <form onSubmit={save}><blockquote className="em-bar" data-tone="info">{text}</blockquote><ModSelect value={mod} onChange={setMod} disabled={busy} />
        {error && <p className="dc-err em-state" data-tone="bad" role="alert">{error}</p>}
        <div className="rec-actions"><Button type="button" disabled={busy} onClick={() => setOpen(false)}>{tr('取消')}</Button>
          <Button type="submit" variant="primary" disabled={busy}>{tr('记为决定')}</Button></div>
      </form>
    </Dialog>
  </Dialog.Root></div>;
}

