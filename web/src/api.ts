// REST calls and the live event stream from the Papertown server.

import { localize, tr, trx } from './i18n';

export interface Placement {
  id: string; type: string; x: number; y: number; name: string; label: string | null; accent: string | null;
  line_id: string | null; status: string; core: boolean; key: boolean; live: boolean; tech: string;
}

export interface Hud {
  day: number;
  bank: { week: number; budget: number; calls: number };
  plant: { load: number; busy: number; gpus: number; queued: number; name: string };
  lines: { running: number; waiting: number; total: number };
  library: number; provider: string; offline: boolean; model: string;
}

export interface RunningLine { id: string; seq: number; title: string; status: string; stage: string; building: string; pct: number; mill_id: string | null }

export interface WorldState { placements: Placement[]; running: RunningLine[]; hud: Hud }

export interface WorkerRef { id: string; role: string; level: number; title?: string }

export interface Stage {
  key: string; name: string; status: 'todo' | 'run' | 'done' | 'wait'; pct: number; building: string; out: string;
  note: string | null; workers: WorkerRef[];
}

export interface Line {
  id: string; seq: number; title: string; idea: string; budget: number; spent: number; status: string; stage: string;
  mill_id: string | null; verdict: string | null; revisions: number; note: string | null; pct: number;
  current: Stage | null; stages: Stage[]; team: Record<string, string[]>; reason: string | null; files: string[];
  outputs?: Record<string, any>;
  linked?: Linked | null; // a project linked in from local repositories (status 'linked')
}

export interface Commit { hash: string; when: string; author: string; subject: string }
export interface LinkedCode {
  path: string; name: string; missing?: boolean; branch?: string; remote?: string | null; commits?: Commit[]; dirty?: number;
  files?: number; langs?: { ext: string; n: number }[]; dirs?: string[]; title?: string | null; readme?: string;
}
export interface LinkedPaper {
  path: string; name: string; missing?: boolean; main?: string | null; title?: string | null; abstract?: string; sections?: string[];
  figures?: number; tables?: number; words?: number; bib?: number; pdf?: boolean; pdf_at?: string | null; commits?: Commit[]; dirty?: number;
}
export interface Linked { key: string; match: string[]; code: LinkedCode | null; paper: LinkedPaper | null }

export interface Message {
  id: number; ts: string; line_id: string | null; role: 'user' | 'worker' | 'system'; worker_id: string | null;
  worker: WorkerRef | null; kind: string; body: any;
}

export interface TraceRow { id: number; ts: string; kind: string; label: string; detail: string; ms: number; line_id: string | null }

export interface Station { name: string; out: string; team: string[]; st: 'todo' | 'run' | 'done' }

export interface Sheet {
  id: string; type: string; name: string; label: string | null; accent: string | null; district: string; rep: string;
  tech: string; later: boolean; live: boolean; status: string; job: string; stations?: Station[]; skills: string[];
  tools: string[]; real: string; from: [string, string][]; to: [string, string][]; repos?: any[] | null; line?: Line | null;
  active_line?: string | null;
}

export type AgentRole = 'coder' | 'writer' | 'monitor';
export type AgentStatus = 'stopped' | 'starting' | 'idle' | 'working' | 'error' | 'watching';

export interface AgentEvent { id: number; agent_id: string; ts: string; kind: 'user' | 'assistant' | 'tool' | 'tool_end' | 'note'; data: any }

export interface ModelRef { provider: string; id: string; name: string; reasoning: boolean; contextWindow: number | null }

// what a pi's bridge reports: its model and thinking level, the models it can switch to, its session
export interface PiState {
  model: ModelRef | null; thinking: string; levels: string[];
  session: { id: string; name: string | null; file: string | null };
  context: { tokens: number | null; contextWindow: number; percent: number | null } | null;
  models?: ModelRef[]; providers?: Record<string, string>;
  commands?: { name: string; description: string; source: string }[];
}

export interface Agent {
  id: string; line_id: string; role: AgentRole; status: AgentStatus; tmux: string | null; cwd: string | null;
  model: string | null; cost: number; attach: string | null; name: string; last: AgentEvent | null; updated_at: string;
  runtime: 'pi' | 'paseo'; started: boolean; ext_id: string | null; web: string | null; state: PiState | null;
}

