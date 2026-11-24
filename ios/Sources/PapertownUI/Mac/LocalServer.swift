#if os(macOS)
import AppKit
import Darwin
import Foundation

/// The Papertown server on this Mac: the one already running on the port (started from a terminal, say), or one the
/// app starts from the code's server folder and stops when it quits. The same job as the earlier web-page app in
/// macos/ (Server.swift, Proc.swift).
@MainActor
public final class LocalServer: ObservableObject {
    public static let shared = LocalServer()

    public enum Problem: Equatable {
        case noCode(String)
        case portTaken(Int)
        case didNotStart
        case spawn(String)
    }

    public enum State: Equatable {
        case unknown
        case checking
        /// Running, started elsewhere: the app uses it and leaves it running.
        case external
        case starting
        /// Running, started by this app.
        case running
        case stopped
        case failed(Problem)
    }

    @Published public private(set) var state: State = .unknown
    @Published public var repoPath: String { didSet { defaults.set(repoPath, forKey: Key.repo); reloadConfig() } }
    /// The port set in the app's settings, which wins over the checkout's config; nil follows the config.
    @Published public var portSetting: Int? {
        didSet {
            if let portSetting { defaults.set(portSetting, forKey: Key.port) } else { defaults.removeObject(forKey: Key.port) }
        }
    }
    /// The port the checkout's config gives the server (CheckoutConfig), read again before each check and start.
    @Published public private(set) var configPort = CheckoutConfig.fallbackPort
    @Published public var command: String {
        didSet {
            if command == Self.defaultCommand { defaults.removeObject(forKey: Key.command) } else { defaults.set(command, forKey: Key.command) }
        }
    }
    @Published public var autoStart: Bool { didSet { defaults.set(autoStart, forKey: Key.autoStart) } }
    @Published public var stopOnQuit: Bool { didSet { defaults.set(stopOnQuit, forKey: Key.stopOnQuit) } }

