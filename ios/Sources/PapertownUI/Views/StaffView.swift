import PapertownCore
import SwiftUI

struct StaffView: View {
    enum SortMode: String {
        case urgency, project
    }

    @EnvironmentObject private var store: TownStore
    @State private var searchText = ""
    @State private var sortMode: SortMode = .urgency
    @State private var hiring = false
    @State private var opened: StaffAgent?
    @State private var showTerminals = false

    private var filteredEntries: [(project: ProjectRefInfo?, agent: StaffAgent)] {
        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let entries = store.allStaffAgents.filter { $0.agent.role != "assistant" }
        guard !q.isEmpty else { return entries }
        return entries.filter { entry in
            let role = TextFormatters.roleName(entry.agent.role, language: store.language).lowercased()
            let projTitle = entry.project?.title.lowercased() ?? ""
            let projSeq = entry.project.map { "#\($0.seq)" } ?? ""
            let taskTitle = entry.agent.task?.title.lowercased() ?? ""
            return role.contains(q) || projTitle.contains(q) || projSeq.contains(q) || taskTitle.contains(q)
        }
    }

    var body: some View {
        let lang = store.language
        NavigationStack {
            PageList {
                let terms = store.openTerminals
                if !terms.isEmpty && searchText.isEmpty {
                    Section {
                        NavigationLink { TerminalsPage() } label: {
                            HStack(spacing: 11) {
                                ZStack {
                                    RoundedRectangle(cornerRadius: 9, style: .continuous).fill(store.appearance.tintColor.opacity(0.14)).frame(width: 32, height: 32)
                                    Image(systemName: "terminal").font(.system(size: 14, weight: .semibold)).foregroundStyle(store.appearance.tintColor)
                                }
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(lang.string("terminals.title")).font(.body.weight(.medium))
                                    Text(lang.string("terminals.sub")).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                }
                                Spacer(minLength: 6)
                                Text(lang.format("terminals.count", terms.count)).font(.caption).foregroundStyle(.secondary)
                            }
                            .padding(.vertical, 2)
                        }
                        .papertownRowBackground(store.appearance)
                    }
                }
                if let assistant = store.assistantAgent {
                    Section(lang.string("staff.section.town")) {
                        NavigationLink {
                            AgentChatView(
                                agentID: assistant.id,
                                role: "assistant",
                                subtitle: lang.string("staff.town_wide")
                            )
                        } label: {
                            HStack(spacing: 11) {
                                RoleBadgeView(role: "assistant", size: 32)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(lang.string("role.assistant"))
                                        .font(.body.weight(.medium))
                                    Text(lang.string("staff.assistant.sub"))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                                Spacer(minLength: 6)
                                if assistant.started != true {
                                    StateTag(text: lang.string("staff.not_started"), small: true)
                                } else {
                                    StateTag(text: TextFormatters.bucketLabel(assistant.effectiveBucket, offline: assistant.isOffline, language: lang),
                                             tone: EmTone.bucket(assistant.effectiveBucket), small: true)
                                }
                            }
                            .padding(.vertical, 2)
                        }
                        .papertownRowBackground(store.appearance)
                    }
                }

                if sortMode == .urgency {
                    ForEach(TextFormatters.orderedBuckets, id: \.self) { bucket in
                        let rows = filteredEntries.filter { $0.agent.effectiveBucket == bucket }
                        if !rows.isEmpty {
                            Section {
                                ForEach(rows, id: \.agent.id) { entry in
                                    staffRow(entry, lang: lang)
                                        .papertownRowBackground(store.appearance)
                                }
                            } header: {
                                HStack {
                                    Text(TextFormatters.bucketLabel(bucket, language: lang))
                                    Spacer()
                                    Text("\(rows.count)")
                                }
                            }
                        }
                    }
                } else {
                    let grouped = Dictionary(grouping: filteredEntries) { $0.project?.id ?? "__none__" }
                    let keys = grouped.keys.sorted { lhs, rhs in
                        let seqL = grouped[lhs]?.first?.project?.seq ?? -1
                        let seqR = grouped[rhs]?.first?.project?.seq ?? -1
                        return seqL > seqR
                    }
                    ForEach(keys, id: \.self) { key in
                        if let rows = grouped[key] {
                            let header = rows.first?.project.map { "#\($0.seq) \($0.title)" } ?? lang.string("staff.section.town")
                            Section(header) {
                                ForEach(rows, id: \.agent.id) { entry in
                                    staffRow(entry, lang: lang)
                                        .papertownRowBackground(store.appearance)
                                }
                            }
                        }
                    }
                }
                terminalsSection(lang: lang)
                if filteredEntries.isEmpty && searchText.isEmpty && (store.overview?.others ?? []).isEmpty
                    && (store.overview?.groups.allSatisfy { ($0.terminals ?? []).isEmpty } ?? true) {
                    Section {
                        Text(lang.string("staff.empty")).font(.footnote).foregroundStyle(.secondary)
                    }
                    .papertownRowBackground(store.appearance)
                }
            }
            .papertownInsetGroupedList()
            .papertownListAppearance(store.appearance)
            .navigationTitle(lang.string("tab.staff"))
            .papertownSidebarButton()
            .papertownLargeTitle()
            .searchable(text: $searchText, prompt: lang.string("staff.search"))
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Picker(lang.string("tab.staff"), selection: $sortMode) {
                            Label(lang.string("staff.sort.urgency"), systemImage: "exclamationmark.circle")
                                .tag(SortMode.urgency)
                            Label(lang.string("staff.sort.project"), systemImage: "folder")
                                .tag(SortMode.project)
                        }
                    } label: {
                        Image(systemName: "arrow.up.arrow.down.circle")
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button { hiring = true } label: { Image(systemName: "person.badge.plus") }
                        .accessibilityLabel(lang.string("hire.title"))
                        .disabled(store.connectionStatus != .connected)
                }
            }
            .refreshable {
                await store.refreshAll()
            }
            .navigationDestination(isPresented: $showTerminals) { TerminalsPage() }
            #if DEBUG
            // -PTTerminals YES opens the wall of terminals, for screenshots
            .onAppear { if UserDefaults.standard.bool(forKey: "PTTerminals") { showTerminals = true } }
            #endif
            .navigationDestination(isPresented: Binding(get: { opened != nil }, set: { if !$0 { opened = nil } })) {
                if let a = opened {
                    AgentChatView(agentID: a.id, role: a.role,
                                  subtitle: store.projects.first { $0.id == a.lineID }.map { "#\($0.seq)" } ?? "")
                }
            }
            .sheet(isPresented: $hiring) {
                HireSheet { agent in opened = agent }
                    .papertownSheetFrame(height: 560)
                    .environmentObject(store)
                    .tint(store.appearance.tintColor)
            }
        }
    }

    /// herdr and tmux sessions the town watches but did not start: read and typed into like an agent.
    @ViewBuilder
    private func terminalsSection(lang: AppLanguage) -> some View {
        let terms = (store.overview?.groups.flatMap { $0.terminals ?? [] } ?? []) + (store.overview?.others ?? [])
        if !terms.isEmpty {
            Section(lang.string("staff.section.terminals")) {
                ForEach(terms) { t in
                    NavigationLink {
                        AgentChatView(target: .terminal(t.id), role: "coder", subtitle: t.kind ?? lang.string("chat.terminal"))
                    } label: {
                        HStack(spacing: 11) {
                            ZStack {
                                Circle().fill(Color.secondary.opacity(0.14)).frame(width: 32, height: 32)
                                Image(systemName: "terminal").foregroundStyle(.secondary)
                            }
                            VStack(alignment: .leading, spacing: 2) {
                                Text(t.name ?? t.title).font(.body.weight(.medium)).lineLimit(1)
                                Text(t.watch?.doing?.text.map(lang.server) ?? t.cwd ?? "").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                            Spacer()
                            if let b = t.watch?.bucket {
                                StateTag(text: TextFormatters.bucketLabel(b, language: lang), tone: EmTone.bucket(b), small: true)
                            }
                        }
                    }
                    .papertownRowBackground(store.appearance)
                }
            }
        }
    }

    private func staffRow(_ entry: (project: ProjectRefInfo?, agent: StaffAgent), lang: AppLanguage) -> some View {
        let agent = entry.agent
        let roleName = agent.task?.title ?? TextFormatters.roleName(agent.role, language: lang)
        let title = entry.project.map { "#\($0.seq) · \(roleName)" } ?? roleName
        let subtitle = entry.project.map { "#\($0.seq) · \(TextFormatters.stageName($0.stage, language: lang))" } ?? lang.string("staff.town_wide")
        let timeLabel = TextFormatters.relativeTime(from: agent.watch?.since ?? agent.updatedAt, language: lang)

        return NavigationLink {
            AgentChatView(agentID: agent.id, role: agent.role, subtitle: subtitle)
        } label: {
            HStack(spacing: 11) {
                RoleBadgeView(role: agent.role, size: 32)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(title)
                            .font(.body.weight(.medium))
                            .lineLimit(1)
                    }
                    StaffMessagePreview(event: agent.last, fallback: lang.string("staff.no_messages"), unread: agent.watch?.unread == true)
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 6)
                VStack(alignment: .trailing, spacing: 3) {
                    if !timeLabel.isEmpty {
                        Text(timeLabel)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    if sortMode == .project || EmTone.issue(agent.effectiveBucket) != nil {
                        StateTag(text: TextFormatters.bucketLabel(agent.effectiveBucket, offline: agent.isOffline, language: lang),
                                 tone: EmTone.bucket(agent.effectiveBucket), small: true)
                    }
                }
            }
            .emBar(agent.effectiveBucket == "needs" ? .warn : nil)
            .padding(.vertical, 2)
        }
    }
}

struct StaffMessagePreview: View {
    let event: AgentEvent?
    let fallback: String
    var unread = false
    @EnvironmentObject private var store: TownStore

    var body: some View {
        let original = event?.data.field("user_text")?.stringValue
        let origin = event?.data.field("origin")?.stringValue
        let raw = event?.data.field("text")?.stringValue ?? ""
        let words = event?.kind == "user" ? ChatEntry.authoredWords(raw, userText: original, origin: origin) : nil
        if let words, !words.isEmpty {
            Text(verbatim: words).emBar(.info)
        } else {
            EmText(raw.isEmpty ? fallback : store.language.server(raw))
                .emMark(active: unread && event?.kind == "assistant" && !raw.isEmpty && !raw.contains("**"))
        }
    }
}
