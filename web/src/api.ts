// REST calls and the live event stream from the Papertown server.

import { DEMO, demoCall, demoFile } from './demo';
import type { FlowPart } from './flow';
import { localize, tr, trx } from './i18n';

export interface Placement {
  id: string; type: string; x: number; y: number; name: string; label: string | null; accent: string | null;
  line_id: string | null; status: string; core: boolean; key: boolean; live: boolean; tech: string;
}

export interface Hud {
  day: number; lines: { running: number; total: number }; library: number;
  leads: { on: number; running: number; blocked?: number }; // blocked: should run and cannot (absent in older demo snapshots)
}
export type LineStatus = 'running' | 'done' | 'linked' | 'dropped';
export interface RunningLine { id: string; seq: number; title: string; status: LineStatus; stage: string; building: string; pct: number; mill_id: string | null }
export interface WorldState { placements: Placement[]; running: RunningLine[]; hud: Hud }
export interface StageAgent { id: string; role: 'lead' | 'coder' | 'writer'; name: string; status: string; runtime: string | null; model: string | null }
export interface Resident { on: boolean; state: 'running' | 'starting' | 'blocked' | 'off' | 'ended'; note: string | null; agent: string | null; runtime: string | null; status: string | null }
export interface Stage {
  key: string; name: string; mod: string; status: 'todo' | 'run' | 'done'; pct: number; building: string; out: string; note: string | null;
  owner: 'lead' | 'coder' | 'writer'; agents: StageAgent[]; started_at: string | null; ended_at: string | null;
}
export interface Line {
  id: string; seq: number; title: string; idea: string; status: LineStatus; stage: string;
  mill_id: string | null; verdict: string | null; note: string | null; pct: number;
  current: Stage | null; stages: Stage[]; team: StageAgent[]; files: string[];
  sample: boolean; lead: Resident; outputs?: Record<string, any>; linked?: Linked | null;
}
export interface BuildingStaff { who: 'lead' | 'coder' | 'writer' | 'assistant'; agent: Agent | null; line: { id: string; seq: number; title: string } | null; name: string }

export type UsageProviderId = 'claude' | 'codex' | 'antigravity';
export type UsageBudget = number | null;
export type UsageState = 'none' | 'ok' | 'near' | 'over';
export interface UsageTokens { input: number; cache_write: number; cache_write_1h: number; cache_read: number; output: number }
export interface UsageWindow {
  id: string; key: string; label: string; group: string | null; used: number; left: number; resets_at: string | null;
}
export interface UsageProvider {
  id: UsageProviderId; label: string; plan: string | null; status: 'available' | 'unavailable' | 'stale';
  error: string | null; notes: string[]; fetched_at: string | null; windows: UsageWindow[];
  balances: { id: string; label: string; unit: string; used?: number; remaining?: number; limit?: number }[];
  week: { cost: number; projects: number; tokens: UsageTokens; unpriced: string[] };
}
export interface UsageView { polled_at: string | null; next_at: string | null; providers: UsageProvider[]; logs: boolean; log_error: string | null }
export interface LineUsage {
  budget: UsageBudget; spent: number; state: UsageState; since: string | null; week: number; logs: boolean;
  providers: { id: UsageProviderId; cost: number; tokens: UsageTokens }[];
  models: { provider: UsageProviderId; model: string; cost: number; tokens: UsageTokens; priced: boolean }[];
  sessions: { session: string; provider: UsageProviderId; owner: { kind: 'agent' | 'terminal' | 'dir'; id: string; name: string };
    cwd: string; cost: number; tokens: UsageTokens; last_at: string }[];
}
export interface UsageSettings { default_budget: UsageBudget; poll: number; logs: boolean }

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
  id: number; ts: string; line_id: string | null; role: 'user' | 'system'; kind: string; body: any;
}

export interface TraceRow { id: number; ts: string; kind: string; label: string; detail: string; ms: number; line_id: string | null }

export interface Station { name: string; out: string; st: 'todo' | 'run' | 'done' }

export interface Sheet {
  id: string; type: string; name: string; label: string | null; accent: string | null; district: string; rep: string;
  tech: string; later: boolean; live: boolean; status: string; job: string; stations?: Station[]; skills: string[];
  tools: string[]; real: string; from: [string, string][]; to: [string, string][]; repos?: any[] | null; line?: Line | null;
  active_line?: string | null;
}

export type AgentRole = 'coder' | 'writer' | 'monitor' | 'assistant' | 'lead';
export type AgentStatus = 'stopped' | 'starting' | 'idle' | 'working' | 'error' | 'watching' | 'offline'; // offline: in Paseo, while Paseo cannot be reached

export type Bucket = 'needs' | 'failed' | 'review' | 'working' | 'idle' | 'off';
export interface Watch {
  bucket: Bucket; why: string | null; since: string | null; turn: string | null;
  doing: { kind: string; text: string } | null; queued: number; unread: boolean;
  permissions: (PaseoPermission & { kind: string })[]; asks: Report[];
}
export interface AgentTask { id: string; title: string; status: string }
export interface Loose { id: string; title: string | null; provider: string; model: string | null; status: string; cwd: string | null; updated: string }
export interface Overview {
  paseo: { ok: boolean; note: string; live: boolean }; counts: Record<Bucket, number>;
  herdr: { ok: boolean; note: string; live: boolean };
  groups: { line: ProjectRef | null; agents: Agent[]; loose: Loose[]; terminals: Terminal[] }[];
  others: Terminal[];
}

export interface Terminal {
  id: string; terminal_id: string; pane_id: string; workspace_id: string | null; tab_id: string | null;
  name: string | null; kind: string | null; title: string; cwd: string | null; watch: Watch;
  agent_session?: { kind: string; value: string } | null;
}
export interface TerminalQueue { id: number; terminal_id: string; text: string; created_at: string; state: 'queued' | 'sending' | 'sent' | 'failed' | 'dropped' }
// a dialog on a terminal's screen (trusting a folder, a permission, a review) and the choices it offers
export interface TermPrompt { digest: string; title: string; body: string[]; options: { index: number; label: string; current: boolean; key: string | null }[]; hint: string }
// whether the session log behind a terminal conversation could be read, and why not
export interface Transcript { ok: boolean; note: string | null }
export interface TerminalDetail { terminal: Terminal; text: string; queued: TerminalQueue[]; prompt?: TermPrompt | null }
export interface HerdrInfo { ok: boolean; note: string; live: boolean; socket: string; count: number; installed: boolean; enabled: boolean }

