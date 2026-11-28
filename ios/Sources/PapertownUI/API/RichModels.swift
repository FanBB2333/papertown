import Foundation
import PapertownCore
import TelettyKit

// Models for the pages beyond the inbox: a project's card, gates, outputs, workspace and usage; the town's library,
// compute and quotas; conversations read through /timeline and terminal screens. Field names follow web/src/api.ts.
// Everything a server release might leave out is optional, so an older or newer server still decodes.

// MARK: - World

public struct HudInfo: Decodable, Sendable, Equatable {
    public struct Lines: Decodable, Sendable, Equatable { public let running: Int; public let total: Int }
    public struct Leads: Decodable, Sendable, Equatable {
        public let on: Int
        public let running: Int
        public var blocked: Int? = nil
    }
    public let day: Int?
    public let lines: Lines
    public let leads: Leads
    public let library: Int?
}

public struct WorldSnapshot: Decodable, Sendable {
    public let hud: HudInfo
}

// MARK: - Project card (the 进展 page)

public struct CardMetric: Decodable, Sendable, Equatable, Hashable {
    public let name: String
    public let value: String
    public let note: String?
}

public struct CardOutput: Decodable, Sendable, Equatable, Hashable {
    public let name: String
    public let due: String?
    public let state: String
}

public struct CardPlan: Decodable, Sendable, Equatable, Hashable {
    public let name: String
    public let goal: String?
    public let when: String?
}

public struct ProgressCard: Decodable, Sendable, Equatable {
    public let summary: String
    public let health: String
    public let progress: Int?
    public let milestone: String?
    public let done: [String]
    public let next: [String]
    public let blockers: [String]
    public let needYou: [String]
    public let metrics: [CardMetric]
    public let plans: [CardPlan]
    public let outputs: [CardOutput]
    public let at: String?
    public let by: String?

    enum CodingKeys: String, CodingKey {
        case summary, health, progress, milestone, done, next, blockers, metrics, plans, outputs, at, by
        case needYou = "need_you"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        summary = (try? c.decode(String.self, forKey: .summary)) ?? ""
        health = (try? c.decode(String.self, forKey: .health)) ?? "ok"
        progress = try? c.decodeIfPresent(Int.self, forKey: .progress)
        milestone = try? c.decodeIfPresent(String.self, forKey: .milestone)
        done = (try? c.decode([String].self, forKey: .done)) ?? []
        next = (try? c.decode([String].self, forKey: .next)) ?? []
        blockers = (try? c.decode([String].self, forKey: .blockers)) ?? []
        needYou = (try? c.decode([String].self, forKey: .needYou)) ?? []
        metrics = (try? c.decode([CardMetric].self, forKey: .metrics)) ?? []
        plans = (try? c.decode([CardPlan].self, forKey: .plans)) ?? []
        outputs = (try? c.decode([CardOutput].self, forKey: .outputs)) ?? []
        at = try? c.decodeIfPresent(String.self, forKey: .at)
        by = try? c.decodeIfPresent(String.self, forKey: .by)
    }
}

public struct CheckCounts: Decodable, Sendable, Equatable {
    public let pass: Int
    public let warn: Int
    public let fail: Int
    public let none: Int
    public let wait: Int
    public let total: Int
}

public struct CardRun: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    public let `where`: String?
    public let progress: Double?
    public let since: String?
}

public struct CardRepo: Decodable, Sendable, Equatable {
    public let path: String
    public let name: String
    public let missing: Bool?
    public let git: Bool?
    public let branch: String?
    public let dirty: Int?
    public let main: String?
    public let title: String?
    public let words: Int?
    public let pdf: Bool?
}

public struct MemoryCounts: Decodable, Sendable, Equatable {
    public let sessions: Int
    public let notes: Int
    public let messages: Int
    public let at: String?
}

public struct ProjectCardView: Decodable, Sendable {
    public struct LineRef: Decodable, Sendable {
        public let id: String
        public let seq: Int
        public let title: String
        public let status: String
        public let usageState: String?
        enum CodingKeys: String, CodingKey { case id, seq, title, status; case usageState = "usage_state" }
    }
    public struct Repos: Decodable, Sendable {
        public let code: CardRepo?
        public let paper: CardRepo?
    }
    public struct Checks: Decodable, Sendable { public let hard: CheckCounts; public let soft: CheckCounts }
    public struct Pending: Decodable, Sendable { public let at: String?; public let note: String? }

    public let line: LineRef
    public let card: ProgressCard?
    public let prev: Int?
    public let pending: Pending?
    public let asks: Int?
    public let running: [CardRun]?
    public let queued: [CardRun]?
    public let repos: Repos?
    public let memory: MemoryCounts?
    public let checks: Checks?
    /// What its agents wait on you for (servers before 待你决定 leave it out).
    public var decisions: [Decision]? = nil
    public var lead: CardLead? = nil
    public var decided: DecidedStats? = nil
    public var prov: ProvStats? = nil
    enum CodingKeys: String, CodingKey { case line, card, prev, pending, asks, running, queued, repos, memory, checks, decisions, lead, decided, prov }
}

