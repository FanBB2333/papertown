import PapertownCore
import SwiftUI

// What waits on the user, requests for a new card and the lead's rounds.

extension ReportItem {
    var pendingDecision: Decision {
        let m = data.matter
        return Decision(kind: m == nil ? "ask" : "matter", id: String(id), agent: agentID, who: data.who ?? "",
                        title: data.question ?? m?.question ?? data.text ?? "", detail: "",
                        options: (data.choices ?? []).map { DecisionOption(label: $0, value: .string($0)) },
                        free: true, since: ts, mod: m?.mod, facts: m?.facts, optionsText: m?.options,
                        materials: m?.materials, write: m == nil ? nil : true)
    }
}

extension TownStore {
    func decisions(_ projectID: String) -> [Decision] {
        if let rows = cards[projectID]?.decisions { return rows }
        let asks = openAsks.filter { $0.lineID == projectID && $0.data.open != false }.map(\.pendingDecision)
        let titles = Set(asks.map(\.title))
        let needs = (cards[projectID]?.card?.needYou ?? []).filter { !titles.contains($0) }
        return asks + needs.map { Decision(kind: "need", id: $0, agent: nil, who: "", title: $0, detail: "", options: [], free: true) }
    }
}

// MARK: - 待你决定

struct DecisionsSection: View {
    let projectID: String
    @EnvironmentObject private var store: TownStore

    var body: some View {
        let lang = store.language
        let list = store.decisions(projectID)
        if !list.isEmpty {
            Section(lang.string("decide.title")) {
                ForEach(["matter", "need", "permissions"], id: \.self) { group in
                    ForEach(list.filter { $0.group == group }, id: \.key) { d in
                        DecisionRow(projectID: projectID, d: d, showsGroup: true)
                            .id(d.key)
                            .papertownRowBackground(store.appearance)
                    }
                }
            }
        }
    }
}

struct DecisionRow: View {
    let projectID: String
    let d: Decision
    var showsActionBar = true
    var showsGroup = false
    var onWritten: () -> Void = {}
    @EnvironmentObject private var store: TownStore
    #if os(iOS)
    @Environment(\.verticalSizeClass) private var heightClass
    @Environment(\.dynamicTypeSize) private var typeSize
    #endif
    @State private var busy = false
    @State private var writing = false
    @State private var showingFacts = false
    @State private var error: String?
    @State private var draft = ""
    @State private var module: String?

