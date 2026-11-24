import PapertownCore
import SwiftUI

// On a project's page: what its agents wait on you for, each settled with one tap the way the agent asked (its question,
// its permission request, the dialog on its terminal, a line of its card); asking its lead for a new card; how often
// the lead looks in. In the project list: asking every lead at once, and the newest papers.

extension TownStore {
    /// What a project's agents wait on you for, from its card (empty on servers before 待你决定).
    func decisions(_ projectID: String) -> [Decision] { cards[projectID]?.decisions ?? [] }
}

// MARK: - 待你决定

struct DecisionsSection: View {
    let projectID: String
    @EnvironmentObject private var store: TownStore

    var body: some View {
        let lang = store.language
        let list = store.decisions(projectID)
        if !list.isEmpty {
            Section {
                ForEach(list, id: \.key) { d in
                    DecisionRow(projectID: projectID, d: d).papertownRowBackground(store.appearance)
                }
            } header: {
                HStack {
                    Label(lang.string("decide.title"), systemImage: "bell.badge.fill").foregroundStyle(.orange)
                    Spacer()
                    Text("\(list.count)")
                }
            } footer: {
                Text(lang.string("decide.footer"))
            }
        }
    }
}

struct DecisionRow: View {
    let projectID: String
    let d: Decision
    @EnvironmentObject private var store: TownStore
    @State private var busy = false
    @State private var writing = false
    @State private var error: String?

    var body: some View {
        let lang = store.language
        VStack(alignment: .leading, spacing: 7) {
            Label {
                Text([lang.server(d.who), lang.string("decide.kind.\(d.kind)"), d.since.map { Stamp.ago($0, lang) }]
                    .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
            } icon: {
                Image(systemName: symbol)
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            Text(lang.server(d.title)).font(.subheadline.weight(.medium)).fixedSize(horizontal: false, vertical: true)
            if !d.detail.isEmpty {
                Text(d.detail)
                    .font(.caption.monospaced())
                    .lineLimit(8)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 6))
            }

            if d.kind == "prompt" {
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
            if writing {
                SendField(placeholder: lang.string("decide.write"), button: lang.string("action.send"), disabled: busy) { text in
                    pick(nil, text: text)
                }
            }
            if d.later == true {
                Text(lang.string("decide.later")).font(.caption).foregroundStyle(.secondary)
            }
            if let error {
                Text(error).font(.caption).foregroundStyle(.red)
            }
        }
        .padding(.vertical, 3)
    }

    private var symbol: String {
        switch d.kind {
        case "ask": return "questionmark.bubble"
        case "permission": return "lock.shield"
        case "prompt": return "terminal"
        default: return "rectangle.stack"
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
                let row = try await store.fetch { try await $0.decide(projectID: projectID, d, value: value, text: text) }
                store.cards[projectID] = row
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
                        Text(lang.format("card.request.note", n)).font(.caption).foregroundStyle(.secondary)
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
                if let error { Text(error).font(.caption).foregroundStyle(.red) }
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
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
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
    @State private var papers: [FreshPaper] = []

    var body: some View {
        let lang = store.language
        Group {
            if !papers.isEmpty {
                Section {
                    ForEach(papers) { p in
                        Button {
                            if let s = p.url, let url = URL(string: s) { openURL(url) }
                        } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(p.title).font(.subheadline).foregroundStyle(.primary).lineLimit(2)
                                Text([p.year, p.authors, p.relevance.flatMap { $0 > 0 ? lang.format("papers.relevance", $0) : nil }]
                                    .compactMap { $0 }.joined(separator: " · "))
                                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                        .papertownRowBackground(store.appearance)
                    }
                } header: {
                    Text(lang.string("papers.fresh"))
                } footer: {
                    Text(lang.string("papers.fresh.footer"))
                }
            }
        }
        .task(id: store.connectionStatus == .connected) {
            guard store.connectionStatus == .connected else { return }
            papers = (try? await store.fetch { try await $0.freshPapers() }) ?? []
        }
    }
}
