// Building detail (layout C): the building's own production line on a belt, with panels
// underneath. A mill shows its paper's stages and live outputs.

import { useEffect, useState } from 'react';
import { BUILDINGS, DISTRICTS } from '@design/sprites.js';
import { api, fileUrl, type Line, type Placement, type Sheet as SheetData, type Stage } from '../api';
import { Ava, Item, ROLE_NAMES, Sprite, itemName } from '../art';
import { GpuBoard } from './Gpus';
import { LinkedRepos } from './Linked';
import { LibraryShelf, LinePapers } from './Papers';
import { tr } from '../i18n';

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
  focus?: string | null;
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

const STAGE_WORD: Record<Stage['status'], string> = { done: tr('完成'), run: tr('进行中'), wait: tr('等你决定'), todo: tr('排队'), fail: tr('出错') };

const chip = (st: string, pct?: number) => st === 'done' ? <span className="chip ok">{STAGE_WORD.done}</span>
  : st === 'run' ? <span className="chip pri">{STAGE_WORD.run}{pct ? ` ${pct}%` : ''}</span>
    : st === 'wait' ? <span className="chip warn">{STAGE_WORD.wait}</span>
      : st === 'fail' ? <span className="chip bad">{STAGE_WORD.fail}</span> : <span className="chip">{STAGE_WORD.todo}</span>;

const chips = (xs: string[]) => xs.length ? xs.map(x => <span key={x} className="chip">{x}</span>) : <span className="muted">—</span>;

// a project's files as links, main.pdf as the primary one
export const FileLinks = ({ lineId, files }: { lineId: string; files: string[] }) => (
  <div className="btns">{files.map(f => <a key={f} className={`btn${f === 'main.pdf' ? ' pri' : ''}`} href={fileUrl(lineId, f)} target="_blank" rel="noreferrer">{f}</a>)}</div>
);