export interface PaseoModel { id: string; name: string; thinking: string[]; default_thinking: string | null }
export interface PaseoProvider { id: string; label: string; modes: string; models: PaseoModel[] }
export interface PaseoInfo {
  status: { ok: boolean; note: string; server_id?: string; web?: string | null; version?: string };
  providers: PaseoProvider[];
}
export interface Llm {
  provider: string; model_strong: string; model_cheap: string; effort: string; offline: boolean; openai_base_url: string;
  providers: { id: string; name: string; models: string[] }[];
}
export interface PaseoConversation {
  id: string; title: string | null; provider: string; model: string | null; cwd: string; status: string;
  updated: string; last_user: string | null; linked: string | null;
}
// a Paseo conversation trimmed for the room: messages, and tools as one-liners
export interface PaseoItem { ts: string; kind: 'user' | 'assistant' | 'tool' | 'error' | 'note'; text?: string; id?: string; name?: string; status?: string; arg?: string; error?: string | null }
export interface PaseoPermission { id: string; name: string; title: string | null; arg: string }
export interface StartOpts { runtime?: 'pi' | 'paseo'; provider?: string; model?: string; thinking?: string }

// a paper in the library, as the cards on its shelves show it
export interface PaperCard {
  paper_id: string; arxiv_id: string; title: string; year: string; authors: string; snippet: string; url: string;
  tags: string[]; topic?: string; similarity?: number;
  note?: string; closest?: boolean; // in a paper's survey: why it is close, and whether it is one of the closest three
}
export interface Shelf { total: number; topics: { label: string; n: number }[]; papers: PaperCard[] }

export interface ProjectRef { id: string; seq: number; title: string; status: string; stage: string }
export interface RosterRow { line: ProjectRef; agent: Agent | null }
export interface Roster { roster: RosterRow[]; available: { ok: boolean; note: string; pi: string | null; tmux: string | null } }

export interface Job {
  id: string; line_id: string | null; name: string; backend: string; status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  progress: number; command: string | null; cwd: string | null; result: any; note: string | null; submitted_by: string | null;
  created_at: string; started_at: string | null; ended_at: string | null; log?: string;
  external?: boolean; nvidb?: NvJob; // a job in nvidb's queue, shown here but managed there
}

// nvidb: the GPUs on your own machines and its job queue, read only
export interface NvJob {
  id: number; name: string; state: string; node: string | null; gpu_ids: number[]; lane: string | null; vram_mb: number;
  progress: string | null; submitter: string | null; workdir: string | null; command: string; notes: string; held: boolean;
  created_at: string | null; started_at: string | null; finished_at: string | null; elapsed_s: number | null;
  exit_code: number | null; last_error: string;
}
export interface GpuProc { user: string | null; name: string; mem_mb: number; managed: boolean; job_id: number | null; job_name: string | null }
export interface Gpu {
  index: number; name: string; mem_total_mb: number; mem_used_mb: number; free_mb: number; util_percent: number;
  temperature_c: number | null; queue_mem_mb: number; external_mem_mb: number; reserved_mb: number; attribution: string | null;
  state: 'idle' | 'room' | 'full'; procs: GpuProc[];
}
export interface GpuNode { name: string; state: string; enabled: boolean; last_seen: string | null; last_error: string | null; gpus: Gpu[] }
export interface GpuStatus {
  ok: boolean; note: string; at: string | null; ticked?: string | null; nodes: GpuNode[]; jobs: NvJob[];
  summary: { nodes: number; up: number; gpus: number; idle: number; room: number; free_mb: number; total_mb: number } | null;
  counts: Record<string, number>; alerts: number;
}
export interface Backend { id: string; name: string; ready: boolean; note: string; active: number }
export interface JobBoard { jobs: Job[]; backends: Backend[]; plant: Hud['plant'] }

