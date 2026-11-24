import SwiftUI
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

/// What typing into a terminal sends: text as it is, a paste, or named keys (the server's terminal keys).
enum TerminalInput: Equatable {
    case text(String)
    case paste(String)
    case keys([String])
}

/// Sends what you type into a terminal one request at a time and in order, merging the text typed while a request is
/// out into the next one, and redraws the screen once it has all gone.
@MainActor
final class TerminalTyper: ObservableObject {
    @Published private(set) var error: String?
    var send: (TerminalInput) async -> String? = { _ in nil }
    var settled: () async -> Void = {}
    private var queue: [TerminalInput] = []
    private var running = false

    func push(_ input: TerminalInput) {
        if case .text(let more) = input, case .text(let text)? = queue.last {
            queue[queue.count - 1] = .text(text + more)
        } else {
            queue.append(input)
        }
        guard !running else { return }
        running = true
        Task {
            while !queue.isEmpty {
                let next = queue.removeFirst()
                if let e = await send(next) {
                    error = e
                    queue.removeAll()
                } else {
                    error = nil
                }
            }
            running = false
            await settled()
        }
    }
}

enum TerminalClipboard {
    static var text: String? {
        #if os(iOS)
        return UIPasteboard.general.string
        #elseif os(macOS)
        return NSPasteboard.general.string(forType: .string)
        #endif
    }
}

#if os(iOS)
/// An unseen view that takes the keyboard while `active`: the software keyboard's characters go to the terminal as
/// text, Return, Tab and delete as keys, and a hardware keyboard's arrows, Esc, Shift+Tab, page keys and Ctrl+C/D/O/T
/// as keys too. Dismissing the keyboard ends it.
struct TerminalKeyboard: UIViewRepresentable {
    @Binding var active: Bool
    let input: (TerminalInput) -> Void

    func makeUIView(context: Context) -> KeyInputView { KeyInputView() }

    func updateUIView(_ view: KeyInputView, context: Context) {
        view.input = input
        let binding = $active
        view.ended = { if binding.wrappedValue { binding.wrappedValue = false } }
        if active, !view.isFirstResponder {
            DispatchQueue.main.async { _ = view.becomeFirstResponder() }
        } else if !active, view.isFirstResponder {
            DispatchQueue.main.async { _ = view.resignFirstResponder() }
        }
    }

    final class KeyInputView: UIView, UIKeyInput {
        var input: (TerminalInput) -> Void = { _ in }
        var ended: () -> Void = {}
        private var handled = Set<UIKeyboardHIDUsage>()

        // a terminal wants what was typed, not what autocorrect would make of it
        var keyboardType: UIKeyboardType = .asciiCapable
        var autocorrectionType: UITextAutocorrectionType = .no
        var autocapitalizationType: UITextAutocapitalizationType = .none
        var spellCheckingType: UITextSpellCheckingType = .no
        var smartQuotesType: UITextSmartQuotesType = .no
        var smartDashesType: UITextSmartDashesType = .no
        var smartInsertDeleteType: UITextSmartInsertDeleteType = .no

        override var canBecomeFirstResponder: Bool { true }
        var hasText: Bool { true }

        func insertText(_ text: String) {
            var run = ""
            for ch in text {
                switch ch {
                case "\n", "\r", "\r\n":
                    flush(&run)
                    input(.keys(["enter"]))
                case "\t":
                    flush(&run)
                    input(.keys(["tab"]))
                default:
                    run.append(ch)
                }
            }
            flush(&run)
        }

        private func flush(_ run: inout String) {
            if !run.isEmpty { input(.text(run)) }
            run = ""
        }

        func deleteBackward() { input(.keys(["backspace"])) }

        override func resignFirstResponder() -> Bool {
            let done = super.resignFirstResponder()
            if done { ended() }
            return done
        }

        override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
            action == #selector(paste(_:)) ? UIPasteboard.general.hasStrings : false
        }

        override func paste(_ sender: Any?) {
            if let text = UIPasteboard.general.string, !text.isEmpty { input(.paste(text)) }
        }

