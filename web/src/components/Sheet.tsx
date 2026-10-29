// Building detail (layout C): the building's own production line on a belt, and three
// panels underneath. A mill shows its paper's eight stages and live outputs.

import { useEffect, useState } from 'react';
import { BUILDINGS, DISTRICTS } from '@design/sprites.js';
import { api, fileUrl, type Line, type Placement, type Sheet as SheetData, type Stage } from '../api';
import { Ava, Item, ROLE_NAMES, Sprite, itemName } from '../art';

interface Props {
  id: string;
  tick: number;
  placements: Placement[];
  onClose: () => void;
  onOpen: (id: string) => void;
  onAsk: (id: string, name: string) => void;
  onHatch: (lineId: string) => void;
  onResume: (lineId: string) => void;
  onAdjust: (lineId: string) => void;
}

const STAGE_SKILLS: Record<string, string[]> = {
  hatch: ['novelty-check'], method: ['method-design'], exp: ['experiment-runner'], write: ['latex-writing'],
  review: ['anonymity-check', 'paper-review'],
};
const STAGE_TOOLS: Record<string, string[]> = {
  hatch: ['library.search', 'arxiv.search (MCP)', 'genealogy.expand'], team: ['market.compile_team'],
  method: ['library.search', 'depot.search'], exp: ['power.status', 'power.submit', 'power.wait'],
  write: ['library.get', 'press.typeset'], review: ['press.read'], ship: ['press.package'],
};

const chip = (st: string, pct?: number) => st === 'done' ? <span className="chip ok">完成</span>
  : st === 'run' ? <span className="chip pri">进行中{pct ? ` ${pct}%` : ''}</span>
    : st === 'wait' ? <span className="chip warn">等你决定</span> : <span className="chip">排队</span>;

