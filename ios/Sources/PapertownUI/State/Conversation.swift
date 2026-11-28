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
    /// The original event, including authorship for a message that can be quoted.
    public var eventID: Int? = nil
    public var origin: String? = nil
    public var decided: String? = nil
    public var userText: String? = nil
    /// A delivered decision contains the already-saved original wrapped by the server for the agent.
    static func deliveredDecision(_ text: String, origin: String?) -> (number: String, text: String)? {
        guard origin == "papertown", text.hasPrefix("<decision "),
              let match = delivery.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let number = Range(match.range(at: 1), in: text), let original = Range(match.range(at: 2), in: text) else { return nil }
        let words = text[original].replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">").replacingOccurrences(of: "&amp;", with: "&")
        return (String(text[number]), words)
    }

    private static let delivery = try! NSRegularExpression(pattern: #"\A<decision id="(D[1-9][0-9]*)" mod="[a-z]+">([^<]*)</decision>\z"#)
    var deliveredDecision: (number: String, text: String)? { Self.deliveredDecision(text, origin: origin) }

    static func authoredWords(_ raw: String, userText: String?, origin: String?) -> String? {
        if let userText { return userText }
        if origin == "web" || origin == "terminal" { return raw }
        return deliveredDecision(raw, origin: origin)?.text
    }

    var canQuote: Bool {
        kind == .user && eventID != nil && (origin == "web" || origin == "terminal")
            && !(userText ?? text).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    public var choices: [String] = []
    public var open: Bool = false
}

public struct QueuedMessage: Identifiable, Equatable, Sendable {
    public let id: Int
    public let text: String
    let authored: Bool

    init(event: AgentEvent) {
        let raw = event.data.field("text")?.stringValue ?? ""
        let original = ChatEntry.authoredWords(ChatFiles.split(raw).text, userText: event.data.field("user_text")?.stringValue,
                                               origin: event.data.field("origin")?.stringValue)?.nonEmpty
        id = event.id
        text = original ?? raw
        authored = original != nil
    }

    init(terminal: TerminalQueueItem) {
        let original = ChatFiles.split(terminal.text).text.nonEmpty
        id = terminal.id
        text = original ?? terminal.text
        authored = original != nil
    }
}

/// A message you sent from this device, shown at once and kept until the conversation itself shows it.
public struct PendingMessage: Identifiable, Equatable, Sendable {
    public enum Phase: Equatable, Sendable {
        case sending
        /// The server took it; the conversation has not shown it yet (a terminal CLI logs it when its turn starts).
        case sent
        /// The connection dropped before the answer: it may or may not have arrived.
        case uncertain
        case failed(String)
    }
    public let id: String
    public let text: String
    public let mode: DeliveryMode?
    /// Files that go with it, uploaded before the message is sent.
    public let files: [OutgoingFile]
    /// What the conversation shows of it once it arrives: its text, or for files alone the line the server puts
    /// before them.
    var match: String { text.isEmpty && !files.isEmpty ? "附件：" : text }
    public var phase: Phase
    /// How many of your messages with this text the conversation held when it was sent.
    var had: Int
    let at: Date

    init(text: String, mode: DeliveryMode?, files: [OutgoingFile] = [], had: Int) {
        id = UUID().uuidString
        self.text = text
        self.mode = mode
        self.files = files
        phase = .sending
        self.had = had
        at = Date()
    }
}

/// A photo or file picked to go with a message.
public struct OutgoingFile: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let type: String
    public let data: Data
    public var isImage: Bool { type.hasPrefix("image/") }

    public init(name: String, type: String, data: Data) {
        id = UUID().uuidString
        self.name = name
        self.type = type
        self.data = data
    }
}

