import Foundation
import PapertownCore
import SwiftUI

public enum TextFormatters {
    public static let orderedStages = ["idea", "hatch", "team", "method", "exp", "write", "review", "ship"]
    public static let orderedBuckets = ["needs", "failed", "review", "working", "idle", "off"]

    public static func stageName(_ key: String, language: AppLanguage) -> String {
        let map = "stage.\(key)"
        let localized = language.string(map)
        return localized == map ? key : localized
    }

    public static func stageStatus(_ status: String, language: AppLanguage) -> String {
        let key = "stage.status.\(status)"
        let localized = language.string(key)
        return localized == key ? status : localized
    }

    public static func roleName(_ role: String, language: AppLanguage) -> String {
        let key = "role.\(role)"
        let localized = language.string(key)
        return localized == key ? role : localized
    }

    public static func roleSymbol(_ role: String) -> String {
        switch role {
        case "lead": return "cpu"
        case "coder": return "chevron.left.forwardslash.chevron.right"
        case "writer": return "doc.text"
        case "monitor": return "eye"
        case "assistant": return "sparkles"
        default: return "person.crop.circle"
        }
    }

    public static func roleTint(_ role: String) -> Color {
        switch role {
        case "lead": return .blue
        case "coder": return .green
        case "writer": return .indigo
        case "monitor": return .orange
        case "assistant": return .purple
        default: return .secondary
        }
    }

    public static func leadStateLabel(_ state: String, language: AppLanguage) -> String {
        let key = "lead.state.\(state)"
        let localized = language.string(key)
        return localized == key ? state : localized
    }

    public static func leadStateColor(_ state: String) -> Color {
        switch state {
        case "running": return .green
        case "starting": return .blue
        case "blocked": return .red
        case "off", "ended": return .secondary
        default: return .secondary
        }
    }

    public static func leadDetail(
        state: String,
        note: String?,
        runtime: String?,
        model: String?,
        status: String?,
        sample: Bool,
        language: AppLanguage
    ) -> String {
        switch state {
        case "running":
            let statusWord: String? = switch status {
            case "working": language.string("bucket.working")
            case "idle": language.string("bucket.idle")
            default: status
            }
            let parts = [runtime, model, statusWord].compactMap { $0?.isEmpty == false ? $0 : nil }
            return parts.isEmpty ? language.string("lead.state.running") : parts.joined(separator: " · ")
        case "starting":
            return language.string("lead.detail.starting")
        case "blocked":
            if let note, !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return note
            }
            return language.string("lead.detail.blocked_fallback")
        case "off":
            return language.string(sample ? "lead.detail.off_sample" : "lead.detail.off")
        case "ended":
            return language.string("lead.detail.ended")
        default:
            return note ?? state
        }
    }

    public static func bucketLabel(_ bucket: String, offline: Bool = false, language: AppLanguage) -> String {
        if bucket == "off" && offline {
            return language.string("bucket.offline")
        }
        let key = "bucket.\(bucket)"
        let localized = language.string(key)
        return localized == key ? bucket : localized
    }

    public static func bucketColor(_ bucket: String) -> Color {
        switch bucket {
        case "needs": return .orange
        case "failed": return .red
        case "review": return .blue
        case "working": return .green
        default: return .secondary
        }
    }

    public static func deliveryModeLabel(_ mode: DeliveryMode, language: AppLanguage) -> String {
        language.string("chat.mode.\(mode.rawValue)")
    }

    public static func deliveryModePlaceholder(_ mode: DeliveryMode, language: AppLanguage) -> String {
        language.string("chat.mode.\(mode.rawValue).placeholder")
    }

    public static func deliveryModeHint(_ mode: DeliveryMode, language: AppLanguage) -> String {
        language.string("chat.mode.\(mode.rawValue).hint")
    }

    public static func stripMarkdown(_ text: String?) -> String {
        guard var value = text, !value.isEmpty else { return "" }
        value = value.replacingOccurrences(of: "\r\n", with: "\n")
        let lines = value.split(separator: "\n", omittingEmptySubsequences: true)
        guard let first = lines.first else { return "" }
        var line = String(first).trimmingCharacters(in: .whitespaces)
        while line.hasPrefix("#") { line.removeFirst() }
        line = line.trimmingCharacters(in: .whitespaces)
        line = line.replacingOccurrences(of: "**", with: "")
        line = line.replacingOccurrences(of: "__", with: "")
        line = line.replacingOccurrences(of: "`", with: "")
        return line
    }

    public static func relativeTime(from isoString: String?, now: Date = Date(), language: AppLanguage) -> String {
        guard let isoString, let date = parseISO8601(isoString) else { return "" }
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        if seconds < 60 { return language.string("time.just_now") }
        let minutes = seconds / 60
        if minutes < 60 { return language.format("time.minutes_ago", minutes) }
        let hours = minutes / 60
        if hours < 24 { return language.format("time.hours_ago", hours) }
        let days = hours / 24
        return language.format("time.days_ago", days)
    }

    public static func shortClockTime(from isoString: String?) -> String {
        guard let isoString, let date = parseISO8601(isoString) else { return "" }
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: date)
    }

    public static func parseISO8601(_ value: String) -> Date? {
        let withFrac = ISO8601DateFormatter()
        withFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = withFrac.date(from: value) { return d }
        let basic = ISO8601DateFormatter()
        basic.formatOptions = [.withInternetDateTime]
        return basic.date(from: value)
    }

    public static func errorMessage(for error: Error, language: AppLanguage) -> String {
        if let clientError = error as? ClientError {
            switch clientError {
            case .invalidAddress:
                return language.string("error.invalid_address")
            case .invalidRoute:
                return language.string("error.invalid_route")
            case .invalidResponse:
                return language.string("error.invalid_response")
            case .http(let status, let detail):
                switch status {
                case 401:
                    return language.string("error.unauthorized")
                case 403:
                    return language.string("error.forbidden")
                case 404:
                    return language.string("error.not_found")
                case 502, 503, 504:
                    return language.string("error.relay_unavailable")
                default:
                    if let detail, !detail.isEmpty { return detail }
                    return language.format("error.http_generic", status)
                }
            }
        }
        if let urlError = error as? URLError {
            switch urlError.code {
            case .notConnectedToInternet:
                return language.string("error.no_internet")
            case .appTransportSecurityRequiresSecureConnection:
                return language.string("error.ats_blocked")
            case .cannotConnectToHost, .cannotFindHost, .timedOut, .dnsLookupFailed, .networkConnectionLost:
                return language.string("error.cannot_connect")
            default:
                return language.string("error.unknown")
            }
        }
        return language.string("error.unknown")
    }
}