function Belt({ stations }: { stations: { key: string; name: string; st: string; pct?: number; icon: React.ReactNode; out: string; team: React.ReactNode; open?: string }[] }) {
  const n = stations.length;
  const style: React.CSSProperties = { gridTemplateColumns: `repeat(${n}, minmax(0, ${n <= 5 ? '200px' : '1fr'}))` };
  if (n <= 5) Object.assign(style, { width: 'fit-content', margin: '0 auto' });
  return (
    <section className="line">
      <div className="stations" style={style}>
        <div className="belt" />
        {stations.map((s, i) => (
          <div key={s.key} className={`stn ${s.st === 'wait' ? 'run' : s.st}`} data-open={s.open} title={s.open ? `打开${s.name}所在的建筑` : undefined}>
            <div className="stn-ic">{s.icon}</div>
            <b>{i + 1}. {s.name}</b>
            {chip(s.st, s.pct)}
            <div className="stn-team">{s.team}</div>
            <div className="stn-out" title={itemName(s.out)}><Item k={s.out} /></div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Output({ stage, body, lineId }: { stage: string; body: any; lineId: string }) {
  if (!body) return <p className="muted">还没有产出。</p>;
  if (stage === 'idea') return <p>{body.text}</p>;
  if (stage === 'hatch') return (
    <>
      <p className="verdict"><span className="chip">{body.verdict}</span>{body.gap}</p>
      <ul className="sim">{(body.similar ?? []).map((x: any) => (
        <li key={x.paper_id}><a href={x.url} target="_blank" rel="noreferrer">{x.title}</a><i style={{ ['--v' as any]: x.similarity }} /><b>{Number(x.similarity).toFixed(2)}</b></li>
      ))}</ul>
    </>
  );
  if (stage === 'team') return <p>{body.reason}</p>;
  if (stage === 'method') return (
    <div className="doc">
      <h6>{body.title}</h6>
      <div className="sec">问题</div><p>{body.problem}</p>
      <div className="sec">机制</div><ul>{(body.mechanism ?? []).map((m: string) => <li key={m}>{m}</li>)}</ul>
      <div className="sec">Baseline</div><ul>{(body.baselines ?? []).map((b: any) => <li key={b.name}>{b.name} <span className="muted">· {b.source}</span></li>)}</ul>
      <div className="sec">指标</div><p>{(body.metrics ?? []).join('、')}</p>
    </div>
  );
  if (stage === 'exp') return (
    <>
      {body.simulated && <p><span className="chip warn">模拟电厂 · 模拟结果，不是真实实验</span></p>}
      <table className="rtab"><thead><tr><th>方法</th>{body.metrics?.map((m: string) => <th key={m}>{m}</th>)}</tr></thead>
        <tbody>{body.rows?.map((r: any) => <tr key={r.method} className={r.ours ? 'ours' : ''}><td>{r.method}</td>{r.values.map((v: number, i: number) => <td key={i}>{v}</td>)}</tr>)}</tbody>
      </table>
      <p className="muted small">{body.analysis}</p>
    </>
  );
  if (stage === 'write') {
    const t = body.typeset ?? {};
    return (
      <>
        <h6 className="doc-t">{body.title}</h6>
        <p className="muted small">{t.summary} · 引用 {t.cited ?? 0} 篇 · 约 {t.words ?? 0} 词</p>
        {t.log && <pre className="log">{t.log}</pre>}
        <div className="btns">{(t.files ?? ['main.tex']).map((f: string) => <a key={f} className="btn" href={fileUrl(lineId, f)} target="_blank" rel="noreferrer">{f}</a>)}</div>
      </>
    );
  }
  if (stage === 'review') return (
    <>
      <p><span className="chip">{body.verdict}</span> 平均 {body.mean} 分 · {body.format?.summary}</p>
      {(body.reviews ?? []).map((r: any) => (
        <div key={r.worker} className="rv"><b>{r.persona} {r.worker}</b>：总分 {r.overall}（新颖 {r.scores?.novelty} · 可靠 {r.scores?.soundness} · 清晰 {r.scores?.clarity}）
          {r.weaknesses?.[0] && <div className="muted small">{r.weaknesses[0]}</div>}</div>
      ))}
    </>
  );
  if (stage === 'ship') return <div className="btns">{(body.files ?? []).map((f: string) => <a key={f} className="btn" href={fileUrl(lineId, f)} target="_blank" rel="noreferrer">{f}</a>)}</div>;
  return null;
}

export function MillDetail({ line, typeOf, onOpen, onHatch, onResume, onAdjust, onAsk, real }: {
  line: Line; typeOf: (id: string) => string; onOpen: (id: string) => void; onHatch: (id: string) => void;
  onResume: (id: string) => void; onAdjust: (id: string) => void; onAsk: () => void; real: string;
}) {
  const outputs = line.outputs ?? {};
  const done = Object.keys(outputs);
  const [view, setView] = useState<string | null>(null);
  const shown = view && outputs[view] ? view : done[done.length - 1];
  const cur: Stage = line.current ?? [...line.stages].reverse().find(s => s.status === 'done') ?? line.stages[0];
  const next = line.stages.find(s => s.status !== 'done' && s.key !== cur.key);
  const names = Object.fromEntries(line.stages.map(s => [s.key, s.name]));
  return (
    <>
      <Belt stations={line.stages.map(s => ({
        key: s.key, name: s.name, st: s.status, pct: s.pct, out: s.out, open: s.building,
        icon: <Sprite type={typeOf(s.building)} />,
        team: s.workers.length ? s.workers.map(w => <Ava key={w.id} role={w.role} level={w.level} code={w.id} />) : <em>—</em>,
      }))} />
      <section className="detail">
        <div className="pnl">
          <h4>{line.stages.findIndex(s => s.key === cur.key) + 1}. {cur.name} · {{ done: '完成', run: '进行中', wait: '等你决定', todo: '排队' }[cur.status]}</h4>
          <dl className="kv">
            <dt>员工</dt><dd>{cur.workers.length ? cur.workers.map(w => <span key={w.id} className="w"><Ava role={w.role} level={w.level} code={w.id} />{w.title} Lv.{w.level}</span>) : <span className="muted">不需要 agent</span>}</dd>
            <dt>预算</dt><dd><div className="bar"><i style={{ width: `${Math.min(100, 100 * line.spent / line.budget)}%` }} /></div>${line.spent.toFixed(4)} / ${line.budget.toFixed(2)}</dd>
            <dt>Skills</dt><dd>{(STAGE_SKILLS[cur.key] ?? []).map(s => <span key={s} className="chip">{s}</span>)}{!STAGE_SKILLS[cur.key] && <span className="muted">—</span>}</dd>
            <dt>工具</dt><dd>{(STAGE_TOOLS[cur.key] ?? []).map(s => <span key={s} className="chip">{s}</span>)}</dd>
            <dt>状态</dt><dd>{line.note ?? cur.note ?? ({ waiting: '撞车报告已经发到对话框，等你决定', done: '已出厂' } as Record<string, string>)[line.status] ?? line.status}</dd>
          </dl>
          <div className="btns" style={{ marginTop: 12 }}>
            {line.status === 'waiting' && <><button className="btn pri" onClick={() => onHatch(line.id)}>孵化并立项</button><button className="btn" onClick={() => onAdjust(line.id)}>调整 idea</button></>}
            {['paused', 'failed'].includes(line.status) && <button className="btn pri" onClick={() => onResume(line.id)}>继续</button>}
            <button className="btn" onClick={onAsk}>问问这里的员工</button>
          </div>
        </div>
        <div className="pnl">
          <h4>产出 · {shown ? names[shown] : '—'}</h4>
          <div className="out-tabs">{done.map(k => <a key={k} className={k === shown ? 'on' : ''} onClick={() => setView(k)}>{names[k]}</a>)}</div>
          {shown && <Output stage={shown} body={outputs[shown]} lineId={line.id} />}
        </div>
        <div className="pnl">
          <h4>{next ? `下一站 · ${next.name}` : '已出厂'}</h4>
          <p className="real">{next ? real : '论文和源码都在下面，可以直接下载。'}</p>
          {line.files.length > 0 && <div className="btns">{line.files.map(f => <a key={f} className={`btn${f === 'main.pdf' ? ' pri' : ''}`} href={fileUrl(line.id, f)} target="_blank" rel="noreferrer">{f}</a>)}</div>}
          {next && <div className="btns" style={{ marginTop: 10 }}><button className="btn" onClick={() => onOpen(next.building)}>去{next.name}所在的建筑</button></div>}
        </div>
      </section>
    </>
  );
}

export function Sheet(p: Props) {
  const [s, setS] = useState<SheetData | null>(null);
  const [line, setLine] = useState<Line | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      try {
        const data = await api.building(p.id);
        const ln = data.line ? await api.line(data.line.id) : null;
        if (live) { setS(data); setLine(ln); setErr(null); }
      } catch (e) {
        if (live) setErr(String((e as Error).message));
      }
    }, s && s.id === p.id ? 250 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [p.id, p.tick]);

  const typeOf = (id: string) => p.placements.find(x => x.id === id)?.type ?? id;
  const nameOf = (id: string) => p.placements.find(x => x.id === id)?.name ?? BUILDINGS[id]?.name ?? id;
  if (err) return <div className="p-sheet pnl lc"><div className="sh-head"><p>{err}</p><button className="sh-x" onClick={p.onClose}>×</button></div></div>;
  if (!s || s.id !== p.id && s.type !== p.id) return <div className="p-sheet pnl lc"><div className="sh-head"><p className="muted">加载中…</p></div></div>;

  const cur = s.stations?.find(x => x.st === 'run');
  const team = [...new Set((s.stations ?? []).flatMap(x => x.team))];
  const goods = (list: [string, string][], dir: string) => list.length ? list.map(([id, it]) => (
    <div key={dir + id + it} className="io" data-open={id}>
      <Item k={it} /><div><b>{dir} {nameOf(id)}</b><small>{itemName(it)}</small></div><span className="go">→</span>
    </div>
  )) : <p className="muted">—</p>;

  return (
    <div className="p-sheet pnl lc" role="dialog" aria-modal="true">
      <header className="sh-head">
        <div className="sh-art"><Sprite type={s.type} label={s.label} accent={s.accent} /></div>
        <div className="sh-t">
          <div className="crumbs">世界 / {s.district || DISTRICTS[BUILDINGS[s.type]?.district]?.name} / <b>{s.name}</b></div>
          <h2>{line ? `${s.name}「${line.title}」` : `${s.name} · ${s.job}`}</h2>
          <p>{line ? line.idea : s.rep}</p>
          <div className="sh-chips">
            <span className="chip">{s.tech}</span>
            {!s.live && <span className="chip warn">{s.later ? '以后再做' : '未接入'}</span>}
            {line && <span className="chip pri">{line.current?.name ?? (line.status === 'done' ? '已出厂' : line.status)} · {line.pct}%</span>}
            {cur && <span className="chip pri">{cur.name}</span>}
          </div>
        </div>
        <div className="sh-btns">
          <button className="btn" onClick={() => p.onAsk(s.id, s.name)}>问问这里的员工</button>
          <button className="sh-x" title="关闭 Esc" onClick={p.onClose}>×</button>
        </div>
      </header>
      {line ? (
        <MillDetail line={line} typeOf={typeOf} real={s.real} onOpen={p.onOpen} onHatch={p.onHatch} onResume={p.onResume}
          onAdjust={p.onAdjust} onAsk={() => p.onAsk(s.id, s.name)} />
      ) : (
        <>
          <Belt stations={(s.stations ?? []).map((x, i) => ({
            key: String(i), name: x.name, st: x.st, out: x.out, icon: <Item k={x.out} />,
            team: x.team.length ? x.team.map((r, k) => <Ava key={k} role={r} />) : <em>—</em>,
          }))} />
          <section className="detail">
            <div className="pnl">
              <h4>{cur ? `当前工位 · ${cur.name}` : s.live ? '现在空闲' : '还没接入'}</h4>
              <dl className="kv">
                <dt>员工</dt><dd>{team.length ? team.map(r => <span key={r} className="w"><Ava role={r} />{ROLE_NAMES[r]}</span>) : <span className="muted">自动运行，没有 agent 员工</span>}</dd>
                <dt>Skills</dt><dd>{s.skills.length ? s.skills.map(x => <span key={x} className="chip">{x}</span>) : <span className="muted">—</span>}</dd>
                <dt>工具</dt><dd>{s.tools.length ? s.tools.map(x => <span key={x} className="chip">{x}</span>) : <span className="muted">—</span>}</dd>
                <dt>现在</dt><dd>{s.job}</dd>
              </dl>
              {s.active_line && <div className="btns" style={{ marginTop: 12 }}><button className="btn pri" onClick={() => p.onOpen(p.placements.find(x => x.line_id === s.active_line)?.id ?? 'hatchery')}>看这篇论文的流水线</button></div>}
            </div>
            <div className="pnl">
              <h4>进货 / 出货</h4>
              <div className="io-list">{goods(s.from, '来自')}{goods(s.to, '送往')}</div>
            </div>
            <div className="pnl">
              <h4>怎么实现的</h4><p className="real">{s.real}</p>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