export interface AgentEvent { id: number; agent_id: string; ts: string; kind: 'user' | 'assistant' | 'tool' | 'tool_end' | 'note' | 'ask' | 'act'; data: any }

export interface ModelRef { provider: string; id: string; name: string; reasoning: boolean; contextWindow: number | null }

export interface PiState {
  model: ModelRef | null; thinking: string; levels: string[];
  session: { id: string; name: string | null; file: string | null };
  context: { tokens: number | null; contextWindow: number; percent: number | null } | null;
  models?: ModelRef[]; providers?: Record<string, string>;
  commands?: { name: string; description: string; source: string }[];
}

export interface Agent {
  id: string; line_id: string | null; role: AgentRole; status: AgentStatus; tmux: string | null; cwd: string | null;
  model: string | null; cost: number; attach: string | null; name: string; last: AgentEvent | null; updated_at: string;
  runtime: 'pi' | 'paseo' | TermBackend; started: boolean; ext_id: string | null; web: string | null; state: PiState | null;
  down?: string | null; // why it cannot be reached now (its status is then offline)
  node_id?: string | null; workspace_id?: string | null; session_id?: string | null;
  watch?: Watch; task?: AgentTask | null; term?: AgentTerm | null;
}

export interface AgentTerm {
  backend: TermBackend; provider: string; status: 'starting' | 'idle' | 'working' | 'blocked' | 'done' | 'exited';
  seq: number; seen_seq: number; since: string; tool?: string | null; model?: string | null; thinking?: string | null; note?: string | null;
}
// where a CLI's real terminal interface runs: a herdr tab, a tmux window, or Papertown's own background terminal
export type TermBackend = 'herdr' | 'tmux' | 'headless';
export type DefaultRuntime = 'paseo' | TermBackend;
export interface Backends {
  paseo: { ok: boolean; note: string }; herdr: { ok: boolean; note: string }; tmux: { ok: boolean; note: string }; headless: { ok: boolean; note: string };
  clis: Record<string, string | null>;
}
export interface PaseoModel { id: string; name: string; thinking: string[]; default_thinking: string | null }
export interface PaseoProvider { id: string; label: string; modes: string; models: PaseoModel[]; error?: string | null } // error: why its models could not be read
export interface PaseoInfo {
  status: { ok: boolean; note: string; server_id?: string; web?: string | null; version?: string };
  providers: PaseoProvider[]; runtime?: DefaultRuntime;
  defaults?: PaseoDefaults;
  news?: ModelNews[];
}
// set: chosen in the settings page rather than from PAPERTOWN_ASSISTANT_MODEL / _LEAD_MODEL
export interface PaseoDefault { provider: string | null; model: string | null; thinking: string | null; set?: boolean }
export type PaseoDefaults = Record<'assistant' | 'lead' | 'worker', PaseoDefault>;
export interface ModelNews { key: string; provider: string; label: string; model: string; name: string; thinking: string[]; default_thinking: string | null; at: string }

export interface Report {
  id: number; line_id: string; agent_id: string | null; ts: string; kind: 'report' | 'ask' | 'usage';
  data: { text?: string; key?: boolean; who?: string; question?: string; choices?: string[]; open?: boolean; answer?: string;
    answered_at?: string; by?: string; act?: { action: string } | null; result?: string };
}
export type Health = 'ok' | 'risk' | 'blocked';
export type OutputState = 'todo' | 'doing' | 'done';
export interface Card {
  summary: string; health: Health; progress: number | null; milestone: string;
  done: string[]; next: string[]; blockers: string[]; need_you: string[]; metrics: { name: string; value: string; note: string }[];
  plans: { name: string; goal: string; when: string }[]; outputs: { name: string; due: string; state: OutputState }[];
  at: string; by: string;
}
export interface CardRun { id: string; name: string; where: string | null; progress: number | null; line: string | null; since: string | null }
export interface CardRepo {
  path: string; name: string; missing?: boolean; git?: boolean; branch?: string | null; dirty?: number;
  commit?: { hash: string; when: string; subject: string } | null; remote?: string | null; files?: number; langs?: { ext: string; n: number }[];
  main?: string | null; title?: string | null; words?: number; figures?: number; tables?: number; bib?: number; pdf?: boolean; pdf_at?: string | null; sections?: number;
}
export interface MemoryCounts { sessions: number; notes: number; messages: number; at: string | null }
export interface ProjectCard {
  line: { id: string; seq: number; title: string; status: LineStatus; linked: boolean; updated_at: string; sample: boolean; lead: Resident; usage_state?: UsageState;
    stages: { key: string; name: string; status: 'todo' | 'run' | 'done' }[]; stage: { name: string; status: string; pct: number } | null };
  lead: Agent | null; card: Card | null; prev: number | null; pending: { at: string; note: string } | null;
  jobs: Record<string, number>; asks: number; decisions?: Decision[];
  running: CardRun[]; queued: CardRun[]; repos: { code: CardRepo | null; paper: CardRepo | null }; memory: MemoryCounts;
  checks?: { hard: CheckCounts; soft: CheckCounts };
}

// 待你决定 on a card (decisions.py): a question, a native permission request, a terminal dialog, or a line of the card
export interface DecisionOption { label: string; value: boolean | number | string; main?: boolean }
export interface Decision {
  kind: 'ask' | 'permission' | 'prompt' | 'need'; id: string; agent: string | null; who: string; title: string; detail: string;
  options: DecisionOption[]; free: boolean; ready: boolean; since: string | null;
  later?: boolean; // a line of the card while no lead runs: it hears the choice with the next card request
}

// checks (checks.py): hard checks are code and must pass; soft checks are the lead's judgement
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'none' | 'wait';
export interface CheckCounts { pass: number; warn: number; fail: number; none: number; wait: number; total: number }
export interface CheckFinding { file: string; line: number; text: string; hit: string; hint: string }
export interface CheckResult { status: CheckStatus; value: number | null; ts: string; seen: string; by: string; note: string; findings: CheckFinding[]; total: number }
export interface Check {
  id: string; kind: 'hard' | 'soft'; stage: string; title: string; prio: string; rule: string; text: string;
  unit?: string; max?: number; params?: { key: string; value: number; label: string }[]; every?: number;
  custom: boolean; on: boolean; last: CheckResult | null; history: { ts: string; status: CheckStatus; value: number | null }[];
  asked?: string | null; due?: boolean;
  gate?: GateLevel; first?: { value: number | null; status: CheckStatus; ts: string } | null; // a hard check: what it does at its gate, its first count
}
export type GateLevel = 'block' | 'warn';
export interface CheckEdit { on?: boolean; params?: Record<string, number>; title?: string; prompt?: string; every?: number; gate?: GateLevel }