    var body: some View {
        let lang = store.language
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if showsGroup { Text(lang.string("decided.group.\(d.group)")).fontWeight(.medium) }
                if !showsGroup || !d.writtenAnswer {
                    Text([lang.server(d.who), lang.string("decide.kind.\(d.kind)"), d.since.map { Stamp.ago($0, lang) }]
                        .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
                if d.writtenAnswer, hasFacts {
                    Button { showingFacts.toggle() } label: {
                        HStack(spacing: 4) {
                            Text(lang.string(showingFacts ? "decided.hide_facts" : "decided.view_facts"))
                            Image(systemName: showingFacts ? "chevron.up" : "chevron.down").font(.caption2)
                        }
                    }
                    .buttonStyle(.borderless).foregroundStyle(.secondary)
                }
                if d.kind == "need" {
                    let project = store.projects.first { $0.id == projectID }
                    let stageMod = project?.stages.first { $0.key == project?.stage }?.mod
                    ModulePicker(selection: Binding(get: { module ?? d.mod ?? stageMod ?? "" }, set: { module = $0 }), allowStage: true)
                        .labelsHidden().tint(.secondary).controlSize(.small)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            let question = Text(lang.server(d.title)).font(.subheadline.weight(.medium)).fixedSize(horizontal: false, vertical: true)
            if inlineAnswer {
                HStack(spacing: 20) {
                    question.frame(maxWidth: .infinity, alignment: .leading)
                    answerField(lang).frame(maxWidth: .infinity)
                }
            } else { question }
            if !d.detail.isEmpty && (!d.writtenAnswer || showingFacts) {
                Text(d.detail)
                    .font(.caption.monospaced())
                    .lineLimit(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if d.writtenAnswer {
                writtenForm(lang).disabled(busy || d.ready == false)
            } else if d.kind == "prompt" {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(d.options.enumerated()), id: \.offset) { i, o in
                        Button { pick(o.value) } label: { Text("\(i + 1). \(o.label)").multilineTextAlignment(.leading).frame(maxWidth: .infinity, alignment: .leading) }
                            .buttonStyle(.bordered)
                    }
                }
                .disabled(busy || d.ready == false)
            } else if !d.options.isEmpty {
                WrapLayout {
                    ForEach(Array(d.options.enumerated()), id: \.offset) { _, o in
                        choice(label(o), main: o.main == true) { pick(o.value) }
                    }
                    if d.free && !writing {
                        Button(lang.string("decide.other")) { writing = true }.buttonStyle(.bordered)
                    }
                }
                .controlSize(.small)
                .disabled(busy || d.ready == false)
            }
            if d.kind == "permission", d.options.isEmpty, let agent = d.agent {
                NavigationLink {
                    AgentChatView(agentID: agent, role: agent.components(separatedBy: "-").first ?? "coder", subtitle: lang.server(d.who))
                } label: {
                    Label(lang.string("decide.in_chat"), systemImage: "bubble.left.and.bubble.right")
                }
                .font(.subheadline)
            }
            if !d.writtenAnswer && (writing || (d.free && d.options.isEmpty)) {
                SendField(placeholder: lang.string("decide.write"), button: lang.string("action.send"), disabled: busy) { text in
                    pick(nil, text: text)
                }
            }
            if d.later == true && !d.writtenAnswer {
                Text(lang.string("decide.later")).font(.caption).foregroundStyle(.secondary)
            }
            if let error {
                Text(error).font(.caption).emState(.bad, detail: true)
            }
        }
        .emBar(showsActionBar ? .warn : nil)
        .padding(.vertical, 3)
    }

    private var inlineAnswer: Bool {
        #if os(iOS)
        showsGroup && d.writtenAnswer && !showingFacts && heightClass == .compact && !typeSize.isAccessibilitySize
        #else
        false
        #endif
    }

    @ViewBuilder
    private func writtenForm(_ lang: AppLanguage) -> some View {
        if showingFacts {
            VStack(alignment: .leading, spacing: 6) {
                Text([lang.server(d.who), d.since.map { Stamp.compact($0) }].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary)
                MatterFields(projectID: projectID, facts: d.facts, options: d.optionsText, materials: d.materials) { draft = $0 }
            }
        }
        if !inlineAnswer { answerField(lang) }
    }

    private func answerField(_ lang: AppLanguage) -> some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(lang.string("decided.placeholder"), text: $draft, axis: .vertical)
                .textFieldStyle(.roundedBorder).font(.subheadline).lineLimit(1...7)
                .emBar(draft.isEmpty ? nil : .info, reserve: true)
            if !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Button(lang.string("decided.settle")) { submitWritten() }
                    .buttonStyle(.borderedProminent).controlSize(.small).fixedSize()
            }
        }
        .disabled(busy || d.ready == false)
    }

    private var hasFacts: Bool {
        d.facts?.isEmpty == false || d.optionsText?.isEmpty == false || d.materials?.isEmpty == false || !d.detail.isEmpty
    }

    private func submitWritten() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !busy, !text.isEmpty else { return }
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                let matterID = d.kind == "matter" ? Int(d.id) : nil
                if d.kind == "matter", matterID == nil { throw ClientError.invalidResponse }
                do {
                    _ = try await store.fetch {
                        try await $0.writeDecision(projectID: projectID, text: text, mod: (module ?? d.mod)?.nonEmpty,
                                                   matter: matterID, need: d.kind == "need" ? d.title : nil)
                    }
                } catch ClientError.http(let status, _) where [404, 405].contains(status) && d.kind == "need" && d.write == nil && store.cards[projectID]?.decided == nil {
                    // Older servers accept a card line's written answer through /decide.
                    let card = try await store.fetch { try await $0.decide(projectID: projectID, d, value: nil, text: text) }
                    store.cards[projectID] = card
                }
                draft = ""
                await store.decisionChanged(projectID)
                onWritten()
            } catch {
                self.error = store.message(for: error)
            }
        }
    }

    /// The server's fixed choices in the app's language; an agent's own choices are its words.
    private func label(_ o: DecisionOption) -> String {
        let lang = store.language
        switch o.label {
        case "允许": return lang.string("action.allow")
        case "拒绝": return lang.string("action.deny")
        case "同意": return lang.string("decide.agree")
        case "不同意": return lang.string("decide.disagree")
        default: return d.kind == "ask" ? lang.server(o.label) : o.label
        }
    }

    @ViewBuilder
    private func choice(_ title: String, main: Bool, _ action: @escaping () -> Void) -> some View {
        if main {
            Button(title, action: action).buttonStyle(.borderedProminent)
        } else {
            Button(title, action: action).buttonStyle(.bordered)
        }
    }

    private func pick(_ value: JSONValue?, text: String? = nil) {
        guard !busy else { return }
        busy = true
        error = nil
        Task {
            do {
                if d.kind == "ask", store.cards[projectID]?.decisions == nil, let id = Int(d.id) {
                    try await store.fetch { try await $0.answerReport(id: id, text: text ?? value?.stringValue ?? "") }
                    await store.refreshAll()
                } else {
                    let row = try await store.fetch { try await $0.decide(projectID: projectID, d, value: value, text: text) }
                    store.cards[projectID] = row
                }
                writing = false
            } catch {
                self.error = store.message(for: error)
            }
            busy = false
        }
    }
}

