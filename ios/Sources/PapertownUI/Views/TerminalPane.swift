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
    @AppStorage("PTTerminalKeys") private var showKeys = true
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
            if showKeys { keyGrid(lang) }
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
                Toggle(isOn: $showKeys) { Label(lang.string("term.keys.show"), systemImage: "keyboard") }
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

    /// A key on the grid: what it shows, what it sends (a combination sends its keys in order), and its name for
    /// VoiceOver and the long press.
    private struct Key: Identifiable {
        let label: String
        let keys: [String]
        let name: String
        /// An SF Symbol drawn instead of the label.
        let symbol: String?
        var id: String { name }
        init(_ label: String, _ keys: [String], _ name: String? = nil, symbol: String? = nil) {
            self.label = label
            self.keys = keys
            self.name = name ?? keys[0]
            self.symbol = symbol
        }
    }

    /// Three rows: moving and editing, the agent CLIs' shortcuts, and the answers a dialog takes.
    private static let rows: [[Key]] = [
        [Key("Esc", ["esc"]), Key("Tab", ["tab"], symbol: "arrow.right.to.line"),
         Key("↑", ["up"], symbol: "arrow.up"), Key("↓", ["down"], symbol: "arrow.down"),
         Key("←", ["left"], symbol: "arrow.left"), Key("→", ["right"], symbol: "arrow.right"),
         Key("⌫", ["backspace"], symbol: "delete.left"), Key("⏎", ["enter"], symbol: "return")],
        [Key("⌃C", ["ctrl+c"]), Key("⌃D", ["ctrl+d"]), Key("⇧Tab", ["shift+tab"], symbol: "arrow.left.to.line"),
         Key("Esc×2", ["esc", "esc"], "esc2"), Key("⌃O", ["ctrl+o"]), Key("⌃T", ["ctrl+t"]),
         Key("PgUp", ["pageup"]), Key("PgDn", ["pagedown"])],
        [Key("1", ["1"]), Key("2", ["2"]), Key("3", ["3"]), Key("4", ["4"]),
         Key("y", ["y"]), Key("n", ["n"]), Key("␣", ["space"], symbol: "space"), Key("/", ["/"])],
    ]

    private func keyGrid(_ lang: AppLanguage) -> some View {
        VStack(spacing: 5) {
            ForEach(Array(Self.rows.enumerated()), id: \.offset) { _, row in
                HStack(spacing: 5) {
                    ForEach(row) { k in
                        Button { Task { await press(k.keys) } } label: {
                            Group {
                                if let symbol = k.symbol {
                                    Image(systemName: symbol).font(.system(size: 14, weight: .medium))
                                } else {
                                    Text(k.label)
                                        .font(.system(size: k.label.count > 2 ? 12 : 15, weight: .medium))
                                        .lineLimit(1)
                                        .minimumScaleFactor(0.7)
                                }
                            }
                            .frame(maxWidth: .infinity, minHeight: 32, maxHeight: 32)
                                .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 7))
                                .contentShape(RoundedRectangle(cornerRadius: 7))
                        }
                        .buttonStyle(.plain)
                        .help(lang.string("term.key.\(k.name)"))
                        .accessibilityLabel(lang.string("term.key.\(k.name)"))
                    }
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, 6)
        .padding(.bottom, 4)
        .disabled(sending || state.termStatus == "exited")
        .opacity(sending || state.termStatus == "exited" ? 0.5 : 1)
    }

    private func press(_ keys: [String]) async {
        sending = true
        keyError = nil
        keyError = await store.pressKeys(keys, on: target)
        sending = false
        follow = true
        onKeys()
    }
}
