// The status view (layout D): the same town, told plainly — projects, papers, GPUs,
// agent calls — with no world metaphor.

import { useEffect, useState } from 'react';
import { api, fileUrl } from '../api';
import { Item } from '../art';
import { tr } from '../i18n';

const STATUS: Record<string, string> = {
  hatching: tr('查重中'), waiting: tr('等你决定'), running: tr('进行中'), paused: tr('已暂停'), failed: tr('出错'), done: tr('已完成'),
};

export function StatusView({ tick, active }: { tick: number; active: boolean }) {
  const [d, setD] = useState<any>(null);

  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => api.status().then(setD).catch(() => {}), d ? 400 : 0);
    return () => clearTimeout(t);
  }, [tick, active]);

  if (!d) return <main className="p-status"><div className="ld p-paper"><p className="muted">{tr('加载中…')}</p></div></main>;
  const lead = d.projects.find((p: any) => ['running', 'hatching', 'waiting', 'paused'].includes(p.status)) ?? d.projects[0];
  const now = new Date();
  return (
    <main className="p-status">
      <div className="ld p-paper">
        <header className="mast">
          <div className="mast-l">{tr('运行状态 ·')} {now.getMonth() + 1} {tr('月')} {now.getDate()} {tr('日')} {now.toTimeString().slice(0, 5)}</div>
          <h1>{tr('PAPERTOWN 日报')}</h1>
          <div className="mast-r"><span className={`chip ${d.hud.offline ? 'warn' : 'ok'}`}>{d.hud.offline ? tr('离线模式 · 模板输出') : tr('模型 {0}', d.hud.model)}</span></div>
        </header>
        <div className="rule" />
        {lead ? (
          <section className="lead">
            <div>
              <span className="kicker">{tr('头条')}</span>
              <h2>{tr('项目 #')}{lead.seq}{tr('「')}{lead.title}{tr('」')}{STATUS[lead.status] ?? lead.status}</h2>
              <p>{tr('当前工序：')}{lead.stage}{tr('，完成')} {lead.pct}{tr('%。')}{lead.verdict ? tr('查重结论：{0}。', lead.verdict) : ''}{tr('已花 $')}{lead.spent.toFixed(4)} / ${lead.budget.toFixed(2)}{tr('。')}</p>
              <div className="btns">
                {lead.mill_id && <button className="btn pri" data-open={lead.mill_id}>{tr('打开项目 #')}{lead.seq}</button>}
                {lead.files.includes('main.pdf') && <a className="btn" href={fileUrl(lead.id, 'main.pdf')} target="_blank" rel="noreferrer">{tr('下载 PDF')}</a>}
              </div>
            </div>
            <ul className="news">{d.headline.map((h: string, i: number) => <li key={i}><div><small>{h}</small></div></li>)}</ul>
          </section>
        ) : (
          <section className="lead"><div><span className="kicker">{tr('头条')}</span><h2>{tr('还没有项目')}</h2><p>{tr('回到「世界」，在左下角放入一颗 idea。')}</p></div></section>
        )}
        <div className="cols">
          <section className="col">
            <h3>{tr('新论文')}</h3><p className="sub">{tr('论文库')} {tr('{0} 篇，其中', d.library.total)} {d.library.arxiv} {tr('篇是从 arXiv 现拉的；按和进行中项目的相关度排序')}</p>
            <ul className="news">{d.papers.map((p: any) => (
              <li key={p.paper_id}><Item k="notes" /><div><b><a href={p.url} target="_blank" rel="noreferrer">{p.title}</a></b>
                <small>{p.year} · {p.authors}{p.relevance ? tr(' · 相关度 {0}', p.relevance.toFixed(2)) : ''}</small></div></li>
            ))}</ul>
          </section>
          <section className="col">
            <h3>{tr('我的项目')}</h3><p className="sub">{tr('{0} 个项目', d.projects.length)}</p>
            {d.projects.length === 0 && <p className="muted">—</p>}
            {d.projects.map((p: any) => (
              <div key={p.id} className="fac" data-open={p.mill_id ?? 'hatchery'}>
                <b>{tr('项目 #')}{p.seq} · {p.title}</b>
                <div className="row">{STATUS[p.status] ?? p.status} · {p.stage}<div className="bar"><i style={{ width: `${p.pct}%` }} /></div>{p.pct}%</div>
              </div>
            ))}
          </section>
          <section className="col">
            <h3>{tr('Agent 员工')}</h3><p className="sub">{tr('按 ROI 结算后的等级变动')}</p>
            {d.workers.length === 0 && <p className="muted">{tr('还没有结算过。')}</p>}
            {d.workers.map((w: any) => <div key={w.id} className="fac"><div className="row">{w.note}</div></div>)}
            <h3 style={{ marginTop: 12 }}>GPU</h3>
            <div className="fac"><div className="row">{d.plant.name}<div className="bar"><i style={{ width: `${d.plant.load}%` }} /></div>{d.plant.load}%</div>
              <div className="row">{d.plant.summary} {tr('· 没有真实 GPU，结果都标「模拟」')}</div></div>
          </section>
          <section className="col">
            <h3>{tr('本周 Agent 调用')}</h3><p className="sub">{tr('作业要求的几项技术各用了多少次')}</p>
            {d.calls.map((c: any) => (
              <div key={c.kind} className="fac"><div className="row"><span className={`k k-${c.kind.toLowerCase()}`}>{c.kind}</span>{c.name}<div className="bar"><i style={{ width: `${c.pct}%` }} /></div>{c.count}</div></div>
            ))}
            <div className="fac"><div className="row">{tr('本周花费')} <b style={{ marginLeft: 'auto', color: 'var(--ink)' }}>${d.bank.week.toFixed(4)}</b> {tr('/ 预算 $')}{d.bank.budget}</div></div>
            <div className="fac"><div className="row">{tr('Skills：')}{d.skills.map((s: any) => s.name).join(' · ')}</div></div>
          </section>
        </div>
        <div className="stats">
          <div><b>{d.library.total}</b><span>{tr('论文库')}</span></div>
          <div><b>{d.hud.lines.running}</b><span>{tr('运行中的项目')}</span></div>
          <div><b>{d.skills.length}</b><span>{tr('在岗 skill')}</span></div>
          <div><b>${d.bank.week.toFixed(2)}</b><span>{tr('本周花费')}</span></div>
          <div><b>{d.hud.lines.total}</b><span>{tr('已查重的 idea')}</span></div>
        </div>
      </div>
    </main>
  );
}
