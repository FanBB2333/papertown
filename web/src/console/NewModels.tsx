// A card offering Paseo's new models as the default for the assistant and the projects' leads.
// 忽略 dismisses the news for good; × only hides it until the next page load.

import { useEffect, useState } from 'react';
import { api, listen, type ModelNews, type PaseoDefault, type PaseoDefaults } from '../api';
import { tr } from '../i18n';
import { Icon } from './icons';

type Role = 'assistant' | 'lead';
const ROLES: [Role, string][] = [['assistant', tr('小助手')], ['lead', tr('项目负责人')]];
const SHOWN = 4;
const spec = (d: PaseoDefault) => [d.provider, d.model, d.thinking].filter(Boolean).join(' / ');
// the thinking a role keeps on the new model: its own when the model has it, else the model's
const think = (d: PaseoDefault, m: ModelNews) => (d.thinking && m.thinking.includes(d.thinking) ? d.thinking : m.default_thinking);

export function NewModels({ toast }: { toast: (t: string, error?: boolean) => void }) {
  const [news, setNews] = useState<ModelNews[]>([]);
  const [defs, setDefs] = useState<PaseoDefaults | null>(null);
  const [key, setKey] = useState('');
  const [roles, setRoles] = useState<Set<Role>>(new Set());
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    api.modelNews().then(r => { setNews(r.news); setDefs(r.defaults); }).catch(() => {});
    return listen(e => {
      if (e.type !== 'paseo_models') return;
      if (e.news) { setNews(e.news); if ((e.news as ModelNews[]).length) setHidden(false); }
      if (e.defaults) setDefs(e.defaults);
    });
  }, []);
  const m = news.find(n => n.key === key) ?? news[news.length - 1];
  useEffect(() => { if (m && defs) setRoles(new Set(ROLES.map(r => r[0]).filter(r => defs[r].provider === m.provider))); }, [m?.key, !!defs]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!m || !defs || hidden) return null;
  const all = news.map(n => n.key);
  async function done(fn: () => Promise<unknown>) {
    setBusy(true);
    try { await fn(); await api.dismissModels(all); } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  }
  const change = () => done(async () => {
    for (const r of roles) await api.setPaseoDefault(r, { provider: m.provider, model: m.model, thinking: think(defs[r], m) });
    toast(tr('{0}后续默认使用 {1} · {2}。运行中的保持不变。', ROLES.filter(r => roles.has(r[0])).map(r => r[1]).join(tr('和')), m.label, m.name));
  });
  const newest = [...news].reverse().slice(0, SHOWN);

  return (
    <aside className="mnews" role="dialog" aria-label={tr('Paseo 有新模型')}>
      <button className="ib mn-x" onClick={() => setHidden(true)} title={tr('暂时收起，下次打开时提醒')}><Icon n="close" size={14} /></button>
      <span className="mn-k"><Icon n="spark" size={15} />{news.length > 1 ? tr('Paseo 新增 {0} 个新模型', news.length) : tr('Paseo 已上线新模型')}</span>
      <div className="mn-list" role="radiogroup">
        {newest.map(n => (
          <button key={n.key} role="radio" aria-checked={n.key === m.key} className={`mn-m${n.key === m.key ? ' on' : ''}`} onClick={() => setKey(n.key)}>
            <b>{n.label} · {n.name}</b>
            {n.thinking.length > 0 && <span className="muted small">{tr('思考强度 {0}', n.thinking.join(' / '))}</span>}
          </button>
        ))}
        {news.length > SHOWN && <span className="muted small">{tr('另有 {0} 个，可在设置的「员工 Agent」中选择', news.length - SHOWN)}</span>}
      </div>
      <p className="mn-q em-bar" data-tone="warn">{tr('谁后续默认使用 {0}？', m.name)}</p>
      <div className="mn-roles">
        {ROLES.map(([r, name]) => (
          <label key={r} className="mn-role">
            <input type="checkbox" checked={roles.has(r)} onChange={e => setRoles(s => { const x = new Set(s); if (e.target.checked) x.add(r); else x.delete(r); return x; })} />
            <span><b>{name}</b><span className="muted small">{tr('当前：{0}', spec(defs[r]) || tr('未设置'))}{roles.has(r) ? ` → ${[m.model, think(defs[r], m)].filter(Boolean).join(' / ')}` : ''}</span></span>
          </label>
        ))}
      </div>
      <div className="btns">
        <button className="btn pri" disabled={busy || !roles.size} onClick={change}>{tr('切换')}</button>
        <button className="btn" disabled={busy} onClick={() => done(async () => {})}>{tr('忽略')}</button>
      </div>
      <p className="muted small">{tr('仅修改后续启动时的默认配置。运行中的负责人与小助手保持不变，小助手新建对话时切换。')}</p>
    </aside>
  );
}
