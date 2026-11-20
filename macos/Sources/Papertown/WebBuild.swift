import CoreServices
import Foundation

// Rebuilds web/dist when the web code is newer. Each build goes into web/dist.next and is swapped in
// whole, so the server never serves a half-written page.
@MainActor
final class WebBuild {
    enum Step { case installing, building }

    let repo: URL
    var web: URL { repo.appendingPathComponent("web") }
    var dist: URL { web.appendingPathComponent("dist") }
    private(set) var running = false
    private var child: Child?

    init(repo: URL) { self.repo = repo }

    private var sources: [URL] {
        ["web/src", "web/public", "web/index.html", "web/package.json", "web/pnpm-lock.yaml", "web/vite.config.ts", "web/tsconfig.json", "design/src"]
            .map { repo.appendingPathComponent($0) }
    }

    func isSource(_ path: String) -> Bool {
        sources.contains { Self.within($0, path) }
    }

    static func within(_ root: URL, _ path: String) -> Bool {
        path == root.path || path.hasPrefix(root.path + "/")
    }

    static func modified(_ url: URL) -> Date? {
        (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date
    }

    var built: Date? { Self.modified(dist.appendingPathComponent("index.html")) }

    // a source changed after the last build (folders count too, so deleting a file does)
    var stale: Bool {
        guard let built else { return true }
        for root in sources {
            if (Self.modified(root) ?? .distantPast) > built { return true }
            guard let items = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.contentModificationDateKey]) else { continue }
            for case let url as URL in items {
                if let d = try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate, d > built { return true }
            }
        }
        return false
    }

    private var needsInstall: Bool {
        guard let installed = Self.modified(web.appendingPathComponent("node_modules/.modules.yaml")) else { return true }
        return (Self.modified(web.appendingPathComponent("pnpm-lock.yaml")) ?? .distantPast) > installed
    }

    func run(_ step: (Step) -> Void) async -> Bool {
        running = true
        defer { running = false; child = nil }
        let env = await LoginEnv.get()
        Logs.begin(Logs.build, "build \(web.path)", fresh: true)
        if needsInstall {
            step(.installing)
            guard await sh("pnpm install --frozen-lockfile", env) else { return false }
        }
        step(.building)
        let fm = FileManager.default
        let next = web.appendingPathComponent("dist.next"), prev = web.appendingPathComponent("dist.prev")
        // vite alone: the page doesn't wait on the type check, which `pnpm build` still runs
        guard await sh("pnpm exec vite build --outDir dist.next --emptyOutDir", env),
              fm.fileExists(atPath: next.appendingPathComponent("index.html").path) else { return false }
        var movedPrevious = false
        do {
            if fm.fileExists(atPath: prev.path) { try fm.removeItem(at: prev) }
            if fm.fileExists(atPath: dist.path) {
                try fm.moveItem(at: dist, to: prev)
                movedPrevious = true
            }
            try fm.moveItem(at: next, to: dist)
        } catch {
            if movedPrevious {
                do { try fm.moveItem(at: prev, to: dist) }
                catch { Logs.begin(Logs.build, "couldn't restore the previous build: \(error.localizedDescription)") }
            }
            Logs.begin(Logs.build, "couldn't put the new build in place: \(error.localizedDescription)")
            return false
        }
        try? fm.removeItem(at: prev)
        return true
    }

    private func sh(_ command: String, _ env: [String: String]) async -> Bool {
        Logs.begin(Logs.build, command)
        guard let c = try? Child(command, in: web, env: env, log: Logs.build) else { return false }
        child = c
        return await c.wait() == 0
    }

    func cancel() async {
        await child?.stop(grace: 2)
    }
}

// FSEvents over a few folders, everything under them included
final class Watcher {
    private var stream: FSEventStreamRef?
    private let handler: ([String]) -> Void

    init(_ folders: [URL], handler: @escaping ([String]) -> Void) {
        self.handler = handler
        var context = FSEventStreamContext(version: 0, info: Unmanaged.passUnretained(self).toOpaque(), retain: nil, release: nil, copyDescription: nil)
        let callback: FSEventStreamCallback = { _, info, _, paths, _, _ in
            let me = Unmanaged<Watcher>.fromOpaque(info!).takeUnretainedValue()
            me.handler(Unmanaged<CFArray>.fromOpaque(paths).takeUnretainedValue() as! [String])
        }
        let flags = FSEventStreamCreateFlags(kFSEventStreamCreateFlagUseCFTypes | kFSEventStreamCreateFlagFileEvents)
        guard let s = FSEventStreamCreate(nil, callback, &context, folders.map(\.path) as CFArray,
                                          FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 0.3, flags) else { return }
        FSEventStreamSetDispatchQueue(s, .main)
        FSEventStreamStart(s)
        stream = s
    }

    deinit {
        guard let stream else { return }
        FSEventStreamStop(stream)
        FSEventStreamInvalidate(stream)
        FSEventStreamRelease(stream)
    }
}
