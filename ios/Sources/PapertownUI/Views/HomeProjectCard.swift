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
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
                Text(project.title.isEmpty || project.title == project.idea ? project.idea : lang.server(project.title))
                    .font(.subheadline).emKey()
                    .emBar(project.title.isEmpty || project.title == project.idea ? .info : nil)
                    .lineLimit(2)
                Spacer(minLength: 4)
                if let health = progress?.health, !health.isEmpty {
                    Text(lang.string("health.\(health)")).font(.caption2).emState(EmTone.issue(health))
                    .fixedSize()
                }
            }
            HStack(spacing: 8) {
                StageTrackView(
                    stages: project.stages,
                    fallbackIndex: TextFormatters.orderedStages.firstIndex(of: project.stage) ?? 0,
                    blocked: blocked
                )
                Text(TextFormatters.stageName(project.stage, language: lang) + " ·").font(.caption).foregroundStyle(.secondary)
                Text("\(project.pct)%")
                    .font(.caption.monospacedDigit())
                    .emNum(blocked ? .bad : .info)
                    .fixedSize()
            }
            if let summary = progress?.summary, !summary.isEmpty {
                EmText(lang.server(summary))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            if let milestone = progress?.milestone, !milestone.isEmpty {
                Text(lang.server(milestone)).lineLimit(1).font(.caption).emState(.warn, icon: "flag.checkered", detail: true)
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
            Text(lang.string("home.lead")).foregroundStyle(Self.muted)
            Text(TextFormatters.leadStateLabel(lead, language: lang)).emState(EmTone.issue(lead))
        }
        if let hard = card?.checks?.hard, hard.total > 0 {
            HStack(spacing: 4) {
                Text(lang.string("home.checks")).foregroundStyle(Self.muted)
                Text("\(hard.pass)✓").emNum(.good)
                if hard.warn > 0 { Text("\(hard.warn)!").emNum(.warn) }
                if hard.fail > 0 { Text("\(hard.fail)✗").emNum(.bad) }
            }
        }
        ForEach(Array((card?.card?.metrics ?? []).prefix(2)), id: \.self) { m in
            HStack(spacing: 4) {
                Text(lang.server(m.name)).foregroundStyle(Self.muted).lineLimit(1)
                Text(m.value).emNum()
            }
        }
        if let running = card?.running, !running.isEmpty {
            EmText(lang.format("home.running", running.count), .numbers(.info))
        }
        if let queued = card?.queued, !queued.isEmpty {
            EmText(lang.format("home.queued", queued.count), .numbers(.info))
        }
        if let count = card?.decided?.total, count > 0 {
            EmText(lang.format("decided.count", count), .numbers(.info))
        }
        let waiting = card?.decisions?.count ?? ((card?.asks ?? 0) + (card?.card?.needYou.count ?? 0))
        if waiting > 0 {
            EmText(lang.format("home.waiting", waiting), .numbers(.warn))
        }
        if let code = card?.repos?.code, let branch = code.branch {
            HStack(spacing: 4) {
                Image(systemName: "arrow.triangle.branch").font(.system(size: 9, weight: .bold))
                Text(branch).lineLimit(1)
                if let dirty = code.dirty, dirty > 0 { Text("*\(dirty)").emMark(.warn) }
            }
            .foregroundStyle(.secondary)
        }
        if let words = card?.repos?.paper?.words, words > 0 {
            Text(lang.format("home.words", Self.count(words))).foregroundStyle(.secondary)
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
