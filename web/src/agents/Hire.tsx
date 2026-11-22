// Hiring from the employees page: a project, a post, then where the employee runs. Every runtime plugs in here.
import { Banner, Button, Dialog, Select, Tabs } from '@cloudflare/kumo';
import { useEffect, useMemo, useState } from 'react';
import { api, type Agent, type AgentRole, type Backends, type PaseoInfo, type Roster, type StartOpts } from '../api';
import { tr } from '../i18n';
import { kindName } from './watch';

type Post = 'coder' | 'writer' | 'lead';
type Runtime = NonNullable<StartOpts['runtime']>;
const POSTS: [Post, string, string][] = [
  ['coder', tr('代码员工'), tr('在项目的代码目录里写代码、跑测试并提交实验。')],
  ['writer', tr('写作员工'), tr('在项目的论文目录里撰写和修改稿件。')],
  ['lead', tr('项目负责人'), tr('推进项目：启动员工、分派任务、收尾工序并汇报。')],
];
const RUNTIMES: [Runtime, string, string][] = [
  ['paseo', 'Paseo', tr('对话在 Paseo 中进行，桌面端和手机同步可见。')],
  ['herdr', 'herdr', tr('在 herdr 的标签页里运行 CLI，可随时接入终端。')],
  ['tmux', 'tmux', tr('在 tmux 窗口里运行 CLI，可随时接入终端。')],
  ['pi', 'pi', tr('本机的 pi，使用它自己的模型设置和登录。')],
];