public struct CardsResponse: Decodable, Sendable {
    public let cards: [ProjectCardView]
}

// MARK: - Checks and gates

public struct CheckParam: Decodable, Sendable, Equatable, Hashable {
    public let key: String
    public let value: Double
    public let label: String
}

public struct CheckFinding: Decodable, Sendable, Equatable, Hashable {
    public let file: String?
    public let line: Int?
    public let text: String?
    public let hit: String?
    public let hint: String?
}

public struct CheckResult: Decodable, Sendable, Equatable {
    public let status: String
    public let value: Double?
    public let ts: String?
    public let by: String?
    public let note: String?
    public let findings: [CheckFinding]?
    public let total: Int?
}

public struct CheckPoint: Decodable, Sendable, Equatable, Hashable {
    public let ts: String
    public let status: String
    public let value: Double?
}

public struct ResearchCheck: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let kind: String
    public let stage: String
    public let title: String
    public let prio: String?
    public let rule: String?
    public let text: String?
    public let unit: String?
    public let params: [CheckParam]?
    public let custom: Bool?
    public let on: Bool
    public let last: CheckResult?
    public let history: [CheckPoint]?
    public let gate: String?
    public let asked: String?
    /// A hard check's allowance, a soft check's hours between rounds.
    public var max: Double? = nil
    public var every: Double? = nil
    /// A sentinel whose next round is due.
    public var due: Bool? = nil

    /// pass, warn, fail, none (not run yet) or wait (a sentinel waiting for its turn); off when switched off.
    public var status: String { on ? (last?.status ?? (kind == "soft" ? "wait" : "none")) : "off" }
}

public struct ChecksView: Decodable, Sendable {
    public struct Summary: Decodable, Sendable { public let hard: CheckCounts; public let soft: CheckCounts }
    public let stages: [StageInfo]?
    public let checks: [ResearchCheck]
    public let summary: Summary
    public let rounds: Int?
    public let ran: String?
}

// MARK: - Stage outputs (GET /api/lines/{id} → outputs)

public struct PaperCard: Decodable, Sendable, Equatable, Identifiable, Hashable {
    public var id: String { paperID }
    public let paperID: String
    public let arxivID: String?
    public let title: String
    public let year: String?
    public let authors: String?
    public let snippet: String?
    public let url: String?
    public let tags: [String]?
    public let topic: String?
    public let similarity: Double?
    public let note: String?
    public let closest: Bool?
    public let matched: [String]?

    enum CodingKeys: String, CodingKey {
        case title, year, authors, snippet, url, tags, topic, similarity, note, closest, matched
        case paperID = "paper_id"
        case arxivID = "arxiv_id"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        paperID = try c.decode(String.self, forKey: .paperID)
        arxivID = try? c.decodeIfPresent(String.self, forKey: .arxivID)
        title = (try? c.decode(String.self, forKey: .title)) ?? paperID
        // a year arrives as text from the library and as a number from some sources
        if let y = try? c.decodeIfPresent(String.self, forKey: .year) { year = y }
        else if let y = try? c.decodeIfPresent(Int.self, forKey: .year) { year = String(y) }
        else { year = nil }
        authors = try? c.decodeIfPresent(String.self, forKey: .authors)
        snippet = try? c.decodeIfPresent(String.self, forKey: .snippet)
        url = try? c.decodeIfPresent(String.self, forKey: .url)
        tags = try? c.decodeIfPresent([String].self, forKey: .tags)
        topic = try? c.decodeIfPresent(String.self, forKey: .topic)
        similarity = try? c.decodeIfPresent(Double.self, forKey: .similarity)
        note = try? c.decodeIfPresent(String.self, forKey: .note)
        closest = try? c.decodeIfPresent(Bool.self, forKey: .closest)
        matched = try? c.decodeIfPresent([String].self, forKey: .matched)
    }
}

public struct HatchOutput: Decodable, Sendable, Equatable {
    public let verdict: String?
    public let summary: String?
    public let gap: String?
    public let suggestions: [String]?
}

public struct BaselineRef: Decodable, Sendable, Equatable, Hashable {
    public let name: String
    public let source: String?

    public init(from decoder: Decoder) throws {
        // a baseline is a name, or {name, source}
        if let s = try? decoder.singleValueContainer().decode(String.self) { name = s; source = nil; return }
        enum K: String, CodingKey { case name, source }
        let c = try decoder.container(keyedBy: K.self)
        name = (try? c.decode(String.self, forKey: .name)) ?? ""
        source = try? c.decodeIfPresent(String.self, forKey: .source)
    }
}

