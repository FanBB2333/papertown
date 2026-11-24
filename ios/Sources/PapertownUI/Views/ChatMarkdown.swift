import MarkdownUI
import SwiftUI

/// An agent's reply as Markdown, drawn by MarkdownUI (GitHub Flavored Markdown: headings, lists, task lists, quotes,
/// code blocks, tables, links). A line break in the text stays a line break, as the agents' CLIs show it.
struct ChatMarkdown: View {
    let text: String
    /// On the tint of your own messages: white text, lighter panels.
    var onTint = false

    var body: some View {
        Markdown(text)
            .markdownTheme(onTint ? .chatOnTint : .chat)
            .markdownSoftBreakMode(.lineBreak)
            .textSelection(.enabled)
    }
}

extension MarkdownUI.Theme {
    /// Sized for a chat bubble: headings a step above the text, code and tables in a light panel that scrolls sideways
    /// instead of wrapping.
    static let chat = Theme.basic
        .code {
            FontFamilyVariant(.monospaced)
            FontSize(.em(0.88))
            BackgroundColor(Color.secondary.opacity(0.14))
        }
        .link {
            ForegroundColor(.accentColor)
        }
        .heading1 { configuration in
            configuration.label
                .markdownMargin(top: .em(0.6), bottom: .em(0.4))
                .markdownTextStyle {
                    FontWeight(.bold)
                    FontSize(.em(1.3))
                }
        }
        .heading2 { configuration in
            configuration.label
                .markdownMargin(top: .em(0.6), bottom: .em(0.4))
                .markdownTextStyle {
                    FontWeight(.bold)
                    FontSize(.em(1.18))
                }
        }
        .heading3 { configuration in
            configuration.label
                .markdownMargin(top: .em(0.5), bottom: .em(0.3))
                .markdownTextStyle {
                    FontWeight(.semibold)
                    FontSize(.em(1.08))
                }
        }
        .heading4 { configuration in
            configuration.label
                .markdownMargin(top: .em(0.5), bottom: .em(0.3))
                .markdownTextStyle { FontWeight(.semibold) }
        }
        .heading5 { configuration in
            configuration.label
                .markdownMargin(top: .em(0.5), bottom: .em(0.3))
                .markdownTextStyle { FontWeight(.semibold) }
        }
        .heading6 { configuration in
            configuration.label
                .markdownMargin(top: .em(0.5), bottom: .em(0.3))
                .markdownTextStyle {
                    FontWeight(.semibold)
                    ForegroundColor(.secondary)
                }
        }
        .paragraph { configuration in
            configuration.label
                .fixedSize(horizontal: false, vertical: true)
                .relativeLineSpacing(.em(0.15))
                .markdownMargin(top: .zero, bottom: .em(0.6))
        }
        .listItem { configuration in
            configuration.label.markdownMargin(top: .em(0.2))
        }
        .blockquote { configuration in
            HStack(spacing: 0) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(Color.secondary.opacity(0.4))
                    .frame(width: 3)
                configuration.label
                    .markdownTextStyle { ForegroundColor(.secondary) }
                    .relativePadding(.leading, length: .em(0.7))
            }
            .fixedSize(horizontal: false, vertical: true)
            .markdownMargin(top: .zero, bottom: .em(0.6))
        }
        .codeBlock { configuration in
            ScrollView(.horizontal, showsIndicators: false) {
                configuration.label
                    .fixedSize(horizontal: false, vertical: true)
                    .relativeLineSpacing(.em(0.15))
                    .markdownTextStyle {
                        FontFamilyVariant(.monospaced)
                        FontSize(.em(0.82))
                    }
                    .padding(10)
            }
            .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
            .markdownMargin(top: .zero, bottom: .em(0.6))
        }
        .table { configuration in
            ScrollView(.horizontal, showsIndicators: false) {
                configuration.label
                    .fixedSize(horizontal: false, vertical: true)
                    .markdownTableBorderStyle(.init(color: Color.secondary.opacity(0.3)))
                    .markdownTableBackgroundStyle(.alternatingRows(Color.clear, Color.secondary.opacity(0.06)))
            }
            .markdownMargin(top: .zero, bottom: .em(0.6))
        }
        .tableCell { configuration in
            configuration.label
                .markdownTextStyle {
                    if configuration.row == 0 { FontWeight(.semibold) }
                    FontSize(.em(0.92))
                }
                .fixedSize(horizontal: false, vertical: true)
                .relativeLineSpacing(.em(0.1))
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
        }
        .thematicBreak {
            Divider().markdownMargin(top: .em(0.6), bottom: .em(0.6))
        }

    static let chatOnTint = Theme.chat
        .text {
            ForegroundColor(.white)
        }
        .code {
            FontFamilyVariant(.monospaced)
            FontSize(.em(0.88))
            BackgroundColor(Color.white.opacity(0.2))
        }
        .link {
            ForegroundColor(.white)
            UnderlineStyle(.single)
        }
        .codeBlock { configuration in
            ScrollView(.horizontal, showsIndicators: false) {
                configuration.label
                    .fixedSize(horizontal: false, vertical: true)
                    .relativeLineSpacing(.em(0.15))
                    .markdownTextStyle {
                        FontFamilyVariant(.monospaced)
                        FontSize(.em(0.82))
                    }
                    .padding(10)
            }
            .background(Color.white.opacity(0.16), in: RoundedRectangle(cornerRadius: 8))
            .markdownMargin(top: .zero, bottom: .em(0.6))
        }
        .blockquote { configuration in
            HStack(spacing: 0) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(Color.white.opacity(0.6))
                    .frame(width: 3)
                configuration.label
                    .markdownTextStyle { ForegroundColor(Color.white.opacity(0.85)) }
                    .relativePadding(.leading, length: .em(0.7))
            }
            .fixedSize(horizontal: false, vertical: true)
            .markdownMargin(top: .zero, bottom: .em(0.6))
        }
        .table { configuration in
            ScrollView(.horizontal, showsIndicators: false) {
                configuration.label
                    .fixedSize(horizontal: false, vertical: true)
                    .markdownTableBorderStyle(.init(color: Color.white.opacity(0.4)))
                    .markdownTableBackgroundStyle(.alternatingRows(Color.clear, Color.white.opacity(0.08)))
            }
            .markdownMargin(top: .zero, bottom: .em(0.6))
        }
}
