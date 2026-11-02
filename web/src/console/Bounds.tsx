// Work boundaries: what the agents must get done, must never do, and must ask you about first.
// Three levels, each with an agent of its own: the global one is the assistant's and reaches
// every project; a project's is its lead's and reaches its workers; a worker's is its own. A rule
// passes down as its inheritance says: 继承, and a lower level may switch it off for itself;
// 不继承, it stays where it is written; 必须继承, every level below keeps it. A never or ask rule
// may name an action that goes through Papertown, which then refuses it or holds it for you.
// Beside the editor, what each agent keeps once saved.

import { useEffect, useState } from 'react';
import { api, type Bound, type BoundInherit, type BoundKind, type BoundsLevel, type BoundsView, type Line } from '../api';
import { Select } from '../components/Select';
import { tr } from '../i18n';
import { Icon } from './icons';

type Lv = 'global' | 'project' | 'coder' | 'writer';
type Who = 'assistant' | 'lead' | 'coder' | 'writer';
type Row = Bound & { k: string }; // k keys a row in the editor before the server gives it an id
type Draft = { rules: Row[]; off: string[] };
type Came = { r: Bound; from: 'global' | 'project'; locked: boolean };

const KINDS: BoundKind[] = ['must', 'never', 'ask'];
const KIND: Record<BoundKind, string> = { must: tr('必须完成'), never: tr('不能做'), ask: tr('需要询问') };
const INHERIT: Record<BoundInherit, string> = { yes: tr('继承'), no: tr('不继承'), force: tr('必须继承') };
const HINT: Record<BoundKind, string> = { must: tr('例如：每个改动都跑一遍测试'), never: tr('例如：不要推送到远端'), ask: tr('例如：改实验配置前先问我') };
const FROM = { global: tr('全局'), project: tr('项目'), worker: tr('员工') };
const WHO: Record<Who, string> = { assistant: tr('小助手'), lead: tr('项目负责人'), coder: tr('代码员工'), writer: tr('写作员工') };
const isWorker = (lv: Lv): lv is 'coder' | 'writer' => lv === 'coder' || lv === 'writer';
// the rules a level writes down, as the server keeps them
const bare = (d: Draft) => ({ rules: d.rules.filter(r => r.text.trim()).map(({ id, kind, text, inherit, action }) => ({ id: id || undefined, kind, text: text.trim(), inherit, action })), off: [...d.off].sort() });
let made = 0;

