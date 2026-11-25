import PapertownCore
import SwiftUI

private func moduleName(_ id: String, _ lang: AppLanguage, mods: [DecidedModule]? = nil) -> String {
    if DecidedModule.order.contains(id) { return lang.string("decided.mod.\(id)") }
    return lang.server(mods?.first { $0.id == id }?.name ?? id)
}

struct ModulePicker: View {
    @Binding var selection: String
    var allowStage = false
    @EnvironmentObject private var store: TownStore

    var body: some View {
        let lang = store.language
        Picker(lang.string("decided.module"), selection: $selection) {
            if allowStage { Text(lang.string("decided.stage_module")).tag("") }
            ForEach(DecidedModule.order, id: \.self) { id in Text(moduleName(id, lang)).tag(id) }
        }
        .pickerStyle(.menu)
    }
}

struct DecidedStatsLine: View {
    let stats: DecidedStats?
    var projectSummary = false
    @EnvironmentObject private var store: TownStore

    var body: some View {
        let lang = store.language
        RecordStatsLine(items: [
            .init(label: projectSummary ? "" : lang.string("decided.nav"), count: stats?.total),
            .init(label: lang.string("decided.state.active"), count: projectSummary ? nil : stats?.active),
            .init(label: lang.string("decided.anchored"), count: stats?.anchored, tone: .good),
            .init(label: lang.string("decided.unanchored"), count: stats?.loose, attention: true)
        ], empty: projectSummary ? lang.string("records.none") : nil)
    }
}

struct DecidedPage: View {
    let projectID: String
    @EnvironmentObject private var store: TownStore
    @State private var writing = false
    @State private var filter = "all"
    @State private var showEnded = false

    var body: some View {
        let lang = store.language
        LivePage(load: { try await $0.decided(projectID: projectID) }, events: ["decided", "prov", "job", "line", "canvas"], projectID: projectID) { list, _ in
            let records = (list.decisions ?? []).sorted { lhs, rhs in
                let a = Stamp.date(lhs.createdAt) ?? .distantPast, b = Stamp.date(rhs.createdAt) ?? .distantPast
                return a == b ? (lhs.n ?? 0) > (rhs.n ?? 0) : a > b
            }
            let active = records.filter(\.isActive)
            let groups = active.map { $0.mod ?? "overview" }.reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
            let loose = list.loose ?? []
            let modules = DecidedModule.order.filter(groups.contains) + groups.filter { !DecidedModule.order.contains($0) }
            let filters = ["all"] + modules + (loose.isEmpty ? [] : ["loose"])
            let selected = filters.contains(filter) ? filter : "all"
            let ended = records.filter { !$0.isActive && (selected == "all" || ($0.mod ?? "overview") == selected) }
            List {
                if !records.isEmpty || !loose.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        DecidedStatsLine(stats: list.stats)
                        if groups.count > 1 || !loose.isEmpty { filterBar(filters, selected: selected, mods: list.mods, lang: lang) }
                    }
                    .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 0, trailing: 4))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                }
                if selected == "loose" {
                    Section(lang.string("decided.loose")) { WorkRows(projectID: projectID, work: loose) }
                        .papertownRowBackground(store.appearance)
                } else {
                    if records.isEmpty {
                        Text(lang.string("decided.empty")).font(.subheadline).foregroundStyle(.secondary)
                            .listRowBackground(Color.clear)
                    }
                    ForEach(groups.filter { selected == "all" || selected == $0 }, id: \.self) { mod in
                        Section(moduleName(mod, lang, mods: list.mods)) {
                            ForEach(active.filter { ($0.mod ?? "overview") == mod }) { d in row(d, lang) }
                        }
                        .papertownRowBackground(store.appearance)
                    }
                    if !ended.isEmpty {
                        Section {
                            Button { showEnded.toggle() } label: {
                                HStack {
                                    EmText(lang.format("decided.ended.count", ended.count), .numbers(.info))
                                    Spacer()
                                    Image(systemName: showEnded ? "chevron.down" : "chevron.right")
                                        .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                                }
                                .contentShape(Rectangle())
                            }
                            .font(.subheadline).buttonStyle(.plain)
                            if showEnded { ForEach(ended) { d in row(d, lang) } }
                        }
                        .papertownRowBackground(store.appearance)
                    }
                }
            }
            .recordList(store.appearance)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button(lang.string("decided.write")) { writing = true }
                }
            }
            .sheet(isPresented: $writing) {
                WriteDecisionSheet(projectID: projectID, records: records)
                    .papertownSheetFrame(height: 440)
            }
        }
        .navigationTitle(lang.string("decided.nav"))
        .papertownInlineTitle()
        .papertownHidesTabBar()
    }

    private func filterBar(_ filters: [String], selected: String, mods: [DecidedModule]?, lang: AppLanguage) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 18) {
                ForEach(filters, id: \.self) { mod in
                    let name = mod == "all" ? lang.string("projects.filter.all") :
                        mod == "loose" ? lang.string("decided.loose") : moduleName(mod, lang, mods: mods)
                    Button { filter = mod } label: {
                        Text(name).font(.subheadline.weight(selected == mod ? .semibold : .regular))
                            .foregroundStyle(selected == mod ? store.appearance.tintColor : .secondary)
                            .padding(.vertical, 8)
                            .overlay(alignment: .bottom) {
                                if selected == mod { Rectangle().fill(store.appearance.tintColor).frame(height: 2) }
                            }
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selected == mod ? .isSelected : [])
                }
            }
        }
    }

    @ViewBuilder
    private func row(_ d: DecidedRecord, _ lang: AppLanguage) -> some View {
        if let id = d.id {
            NavigationLink { DecidedDetailPage(projectID: projectID, recordID: id) } label: {
                HStack(alignment: .firstTextBaseline, spacing: 9) {
                    Text(d.number).font(.subheadline.monospaced()).foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(d.text ?? "").font(.subheadline).lineLimit(2).emBar(.info)
                        HStack(spacing: 8) {
                            Text(decisionMetadata(d, lang)).monospacedDigit().foregroundStyle(.secondary)
                            DecisionState(state: d.state)
                        }
                        .font(.caption)
                    }
                }
                .padding(.vertical, 2)
            }
        }
    }
}

