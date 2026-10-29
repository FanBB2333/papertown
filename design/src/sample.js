// Sample data for the open-source depot district. None of these repos exist; replace
// this list with real repositories (e.g. from the GitHub API) once data is connected.
// Ids stay fixed so the map and links don't change when the data does.
//
// to: buildings that take code from this repo

export const SAMPLE_REPOS = [
  { id: 'depot_a', label: 'sg-kit', repo: 'sample-lab/sg-kit', accent: '#4f8a3d',
    desc: '场景图构建与增量更新的工具包', lang: 'Python', stars: 128, issues: 3, prs: 1, release: 'v0.3.1', updated: '2 天前',
    to: ['farm', 'mill'] },
  { id: 'depot_b', label: 'vla-bench', repo: 'sample-lab/vla-bench', accent: '#7a5aa6',
    desc: '长程操作任务的评测脚本和 baseline', lang: 'Python', stars: 342, issues: 7, prs: 2, release: 'v1.2.0', updated: '今天',
    to: ['farm'] },
  { id: 'depot_c', label: 'paper-tpl', repo: 'sample-lab/paper-tpl', accent: '#2f8f9d',
    desc: '会议投稿用的 LaTeX 模板和画图脚本', lang: 'TeX', stars: 56, issues: 1, prs: 0, release: 'v2.0', updated: '1 周前',
    to: ['press'] },
];
