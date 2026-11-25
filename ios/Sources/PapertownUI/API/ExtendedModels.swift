import Foundation
import PapertownCore

// MARK: - Rich Server Models decoded via PapertownClient.get / post

public struct ResidentInfo: Decodable, Sendable, Equatable {
    public let on: Bool
    public let state: String
    public let note: String?
    public let agent: String?
    public let runtime: String?
    public let status: String?

    public init(on: Bool, state: String, note: String? = nil, agent: String? = nil, runtime: String? = nil, status: String? = nil) {
        self.on = on
        self.state = state
        self.note = note
        self.agent = agent
        self.runtime = runtime
        self.status = status
    }
}

public struct StageInfo: Decodable, Sendable, Equatable, Identifiable {
    public var id: String { key }
    public let key: String
    public let name: String
    public let status: String
    public let pct: Int
    public let note: String?
    public let owner: String?
    public var building: String? = nil
    public var mod: String? = nil
    public var startedAt: String? = nil
    public var endedAt: String? = nil

    enum CodingKeys: String, CodingKey {
        case key, name, status, pct, note, owner, building, mod
        case startedAt = "started_at"
        case endedAt = "ended_at"
    }
}

public struct StageAgentInfo: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let role: String
    public let name: String?
    public let status: String
    public let runtime: String?
    public let model: String?
}

public struct ProjectSnapshot: Decodable, Sendable, Equatable, Identifiable {
    public struct Item: Decodable, Sendable, Equatable {
        public let id: String?, stage: String?
        enum CodingKeys: String, CodingKey { case id, stage }
    }
    public let id: String
    public let seq: Int
    public let title: String
    public let idea: String
    public let status: String
    public let stage: String
    public let pct: Int
    public let sample: Bool
    public let note: String?
    public let updatedAt: String?
    public let stages: [StageInfo]
    public let team: [StageAgentInfo]
    public let lead: ResidentInfo
    public var verdict: String? = nil
    public var createdAt: String? = nil
    public var linked: JSONValue? = nil
    /// Only in the single-project answer: what each stage produced, keyed by stage.
    public var outputs: ProjectOutputs? = nil
    public var items: [Item]? = nil

    enum CodingKeys: String, CodingKey {
        case id, seq, title, idea, status, stage, pct, sample, note, stages, team, lead, verdict, linked, outputs, items
        case updatedAt = "updated_at"
        case createdAt = "created_at"
    }

    public var isLinked: Bool {
        if case .object = linked { return true }
        return false
    }

    public var isDone: Bool { status == "done" }

    public var doneStageCount: Int {
        stages.filter { $0.status == "done" }.count
    }

    public var leadAgentID: String? {
        lead.agent ?? team.first(where: { $0.role == "lead" })?.id
    }
}

public struct PermissionPrompt: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    public let title: String?
    public let arg: String
    public let kind: String?
}

public struct ReportItem: Decodable, Sendable, Equatable, Identifiable {
    public let id: Int
    public let lineID: String
    public let agentID: String?
    public let ts: String
    public let kind: String
    public let data: ReportPayload

    enum CodingKeys: String, CodingKey {
        case id, ts, kind, data
        case lineID = "line_id"
        case agentID = "agent_id"
    }
}

public struct ReportPayload: Decodable, Sendable, Equatable {
    public let text: String?
    public let question: String?
    public let open: Bool?
    public let answer: String?
    public let who: String?
    public var key: Bool? = nil
    public var choices: [String]? = nil
    public var answeredAt: String? = nil
    public var by: String? = nil
    public var result: String? = nil
    public var matter: Matter? = nil

    enum CodingKeys: String, CodingKey {
        case text, question, open, answer, who, key, choices, by, result, matter
        case answeredAt = "answered_at"
    }
}

public struct WatchDoing: Decodable, Sendable, Equatable {
    public let kind: String?
    public let text: String?
}

public struct WatchInfo: Decodable, Sendable, Equatable {
    public let bucket: String
    public let why: String?
    public var doing: WatchDoing? = nil
    public let since: String?
    public let turn: String?
    public let queued: Int?
    public let unread: Bool?
    public let permissions: [PermissionPrompt]?
    public let asks: [ReportItem]?

    enum CodingKeys: String, CodingKey { case bucket, why, doing, since, turn, queued, unread, permissions, asks }
}

public struct StaffTask: Decodable, Sendable, Equatable {
    public let id: String
    public let title: String
    public let status: String
}

public struct StaffAgent: Decodable, Sendable, Identifiable {
    public let id: String
    public let lineID: String?
    public let role: String
    public let status: String
    public let name: String?
    public let model: String?
    public let runtime: String?
    public let updatedAt: String?
    public let down: String?
    public let last: AgentEvent?
    public let watch: WatchInfo?
    public let task: StaffTask?
    public var term: AgentTermInfo? = nil
    public var cwd: String? = nil
    public var cost: Double? = nil
    public var started: Bool? = nil
    public var extID: String? = nil
    public var sessionID: String? = nil
    public var nodeID: String? = nil

    enum CodingKeys: String, CodingKey {
        case id, role, status, name, model, runtime, down, last, watch, task, term, cwd, cost, started
        case lineID = "line_id"
        case updatedAt = "updated_at"
        case extID = "ext_id"
        case sessionID = "session_id"
        case nodeID = "node_id"
    }

