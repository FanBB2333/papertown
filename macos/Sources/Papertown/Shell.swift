import AppKit
import Observation
import SwiftUI

// What the app does: find or start the server, keep the page built from the current web code,
// show it, and stop what it started when it quits.
@MainActor @Observable
final class Shell {
    static let shared = Shell()

    enum Phase: Equatable {
        case starting(String)
        case failed(String, log: URL?)
        case ready
    }

    var phase = Phase.starting("")
    var lang: Lang { didSet { defaults.set(lang.rawValue, forKey: "lang") } }
    private(set) var ownsServer = false
    private(set) var strip = NSColor.hud // under the hidden title bar, the colour of the page's top bar

    // the app's own settings (the page has its own, behind ⌘,)
    var repoPath: String { didSet { defaults.set(repoPath, forKey: "repo") } }
    var port: Int { didSet { defaults.set(port, forKey: "port") } }
    var command: String { didSet { defaults.set(command, forKey: "command") } }
    var autoBuild: Bool { didSet { defaults.set(autoBuild, forKey: "autoBuild") } }
    var stopOnQuit: Bool { didSet { defaults.set(stopOnQuit, forKey: "stopOnQuit") } }

    static let defaultCommand = "uv run papertown serve --port $PAPERTOWN_PORT"
    // build.sh writes where the code is into Info.plist
    static var defaultRepo: String { Bundle.main.object(forInfoDictionaryKey: "PTRepoRoot") as? String ?? "" }

    @ObservationIgnored let page: Page
    @ObservationIgnored private let defaults = UserDefaults.standard
    @ObservationIgnored private var server: Server?
    @ObservationIgnored private var build: WebBuild?
    @ObservationIgnored private var watcher: Watcher?
    @ObservationIgnored private var starting = false
    @ObservationIgnored private var buildAgain = false
    @ObservationIgnored private var buildFailed = false
    @ObservationIgnored private var shownBuild: Date? // when the build the page was loaded from was made
    @ObservationIgnored private var sourceTimer: Task<Void, Never>?
    @ObservationIgnored private var distTimer: Task<Void, Never>?
    @ObservationIgnored private var badge: Task<Void, Never>?

    private init() {
        let d = UserDefaults.standard
        let lang = Lang(rawValue: d.string(forKey: "lang") ?? "") ?? .system
        self.lang = lang
        repoPath = d.string(forKey: "repo") ?? Self.defaultRepo
        port = d.object(forKey: "port") as? Int ?? 8000
        command = d.string(forKey: "command") ?? Self.defaultCommand
        autoBuild = d.object(forKey: "autoBuild") as? Bool ?? true
        stopOnQuit = d.object(forKey: "stopOnQuit") as? Bool ?? true
        page = Page(lang: lang)
        page.onLang = { [weak self] in self?.lang = $0 }
        page.onLook = { [weak self] strip, dark in
            self?.strip = strip
            NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        }
        page.onFinish = { [weak self] in self?.loaded() }
        page.onFail = { [weak self] e in
            guard let self, self.phase != .ready else { return }
            self.phase = .failed(t("页面打不开：{0}", e.localizedDescription), log: Logs.server)
        }
    }

    var base: URL? { server?.base }
    private(set) var building = false

    func start() async {
        guard !starting else { return }
        starting = true
        defer { starting = false }
        phase = .starting(t("正在打开…"))
        badge?.cancel()

        let repo = URL(fileURLWithPath: (repoPath as NSString).expandingTildeInPath).resolvingSymlinksInPath()
        let fm = FileManager.default
        guard fm.fileExists(atPath: repo.appendingPathComponent("server/pyproject.toml").path),
              fm.fileExists(atPath: repo.appendingPathComponent("web/package.json").path) else {
            return phase = .failed(t("找不到 Papertown 的代码：{0}", repo.path), log: nil)
        }
        if build?.repo != repo {
            let b = WebBuild(repo: repo)
            build = b
            watcher = Watcher([b.web, repo.appendingPathComponent("design/src")]) { [weak self] in self?.changed($0) }
        }
        let build = build!
        if server?.port != port {
            if server?.owned == true { await server?.stop() }
            server = Server(port: port)
            server!.onExit = { [weak self] in self?.serverExited() }
        }
        let server = server!

        switch await server.probe() {
        case .other:
            return phase = .failed(t("端口 {0} 被别的程序占用了", port), log: nil)
        case .papertown:
            ownsServer = server.owned
            if autoBuild && build.stale { await rebuild() }
            guard await server.servesPage() else {
                return phase = .failed(t("服务在运行，但没有托管网页：它启动时 web/dist 还不存在，重启它就好"), log: nil)
            }
        case .nothing:
            // the server serves web/dist only if it is there when it starts
            if build.built == nil { await rebuild() }
            guard build.built != nil else { return phase = .failed(t("网页还没构建过，这次构建也失败了"), log: Logs.build) }
            phase = .starting(t("正在启动服务…"))
            do {
                try await server.start(command, repo: repo)
            } catch {
                return phase = .failed("\(t("服务没能启动")): \(error.localizedDescription)", log: Logs.server)
            }
            ownsServer = true
            async let up = server.ready()
            if autoBuild && build.stale {
                await rebuild()
                phase = .starting(t("正在启动服务…"))
            }
            if !(await up) {
                await server.stop()
                ownsServer = false
                return phase = .failed(t("服务没能启动"), log: Logs.server)
            }
        }

        phase = .starting(t("正在打开…"))
        shownBuild = build.built
        page.load(server.base)
        watchBadge(server)
    }