    /// Without --port: the server reads its port from the checkout's papertown.toml, or from PAPERTOWN_PORT when the
    /// app's settings set one.
    public static let defaultCommand = "uv run --frozen papertown serve"
    /// Where the code is, written into Info.plist at build time (PT_REPO_ROOT).
    public static var defaultRepo: String {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: "PTRepoRoot") as? String, !raw.isEmpty, !raw.contains("$(") else { return "" }
        return URL(fileURLWithPath: raw).standardizedFileURL.path
    }

    private enum Key {
        static let repo = "papertown.mac.local.repo"
        static let port = "papertown.mac.local.port"
        static let command = "papertown.mac.local.command"
        static let autoStart = "papertown.mac.local.autoStart"
        static let stopOnQuit = "papertown.mac.local.stopOnQuit"
        /// The saved server the app made for this Mac's own.
        static let profile = "papertown.mac.local.profile"
    }

    private let defaults = UserDefaults.standard
    private var child: Child?
    /// The port the app's own server was started on.
    private var startedPort: Int?
    /// The app's store, from prepare: after a start, its saved server for this Mac follows the port.
    private weak var store: TownStore?

    private init() {
        let d = UserDefaults.standard
        repoPath = d.string(forKey: Key.repo) ?? Self.defaultRepo
        portSetting = d.object(forKey: Key.port) as? Int
        command = d.string(forKey: Key.command) ?? Self.defaultCommand
        autoStart = d.object(forKey: Key.autoStart) as? Bool ?? true
        stopOnQuit = d.object(forKey: Key.stopOnQuit) as? Bool ?? true
        reloadConfig()
    }

    /// The server's port: the one the app started it on while it runs, else the app's setting, else the config's.
    public var port: Int { (ownsServer ? startedPort : nil) ?? portSetting ?? configPort }
    public var address: String { "http://127.0.0.1:\(port)" }
    public var repoURL: URL { URL(fileURLWithPath: (repoPath as NSString).expandingTildeInPath) }
    public var ownsServer: Bool { child != nil && child?.status == nil }
    public var isUp: Bool { state == .external || state == .running }
    public var hasCode: Bool { FileManager.default.fileExists(atPath: repoURL.appendingPathComponent("server/pyproject.toml").path) }

    public func restoreDefaults() {
        repoPath = Self.defaultRepo
        portSetting = nil
        command = Self.defaultCommand
        autoStart = true
        stopOnQuit = true
    }

    /// Reads the checkout's config again: the web app's Settings › Network & security, say, may have changed the port.
    /// The login shell's environment counts once it has been read, as it does for the server the app starts.
    private func reloadConfig(env: [String: String]? = nil) {
        let read = CheckoutConfig.port(repo: repoURL.resolvingSymlinksInPath(), env: env ?? LoginEnv.current ?? [:])
        if read != configPort { configPort = read }
    }

    /// Whether a saved server is this Mac's own, on the port the app looks after.
    public func manages(_ profile: ServerProfile) -> Bool {
        isThisMac(profile) && profile.url.map(Self.portOf) == port
    }

    private func isThisMac(_ profile: ServerProfile) -> Bool {
        guard !profile.isDemo, let host = profile.url?.host?.lowercased() else { return false }
        return ["127.0.0.1", "localhost", "::1"].contains(host)
    }

    private static func portOf(_ url: URL) -> Int {
        url.port ?? (url.scheme?.lowercased() == "https" ? 443 : 80)
    }

    /// Connects to this Mac's server: the saved server the app made for it, moved to the server's port, or a new one.
    public func connect(_ store: TownStore) async {
        await follow(store)
        if let profile = store.profiles.first(where: { manages($0) }) {
            await store.connect(to: profile)
        } else {
            await addProfile(to: store, connectNow: true)
        }
    }

    /// Saves this Mac's server, remembered as the one whose port follows the server's.
    private func addProfile(to store: TownStore, connectNow: Bool) async {
        let profile = ServerProfile(name: store.language.string("local.profile.name"), addressString: address)
        defaults.set(profile.id.uuidString, forKey: Key.profile)
        await store.upsertProfile(profile, password: nil, connectNow: connectNow)
    }

    /// The saved server the app made for this Mac's own; one saved before the app remembered it is recognised by being
    /// on this Mac under the name the app gives it.
    private func localProfile(in store: TownStore) -> ServerProfile? {
        if let raw = defaults.string(forKey: Key.profile), let id = UUID(uuidString: raw) {
            return store.profiles.first { $0.id == id }
        }
        let names = Set([AppLanguage.english, .simplifiedChinese].map { $0.string("local.profile.name") })
        guard let found = store.profiles.first(where: { names.contains($0.name) && isThisMac($0) }) else { return nil }
        defaults.set(found.id.uuidString, forKey: Key.profile)
        return found
    }

    /// Moves the saved server for this Mac's own to the port the server runs on. True when it moved.
    @discardableResult
    private func follow(_ store: TownStore) async -> Bool {
        guard var profile = localProfile(in: store), let url = profile.url, Self.portOf(url) != port,
              var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        parts.port = port
        guard let moved = parts.string else { return false }
        profile.addressString = moved
        await store.upsertProfile(profile, password: nil, connectNow: false)
        return true
    }

    /// Once the server answers: the saved server for this Mac's own follows its port, connected again when it is the
    /// chosen one and was in use (before the first connection, the app's launch connects to it).
    private func followStore() async {
        guard let store, await follow(store), let current = store.currentProfile, manages(current),
              store.connectionStatus != .disconnected else { return }
        await store.connect(to: current)
    }

    /// Before the first connection: with no saved server, this Mac's own becomes the first; when the chosen server is
    /// this Mac's and nothing runs on its port, the app starts it.
    public func prepare(_ store: TownStore) async {
        self.store = store
        reloadConfig()
        if store.profiles.isEmpty, hasCode {
            await addProfile(to: store, connectNow: false)
        } else {
            await follow(store)
        }
        guard let profile = store.currentProfile, manages(profile) else { return }
        if autoStart {
            await ensure()
        } else {
            await refresh()
        }
    }

    public func refresh() async {
        reloadConfig()
        if state != .starting { state = .checking }
        switch await probe() {
        case .papertown: state = ownsServer ? .running : .external
        case .other: state = .failed(.portTaken(port))
        case .nothing: if state != .starting { state = .stopped }
        }
    }

    /// The server answers on the port, started now if nothing was there. True once it answers.
    @discardableResult
    public func ensure() async -> Bool {
        reloadConfig()
        switch await probe() {
        case .papertown:
            state = ownsServer ? .running : .external
            return true
        case .other:
            state = .failed(.portTaken(port))
            return false
        case .nothing:
            return await start()
        }
    }

    @discardableResult
    public func start() async -> Bool {
        if ownsServer || state == .starting { return isUp }
        guard hasCode else {
            state = .failed(.noCode(repoURL.path))
            return false
        }
        state = .starting
        var env = await LoginEnv.get()
        // the port the server will take: PAPERTOWN_PORT or PAPERTOWN_CONFIG in the login shell count for it too
        reloadConfig(env: env)
        if await probe() == .papertown {
            state = .external
            await followStore()
            return true
        }
        let port = self.port
        // only a port set in the app's settings overrides the config (or a command of one's own that asks for it)
        if portSetting != nil || command.contains("PAPERTOWN_PORT") { env["PAPERTOWN_PORT"] = String(port) }
        Logs.begin(Logs.server, command)
        let started: Child
        do {
            started = try Child(command, in: repoURL.resolvingSymlinksInPath().appendingPathComponent("server"), env: env, log: Logs.server)
        } catch {
            state = .failed(.spawn(error.localizedDescription))
            return false
        }
        startedPort = port
        child = started
        started.onExit = { [weak self] _ in
            guard let self, self.child === started else { return }
            self.child = nil
            if self.state == .running { self.state = .stopped }
        }
        let until = Date().addingTimeInterval(120)
        while Date() < until {
            if started.status != nil { break }
            if await probe() == .papertown {
                state = .running
                await followStore()
                return true
            }
            try? await Task.sleep(for: .milliseconds(300))
        }
        await started.stop()
        child = nil
        state = .failed(.didNotStart)
        return false
    }

    /// Stops the server this app started; one started elsewhere is left alone.
    public func stop() async {
        guard let running = child else { return }
        await running.stop()
        child = nil
        state = .stopped
    }

    public func restart() async {
        guard ownsServer else { return }
        await stop()
        await start()
    }

    public var needsQuitTime: Bool { stopOnQuit && ownsServer }

    public func quit() async {
        if stopOnQuit { await stop() }
    }

    public func showLog() {
        NSWorkspace.shared.open(Logs.server)
    }

    // MARK: probing

    enum Found { case papertown, other, nothing }

    private static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 2
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: c)
    }()

    func probe() async -> Found {
        guard let url = URL(string: "\(address)/api/health"),
              let (data, response) = try? await Self.session.data(from: url),
              let http = response as? HTTPURLResponse else { return .nothing }
        let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        let app = body?["app"] as? String
        return http.statusCode == 200 && body?["ok"] as? Bool == true && (app == nil || app == "papertown") ? .papertown : .other
    }
}

