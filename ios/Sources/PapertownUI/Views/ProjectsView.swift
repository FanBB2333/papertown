import PapertownCore
import SwiftUI

struct ProjectsView: View {
    #if DEBUG
    private static var linked = false
    #endif
    enum Filter: String, CaseIterable, Identifiable {
        case all, needs, active, done
        var id: String { rawValue }
    }

    @EnvironmentObject private var store: TownStore
    @State private var filter: Filter = .all
    @State private var searchText = ""
    @State private var showNewIdea = false
    @State private var freshPapers: [FreshPaper] = []

    private var filteredProjects: [ProjectSnapshot] {
        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let askProjectIDs = Set(store.openAsks.filter { $0.data.open != false }.map(\.lineID))

        return store.projects.filter { project in
            switch filter {
            case .all:
                break
            case .needs:
                if project.lead.state != "blocked" && !askProjectIDs.contains(project.id) && store.decisions(project.id).isEmpty { return false }
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

    private func takeNewIdeaRequest() {
        guard store.newProjectRequested else { return }
        store.newProjectRequested = false
        showNewIdea = true
    }

    var body: some View {
        let lang = store.language
        NavigationStack(path: $store.projectsPath) {
            CardPage {
                Picker(lang.string("tab.projects"), selection: $filter) {
                    Text(lang.string("projects.filter.all")).tag(Filter.all)
                    Text(lang.string("projects.filter.needs")).tag(Filter.needs)
                    Text(lang.string("projects.filter.active")).tag(Filter.active)
                    Text(lang.string("projects.filter.done")).tag(Filter.done)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                #if os(macOS)
                .fixedSize()
                #else
                .frame(maxWidth: 440)
                #endif

                if filteredProjects.isEmpty {
                    EmptyStateView(
                        title: lang.string("inbox.noprojects.title"),
                        systemImage: "folder",
                        description: lang.string("inbox.noprojects.desc"),
                        actionTitle: lang.string("projects.new_idea.title")
                    ) {
                        showNewIdea = true
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 24)
                    .papertownCard()
                } else {
                    // as many columns as fit: one on an iPhone, more on an iPad and the Mac
                    CardGrid {
                        ForEach(filteredProjects) { project in
                            NavigationLink(value: ProjectRoute.project(project.id)) {
                                ProjectCard(project: project, query: searchText)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                if filter == .all && searchText.isEmpty && !store.projects.isEmpty {
                    FreshPapersPanel(papers: freshPapers)
                }
            }
            .onAppear { store.currentProjectID = nil }  // back on the list: no project open
            .navigationTitle(lang.string("tab.projects"))
            .papertownSidebarButton()
            .task(id: store.connectionStatus == .connected && !store.projects.isEmpty) {
                guard store.connectionStatus == .connected, !store.projects.isEmpty else { return }
                freshPapers = (try? await store.fetch { try await $0.freshPapers() }) ?? []
            }
            .navigationDestination(for: ProjectRoute.self) { route in route.view }
            #if DEBUG
            // -PTProject line_1 [-PTPage decided|prov|checks|overlap|method|exp|paper|reports|files|usage|loop|canvas|outline] opens that page
            // at launch, for screenshots in the simulator.
            .task {
                guard !Self.linked, let id = UserDefaults.standard.string(forKey: "PTProject") else { return }
                Self.linked = true
                var path = NavigationPath([ProjectRoute.project(id)])
                if let page = UserDefaults.standard.string(forKey: "PTPage") { path.append(ProjectRoute.page(id, page)) }
                store.projectsPath = path
            }
            #endif
            .papertownLargeTitle()
            .searchable(text: $searchText, prompt: lang.string("projects.search"))
            .toolbar {
                ToolbarItem(placement: .automatic) {
                    UpdateAllButton()
                }
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
            // the sidebar's 新建 Idea
            .onAppear { takeNewIdeaRequest() }
            .onChange(of: store.newProjectRequested) { _ in takeNewIdeaRequest() }
            .sheet(isPresented: $showNewIdea) {
                NewIdeaSheet()
                    .papertownSheetFrame(height: 420)
                    .environmentObject(store)
                    .environment(\.locale, store.language.locale)
                    .tint(store.appearance.tintColor)
                    .preferredColorScheme(store.appearance.colorScheme)
            }
        }
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
                            .emBar(ideaText.isEmpty ? nil : .info, reserve: true)
                    }
                } header: {
                    Text(lang.string("projects.new_idea.section"))
                } footer: {
                    Text(lang.string("projects.new_idea.footer"))
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage).font(.footnote).emState(.bad, detail: true)
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
            case "decided": DecidedPage(projectID: id)
            case "prov": ProvPage(projectID: id)
            case "checks": ChecksPage(projectID: id)
            case "overlap": OverlapPage(projectID: id)
            case "method": MethodPage(projectID: id)
            case "exp": ExperimentsPage(projectID: id)
            case "paper": PaperPage(projectID: id)
            case "reports": ReportsPage(projectID: id)
            case "files": FilesPage(projectID: id, root: "paper")
            case "usage": ProjectUsagePage(projectID: id)
            case "loop": LoopPage(projectID: id)
            case "canvas": LoopCanvasPage(projectID: id)
            case "pages": PagesPage(projectID: id)
            case "memory": MemoryPage(projectID: id)
            case "chat": AgentChatView(agentID: "lead-\(id)", role: "lead", subtitle: "#" + (id.split(separator: "_").last.map(String.init) ?? id))
            default: OutlinePage(projectID: id)
            }
        }
    }
}