    private func loaded() {
        guard phase != .ready else { return }
        withAnimation(.easeOut(duration: 0.25)) { phase = .ready }
        if buildFailed { page.toast(t("网页构建失败，详见「服务」菜单里的构建日志")) }
    }

    // builds the page again; asked again while building, builds once more after
    func rebuild() async {
        guard let build else { return }
        if build.running { return buildAgain = true }
        building = true
        defer { building = false }
        repeat {
            buildAgain = false
            let ok = await build.run { step in
                if case .starting = self.phase {
                    self.phase = .starting(step == .installing ? t("正在安装网页的依赖…") : t("正在构建网页…"))
                }
            }
            buildFailed = !ok
            if !ok && phase == .ready { page.toast(t("网页构建失败，详见「服务」菜单里的构建日志")) }
        } while buildAgain
    }

    func restartServer() async {
        guard let server, server.owned else { return }
        phase = .starting(t("正在启动服务…"))
        await server.stop()
        ownsServer = false
        await start()
    }

    func reload() {
        shownBuild = build?.built
        page.web.reload()
    }

    func quit() async {
        sourceTimer?.cancel()
        await build?.cancel()
        if stopOnQuit { await server?.stop() }
    }

    var needsQuitTime: Bool { building || (stopOnQuit && server?.owned == true) }

    private func serverExited() {
        ownsServer = false
        if phase == .ready { page.toast(t("服务退出了，可以在「服务」菜单里重启")) }
    }

    // a file changed under web/ or design/src
    private func changed(_ paths: [String]) {
        guard let build else { return }
        let dist = build.dist.path
        if paths.contains(where: { $0 == dist || $0.hasPrefix(dist + "/") }) {
            distTimer?.cancel()
            distTimer = Task { [weak self] in
                try? await Task.sleep(for: .seconds(1))
                if !Task.isCancelled { await self?.distChanged() }
            }
        }
        if autoBuild && paths.contains(where: build.isSource) {
            // after the edits settle, and only if no one else has built them by then
            sourceTimer?.cancel()
            sourceTimer = Task { [weak self] in
                try? await Task.sleep(for: .seconds(3))
                guard let self, !Task.isCancelled, self.phase == .ready, build.stale else { return }
                await self.rebuild()
            }
        }
    }

    private func distChanged() async {
        guard phase == .ready, let built = build?.built, built != shownBuild else { return }
        if await page.writing() {
            shownBuild = built
            page.toast(t("网页有更新，按 ⌘R 重新载入"))
        } else {
            reload()
        }
    }

    // the Dock icon shows how many projects are waiting on you
    private func watchBadge(_ server: Server) {
        badge?.cancel()
        badge = Task {
            while !Task.isCancelled {
                if let (data, _) = try? await Server.get(server.base.appendingPathComponent("api/world")),
                   let world = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let lines = (world["hud"] as? [String: Any])?["lines"] as? [String: Any] {
                    let waiting = lines["waiting"] as? Int ?? 0
                    NSApp.dockTile.badgeLabel = waiting > 0 ? String(waiting) : nil
                }
                try? await Task.sleep(for: .seconds(15))
            }
        }
    }
}

extension NSColor {
    convenience init?(hex: String) {
        guard hex.count == 7, hex.hasPrefix("#"), let v = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        self.init(srgbRed: CGFloat(v >> 16 & 255) / 255, green: CGFloat(v >> 8 & 255) / 255, blue: CGFloat(v & 255) / 255, alpha: 1)
    }

    static let paper = NSColor(srgbRed: 0xf4 / 255, green: 0xee / 255, blue: 0xe2 / 255, alpha: 1) // --bg
    static let hud = NSColor(srgbRed: 0xf3 / 255, green: 0xe2 / 255, blue: 0xd5 / 255, alpha: 1) // the page's top bar
    static let ink = NSColor(srgbRed: 0x2f / 255, green: 0x26 / 255, blue: 0x1d / 255, alpha: 1)
    static let muted = NSColor(srgbRed: 0x85 / 255, green: 0x75 / 255, blue: 0x60 / 255, alpha: 1)
    static let brand = NSColor(srgbRed: 0xc2 / 255, green: 0x66 / 255, blue: 0x3f / 255, alpha: 1)
}