// MARK: - The checkout's config

/// The server's port as `papertown serve` finds it in a checkout (server/papertown/config.py): PAPERTOWN_PORT, else
/// [server] port in papertown.toml at the root (or the file PAPERTOWN_CONFIG names), else the default that
/// papertown.example.toml lists as `# port = …`, else `fallbackPort`.
enum CheckoutConfig {
    /// The last resort, for a checkout without papertown.example.toml: DEFAULT_PORT in config.py.
    static let fallbackPort = 31640

    static func port(repo: URL, env: [String: String]) -> Int {
        if let raw = env["PAPERTOWN_PORT"], let port = int(raw) { return port }
        if let port = value(in: file(repo: repo, env: env), section: "server", key: "port").flatMap(int) { return port }
        let example = repo.appendingPathComponent("papertown.example.toml")
        return value(in: example, section: "server", key: "port", commented: true).flatMap(int) ?? fallbackPort
    }

    /// papertown.toml: PAPERTOWN_CONFIG, else at the root of the checkout. A relative PAPERTOWN_CONFIG is taken from
    /// the server folder, where the server runs.
    static func file(repo: URL, env: [String: String]) -> URL {
        let raw = (env["PAPERTOWN_CONFIG"] ?? "").trimmingCharacters(in: .whitespaces)
        guard !raw.isEmpty else { return repo.appendingPathComponent("papertown.toml") }
        let path = (raw as NSString).expandingTildeInPath
        return path.hasPrefix("/") ? URL(fileURLWithPath: path) : repo.appendingPathComponent("server").appendingPathComponent(path)
    }

    /// The value of `key = value` in `[section]` of a TOML file, its quotes and trailing comment removed. `commented`
    /// reads the `# key = value` lines instead, as papertown.example.toml lists the defaults.
    static func value(in file: URL, section: String, key: String, commented: Bool = false) -> String? {
        guard let text = try? String(contentsOf: file, encoding: .utf8) else { return nil }
        var inSection = false
        for raw in text.split(whereSeparator: \.isNewline) {
            var line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("[") {
                inSection = line.dropFirst().prefix { $0 != "]" }.trimmingCharacters(in: .whitespaces) == section
                continue
            }
            guard inSection else { continue }
            if commented {
                guard line.hasPrefix("#") else { continue }
                line = String(line.drop { $0 == "#" }).trimmingCharacters(in: .whitespaces)
            }
            guard let eq = line.firstIndex(of: "="), line[..<eq].trimmingCharacters(in: .whitespaces) == key else { continue }
            let rest = line[line.index(after: eq)...]
            let value = (rest.firstIndex(of: "#").map { rest[..<$0] } ?? rest).trimmingCharacters(in: .whitespaces)
            return value.trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
        }
        return nil
    }

    private static func int(_ raw: String) -> Int? {
        Int(raw.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "_", with: ""))
    }
}

// MARK: - Processes

/// The login shell's environment, read once: an app opened from Finder lacks the terminal's PATH (uv, node and so on).
enum LoginEnv {
    private static var cached: [String: String]?

    /// The environment once read, nil before.
    static var current: [String: String]? { cached }

    static func get() async -> [String: String] {
        if let env = cached { return env }
        let env = await Task.detached { capture() }.value
        cached = env
        return env
    }

