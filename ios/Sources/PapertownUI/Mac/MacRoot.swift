#if os(macOS)
import AppKit
import SwiftUI

// The Mac app's own parts: its menus, its Settings window, this Mac's server and the app delegate. The window itself is
// the shared sidebar frame (Views/AppShell.swift); PapertownApp.swift puts these together.

// MARK: - Menus

public struct PapertownCommands: Commands {
    @ObservedObject var store: TownStore
    @ObservedObject var local: LocalServer

    public init(store: TownStore) {
        self.store = store
        self.local = LocalServer.shared
    }

    public var body: some Commands {
        let lang = store.language
        CommandGroup(replacing: .newItem) {
            Button(lang.string("menu.connect")) {
                store.editingProfile = nil
                store.showConnectSheet = true
            }
            .keyboardShortcut("k", modifiers: [.command, .shift])
            Button(lang.string("menu.open_browser")) {
                if let url = store.currentProfile?.url { NSWorkspace.shared.open(url) }
            }
            .keyboardShortcut("o", modifiers: [.command, .shift])
            .disabled(store.currentProfile?.url == nil || store.isDemo)
        }
        CommandGroup(before: .sidebar) {
            ForEach(Array(AppSection.all.enumerated()), id: \.offset) { i, section in
                Button(lang.string(section.title)) { store.selectedTab = section.tab }
                    .keyboardShortcut(KeyEquivalent(Character(String(i + 1))))
            }
            Divider()
            Button(lang.string("menu.refresh")) { Task { await store.refreshAll() } }
                .keyboardShortcut("r")
                .disabled(store.connectionStatus != .connected)
            Divider()
        }
        CommandMenu(lang.string("menu.server")) {
            Button(lang.string("local.start")) { Task { await local.start() } }
                .disabled(local.isUp || local.state == .starting)
            Button(lang.string("local.restart")) { Task { await local.restart() } }
                .disabled(!local.ownsServer)
            Button(lang.string("local.stop")) { Task { await local.stop() } }
                .disabled(!local.ownsServer)
            Divider()
            Button(lang.string("local.log")) { local.showLog() }
        }
        CommandGroup(replacing: .help) {}
    }
}

// MARK: - Settings window (⌘,)

public struct MacSettingsView: View {
    @ObservedObject var store: TownStore

    public init(store: TownStore) {
        self.store = store
    }

    public var body: some View {
        let lang = store.language
        TabView {
            Form {
                Picker(lang.string("server.appearance"), selection: Binding(get: { store.appearance }, set: { store.setAppearance($0) })) {
                    Text(lang.string("server.appearance.system")).tag(AppAppearance.system)
                    Text(lang.string("server.appearance.light")).tag(AppAppearance.light)
                    Text(lang.string("server.appearance.dark")).tag(AppAppearance.dark)
                    Text(lang.string("server.appearance.paper")).tag(AppAppearance.paper)
                }
                Picker(lang.string("server.language"), selection: Binding(get: { store.language }, set: { store.setLanguage($0) })) {
                    Text(lang.string("server.language.en")).tag(AppLanguage.english)
                    Text(lang.string("server.language.zh")).tag(AppLanguage.simplifiedChinese)
                    Text(lang.string("server.language.system")).tag(AppLanguage.system)
                }
            }
            .formStyle(.grouped)
            .tabItem { Label(lang.string("settings.general"), systemImage: "gearshape") }

            LocalServerSettings(lang: lang)
                .tabItem { Label(lang.string("local.section"), systemImage: "desktopcomputer") }
        }
        .frame(width: 560)
        .fixedSize(horizontal: false, vertical: true)
        .environment(\.locale, store.language.locale)
        .environment(\.emAppearance, store.appearance)
    }
}

/// Where the code is and how the app starts the server; the status and buttons are on the Server page.
struct LocalServerSettings: View {
    let lang: AppLanguage
    @ObservedObject private var local = LocalServer.shared

