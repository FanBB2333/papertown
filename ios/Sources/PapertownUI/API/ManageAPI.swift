import Foundation
import PapertownCore

// What the web app lets you change, and the models it reads for that: decisions on a project's card, asking its lead for
// a new card, the lead's rounds, imported memory, published pages, the budget, checks, the research loop's gates and
// tasks; hiring and starting staff, their conversations; and the town's settings (access, usage, models, skills, MCP,
// the library's search, work bounds, samples, the call trace). Field names follow web/src/api.ts and server/papertown/api.py.
// Anything a server release might leave out is optional, so an older or newer server still decodes.

private struct Empty: Codable {}
private struct Ack: Decodable {}

/// Reads a field that may be missing or of another shape without failing the whole object.
private extension KeyedDecodingContainer {
    func opt<T: Decodable>(_ key: Key) -> T? { (try? decodeIfPresent(T.self, forKey: key)) ?? nil }
}

// MARK: - Decisions (待你决定)

public struct DecisionOption: Decodable, Sendable, Equatable {
    public let label: String
    public let value: JSONValue
    public var main: Bool? = nil
}

/// Something a project's agents wait on, with the choices that settle it: a question from its lead (ask), a Paseo
/// permission request (permission), a dialog on a terminal (prompt), a line of its card (need). decisions.py.
public struct Decision: Decodable, Sendable, Equatable {
    public let kind: String
    public let id: String
    public let agent: String?
    public let who: String
    public let title: String
    public let detail: String
    public let options: [DecisionOption]
    public let free: Bool
    public var ready: Bool? = nil
    public var since: String? = nil
    public var later: Bool? = nil

    public var key: String { "\(kind):\(agent ?? ""):\(id)" }
}

public struct CardLead: Decodable, Sendable, Equatable {
    public var started: Bool? = nil
    public var model: String? = nil
}

public struct CardsUpdate: Decodable, Sendable {
    public struct Skip: Decodable, Sendable { public let lineID: String; public let why: String?
        enum CodingKeys: String, CodingKey { case lineID = "line_id"; case why } }
    public let sent: [String]
    public let skipped: [Skip]?
}

// MARK: - The lead's rounds

public struct LeadSettings: Decodable, Sendable, Equatable {
    public var on: Bool? = nil
    public var supervise: Bool? = nil
    public var every: Int? = nil
}

public struct LeadView: Decodable, Sendable {
    public let settings: LeadSettings
}

// MARK: - Memory

public struct MemoryItem: Decodable, Sendable, Identifiable, Equatable {
    public let id: String
    public let key: String
    public let source: String
    public let kind: String
    public let repo: String?
    public let title: String
    public var cwd: String? = nil
    public var started: String? = nil
    public var ended: String? = nil
    public var n: Int? = nil
    public var importedAt: String? = nil
    enum CodingKeys: String, CodingKey { case id, key, source, kind, repo, title, cwd, started, ended, n; case importedAt = "imported_at" }
}

public struct MemoryList: Decodable, Sendable {
    public let items: [MemoryItem]
    public let counts: MemoryCounts?
}

public struct MemoryMessage: Decodable, Sendable, Hashable {
    public let role: String
    public let text: String
    public let at: String?
}

public struct MemoryDetail: Decodable, Sendable {
    public let title: String
    public let source: String
    public let kind: String
    public var repo: String? = nil
    public var cwd: String? = nil
    public var n: Int? = nil
    public var started: String? = nil
    public var ended: String? = nil
    public var importedAt: String? = nil
    public var messages: [MemoryMessage]? = nil
    public var text: String? = nil
    enum CodingKeys: String, CodingKey { case title, source, kind, repo, cwd, n, started, ended, messages, text; case importedAt = "imported_at" }
}

/// What there is to import from the project's repositories on the server's machine.
public struct MemoryScan: Decodable, Sendable {
    public struct Found: Decodable, Sendable, Identifiable {
        public var id: String { key }
        public let key: String
        public let source: String
        public let kind: String
        public let repo: String?
        public let title: String
        public var started: String? = nil
        public var ended: String? = nil
        public var imported: Bool? = nil
        public var changed: Bool? = nil
    }
    public struct Root: Decodable, Sendable { public let repo: String; public let path: String }
    public let found: [Found]
    public var roots: [Root]? = nil
}