public struct MethodOutput: Decodable, Sendable, Equatable {
    public let title: String?
    public let problem: String?
    public let mechanism: [String]?
    public let baselines: [BaselineRef]?
    public let datasets: [String]?
    public let metrics: [String]?
    public let risks: [String]?
}

public struct ResultRow: Decodable, Sendable, Equatable, Hashable {
    public let method: String
    public let values: [Double?]
    public let ours: Bool?
}

public struct ResultsTable: Decodable, Sendable, Equatable {
    public let metrics: [String]
    public let rows: [ResultRow]
    public let simulated: Bool?
    public let analysis: String?
    public let concerns: [String]?
    public let seeds: Int?
    public let sample: Bool?
}

public struct WriteOutput: Decodable, Sendable, Equatable {
    public let title: String?
    public let abstract: String?
    public let sections: [String: String]?
}

public struct PeerReview: Decodable, Sendable, Equatable, Hashable {
    public let persona: String?
    public let scores: [String: Double]?
    public let overall: Double?
    public let strengths: [String]?
    public let weaknesses: [String]?
    public let decision: String?
}

public struct ReviewOutput: Decodable, Sendable, Equatable {
    public struct Format: Decodable, Sendable, Equatable {
        public let ok: Bool?
        public let summary: String?
        public let issues: [String]?
    }
    public let reviews: [PeerReview]?
    public let format: Format?
    public let mean: Double?
    public let verdict: String?
    public let feedback: [String]?
}

public struct ShipOutput: Decodable, Sendable, Equatable {
    public let zip: String?
    public let files: [String]?
}

/// What each stage produced. A stage whose output does not decode is left out rather than failing the project.
public struct ProjectOutputs: Decodable, Sendable, Equatable {
    public let idea: String?
    public let hatch: HatchOutput?
    public let method: MethodOutput?
    public let exp: ResultsTable?
    public let write: WriteOutput?
    public let review: ReviewOutput?
    public let ship: ShipOutput?

    enum CodingKeys: String, CodingKey { case idea, hatch, method, exp, write, review, ship }
    enum IdeaKeys: String, CodingKey { case text }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        idea = (try? c.nestedContainer(keyedBy: IdeaKeys.self, forKey: .idea)).flatMap { try? $0.decodeIfPresent(String.self, forKey: .text) }
        hatch = try? c.decodeIfPresent(HatchOutput.self, forKey: .hatch)
        method = try? c.decodeIfPresent(MethodOutput.self, forKey: .method)
        exp = try? c.decodeIfPresent(ResultsTable.self, forKey: .exp)
        write = try? c.decodeIfPresent(WriteOutput.self, forKey: .write)
        review = try? c.decodeIfPresent(ReviewOutput.self, forKey: .review)
        ship = try? c.decodeIfPresent(ShipOutput.self, forKey: .ship)
    }
}

public struct PapersView: Decodable, Sendable {
    public let survey: [PaperCard]
    public let references: [PaperCard]
}

// MARK: - Experiments and data

public struct DataRun: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    public let state: String
    public let `where`: String?
    public let startedAt: String?
    public let finishedAt: String?
    public let elapsedS: Double?
    public let exitCode: Int?
    public var prov: [RunProv]? = nil

    enum CodingKeys: String, CodingKey {
        case id, name, state, `where`, prov
        case startedAt = "started_at"
        case finishedAt = "finished_at"
        case elapsedS = "elapsed_s"
        case exitCode = "exit_code"
    }
}

public struct LineData: Decodable, Sendable {
    public struct Meta: Decodable, Sendable {
        public let datasets: [String]?
        public let metrics: [String]?
        public let baselines: [String]?
        public let seeds: Int?
        public let gpuHours: Double?
        public let backend: String?
        enum CodingKeys: String, CodingKey { case datasets, metrics, baselines, seeds, backend; case gpuHours = "gpu_hours" }
    }
    public struct DataFile: Decodable, Sendable, Equatable, Hashable {
        public let path: String
        public let size: Int?
        public let kind: String?
    }
    public let meta: Meta?
    public let results: ResultsTable?
    public let runs: [DataRun]?
    public let files: [DataFile]?
}

public struct JobBackend: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    public let ready: Bool
    public let note: String?
    public let active: Int?
}

public struct TownJob: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let lineID: String?
    public let name: String
    public let backend: String
    public let status: String
    public let progress: Double?
    public let command: String?
    public let note: String?
    public let submittedBy: String?
    public let createdAt: String?
    public let startedAt: String?
    public let endedAt: String?
    public let log: String?

    enum CodingKeys: String, CodingKey {
        case id, name, backend, status, progress, command, note, log
        case lineID = "line_id"
        case submittedBy = "submitted_by"
        case createdAt = "created_at"
        case startedAt = "started_at"
        case endedAt = "ended_at"
    }
}

