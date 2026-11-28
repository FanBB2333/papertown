import PapertownCore
import SwiftUI

// Small pieces the project, town and chat pages share.

/// Loads a page's data once it appears and on pull-to-refresh, and shows the loading state and errors with a retry.
struct LoadingList<Value, Content: View>: View {
    let load: (PapertownClient) async throws -> Value
    @ViewBuilder let content: (Value) -> Content
    var reloadKey: String = ""

    @EnvironmentObject private var store: TownStore
    @State private var value: Value?
    @State private var error: String?

    var body: some View {
        let lang = store.language
        Group {
            if let value {
                content(value)
            } else if let error {
                PageList {
                    Section {
                        Text(error).emState(.bad, detail: true)
                            .font(.subheadline)
                        Button(lang.string("action.retry")) { Task { await run() } }
                    }
                    .papertownRowBackground(store.appearance)
                }
                .papertownInsetGroupedList()
                .papertownListAppearance(store.appearance)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: reloadKey) { await run() }
        .refreshable { await run() }
    }

    private func run() async {
        do {
            value = try await store.fetch(load)
            error = nil
        } catch is CancellationError {
        } catch {
            if value == nil { self.error = store.message(for: error) }
        }
    }
}

/// A row of a label on the left and its value on the right.
struct InfoRow: View {
    let label: String
    let value: String
    var mono = false
    var number: EmTone? = nil
    var status: EmTone? = nil
    var modelText = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label).foregroundStyle(.secondary)
            Spacer(minLength: 8)
            Group {
                if let number { EmText(value, .numbers(number)) }
                else if let status { Text(value).emState(status) }
                else if modelText { EmText(value) }
                else { Text(value) }
            }
                .font(mono ? .system(.footnote, design: .monospaced) : .body)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
    }
}

/// One inline summary, shared by the project links and their destination pages.
struct RecordStatsLine: View {
    struct Item {
        let label: String
        let count: Int?
        var total: Int? = nil
        var attention = false
        var tone: EmTone = .info
    }

    let items: [Item]
    var empty: String? = nil
    @Environment(\.self) private var env

    var body: some View {
        let visible = items.filter { $0.count != nil && ($0.total ?? $0.count ?? 0) > 0 }
        if !visible.isEmpty {
            Text(visible.reduce(into: AttributedString()) { line, item in
                if !line.characters.isEmpty { line += AttributedString(" · ") }
                if !item.label.isEmpty { line += AttributedString(item.label + " ") }
                var number = AttributedString(String(item.count ?? 0))
                if let total = item.total { number += AttributedString("/\(total)") }
                number.foregroundColor = env.emInk(item.attention ? .warn : item.tone)
                number.font = .caption.monospacedDigit()
                line += number
            })
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .minimumScaleFactor(0.82)
        } else if let empty {
            Text(empty).font(.caption).foregroundStyle(.secondary)
        }
    }
}

extension View {
    @ViewBuilder
    func recordList(_ appearance: AppAppearance) -> some View {
        let list = papertownInsetGroupedList().papertownListAppearance(appearance)
        #if os(iOS)
        if #available(iOS 17, *) {
            list.listSectionSpacing(12).contentMargins(.top, 8, for: .scrollContent)
        } else {
            list
        }
        #else
        list
        #endif
    }
}

/// Bulleted lines, for lists the server writes (next steps, risks, suggestions).
struct BulletList: View {
    let items: [String]
    var symbol = "circle.fill"
    var color: Color = .secondary

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: symbol)
                        .font(.system(size: symbol == "circle.fill" ? 5 : 11, weight: .semibold))
                        .foregroundStyle(color)
                        .frame(width: 12)
                    EmText(item).font(.subheadline).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

/// Text in a monospaced block that scrolls sideways: a command, a screen, a file.
struct MonoBlock: View {
    let text: String
    var maxHeight: CGFloat? = nil

    var body: some View {
        ScrollView([.horizontal, .vertical]) {
            Text(text)
                .font(.system(size: 12, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
        }
        .frame(maxHeight: maxHeight)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
    }
}

/// A thin meter for a share of something: progress, quota used, similarity.
struct Meter: View {
    let value: Double
    var color: Color = .accentColor

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.secondary.opacity(0.18))
                Capsule().fill(color).frame(width: max(0, min(1, value)) * geo.size.width)
            }
        }
        .frame(height: 5)
    }
}

enum Tone {
    /// The colour of a check, gate, job or run state as the server names it.
    static func color(_ state: String?) -> Color {
        switch state {
        case "pass", "done", "ok", "completed", "succeeded", "running", "available", "ready", "busy": return .green
        case "warn", "risk", "near", "queued", "waiting", "starting", "wait", "stale", "doing": return .orange
        case "fail", "failed", "blocked", "block", "error", "over", "cancelled", "unavailable": return .red
        default: return .secondary
        }
    }

    static func symbol(_ state: String?) -> String {
        switch state {
        case "pass", "done", "completed": return "checkmark.circle.fill"
        case "warn", "risk": return "exclamationmark.triangle.fill"
        case "fail", "failed", "blocked", "block", "error": return "xmark.octagon.fill"
        case "running", "run", "doing": return "circle.dotted"
        case "wait", "queued", "waiting": return "clock"
        case "off": return "pause.circle"
        default: return "circle"
        }
    }
}

enum Stamp {
    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let plain = ISO8601DateFormatter()
    private static let rowTime = numericFormat("HH:mm")
    private static let rowDate = numericFormat("MM-dd HH:mm")
    private static let rowDateWithYear = numericFormat("yyyy-MM-dd HH:mm")

    private static func numericFormat(_ format: String) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .autoupdatingCurrent
        formatter.dateFormat = format
        return formatter
    }

    static func date(_ s: String?) -> Date? {
        guard let s else { return nil }
        return iso.date(from: s) ?? plain.date(from: s)
    }

    /// "5m ago" style, in the app's language.
    static func ago(_ s: String?, _ lang: AppLanguage) -> String {
        guard s != nil else { return "" }
        return TextFormatters.relativeTime(from: s, language: lang)
    }

    /// Date and time, short.
    static func short(_ s: String?, _ lang: AppLanguage) -> String {
        guard let d = date(s) else { return s ?? "" }
        let f = DateFormatter()
        f.locale = lang.locale
        f.dateStyle = .medium
        f.timeStyle = .short
        return f.string(from: d)
    }

    /// Fixed-width dates for record rows. Older years stay explicit.
    static func compact(_ s: String?, timeOnly: Bool = false) -> String {
        guard let d = date(s) else { return s ?? "" }
        let calendar = Calendar(identifier: .gregorian)
        if !calendar.isDate(d, equalTo: Date(), toGranularity: .year) { return rowDateWithYear.string(from: d) }
        return (timeOnly ? rowTime : rowDate).string(from: d)
    }
}

extension Double {
    /// Dollars with cents, or a dash for nothing spent.
    var dollars: String { self == 0 ? "$0" : String(format: "$%.2f", self) }
}
