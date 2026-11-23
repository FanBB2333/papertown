import PapertownCore
import SwiftUI

public struct PapertownRootView: View {
    @StateObject private var store: TownStore
    @Environment(\.scenePhase) private var scenePhase

    public init(store: TownStore? = nil) {
        _store = StateObject(wrappedValue: store ?? TownStore())
    }

    public var body: some View {
        let lang = store.language
        TabView(selection: $store.selectedTab) {
            InboxView()
                .tabItem {
                    Label(lang.string("tab.inbox"), systemImage: "tray.fill")
                }
                .badge(store.inboxItems.count)
                .tag(TownStore.Tab.inbox)

            ProjectsView()
                .tabItem {
                    Label(lang.string("tab.projects"), systemImage: "folder.fill")
                }
                .tag(TownStore.Tab.projects)

            StaffView()
                .tabItem {
                    Label(lang.string("tab.staff"), systemImage: "person.2.fill")
                }
                .tag(TownStore.Tab.staff)

            TownView()
                .tabItem {
                    Label(lang.string("tab.town"), systemImage: "building.columns.fill")
                }
                .tag(TownStore.Tab.town)

            ServerView()
                .tabItem {
                    Label(lang.string("tab.server"), systemImage: "server.rack")
                }
                .tag(TownStore.Tab.server)
        }
        .environmentObject(store)
        .environment(\.locale, store.language.locale)
        .tint(store.appearance.tintColor)
        .preferredColorScheme(store.appearance.colorScheme)
        .task {
            await store.onAppLaunch()
        }
        .onChange(of: scenePhase) { newPhase in
            store.handleScenePhase(newPhase)
        }
        .sheet(isPresented: $store.showConnectSheet, onDismiss: {
            store.editingProfile = nil
        }) {
            ConnectionSheet(editing: store.editingProfile)
                .environmentObject(store)
                .environment(\.locale, store.language.locale)
                .tint(store.appearance.tintColor)
                .preferredColorScheme(store.appearance.colorScheme)
        }
        .sheet(isPresented: $store.showLoginSheet) {
            LoginSheet(expired: store.loginExpired)
                .environmentObject(store)
                .environment(\.locale, store.language.locale)
                .tint(store.appearance.tintColor)
                .preferredColorScheme(store.appearance.colorScheme)
        }
    }
}

// MARK: - Shared Native Building Blocks (Zero Emojis, 100% SF Symbols)

struct StageTrackView: View {
    let stages: [StageInfo]
    let fallbackIndex: Int
    let blocked: Bool

    var body: some View {
        HStack(spacing: 3) {
            if stages.isEmpty {
                ForEach(0..<8, id: \.self) { idx in
                    Capsule()
                        .fill(colorForIndex(idx))
                        .frame(height: 4)
                }
            } else {
                ForEach(stages) { stage in
                    Capsule()
                        .fill(color(for: stage))
                        .frame(height: 4)
                }
            }
        }
    }

    private func color(for stage: StageInfo) -> Color {
        switch stage.status {
        case "done": return .green
        case "run": return blocked ? .red : .accentColor
        default: return Color.secondary.opacity(0.22)
        }
    }

    private func colorForIndex(_ idx: Int) -> Color {
        if idx < fallbackIndex { return .green }
        if idx == fallbackIndex { return blocked ? .red : .accentColor }
        return Color.secondary.opacity(0.22)
    }
}

struct RoleBadgeView: View {
    let role: String
    var size: CGFloat = 32

    var body: some View {
        let tint = TextFormatters.roleTint(role)
        ZStack {
            Circle()
                .fill(tint.opacity(0.14))
                .frame(width: size, height: size)
            Image(systemName: TextFormatters.roleSymbol(role))
                .font(.system(size: size * 0.45, weight: .medium))
                .foregroundStyle(tint)
        }
    }
}

struct ConnectionPillButton: View {
    @EnvironmentObject private var store: TownStore

    var body: some View {
        let lang = store.language
        Button {
            if case .authRequired = store.connectionStatus {
                store.showLoginSheet = true
            } else if store.currentProfile == nil {
                store.showConnectSheet = true
            } else {
                store.selectedTab = .server
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: symbol)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(color)
                Text(label(language: lang))
                    .font(.subheadline)
                    .lineLimit(1)
            }
        }
    }

    private var symbol: String {
        switch store.connectionStatus {
        case .connected: return "dot.radiowaves.left.and.right"
        case .connecting, .reconnecting: return "arrow.triangle.2.circlepath"
        case .authRequired: return "lock.fill"
        case .disconnected: return "wifi.slash"
        }
    }

    private var color: Color {
        switch store.connectionStatus {
        case .connected: return .green
        case .connecting, .reconnecting: return .orange
        case .authRequired: return .orange
        case .disconnected: return .red
        }
    }

    private func label(language: AppLanguage) -> String {
        switch store.connectionStatus {
        case .connected:
            return store.currentProfile?.name ?? language.string("conn.connected")
        case .connecting:
            return language.string("conn.connecting")
        case .reconnecting:
            return language.string("conn.reconnecting")
        case .authRequired:
            return language.string("conn.sign_in_needed")
        case .disconnected:
            return language.string("conn.disconnected")
        }
    }
}

// MARK: - Cross-Platform Native Modifiers

extension View {
    @ViewBuilder
    func papertownInsetGroupedList() -> some View {
        #if os(iOS)
        self.listStyle(.insetGrouped)
        #else
        self.listStyle(.inset)
        #endif
    }

    @ViewBuilder
    func papertownLargeTitle() -> some View {
        #if os(iOS)
        self.navigationBarTitleDisplayMode(.large)
        #else
        self
        #endif
    }

    @ViewBuilder
    func papertownInlineTitle() -> some View {
        #if os(iOS)
        self.navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }

    @ViewBuilder
    func papertownURLInput() -> some View {
        #if os(iOS)
        self
            .keyboardType(.URL)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        #else
        self.autocorrectionDisabled()
        #endif
    }
}