    private static func capture() -> [String: String] {
        let mark = "__PAPERTOWN_ENV__"
        let shell = String(cString: getpwuid(getuid()).pointee.pw_shell)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: shell.isEmpty ? "/bin/zsh" : shell)
        // -i as well as -l: zsh reads ~/.zshrc, where PATH is set up, only for interactive shells
        p.arguments = ["-lic", "printf '\\0\(mark)\\0'; /usr/bin/env -0"]
        p.standardInput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        let out = Pipe()
        p.standardOutput = out
        var env: [String: String] = [:]
        if (try? p.run()) != nil {
            let killer = DispatchWorkItem { p.terminate() }
            DispatchQueue.global().asyncAfter(deadline: .now() + 20, execute: killer)
            let data = out.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            killer.cancel()
            if let r = data.range(of: Data("\0\(mark)\0".utf8)) {
                for item in data[r.upperBound...].split(separator: 0) {
                    guard let s = String(data: Data(item), encoding: .utf8), let eq = s.firstIndex(of: "=") else { continue }
                    env[String(s[..<eq])] = String(s[s.index(after: eq)...])
                }
            }
        }
        if env["PATH"] == nil {
            env = ProcessInfo.processInfo.environment
            let home = NSHomeDirectory()
            env["PATH"] = ["\(home)/.local/bin", "\(home)/.cargo/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].joined(separator: ":")
        }
        env.removeValue(forKey: "SHLVL")
        env.removeValue(forKey: "_")
        return env
    }
}

/// A command run by /bin/sh in its own process group (so stopping it stops what it started), its output appended
/// to a log file.
final class Child {
    let pid: pid_t
    private(set) var status: Int32?
    private var waiters: [CheckedContinuation<Int32, Never>] = []
    var onExit: ((Int32) -> Void)?

    init(_ command: String, in dir: URL, env: [String: String], log: URL) throws {
        let fd = open(log.path, O_WRONLY | O_CREAT | O_APPEND, 0o644)
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer { close(fd) }

        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_CLOEXEC_DEFAULT))
        posix_spawnattr_setpgroup(&attr, 0)
        var all = sigset_t(), none = sigset_t()
        sigfillset(&all)
        sigemptyset(&none)
        posix_spawnattr_setsigdefault(&attr, &all)
        posix_spawnattr_setsigmask(&attr, &none)

        var files: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&files)
        defer { posix_spawn_file_actions_destroy(&files) }
        posix_spawn_file_actions_addopen(&files, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_adddup2(&files, fd, 1)
        posix_spawn_file_actions_adddup2(&files, fd, 2)
        if #available(macOS 26, *) {
            posix_spawn_file_actions_addchdir(&files, dir.path)
        } else {
            posix_spawn_file_actions_addchdir_np(&files, dir.path)
        }

        let argv = ["/bin/sh", "-c", command].map { strdup($0) } + [nil]
        let envp = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer { (argv + envp).forEach { free($0) } }
        var pid: pid_t = 0
        let err = posix_spawn(&pid, "/bin/sh", &files, &attr, argv, envp)
        guard err == 0 else { throw POSIXError(POSIXErrorCode(rawValue: err) ?? .EIO) }
        self.pid = pid

        Thread.detachNewThread { [self] in
            var st: Int32 = 0
            while waitpid(pid, &st, 0) < 0 && errno == EINTR {}
            DispatchQueue.main.async { self.exited(st) }
        }
    }

    private func exited(_ status: Int32) {
        self.status = status
        onExit?(status)
        waiters.forEach { $0.resume(returning: status) }
        waiters = []
    }

    @MainActor func wait() async -> Int32 {
        if let status { return status }
        return await withCheckedContinuation { waiters.append($0) }
    }

    @MainActor func stop(grace: Double = 5) async {
        guard status == nil else { return }
        killpg(pid, SIGTERM)
        let pid = pid
        let force = Task { try await Task.sleep(for: .seconds(grace)); killpg(pid, SIGKILL) }
        _ = await wait()
        force.cancel()
    }
}

enum Logs {
    static let dir: URL = {
        let d = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Papertown")
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()
    static let server = dir.appendingPathComponent("server.log")

    /// Appends a heading for a run, emptying the log first when it has grown too big.
    static func begin(_ log: URL, _ what: String) {
        let size = (try? FileManager.default.attributesOfItem(atPath: log.path)[.size] as? Int) ?? 0
        if size > 5_000_000 { try? Data().write(to: log) }
        let line = "\n=== \(Date().formatted(date: .numeric, time: .standard)) · \(what)\n"
        if let h = try? FileHandle(forWritingTo: log) {
            h.seekToEndOfFile()
            h.write(Data(line.utf8))
            try? h.close()
        } else {
            try? Data(line.utf8).write(to: log)
        }
    }
}
#endif
