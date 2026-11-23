import Foundation

public enum FeedUpdate: Sendable {
    /// Fetch a fresh snapshot here. The server streams live changes without replay.
    case connected
    case reconnecting
    case event(name: String, payload: [String: JSONValue])
}

struct EventFrame {
    var retryMilliseconds = 3000
    private var name = ""
    private var lines: [String] = []

    mutating func consume(_ line: String) throws -> FeedUpdate? {
        if line.isEmpty {
            defer { name = ""; lines.removeAll(keepingCapacity: true) }
            guard !lines.isEmpty else { return nil }
            let data = Data(lines.joined(separator: "\n").utf8)
            return .event(name: name.isEmpty ? "message" : name,
                          payload: try JSONDecoder().decode([String: JSONValue].self, from: data))
        }
        let parts = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        var value = parts.count == 2 ? String(parts[1]) : ""
        if value.first == " " { value.removeFirst() }
        switch parts[0] {
        case "event": name = value
        case "data": lines.append(value)
        case "retry":
            if let ms = Int(value), ms >= 0 { retryMilliseconds = min(60_000, max(250, ms)) }
        default: break // Includes the server's keepalive comments.
        }
        return nil
    }
}

extension PapertownClient {
    /// Own this call from a cancellable Task for the active server/foreground session.
    public func followEvents(_ receive: @Sendable (FeedUpdate) async -> Void) async throws {
        var request = try request(.get, path: ["events"])
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        var delay = 3000
        while !Task.isCancelled {
            do {
                let (bytes, response) = try await session.bytes(for: request)
                defer { bytes.task.cancel() }
                try Self.validate(response)
                guard response.mimeType == "text/event-stream" else { throw ClientError.invalidResponse }
                await receive(.connected)
                var frame = EventFrame()
                frame.retryMilliseconds = delay
                var line = Data()
                for try await byte in bytes {
                    try Task.checkCancellation()
                    if byte == 10 {
                        if line.last == 13 { line.removeLast() }
                        if let update = try frame.consume(String(decoding: line, as: UTF8.self)) {
                            await receive(update)
                        }
                        delay = frame.retryMilliseconds
                        line.removeAll(keepingCapacity: true)
                    } else {
                        line.append(byte)
                    }
                }
            } catch let error as URLError {
                try Task.checkCancellation()
                switch error.code {
                case .timedOut, .cannotFindHost, .cannotConnectToHost, .networkConnectionLost,
                     .dnsLookupFailed, .notConnectedToInternet: break
                default: throw error
                }
            } catch ClientError.http(let status, _) where [502, 503, 504].contains(status) {
                // A relay may be up while the host is reconnecting.
            }
            try Task.checkCancellation()
            await receive(.reconnecting)
            try await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000)
        }
        throw CancellationError()
    }
}