// MARK: - Pages the lead publishes

public struct PageMeta: Decodable, Sendable, Identifiable, Equatable {
    public let id: String
    public let n: Int
    public let title: String
    public let kind: String
    public var by: String? = nil
    public var at: String? = nil
}

public struct PagesList: Decodable, Sendable {
    public let pages: [PageMeta]
    public var kinds: [String: String]? = nil
}

// MARK: - Checks

public struct CheckEdit: Encodable, Sendable {
    public var on: Bool? = nil
    public var gate: String? = nil
    public var params: [String: Double]? = nil
    public var prompt: String? = nil
    public var every: Double? = nil
    public init(on: Bool? = nil, gate: String? = nil, params: [String: Double]? = nil, prompt: String? = nil, every: Double? = nil) {
        self.on = on; self.gate = gate; self.params = params; self.prompt = prompt; self.every = every
    }
}

// MARK: - Research loop (研究回路)

public struct LoopRef: Decodable, Sendable, Identifiable, Equatable, Hashable {
    public let id: String
    public let title: String
}

public struct LoopGate: Decodable, Sendable, Equatable {
    public struct Policy: Decodable, Sendable, Equatable { public let auto: Bool; public let rounds: Int }
    public let stage: String
    public let name: String?
    public let state: String
    public let pass: Int?
    public let total: Int?
    public let blocking: [LoopRef]?
    public let policy: Policy?
    public let ticket: String?
    public let ticketStatus: String?
    public let round: Int?
    public let escalated: Bool?
    public let waived: Bool?
    public let checks: [String]?
    public let open: Bool?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        stage = try c.decode(String.self, forKey: .stage)
        state = (c.opt(.state) as String?) ?? "none"
        name = c.opt(.name); pass = c.opt(.pass); total = c.opt(.total); blocking = c.opt(.blocking); policy = c.opt(.policy)
        ticket = c.opt(.ticket); ticketStatus = c.opt(.ticketStatus); round = c.opt(.round); escalated = c.opt(.escalated)
        waived = c.opt(.waived); checks = c.opt(.checks); open = c.opt(.open)
    }
    enum CodingKeys: String, CodingKey {
        case stage, name, state, pass, total, blocking, policy, ticket, round, escalated, waived, checks, open
        case ticketStatus = "ticket_status"
    }
}

public struct LoopLogEntry: Decodable, Sendable, Hashable {
    public var ts: String? = nil
    public var kind: String? = nil
    public var text: String? = nil
    public var by: String? = nil
}

public struct LoopHumanItem: Decodable, Sendable, Equatable {
    public let kind: String
    public var id: String? = nil
    public let text: String
    public var gate: String? = nil
}

/// A node of the loop. Only the parts the app shows are read; each kind fills its own.
public struct LoopNode: Decodable, Sendable, Identifiable, Equatable {
    public let id: String
    public let kind: String
    public let mod: String?
    public let title: String?
    public let text: String?
    public let status: String?
    public let to: String?
    public let note: String?
    public let pct: Double?
    public let gate: LoopGate?
    public let check: ResearchCheck?
    public let items: [LoopHumanItem]?
    public let sentAt: String?
    public let doneAt: String?
    public let result: JSONValue?
    public let waitNote: String?
    public let stale: String?
    public let agentID: String?
    public let loop: String?
    public let round: Int?
    public let log: [LoopLogEntry]?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decode(String.self, forKey: .kind)
        mod = c.opt(.mod); title = c.opt(.title); text = c.opt(.text); status = c.opt(.status); to = c.opt(.to)
        note = c.opt(.note); pct = c.opt(.pct); gate = c.opt(.gate); check = c.opt(.check); items = c.opt(.items)
        sentAt = c.opt(.sentAt); doneAt = c.opt(.doneAt); result = c.opt(.result); waitNote = c.opt(.waitNote)
        stale = c.opt(.stale); agentID = c.opt(.agentID); loop = c.opt(.loop); round = c.opt(.round); log = c.opt(.log)
    }
    enum CodingKeys: String, CodingKey {
        case id, kind, mod, title, text, status, to, note, pct, gate, check, items, result, stale, loop, round, log
        case sentAt = "sent_at", doneAt = "done_at", waitNote = "wait_note", agentID = "agent_id"
    }
}

