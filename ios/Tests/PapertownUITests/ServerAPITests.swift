import XCTest
import PapertownCore
@testable import PapertownUI

/// Read the bundled sample answers through the ordinary client, including the decision and provenance examples.
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
            let loop = try await c.loop(projectID: p.id)
            XCTAssertFalse(loop.nodes.filter { $0.kind == "gate" }.compactMap(\.gate).isEmpty, "#\(p.seq) gates")
            let memory = try await c.memory(projectID: p.id)
            for item in memory.items {
                let detail = try await c.memoryItem(projectID: p.id, id: item.id)
                XCTAssertEqual(detail.title, item.title)
                XCTAssertEqual(detail.source, item.source)
            }
            let pages = try await c.pages(projectID: p.id)
            for page in pages.pages {
                for look in [nil, "light", "dark"] as [String?] {
                    let document = try await c.page(projectID: p.id, id: page.id, look: look)
                    XCTAssertTrue(document.html.contains("<body"))
                    XCTAssertTrue(document.policy?.contains("default-src") == true)
                }
            }
            let list = try await c.decided(projectID: p.id)
            XCTAssertEqual(list.mods?.compactMap(\.id), DecidedModule.order)
            XCTAssertEqual(list.stats?.total, list.decisions?.count)
            for record in try XCTUnwrap(list.decisions) {
                let d = try await c.decidedRecord(projectID: p.id, id: XCTUnwrap(record.id))
                XCTAssertEqual(d.text, record.text)
                XCTAssertNotNil(d.work)
            }
            let tree = try await c.prov(projectID: p.id)
            let ops = try await c.provOps(projectID: p.id, limit: 50)
            for op in ops {
                let detail = try await c.provOp(projectID: p.id, id: XCTUnwrap(op.id))
                XCTAssertEqual(detail.files?.count, op.fileCount)
            }
            for (id, node) in tree.nodes ?? [:] {
                let detail = try await c.provNode(projectID: p.id, id: id)
                XCTAssertEqual(detail.tag, node.tag)
                for source in node.src ?? [] { XCTAssertNotNil(tree.nodes?[source]) }
            }
            for file in tree.files ?? [] {
                let lines = try await c.provBlame(projectID: p.id, root: "paper", path: XCTUnwrap(file.path))
                XCTAssertNotNil(lines.first?.start)
            }
            _ = try await c.bounds(projectID: p.id)
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

    func testDecisionsConnectReportsCardsWorkAndChat() async throws {
        let c = try client(), id = "line_2"
        let list = try await c.decided(projectID: id)
        let card = try await c.card(projectID: id)
        let matter = try XCTUnwrap(list.matters?.first)
        let ask = try XCTUnwrap(card.decisions?.first { $0.kind == "matter" })
        XCTAssertEqual(matter.id, Int(ask.id))
        XCTAssertEqual(ask.optionsText, matter.options)
        XCTAssertEqual(ask.materials, matter.materials)
        XCTAssertFalse(try XCTUnwrap(ask.facts).isEmpty)
        XCTAssertTrue(ask.writtenAnswer && ask.options.isEmpty)
        XCTAssertTrue(try XCTUnwrap(card.decisions?.first { $0.kind == "need" }).writtenAnswer)
        XCTAssertFalse(try XCTUnwrap(card.decisions?.first { $0.kind == "ask" }).writtenAnswer)
        let reports = try await c.reports(projectID: id)
        let report = try XCTUnwrap(reports.asks.first { String($0.id) == ask.id })
        XCTAssertEqual(report.pendingDecision.optionsText, matter.options)
        XCTAssertEqual(card.decided?.total, list.stats?.total)
        XCTAssertEqual(card.decided?.latest?.count, Set((list.decisions ?? []).filter(\.isActive).compactMap(\.mod)).count)

        let answer = try XCTUnwrap(list.decisions?.first { $0.matter != nil && $0.replaces != nil })
        let original = try XCTUnwrap(list.record(XCTUnwrap(answer.replaces)))
        XCTAssertEqual(original.state, "replaced")
        XCTAssertEqual(original.replacedBy, answer.id)
        XCTAssertTrue(list.decisions?.contains { $0.state == "withdrawn" } ?? false)
        let detail = try await c.decidedRecord(projectID: id, id: answer.number)
        XCTAssertFalse(try XCTUnwrap(detail.matter?.facts).isEmpty)
        XCTAssertTrue(try XCTUnwrap(detail.work?.all).allSatisfy { $0.basis?.contains(answer.number) == true })
        let experiment = try XCTUnwrap(list.decisions?.first { $0.mod == "exp" && $0.isActive })
        let work = try await c.decidedRecord(projectID: id, id: experiment.number).work
        XCTAssertFalse(try XCTUnwrap(work?.prov).isEmpty)
        XCTAssertFalse(try XCTUnwrap(work?.tasks).isEmpty)
        XCTAssertTrue(try XCTUnwrap(work?.all).allSatisfy { $0.basis?.contains(experiment.number) == true })
        XCTAssertFalse(try XCTUnwrap(list.loose).isEmpty)
        let loop = try await c.loop(projectID: id)
        XCTAssertNotNil(loop.decided?[try XCTUnwrap(answer.mod)])
        XCTAssertTrue(loop.nodes.contains { $0.kind == "task" && $0.createdBy == "you" && $0.basis?.contains(experiment.number) == true })
        XCTAssertTrue(loop.nodes.contains { $0.kind == "stage" && $0.basis?.contains(experiment.number) == true })
        XCTAssertTrue(loop.nodes.contains { $0.items?.contains { $0.ask == matter.id && $0.kind == "matter" } == true })

        let history = try await c.agentEvents(agentID: "lead-\(id)")
        let entries = ConversationState.entries(from: history.events)
        let entry = try XCTUnwrap(entries.first { $0.decided != nil })
        XCTAssertTrue(entry.canQuote)
        XCTAssertNotNil(entry.userText)
        XCTAssertNotEqual(entry.userText, entry.text)
        let attachment = ChatFiles.split(entry.text)
        XCTAssertEqual(attachment.text, entry.userText)
        XCTAssertEqual(attachment.files.map(\.name), ["评分表.csv"])
        let queued = QueuedMessage(event: try XCTUnwrap(history.events.first { $0.id == entry.eventID }))
        XCTAssertEqual(queued.text, entry.userText)
        XCTAssertTrue(queued.authored)
        let quoted = try XCTUnwrap(list.record(XCTUnwrap(entry.decided)))
        XCTAssertEqual(quoted.text, entry.userText ?? entry.text)
        XCTAssertEqual(quoted.ref?.displayText, entry.eventID.map(String.init))
        XCTAssertEqual(quoted.source, "chat")

        let assigned = try await c.decidedRecord(projectID: "line_1", id: "D7")
        let tell = try XCTUnwrap(assigned.work?.tells?.first)
        let sender = try await c.agentEvents(agentID: "lead-line_1")
        let event = try XCTUnwrap(sender.events.first { String($0.id) == tell.id })
        XCTAssertEqual(event.kind, "sent")
        XCTAssertEqual(tell.title, event.data.field("text")?.stringValue)
        XCTAssertEqual(tell.basis, [assigned.number])
    }

    func testProvenanceConnectsPaperResultRunAndOperation() async throws {
        let c = try client(), id = "line_2"
        let tree = try await c.prov(projectID: id)
        let nodes = try XCTUnwrap(tree.nodes)
        let roots = (tree.files ?? []).flatMap { $0.sections ?? [] }.flatMap { $0.nodes ?? [] }
        let p = try XCTUnwrap(roots.compactMap { nodes[$0] }.first { $0.kind == "passage" && $0.src?.contains { nodes[$0]?.kind == "artifact" } == true })
        let artifact = try XCTUnwrap(p.src?.compactMap { nodes[$0] }.first)
        let result = try XCTUnwrap(artifact.src?.compactMap { nodes[$0] }.first)
        XCTAssertNotNil(p.span?.text)
        let passage = try await c.provNode(projectID: id, id: XCTUnwrap(p.id))
        let previous = try XCTUnwrap(passage.history?.first)
        let previousDetail = try await c.provNode(projectID: id, id: XCTUnwrap(previous.id))
        XCTAssertEqual(previousDetail.tag, previous.tag)
        XCTAssertEqual(artifact.kind, "artifact")
        XCTAssertEqual(result.kind, "result")
        let detail = try await c.provNode(projectID: id, id: XCTUnwrap(result.id))
        XCTAssertNotEqual(detail.then, detail.now)
        XCTAssertFalse(try XCTUnwrap(detail.diff).isEmpty)
        XCTAssertNotNil(detail.made?.job?.op)
        XCTAssertFalse(try XCTUnwrap(detail.made?.job?.cwd).isEmpty)
        XCTAssertNil(try XCTUnwrap(nodes.values.first { $0.kind == "source" }).root)
        XCTAssertFalse(try XCTUnwrap(previous.title).isEmpty)
        XCTAssertFalse(try XCTUnwrap(detail.used?.first?.tag).isEmpty)
        XCTAssertTrue(detail.used?.contains { $0.id == artifact.id } ?? false)
        XCTAssertFalse(try XCTUnwrap(tree.loose).isEmpty)
        let card = try await c.card(projectID: id)
        XCTAssertEqual(card.prov?.numbers?.ok, tree.stats?.numbers?.ok)
        XCTAssertEqual(card.prov?.recent?.count, 3)
        let op = try await c.provOp(projectID: id, id: XCTUnwrap(detail.op))
        XCTAssertFalse(try XCTUnwrap(op.files?.first?.diff).isEmpty)
        let runs = try await c.lineData(projectID: id)
        let tag = try XCTUnwrap(runs.runs?.flatMap { $0.prov ?? [] }.first)
        XCTAssertEqual(tag.id, result.id)
        XCTAssertEqual(tag.tag, result.tag)
        XCTAssertEqual(tag.used, 1)
    }

    @MainActor
    func testInboxGroupsWrittenAnswersAndDeduplicatesReportRows() async throws {
        let c = try client(), id = "line_2"
        let store = TownStore()
        store.projects = [try await c.projectSnapshot(id: id)]
        store.cards[id] = try await c.card(projectID: id)
        store.openAsks = try await c.reports(projectID: id).asks
        let items = store.inboxItems
        XCTAssertEqual(items.filter { $0.section == "decided.group.matter" }.count, 1)
        XCTAssertEqual(items.filter { $0.section == "decided.group.need" }.count, 1)
        XCTAssertEqual(items.filter { $0.section == "decided.group.permissions" }.count, 1)
        store.cards = [:]
        let pending = try XCTUnwrap(store.inboxItems.first { $0.section == "decided.group.matter" })
        guard case .decision(let d) = pending.kind else { return XCTFail("A matter needs a written decision") }
        XCTAssertTrue(d.writtenAnswer)
        XCTAssertEqual(d.facts, store.openAsks.first { String($0.id) == d.id }?.data.matter?.facts)
    }

    func testOperationCursorsAndSnapshot() async throws {
        let c: PapertownClient
        let isolated = ProcessInfo.processInfo.environment["PAPERTOWN_IOS_TEST_SERVER"]
        if let isolated {
            let url = try XCTUnwrap(URL(string: isolated))
            guard url.host == "127.0.0.1", let port = url.port, port != 31640 else {
                return XCTFail("Expected an isolated loopback sample server")
            }
            c = try PapertownClient(address: url)
            let projects = try await c.projectSnapshots()
            guard !projects.isEmpty && projects.allSatisfy(\.sample) else { return XCTFail("Expected sample projects") }
            let snapshot = try await c.provSnap(projectID: "line_2")
            let operations = try await c.provOps(projectID: "line_2")
            for (root, head) in [("code", snapshot.code), ("paper", snapshot.paper)] {
                XCTAssertEqual(try XCTUnwrap(head), operations.first { $0.root == root }?.id)
            }
        } else {
            c = try client()
        }
        let ops = try await c.provOps(projectID: "line_2")
        let pivot = try XCTUnwrap(ops.first)
        let byID = try await c.provOps(projectID: "line_2", before: XCTUnwrap(pivot.id), limit: 2)
        let byTime = try await c.provOps(projectID: "line_2", before: XCTUnwrap(pivot.ts), limit: 2)
        XCTAssertEqual(byID.compactMap(\.id), byTime.compactMap(\.id))
        XCTAssertEqual(byID.compactMap(\.id), Array(ops.dropFirst().prefix(2)).compactMap(\.id))
        let paper = try await c.provOps(projectID: "line_2", root: "paper", limit: 2)
        XCTAssertEqual(paper.compactMap(\.id), Array(ops.filter { $0.root == "paper" }.prefix(2)).compactMap(\.id))
    }

    func testOlderAndPartialResponsesDecode() throws {
        let decoder = JSONDecoder()
        let empty = Data("{}".utf8)
        XCTAssertNil(try decoder.decode(DecidedList.self, from: empty).stats)
        XCTAssertNil(try decoder.decode(DecidedRecord.self, from: empty).materials)
        XCTAssertNil(try decoder.decode(ProvTree.self, from: empty).files)
        XCTAssertNil(try decoder.decode(ProvOp.self, from: empty).files)
        XCTAssertNil(try decoder.decode(ProvNode.self, from: empty).made)
        let blame = try decoder.decode(ProvBlame.self, from: Data(#"{"start":4,"end":8,"commit":"461ace","author":"Researcher","date":"2026-11-01"}"#.utf8))
        XCTAssertEqual([blame.commit, blame.author, blame.date], ["461ace", "Researcher", "2026-11-01"])
        let snap = try decoder.decode(ProvSnapshot.self, from: Data(#"{"code":null,"paper":"461ace"}"#.utf8))
        XCTAssertNil(snap.code)
        XCTAssertEqual(snap.paper, "461ace")
        XCTAssertNil(try decoder.decode(ProjectCardView.self, from: Data(#"{"line":{"id":"l","seq":1,"title":"t","status":"running"}}"#.utf8)).decided)
        XCTAssertNil(try decoder.decode(LoopView.self, from: Data(#"{"nodes":[]}"#.utf8)).decided)
        XCTAssertNil(try decoder.decode(DataRun.self, from: Data(#"{"id":"r","name":"r","state":"done"}"#.utf8)).prov)
        let need = try decoder.decode(Decision.self, from: Data(#"{"kind":"need","id":"Q","title":"Q","options":[{"label":"同意","value":"同意"}]}"#.utf8))
        XCTAssertNil(need.write)
        XCTAssertTrue(need.writtenAnswer)
        let refs = try decoder.decode(ProvNode.self, from: Data(#"{"used":["pv_a"],"history":[{"id":"pv_b","tag":"abcdef0"}]}"#.utf8))
        XCTAssertEqual(refs.used?.first?.id, "pv_a")
        XCTAssertEqual(refs.history?.first?.tag, "abcdef0")
        let numbers = try decoder.decode(ProvNode.self, from: Data(#"{"numbers":[{"where":"a.csv"},{"where":["a.csv","b.csv"]}]}"#.utf8)).numbers
        XCTAssertEqual(numbers?.compactMap(\.locations), [["a.csv"], ["a.csv", "b.csv"]])
    }

    func testOnlyAuthoredChatEventsCanBeQuoted() throws {
        let decoder = JSONDecoder()
        let events = try decoder.decode([AgentEvent].self, from: Data(#"""
        [{"id":10,"ts":"t","agent_id":"a","kind":"user","data":{"origin":"web","text":"same","decided":"D3"}},
         {"id":11,"ts":"u","agent_id":"a","kind":"user","data":{"origin":"bridge","text":"same"}},
         {"id":12,"ts":"v","agent_id":"a","kind":"user","data":{"text":"older"}},
         {"id":13,"ts":"z","agent_id":"a","kind":"user","data":{"origin":"web","text":"duplicate"}},
         {"id":14,"ts":"z","agent_id":"a","kind":"user","data":{"origin":"web","text":"duplicate"}}]
        """#.utf8))
        let items = try decoder.decode([TimelineItem].self, from: Data(#"""
        [{"kind":"user","ts":"t","text":"same"},{"kind":"user","ts":"u","text":"same"},
         {"kind":"user","ts":"x","text":"same"},{"kind":"user","ts":"v","text":"older"},
         {"kind":"user","ts":"z","text":"duplicate"},
         {"kind":"user","text":"message with attachment","data":{"event_id":20,"origin":"web","user_text":"original words","decided":"D2"}},
         {"kind":"user","event_id":21,"origin":"terminal","text":"different","user_text":"terminal words"}]
        """#.utf8))
        let rows = ConversationState.entries(from: items, events: events)
        XCTAssertEqual(rows.map(\.canQuote), [true, false, false, false, false, true, true])
        XCTAssertEqual(rows.first?.eventID, 10)
        XCTAssertEqual(rows.first?.decided, "D3")
        XCTAssertEqual(rows[5].decided, "D2")
        XCTAssertEqual(rows[5].userText, "original words")
        XCTAssertEqual(rows.last?.userText, "terminal words")
        XCTAssertEqual(rows.last?.eventID, 21)
        let wrapped = #"<decision id="D10" mod="paper">三组 &lt;盲审&gt;：A &amp; B</decision>"#
        XCTAssertEqual(ChatEntry.deliveredDecision(wrapped, origin: "papertown")?.text, "三组 <盲审>：A & B")
        XCTAssertNil(ChatEntry.deliveredDecision(wrapped, origin: "web"))
        XCTAssertFalse(QueuedMessage(event: events[1]).authored)
        XCTAssertFalse(QueuedMessage(event: events[2]).authored)
    }

    func testWritingQuotingAndWithdrawingUseProjectRoutes() async throws {
        let c = try PapertownClient(address: DemoServer.address, protocolClasses: [DecisionRequestProtocol.self])
        let written = try await c.writeDecision(projectID: "line_2", text: "new", mod: "exp", replaces: "dc_old")
        XCTAssertEqual(written.number, "D8")
        try await c.writeDecision(projectID: "line_2", text: "answer", mod: "data", matter: 72)
        try await c.writeDecision(projectID: "line_2", text: "card", mod: nil, need: "original card line")
        try await c.quoteDecision(projectID: "line_2", eventID: 41, mod: "paper")
        let withdrawn = try await c.withdrawDecision(projectID: "line_2", id: "dc_old")
        XCTAssertEqual(withdrawn.id, "dc_old")
        XCTAssertEqual(withdrawn.state, "withdrawn")
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
        _ = try await c.freshPapers()
        _ = try await c.skim()
        let bounds = try await c.bounds(projectID: nil)
        XCTAssertEqual(Set(bounds.kinds.keys), ["must", "never", "ask"])
        _ = try await c.trace()
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

/// Checks the wire payload without starting a server or changing the demo.
private final class DecisionRequestProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let url = request.url else { return XCTFail("Missing URL") }
        XCTAssertEqual(request.httpMethod, "POST")
        var bytes = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 512)
            var count = stream.read(&buffer, maxLength: buffer.count)
            while count > 0 {
                bytes.append(contentsOf: buffer.prefix(count))
                count = stream.read(&buffer, maxLength: buffer.count)
            }
        }
        let body = try? JSONDecoder().decode([String: JSONValue].self, from: bytes)
        switch url.path {
        case "/api/lines/line_2/decided":
            switch body?["text"] {
            case .string("new"): XCTAssertEqual(body, ["text": .string("new"), "mod": .string("exp"), "replaces": .string("dc_old")])
            case .string("answer"): XCTAssertEqual(body, ["text": .string("answer"), "mod": .string("data"), "matter": .integer(72)])
            case .string("card"): XCTAssertEqual(body, ["text": .string("card"), "need": .string("original card line")])
            default: XCTFail("Unexpected decision body")
            }
        case "/api/lines/line_2/decided/quote": XCTAssertEqual(body, ["event_id": .integer(41), "mod": .string("paper")])
        case "/api/lines/line_2/decided/dc_old/withdraw": XCTAssertEqual(body, [:])
        default: XCTFail("Unexpected route \(url.path)")
        }
        let reply = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: reply, cacheStoragePolicy: .notAllowed)
        let record = url.path.hasSuffix("/withdraw") ? #"{"id":"dc_old","n":7,"state":"withdrawn"}"# : #"{"id":"dc_new","n":8,"state":"active"}"#
        client?.urlProtocol(self, didLoad: Data(record.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}
