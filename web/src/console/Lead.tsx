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
          <span>{tr('项目有动静时（实验结束或失败、员工结束一轮、工序变了、你回答了问题）发消息给它')}</span>
        </label>
        <label className="field">{tr('项目没动静时，最多隔多久也看一眼')}
          <Select value={v.settings.every} disabled={!v.settings.supervise} onChange={m => set({ every: m })}
            options={EVERY.map(m => ({ value: m, label: m < 60 ? tr('{0} 分钟', m) : tr('{0} 小时', m / 60) }))} />
        </label>
        <p className="muted small">{tr('接连三次没有新动静就不再来，直到项目又有变化。')}</p>
      </div>
      {talk && (
        <div className="pnl-s">
          <h4>{tr('汇报和提问')}</h4>
          <p className="muted small">{tr('它的汇报、它问你的事，和你在「进展」里对它说的话，都在这个项目的对话里。')}</p>
          <a className={`btn${v.asks.length ? ' pri' : ''}`} href={href(talk)} onClick={e => follow(e, talk)}>
            {v.asks.length ? tr('{0} 件等你回答', v.asks.length) : tr('打开对话')}
          </a>
        </div>
      )}
    </>
  );
}
