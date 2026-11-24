import Foundation
import PapertownCore

// Every call the app makes beyond the inbox basics, one per server route (server/papertown/api.py).
public extension PapertownClient {
    private struct Empty: Codable {}
    private struct Ack: Decodable {}

    // MARK: Town

    func world() async throws -> WorldSnapshot { try await get(["world"]) }
    func cards() async throws -> CardsResponse { try await get(["cards"]) }
    func departments() async throws -> [Department] { try await get(["departments"]) }
    func usage() async throws -> UsageView { try await get(["usage"]) }
    func refreshUsage() async throws -> UsageView { try await send(.post, ["usage", "refresh"], body: Empty()) }
    func gpus() async throws -> GpuStatus { try await get(["gpus"]) }
    func mcp() async throws -> McpView { try await get(["mcp"]) }
    func skills() async throws -> [TownSkill] { try await get(["skills"]) }
    func ragView() async throws -> RagView { try await get(["rag"]) }

    func ragSearch(_ query: String, k: Int? = nil) async throws -> RagResult {
        var items = [URLQueryItem(name: "q", value: query)]
        if let k { items.append(URLQueryItem(name: "k", value: String(k))) }
        return try await get(["rag", "search"], query: items)
    }

    func library(query: String = "", topic: String = "", limit: Int = 60) async throws -> LibraryShelf {
        try await get(["library"], query: [URLQueryItem(name: "q", value: query), URLQueryItem(name: "topic", value: topic),
                                           URLQueryItem(name: "limit", value: String(limit))])
    }

    func jobs(projectID: String? = nil) async throws -> JobBoard {
        try await get(["jobs"], query: projectID.map { [URLQueryItem(name: "line_id", value: $0)] } ?? [])
    }

    func job(id: String) async throws -> TownJob {
        try await get(["jobs", id], query: [URLQueryItem(name: "tail", value: "400")])
    }

    func cancelJob(id: String) async throws -> TownJob { try await send(.post, ["jobs", id, "cancel"], body: Empty()) }

    // MARK: Project pages

    func card(projectID: String) async throws -> ProjectCardView { try await get(["lines", projectID, "card"]) }
    func checks(projectID: String) async throws -> ChecksView { try await get(["lines", projectID, "checks"]) }
    func runChecks(projectID: String) async throws { let _: Ack = try await send(.post, ["lines", projectID, "checks", "run"], body: Empty()) }
    func papers(projectID: String) async throws -> PapersView { try await get(["lines", projectID, "papers"]) }
    func lineData(projectID: String) async throws -> LineData { try await get(["lines", projectID, "data"]) }
    func workspace(projectID: String) async throws -> WorkspaceInfo { try await get(["lines", projectID, "ws"]) }
    func workspaceTree(projectID: String, root: String) async throws -> WorkspaceTree { try await get(["lines", projectID, "ws", root, "tree"]) }

    func workspaceFile(projectID: String, root: String, path: String) async throws -> WorkspaceFile {
        try await get(["lines", projectID, "ws", root, "file"], query: [URLQueryItem(name: "path", value: path)])
    }

    func paperPDF(projectID: String) async throws -> Data {
        try await data(path: ["lines", projectID, "ws", "paper", "pdf"],
                       query: [URLQueryItem(name: "v", value: String(Int(Date().timeIntervalSince1970)))])
    }

    func compilePaper(projectID: String) async throws -> CompileResult {
        try await send(.post, ["lines", projectID, "ws", "paper", "compile"], body: Empty())
    }

    func lineUsage(projectID: String) async throws -> LineUsage { try await get(["lines", projectID, "usage"]) }

    func outline(projectID: String) async throws -> String {
        struct Outline: Decodable { let text: String }
        let o: Outline = try await get(["lines", projectID, "canvas", "outline"])
        return o.text
    }

    // MARK: Agents and conversations

    func agentEvents(agentID: String, after: Int = 0) async throws -> AgentEvents {
        try await get(["agents", agentID], query: [URLQueryItem(name: "after", value: String(after))])
    }