public struct LoopView: Decodable, Sendable {
    public struct Rules: Decodable, Sendable { public var exclusive: Bool? = nil }
    public struct There: Decodable, Sendable { public var there: Bool? = nil; public var status: String? = nil; public var model: String? = nil }
    public let nodes: [LoopNode]
    public var gone: [LoopRef]? = nil
    public var spare: [LoopRef]? = nil
    public var rules: Rules? = nil
    public var rounds: Int? = nil
    public var agents: [String: There]? = nil
    public var lead: Bool? = nil
}

public struct LoopReport: Decodable, Sendable {
    public let markdown: String
    public let title: String
}

public struct NewLoopNode: Encodable, Sendable {
    public let kind: String
    public var title: String
    public var text: String
    public var to: String
    public var prio: String
    public var send: Bool
    public var x: Double = 0
    public var y: Double = 0
    public init(kind: String, title: String, text: String, to: String = "lead", prio: String = "P1", send: Bool = false) {
        self.kind = kind; self.title = title; self.text = text; self.to = to; self.prio = prio; self.send = send
    }
}

public struct LoopNodeEdit: Encodable, Sendable {
    public var status: String? = nil
    public var stale: Bool? = nil
    public init(status: String? = nil, stale: Bool? = nil) { self.status = status; self.stale = stale }
}

// MARK: - New papers

public struct FreshPaper: Decodable, Sendable, Identifiable {
    public var id: String { paperID }
    public let paperID: String
    public let title: String
    public let year: String?
    public let authors: String?
    public let url: String?
    public let relevance: Double?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        paperID = try c.decode(String.self, forKey: .paperID)
        title = try c.decode(String.self, forKey: .title)
        year = c.opt(.year) ?? (c.opt(.year) as Int?).map(String.init)
        authors = c.opt(.authors); url = c.opt(.url); relevance = c.opt(.relevance)
    }
    enum CodingKeys: String, CodingKey { case title, year, authors, url, relevance; case paperID = "paper_id" }
}

// MARK: - Staff: hiring, starting, conversations

public struct RosterEntry: Decodable, Sendable {
    public struct Line: Decodable, Sendable, Identifiable, Hashable { public let id: String; public let seq: Int; public let title: String; public let status: String? }
    public let line: Line
    public let agent: StaffAgent?
}

public struct Roster: Decodable, Sendable {
    public struct Available: Decodable, Sendable { public let ok: Bool; public var note: String? = nil }
    public let roster: [RosterEntry]
    public let available: Available?
}

public struct BackendState: Decodable, Sendable { public let ok: Bool; public var note: String? = nil }

public struct Backends: Decodable, Sendable {
    public var paseo: BackendState? = nil
    public var herdr: BackendState? = nil
    public var tmux: BackendState? = nil
    public var headless: BackendState? = nil
    public var clis: [String: String?]? = nil

    public func state(_ runtime: String) -> BackendState? {
        switch runtime {
        case "paseo": return paseo
        case "herdr": return herdr
        case "tmux": return tmux
        case "headless": return headless
        default: return nil
        }
    }
}

public struct PaseoModel: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    public var name: String? = nil
    public var thinking: [String]? = nil
    public var defaultThinking: String? = nil
    enum CodingKeys: String, CodingKey { case id, name, thinking; case defaultThinking = "default_thinking" }
}

public struct PaseoProvider: Decodable, Sendable, Identifiable, Hashable {
    public let id: String
    public var label: String? = nil
    public var models: [PaseoModel]? = nil
    public var error: String? = nil
}

public struct RoleDefault: Decodable, Sendable, Equatable {
    public var provider: String? = nil
    public var model: String? = nil
    public var thinking: String? = nil
    public var set: Bool? = nil
}

