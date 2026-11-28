import PapertownCore
import SwiftUI

// Hiring a member of staff for a project's post and starting it the way you choose (Paseo, a terminal in herdr, tmux or
// Papertown's own, or pi), or taking over a conversation already in Paseo; and, for one member, its earlier
// conversations, a fresh one, the project brief, closing its terminal. web/src/agents/Hire.tsx, components/AgentRoom.tsx.

private let runtimes = ["paseo", "herdr", "tmux", "headless", "pi"]
private let cliNames = ["claude": "Claude Code", "codex": "Codex", "antigravity": "Antigravity"]

struct HireSheet: View {
    var projectID: String? = nil
    var role: String? = nil
    var agentID: String? = nil
    var nodeID: String? = nil
    let opened: (StaffAgent?) -> Void
    @EnvironmentObject private var store: TownStore
    @Environment(\.dismiss) private var dismiss

    @State private var line = ""
    @State private var post = "coder"
    @State private var mode = "start"
    @State private var runtime = ""
    @State private var provider = ""
    @State private var model = ""
    @State private var thinking = ""
    @State private var backends: Backends?
    @State private var paseo: PaseoInfo?
    @State private var pi: Roster.Available?
    @State private var loaded = false
    @State private var busy = false
    @State private var error: String?

    private var isAssistant: Bool { role == "assistant" || agentID == "assistant" }
    private var isNode: Bool { nodeID != nil || (agentID?.hasPrefix("node-") ?? false) }
    private var allowsPi: Bool { !isNode && post != "lead" }
    private var allowsImport: Bool { !isAssistant && agentID == nil && (isNode || post != "lead") && paseo?.status.ok == true && paseo?.chatOn == true }
    private var needsProject: Bool { !isAssistant && agentID == nil }

