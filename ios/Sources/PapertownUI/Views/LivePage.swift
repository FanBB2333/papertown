import PapertownCore
import SwiftUI

/// What a page's controls do: run a change on the server and load the page again. A failure shows as an alert, a
/// result worth saying as a note.
struct PageActions {
    let busy: Bool
    fileprivate let perform: (_ done: String?, _ op: @escaping (PapertownClient) async throws -> String?) -> Void

    /// Runs the change; `done` is said when it worked.
    func run(_ done: String? = nil, _ op: @escaping (PapertownClient) async throws -> Void) {
        perform(done) { try await op($0); return nil }
    }

    /// Runs the change and says what it answers.
    func say(_ op: @escaping (PapertownClient) async throws -> String?) {
        perform(nil, op)
    }
}

/// A page that loads its data when it appears, on pull-to-refresh, after each change made on it, and on the server's
/// events it names (only those about its project, when it has one).
struct LivePage<Value, Content: View>: View {
    let load: (PapertownClient) async throws -> Value
    var events: Set<String> = []
    var projectID: String? = nil
    @ViewBuilder let content: (Value, PageActions) -> Content

    @EnvironmentObject private var store: TownStore
    @State private var value: Value?
    @State private var error: String?
    @State private var busy = false
    @State private var failure: String?
    @State private var notice: String?
    @State private var pending: Task<Void, Never>?

    var body: some View {
        let lang = store.language
        Group {
            if let value {
                content(value, PageActions(busy: busy, perform: perform))
            } else if let error {
                PageList {
                    Section {
                        Text(error).emState(.bad, detail: true).font(.subheadline)
                        Button(lang.string("action.retry")) { Task { await reload() } }
                    }
                    .papertownRowBackground(store.appearance)
                }
                .papertownInsetGroupedList()
                .papertownListAppearance(store.appearance)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task { await reload() }
        .refreshable { await reload() }
        .onReceive(store.events) { e in
            guard events.contains(e.name), concerns(e.payload) else { return }
            pending?.cancel()
            pending = Task {
                try? await Task.sleep(nanoseconds: 600_000_000)
                if !Task.isCancelled { await reload() }
            }
        }
        .alert(lang.string("manage.failed"), isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button(lang.string("action.ok"), role: .cancel) {}
        } message: {
            Text(failure ?? "")
        }
        .alert(notice ?? "", isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })) {
            Button(lang.string("action.ok"), role: .cancel) {}
        }
    }

    private func reload() async {
        do {
            value = try await store.fetch(load)
            error = nil
        } catch is CancellationError {
        } catch {
            if value == nil { self.error = store.message(for: error) }
        }
    }

    private func perform(_ done: String?, _ op: @escaping (PapertownClient) async throws -> String?) {
        guard !busy else { return }
        busy = true
        Task {
            do {
                let said = try await store.fetch(op)
                if let message = said ?? done, !message.isEmpty { notice = message }
            } catch {
                failure = store.message(for: error)
            }
            await reload()
            busy = false
        }
    }

    /// Whether an event is about this page's project: events that name no project concern every page that listens.
    private func concerns(_ p: [String: JSONValue]) -> Bool {
        guard let projectID else { return true }
        let line = p["line_id"]?.stringValue ?? p["line"]?.field("id")?.stringValue ?? p["card"]?.field("line")?.field("id")?.stringValue
            ?? p["agent"]?.field("line_id")?.stringValue ?? p["report"]?.field("line_id")?.stringValue
        return line == nil || line == projectID
    }
}

/// A line of text and a button that sends it: a note to the lead, a reply, a reason.
struct SendField: View {
    let placeholder: String
    let button: String
    var limit: Int = 2000
    var axis: Axis = .horizontal
    var disabled = false
    let send: (String) -> Void
    @State private var text = ""

    var body: some View {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        HStack(alignment: .bottom, spacing: 8) {
            PromptField(placeholder, text: $text, axis: axis)
                .textFieldStyle(.roundedBorder)
                .lineLimit(axis == .vertical ? 1...6 : 1...1)
                .emBar(trimmed.isEmpty ? nil : .info, reserve: true)
                .onChange(of: text) { if $0.count > limit { text = String($0.prefix(limit)) } }
                .onSubmit { if axis == .horizontal, !trimmed.isEmpty, !disabled { send(trimmed); text = "" } }
            Button(button) { send(trimmed); text = "" }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(trimmed.isEmpty || disabled)
        }
    }
}

/// Lays its views out in rows, wrapping onto the next row as they fill one: the choices of a decision.
struct WrapLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews)
        let width = rows.map { $0.width }.max() ?? 0
        let height = rows.reduce(0) { $0 + $1.height } + spacing * CGFloat(max(rows.count - 1, 0))
        return CGSize(width: proposal.width ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(width: bounds.width, subviews) {
            var x = bounds.minX
            for i in row.items {
                let size = subviews[i].sizeThatFits(.unspecified)
                subviews[i].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(width: min(size.width, bounds.width), height: size.height))
                x += min(size.width, bounds.width) + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row { var items: [Int] = []; var width: CGFloat = 0; var height: CGFloat = 0 }

    private func arrange(width: CGFloat, _ subviews: Subviews) -> [Row] {
        var rows: [Row] = [Row()]
        for i in subviews.indices {
            let size = subviews[i].sizeThatFits(.unspecified)
            let w = min(size.width, width)
            if !rows[rows.count - 1].items.isEmpty, rows[rows.count - 1].width + spacing + w > width { rows.append(Row()) }
            let gap = rows[rows.count - 1].items.isEmpty ? 0 : spacing
            rows[rows.count - 1].items.append(i)
            rows[rows.count - 1].width += gap + w
            rows[rows.count - 1].height = max(rows[rows.count - 1].height, size.height)
        }
        return rows
    }
}
