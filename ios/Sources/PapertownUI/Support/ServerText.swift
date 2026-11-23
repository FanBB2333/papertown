import Foundation

/// Puts the Chinese text the server sends (stage names, notes, reports, check titles) into English when the app is in
/// English, with the web's dictionary (Resources/server-en.json, copied from web/src/i18n/en.json by
/// scripts/sync-server-text.sh). The same steps as `english()` in web/src/i18n.ts: the whole string, then templates such as
/// "{0} 个项目进行中", lines, runs of sentences, separators, "（…）", "label：text", and word by word.
/// Text it cannot place stays as the server wrote it.
public enum ServerText {
    private static let dict: [String: String] = {
        guard let url = Bundle.module.url(forResource: "server-en", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let map = try? JSONDecoder().decode([String: String].self, from: data) else { return [:] }
        return map
    }()

    private struct Pattern { let re: NSRegularExpression; let en: String; let length: Int }

    /// The dictionary's Chinese keys, shortest first, for finding the full text of a cut-short title.
    private static let keysByLength: [String] = dict.keys.filter { hasCJK($0) }.sorted { $0.count < $1.count }

    private static let patterns: [Pattern] = {
        var out: [Pattern] = []
        let slot = try! NSRegularExpression(pattern: #"\{(\d+)\}"#)
        for (key, en) in dict where key.contains("{") {
            let ns = key as NSString
            let marks = slot.matches(in: key, range: NSRange(location: 0, length: ns.length))
            guard !marks.isEmpty else { continue }
            let fixed = slot.stringByReplacingMatches(in: key, range: NSRange(location: 0, length: ns.length), withTemplate: "")
                .filter { !$0.isWhitespace }
            guard fixed.count >= 3, hasCJK(fixed) else { continue }
            var src = "^", order: [Int] = [], at = 0
            for (i, m) in marks.enumerated() {
                src += NSRegularExpression.escapedPattern(for: ns.substring(with: NSRange(location: at, length: m.range.location - at)))
                order.append(Int(ns.substring(with: m.range(at: 1))) ?? 0)
                let end = m.range.location + m.range.length
                let adjacent = i + 1 < marks.count && marks[i + 1].range.location == end
                // "{0}{1}": the first of two adjacent values is a whole sentence, or empty
                src += adjacent ? #"((?:[\s\S]*?[。！？；.!?])?)"# : #"([\s\S]*?)"#
                at = end
            }
            src += NSRegularExpression.escapedPattern(for: ns.substring(from: at)) + "$"
            guard let re = try? NSRegularExpression(pattern: src) else { continue }
            // the English template numbers its values in the order they appear in the Chinese one
            var target = en
            for (pos, n) in order.enumerated() { target = target.replacingOccurrences(of: "{\(n)", with: "{#\(pos)") }
            target = target.replacingOccurrences(of: "{#", with: "{")
            out.append(Pattern(re: re, en: target, length: src.count))
        }
        return out.sorted { $0.length > $1.length }
    }()

    private static var cache: [String: String] = [:]
    private static let lock = NSLock()

    static func hasCJK(_ s: String) -> Bool {
        s.unicodeScalars.contains { (0x4E00...0x9FFF).contains($0.value) || (0x3400...0x4DBF).contains($0.value) }
    }

    /// The text for the chosen language: as written for Chinese, translated for English.
    public static func localized(_ s: String?, _ language: AppLanguage) -> String {
        guard let s, !s.isEmpty else { return s ?? "" }
        guard language.resolvedCode == "en", hasCJK(s) else { return s }
        lock.lock(); defer { lock.unlock() }
        if let hit = cache[s] { return hit }
        let v = english(s, depth: 0)
        if cache.count > 5000 { cache.removeAll() }
        cache[s] = v
        return v
    }

    // {0}, {1}… are the arguments; {0|paper|papers} picks a word by the number in {0}
    static func fill(_ template: String, _ args: [String]) -> String {
        guard !args.isEmpty, let re = try? NSRegularExpression(pattern: #"\{(\d+)(?:\|([^|{}]*)\|([^|{}]*))?\}"#) else { return template }
        let ns = template as NSString
        var out = "", at = 0
        for m in re.matches(in: template, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: at, length: m.range.location - at))
            let i = Int(ns.substring(with: m.range(at: 1))) ?? 0
            if i >= args.count {
                out += ns.substring(with: m.range)
            } else if m.range(at: 2).location != NSNotFound {
                out += Double(args[i]) == 1 ? ns.substring(with: m.range(at: 2)) : ns.substring(with: m.range(at: 3))
            } else {
                out += args[i]
            }
            at = m.range.location + m.range.length
        }
        return out + ns.substring(from: at)
    }

    private static func direct(_ s: String, depth: Int) -> String? {
        if let hit = dict[s] { return hit }
        let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed != s, let hit = dict[trimmed] { return s.replacingOccurrences(of: trimmed, with: hit) }
        let ns = s as NSString
        for p in patterns {
            guard let m = p.re.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { continue }
            let args = (1..<m.numberOfRanges).map { k -> String in
                let r = m.range(at: k)
                let v = r.location == NSNotFound ? "" : ns.substring(with: r)
                return hasCJK(v) ? english(v, depth: depth + 1) : v
            }
            return fill(p.en, args)
        }
        return nil
    }

    private static let punct: [Character: String] = ["；": "; ", "、": ", ", "：": ": ", "，": ", ", "。": ". ", "（": " (", "）": ")", "「": "“", "」": "”"]

    private static func english(_ s: String, depth: Int) -> String {
        if depth > 3 || s.count > 400 { return dict[s] ?? s }
        if let whole = direct(s, depth: depth) { return whole }
        let sub: (String) -> String = { hasCJK($0) ? english($0, depth: depth + 1) : $0 }
        // a title the server cut short: the dictionary's full entry, cut short in English
        if s.hasSuffix("…"), s.count > 12 {
            let head = String(s.dropLast())
            if let full = keysByLength.first(where: { $0.count > s.count && $0.hasPrefix(head) }), let en = dict[full] {
                return en.count > 40 ? String(en.prefix(39)).trimmingCharacters(in: .whitespaces) + "…" : en
            }
        }
        if s.contains("\n") { return s.components(separatedBy: "\n").map(sub).joined(separator: "\n") }
        let sentences = splitSentences(s)
        if sentences.count > 1 {
            var out: [String] = [], i = 0, changed = false
            while i < sentences.count {
                var j = sentences.count, hit: String? = nil
                while j > i + 1, hit == nil {
                    hit = direct(sentences[i..<j].joined(), depth: depth)
                    if hit == nil { j -= 1 }
                }
                if hit == nil { hit = sub(sentences[i]); j = i + 1 }
                if hit != sentences[i..<j].joined() { changed = true }
                out.append(hit!.trimmingCharacters(in: .whitespaces))
                i = j
            }
            // nothing translated: keep the Chinese as written rather than respaced
            return changed ? out.joined(separator: " ") : s
        }
        for sep in [" · ", "；", "、"] where s.contains(sep) {
            return s.components(separatedBy: sep).map(sub).joined(separator: punct[sep.first!] ?? sep)
        }
        if s.hasPrefix("（"), s.hasSuffix("）"), s.count > 2 { return "(\(sub(String(s.dropFirst().dropLast()))))" }
        if let colon = s.firstIndex(of: "："), colon != s.startIndex, s.index(after: colon) != s.endIndex {
            return "\(sub(String(s[..<colon]))): \(sub(String(s[s.index(after: colon)...])))"
        }
        // word by word, when every Chinese run is in the dictionary
        var runs: [String] = [], cur = ""
        for ch in s {
            if hasCJK(String(ch)) { cur.append(ch) } else if !cur.isEmpty { runs.append(cur); cur = "" }
        }
        if !cur.isEmpty { runs.append(cur) }
        if !runs.isEmpty, runs.allSatisfy({ dict[$0] != nil }) {
            var out = "", run = ""
            for ch in s {
                if hasCJK(String(ch)) { run.append(ch); continue }
                if !run.isEmpty { out += dict[run]!; run = "" }
                out += punct[ch] ?? String(ch)
            }
            if !run.isEmpty { out += dict[run]! }
            return out.trimmingCharacters(in: .whitespaces)
        }
        return s
    }

    private static func splitSentences(_ s: String) -> [String] {
        var out: [String] = [], cur = ""
        for ch in s {
            cur.append(ch)
            if "。！？".contains(ch) { out.append(cur); cur = "" }
        }
        if !cur.trimmingCharacters(in: .whitespaces).isEmpty { out.append(cur) }
        return out.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    }
}

extension AppLanguage {
    /// Server text in this language.
    func server(_ s: String?) -> String { ServerText.localized(s, self) }
}
