// What the static demo adds to the town: a card on the first visit that says what Papertown
// is and what can be tried here, and a link to the repository in the top bar.

import { useState } from 'react';
import { REPO } from '../demo';
import { tr } from '../i18n';
import '../demo.css';

const SEEN = 'papertown.demo-seen';

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
        <p>{tr('一个把 AI 科研流水线画成手绘小镇的开源项目：idea 在孵化场查重，在造纸厂立项，在实验农场跑实验，在印刷厂写成论文，经过质检所后出厂。')}</p>
        <p className="muted">{tr('这是静态演示，内容来自一次离线运行的快照。可以随便走走、进建筑看看，这里的改动不会保存。')}</p>
        <ul>
          <li>{tr('用 WASD 走动，到门口按 F，或者直接点建筑')}</li>
          <li>{tr('点顶栏的「3D 漫游」：空格跳，双击空格飞起来，按 F 走进建筑看里面的机器')}</li>
          <li>{tr('进图书馆试一下检索；在设置里切换 English / 简体 / 繁體')}</li>
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
