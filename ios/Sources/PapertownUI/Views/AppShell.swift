import PapertownCore
import SwiftUI
#if os(iOS)
import UIKit
#endif

// The app's frame for the shape it has. Taller than wide (an iPhone or iPad held upright, a narrow iPad window): tabs
// along the bottom, the server behind the connection pill. Wider than tall: a sidebar, beside the page where there is
// room for one (iPad, Plus and Max iPhones) and sliding over it from the left where there is not. The Mac keeps the
// system's list in SidebarShell. The pages are the same in every frame, and turning the device keeps the section and
// what is open in it, because both live in TownStore.

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
    @State private var tall = AppShell.startsTall
    #endif

    var body: some View {
        #if os(macOS)
        SidebarShell(store: store)
        #else
        Group {
            if tall {
                TabShell(store: store, width: width)
            } else if width == .regular {
                SplitShell(store: store)
            } else {
                DrawerShell(store: store)
            }
        }
        // the whole window, keyboard and all: typing does not turn an upright iPad into a wide one
        .background(
            GeometryReader { g in
                Color.clear
                    .onAppear { tall = g.size.height > g.size.width }
                    .onChange(of: g.size) { tall = $0.height > $0.width }
            }
            .ignoresSafeArea()
        )
        #endif
    }

    #if os(iOS)
    /// The window's shape at launch, so the first frame is already the right one.
    private static var startsTall: Bool {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        guard let b = (windows.first { $0.isKeyWindow } ?? windows.first)?.bounds, b.width > 0 else {
            return UIDevice.current.userInterfaceIdiom == .phone
        }
        return b.height > b.width
    }
    #endif
}

#if os(iOS)
/// Upright: the four sections as tabs along the bottom. The server opens from the connection pill on the pages, so a
/// server section chosen in another frame becomes its page over the Inbox here.
struct TabShell: View {
    @ObservedObject var store: TownStore
    /// The width the pages get: on an iPad the tab bar is told the width is compact, which keeps it along the bottom.
    let width: UserInterfaceSizeClass?

    var body: some View {
        let lang = store.language
        TabView(selection: $store.selectedTab) {
            ForEach(AppSection.all.filter { $0.tab != .server }) { section in
                AppSection.page(section.tab)
                    .environment(\.horizontalSizeClass, width)
                    .tabItem { Label(lang.string(section.title), systemImage: section.symbol) }
                    .badge(section.tab == .inbox ? store.inboxItems.count : 0)
                    .tag(section.tab)
            }
        }
        .environment(\.horizontalSizeClass, .compact)
        .onAppear { leaveServer() }
        .onChange(of: store.selectedTab) { _ in leaveServer() }
    }

    private func leaveServer() {
        guard store.selectedTab == .server else { return }
        store.selectedTab = .inbox
        store.inboxPath.append(InboxRoute.server)
    }
}
#endif

extension View {
    /// A page that wants the whole height (the canvas, a conversation): the tab bar steps aside while it shows.
    func papertownHidesTabBar() -> some View {
        #if os(iOS)
        toolbar(.hidden, for: .tabBar)
        #else
        self
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
