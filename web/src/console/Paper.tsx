// The paper panel, laid out like Overleaf: the paper's files, the LaTeX source and the compiled
// PDF side by side (one at a time on a phone). Recompiling (Mod-Enter) saves what is unsaved first.

import { useEffect, useRef, useState } from 'react';
import { api, paperPdfUrl, type Compiled, type WsInfo } from '../api';
import { DEMO } from '../demo';
import { tr } from '../i18n';
import { themeVars, useLook } from './edthemes';
import { FileView, Tabs, Tree, useFiles } from './files';
import { Icon } from './icons';
import { usePanelNote } from './page';
import { PHONE, useMedia } from './util';

interface Props {
  lineId: string; info: WsInfo | null; tick: number; toast: (t: string) => void; onDirty: (n: number) => void; onAgents: () => void;
  reveal?: { path: string; line?: number; n: number } | null; // asked from the assistant: open this file, at this line
}

type Layout = 'split' | 'src' | 'pdf';
const SPLIT_KEY = 'pt-tex-split';
const loadSplit = () => { try { const v = Number(localStorage.getItem(SPLIT_KEY)); return v > 0.2 && v < 0.8 ? v : 0.5; } catch { return 0.5; } };

export function Paper(p: Props) {
  if (!p.info) return <div className="cm-wait"><p className="muted">{tr('加载中…')}</p></div>;
  if (!p.info.paper) return (
    <div className="cm-empty">
      <Icon n="doc" size={34} />
      <h3>{tr('这个项目还没有论文')}</h3>
      <p>{p.info.linked ? tr('projects.json 里没有给它配论文目录，或者那个目录不在了。')
        : tr('流水线走到「写作」这一站，印刷厂排出 main.tex 之后，论文就出现在这里。也可以先给它配一个写作员工。')}</p>
      {!p.info.linked && <button className="btn" onClick={p.onAgents}>{tr('去配写作员工')}</button>}
    </div>
  );
  return <Tex {...p} />;
}

// the lines of LaTeX's log worth reading: the errors with the line they point at, and how many warnings
function digest(log: string) {
  const ls = log.split('\n');
  const errs: string[] = [];
  ls.forEach((l, i) => {
    if (l.startsWith('!')) errs.push([l, ...ls.slice(i + 1, i + 4).filter(x => /^l\.\d+/.test(x) || x.trim().startsWith('<'))].join('\n'));
  });
  return { errs: errs.slice(0, 6), warns: ls.filter(l => /Warning/.test(l)).length };
}

