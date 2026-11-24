import PapertownCore
import SwiftUI

enum InboxRoute: Hashable {
    case project(String)
    case chat(ChatRoute)
}

struct InboxView: View {
    @EnvironmentObject private var store: TownStore
    @State private var answering: ReportItem?

    var body: some View {
        let lang = store.language
        NavigationStack(path: $store.inboxPath) {
            List {
                connectionBannerSection(lang: lang)

                if store.projects.isEmpty && store.inboxItems.isEmpty && !store.isRefreshing {
                    Section {
                        EmptyStateView(
                            title: lang.string("inbox.noprojects.title"),
                            systemImage: "tray",
                            description: lang.string("inbox.noprojects.desc"),
                            actionTitle: store.currentProfile == nil ? lang.string("connect.title") : lang.string("projects.new_idea.title")
                        ) {
                            if store.currentProfile == nil {
                                store.showConnectSheet = true
                            } else {
                                store.selectedTab = .projects
                            }
                        }
                    }
                    .papertownRowBackground(store.appearance)
                } else {
                    Section {
                        if store.inboxItems.isEmpty {
                            EmptyStateView(
                                title: lang.string("inbox.empty.title"),
                                systemImage: "checkmark.circle",
                                description: lang.string("inbox.empty.desc")
                            )
                            .papertownRowBackground(store.appearance)
                        } else {
                            ForEach(store.inboxItems) { item in
                                inboxRow(item, lang: lang)
                                    .papertownRowBackground(store.appearance)
                            }
                        }
                    } header: {
                        HStack {
                            Text(lang.string("inbox.section.needs"))
                            Spacer()
                            if !store.inboxItems.isEmpty {
                                Text("\(store.inboxItems.count)")
                            }
                        }
                    }

                    let activeProjects = store.projects.filter { !$0.isDone }
                    if !activeProjects.isEmpty {
                        Section {
                            ForEach(activeProjects) { project in
                                NavigationLink {
                                    ProjectDetailView(projectID: project.id)
                                } label: {
                                    activeProjectRow(project, lang: lang)
                                }
                                .papertownRowBackground(store.appearance)
                            }
                        } header: {
                            HStack {
                                Text(lang.string("inbox.section.active"))
                                Spacer()
                                Text("\(activeProjects.count)")
                            }
                        }
                    }
                }
            }
            .papertownInsetGroupedList()
            .papertownListAppearance(store.appearance)
            .navigationTitle(lang.string("tab.inbox"))
            .papertownSidebarButton()
            .papertownLargeTitle()
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    ConnectionPillButton()
                }
            }
            .refreshable {
                await store.refreshAll()
            }
            .sheet(item: $answering) { ask in
                AnswerSheet(ask: ask).environmentObject(store).papertownSheetFrame(height: 460)
            }
            .navigationDestination(for: InboxRoute.self) { route in
                switch route {
                case .chat(let chat):
                    AgentChatView(
                        agentID: chat.agentID,
                        role: chat.role,
                        subtitle: chat.subtitle
                    )
                case .project(let projectID):
                    ProjectDetailView(projectID: projectID)
                }
            }
        }
    }

    @ViewBuilder
    private func connectionBannerSection(lang: AppLanguage) -> some View {
        let serverName = store.currentProfile?.name ?? lang.string("tab.server")
        switch store.connectionStatus {
        case .reconnecting:
            Section {
                Label {
                    Text(lang.format("conn.banner.reconnecting", serverName))
                        .font(.footnote)
                } icon: {
                    Image(systemName: "arrow.triangle.2.circlepath")
                        .foregroundStyle(.orange)
                }
                .papertownRowBackground(store.appearance)
            }
        case .disconnected where store.currentProfile != nil:
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Label {
                        Text(store.lastError ?? lang.format("conn.banner.offline", serverName))
                            .font(.footnote)
                    } icon: {
                        Image(systemName: "wifi.slash")
                            .foregroundStyle(.red)
                    }
                    Button(lang.string("action.retry")) {
                        if let profile = store.currentProfile {
                            Task { await store.connect(to: profile, allowBiometricAutoLogin: true) }
                        }
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
                .padding(.vertical, 2)
                .papertownRowBackground(store.appearance)
            }
        default:
            EmptyView()
        }
    }

    @ViewBuilder
    private func inboxRow(_ item: InboxItem, lang: AppLanguage) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                iconBadge(for: item.kind)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(headerTitle(for: item, lang: lang))
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(2)
                        Spacer(minLength: 6)
                        if let ts = item.timestamp {
                            Text(TextFormatters.relativeTime(from: ts, language: lang))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    bodyText(for: item, lang: lang)
                }
            }

            HStack(spacing: 8) {
                actions(for: item, lang: lang)
            }
            .padding(.leading, 39)
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func iconBadge(for kind: InboxItemKind) -> some View {
        let (symbol, color): (String, Color) = switch kind {
        case .ask: ("questionmark.bubble.fill", .blue)
        case .permission: ("terminal.fill", .orange)
        case .blockedLead: ("exclamationmark.triangle.fill", .red)
        }
        ZStack {
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(color.opacity(0.14))
                .frame(width: 29, height: 29)
            Image(systemName: symbol)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(color)
        }
    }

    private func headerTitle(for item: InboxItem, lang: AppLanguage) -> String {
        let prefix = item.projectSeq.map { "#\($0) " } ?? ""
        switch item.kind {
        case .ask:
            return "\(prefix)\(lang.server(item.projectTitle))"
        case .permission(_, let role, _):
            return "\(prefix)\(TextFormatters.roleName(role, language: lang))"
        case .blockedLead:
            return "\(prefix)\(lang.server(item.projectTitle))"
        }
    }

    @ViewBuilder
    private func bodyText(for item: InboxItem, lang: AppLanguage) -> some View {
        switch item.kind {
        case .ask(let report):
            Text(lang.server(report.data.question ?? report.data.text ?? lang.string("inbox.badge.waiting")))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(3)
        case .permission(_, _, let prompt):
            VStack(alignment: .leading, spacing: 5) {
                Text(prompt.title.map(lang.server) ?? lang.string("inbox.perm.default"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                if !prompt.arg.isEmpty {
                    Text(prompt.arg)
                        .font(.caption.monospaced())
                        .lineLimit(2)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                }
            }
        case .blockedLead(let project):
            Text(TextFormatters.leadDetail(
                state: project.lead.state,
                note: project.lead.note,
                runtime: project.lead.runtime,
                model: nil,
                status: project.lead.status,
                sample: project.sample,
                language: lang
            ))
            .font(.footnote)
            .foregroundStyle(.red)
            .lineLimit(3)
        }
    }

    @ViewBuilder
    private func actions(for item: InboxItem, lang: AppLanguage) -> some View {
        switch item.kind {
        case .ask(let report):
            Button(lang.string("action.reply")) { answering = report }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
            if let projectID = item.projectID {
                Button(lang.string("action.open_project")) {
                    store.inboxPath.append(InboxRoute.project(projectID))
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
        case .permission(let agentID, let role, let prompt):
            Button(lang.string("action.allow")) {
                Task { await store.respondPermission(agentID: agentID, requestID: prompt.id, allow: true) }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)

            Button(lang.string("action.deny"), role: .destructive) {
                Task { await store.respondPermission(agentID: agentID, requestID: prompt.id, allow: false) }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)

            Button(lang.string("action.view_chat")) {
                store.inboxPath.append(InboxRoute.chat(ChatRoute(
                    agentID: agentID,
                    role: role,
                    subtitle: item.projectSeq.map { "#\($0)" } ?? item.projectTitle
                )))
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        case .blockedLead(let project):
            Button(lang.string("action.retry")) {
                Task { await store.toggleLead(projectID: project.id, on: true) }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)

            Button(lang.string("action.open_project")) {
                store.inboxPath.append(InboxRoute.project(project.id))
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
    }

    private func activeProjectRow(_ project: ProjectSnapshot, lang: AppLanguage) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("#\(project.seq) \(lang.server(project.title))")
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text("\(TextFormatters.stageName(project.stage, language: lang)) · \(project.pct)%")
                    .font(.caption)
                    .foregroundStyle(project.lead.state == "blocked" ? .red : .secondary)
                    .lineLimit(1)
            }
            ProgressView(value: Double(project.pct), total: 100)
                .tint(project.lead.state == "blocked" ? .red : store.appearance.tintColor)
        }
        .padding(.vertical, 2)
    }
}

struct ChatRoute: Hashable, Identifiable {
    var id: String { agentID }
    let agentID: String
    let role: String
    let subtitle: String
}
