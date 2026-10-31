import Darwin
import Foundation

// Running the server and the page's build. An app opened from the Finder doesn't get the PATH your
// terminal has (uv, pnpm, nvm's node, TeX), so the environment comes from your login shell, once.
// Every child runs in its own process group, so stopping it stops what it started too.
enum LoginEnv {
    private static var cached: [String: String]?

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
        // interactive as well as login: zsh reads ~/.zshrc only then, and that's where PATH is set up
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
            // the shell didn't answer: the usual places, so uv and pnpm may still be found
            env = ProcessInfo.processInfo.environment
            let home = NSHomeDirectory()
            env["PATH"] = ["\(home)/.local/bin", "\(home)/.cargo/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].joined(separator: ":")
        }
        env.removeValue(forKey: "SHLVL")
        env.removeValue(forKey: "_")
        return env
    }
}

// A command run by /bin/sh in its own process group, its output appended to a log file.
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
        posix_spawn_file_actions_addchdir_np(&files, dir.path)

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

    // the exit status, once it has stopped
    @MainActor func wait() async -> Int32 {
        if let status { return status }
        return await withCheckedContinuation { waiters.append($0) }
    }

    // asks it to stop the way Ctrl-C does, then makes it
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
    static let build = dir.appendingPathComponent("build.log")

    // a heading for this run; the server's log is kept (cut short when it grows big), the build's starts over
    static func begin(_ log: URL, _ what: String, fresh: Bool = false) {
        let size = (try? FileManager.default.attributesOfItem(atPath: log.path)[.size] as? Int) ?? 0
        if fresh || size > 5_000_000 { try? Data().write(to: log) }
        let line = "\n=== \(Date().formatted(date: .numeric, time: .standard)) · \(what)\n"
        if let h = try? FileHandle(forWritingTo: log) {
            h.seekToEndOfFile()
            h.write(Data(line.utf8))
            try? h.close()
        } else {
            try? Data(line.utf8).write(to: log)
        }
    }

    static func tail(_ log: URL, lines: Int = 12) -> String {
        guard let s = try? String(contentsOf: log, encoding: .utf8) else { return "" }
        return s.split(separator: "\n", omittingEmptySubsequences: false).suffix(lines).joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
