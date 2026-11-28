import PapertownCore
import SwiftUI

/// A project as a card, after the web's progress page: its number and title, its state and health as capsules, the
/// stages, where it stands, the lead's summary, what waits on you under the one filled tag, and the lead along the
/// bottom. A project that waits on you has an orange edge.
struct ProjectCard: View {
    let project: ProjectSnapshot
    var query = ""
    @EnvironmentObject private var store: TownStore
    @Environment(\.self) private var env

    var body: some View {
        let lang = store.language
        let view = store.cards[project.id]
        let card = view?.card
        let decisions = store.decisions(project.id)
        let blocked = project.lead.state == "blocked" || card?.health == "blocked"
        let untitled = project.title.isEmpty || project.title == project.idea
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text("#\(project.seq)").font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
                EmText(untitled ? project.idea : lang.server(project.title), .matches([query]))
                    .font(.headline)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }
            HStack(spacing: 6) {
                StateTag(text: Self.status(project.status, lang), tone: Self.statusTone(project.status))
                if project.sample { StateTag(text: lang.string("projects.sample"), dot: false, outlined: true) }
                Spacer(minLength: 4)
                if let health = card?.health, !health.isEmpty {
                    StateTag(text: lang.string("health.\(health)"), tone: health == "ok" ? .good : EmTone.issue(health))
                }
            }
            StageTrackView(
                stages: project.stages,
                fallbackIndex: TextFormatters.orderedStages.firstIndex(of: project.stage) ?? 0,
                blocked: blocked
            )
            HStack(spacing: 5) {
                Text(project.isDone ? lang.string("stage.complete") : "\(TextFormatters.stageName(project.stage, language: lang)) · \(project.pct)%")
                    .foregroundStyle(.secondary)
                if let hard = view?.checks?.hard, hard.fail > 0 {
                    Text("·").foregroundStyle(.secondary)
                    Text(lang.format("projects.hard_failed", hard.fail)).fontWeight(.medium).foregroundStyle(env.emInk(.bad))
                }
                Spacer(minLength: 0)
            }
            .font(.caption)
            .lineLimit(1)
            if let summary = card?.summary, !summary.isEmpty {
                EmText(lang.server(summary))
                    .font(.subheadline)
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let first = decisions.first {
                HStack(alignment: .top, spacing: 8) {
                    DecideTag(title: lang.string("decide.title"), count: decisions.count)
                    Text(lang.server(first.title))
                        .font(.footnote)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(7)
                .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(DecideTag.wash))
            }
            Spacer(minLength: 0)
            Rectangle().fill(Hairline.color).frame(height: 1)
            HStack(spacing: 7) {
                Text(lang.string("home.lead")).font(.caption).foregroundStyle(.secondary)
                let lead = project.lead.on ? project.lead.state : "off"
                StateTag(text: TextFormatters.leadStateLabel(lead, language: lang), tone: Self.leadTone(lead), small: true)
                Spacer(minLength: 4)
                let when = TextFormatters.relativeTime(from: card?.at ?? project.updatedAt, language: lang)
                if !when.isEmpty { Text(when).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(.tertiary)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .papertownCard(ring: decisions.isEmpty ? (blocked ? .bad : nil) : .warn)
        .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private static func status(_ status: String, _ lang: AppLanguage) -> String {
        let key = "project.status.\(status)", name = lang.string(key)
        return name == key ? status : name
    }

    private static func statusTone(_ status: String) -> EmTone? {
        switch status {
        case "running": return .info
        case "done": return .good
        case "dropped": return nil
        default: return EmTone.issue(status)
        }
    }

    private static func leadTone(_ state: String) -> EmTone? {
        switch state {
        case "running": return .good
        case "starting": return .info
        default: return EmTone.issue(state)
        }
    }
}