private func decisionMetadata(_ d: DecidedRecord, _ lang: AppLanguage) -> String {
    [d.source.map { lang.string("decided.source.\($0)") }, d.createdAt.map { Stamp.compact($0) }]
        .compactMap { $0 }.joined(separator: " · ")
}

private struct DecisionState: View {
    let state: String?
    @Environment(\.colorScheme) private var scheme
    @EnvironmentObject private var store: TownStore
    var body: some View {
        if let state, state == "replaced" || state == "withdrawn" {
            Text(store.language.string("decided.state.\(state)")).font(.caption2)
                .emState(EmTone.issue(state), icon: state == "replaced" ? "arrow.triangle.2.circlepath" : "minus.circle")
        }
    }
}

struct DecidedDetailPage: View {
    let projectID: String
    let recordID: String
    @EnvironmentObject private var store: TownStore
    @State private var rewriting = false
    @State private var withdrawing = false

    var body: some View {
        let lang = store.language
        LivePage(load: { client in
            let d = try await client.decidedRecord(projectID: projectID, id: recordID)
            let list = d.replaces != nil || d.replacedBy != nil ? try? await client.decided(projectID: projectID) : nil
            return (d, list)
        }, events: ["decided", "prov", "job", "canvas", "line"], projectID: projectID) { value, act in
            let (d, list) = value
            List {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(d.text ?? "").font(.body).emBar(.info).textSelection(.enabled)
                        HStack(spacing: 8) {
                            Text([d.mod.map { moduleName($0, lang) }, decisionMetadata(d, lang)].compactMap { $0 }.joined(separator: " · "))
                                .font(.caption).monospacedDigit().foregroundStyle(.secondary)
                            DecisionState(state: d.state)
                        }
                    }
                    .padding(.vertical, 3)
                    if let end = d.endedAt { InfoRow(label: lang.string("decided.ended_at"), value: Stamp.short(end, lang)) }
                }
                .papertownRowBackground(store.appearance)
                if let m = d.matter {
                    Section(lang.string("decided.group.matter")) {
                        if let q = m.question { EmText(q).font(.subheadline) }
                        if m.facts?.isEmpty == false || m.options?.isEmpty == false {
                            DisclosureGroup(lang.string("decided.view_facts")) {
                                MatterFields(projectID: projectID, facts: m.facts, options: m.options, materials: nil)
                            }
                            .font(.subheadline).tint(.secondary)
                        }
                    }
                    .papertownRowBackground(store.appearance)
                }
                if let materials = d.materials ?? d.matter?.materials, !materials.isEmpty {
                    Section(lang.string("decided.materials")) { MaterialRows(projectID: projectID, materials: materials) }
                        .papertownRowBackground(store.appearance)
                }
                Section(lang.string("decided.work")) { WorkRows(projectID: projectID, work: d.work?.all ?? []) }
                    .papertownRowBackground(store.appearance)
                if d.replaces != nil || d.replacedBy != nil {
                    Section(lang.string("decided.relations")) {
                        relation(d.replaces, "decided.replaces", list, lang)
                        relation(d.replacedBy, "decided.replaced_by", list, lang)
                    }
                    .papertownRowBackground(store.appearance)
                }
                if d.isActive, let id = d.id {
                    Section {
                        HStack {
                            Button(lang.string("decided.rewrite")) { rewriting = true }
                            Spacer()
                            Button(lang.string("decided.withdraw"), role: .destructive) { withdrawing = true }
                                .font(.subheadline)
                                .confirmationDialog(lang.format("decided.withdraw.confirm", d.number), isPresented: $withdrawing, titleVisibility: .visible) {
                                    Button(lang.string("decided.withdraw"), role: .destructive) {
                                        act.run { client in
                                            try await client.withdrawDecision(projectID: projectID, id: id)
                                            await store.decisionChanged(projectID)
                                        }
                                    }
                                    Button(lang.string("action.cancel"), role: .cancel) {}
                                }
                        }
                        .buttonStyle(.borderless)
                    }
                    .disabled(act.busy)
                    .papertownRowBackground(store.appearance)
                }
            }
            .recordList(store.appearance)
            .navigationTitle(d.number)
            .sheet(isPresented: $rewriting) {
                WriteDecisionSheet(projectID: projectID, replacing: d)
                    .papertownSheetFrame(height: 440)
            }
        }
        .papertownInlineTitle()
        .papertownHidesTabBar()
    }

    @ViewBuilder
    private func relation(_ ref: String?, _ key: String, _ list: DecidedList?, _ lang: AppLanguage) -> some View {
        if let ref {
            let other = list?.record(ref)
            NavigationLink { DecidedDetailPage(projectID: projectID, recordID: other?.id ?? ref) } label: {
                Text([lang.string(key), other?.number ?? ref, other?.text].compactMap { $0 }.joined(separator: " · ")).lineLimit(2).emBar(other?.text == nil ? nil : .info)
            }
        }
    }
}

