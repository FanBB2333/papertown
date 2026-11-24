import XCTest
import PapertownCore
@testable import PapertownUI

/// The bundled demo answers were exported from a real server (scripts/make-demo.py), so decoding each of them is a check
/// that the app's models match what the server sends. The demo server is then read through the ordinary client.
final class ServerAPITests: XCTestCase {
    private func client() throws -> PapertownClient {
        try PapertownClient(address: DemoServer.address, protocolClasses: [DemoServer.self])
    }

    func testEveryProjectPageDecodes() async throws {
        let c = try client()
        let projects = try await c.projectSnapshots()
        XCTAssertEqual(projects.count, 5)
        for p in projects {
            let snap = try await c.projectSnapshot(id: p.id)
            XCTAssertEqual(snap.stages.count, 8)
            XCTAssertNotNil(snap.outputs?.idea, "#\(p.seq) idea")
            _ = try await c.card(projectID: p.id)
            let checks = try await c.checks(projectID: p.id)
            XCTAssertFalse(checks.checks.isEmpty)
            _ = try await c.papers(projectID: p.id)
            _ = try await c.lineData(projectID: p.id)
            _ = try await c.workspace(projectID: p.id)
            _ = try await c.lineUsage(projectID: p.id)
            _ = try await c.jobs(projectID: p.id)
            _ = try await c.reports(projectID: p.id)
            _ = try await c.outline(projectID: p.id)
            let lead = try await c.agentEvents(agentID: "lead-\(p.id)")
            XCTAssertEqual(lead.agent.role, "lead")
        }
        // the shipped project has produced every stage's output
        let done = try await c.projectSnapshot(id: "line_1").outputs
        XCTAssertNotNil(done?.hatch?.verdict)
        XCTAssertFalse(done?.method?.mechanism?.isEmpty ?? true)
        XCTAssertFalse(done?.exp?.rows.isEmpty ?? true)
        XCTAssertNotNil(done?.write?.abstract)
        XCTAssertFalse(done?.review?.reviews?.isEmpty ?? true)
        XCTAssertFalse(done?.ship?.files?.isEmpty ?? true)
    }

    func testTownPagesDecode() async throws {
        let c = try client()
        let auth = try await c.authState()
        XCTAssertTrue(auth.authed)
        let world = try await c.world()
        XCTAssertEqual(world.hud.lines.total, 5)
        let v1 = try await c.cards()
        XCTAssertEqual(v1.cards.count, 5)
        _ = try await c.staffOverview()
        _ = try await c.reports()
        _ = try await c.assistantSnapshot()
        let v2 = try await c.departments()
        XCTAssertFalse(v2.isEmpty)
        let v3 = try await c.usage()
        XCTAssertFalse(v3.providers.isEmpty)
        _ = try await c.gpus()
        _ = try await c.jobs()
        _ = try await c.mcp()
        let v4 = try await c.skills()
        XCTAssertFalse(v4.isEmpty)
        let v5 = try await c.ragView()
        XCTAssertGreaterThan(v5.stats.papers, 0)
        let v6 = try await c.library()
        XCTAssertFalse(v6.papers.isEmpty)
    }

    func testDemoSearchesTheShelfAndRefusesChanges() async throws {
        let c = try client()
        let hits = try await c.ragSearch("sparse attention")
        XCTAssertFalse(hits.hits.isEmpty)
        XCTAssertEqual(hits.hits.first?.matched?.sorted(), ["attention", "sparse"])
        do {
            try await c.setLead(projectID: "line_4", on: true)
            XCTFail("the demo accepted a change")
        } catch ClientError.http(let status, let detail) {
            XCTAssertEqual(status, 403)
            XCTAssertNotNil(detail)
        }
    }

    func testFilesAreServedByPath() async throws {
        let c = try client()
        let tree = try await c.workspaceTree(projectID: "line_1", root: "paper")
        let main = try XCTUnwrap(tree.files.first { $0.path == "main.tex" })
        let file = try await c.workspaceFile(projectID: "line_1", root: "paper", path: main.path)
        XCTAssertTrue(file.text?.contains("\\documentclass") ?? false)
    }

    func testServerTextBecomesEnglish() {
        XCTAssertEqual(ServerText.localized("项目负责人", .english), "Project lead")
        XCTAssertEqual(ServerText.localized("项目负责人", .simplifiedChinese), "项目负责人")
        // a template with its value filled in
        XCTAssertEqual(ServerText.localized("3 个项目进行中", .english), "3 projects in progress")
        // a title the server cut short is found by its beginning
        XCTAssertTrue(ServerText.localized("多智能体通过 model context pr…", .english).hasPrefix("Multiple agents sharing tools"))
        // sentences the dictionary does not know stay exactly as written
        let unknown = "查重结论是「已被做过」，最接近的工作相似度 0.85。照原 idea 立项，还是先调整 idea？"
        XCTAssertEqual(ServerText.localized(unknown, .english), unknown)
        // text with nothing Chinese in it is left alone
        XCTAssertEqual(ServerText.localized("Vela: Scaling VLA", .english), "Vela: Scaling VLA")
    }

    func testServersSavedBeforeAccessKeysStillLoad() throws {
        let saved = #"[{"id":"6F9619FF-8B86-D011-B42D-00C04FC964FF","name":"Lab","addressString":"http://10.0.0.2:8000","useBiometrics":true}]"#
        let profiles = try JSONDecoder().decode([ServerProfile].self, from: Data(saved.utf8))
        XCTAssertEqual(profiles.first?.name, "Lab")
        XCTAssertEqual(profiles.first?.usesAccessKey, false)
        let again = try JSONDecoder().decode([ServerProfile].self, from: try JSONEncoder().encode([ServerProfile(name: "Pi", addressString: "https://pt.example.com", usesAccessKey: true)]))
        XCTAssertEqual(again.first?.usesAccessKey, true)
    }

    func testPiEventsFoldIntoChatRows() throws {
        let json = """
        [{"id":1,"agent_id":"a","ts":"t","kind":"user","data":{"text":"hi"}},
         {"id":2,"agent_id":"a","ts":"t","kind":"tool","data":{"id":"x","name":"Bash","args":{"command":"ls"}}},
         {"id":3,"agent_id":"a","ts":"t","kind":"tool_end","data":{"id":"x","name":"Bash","error":null}},
         {"id":4,"agent_id":"a","ts":"t","kind":"assistant","data":{"text":"done"}},
         {"id":5,"agent_id":"a","ts":"t","kind":"user","data":{"text":"later","queued":true,"delivered":false}},
         {"id":6,"agent_id":"a","ts":"t","kind":"act","data":{"action":"lead.switch","title":"Turn on #4","status":"pending"}}]
        """
        let events = try JSONDecoder().decode([AgentEvent].self, from: Data(json.utf8))
        var state = ConversationState()
        state.merge(events)
        XCTAssertEqual(state.entries.map(\.kind), [.user, .tool, .assistant, .act])
        XCTAssertEqual(state.entries[1].arg, "ls")
        XCTAssertEqual(state.entries[1].status, "completed")
        XCTAssertTrue(state.entries[3].open)
        XCTAssertEqual(state.queued.map(\.text), ["later"])
    }
}
