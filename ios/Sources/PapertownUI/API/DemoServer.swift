import Foundation

/// The offline demo: a read-only Papertown with the five sample projects, answered from Resources/Demo (exported by
/// scripts/make-demo.py). It runs as a URL protocol under the ordinary client, so every page reads it the way it reads a
/// real server. Library searches are answered from the bundled shelf; anything that would change the town is refused.
public final class DemoServer: URLProtocol {
    public static let address = URL(string: "https://demo.papertown.invalid")!

    private static let routes: [String: String] = {
        guard let data = file("routes.json"), let map = try? JSONDecoder().decode([String: String].self, from: data) else { return [:] }
        var routes = map
        for (key, file) in map where key.contains("%") {
            if let decoded = key.removingPercentEncoding { routes[decoded] = file }
        }
        return routes
    }()

    private static func file(_ name: String) -> Data? {
        let base = (name as NSString).deletingPathExtension, ext = (name as NSString).pathExtension
        let url = Bundle.module.url(forResource: base, withExtension: ext, subdirectory: "Demo")
            ?? Bundle.module.url(forResource: base, withExtension: ext)
        return url.flatMap { try? Data(contentsOf: $0) }
    }

    override public class func canInit(with request: URLRequest) -> Bool { request.url?.host == address.host }
    override public class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override public func startLoading() {
        guard let url = request.url, let comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return answer(400, json: #"{"detail":"bad request"}"#)
        }
        let path = comps.path
        if path == "/api/events" { return openStream() }
        guard (request.httpMethod ?? "GET") == "GET" else {
            return answer(403, json: #"{"detail":"这是只读的离线演示，操作不会生效。连接你自己的 Papertown 服务器后即可使用。"}"#)
        }
        if path == "/api/rag/search" { return answer(200, data: search(comps)) }
        let query = comps.queryItems ?? []
        if path.hasSuffix("/prov/ops"), let page = operationPage(path, query) {
            return answer(200, data: page)
        }
        // the exported answers are keyed by path and the query the app sends; "after" and cache-busting values do not matter
        let keep = query.filter { !["v", "tail"].contains($0.name) }
        var keys = [path + (keep.isEmpty ? "" : "?" + keep.map { "\($0.name)=\($0.value ?? "")" }.joined(separator: "&"))]
        if path.hasPrefix("/api/agents/") { keys.append(path + "?after=0") }
        if path == "/api/library" { keys.append("/api/library?q=&topic=&limit=400") }
        if path.hasSuffix("/file"), let p = query.first(where: { $0.name == "path" })?.value {
            keys.append(path + "?path=" + (p.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? p))
        }
        for key in keys {
            if let name = Self.routes[key], let data = Self.file(name) {
                if path.hasSuffix("/conversations") || path == "/api/paseo",
                   let error = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let code = error["_http_error"] as? Int, let body = error["body"],
                   let message = try? JSONSerialization.data(withJSONObject: body) {
                    return answer(code, data: message)
                }
                if path.hasSuffix("/view"), let page = try? JSONDecoder().decode([String: String].self, from: data), let html = page["html"] {
                    return answer(200, data: Data(html.utf8), headers: ["Content-Type": "text/html", "Content-Security-Policy": page["policy"] ?? "default-src 'none'"])
                }
                return answer(200, data: data)
            }
        }
        answer(404, json: #"{"detail":"离线演示里没有这一项"}"#)
    }

    override public func stopLoading() {}

    private func answer(_ status: Int, json: String) { answer(status, data: Data(json.utf8)) }

    private func answer(_ status: Int, data: Data, headers: [String: String] = ["Content-Type": "application/json"]) {
        guard let url = request.url,
              let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                                             headerFields: headers) else { return }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    /// The live feed: opened and kept open, with nothing on it, so the app shows itself connected.
    private func openStream() {
        guard let url = request.url,
              let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                             headerFields: ["Content-Type": "text/event-stream"]) else { return }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("retry: 3000\n\n".utf8))
    }

    /// Apply the live server's root, cursor and limit to its recorded operation summaries.
    private func operationPage(_ path: String, _ query: [URLQueryItem]) -> Data? {
        guard Self.routes[path] != nil else { return nil }
        let files = Set(Self.routes.compactMap { key, name in
            key == path || key.hasPrefix(path + "?") ? name : nil
        })
        let rows = files.flatMap { name -> [[String: Any]] in
            guard let data = Self.file(name), let page = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
            return page
        }.sorted { ($0["ts"] as? String ?? "") > ($1["ts"] as? String ?? "") }
        func item(_ key: String) -> String? { query.first { $0.name == key }?.value }
        let before = item("before").map { id in rows.first { $0["id"] as? String == id }?["ts"] as? String ?? id }
        let root = item("root"), limit = min(200, max(1, item("limit").flatMap(Int.init) ?? 50))
        let page = rows.filter { row in
            (root == nil || row["root"] as? String == root) && (before.map { (row["ts"] as? String ?? "") < $0 } ?? true)
        }
        return try? JSONSerialization.data(withJSONObject: Array(page.prefix(limit)))
    }

    /// Scores the bundled shelf by how many query words a paper's title and abstract contain.
    private func search(_ comps: URLComponents) -> Data {
        let q = comps.queryItems?.first(where: { $0.name == "q" })?.value ?? ""
        let terms = q.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init).filter { $0.count > 1 }
        var hits: [[String: Any]] = []
        if let data = Self.file("library.json"),
           let shelf = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let papers = shelf["papers"] as? [[String: Any]], !terms.isEmpty {
            for p in papers {
                let hay = "\(p["title"] ?? "") \(p["snippet"] ?? "")".lowercased()
                let matched = terms.filter { hay.contains($0) }
                guard !matched.isEmpty else { continue }
                var hit = p
                hit["similarity"] = (Double(matched.count) / Double(terms.count) * 100).rounded() / 100
                hit["matched"] = matched
                hits.append(hit)
            }
            hits.sort { ($0["similarity"] as? Double ?? 0) > ($1["similarity"] as? Double ?? 0) }
        }
        let body: [String: Any] = ["query": q, "expanded": q, "terms": terms, "method": "coverage", "hits": Array(hits.prefix(8))]
        return (try? JSONSerialization.data(withJSONObject: body)) ?? Data("{}".utf8)
    }
}

extension ServerProfile {
    public static func demo(name: String) -> ServerProfile {
        ServerProfile(name: name, addressString: DemoServer.address.absoluteString)
    }

    public var isDemo: Bool { url?.host == DemoServer.address.host }
}
