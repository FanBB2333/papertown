import PapertownCore
import SwiftUI

struct ProjectDetailView: View {
    let projectID: String
    @EnvironmentObject private var store: TownStore
    @State private var ideaExpanded = false
    @State private var isUpdatingLead = false
    @State private var answering: ReportItem?
    @State private var showHire = false
    @State private var hiringRole: String? = nil

    private var project: ProjectSnapshot? {
        store.projects.first(where: { $0.id == projectID })
    }

    private var staffForProject: [StaffAgent] {
        store.allStaffAgents
            .filter { $0.project?.id == projectID || $0.agent.lineID == projectID }
            .map(\.agent)
    }

    var body: some View {
        let lang = store.language
        Group {
            if let project {
                List {
                    // 待你决定 covers the lead's questions; servers before it list them on their own
                    if store.cards[projectID]?.decisions != nil {
                        DecisionsSection(projectID: projectID)
                    } else {
                        asksSection(lang: lang)
                    }
                    leadSection(project, lang: lang)
                    progressSection(project, lang: lang)
                    if let card = store.cards[projectID] { ProgressCardSection(card: card) }
                    CardRequestSection(project: project)
                    researchSection(project, lang: lang)
                    teamSection(project, lang: lang)

                    if let leadAgentID = project.leadAgentID {
                        Section {
                            NavigationLink {
                                AgentChatView(
                                    agentID: leadAgentID,
                                    role: "lead",
                                    subtitle: "#\(project.seq) · \(TextFormatters.stageName(project.stage, language: lang))"
                                )
                            } label: {
                                Label(lang.string("detail.message_lead"), systemImage: "bubble.left.and.bubble.right")
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(store.appearance.tintColor)
                                    .frame(maxWidth: .infinity, alignment: .center)
                            }
                            .papertownRowBackground(store.appearance)
                        }
                    }
                }
                .papertownInsetGroupedList()
                .papertownListAppearance(store.appearance)
                .navigationTitle("#\(project.seq)")
                .papertownInlineTitle()
                #if os(macOS)
                // the window's title bar has room for both: number, then stage
                .navigationSubtitle(TextFormatters.stageName(project.stage, language: lang))
                #endif
                .toolbar {
                    #if os(iOS)
                    ToolbarItem(placement: .principal) {
                        VStack(spacing: 1) {
                            Text("#\(project.seq)")
                                .font(.headline)
                            Text(TextFormatters.stageName(project.stage, language: lang))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                    #endif
                    if let leadAgentID = project.leadAgentID {
                        ToolbarItem(placement: .primaryAction) {
                            NavigationLink {
                                AgentChatView(
                                    agentID: leadAgentID,
                                    role: "lead",
                                    subtitle: "#\(project.seq) · \(TextFormatters.stageName(project.stage, language: lang))"
                                )
                            } label: {
                                Image(systemName: "bubble.left.and.bubble.right")
                            }
                            .accessibilityLabel(lang.string("detail.message_lead"))
                        }
                    }
                }
                .refreshable {
                    await store.refreshProject(id: projectID)
                }
                .onAppear { store.noteOpened(projectID) }
            } else {
                EmptyStateView(
                    title: lang.string("error.not_found"),
                    systemImage: "folder",
                    description: ""
                )
            }
        }
        .task {
            await store.refreshProject(id: projectID)
        }
        .sheet(item: $answering) { ask in
            AnswerSheet(ask: ask).environmentObject(store).papertownSheetFrame(height: 460)
        }
        .sheet(isPresented: $showHire) {
            HireSheet(projectID: projectID) { _ in
                Task { await store.refreshProject(id: projectID) }
            }
            .papertownSheetFrame(height: 540)
            .environmentObject(store)
            .tint(store.appearance.tintColor)
        }
        .sheet(isPresented: Binding(get: { hiringRole != nil }, set: { if !$0 { hiringRole = nil } })) {
            HireSheet(projectID: projectID, role: hiringRole) { _ in
                Task { await store.refreshProject(id: projectID) }
            }
            .papertownSheetFrame(height: 540)
            .environmentObject(store)
            .tint(store.appearance.tintColor)
        }
    }

    /// The lead's open questions about this project, answered here without leaving the page.
    @ViewBuilder
    private func asksSection(lang: AppLanguage) -> some View {
        let asks = store.openAsks.filter { $0.lineID == projectID && $0.data.open != false }
        if !asks.isEmpty {
            Section {
                ForEach(asks) { ask in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(lang.server(ask.data.question ?? ask.data.text ?? "")).font(.subheadline)
                        Button(lang.string("action.reply")) { answering = ask }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                    }
                    .padding(.vertical, 2)
                    .papertownRowBackground(store.appearance)
                }
            } header: {
                Label(lang.string("inbox.badge.waiting"), systemImage: "person.fill.questionmark").foregroundStyle(.orange)
            }
        }
    }

    /// What the project has produced, a page per stage group, plus its gates, files and spending.
    @ViewBuilder
    private func researchSection(_ project: ProjectSnapshot, lang: AppLanguage) -> some View {
        let checks = store.cards[projectID]?.checks
        let reached: (String) -> Bool = { key in
            project.stages.first(where: { $0.key == key }).map { $0.status != "todo" } ?? false
        }
        Section(lang.string("detail.section.research")) {
            link(lang.string("reports.nav"), "text.bubble", detail: nil) { ReportsPage(projectID: projectID) }
            link(lang.string("loop.nav"), "arrow.triangle.capsulepath", detail: nil) { LoopPage(projectID: projectID) }
            link(lang.string("checks.nav"), "checklist", detail: checks.map { c in
                c.hard.fail > 0 ? lang.format("checks.failing", c.hard.fail) : "\(c.hard.pass)/\(c.hard.total)"
            }) { ChecksPage(projectID: projectID) }
            link(lang.string("pages.nav"), "doc.richtext.fill", detail: nil) { PagesPage(projectID: projectID) }
            link(lang.string("memory.nav"), "brain", detail: store.cards[projectID]?.memory.map { m in
                m.sessions + m.notes > 0 ? lang.format("memory.counts", m.sessions, m.notes) : lang.string("memory.none")
            }) { MemoryPage(projectID: projectID) }
            if reached("hatch") {
                link(lang.string("overlap.nav"), "doc.text.magnifyingglass", detail: project.verdict.map(lang.server)) { OverlapPage(projectID: projectID) }
            }
            if reached("method") {
                link(lang.string("stage.method"), "function", detail: nil) { MethodPage(projectID: projectID) }
            }
            if reached("exp") {
                link(lang.string("stage.exp"), "flask", detail: nil) { ExperimentsPage(projectID: projectID) }
            }
            if reached("write") {
                link(lang.string("paper.nav"), "doc.richtext", detail: nil) { PaperPage(projectID: projectID) }
            }
            link(lang.string("files.code"), "chevron.left.forwardslash.chevron.right", detail: nil) { FilesPage(projectID: projectID, root: "code") }
            link(lang.string("usage.nav"), "dollarsign.circle", detail: nil) { ProjectUsagePage(projectID: projectID) }
        }
    }

    private func link<Dest: View>(_ title: String, _ symbol: String, detail: String?, @ViewBuilder _ dest: @escaping () -> Dest) -> some View {
        NavigationLink {
            dest()
        } label: {
            HStack {
                Label(title, systemImage: symbol)
                Spacer()
                if let detail { Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
            }
        }
        .papertownRowBackground(store.appearance)
    }

    @ViewBuilder
    private func leadSection(_ project: ProjectSnapshot, lang: AppLanguage) -> some View {
        let leadModel = project.team.first(where: { $0.role == "lead" })?.model
        Section {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 10) {
                    RoleBadgeView(role: "lead", size: 30)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(lang.string("detail.resident_lead"))
                            .font(.body.weight(.medium))
                        Text(TextFormatters.leadDetail(
                            state: project.lead.state,
                            note: project.lead.note,
                            runtime: project.lead.runtime,
                            model: leadModel,
                            status: project.lead.status,
                            sample: project.sample,
                            language: lang
                        ))
                        .font(.caption)
                        .foregroundStyle(project.lead.state == "blocked" ? .red : .secondary)
                    }
                    Spacer(minLength: 8)
                    if project.lead.state != "ended" {
                        Toggle("", isOn: Binding(
                            get: { project.lead.on },
                            set: { newValue in
                                guard !isUpdatingLead else { return }
                                isUpdatingLead = true
                                Task {
                                    await store.toggleLead(projectID: project.id, on: newValue)
                                    isUpdatingLead = false
                                }
                            }
                        ))
                        .labelsHidden()
                        .toggleStyle(.switch)
                        .disabled(isUpdatingLead)
                    }
                }

                if project.lead.state == "blocked" || project.lead.state == "off" {
                    HStack(spacing: 8) {
                        if project.lead.state == "blocked" {
                            Button(lang.string("action.retry")) {
                                Task { await store.toggleLead(projectID: project.id, on: true) }
                            }
                            .buttonStyle(.borderedProminent)
                        }
                        if store.connectionStatus == .connected && !store.isDemo {
                            Button(lang.string("chat.start_with")) { hiringRole = "lead" }
                                .buttonStyle(.bordered)
                        }
                    }
                    .controlSize(.small)
                    .padding(.leading, 40)
                }
            }
            .padding(.vertical, 2)
            .papertownRowBackground(store.appearance)
            if project.lead.state != "ended" {
                LeadRoundsRows(projectID: projectID).papertownRowBackground(store.appearance)
            }
        } header: {
            HStack {
                Text(lang.string("detail.section.lead"))
                Spacer()
                Text(TextFormatters.leadStateLabel(project.lead.state, language: lang))
                    .foregroundStyle(TextFormatters.leadStateColor(project.lead.state))
            }
        } footer: {
            Text(lang.string("lead.footer"))
        }
    }

    @ViewBuilder
    private func progressSection(_ project: ProjectSnapshot, lang: AppLanguage) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline) {
                    Text(TextFormatters.stageName(project.stage, language: lang))
                        .font(.subheadline.weight(.semibold))
                    Spacer()
                    Text("\(project.pct)%")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(store.appearance.tintColor)
                }
                StageTrackView(
                    stages: project.stages,
                    fallbackIndex: TextFormatters.orderedStages.firstIndex(of: project.stage) ?? 0,
                    blocked: project.lead.state == "blocked"
                )
                Text(project.title)
                    .font(.subheadline.weight(.medium))
                    .padding(.top, 2)

                if !project.idea.isEmpty && project.idea != project.title {
                    Text(lang.server(project.idea))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(ideaExpanded ? nil : 3)
                        .onTapGesture {
                            withAnimation { ideaExpanded.toggle() }
                        }
                }
            }
            .padding(.vertical, 3)
            .papertownRowBackground(store.appearance)

            if let note = project.note, !note.isEmpty {
                Label(lang.server(note), systemImage: project.sample ? "info.circle" : "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(project.lead.state == "blocked" ? Color.red : (project.sample ? Color.secondary : Color.orange))
                    .papertownRowBackground(store.appearance)
            }
        } header: {
            HStack {
                Text(lang.string("detail.section.progress"))
                Spacer()
                Text("\(project.doneStageCount)/\(max(project.stages.count, 8))")
            }
        }
    }

    @ViewBuilder
    private func teamSection(_ project: ProjectSnapshot, lang: AppLanguage) -> some View {
        Section {
            if project.team.isEmpty && staffForProject.isEmpty {
                Text(lang.string("detail.team.empty"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .papertownRowBackground(store.appearance)
            } else {
                let members: [(id: String, role: String, subtitle: String, statusLabel: String, statusColor: Color, unread: Bool)] =
                    !staffForProject.isEmpty
                    ? staffForProject.map { agent in
                        let rawLast = agent.last?.data.field("text")?.stringValue
                        let preview = TextFormatters.stripMarkdown(rawLast)
                        return (
                            agent.id,
                            agent.role,
                            preview.isEmpty ? lang.string("detail.no_conversation") : preview,
                            TextFormatters.bucketLabel(agent.effectiveBucket, offline: agent.isOffline, language: lang),
                            TextFormatters.bucketColor(agent.effectiveBucket),
                            agent.watch?.unread == true
                        )
                    }
                    : project.team.map { member in
                        (
                            member.id,
                            member.role,
                            member.model ?? lang.string("detail.no_conversation"),
                            TextFormatters.bucketLabel(member.status == "working" ? "working" : (member.status == "idle" ? "idle" : "off"), language: lang),
                            .secondary,
                            false
                        )
                    }

                ForEach(members, id: \.id) { member in
                    NavigationLink {
                        AgentChatView(
                            agentID: member.id,
                            role: member.role,
                            subtitle: "#\(project.seq) · \(TextFormatters.stageName(project.stage, language: lang))"
                        )
                    } label: {
                        HStack(spacing: 11) {
                            RoleBadgeView(role: member.role, size: 32)
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) {
                                    Text(TextFormatters.roleName(member.role, language: lang))
                                        .font(.body.weight(.medium))
                                    if member.unread {
                                        Circle()
                                            .fill(store.appearance.tintColor)
                                            .frame(width: 7, height: 7)
                                    }
                                }
                                Text(member.subtitle)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            Spacer(minLength: 6)
                            Text(member.statusLabel)
                                .font(.caption)
                                .foregroundStyle(member.statusColor)
                        }
                        .padding(.vertical, 2)
                    }
                    .papertownRowBackground(store.appearance)
                }
            }
            if store.connectionStatus == .connected && !store.isDemo {
                Button { showHire = true } label: {
                    Label(lang.string("hire.title"), systemImage: "person.badge.plus")
                }
                .papertownRowBackground(store.appearance)
            }
        } header: {
            HStack {
                Text(lang.string("detail.section.team"))
                Spacer()
                Text("\(max(project.team.count, staffForProject.count))")
            }
        }
    }
}