public struct JobBoard: Decodable, Sendable {
    public let jobs: [TownJob]
    public let backends: [JobBackend]?
}

// MARK: - Workspace

public struct WorkspacePlace: Decodable, Sendable, Equatable {
    public let path: String
    public let name: String
    public let git: Bool?
    public let branch: String?
    public let dirty: Int?
    public let main: String?
    public let pdf: Bool?
}

public struct WorkspaceInfo: Decodable, Sendable {
    public let linked: Bool?
    public let latexmk: Bool?
    public let code: WorkspacePlace?
    public let paper: WorkspacePlace?
}

public struct WorkspaceEntry: Decodable, Sendable, Equatable, Hashable, Identifiable {
    public var id: String { path }
    public let path: String
    public let size: Int?
    public let status: String?
}

public struct WorkspaceTree: Decodable, Sendable {
    public let root: String
    public let files: [WorkspaceEntry]
    public let truncated: Bool?
}

public struct WorkspaceFile: Decodable, Sendable {
    public let path: String
    public let size: Int?
    public let binary: Bool?
    public let tooBig: Bool?
    public let text: String?
    enum CodingKeys: String, CodingKey { case path, size, binary, text; case tooBig = "too_big" }
}

public struct CompileResult: Decodable, Sendable {
    public let ok: Bool
    public let log: String?
    public let pages: Int?
    public let seconds: Double?
}

// MARK: - Usage

public struct UsageTokens: Decodable, Sendable, Equatable {
    public let input: Int?
    public let output: Int?
    public let cacheRead: Int?
    public let cacheWrite: Int?
    enum CodingKeys: String, CodingKey { case input, output; case cacheRead = "cache_read"; case cacheWrite = "cache_write" }

    public var total: Int { (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0) }
}

public struct UsageWindow: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let label: String
    public let group: String?
    public let used: Double
    public let left: Double?
    public let resetsAt: String?
    enum CodingKeys: String, CodingKey { case id, label, group, used, left; case resetsAt = "resets_at" }
}

public struct UsageBalance: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let label: String
    public let unit: String?
    public let used: Double?
    public let remaining: Double?
    public let limit: Double?
}

public struct UsageProvider: Decodable, Sendable, Equatable, Identifiable {
    public struct Week: Decodable, Sendable, Equatable {
        public let cost: Double?
        public let projects: Int?
        public let tokens: UsageTokens?
    }
    public let id: String
    public let label: String
    public let plan: String?
    public let status: String
    public let error: String?
    public let notes: [String]?
    public let fetchedAt: String?
    public let windows: [UsageWindow]
    public let balances: [UsageBalance]?
    public let week: Week?
    enum CodingKeys: String, CodingKey {
        case id, label, plan, status, error, notes, windows, balances, week
        case fetchedAt = "fetched_at"
    }
}

public struct UsageView: Decodable, Sendable {
    public let polledAt: String?
    public let nextAt: String?
    public let providers: [UsageProvider]
    public let logs: Bool?
    public let logError: String?
    enum CodingKeys: String, CodingKey {
        case providers, logs
        case polledAt = "polled_at"
        case nextAt = "next_at"
        case logError = "log_error"
    }
}

public struct LineUsage: Decodable, Sendable {
    public struct ModelCost: Decodable, Sendable, Equatable, Hashable {
        public let provider: String
        public let model: String
        public let cost: Double
        public let priced: Bool?
    }
    public let budget: Double?
    public let spent: Double
    public let state: String
    public let since: String?
    public let week: Double?
    public let logs: Bool?
    public let models: [ModelCost]?
}

// MARK: - Compute

public struct GpuCard: Decodable, Sendable, Equatable, Hashable {
    public let index: Int?
    public let name: String?
    public let memUsedMB: Double?
    public let memTotalMB: Double?
    public let utilPercent: Double?
    enum CodingKeys: String, CodingKey {
        case index, name
        case memUsedMB = "mem_used_mb"
        case memTotalMB = "mem_total_mb"
        case utilPercent = "util_percent"
    }
}

public struct GpuNode: Decodable, Sendable, Equatable, Identifiable {
    public var id: String { name }
    public let name: String
    public let state: String?
    public let enabled: Bool?
    public let lastError: String?
    public let gpus: [GpuCard]?
    enum CodingKeys: String, CodingKey { case name, state, enabled, gpus; case lastError = "last_error" }
}

public struct GpuStatus: Decodable, Sendable {
    public struct Summary: Decodable, Sendable {
        public let nodes: Int?
        public let up: Int?
        public let gpus: Int?
        public let idle: Int?
        public let freeMB: Double?
        public let totalMB: Double?
        enum CodingKeys: String, CodingKey { case nodes, up, gpus, idle; case freeMB = "free_mb"; case totalMB = "total_mb" }
    }
    public let ok: Bool
    public let note: String?
    public let at: String?
    public let nodes: [GpuNode]
    public let summary: Summary?
    public let alerts: Int?
}

