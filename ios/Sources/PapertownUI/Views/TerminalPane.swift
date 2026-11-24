import PapertownCore
import SwiftUI

/// The terminal tab of a conversation: the CLI's own screen with the lines that scrolled off it, so scrolling up shows
/// the same exchange as the chat tab in the CLI's own drawing, a status line, and the keys it takes. Messages go through
/// the same composer below.
struct TerminalPane: View {
    let target: ChatTarget
    var onKeys: () -> Void = {}

    @EnvironmentObject private var store: TownStore
    @AppStorage("PTTerminalWrap") private var wrap = true
    @AppStorage("PTTerminalSize") private var size = 10.0
    @State private var follow = true
    @State private var sending = false
    @State private var keyError: String?

    private var state: ConversationState { store.conversation(target) }

    var body: some View {
        let lang = store.language
        VStack(spacing: 0) {
            header(lang)
            screen(lang)
            if let keyError {
                Text(keyError).font(.caption).foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14).padding(.top, 6)
            }
            keyBar(lang)
        }
    }

    // MARK: Header

    private func header(_ lang: AppLanguage) -> some View {
        let st = state.termStatus ?? "idle"
        return HStack(spacing: 8) {
            if st == "working" || st == "starting" {
                ProgressView().controlSize(.small)
            } else {
                Circle().fill(Self.tone(st)).frame(width: 8, height: 8)
            }
            Text(lang.string("term.status.\(st)")).font(.footnote.weight(.medium))
            if let t = state.agent?.term {
                Text([t.backend, t.provider].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            Button { follow.toggle() } label: {
                Image(systemName: follow ? "arrow.down.to.line.compact" : "pause")
            }
            .accessibilityLabel(lang.string(follow ? "term.follow.on" : "term.follow.off"))
            Menu {
                Picker(lang.string("term.layout"), selection: $wrap) {
                    Text(lang.string("term.wrap")).tag(true)
                    Text(lang.string("term.nowrap")).tag(false)
                }
                Section(lang.string("term.size")) {
                    Button { size = max(7, size - 1) } label: { Label(lang.string("term.smaller"), systemImage: "textformat.size.smaller") }
                    Button { size = min(16, size + 1) } label: { Label(lang.string("term.larger"), systemImage: "textformat.size.larger") }
                }
            } label: {
                Image(systemName: "textformat.size")
            }
            .accessibilityLabel(lang.string("term.size"))
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }

    static func tone(_ status: String) -> Color {
        switch status {
        case "working", "starting": return .green
        case "blocked": return .orange
        case "exited": return .gray
        default: return .blue
        }
    }

    // MARK: Screen

    /// Runs of blank lines collapse to one, and the trailing blank ones go.
    private var lines: [String] {
        var out: [String] = []
        var blank = 0
        for line in (state.screen ?? "").split(separator: "\n", omittingEmptySubsequences: false) {
            let l = String(line).replacingOccurrences(of: "\t", with: "    ")
            if l.trimmingCharacters(in: .whitespaces).isEmpty {
                blank += 1
                if blank > 1 { continue }
            } else {
                blank = 0
            }
            out.append(l)
        }
        while out.last?.trimmingCharacters(in: .whitespaces).isEmpty == true { out.removeLast() }
        return out
    }

    private func screen(_ lang: AppLanguage) -> some View {
        let rows = lines
        let font = Font.system(size: size, design: .monospaced)
        return ScrollViewReader { proxy in
            ScrollView(wrap ? [.vertical] : [.vertical, .horizontal]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if rows.isEmpty {
                        Text(lang.string(state.screen == nil ? "term.loading" : "term.empty"))
                            .font(font).foregroundStyle(Color.white.opacity(0.5))
                    }
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, line in
                        Text(line.isEmpty ? " " : line)
                            .font(font)
                            .foregroundStyle(Color(white: 0.9))
                            .fixedSize(horizontal: !wrap, vertical: true)
                            .frame(maxWidth: wrap ? .infinity : nil, alignment: .leading)
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .textSelection(.enabled)
                .padding(10)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Color(red: 0.11, green: 0.11, blue: 0.12), in: RoundedRectangle(cornerRadius: 12))
            .padding(.horizontal, 10)
            .onAppear { proxy.scrollTo("end", anchor: .bottom) }
            .onChange(of: state.screen) { _ in
                if follow { proxy.scrollTo("end", anchor: .bottom) }
            }
            .onChange(of: follow) { on in
                if on { withAnimation { proxy.scrollTo("end", anchor: .bottom) } }
            }
        }
    }

    // MARK: Keys

    private static let keys: [(label: String, key: String)] = [
        ("Esc", "esc"), ("Tab", "tab"), ("↑", "up"), ("↓", "down"), ("←", "left"), ("→", "right"),
        ("␣", "space"), ("⌫", "backspace"), ("⏎", "enter"), ("⌃C", "ctrl+c"),
        ("1", "1"), ("2", "2"), ("3", "3"), ("y", "y"), ("n", "n"),
    ]

    private func keyBar(_ lang: AppLanguage) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(Self.keys, id: \.key) { k in
                    Button { Task { await press(k.key) } } label: {
                        Text(k.label)
                            .font(.system(size: 14, weight: .medium, design: .monospaced))
                            .frame(minWidth: 30, minHeight: 30)
                            .padding(.horizontal, 4)
                    }
                    .buttonStyle(.bordered)
                    .accessibilityLabel(lang.string("term.key.\(k.key)"))
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
        }
        .disabled(sending || state.termStatus == "exited")
    }

    private func press(_ key: String) async {
        sending = true
        keyError = nil
        keyError = await store.pressKeys([key], on: target)
        sending = false
        follow = true
        onKeys()
    }
}