    var body: some View {
        Form {
            Section {
                LabeledContent(lang.string("local.code")) {
                    HStack {
                        TextField("", text: $local.repoPath).labelsHidden()
                        Button(lang.string("local.choose"), action: choose)
                    }
                }
                // empty follows [server] port in the checkout's papertown.toml, shown as the prompt
                TextField(lang.string("local.port"), value: $local.portSetting, format: .number.grouping(.never),
                          prompt: Text(String(local.configPort)))
                VStack(alignment: .leading, spacing: 6) {
                    TextField(lang.string("local.command"), text: $local.command, axis: .vertical)
                        .font(.system(size: 12, design: .monospaced))
                    Text(lang.string("local.command.footer"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Section {
                Toggle(lang.string("local.auto_start"), isOn: $local.autoStart)
                Toggle(lang.string("local.stop_on_quit"), isOn: $local.stopOnQuit)
            }
            .toggleStyle(.switch)
            Section {
                HStack {
                    Button(lang.string("local.defaults")) { local.restoreDefaults() }
                    Spacer()
                    Button(lang.string("local.log")) { local.showLog() }
                }
            } footer: {
                Text(lang.string("local.apply.footer")).font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }

    private func choose() {
        let p = NSOpenPanel()
        p.canChooseDirectories = true
        p.canChooseFiles = false
        p.directoryURL = local.repoURL
        if p.runModal() == .OK, let url = p.url { local.repoPath = url.path }
    }
}

/// On the Server page: this Mac's server, how it is doing, and starting or stopping it.
struct LocalServerSection: View {
    @EnvironmentObject private var store: TownStore
    @ObservedObject private var local = LocalServer.shared

    var body: some View {
        let lang = store.language
        Section {
            LabeledContent(lang.string("local.status")) {
                HStack(spacing: 6) {
                    Circle().fill(color).frame(width: 8, height: 8)
                    Text(status(lang)).foregroundStyle(color)
                }
            }
            LabeledContent(lang.string("local.address")) {
                Text(local.address).font(.footnote.monospaced()).textSelection(.enabled)
            }
            HStack {
                if local.ownsServer {
                    Button(lang.string("local.restart")) { Task { await local.restart() } }
                    Button(lang.string("local.stop")) { Task { await local.stop() } }
                } else if !local.isUp {
                    Button(lang.string("local.start")) { Task { await local.start() } }
                        .disabled(local.state == .starting)
                }
                if let profile = store.profiles.first(where: { local.manages($0) }), profile.id != store.currentProfile?.id || store.connectionStatus != .connected {
                    Button(lang.string("local.connect")) { Task { await store.connect(to: profile) } }
                        .disabled(!local.isUp)
                } else if !store.profiles.contains(where: { local.manages($0) }) {
                    Button(lang.string("local.connect")) {
                        Task { await local.connect(store) }
                    }
                    .disabled(!local.isUp)
                }
                Spacer()
                Button(lang.string("local.log")) { local.showLog() }
            }
        } header: {
            Text(lang.string("local.section"))
        }
        .task { if local.state == .unknown { await local.refresh() } }
    }

    private var color: Color {
        switch local.state {
        case .running, .external: return .green
        case .starting, .checking, .unknown: return .orange
        case .stopped: return .secondary
        case .failed: return .red
        }
    }

    private func status(_ lang: AppLanguage) -> String {
        switch local.state {
        case .unknown, .checking: return lang.string("local.state.checking")
        case .external: return lang.string("local.state.external")
        case .starting: return lang.string("local.state.starting")
        case .running: return lang.string("local.state.running")
        case .stopped: return lang.string("local.state.stopped")
        case .failed(let problem):
            switch problem {
            case .noCode(let path): return String(format: lang.string("local.problem.no_code"), path)
            case .portTaken(let port): return String(format: lang.string("local.problem.port_taken"), port)
            case .didNotStart: return lang.string("local.problem.did_not_start")
            case .spawn(let message): return String(format: lang.string("local.problem.spawn"), message)
            }
        }
    }
}

// MARK: - App delegate

/// Keeps running with the window closed (the Dock icon brings it back) and stops the server it started on quit.
@MainActor
public final class MacAppDelegate: NSObject, NSApplicationDelegate {
    public func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    public func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard LocalServer.shared.needsQuitTime else { return .terminateNow }
        Task { @MainActor in
            await LocalServer.shared.quit()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}
#endif