// MARK: - Asking the lead for a new card

/// Under the card: the update under way (with a way to call it off), or a request with an optional note.
struct CardRequestSection: View {
    let project: ProjectSnapshot
    @EnvironmentObject private var store: TownStore
    @State private var busy = false
    @State private var note = ""
    @State private var error: String?

    var body: some View {
        let lang = store.language
        let card = store.cards[project.id]
        let started = card?.lead?.started == true
        if project.lead.state != "ended" {
            Section {
                if let pending = card?.pending {
                    HStack(alignment: .firstTextBaseline) {
                        Label(lang.format("card.request.pending", Stamp.ago(pending.at, lang)), systemImage: "clock")
                            .font(.subheadline)
                        Spacer()
                        Button(lang.string("card.request.cancel"), role: .destructive) { run { try await $0.cancelCard(projectID: project.id) } }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .disabled(busy)
                    }
                    if let n = pending.note, !n.isEmpty {
                        Text(lang.format("card.request.note", n)).font(.caption).emBar(.info)
                    }
                } else if started && project.lead.state == "running" {
                    HStack(spacing: 8) {
                        TextField(lang.string("card.request.placeholder"), text: $note)
                            .textFieldStyle(.roundedBorder)
                            .onChange(of: note) { if $0.count > 300 { note = String($0.prefix(300)) } }
                            .onSubmit(request)
                        Button(lang.string("card.request.update"), action: request)
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                            .disabled(busy)
                    }
                } else {
                    Text(lang.string(card?.card == nil ? (started ? "card.empty.started" : "card.empty.no_lead") : "card.request.no_lead"))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if let error { Text(error).font(.caption).emState(.bad, detail: true) }
            } footer: {
                if card?.pending == nil && started && project.lead.state == "running" {
                    Text(lang.string("card.request.footer"))
                }
            }
            .papertownRowBackground(store.appearance)
        }
    }

    private func request() {
        let text = note.trimmingCharacters(in: .whitespacesAndNewlines)
        run { try await $0.requestCard(projectID: project.id, note: text) }
    }

    private func run(_ op: @escaping (PapertownClient) async throws -> ProjectCardView) {
        guard !busy else { return }
        busy = true
        error = nil
        Task {
            do {
                store.cards[project.id] = try await store.fetch(op)
                note = ""
            } catch {
                self.error = store.message(for: error)
            }
            busy = false
        }
    }
}

// MARK: - The lead's rounds

/// Whether the lead hears of each change, and how long it waits between looks when nothing changes.
struct LeadRoundsRows: View {
    let projectID: String
    @EnvironmentObject private var store: TownStore
    @State private var settings: LeadSettings?
    @State private var error: String?

