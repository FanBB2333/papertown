import XCTest
@testable import PapertownUI

/// Lists the demo's server text that stays Chinese in English. Runs only with PT_GAP_OUT set (a file to write to).
final class TranslationGapProbe: XCTestCase {
    func testListUntranslatedDemoText() throws {
        guard let out = ProcessInfo.processInfo.environment["PT_GAP_OUT"] else { throw XCTSkip("probe only") }
        var seen = Set<String>(), left: [String] = []
        func walk(_ v: Any) {
            if let s = v as? String {
                guard ServerText.hasCJK(s), seen.insert(s).inserted else { return }
                if ServerText.hasCJK(ServerText.localized(s, .english)) { left.append(s) }
            } else if let a = v as? [Any] { a.forEach(walk) } else if let d = v as? [String: Any] { d.values.forEach(walk) }
        }
        let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../Sources/PapertownUI/Resources/Demo")
        for f in try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) where f.pathExtension == "json" && f.lastPathComponent != "routes.json" {
            if !["library.json"].contains(f.lastPathComponent) { walk(try JSONSerialization.jsonObject(with: Data(contentsOf: f))) }
        }
        try left.sorted().joined(separator: "\n").write(toFile: out, atomically: true, encoding: .utf8)
        print("untranslated \(left.count) of \(seen.count)")
    }
}
