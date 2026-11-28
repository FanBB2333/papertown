import PapertownCore
import SwiftUI

// Papertown's own sidebar, the same on the Mac, iPad and iPhone held wide, after the Claude app's: a quiet colour a
// shade under the page, the four sections with the one open in the tint, and the server along the bottom like an
// account. Where there is room it stands beside the page (SplitShell: the Mac, iPad, wide iPhones); where there is not
// it slides over the page from the left (DrawerShell), opened from the button the pages put at their top left
// (papertownSidebarButton). Held upright an iPhone or iPad has tabs instead (TabShell).

// MARK: - Opening it from a page

private struct OpenSidebarKey: EnvironmentKey {
    static let defaultValue: (() -> Void)? = nil
}

extension EnvironmentValues {
    /// Set where the sidebar is out of sight (the iPhone's drawer): the pages' top-left button calls it.
    var openSidebar: (() -> Void)? {
        get { self[OpenSidebarKey.self] }
        set { self[OpenSidebarKey.self] = newValue }
    }
}

private struct SidebarButton: ViewModifier {
    var shown = true
    @Environment(\.openSidebar) private var open
    @EnvironmentObject private var store: TownStore

    func body(content: Content) -> some View {
        #if os(iOS)
        if shown, let open {
            content.toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: open) {
                        Image(systemName: "sidebar.left")
                            .overlay(alignment: .topTrailing) {
                                // something waits in the Inbox, which the drawer hides
                                if !store.inboxItems.isEmpty {
                                    Text("\(store.inboxItems.count)").font(.caption2).emNum(.warn).offset(x: 6, y: -5)
                                }
                            }
                    }
                    .accessibilityLabel(store.language.string("sidebar.open"))
                }
            }
        } else {
            content
        }
        #else
        content
        #endif
    }
}

extension View {
    /// The top-left button that opens the sidebar, on the first page of each section; shown only in the drawer frame.
    func papertownSidebarButton(_ shown: Bool = true) -> some View {
        modifier(SidebarButton(shown: shown))
    }
}

// MARK: - Recent projects

extension TownStore {
    private var serverKey: String { selectedProfileID?.uuidString ?? "" }

    /// Projects opened lately on this server, newest first (ids repeat from one server to the next).
    var recentProjectIDs: [String] { recentByServer[serverKey] ?? [] }

    /// A project page came up: it is the one open now, and the most recent.
    func noteOpened(_ id: String) {
        if currentProjectID != id { currentProjectID = id }
        guard recentProjectIDs.first != id else { return }
        recentByServer[serverKey] = Array(([id] + recentProjectIDs.filter { $0 != id }).prefix(20))
        UserDefaults.standard.set(recentByServer, forKey: TownStore.recentKey)
    }

    func openProject(_ id: String) {
        selectedTab = .projects
        projectsPath = NavigationPath([ProjectRoute.project(id)])
    }
}

// MARK: - The two frames

/// The Mac, iPad, and an iPhone wide enough: the sidebar beside the page. On iPad the button at its head folds it away
/// and the split view then offers its own to bring it back; the Mac keeps that button in the window's title bar.
struct SplitShell: View {
    @ObservedObject var store: TownStore
    @State private var columns = NavigationSplitViewVisibility.all

