// What the static demo adds to the page: a card on the first visit that says what Papertown
// is and where to look, and a link to the repository in the top bar.

import { useState } from 'react';
import { REPO } from '../demo';
import { tr } from '../i18n';
import '../demo.css';

const SEEN = 'papertown.demo-seen-2'; // a new key when the card says something new, so it shows again

function seen() {
  try { return localStorage.getItem(SEEN) === '1'; } catch { return false; }
}

export function RepoLink() {
  return <a className="btn demo-gh" href={REPO} target="_blank" rel="noreferrer"><GitHubMark />{tr('在 GitHub 上查看')}</a>;
}

export function DemoWelcome() {
  const [open, setOpen] = useState(() => !seen());
  if (!open) return null;
  const close = () => {
    try { localStorage.setItem(SEEN, '1'); } catch { /* shown again next time */ }
    setOpen(false);
  };
  return (
    <div className="demo-veil" role="dialog" aria-modal="true" onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="demo-card pnl">
        <h2>{tr('欢迎来到 Papertown')}</h2>
        <p>{tr('一个开源的科研流水线：idea 经过查重、立项、方法设计、实验、写作和审稿，最后成为一篇论文。每个项目走同一套研究流程，agent 员工做事，你在关键处监督、纠错和拍板。')}</p>
        <p className="muted">{tr('这是只读的静态演示，内容来自一次离线运行的快照，五个示例项目停在不同的阶段。这里的改动不会保存。')}</p>
        <ul>
          <li>{tr('「进展」里每个项目一张卡片，点开项目页，再进入「研究回路」')}</li>
          <li>{tr('研究回路按研究流程排成四行分块，按住 ⌘ 或 Ctrl 滚动缩放，点节点在右侧看详情')}</li>
          <li>{tr('「小镇 › 中控屏」里是每个项目的调研、代码、实验、数据、论文和员工，也可以切到平面地图或 3D 漫游')}</li>
          <li>{tr('在设置里切换 English / 简体 / 繁體')}</li>
        </ul>
        <div className="btns">
          <a className="btn pri" href={REPO} target="_blank" rel="noreferrer"><GitHubMark />{tr('去 GitHub 看源码')}</a>
          <button className="btn" onClick={close}>{tr('先逛逛')}</button>
        </div>
      </div>
    </div>
  );
}

function GitHubMark() {
  return (
    <svg className="gh-mark" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
