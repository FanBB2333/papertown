// 汇报与讲解 at /progress/<number>/pages[/<page>]: the HTML pages a project's agents wrote, ready to
// present. A page runs in a sandbox (pages.py): it only reports its height and asks to open links;
// nothing else from it reaches this page.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, listen, type Page, type PageKind, type ProjectCard } from '../api';
import { StatusTag } from '../components/MillRoom';
import { Icon } from '../console/icons';
import { ago, enterSends } from '../console/util';
import { tr } from '../i18n';
import { follow, go, href } from '../route';
import './ask.css';

const KIND: Record<PageKind, string> = { report: tr('汇报'), explain: tr('讲解'), answer: tr('回答') };
export const pagesPath = (seq: number, id?: string) => `/progress/${seq}/pages${id ? `/${id}` : ''}`;

export interface PageOpen { file?: string; job?: string; page?: string }

// one page, sandboxed; given `fit`, the frame grows with the page up to that height
export function PageFrame({ src, title, fit, onOpen, onKey }: {
  src: string; title: string; fit?: number; onOpen: (o: PageOpen) => void; onKey?: (key: string) => void;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [h, setH] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => { setReady(false); setH(null); }, [src]);
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow || !e.data || e.data.pt !== 1) return;
      if (typeof e.data.h === 'number') setH(e.data.h);
      if (e.data.open) onOpen(e.data.open);
      if (typeof e.data.key === 'string') onKey?.(e.data.key);
    };
    addEventListener('message', on);
    return () => removeEventListener('message', on);
  }, [onOpen, onKey]);
  return (
    <div className={`pf${ready ? ' ready' : ''}`} style={fit ? { height: Math.min(Math.max(h ?? 180, 96), fit) } : undefined}>
      {!ready && <span className="pf-load"><span className="ak-dots"><i /><i /><i /></span></span>}
      <iframe ref={ref} src={src} title={title} onLoad={() => setReady(true)} referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals" />
    </div>
  );
}

// a project's pages, kept current
function usePages(lineId: string, toast: (t: string) => void) {
  const [pages, setPages] = useState<Page[] | null>(null);
  useEffect(() => {
    let alive = true;
    setPages(null);
    api.pages(lineId).then(r => alive && setPages(r.pages)).catch(e => toast((e as Error).message));
    const off = listen(e => {
      if (e.type !== 'page' || e.line_id !== lineId) return;
      setPages(ps => ps && (e.page.removed ? ps.filter(p => p.id !== e.page.id) : [...ps.filter(p => p.id !== e.page.id), e.page].sort((a, b) => a.n - b.n)));
    });
    return () => { alive = false; off(); };
  }, [lineId]); // eslint-disable-line react-hooks/exhaustive-deps
  return [pages, setPages] as const;
}

