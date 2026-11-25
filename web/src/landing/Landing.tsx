// The landing at /: a plain-language summary of the projects, the town's four buildings with live
// numbers, and the way in (straight in on the local machine, otherwise the access password).

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, type AuthState, type ProjectCard } from '../api';
import { Logo, Sprite } from '../art';
import { Icon } from '../console/icons';
import { DEMO } from '../demo';
import { LANG, LANGS, setLang, tr } from '../i18n';
import { follow, go, href, next, PATHS } from '../route';
import { getSettings } from '../settings';
import { Select } from '../components/Select';
import { ago } from '../console/util';
import { youNeeded } from '../progress/parts';
import './landing.css';

const START = { cards: PATHS.cards, console: PATHS.console, '2d': PATHS.world, '3d': PATHS.world } as const;

const jobsIn = (r: ProjectCard[]) => [r.reduce((n, x) => n + x.running.length, 0), r.reduce((n, x) => n + x.queued.length, 0)] as const;

// building, name, what it is for, and what it holds now
const TOWN: [string, string, string, (r: ProjectCard[]) => string][] = [
  ['depot', tr('代码仓库'), tr('每次提交、改动和分支'), r => {
    const code = r.map(x => x.repos.code).filter(c => c && !c.missing);
    const dirty = code.reduce((n, c) => n + (c!.dirty ?? 0), 0);
    return dirty ? tr('{0} 个仓库 · {1} 处未提交', code.length, dirty) : tr('{0} 个仓库，均已提交', code.length);
  }],
  ['farm', tr('实验'), tr('运行中、排队中、规划中'), r => {
    const [run, q] = jobsIn(r);
    return run || q ? tr('{0} 个运行中 · {1} 个排队', run, q) : tr('当前暂无实验运行');
  }],
  ['press', tr('论文'), tr('LaTeX 仓库，字数和页数'), r => {
    const papers = r.map(x => x.repos.paper).filter(c => c && !c.missing);
    const words = papers.reduce((n, c) => n + (c!.words ?? 0), 0);
    return words ? tr('{0} 篇 · 共 {1} 词', papers.length, words.toLocaleString()) : tr('{0} 篇', papers.length);
  }],
  ['mill', tr('负责人'), tr('一个 agent 跟进一个项目'), r => tr('{0}/{1} 个项目有负责人', r.filter(x => x.lead?.started).length, r.length)],
];

const greeting = (h = new Date().getHours()) =>
  h < 5 ? tr('夜深了') : h < 11 ? tr('早上好') : h < 13 ? tr('中午好') : h < 18 ? tr('下午好') : tr('晚上好');
const FEATURES: [Parameters<typeof Icon>[0]['n'], string, string][] = [
  ['cards', tr('进展'), tr('每个项目一张卡片：运行中实验、预期产出、代码与论文仓库，负责人按你要求更新。')],
  ['chat', tr('对话'), tr('可询问项目任意事项，或向负责人派发任务。负责人的汇报与待你决定的事项也在此处。')],
  ['board', tr('小镇'), tr('项目详情：代码、实验、论文与员工可在中控屏面板中管理与修改，也可在小镇中穿行。')],
];

export function Landing({ auth, err, reload }: { auth: AuthState | null; err: string; reload: () => Promise<AuthState | null> }) {
  const enter = () => go(next(START[getSettings().start] ?? PATHS.cards));
  const [rows, setRows] = useState<ProjectCard[] | null>(null);
  useEffect(() => {
    if (!auth?.authed) { setRows(null); return; }
    let alive = true;
    api.cards().then(r => alive && setRows(r.cards)).catch(() => {});
    return () => { alive = false; };
  }, [auth?.authed]);
  return (
    <div className="landing theme-sketch">
      <header className="ld-top">
        <span className="ld-brand"><Logo /><b>Papertown</b></span>
        <Select className="ld-lang" value={LANG} options={LANGS.map(([v, name]) => ({ value: v, label: name }))} onChange={v => setLang(v as typeof LANG)} />
      </header>
      <main className="ld-main">
        <section className="ld-hero">
          <Headline auth={auth} rows={rows} />
        </section>
        <section className="ld-card pnl" aria-label={tr('登录')}>
          <Door auth={auth} err={err} reload={reload} enter={enter} />
        </section>
        <ol className="ld-town" aria-label={tr('小镇的四座建筑')}>
          {TOWN.map(([type, name, desc, now], i) => (
            <li key={type} style={{ ['--i' as string]: i }}>
              <span className="ld-sp"><Sprite type={type} /></span>
              <b>{name}</b><span className={rows ? 'ld-now' : undefined}>{rows ? now(rows) : desc}</span>
            </li>
          ))}
        </ol>
        {!rows && <ul className="ld-feats">
          {FEATURES.map(([ic, name, desc], i) => (
            <li key={name} style={{ ['--i' as string]: i }}><Icon n={ic} size={18} /><span><b>{name}</b>{desc}</span></li>
          ))}
        </ul>}
      </main>
      <footer className="ld-foot small muted">{DEMO ? tr('只读演示：数据为快照') : location.host}</footer>
    </div>
  );
}

