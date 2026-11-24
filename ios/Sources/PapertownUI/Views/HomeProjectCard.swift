import SwiftUI

/// A project on the home page: its number and title with how it is doing, the stages, the lead's summary and the next
/// milestone, then a status line of what is going on: the lead, the checks, the first metrics, runs, what waits on you,
/// the code and paper repositories and when it last changed. The status line wraps to a second line where it does not
/// fit. The sidebar lists no projects, so this is where they show.
struct HomeProjectCard: View {
    let project: ProjectSnapshot
    let card: ProjectCardView?
    @EnvironmentObject private var store: TownStore

    var body: some View {
        let lang = store.language
        let progress = card?.card
        let blocked = project.lead.state == "blocked" || progress?.health == "blocked"
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("#\(project.seq)")
                    .font(.subheadline.weight(.semibold).monospacedDigit())
                    .foregroundStyle(.secondary)
                Text(lang.server(project.title.isEmpty ? project.idea : project.title))
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2)
                Spacer(minLength: 4)
                if let health = progress?.health, !health.isEmpty {
                    HStack(spacing: 3) {
                        Image(systemName: Tone.symbol(health))
                        Text(lang.string("health.\(health)"))
                    }
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Tone.color(health))
                    .fixedSize()
                }
            }
            HStack(spacing: 8) {
                StageTrackView(
                    stages: project.stages,
                    fallbackIndex: TextFormatters.orderedStages.firstIndex(of: project.stage) ?? 0,
                    blocked: blocked
                )
                Text("\(TextFormatters.stageName(project.stage, language: lang)) · \(project.pct)%")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(blocked ? Color.red : Color.secondary)
                    .fixedSize()
            }
            if let summary = progress?.summary, !summary.isEmpty {
                Text(lang.server(summary))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            if let milestone = progress?.milestone, !milestone.isEmpty {
                HStack(spacing: 5) {
                    Image(systemName: "flag.checkered")
                    Text(lang.server(milestone)).lineLimit(1)
                }
                .font(.caption)
                .foregroundStyle(Color.purple)
            }
            ChipFlow(spacing: 10, lineSpacing: 4) { statusLine(lang) }
                .font(.system(size: 11, weight: .medium, design: .monospaced))
        }
        .padding(.vertical, 4)
    }

    private static let muted = Color.gray

    @ViewBuilder
    private func statusLine(_ lang: AppLanguage) -> some View {
        let lead = project.lead.on ? project.lead.state : "off"
        HStack(spacing: 4) {
            Circle().fill(TextFormatters.leadStateColor(lead)).frame(width: 6, height: 6)
            Text(lang.string("home.lead")).foregroundStyle(Self.muted)
            Text(TextFormatters.leadStateLabel(lead, language: lang)).foregroundStyle(TextFormatters.leadStateColor(lead))
        }
        if let hard = card?.checks?.hard, hard.total > 0 {
            HStack(spacing: 4) {
                Text(lang.string("home.checks")).foregroundStyle(Self.muted)
                Text("\(hard.pass)✓").foregroundStyle(Color.green)
                if hard.warn > 0 { Text("\(hard.warn)!").foregroundStyle(Color.orange) }
                if hard.fail > 0 { Text("\(hard.fail)✗").foregroundStyle(Color.red) }
            }
        }
        ForEach(Array((card?.card?.metrics ?? []).prefix(2)), id: \.self) { m in
            HStack(spacing: 4) {
                Text(lang.server(m.name)).foregroundStyle(Self.muted).lineLimit(1)
                Text(m.value).foregroundStyle(Color.teal)
            }
        }
        if let running = card?.running, !running.isEmpty {
            Text(lang.format("home.running", running.count)).foregroundStyle(Color.blue)
        }
        if let queued = card?.queued, !queued.isEmpty {
            Text(lang.format("home.queued", queued.count)).foregroundStyle(Self.muted)
        }
        let waiting = (card?.asks ?? 0) + (card?.decisions?.count ?? 0) + (card?.card?.needYou.count ?? 0)
        if waiting > 0 {
            Text(lang.format("home.waiting", waiting)).foregroundStyle(Color.orange)
        }
        if let code = card?.repos?.code, let branch = code.branch {
            HStack(spacing: 4) {
                Image(systemName: "arrow.triangle.branch").font(.system(size: 9, weight: .bold))
                Text(branch).lineLimit(1)
                if let dirty = code.dirty, dirty > 0 { Text("*\(dirty)") }
            }
            .foregroundStyle(Color.orange)
        }
        if let words = card?.repos?.paper?.words, words > 0 {
            Text(lang.format("home.words", Self.count(words))).foregroundStyle(Color.indigo)
        }
        let when = TextFormatters.relativeTime(from: card?.card?.at ?? project.updatedAt, language: lang)
        if !when.isEmpty {
            Text(when).foregroundStyle(Self.muted)
        }
    }

    /// 2597 as 2.6k.
    private static func count(_ n: Int) -> String {
        n >= 1000 ? String(format: "%.1fk", Double(n) / 1000) : "\(n)"
    }
}
