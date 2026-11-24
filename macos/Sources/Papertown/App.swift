import AppKit
import SwiftUI

@main
struct PapertownApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    private let shell = Shell.shared

    var body: some Scene {
        Window("Papertown", id: "main") {
            MainView(shell: shell)
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1440, height: 900)
        .commands { Menus(shell: shell) }

        Window(t("App 设置…").replacingOccurrences(of: "…", with: ""), id: "app-settings") {
            AppSettings(shell: shell)
        }
        .windowResizability(.contentSize)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.appearance = NSAppearance(named: .aqua) // the splash is light; the page sets the look once it loads
        Task { await Shell.shared.start() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard Shell.shared.needsQuitTime else { return .terminateNow }
        Task {
            await Shell.shared.quit()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}

struct Menus: Commands {
    let shell: Shell
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        CommandGroup(replacing: .appSettings) {
            Button(t("设置…")) { shell.page.send(["type": "settings"]) }
                .keyboardShortcut(",")
                .disabled(shell.phase != .ready)
            Button(t("App 设置…")) { openWindow(id: "app-settings") }
                .keyboardShortcut(",", modifiers: [.command, .option])
        }
        CommandGroup(replacing: .newItem) {
            Button(t("在浏览器中打开")) { if let base = shell.base { NSWorkspace.shared.open(base) } }
                .keyboardShortcut("o", modifiers: [.command, .shift])
                .disabled(shell.phase != .ready)
        }
        CommandGroup(before: .toolbar) {
            Group {
                Button(t("进展")) { shell.page.send(["type": "view", "view": "cards"]) }.keyboardShortcut("1")
                Button(t("中控屏")) { shell.page.send(["type": "view", "view": "console"]) }.keyboardShortcut("2")
                Button(t("小镇地图")) { shell.page.send(["type": "view", "view": "world"]) }.keyboardShortcut("3")
                Divider()
                Button(t("重新载入")) { shell.reload() }.keyboardShortcut("r")
            }
            .disabled(shell.phase != .ready)
            Divider()
            Button(t("实际大小")) { shell.page.zoom(0) }.keyboardShortcut("0")
            Button(t("放大")) { shell.page.zoom(1) }.keyboardShortcut("=")
            Button(t("缩小")) { shell.page.zoom(-1) }.keyboardShortcut("-")
            Divider()
        }
        CommandMenu(t("服务")) {
            Button(t("重新构建网页")) { Task { await shell.rebuild() } }
                .keyboardShortcut("r", modifiers: [.command, .shift])
                .disabled(shell.building)
            Toggle(t("网页代码改动后自动构建"), isOn: Bindable(shell).autoBuild)
            Divider()
            Button(t("重启服务")) { Task { await shell.restartServer() } }
                .disabled(!shell.ownsServer)
                .help(shell.ownsServer ? "" : t("服务不是这个 App 启动的：在启动它的地方重启"))
            Divider()
            Button(t("显示服务日志")) { NSWorkspace.shared.open(Logs.server) }
            Button(t("显示构建日志")) { NSWorkspace.shared.open(Logs.build) }
        }
        CommandGroup(replacing: .help) {}
    }
}

struct MainView: View {
    let shell: Shell

    var body: some View {
        ZStack {
            PageView(page: shell.page)
            if shell.phase != .ready {
                Splash(shell: shell).transition(.opacity)
            }
        }
        .frame(minWidth: 960, minHeight: 600)
        .background(Color(nsColor: shell.phase == .ready ? shell.strip : .paper).ignoresSafeArea())
        .background(OneWindow())
    }
}

// no tabs: there is one town
struct OneWindow: NSViewRepresentable {
    final class Probe: NSView {
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            window?.tabbingMode = .disallowed
        }
    }

    func makeNSView(context: Context) -> Probe { Probe() }
    func updateNSView(_ view: Probe, context: Context) {}
}

// Shown while the server starts and the page builds; mirrors web/index.html's boot mark so one hands over to the other.
struct Splash: View {
    let shell: Shell
    @Environment(\.openWindow) private var openWindow
    @Environment(\.accessibilityReduceMotion) private var still

    static let logo: NSImage? = NSImage(contentsOf: Shell.shared.repoURL.appendingPathComponent("web/public/logo.svg"))
        ?? Bundle.main.url(forResource: "logo", withExtension: "svg").flatMap(NSImage.init(contentsOf:))