public struct Department: Decodable, Sendable, Identifiable {
    public struct LineAt: Decodable, Sendable, Identifiable {
        public let id: String
        public let seq: Int
        public let title: String
        public let pct: Int?
        public let stage: String?
    }
    public let id: String
    public let type: String?
    public let name: String
    public let district: String?
    public let state: String
    public let job: String?
    public let lines: [LineAt]
    public let jobs: [TownJob]?
}

// MARK: - Library

public struct RagView: Decodable, Sendable {
    public struct Stats: Decodable, Sendable { public let papers: Int; public let terms: Int? }
    public let stats: Stats
    public let index: String?
}

public struct RagResult: Decodable, Sendable {
    public let query: String
    public let expanded: String?
    public let terms: [String]?
    public let method: String?
    public let hits: [PaperCard]
}

public struct LibraryShelf: Decodable, Sendable {
    public struct Topic: Decodable, Sendable, Hashable { public let label: String; public let n: Int }
    public let total: Int
    public let topics: [Topic]?
    public let papers: [PaperCard]
}

public struct McpServer: Decodable, Sendable, Identifiable, Equatable {
    public struct Tool: Decodable, Sendable, Hashable, Equatable { public let name: String; public let description: String? }
    public var id: String { name }
    public let name: String
    public let source: String?
    public let enabled: Bool
    public let state: String
    public let error: String?
    public let tools: [Tool]?
    public var command: String? = nil
    public var args: [String]? = nil
    /// The names of its environment variables; the values stay on the server.
    public var env: [String]? = nil
}

public struct McpView: Decodable, Sendable {
    public let servers: [McpServer]
}

public struct TownSkill: Decodable, Sendable, Identifiable, Equatable {
    public var id: String { name }
    public let name: String
    public let description: String?
    public let roles: [String]?
}

// MARK: - Conversations

/// One entry of a conversation read through /timeline: what was said, a tool call, an error or a note.
public struct TimelineItem: Decodable, Sendable, Equatable {
    public struct EventData: Decodable, Sendable, Equatable {
        public let eventID: Int?, origin: String?, decided: String?, userText: String?
        enum CodingKeys: String, CodingKey { case eventID = "event_id", origin, decided, userText = "user_text" }
    }
    public let ts: String?
    public let kind: String
    public let text: String?
    public let id: String?
    public let name: String?
    public let status: String?
    public let arg: String?
    public let error: String?
    public var eventID: Int? = nil
    public var origin: String? = nil
    public var decided: String? = nil
    public var userText: String? = nil
    public var data: EventData? = nil
    enum CodingKeys: String, CodingKey { case ts, kind, text, id, name, status, arg, error, origin, decided, data, eventID = "event_id", userText = "user_text" }
}

public struct AgentTermInfo: Decodable, Sendable, Equatable {
    public let backend: String
    public let provider: String?
    public let status: String
    public let since: String?
    public let tool: String?
    public let model: String?
    public let note: String?
    /// Whether what you type goes straight into the terminal: Papertown's own tmux and headless ones, not herdr's.
    public let typing: Bool?
}

public typealias TermOption = TelettyKit.TermOption
public typealias TermPrompt = TelettyKit.TermPrompt

public struct TranscriptState: Decodable, Sendable, Equatable {
    public let ok: Bool
    public let note: String?
    /// The conversation's title as the CLI named it.
    public let title: String?
    /// How full the context is after the last reply.
    public let context: TranscriptContext?
}

/// The tokens the model last read and wrote, and its context window where the CLI logs it (Codex does, Claude Code
/// does not).
public struct TranscriptContext: Decodable, Sendable, Equatable {
    public let used: Int
    public let window: Int?

    public var fraction: Double? { window.map { Double(used) / Double(max($0, 1)) } }
}

/// What one CLI session has used so far: its tokens and their cost at API prices (`priced` is false when a model has
/// no price).
public struct SessionUsage: Decodable, Sendable, Equatable {
    public let cost: Double
    public let tokens: Int
    public let priced: Bool
}

/// Where the CLI works: the branch, how many files have changed and how far it is ahead of and behind its upstream
/// (nil where git could not tell).
public struct GitState: Decodable, Sendable, Equatable {
    public let branch: String
    public let changed: Int?
    public let ahead: Int?
    public let behind: Int?
}

/// A subscription window ("5h", "7d"): the percentage used and when it resets.
public struct UsageLimit: Decodable, Sendable, Equatable {
    public let window: String
    public let used: Double
    public let resetsAt: String?

    enum CodingKeys: String, CodingKey {
        case window, used
        case resetsAt = "resets_at"
    }
}

/// A file kept on the server to go with the next message.
public struct UploadedFile: Decodable, Sendable, Equatable {
    public let id: String
    public let name: String
    public let path: String
    public let kind: String
}