export function PagesView({ r, pid, toast, onOpen }: { r: ProjectCard; pid?: string; toast: (t: string) => void; onOpen: (o: PageOpen) => void }) {
  const { line } = r;
  const [pages, setPages] = usePages(line.id, toast);
  const [kind, setKind] = useState<PageKind | 'all'>('all');
  const [nav, setNav] = useState(false);
  const [asking, setAsking] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const back = `/progress/${line.seq}`;
  const newest = [...(pages ?? [])].reverse();
  const kinds = (['report', 'explain', 'answer'] as const).filter(k => newest.some(p => p.kind === k));
  const shown = kinds.includes(kind as PageKind) ? kind : 'all'; // the kind chosen may have gone with its last page
  const list = newest.filter(p => shown === 'all' || p.kind === shown);
  const cur = pid ? pages?.find(p => p.id === pid) : newest[0];
  const lead = !!r.lead?.started;

  useEffect(() => { setNav(false); }, [pid, line.id]);

  function step(d: -1 | 1) {
    const order = cur && list.some(p => p.id === cur.id) ? list : newest;
    const next = order[order.findIndex(p => p.id === cur?.id) + d];
    if (next) go(pagesPath(line.seq, next.id), true);
  }
  const onKey = (k: string) => { if (k === 'ArrowLeft') step(-1); else if (k === 'ArrowRight') step(1); };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest?.('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); onKey(e.key); }
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [onKey]);

  async function remove(p: Page) {
    if (!confirm(tr('删掉「{0}」？', p.title))) return;
    try {
      await api.dropPage(line.id, p.id);
      setPages(ps => ps && ps.filter(x => x.id !== p.id));
      if (cur?.id === p.id) go(pagesPath(line.seq), true);
    } catch (e) { toast((e as Error).message); }
  }
  const present = () => stage.current?.requestFullscreen?.().catch(() => {});

  return createPortal(
    <div className="ak pv" role="dialog" aria-modal="true" aria-label={tr('汇报与讲解')}>
      {nav && <div className="ak-scrim" onClick={() => setNav(false)} />}
      <aside className={`ak-side${nav ? ' open' : ''}`}>
        <a className="ak-back" href={href(back)} onClick={e => follow(e, back)}><Icon n="left" size={15} />{tr('回到项目')}</a>
        <button className={`ak-new${asking ? ' on' : ''}`} onClick={() => setAsking(a => !a)} disabled={!lead} title={lead ? '' : tr('这个项目还没有负责人')}>
          <Icon n="compose" size={16} />{tr('请负责人写一页')}
        </button>
        {asking && lead && <Request lineId={line.id} toast={toast} onDone={() => setAsking(false)} />}
        {kinds.length > 1 && (
          <div className="pv-kinds" role="tablist">
            {(['all', ...kinds] as const).map(k => (
              <button key={k} role="tab" aria-selected={shown === k} className={shown === k ? 'on' : ''} onClick={() => setKind(k)}>
                {k === 'all' ? tr('全部') : KIND[k]} {k === 'all' ? newest.length : newest.filter(p => p.kind === k).length}
              </button>
            ))}
          </div>
        )}
        <nav className="ak-hist pv-list" aria-label={tr('页面')}>
          <ul>
            {list.map(p => {
              const to = pagesPath(line.seq, p.id);
              return (
                <li key={p.id} className={cur?.id === p.id ? 'on' : ''}>
                  <a href={href(to)} onClick={e => follow(e, to)} aria-current={cur?.id === p.id ? 'page' : undefined}>
                    <b>{p.title}</b>
                    <span><i className={`pv-k k-${p.kind}`}>{KIND[p.kind]}</i>{ago(p.at)}{p.by ? ` · ${p.by}` : ''}</span>
                  </a>
                  <button className="ib ak-del" onClick={() => remove(p)} title={tr('删掉这一页')} aria-label={tr('删掉这一页')}><Icon n="close" size={12} /></button>
                </li>
              );
            })}
          </ul>
          {pages && !pages.length && <p className="ak-none">{tr('还没有页面。')}</p>}
        </nav>
      </aside>

      <main className="ak-main">
        <header className="ak-top pv-top">
          <button className="ib ak-menu" onClick={() => setNav(true)} title={tr('页面')} aria-label={tr('页面')}><Icon n="sidebar" size={18} /></button>
          {cur ? (
            <div className="pv-title">
              <b title={cur.title}>{cur.title}</b>
              <span><i className={`pv-k k-${cur.kind}`}>{KIND[cur.kind]}</i><span className="pc-seq">#{line.seq}</span>{cur.by ? ` · ${cur.by}` : ''} · {ago(cur.at)}
              </span>
            </div>
          ) : (
            <div className="ak-title"><span className="pc-seq">#{line.seq}</span><b>{line.title}</b><StatusTag status={line.status} /></div>
          )}
          {cur && (
            <div className="pv-acts">
              <button className="btn pri" onClick={present} title={tr('全屏演示，←/→ 换页，Esc 退出')}><Icon n="play" size={14} /><span>{tr('演示')}</span></button>
              <a className="ib" href={api.pageUrl(line.id, cur.id)} target="_blank" rel="noreferrer" title={tr('在新标签页打开')} aria-label={tr('在新标签页打开')}><Icon n="ext" size={16} /></a>
            </div>
          )}
          <a className="ib ak-x" href={href(back)} onClick={e => follow(e, back)} title={tr('回到项目')} aria-label={tr('关闭')}><Icon n="close" size={18} /></a>
        </header>

        {pages == null ? <p className="ak-load">{tr('加载中…')}</p> : cur ? (
          <div className="pv-stage">
            <div className="pv-paper" ref={stage}>
              <PageFrame key={cur.id} src={api.pageUrl(line.id, cur.id)} title={cur.title} onOpen={onOpen} onKey={onKey} />
            </div>
          </div>
        ) : (
          <div className="ak-scroll">
            <div className="ak-hello">
              <span className="ak-hello-ic"><Icon n="doc" size={24} /></span>
              <h1>{pid ? tr('没有这一页了') : tr('还没有汇报和讲解')}</h1>
              <p>{tr('项目负责人汇报、讲解时，会把内容写成一页 HTML：表格、图、对比和分步的解释。写好的页面都放在这里，也可以全屏演示。')}</p>
              {lead ? <div className="pv-ask"><Request lineId={line.id} toast={toast} big /></div>
                : <p className="ak-mem">{tr('这个项目还没有负责人。')} <a href={href(back)} onClick={e => follow(e, back)}>{tr('在项目页配一个')}</a></p>}
            </div>
          </div>
        )}
      </main>
    </div>,
    document.querySelector('.proto') ?? document.body,
  );
}

