import Foundation

public enum ClientError: Error, Equatable {
    case invalidAddress, invalidRoute, invalidResponse
    case http(status: Int, detail: String?)
}

public enum HTTPMethod: String { case get = "GET", post = "POST", put = "PUT", patch = "PATCH", delete = "DELETE" }

// Keep requests, credentials and streamed data on the configured server.
private final class RedirectPolicy: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

public final class PapertownClient: Sendable {
    public let address: URL
    /// An access key made on the server (`papertown key create`, or Settings › Access in the web app), sent with every
    /// request as `Authorization: Bearer`. Without one the client signs in with the access password (a cookie).
    public let accessKey: String?
    let session: URLSession

    public convenience init(address: URL, accessKey: String? = nil) throws {
        try self.init(address: address, configuration: .ephemeral, accessKey: accessKey)
    }

    /// A client whose requests go through the given URL protocols first, as the offline demo's do.
    public convenience init(address: URL, protocolClasses: [AnyClass], accessKey: String? = nil) throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = protocolClasses + (configuration.protocolClasses ?? [])
        try self.init(address: address, configuration: configuration, accessKey: accessKey)
    }

    init(address: URL, configuration: URLSessionConfiguration, accessKey: String? = nil) throws {
        guard ["http", "https"].contains(address.scheme?.lowercased()), let host = address.host,
              !host.isEmpty, address.user == nil, address.password == nil,
              address.query == nil, address.fragment == nil else { throw ClientError.invalidAddress }
        self.address = address
        let key = accessKey?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.accessKey = key?.isEmpty == false ? key : nil
        configuration.urlCache = nil
        session = URLSession(configuration: configuration, delegate: RedirectPolicy(), delegateQueue: nil)
    }

    deinit { session.invalidateAndCancel() }

    func request(_ method: HTTPMethod, path: [String], query: [URLQueryItem] = []) throws -> URLRequest {
        guard !path.isEmpty, path.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." &&
            !$0.contains("/") && !$0.contains("\\") }) else { throw ClientError.invalidRoute }
        let url = path.reduce(address.appendingPathComponent("api")) { $0.appendingPathComponent($1) }
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { throw ClientError.invalidRoute }
        components.queryItems = query.isEmpty ? nil : query
        guard let target = components.url else { throw ClientError.invalidRoute }
        var request = URLRequest(url: target)
        request.httpMethod = method.rawValue
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let accessKey { request.setValue("Bearer \(accessKey)", forHTTPHeaderField: "Authorization") }
        return request
    }

    static func validate(_ response: URLResponse, data: Data = Data()) throws {
        guard let http = response as? HTTPURLResponse else { throw ClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            struct Failure: Decodable { let detail: JSONValue? }
            let detail = try? JSONDecoder().decode(Failure.self, from: data).detail
            let message: String?
            switch detail {
            case .string(let value): message = value
            case .some: message = String(data: data, encoding: .utf8)
            case nil: message = nil
            }
            throw ClientError.http(status: http.statusCode, detail: message)
        }
    }

    /// Whether a Papertown server answers at the address, before signing in.
    public func health() async throws -> ServerHealth {
        try JSONDecoder().decode(ServerHealth.self, from: try await data(path: ["health"]))
    }

    public func data(_ method: HTTPMethod = .get, path: [String], query: [URLQueryItem] = [],
                     body: Data? = nil, contentType: String? = nil) async throws -> Data {
        var request = try request(method, path: path, query: query)
        request.httpBody = body
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        let (data, response) = try await session.data(for: request)
        try Self.validate(response, data: data)
        return data
    }

    public func get<T: Decodable>(_ path: [String], query: [URLQueryItem] = []) async throws -> T {
        try JSONDecoder().decode(T.self, from: await data(path: path, query: query))
    }

    public func post<Body: Encodable, Reply: Decodable>(_ path: [String], body: Body) async throws -> Reply {
        try await send(.post, path, body: body)
    }

    /// Any method with a JSON body; an empty reply body decodes as `{}`.
    public func send<Body: Encodable, Reply: Decodable>(_ method: HTTPMethod, _ path: [String], query: [URLQueryItem] = [],
                                                        body: Body) async throws -> Reply {
        let bytes = try await data(method, path: path, query: query, body: JSONEncoder().encode(body), contentType: "application/json")
        return try JSONDecoder().decode(Reply.self, from: bytes.isEmpty ? Data("{}".utf8) : bytes)
    }
}