// a project's research loop (canvas.py): a free graph framed by the parts of the research flow (flow.ts), a block
// each. A stage is in its part's block with its hard gate, the sentinels (soft checks) that watch it and what they send
// back; the soft spec, the hard clamp and the human gate are in the overview; a task or a note is where it was put
export interface CanvasBlock { key: FlowPart; title: string; x: number; y: number; w: number; h: number } // the slot it has while empty
export type CanvasKind = 'stage' | 'gate' | 'hard' | 'soft' | 'spec' | 'clamp' | 'human' | 'task' | 'note' | 'info';
export type TaskStatus = 'draft' | 'queued' | 'sent' | 'done' | 'blocked'; // queued: dispatched, waiting for its turn
// why a queued task has not gone out: a task before it (not done, or done on a result to be looked at again), or the one at work in its directory
export interface TaskWait { kind: 'after' | 'dir'; id: string; title: string; status: TaskStatus; stale: boolean }
export type TaskTo = 'lead' | 'coder' | 'writer';
export interface TaskLog { ts: string; kind: 'made' | 'bound' | 'sent' | 'resent' | 'done' | 'blocked' | 'back' | 'marked' | 'reopened' | 'round' | 'escalated' | 'converged' | 'queued' | 'unqueued' | 'relay' | 'stale' | 'kept'; text: string; by: string }
export type GateState = 'pass' | 'warn' | 'block' | 'none' | 'off';
export interface Gate {
  stage: string; name: string; state: GateState; checks: string[]; pass: number; total: number; blocking: { id: string; title: string }[];
  before: number; now: number; policy: { auto: boolean; rounds: number }; ticket: string | null; ticket_status: TaskStatus | null; round: number;
  escalated: boolean; open: boolean; waived: boolean; reached: boolean; next: string | null; locks: string | null;
}
export interface BoundRule { id: string; kind: 'must' | 'never' | 'ask'; text: string; from: string; action: string | null }
export interface HumanItem { kind: 'escalated' | 'blocked' | 'stale' | 'fail' | 'ask' | 'line'; id: string; text: string; gate?: string }
export interface CanvasNode {
  id: string; kind: CanvasKind; x: number; y: number; mod: FlowPart; title?: string; text?: string; // mod: the block it belongs to
  w?: number; h?: number; // an info card: how big it is drawn
  ref?: string; status?: string; pct?: number; // a stage: its key, state and progress; a task: its state; an info card: what it shows
  note?: string; role?: TaskTo | null; locked?: { gate: string; title: string } | null; // a stage: its note, who works there, the gate holding it
  check?: Check; gate?: Gate;
  rules?: BoundRule[]; items?: HumanItem[];
  to?: TaskTo; sent_at?: string | null; done_at?: string | null; result?: string; by?: string; log?: TaskLog[];
  agent_id?: string | null; agent?: Agent | null;
  // a task's turn: what it waits for while queued, why it could not be delivered, and why its result is to be looked at again
  waits?: TaskWait[]; wait_note?: string | null; queued_at?: string | null; stale?: string | null;
  // a task on the loop: a rework ticket (the stage whose gate sent it back, its round, the counts so far) or a correction (the sentinel it came from)
  loop?: 'hard' | 'soft' | null; stage?: string | null; round?: number; trail?: number[]; from?: string | null; escalated?: boolean; converged?: boolean;
}
export type EdgeKind = 'flow' | 'watch' | 'spec' | 'clamp' | 'hard_loop' | 'soft_loop' | 'escalate' | 'member' | 'order'; // order: between two tasks, the first before the second
export interface CanvasEdge { id: string; source: string; target: string; label?: string; kind?: EdgeKind }
export interface CanvasView {
  line_id: string; seq: number; title: string; nodes: CanvasNode[]; edges: CanvasEdge[]; gone: { id: string; title: string }[];
  spare: { id: string; title: string }[]; blocks: CanvasBlock[]; rows: FlowPart[][]; checks: Check[]; // rows: the blocks as they stand, row by row
  summary: { hard: CheckCounts; soft: CheckCounts }; tasks: Record<TaskStatus, number>;
  trend: { ts: string; pass: number; fail: number; total: number; found: number }[]; found: { first: number | null; now: number | null };
  rounds: number; ran: string | null; rules: { exclusive: boolean }; // exclusive: one task per working directory at a time
  lead: boolean; agents: Record<TaskTo, { there: boolean; status: string | null; model: string | null }>; added?: string;
}
export interface NewNode { kind: 'task' | 'hard' | 'soft' | 'note'; x: number; y: number; title?: string; text?: string; to?: TaskTo; prio?: string; link?: string | null; send?: boolean }
export type Pane = 'summary' | 'attention' | 'milestone' | 'metrics' | 'running' | 'planned' | 'outputs' | 'code' | 'paper' | 'memory';
export interface CardLayout { panes: Pane[]; default: Pane[] }

export type MemorySource = 'claude' | 'codex' | 'claude-memory' | 'repo';
export interface MemoryFound {
  key: string; source: MemorySource; kind: 'session' | 'note'; repo: 'code' | 'paper'; title: string; cwd: string; origin: string;
  started: string | null; ended: string | null; size: number; imported: boolean; changed: boolean;
}
export interface MemoryItem {
  id: string; key: string; source: MemorySource; kind: 'session' | 'note'; repo: 'code' | 'paper'; title: string; cwd: string; origin: string;
  started: string | null; ended: string | null; n: number; chars: number; imported_at: string;
}
export interface MemoryFull extends MemoryItem { messages?: { role: 'user' | 'assistant'; text: string; at: string | null }[]; text?: string }