// asks the lead for a page, in its conversation
function Request({ lineId, toast, big, onDone }: { lineId: string; toast: (t: string) => void; big?: boolean; onDone?: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  async function send() {
    const q = text.trim();
    if (!q || busy) return;
    setBusy(true);
    try {
      await api.say(`lead-${lineId}`, `请写成一页给我看，用 \`pt publish 页面.html --kind explain\` 发布：\n\n${q}`);
      setText('');
      toast(tr('已经交给负责人，它写好的页面会出现在这里。'));
      onDone?.();
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <form className={`ak-comp${big ? '' : ' mini pv-req'}`} onSubmit={e => { e.preventDefault(); send(); }}>
      <textarea rows={big ? 2 : 3} value={text} maxLength={1000} autoFocus={!big} placeholder={tr('想让负责人讲什么？比如「把这周的实验结果做成一页对比」')}
        onChange={e => setText(e.target.value)}
        onKeyDown={enterSends(send)} />
      <div className="ak-comp-row">
        <span className="small muted">{tr('负责人读完项目写成一页')}</span>
        <button className="ak-send" type="submit" disabled={busy || !text.trim()} aria-label={tr('发给负责人')}><Icon n="send" size={15} /></button>
      </div>
    </form>
  );
}

// on the project's page: its latest pages, each opening on the page above
export function PagesBox({ r, toast }: { r: ProjectCard; toast: (t: string) => void }) {
  const { line } = r;
  const [pages] = usePages(line.id, toast);
  const all = pagesPath(line.seq);
  const latest = [...(pages ?? [])].reverse().slice(0, 4);
  return (
    <section className="psec pj-pages">
      <header className="psec-h">
        <h3><Icon n="doc" size={16} />{tr('汇报与讲解')}</h3>
        <a className="btn" href={href(all)} onClick={e => follow(e, all)}>{pages?.length ? tr('全部 {0} 页', pages.length) : tr('打开')}</a>
      </header>
      {latest.length ? (
        <ul className="pj-recent">
          {latest.map(p => {
            const to = pagesPath(line.seq, p.id);
            return (
              <li key={p.id}><a href={href(to)} onClick={e => follow(e, to)}>
                <span>{p.title}</span><span className="small muted"><i className={`pv-k k-${p.kind}`}>{KIND[p.kind]}</i>{ago(p.at)}{p.by ? ` · ${p.by}` : ''}</span>
              </a></li>
            );
          })}
        </ul>
      ) : pages && <p className="psec-empty muted small">{tr('负责人汇报和讲解时写的 HTML 页面放在这里，可以全屏演示。')}</p>}
    </section>
  );
}
