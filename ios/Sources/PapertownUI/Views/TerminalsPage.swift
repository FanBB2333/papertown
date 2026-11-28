import PapertownCore
import SwiftUI
import TelettyKit

/// A terminal open in the background: an agent's own, or a herdr session the town watches.
struct OpenTerminal: Identifiable {
    /// Also the key of its screen in GET /api/agents/screens.
    let id: String
    let target: ChatTarget
    let role: String
    let name: String
    let project: ProjectRefInfo?
    let bucket: String
    let offline: Bool
    /// The CLI, how it runs and its model.
    let about: String
}

extension TownStore {
    /// Every terminal open now, what needs you first: the agents that run in a terminal, and the herdr sessions.
    var openTerminals: [OpenTerminal] {
        guard let overview else { return [] }
        var out: [OpenTerminal] = []
        func session(_ t: TerminalInfo, _ line: ProjectRefInfo?) -> OpenTerminal {
            OpenTerminal(id: t.id, target: .terminal(t.id), role: "coder", name: t.name ?? t.title, project: line,
                         bucket: t.watch?.bucket ?? "idle", offline: false, about: [t.kind, "herdr"].compactMap { $0 }.joined(separator: " · "))
        }
        for group in overview.groups {
            for a in group.agents {
                guard let term = a.term, term.status != "exited" else { continue }
                let about = [term.provider.map { $0.prefix(1).uppercased() + $0.dropFirst() }, a.runtime, term.model].compactMap { $0 }.joined(separator: " · ")
                out.append(OpenTerminal(id: a.id, target: .agent(a.id), role: a.role,
                                        name: a.task?.title ?? TextFormatters.roleName(a.role, language: language), project: group.line,
                                        bucket: a.effectiveBucket, offline: a.isOffline, about: about))
            }
            for t in group.terminals ?? [] { out.append(session(t, group.line)) }
        }
        for t in overview.others ?? [] { out.append(session(t, nil)) }
        let order = TextFormatters.orderedBuckets
        return out.enumerated().sorted { x, y in
            let a = order.firstIndex(of: x.element.bucket) ?? order.count, b = order.firstIndex(of: y.element.bucket) ?? order.count
            return a == b ? x.offset < y.offset : a < b
        }.map(\.element)
    }
}

extension EmTone {
    /// The colour of an agent's state: working in the tint, what needs you in orange, an error in red.
    static func bucket(_ bucket: String) -> Self? {
        switch bucket {
        case "working": return .info
        case "review": return .good
        default: return issue(bucket)
        }
    }
}

/// Every terminal open in the background side by side, each showing what is on its screen now. A tile opens that
/// terminal, where it takes keys and typing.
struct TerminalsPage: View {
    @EnvironmentObject private var store: TownStore
    @StateObject private var wall = ScreenWallPoller()

    var body: some View {
        let lang = store.language
        let terms = store.openTerminals
        CardPage {
            if terms.isEmpty {
                VStack(spacing: 6) {
                    Image(systemName: "terminal").font(.title2).foregroundStyle(.secondary)
                    Text(lang.string("terminals.empty")).font(.subheadline.weight(.semibold))
                    Text(lang.string("terminals.empty.sub")).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .padding(28)
                .papertownCard()
            } else {
                HStack(spacing: 8) {
                    Text(lang.format("terminals.count", terms.count)).font(.subheadline).foregroundStyle(.secondary)
                    let working = terms.filter { $0.bucket == "working" }.count
                    if working > 0 { StateTag(text: lang.format("terminals.working", working), tone: .info, small: true) }
                    Spacer(minLength: 0)
                }
                if wall.error != nil {
                    Label(lang.string("terminals.unread"), systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .emState(.warn, detail: true)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(DecideTag.wash))
                }
                CardGrid(minimum: 360, maximum: 620) {
                    ForEach(terms) { t in
                        NavigationLink {
                            AgentChatView(target: t.target, role: t.role, subtitle: Self.place(t, lang), onTerminal: true)
                        } label: {
                            TerminalTile(term: t, screen: wall.screens[t.id])
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .navigationTitle(lang.string("terminals.title"))
        .papertownInlineTitle()
        // read again while the page shows; leaving it (or opening a terminal) stops the reads
        .task {
            await wall.run { try await store.fetch { try await $0.screens() } }
        }
    }

    static func place(_ t: OpenTerminal, _ lang: AppLanguage) -> String {
        t.project.map { "#\($0.seq) \(lang.server($0.title))" } ?? lang.string("staff.town_wide")
    }
}

private struct TerminalTile: View {
    let term: OpenTerminal
    let screen: ScreenNow?
    @EnvironmentObject private var store: TownStore

    var body: some View {
        let lang = store.language
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 9) {
                RoleBadgeView(role: term.role, size: 26)
                VStack(alignment: .leading, spacing: 1) {
                    Text(term.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                    Text(TerminalsPage.place(term, lang)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 6)
                StateTag(text: TextFormatters.bucketLabel(term.bucket, offline: term.offline, language: lang), tone: EmTone.bucket(term.bucket))
            }
            .padding(.horizontal, 12)
            .frame(height: 46)
            Rectangle().fill(Hairline.color).frame(height: 1)
            ScreenPreview(screen: screen, labels: lang.terminalLabels)
                .frame(height: 196)
            Rectangle().fill(Hairline.color).frame(height: 1)
            HStack(spacing: 6) {
                Text(term.about).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Spacer(minLength: 6)
                Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 12)
            .frame(height: 32)
        }
        .papertownCard(ring: term.bucket == "needs" ? .warn : (term.bucket == "failed" ? .bad : nil))
        .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}