export type PageKind = 'report' | 'explain' | 'answer';
export interface Page { id: string; n: number; title: string; kind: PageKind; by: string; agent: string; question: string | null; at: string; size: number }
export interface AuthState { local: boolean; password: boolean; authed: boolean; signed_in: boolean; key?: boolean; via?: 'local' | 'password' | 'key' | null; sessions?: number; keys?: number }
// an access key for the apps: its text comes back once, when it is made
export interface AccessKey { id: string; name: string; hint: string; at: string; seen: string | null; key?: string }
export interface LeadView { agent: Agent | null; resident: Resident; settings: { on: boolean; supervise: boolean; every: number }; reports: Report[]; asks: Report[] }

export type BoundKind = 'must' | 'never' | 'ask';
export type BoundInherit = 'yes' | 'no' | 'force';
export interface Bound { id: string; kind: BoundKind; text: string; inherit: BoundInherit; action: string | null; from?: 'global' | 'project' | 'worker'; locked?: boolean }
export interface BoundsLevel { rules: Bound[]; off?: string[] }
export interface BoundsView {
  levels: { global: BoundsLevel; project?: BoundsLevel; workers?: Record<'coder' | 'writer', BoundsLevel> };
  effective: Record<string, Bound[]>; kinds: Record<BoundKind, string>; inherit: Record<BoundInherit, string>; actions: Record<string, string>;
}

export interface PaseoConversation {
  id: string; title: string | null; provider: string; model: string | null; cwd: string | null; status: string;
  updated: string; last_user: string | null; linked: string | null;
}
export interface PaseoItem { ts: string; kind: 'user' | 'assistant' | 'tool' | 'error' | 'note'; text?: string; id?: string; name?: string; status?: string; arg?: string; error?: string | null }
export interface PaseoPermission { id: string; name: string; title: string | null; arg: string; kind?: string }
export interface StartOpts { runtime?: 'pi' | 'paseo' | TermBackend; provider?: string; model?: string; thinking?: string }

export interface AssistantView { agent: Agent; asks: AgentEvent[]; acts: AgentEvent[]; actions: Record<string, { what: string; args: string }> }
export interface Focus { ref?: string; label: string; where?: string; text?: string }
export interface PageCtx {
  line: { id: string; seq: number; title: string } | null; mod: string; mod_name: string;
  state: Record<string, string>; focus: Focus | null; refs: { ref: string; label: string }[]; text: string;
  selection?: string; selection_at?: Focus | null;
}
export interface AssistantConv { id: string; title: string | null; model: string; at: string | null; current: boolean }
export interface ShowTarget { mod?: string; line?: string; file?: string; job?: string; ref?: string }

export interface PaperCard {
  paper_id: string; arxiv_id: string; title: string; year: string; authors: string; snippet: string; url: string;
  tags: string[]; topic?: string; similarity?: number;
  note?: string; closest?: boolean;
}
export interface Shelf { total: number; topics: { label: string; n: number }[]; papers: PaperCard[] }

export interface ProjectRef { id: string; seq: number; title: string; status: string; stage: string }
export interface DeptAgent extends Pick<Agent, 'id' | 'role' | 'name' | 'status' | 'runtime' | 'line_id' | 'model' | 'started' | 'cost' | 'updated_at'> {
  seq: number | null; last: { kind: string; text: string } | null;
}
export interface Department {
  id: string; type: string; name: string; district: string; color: string; state: 'busy' | 'wait' | 'idle' | 'off'; job: string;
  lines: (ProjectRef & { pct: number })[]; agents: DeptAgent[]; jobs: Pick<Job, 'id' | 'name' | 'status' | 'progress' | 'line_id' | 'backend'>[];
  gpus: { total: number; idle: number; running: number } | null;
}
export type SayMode = 'steer' | 'queue' | 'interrupt';
export interface RosterRow { line: ProjectRef; agent: Agent | null }
export interface Roster { roster: RosterRow[]; available: { ok: boolean; note: string; pi: string | null; tmux: string | null } }

export interface Job {
  id: string; line_id: string | null; name: string; backend: string; status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  progress: number; command: string | null; cwd: string | null; result: any; note: string | null; submitted_by: string | null;
  created_at: string; started_at: string | null; ended_at: string | null; log?: string;
  external?: boolean; nvidb?: NvJob;
}

