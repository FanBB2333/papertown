import PapertownCore
import SwiftUI

public struct PapertownRootView: View {
    @StateObject private var store: TownStore
    @Environment(\.scenePhase) private var scenePhase
    #if DEBUG
    @State private var debugChat = false
    #endif

    public init(store: TownStore? = nil) {
        _store = StateObject(wrappedValue: store ?? TownStore())
    }

    public var body: some View {
        sections
            .environmentObject(store)
            .environment(\.locale, store.language.locale)
            .tint(store.appearance.tintColor)
            .preferredColorScheme(store.appearance.colorScheme)
            .task {
                #if os(macOS)
                // this Mac's own server first, started if the chosen server is it and nothing runs there
                let testRun = UserDefaults.standard.bool(forKey: "PTDemo") || UserDefaults.standard.string(forKey: "PTConnect") != nil
                if !testRun { await LocalServer.shared.prepare(store) }
                #endif
                await store.onAppLaunch()
            }
            .onChange(of: scenePhase) { newPhase in
                store.handleScenePhase(newPhase)
            }
            #if DEBUG
            // -PTChat <agent id> [-PTChatTab terminal]: opens that conversation once connected, for screenshots
            .sheet(isPresented: $debugChat) {
                if let id = UserDefaults.standard.string(forKey: "PTChat") {
                    NavigationStack { AgentChatView(agentID: id, role: id.components(separatedBy: "-").first ?? "coder", subtitle: "") }
                        .environmentObject(store)
                        .environment(\.locale, store.language.locale)
                        .tint(store.appearance.tintColor)
                }
            }
            .onChange(of: store.connectionStatus) { status in
                if status == .connected, UserDefaults.standard.string(forKey: "PTChat") != nil { debugChat = true }
            }
            #endif
            .sheet(isPresented: $store.showConnectSheet, onDismiss: {
                store.editingProfile = nil
            }) {
                ConnectionSheet(editing: store.editingProfile)
                    .papertownSheetFrame()
                    .environmentObject(store)
                    .environment(\.locale, store.language.locale)
                    .tint(store.appearance.tintColor)
                    .preferredColorScheme(store.appearance.colorScheme)
            }
            .sheet(isPresented: $store.showLoginSheet) {
                LoginSheet(expired: store.loginExpired)
                    .papertownSheetFrame(height: 360)
                    .environmentObject(store)
                    .environment(\.locale, store.language.locale)
                    .tint(store.appearance.tintColor)
                    .preferredColorScheme(store.appearance.colorScheme)
            }
            .environment(\.emAppearance, store.appearance)
    }

    /// A sidebar or tabs, whichever fits (AppShell.swift).
    private var sections: some View {
        AppShell(store: store)
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
        case "done": return .secondary.opacity(0.55)
        case "run": return blocked ? .red : .accentColor
        default: return Color.secondary.opacity(0.22)
        }
    }

    private func colorForIndex(_ idx: Int) -> Color {
        if idx < fallbackIndex { return .secondary.opacity(0.55) }
        if idx == fallbackIndex { return blocked ? .red : .accentColor }
        return Color.secondary.opacity(0.22)
    }
}

struct RoleBadgeView: View {
    let role: String
    var size: CGFloat = 32

    var body: some View {
        let tint = Color.secondary
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
    /// How the server page opens: slid in over the page the pill sits on. Without it (in the sidebar) the server
    /// section takes the page's place.
    var open: (() -> Void)? = nil
    @EnvironmentObject private var store: TownStore

    var body: some View {
        let lang = store.language
        Button {
            if case .authRequired = store.connectionStatus {
                store.showLoginSheet = true
            } else if store.currentProfile == nil {
                store.showConnectSheet = true
            } else if let open {
                open()
            } else {
                store.selectedTab = .server
            }
        } label: {
            HStack(spacing: 5) {
                if store.connectionIssue == nil { Image(systemName: symbol).font(.caption).foregroundStyle(.secondary) }
                Text(label(language: lang)).font(.subheadline)
                    .emState(store.connectionIssue, icon: symbol)
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

extension TownStore {
    var connectionIssue: EmTone? {
        switch connectionStatus {
        case .authRequired, .reconnecting: return .warn
        case .disconnected: return currentProfile == nil ? nil : .bad
        default: return nil
        }
    }

    var connectionColor: Color {
        switch connectionStatus {
        case .connected: return .secondary
        case .connecting, .reconnecting: return .orange
        case .authRequired: return .orange
        case .disconnected: return .red
        }
    }
}

// MARK: - Cross-Platform Native Modifiers

/// A page's sections: a list on iPhone and iPad, and on the Mac a grouped form, which draws the same rounded cards
/// there (a Mac list has no grouped style).
#if os(macOS)
struct PageList<Content: View>: View {
    @ViewBuilder var content: () -> Content
    var body: some View { Form(content: content).formStyle(.grouped) }
}
#else
typealias PageList = List
#endif

/// A text field whose words show inside it until something is typed, on every platform: a Mac form would otherwise
/// stand them to the left of the field as its label and leave the field empty.
@MainActor @ViewBuilder
func PromptField(_ prompt: String, text: Binding<String>, axis: Axis = .horizontal) -> some View {
    #if os(macOS)
    TextField(text: text, prompt: Text(prompt), axis: axis) { Text(prompt) }.labelsHidden()
    #else
    TextField(prompt, text: text, axis: axis)
    #endif
}

/// Keeps a scrolling page's content in a column of at most `width`, in the middle of what is wider. The whole width
/// still scrolls.
struct PageColumn: ViewModifier {
    static let reading: CGFloat = 780
    let width: CGFloat
    @State private var room: CGFloat = 0

    func body(content: Content) -> some View {
        let side = max(0, (room - width) / 2)
        Group {
            if #available(iOS 17.0, macOS 14.0, *) {
                content.contentMargins(.horizontal, side, for: .scrollContent)
            } else {
                content.padding(.horizontal, side)
            }
        }
        .background(GeometryReader { g in
            Color.clear.onAppear { room = g.size.width }.onChange(of: g.size.width) { room = $0 }
        })
    }
}

extension View {
    /// A page of grouped sections: rounded cards on the page's colour, in a column no wider than reads well. On iPad
    /// and the Mac the column sits in the middle of the window, so a row never runs the whole width of it.
    @ViewBuilder
    func papertownInsetGroupedList(column: CGFloat = PageColumn.reading) -> some View {
        #if os(iOS)
        self.listStyle(.insetGrouped).modifier(PageColumn(width: column))
        #else
        self.modifier(PageColumn(width: column))
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

    /// A sheet on the Mac opens at its content's size, which for a form is too small: give it room.
    @ViewBuilder
    func papertownSheetFrame(width: CGFloat = 520, height: CGFloat = 560) -> some View {
        #if os(macOS)
        self.frame(minWidth: width, idealWidth: width, minHeight: height, idealHeight: height)
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
