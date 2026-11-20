import { useMemo, useState } from 'react';
import { api, type Agent, type CanvasNode } from '../api';
import { fold, ImportCard, PaseoLog, PaseoPick, usePaseoTalk } from '../components/AgentRoom';
import { AGENT_STATUS } from '../components/MillRoom';
import { enterSends } from '../console/util';
import { tr } from '../i18n';
import type { Act } from './Checks';

export function NodeConversation({ node, lineId, busy, act }: { node: CanvasNode; lineId: string; busy: boolean; act: Act }) {
  const [configure, setConfigure] = useState(false);
  const agent = node.agent;
  const canBind = !node.agent_id && node.status === 'draft';
  return <div className="node-conversation">
    {node.agent_id ? <p className="small muted">{tr('这个任务使用独立的 Paseo 会话。派发、补充信息和返工都会回到这里。')}</p>
      : <p className="small muted">{tr('当前使用项目岗位的共享会话。可为尚未派发的任务创建或导入独立会话。')}</p>}
    {canBind && <button className="btn" disabled={busy} onClick={() => setConfigure(x => !x)}>{configure ? tr('收起') : tr('安排独立 Agent')}</button>}
    {canBind && configure ? <>
      <PaseoPick busy={busy} onStart={options => act(() => api.bindNode(lineId, node.id, options))} />
      <ImportCard busy={busy} onPick={ext_id => act(() => api.bindNode(lineId, node.id, { ext_id }))} />
    </> : agent?.runtime === 'paseo' && agent.ext_id ? <Talk key={agent.ext_id} initial={agent} />
      : <p className="muted small">{tr('还没有可打开的 Paseo 会话。')}</p>}
  </div>;
}

function Talk({ initial }: { initial: Agent }) {
  const talk = usePaseoTalk(initial);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'steer' | 'queue'>('queue');
  const { agent, items, asks, sent } = talk;
  const working = agent.status === 'working';
  const rows = useMemo(() => fold(items ?? [], item => item.kind === 'tool'), [items]);
  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const send = () => {
    const message = text.trim();
    if (!message) return;
    void run(async () => {
      const event = await api.say(agent.id, message, working ? mode : undefined);
      if (event.data.delivered) talk.wrote(message);
      setText('');
    });
  };
  return <>
    <div className="cv-row">
      <span className={`dot s-${agent.status}`} /><span>{AGENT_STATUS[agent.status]} · {agent.model}</span>
      <button className="btn" disabled={busy} onClick={() => run(() => api.openInPaseo(agent.id))}>Paseo ↗</button>
      {working && <button className="btn" disabled={busy} onClick={() => run(() => api.abort(agent.id))}>{tr('打断')}</button>}
    </div>
    {agent.cwd && <p className="small muted path">{agent.cwd}</p>}
    {(error || talk.err) && <p role="alert" className="warn-box">{error || talk.err}</p>}
    <div className="transcript node-transcript">
      {items === null && <p>{tr('加载中…')}</p>}
      <PaseoLog rows={rows} sent={sent} asks={asks} working={working}
        onPermit={(id, allow) => run(async () => { await api.permit(agent.id, id, allow); talk.answered(id); })} />
      {talk.queued.map(event => <div className="note" key={event.id}><b>{tr('排队')}</b><p>{String(event.data.text)}</p>
        {event.data.error && <p className="err">{String(event.data.error)}</p>}</div>)}
    </div>
    <div className="cv-form">
      <textarea aria-label={tr('消息')} rows={3} value={text} disabled={busy} onChange={e => setText(e.target.value)} onKeyDown={enterSends(send)} />
      <div className="cv-row">
        {working && <select aria-label={tr('发送方式')} value={mode} onChange={e => setMode(e.target.value as typeof mode)}>
          <option value="queue">{tr('排队')}</option><option value="steer">{tr('插话')}</option>
        </select>}
        <button className="btn pri" disabled={busy || !text.trim() || !!agent.down} onClick={send}>{tr('发送')}</button>
      </div>
    </div>
  </>;
}
