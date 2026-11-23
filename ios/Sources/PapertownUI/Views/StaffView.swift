import PapertownCore
import SwiftUI

struct StaffView: View {
    enum SortMode: String {
        case urgency, project
    }

    @EnvironmentObject private var store: TownStore
    @State private var searchText = ""
    @State private var sortMode: SortMode = .urgency

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
            List {
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
            }
            .refreshable {
                await store.refreshAll()
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
                                Text(TextFormatters.bucketLabel(b, language: lang)).font(.caption).foregroundStyle(TextFormatters.bucketColor(b))
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
        let lastText = TextFormatters.stripMarkdown(agent.last?.data.field("text")?.stringValue)
        let preview = lastText.isEmpty ? lang.string("staff.no_messages") : lang.server(lastText)
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
                        if agent.watch?.unread == true {
                            Circle()
                                .fill(store.appearance.tintColor)
                                .frame(width: 7, height: 7)
                        }
                    }
                    Text(preview)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 6)
                VStack(alignment: .trailing, spacing: 3) {
                    if !timeLabel.isEmpty {
                        Text(timeLabel)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    Circle()
                        .fill(TextFormatters.bucketColor(agent.effectiveBucket))
                        .frame(width: 7, height: 7)
                }
            }
            .padding(.vertical, 2)
        }
    }
}
