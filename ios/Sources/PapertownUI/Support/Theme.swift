import SwiftUI

public enum AppAppearance: String, CaseIterable, Identifiable, Sendable {
    case system
    case light
    case dark
    case paper

    public var id: String { rawValue }

    public var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light, .paper: return .light
        case .dark: return .dark
        }
    }

    public var tintColor: Color {
        switch self {
        case .paper:
            return Color(red: 0.65, green: 0.29, blue: 0.16)
        default:
            return .accentColor
        }
    }

    public var groupedBackground: Color? {
        switch self {
        case .paper:
            return Color(red: 0.96, green: 0.945, blue: 0.91)
        default:
            return nil
        }
    }

    public var rowBackground: Color? {
        switch self {
        case .paper:
            return Color(red: 1.0, green: 0.992, blue: 0.973)
        default:
            return nil
        }
    }
}

public extension View {
    @ViewBuilder
    func papertownListAppearance(_ appearance: AppAppearance) -> some View {
        if let bg = appearance.groupedBackground {
            self
                .scrollContentBackground(.hidden)
                .background(bg)
        } else {
            self
        }
    }

    @ViewBuilder
    func papertownRowBackground(_ appearance: AppAppearance) -> some View {
        if let bg = appearance.rowBackground {
            self.listRowBackground(bg)
        } else {
            self
        }
    }
}

/// Native iOS 17+ ContentUnavailableView with a clean iOS 16 fallback.
struct EmptyStateView: View {
    let title: String
    let systemImage: String
    let description: String
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil

    var body: some View {
        if #available(iOS 17.0, macOS 14.0, *) {
            ContentUnavailableView {
                Label(title, systemImage: systemImage)
            } description: {
                Text(description)
            } actions: {
                if let actionTitle, let action {
                    Button(actionTitle, action: action)
                        .buttonStyle(.borderedProminent)
                }
            }
        } else {
            VStack(spacing: 10) {
                Image(systemName: systemImage)
                    .font(.system(size: 32, weight: .regular))
                    .foregroundStyle(.secondary)
                Text(title)
                    .font(.headline)
                Text(description)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                if let actionTitle, let action {
                    Button(actionTitle, action: action)
                        .buttonStyle(.borderedProminent)
                        .padding(.top, 4)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 28)
            .padding(.horizontal, 20)
        }
    }
}