    var body: some View {
        NavigationSplitView(columnVisibility: $columns) {
            #if os(iOS)
            PapertownSidebar(hide: { withAnimation { columns = .detailOnly } })
                .toolbar(.hidden, for: .navigationBar)
                .navigationSplitViewColumnWidth(min: 240, ideal: 270, max: 320)
            #else
            PapertownSidebar()
                .navigationSplitViewColumnWidth(min: 208, ideal: 236, max: 300)
            #endif
        } detail: {
            AppSection.page(store.selectedTab)
                #if os(macOS)
                // the page's colour up to the top of the window, under a title bar with no band of its own
                .background((store.appearance.groupedBackground ?? .clear).ignoresSafeArea())
                .toolbarBackground(.hidden, for: .windowToolbar)
                #endif
        }
        .navigationSplitViewStyle(.balanced)  // beside the page, in portrait too
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

#if os(iOS)

/// iPhone, and narrow windows: the page alone, the sidebar sliding over it from the left. A tap beside it or a swipe
/// to the left closes it, and so does any choice made in it.
struct DrawerShell: View {
    @ObservedObject var store: TownStore
    @State private var open = false
    @State private var pull: CGFloat = 0

    var body: some View {
        GeometryReader { geo in
            let width = min(geo.size.width * 0.84, 360)
            ZStack(alignment: .leading) {
                AppSection.page(store.selectedTab)
                    .environment(\.openSidebar) { show(true) }
                    .accessibilityHidden(open)
                if open {
                    Color.black.opacity(0.3)
                        .ignoresSafeArea()
                        .onTapGesture { show(false) }
                        .accessibilityLabel(store.language.string("sidebar.close"))
                        .accessibilityAddTraits(.isButton)
                        .transition(.opacity)
                    PapertownSidebar(drawer: true, picked: { show(false) })
                        .frame(width: width)
                        .shadow(color: .black.opacity(0.18), radius: 18, x: 6)
                        .offset(x: pull)
                        .gesture(
                            DragGesture(minimumDistance: 12)
                                .onChanged { pull = min(0, $0.translation.width) }
                                .onEnded { drag in
                                    if drag.translation.width < -width / 3 || drag.predictedEndTranslation.width < -width / 2 {
                                        show(false)
                                    } else {
                                        withAnimation(Self.spring) { pull = 0 }
                                    }
                                }
                        )
                        .transition(.move(edge: .leading))
                        .zIndex(1)
                }
            }
        }
        #if DEBUG
        // -PTSidebar YES opens it at launch, for screenshots in the simulator
        .onAppear { if UserDefaults.standard.bool(forKey: "PTSidebar") { open = true } }
        #endif
    }

    private static let spring = Animation.spring(response: 0.32, dampingFraction: 0.9)

    private func show(_ on: Bool) {
        if on { pull = 0 }
        withAnimation(Self.spring) { open = on }
    }
}

#endif

// MARK: - The sidebar

struct PapertownSidebar: View {
    @EnvironmentObject private var store: TownStore
    /// In the iPhone's drawer: a search field at the top, and it closes after each choice.
    var drawer = false
    /// iPad: folds the column away. Nil leaves the button out.
    var hide: (() -> Void)? = nil
    var picked: () -> Void = {}
    @State private var query = ""

    var body: some View {
        let lang = store.language
        VStack(spacing: 0) {
            HStack(alignment: .center) {
                Text(verbatim: "Papertown")
                    .font(.system(.title3, design: .serif).weight(.semibold))
                Spacer()
                if let hide {
                    Button(action: hide) {
                        Image(systemName: "sidebar.left")
                            .font(.title3)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel(lang.string("sidebar.hide"))
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, Self.headTop)
            .padding(.bottom, 12)

            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    if drawer {
                        search(lang)
                    }
                    newIdea(lang)
                    ForEach(AppSection.all.filter { $0.tab != .server }) { section in
                        SidebarRow(
                            title: lang.string(section.title),
                            symbol: section.symbol,
                            count: section.tab == .inbox ? store.inboxItems.count : 0,
                            selected: isSelected(section.tab)
                        ) { go(section.tab) }
                    }
                    matches(lang)
                }
                .padding(.horizontal, 10)
                .padding(.bottom, 12)
            }
            #if os(iOS)
            .scrollDismissesKeyboard(.immediately)
            #endif

            Rectangle().fill(Color.primary.opacity(0.07)).frame(height: 1).padding(.horizontal, 14)
            ServerRow(selected: store.selectedTab == .server) { server() }
                .padding(.horizontal, 10)
                .padding(.top, 6)
                .padding(.bottom, Self.footBottom)
        }
        .background(store.appearance.sidebarBackground.ignoresSafeArea())
    }

    #if os(macOS)
    private static let headTop: CGFloat = 4, footBottom: CGFloat = 10  // the title bar is above the head
    #else
    private static let headTop: CGFloat = 12, footBottom: CGFloat = 6
    #endif

    // MARK: Rows

    private func search(_ lang: AppLanguage) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
            TextField(lang.string("projects.search"), text: $query)
                .textFieldStyle(.plain)
                #if os(iOS)
                .submitLabel(.search)
                #endif
        }
        .font(.subheadline)
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.primary.opacity(0.06)))
        .padding(.bottom, 8)
    }

    private func newIdea(_ lang: AppLanguage) -> some View {
        let ready = store.connectionStatus == .connected
        return Button {
            store.projectsPath = NavigationPath()
            store.selectedTab = .projects
            store.newProjectRequested = true
            picked()
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "plus")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(store.appearance.sidebarBackground)
                    .frame(width: 22, height: 22)
                    .background(Circle().fill(Color.primary))
                Text(lang.string("projects.new_idea.title"))
                    .font(.callout)
                Spacer(minLength: 0)
            }
            .modifier(RowLook(selected: false))
        }
        .buttonStyle(.plain)
        .disabled(!ready)
        .opacity(ready ? 1 : 0.4)
    }

    @ViewBuilder
    private func matches(_ lang: AppLanguage) -> some View {
        let list = matchingProjects
        if !list.isEmpty {
            Text(lang.string("tab.projects"))
                .font(.footnote.weight(.medium))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 10)
                .padding(.top, 18)
                .padding(.bottom, 4)
            let waiting = Set(store.openAsks.filter { $0.data.open != false }.map(\.lineID))
            ForEach(list) { project in
                let needs = project.lead.state == "blocked" || waiting.contains(project.id) || !store.decisions(project.id).isEmpty
                let open = store.selectedTab == .projects && store.currentProjectID == project.id
                Button {
                    store.openProject(project.id)
                    picked()
                } label: {
                    HStack(spacing: 6) {
                        EmText(project.title.isEmpty ? project.idea : project.title, .matches([query]))
                            .font(.subheadline)
                            .fontWeight(open ? .semibold : .regular)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .emBar(needs ? .warn : (project.title.isEmpty || project.title == project.idea ? .info : nil))
                    .modifier(RowLook(selected: open, compact: true))
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(open ? .isSelected : [])
            }
        }
    }

    /// The projects matching a search. Without one the sidebar lists no projects: the Inbox and Projects pages show
    /// them, with more about each.
    private var matchingProjects: [ProjectSnapshot] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return [] }
        return store.projects.filter {
            $0.title.lowercased().contains(q) || $0.idea.lowercased().contains(q) || "#\($0.seq)".contains(q)
        }
    }

    // MARK: Actions

    private func isSelected(_ tab: TownStore.Tab) -> Bool {
        store.selectedTab == tab
    }

    private func go(_ tab: TownStore.Tab) {
        if store.selectedTab == tab {
            // the section again: back to its first page
            if tab == .projects {
                store.projectsPath = NavigationPath()
            } else if tab == .inbox {
                store.inboxPath = NavigationPath()
            }
        }
        store.selectedTab = tab
        picked()
    }

    private func server() {
        if case .authRequired = store.connectionStatus {
            store.showLoginSheet = true
        } else if store.currentProfile == nil {
            store.showConnectSheet = true
        } else {
            store.selectedTab = .server
        }
        picked()
    }
}

