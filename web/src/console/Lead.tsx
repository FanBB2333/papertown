// A project's lead: what it has reported and asked, kept current (the 进展 conversation shows it), and its
// check-in settings beside its conversation in the 员工 panel.

import { useEffect, useState } from 'react';
import { api, listen, type LeadView } from '../api';
import { ResidentControl } from '../components/Resident';
import { Select } from '../components/Select';
import { tr } from '../i18n';
import { follow, href } from '../route';

const EVERY = [15, 30, 60, 120, 240, 480];

export function useLead(lineId: string) {
  const [v, setV] = useState<LeadView | null>(null);
  const [bump, setBump] = useState(0);
  useEffect(() => listen(e => {
    if ((e.type === 'report' && e.report?.line_id === lineId) || (e.type === 'agent' && (e.agent?.line_id === lineId || e.agent?.id === `lead-${lineId}`)) || (e.type === 'line' && (e.line?.id === lineId || e.line_id === lineId))) setBump(b => b + 1);
  }), [lineId]);
  useEffect(() => {
    let alive = true;
    api.lead(lineId).then(x => alive && setV(x)).catch(() => alive && setV(null));
    return () => { alive = false; };
  }, [lineId, bump]);
  return [v, () => setBump(b => b + 1)] as const;
}

// beside the lead's conversation: its check-in settings, and the way to what it tells and asks you
export function LeadAside({ lineId, seq, toast }: { lineId: string; seq?: number; toast: (t: string) => void }) {
  const [v, again] = useLead(lineId);
  if (!v) return null;
  const set = (o: { supervise?: boolean; every?: number }) => api.setLead(lineId, o).then(again).catch(e => toast((e as Error).message));
  const talk = seq != null ? `/progress/${seq}/ask` : null;
  return (
    <>
      <ResidentControl lineId={lineId} resident={v.resident} model={v.agent?.model} talk={talk ?? undefined} toast={toast} onChanged={again} />
      <div className="pnl-s">
        <h4>{tr('巡检')}</h4>
        <label className="ld-sw">
          <input type="checkbox" checked={v.settings.supervise} onChange={e => set({ supervise: e.target.checked })} />
          <span>{tr('项目有新动态时（实验结束或失败、员工结束一轮、工序变更、你回复）向负责人发送消息')}</span>
        </label>
        <label className="field">{tr('项目无新动态时，最多隔多久检查一次')}
          <Select value={v.settings.every} disabled={!v.settings.supervise} onChange={m => set({ every: m })}
            options={EVERY.map(m => ({ value: m, label: m < 60 ? tr('{0} 分钟', m) : tr('{0} 小时', m / 60) }))} />
        </label>
        <p className="muted small">{tr('连续三次无新动态即停止跟进，直至项目再有变化。')}</p>
      </div>
      {talk && (
        <div className="pnl-s">
          <h4>{tr('汇报和提问')}</h4>
          <p className="muted small">{tr('负责人的汇报、向你的提问，以及你在「进展」中发送的消息，均在此项目对话中。')}</p>
          <a className={`btn${v.asks.length ? ' pri' : ''}`} href={href(talk)} onClick={e => follow(e, talk)}>
            {v.asks.length ? tr('{0} 项待你回复', v.asks.length) : tr('打开对话')}
          </a>
        </div>
      )}
    </>
  );
}
