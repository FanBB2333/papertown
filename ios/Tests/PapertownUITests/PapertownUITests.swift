import XCTest
import PapertownCore
@testable import PapertownUI

final class PapertownUITests: XCTestCase {
    func testEnglishPrimaryAndChineseOptionalLocalization() {
        XCTAssertEqual(AppLanguage.english.string("tab.inbox"), "Inbox")
        XCTAssertEqual(AppLanguage.english.string("tab.projects"), "Projects")
        XCTAssertEqual(AppLanguage.english.string("tab.staff"), "Staff")
        XCTAssertEqual(AppLanguage.english.string("tab.server"), "Server")

        XCTAssertEqual(AppLanguage.simplifiedChinese.string("tab.inbox"), "待处理")
        XCTAssertEqual(AppLanguage.simplifiedChinese.string("tab.projects"), "项目")
        XCTAssertEqual(AppLanguage.simplifiedChinese.string("tab.staff"), "员工")
        XCTAssertEqual(AppLanguage.simplifiedChinese.string("tab.server"), "服务器")
    }

    func testAllEightStagesAndFiveRolesLocalized() {
        for stage in TextFormatters.orderedStages {
            let en = TextFormatters.stageName(stage, language: .english)
            let zh = TextFormatters.stageName(stage, language: .simplifiedChinese)
            XCTAssertNotEqual(en, stage, "Missing English stage copy for \(stage)")
            XCTAssertNotEqual(zh, stage, "Missing Chinese stage copy for \(stage)")
        }

        for role in ["lead", "coder", "writer", "monitor", "assistant"] {
            let en = TextFormatters.roleName(role, language: .english)
            let zh = TextFormatters.roleName(role, language: .simplifiedChinese)
            XCTAssertNotEqual(en, role)
            XCTAssertNotEqual(zh, role)
        }
    }

    func testResidentLeadSixStateCopies() {
        let running = TextFormatters.leadDetail(
            state: "running", note: nil, runtime: "headless", model: "codex", status: "working", sample: false, language: .english
        )
        XCTAssertEqual(running, "headless · codex · Working")

        let offNormal = TextFormatters.leadDetail(
            state: "off", note: nil, runtime: nil, model: nil, status: nil, sample: false, language: .english
        )
        XCTAssertTrue(offNormal.contains("Paused"))

        let offSample = TextFormatters.leadDetail(
            state: "off", note: nil, runtime: nil, model: nil, status: nil, sample: true, language: .english
        )
        XCTAssertTrue(offSample.contains("Sample project"))

        let blockedCustom = TextFormatters.leadDetail(
            state: "blocked", note: "Paseo daemon is stopped", runtime: nil, model: nil, status: nil, sample: false, language: .english
        )
        XCTAssertEqual(blockedCustom, "Paseo daemon is stopped")

        let blockedFallback = TextFormatters.leadDetail(
            state: "blocked", note: nil, runtime: nil, model: nil, status: nil, sample: false, language: .english
        )
        XCTAssertEqual(blockedFallback, "Failed to start the project lead.")
    }

    func testMarkdownStrippingAndErrorTranslation() {
        XCTAssertEqual(TextFormatters.stripMarkdown("### **Summary**: `done`\nSecond line"), "Summary: done")
        XCTAssertEqual(
            TextFormatters.errorMessage(for: ClientError.http(status: 502, detail: nil), language: .english),
            "The relay cannot reach your Mac right now. Make sure Papertown is running on your computer."
        )
        XCTAssertEqual(
            TextFormatters.errorMessage(for: ClientError.http(status: 401, detail: nil), language: .simplifiedChinese),
            "登录已过期或密码无效，请重新登录。"
        )
    }

    func testServerProfileNormalizationAndPersistence() {
        XCTAssertEqual(ServerProfile.normalizeURL("https://example.com/town/ ")?.absoluteString, "https://example.com/town")
        XCTAssertNil(ServerProfile.normalizeURL("ftp://example.com"))
        XCTAssertNil(ServerProfile.normalizeURL("https://user:pass@example.com"))
        XCTAssertNil(ServerProfile.normalizeURL("https://example.com?x=1"))

        let lan = ServerProfile(name: "Home", addressString: "http://192.168.1.20:8000")
        XCTAssertTrue(lan.isLocalAddress)
        XCTAssertEqual(lan.routeSymbol, "wifi")

        let remote = ServerProfile(name: "Relay", addressString: "https://pt.example.com/home")
        XCTAssertFalse(remote.isLocalAddress)
        XCTAssertEqual(remote.routeSymbol, "lock.shield")
        XCTAssertEqual(remote.displayHost, "pt.example.com/home")

        let suiteName = "papertown.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let store = ProfileStore(defaults: defaults)
        XCTAssertEqual(store.loadLanguage(), .english)
        store.saveLanguage(.simplifiedChinese)
        XCTAssertEqual(store.loadLanguage(), .simplifiedChinese)

        store.saveProfiles([lan, remote])
        XCTAssertEqual(store.loadProfiles(), [lan, remote])
    }

    func testChatEventMergeDeduplicatesAndSorts() throws {
        var chat = ConversationState()
        let decoder = JSONDecoder()
        let e2 = try decoder.decode(AgentEvent.self, from: Data(#"{"id":2,"agent_id":"lead","ts":"2026-11-23T03:00:02Z","kind":"assistant","data":{"text":"Second"}}"#.utf8))
        let e1 = try decoder.decode(AgentEvent.self, from: Data(#"{"id":1,"agent_id":"lead","ts":"2026-11-23T03:00:01Z","kind":"user","data":{"text":"First"}}"#.utf8))
        let e2Updated = try decoder.decode(AgentEvent.self, from: Data(#"{"id":2,"agent_id":"lead","ts":"2026-11-23T03:00:02Z","kind":"assistant","data":{"text":"Second updated"}}"#.utf8))

        chat.merge([e2, e1])
        XCTAssertEqual(chat.events.map(\.id), [1, 2])
        chat.merge([e2Updated])
        XCTAssertEqual(chat.events.count, 2)
        XCTAssertEqual(chat.events.last?.data.field("text")?.stringValue, "Second updated")
        XCTAssertEqual(chat.entries.map(\.text), ["First", "Second updated"])
    }

    func testZeroEmojisInLocalizationStrings() {
        let keys = [
            "tab.inbox", "tab.projects", "tab.staff", "tab.server",
            "inbox.empty.title", "inbox.empty.desc", "detail.message_lead",
            "chat.mode.steer", "chat.mode.queue", "chat.mode.interrupt",
            "connect.title", "login.title", "server.section.current"
        ]
        for lang in [AppLanguage.english, AppLanguage.simplifiedChinese] {
            for key in keys {
                let text = lang.string(key)
                let hasEmoji = text.unicodeScalars.contains { $0.properties.isEmojiPresentation }
                XCTAssertFalse(hasEmoji, "Unexpected emoji found in \(lang.rawValue) for key \(key): \(text)")
            }
        }
    }
}
