// REST calls and the live event stream from the Papertown server.

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
}

export interface Message {
  id: number; ts: string; line_id: string | null; role: 'user' | 'worker' | 'system'; worker_id: string | null;
  worker: WorkerRef | null; kind: string; body: any;
}

export interface TraceRow { id: number; ts: string; kind: string; label: string; detail: string; ms: number; line_id: string | null }

export interface Station { name: string; out: string; team: string[]; st: 'todo' | 'run' | 'done' }

export interface Sheet {
  id: string; type: string; name: string; label: string | null; accent: string | null; district: string; rep: string;
  tech: string; later: boolean; live: boolean; status: string; job: string; stations?: Station[]; skills: string[];
  tools: string[]; real: string; from: [string, string][]; to: [string, string][]; repo?: any; line?: Line | null;
  active_line?: string | null;
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail ? (typeof data.detail === 'string' ? data.detail : '输入有误') : `请求失败 ${r.status}`);
  return data as T;
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
};

export const fileUrl = (lineId: string, name: string) => `/api/lines/${lineId}/files/${name}`;

export type ServerEvent = { id: number; type: string; ts: string; [k: string]: any };

// One EventSource for the app; the browser reconnects on its own.
export function subscribe(onEvent: (e: ServerEvent) => void, onState: (ok: boolean) => void): () => void {
  const es = new EventSource('/api/events');
  const types = ['line', 'message', 'trace', 'world', 'building', 'bank', 'power', 'workers', 'skills', 'library', 'item'];
  for (const t of types) es.addEventListener(t, ev => onEvent(JSON.parse((ev as MessageEvent).data)));
  es.onopen = () => onState(true);
  es.onerror = () => onState(false);
  return () => es.close();
}