public struct AgentTimeline: Decodable, Sendable {
    public struct Paseo: Decodable, Sendable { public let permissions: [PermissionPrompt]? }
    public let agent: StaffAgent
    public let items: [TimelineItem]
    public let queued: [AgentEvent]?
    public let paseo: Paseo?
    public let transcript: TranscriptState?
    public let usage: SessionUsage?
    public let git: GitState?
    public let limits: [UsageLimit]?
}

/// GET /api/agents/{id}/models: the model the conversation is on and the ones it can switch to. `how` is "resume" for a
/// terminal CLI (closed and resumed on its session) and "none" where switching is not offered.
public struct AgentModels: Decodable, Sendable, Equatable {
    public struct Current: Decodable, Sendable, Equatable {
        public let provider: String
        public let model: String
        public let thinking: String
    }
    public let how: String
    public let current: Current?
    public let models: [PaseoModel]
}

public struct AgentScreen: Decodable, Sendable {
    public let text: String
    public let term: AgentTermInfo?
    public let prompt: TermPrompt?
    /// With `styled`: the screen's colours, read by the server so the web and the app draw it alike.
    public let lines: [[ScreenRun]]?
    public let styles: [ScreenStyle]?
    public let theme: ScreenTheme?

    public var styled: StyledScreen? {
        guard let lines, let styles, let theme else { return nil }
        return StyledScreen(lines: lines, styles: styles, theme: theme)
    }
}

public typealias ScreenRun = TelettyKit.ScreenRun
public typealias ScreenStyle = TelettyKit.ScreenStyle
public typealias ScreenTheme = TelettyKit.ScreenTheme
public typealias StyledScreen = TelettyKit.StyledScreen
public typealias ScreenNow = TelettyKit.ScreenNow
public typealias ScreensNow = TelettyKit.ScreensNow

/// An agent history read through GET /api/agents/{id}, with the agent in full.
public struct AgentEvents: Decodable, Sendable {
    public let agent: StaffAgent
    public let events: [AgentEvent]
}

// MARK: - Terminals (herdr and tmux sessions the town watches)

public struct TerminalInfo: Decodable, Sendable, Identifiable, Equatable {
    public let id: String
    public let name: String?
    public let kind: String?
    public let title: String
    public let cwd: String?
    public let watch: WatchInfo?
}

public struct TerminalQueueItem: Decodable, Sendable, Equatable, Identifiable {
    public let id: Int
    public let text: String
    public let state: String
}

public struct TerminalDetail: Decodable, Sendable {
    public let terminal: TerminalInfo
    public let text: String
    public let queued: [TerminalQueueItem]?
    public let prompt: TermPrompt?
    public let lines: [[ScreenRun]]?
    public let styles: [ScreenStyle]?
    public let theme: ScreenTheme?

    public var styled: StyledScreen? {
        guard let lines, let styles, let theme else { return nil }
        return StyledScreen(lines: lines, styles: styles, theme: theme)
    }
}

public struct TerminalTimeline: Decodable, Sendable {
    public let terminal: TerminalInfo
    public let items: [TimelineItem]
    public let transcript: TranscriptState?
    public let usage: SessionUsage?
    public let git: GitState?
    public let limits: [UsageLimit]?
}

// MARK: - Decisions and the work based on them

extension KeyedDecodingContainer {
    /// Report and event IDs are integers in their own tables and strings in some references.
    func decodeIfPresentID(forKey key: Key) throws -> String? {
        if let number = try? decode(Int.self, forKey: key) { return String(number) }
        return try decodeIfPresent(String.self, forKey: key)
    }
}

public struct DecisionMaterial: Codable, Sendable, Equatable {
    public let kind: String?
    public let ref: String?
    public let title: String?
    enum CodingKeys: String, CodingKey { case kind, ref, title }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decodeIfPresent(String.self, forKey: .kind)
        ref = try c.decodeIfPresentID(forKey: .ref)
        title = try c.decodeIfPresent(String.self, forKey: .title)
    }
}

/// The same facts and options accompany an open report and the decision that answered it.
public struct Matter: Decodable, Sendable, Equatable {
    public let id: Int?
    public let agent: String?
    public let who: String?
    public let question: String?
    public let mod: String?
    public let facts: [String]?
    public let options: [String]?
    public let materials: [DecisionMaterial]?
    public let since: String?
    enum CodingKeys: String, CodingKey { case id, agent, who, question, mod, facts, options, materials, since }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresentID(forKey: .id).flatMap(Int.init)
        agent = try c.decodeIfPresent(String.self, forKey: .agent)
        who = try c.decodeIfPresent(String.self, forKey: .who)
        question = try c.decodeIfPresent(String.self, forKey: .question)
        mod = try c.decodeIfPresent(String.self, forKey: .mod)
        facts = try c.decodeIfPresent([String].self, forKey: .facts)
        options = try c.decodeIfPresent([String].self, forKey: .options)
        materials = try c.decodeIfPresent([DecisionMaterial].self, forKey: .materials)
        since = try c.decodeIfPresent(String.self, forKey: .since)
    }
}

