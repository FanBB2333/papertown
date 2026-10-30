// A project linked in from local repositories: what is in its code repo and its paper repo,
// as git and the LaTeX sources show them. Read only; the agents hired for it work there.

import type { Commit, Line, LinkedCode, LinkedPaper } from '../api';
import { linkedPdfUrl } from '../api';
import { tr } from '../i18n';

function ago(ts: string | null | undefined) {
  if (!ts) return '';
  const s = (Date.now() - Date.parse(ts)) / 1000;
  return s < 3600 ? tr('{0} 分钟前', Math.max(1, Math.floor(s / 60))) : s < 86400 ? tr('{0} 小时前', Math.floor(s / 3600)) : tr('{0} 天前', Math.floor(s / 86400));
}

function Commits({ list }: { list?: Commit[] }) {
  if (!list?.length) return <p className="muted small">{tr('还没有提交。')}</p>;
  return (
    <ul className="commits">
      {list.map(c => (
        <li key={c.hash} title={`${c.hash} · ${c.author} · ${c.when}`}>
          <code>{c.hash}</code><span className="c-sub">{c.subject}</span><span className="muted small">{ago(c.when)}</span>
        </li>
      ))}
    </ul>
  );
}

function Dirty({ n }: { n?: number }) {
  return n ? <span className="chip warn" title={tr('git status 里没有提交的改动')}>{n} {tr('处没提交')}</span> : <span className="chip ok">{tr('工作区干净')}</span>;
}

function CodeCard({ c, onGo }: { c: LinkedCode; onGo: () => void }) {
  return (
    <div className="pnl lk-card">
      <div className="lk-head">
        <h4>{tr('代码仓库 ·')} {c.name}</h4>
        <button className="btn" onClick={onGo}>{tr('去仓库')}</button>
      </div>
      <p className="muted small lk-path">{c.path}</p>
      {c.missing ? <p className="warn-box small">{tr('这个目录不存在了，检查 projects.json 里的路径。')}</p> : (
        <>
          <div className="lk-chips">
            <span className="chip">{c.branch}</span>
            {c.remote && <span className="chip">{c.remote}</span>}
            <span className="chip">{tr('{0} 个文件', c.files)}</span>
            <Dirty n={c.dirty} />
          </div>
          {c.title && <b className="lk-title">{c.title}</b>}
          {c.readme && <p className="lk-text">{c.readme}</p>}
          {!!c.langs?.length && <div className="lk-langs">{c.langs.map(l => <span key={l.ext}><b>{l.ext}</b> {l.n}</span>)}</div>}
          {!!c.dirs?.length && <p className="muted small">{tr('目录：')}{c.dirs.join(' · ')}</p>}
          <h5>{tr('最近的提交')}</h5>
          <Commits list={c.commits} />
        </>
      )}
    </div>
  );
}

function PaperCard({ p, lineId, onGo }: { p: LinkedPaper; lineId: string; onGo: () => void }) {
  return (
    <div className="pnl lk-card">
      <div className="lk-head">
        <h4>{tr('论文仓库 ·')} {p.name}</h4>
        <div className="btns">
          {p.pdf && <a className="btn pri" href={linkedPdfUrl(lineId)} target="_blank" rel="noreferrer" title={tr('编译于 {0}', p.pdf_at)}>{tr('看 PDF')}</a>}
          <button className="btn" onClick={onGo}>{tr('去印刷厂')}</button>
        </div>
      </div>
      <p className="muted small lk-path">{p.path}{p.main ? ` · ${p.main}` : ''}</p>
      {p.missing ? <p className="warn-box small">{tr('这个目录不存在了，检查 projects.json 里的路径。')}</p>
        : !p.main ? <p className="muted small">{tr('没找到带 \\documentclass 的 .tex 文件。')}</p> : (
          <>
            <div className="lk-chips">
              <span className="chip">{tr('约')} {p.words} {tr('词')}</span>
              <span className="chip">{p.figures} {tr('图 ·')} {p.tables} {tr('表')}</span>
              <span className="chip">{tr('引用')} {tr('{0} 篇', p.bib)}</span>
              {p.pdf ? <span className="chip ok">PDF {ago(p.pdf_at)}{tr('编译')}</span> : <span className="chip">{tr('还没有 PDF')}</span>}
              <Dirty n={p.dirty} />
            </div>
            {p.title && <b className="lk-title">{p.title}</b>}
            {p.abstract ? <p className="lk-text">{p.abstract}</p> : <p className="muted small">{tr('摘要还没写。')}</p>}
            {!!p.sections?.length && <ol className="lk-secs">{p.sections.map(s => <li key={s}>{s}</li>)}</ol>}
            <h5>{tr('最近的提交')}</h5>
            <Commits list={p.commits} />
          </>
        )}
    </div>
  );
}

export function LinkedRepos({ line, onOpen }: { line: Line; onOpen: (id: string) => void }) {
  const l = line.linked;
  if (!l) return null;
  return (
    <section className="linked">
      <div className="shelf-head">
        <h4>{tr('本地仓库')}</h4>
        <span className="muted small">{tr('只读展示。给它配的代码员工和写作员工直接在这两个仓库里工作，提交和推送由你决定。')}</span>
      </div>
      <div className="lk-grid">
        {l.code && <CodeCard c={l.code} onGo={() => onOpen('depot')} />}
        {l.paper && <PaperCard p={l.paper} lineId={line.id} onGo={() => onOpen('press')} />}
      </div>
    </section>
  );
}