public struct ModelNews: Decodable, Sendable, Identifiable {
    public var id: String { key }
    public let key: String
    public let provider: String
    public var label: String? = nil
    public let model: String
    public var name: String? = nil
    public var thinking: [String]? = nil
    public var defaultThinking: String? = nil
    enum CodingKeys: String, CodingKey { case key, provider, label, model, name, thinking; case defaultThinking = "default_thinking" }
}

public struct PaseoInfo: Decodable, Sendable {
    public struct Status: Decodable, Sendable { public let ok: Bool; public var note: String? = nil; public var version: String? = nil; public var web: String? = nil }
    public let status: Status
    public let providers: [PaseoProvider]
    public var defaults: [String: RoleDefault]? = nil
    public var news: [ModelNews]? = nil
    public var runtime: String? = nil
}

public struct StartOptions: Encodable, Sendable {
    public var runtime: String?
    public var provider: String?
    public var model: String?
    public var thinking: String?
    public init(runtime: String?, provider: String?, model: String?, thinking: String?) {
        self.runtime = runtime; self.provider = provider; self.model = model; self.thinking = thinking
    }
}

public struct AgentConversation: Decodable, Sendable, Identifiable {
    public let id: String
    public var title: String? = nil
    public var model: String? = nil
    public var at: String? = nil
    public var current: Bool? = nil
}

public struct PaseoConversation: Decodable, Sendable, Identifiable {
    public let id: String
    public var title: String? = nil
    public var provider: String? = nil
    public var model: String? = nil
    public var cwd: String? = nil
    public var updated: String? = nil
    public var lastUser: String? = nil
    public var linked: String? = nil
    enum CodingKeys: String, CodingKey { case id, title, provider, model, cwd, updated, linked; case lastUser = "last_user" }
}

public struct HerdrInfo: Decodable, Sendable {
    public let ok: Bool
    public var note: String? = nil
    public var socket: String? = nil
    public var count: Int? = nil
}

// MARK: - Settings

public struct AccessKeyInfo: Decodable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let hint: String
    public var at: String? = nil
    public var seen: String? = nil
    /// The key itself, only in the reply that creates it.
    public var key: String? = nil
}

public struct UsageSettings: Codable, Sendable, Equatable {
    public var defaultBudget: Double?
    public var poll: Double
    public var logs: Bool
    enum CodingKeys: String, CodingKey { case poll, logs; case defaultBudget = "default_budget" }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(defaultBudget, forKey: .defaultBudget) // null clears it
        try c.encode(poll, forKey: .poll)
        try c.encode(logs, forKey: .logs)
    }
}

public struct SkimStatus: Decodable, Sendable {
    public struct Env: Decodable, Sendable, Hashable { public let name: String; public var skills: [String]? = nil; public var active: Bool? = nil }
    public struct Agent: Decodable, Sendable, Hashable { public let id: String; public let role: String; public var status: String? = nil; public var runtime: String? = nil; public var model: String? = nil }
    public struct Line: Decodable, Sendable, Hashable, Identifiable { public let id: String; public let seq: Int; public let title: String; public var agents: [Agent]? = nil }
    public let ok: Bool
    public var note: String? = nil
    public var activeEnv: String? = nil
    public var envs: [Env]? = nil
    public var lines: [Line]? = nil
    enum CodingKeys: String, CodingKey { case ok, note, envs, lines; case activeEnv = "active_env" }
}

public struct SkimResolution: Decodable, Sendable {
    public struct Skill: Decodable, Sendable, Identifiable {
        public var id: String { name }
        public let name: String
        public var description: String? = nil
        public var enabled: Bool? = nil
        public var inStore: Bool? = nil
        public var scope: String? = nil
        public var origin: String? = nil
        enum CodingKeys: String, CodingKey { case name, description, enabled, scope, origin; case inStore = "in_store" }
    }
    public var env: String? = nil
    public var envScope: String? = nil
    public var envMissing: Bool? = nil
    public let skills: [Skill]
    enum CodingKeys: String, CodingKey { case env, skills; case envScope = "env_scope", envMissing = "env_missing" }
}