// keeps a headline line on one line by shrinking its font to fit the column
function useOneLine(text: string) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.fontSize = '';
      const k = el.clientWidth / el.scrollWidth;
      if (k < 1) el.style.fontSize = `${Math.floor(parseFloat(getComputedStyle(el).fontSize) * k * 0.98)}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el.parentElement!);
    document.fonts.ready.then(fit);
    return () => ro.disconnect();
  }, [text]);
  return ref;
}

// greeting, project count and how many wait for you, then the blocked or at-risk ones as links
function Headline({ auth, rows }: { auth: AuthState | null; rows: ProjectCard[] | null }) {
  const hi = greeting();
  const n = rows?.length ?? 0, wait = rows?.filter(youNeeded).length ?? 0;
  const status = !rows ? (auth && !auth.authed ? tr('登录后查看项目进展。') : '')
    : !n ? tr('暂无项目。') : wait ? tr('{0} 个项目，{1} 个待你决定。', n, wait) : tr('{0} 个项目，无待你决定事项。', n);
  const line = useOneLine(status);
  const head = <><span className="ld-hi">{tr('{0}。', hi)}</span>{status && <span className={wait ? 'ld-st em-bar' : 'ld-st'} data-tone="warn" ref={line}>{status}</span>}</>;
  if (!rows) return <h1>{head}</h1>;
  const marked = [...rows.filter(r => r.card?.health === 'blocked'), ...rows.filter(r => r.card?.health === 'risk')];
  const shown = marked.slice(0, 3);
  const [run, q] = jobsIn(rows);
  const last = rows.map(r => r.card?.at).filter(Boolean).sort().pop();
  const facts = [run ? tr('{0} 个实验运行中', run) : tr('暂无实验运行'), q ? tr('{0} 个排队', q) : '', last ? tr('最近一次更新：{0}', ago(last)) : ''].filter(Boolean);
  return (
    <>
      <h1>
        {head}
        {n > 0 && (
          <span className="ld-h2">
            {shown.length ? (
              <>
                {shown.map((r, i) => (
                  <span key={r.line.id}>{i > 0 && tr('，')}<a className="em-state" data-tone={r.card!.health === 'blocked' ? 'bad' : 'warn'} href={href(`/progress/${r.line.seq}`)} onClick={e => follow(e, `/progress/${r.line.seq}`)}>
                    {r.card!.health === 'blocked' ? tr('#{0} 已受阻', r.line.seq) : tr('#{0} 有风险', r.line.seq)}</a></span>
                ))}
                {marked.length > shown.length && tr('，还有 {0} 个', marked.length - shown.length)}
                {marked.length < n ? tr('，其余正常。') : tr('。')}
              </>
            ) : rows.some(r => r.card) ? tr('均在正常推进。') : tr('尚无负责人撰写进展卡片。')}
          </span>
        )}
      </h1>
      <p className="ld-lede">{facts.join(' · ')}</p>
    </>
  );
}

// where to open Papertown on the computer that runs it: the port this page came from. The server speaks
// plain http, so https or no port means a proxy in between, whose port says nothing about the server's
const onHost = location.protocol === 'http:' && location.port ? `http://127.0.0.1:${location.port}` : '';