// skim: skills layered per project and conversation, like git config (global → project → session)
export type SkimScope = 'global' | 'project' | 'session';
export interface SkimSetting { key: string; value: string; scope: SkimScope; file: string; line: number }
export interface SkimScopeInfo { scope: SkimScope; file: string; exists: boolean; settings: SkimSetting[] }
export interface SkimSkill {
  name: string; description?: string; enabled: boolean; in_store: boolean; path?: string;
  scope?: SkimScope | 'env'; origin?: string; // what decided it
}
export interface SkimResolution {
  env: string; env_scope?: SkimScope | 'active'; env_origin?: string; env_missing?: boolean;
  scopes: SkimScopeInfo[]; skills: SkimSkill[];
}
export interface SkimStatus {
  ok: boolean; note: string; bin: string | null; active_env: string | null;
  store: { name: string; description?: string; version?: string; path: string }[];
  envs: { name: string; skills: string[]; active: boolean }[];
  global: SkimScopeInfo | null;
  lines: { id: string; seq: number; title: string; status: string; agents: { id: string; role: AgentRole; status: AgentStatus; runtime: string | null; model: string | null }[] }[];
}
// the town's own workers' skills (server/skills), hot-swapped
export interface TownSkill { name: string; description: string; roles: string[]; allowed_tools: string[]; references: string[]; scripts: string[] }

// the MCP exchange
export interface McpServer {
  name: string; source: 'builtin' | 'file' | 'town'; command: string; args: string[]; env: string[]; cwd: string | null;
  enabled: boolean; state: 'ok' | 'error' | 'connecting' | 'off'; error: string | null; tools: { name: string; description: string }[];
}
export interface McpView { servers: McpServer[]; town_file: string; config_file: string | null; self: any }

// the library's retrieval
export interface RagOpts { top_k: number; candidates: number; vectors: boolean }
export interface RagView {
  stats: { papers: number; sources: Record<string, number>; vectors: number; terms: number };
  opts: RagOpts; limits: Record<'top_k' | 'candidates', [number, number]>; index: string;
  embed: { configured: boolean; model: string | null; host: string | null };
}
export interface RagHit extends PaperCard { matched: string[] }
export interface RagResult { query: string; expanded: string; terms: string[]; method: 'coverage' | 'embedding'; hits: RagHit[] }

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail ? (typeof data.detail === 'string' ? trx(data.detail) : tr('输入有误')) : tr('请求失败 {0}', r.status));
  return localize(data) as T;
}