export function HireDialog({ lineId, onClose, onStarted, onOpen }: {
  lineId?: string | null; onClose: () => void; onStarted: (a: Agent) => void; onOpen: (a: Agent) => void;
}) {
  const [rosters, setRosters] = useState<Record<Post, Roster> | null>(null), [backends, setBackends] = useState<Backends | null>(null);
  const [info, setInfo] = useState<PaseoInfo | null>(null);
  const [line, setLine] = useState(lineId ?? ''), [post, setPost] = useState<Post>('coder'), [runtime, setRuntime] = useState<Runtime>('paseo');
  const [provider, setProvider] = useState(''), [model, setModel] = useState(''), [thinking, setThinking] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    Promise.all([api.roster('coder'), api.roster('writer'), api.roster('lead'), api.backends(), api.paseo(), api.defaultRuntime()]).then(([coder, writer, lead, b, i, d]) => {
      if (!alive) return;
      setRosters({ coder, writer, lead }); setBackends(b); setInfo(i);
      setLine(v => v || coder.roster[0]?.line.id || '');
      setRuntime(([d.runtime, 'paseo', 'herdr', 'tmux'] as Runtime[]).find(r => r === 'paseo' ? i.status.ok : b[r as 'herdr' | 'tmux'].ok) ?? d.runtime);
    }).catch(e => { if (alive) setError((e as Error).message); });
    return () => { alive = false; };
  }, []);

  const terminal = runtime === 'herdr' || runtime === 'tmux';
  const row = rosters?.[post].roster.find(r => r.line.id === line), existing = row?.agent?.started ? row.agent : null;
  // why a runtime cannot be chosen now, or '' when it can
  const blocked = (r: Runtime) => !backends || !info || !rosters ? ''
    : r === 'paseo' ? (info.status.ok ? '' : info.status.note)
      : r === 'pi' ? (post === 'lead' ? tr('项目负责人暂不支持 pi。') : rosters.coder.available.ok ? '' : rosters.coder.available.note)
        : !backends[r].ok ? backends[r].note : Object.values(backends.clis).some(Boolean) ? '' : tr('本机没有找到 Claude Code、Codex 或 Antigravity。');
  // the providers a runtime offers: Paseo's own list, or the CLIs found on this machine with Paseo's model catalog
  const providers = useMemo(() => {
    if (!backends || !info) return [];
    if (runtime === 'paseo') return info.providers.map(p => ({ id: p.id, label: p.label, models: p.models }));
    if (!terminal) return [];
    return Object.keys(backends.clis).filter(k => backends.clis[k]).map(k => ({ id: k, label: kindName(k), models: info.status.ok ? info.providers.find(p => p.id === k)?.models ?? [] : [] }));
  }, [backends, info, runtime, terminal]);
  const current = providers.find(p => p.id === provider), chosen = current?.models.find(m => m.id === model);

  useEffect(() => { if (blocked(runtime)) { const next = RUNTIMES.find(([r]) => !blocked(r)); if (next) setRuntime(next[0]); } }, [post, backends, info, rosters]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!providers.length) { setProvider(''); setModel(''); setThinking(''); return; }
    const preset = post === 'lead' ? info?.defaults?.lead : undefined;
    const p = providers.find(x => x.id === provider) ?? providers.find(x => x.id === preset?.provider) ?? providers.find(x => x.id === 'claude') ?? providers[0];
    // a terminal CLI may run on its own default model, Paseo always names one
    const m = p.models.find(x => x.id === model) ?? (p.id === preset?.provider ? p.models.find(x => x.id === preset?.model) : undefined) ?? (terminal ? undefined : p.models[0]);
    setProvider(p.id); setModel(m?.id ?? '');
    setThinking(t => m ? (m.thinking.includes(t) ? t : m.default_thinking ?? '') : '');
  }, [providers, post]); // eslint-disable-line react-hooks/exhaustive-deps

  async function start(e: React.FormEvent) {
    e.preventDefault();
    if (!line || busy) return;
    setBusy(true); setError('');
    try {
      const a = row?.agent ?? await api.openAgent(line, post as AgentRole);
      onStarted(await api.startAgent(a.id, runtime === 'pi' ? { runtime } : { runtime, provider: provider || undefined, model: model || undefined, thinking: thinking || undefined }));
      onClose();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const ready = !!rosters && !!backends && !!info, why = blocked(runtime);
  return <Dialog.Root open onOpenChange={v => { if (!v && !busy) onClose(); }}>
    <Dialog size="lg" className="st-dlg aw-hire">
      <Dialog.Title>{tr('新建员工')}</Dialog.Title>
      <Dialog.Description>{tr('为项目的一个岗位启动员工。工作目录是该项目在小镇里的目录，启动时会收到项目简报。')}</Dialog.Description>
      {!ready ? <p className="aw-hire-wait">{error || tr('加载中…')}</p> : !rosters.coder.roster.length ? <Banner description={tr('尚无项目。请先在小镇里放入一颗 idea。')} /> : <form onSubmit={start}>
        <div className="aw-hire-row">
          <Select label={tr('项目')} value={line} items={Object.fromEntries(rosters.coder.roster.map(r => [r.line.id, `#${r.line.seq} ${r.line.title}`]))} onValueChange={v => setLine(String(v))} disabled={busy} />
        </div>
        <div className="aw-hire-row">
          <span className="aw-hire-label">{tr('岗位')}</span>
          <Tabs variant="segmented" value={post} onValueChange={v => setPost(v as Post)} tabs={POSTS.map(([value, label]) => ({ value, label }))} />
          <p className="aw-hire-note">{POSTS.find(p => p[0] === post)![2]}</p>
        </div>
        {existing ? <div className="aw-hire-there">
          <p>{tr('这个岗位的员工已在运行。')}</p>
          <Button type="button" variant="primary" onClick={() => { onOpen(existing); onClose(); }}>{tr('打开对话')}</Button>
        </div> : <>
          <div className="aw-hire-row">
            <span className="aw-hire-label">{tr('运行方式')}</span>
            <div className="aw-hire-runtimes" role="radiogroup" aria-label={tr('运行方式')}>
              {RUNTIMES.filter(([r]) => r !== 'pi' || post !== 'lead').map(([r, name, about]) => {
                const no = blocked(r);
                return <button type="button" key={r} role="radio" aria-checked={runtime === r} disabled={!!no || busy} className={runtime === r ? 'on' : ''} onClick={() => setRuntime(r)}>
                  <b>{name}</b><span>{no || about}</span>
                </button>;
              })}
            </div>
          </div>
          {runtime !== 'pi' && !!providers.length && <div className="aw-hire-row aw-hire-model">
            <Select label={terminal ? tr('CLI') : tr('供应商')} value={provider} items={Object.fromEntries(providers.map(p => [p.id, p.label]))} disabled={busy}
              onValueChange={v => { setProvider(String(v)); setModel(''); }} />
            <Select label={tr('模型')} value={model} disabled={busy}
              items={{ ...(terminal ? { '': tr('CLI 默认模型') } : {}), ...Object.fromEntries((current?.models ?? []).map(m => [m.id, m.name])) }}
              onValueChange={v => { const id = String(v); setModel(id); setThinking(current?.models.find(m => m.id === id)?.default_thinking ?? ''); }} />
            {!!chosen && chosen.thinking.length > 1 && <Select label={tr('思考强度')} value={thinking} disabled={busy}
              items={Object.fromEntries(chosen.thinking.map(t => [t, t]))} onValueChange={v => setThinking(String(v))} />}
          </div>}
          {terminal && !info.status.ok && <p className="aw-hire-note">{tr('Paseo 未连接，将使用 CLI 默认模型。')}</p>}
          {error && <Banner variant="error" description={error} />}
          <div className="st-btns">
            <Button type="button" disabled={busy} onClick={onClose}>{tr('取消')}</Button>
            <Button type="submit" variant="primary" loading={busy} disabled={!line || !!why || (runtime !== 'pi' && !provider)}>{tr('启动员工')}</Button>
          </div>
        </>}
      </form>}
    </Dialog>
  </Dialog.Root>;
}