    var body: some View {
        let lang = store.language
        NavigationStack {
            Form {
                if needsProject && store.projects.isEmpty {
                    Text(lang.string("hire.no_projects")).foregroundStyle(.secondary)
                } else {
                    Section {
                        if needsProject && projectID == nil {
                            Picker(lang.string("hire.project"), selection: $line) {
                                ForEach(store.projects) { p in Text("#\(p.seq) \(lang.server(p.title))").tag(p.id) }
                            }
                        }
                        if !isAssistant && role == nil && nodeID == nil && agentID == nil {
                            Picker(lang.string("hire.post"), selection: $post) {
                                ForEach(["coder", "writer", "lead"], id: \.self) { Text(TextFormatters.roleName($0, language: lang)).tag($0) }
                            }
                            .pickerStyle(.segmented)
                        }
                        Text(lang.string(isNode ? "hire.post.node" : isAssistant ? "hire.post.assistant" : "hire.post.\(post)"))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if let running = runningAgent {
                        Section {
                            Text(lang.string("hire.running"))
                            Button(lang.string("hire.open")) { opened(running); dismiss() }
                        }
                    } else if !loaded {
                        ProgressView().frame(maxWidth: .infinity)
                    } else {
                        if allowsImport {
                            Picker("", selection: $mode) {
                                Text(lang.string("hire.mode.start")).tag("start")
                                Text(lang.string("hire.mode.import")).tag("import")
                            }
                            .pickerStyle(.segmented)
                            .labelsHidden()
                        }
                        if mode == "import" && allowsImport {
                            ImportConversationList(projectID: line, role: post, nodeID: nodeID) { agent in opened(agent); dismiss() }
                        } else {
                            startForm(lang)
                        }
                    }
                }
                if let error {
                    Section { Text(error).emState(.bad, detail: true).font(.footnote) }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(lang.string(nodeID != nil ? "hire.node_title" : isAssistant ? "hire.assistant_title" : (projectID == nil && agentID == nil ? "hire.title" : "hire.start_title")))
            .papertownInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(lang.string("action.cancel")) { dismiss() }.disabled(busy) }
                if mode == "start" && runningAgent == nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(lang.string(nodeID != nil ? "hire.node_start" : isAssistant ? "hire.start_assistant" : "hire.start")) { start() }
                            .disabled(busy || !loaded || (needsProject && line.isEmpty) || blocked(runtime) != nil || (runtime != "pi" && provider.isEmpty))
                    }
                }
            }
            .interactiveDismissDisabled(busy)
        }
        .task { await load() }
        .onChange(of: post) { _ in pickRuntime(); pickProvider() }
        .onChange(of: runtime) { _ in pickProvider() }
        .onChange(of: provider) { _ in pickModel() }
        .onChange(of: model) { _ in thinking = currentModel?.defaultThinking ?? "" }
    }

    @ViewBuilder
    private func startForm(_ lang: AppLanguage) -> some View {
        Section {
            if offered.count > 1 {
                Picker(lang.string("hire.runtime"), selection: $runtime) {
                    ForEach(offered, id: \.self) { r in
                        Text(runtimeName(r, lang) + (blocked(r) != nil ? " · " + lang.string("hire.unavailable") : "")).tag(r)
                    }
                }
            } else {
                HStack {
                    Text(lang.string("hire.runtime"))
                    Spacer()
                    Text(runtimeName(runtime, lang)).foregroundStyle(.secondary)
                }
            }
            if let why = blocked(runtime) {
                Text(lang.server(why)).font(.caption).emState(.warn, detail: true)
            } else {
                Text(lang.string(isAssistant && runtime == "headless" ? "runtime.background.sub" : "runtime.\(runtime).sub")).font(.caption).foregroundStyle(.secondary)
            }
        }
        if runtime != "pi" && blocked(runtime) == nil {
            Section {
                Picker(lang.string(runtime == "paseo" ? "hire.provider" : "hire.cli"), selection: $provider) {
                    ForEach(providers, id: \.id) { p in Text(p.label).tag(p.id) }
                }
                if !models.isEmpty || runtime != "paseo" {
                    Picker(lang.string("hire.model"), selection: $model) {
                        if runtime != "paseo" { Text(lang.string("hire.cli_default")).tag("") }
                        ForEach(models) { m in Text(m.name ?? m.id).tag(m.id) }
                    }
                }
                if let t = currentModel?.thinking, t.count > 1 {
                    Picker(lang.string("hire.thinking"), selection: $thinking) {
                        ForEach(t, id: \.self) { Text($0).tag($0) }
                    }
                }
            } footer: {
                if runtime != "paseo" && models.isEmpty { Text(lang.string("hire.no_paseo_models")) }
            }
        }
    }

    // MARK: choices

    /// The ways to run it. The assistant runs in the background only: its page shows the conversation, and its
    /// terminal is with the others under 后台终端, so herdr and tmux are not offered for it.
    private var offered: [String] {
        let all = runtimes.filter { $0 != "pi" || allowsPi }
        guard isAssistant else { return all }
        return all.filter { $0 == "headless" || $0 == "pi" || ($0 == "paseo" && paseo?.chatOn == true) }
    }

    private func runtimeName(_ r: String, _ lang: AppLanguage) -> String {
        lang.string(isAssistant && r == "headless" ? "runtime.background" : "runtime.\(r)")
    }

    private static func isRunning(_ a: StaffAgent) -> Bool {
        a.started == true && !a.isOffline && a.term?.status != "exited"
    }

    private var runningAgent: StaffAgent? {
        if nodeID != nil { return nil }
        if isAssistant {
            guard let a = store.assistantAgent, Self.isRunning(a) else { return nil }
            return a
        }
        if let agentID {
            guard let a = store.allStaffAgents.map(\.agent).first(where: { $0.id == agentID }), Self.isRunning(a) else { return nil }
            return a
        }
        guard !line.isEmpty else { return nil }
        guard let a = store.allStaffAgents.map(\.agent).first(where: { $0.id == "\(post)-\(line)" }), Self.isRunning(a) else { return nil }
        if post == "lead" {
            let state = store.projects.first(where: { $0.id == line })?.lead.state
            guard state == "running" || state == "starting" else { return nil }
        }
        return a
    }

    private func blocked(_ r: String) -> String? {
        switch r {
        case "paseo":
            if paseo?.chatOn == false { return store.language.string("hire.paseo_off") }
            return paseo?.status.ok == true ? nil : (paseo?.status.note ?? store.language.string("hire.paseo_down"))
        case "pi":
            if isNode { return store.language.string("hire.pi_node") }
            if post == "lead" { return store.language.string("hire.pi_lead") }
            return pi?.ok == false ? (pi?.note ?? "") : nil
        default:
            guard let b = backends?.state(r) else { return store.language.string("hire.unavailable") }
            if !b.ok { return b.note ?? store.language.string("hire.unavailable") }
            return clis.isEmpty ? store.language.string("hire.no_cli") : nil
        }
    }

    private var clis: [String] {
        ["claude", "codex", "antigravity"].filter { (backends?.clis?[$0] ?? nil) != nil }
    }

    private var providers: [(id: String, label: String)] {
        if runtime == "paseo" { return (paseo?.providers ?? []).map { ($0.id, $0.label ?? $0.id) } }
        return clis.map { ($0, cliNames[$0] ?? $0) }
    }

    private var models: [PaseoModel] {
        // Paseo's list, or without Paseo the one it gave before
        return paseo?.providers.first { $0.id == provider }?.models ?? []
    }

    private var currentModel: PaseoModel? { models.first { $0.id == model } }
    private var defaultRoleKey: String { isAssistant ? "assistant" : (post == "lead" ? "lead" : "worker") }

    private func load() async {
        line = projectID ?? store.projects.first?.id ?? ""
        post = role ?? "coder"
        async let b = try? store.fetch { try await $0.backends() }
        async let p = try? store.fetch { try await $0.paseo() }
        async let d = try? store.fetch { try await $0.defaultRuntime() }
        async let r = try? store.fetch { try await $0.roster(role: "coder") }
        backends = await b
        paseo = await p
        pi = await r?.available
        let preferred = await d
        loaded = true
        pickRuntime(preferred)
        pickProvider()
    }

    private func pickRuntime(_ preferred: String? = nil) {
        let order = isAssistant ? ["headless", "paseo", "pi"] : [preferred ?? paseo?.runtime ?? "tmux", "herdr", "tmux", "headless", "paseo"]
        if runtime.isEmpty || !offered.contains(runtime) || blocked(runtime) != nil {
            runtime = order.first { offered.contains($0) && blocked($0) == nil } ?? offered.first ?? "paseo"
        }
    }

    private func pickProvider() {
        let ids = providers.map(\.id)
        guard !ids.contains(provider) else { return pickModel() }
        let wanted = paseo?.defaults?[defaultRoleKey]?.provider
        provider = [wanted, "claude"].compactMap { $0 }.first { ids.contains($0) } ?? ids.first ?? ""
        pickModel()
    }

    private func pickModel() {
        let d = paseo?.defaults?[defaultRoleKey]
        if d?.provider == provider, let m = d?.model, models.contains(where: { $0.id == m }) {
            model = m
        } else if !models.contains(where: { $0.id == model }) {
            model = runtime == "paseo" ? (models.first?.id ?? "") : ""
        }
        thinking = d?.provider == provider && d?.model == model ? (d?.thinking ?? currentModel?.defaultThinking ?? "") : (currentModel?.defaultThinking ?? "")
    }

    private func start() {
        busy = true
        error = nil
        let options = runtime == "pi" ? StartOptions(runtime: "pi", provider: nil, model: nil, thinking: nil)
            : StartOptions(runtime: runtime, provider: provider, model: model.isEmpty ? nil : model, thinking: thinking.isEmpty ? nil : thinking)
        let line = line, post = post, targetID = agentID, nodeID = nodeID, isAssistant = isAssistant
        Task {
            do {
                var started: StaffAgent?
                if let nodeID {
                    let nodeOpts = NodeAgentOptions(runtime: runtime, provider: provider, model: model.isEmpty ? nil : model, thinking: thinking.isEmpty ? nil : thinking)
                    _ = try await store.fetch { try await $0.bindNode(projectID: line, nodeID: nodeID, nodeOpts) }
                } else if isAssistant {
                    started = try await store.fetch { try await $0.startAgent("assistant", options) }
                } else if let targetID {
                    started = try await store.fetch { try await $0.startAgent(targetID, options) }
                    if post == "lead" && !line.isEmpty { await store.toggleLead(projectID: line, on: true) }
                } else {
                    started = try await store.fetch { c -> StaffAgent in
                        let a = try await c.openAgent(projectID: line, role: post)
                        return try await c.startAgent(a.id, options)
                    }
                    if post == "lead" { await store.toggleLead(projectID: line, on: true) }
                }
                await store.refreshAll()
                opened(started)
                dismiss()
            } catch {
                self.error = store.message(for: error)
            }
            busy = false
        }
    }
}

