// The icons beside a file's or a folder's name, in the icon theme chosen (edthemes.ts): a dot of
// the file kind's colour, the kind's short name in that colour (like Seti), a solid badge with
// coloured folders (like the Material icon themes), or nothing at all.

import type { IconTheme } from './edthemes';

interface Kind { c: string; t: string } // colour, short name

const EXT: Record<string, Kind> = {
  py: { c: '#3572a5', t: 'py' }, pyi: { c: '#3572a5', t: 'pyi' }, ipynb: { c: '#e46e2e', t: 'nb' },
  js: { c: '#c9a41a', t: 'js' }, mjs: { c: '#c9a41a', t: 'js' }, cjs: { c: '#c9a41a', t: 'js' }, jsx: { c: '#c9a41a', t: 'jsx' },
  ts: { c: '#2f74c0', t: 'ts' }, mts: { c: '#2f74c0', t: 'ts' }, tsx: { c: '#2f74c0', t: 'tsx' },
  json: { c: '#a0782a', t: '{}' }, jsonl: { c: '#a0782a', t: '{}' },
  md: { c: '#4b7bb0', t: 'M↓' }, markdown: { c: '#4b7bb0', t: 'M↓' }, rst: { c: '#4b7bb0', t: 'rst' }, txt: { c: '#8a8a8a', t: '≡' }, log: { c: '#8a8a8a', t: 'log' },
  tex: { c: '#3d8b80', t: 'TeX' }, sty: { c: '#3d8b80', t: 'sty' }, cls: { c: '#3d8b80', t: 'cls' }, bib: { c: '#7a9b3c', t: 'bib' }, bst: { c: '#7a9b3c', t: 'bst' },
  yaml: { c: '#b0413e', t: 'yml' }, yml: { c: '#b0413e', t: 'yml' }, toml: { c: '#9c4221', t: 'tml' }, ini: { c: '#6d8086', t: 'ini' }, cfg: { c: '#6d8086', t: 'cfg' },
  sh: { c: '#4e9a06', t: '$_' }, bash: { c: '#4e9a06', t: '$_' }, zsh: { c: '#4e9a06', t: '$_' },
  c: { c: '#555fbf', t: 'C' }, h: { c: '#7a5fbf', t: 'h' }, cc: { c: '#00599c', t: 'C++' }, cpp: { c: '#00599c', t: 'C++' }, cxx: { c: '#00599c', t: 'C++' }, hpp: { c: '#7a5fbf', t: 'h++' },
  cu: { c: '#5b8f1f', t: 'cu' }, cuh: { c: '#5b8f1f', t: 'cu' }, rs: { c: '#b7410e', t: 'rs' }, go: { c: '#00a3c4', t: 'go' }, java: { c: '#b07219', t: 'jv' },
  html: { c: '#e44d26', t: '<>' }, htm: { c: '#e44d26', t: '<>' }, css: { c: '#563d7c', t: '#' }, scss: { c: '#c6538c', t: '#' },
  csv: { c: '#2f8f5b', t: 'csv' }, tsv: { c: '#2f8f5b', t: 'tsv' }, parquet: { c: '#2f8f5b', t: 'pq' },
  pdf: { c: '#c4362b', t: 'pdf' }, png: { c: '#a2569b', t: 'img' }, jpg: { c: '#a2569b', t: 'img' }, jpeg: { c: '#a2569b', t: 'img' },
  gif: { c: '#a2569b', t: 'img' }, svg: { c: '#d9822b', t: 'svg' }, webp: { c: '#a2569b', t: 'img' }, eps: { c: '#a2569b', t: 'eps' },
  zip: { c: '#8d6e4f', t: 'zip' }, gz: { c: '#8d6e4f', t: 'gz' }, tar: { c: '#8d6e4f', t: 'tar' },
  pt: { c: '#ee4c2c', t: 'pt' }, pth: { c: '#ee4c2c', t: 'pt' }, ckpt: { c: '#7c6f64', t: 'ck' }, safetensors: { c: '#7c6f64', t: 'st' },
  npy: { c: '#4d77cf', t: 'np' }, npz: { c: '#4d77cf', t: 'np' }, h5: { c: '#7c6f64', t: 'h5' }, pkl: { c: '#7c6f64', t: 'pk' },
  lock: { c: '#8a8a8a', t: 'lck' }, env: { c: '#c9a41a', t: 'env' },
};