// the way in: straight in locally, a password elsewhere, or instructions when none is set yet
function Door({ auth, err, reload, enter }: { auth: AuthState | null; err: string; reload: () => Promise<AuthState | null>; enter: () => void }) {
  const [pw, setPw] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { if (auth && !auth.authed && auth.password) field.current?.focus(); }, [auth]);
  useEffect(() => {
    if (!auth?.authed) return;
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === 'Enter' && !(t && ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(t.tagName))) enter();
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [auth?.authed, enter]);

  if (DEMO) {
    return (
      <>
        <h2>{tr('查看演示')}</h2>
        <p className="muted">{tr('此为只读演示，数据为离线小镇快照。如需实际启动运行，请克隆仓库并在本机启动。')}</p>
        <button className="btn pri ld-go" onClick={enter}>{tr('进入演示')}<Icon n="right" size={16} /></button>
      </>
    );
  }
  if (!auth) {
    return <p className={err ? 'ld-wait em-state' : 'muted ld-wait'} data-tone="bad">{err ? tr('无法连接服务器：{0}', err) : tr('确认中…')}</p>;
  }

  async function login(e: React.FormEvent) {
    e.preventDefault();
    if (!pw) return;
    setBusy(true);
    setMsg('');
    try {
      await api.login(pw);
      const a = await reload();
      if (a?.authed) enter();
    } catch (x) { setMsg((x as Error).message); setPw(''); field.current?.focus(); } finally { setBusy(false); }
  }

  if (!auth.authed) {
    return auth.password ? (
      <form onSubmit={login}>
        <h2>{tr('登录')}</h2>
        <p className="muted">{tr('输入访问密码。该密码在运行 Papertown 的电脑上设置。')}</p>
        <label className="ld-field">
          <span>{tr('访问密码')}</span>
          <input ref={field} type="password" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} disabled={busy} />
        </label>
        {msg && <p className="ld-err em-state" data-tone="bad" role="alert">{msg}</p>}
        <button className="btn pri ld-go" type="submit" disabled={busy || !pw}>{busy ? tr('登录中…') : tr('登录')}<Icon n="right" size={16} /></button>
        <p className="small muted">{tr('登录保持 30 天，或直至你在设置中退出。')}</p>
      </form>
    ) : (
      <>
        <h2 className="em-state" data-tone="warn">{tr('暂无法进入')}</h2>
        <p className="muted">{tr('尚未设置访问密码，仅运行 Papertown 的电脑可打开。')}</p>
        <ol className="ld-steps">
          <li>{onHost ? tr('在那台电脑上打开 Papertown（{0}）', onHost) : tr('在那台电脑上打开 Papertown')}</li>
          <li>{tr('在该页面设置访问密码')}</li>
          <li>{tr('返回此处用密码登录')}</li>
        </ol>
        <button className="btn" onClick={() => reload()}><Icon n="refresh" size={14} />{tr('已设置，重新检查')}</button>
      </>
    );
  }

  return (
    <>
      <h2>{auth.local ? tr('欢迎回来') : tr('已登录')}</h2>
      <p className="muted">
        {auth.local ? tr('此为运行 Papertown 的电脑，可直接进入。') : tr('此设备已通过访问密码登录。')}
      </p>
      <button className="btn pri ld-go" onClick={enter}>{tr('进入')}<Icon n="right" size={16} /></button>
      {auth.local ? <Password auth={auth} reload={reload} /> : (
        <button className="btn ld-out" onClick={async () => { await api.logout().catch(() => {}); await reload(); }}>{tr('退出登录')}</button>
      )}
    </>
  );
}

// on the local machine: set the password other devices sign in with
function Password({ auth, reload }: { auth: AuthState; reload: () => Promise<AuthState | null> }) {
  const [open, setOpen] = useState(false);
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (a !== b) { setMsg(tr('两次输入不一致')); return; }
    setBusy(true);
    setMsg('');
    try {
      await api.setPassword(a);
      await reload();
      setOpen(false);
      setA(''); setB('');
    } catch (x) { setMsg((x as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="ld-pw">
      <p className="small">
        <Icon n="lock" size={14} />
        {auth.password ? tr('手机与其他电脑通过访问密码登录。') : tr('尚未设置访问密码：设置后，手机与其他电脑即可登录。')}
        {!open && <button className="ld-link" onClick={() => setOpen(true)}>{auth.password ? tr('修改密码') : tr('设置密码')}</button>}
      </p>
      {open && (
        <form onSubmit={save} className="ld-pwf">
          <input type="password" autoComplete="new-password" placeholder={tr('新的访问密码（至少 6 位）')} value={a} onChange={e => setA(e.target.value)} autoFocus />
          <input type="password" autoComplete="new-password" placeholder={tr('再次输入')} value={b} onChange={e => setB(e.target.value)} />
          {msg && <p className="ld-err em-state" data-tone="bad" role="alert">{msg}</p>}
          <div className="btns">
            <button className="btn pri" type="submit" disabled={busy || a.length < 6 || !b}>{tr('保存')}</button>
            <button className="btn" type="button" onClick={() => { setOpen(false); setMsg(''); }}>{tr('取消')}</button>
          </div>
        </form>
      )}
    </div>
  );
}
