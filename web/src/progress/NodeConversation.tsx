import { useMemo, useState } from 'react';
import { api, type Agent, type CanvasNode } from '../api';
import { fold, ImportCard, PaseoLog, RuntimePick, usePaseoTalk } from '../components/AgentRoom';
import { AGENT_STATUS } from '../components/MillRoom';
import { HostedRoom, HostedContext } from '../agents/Terminal';
import { Compose } from '../agents/Compose';
import { tr } from '../i18n';
import type { Act } from './Checks';

export function NodeConversation({ node, lineId, busy, act }: { node: CanvasNode; lineId: string; busy: boolean; act: Act }) {
  const [error, setError] = useState('');
  const [configure, setConfigure] = useState(false);
  const agent = node.agent;
  const canBind = !node.agent_id && node.status === 'draft';
  return <div className="node-conversation">
    {error && <p role="alert" className="warn-box">{error}</p>}
    {node.agent_id ? <p className="small muted">{tr('该任务使用独立会话，派发、补充信息与返工均在此处理。')}</p>
      : <p className="small muted">{tr('当前使用项目岗位的共享会话。可为尚未派发的任务创建或导入独立会话。')}</p>}
    {canBind && <button className="btn" disabled={busy} onClick={() => setConfigure(x => !x)}>{configure ? tr('收起') : tr('安排独立 Agent')}</button>}
    {canBind && configure ? <>
      <div className="hire-card">
        <RuntimePick busy={busy} onStart={options => act(() => api.bindNode(lineId, node.id, options))} role={node.to} />
      </div>
      <ImportCard busy={busy} onPick={ext_id => act(() => api.bindNode(lineId, node.id, { ext_id }))} />
    </> : agent?.term ? <><HostedRoom agent={agent} toast={setError} /><HostedContext agent={agent} toast={setError} /></> : agent?.runtime === 'paseo' && agent.ext_id ? <Talk key={agent.ext_id} initial={agent} />
      : <p className="muted small">{tr('暂无可打开的会话。')}</p>}
  </div>;
}

function Talk({ initial }: { initial: Agent }) {
  const talk = usePaseoTalk(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { agent, items, asks, sent } = talk;
  const working = agent.status === 'working';
  const rows = useMemo(() => fold(items ?? [], item => item.kind === 'tool'), [items]);
  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <>
    <div className="cv-row">
      <span className={`dot s-${agent.status}`} /><span>{AGENT_STATUS[agent.status]} · {agent.model}</span>
      <button className="btn" disabled={busy} onClick={() => run(() => api.openInPaseo(agent.id))}>Paseo ↗</button>
    </div>
    {agent.cwd && <p className="small muted path">{agent.cwd}</p>}
    {(error || talk.err) && <p role="alert" className="warn-box">{error || talk.err}</p>}
    <div className="transcript node-transcript" ref={talk.readRef}>
      {items === null && <p>{tr('加载中…')}</p>}
      <PaseoLog rows={rows} sent={sent} asks={asks} working={working}
        onPermit={(id, allow) => run(async () => { await api.permit(agent.id, id, allow); talk.answered(id); })} />
    </div>
    <Compose agent={agent} queued={talk.queued} permission={asks.length > 0} toast={setError} onChanged={talk.reload}
      onSent={(event, text) => { if (event.data.delivered) talk.wrote(text); }} />
  </>;
}