export function Bounds({ line, toast }: { line: Line | null; toast: (t: string) => void }) {
  const lid = line?.id;
  const [got, setGot] = useState<{ lid?: string; v: BoundsView } | null>(null); // the levels, with the project they were read for
  const [err, setErr] = useState('');
  const [drafts, setDrafts] = useState<Partial<Record<Lv, Draft>>>({});
  const [worker, setWorker] = useState<'coder' | 'writer'>('coder');
  const [picked, setWho] = useState<Who | null>(null);
  const [busy, setBusy] = useState<Lv | null>(null);

  useEffect(() => {
    let alive = true;
    setDrafts({});
    api.bounds(lid).then(x => { if (alive) { setGot({ lid, v: x }); setErr(''); } }, e => alive && setErr((e as Error).message));
    return () => { alive = false; };
  }, [lid]);

  const v = got && got.lid === lid ? got.v : null;
  if (!v) return <div className="cm-page"><p className="muted">{err || tr('加载中…')}</p></div>;
  const lv = v.levels;
  const saved = (l: Lv): BoundsLevel => (l === 'global' ? lv.global : l === 'project' ? lv.project! : lv.workers![l]);
  const rows = (b: BoundsLevel): Draft => ({ rules: b.rules.map(r => ({ ...r, k: r.id })), off: b.off ?? [] });
  const cur = (l: Lv) => drafts[l] ?? rows(saved(l));
  const dirty = (l: Lv) => !!drafts[l] && JSON.stringify(bare(drafts[l]!)) !== JSON.stringify(bare(rows(saved(l))));
  const edit = (l: Lv, f: (d: Draft) => Draft) => setDrafts(ds => ({ ...ds, [l]: f(ds[l] ?? rows(saved(l))) }));
  const drop = (l: Lv) => setDrafts(ds => { const { [l]: _, ...rest } = ds; return rest; });

  // what comes down to a level from above, before it switches anything off
  const came = (l: Lv): Came[] => {
    const g = lv.global.rules.filter(r => r.inherit !== 'no').map(r => ({ r, from: 'global' as const, locked: r.inherit === 'force' }));
    if (l === 'project') return g;
    if (!isWorker(l)) return [];
    const off = lv.project?.off ?? [];
    return [...g.filter(x => x.locked || !off.includes(x.r.id)),
      ...(lv.project?.rules ?? []).filter(r => r.inherit !== 'no').map(r => ({ r, from: 'project' as const, locked: r.inherit === 'force' }))];
  };

  async function save(l: Lv) {
    setBusy(l);
    try {
      const d = bare(cur(l));
      let x = await api.saveBounds({ line_id: l === 'global' ? undefined : lid, role: isWorker(l) ? l : undefined, rules: d.rules, off: l === 'global' ? undefined : d.off });
      if (l === 'global' && lid) x = await api.bounds(lid); // the global level comes back alone
      setGot({ lid, v: x });
      drop(l);
      toast(tr('保存了。规则有变的 agent 会收到新的一份。'));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const level = (l: Lv, title: string, note: string, head?: React.ReactNode) => {
    const d = cur(l), inherited = came(l);
    return (
      <section className={`cs bd-lv lv-${isWorker(l) ? 'worker' : l}`} data-ref={`bounds:${l}`} data-ref-label={`${tr('工作边界')} ${title}`}>
        <div className="cs-h">
          <h3>{title}</h3>
          {head}
          <span className="muted small">{note}</span>
        </div>
        {inherited.length > 0 && (
          <ul className="bd-came">
            {inherited.map(({ r, from, locked }) => {
              const off = !locked && d.off.includes(r.id);
              return (
                <li key={r.id} className={`bd-in k-${r.kind}${off ? ' off' : ''}`}>
                  <span className="bd-kc">{KIND[r.kind]}</span>
                  <span className="bd-t">{r.text}{r.action && <Act r={r} actions={v.actions} />}</span>
                  <span className="bd-from">{tr('来自{0}', FROM[from])}</span>
                  {locked
                    ? <span className="bd-lock" title={tr('上一层设成了必须继承，这里关不掉')}><Icon n="lock" size={13} />{tr('必须继承')}</span>
                    : <label className="bd-sw" title={off ? tr('这一层和它下面不再守这一条') : tr('取消勾选，这一层和它下面就不守这一条')}>
                      <input type="checkbox" checked={!off} onChange={e => edit(l, x => ({ ...x, off: e.target.checked ? x.off.filter(i => i !== r.id) : [...x.off, r.id] }))} />
                      {off ? tr('已关掉') : tr('生效')}
                    </label>}
                </li>
              );
            })}
          </ul>
        )}
        <ul className="bd-own">
          {d.rules.map((r, i) => {
            const set = (o: Partial<Bound>) => edit(l, x => ({ ...x, rules: x.rules.map((y, j) => (j === i ? { ...y, ...o } : y)) }));
            return (
              <li key={r.k} className={`bd-row k-${r.kind}`}>
                <Select className="bd-kind" value={r.kind} label={tr('类别')} options={KINDS.map(k => ({ value: k, label: KIND[k] }))}
                  onChange={k => set({ kind: k, action: k === 'must' ? null : r.action })} />
                <input className="bd-text" value={r.text} maxLength={300} placeholder={HINT[r.kind]} autoFocus={!r.id && !r.text}
                  onChange={e => set({ text: e.target.value })} aria-label={tr('条目内容')} />
                {!isWorker(l) && <Select className="bd-inh" value={r.inherit} label={tr('往下传')} title={tr('下面的层级要不要守这一条')}
                  options={(['yes', 'no', 'force'] as BoundInherit[]).map(k => ({ value: k, label: INHERIT[k] }))} onChange={k => set({ inherit: k })} />}
                {r.kind !== 'must' && <Select className="bd-act" value={r.action ?? ''} label={tr('绑定动作')}
                  title={r.kind === 'never' ? tr('绑定以后，Papertown 会直接拦下这个动作') : tr('绑定以后，这个动作要等你同意才执行')}
                  options={[{ value: '', label: tr('不绑定动作') }, ...Object.entries(v.actions).map(([k, name]) => ({ value: k, label: name }))]}
                  onChange={a => set({ action: a || null })} />}
                <button className="ib bd-del" onClick={() => edit(l, x => ({ ...x, rules: x.rules.filter((_, j) => j !== i) }))} title={tr('删掉这一条')}>
                  <Icon n="close" size={14} />
                </button>
              </li>
            );
          })}
          {!d.rules.length && <li className="muted small bd-none">{inherited.length ? tr('这一层还没有自己的条目。') : tr('还没有条目。')}</li>}
        </ul>
        <div className="bd-foot">
          {KINDS.map(k => (
            <button key={k} className={`btn bd-add k-${k}`} onClick={() => edit(l, x => ({ ...x, rules: [...x.rules, { k: `n${++made}`, id: '', kind: k, text: '', inherit: isWorker(l) ? 'no' : 'yes', action: null }] }))}>
              <Icon n="plus" size={13} />{KIND[k]}
            </button>
          ))}
          {dirty(l) && <span className="bd-save">
            <span className="muted small">{tr('有改动没保存')}</span>
            <button className="btn" disabled={busy === l} onClick={() => drop(l)}>{tr('还原')}</button>
            <button className="btn pri" disabled={busy === l} onClick={() => save(l)}>{busy === l ? tr('保存中…') : tr('保存')}</button>
          </span>}
        </div>
      </section>
    );
  };

  const whos: Who[] = lid ? ['assistant', 'lead', 'coder', 'writer'] : ['assistant'];
  const who = picked && whos.includes(picked) ? picked : whos[1] ?? whos[0];
  const eff = v.effective[who] ?? [];
  return (
    <div className="cm-page bounds">
      <p className="bd-intro muted small">
        {tr('给 agent 定规矩：必须完成的、不能做的、动手前要先问你的。全局的给小助手，也往下传给每个项目；项目的给它的负责人，也往下传给员工；员工的只管它自己。')}
        {tr('不能做和需要询问的条目可以绑定一个经过 Papertown 的动作，它会替你拦下，或者等你点头再执行。')}
      </p>
      <div className="bd-grid">
        <div className="bd-levels">
          {level('global', tr('全局'), tr('小助手，以及往下的每个项目'))}
          {lid && line && level('project', tr('项目 #{0}', line.seq), tr('这个项目的负责人，以及往下的员工'))}
          {lid && level(worker, tr('员工'), tr('只管这一个员工'), (
            <div className="seg mini" role="tablist">
              {(['coder', 'writer'] as const).map(w => <button key={w} className={worker === w ? 'on' : ''} onClick={() => setWorker(w)}>{WHO[w]}{dirty(w) ? ' •' : ''}</button>)}
            </div>
          ))}
          {!lid && <p className="muted small">{tr('先选一个项目，才能设项目和员工这两层。')}</p>}
        </div>
        <aside className="cs bd-eff">
          <div className="cs-h"><h3>{tr('对谁有效')}</h3></div>
          {whos.length > 1 && <div className="seg mini bd-whos" role="tablist">
            {whos.map(w => <button key={w} className={who === w ? 'on' : ''} onClick={() => setWho(w)}>{WHO[w]}</button>)}
          </div>}
          <p className="muted small">{tr('{0}现在守的条目（保存后的）。它在自己的说明里读到这些，改了会收到一条消息。', WHO[who])}</p>
          {!eff.length ? <p className="muted small">{tr('没有条目。')}</p> : KINDS.map(k => {
            const rs = eff.filter(r => r.kind === k);
            return rs.length > 0 && (
              <div key={k} className={`bd-eg k-${k}`}>
                <h4>{KIND[k]}</h4>
                <ul>{rs.map(r => <li key={r.id}>{r.text}<span className="bd-from">{FROM[r.from ?? 'global']}{r.locked ? ` · ${tr('必须继承')}` : ''}</span>{r.action && <Act r={r} actions={v.actions} />}</li>)}</ul>
              </div>
            );
          })}
        </aside>
      </div>
    </div>
  );
}

// what Papertown does about a rule's action
function Act({ r, actions }: { r: Bound; actions: Record<string, string> }) {
  const name = actions[r.action!] ?? r.action;
  return <em className="bd-actn">{r.kind === 'never' ? tr('Papertown 会拦下「{0}」', name) : tr('「{0}」要等你点头', name)}</em>;
}
