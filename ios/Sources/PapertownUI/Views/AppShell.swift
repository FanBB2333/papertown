import PapertownCore
import SwiftUI

// The app's frame for the space it has. A sidebar beside the page on the Mac, on iPad, and on an iPhone wide enough
// for one (iPhone Duo open, Plus and Max models in landscape); tabs along the bottom on an iPhone or a narrow window
// (iPad Split View, iPhone Duo folded). The pages are the same in both. Switching frames keeps the section and what is
// open in it, because both live in TownStore.

struct AppSection: Identifiable {
    let tab: TownStore.Tab
    let title: String
    let symbol: String
    var id: TownStore.Tab { tab }

    static let all = [
        AppSection(tab: .inbox, title: "tab.inbox", symbol: "tray"),
        AppSection(tab: .projects, title: "tab.projects", symbol: "folder"),
        AppSection(tab: .staff, title: "tab.staff", symbol: "person.2"),
        AppSection(tab: .town, title: "tab.town", symbol: "building.columns"),
        AppSection(tab: .server, title: "tab.server", symbol: "server.rack"),
    ]

    @ViewBuilder
    static func page(_ tab: TownStore.Tab) -> some View {
        switch tab {
        case .inbox: InboxView()
        case .projects: ProjectsView()
        case .staff: StaffView()
        case .town: TownView()
        case .server: ServerView()
        }
    }
}

struct AppShell: View {
    @ObservedObject var store: TownStore
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var width
    #endif

    var body: some View {
        #if os(macOS)
        SidebarShell(store: store)
        #else
        if width == .regular {
            SidebarShell(store: store)
        } else {
            TabShell(store: store)
        }
        #endif
    }
}

/// The sidebar and the page beside it.
struct SidebarShell: View {
    @ObservedObject var store: TownStore

    var body: some View {
        let lang = store.language
        NavigationSplitView {
            List(selection: Binding<TownStore.Tab?>(get: { store.selectedTab }, set: { if let tab = $0 { store.selectedTab = tab } })) {
                ForEach(AppSection.all) { section in
                    Label(lang.string(section.title), systemImage: section.symbol)
                        .badge(section.tab == .inbox ? store.inboxItems.count : 0)
                        .tag(section.tab as TownStore.Tab?)
                }
            }
            #if os(iOS)
            .listStyle(.sidebar)
            .navigationTitle("Papertown")
            #endif
            .navigationSplitViewColumnWidth(min: 180, ideal: 220, max: 280)
            .safeAreaInset(edge: .bottom) {
                ConnectionPillButton()
                    .buttonStyle(.plain)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
            }
        } detail: {
            AppSection.page(store.selectedTab)
        }
        #if os(macOS)
        .frame(minWidth: 880, minHeight: 580)
        .onAppear { setBadge(store.inboxItems.count) }
        .onChange(of: store.inboxItems.count) { setBadge($0) }
        #endif
    }

    #if os(macOS)
    /// The Dock icon counts what waits on you, like the Inbox.
    private func setBadge(_ n: Int) {
        NSApp.dockTile.badgeLabel = n > 0 ? String(n) : nil
    }
    #endif
}

/// Tabs along the bottom.
struct TabShell: View {
    @ObservedObject var store: TownStore

    var body: some View {
        let lang = store.language
        TabView(selection: $store.selectedTab) {
            ForEach(AppSection.all) { section in
                AppSection.page(section.tab)
                    .tabItem { Label(lang.string(section.title), systemImage: section.symbol + (section.tab == .server ? "" : ".fill")) }
                    .badge(section.tab == .inbox ? store.inboxItems.count : 0)
                    .tag(section.tab)
            }
        }
    }
}