    func timeline(agentID: String) async throws -> AgentTimeline { try await get(["agents", agentID, "timeline"]) }
    func screen(agentID: String) async throws -> AgentScreen { try await get(["agents", agentID, "screen"]) }

    func keys(agentID: String, _ keys: [String]) async throws {
        struct Body: Encodable { let keys: [String] }
        let _: Ack = try await send(.post, ["agents", agentID, "keys"], body: Body(keys: keys))
    }

    func answerPrompt(agentID: String, digest: String, option: Int) async throws {
        struct Body: Encodable { let digest: String; let option: Int }
        let _: Ack = try await send(.post, ["agents", agentID, "prompt"], body: Body(digest: digest, option: option))
    }

    /// What the conversation open now can switch to: a terminal CLI resumes its session on another model of the same CLI.
    func agentModels(agentID: String) async throws -> AgentModels { try await get(["agents", agentID, "models"]) }

    /// An empty model or thinking leaves the choice to the CLI.
    func switchModel(agentID: String, model: String, thinking: String) async throws {
        struct Body: Encodable { let model: String; let thinking: String }
        let _: Ack = try await send(.post, ["agents", agentID, "model"], body: Body(model: model, thinking: thinking))
    }

    func startAgent(_ agentID: String) async throws { let _: Ack = try await send(.post, ["agents", agentID, "start"], body: Empty()) }
    func stopAgent(_ agentID: String) async throws { let _: Ack = try await send(.post, ["agents", agentID, "stop"], body: Empty()) }

    /// Says something to an agent and returns nothing: a terminal agent answers with its queue state, a pi agent with an event.
    func say(_ text: String, to agentID: String, mode: DeliveryMode?) async throws {
        struct Body: Encodable { let text: String; let mode: DeliveryMode? }
        let _: Ack = try await send(.post, ["agents", agentID, "say"], body: Body(text: text, mode: mode))
    }

    // MARK: Assistant

    func assistantSay(_ text: String) async throws {
        struct Body: Encodable { let text: String; let page: String? }
        let _: Ack = try await send(.post, ["assistant", "say"], body: Body(text: text, page: nil))
    }

    func decideAct(eventID: Int, allow: Bool) async throws {
        struct Body: Encodable { let allow: Bool }
        let _: Ack = try await send(.post, ["assistant", "acts", String(eventID)], body: Body(allow: allow))
    }

    func assistantNew() async throws { let _: Ack = try await send(.post, ["assistant", "new"], body: Empty()) }

    // MARK: Terminals

    func terminal(id: String) async throws -> TerminalDetail { try await get(["terminals", id]) }
    func terminalTimeline(id: String) async throws -> TerminalTimeline { try await get(["terminals", id, "timeline"]) }

    func terminalSay(_ text: String, to id: String, mode: DeliveryMode?) async throws {
        struct Body: Encodable { let text: String; let mode: DeliveryMode? }
        let _: Ack = try await send(.post, ["terminals", id, "say"], body: Body(text: text, mode: mode))
    }

    func terminalKeys(id: String, _ keys: [String]) async throws {
        struct Body: Encodable { let keys: [String] }
        let _: Ack = try await send(.post, ["terminals", id, "keys"], body: Body(keys: keys))
    }

    func terminalPrompt(id: String, digest: String, option: Int) async throws {
        struct Body: Encodable { let digest: String; let option: Int }
        let _: Ack = try await send(.post, ["terminals", id, "prompt"], body: Body(digest: digest, option: option))
    }

    func terminalQueue(id: String, queueID: Int, action: String) async throws {
        struct Body: Encodable { let what: String }
        let _: Ack = try await send(.post, ["terminals", id, "queue", String(queueID)], body: Body(what: action))
    }

    func terminalSeen(id: String) async throws { let _: Ack = try await send(.post, ["terminals", id, "seen"], body: Empty()) }
}
