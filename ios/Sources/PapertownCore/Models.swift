import Foundation

/// Preserves server-defined keys in event payloads and new fields added by server releases.
public enum JSONValue: Decodable, Sendable, Equatable {
    case null, bool(Bool), integer(Int64), number(Double), string(String), array([JSONValue]), object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let b = try? value.decode(Bool.self) { self = .bool(b) }
        else if let n = try? value.decode(Int64.self) { self = .integer(n) }
        else if let n = try? value.decode(Double.self) { self = .number(n) }
        else if let s = try? value.decode(String.self) { self = .string(s) }
        else if let a = try? value.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try value.decode([String: JSONValue].self)) }
    }
}

public struct AuthState: Decodable, Sendable {
    public let local, password, authed, signedIn: Bool
    /// Let in by an access key (servers before keys leave it out).
    public let key: Bool?
    public let sessions: Int?
    enum CodingKeys: String, CodingKey { case local, password, authed, signedIn = "signed_in", key, sessions }
}

/// `GET /api/health`, open before signing in: whether the address is a Papertown server.
public struct ServerHealth: Decodable, Sendable {
    public let ok: Bool
    /// "papertown" (servers before access keys leave it out)
    public let app: String?
    public let version: String?
}

public struct TownProject: Decodable, Sendable, Identifiable {
    public let id, title, idea, status, stage: String
    public let pct: Int
    public let team: [TownAgent]
}

public struct TownAgent: Decodable, Sendable, Identifiable {
    public let id, role, status: String
    public let name: String?
}

public struct AgentEvent: Decodable, Sendable, Identifiable {
    public let id: Int
    public let agentID, ts, kind: String
    public let data: JSONValue
    enum CodingKeys: String, CodingKey { case id, agentID = "agent_id", ts, kind, data }
}

public struct AgentHistory: Decodable, Sendable {
    public let agent: TownAgent
    public let events: [AgentEvent]
}

public enum DeliveryMode: String, Encodable, Sendable { case steer, queue, interrupt }

extension PapertownClient {
    private struct Acknowledgement: Decodable { let ok: Bool }
    public func authState() async throws -> AuthState { try await get(["auth", "state"]) }

    public func login(password: String) async throws {
        let _: Acknowledgement = try await post(["auth", "login"], body: ["password": password])
    }

    public func logout() async throws {
        let _: Acknowledgement = try await post(["auth", "logout"], body: [String: String]())
    }

    public func projects() async throws -> [TownProject] { try await get(["lines"]) }
    public func project(id: String) async throws -> TownProject { try await get(["lines", id]) }

    public func history(agentID: String, after: Int = 0) async throws -> AgentHistory {
        try await get(["agents", agentID], query: [URLQueryItem(name: "after", value: String(after))])
    }

    public func send(_ text: String, to agentID: String, mode: DeliveryMode? = nil) async throws -> AgentEvent {
        struct Message: Encodable { let text: String; let mode: DeliveryMode? }
        return try await post(["agents", agentID, "say"], body: Message(text: text, mode: mode))
    }
}