    private static let minutes = [15, 30, 60, 120, 240, 480]

    var body: some View {
        let lang = store.language
        // shown at once with the defaults, so the rows exist for .task to load into (an empty row never appears)
        let s = settings ?? LeadSettings(on: nil, supervise: true, every: 60)
        Group {
            Group {
                Toggle(isOn: Binding(get: { s.supervise ?? true }, set: { v in save { try await $0.setLeadRounds(projectID: projectID, supervise: v) } })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(lang.string("lead.rounds.supervise"))
                        Text(lang.string("lead.rounds.supervise.sub")).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Picker(lang.string("lead.rounds.every"), selection: Binding(get: { s.every ?? 60 }, set: { v in save { try await $0.setLeadRounds(projectID: projectID, every: v) } })) {
                    ForEach(Self.minutes + ((s.every).map { Self.minutes.contains($0) ? [] : [$0] } ?? []), id: \.self) { m in
                        Text(m < 60 ? lang.format("lead.rounds.minutes", m) : lang.format("lead.rounds.hours", m / 60)).tag(m)
                    }
                }
                .disabled(s.supervise == false)
            }
            .disabled(settings == nil)
            if let error { Text(error).font(.caption).emState(.bad, detail: true) }
        }
        .task { await load() }
    }

    private func load() async {
        do { settings = try await store.fetch { try await $0.leadView(projectID: projectID) }.settings } catch {}
    }

    private func save(_ op: @escaping (PapertownClient) async throws -> Void) {
        Task {
            do { try await store.fetch(op); error = nil } catch { self.error = store.message(for: error) }
            await load()
        }
    }
}

// MARK: - The project list: every lead at once, and new papers

struct UpdateAllButton: View {
    @EnvironmentObject private var store: TownStore
    @State private var busy = false
    @State private var said: String?

    var body: some View {
        let lang = store.language
        let ready = store.cards.values.contains { $0.lead?.started == true && $0.pending == nil }
        Button {
            busy = true
            Task {
                do {
                    let r = try await store.fetch { try await $0.updateAllCards() }
                    said = r.sent.isEmpty ? lang.string("cards.update_all.none") : lang.format("cards.update_all.sent", r.sent.count)
                    await store.refreshAll()
                } catch {
                    said = store.message(for: error)
                }
                busy = false
            }
        } label: {
            Label(lang.string("cards.update_all"), systemImage: "arrow.triangle.2.circlepath")
        }
        .disabled(busy || !ready || store.connectionStatus != .connected)
        .alert(said ?? "", isPresented: Binding(get: { said != nil }, set: { if !$0 { said = nil } })) {
            Button(lang.string("action.ok"), role: .cancel) {}
        }
    }
}

struct FreshPapersSection: View {
    @EnvironmentObject private var store: TownStore
    @Environment(\.openURL) private var openURL
    let papers: [FreshPaper]

    var body: some View {
        let lang = store.language
        if !papers.isEmpty {
            Section {
                ForEach(papers) { p in
                    Button {
                        if let s = p.url, let url = URL(string: s) { openURL(url) }
                    } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(p.title).font(.subheadline).foregroundStyle(.primary).lineLimit(2)
                            HStack(spacing: 0) {
                                let meta = [p.year, p.authors].compactMap { $0 }.joined(separator: " · ")
                                Text(meta)
                                if let score = p.relevance, score > 0 {
                                    if !meta.isEmpty { Text(" · ") }
                                    EmText(lang.format("papers.relevance", score), .numbers(.info))
                                        .fixedSize(horizontal: true, vertical: false)
                                }
                            }
                            .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    .buttonStyle(.plain)
                    .papertownRowBackground(store.appearance)
                }
            } header: {
                Text(lang.string("papers.fresh"))
            } footer: {
                Text(lang.string("papers.fresh.footer"))
            }
        }
    }
}