        override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
            var rest = Set<UIPress>()
            for press in presses {
                if let key = press.key, let name = Self.name(key) {
                    handled.insert(key.keyCode)
                    input(.keys([name]))
                } else {
                    rest.insert(press)
                }
            }
            if !rest.isEmpty { super.pressesBegan(rest, with: event) }
        }

        override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
            let rest = presses.filter { press in
                guard let code = press.key?.keyCode, handled.contains(code) else { return true }
                handled.remove(code)
                return false
            }
            if !rest.isEmpty { super.pressesEnded(rest, with: event) }
        }

        /// The hardware keys the software keyboard has no way to type.
        static func name(_ key: UIKey) -> String? {
            if key.modifierFlags.contains(.control), let c = key.charactersIgnoringModifiers.lowercased().first, "cdot".contains(c) {
                return "ctrl+\(c)"
            }
            switch key.keyCode {
            case .keyboardUpArrow: return "up"
            case .keyboardDownArrow: return "down"
            case .keyboardLeftArrow: return "left"
            case .keyboardRightArrow: return "right"
            case .keyboardEscape: return "esc"
            case .keyboardTab: return key.modifierFlags.contains(.shift) ? "shift+tab" : "tab"
            case .keyboardPageUp: return "pageup"
            case .keyboardPageDown: return "pagedown"
            default: return nil
            }
        }
    }
}
#elseif os(macOS)
/// An unseen view that takes the keyboard while `active`: characters go to the terminal as text, the arrows, Esc,
/// Tab, Shift+Tab, delete, Return, page keys and Ctrl+C/D/O/T as keys, and ⌘V as a paste. Clicking elsewhere ends it.
struct TerminalKeyboard: NSViewRepresentable {
    @Binding var active: Bool
    let input: (TerminalInput) -> Void

    func makeNSView(context: Context) -> KeyView { KeyView() }

    func updateNSView(_ view: KeyView, context: Context) {
        view.input = input
        let binding = $active
        view.ended = { if binding.wrappedValue { binding.wrappedValue = false } }
        let focused = view.window?.firstResponder === view
        if active, !focused {
            DispatchQueue.main.async { view.window?.makeFirstResponder(view) }
        } else if !active, focused {
            DispatchQueue.main.async { view.window?.makeFirstResponder(nil) }
        }
    }

    final class KeyView: NSView {
        var input: (TerminalInput) -> Void = { _ in }
        var ended: () -> Void = {}

        override var acceptsFirstResponder: Bool { true }

        override func resignFirstResponder() -> Bool {
            let done = super.resignFirstResponder()
            if done { ended() }
            return done
        }

        override func keyDown(with event: NSEvent) {
            if let name = Self.name(event) {
                input(.keys([name]))
            } else if let text = event.characters, !text.isEmpty, !event.modifierFlags.contains(.command),
                      text.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) {
                input(.text(text))
            } else {
                super.keyDown(with: event)
            }
        }

        override func performKeyEquivalent(with event: NSEvent) -> Bool {
            guard window?.firstResponder === self, event.modifierFlags.contains(.command),
                  event.charactersIgnoringModifiers == "v", let text = TerminalClipboard.text, !text.isEmpty else {
                return super.performKeyEquivalent(with: event)
            }
            input(.paste(text))
            return true
        }

        static func name(_ event: NSEvent) -> String? {
            if event.modifierFlags.contains(.control), let c = event.charactersIgnoringModifiers?.lowercased().first, "cdot".contains(c) {
                return "ctrl+\(c)"
            }
            if event.keyCode == 53 { return "esc" }
            switch event.specialKey {
            case .upArrow?: return "up"
            case .downArrow?: return "down"
            case .leftArrow?: return "left"
            case .rightArrow?: return "right"
            case .pageUp?: return "pageup"
            case .pageDown?: return "pagedown"
            case .backTab?: return "shift+tab"
            case .tab?: return event.modifierFlags.contains(.shift) ? "shift+tab" : "tab"
            case .delete?: return "backspace"
            case .carriageReturn?, .enter?, .newline?: return "enter"
            default: return nil
            }
        }
    }
}
#endif