const NAME: Record<string, Kind> = {
  'readme.md': { c: '#2f74c0', t: 'i' }, readme: { c: '#2f74c0', t: 'i' }, license: { c: '#b8952d', t: '§' }, 'license.md': { c: '#b8952d', t: '§' },
  makefile: { c: '#6d8086', t: 'mk' }, dockerfile: { c: '#2496ed', t: 'dk' }, '.gitignore': { c: '#e5533b', t: 'git' }, '.gitattributes': { c: '#e5533b', t: 'git' },
  '.gitmodules': { c: '#e5533b', t: 'git' }, 'requirements.txt': { c: '#3572a5', t: 'req' }, 'pyproject.toml': { c: '#3572a5', t: 'py' },
  'setup.py': { c: '#3572a5', t: 'py' }, 'package.json': { c: '#cb3837', t: 'npm' }, '.env': { c: '#c9a41a', t: 'env' }, 'agents.md': { c: '#c2663f', t: 'AI' },
  'claude.md': { c: '#c2663f', t: 'AI' }, 'main.tex': { c: '#2e7472', t: 'TeX' },
};

const FOLDER: Record<string, string> = {
  src: '#3b82c4', lib: '#3b82c4', app: '#3b82c4', tests: '#3f9c5a', test: '#3f9c5a', docs: '#2e8f9a', doc: '#2e8f9a', data: '#c48a2a', datasets: '#c48a2a',
  scripts: '#7c8794', tools: '#7c8794', bin: '#7c8794', configs: '#8a5fbf', config: '#8a5fbf', conf: '#8a5fbf', figures: '#c25a8a', figs: '#c25a8a',
  images: '#c25a8a', img: '#c25a8a', assets: '#c25a8a', paper: '#3d8b80', tex: '#3d8b80', latex: '#3d8b80', sections: '#3d8b80', notebooks: '#e46e2e',
  models: '#7c6f64', checkpoints: '#7c6f64', results: '#b0723a', outputs: '#b0723a', logs: '#b0723a', runs: '#b0723a', experiments: '#b0413e',
  '.github': '#6b6b6b', '.papertown': '#c2663f', node_modules: '#8a8a8a', '.venv': '#8a8a8a', venv: '#8a8a8a',
};

const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const ext = (p: string) => { const b = base(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1).toLowerCase() : ''; };
export const kindOf = (path: string): Kind => NAME[base(path).toLowerCase()] ?? EXT[ext(path)] ?? { c: '#a3927b', t: '' };
export const kindColor = (path: string) => kindOf(path).c;

export function FileIcon({ path, theme }: { path: string; theme: IconTheme }) {
  if (theme === 'none') return null;
  const k = kindOf(path);
  if (theme === 'dots') return <i className="fi fi-dot" style={{ background: k.c }} />;
  if (theme === 'glyphs') return <i className="fi fi-glyph" style={{ ['--ic' as string]: k.c }}>{k.t || '·'}</i>;
  const n = k.t.length;
  return (
    <svg className="fi fi-badge" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" style={{ ['--ic' as string]: k.c }}>
      <path d="M3.5 1.5h6l3.5 3.5v9a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5v-12a.5.5 0 0 1 .5-.5z" />
      <path className="fold" d="M9.5 1.5v3.5h3.5" />
      {k.t && <text x="8" y="12.2" textAnchor="middle" fontSize={n > 2 ? 4.6 : n > 1 ? 5.4 : 6.4}>{k.t}</text>}
    </svg>
  );
}

export function FolderIcon({ name, open, theme }: { name: string; open: boolean; theme: IconTheme }) {
  if (theme !== 'badges') return null;
  const c = FOLDER[name.toLowerCase()] ?? '#c09a5b';
  return (
    <svg className="fi fi-folder" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" style={{ ['--ic' as string]: c }}>
      {open
        ? <><path d="M1.5 4a1 1 0 0 1 1-1h3.6l1.4 1.5h5.5a1 1 0 0 1 1 1v1h-10l-2.5 6.5z" /><path className="lid" d="M3.6 6.5h11.4l-2.4 6.6a.6.6 0 0 1-.6.4H1.5z" /></>
        : <><path d="M1.5 4a1 1 0 0 1 1-1h3.6l1.4 1.5h5.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1z" /><path className="lid" d="M1.5 6.2h13v6.8a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" /></>}
    </svg>
  );
}
