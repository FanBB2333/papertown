import { useEffect, useState } from 'react';
import { api, type AgentRole, type Backends, type PaseoInfo, type StartOpts, type TermBackend } from '../api';
import { Select } from '../components/Select';
import { tr } from '../i18n';
import { kindName } from './watch';
import { AccountPick } from './AccountPick';

// hiring a CLI that runs in a herdr tab, a tmux window or a background terminal, drawn like the Paseo card beside it
export function TerminalPick({ busy, onStart, role, fixedBackend, lineId, agentId }: {
  fixedBackend?: TermBackend; busy: boolean; onStart: (o: StartOpts) => void; role?: AgentRole; lineId?: string | null; agentId?: string | null;
}) {
  const [backends, setBackends] = useState<Backends | null>(null), [info, setInfo] = useState<PaseoInfo | null>(null);
  const [backend, setBackend] = useState<TermBackend>('tmux'), [provider, setProvider] = useState('');
  const [model, setModel] = useState(''), [thinking, setThinking] = useState(''), [error, setError] = useState('');
  const [account, setAccount] = useState<string | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void Promise.all([api.backends(), api.paseo(), api.defaultRuntime()]).then(([b, i, d]) => {
      if (!alive) return;
      setBackends(b); setInfo(i);
      const pref = role === 'lead' || role === 'assistant' ? i.defaults?.[role] : undefined;
      const p = pref?.provider && b.clis[pref.provider] ? pref.provider : Object.keys(b.clis).find(k => b.clis[k]) ?? '';
      setProvider(p);
      if (p === pref?.provider && i.providers.some(x => x.id === p && x.models.some(m => m.id === pref.model))) { setModel(pref.model ?? ''); setThinking(pref.thinking ?? ''); }
      setBackend(fixedBackend ?? (d.runtime !== 'paseo' ? d.runtime : b.herdr.ok ? 'herdr' : 'tmux'));
    }).catch(e => { if (alive) setError((e as Error).message); });
    return () => { alive = false; };
  }, [role, fixedBackend]);
  if (error) return <p className="small em-state" data-tone="bad">{error}</p>;
  if (!backends) return <p className="muted small">{tr('检查中…')}</p>;
  // Paseo's list, or without Paseo the one it gave before
  const models = info?.providers.find(p => p.id === provider)?.models ?? [];
  const selected = models.find(m => m.id === model);
  const clis = Object.keys(backends.clis).filter(p => backends.clis[p]);
  const shown = (['herdr', 'tmux', 'headless'] as const).filter(b => !fixedBackend || fixedBackend === b);
  return <>
    <p className="muted small">{tr('Claude Code、Codex 或 Antigravity 以真实的终端界面运行，网页操作以模拟键盘输入送达。herdr 与 tmux 可随时接入终端，headless 由 Papertown 在后台托管。')}</p>
    {shown.length > 1 && <div className="seg mini" role="radiogroup" aria-label={tr('终端后端')}>
      {shown.map(b => <button key={b} role="radio" aria-checked={backend === b} className={backend === b ? 'on' : ''} disabled={!backends[b].ok || busy} onClick={() => setBackend(b)}>{b}</button>)}
    </div>}
    {shown.filter(b => !backends[b].ok).map(b => <p className="small em-state" data-tone="bad" key={b}>{b}{tr('：')}{backends[b].note}</p>)}
    {!clis.length ? <p className="small em-state" data-tone="bad">{tr('本机未找到 Claude Code、Codex 或 Antigravity。')}</p> : <>
      <label className="field">{tr('CLI')}
        <Select value={provider} options={clis.map(p => ({ value: p, label: kindName(p) }))} onChange={v => { setProvider(v); setModel(''); setThinking(''); }} />
      </label>
      <label className="field">{tr('模型')}
        <Select value={model} options={[{ value: '', label: tr('CLI 默认模型') }, ...models.map(m => ({ value: m.id, label: m.name }))]}
          onChange={v => { setModel(v); setThinking(models.find(m => m.id === v)?.default_thinking ?? ''); }} />
      </label>
      {!!selected && selected.thinking.length > 1 && <label className="field">{tr('思考强度')}
        <Select value={thinking} options={selected.thinking.map(t => ({ value: t, label: t }))} onChange={setThinking} />
      </label>}
      {!models.length && <p className="muted small">{tr('暂无模型列表，将使用 CLI 默认模型。')}</p>}
      <AccountPick lineId={lineId} agentId={agentId} onChange={setAccount} />
    </>}
    <button className="btn pri" disabled={busy || !provider || !backends[backend].ok} onClick={() => onStart({ runtime: backend, provider, model, thinking, ...(account !== undefined ? { account } : {}) })}>
      {busy ? tr('启动中…') : backend === 'herdr' ? tr('在 herdr 中启动') : backend === 'tmux' ? tr('在 tmux 中启动') : tr('在后台终端中启动')}
    </button>
  </>;
}
