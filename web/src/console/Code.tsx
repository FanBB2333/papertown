// The code panel, laid out like VS Code: the repository's files with git's marks, tabs, the
// editor and a status bar; Mod-S writes back into the repository. On a phone, files and editor take turns.

import { useEffect, useState } from 'react';
import { api, type WsInfo } from '../api';
import { DEMO } from '../demo';
import { tr } from '../i18n';
import { themeVars, useLook } from './edthemes';
import { FileView, Tabs, Tree, langOf, useFiles } from './files';
import { Icon } from './icons';
import { usePanelNote } from './page';
import { PHONE, useMedia } from './util';

interface Props {
  lineId: string; info: WsInfo | null; tick: number; toast: (t: string) => void; onDirty: (n: number) => void; onAgents: () => void;
  reveal?: { path: string; line?: number; n: number } | null; // asked from another panel or the assistant: open this file
}

export function Code(p: Props) {
  const place = p.info?.code;
  if (!p.info) return <div className="cm-wait"><p className="muted">{tr('加载中…')}</p></div>;
  if (!place) return (
    <div className="cm-empty">
      <Icon n="code" size={34} />
      <h3>{tr('这个项目还没有代码仓库')}</h3>
      <p>{p.info.linked ? tr('projects.json 里没有给它配代码目录，或者那个目录不在了。')
        : tr('idea 项目的代码由代码员工来写：项目负责人启动它之后，代码会出现在这里。')}</p>
      {!p.info.linked && <button className="btn" onClick={p.onAgents}>{tr('去配代码员工')}</button>}
    </div>
  );
  return <Repo {...p} />;
}

function Repo(p: Props) {
  const place = p.info!.code!;
  const f = useFiles(p.lineId, 'code', p.tick, p.toast);
  const { theme } = useLook();
  const [q, setQ] = useState('');
  const [pos, setPos] = useState<[number, number]>([1, 1]);
  const [picked, setPicked] = useState('');
  const [diff, setDiff] = useState<{ path: string; text: string } | null>(null);
  const phone = useMedia(PHONE);
  const [browse, setBrowse] = useState(false);
  const files = f.tree.data?.files ?? [];
  const changed = files.filter(x => x.status);

  useEffect(() => p.onDirty(f.dirty), [f.dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (f.open.length || !files.length) return;
    const readme = files.find(x => /^readme(\.md|\.txt|\.rst)?$/i.test(x.path)) ?? files.find(x => /(^|\/)readme\.md$/i.test(x.path));
    if (readme) f.show(readme.path);
  }, [files.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setDiff(null), [f.cur]);
  useEffect(() => { if (p.reveal) f.show(p.reveal.path); }, [p.reveal?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  const cur = f.now;
  const open = (path: string) => { f.show(path); setBrowse(false); };
  const st = cur ? f.status.get(cur.path) : undefined;
  const goto = p.reveal?.line && cur?.path === p.reveal.path ? { line: p.reveal.line, n: p.reveal.n } : null;
  usePanelNote('code', 'file', {
    仓库: place.path, 打开的文件: cur?.path, 光标: cur ? `第 ${pos[0]} 行第 ${pos[1]} 列` : null, 选中的文字: picked,
    其他打开的文件: f.open.filter(o => o.path !== cur?.path).map(o => o.path).join('、'), 没保存: f.dirty ? `${f.dirty} 个文件` : null,
  });
  const showDiff = () => {
    if (!cur) return;
    if (diff) { setDiff(null); return; }
    api.wsDiff(p.lineId, 'code', cur.path).then(d => setDiff({ path: d.path, text: d.diff || tr('（和 git 里的一样）') })).catch(e => p.toast((e as Error).message));
  };

  return (
    <div className={`ide${phone && (browse || !cur) ? ' browse' : ''}`} data-ed={theme.dark ? 'dark' : 'light'} style={themeVars(theme)}>
      <aside className="ide-side">
        <div className="ide-sh">
          <span className="ide-t">{tr('资源管理器')}</span>
          <button className="ib" title={tr('从磁盘重新读取')} onClick={f.reread}><Icon n="refresh" size={15} /></button>
        </div>
        <div className="ide-repo">
          <b title={place.path}>{place.name}</b>
          {place.git && <span className="ide-br"><Icon n="branch" size={13} />{place.branch ?? 'HEAD'}</span>}
        </div>
        <input className="ide-filter" placeholder={tr('筛选文件')} value={q} onChange={e => setQ(e.target.value)} />
        {f.tree.err && <p className="warn-box small">{f.tree.err}</p>}
        {changed.length > 0 && !q && (
          <div className="ide-changes">
            <span className="ide-t">{tr('改动 · {0}', changed.length)}</span>
            {changed.slice(0, 6).map(x => (
              <button key={x.path} className={`ide-ch st-${x.status}`} onClick={() => open(x.path)} title={x.path}>
                <span>{x.path}</span><em>{x.status?.[0].toUpperCase()}</em>
              </button>
            ))}
            {changed.length > 6 && <span className="muted small">{tr('还有 {0} 个', changed.length - 6)}</span>}
          </div>
        )}
        <Tree files={files} cur={f.cur} onOpen={open} dirty={f.dirtySet} filter={q} root="code" />
        {f.tree.data?.truncated && <p className="muted small tr-none">{tr('文件太多，只列出前 4000 个。')}</p>}
      </aside>
      <section className="ide-main">
        <Tabs f={f} lead={phone && <button className="ib ide-files" onClick={() => setBrowse(true)}><Icon n="folder" size={16} />{tr('文件')}</button>} extra={cur && <>
          {st && st !== 'untracked' && <button className={`ib${diff ? ' on' : ''}`} title={tr('和 git 里的版本对比')} onClick={showDiff}><Icon n="diff" size={15} /></button>}
          {!DEMO && <button className="ib" title={tr('保存（⌘S）')} disabled={!f.dirtySet.has(cur.path) || f.saving} onClick={() => f.save(cur.path)}><Icon n="save" size={15} /></button>}
        </>} />
        <div className="ide-ed">
          <FileView f={f} goto={goto} onCursor={(l, c, s) => { setPos([l, c]); setPicked(s); }} empty={
            <div className="fv-note"><Icon n="code" size={30} /><b>{place.name}</b><p className="muted small">{tr('从左边挑一个文件打开。⌘S 保存，改动直接写回仓库。')}</p></div>} />
          {diff && <Diff text={diff.text} onClose={() => setDiff(null)} />}
        </div>
        <footer className="ide-status">
          {place.git && <span><Icon n="branch" size={12} />{place.branch ?? 'HEAD'}</span>}
          <span>{tr('{0} 处改动', changed.length)}</span>
          {f.dirty > 0 && <span className="warn-t">{tr('{0} 个未保存', f.dirty)}</span>}
          {DEMO && <span>{tr('只读')}</span>}
          <span className="sp" />
          {cur && <><span>{tr('行 {0}，列 {1}', pos[0], pos[1])}</span><span>{langOf(cur.path)}</span><span>UTF-8</span></>}
        </footer>
      </section>
    </div>
  );
}

function Diff({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div className="diff">
      <div className="diff-h"><b>{tr('和 git 里的版本对比')}</b><button className="ib" onClick={onClose} aria-label={tr('关闭')}><Icon n="close" size={14} /></button></div>
      <pre>{text.split('\n').map((l, i) => (
        <span key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : ''}>{l}{'\n'}</span>
      ))}</pre>
    </div>
  );
}
