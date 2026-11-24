import XCTest
@testable import PapertownCore

/// Answers every request with a health reply and keeps the requests, to read their headers.
final class HeaderSpy: URLProtocol {
    static var seen: [URLRequest] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.seen.append(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"ok":true,"app":"papertown","version":"0.1.0"}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class AccessKeyTests: XCTestCase {
    func testEveryRequestCarriesTheAccessKey() async throws {
        HeaderSpy.seen = []
        let address = URL(string: "http://192.168.1.5:8000")!
        let keyed = try PapertownClient(address: address, protocolClasses: [HeaderSpy.self], accessKey: " ptk_abc\n")
        let health = try await keyed.health()
        XCTAssertEqual(health.app, "papertown")
        XCTAssertEqual(HeaderSpy.seen.last?.url?.path, "/api/health")
        XCTAssertEqual(HeaderSpy.seen.last?.value(forHTTPHeaderField: "Authorization"), "Bearer ptk_abc")
        // the event stream is built the same way
        XCTAssertEqual(try keyed.request(.get, path: ["events"]).value(forHTTPHeaderField: "Authorization"), "Bearer ptk_abc")

        let plain = try PapertownClient(address: address, protocolClasses: [HeaderSpy.self], accessKey: "  ")
        _ = try await plain.health()
        XCTAssertNil(plain.accessKey)
        XCTAssertNil(HeaderSpy.seen.last?.value(forHTTPHeaderField: "Authorization"))
    }

    func testHealthFromServersBeforeAccessKeysDecodes() throws {
        let old = try JSONDecoder().decode(ServerHealth.self, from: Data(#"{"ok":true,"ports":{"arxiv":{"ok":true}}}"#.utf8))
        XCTAssertTrue(old.ok)
        XCTAssertNil(old.app)
        let state = try JSONDecoder().decode(AuthState.self, from: Data(#"{"local":false,"password":true,"authed":true,"signed_in":false,"key":true,"via":"key","keys":2}"#.utf8))
        XCTAssertEqual(state.key, true)
        XCTAssertTrue(state.authed)
    }
}
