import PapertownCore
import SwiftUI

struct ProjectsView: View {
    enum Filter: String, CaseIterable, Identifiable {
        case all, needs, active, done
        var id: String { rawValue }
    }

    @EnvironmentObject private var store: TownStore
    @State private var filter: Filter = .all
    @State private var searchText = ""
    @State private var showNewIdea = false
    @State private var path: [ProjectRoute] = []

    private var filteredProjects: [ProjectSnapshot] {
        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let askProjectIDs = Set(store.openAsks.filter { $0.data.open != false }.map(\.lineID))

        return store.projects.filter { project in
            switch filter {
            case .all:
                break
            case .needs:
                if project.lead.state != "blocked" && !askProjectIDs.contains(project.id) { return false }
            case .active:
                if project.isDone { return false }
            case .done:
                if !project.isDone { return false }
            }
            guard !q.isEmpty else { return true }
            let stageName = TextFormatters.stageName(project.stage, language: store.language).lowercased()
            return project.title.lowercased().contains(q)
                || project.idea.lowercased().contains(q)
                || "#\(project.seq)".contains(q)
                || stageName.contains(q)
        }
    }

    var body: some View {
        let lang = store.language
        NavigationStack(path: $path) {
            List {
                Section {
                    Picker(lang.string("tab.projects"), selection: $filter) {
                        Text(lang.string("projects.filter.all")).tag(Filter.all)
                        Text(lang.string("projects.filter.needs")).tag(Filter.needs)
                        Text(lang.string("projects.filter.active")).tag(Filter.active)
                        Text(lang.string("projects.filter.done")).tag(Filter.done)
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                }

                if filteredProjects.isEmpty {
                    Section {
                        EmptyStateView(
                            title: lang.string("inbox.noprojects.title"),
                            systemImage: "folder",
                            description: lang.string("inbox.noprojects.desc"),
                            actionTitle: lang.string("projects.new_idea.title")
                        ) {
                            showNewIdea = true
                        }
                    }
                    .papertownRowBackground(store.appearance)
                } else {
                    Section {
                        ForEach(filteredProjects) { project in
                            NavigationLink {
                                ProjectDetailView(projectID: project.id)
                            } label: {
                                projectRow(project, lang: lang)
                            }
                            .papertownRowBackground(store.appearance)
                        }
                    }
                }
            }
            .papertownInsetGroupedList()
            .papertownListAppearance(store.appearance)
            .navigationTitle(lang.string("tab.projects"))
            .navigationDestination(for: ProjectRoute.self) { route in route.view }
            #if DEBUG
            // -PTProject line_1 [-PTPage checks|overlap|method|exp|paper|reports|files|usage|outline] opens that page
            // at launch, for screenshots in the simulator.
            .task {
                guard path.isEmpty, let id = UserDefaults.standard.string(forKey: "PTProject") else { return }
                path.append(.project(id))
                if let page = UserDefaults.standard.string(forKey: "PTPage") { path.append(.page(id, page)) }
            }
            #endif
            .papertownLargeTitle()
            .searchable(text: $searchText, prompt: lang.string("projects.search"))
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showNewIdea = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel(lang.string("projects.new_idea.title"))
                    .disabled(store.connectionStatus != .connected)
                }
            }
            .refreshable {
                await store.refreshAll()
            }
            .sheet(isPresented: $showNewIdea) {
                NewIdeaSheet()
                    .environmentObject(store)
                    .environment(\.locale, store.language.locale)
                    .tint(store.appearance.tintColor)
                    .preferredColorScheme(store.appearance.colorScheme)
            }
        }
    }

    private func projectRow(_ project: ProjectSnapshot, lang: AppLanguage) -> some View {
        let asksCount = store.openAsks.filter { $0.lineID == project.id && $0.data.open != false }.count
        return VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("#\(project.seq) \(lang.server(project.title))")
                    .font(.body.weight(.medium))
                    .lineLimit(2)
                Spacer(minLength: 6)
                Text(TextFormatters.leadStateLabel(project.lead.state, language: lang))
                    .font(.caption.weight(.medium))
                    .foregroundStyle(TextFormatters.leadStateColor(project.lead.state))
            }

            StageTrackView(
                stages: project.stages,
                fallbackIndex: TextFormatters.orderedStages.firstIndex(of: project.stage) ?? 0,
                blocked: project.lead.state == "blocked"
            )

            HStack {
                Text(project.isDone
                     ? lang.string("stage.complete")
                     : "\(TextFormatters.stageName(project.stage, language: lang)) · \(project.pct)%")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                if project.sample {
                    Text(lang.string("projects.sample"))
                        .font(.caption2.weight(.medium))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.secondary.opacity(0.14), in: Capsule())
                        .foregroundStyle(.secondary)
                }

                Spacer()

                if asksCount > 0 {
                    Text(lang.format("projects.waiting_count", asksCount))
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.orange)
                }
            }
        }
        .padding(.vertical, 3)
    }
}

struct NewIdeaSheet: View {
    @EnvironmentObject private var store: TownStore
    @Environment(\.dismiss) private var dismiss
    @State private var ideaText = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    var body: some View {
        let lang = store.language
        NavigationStack {
            Form {
                Section {
                    ZStack(alignment: .topLeading) {
                        if ideaText.isEmpty {
                            Text(lang.string("projects.new_idea.placeholder"))
                                .foregroundStyle(.tertiary)
                                .padding(.top, 8)
                                .padding(.leading, 4)
                        }
                        TextEditor(text: $ideaText)
                            .frame(minHeight: 140)
                    }
                } header: {
                    Text(lang.string("projects.new_idea.section"))
                } footer: {
                    Text(lang.string("projects.new_idea.footer"))
                }

                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(lang.string("projects.new_idea.title"))
            .papertownInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(lang.string("action.cancel")) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSubmitting {
                        ProgressView()
                    } else {
                        Button(lang.string("action.create")) {
                            submit()
                        }
                        .fontWeight(.semibold)
                        .disabled(ideaText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
        }
    }

    private func submit() {
        let trimmed = ideaText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        isSubmitting = true
        errorMessage = nil
        Task {
            do {
                _ = try await store.createIdea(trimmed)
                dismiss()
            } catch {
                errorMessage = TextFormatters.errorMessage(for: error, language: store.language)
            }
            isSubmitting = false
        }
    }
}

enum ProjectRoute: Hashable {
    case project(String)
    case page(String, String)

    @ViewBuilder
    var view: some View {
        switch self {
        case .project(let id): ProjectDetailView(projectID: id)
        case .page(let id, let page):
            switch page {
            case "checks": ChecksPage(projectID: id)
            case "overlap": OverlapPage(projectID: id)
            case "method": MethodPage(projectID: id)
            case "exp": ExperimentsPage(projectID: id)
            case "paper": PaperPage(projectID: id)
            case "reports": ReportsPage(projectID: id)
            case "files": FilesPage(projectID: id, root: "paper")
            case "usage": ProjectUsagePage(projectID: id)
            case "chat": AgentChatView(agentID: "lead-\(id)", role: "lead", subtitle: "#" + (id.split(separator: "_").last.map(String.init) ?? id))
            default: OutlinePage(projectID: id)
            }
        }
    }
}