public struct Bound: Codable, Sendable, Identifiable, Equatable {
    public var id: String
    public var kind: String
    public var text: String
    public var inherit: String
    public var action: String?
    public var from: String? = nil
    public var locked: Bool? = nil

    public init(kind: String, inherit: String) {
        id = "new-" + UUID().uuidString; self.kind = kind; text = ""; self.inherit = inherit; action = nil
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (c.opt(.id) as String?) ?? UUID().uuidString
        kind = try c.decode(String.self, forKey: .kind)
        text = (c.opt(.text) as String?) ?? ""
        inherit = (c.opt(.inherit) as String?) ?? "yes"
        action = c.opt(.action); from = c.opt(.from); locked = c.opt(.locked)
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        if id.hasPrefix("b_") { try c.encode(id, forKey: .id) } // a new rule gets its id from the server
        try c.encode(kind, forKey: .kind)
        try c.encode(text, forKey: .text)
        try c.encode(inherit, forKey: .inherit)
        try c.encode(kind == "must" ? nil : action, forKey: .action)
    }
    enum CodingKeys: String, CodingKey { case id, kind, text, inherit, action, from, locked }
}

public struct BoundsView: Decodable, Sendable {
    public struct Level: Decodable, Sendable { public var rules: [Bound] = []; public var off: [String]? = nil }
    public struct Levels: Decodable, Sendable {
        public let global: Level
        public var project: Level? = nil
        public var workers: [String: Level]? = nil
    }
    public let levels: Levels
    public var effective: [String: [Bound]]? = nil
    public let kinds: [String: String]
    public let inherit: [String: String]
    public let actions: [String: String]
}

public struct TraceRow: Decodable, Sendable, Identifiable {
    public let id: Int
    public let ts: String?
    public let kind: String?
    public let label: String?
    public let detail: String?
    public let ms: Double?
}

public struct RagOptions: Decodable, Sendable {
    public struct Opts: Decodable, Sendable { public let topK: Int; public let candidates: Int
        enum CodingKeys: String, CodingKey { case candidates; case topK = "top_k" } }
    public struct Limits: Decodable, Sendable { public let topK: [Int]; public let candidates: [Int]
        enum CodingKeys: String, CodingKey { case candidates; case topK = "top_k" } }
    public let opts: Opts
    public let limits: Limits
}

// MARK: - Calls

public extension PapertownClient {
    // decisions and the card
    func decide(projectID: String, _ d: Decision, value: JSONValue?, text: String?) async throws -> ProjectCardView {
        struct Body: Encodable { let kind: String; let id: String; let agent: String?; let value: JSONValue?; let text: String? }
        return try await send(.post, ["lines", projectID, "decide"], body: Body(kind: d.kind, id: d.id, agent: d.agent, value: value, text: text))
    }
    func requestCard(projectID: String, note: String) async throws -> ProjectCardView {
        try await send(.post, ["lines", projectID, "card"], body: ["note": note])
    }
    func cancelCard(projectID: String) async throws -> ProjectCardView { try await send(.post, ["lines", projectID, "card", "cancel"], body: Empty()) }
    func updateAllCards() async throws -> CardsUpdate { try await send(.post, ["cards", "update"], body: Empty()) }
    func freshPapers() async throws -> [FreshPaper] {
        struct Reply: Decodable { let papers: [FreshPaper] }
        let r: Reply = try await get(["papers", "fresh"])
        return r.papers
    }

    // the lead
    func leadView(projectID: String) async throws -> LeadView { try await get(["lines", projectID, "lead"]) }
    func setLeadRounds(projectID: String, supervise: Bool? = nil, every: Int? = nil) async throws {
        struct Body: Encodable { let supervise: Bool?; let every: Int? }
        let _: Ack = try await send(.post, ["lines", projectID, "lead"], body: Body(supervise: supervise, every: every))
    }

