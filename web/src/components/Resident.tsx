import { useEffect, useState } from 'react';
import { api, listen, type Resident, type Stage } from '../api';
import { tr } from '../i18n';
import { follow, href } from '../route';
import './resident.css';

export const POST_NAMES = { lead: tr('项目负责人'), coder: tr('代码员工'), writer: tr('写作员工') };
const STATE = { running: tr('在岗'), starting: tr('启动中'), blocked: tr('受阻'), off: tr('暂停'), ended: tr('结束') };
const LABEL = { running: tr('负责人在岗'), starting: tr('正在启动负责人'), blocked: tr('负责人启动受阻'), off: tr('负责人已暂停'), ended: tr('项目已结束') };

export function ResidentMark({ resident }: { resident: Resident }) {
  return <span className={`resident-mark rs-${resident.state}`} title={resident.note ?? LABEL[resident.state]}><i aria-hidden />{STATE[resident.state]}</span>;
}

export function AgentPost({ stage }: { stage: Stage }) {
  return stage.agents.length ? <>{stage.agents.map(a => <span className="stage-agent" key={a.id} title={[a.runtime, a.model].filter(Boolean).join(' · ')}><i className={`dot s-${a.status}`} />{a.name}</span>)}</> : <span className="muted">{POST_NAMES[stage.owner]}</span>;
}

// Read the contracted Line payload, independent of the card endpoint's summary shape.
export function useResidentLine(id: string) {
  const [line, setLine] = useState<Awaited<ReturnType<typeof api.line>> | null>(null);
  const [bump, setBump] = useState(0);
  useEffect(() => {
    setLine(null);
    return listen(e => {
      if ((e.type === 'line' && (e.line?.id === id || e.line_id === id)) || (e.type === 'agent' && e.agent?.line_id === id)) setBump(n => n + 1);
    });
  }, [id]);
  useEffect(() => {
    let alive = true;
    api.line(id).then(l => { if (alive) setLine(l); }).catch(() => {});
    return () => { alive = false; };
  }, [id, bump]);
  return [line, () => setBump(n => n + 1)] as const;
}

export function ResidentControl({ lineId, resident, model, sample, talk, toast, onChanged }: {
  lineId: string; resident: Resident; model?: string | null; sample?: boolean; talk?: string;
  toast: (s: string) => void; onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  async function set(on: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      await api.setLead(lineId, { on });
      await api.lead(lineId);
      onChanged();
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  }
  return <section className={`psec resident-control rs-${resident.state}`} aria-label={tr('项目负责人')} aria-busy={busy}>
    <div className="resident-copy" aria-live="polite">
      <b className="resident-title"><ResidentMark resident={resident} />{LABEL[resident.state]}</b>
      {resident.state === 'running' && <p className="muted small">{[resident.runtime, model, resident.status === 'working' ? tr('工作中') : resident.status === 'idle' ? tr('待命') : resident.status].filter(Boolean).join(' · ')}</p>}
      {resident.state === 'blocked' && resident.note && <p className="resident-warning">{resident.note}</p>}
      {sample && resident.state === 'off' && <p className="muted small">{tr('这是包含占位内容的样例项目。开启后由真实负责人继续推进。')}</p>}
    </div>
    {resident.state !== 'ended' && <div className="resident-actions">
      {resident.state === 'blocked' && <><button className="btn" disabled={busy} onClick={() => set(true)}>{tr('重试')}</button>{talk && <a className="btn" href={href(talk)} onClick={e => follow(e, talk)}>{tr('在对话中手动启动')}</a>}</>}
      <button type="button" role="switch" aria-checked={resident.on} aria-label={tr('项目负责人开关')} className="resident-switch" disabled={busy} onClick={() => set(!resident.on)}><span aria-hidden /></button>
    </div>}
  </section>;
}
