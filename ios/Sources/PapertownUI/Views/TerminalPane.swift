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

    private static let plainBackground = Color(red: 0.11, green: 0.11, blue: 0.12)

    /// The lines to draw: runs of blank lines collapse to one, and the trailing blank ones go. A line with a background
    /// colour is not blank.
    private func shownLines() -> [Int] {
        var out: [Int] = []
        var blank = 0
        let count: Int
        let isBlank: (Int) -> Bool
        if let styled = state.styledScreen {
            count = styled.lines.count
            isBlank = { i in
                styled.lines[i].allSatisfy { run in
                    run.text.trimmingCharacters(in: .whitespaces).isEmpty && (run.style >= styled.styles.count || styled.styles[run.style].bg == nil)
                }
            }
        } else {
            let plain = plainLines
            count = plain.count
            isBlank = { plain[$0].trimmingCharacters(in: .whitespaces).isEmpty }
        }
        for i in 0..<count {
            if isBlank(i) {
                blank += 1
                if blank > 1 { continue }
            } else {
                blank = 0
            }
            out.append(i)
        }
        while let last = out.last, isBlank(last) { out.removeLast() }
        return out
    }

    private var plainLines: [String] {
        (state.screen ?? "").split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    }

    /// One line as the server styled it: colours, bold, italic, underline and strikethrough.
    private func attributed(_ runs: [ScreenRun], _ styled: StyledScreen) -> AttributedString {
        var out = AttributedString()
        for run in runs {
            var a = AttributedString(run.text.replacingOccurrences(of: "\t", with: "    "))
            let st = run.style < styled.styles.count ? styled.styles[run.style] : nil
            if let fg = st?.fg { a.foregroundColor = Self.color(fg) }
            if let bg = st?.bg { a.backgroundColor = Self.color(bg) }
            var font = Font.system(size: size, weight: st?.b == true ? .bold : .regular, design: .monospaced)
            if st?.i == true { font = font.italic() }
            a.font = font
            if st?.u == true { a.underlineStyle = .single }
            if st?.s == true { a.strikethroughStyle = .single }
            out += a
        }
        return out
    }

    static func color(_ hex: String) -> Color {
        let v = UInt32(hex.dropFirst(), radix: 16) ?? 0
        return Color(red: Double(v >> 16 & 0xff) / 255, green: Double(v >> 8 & 0xff) / 255, blue: Double(v & 0xff) / 255)
    }

    private func screen(_ lang: AppLanguage) -> some View {
        let rows = shownLines()
        let styled = state.styledScreen
        let plain = styled == nil ? plainLines : []
        let font = Font.system(size: size, design: .monospaced)
        let ink = styled.map { Self.color($0.theme.fg) } ?? Color(white: 0.9)
        let paper = styled.map { Self.color($0.theme.bg) } ?? Self.plainBackground
        return ScrollViewReader { proxy in
            ScrollView(wrap ? [.vertical] : [.vertical, .horizontal]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if rows.isEmpty {
                        Text(lang.string(state.screen == nil ? "term.loading" : "term.empty"))
                            .font(font).foregroundStyle(ink.opacity(0.5))
                    }
                    ForEach(rows, id: \.self) { i in
                        Group {
                            if let styled {
                                let runs = styled.lines[i]
                                Text(runs.isEmpty ? AttributedString(" ") : attributed(runs, styled))
                            } else {
                                Text(plain[i].isEmpty ? " " : plain[i].replacingOccurrences(of: "\t", with: "    "))
                            }
                        }
                        .font(font)
                        .foregroundStyle(ink)
                        .fixedSize(horizontal: !wrap, vertical: true)
                        .frame(maxWidth: wrap ? .infinity : nil, alignment: .leading)
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .textSelection(.enabled)
                .padding(10)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(paper, in: RoundedRectangle(cornerRadius: 12))
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
