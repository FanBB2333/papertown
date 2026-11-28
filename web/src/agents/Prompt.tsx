// One dialog for whatever an agent waits on: a prompt on its terminal screen or a permission request.
import { Button, Dialog } from '@cloudflare/kumo';
import { paragraphs, usePrompt, type PromptChoice } from '@teletty/web';
import { tr } from '../i18n';

export { promptDismissed } from '@teletty/web';

export function PromptDialog({ id, who, title, body = [], code, choices, hint, children, onClose }: {
  id: string; who: string; title: string; body?: string[]; code?: string; choices: PromptChoice[]; hint?: string;
  children?: React.ReactNode; onClose: () => void;
}) {
  const { busy, error, run, close } = usePrompt({ id, choices, onClose });
  return <Dialog.Root open onOpenChange={v => { if (!v && busy < 0) close(); }}>
    <Dialog size="base" className="st-dlg aw-prompt">
      <p className="aw-prompt-who"><i aria-hidden="true" />{who}</p>
      <Dialog.Title><span className="em-bar" data-tone="warn">{title}</span></Dialog.Title>
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
      {error && <p role="alert" className="warn-box" data-tone="bad">{error}</p>}
      <div className="st-btns"><Button disabled={busy >= 0} onClick={close}>{tr('稍后处理')}</Button></div>
    </Dialog>
  </Dialog.Root>;
}
