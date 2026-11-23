import Foundation

public struct ServerProfile: Codable, Identifiable, Equatable, Hashable, Sendable {
    public let id: UUID
    public var name: String
    public var addressString: String
    public var useBiometrics: Bool

    public init(id: UUID = UUID(), name: String, addressString: String, useBiometrics: Bool = false) {
        self.id = id
        self.name = name
        self.addressString = addressString
        self.useBiometrics = useBiometrics
    }

    public var url: URL? {
        ServerProfile.normalizeURL(addressString)
    }

    public var displayHost: String {
        guard let url, let host = url.host else { return addressString }
        let port = url.port.map { ":\($0)" } ?? ""
        let path = url.path == "/" ? "" : url.path
        return "\(host)\(port)\(path)"
    }

    public var isLocalAddress: Bool {
        guard let host = url?.host?.lowercased() else { return false }
        if host == "localhost" || host == "127.0.0.1" || host == "::1" || host.hasSuffix(".local") {
            return true
        }
        if host.hasPrefix("192.168.") || host.hasPrefix("10.") { return true }
        if host.hasPrefix("172.") {
            let parts = host.split(separator: ".")
            if parts.count >= 2, let second = Int(parts[1]), (16...31).contains(second) {
                return true
            }
        }
        return false
    }

    public var routeSymbol: String {
        if isLocalAddress { return "wifi" }
        if url?.scheme?.lowercased() == "https" { return "lock.shield" }
        return "globe"
    }

    public static func normalizeURL(_ raw: String) -> URL? {
        var trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        while trimmed.hasSuffix("/") && trimmed.count > 8 {
            trimmed.removeLast()
        }
        guard let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              ["http", "https"].contains(scheme),
              let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil else {
            return nil
        }
        return url
    }
}

public final class ProfileStore {
    private let defaults: UserDefaults
    private let profilesKey = "papertown.ios.servers.v1"
    private let selectedKey = "papertown.ios.selectedServer.v1"
    private let languageKey = "papertown.ios.language.v1"
    private let appearanceKey = "papertown.ios.appearance.v1"

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func loadProfiles() -> [ServerProfile] {
        guard let data = defaults.data(forKey: profilesKey),
              let list = try? JSONDecoder().decode([ServerProfile].self, from: data) else {
            return []
        }
        return list
    }

    public func saveProfiles(_ profiles: [ServerProfile]) {
        if let data = try? JSONEncoder().encode(profiles) {
            defaults.set(data, forKey: profilesKey)
        }
    }

    public func loadSelectedID() -> UUID? {
        guard let raw = defaults.string(forKey: selectedKey) else { return nil }
        return UUID(uuidString: raw)
    }

    public func saveSelectedID(_ id: UUID?) {
        if let id {
            defaults.set(id.uuidString, forKey: selectedKey)
        } else {
            defaults.removeObject(forKey: selectedKey)
        }
    }

    public func loadLanguage() -> AppLanguage {
        guard let raw = defaults.string(forKey: languageKey),
              let lang = AppLanguage(rawValue: raw) else {
            return .english
        }
        return lang
    }

    public func saveLanguage(_ language: AppLanguage) {
        defaults.set(language.rawValue, forKey: languageKey)
    }

    public func loadAppearance() -> AppAppearance {
        guard let raw = defaults.string(forKey: appearanceKey),
              let app = AppAppearance(rawValue: raw) else {
            return .system
        }
        return app
    }

    public func saveAppearance(_ appearance: AppAppearance) {
        defaults.set(appearance.rawValue, forKey: appearanceKey)
    }
}
