import XCTest
@testable import Papertown

final class WebBuildTests: XCTestCase {
    @MainActor
    func testLinkedWebSourcesTriggerWatchAndStartupBuild() throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString).resolvingSymlinksInPath()
        defer { try? fm.removeItem(at: root) }
        let repo = root.appendingPathComponent("town")
        let linked = repo.appendingPathComponent("teletty/web")
        try fm.createDirectory(at: linked.appendingPathComponent("src"), withIntermediateDirectories: true)
        let build = WebBuild(repo: repo)
        try fm.createDirectory(at: build.dist, withIntermediateDirectories: true)
        let index = build.dist.appendingPathComponent("index.html")
        try Data().write(to: index)
        let inputs = ["src/wall.tsx", "src/styles.css", "package.json"].map { linked.appendingPathComponent($0) }
        for input in inputs { try Data().write(to: input) }
        try fm.setAttributes([.modificationDate: Date(timeIntervalSinceNow: 10)], ofItemAtPath: index.path)
        XCTAssertFalse(build.stale)
        for input in inputs {
            XCTAssertTrue(build.watchFolders.contains { WebBuild.within($0, input.path) })
            XCTAssertTrue(build.isSource(input.path), input.path)
            try fm.setAttributes([.modificationDate: Date(timeIntervalSinceNow: 30)], ofItemAtPath: input.path)
            XCTAssertTrue(build.stale, input.path)
            try fm.setAttributes([.modificationDate: Date()], ofItemAtPath: input.path)
        }
        XCTAssertFalse(build.isSource(linked.appendingPathComponent("node_modules/react/index.js").path))
    }
}
