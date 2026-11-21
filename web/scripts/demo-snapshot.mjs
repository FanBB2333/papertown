// Snapshots every GET the static demo makes into dist-demo/demo/<key>.json, plus the papers' files and PDFs.
// Run it against a fresh offline instance, never the one you work in: it compiles the papers there, and it fails
// if personal data is left. Give that instance an empty home and data directory, nothing of yours linked in, and
// TeX on its PATH; let the sample projects run for a few minutes before taking the snapshot.
//
//   HOME=/tmp/pt-demo/home PAPERTOWN_PROVIDER=mock PAPERTOWN_DATA_DIR=/tmp/pt-demo/var PAPERTOWN_NVIDB=0 \
//     PAPERTOWN_PASEO_BIN=/nonexistent PAPERTOWN_PASEO_WATCH=0 PAPERTOWN_PROJECTS=/nonexistent \
//     server/.venv/bin/papertown serve --port 8001
//   PAPERTOWN_DEMO_SOURCE=http://127.0.0.1:8001 pnpm build:demo     (or: node scripts/demo-snapshot.mjs [source] [dist-demo])
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SRC = process.argv[2] ?? process.env.PAPERTOWN_DEMO_SOURCE ?? 'http://127.0.0.1:8001';
const OUT = join(process.argv[3] ?? 'dist-demo', 'demo');
mkdirSync(join(OUT, 'files'), { recursive: true });

