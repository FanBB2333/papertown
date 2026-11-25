import SwiftUI

enum EmTone {
    case info, good, warn, bad

    static func issue(_ state: String?) -> Self? {
        switch state {
        case "warn", "risk", "near", "stale", "moved", "changed", "replaced", "waiting_permission", "permission", "held", "attention", "needs_input", "needs", "auth", "expired":
            return .warn
        case "fail", "failed", "block", "blocked", "error", "over", "missing", "unavailable", "withdrawn", "down", "disconnected", "bad":
            return .bad
        default: return nil
        }
    }

    static func deadline(_ text: String, at now: Date = .now, calendar: Calendar = .current) -> Self? {
        let date: Date?
        if let instant = TextFormatters.parseISO8601(text) {
            date = instant
        } else {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = calendar.timeZone
            formatter.dateFormat = "yyyy-MM-dd"
            date = formatter.date(from: text)
        }
        guard let date else { return nil }
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)).day ?? 0
        return days < 0 ? .bad : days <= 1 ? .warn : nil
    }

    static func usage(_ fraction: Double) -> Self { fraction >= 0.9 ? .bad : fraction >= 0.7 ? .warn : .info }

    var symbol: String { self == .bad ? "exclamationmark.circle" : "exclamationmark.triangle" }
}

private struct EmAppearanceKey: EnvironmentKey { static let defaultValue = AppAppearance.system }

extension EnvironmentValues {
    var emAppearance: AppAppearance {
        get { self[EmAppearanceKey.self] }
        set { self[EmAppearanceKey.self] = newValue }
    }

    private func emRGB(_ tone: EmTone) -> UInt32 {
        let rgb: UInt32
        switch (colorScheme == .dark, emAppearance == .paper, tone) {
        case (true, _, .info): rgb = 0x91BCFA
        case (true, _, .good): rgb = 0x80CCA1
        case (true, _, .warn): rgb = 0xF1B76F
        case (true, _, .bad):  rgb = 0xFF9992
        case (_, true, .info): rgb = 0x944923
        case (_, true, .good): rgb = 0x356B48
        case (_, true, .warn): rgb = 0x865407
        case (_, true, .bad):  rgb = 0xA1322C
        case (_, _, .info): rgb = 0x175FA9
        case (_, _, .good): rgb = 0x246644
        case (_, _, .warn): rgb = 0x925100
        case (_, _, .bad):  rgb = 0xA83232
        }
        return rgb
    }

    func emInk(_ tone: EmTone) -> Color {
        let rgb = emRGB(tone)
        return Color(red: Double(rgb >> 16) / 255, green: Double((rgb >> 8) & 255) / 255, blue: Double(rgb & 255) / 255)
    }

    private var emWashOpacity: Double { colorScheme == .dark ? 0.25 : 0.13 }

    func emWash(_ tone: EmTone) -> Color { emInk(tone).opacity(emWashOpacity) }

