import XCTest
@testable import PapertownCore

final class CoreTests: XCTestCase {
    func testRelayPrefixAndQuery() throws {
        let client = try PapertownClient(address: XCTUnwrap(URL(string: "https://example.org/town/")))
        let request = try client.request(.get, path: ["agents", "张 三"], query: [.init(name: "after", value: "42")])
        XCTAssertEqual(request.url?.path, "/town/api/agents/张 三")
        XCTAssertEqual(request.url?.query, "after=42")
        XCTAssertThrowsError(try client.request(.get, path: [".."]))
        XCTAssertThrowsError(try client.request(.get, path: ["http://other.example"]))
    }

    func testRemoteAuthAndErrors() throws {
        let state = try JSONDecoder().decode(AuthState.self, from: Data(#"{"local":false,"signed_in":false,"authed":false,"password":true}"#.utf8))
        XCTAssertFalse(state.signedIn)
        XCTAssertNil(state.sessions)
        let response = try XCTUnwrap(HTTPURLResponse(url: URL(fileURLWithPath: "/"), statusCode: 401, httpVersion: nil, headerFields: nil))
        XCTAssertThrowsError(try PapertownClient.validate(response, data: Data(#"{"detail":"先登录"}"#.utf8))) {
            XCTAssertEqual($0 as? ClientError, .http(status: 401, detail: "先登录"))
        }
    }

    func testNamedEventAndHeartbeat() throws {
        var frame = EventFrame()
        for line in ["retry: 4500", "", ": keepalive", "", "event: agent_delta",
                     #"data: {"text":"中文","#, #"data: "line_id":null}"#] {
            XCTAssertNil(try frame.consume(line))
        }
        XCTAssertEqual(frame.retryMilliseconds, 4500)
        guard case let .event(name, payload) = try frame.consume("") else { return XCTFail("missing event") }
        XCTAssertEqual(name, "agent_delta")
        XCTAssertEqual(payload["text"], .string("中文"))
        XCTAssertEqual(payload["line_id"], .null)
        XCTAssertNil(try frame.consume(""))
    }
}

private final class ChatProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else { return XCTFail("missing URL") }
        XCTAssertEqual(url.path, "/api/agents/lead/say")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        var body = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 256)
            while true {
                let count = stream.read(&buffer, maxLength: buffer.count)
                guard count > 0 else { break }
                body.append(contentsOf: buffer.prefix(count))
            }
        }
        XCTAssertEqual(try? JSONDecoder().decode([String: String].self, from: body),
                       ["text": "查看进展", "mode": "queue"])
        let payload = #"{"id":12,"agent_id":"lead","kind":"user","ts":"now","data":{"queued":true}}"#
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(payload.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

extension CoreTests {
    func testChatRoundTrip() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ChatProtocol.self]
        let client = try PapertownClient(address: XCTUnwrap(URL(string: "https://example.org")), configuration: config)
        let event = try await client.send("查看进展", to: "lead", mode: .queue)
        XCTAssertEqual(event.agentID, "lead")
        XCTAssertEqual(event.data, .object(["queued": .bool(true)]))
    }
}