// must match demoKey in src/demo.ts
function demoKey(path, query = '') {
  const q = [...new URLSearchParams(query)].filter(([, v]) => v !== '').sort(([a], [b]) => a.localeCompare(b));
  return [path.replace(/^\/api\//, ''), ...q.map(([k, v]) => `${k}=${v}`)].join('_').replace(/[^\w.=-]+/g, '_');
}

const HOME = homedir();
// temp data dir, temp home, this repo and $HOME become ~ paths; other temp paths keep only their name
function scrub(s) {
  return s.replace(/(?:\/private)?\/(?:tmp|var\/folders)\/[^\s"',)]*?\/(var|home)(?=\/|\b)/g, (_, d) => (d === 'var' ? '~/papertown/server/var' : '~'))
    .replace(/(?:\/private)?\/(?:tmp|var\/folders)\/[^\s"',)]*\/([^\s"',)/]+)/g, '$1')
    .split(join(HOME, 'repos', 'papertown')).join('~/papertown')
    .split(HOME).join('~');
}
const clean = v => typeof v === 'string' ? scrub(v)
  : Array.isArray(v) ? v.map(clean)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)])) : v;

const saved = new Map();
async function get(url, key = null) {
  const u = new URL(url, SRC);
  const k = key ?? demoKey(u.pathname, u.search);
  if (saved.has(k)) return saved.get(k);
  const r = await fetch(u);
  if (!r.ok) { console.warn(`skip ${u.pathname}${u.search}: ${r.status}`); saved.set(k, null); return null; }
  const data = clean(await r.json());
  writeFileSync(join(OUT, `${k}.json`), JSON.stringify(data));
  saved.set(k, data);
  return data;
}

const world = await get('/api/world');
const lines = await get('/api/lines');
for (const u of ['/api/messages?limit=120', '/api/trace?limit=80', '/api/papers/fresh', '/api/departments', '/api/skills', '/api/skim', '/api/skim?fresh=1',
  '/api/skim/resolve', '/api/mcp', '/api/rag', '/api/gpus', '/api/gpus?fresh=1', '/api/paseo', '/api/paseo/conversations', '/api/llm',
  '/api/agents?role=coder', '/api/agents?role=writer', '/api/agents?role=monitor', '/api/agents?role=lead', '/api/agents?role=',
  '/api/agents/overview', '/api/cards', '/api/paseo/news', '/api/reports', '/api/bounds', '/api/assistant']) await get(u);
await get('/api/library?limit=5000', 'library_all');

for (const pl of world.placements) { await get(`/api/buildings/${pl.id}`); await get(`/api/buildings/${pl.type}`); }

const board = await get('/api/jobs');
const jobs = new Set((board?.jobs ?? []).map(j => j.id));
const agents = new Map();
for (const ln of lines) {
  await get(`/api/lines/${ln.id}`);
  await get(`/api/lines/${ln.id}/papers`);
  await get(`/api/skim/resolve?line_id=${ln.id}`);
  // the project page, its research loop and what hangs off them
  for (const part of ['card', 'canvas', 'canvas/report', 'pages', 'lead', 'memory']) await get(`/api/lines/${ln.id}/${part}`);
  await get(`/api/reports?line_id=${ln.id}`);
  await get(`/api/bounds?line_id=${ln.id}`);
  for (const j of (await get(`/api/jobs?line_id=${ln.id}`))?.jobs ?? []) jobs.add(j.id);
  for (const name of ln.files ?? []) {
    const r = await fetch(`${SRC}/api/lines/${ln.id}/files/${name}`);
    if (!r.ok) continue;
    mkdirSync(join(OUT, 'files', ln.id), { recursive: true });
    const buf = Buffer.from(await r.arrayBuffer());
    writeFileSync(join(OUT, 'files', ln.id, name), /\.(tex|bib)$/.test(name) ? scrub(buf.toString('utf8')) : buf);
  }
}
const TEXT = /\.(tex|bib|sty|cls|bst|md|txt|py|ts|js|json|jsonl|ya?ml|toml|cfg|sh|csv|tsv)$/i;
for (const ln of lines) {
  let ws = await get(`/api/lines/${ln.id}/ws`);
  if (ws?.paper && !ws.paper.pdf && ws.latexmk) { // compile it there, so the paper panel has its PDF
    await fetch(`${SRC}/api/lines/${ln.id}/ws/paper/compile`, { method: 'POST' });
    saved.delete(demoKey(`/api/lines/${ln.id}/ws`));
    ws = await get(`/api/lines/${ln.id}/ws`);
  }
  if (ws?.paper?.pdf) { // the PDF the paper panel shows beside the source
    const r = await fetch(`${SRC}/api/lines/${ln.id}/ws/paper/pdf`);
    if (r.ok) { mkdirSync(join(OUT, 'files', ln.id), { recursive: true }); writeFileSync(join(OUT, 'files', ln.id, 'main.pdf'), Buffer.from(await r.arrayBuffer())); }
  }
  const data = await get(`/api/lines/${ln.id}/data`);
  const want = new Map();
  for (const root of ['code', 'paper']) {
    if (!ws?.[root]) continue;
    const tree = await get(`/api/lines/${ln.id}/ws/${root}/tree`);
    for (const f of (tree?.files ?? []).filter(f => TEXT.test(f.path) && f.size < 256 * 1024).slice(0, 120)) want.set(`${root}:${f.path}`, [root, f.path]);
  }
  for (const f of (data?.files ?? []).filter(f => f.size < 256 * 1024).slice(0, 40)) want.set(`code:${f.path}`, ['code', f.path]);
  for (const [root, path] of want.values()) await get(`/api/lines/${ln.id}/ws/${root}/file?${new URLSearchParams({ path })}`);
}
for (const id of jobs) await get(`/api/jobs/${id}?tail=400`);
for (const role of ['coder', 'writer', 'monitor', 'lead']) {
  for (const row of saved.get(demoKey('/api/agents', `?role=${role}`))?.roster ?? []) if (row.agent) agents.set(row.agent.id, row.agent);
}
for (const g of saved.get(demoKey('/api/agents/overview'))?.groups ?? []) for (const a of g.agents) agents.set(a.id, a);
for (const a of agents.values()) {
  await get(`/api/agents/${a.id}?after=0`);
  await get(`/api/agents/${a.id}/timeline`);
  await get(`/api/agents/${a.id}/conversations`);
  await get(`/api/skim/resolve?line_id=${a.line_id}&agent_id=${a.id}`);
}

const LEAKS = [/\/Users\/\w/, /\/home\/\w/, /\/private\/|\/var\/folders\//, new RegExp(HOME.split('/').pop()), /\b100\.\d+\.\d+\.\d+\b/,
  /\b192\.168\.\d+\.\d+\b/, /tailscale/i, /@(gmail|qq|163|outlook)\./i];
const found = [];
for (const [k, v] of saved) {
  if (!v) continue;
  const text = JSON.stringify(v);
  for (const re of LEAKS) { const m = text.match(re); if (m) found.push(`${k}: ${m[0]} …${text.slice(Math.max(0, m.index - 40), m.index + 40)}…`); }
}
console.log(`${[...saved.values()].filter(Boolean).length} snapshots in ${OUT}`);
if (found.length) { console.error('possible personal data:\n' + found.join('\n')); process.exit(1); }
