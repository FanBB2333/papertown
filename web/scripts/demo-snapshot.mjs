// Takes the static demo's data from a running Papertown: every GET the page makes, saved as
// dist-demo/demo/<key>.json (see demoKey in src/demo.ts), plus the shipped papers' files.
// Point it at a fresh offline instance of its own, never at the one you work in:
//
//   PAPERTOWN_PROVIDER=mock PAPERTOWN_DATA_DIR=/tmp/pt-demo PAPERTOWN_NVIDB=0 … papertown serve --port 8001
//   node scripts/demo-snapshot.mjs [http://127.0.0.1:8001] [dist-demo]
//
// Absolute paths are cut down to ~ before saving, and the run fails if anything that looks
// like a home directory, a private address or a temp path is left.
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SRC = process.argv[2] ?? process.env.PAPERTOWN_DEMO_SOURCE ?? 'http://127.0.0.1:8001';
const OUT = join(process.argv[3] ?? 'dist-demo', 'demo');
mkdirSync(join(OUT, 'files'), { recursive: true });

// the same key as src/demo.ts
function demoKey(path, query = '') {
  const q = [...new URLSearchParams(query)].filter(([, v]) => v !== '').sort(([a], [b]) => a.localeCompare(b));
  return [path.replace(/^\/api\//, ''), ...q.map(([k, v]) => `${k}=${v}`)].join('_').replace(/[^\w.=-]+/g, '_');
}

const HOME = homedir();
function scrub(s) {
  // the instance's own temp directories: its data directory and the home its skim ran in
  return s.replace(/(?:\/private)?\/(?:tmp|var\/folders)\/[^\s"',)]*?\/(var|home)(?=\/|\b)/g, (_, d) => (d === 'var' ? '~/papertown/server/var' : '~'))
    .replace(/(?:\/private)?\/(?:tmp|var\/folders)\/[^\s"',)]*\/([^\s"',)/]+)/g, '$1') // anything else there: its name
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
for (const u of ['/api/messages?limit=120', '/api/trace?limit=80', '/api/status', '/api/skills', '/api/skim', '/api/skim?fresh=1',
  '/api/skim/resolve', '/api/mcp', '/api/rag', '/api/gpus', '/api/gpus?fresh=1', '/api/paseo', '/api/paseo/conversations', '/api/llm',
  '/api/agents?role=coder', '/api/agents?role=writer', '/api/agents?role=monitor']) await get(u);
await get('/api/library?limit=5000', 'library_all');

for (const pl of world.placements) { await get(`/api/buildings/${pl.id}`); await get(`/api/buildings/${pl.type}`); }

const board = await get('/api/jobs');
const jobs = new Set((board?.jobs ?? []).map(j => j.id));
const agents = new Map();
for (const ln of lines) {
  await get(`/api/lines/${ln.id}`);
  await get(`/api/lines/${ln.id}/papers`);
  await get(`/api/skim/resolve?line_id=${ln.id}`);
  for (const j of (await get(`/api/jobs?line_id=${ln.id}`))?.jobs ?? []) jobs.add(j.id);
  for (const name of ln.files ?? []) {
    const r = await fetch(`${SRC}/api/lines/${ln.id}/files/${name}`);
    if (!r.ok) continue;
    mkdirSync(join(OUT, 'files', ln.id), { recursive: true });
    const buf = Buffer.from(await r.arrayBuffer());
    writeFileSync(join(OUT, 'files', ln.id, name), /\.(tex|bib)$/.test(name) ? scrub(buf.toString('utf8')) : buf);
  }
}
for (const id of jobs) await get(`/api/jobs/${id}?tail=400`);
for (const role of ['coder', 'writer', 'monitor']) {
  for (const row of saved.get(demoKey('/api/agents', `?role=${role}`))?.roster ?? []) if (row.agent) agents.set(row.agent.id, row.agent);
}
for (const a of agents.values()) {
  await get(`/api/agents/${a.id}?after=0`);
  await get(`/api/agents/${a.id}/timeline`);
  await get(`/api/skim/resolve?line_id=${a.line_id}&agent_id=${a.id}`);
}

// nothing personal may be left: home directories, user names, private addresses, temp paths
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