struct WriteDecisionSheet: View {
    let projectID: String
    var records: [DecidedRecord] = []
    var replacing: DecidedRecord?
    var quote: ChatEntry?
    let onQuoted: (Int, String) -> Void
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: TownStore
    @State private var mod: String
    @State private var text: String
    @State private var replaces: String
    @State private var busy = false
    @State private var error: String?

    init(projectID: String, records: [DecidedRecord] = [], replacing: DecidedRecord? = nil,
         quote: ChatEntry? = nil, onQuoted: @escaping (Int, String) -> Void = { _, _ in }) {
        self.projectID = projectID
        self.records = records
        self.replacing = replacing
        self.quote = quote
        self.onQuoted = onQuoted
        _mod = State(initialValue: replacing?.mod ?? "overview")
        _text = State(initialValue: quote?.userText ?? quote?.text ?? replacing?.text ?? "")
        _replaces = State(initialValue: replacing?.id ?? "")
    }

    var body: some View {
        let lang = store.language
        NavigationStack {
            Form {
                Section(lang.string("decided.content")) {
                    if quote != nil { Text(text).emBar(.info).textSelection(.enabled) }
                    else { TextField(lang.string("decided.placeholder"), text: $text, axis: .vertical).lineLimit(3...10).emBar(text.isEmpty ? nil : .info, reserve: true) }
                }
                .papertownRowBackground(store.appearance)
                Section {
                    ModulePicker(selection: $mod)
                    if let replacing {
                        InfoRow(label: lang.string("decided.replaces"), value: replacing.number)
                    } else if quote == nil, records.contains(where: \.isActive) {
                        Picker(lang.string("decided.replaces"), selection: $replaces) {
                            Text(lang.string("decided.replace.none")).tag("")
                            ForEach(records.filter(\.isActive)) { d in
                                if let id = d.id { Text("\(d.number) · \(d.text ?? "")").lineLimit(2).tag(id) }
                            }
                        }
                    }
                }
                .papertownRowBackground(store.appearance)
                if let error { Text(error).font(.footnote).emState(.bad, detail: true) }
            }
            .papertownListAppearance(store.appearance)
            .disabled(busy)
            .navigationTitle(lang.string(quote != nil ? "decided.quote" : replacing == nil ? "decided.write" : "decided.rewrite"))
            .papertownInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(lang.string("action.cancel")) { dismiss() }.disabled(busy) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(lang.string("decided.settle")) { Task { await save() } }
                        .disabled(busy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .interactiveDismissDisabled(busy)
        }
        .tint(store.appearance.tintColor)
        .preferredColorScheme(store.appearance.colorScheme)
    }

    private func save() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            if let quote {
                guard let id = quote.eventID else { throw ClientError.invalidResponse }
                let record = try await store.fetch { try await $0.quoteDecision(projectID: projectID, eventID: id, mod: mod) }
                if record.n != nil { onQuoted(id, record.number) }
            } else {
                try await store.fetch { _ = try await $0.writeDecision(projectID: projectID, text: text, mod: mod, replaces: replaces.nonEmpty) }
            }
            await store.decisionChanged(projectID)
            dismiss()
        } catch {
            self.error = store.message(for: error)
        }
    }
}

