// The skill academy: which skills each project and conversation gets, configured with skim in layers
// like git config (global, project, conversation); the narrowest layer that sets a skill decides it.

import { useEffect, useMemo, useState } from 'react';
import { api, type SkimResolution, type SkimScope, type SkimSkill, type SkimStatus, type TownSkill } from '../api';
import type { RoomActions } from './Interior';
import { Select } from './Select';
import '../config-rooms.css';
import { tr } from '../i18n';

interface Props extends RoomActions { focus: string | null; tick: number }

type Sel = { scope: 'global' } | { scope: 'project'; lineId: string } | { scope: 'session'; lineId: string; agentId: string };

const SCOPE_NAME: Record<string, string> = { global: tr('全局'), project: tr('项目'), session: tr('对话'), env: tr('环境'), active: tr('激活的环境') };
const ROLE_NAME: Record<string, string> = { coder: tr('代码员工'), writer: tr('写作员工') };
const SCOPE_HINT: Record<SkimScope, string> = {
  global: tr('本机所有项目和对话'), project: tr('这个项目里的每段对话'), session: tr('只管这一段对话'),
};

// where a skill's state comes from, for its chip
function fromLabel(s: SkimSkill, env: string) {
  if (!s.scope) return tr('没人配置');
  return s.scope === 'env' ? tr('环境 {0}', env) : SCOPE_NAME[s.scope];
}

const lineOf = (sel: Sel) => sel.scope === 'global' ? null : sel.lineId;
const agentOf = (sel: Sel) => sel.scope === 'session' ? sel.agentId : null;