    /// Paseo conversations and terminal CLIs keep their own transcript, read through /timeline; pi agents keep events.
    public var usesTimeline: Bool { runtime == "paseo" || term != nil }

    /// The model shown for it: what the terminal reports, else the one it was started with.
    public var displayModel: String? { term?.model ?? model }

    public var effectiveBucket: String {
        if let b = watch?.bucket { return b }
        if status == "error" { return "failed" }
        if status == "working" || status == "starting" { return "working" }
        if status == "idle" || status == "watching" { return "idle" }
        return "off"
    }

    public var isWorking: Bool {
        status == "working" || effectiveBucket == "working" || !(watch?.permissions?.isEmpty ?? true)
    }

    public var isOffline: Bool {
        down != nil || status == "offline" || status == "stopped"
    }
}

public struct ProjectRefInfo: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let seq: Int
    public let title: String
    public let status: String
    public let stage: String
}

public struct StaffGroup: Decodable, Sendable {
    public let line: ProjectRefInfo?
    public let agents: [StaffAgent]
    public var terminals: [TerminalInfo]? = nil
}

public struct LinkStatus: Decodable, Sendable, Equatable {
    public let ok: Bool
    public let note: String?
    public let live: Bool?
}

public struct StaffOverview: Decodable, Sendable {
    public let counts: [String: Int]?
    public let groups: [StaffGroup]
    public var others: [TerminalInfo]? = nil
    public var paseo: LinkStatus? = nil
    public var herdr: LinkStatus? = nil
}

public struct ReportsResponse: Decodable, Sendable, Equatable {
    public let reports: [ReportItem]
    public let asks: [ReportItem]
}

public struct AssistantSnapshot: Decodable, Sendable {
    public let agent: StaffAgent
    /// Questions it put to you and actions it proposes, waiting for a decision.
    public var asks: [AgentEvent]? = nil
    public var acts: [AgentEvent]? = nil
}

public extension JSONValue {
    var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    var boolValue: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }

    var intValue: Int? {
        switch self {
        case .integer(let n): return Int(n)
        case .number(let n): return Int(n)
        default: return nil
        }
    }

    var doubleValue: Double? {
        switch self {
        case .integer(let n): return Double(n)
        case .number(let n): return n
        default: return nil
        }
    }

    var arrayValue: [JSONValue]? {
        if case .array(let a) = self { return a }
        return nil
    }

    /// Text for display: strings as they are, numbers and booleans written out, anything else as nil.
    var displayText: String? {
        switch self {
        case .string(let s): return s
        case .integer(let n): return String(n)
        case .number(let n): return n == n.rounded() && abs(n) < 1e9 ? String(Int(n)) : String(format: "%.3g", n)
        case .bool(let b): return b ? "true" : "false"
        default: return nil
        }
    }

    var objectValue: [String: JSONValue]? {
        if case .object(let dict) = self { return dict }
        return nil
    }

    func field(_ key: String) -> JSONValue? {
        objectValue?[key]
    }
}

// MARK: - Thin Extensions on PapertownClient

public extension PapertownClient {
    private struct EmptyReply: Decodable {}

    func projectSnapshots() async throws -> [ProjectSnapshot] {
        try await get(["lines"])
    }

    func projectSnapshot(id: String) async throws -> ProjectSnapshot {
        try await get(["lines", id])
    }

    func setLead(projectID: String, on: Bool) async throws {
        struct Body: Encodable { let on: Bool }
        let _: EmptyReply = try await post(["lines", projectID, "lead"], body: Body(on: on))
    }

    func createIdea(_ text: String) async throws -> ProjectSnapshot {
        struct Body: Encodable { let text: String }
        return try await post(["ideas"], body: Body(text: text))
    }

    func staffOverview() async throws -> StaffOverview {
        try await get(["agents", "overview"])
    }

    func reports(projectID: String? = nil) async throws -> ReportsResponse {
        let query = projectID.map { [URLQueryItem(name: "line_id", value: $0)] } ?? []
        return try await get(["reports"], query: query)
    }

    func answerReport(id: Int, text: String) async throws {
        struct Body: Encodable { let text: String }
        let _: EmptyReply = try await post(["reports", String(id), "answer"], body: Body(text: text))
    }

    func respondPermission(agentID: String, requestID: String, allow: Bool) async throws {
        struct Body: Encodable {
            let requestID: String
            let allow: Bool
            enum CodingKeys: String, CodingKey {
                case requestID = "request_id"
                case allow
            }
        }
        let _: EmptyReply = try await post(["agents", agentID, "permit"], body: Body(requestID: requestID, allow: allow))
    }

    func abortAgent(_ agentID: String) async throws {
        let _: EmptyReply = try await post(["agents", agentID, "abort"], body: [String: String]())
    }

    func markSeen(agentID: String) async throws {
        let _: EmptyReply = try await post(["agents", agentID, "seen"], body: [String: String]())
    }

    func actQueuedMessage(agentID: String, eventID: Int, action: String) async throws {
        struct Body: Encodable { let what: String }
        let _: EmptyReply = try await post(["agents", agentID, "queue", String(eventID)], body: Body(what: action))
    }

    func assistantSnapshot() async throws -> AssistantSnapshot {
        try await get(["assistant"])
    }
}