/// Options fill the writer's draft. In a saved decision the same list is read-only.
struct MatterFields: View {
    let projectID: String
    let facts: [String]?
    let options: [String]?
    let materials: [DecisionMaterial]?
    var choose: ((String) -> Void)? = nil
    @EnvironmentObject private var store: TownStore

    var body: some View {
        let lang = store.language
        if let facts, !facts.isEmpty {
            Text(lang.string("decided.facts")).font(.caption).foregroundStyle(.secondary)
            BulletList(items: facts)
        }
        if let options, !options.isEmpty {
            Text(lang.string("decided.options")).font(.caption).foregroundStyle(.secondary)
            if let choose {
                ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                    Button { choose(option) } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Image(systemName: "arrow.down.left").font(.caption2).foregroundStyle(.secondary)
                            Text(option).multilineTextAlignment(.leading)
                        }
                    }
                    .buttonStyle(.borderless).foregroundStyle(.primary).font(.subheadline)
                }
            } else {
                BulletList(items: options)
            }
        }
        if let materials, !materials.isEmpty {
            Text(lang.string("decided.materials")).font(.caption).foregroundStyle(.secondary)
            MaterialRows(projectID: projectID, materials: materials)
        }
    }
}

private struct MaterialRows: View {
    let projectID: String
    let materials: [DecisionMaterial]

    var body: some View {
        ForEach(Array(materials.enumerated()), id: \.offset) { _, m in
            let ref = m.ref ?? ""
            let label = m.title?.nonEmpty ?? ref
            if let url = URL(string: ref), ["https", "http"].contains(url.scheme?.lowercased() ?? "") {
                Link(label, destination: url)
            } else if m.kind == "arxiv", !ref.isEmpty {
                Link(label, destination: URL(string: "https://arxiv.org/abs/")!.appendingPathComponent(ref))
            } else if m.kind == "page", !ref.isEmpty {
                NavigationLink(label) { PageViewer(projectID: projectID, pageID: ref, title: m.title ?? ref) }
            } else if m.kind == "report" { NavigationLink(label) { ReportsPage(projectID: projectID, reportID: Int(ref)) } }
            else if m.kind == "job" { NavigationLink(label) { JobPage(jobID: ref) } }
            else if m.kind == "prov" { NavigationLink(label) { ProvNodePage(projectID: projectID, nodeID: ref) } }
            else if let (root, path) = file(ref, kind: m.kind) {
                NavigationLink(label) { FileTextPage(projectID: projectID, root: root, path: path) }
            } else {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(label)
                        if !ref.isEmpty, label != ref { Text(ref).font(.caption.monospaced()).foregroundStyle(.secondary) }
                    }
                } icon: { Image(systemName: "paperclip") }
                .font(.footnote).textSelection(.enabled)
            }
        }
        .buttonStyle(.borderless)
        .font(.subheadline)
    }

    private func file(_ ref: String, kind: String?) -> (String, String)? {
        if let separator = ref.firstIndex(where: { $0 == "/" || $0 == ":" }) {
            let root = String(ref[..<separator])
            if root == "paper" || root == "code" { return (root, String(ref[ref.index(after: separator)...])) }
        }
        return kind == "file" && !ref.isEmpty ? ("code", ref) : nil
    }
}

struct BasisSection: View {
    let projectID: String
    let basis: [String]?
    @EnvironmentObject private var store: TownStore

