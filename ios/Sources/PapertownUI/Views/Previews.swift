#if DEBUG
import SwiftUI

// Xcode previews of the main pages, all reading the offline demo (Resources/Demo), so they show the five sample
// projects without a server. Their saved servers live in a defaults suite of their own.

@MainActor
enum PreviewTown {
    static func store(language: AppLanguage = .english) -> TownStore {
        let defaults = UserDefaults(suiteName: "papertown.previews") ?? .standard
        let profiles = ProfileStore(defaults: defaults)
        let demo = profiles.loadProfiles().first(where: \.isDemo) ?? ServerProfile.demo(name: "Offline Demo")
        profiles.saveProfiles([demo])
        profiles.saveSelectedID(demo.id)
        profiles.saveLanguage(language)
        return TownStore(profileStore: profiles)
    }
}

/// A page inside a navigation stack, with the demo town loaded around it.
private struct DemoPage<Content: View>: View {
    @StateObject private var store: TownStore
    private let content: () -> Content
    private let stacked: Bool

    /// stacked: false for a page that brings its own navigation stack (the tabs).
    init(language: AppLanguage = .english, stacked: Bool = true, @ViewBuilder content: @escaping () -> Content) {
        _store = StateObject(wrappedValue: PreviewTown.store(language: language))
        self.content = content
        self.stacked = stacked
    }

    var body: some View {
        Group {
            if stacked { NavigationStack { content() } } else { content() }
        }
            .environmentObject(store)
            .environment(\.locale, store.language.locale)
            .task { await store.onAppLaunch() }
    }
}

#Preview("App") {
    PapertownRootView(store: PreviewTown.store())
}

#Preview("App · 简体中文") {
    PapertownRootView(store: PreviewTown.store(language: .simplifiedChinese))
}

#Preview("Project #1 (shipped)") {
    DemoPage { ProjectDetailView(projectID: "line_1") }
}

#Preview("Project #4 · Experiments") {
    DemoPage { ExperimentsPage(projectID: "line_4") }
}

#Preview("Gates & Checks") {
    DemoPage { ChecksPage(projectID: "line_2") }
}

#Preview("Overlap Report") {
    DemoPage { OverlapPage(projectID: "line_5") }
}

#Preview("Paper") {
    DemoPage { PaperPage(projectID: "line_1") }
}

#Preview("Town") {
    DemoPage(stacked: false) { TownView() }
}

#Preview("Library") {
    DemoPage { LibraryPage() }
}

#Preview("Lead conversation") {
    DemoPage { AgentChatView(agentID: "lead-line_5", role: "lead", subtitle: "#5") }
}
#endif