public struct DecidedRecord: Decodable, Sendable, Identifiable {
    public let id: String?
    public let n: Int?
    public let mod: String?
    public let text: String?
    public let source: String?
    public let ref: JSONValue?
    public let state: String?
    public let replaces: String?
    public let replacedBy: String?
    public let materials: [DecisionMaterial]?
    public let matter: Matter?
    public let createdAt: String?
    public let endedAt: String?
    public let counts: [String: Int]?
    public let work: WorkList?
    enum CodingKeys: String, CodingKey {
        case id, n, mod, text, source, ref, state, replaces, materials, matter, counts, work
        case replacedBy = "replaced_by", createdAt = "created_at", endedAt = "ended_at"
    }
    var number: String { n.map { "D\($0)" } ?? id ?? "" }
    var isActive: Bool { state == nil || state == "active" }
}

public struct Work: Decodable, Sendable {
    public let kind: String?
    public let id: String?
    public let title: String?
    public let who: String?
    public let at: String?
    public let basis: [String]?
    public let agent: String?
    public let stage: String?
    enum CodingKeys: String, CodingKey { case kind, id, title, who, at, basis, agent, stage }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresentID(forKey: .id)
        kind = try c.decodeIfPresent(String.self, forKey: .kind)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        who = try c.decodeIfPresent(String.self, forKey: .who)
        at = try c.decodeIfPresent(String.self, forKey: .at)
        basis = try c.decodeIfPresent([String].self, forKey: .basis)
        agent = try c.decodeIfPresent(String.self, forKey: .agent)
        stage = try c.decodeIfPresent(String.self, forKey: .stage)
    }
}

public struct WorkList: Decodable, Sendable {
    public let jobs: [Work]?
    public let outputs: [Work]?
    public let tells: [Work]?
    public let tasks: [Work]?
    public let prov: [Work]?
    enum CodingKeys: String, CodingKey { case jobs, outputs, tells, tasks, prov }
    var all: [Work] { [jobs, outputs, tells, tasks, prov].flatMap { $0 ?? [] } }
}

public struct DecidedStats: Decodable, Sendable {
    public let total: Int?
    public let active: Int?
    public let anchored: Int?
    public let loose: Int?
    public let latest: [DecidedRecord]?
    enum CodingKeys: String, CodingKey { case total, active, anchored, loose, latest }
}

public struct DecidedModule: Decodable, Sendable {
    public let id: String?
    public let name: String?
    enum CodingKeys: String, CodingKey { case id, name }
    static let order = ["overview", "survey", "code", "exp", "data", "paper", "agents"]
}

public struct DecidedList: Decodable, Sendable {
    public let decisions: [DecidedRecord]?
    public let matters: [Matter]?
    public let loose: [Work]?
    public let stats: DecidedStats?
    public let mods: [DecidedModule]?
    enum CodingKeys: String, CodingKey { case decisions, matters, loose, stats, mods }

    func record(_ ref: String) -> DecidedRecord? {
        decisions?.first { $0.id == ref || $0.number == ref }
    }
}

// MARK: - Provenance

public struct RunProv: Decodable, Sendable, Equatable {
    public let id: String?, tag: String?, path: String?, state: String?
    public let used: Int?
    enum CodingKeys: String, CodingKey { case id, tag, path, state, used }
}

public struct ProvStats: Decodable, Sendable {
    public struct Floats: Decodable, Sendable {
        public let total: Int?, tagged: Int?
        enum CodingKeys: String, CodingKey { case total, tagged }
    }
    public struct Numbers: Decodable, Sendable {
        public let total: Int?, ok: Int?
        enum CodingKeys: String, CodingKey { case total, ok }
    }
    public let floats: Floats?, numbers: Numbers?
    public let changed: Int?, ops: Int?
    public let recent: [ProvOp]?
    enum CodingKeys: String, CodingKey { case floats, numbers, changed, ops, recent }
}

public struct ProvTree: Decodable, Sendable {
    public struct File: Decodable, Sendable {
        public let path: String?, title: String?
        public let sections: [Section]?
        enum CodingKeys: String, CodingKey { case path, title, sections }
    }
    public struct Section: Decodable, Sendable {
        public let title: String?, line: Int?
        public let nodes: [String]?, rest: [Rest]?
        enum CodingKeys: String, CodingKey { case title, line, nodes, rest }
    }
    public struct Rest: Decodable, Sendable {
        public let who: String?, lines: Int?
        enum CodingKeys: String, CodingKey { case who, lines }
    }
    public let stats: ProvStats?
    public let files: [File]?
    public let nodes: [String: ProvNode]?
    public let loose: [String]?
    enum CodingKeys: String, CodingKey { case stats, files, nodes, loose }
}