    var body: some View {
        if let basis {
            Section(store.language.string("decided.basis")) {
                if basis.isEmpty { Text(store.language.string("decided.basis.empty")).font(.caption).emState(.warn) }
                ForEach(basis, id: \.self) { ref in
                    if ref.hasPrefix("#") {
                        NavigationLink(ref) { LoopTaskPage(projectID: projectID, nodeID: String(ref.dropFirst())) }
                    } else {
                        NavigationLink(ref) { DecidedDetailPage(projectID: projectID, recordID: ref) }
                    }
                }
            }
            .papertownRowBackground(store.appearance)
        }
    }
}

private struct WorkRows: View {
    let projectID: String
    let work: [Work]
    @EnvironmentObject private var store: TownStore

    var body: some View {
        let lang = store.language
        if work.isEmpty { Text(lang.string("decided.work.empty")).font(.footnote).foregroundStyle(.secondary) }
        ForEach(Array(work.enumerated()), id: \.offset) { _, item in
            NavigationLink { destination(item) } label: {
                VStack(alignment: .leading, spacing: 3) {
                    Group {
                        if item.kind == "task", item.who == "你" || item.who == "you" {
                            Text(item.title ?? item.id ?? "").emBar(.info)
                        } else if item.kind == "tell" {
                            EmText(item.title ?? item.id ?? "")
                        } else {
                            Text(item.title ?? item.id ?? "")
                        }
                    }
                    .font(.subheadline)
                    Text([item.kind.map { lang.string("decided.work.\($0)") }, item.who.map(lang.server), item.at.map { Stamp.compact($0) }]
                        .compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder
    private func destination(_ w: Work) -> some View {
        let id = w.id ?? ""
        switch w.kind {
        case "job": JobPage(jobID: id)
        case "task": LoopTaskPage(projectID: projectID, nodeID: id)
        case "prov": ProvNodePage(projectID: projectID, nodeID: id)
        case "tell": AssignmentPage(projectID: projectID, work: w)
        case "output":
            let project = store.projects.first { $0.id == projectID }
            let stage = project?.items?.first { $0.id == id }?.stage
            switch w.stage ?? stage ?? id {
            case "method": MethodPage(projectID: projectID)
            case "exp": ExperimentsPage(projectID: projectID)
            case "write", "review", "ship": PaperPage(projectID: projectID)
            case "hatch": OverlapPage(projectID: projectID)
            default: ProjectDetailView(projectID: projectID)
            }
        default: ProjectDetailView(projectID: projectID)
        }
    }
}

/// A tell is an event. Its text and author remain visible even if the corresponding conversation has closed.
private struct AssignmentPage: View {
    let projectID: String
    let work: Work
    @EnvironmentObject private var store: TownStore
    @State private var sender: StaffAgent?
    @State private var recipient: String?

    var body: some View {
        let lang = store.language
        List {
            Section {
                EmText(work.title ?? "").textSelection(.enabled)
                if let who = work.who { InfoRow(label: lang.string("prov.who"), value: lang.server(who)) }
                if let at = work.at { InfoRow(label: lang.string("prov.time"), value: Stamp.short(at, lang)) }
                if let sender {
                    NavigationLink {
                        AgentChatView(agentID: sender.id, role: sender.role, subtitle: work.who ?? "", focusEventID: work.id.flatMap(Int.init))
                    } label: { Label(lang.string("action.view_chat"), systemImage: "bubble.left.and.bubble.right") }
                }
                if let recipient { InfoRow(label: lang.string("decided.recipient"), value: recipient) }
            }
            BasisSection(projectID: projectID, basis: work.basis)
        }
        .papertownInsetGroupedList()
        .papertownListAppearance(store.appearance)
        .navigationTitle(lang.string("decided.work.tell"))
        .papertownInlineTitle()
        .task {
            guard let id = work.id.flatMap(Int.init), id > 0 else { return }
            let project = store.projects.first { $0.id == projectID }
            let agents = store.allStaffAgents.filter { $0.project?.id == projectID || $0.agent.lineID == projectID }.map(\.agent)
            var seen: Set<String> = []
            let candidates = [work.agent, agents.first { $0.name == work.who }?.id, project?.leadAgentID ?? "lead-\(projectID)"].compactMap { $0 }
                + agents.map(\.id) + (project?.team.map(\.id) ?? []) + ["assistant"]
            for agent in candidates where seen.insert(agent).inserted {
                guard !Task.isCancelled else { return }
                guard let read = try? await store.fetch({ try await $0.agentEvents(agentID: agent, after: id - 1) }),
                      let event = read.events.first(where: { $0.id == id && $0.kind == "sent" }) else { continue }
                sender = read.agent
                recipient = event.data.field("who")?.stringValue.map(lang.server) ?? event.data.field("to")?.stringValue
                return
            }
        }
    }
}