    // memory
    func memory(projectID: String) async throws -> MemoryList { try await get(["lines", projectID, "memory"]) }
    func memoryItem(projectID: String, id: String) async throws -> MemoryDetail { try await get(["lines", projectID, "memory", id]) }
    func removeMemory(projectID: String, id: String) async throws { let _: Ack = try await send(.delete, ["lines", projectID, "memory", id], body: Empty()) }
    func memoryScan(projectID: String) async throws -> MemoryScan { try await get(["lines", projectID, "memory", "scan"]) }
    func importMemory(projectID: String, keys: [String]) async throws {
        let _: Ack = try await send(.post, ["lines", projectID, "memory", "import"], body: ["keys": keys])
    }

    // pages
    func pages(projectID: String) async throws -> PagesList { try await get(["lines", projectID, "pages"]) }
    func removePage(projectID: String, id: String) async throws { let _: Ack = try await send(.delete, ["lines", projectID, "pages", id], body: Empty()) }
    /// The page's HTML and the policy the server serves it under.
    func page(projectID: String, id: String, look: String?) async throws -> (html: String, policy: String?) {
        let (data, response) = try await fetch(path: ["lines", projectID, "pages", id, "view"],
                                               query: look.map { [URLQueryItem(name: "look", value: $0)] } ?? [])
        return (String(decoding: data, as: UTF8.self), response.value(forHTTPHeaderField: "Content-Security-Policy"))
    }

    // budget
    func setBudget(projectID: String, usd: Double?) async throws -> LineUsage {
        struct Body: Encodable { let usd: Double?
            func encode(to encoder: Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(["usd": usd]) } }
        return try await send(.put, ["lines", projectID, "usage_budget"], body: Body(usd: usd))
    }

    // checks
    func editCheck(projectID: String, checkID: String, _ edit: CheckEdit) async throws -> ChecksView {
        try await send(.put, ["lines", projectID, "checks", checkID], body: edit)
    }
    func askCheck(projectID: String, checkID: String) async throws { let _: Ack = try await send(.post, ["lines", projectID, "checks", checkID, "ask"], body: Empty()) }
    func askAllChecks(projectID: String) async throws -> Int {
        struct Reply: Decodable { let n: Int? }
        let r: Reply = try await send(.post, ["lines", projectID, "checks", "ask"], body: Empty())
        return r.n ?? 0
    }

    // the research loop
    func loop(projectID: String) async throws -> LoopView { try await get(["lines", projectID, "canvas"]) }
    func gate(projectID: String, stage: String, _ what: String) async throws {
        let _: Ack = try await send(.post, ["lines", projectID, "canvas", "gates", stage], body: ["what": what])
    }
    func loopPolicy(projectID: String, stage: String, auto: Bool? = nil, rounds: Int? = nil) async throws {
        struct Body: Encodable { let auto: Bool?; let rounds: Int? }
        let _: Ack = try await send(.put, ["lines", projectID, "loops", stage], body: Body(auto: auto, rounds: rounds))
    }
    func sendTask(projectID: String, nodeID: String, chain: Bool) async throws {
        let _: Ack = try await send(.post, ["lines", projectID, "canvas", "nodes", nodeID, "send"], body: ["chain": chain])
    }
    func backTask(projectID: String, nodeID: String, text: String) async throws {
        let _: Ack = try await send(.post, ["lines", projectID, "canvas", "nodes", nodeID, "back"], body: ["text": text])
    }
    func editNode(projectID: String, nodeID: String, _ edit: LoopNodeEdit) async throws {
        let _: Ack = try await send(.put, ["lines", projectID, "canvas", "nodes", nodeID], body: edit)
    }
    func restoreNode(projectID: String, nodeID: String) async throws {
        let _: Ack = try await send(.post, ["lines", projectID, "canvas", "nodes", nodeID, "restore"], body: Empty())
    }
    func removeNode(projectID: String, nodeID: String) async throws {
        let _: Ack = try await send(.delete, ["lines", projectID, "canvas", "nodes", nodeID], body: Empty())
    }
    func addNode(projectID: String, _ node: NewLoopNode) async throws { let _: Ack = try await send(.post, ["lines", projectID, "canvas", "nodes"], body: node) }
    func loopRules(projectID: String, exclusive: Bool) async throws {
        let _: Ack = try await send(.put, ["lines", projectID, "canvas", "rules"], body: ["exclusive": exclusive])
    }
    func loopReport(projectID: String) async throws -> LoopReport { try await get(["lines", projectID, "canvas", "report"]) }
    func publishLoopReport(projectID: String) async throws -> PageMeta { try await send(.post, ["lines", projectID, "canvas", "report"], body: Empty()) }