/// Conversations already in Paseo, to hand to a project's post or a task node.
struct ImportConversationList: View {
    let projectID: String
    let role: String
    var nodeID: String? = nil
    let imported: (StaffAgent?) -> Void
    @EnvironmentObject private var store: TownStore
    @State private var list: [PaseoConversation]?
    @State private var query = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        let lang = store.language
        Section {
            if let list {
                if list.count > 5 {
                    PromptField(lang.string("hire.import.filter"), text: $query)
                }
                let q = query.lowercased()
                let shown = list.filter { c in q.isEmpty || [c.title, c.provider, c.model, c.cwd].compactMap { $0?.lowercased() }.contains { $0.contains(q) } }
                if list.isEmpty { Text(lang.string("hire.import.none")).foregroundStyle(.secondary) }
                ForEach(shown) { c in
                    Button { take(c) } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(c.title ?? lang.string("hire.untitled")).foregroundStyle(.primary).lineLimit(2)
                            Text([c.provider, c.model, c.cwd.map(shortPath), Stamp.ago(c.lastUser ?? c.updated, lang)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            if let who = c.linked { Text(lang.format("hire.import.linked", lang.server(who))).font(.caption).foregroundStyle(.secondary) }
                            if c.cwd == nil { Text(lang.string("hire.import.no_cwd")).font(.caption).emState(.warn, detail: true) }
                        }
                    }
                    .disabled(busy || c.linked != nil || c.cwd == nil)
                }
            } else if let error {
                Text(error).emState(.bad, detail: true).font(.footnote)
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        } footer: {
            Text(lang.string("hire.import.footer"))
        }
        .task {
            do { list = try await store.fetch { try await $0.paseoConversations() } } catch { self.error = store.message(for: error) }
        }
    }