function Belt({ stations }: { stations: { key: string; name: string; st: string; pct?: number; icon: React.ReactNode; out: string; team: React.ReactNode; open?: string }[] }) {
  const n = stations.length;
  const style: React.CSSProperties = { gridTemplateColumns: `repeat(${n}, minmax(0, ${n <= 5 ? '200px' : '1fr'}))` };
  if (n <= 5) Object.assign(style, { width: 'fit-content', margin: '0 auto' });
  return (
    <section className="line">
      <div className="stations" style={style}>
        <div className="belt" />
        {stations.map((s, i) => (
          <div key={s.key} className={`stn ${s.st === 'wait' ? 'run' : s.st === 'fail' ? 'todo' : s.st}`} data-open={s.open} title={s.open ? tr('打开{0}所在的建筑', s.name) : undefined}>
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
  if (!body) return <p className="muted">{tr('还没有产出。')}</p>;
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
      <div className="sec">{tr('问题')}</div><p>{body.problem}</p>
      <div className="sec">{tr('机制')}</div><ul>{(body.mechanism ?? []).map((m: string) => <li key={m}>{m}</li>)}</ul>
      <div className="sec">Baseline</div><ul>{(body.baselines ?? []).map((b: any) => <li key={b.name}>{b.name} <span className="muted">· {b.source}</span></li>)}</ul>
      <div className="sec">{tr('指标')}</div><p>{(body.metrics ?? []).join(tr('、'))}</p>
    </div>
  );
  if (stage === 'exp') return (
    <>
      {body.simulated && <p><span className="chip warn">{tr('模拟电厂 · 模拟结果，不是真实实验')}</span></p>}
      <table className="rtab"><thead><tr><th>{tr('方法')}</th>{body.metrics?.map((m: string) => <th key={m}>{m}</th>)}</tr></thead>
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
        <p className="muted small">{t.summary} {tr('· 引用')} {tr('{0} 篇 · 约', t.cited ?? 0)} {t.words ?? 0} {tr('词')}</p>
        {t.log && <pre className="log">{t.log}</pre>}
        <div className="btns">{(t.files ?? ['main.tex']).map((f: string) => <a key={f} className="btn" href={fileUrl(lineId, f)} target="_blank" rel="noreferrer">{f}</a>)}</div>
      </>
    );
  }
  if (stage === 'review') return (
    <>
      <p><span className="chip">{body.verdict}</span> {tr('平均')} {body.mean} {tr('分 ·')} {body.format?.summary}</p>
      {(body.reviews ?? []).map((r: any) => (
        <div key={r.worker} className="rv"><b>{r.persona} {r.worker}</b>{tr('：总分')} {r.overall}{tr('（新颖')} {r.scores?.novelty} {tr('· 可靠')} {r.scores?.soundness} {tr('· 清晰')} {r.scores?.clarity}{tr('）')}
          {r.weaknesses?.[0] && <div className="muted small">{r.weaknesses[0]}</div>}</div>
      ))}
    </>
  );
  if (stage === 'ship') return <div className="btns">{(body.files ?? []).map((f: string) => <a key={f} className="btn" href={fileUrl(lineId, f)} target="_blank" rel="noreferrer">{f}</a>)}</div>;
  return null;
}

export function MillDetail({ line, typeOf, onOpen, onHatch, onResume, onAdjust, onAsk, real, tick }: {
  line: Line; typeOf: (id: string) => string; onOpen: (id: string) => void; onHatch: (id: string) => void;
  onResume: (id: string) => void; onAdjust: (id: string) => void; onAsk: () => void; real: string; tick: number;
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
          <h4>{line.stages.findIndex(s => s.key === cur.key) + 1}. {cur.name} · {STAGE_WORD[cur.status]}</h4>
          <dl className="kv">
            <dt>{tr('员工')}</dt><dd>{cur.workers.length ? cur.workers.map(w => <span key={w.id} className="w"><Ava role={w.role} level={w.level} code={w.id} />{w.title} Lv.{w.level}</span>) : <span className="muted">{tr('Papertown 直接处理')}</span>}</dd>
            <dt>{tr('小镇 API 预算')}</dt><dd>{line.linked ? <span className="muted">{tr('本地项目未计入小镇 API 预算')}</span> : <><div className="bar"><i style={{ width: `${Math.min(100, 100 * line.spent / line.budget)}%` }} /></div>${line.spent.toFixed(4)} / ${line.budget.toFixed(2)}</>}</dd>
            <dt>Skills</dt><dd>{chips(STAGE_SKILLS[cur.key] ?? [])}</dd>
            <dt>{tr('工具')}</dt><dd>{(STAGE_TOOLS[cur.key] ?? []).map(s => <span key={s} className="chip">{s}</span>)}</dd>
            <dt>{tr('状态')}</dt><dd>{line.note ?? cur.note ?? ({ waiting: tr('撞车报告已经发到对话框，等你决定'), done: tr('已出厂') } as Record<string, string>)[line.status] ?? line.status}</dd>
          </dl>
          <div className="btns" style={{ marginTop: 12 }}>
            {line.status === 'waiting' && <><button className="btn pri" onClick={() => onHatch(line.id)}>{tr('孵化并立项')}</button><button className="btn" onClick={() => onAdjust(line.id)}>{tr('调整 idea')}</button></>}
            {['paused', 'failed'].includes(line.status) && <button className="btn pri" onClick={() => onResume(line.id)}>{tr('继续')}</button>}
            <button className="btn" onClick={onAsk}>{tr('问问这里的员工')}</button>
          </div>
        </div>
        <div className="pnl">
          <h4>{tr('产出 ·')} {shown ? names[shown] : '—'}</h4>
          <div className="out-tabs">{done.map(k => <a key={k} className={k === shown ? 'on' : ''} onClick={() => setView(k)}>{names[k]}</a>)}</div>
          {shown ? <Output stage={shown} body={outputs[shown]} lineId={line.id} />
            : line.linked && <p className="muted small">{tr('本地项目不走流水线，没有工序产出。代码和论文的现状在下面「本地仓库」里。')}</p>}
        </div>
        <div className="pnl">
          <h4>{next ? tr('下一站 · {0}', next.name) : tr('已出厂')}</h4>
          <p className="real">{next ? real : tr('论文和源码都在下面，可以直接下载。')}</p>
          {line.files.length > 0 && <FileLinks lineId={line.id} files={line.files} />}
          {next && <div className="btns" style={{ marginTop: 10 }}><button className="btn" onClick={() => onOpen(next.building)}>{tr('去')}{next.name}{tr('所在的建筑')}</button></div>}
        </div>
      </section>
      <LinkedRepos line={line} onOpen={onOpen} />
      <LinePapers lineId={line.id} tick={tick} />
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
        if (live) setErr((e as Error).message);
      }
    }, s && s.id === p.id ? 250 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [p.id, p.tick]);

  const typeOf = (id: string) => p.placements.find(x => x.id === id)?.type ?? id;
  const nameOf = (id: string) => p.placements.find(x => x.id === id)?.name ?? BUILDINGS[id]?.name ?? id;
  if (err) return <div className="p-sheet pnl lc"><div className="sh-head"><p>{err}</p><button className="sh-x" onClick={p.onClose}>×</button></div></div>;
  if (!s || s.id !== p.id && s.type !== p.id) return <div className="p-sheet pnl lc"><div className="sh-head"><p className="muted">{tr('加载中…')}</p></div></div>;

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
          <div className="crumbs">{tr('世界 /')} {s.district || DISTRICTS[BUILDINGS[s.type]?.district]?.name} / <b>{s.name}</b></div>
          <h2>{line ? tr('{0}「{1}」', s.name, line.title) : `${s.name} · ${s.job}`}</h2>
          <p>{line ? line.idea : s.rep}</p>
          <div className="sh-chips">
            <span className="chip">{s.tech}</span>
            {!s.live && <span className="chip warn">{s.later ? tr('以后再做') : tr('未接入')}</span>}
            {line && <span className="chip pri">{line.current?.name ?? (line.status === 'done' ? tr('已出厂') : line.status)} · {line.pct}%</span>}
            {cur && <span className="chip pri">{cur.name}</span>}
          </div>
        </div>
        <div className="sh-btns">
          <button className="btn" onClick={() => p.onAsk(s.id, s.name)}>{tr('问问这里的员工')}</button>
          <button className="sh-x" title={tr('关闭 Esc')} onClick={p.onClose}>×</button>
        </div>
      </header>
      {line ? (
        <MillDetail line={line} typeOf={typeOf} real={s.real} tick={p.tick} onOpen={p.onOpen} onHatch={p.onHatch} onResume={p.onResume}
          onAdjust={p.onAdjust} onAsk={() => p.onAsk(s.id, s.name)} />
      ) : (
        <>
          <Belt stations={(s.stations ?? []).map((x, i) => ({
            key: String(i), name: x.name, st: x.st, out: x.out, icon: <Item k={x.out} />,
            team: x.team.length ? x.team.map((r, k) => <Ava key={k} role={r} />) : <em>—</em>,
          }))} />
          <section className="detail">
            <div className="pnl">
              <h4>{cur ? tr('当前工位 · {0}', cur.name) : s.live ? tr('现在空闲') : tr('还没接入')}</h4>
              <dl className="kv">
                <dt>{tr('员工')}</dt><dd>{team.length ? team.map(r => <span key={r} className="w"><Ava role={r} />{ROLE_NAMES[r]}</span>) : <span className="muted">{tr('自动运行，没有 agent 员工')}</span>}</dd>
                <dt>Skills</dt><dd>{chips(s.skills)}</dd>
                <dt>{tr('工具')}</dt><dd>{chips(s.tools)}</dd>
                <dt>{tr('现在')}</dt><dd>{s.job}</dd>
              </dl>
              {s.active_line && <div className="btns" style={{ marginTop: 12 }}><button className="btn pri" onClick={() => p.onOpen(p.placements.find(x => x.line_id === s.active_line)?.id ?? 'hatchery')}>{tr('看这篇论文的流水线')}</button></div>}
            </div>
            <div className="pnl">
              <h4>{tr('进货 / 出货')}</h4>
              <div className="io-list">{goods(s.from, tr('来自'))}{goods(s.to, tr('送往'))}</div>
            </div>
            <div className="pnl">
              <h4>{tr('怎么实现的')}</h4><p className="real">{s.real}</p>
            </div>
          </section>
          {s.type === 'library' && <LibraryShelf tick={p.tick} />}
          {s.type === 'power' && <GpuBoard focus={p.focus} />}
        </>
      )}
    </div>
  );
}
