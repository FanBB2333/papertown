// The static demo (`pnpm build:demo`): GETs are answered from the demo/*.json snapshot beside the
// page, the library and retrieval search run in the browser, and every write is refused.
import type { PaperCard, RagResult, Shelf } from './api';
import { tr } from './i18n';

export const DEMO = import.meta.env.VITE_DEMO === '1';
export const REPO = 'https://github.com/FanBB2333/papertown';

// "/api/jobs?line_id=line_1" -> "jobs_line_id=line_1"; must match scripts/demo-snapshot.mjs
function demoKey(path: string, query = '') {
  const q = [...new URLSearchParams(query)].filter(([, v]) => v !== '').sort(([a], [b]) => a.localeCompare(b));
  return [path.replace(/^\/api\//, ''), ...q.map(([k, v]) => `${k}=${v}`)].join('_').replace(/[^\w.=-]+/g, '_');
}

export const demoFile = (lineId: string, name: string) => `demo/files/${lineId}/${name}`;

const cache = new Map<string, Promise<unknown>>();
function load(key: string): Promise<unknown> {
  if (!cache.has(key)) {
    cache.set(key, fetch(`demo/${key}.json`).then(r => (r.ok ? r.json() : Promise.reject(new Error(tr('演示里没有这部分数据'))))));
  }
  return cache.get(key)!.then(v => structuredClone(v));
}

const terms = (q: string) => q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t.length > 1);
const coverage = (p: PaperCard, ts: string[]) => {
  const text = `${p.title} ${p.snippet} ${p.tags.join(' ')}`.toLowerCase();
  const hit = ts.filter(t => text.includes(t));
  return { hit, score: ts.length ? hit.length / ts.length : 0 };
};

async function library(q: string, topic: string, limit: number): Promise<Shelf> {
  const all = await load('library_all') as Shelf;
  const ts = terms(q);
  const papers = all.papers.map(p => ({ p, score: coverage(p, ts).score }))
    .filter(x => (!topic || x.p.topic === topic) && (!ts.length || x.score > 0))
    .sort((a, b) => b.score - a.score).slice(0, limit).map(x => x.p);
  return { ...all, papers };
}

// keyword coverage, the way the server ranks without vectors
async function ragSearch(q: string, k: number): Promise<RagResult> {
  const all = await load('library_all') as Shelf;
  const ts = terms(q);
  const hits = all.papers.map(p => ({ p, ...coverage(p, ts) })).filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score).slice(0, k)
    .map(x => ({ ...x.p, similarity: x.score, matched: x.hit }));
  return { query: q, expanded: q, terms: ts, method: 'coverage', hits };
}

// Migrate snapshots at the demo boundary only. Old fictional crews never become real agents.
function normalizeDemo(value: unknown): any {
  if (Array.isArray(value)) return value.map(normalizeDemo);
  if (!value || typeof value !== 'object') return value;
  const v = Object.fromEntries(Object.entries(value).map(([k, x]) => [k, normalizeDemo(x)]));
  const off = (ended = false) => ({ on: false, state: ended ? 'ended' : 'off', note: null, agent: null, runtime: null, status: null });
  const stageStatus = (s: string) => s === 'fail' ? 'run' : s === 'wait' ? 'todo' : s;
  if (v.key && 'pct' in v && 'building' in v) {
    v.status = stageStatus(v.status);
    v.owner ??= v.key === 'write' ? 'writer' : v.key === 'exp' ? 'coder' : 'lead';
    v.agents ??= [];
    v.started_at ??= null; v.ended_at ??= null;
    delete v.workers;
  }
  if (v.kind === 'stage') v.status = stageStatus(v.status);
  if ('id' in v && 'seq' in v && 'status' in v) {
    if (['hatching', 'waiting', 'paused', 'failed'].includes(v.status)) v.status = 'running';
    if (Array.isArray(v.stages)) {
      v.lead ??= off(['done', 'dropped'].includes(v.status));
      v.sample ??= true;
      v.stages = v.stages.map((s: any) => ({ ...s, status: stageStatus(s.status) }));
      if (v.stage && typeof v.stage === 'object') v.stage.status = stageStatus(v.stage.status);
      if ('team' in v && !Array.isArray(v.team)) v.team = [];
    }
  }
  if ('settings' in v && 'reports' in v && 'asks' in v) {
    v.resident ??= off();
    v.settings.on ??= v.resident.on;
  }
  if ('day' in v && 'lines' in v) {
    v.leads ??= { on: 0, running: 0 };
    delete v.lines.waiting;
  }
  if (v.defaults && 'assistant' in v.defaults && 'lead' in v.defaults) v.defaults.worker ??= { ...v.defaults.lead };
  return v;
}

export async function demoCall(method: string, url: string): Promise<unknown> {
  if (method !== 'GET') throw new Error(tr('这是只读的演示：要让小镇真的跑起来，请到 GitHub 上克隆 Papertown，在本机启动。'));
  const u = new URL(url, location.href);
  const p = u.searchParams;
  if (u.pathname === '/api/library') return library(p.get('q') ?? '', p.get('topic') ?? '', Number(p.get('limit') ?? 60));
  if (u.pathname === '/api/rag/search') return ragSearch(p.get('q') ?? '', Number(p.get('k') ?? 8));
  return normalizeDemo(await load(demoKey(u.pathname, u.search)).catch(() => load(demoKey(u.pathname))));
}