    /// Apply the same explicit author marks inside published HTML without rewriting source or code samples.
    var emPageScript: String {
        let rgb = emRGB(.info)
        func hex(_ tone: EmTone) -> String { String(format: "#%06X", emRGB(tone)) }
        return #"""
        (() => {
            const wash = 'rgba(\#(rgb >> 16),\#((rgb >> 8) & 255),\#(rgb & 255),\#(emWashOpacity))';
            const style = document.createElement('style');
            style.textContent = 'strong:not(pre *,code *),mark.em-mark{background-color:' + wash + ';color:inherit;font-weight:600}' +
                '.em-num{font-variant-numeric:tabular-nums;color:\#(hex(.info))}.em-num[data-tone=good]{color:\#(hex(.good))}' +
                '.em-state[data-tone=bad],.em-num[data-tone=bad]{color:\#(hex(.bad))}.em-state[data-tone=warn],.em-num[data-tone=warn]{color:\#(hex(.warn))}' +
                '.em-state[data-tone=warn]::before,.em-state[data-tone=bad]::before{content:"⚠︎ ";}';
            document.head.append(style);
            // Older loop reports publish their before/after values as plain table cells.
            if (document.title.endsWith('研究回路汇报')) {
                for (const table of document.querySelectorAll('table')) {
                    const fields = Array.from(table.tHead?.rows[0]?.cells ?? [], cell => cell.textContent.trim());
                    const before = fields.indexOf('R1'), now = fields.indexOf('现在');
                    const state = fields.indexOf('门禁') >= 0 ? fields.indexOf('门禁') : fields.indexOf('判断');
                    if (state < 0) continue;
                    for (const row of table.tBodies[0]?.rows ?? []) {
                        const cell = row.cells[state];
                        if (!cell) continue;
                        const tone = { '阻断':'bad','偏离':'bad','预警':'warn','告警':'warn' }[cell.textContent.trim()];
                        if (tone && !cell.querySelector('.em-state')) { cell.classList.add('em-state'); cell.dataset.tone = tone; }
                        if (before < 0 || now < 0) continue;
                        const previous = row.cells[before], current = row.cells[now];
                        if (!current || !previous || !/^\d+$/.test(current.textContent.trim())) continue;
                        const changed = /^\d+$/.test(previous.textContent.trim()) && previous.textContent.trim() !== current.textContent.trim();
                        if (tone || changed) {
                            const increased = Number(current.textContent.trim()) > Number(previous.textContent.trim());
                            current.classList.add('em-num'); current.dataset.tone = tone ?? (increased ? 'warn' : 'good');
                            if (changed) { const mark = document.createElement('mark'); mark.className = 'em-mark';
                                mark.textContent = current.textContent; current.replaceChildren(mark); }
                        }
                    }
                }
            }
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            const nodes = [];
            while (walker.nextNode()) {
                const n = walker.currentNode;
                if (n.data.includes('**') && !n.parentElement?.closest('script,style,pre,code,textarea,mark,strong,[contenteditable]')) nodes.push(n);
            }
            for (const n of nodes) {
                const pattern = /(\x60+)[\s\S]*?\1|\\.|\*\*([^\s*](?:[\s\S]*?[^\s*])?)\*\*(?!\*)/g;
                const parts = document.createDocumentFragment();
                let end = 0;
                for (const match of n.data.matchAll(pattern)) {
                    if (!match[2] || n.data[match.index - 1] === "*") continue;
                    parts.append(n.data.slice(end, match.index));
                    const mark = document.createElement('mark');
                    mark.className = 'em-mark';
                    mark.textContent = match[2];
                    parts.append(mark);
                    end = match.index + match[0].length;
                }
                if (end) {
                    parts.append(n.data.slice(end));
                    n.replaceWith(parts);
                }
            }
        })();
        """#
    }
}

extension View {
    func emKey() -> some View { fontWeight(.semibold).foregroundStyle(.primary) }

    func emNum(_ tone: EmTone = .info) -> some View {
        modifier(EmInk(tone: tone)).monospacedDigit()
    }

    func emState(_ tone: EmTone?, icon: String? = nil, detail: Bool = false) -> some View {
        modifier(EmState(tone: tone, icon: icon, detail: detail))
    }

    func emBar(_ tone: EmTone?, reserve: Bool = false) -> some View {
        modifier(EmBar(tone: tone, reserve: reserve))
    }

    func emMark(_ tone: EmTone = .info, active: Bool = true) -> some View {
        modifier(EmMark(tone: tone, active: active))
    }
}

private struct EmInk: ViewModifier {
    let tone: EmTone
    @Environment(\.self) var env

    func body(content: Content) -> some View { content.foregroundStyle(env.emInk(tone)) }
}

private struct EmState: ViewModifier {
    let tone: EmTone?, icon: String?, detail: Bool
    @Environment(\.self) var env

    func body(content: Content) -> some View {
        if let tone {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Image(systemName: icon ?? tone.symbol).imageScale(.small).foregroundStyle(env.emInk(tone))
                content.foregroundStyle(detail ? Color.primary : env.emInk(tone))
            }
            .accessibilityElement(children: .combine)
        } else {
            content.foregroundStyle(.secondary)
        }
    }
}

private struct EmBar: ViewModifier {
    let tone: EmTone?, reserve: Bool
    @Environment(\.self) var env

    func body(content: Content) -> some View {
        content.padding(.leading, tone != nil || reserve ? 9 : 0)
            .overlay(alignment: .leading) {
                if let tone {
                    RoundedRectangle(cornerRadius: 1.5).fill(env.emInk(tone)).frame(width: 3)
                        .accessibilityHidden(true).allowsHitTesting(false)
                }
            }
    }
}

private struct EmMark: ViewModifier {
    let tone: EmTone, active: Bool
    @Environment(\.self) var env

    func body(content: Content) -> some View { content.background(active ? env.emWash(tone) : .clear) }
}

/// Applies inline emphasis without changing line breaks, text selection or the surrounding font.
struct EmText: View {
    enum Style { case model, numbers(EmTone), matches([String]), diff }
    let value: String
    let style: Style
    @Environment(\.self) private var env

    init(_ value: String, _ style: Style = .model) { self.value = value; self.style = style }

    var body: some View { Text(Self.render(value, style, env)) }

    private static let numbers = try! NSRegularExpression(pattern: #"[\p{Sc}+−-]?\d+(?:[.,]\d+)*(?:\s*/\s*\d+(?:[.,]\d+)*)?%?"#)
    // Consume code and escapes first so literal operators in a command are never treated as prose.
    private static let marked = try! NSRegularExpression(pattern: #"(?s)(?<!\x60)(\x60+).*?\1(?!\x60)|\\.|(?<!\*)\*\*(?![\s*])(.+?)(?<![\s*])\*\*(?!\*)"#)

    static func render(_ value: String, _ style: Style, _ env: EnvironmentValues) -> AttributedString {
        var result = AttributedString(value)
        switch style {
        case .model:
            guard value.contains("**") else { return result }
            let source = value as NSString
            var end = 0
            result = AttributedString()
            for match in marked.matches(in: value, range: NSRange(location: 0, length: source.length)) where match.range(at: 2).location != NSNotFound {
                result += AttributedString(source.substring(with: NSRange(location: end, length: match.range.location - end)))
                var phrase = AttributedString(source.substring(with: match.range(at: 2)))
                phrase.font = (env.font ?? .body).weight(.semibold)
                phrase.foregroundColor = .primary
                phrase.backgroundColor = env.emWash(.info)
                result += phrase
                end = NSMaxRange(match.range)
            }
            result += AttributedString(source.substring(from: end))
        case .numbers(let tone):
            result.foregroundColor = .secondary
            for match in numbers.matches(in: value, range: NSRange(value.startIndex..., in: value)) {
                guard let range = Range(match.range, in: value), let r = Range(range, in: result) else { continue }
                result[r].foregroundColor = env.emInk(tone)
                result[r].font = (env.font ?? .body).monospacedDigit()
            }
        case .matches(let terms):
            for term in terms where !term.isEmpty {
                var start = value.startIndex
                while let match = value.range(of: term, options: [.caseInsensitive, .diacriticInsensitive], range: start..<value.endIndex),
                      !match.isEmpty {
                    if let r = Range(match, in: result) { result[r].backgroundColor = env.emWash(.info) }
                    start = match.upperBound
                }
            }
        case .diff:
            var payload = false
            result = AttributedString()
            for (i, line) in value.components(separatedBy: "\n").enumerated() {
                if i > 0 { result += AttributedString("\n") }
                var part = AttributedString(line)
                if line.hasPrefix("@@") { payload = true }
                else if line.hasPrefix("diff ") { payload = false }
                else if payload && (line.hasPrefix("+") || line.hasPrefix("-")) {
                    part.backgroundColor = env.emWash(line.hasPrefix("+") ? .good : .bad)
                }
                result += part
            }
        }
        return result
    }
}