export interface NvJob {
  id: number; name: string; state: string; node: string | null; gpu_ids: number[]; lane: string | null; vram_mb: number;
  progress: string | null; submitter: string | null; workdir: string | null; command: string; notes: string; held: boolean;
  created_at: string | null; started_at: string | null; finished_at: string | null; elapsed_s: number | null;
  exit_code: number | null; last_error: string; result?: unknown;
  pool?: string | null; lane_seq?: number | null; node_constraint?: string | null; gpu_constraint?: number[]; gpus?: number;
  priority?: number; depends_on?: number[]; held_reason?: string | null; gpu_mem_mb?: number | null; max_runtime_s?: number | null;
  progress_at?: string | null;
}
export interface NvJobFull extends NvJob {
  tags: string[]; attempt: number | null; events: { ts: string; kind: string; node: string | null; message: string }[];
}
// running and queued are job ids, in run order
export interface NvLane {
  name: string; node: string; gpu_ids: number[]; paused: boolean; concurrency: number; runner_up: boolean | null; blocked: string | null;
  running: number[]; queued: number[];
}
export interface NvPool { name: string; members: { node: string; gpus: number[] }[] }
// seen_since: when Papertown first saw the process; earlier: it was already running then
export interface GpuProc {
  pid: number | null; user: string | null; name: string; mem_mb: number; managed: boolean; job_id: number | null; job_name: string | null;
  seen_since?: string; earlier?: boolean;
}
export interface Gpu {
  index: number; name: string; mem_total_mb: number; mem_used_mb: number; free_mb: number; util_percent: number;
  temperature_c: number | null; queue_mem_mb: number; external_mem_mb: number; reserved_mb: number; attribution: string | null;
  state: 'idle' | 'room' | 'full'; procs: GpuProc[];
  updated_at?: string | null; trend?: [number, number, number][]; // [epoch s, util %, memory used MB] over the last hour
}
export interface GpuNode { name: string; state: string; enabled: boolean; last_seen: string | null; probed_at?: string | null; last_error: string | null; gpus: Gpu[] }
export interface GpuStatus {
  ok: boolean; note: string; at: string | null; ticked?: string | null; nodes: GpuNode[]; jobs: NvJob[]; lanes?: NvLane[]; pools?: NvPool[];
  polled_at?: string; poll_s?: number;
  summary: { nodes: number; up: number; gpus: number; idle: number; room: number; free_mb: number; total_mb: number } | null;
  counts: Record<string, number>; alerts: number;
}
export type WsRoot = 'code' | 'paper';
export interface WsPlace { path: string; name: string; git: boolean; branch?: string | null; dirty?: number; main?: string | null; pdf?: boolean }
export interface WsInfo { line_id: string; linked: boolean; latexmk: boolean; code: WsPlace | null; paper: WsPlace | null }
export interface WsEntry { path: string; size: number; status?: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' }
export interface WsTree { root: WsRoot; files: WsEntry[]; truncated: boolean }
export interface WsFile { path: string; size: number; mtime: number; binary: boolean; too_big: boolean; text: string | null }
export interface Compiled { ok: boolean; log: string; pages?: number | null; seconds: number }
export interface DataRun {
  id: string; name: string; state: string; where: string | null; started_at: string | null; finished_at: string | null;
  elapsed_s: number | null; exit_code: number | null; vram_mb: number | null; result: unknown;
  script?: string | null; entry?: string | null; // the file of the code repository its command ran, and the script or module as the command names it
}
export interface LineData {
  meta: { datasets: string[]; metrics: string[]; baselines: string[]; seeds: number | null; gpu_hours: number | null; backend: string | null };
  results: { metrics: string[]; rows: { method: string; values: number[]; ours: boolean }[]; simulated?: boolean; analysis?: string; concerns?: string[] } | null;
  runs: DataRun[];
  files: (WsEntry & { kind: 'processed' | 'raw' | 'other'; mtime: number })[];
}

export interface Backend { id: string; name: string; ready: boolean; note: string; active: number }
export interface JobBoard { jobs: Job[]; backends: Backend[] }

// skim: skills layered like git config (global → project → session)
export type SkimScope = 'global' | 'project' | 'session';
export interface SkimSetting { key: string; value: string; scope: SkimScope; file: string; line: number }
export interface SkimScopeInfo { scope: SkimScope; file: string; exists: boolean; settings: SkimSetting[] }
export interface SkimSkill {
  name: string; description?: string; enabled: boolean; in_store: boolean; path?: string;
  scope?: SkimScope | 'env'; origin?: string;
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
export interface TownSkill { name: string; description: string; roles: string[]; allowed_tools: string[]; references: string[]; scripts: string[] }

export interface McpServer {
  name: string; source: 'builtin' | 'file' | 'town'; command: string; args: string[]; env: string[]; cwd: string | null;
  enabled: boolean; state: 'ok' | 'error' | 'connecting' | 'off'; error: string | null; tools: { name: string; description: string }[];
}
export interface McpView { servers: McpServer[]; town_file: string; config_file: string | null; self: any }

export interface RagOpts { top_k: number; candidates: number }
export interface RagView {
  stats: { papers: number; sources: Record<string, number>; terms: number };
  opts: RagOpts; limits: Record<'top_k' | 'candidates', [number, number]>; index: string;
}
export interface RagHit extends PaperCard { matched: string[] }
export interface RagResult { query: string; expanded: string; terms: string[]; method: 'coverage'; hits: RagHit[] }

const pageLook = () => {
  const h = document.documentElement;
  return h.classList.contains('ui-cf') ? `?look=${h.dataset.mode === 'dark' ? 'dark' : 'light'}` : '';
};
// localize() keep-predicates: what you and the agents wrote stays as written; only the town's own text is translated
const said = (v: object) => ['user', 'assistant'].includes((v as { kind?: string }).kind ?? '') || (v as { type?: string }).type === 'agent_delta';
const written = (v: object) => said(v) || 'question' in v || ('key' in v && 'text' in v && !('threshold' in v));
const carded = (v: object) => said(v) || ('summary' in v && 'health' in v);
const asIs = () => true;
const ruled = (v: object) => 'inherit' in v && 'kind' in v;
// a check's findings and results keep the paper's words and the lead's, and tasks and notes on the canvas keep
// yours; the page translates their own labels
const kept = (v: object) => ('file' in v && 'hit' in v) || ('seen' in v && 'note' in v) || ('source' in v && 'target' in v) || ['task', 'note'].includes((v as { kind?: string }).kind ?? '');
const KEEP_EVENT: Record<string, (v: object) => boolean> = { report: written, card: carded, agent_event: said, agent_delta: said, page: asIs };

async function call<T>(method: string, url: string, body?: unknown, keep?: (v: object) => boolean): Promise<T> {
  if (DEMO) return localize(await demoCall(method, url), keep) as T;
  const r = await fetch(url, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && !url.startsWith('/api/auth/')) dispatchEvent(new Event('pt-signed-out')); // back to the landing, except for the auth calls themselves
  let data;
  try { data = await r.json(); }
  catch { throw new Error(tr('服务返回了无效的 JSON（HTTP {0}）', r.status)); }
  if (!r.ok) throw new Error(data.detail ? (typeof data.detail === 'string' ? trx(data.detail) : tr('输入有误')) : tr('请求失败 {0}', r.status));
  return localize(data, keep) as T;
}

async function residentCard(card: ProjectCard): Promise<ProjectCard> {
  const line = await call<Line>('GET', `/api/lines/${card.line.id}`);
  return { ...card, line: { ...card.line, lead: line.lead, sample: line.sample } };
}

export const api = {
  world: () => call<WorldState>('GET', '/api/world'),
  staffAt: (id: string) => call<BuildingStaff>('GET', `/api/buildings/${encodeURIComponent(id)}/staff`),
  building: (id: string) => call<Sheet>('GET', `/api/buildings/${id}`),
  line: (id: string) => call<Line>('GET', `/api/lines/${id}`),
  lines: () => call<Line[]>('GET', '/api/lines'),
  messages: () => call<Message[]>('GET', '/api/messages?limit=120'),
  trace: () => call<TraceRow[]>('GET', '/api/trace?limit=80'),
  freshPapers: () => call<{ papers: (PaperCard & { relevance: number })[] }>('GET', '/api/papers/fresh'),
  departments: () => call<Department[]>('GET', '/api/departments'),
  idea: (text: string) => call<Line>('POST', '/api/ideas', { text }),
  usage: () => call<UsageView>('GET', '/api/usage'),
  refreshUsage: () => call<UsageView>('POST', '/api/usage/refresh'),
  usageSettings: () => call<UsageSettings>('GET', '/api/usage/settings'),
  setUsageSettings: (body: UsageSettings) => call<UsageSettings>('PUT', '/api/usage/settings', body),
  lineUsage: (id: string) => call<LineUsage>('GET', `/api/lines/${id}/usage`),
  setUsageBudget: (id: string, body: UsageBudget) => call<LineUsage>('PUT', `/api/lines/${id}/usage_budget`, { usd: body }),
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
  overview: () => call<Overview>('GET', '/api/agents/overview', undefined, asIs),
  herdr: () => call<HerdrInfo>('GET', '/api/herdr', undefined, asIs),
  terminal: (id: string) => call<TerminalDetail>('GET', `/api/terminals/${encodeURIComponent(id)}`, undefined, asIs),
  terminalSay: (id: string, text: string, mode?: SayMode) => call<unknown>('POST', `/api/terminals/${encodeURIComponent(id)}/say`, { text, mode }, asIs),
  terminalKeys: (id: string, keys: string[]) => call<unknown>('POST', `/api/terminals/${encodeURIComponent(id)}/keys`, { keys }, asIs),
  terminalTimeline: (id: string) => call<{ terminal: Terminal; items: PaseoItem[]; transcript: Transcript }>('GET', `/api/terminals/${encodeURIComponent(id)}/timeline`, undefined, asIs),
  terminalPrompt: (id: string, digest: string, option: number) => call<{ ok: boolean }>('POST', `/api/terminals/${encodeURIComponent(id)}/prompt`, { digest, option }, asIs),
  terminalSeen: (id: string) => call<Terminal>('POST', `/api/terminals/${encodeURIComponent(id)}/seen`, undefined, asIs),
  terminalQueue: (id: string, queueId: number, what: 'now' | 'drop') =>
    call<TerminalQueue>('POST', `/api/terminals/${encodeURIComponent(id)}/queue/${queueId}`, { what }, asIs),
  seen: (id: string) => call<unknown>('POST', `/api/agents/${encodeURIComponent(id)}/seen`),
  queueAct: (id: string, eventId: number, what: 'now' | 'drop') =>
    call<unknown>('POST', `/api/agents/${encodeURIComponent(id)}/queue/${eventId}`, { what }),
  events: (id: string) => call<{ agent: Agent; events: AgentEvent[] }>('GET', `/api/agents/${id}?after=0`, undefined, said).then(v => v.events),
  agent: (id: string, after = 0) => call<{ agent: Agent; events: AgentEvent[] }>('GET', `/api/agents/${id}?after=${after}`, undefined, said),
  openAgent: (lineId: string, role: AgentRole) => call<Agent>('POST', '/api/agents', { line_id: lineId, role }),
  backends: () => call<Backends>('GET', '/api/backends'),
  defaultRuntime: () => call<{ runtime: DefaultRuntime }>('GET', '/api/agents/runtime'),
  setDefaultRuntime: (runtime: DefaultRuntime) => call<{ runtime: DefaultRuntime }>('POST', '/api/agents/runtime', { runtime }),
  agentScreen: (id: string) => call<{ text: string; term: AgentTerm; prompt?: TermPrompt | null }>('GET', `/api/agents/${id}/screen`, undefined, asIs),
  answerPrompt: (id: string, digest: string, option: number) => call<{ ok: boolean }>('POST', `/api/agents/${id}/prompt`, { digest, option }),
  agentKeys: (id: string, keys: string[]) => call('POST', `/api/agents/${id}/keys`, { keys }),
  closeTerminal: (id: string) => call<Agent>('POST', `/api/agents/${id}/close`),
  startAgent: (id: string, o: StartOpts = {}) => call<Agent>('POST', `/api/agents/${id}/start`, o),
  openInPaseo: (id: string) => call<{ ok: boolean }>('POST', `/api/agents/${id}/open`),
  paseo: (fresh?: boolean) => call<PaseoInfo>('GET', `/api/paseo${fresh ? '?fresh=1' : ''}`),
  setPaseoDefault: (role: 'assistant' | 'lead' | 'worker', o: { provider: string | null; model?: string | null; thinking?: string | null }) =>
    call<PaseoDefaults>('POST', '/api/paseo/defaults', { role, ...o }),
  modelNews: () => call<{ news: ModelNews[]; defaults: PaseoDefaults }>('GET', '/api/paseo/news'),
  dismissModels: (keys?: string[]) => call<{ news: ModelNews[] }>('POST', '/api/paseo/news/dismiss', { keys: keys ?? null }),
  conversations: () => call<{ conversations: PaseoConversation[] }>('GET', '/api/paseo/conversations'),
  importAgent: (lineId: string, role: AgentRole, extId: string) => call<Agent>('POST', '/api/agents/import', { line_id: lineId, role, ext_id: extId }),
  timeline: (id: string) => call<{ agent: Agent; items: PaseoItem[]; queued: AgentEvent[]; paseo: { permissions?: PaseoPermission[]; usage?: { cost: number } | null }; transcript?: Transcript }>('GET', `/api/agents/${id}/timeline`, undefined, said),
  permit: (id: string, requestId: string, allow: boolean) => call<{ ok: boolean }>('POST', `/api/agents/${id}/permit`, { request_id: requestId, allow }),
  samples: () => call<{ added: string[]; note: string }>('POST', '/api/samples'),
  library: (q = '', topic = '', limit = 60) => call<Shelf>('GET', `/api/library?${new URLSearchParams({ q, topic, limit: String(limit) })}`),
  papersOf: (lineId: string) => call<{ survey: PaperCard[]; references: PaperCard[] }>('GET', `/api/lines/${lineId}/papers`),
  stopAgent: (id: string) => call<Agent>('POST', `/api/agents/${id}/stop`),
  cards: async () => {
    const [v, lines] = await Promise.all([call<{ cards: ProjectCard[]; layout: CardLayout }>('GET', '/api/cards', undefined, carded), call<Line[]>('GET', '/api/lines')]);
    return { ...v, cards: v.cards.map(c => { const l = lines.find(l => l.id === c.line.id); return { ...c, line: { ...c.line, lead: l?.lead ?? c.line.lead, sample: l?.sample ?? c.line.sample } }; }) };
  },
  card: (lineId: string) => call<ProjectCard>('GET', `/api/lines/${lineId}/card`, undefined, carded).then(residentCard),
  setLayout: (panes: Pane[] | null) => call<CardLayout>('POST', '/api/cards/layout', { panes }),
  memory: (lineId: string) => call<{ items: MemoryItem[]; counts: MemoryCounts }>('GET', `/api/lines/${lineId}/memory`, undefined, asIs),
  memoryScan: (lineId: string) => call<{ found: MemoryFound[]; roots: { repo: 'code' | 'paper'; path: string }[]; sources: Record<'claude' | 'codex', boolean> }>(
    'GET', `/api/lines/${lineId}/memory/scan`, undefined, asIs),
  memoryImport: (lineId: string, keys: string[]) => call<{ imported: MemoryItem[]; failed: { key: string; why: string }[]; counts: MemoryCounts }>(
    'POST', `/api/lines/${lineId}/memory/import`, { keys }, asIs),
  memoryItem: (lineId: string, id: string) => call<MemoryFull>('GET', `/api/lines/${lineId}/memory/${id}`, undefined, asIs),
  memoryRemove: (lineId: string, id: string) => call<{ counts: MemoryCounts }>('DELETE', `/api/lines/${lineId}/memory/${id}`),
  pages: (lineId: string) => call<{ pages: Page[] }>('GET', `/api/lines/${lineId}/pages`, undefined, asIs),
  dropPage: (lineId: string, id: string) => call<{ ok: boolean }>('DELETE', `/api/lines/${lineId}/pages/${id}`),
  pageUrl: (lineId: string, id: string) => `/api/lines/${lineId}/pages/${id}/view${pageLook()}`,
  authState: () => call<AuthState>('GET', '/api/auth/state'),
  login: (password: string) => call<{ ok: boolean }>('POST', '/api/auth/login', { password }),
  logout: () => call<{ ok: boolean }>('POST', '/api/auth/logout'),
  logoutAll: () => call<{ ok: boolean; ended: number }>('POST', '/api/auth/logout-all'),
  setPassword: (password: string, old?: string) => call<AuthState>('POST', '/api/auth/password', { password, ...(old ? { old } : {}) }),
  clearPassword: () => call<AuthState>('DELETE', '/api/auth/password'),
  accessKeys: () => call<{ keys: AccessKey[] }>('GET', '/api/auth/keys'),
  createKey: (name: string) => call<AccessKey & { key: string }>('POST', '/api/auth/keys', { name }),
  decideCard: (lineId: string, d: { kind: Decision['kind']; id: string; agent: string | null; value: DecisionOption['value'] | null; text?: string }) =>
    call<ProjectCard>('POST', `/api/lines/${encodeURIComponent(lineId)}/decide`, d),
  revokeKey: (id: string) => call<{ keys: AccessKey[] }>('DELETE', `/api/auth/keys/${encodeURIComponent(id)}`),
  updateCard: (lineId: string, note = '') => call<ProjectCard>('POST', `/api/lines/${lineId}/card`, { note }, carded).then(residentCard),
  cancelCard: (lineId: string) => call<ProjectCard>('POST', `/api/lines/${lineId}/card/cancel`, {}, carded).then(residentCard),
  updateCards: () => call<{ sent: string[]; skipped: { line_id: string; why: string }[] }>('POST', '/api/cards/update', {}),
  lead: (lineId: string) => call<LeadView>('GET', `/api/lines/${lineId}/lead`, undefined, written),
  setLead: (lineId: string, o: { on?: boolean; supervise?: boolean; every?: number }) => call<LeadView['settings']>('POST', `/api/lines/${lineId}/lead`, o),
  reports: (lineId?: string) => call<{ reports: Report[]; asks: Report[] }>('GET', `/api/reports${lineId ? `?line_id=${lineId}` : ''}`, undefined, written),
  answer: (id: number, text: string) => call<Report>('POST', `/api/reports/${id}/answer`, { text }),
  bounds: (lineId?: string) => call<BoundsView>('GET', `/api/bounds${lineId ? `?line_id=${lineId}` : ''}`, undefined, ruled),
  saveBounds: (o: { line_id?: string; role?: string; rules: Partial<Bound>[]; off?: string[] }) => call<BoundsView>('PUT', '/api/bounds', o, ruled),
  say: (id: string, text: string, mode?: SayMode) => call<AgentEvent>('POST', `/api/agents/${id}/say`, { text, mode }),
  brief: (id: string) => call<AgentEvent>('POST', `/api/agents/${id}/brief`),
  abort: (id: string) => call<{ ok: boolean }>('POST', `/api/agents/${id}/abort`),
  ws: (lineId: string) => call<WsInfo>('GET', `/api/lines/${lineId}/ws`),
  wsTree: (lineId: string, root: WsRoot) => call<WsTree>('GET', `/api/lines/${lineId}/ws/${root}/tree`),
  wsFile: (lineId: string, root: WsRoot, path: string) => call<WsFile>('GET', `/api/lines/${lineId}/ws/${root}/file?${new URLSearchParams({ path })}`),
  wsSave: (lineId: string, root: WsRoot, path: string, text: string) => call<WsEntry>('PUT', `/api/lines/${lineId}/ws/${root}/file`, { path, text }),
  wsDiff: (lineId: string, root: WsRoot, path: string) => call<{ path: string; diff: string }>('GET', `/api/lines/${lineId}/ws/${root}/diff?${new URLSearchParams({ path })}`),
  compile: (lineId: string) => call<Compiled>('POST', `/api/lines/${lineId}/ws/paper/compile`),
  data: (lineId: string) => call<LineData>('GET', `/api/lines/${lineId}/data`),
  nvJob: (id: number) => call<NvJobFull>('GET', `/api/nvidb/jobs/${id}`),
  assistant: () => call<AssistantView>('GET', '/api/assistant'),
  assistantPage: (page: PageCtx) => call<{ ok: boolean }>('POST', '/api/assistant/page', { page }),
  assistantSay: (text: string, page: PageCtx | null) => call<AgentEvent>('POST', '/api/assistant/say', { text, page }),
  // an agent's conversations in Paseo: the list, a new one, going back to one
  runChecks: (lineId: string) => call<unknown>('POST', `/api/lines/${lineId}/checks/run`, undefined, kept),
  setCheck: (lineId: string, id: string, b: CheckEdit) => call<unknown>('PUT', `/api/lines/${lineId}/checks/${id}`, b, kept),
  askCheck: (lineId: string, id: string) => call<{ ok: boolean }>('POST', `/api/lines/${lineId}/checks/${id}/ask`),
  canvas: (lineId: string) => call<CanvasView>('GET', `/api/lines/${lineId}/canvas`, undefined, kept),
  addNode: (lineId: string, b: NewNode) => call<CanvasView>('POST', `/api/lines/${lineId}/canvas/nodes`, b, kept),
  setNode: (lineId: string, id: string, b: { title?: string; text?: string; to?: TaskTo; status?: 'draft' | 'done'; stale?: false }) =>
    call<CanvasView>('PUT', `/api/lines/${lineId}/canvas/nodes/${encodeURIComponent(id)}`, b, kept),
  dropNode: (lineId: string, id: string) => call<CanvasView>('DELETE', `/api/lines/${lineId}/canvas/nodes/${encodeURIComponent(id)}`, undefined, kept),
  sendNode: (lineId: string, id: string, chain = false) => call<CanvasView>('POST', `/api/lines/${lineId}/canvas/nodes/${encodeURIComponent(id)}/send`, { chain }, kept),
  bindNode: (lineId: string, id: string, options: StartOpts & { ext_id?: string }) =>
    call<CanvasView>('POST', `/api/lines/${lineId}/canvas/nodes/${encodeURIComponent(id)}/agent`, options, kept),
  backNode: (lineId: string, id: string, text: string) => call<CanvasView>('POST', `/api/lines/${lineId}/canvas/nodes/${encodeURIComponent(id)}/back`, { text }, kept),
  labelEdge: (lineId: string, id: string, label: string) => call<CanvasView>('PUT', `/api/lines/${lineId}/canvas/edges/${encodeURIComponent(id)}`, { label }, kept),
  orderEdge: (lineId: string, id: string, b: { order?: boolean; flip?: boolean }) => call<CanvasView>('PUT', `/api/lines/${lineId}/canvas/edges/${encodeURIComponent(id)}`, b, kept),
  setLoopRules: (lineId: string, exclusive: boolean) => call<CanvasView>('PUT', `/api/lines/${lineId}/canvas/rules`, { exclusive }, kept),
  restoreNode: (lineId: string, id: string) => call<CanvasView>('POST', `/api/lines/${lineId}/canvas/nodes/${encodeURIComponent(id)}/restore`, undefined, kept),
  // blocks: where slots go, said outright (a block dragged by its header; a layout put back, with w and h). The answer: the tasks and
  // notes that changed block by where they were dropped (mods), and the slots that went with nodes that all moved together (blocks)
  moveNodes: (lineId: string, at: Record<string, [number, number]>, blocks?: Record<string, number[]>) =>
    call<{ ok: boolean; mods: Record<string, FlowPart>; blocks: Record<string, number[]>; at: Record<string, [number, number]> }>('POST', `/api/lines/${lineId}/canvas/move`, { at, blocks }),
  connect: (lineId: string, source: string, target: string) => call<CanvasView>('POST', `/api/lines/${lineId}/canvas/edges`, { source, target }, kept),
  disconnect: (lineId: string, id: string) => call<CanvasView>('DELETE', `/api/lines/${lineId}/canvas/edges/${encodeURIComponent(id)}`, undefined, kept),
  tidyCanvas: (lineId: string) => call<CanvasView>('POST', `/api/lines/${lineId}/canvas/tidy`, undefined, kept),
  gateAct: (lineId: string, stage: string, what: 'open' | 'close' | 'rework' | 'more' | 'waive') =>
    call<CanvasView>('POST', `/api/lines/${lineId}/canvas/gates/${stage}`, { what }, kept),
  setLoop: (lineId: string, stage: string, b: { auto?: boolean; rounds?: number }) => call<unknown>('PUT', `/api/lines/${lineId}/loops/${stage}`, b, kept),
  askAll: (lineId: string) => call<{ ok: boolean; n: number }>('POST', `/api/lines/${lineId}/checks/ask`),
  loopReport: (lineId: string) => call<{ markdown: string; html: string; title: string }>('GET', `/api/lines/${lineId}/canvas/report`),
  publishReport: (lineId: string) => call<{ id: string; title: string }>('POST', `/api/lines/${lineId}/canvas/report`),
  convs: (id: string) => call<{ conversations: AssistantConv[] }>('GET', `/api/agents/${id}/conversations`),
  newConv: (id: string) => call<Agent>('POST', `/api/agents/${id}/conversations/new`),
  resumeConv: (id: string, ext: string) => call<Agent>('POST', `/api/agents/${id}/conversations/${encodeURIComponent(ext)}`),
  decide: (id: number, allow: boolean) => call<AgentEvent>('POST', `/api/assistant/acts/${id}`, { allow }),
};

export const fileUrl = (lineId: string, name: string) => (DEMO ? demoFile(lineId, name) : `/api/lines/${lineId}/files/${name}`);
export const linkedPdfUrl = (lineId: string) => `/api/lines/${lineId}/linked/pdf`;
// v changes the URL so the viewer loads the PDF again
export const paperPdfUrl = (lineId: string, v = 0) => (DEMO ? demoFile(lineId, 'main.pdf') : `/api/lines/${lineId}/ws/paper/pdf?v=${v}`);

export type ServerEvent = { id: number | string; type: string; ts: string; [k: string]: any };

const listeners = new Set<(e: ServerEvent) => void>();

// Lets components receive the events subscribe() reads.
export function listen(fn: (e: ServerEvent) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// One EventSource for the app; the browser reconnects on its own.
export function subscribe(onEvent: (e: ServerEvent) => void, onState: (ok: boolean) => void): () => void {
  if (DEMO) { onState(true); return () => {}; }
  const es = new EventSource('/api/events');
  const types = ['line', 'message', 'trace', 'world', 'building', 'skills', 'library', 'item',
    'job', 'agent', 'agent_event', 'agent_delta', 'agent_live', 'terminal', 'assistant_show', 'report', 'paseo_models', 'card', 'card_layout', 'memory', 'page', 'checks', 'canvas', 'usage'];
  for (const t of types) es.addEventListener(t, ev => {
    const e = localize(JSON.parse((ev as MessageEvent).data), KEEP_EVENT[t]);
    onEvent(e);
    for (const fn of listeners) fn(e);
  });
  es.onopen = () => onState(true);
  es.onerror = () => onState(false);
  return () => es.close();
}
