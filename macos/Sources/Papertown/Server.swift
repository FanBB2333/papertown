import Foundation

// The Papertown server the page talks to: the one already running on the port (started from a
// terminal, say), or one the app starts and, when it quits, stops.
@MainActor
final class Server {
    enum Found { case papertown, other, nothing }

    let port: Int
    private(set) var child: Child?
    var onExit: (() -> Void)?
    private var stopping = false

    init(port: Int) { self.port = port }

    var base: URL { URL(string: "http://127.0.0.1:\(port)/")! }
    var owned: Bool { child != nil && child?.status == nil }

    private static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 2
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: c)
    }()

    static func get(_ url: URL) async throws -> (Data, HTTPURLResponse) {
        let (data, res) = try await session.data(from: url)
        return (data, res as! HTTPURLResponse)
    }

    func probe() async -> Found {
        guard let (data, res) = try? await Self.get(base.appendingPathComponent("api/health")) else { return .nothing }
        let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        return res.statusCode == 200 && body?["ok"] as? Bool == true && body?["provider"] != nil ? .papertown : .other
    }

    // the page itself: missing when the server started before web/dist existed
    func servesPage() async -> Bool {
        (try? await Self.get(base))?.1.statusCode == 200
    }

    func start(_ command: String, repo: URL) async throws {
        var env = await LoginEnv.get()
        env["PAPERTOWN_PORT"] = String(port)
        Logs.begin(Logs.server, command)
        let child = try Child(command, in: repo.appendingPathComponent("server"), env: env, log: Logs.server)
        child.onExit = { [weak self] _ in
            guard let self, self.child === child else { return }
            if !self.stopping { self.onExit?() }
        }
        self.child = child
        stopping = false
    }

    // up and answering, or why not
    func ready(within seconds: Double = 120) async -> Bool {
        let until = Date().addingTimeInterval(seconds)
        while Date() < until {
            if let child, child.status != nil { return false }
            if await probe() == .papertown { return true }
            try? await Task.sleep(for: .milliseconds(300))
        }
        return false
    }

    func stop() async {
        guard let child, child.status == nil else { return }
        stopping = true
        await child.stop()
    }
}
