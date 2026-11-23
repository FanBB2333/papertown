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
                List {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
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

/// A small coloured label: a state, a verdict, a health.
struct Pill: View {
    let text: String
    var color: Color = .secondary
    var symbol: String? = nil

    var body: some View {
        HStack(spacing: 3) {
            if let symbol { Image(systemName: symbol).imageScale(.small) }
            Text(text).lineLimit(1)
        }
        .font(.caption2.weight(.semibold))
        .padding(.horizontal, 7)
        .padding(.vertical, 2.5)
        .foregroundStyle(color)
        .background(color.opacity(0.13), in: Capsule())
    }
}

/// A row of a label on the left and its value on the right.
struct InfoRow: View {
    let label: String
    let value: String
    var mono = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label).foregroundStyle(.secondary)
            Spacer(minLength: 8)
            Text(value)
                .font(mono ? .system(.footnote, design: .monospaced) : .body)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
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
                    Text(item).font(.subheadline).fixedSize(horizontal: false, vertical: true)
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
}

extension Double {
    /// Dollars with cents, or a dash for nothing spent.
    var dollars: String { self == 0 ? "$0" : String(format: "$%.2f", self) }
}
