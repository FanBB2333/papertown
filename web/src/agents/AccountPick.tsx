// Which account the CLI runs as: a CLIppet env, chosen for this agent or taken from the project's or the town's choice
import { useEffect, useState } from 'react';
import { api, type AccountView } from '../api';
import { Select } from '../components/Select';
import { tr } from '../i18n';

export const INHERIT = '__inherit';

export function envLabel(v: AccountView | null, env: string) {
  if (!env) return tr('本机当前登录');
  const e = v?.envs.find(x => x.name === env);
  const who = [e?.codex, e?.agy].filter(Boolean).join(' · ');
  return who ? `${env} · ${who}` : env;
}

// `value`: the agent's own layer, INHERIT when it takes the wider choice; reported with whether it changed
export function AccountPick({ lineId, agentId, onChange }: {
  lineId?: string | null; agentId?: string | null; onChange: (account: string | undefined) => void;
}) {
  const [v, setV] = useState<AccountView | null>(null), [value, setValue] = useState(INHERIT), [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    api.accounts(lineId, agentId).then(x => { if (alive) { setV(x); setValue(x.layers.agent ?? INHERIT); } }).catch(() => {});
    return () => { alive = false; };
  }, [lineId, agentId]);
  if (!v) return null;
  const set = Object.values(v.layers).some(x => x !== null);
  if (!v.ok && !set) return null;  // no CLIppet and nothing chosen: every CLI runs as this machine's login
  const wider = v.layers.project ?? v.layers.global ?? '';
  const from = v.layers.project !== null ? tr('本项目') : v.layers.global !== null ? tr('全局') : tr('默认');
  const pick = (x: string) => { setValue(x); onChange(x === (v.layers.agent ?? INHERIT) ? undefined : x); };
  async function forProject() {
    setBusy(true); setErr('');
    try {
      const x = await api.setAccount('project', value === INHERIT ? null : value, lineId);
      setV(x);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return <>
    <label className="field">{tr('账号')}
      <Select value={value} onChange={pick} options={[
        { value: INHERIT, label: tr('沿用{0}：{1}', from, envLabel(v, wider)) },
        { value: '', label: tr('本机当前登录') },
        ...v.envs.map(e => ({ value: e.name, label: envLabel(v, e.name) })),
      ]} />
    </label>
    {!v.ok && <p className="warn-box small">{v.note}</p>}
    <p className="muted small">
      {tr('选择 CLIppet 的 env 时，以 clippet -e <env> 启动 CLI 的真实界面。全局默认在「设置 › 员工 Agent」。')}
      {lineId && value !== INHERIT && value !== wider && <> <button type="button" className="linkish" disabled={busy} onClick={forProject}>{tr('设为本项目默认')}</button></>}
    </p>
    {err && <p className="warn-box small">{err}</p>}
  </>;
}