    // staff
    func roster(role: String) async throws -> Roster { try await get(["agents"], query: [URLQueryItem(name: "role", value: role)]) }
    func openAgent(projectID: String, role: String) async throws -> StaffAgent {
        try await send(.post, ["agents"], body: ["line_id": projectID, "role": role])
    }
    func startAgent(_ agentID: String, _ options: StartOptions) async throws -> StaffAgent { try await send(.post, ["agents", agentID, "start"], body: options) }
    func backends() async throws -> Backends { try await get(["backends"]) }
    func paseo(fresh: Bool = false) async throws -> PaseoInfo { try await get(["paseo"], query: fresh ? [URLQueryItem(name: "fresh", value: "1")] : []) }
    func defaultRuntime() async throws -> String {
        struct Reply: Decodable { let runtime: String }
        let r: Reply = try await get(["agents", "runtime"])
        return r.runtime
    }
    func setDefaultRuntime(_ runtime: String) async throws { let _: Ack = try await send(.post, ["agents", "runtime"], body: ["runtime": runtime]) }
    func setDefaultModel(role: String, provider: String?, model: String?, thinking: String?) async throws {
        struct Body: Encodable { let role: String; let provider: String?; let model: String?; let thinking: String?
            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: K.self)
                try c.encode(role, forKey: .role); try c.encode(provider, forKey: .provider) // null: back to the environment's
                try c.encodeIfPresent(model, forKey: .model); try c.encodeIfPresent(thinking, forKey: .thinking)
            }
            enum K: String, CodingKey { case role, provider, model, thinking } }
        let _: Ack = try await send(.post, ["paseo", "defaults"], body: Body(role: role, provider: provider, model: model, thinking: thinking))
    }
    func dismissModelNews() async throws {
        struct Body: Encodable { func encode(to encoder: Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(["keys": nil as [String]?]) } }
        let _: Ack = try await send(.post, ["paseo", "news", "dismiss"], body: Body())
    }
    func herdr() async throws -> HerdrInfo { try await get(["herdr"]) }
    func conversations(agentID: String) async throws -> [AgentConversation] {
        struct Reply: Decodable { let conversations: [AgentConversation] }
        let r: Reply = try await get(["agents", agentID, "conversations"])
        return r.conversations
    }
    func newConversation(agentID: String) async throws { let _: Ack = try await send(.post, ["agents", agentID, "conversations", "new"], body: Empty()) }
    func resumeConversation(agentID: String, id: String) async throws { let _: Ack = try await send(.post, ["agents", agentID, "conversations", id], body: Empty()) }
    func paseoConversations() async throws -> [PaseoConversation] {
        struct Reply: Decodable { let conversations: [PaseoConversation] }
        let r: Reply = try await get(["paseo", "conversations"])
        return r.conversations
    }
    func importConversation(projectID: String, role: String, id: String) async throws -> StaffAgent {
        try await send(.post, ["agents", "import"], body: ["line_id": projectID, "role": role, "ext_id": id])
    }
    func brief(agentID: String) async throws { let _: Ack = try await send(.post, ["agents", agentID, "brief"], body: Empty()) }
    func closeTerminal(agentID: String) async throws { let _: Ack = try await send(.post, ["agents", agentID, "close"], body: Empty()) }
    func openInPaseo(agentID: String) async throws { let _: Ack = try await send(.post, ["agents", agentID, "open"], body: Empty()) }

    // settings: access
    func setPassword(_ password: String, old: String?) async throws {
        struct Body: Encodable { let password: String; let old: String? }
        let _: Ack = try await send(.post, ["auth", "password"], body: Body(password: password, old: old))
    }
    func clearPassword() async throws { let _: Ack = try await send(.delete, ["auth", "password"], body: Empty()) }
    func signOutEverywhere() async throws -> Int {
        struct Reply: Decodable { let ended: Int? }
        let r: Reply = try await send(.post, ["auth", "logout-all"], body: Empty())
        return r.ended ?? 0
    }
    func accessKeys() async throws -> [AccessKeyInfo] {
        struct Reply: Decodable { let keys: [AccessKeyInfo] }
        let r: Reply = try await get(["auth", "keys"])
        return r.keys
    }
    func createAccessKey(name: String) async throws -> AccessKeyInfo { try await send(.post, ["auth", "keys"], body: ["name": name]) }
    func revokeAccessKey(id: String) async throws { let _: Ack = try await send(.delete, ["auth", "keys", id], body: Empty()) }

    // settings: usage, library, MCP, skills, bounds, samples, trace
    func usageSettings() async throws -> UsageSettings { try await get(["usage", "settings"]) }
    func setUsageSettings(_ s: UsageSettings) async throws -> UsageSettings { try await send(.put, ["usage", "settings"], body: s) }
    func ragOptions() async throws -> RagOptions { try await get(["rag"]) }
    func setRagOptions(topK: Int, candidates: Int) async throws -> RagOptions {
        try await send(.post, ["rag"], body: ["top_k": topK, "candidates": candidates])
    }
    func saveMcpServer(name: String, command: String, args: [String], env: [String: String]) async throws {
        struct Body: Encodable { let name: String; let command: String; let args: [String]; let env: [String: String] }
        let _: Ack = try await send(.post, ["mcp", "servers"], body: Body(name: name, command: command, args: args, env: env))
    }
    func removeMcpServer(_ name: String) async throws { let _: Ack = try await send(.delete, ["mcp", "servers", name], body: Empty()) }
    func toggleMcpServer(_ name: String, enabled: Bool) async throws { let _: Ack = try await send(.post, ["mcp", "servers", name, "toggle"], body: ["enabled": enabled]) }
    func restartMcpServer(_ name: String) async throws { let _: Ack = try await send(.post, ["mcp", "servers", name, "restart"], body: Empty()) }
    func skim() async throws -> SkimStatus { try await get(["skim"], query: [URLQueryItem(name: "fresh", value: "1")]) }
    func skimResolve(projectID: String?, agentID: String?) async throws -> SkimResolution {
        try await get(["skim", "resolve"], query: [projectID.map { URLQueryItem(name: "line_id", value: $0) },
                                                    agentID.map { URLQueryItem(name: "agent_id", value: $0) }].compactMap { $0 })
    }
    func setSkim(scope: String, key: String, value: String?, projectID: String?, agentID: String?) async throws -> SkimResolution {
        struct Body: Encodable { let scope: String; let key: String; let value: String?; let line_id: String?; let agent_id: String?
            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: K.self)
                try c.encode(scope, forKey: .scope); try c.encode(key, forKey: .key); try c.encode(value, forKey: .value) // null unsets
                try c.encodeIfPresent(line_id, forKey: .line_id); try c.encodeIfPresent(agent_id, forKey: .agent_id)
            }
            enum K: String, CodingKey { case scope, key, value, line_id, agent_id } }
        return try await send(.post, ["skim", "config"], body: Body(scope: scope, key: key, value: value, line_id: projectID, agent_id: agentID))
    }
    func bounds(projectID: String?) async throws -> BoundsView {
        try await get(["bounds"], query: projectID.map { [URLQueryItem(name: "line_id", value: $0)] } ?? [])
    }
    func setBounds(projectID: String?, role: String?, rules: [Bound], off: [String]) async throws {
        struct Body: Encodable { let line_id: String?; let role: String?; let rules: [Bound]; let off: [String] }
        let _: Ack = try await send(.put, ["bounds"], body: Body(line_id: projectID, role: role, rules: rules, off: off))
    }
    func addSamples() async throws -> String {
        struct Reply: Decodable { let note: String? }
        let r: Reply = try await send(.post, ["samples"], body: Empty())
        return r.note ?? ""
    }
    func trace(limit: Int = 80) async throws -> [TraceRow] { try await get(["trace"], query: [URLQueryItem(name: "limit", value: String(limit))]) }
}
