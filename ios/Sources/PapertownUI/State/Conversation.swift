import Foundation
import PapertownCore

/// Whose conversation a chat page shows: one of the town's agents (the assistant is the agent "assistant"),
/// or a herdr / tmux terminal the town watches.
public enum ChatTarget: Hashable, Sendable {
    case agent(String)
    case terminal(String)

    public var key: String {
        switch self {
        case .agent(let id): return "agent:\(id)"
        case .terminal(let id): return "terminal:\(id)"
        }
    }

    public var isAssistant: Bool { self == .agent("assistant") }
}

/// One row of a conversation, whatever it was read from: pi events, a Paseo or terminal timeline.
public struct ChatEntry: Identifiable, Equatable, Sendable {
    public enum Kind: String, Sendable { case user, assistant, tool, error, note, ask, act }
    public let id: String
    public let kind: Kind
    public let text: String
    public var tool: String? = nil
    public var arg: String? = nil
    public var status: String? = nil
    public var ts: String? = nil
    /// An ask or act: its event id, the choices offered, and whether it still waits for you.
    public var eventID: Int? = nil
    public var choices: [String] = []
    public var open: Bool = false
}

public struct QueuedMessage: Identifiable, Equatable, Sendable {
    public let id: Int
    public let text: String
}

public struct ConversationState: Sendable {
    public var agent: StaffAgent?
    public var terminal: TerminalInfo?
    public var entries: [ChatEntry] = []
    public var queued: [QueuedMessage] = []
    public var permissions: [PermissionPrompt] = []
    public var screen: String?
    public var prompt: TermPrompt?
    public var transcriptNote: String?
    public var isLoading = false
    public var error: String?
    /// pi agents: the last event read, so a refresh only asks for what came after it.
    var lastEventID = 0
    var events: [AgentEvent] = []

    public var hasScreen: Bool { agent?.term != nil || terminal != nil }

    public var isWorking: Bool {
        if let t = agent?.term { return t.status == "working" || t.status == "starting" }
        if let agent { return agent.isWorking }
        return terminal?.watch?.bucket == "working"
    }

    public var isOffline: Bool {
        guard let agent else { return terminal == nil }
        if agent.started != true { return true }
        if agent.term != nil { return agent.term?.status == "exited" }
        return agent.isOffline || agent.status == "stopped"
    }

    mutating func merge(_ incoming: [AgentEvent]) {
        guard !incoming.isEmpty else { return }
        var byID = Dictionary(uniqueKeysWithValues: events.map { ($0.id, $0) })
        for ev in incoming { byID[ev.id] = ev }
        events = byID.values.sorted { $0.id < $1.id }
        lastEventID = events.last?.id ?? lastEventID
        entries = ConversationState.entries(from: events)
        queued = events.filter { $0.kind == "user" && $0.data.field("queued")?.boolValue == true && $0.data.field("delivered")?.boolValue != true }
            .map { QueuedMessage(id: $0.id, text: $0.data.field("text")?.stringValue ?? "") }
    }

    /// pi events: a tool call and its end become one row; asks and acts carry their choices.
    static func entries(from events: [AgentEvent]) -> [ChatEntry] {
        var out: [ChatEntry] = []
        var toolRow: [String: Int] = [:]
        for ev in events {
            let d = ev.data
            let text = d.field("text")?.stringValue ?? ""
            switch ev.kind {
            case "user":
                if d.field("queued")?.boolValue == true && d.field("delivered")?.boolValue != true { continue }
                out.append(ChatEntry(id: "e\(ev.id)", kind: .user, text: text, ts: ev.ts))
            case "assistant":
                if let err = d.field("error")?.stringValue, !err.isEmpty, text.isEmpty {
                    out.append(ChatEntry(id: "e\(ev.id)", kind: .error, text: err, ts: ev.ts))
                } else if !text.isEmpty {
                    out.append(ChatEntry(id: "e\(ev.id)", kind: .assistant, text: text, ts: ev.ts))
                }
            case "tool":
                let name = d.field("name")?.stringValue ?? "tool"
                out.append(ChatEntry(id: "e\(ev.id)", kind: .tool, text: name, tool: name, arg: argText(d.field("args")), status: "running", ts: ev.ts))
                if let id = d.field("id")?.stringValue { toolRow[id] = out.count - 1 }
            case "tool_end":
                let failed = (d.field("error")?.stringValue).map { !$0.isEmpty } ?? (d.field("error")?.boolValue ?? false)
                if let id = d.field("id")?.stringValue, let row = toolRow[id] {
                    out[row].status = failed ? "failed" : "completed"
                }
            case "note":
                let isError = d.field("error")?.boolValue == true
                out.append(ChatEntry(id: "e\(ev.id)", kind: isError ? .error : .note, text: text, ts: ev.ts))
            case "ask":
                let choices = d.field("choices")?.arrayValue?.compactMap(\.stringValue) ?? []
                out.append(ChatEntry(id: "e\(ev.id)", kind: .ask, text: d.field("question")?.stringValue ?? text, ts: ev.ts,
                                     eventID: ev.id, choices: choices, open: d.field("answer") == nil && d.field("open")?.boolValue != false))
            case "act":
                let status = d.field("status")?.stringValue ?? "pending"
                let title = d.field("title")?.stringValue ?? d.field("action")?.stringValue ?? ""
                let why = d.field("why")?.stringValue
                out.append(ChatEntry(id: "e\(ev.id)", kind: .act, text: title, tool: d.field("action")?.stringValue,
                                     arg: why ?? d.field("result")?.displayText, status: status, ts: ev.ts,
                                     eventID: ev.id, open: status == "pending"))
            default:
                if !text.isEmpty { out.append(ChatEntry(id: "e\(ev.id)", kind: .note, text: text, ts: ev.ts)) }
            }
        }
        return out
    }

    /// A Paseo or terminal transcript, in the order it was written.
    static func entries(from items: [TimelineItem]) -> [ChatEntry] {
        items.enumerated().compactMap { i, item in
            let id = "t\(i)"
            switch item.kind {
            case "user": return ChatEntry(id: id, kind: .user, text: item.text ?? "", ts: item.ts)
            case "assistant": return ChatEntry(id: id, kind: .assistant, text: item.text ?? "", ts: item.ts)
            case "tool":
                let name = item.name ?? "tool"
                return ChatEntry(id: id, kind: .tool, text: name, tool: name, arg: item.arg, status: item.status ?? (item.error == nil ? nil : "failed"), ts: item.ts)
            case "error": return ChatEntry(id: id, kind: .error, text: item.text ?? item.error ?? "", ts: item.ts)
            default:
                guard let text = item.text, !text.isEmpty else { return nil }
                return ChatEntry(id: id, kind: .note, text: text, ts: item.ts)
            }
        }
    }

    private static func argText(_ v: JSONValue?) -> String? {
        guard let v else { return nil }
        if let s = v.stringValue { return s }
        guard let obj = v.objectValue else { return v.displayText }
        for key in ["command", "path", "file_path", "pattern", "query", "url"] {
            if let s = obj[key]?.displayText { return s }
        }
        return obj.compactMap { k, val in val.displayText.map { "\(k): \($0)" } }.sorted().joined(separator: " · ")
    }
}