export const api = {
  world: () => call<WorldState>('GET', '/api/world'),
  building: (id: string) => call<Sheet>('GET', `/api/buildings/${id}`),
  line: (id: string) => call<Line>('GET', `/api/lines/${id}`),
  lines: () => call<Line[]>('GET', '/api/lines'),
  messages: () => call<Message[]>('GET', '/api/messages?limit=120'),
  trace: () => call<TraceRow[]>('GET', '/api/trace?limit=80'),
  status: () => call<any>('GET', '/api/status'),
  idea: (text: string, budget: number) => call<Line>('POST', '/api/ideas', { text, budget }),
  hatch: (id: string) => call<Line>('POST', `/api/lines/${id}/hatch`),
  adjust: (id: string, text: string) => call<Line>('POST', `/api/lines/${id}/adjust`, { text }),
  resume: (id: string) => call<Line>('POST', `/api/lines/${id}/resume`),
  ask: (text: string, building: string) => call<{ ok: boolean }>('POST', '/api/chat', { text, building }),
  jobs: (lineId?: string) => call<JobBoard>('GET', `/api/jobs${lineId ? `?line_id=${lineId}` : ''}`),
  job: (id: string) => call<Job>('GET', `/api/jobs/${id}?tail=400`),
  townSkills: () => call<TownSkill[]>('GET', '/api/skills'),
  skim: (fresh = false) => call<SkimStatus>('GET', `/api/skim${fresh ? '?fresh=1' : ''}`),
  resolve: (lineId?: string | null, agentId?: string | null) =>
    call<SkimResolution>('GET', `/api/skim/resolve?${new URLSearchParams({ ...(lineId ? { line_id: lineId } : {}), ...(agentId ? { agent_id: agentId } : {}) })}`),
  skimSet: (scope: SkimScope, key: string, value: string | null, lineId?: string | null, agentId?: string | null) =>
    call<SkimResolution>('POST', '/api/skim/config', { scope, key, value, line_id: lineId ?? null, agent_id: agentId ?? null }),
  mcp: () => call<McpView>('GET', '/api/mcp'),
  mcpAdd: (o: { name: string; command: string; args: string[]; env: Record<string, string> }) => call<McpView>('POST', '/api/mcp/servers', o),
  mcpToggle: (name: string, enabled: boolean) => call<McpView>('POST', `/api/mcp/servers/${name}/toggle`, { enabled }),
  mcpRestart: (name: string) => call<McpView>('POST', `/api/mcp/servers/${name}/restart`),
  mcpRemove: (name: string) => call<McpView>('DELETE', `/api/mcp/servers/${name}`),
  rag: () => call<RagView>('GET', '/api/rag'),
  ragSet: (o: Partial<RagOpts>) => call<RagView>('POST', '/api/rag', o),
  ragSearch: (q: string, k?: number) => call<RagResult>('GET', `/api/rag/search?${new URLSearchParams({ q, ...(k ? { k: String(k) } : {}) })}`),
  gpus: (fresh = false) => call<GpuStatus>('GET', `/api/gpus${fresh ? '?fresh=1' : ''}`),
  cancelJob: (id: string) => call<Job>('POST', `/api/jobs/${id}/cancel`),
  roster: (role: AgentRole) => call<Roster>('GET', `/api/agents?role=${role}`),
  agent: (id: string, after = 0) => call<{ agent: Agent; events: AgentEvent[] }>('GET', `/api/agents/${id}?after=${after}`),
  openAgent: (lineId: string, role: AgentRole) => call<Agent>('POST', '/api/agents', { line_id: lineId, role }),
  startAgent: (id: string, o: StartOpts = {}) => call<Agent>('POST', `/api/agents/${id}/start`, o),
  openInPaseo: (id: string) => call<{ ok: boolean }>('POST', `/api/agents/${id}/open`),
  paseo: () => call<PaseoInfo>('GET', '/api/paseo'),
  conversations: () => call<{ conversations: PaseoConversation[] }>('GET', '/api/paseo/conversations'),
  importAgent: (lineId: string, role: AgentRole, extId: string) => call<Agent>('POST', '/api/agents/import', { line_id: lineId, role, ext_id: extId }),
  timeline: (id: string) => call<{ agent: Agent; items: PaseoItem[]; paseo: { permissions?: PaseoPermission[]; usage?: { cost: number } | null } }>('GET', `/api/agents/${id}/timeline`),
  permit: (id: string, requestId: string, allow: boolean) => call<{ ok: boolean }>('POST', `/api/agents/${id}/permit`, { request_id: requestId, allow }),
  llm: () => call<Llm>('GET', '/api/llm'),
  samples: () => call<{ added: string[]; note: string }>('POST', '/api/samples'),
  library: (q = '', topic = '', limit = 60) => call<Shelf>('GET', `/api/library?${new URLSearchParams({ q, topic, limit: String(limit) })}`),
  papersOf: (lineId: string) => call<{ survey: PaperCard[]; references: PaperCard[] }>('GET', `/api/lines/${lineId}/papers`),
  setLlm: (o: Partial<Pick<Llm, 'provider' | 'model_strong' | 'model_cheap' | 'effort'>>) => call<Llm>('POST', '/api/llm', o),
  stopAgent: (id: string) => call<Agent>('POST', `/api/agents/${id}/stop`),
  say: (id: string, text: string) => call<AgentEvent>('POST', `/api/agents/${id}/say`, { text }),
  brief: (id: string) => call<AgentEvent>('POST', `/api/agents/${id}/brief`),
  abort: (id: string) => call<{ ok: boolean }>('POST', `/api/agents/${id}/abort`),
};

export const fileUrl = (lineId: string, name: string) => `/api/lines/${lineId}/files/${name}`;
// a linked project's paper, compiled in its own repository
export const linkedPdfUrl = (lineId: string) => `/api/lines/${lineId}/linked/pdf`;

export type ServerEvent = { id: number; type: string; ts: string; [k: string]: any };

const listeners = new Set<(e: ServerEvent) => void>();

// Components that need live events (an agent's transcript, the job board) listen here.
export function listen(fn: (e: ServerEvent) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// One EventSource for the app; the browser reconnects on its own.
export function subscribe(onEvent: (e: ServerEvent) => void, onState: (ok: boolean) => void): () => void {
  const es = new EventSource('/api/events');
  const types = ['line', 'message', 'trace', 'world', 'building', 'bank', 'power', 'workers', 'skills', 'library', 'item',
    'job', 'agent', 'agent_event', 'agent_delta', 'llm'];
  for (const t of types) es.addEventListener(t, ev => {
    const e = localize(JSON.parse((ev as MessageEvent).data));
    onEvent(e);
    for (const fn of listeners) fn(e);
  });
  es.onopen = () => onState(true);
  es.onerror = () => onState(false);
  return () => es.close();
}
