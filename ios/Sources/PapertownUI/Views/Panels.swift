import PapertownCore
import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
#endif

// What the pages are built from, the same on iPhone, iPad and the Mac, after the web's pages (docs/ui_emphasis.md):
// a card standing on the page, a panel with a title bar, a capsule that names a state, the one filled tag for what
// waits on you, and a scrolling page that lays its cards out in as many columns as fit.

extension AppAppearance {
    /// A card standing on the page.
    var cardBackground: Color {
        if let paper = rowBackground { return paper }
        #if os(iOS)
        return Color(uiColor: .secondarySystemGroupedBackground)
        #else
        return Color(nsColor: .controlBackgroundColor)
        #endif
    }
}

/// The hairline round a card and between its parts.
enum Hairline {
    static let color = Color.primary.opacity(0.09)
}

// MARK: - States

extension EnvironmentValues {
    /// A state's colour on a tag. Orange stays orange here (the ink for running words is darker, and reads brown
    /// at a tag's size): the same pair as the web's.
    func tagInk(_ tone: EmTone) -> Color {
        guard tone == .warn, emAppearance != .paper else { return emInk(tone) }
        return colorScheme == .dark ? Color(red: 1.0, green: 0.70, blue: 0.25) : Color(red: 0.72, green: 0.42, blue: 0.0)
    }

    func tagWash(_ tone: EmTone) -> Color { tagInk(tone).opacity(colorScheme == .dark ? 0.24 : 0.14) }
}

/// A state as a capsule: a dot and a word in the state's colour on a wash of it. In a list, a card or a title bar a
/// state is always one of these, at the end of its row, never a coloured word.
struct StateTag: View {
    let text: String
    /// Nil is the quiet grey of a state that asks for nothing.
    var tone: EmTone? = nil
    var dot = true
    /// A grey outline with no fill: a kind (a sample project), not a state.
    var outlined = false
    var small = false
    @Environment(\.self) private var env

    var body: some View {
        let ink = tone.map { env.tagInk($0) } ?? Color.secondary
        HStack(spacing: 5) {
            if dot { Circle().fill(ink).frame(width: 6, height: 6) }
            Text(text).font((small ? Font.caption2 : Font.caption).weight(.medium)).lineLimit(1)
        }
        .foregroundStyle(ink)
        .padding(.horizontal, small ? 7 : 8)
        .padding(.vertical, small ? 2 : 3)
        .background(Capsule().fill(outlined ? Color.clear : (tone.map { env.tagWash($0) } ?? Color.primary.opacity(0.07))))
        .overlay(Capsule().stroke(outlined ? Color.primary.opacity(0.16) : Color.clear, lineWidth: 1))
        .fixedSize()
    }
}

/// 「待你决定」: the one filled tag, for what waits on the user. At most one to a card.
struct DecideTag: View {
    let title: String
    var count = 0

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "bell.fill").font(.system(size: 9, weight: .bold))
            Text(title).font(.caption.weight(.semibold))
            if count > 1 {
                Text("\(count)").font(.caption2.weight(.bold).monospacedDigit())
                    .padding(.horizontal, 4)
                    .background(Capsule().fill(Color.white.opacity(0.28)))
            }
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Self.fill))
        .fixedSize()
    }

    /// An orange deep enough for white words on it.
    static let fill = Color(red: 0.90, green: 0.45, blue: 0.05)
    /// The same orange as a wash, under the words that go with the tag.
    static let wash = fill.opacity(0.13)
}

// MARK: - Cards and panels

private struct CardLook: ViewModifier {
    var ring: EmTone? = nil
    var radius: CGFloat = 14
    @EnvironmentObject private var store: TownStore
    @Environment(\.self) private var env

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        content
            .background(shape.fill(store.appearance.cardBackground))
            .clipShape(shape)
            // orange stays orange round what waits on you: the ink for words would turn it brown
            .overlay(shape.stroke(ring.map { $0 == .warn ? DecideTag.fill.opacity(0.62) : env.emInk($0).opacity(0.55) } ?? Hairline.color, lineWidth: 1))
    }
}