public struct ProvNode: Decodable, Sendable {
    public struct Span: Decodable, Sendable {
        public let start: Int?, end: Int?, text: String?
        enum CodingKeys: String, CodingKey { case start, end, text }
    }
    public struct Number: Decodable, Sendable {
        public let text: String?, ok: Bool?, locations: [String]?
        enum CodingKeys: String, CodingKey { case text, ok, `where` }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            text = try c.decodeIfPresent(String.self, forKey: .text)
            ok = try c.decodeIfPresent(Bool.self, forKey: .ok)
            if let path = try? c.decode(String.self, forKey: .where) { locations = [path] }
            else { locations = try c.decodeIfPresent([String].self, forKey: .where) }
        }
    }
    public struct Made: Decodable, Sendable {
        public let at: String?, agent: String?, role: String?, who: String?, model: String?, session: String?, how: String?
        public let job: Job?, basis: [String]?
        enum CodingKeys: String, CodingKey { case at, agent, role, who, model, session, how, job, basis }
    }
    public struct Job: Decodable, Sendable {
        public let id: String?, name: String?, command: String?, node: String?, cwd: String?, status: String?, startedAt: String?, endedAt: String?, op: String?
        enum CodingKeys: String, CodingKey { case id, name, command, node, cwd, status, op, startedAt = "started_at", endedAt = "ended_at" }
    }
    /// Detail endpoints may return a reference as an ID or with its display label.
    public struct Ref: Decodable, Sendable {
        public let id: String?, tag: String?, title: String?
        enum CodingKeys: String, CodingKey { case id, tag, title }

        public init(from decoder: Decoder) throws {
            if let key = try? decoder.singleValueContainer().decode(String.self) {
                id = key; tag = nil; title = nil
            } else {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                id = try c.decodeIfPresent(String.self, forKey: .id)
                tag = try c.decodeIfPresent(String.self, forKey: .tag)
                title = try c.decodeIfPresent(String.self, forKey: .title)
            }
        }
    }
    public let id: String?, tag: String?, kind: String?, title: String?, root: String?, path: String?
    public let span: Span?, blob: String?, op: String?, state: String?, made: Made?
    public let src: [String]?, numbers: [Number]?, gaps: [String]?, note: String?, createdAt: String?
    public let now: String?, then: String?, diff: String?, used: [Ref]?, history: [Ref]?
    enum CodingKeys: String, CodingKey {
        case id, tag, kind, title, root, path, span, blob, op, state, made, src, numbers, gaps, note, now, then, diff, used, history
        case createdAt = "created_at"
    }
}

public struct ProvOp: Decodable, Sendable, Identifiable {
    public struct File: Decodable, Sendable {
        public let path: String?, added: Int?, removed: Int?, diff: String?
        enum CodingKeys: String, CodingKey { case path, added, removed, diff }
    }
    public let id: String?, short: String?, root: String?, ts: String?, trigger: String?, agent: String?, role: String?, who: String?, session: String?
    public let basis: [String]?, fileCount: Int?, files: [File]?, added: Int?, removed: Int?, summary: String?
    enum CodingKeys: String, CodingKey { case id, short, root, ts, trigger, agent, role, who, session, basis, files, added, removed, summary }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id)
        short = try c.decodeIfPresent(String.self, forKey: .short)
        root = try c.decodeIfPresent(String.self, forKey: .root)
        ts = try c.decodeIfPresent(String.self, forKey: .ts)
        trigger = try c.decodeIfPresent(String.self, forKey: .trigger)
        agent = try c.decodeIfPresent(String.self, forKey: .agent)
        role = try c.decodeIfPresent(String.self, forKey: .role)
        who = try c.decodeIfPresent(String.self, forKey: .who)
        session = try c.decodeIfPresent(String.self, forKey: .session)
        basis = try c.decodeIfPresent([String].self, forKey: .basis)
        // The summary has a count, the detail lists the files under the same key.
        files = try? c.decode([File].self, forKey: .files)
        fileCount = (try? c.decode(Int.self, forKey: .files)) ?? files?.count
        added = try c.decodeIfPresent(Int.self, forKey: .added)
        removed = try c.decodeIfPresent(Int.self, forKey: .removed)
        summary = try c.decodeIfPresent(String.self, forKey: .summary)
    }
}

public struct ProvSnapshot: Decodable, Sendable {
    public let code: String?, paper: String?
}

public struct ProvBlame: Decodable, Sendable {
    public let start: Int?, end: Int?, op: String?, who: String?, role: String?, at: String?, node: String?
    public let commit: String?, author: String?, date: String?
    enum CodingKeys: String, CodingKey { case start, end, op, who, role, at, node, commit, author, date }
}