/// A rounded row: the one open on a wash of the tint, and a soft shade under the one the pointer is over.
private struct RowLook: ViewModifier {
    let selected: Bool
    var compact = false
    @EnvironmentObject private var store: TownStore
    @State private var over = false

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
        content
            .padding(.horizontal, 10)
            .padding(.vertical, compact ? 7 : 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(shape.fill(selected ? store.appearance.tintColor.opacity(0.14) : Color.primary.opacity(over ? 0.06 : 0)))
            .contentShape(shape)
            #if os(iOS)
            .hoverEffect(.highlight)
            #else
            .onHover { over = $0 }
            .animation(.easeOut(duration: 0.12), value: over)
            #endif
    }
}

private struct SidebarRow: View {
    let title: String
    let symbol: String
    let count: Int
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: selected ? Self.filled(symbol) : symbol)
                    .font(.body)
                    .foregroundStyle(selected ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                    .frame(width: 22)
                Text(title)
                    .font(.callout)
                    .fontWeight(selected ? .semibold : .regular)
                Spacer(minLength: 4)
                if count > 0 {
                    // what waits on you: the one filled mark in the sidebar
                    Text("\(count)")
                        .font(.caption.weight(.semibold).monospacedDigit())
                        .foregroundStyle(.white)
                        .padding(.horizontal, 7)
                        .frame(minWidth: 20, minHeight: 20)
                        .background(Capsule().fill(Color.orange))
                }
            }
            .modifier(RowLook(selected: selected))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// The section open now has its symbol filled in.
    private static func filled(_ symbol: String) -> String {
        symbol == "building.columns" || symbol == "tray" || symbol == "folder" || symbol == "person.2" ? symbol + ".fill" : symbol
    }
}

/// The server along the bottom, like an account: its initial, whether it answers, its address. A tap opens Server, or
/// signs in, or connects.
private struct ServerRow: View {
    @EnvironmentObject private var store: TownStore
    let selected: Bool
    let action: () -> Void

    var body: some View {
        let lang = store.language
        let name = store.currentProfile?.name ?? lang.string("sidebar.connect")
        Button(action: action) {
            HStack(spacing: 10) {
                Text(String(name.prefix(1)).uppercased())
                    .font(.subheadline.weight(.semibold))
                    .frame(width: 30, height: 30)
                    .background(Circle().fill(Color.primary.opacity(0.08)))
                    .overlay(alignment: .bottomTrailing) {
                        Circle().fill(dot).frame(width: 9, height: 9)
                            .overlay(Circle().stroke(store.appearance.sidebarBackground, lineWidth: 2))
                    }
                VStack(alignment: .leading, spacing: 1) {
                    Text(name)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    Text(detail(lang)).font(.caption).emState(store.connectionIssue)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .modifier(RowLook(selected: selected))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// Green while it answers, orange while connecting or waiting for a sign-in, grey when it does not.
    private var dot: Color {
        switch store.connectionStatus {
        case .connected: return .green
        case .connecting, .reconnecting, .authRequired: return .orange
        case .disconnected: return Color.secondary
        }
    }

    private func detail(_ lang: AppLanguage) -> String {
        switch store.connectionStatus {
        case .connected:
            if store.isDemo { return lang.string("sidebar.demo") }
            let address = store.currentProfile?.addressString ?? ""
            return address.replacingOccurrences(of: "https://", with: "").replacingOccurrences(of: "http://", with: "")
        case .connecting: return lang.string("conn.connecting")
        case .reconnecting: return lang.string("conn.reconnecting")
        case .authRequired: return lang.string("conn.sign_in_needed")
        case .disconnected: return lang.string("conn.disconnected")
        }
    }
}
