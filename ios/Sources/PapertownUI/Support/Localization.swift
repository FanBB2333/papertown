import Foundation
import SwiftUI

/// Primary UI language is English (`en`), with Simplified Chinese (`zh-Hans`) as an optional secondary language.
public enum AppLanguage: String, CaseIterable, Identifiable, Sendable {
    case english = "en"
    case simplifiedChinese = "zh-Hans"
    case system = "system"

    public var id: String { rawValue }

    public var resolvedCode: String {
        switch self {
        case .english:
            return "en"
        case .simplifiedChinese:
            return "zh-Hans"
        case .system:
            let preferred = Locale.preferredLanguages.first?.lowercased() ?? "en"
            return preferred.hasPrefix("zh") ? "zh-Hans" : "en"
        }
    }

    public var locale: Locale {
        Locale(identifier: resolvedCode)
    }

    public var bundle: Bundle {
        // SwiftPM's native builder lowercases localization directories; Xcode preserves their names.
        let code = resolvedCode
        guard let path = Bundle.module.path(forResource: code, ofType: "lproj") ?? Bundle.module.path(forResource: code.lowercased(), ofType: "lproj"),
              let lproj = Bundle(path: path) else {
            return .module
        }
        return lproj
    }

    public func string(_ key: String) -> String {
        let value = bundle.localizedString(forKey: key, value: nil, table: nil)
        if value != key { return value }
        // Fallback to English development language.
        if let enPath = Bundle.module.path(forResource: "en", ofType: "lproj"),
           let enBundle = Bundle(path: enPath) {
            return enBundle.localizedString(forKey: key, value: key, table: nil)
        }
        return key
    }

    public func format(_ key: String, _ args: CVarArg...) -> String {
        String(format: string(key), locale: locale, arguments: args)
    }
}