public struct ConversationState: Sendable {
    public var agent: StaffAgent?
    public var terminal: TerminalInfo?
    public var entries: [ChatEntry] = []
    public var queued: [QueuedMessage] = []
    public var permissions: [PermissionPrompt] = []
    public var screen: String?
    /// The conversation's title as the CLI named it.
    public var title: String?
    /// The screen with its colours, read while the terminal tab shows.
    public var styledScreen: StyledScreen?
    public var prompt: TermPrompt?
    public var transcriptNote: String?
    /// The status line above the input: how full the context is, what the session has used, where it works and the
    /// subscription's windows.
    public var context: TranscriptContext?
    public var usage: SessionUsage?
    public var git: GitState?
    public var limits: [UsageLimit] = []
    public var pending: [PendingMessage] = []
    public var isLoading = false
    public var error: String?
    /// pi agents: the last event read, so a refresh only asks for what came after it.
    var lastEventID = 0
    var events: [AgentEvent] = []

    public var hasScreen: Bool { agent?.term != nil || terminal != nil }

    /// The terminal's status: working, starting, blocked, idle, done or exited.
    public var termStatus: String? { agent?.term?.status ?? (terminal?.watch?.bucket == "needs" ? "blocked" : nil) }

    /// A screen holds the terminal that Papertown cannot answer for you (a hook review, a menu): typing would go into it.
    public var heldByScreen: Bool { termStatus == "blocked" && prompt == nil && (agent?.watch?.permissions ?? []).isEmpty }

    /// The last lines of the terminal above its input box: the CLI's own account of what it is doing.
    public var screenTail: [String] {
        guard let screen else { return [] }
        let lines = screen.split(separator: "\n", omittingEmptySubsequences: false).map { String($0) }
        // Claude Code and Codex end their working line with "esc to interrupt"; the lines above it are the latest output
        if let i = lines.lastIndex(where: { $0.contains("esc to interrupt") || $0.contains("Esc to interrupt") }) {
            let shown = lines[max(0, i - 3)...i].map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            return Array(shown.suffix(3))
        }
        return []
    }

    /// Your messages with this text the conversation shows.
    func seen(_ text: String) -> Int {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return entries.filter { $0.kind == .user && $0.text.contains(t) }.count
    }

    /// Sent messages the conversation now shows, or that it has not shown for ten minutes, are let go.
    mutating func settlePending() {
        let now = Date()
        let kept = pending.filter { p in !(p.phase == .sent && (seen(p.match) > p.had || now.timeIntervalSince(p.at) > 600)) }
        pending = kept
    }

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
            .map(QueuedMessage.init(event:))
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
                out.append(ChatEntry(id: "e\(ev.id)", kind: .user, text: text, ts: ev.ts, eventID: ev.id,
                                     origin: d.field("origin")?.stringValue, decided: d.field("decided")?.stringValue,
                                     userText: d.field("user_text")?.stringValue))
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
    static func entries(from items: [TimelineItem], events: [AgentEvent] = [], assistant: Bool = false) -> [ChatEntry] {
        let users = events.filter { $0.kind == "user" }
        let byID = Dictionary(users.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        let byText = Dictionary(grouping: users, by: { $0.data.field("text")?.stringValue ?? "" })
        return items.enumerated().compactMap { i, item in
            let id = "t\(i)"
            switch item.kind {
            case "user":
                // what Papertown sent the assistant to start it is not something you said: one line, as on the web
                if assistant, let text = item.text, startBrief.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil {
                    return ChatEntry(id: id, kind: .note, text: "小助手已启动，首先读取了其说明。", ts: item.ts)
                }
                // A transcript index or a tool call ID is not an agent event ID.
                let eventID = item.eventID ?? item.data?.eventID
                let matches = (byText[item.text ?? ""] ?? []).filter { $0.ts == item.ts }
                let event = eventID.flatMap { byID[$0] } ?? (matches.count == 1 && eventID == nil ? matches[0] : nil)
                return ChatEntry(id: id, kind: .user, text: item.text ?? "", ts: item.ts, eventID: eventID ?? event?.id,
                                 origin: item.origin ?? item.data?.origin ?? event?.data.field("origin")?.stringValue,
                                 decided: item.decided ?? item.data?.decided ?? event?.data.field("decided")?.stringValue,
                                 userText: event?.data.field("user_text")?.stringValue ?? item.userText ?? item.data?.userText)
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

    private static let startBrief = try! NSRegularExpression(pattern: #"\A\s*(<start>|你是 Papertown 中控屏的小助手|请先完整阅读 \S+/\.papertown/intro\.md)"#)

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
