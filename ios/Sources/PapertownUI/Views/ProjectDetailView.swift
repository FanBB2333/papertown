import PapertownCore
import SwiftUI

struct ProjectDetailView: View {
    let projectID: String
    var matterID: Int? = nil
    @EnvironmentObject private var store: TownStore
    @State private var ideaExpanded = false
    @State private var isUpdatingLead = false
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
                ScrollViewReader { proxy in
                    PageList {
                        asksSection
                        LoopPreviewSection(projectID: projectID)
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
                    .task(id: matterKey) {
                        if let key = matterKey { proxy.scrollTo(key, anchor: .top) }
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

    private var matterKey: String? {
        guard let matterID else { return nil }
        return store.decisions(projectID).first { $0.kind == "matter" && $0.id == String(matterID) }?.key
    }

    private var asksSection: some View { DecisionsSection(projectID: projectID) }

    /// What the project has produced, a page per stage group, plus its gates, files and spending.
    @ViewBuilder
    private func researchSection(_ project: ProjectSnapshot, lang: AppLanguage) -> some View {
        let checks = store.cards[projectID]?.checks
        let reached: (String) -> Bool = { key in
            project.stages.first(where: { $0.key == key }).map { $0.status != "todo" } ?? false
        }
        Section {
            link(lang.string("reports.nav"), "text.bubble", detail: nil) { ReportsPage(projectID: projectID) }
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
        } header: {
            SectionTitle(title: lang.string("detail.section.research"), symbol: "books.vertical")
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
                        .foregroundStyle(.secondary)
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
            .emBar(project.lead.state == "blocked" ? .warn : nil)
            .padding(.vertical, 2)
            .papertownRowBackground(store.appearance)
            NavigationLink { DecidedPage(projectID: projectID) } label: {
                HStack(spacing: 8) {
                    Text(lang.string("decided.nav")).fixedSize()
                    Spacer(minLength: 0)
                    DecidedStatsLine(stats: store.cards[projectID]?.decided, projectSummary: true)
                }
            }
            .papertownRowBackground(store.appearance)
            NavigationLink { ProvPage(projectID: projectID) } label: {
                HStack(spacing: 8) {
                    Text(lang.string("prov.nav")).fixedSize()
                    Spacer(minLength: 0)
                    ProvStatsLine(stats: store.cards[projectID]?.prov, projectSummary: true)
                }
            }
            .papertownRowBackground(store.appearance)
            if project.lead.state != "ended" {
                LeadRoundsRows(projectID: projectID).papertownRowBackground(store.appearance)
            }
        } header: {
            SectionTitle(title: lang.string("detail.section.lead"), symbol: "person.crop.circle.badge.checkmark") {
                let state = project.lead.state
                StateTag(text: TextFormatters.leadStateLabel(state, language: lang),
                         tone: state == "running" ? .good : state == "starting" ? .info : EmTone.issue(state), small: true)
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
                        .font(.subheadline).emNum()
                }
                StageTrackView(
                    stages: project.stages,
                    fallbackIndex: TextFormatters.orderedStages.firstIndex(of: project.stage) ?? 0,
                    blocked: project.lead.state == "blocked"
                )
                Text(project.title)
                    .font(.subheadline).emKey().emBar(project.title == project.idea && !project.idea.isEmpty ? .info : nil)
                    .padding(.top, 2)

                if !project.idea.isEmpty && project.idea != project.title {
                    Text(project.idea)
                        .font(.footnote).emBar(.info)
                        .lineLimit(ideaExpanded ? nil : 3)
                        .onTapGesture {
                            withAnimation { ideaExpanded.toggle() }
                        }
                }
            }
            .padding(.vertical, 3)
            .papertownRowBackground(store.appearance)

            if let note = project.note, !note.isEmpty {
                EmText(lang.server(note)).font(.footnote)
                    .emState(project.lead.state == "blocked" ? .bad : nil, detail: true)
                    .papertownRowBackground(store.appearance)
            }
        } header: {
            SectionTitle(title: lang.string("detail.section.progress"), symbol: "chart.bar.xaxis") {
                Text("\(project.doneStageCount)/\(max(project.stages.count, 8))").emNum()
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
                let members: [(id: String, role: String, last: AgentEvent?, fallback: String, statusLabel: String, statusTone: EmTone?, unread: Bool)] =
                    !staffForProject.isEmpty
                    ? staffForProject.map { agent in
                        (
                            agent.id,
                            agent.role,
                            agent.last, lang.string("detail.no_conversation"),
                            TextFormatters.bucketLabel(agent.effectiveBucket, offline: agent.isOffline, language: lang),
                            EmTone.issue(agent.effectiveBucket),
                            agent.watch?.unread == true
                        )
                    }
                    : project.team.map { member in
                        (
                            member.id,
                            member.role,
                            nil, member.model ?? lang.string("detail.no_conversation"),
                            TextFormatters.bucketLabel(member.status == "working" ? "working" : (member.status == "idle" ? "idle" : "off"), language: lang),
                            nil,
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
                                Text(TextFormatters.roleName(member.role, language: lang))
                                    .font(.body.weight(.medium))
                                StaffMessagePreview(event: member.last, fallback: member.fallback, unread: member.unread)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            Spacer(minLength: 6)
                            Text(member.statusLabel)
                                .font(.caption)
                                .emState(member.statusTone)
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
            SectionTitle(title: lang.string("detail.section.team"), symbol: "person.2") {
                Text("\(max(project.team.count, staffForProject.count))").foregroundStyle(.secondary)
            }
        }
    }
}
