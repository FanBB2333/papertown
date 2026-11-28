import PapertownCore
import SwiftUI
import TelettyKit

/// The terminal tab of a conversation: the CLI's own screen with the lines that scrolled off it, so scrolling up shows
/// the same exchange as the chat tab in the CLI's own drawing, a status line, and the keys it takes. Messages go through
/// the same composer below. Papertown's own terminals (tmux, headless) also take typing straight from the keyboard.
struct TerminalPane: View {
    let target: ChatTarget
    @Binding var typing: Bool
    var onKeys: () -> Void = {}

    @EnvironmentObject private var store: TownStore
    @AppStorage("PTTerminalWrap") private var wrap = true
    @AppStorage("PTTerminalSize") private var size = 10.0
    @AppStorage("PTTerminalKeys") private var showKeys = true
    @State private var follow = true
    @State private var sending = false
    @State private var keyError: String?
    @StateObject private var typer = TerminalTyper()

    private var state: ConversationState { store.conversation(target) }

    /// The server says whether the terminal takes typing (not herdr's, which live in your herdr workspace).
    private var canType: Bool { state.agent?.term?.typing == true && state.termStatus != "exited" }

    var body: some View {
        let lang = store.language
        VStack(spacing: 0) {
            header(lang)
            TerminalScreenView(text: state.screen, styled: state.styledScreen, wrap: wrap, size: size,
                               follow: follow, typing: typing, labels: lang.terminalLabels, followStyleChanges: false)
            if let error = keyError ?? typer.error {
                Text(error).font(.caption).emState(.bad, detail: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14).padding(.top, 6)
            }
            if showKeys {
                TerminalKeyGrid(labels: lang.terminalKeyLabels, enabled: !sending && state.termStatus != "exited", send: press)
            }
        }
        .background {
            if canType {
                TerminalKeyboard(active: $typing) { input in
                    follow = true
                    typer.push(input)
                }
                .frame(width: 1, height: 1)
                .opacity(0.01)
                .allowsHitTesting(false)
            }
        }
        .onAppear {
            let store = store, target = target
            typer.send = { input in
                switch input {
                case .text(let text): return await store.typeIntoTerminal(text, paste: false, on: target)
                case .paste(let text): return await store.typeIntoTerminal(text, paste: true, on: target)
                case .keys(let keys): return await store.sendKeys(keys, on: target)
                }
            }
            typer.settled = {
                try? await Task.sleep(nanoseconds: 150_000_000)  // let the screen redraw
                await store.refreshChat(target)
            }
        }
        .onChange(of: canType) { can in
            if !can { typing = false }
        }
    }

    // MARK: Header

    private func header(_ lang: AppLanguage) -> some View {
        let st = state.termStatus ?? "idle"
        return HStack(spacing: 8) {
            if st == "working" || st == "starting" {
                ProgressView().controlSize(.small)
            }
            Text(lang.string("term.status.\(st)")).font(.footnote).emState(EmTone.issue(st))
            if let t = state.agent?.term {
                Text([t.backend, t.provider].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            if canType {
                Button { typing.toggle() } label: {
                    Image(systemName: typing ? "keyboard.chevron.compact.down" : "keyboard")
                }
                .accessibilityLabel(lang.string(typing ? "term.type.off" : "term.type.on"))
            }
            Button { follow.toggle() } label: {
                Image(systemName: follow ? "arrow.down.to.line.compact" : "pause")
            }
            .accessibilityLabel(lang.string(follow ? "term.follow.on" : "term.follow.off"))
            Menu {
                Picker(lang.string("term.layout"), selection: $wrap) {
                    Text(lang.string("term.wrap")).tag(true)
                    Text(lang.string("term.nowrap")).tag(false)
                }
                Toggle(isOn: $showKeys) { Label(lang.string("term.keys.show"), systemImage: "square.grid.3x3") }
                if canType {
                    Button {
                        if let text = TerminalClipboard.text, !text.isEmpty { follow = true; typer.push(.paste(text)) }
                    } label: { Label(lang.string("term.type.paste"), systemImage: "doc.on.clipboard") }
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

    private func press(_ keys: [String]) async {
        sending = true
        keyError = nil
        keyError = await store.pressKeys(keys, on: target)
        sending = false
        follow = true
        onKeys()
    }
}

extension AppLanguage {
    var terminalLabels: ScreenLabels {
        ScreenLabels(loading: string("term.loading"), empty: string("term.empty"), unread: string("terminals.unread"))
    }

    fileprivate var terminalKeyLabels: [String: String] {
        Dictionary(uniqueKeysWithValues: TerminalKeyGrid.keyIDs.map { ($0, string("term.key.\($0)")) })
    }
}