extension View {
    /// A card on the page; `ring` draws its edge in a state's colour (orange round what waits on you).
    func papertownCard(ring: EmTone? = nil, radius: CGFloat = 14) -> some View {
        modifier(CardLook(ring: ring, radius: radius))
    }
}

/// A section of a page: a card with a title bar (the symbol on a tile of the tint, the name, what belongs to the whole
/// section on the right) and its content under a hairline. `tone` washes the bar and rings the card, for 待你决定.
struct Panel<Trailing: View, Content: View>: View {
    let title: String
    let symbol: String
    var tone: EmTone? = nil
    var padded = true
    @ViewBuilder var trailing: () -> Trailing
    @ViewBuilder var content: () -> Content
    @Environment(\.self) private var env

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 9) {
                Image(systemName: symbol)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(tone.map { env.emInk($0) } ?? env.emInk(.info))
                    .frame(width: 24, height: 24)
                    .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(env.emWash(tone ?? .info)))
                Text(title).font(.subheadline.weight(.semibold)).lineLimit(1)
                Spacer(minLength: 8)
                trailing()
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 44)
            .background(tone.map { $0 == .warn ? DecideTag.wash : env.emWash($0).opacity(0.6) } ?? Color.primary.opacity(0.03))
            Rectangle().fill(Hairline.color).frame(height: 1)
            content()
                .padding(padded ? 14 : 0)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .papertownCard(ring: tone)
    }
}

extension Panel where Trailing == EmptyView {
    init(title: String, symbol: String, tone: EmTone? = nil, padded: Bool = true, @ViewBuilder content: @escaping () -> Content) {
        self.init(title: title, symbol: symbol, tone: tone, padded: padded, trailing: { EmptyView() }, content: content)
    }
}

/// The title over a section of a list: the same parts as a panel's title bar (the symbol on a tile of the tint, the
/// name in the text colour, what belongs to the whole section on the right), standing on the page above its group.
struct SectionTitle<Trailing: View>: View {
    let title: String
    let symbol: String
    var tone: EmTone? = nil
    @ViewBuilder var trailing: () -> Trailing
    @Environment(\.self) private var env

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: symbol)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(tone == .warn ? DecideTag.fill : env.emInk(tone ?? .info))
                .frame(width: 22, height: 22)
                .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(tone == .warn ? DecideTag.wash : env.emWash(tone ?? .info)))
            Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Color.primary).lineLimit(1)
            Spacer(minLength: 8)
            trailing().font(.caption)
        }
        .textCase(nil)
        .padding(.bottom, 2)
    }
}

extension SectionTitle where Trailing == EmptyView {
    init(title: String, symbol: String, tone: EmTone? = nil) {
        self.init(title: title, symbol: symbol, tone: tone, trailing: { EmptyView() })
    }
}

// MARK: - Pages

/// A scrolling page of cards and panels on the page's colour, its content no wider than `width` and in the middle of
/// what is wider. The cards inside choose their own columns (CardGrid).
struct CardPage<Content: View>: View {
    var width: CGFloat = 1480
    @ViewBuilder var content: () -> Content
    @EnvironmentObject private var store: TownStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) { content() }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 28)
                .frame(maxWidth: width, alignment: .leading)
                .frame(maxWidth: .infinity)
        }
        .background((store.appearance.groupedBackground ?? Color.clear).ignoresSafeArea())
    }
}

/// Cards side by side, as many columns as fit at `minimum` each: one on an iPhone, two or three on an iPad, more in a
/// wide window. Each row is as tall as its tallest card.
struct CardGrid<Content: View>: View {
    var minimum: CGFloat = 320
    var maximum: CGFloat = 620
    var spacing: CGFloat = 14
    @ViewBuilder var content: () -> Content

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: minimum, maximum: maximum), spacing: spacing, alignment: .top)], alignment: .leading, spacing: spacing) {
            content()
        }
    }
}