export function SkillRoom(p: Props) {
  const [st, setSt] = useState<SkimStatus | null>(null);
  const [own, setOwn] = useState<TownSkill[]>([]);
  const [sel, setSel] = useState<Sel>(p.focus ? { scope: 'project', lineId: p.focus } : { scope: 'global' });
  const [res, setRes] = useState<SkimResolution | null>(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [show, setShow] = useState<'all' | 'on' | 'here'>('all');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => { api.skim().then(setSt).catch(e => setErr((e as Error).message)); }, [p.tick]);
  useEffect(() => { api.townSkills().then(setOwn).catch(() => {}); }, []);
  useEffect(() => {
    if (!st?.ok) return;
    let live = true;
    api.resolve(lineOf(sel), agentOf(sel)).then(r => { if (live) { setRes(r); setErr(''); } }).catch(e => live && setErr((e as Error).message));
    return () => { live = false; };
  }, [st?.ok, sel, p.tick]);

  const here = useMemo(() => {
    const m: Record<string, string> = {};
    for (const s of res?.scopes.find(x => x.scope === sel.scope)?.settings ?? []) m[s.key] = s.value;
    return m;
  }, [res, sel.scope]);

  async function set(key: string, value: string | null) {
    setBusy(key);
    try {
      setRes(await api.skimSet(sel.scope, key, value, lineOf(sel), agentOf(sel)));
      if (key === 'core.env' || sel.scope === 'global') api.skim(true).then(setSt).catch(() => {});
    } catch (e) {
      p.toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!st) return <div className="room-empty"><p>{err || tr('正在问 skim…')}</p></div>;
  if (!st.ok) {
    return (
      <div className="room-empty">
        <h2>{tr('skim 还没接上')}</h2>
        <p>{st.note}</p>
        <p className="muted small">{tr('skim 是一个 skill 版本管理器：所有 skill 放在一个全局仓库里，再按项目、按对话分层配置。装好后运行')} <code>skim init</code>{tr('，它会把本机各个 agent 已有的 skill 收进仓库。')}</p>
      </div>
    );
  }

  const line = sel.scope !== 'global' ? st.lines.find(l => l.id === sel.lineId) : null;
  const agent = sel.scope === 'session' ? line?.agents.find(a => a.id === sel.agentId) : null;
  const k = q.trim().toLowerCase();
  const skills = (res?.skills ?? []).filter(s =>
    (!k || `${s.name} ${s.description ?? ''}`.toLowerCase().includes(k))
    && (show === 'all' || show === 'on' && s.enabled || show === 'here' && `skill.${s.name}.enabled` in here));
  const on = (res?.skills ?? []).filter(s => s.enabled).length;
  const envHere = 'core.env' in here ? here['core.env'] : null;
  const layer = (scope: SkimScope, label: string) => {
    const sc = res?.scopes.find(s => s.scope === scope);
    return { scope, label, n: sc?.settings.length ?? 0, file: sc?.file };
  };
  const chain = [
    layer('global', tr('全局')),
    ...(line ? [layer('project', `#${line.seq}`)] : []),
    ...(agent ? [layer('session', ROLE_NAME[agent.role])] : []),
  ];

  return (
    <div className="room room-config room-academy">
      <aside className="room-side">
        <h4 className="side-h">{tr('配置层')} <span className="muted small">{tr('像 git config：窄的一层覆盖宽的')}</span></h4>
        <button className={`scope-btn${sel.scope === 'global' ? ' on' : ''}`} onClick={() => setSel({ scope: 'global' })}>
          <span className="sc-tag sc-global">{tr('全局')}</span><b>{tr('本机所有项目和对话')}</b>
          <span className="muted small">~/.skim/skimconfig</span>
        </button>
        <h5 className="side-sub">{tr('项目和它们的对话')}</h5>
        {st.lines.map((l, i) => (
          <div key={l.id} className="scope-group" style={{ ['--i' as string]: Math.min(i, 10) }}>
            <button className={`scope-btn${sel.scope === 'project' && sel.lineId === l.id ? ' on' : ''}`} onClick={() => setSel({ scope: 'project', lineId: l.id })}>
              <span className="sc-tag sc-project">{tr('项目')}</span><b>#{l.seq} {l.title}</b>
            </button>
            {l.agents.map(a => (
              <button key={a.id} className={`scope-btn sub${sel.scope === 'session' && sel.agentId === a.id ? ' on' : ''}`}
                onClick={() => setSel({ scope: 'session', lineId: l.id, agentId: a.id })}>
                <span className="sc-tag sc-session">{tr('对话')}</span><b>{ROLE_NAME[a.role]}</b>
                <span className="muted small">{a.runtime === 'paseo' ? 'Paseo' : a.runtime === 'pi' ? 'pi' : tr('还没启动')}{a.model ? ` · ${a.model}` : ''}</span>
              </button>
            ))}
            {!l.agents.length && <p className="muted small sc-none">{tr('还没有员工对话：在仓库或印刷厂给它配一位，这里就能单独配置。')}</p>}
          </div>
        ))}
      </aside>

      <section className="room-main">
        <div className="sk-chain">
          {chain.map((c, i) => (
            <span key={c.scope} className={`sk-link${c.scope === sel.scope ? ' on' : ''}`} title={c.file}>
              {i > 0 && <em>→</em>}<span className={`sc-tag sc-${c.scope}`}>{SCOPE_NAME[c.scope]}</span>{c.label}
              <small>{tr('{0} 项', c.n)}</small>
            </span>
          ))}
        </div>
        <h2 className="cr-title">{sel.scope === 'global' ? tr('全局配置') : sel.scope === 'project' ? tr('项目 #{0} 的配置', line?.seq) : tr('#{0} {1}这段对话的配置', line?.seq, agent ? ROLE_NAME[agent.role] : '')}</h2>
        <p className="muted">{SCOPE_HINT[sel.scope]}{tr('。在这一层没设置的 skill 沿用上一层。改动立刻生效，相关员工的 skill 目录会同步更新。')}</p>

        <div className="sk-env pnl-s">
          <div>
            <b>{tr('起始环境')}</b>
            <p className="muted small">
              {res ? (res.env ? <>{tr('现在用')} <code>{res.env}</code>{tr('（')}{res.env_scope === 'active' ? tr('skim 当前激活的环境') : tr('{0}层定的', SCOPE_NAME[res.env_scope ?? ''])}{tr('）')}{res.env_missing && <span className="warn"> {tr('· 这个环境不存在')}</span>}</> : tr('现在不从任何环境开始，只用各层单独打开的 skill。')) : '…'}
            </p>
          </div>
          <Select value={envHere === null ? '__inherit' : envHere === '' ? '__none' : envHere} disabled={busy === 'core.env'} label={tr('起始环境')}
            onChange={v => set('core.env', v === '__inherit' ? null : v === '__none' ? '' : v)}
            options={[{ value: '__inherit', label: sel.scope === 'global' ? tr('用 skim 激活的环境') : tr('沿用上一层') }, { value: '__none', label: tr('空环境') },
              ...st.envs.map(e => ({ value: e.name, label: e.name, hint: tr('{0} 个 skill', e.skills.length) + (e.active ? tr(' · 激活中') : '') }))]} />
        </div>

        <div className="sk-tools">
          <input className="shelf-q" placeholder={tr('搜 skill 的名字和说明')} value={q} onChange={e => setQ(e.target.value)} />
          <div className="seg">
            {([['all', tr('全部 {0}', res?.skills.length ?? 0)], ['on', tr('生效 {0}', on)], ['here', tr('这一层设的 {0}', Object.keys(here).filter(x => x.startsWith('skill.')).length)]] as const).map(([v, t]) =>
              <button key={v} className={show === v ? 'on' : ''} onClick={() => setShow(v)}>{t}</button>)}
          </div>
        </div>
        {err && <p className="warn-box small">{err}</p>}
        <div className="sk-list">
          {skills.map((s, i) => {
            const key = `skill.${s.name}.enabled`;
            const mine = key in here ? (/^(true|yes|on|1)$/i.test(here[key]) ? 'on' : 'off') : 'inherit';
            return (
              <div key={s.name} className={`sk-row${s.enabled ? ' is-on' : ''}`} style={{ ['--i' as string]: Math.min(i, 16) }}>
                <span className="sk-dot" aria-label={s.enabled ? tr('生效') : tr('不生效')} />
                <div className="sk-name">
                  <b>{s.name}</b>
                  {s.description && <span className="muted small">{s.description}</span>}
                  {!s.in_store && <span className="warn small">{tr('skim 仓库里没有这个 skill')}</span>}
                </div>
                <span className={`sk-from f-${s.scope ?? 'none'}`} title={s.origin}>{fromLabel(s, res?.env ?? '')}</span>
                <div className="tri" role="group" aria-label={tr('{0} 在这一层', s.name)}>
                  {(['inherit', 'on', 'off'] as const).map(v => (
                    <button key={v} className={`${mine === v ? 'on' : ''} t-${v}`} disabled={busy === key}
                      onClick={() => mine !== v && set(key, v === 'inherit' ? null : v === 'on' ? 'true' : 'false')}>
                      {v === 'inherit' ? tr('沿用') : v === 'on' ? tr('开') : tr('关')}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          {res && !skills.length && <p className="muted">{tr('没有符合的 skill。')}</p>}
        </div>
      </section>

      <aside className="room-aside">
        <div className="pnl-s">
          <h4>skim</h4>
          <p className="muted small">{tr('仓库里')} {tr('{0} 个 skill ·', st.store.length)} {tr('{0} 个环境', st.envs.length)}{st.active_env ? tr(' · 激活的是 {0}', st.active_env) : tr(' · 没有激活的环境')}</p>
          <div className="env-chips">{st.envs.map(e => <span key={e.name} className={`chip${e.active ? ' ok' : ''}`}>{e.name} {e.skills.length}</span>)}</div>
        </div>
        <div className="pnl-s">
          <h4>{tr('配置文件')}</h4>
          <p className="muted small">{tr('等于')} <code>skim config --list --show-origin</code>{tr('，从宽到窄：')}</p>
          {res?.scopes.map(sc => (
            <div key={sc.scope} className={`cfg-file${sc.scope === sel.scope ? ' on' : ''}`}>
              <div className="cfg-path"><span className={`sc-tag sc-${sc.scope}`}>{SCOPE_NAME[sc.scope]}</span><code title={sc.file}>{shortPath(sc.file)}</code></div>
              <pre>{sc.settings.length ? sc.settings.map(x => `${x.key} = ${x.value}`).join('\n') : sc.exists ? tr('（空）') : tr('（还没有这个文件）')}</pre>
            </div>
          ))}
        </div>
        <div className="pnl-s">
          <h4>{tr('在终端里')}</h4>
          <pre className="code small-code">{cli(sel)}</pre>
        </div>
        {own.length > 0 && (
          <div className="pnl-s">
            <h4>{tr('小镇员工自带的 skill')}</h4>
            <p className="muted small">{tr('孵化员、审稿人这些小镇自己的员工用的，在')} <code>server/skills/</code>{tr('，热插拔，不归 skim 管。')}</p>
            {own.map(s => <div key={s.name} className="own-sk"><b>{s.name}</b><span className="muted small">{s.roles.join(tr('、')) || '—'}</span></div>)}
          </div>
        )}
      </aside>
    </div>
  );
}

// a config file's path, from home and keeping its tail when it is long
function shortPath(f: string) {
  const p = f.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, '~');
  return p.length > 38 ? '…' + p.slice(-37) : p;
}

function cli(sel: Sel) {
  const dir = sel.scope === 'global' ? '' : ` --project-dir server/var/projects/${sel.lineId}`;
  const sid = sel.scope === 'session' ? ` --session-id papertown-${sel.agentId}` : '';
  const flag = `--${sel.scope}${sel.scope === 'project' ? dir : sid}`;
  return tr('skim config {0} skill.<名字>.enabled true\nskim config {1} core.env base\nskim resolve{2}', flag, flag, dir + sid);
}

// in a coding or writing agent's room: the skills its conversation ends up with, and which layer gave each
export function ConvSkills({ lineId, agentId, onOpen }: { lineId: string; agentId: string; onOpen: (id: string, lineId?: string) => void }) {
  const [res, setRes] = useState<SkimResolution | null>(null);
  const [note, setNote] = useState('');
  useEffect(() => {
    let live = true;
    api.resolve(lineId, agentId).then(r => { if (live) { setRes(r); setNote(''); } })
      .catch(e => live && setNote((e as Error).message));
    return () => { live = false; };
  }, [lineId, agentId]);
  const on = res?.skills.filter(s => s.enabled) ?? [];
  return (
    <div className="pnl-s conv-skills">
      <h4>{tr('这段对话的 skill')} <span className="muted">{res ? on.length : ''}</span></h4>
      {note ? <p className="muted small">{note}</p> : !res ? <p className="muted small">…</p> : (
        <>
          <p className="muted small">{res.env ? tr('从环境 {0} 开始，', res.env) : ''}{tr('按 全局 → 项目 → 对话 一层层算出来，链接进它的 .papertown/skills。')}</p>
          <div className="cs-list">
            {on.slice(0, 14).map(s => (
              <span key={s.name} className="cs-item" title={s.description}><b>{s.name}</b><em className={`f-${s.scope ?? 'none'}`}>{fromLabel(s, res.env)}</em></span>
            ))}
            {on.length > 14 && <span className="muted small">{tr('还有')} {on.length - 14} {tr('个')}</span>}
            {!on.length && <span className="muted small">{tr('一个都没开。')}</span>}
          </div>
        </>
      )}
      <div className="btns"><button className="btn" onClick={() => onOpen('academy', lineId)}>{tr('去技能学堂配置')}</button></div>
    </div>
  );
}