    private func shortPath(_ p: String) -> String { "~/" + p.split(separator: "/").suffix(2).joined(separator: "/") }

    private func take(_ c: PaseoConversation) {
        busy = true
        Task {
            do {
                var agent: StaffAgent?
                if let nodeID {
                    _ = try await store.fetch { try await $0.bindNode(projectID: projectID, nodeID: nodeID, NodeAgentOptions(extID: c.id)) }
                } else {
                    agent = try await store.fetch { try await $0.importConversation(projectID: projectID, role: role, id: c.id) }
                }
                await store.refreshAll()
                imported(agent)
            } catch {
                self.error = store.message(for: error)
            }
            busy = false
        }
    }
}

/// An agent's earlier conversations (Paseo), one to go back to, or a fresh one.
struct ConversationsSheet: View {
    let agentID: String
    let changed: () -> Void
    @EnvironmentObject private var store: TownStore
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        let lang = store.language
        NavigationStack {
            LoadingList(load: { try await $0.conversations(agentID: agentID) }) { list in
                PageList {
                    if list.isEmpty { Text(lang.string("convs.none")).foregroundStyle(.secondary) }
                    ForEach(list) { c in
                        Button { resume(c.id) } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(c.title ?? lang.string("hire.untitled")).foregroundStyle(.primary).lineLimit(2)
                                Text([c.current == true ? lang.string("convs.current") : Stamp.ago(c.at, lang), c.model].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                                    .font(.caption).foregroundStyle(c.current == true ? store.appearance.tintColor : .secondary)
                            }
                        }
                        .disabled(busy || c.current == true)
                    }
                    if let error { Text(error).emState(.bad, detail: true).font(.footnote) }
                }
                .papertownInsetGroupedList()
            }
            .navigationTitle(lang.string("convs.title"))
            .papertownInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(lang.string("action.done")) { dismiss() } }
            }
        }
    }

    private func resume(_ id: String) {
        busy = true
        Task {
            do {
                try await store.fetch { try await $0.resumeConversation(agentID: agentID, id: id) }
                changed()
                dismiss()
            } catch {
                self.error = store.message(for: error)
            }
            busy = false
        }
    }
}