    var body: some View {
        TimelineView(.animation(paused: still)) { tl in
            let s = still ? 0 : tl.date.timeIntervalSinceReferenceDate
            let bob = (1 - cos(s / 2.6 * 2 * .pi)) / 2, run = s / 1.3 - (s / 1.3).rounded(.down)
            VStack(spacing: 12) {
                Image(nsImage: Self.logo ?? NSApp.applicationIconImage)
                    .resizable()
                    .frame(width: 96, height: 96)
                    .rotationEffect(.degrees(-3 * bob))
                    .offset(y: -4 * bob)
                Text("Papertown")
                    .font(.custom("Songti SC", size: 30))
                    .tracking(1.2)
                    .foregroundStyle(Color(nsColor: .ink))
                LinearGradient(colors: [.clear, Color(nsColor: .brand), .clear], startPoint: .leading, endPoint: .trailing)
                    .frame(width: 112, height: 3)
                    .offset(x: still ? 0 : -84 + 168 * run)
                    .frame(width: 56, height: 3)
                    .clipShape(Capsule())
                    .padding(.top, 4)
                    .opacity(shell.phase.failure == nil ? 1 : 0)
            }
        }
        .overlay(alignment: .bottom) {
            detail
                .frame(width: 560)
                .alignmentGuide(.bottom) { $0[.top] - 28 }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .paper))
    }

    @ViewBuilder private var detail: some View {
        switch shell.phase {
        case .starting(let message):
            Text(message).font(.system(size: 13)).foregroundStyle(Color(nsColor: .muted))
        case .failed(let message, let log):
            VStack(spacing: 14) {
                let tail = log.map { Logs.tail($0) } ?? ""
                Text(message).font(.system(size: 14)).foregroundStyle(Color(nsColor: .ink)).multilineTextAlignment(.center)
                if !tail.isEmpty {
                    ScrollView {
                        Text(tail)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(Color(nsColor: .muted))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                            .padding(10)
                    }
                    .frame(maxHeight: 170)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .ink).opacity(0.05)))
                }
                HStack {
                    Button(t("重试")) { Task { await shell.start() } }.keyboardShortcut(.defaultAction)
                    if let log { Button(t("显示日志")) { NSWorkspace.shared.open(log) } }
                    Button(t("App 设置…")) { openWindow(id: "app-settings") }
                }
            }
        case .ready:
            EmptyView()
        }
    }
}

extension Shell.Phase {
    var failure: String? {
        if case .failed(let message, _) = self { return message }
        return nil
    }
}

// The app's own settings; the town's are the page's, under ⌘,.
struct AppSettings: View {
    @Bindable var shell: Shell

    var body: some View {
        Form {
            Section {
                LabeledContent(t("Papertown 的代码")) {
                    HStack {
                        TextField("", text: $shell.repoPath).labelsHidden()
                        Button(t("选择…"), action: choose)
                    }
                }
                TextField(t("端口"), value: $shell.port, format: .number.grouping(.never))
                VStack(alignment: .leading, spacing: 6) {
                    TextField(t("启动服务的命令"), text: $shell.command, axis: .vertical)
                        .font(.system(size: 12, design: .monospaced))
                    Text(t("在代码的 server 目录里、用登录 shell 的环境运行；$PAPERTOWN_PORT 是上面的端口。端口上已经有 Papertown 在跑时，App 直接用它。"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Section {
                Toggle(t("网页代码改动后自动构建"), isOn: $shell.autoBuild)
                Toggle(t("退出 App 时停止它启动的服务"), isOn: $shell.stopOnQuit)
            }
            Section {
                HStack {
                    Button(t("恢复默认")) {
                        shell.repoPath = Shell.defaultRepo
                        shell.port = 31640
                        shell.command = Shell.defaultCommand
                        shell.autoBuild = true
                        shell.stopOnQuit = true
                    }
                    Spacer()
                    Button(t("重启服务")) {
                        Task { if shell.ownsServer { await shell.restartServer() } else { await shell.start() } }
                    }
                }
            } footer: {
                Text(t("改了代码位置、端口或命令，重启服务后生效")).font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .frame(width: 580)
        .fixedSize(horizontal: false, vertical: true)
    }

    private func choose() {
        let p = NSOpenPanel()
        p.canChooseDirectories = true
        p.canChooseFiles = false
        p.directoryURL = shell.repoURL
        if p.runModal() == .OK, let url = p.url { shell.repoPath = url.path }
    }
}
