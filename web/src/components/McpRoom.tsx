// The MCP exchange: every MCP server the town is wired to, as lines on a switchboard, with where each
// is configured, whether it is connected and the tools it gives the agents.

import { useEffect, useState } from 'react';
import { api, type McpServer, type McpView } from '../api';
import type { RoomActions } from './Interior';
import '../config-rooms.css';
import { tr } from '../i18n';

interface Props extends RoomActions { tick: number }

const SOURCE: Record<McpServer['source'], string> = { builtin: tr('内置'), file: 'PAPERTOWN_MCP_CONFIG', town: tr('在小镇里添加') };
const STATE: Record<McpServer['state'], string> = { ok: tr('接通'), error: tr('接不通'), connecting: tr('正在接'), off: tr('已停用') };

interface Draft { name: string; command: string; args: string; env: string }
const EMPTY: Draft = { name: '', command: '', args: '', env: '' };

function draftOf(s: McpServer): Draft {
  return { name: s.name, command: s.command, args: s.args.join('\n'), env: s.env.map(k => `${k}=`).join('\n') };
}

export function McpRoom(p: Props) {
  const [v, setV] = useState<McpView | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.mcp().then(setV).catch(e => p.toast((e as Error).message));
  useEffect(() => { load(); }, [p.tick]);
  // while a line is being dialled, look again shortly
  useEffect(() => {
    if (!v?.servers.some(s => s.state === 'connecting')) return;
    const t = setTimeout(load, 900);
    return () => clearTimeout(t);
  }, [v]);

  async function run(f: () => Promise<McpView>, ok?: string) {
    setBusy(true);
    try {
      setV(await f());
      if (ok) p.toast(ok);
      return true;
    } catch (e) {
      p.toast((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(d: Draft) {
    const env: Record<string, string> = {};
    for (const line of d.env.split('\n').map(x => x.trim()).filter(Boolean)) {
      const i = line.indexOf('=');
      if (i <= 0) { p.toast(tr('env 一行一个 KEY=VALUE：{0}', line)); return; }
      env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    const done = await run(() => api.mcpAdd({ name: d.name.trim(), command: d.command.trim(), args: d.args.split('\n').map(x => x.trim()).filter(Boolean), env }), tr('已保存，正在接通'));
    if (done) { setSel(d.name.trim()); setDraft(null); }
  }

  if (!v) return <div className="room-empty"><p>{tr('正在看总机…')}</p></div>;
  const cur = v.servers.find(s => s.name === sel) ?? (draft ? null : v.servers[0]);
  const tools = v.servers.reduce((n, s) => n + s.tools.length, 0);

  return (
    <div className="room room-config room-exchange">
      <aside className="room-side">
        <h4 className="side-h">{tr('线路')} <span className="muted small">{v.servers.filter(s => s.state === 'ok').length}/{v.servers.length} {tr('条接通 · 共')} {tr('{0} 个工具', tools)}</span></h4>
        {v.servers.map((s, i) => (
          <button key={s.name} className={`scope-btn line-btn${cur?.name === s.name && !draft ? ' on' : ''}`} style={{ ['--i' as string]: i }}
            onClick={() => { setSel(s.name); setDraft(null); }}>
            <div className="proj-top"><b>{s.name}</b><span className={`mcp-st st-${s.state}`}>{STATE[s.state]}</span></div>
            <span className="muted small">{SOURCE[s.source]} · {tr('{0} 个工具', s.tools.length)}</span>
          </button>
        ))}
        {!v.servers.length && <p className="muted small">{tr('还没有接任何 MCP server。')}</p>}
        <button className="btn pri" onClick={() => { setDraft(EMPTY); setSel(null); }}>{tr('接一条新线')}</button>
      </aside>

      <section className="room-main">
        {draft ? (
          <div className="mcp-form">
            <h2 className="cr-title">{v.servers.some(s => s.name === draft.name && s.source === 'town') ? tr('改 {0}', draft.name) : tr('接一条新线')}</h2>
            <p className="muted">{tr('用 stdio 启动的 MCP server，写法和 Claude Desktop 的')} <code>mcpServers</code> {tr('一样。保存后立刻接通，工具会以')} <code>{tr('名字.工具')}</code> {tr('出现在员工的工具箱里。')}</p>
            <label className="field">{tr('名字')}<input value={draft.name} placeholder="github" onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
            <label className="field">{tr('启动命令')}<input value={draft.command} placeholder="npx" onChange={e => setDraft({ ...draft, command: e.target.value })} /></label>
            <label className="field">{tr('参数（一行一个）')}<textarea rows={3} value={draft.args} placeholder={'-y\n@modelcontextprotocol/server-github'} onChange={e => setDraft({ ...draft, args: e.target.value })} /></label>
            <label className="field">{tr('环境变量（一行一个 KEY=VALUE）')}
              <textarea rows={3} value={draft.env} placeholder="GITHUB_TOKEN=${GITHUB_TOKEN}" onChange={e => setDraft({ ...draft, env: e.target.value })} />
              <span className="muted small">{tr('密钥不要直接写在这里：写成')} <code>{tr('${变量名}')}</code>{tr('，值放在')} <code>~/.secrets.zsh</code>{tr('，启动时从环境里取。改已有的线时，值留空就是不改。')}</span>
            </label>
            <div className="btns">
              <button className="btn pri" disabled={busy || !draft.name.trim() || !draft.command.trim()} onClick={() => save(draft)}>{busy ? tr('接通中…') : tr('保存并接通')}</button>
              <button className="btn" onClick={() => setDraft(null)}>{tr('取消')}</button>
            </div>
          </div>
        ) : cur ? (
          <div className="mcp-detail">
            <div className="mcp-head">
              <div>
                <span className={`mcp-st st-${cur.state}`}>{STATE[cur.state]}</span>
                <h2 className="cr-title">{cur.name}</h2>
                <p className="muted small">{SOURCE[cur.source]}{cur.source === 'town' ? ` · ${v.town_file}` : cur.source === 'file' ? ` · ${v.config_file}` : ' · papertown.ports'}</p>
              </div>
              <div className="btns">
                {cur.enabled && <button className="btn" disabled={busy} onClick={() => run(() => api.mcpRestart(cur.name), tr('正在重连'))}>{tr('重连')}</button>}
                <button className="btn" disabled={busy} onClick={() => run(() => api.mcpToggle(cur.name, !cur.enabled))}>{cur.enabled ? tr('停用') : tr('启用')}</button>
                {cur.source === 'town' && <button className="btn" disabled={busy} onClick={() => setDraft(draftOf(cur))}>{tr('修改')}</button>}
                {cur.source === 'town' && <button className="btn danger" disabled={busy} onClick={() => {
                  if (confirm(tr('删掉 {0} 这条线？它的工具会从员工的工具箱里拿掉。', cur.name))) run(() => api.mcpRemove(cur.name), tr('已删除')).then(() => setSel(null));
                }}>{tr('删除')}</button>}
              </div>
            </div>
            <pre className="code">{[cur.command, ...cur.args].map(a => /\s/.test(a) ? JSON.stringify(a) : a).join(' ')}</pre>
            {cur.env.length > 0 && <p className="muted small">{tr('环境变量：')}{cur.env.map(k => <code key={k}>{k}</code>)}{tr('（值不显示）')}</p>}
            {cur.error && <p className="warn-box small">{cur.error}</p>}
            <h4 className="cr-sub">{tr('工具')} <span className="muted">{cur.tools.length}</span></h4>
            {cur.tools.length ? (
              <div className="tool-grid">
                {cur.tools.map((t, i) => (
                  <div key={t.name} className="tool-card" style={{ ['--i' as string]: Math.min(i, 12) }}>
                    <code>{cur.name}.{t.name}</code>
                    <p className="muted small">{t.description || tr('没有说明')}</p>
                  </div>
                ))}
              </div>
            ) : <p className="muted small">{cur.state === 'off' ? tr('停用了，工具已经从员工的工具箱里拿掉。') : cur.state === 'connecting' ? tr('正在接…') : tr('没有拿到工具。')}</p>}
          </div>
        ) : <div className="room-empty small-empty"><p>{tr('选一条线，或者接一条新线。')}</p></div>}
      </section>

      <aside className="room-aside">
        <div className="pnl-s">
          <h4>{tr('线从哪来')}</h4>
          <p className="muted small"><b>{tr('内置')}</b>{tr('：arXiv 码头（')}<code>PAPERTOWN_ARXIV=0</code> {tr('关掉）。')}</p>
          <p className="muted small"><b>PAPERTOWN_MCP_CONFIG</b>{tr('：')}{v.config_file ? <code>{v.config_file}</code> : tr('没有设置')}{tr('，在这里只能停用。')}</p>
          <p className="muted small"><b>{tr('在小镇里添加')}</b>{tr('：')}<code>{v.town_file}</code>{tr('，可以改、可以删。')}</p>
        </div>
        <div className="pnl-s">
          <h4>{tr('把小镇接到别的 agent 上')}</h4>
          <p className="muted small">{tr('Papertown 自己也是一个只读的 MCP server，别的 agent 能用它查论文库和项目的工序：')}</p>
          <pre className="code small-code">{JSON.stringify(v.self, null, 2)}</pre>
          <button className="btn" onClick={() => navigator.clipboard?.writeText(JSON.stringify(v.self, null, 2)).then(() => p.toast(tr('已复制')), () => {})}>{tr('复制')}</button>
        </div>
      </aside>
    </div>
  );
}