function Tex(p: Props) {
  const place = p.info!.paper!;
  const f = useFiles(p.lineId, 'paper', p.tick, p.toast);
  const { theme } = useLook();
  const phone = useMedia(PHONE);
  const [want, setLayout] = useState<Layout>('split');
  const layout: Layout = phone && want === 'split' ? 'pdf' : want;
  const [split, setSplit] = useState(loadSplit);
  const [side, setSide] = useState(!phone);
  const [run, setRun] = useState<Compiled | null>(null);
  const [busy, setBusy] = useState(false);
  const [v, setV] = useState(0);
  const [hasPdf, setHasPdf] = useState(!!place.pdf);
  const [logOpen, setLogOpen] = useState(false);
  const [drag, setDrag] = useState(false);
  const [at, setAt] = useState<{ line: number; picked: string }>({ line: 1, picked: '' });
  const body = useRef<HTMLDivElement>(null);
  const files = f.tree.data?.files ?? [];

  useEffect(() => p.onDirty(f.dirty), [f.dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (p.reveal) { f.show(p.reveal.path); setLayout(l => (phone ? 'src' : l === 'pdf' ? 'split' : l)); } }, [p.reveal?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const goto = p.reveal?.line && f.now?.path === p.reveal.path ? { line: p.reveal.line, n: p.reveal.n } : null;
  useEffect(() => { if (!f.open.length && place.main) f.show(place.main); }, [place.main]); // eslint-disable-line react-hooks/exhaustive-deps

  async function compile() {
    if (DEMO) { p.toast(tr('这是只读的演示，不能编译。')); return; }
    if (busy) return;
    setBusy(true);
    try {
      if (!(await f.save())) return;
      const r = await api.compile(p.lineId);
      setRun(r);
      setLogOpen(!r.ok);
      if (r.ok) { setHasPdf(true); setV(Date.now()); }
    } catch (e) {
      p.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function onDrag(e: React.PointerEvent) {
    const box = body.current?.querySelector('.tex-panes')?.getBoundingClientRect();
    if (!box) return;
    e.preventDefault();
    setDrag(true);
    let last = split;
    const move = (ev: PointerEvent) => { last = Math.max(0.22, Math.min(0.78, (ev.clientX - box.left) / box.width)); setSplit(last); };
    const up = () => {
      setDrag(false);
      try { localStorage.setItem(SPLIT_KEY, String(last)); } catch { /* private mode */ }
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  const d = run && !run.ok ? digest(run.log) : null;
  const url = `${paperPdfUrl(p.lineId, v)}#view=FitH&navpanes=0`;
  const noTex = !p.info!.latexmk && p.info!.linked;
  usePanelNote('paper', 'tex', {
    论文目录: place.path, 主文件: place.main, 打开的文件: f.cur, 光标: f.cur ? `第 ${at.line} 行` : null, 选中的文字: at.picked,
    版面: { src: '只看源码', split: '源码和 PDF 对照', pdf: '只看 PDF' }[layout], 没保存: f.dirty ? `${f.dirty} 个文件` : null,
    这次编译: run ? (run.ok ? `成功，${run.seconds.toFixed(1)} 秒${run.pages ? `，${run.pages} 页` : ''}` : `失败：${d?.errs[0]?.split('\n')[0] ?? ''}`) : null,
  });
  return (
    <div className={`tex l-${layout}${drag ? ' dragging' : ''}`} ref={body}>
      <div className="tex-bar">
        <button className={`ib${side ? ' on' : ''}`} title={tr('文件列表')} onClick={() => setSide(s => !s)}><Icon n="sidebar" size={16} /></button>
        <span className="tex-name"><b>{place.name}</b>{place.git && place.branch && <span className="ide-br"><Icon n="branch" size={12} />{place.branch}</span>}</span>
        <span className="sp" />
        <div className="seg tex-seg" role="tablist">
          <button className={layout === 'src' ? 'on' : ''} onClick={() => setLayout('src')}>{tr('源码')}</button>
          {!phone && <button className={layout === 'split' ? 'on' : ''} onClick={() => setLayout('split')}>{tr('对照')}</button>}
          <button className={layout === 'pdf' ? 'on' : ''} onClick={() => setLayout('pdf')}>PDF</button>
        </div>
        {run && <span className={`tex-run ${run.ok ? 'ok' : 'bad'}`} onClick={() => setLogOpen(o => !o)} title={tr('看编译日志')}>
          {run.ok ? tr('编译完成 · {0} 秒', run.seconds.toFixed(1)) + (run.pages ? tr(' · {0} 页', run.pages) : '') : tr('编译失败 · 看日志')}
        </span>}
        {hasPdf && <a className="ib" href={paperPdfUrl(p.lineId, v)} target="_blank" rel="noreferrer" title={tr('在新标签页打开 PDF')}><Icon n="ext" size={15} /></a>}
        <button className={`btn pri tex-go${busy ? ' busy' : ''}`} disabled={busy || DEMO || noTex} onClick={compile}
          title={noTex ? tr('本机没有 latexmk，装上 TeX 发行版后才能编译') : tr('保存并重新编译（⌘↵）')}>
          <Icon n={busy ? 'refresh' : 'play'} size={14} />{busy ? tr('编译中…') : tr('重新编译')}
        </button>
      </div>
      <div className="tex-body" data-ed={theme.dark ? 'dark' : 'light'} style={themeVars(theme)}>
        {side && phone && <div className="tex-files-back" onClick={() => setSide(false)} />}
        {side && <aside className="tex-files">
          <span className="ide-t">{tr('文件')}</span>
          <Tree files={files} cur={f.cur} dirty={f.dirtySet} root="paper" onOpen={x => {
            if (/\.pdf$/i.test(x)) setLayout('pdf');
            else { f.show(x); if (phone) setLayout('src'); }
            if (phone) setSide(false);
          }} />
        </aside>}
        <div className="tex-panes" style={{ ['--split' as string]: split }}>
          <section className="tex-src">
            <Tabs f={f} />
            <div className="ide-ed">
              <FileView f={f} goto={goto} onRun={compile} onCursor={(line, _c, picked) => setAt({ line, picked })} empty={<div className="fv-note"><Icon n="doc" size={30} /><p className="muted small">{tr('从左边挑一个文件打开。')}</p></div>} />
            </div>
            {run && !run.ok && logOpen && d && (
              <div className="tex-log">
                <div className="diff-h"><b>{tr('LaTeX 报错 · {0} 处 · 警告 {1} 条', d.errs.length, d.warns)}</b>
                  <button className="ib" onClick={() => setLogOpen(false)} aria-label={tr('关闭')}><Icon n="close" size={14} /></button></div>
                {d.errs.map((x, i) => <pre key={i} className="tex-err">{x}</pre>)}
                <details><summary>{tr('完整日志')}</summary><pre>{run.log.slice(-12000)}</pre></details>
              </div>
            )}
          </section>
          <div className="tex-gutter" onPointerDown={onDrag} role="separator" aria-orientation="vertical" title={tr('拖动调整左右宽度')}><i /></div>
          <section className="tex-pdf" data-ref="pdf" data-ref-label={tr('编译出的 PDF')}>
            {hasPdf ? <iframe key={v} src={url} title="PDF" /> : (
              <div className="fv-note"><Icon n="doc" size={30} /><b>{tr('还没有 PDF')}</b><p className="muted small">{tr('点「重新编译」排出第一版。')}</p></div>
            )}
            {busy && <div className="tex-busy"><span />{tr('正在编译…')}</div>}
          </section>
        </div>
      </div>
    </div>
  );
}
