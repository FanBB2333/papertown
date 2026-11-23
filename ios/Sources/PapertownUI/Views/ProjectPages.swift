import PapertownCore
import SwiftUI
#if canImport(PDFKit) && canImport(UIKit)
import PDFKit
import UIKit
#endif

// The pages under a project: its reports and questions, gates and checks, and what each stage produced.

// MARK: - Progress card

struct ProgressCardSection: View {
    let card: ProjectCardView
    @EnvironmentObject private var store: TownStore

    var body: some View {
        let lang = store.language
        if let c = card.card {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Pill(text: lang.string("health.\(c.health)"), color: Tone.color(c.health), symbol: Tone.symbol(c.health))
                        if let m = c.milestone, !m.isEmpty { Text(lang.server(m)).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                        Spacer()
                        if let p = c.progress { Text("\(p)%").font(.caption.weight(.semibold)).foregroundStyle(store.appearance.tintColor) }
                    }
                    Text(lang.server(c.summary)).font(.subheadline)
                }
                .padding(.vertical, 2)
                if !c.needYou.isEmpty {
                    labeled("card.need_you", c.needYou, symbol: "person.fill.questionmark", color: .orange)
                }
                if !c.blockers.isEmpty {
                    labeled("card.blockers", c.blockers, symbol: "exclamationmark.triangle.fill", color: .red)
                }
                if !c.next.isEmpty {
                    labeled("card.next", c.next, symbol: "arrow.right.circle", color: store.appearance.tintColor)
                }
                if !c.metrics.isEmpty {
                    ForEach(c.metrics, id: \.self) { m in
                        InfoRow(label: lang.server(m.name), value: lang.server(m.value))
                    }
                }
            } header: {
                HStack {
                    Text(lang.string("card.title"))
                    Spacer()
                    if let at = c.at { Text(Stamp.ago(at, lang)) }
                }
            }
            .papertownRowBackground(store.appearance)
        } else if let pending = card.pending {
            Section(lang.string("card.title")) {
                Label(lang.server(pending.note) .isEmpty ? lang.string("card.pending") : lang.server(pending.note), systemImage: "clock")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            .papertownRowBackground(store.appearance)
        }
    }

    private func labeled(_ key: String, _ items: [String], symbol: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(store.language.string(key), systemImage: symbol).font(.caption.weight(.semibold)).foregroundStyle(color)
            BulletList(items: items.map(store.language.server))
        }
    }
}

// MARK: - Reports and questions

struct ReportsPage: View {
    let projectID: String
    @EnvironmentObject private var store: TownStore
    @State private var answering: ReportItem?

    var body: some View {
        let lang = store.language
        LoadingList(load: { try await $0.reports(projectID: projectID) }, content: { r in
            List {
                let open = r.asks.filter { $0.data.open != false }
                if !open.isEmpty {
                    Section(lang.string("reports.asks")) {
                        ForEach(open) { ask in askRow(ask, lang) }
                    }
                }
                Section(lang.string("reports.title")) {
                    if r.reports.isEmpty {
                        Text(lang.string("reports.empty")).font(.footnote).foregroundStyle(.secondary)
                    }
                    ForEach(r.reports.reversed()) { rep in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(lang.server(rep.data.who ?? "")).font(.caption.weight(.semibold))
                                if rep.data.key == true { Pill(text: lang.string("reports.key"), color: .orange) }
                                Spacer()
                                Text(Stamp.ago(rep.ts, lang)).font(.caption2).foregroundStyle(.secondary)
                            }
                            Text(lang.server(rep.data.text ?? "")).font(.subheadline).textSelection(.enabled)
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
            .papertownInsetGroupedList()
            .papertownListAppearance(store.appearance)
        }, reloadKey: "\(store.openAsks.count)")
        .navigationTitle(lang.string("reports.nav"))
        .papertownInlineTitle()
        .sheet(item: $answering) { ask in
            AnswerSheet(ask: ask).environmentObject(store)
        }
    }

    private func askRow(_ ask: ReportItem, _ lang: AppLanguage) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(lang.server(ask.data.question ?? ask.data.text ?? "")).font(.subheadline)
            Button(lang.string("action.reply")) { answering = ask }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
        }
        .padding(.vertical, 2)
    }
}

/// Answers a lead's question: one of its choices, or your own words.
struct AnswerSheet: View {
    let ask: ReportItem
    @EnvironmentObject private var store: TownStore
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var sending = false
    @State private var error: String?

    var body: some View {
        let lang = store.language
        NavigationStack {
            Form {
                Section {
                    Text(lang.server(ask.data.question ?? ask.data.text ?? "")).font(.subheadline)
                }
                if let choices = ask.data.choices, !choices.isEmpty {
                    Section(lang.string("answer.choices")) {
                        ForEach(choices, id: \.self) { c in
                            Button(lang.server(c)) { Task { await submit(c) } }
                        }
                    }
                }
                Section(lang.string("answer.own")) {
                    TextField(lang.string("answer.placeholder"), text: $text, axis: .vertical).lineLimit(3...8)
                }
                if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
            }
            .navigationTitle(lang.string("answer.title"))
            .papertownInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(lang.string("action.cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(lang.string("action.send")) { Task { await submit(text) } }
                        .disabled(sending || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private func submit(_ answer: String) async {
        sending = true
        do {
            try await store.fetch { try await $0.answerReport(id: ask.id, text: answer) }
            await store.refreshAll()
            dismiss()
        } catch {
            self.error = store.message(for: error)
        }
        sending = false
    }
}

// MARK: - Gates and checks

struct ChecksPage: View {
    let projectID: String
    @EnvironmentObject private var store: TownStore

    var body: some View {
        let lang = store.language
        LoadingList(load: { try await $0.checks(projectID: projectID) }) { v in
            List {
                Section {
                    countsRow(lang.string("checks.hard"), v.summary.hard)
                    countsRow(lang.string("checks.soft"), v.summary.soft)
                } footer: {
                    Text(lang.string("checks.footer"))
                }
                ForEach(TextFormatters.orderedStages, id: \.self) { stage in
                    let list = v.checks.filter { $0.stage == stage }
                    if !list.isEmpty {
                        Section(TextFormatters.stageName(stage, language: lang)) {
                            ForEach(list) { check in
                                NavigationLink { CheckDetailPage(check: check) } label: { checkRow(check, lang) }
                            }
                        }
                    }
                }
            }
            .papertownInsetGroupedList()
            .papertownListAppearance(store.appearance)
        }
        .navigationTitle(lang.string("checks.nav"))
        .papertownInlineTitle()
    }

    private func countsRow(_ title: String, _ c: CheckCounts) -> some View {
        HStack(spacing: 10) {
            Text(title).font(.subheadline.weight(.medium))
            Spacer()
            if c.pass > 0 { Pill(text: "\(c.pass)", color: .green, symbol: "checkmark") }
            if c.warn > 0 { Pill(text: "\(c.warn)", color: .orange, symbol: "exclamationmark") }
            if c.fail > 0 { Pill(text: "\(c.fail)", color: .red, symbol: "xmark") }
            Text("\(c.total)").font(.caption).foregroundStyle(.secondary)
        }
    }

    private func checkRow(_ check: ResearchCheck, _ lang: AppLanguage) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: Tone.symbol(check.status)).foregroundStyle(Tone.color(check.status))
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(lang.server(check.title)).font(.subheadline.weight(.medium))
                    if check.kind == "hard", check.gate == "block" { Pill(text: lang.string("checks.gate"), color: .secondary) }
                }
                if let note = check.last?.note, !note.isEmpty {
                    Text(lang.server(note)).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                } else if let text = check.text {
                    Text(lang.server(text)).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
        }
    }
}

struct CheckDetailPage: View {
    let check: ResearchCheck
    @EnvironmentObject private var store: TownStore

    var body: some View {
        let lang = store.language
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Pill(text: lang.string("check.status.\(check.status)"), color: Tone.color(check.status), symbol: Tone.symbol(check.status))
                        Pill(text: lang.string(check.kind == "hard" ? "checks.hard" : "checks.soft"), color: .secondary)
                        if let p = check.prio { Pill(text: p, color: .secondary) }
                    }
                    if let text = check.text { Text(lang.server(text)).font(.subheadline) }
                }
                if let note = check.last?.note, !note.isEmpty { InfoRow(label: lang.string("check.last"), value: lang.server(note)) }
                if let v = check.last?.value { InfoRow(label: lang.string("check.value"), value: v.formatted() + (check.unit.map { " " + lang.server($0) } ?? "")) }
                if let ts = check.last?.ts { InfoRow(label: lang.string("check.ran"), value: Stamp.short(ts, lang)) }
                ForEach(check.params ?? [], id: \.self) { p in InfoRow(label: lang.server(p.label), value: p.value.formatted()) }
            }
            if let findings = check.last?.findings, !findings.isEmpty {
                Section(lang.string("check.findings")) {
                    ForEach(findings, id: \.self) { f in
                        VStack(alignment: .leading, spacing: 3) {
                            if let file = f.file { Text(file + (f.line.map { ":\($0)" } ?? "")).font(.caption.monospaced()).foregroundStyle(.secondary) }
                            if let t = f.text { Text(lang.server(t)).font(.footnote) }
                            if let h = f.hint, !h.isEmpty { Text(lang.server(h)).font(.caption).foregroundStyle(.orange) }
                        }
                    }
                }
            }
            if let hist = check.history, hist.count > 1 {
                Section(lang.string("check.history")) {
                    ForEach(hist.reversed(), id: \.self) { h in
                        HStack {
                            Image(systemName: Tone.symbol(h.status)).foregroundStyle(Tone.color(h.status))
                            Text(Stamp.short(h.ts, lang)).font(.footnote)
                            Spacer()
                            if let v = h.value { Text(v.formatted()).font(.footnote.monospacedDigit()) }
                        }
                    }
                }
            }
        }
        .papertownInsetGroupedList()
        .papertownListAppearance(store.appearance)
        .navigationTitle(lang.server(check.title))
        .papertownInlineTitle()
    }
}

// MARK: - Overlap check (hatch)

struct OverlapPage: View {
    let projectID: String
    @EnvironmentObject private var store: TownStore

    private struct Loaded { let hatch: HatchOutput?; let papers: PapersView }

    var body: some View {
        let lang = store.language
        LoadingList(load: { client -> Loaded in
            async let snap = client.projectSnapshot(id: projectID)
            async let papers = client.papers(projectID: projectID)
            return Loaded(hatch: try await snap.outputs?.hatch, papers: try await papers)
        }) { v in
            List {
                if let h = v.hatch {
                    Section {
                        if let verdict = h.verdict {
                            HStack {
                                Text(lang.string("overlap.verdict")).foregroundStyle(.secondary)
                                Spacer()
                                Pill(text: lang.server(verdict), color: verdictColor(verdict))
                            }
                        }
                        if let s = h.summary { Text(lang.server(s)).font(.subheadline) }
                        if let gap = h.gap {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(lang.string("overlap.gap")).font(.caption).foregroundStyle(.secondary)
                                Text(lang.server(gap)).font(.subheadline)
                            }
                        }
                        if let sug = h.suggestions, !sug.isEmpty { BulletList(items: sug.map(lang.server)) }
                    }
                }
                Section(lang.string("overlap.similar")) {
                    if v.papers.survey.isEmpty { Text(lang.string("overlap.none")).font(.footnote).foregroundStyle(.secondary) }
                    ForEach(v.papers.survey) { PaperRow(paper: $0) }
                }
                if !v.papers.references.isEmpty {
                    Section(lang.string("overlap.references")) {
                        ForEach(v.papers.references) { PaperRow(paper: $0) }
                    }
                }
            }
            .papertownInsetGroupedList()
            .papertownListAppearance(store.appearance)
        }
        .navigationTitle(lang.string("overlap.nav"))
        .papertownInlineTitle()
    }

    private func verdictColor(_ v: String) -> Color {
        if v.contains("做过") || v.lowercased().contains("done") { return .red }
        if v.contains("调整") || v.lowercased().contains("adjust") { return .orange }
        return .green
    }
}

struct PaperRow: View {
    let paper: PaperCard
    @EnvironmentObject private var store: TownStore
    @Environment(\.openURL) private var openURL

    var body: some View {
        let lang = store.language
        Button {
            if let u = paper.url.flatMap(URL.init(string:)) { openURL(u) }
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .top) {
                    Text(paper.title).font(.subheadline.weight(.medium)).foregroundStyle(.primary).multilineTextAlignment(.leading)
                    Spacer(minLength: 6)
                    if let s = paper.similarity { Text(String(format: "%.2f", s)).font(.caption.monospacedDigit()).foregroundStyle(paper.closest == true ? .orange : .secondary) }
                }
                Text([paper.authors, paper.year].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                if let m = paper.matched, !m.isEmpty {
                    Text(m.joined(separator: " · ")).font(.caption2.monospaced()).foregroundStyle(store.appearance.tintColor).lineLimit(1)
                } else if let note = paper.note {
                    Text(lang.server(note)).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Method

struct MethodPage: View {
    let projectID: String
    @EnvironmentObject private var store: TownStore

    var body: some View {
        let lang = store.language
        LoadingList(load: { try await $0.projectSnapshot(id: projectID).outputs?.method }) { m in
            if let m {
                List {
                    if let p = m.problem { Section(lang.string("method.problem")) { Text(lang.server(p)).font(.subheadline).textSelection(.enabled) } }
                    list("method.mechanism", m.mechanism)
                    if let b = m.baselines, !b.isEmpty {
                        Section(lang.string("method.baselines")) {
                            ForEach(b, id: \.self) { x in
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(lang.server(x.name)).font(.subheadline)
                                    if let s = x.source { Text(s).font(.caption.monospaced()).foregroundStyle(.secondary) }
                                }
                            }
                        }
                    }
                    list("method.datasets", m.datasets.map { Array(NSOrderedSet(array: $0)) as? [String] ?? $0 })
                    list("method.metrics", m.metrics)
                    list("method.risks", m.risks)
                }
                .papertownInsetGroupedList()
                .papertownListAppearance(store.appearance)
            } else {
                EmptyStateView(title: lang.string("method.empty.title"), systemImage: "function", description: lang.string("method.empty.desc"))
            }
        }
        .navigationTitle(lang.string("stage.method"))
        .papertownInlineTitle()
    }

    @ViewBuilder
    private func list(_ key: String, _ items: [String]?) -> some View {
        if let items, !items.isEmpty {
            Section(store.language.string(key)) { BulletList(items: items.map(store.language.server)) }
        }
    }
}

// MARK: - Experiments and data

struct ExperimentsPage: View {
    let projectID: String
    @EnvironmentObject private var store: TownStore

    private struct Loaded { let data: LineData; let jobs: JobBoard }

    var body: some View {
        let lang = store.language
        LoadingList(load: { client -> Loaded in
            async let d = client.lineData(projectID: projectID)
            async let j = client.jobs(projectID: projectID)
            return Loaded(data: try await d, jobs: try await j)
        }) { v in
            List {
                if let r = v.data.results, !r.rows.isEmpty {
                    Section {
                        ResultsTableView(table: r)
                        if let a = r.analysis { Text(lang.server(a)).font(.footnote).foregroundStyle(.secondary) }
                        if let c = r.concerns, !c.isEmpty { BulletList(items: c.map(lang.server), symbol: "exclamationmark.triangle", color: .orange) }
                    } header: {
                        HStack {
                            Text(lang.string("exp.results"))
                            if r.simulated == true || r.sample == true { Pill(text: lang.string("exp.placeholder"), color: .orange) }
                        }
                    }
                }
                if let meta = v.data.meta {
                    Section(lang.string("exp.setup")) {
                        if let d = meta.datasets, !d.isEmpty {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(lang.string("method.datasets")).font(.caption).foregroundStyle(.secondary)
                                ForEach(Array(Set(d)).sorted(), id: \.self) { Text($0).font(.footnote.monospaced()).textSelection(.enabled) }
                            }
                        }
                        if let s = meta.seeds { InfoRow(label: lang.string("exp.seeds"), value: "\(s)") }
                        if let g = meta.gpuHours { InfoRow(label: lang.string("exp.gpu_hours"), value: g.formatted()) }
                        if let b = meta.backend { InfoRow(label: lang.string("exp.backend"), value: b) }
                    }
                }
                Section(lang.string("exp.jobs")) {
                    if v.jobs.jobs.isEmpty && (v.data.runs ?? []).isEmpty {
                        Text(lang.string("exp.jobs.empty")).font(.footnote).foregroundStyle(.secondary)
                    }
                    ForEach(v.jobs.jobs) { job in NavigationLink { JobPage(jobID: job.id) } label: { JobRow(job: job) } }
                    ForEach(v.data.runs ?? []) { run in
                        HStack {
                            Image(systemName: Tone.symbol(run.state)).foregroundStyle(Tone.color(run.state))
                            VStack(alignment: .leading) {
                                Text(run.name).font(.subheadline)
                                Text([run.where, run.elapsedS.map { "\(Int($0))s" }].compactMap { $0 }.joined(separator: " · "))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                if let files = v.data.files, !files.isEmpty {
                    Section(lang.string("exp.files")) {
                        ForEach(files, id: \.self) { f in
                            HStack {
                                Text(f.path).font(.caption.monospaced())
                                Spacer()
                                if let k = f.kind { Text(lang.string("exp.file.\(k)")).font(.caption2).foregroundStyle(.secondary) }
                            }
                        }
                    }
                }
            }
            .papertownInsetGroupedList()
            .papertownListAppearance(store.appearance)
        }
        .navigationTitle(lang.string("stage.exp"))
        .papertownInlineTitle()
    }
}

/// A results table that scrolls sideways; the row marked as ours is in bold, and each column's best value is tinted.
struct ResultsTableView: View {
    let table: ResultsTable
    @EnvironmentObject private var store: TownStore

    var body: some View {
        let lang = store.language
        let best = table.metrics.indices.map { i in table.rows.compactMap { $0.values.indices.contains(i) ? $0.values[i] : nil }.max() }
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
                GridRow {
                    Text(lang.string("exp.method")).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    ForEach(table.metrics, id: \.self) { m in
                        Text(lang.server(m)).font(.caption.weight(.semibold)).foregroundStyle(.secondary).frame(maxWidth: 120, alignment: .trailing)
                    }
                }
                Divider()
                ForEach(table.rows, id: \.self) { row in
                    GridRow {
                        Text(lang.server(row.method)).font(.footnote.weight(row.ours == true ? .bold : .regular)).lineLimit(2).frame(maxWidth: 160, alignment: .leading)
                        ForEach(Array(row.values.enumerated()), id: \.offset) { i, val in
                            Text(val.map { String(format: "%.1f", $0) } ?? "–")
                                .font(.footnote.monospacedDigit().weight(row.ours == true ? .bold : .regular))
                                .foregroundStyle(val != nil && best.indices.contains(i) && val == best[i] ? store.appearance.tintColor : .primary)
                                .frame(maxWidth: 120, alignment: .trailing)
                        }
                    }
                }
            }
            .padding(.vertical, 4)
        }
    }
}

struct JobRow: View {
    let job: TownJob
    @EnvironmentObject private var store: TownStore

    var body: some View {
        let lang = store.language
        HStack(spacing: 10) {
            Image(systemName: Tone.symbol(job.status)).foregroundStyle(Tone.color(job.status))
            VStack(alignment: .leading, spacing: 2) {
                Text(lang.server(job.name)).font(.subheadline)
                Text([job.backend, Stamp.ago(job.startedAt ?? job.createdAt, lang)].filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if job.status == "running", let p = job.progress { Text("\(Int(p * (p <= 1 ? 100 : 1)))%").font(.caption.monospacedDigit()) }
        }
    }
}

struct JobPage: View {
    let jobID: String
    @EnvironmentObject private var store: TownStore
    @State private var reload = 0

    var body: some View {
        let lang = store.language
        LoadingList(load: { try await $0.job(id: jobID) }, content: { job in
            List {
                Section {
                    InfoRow(label: lang.string("job.status"), value: lang.string("job.status.\(job.status)"))
                    InfoRow(label: lang.string("exp.backend"), value: job.backend)
                    if let c = job.command { MonoBlock(text: c, maxHeight: 120) }
                    if let n = job.note { Text(lang.server(n)).font(.footnote).foregroundStyle(.secondary) }
                    if ["queued", "running"].contains(job.status) {
                        Button(lang.string("job.cancel"), role: .destructive) {
                            Task {
                                _ = try? await store.fetch { try await $0.cancelJob(id: jobID) }
                                reload += 1
                            }
                        }
                    }
                }
                if let log = job.log, !log.isEmpty {
                    Section(lang.string("job.log")) { MonoBlock(text: log, maxHeight: 420) }
                }
            }
            .papertownInsetGroupedList()
            .papertownListAppearance(store.appearance)
        }, reloadKey: "\(reload)")
        .navigationTitle(lang.string("job.nav"))
        .papertownInlineTitle()
    }
}

// MARK: - Paper

struct PaperPage: View {
    let projectID: String
    @EnvironmentObject private var store: TownStore
    @State private var compiling = false
    @State private var compileNote: String?
    @State private var reload = 0

    private struct Loaded { let snap: ProjectSnapshot; let ws: WorkspaceInfo }

    var body: some View {
        let lang = store.language
        LoadingList(load: { client -> Loaded in
            async let s = client.projectSnapshot(id: projectID)
            async let w = client.workspace(projectID: projectID)
            return Loaded(snap: try await s, ws: try await w)
        }, content: { v in
            List {
                Section {
                    if v.ws.paper?.pdf == true {
                        NavigationLink { PDFPage(projectID: projectID) } label: {
                            Label(lang.string("paper.open_pdf"), systemImage: "doc.richtext")
                        }
                    } else {
                        Label(lang.string("paper.no_pdf"), systemImage: "doc").foregroundStyle(.secondary)
                    }
                    if v.ws.latexmk == true {
                        Button {
                            Task { await compile() }
                        } label: {
                            HStack {
                                Label(lang.string("paper.compile"), systemImage: "hammer")
                                if compiling { Spacer(); ProgressView() }
                            }
                        }
                        .disabled(compiling)
                    }
                    if let compileNote { Text(compileNote).font(.caption).foregroundStyle(.secondary) }
                    if let p = v.ws.paper {
                        NavigationLink { FilesPage(projectID: projectID, root: "paper") } label: {
                            Label(lang.string("paper.files"), systemImage: "folder")
                        }
                        if let main = p.main { InfoRow(label: lang.string("paper.main"), value: main, mono: true) }
                    }
                }
                if let w = v.snap.outputs?.write {
                    if let a = w.abstract {
                        Section(lang.string("paper.abstract")) {
                            if let t = w.title { Text(lang.server(t)).font(.subheadline.weight(.semibold)) }
                            Text(lang.server(a)).font(.subheadline).textSelection(.enabled)
                        }
                    }
                    if let sections = w.sections, !sections.isEmpty {
                        Section(lang.string("paper.sections")) {
                            ForEach(sections.keys.sorted(by: PaperPage.sectionOrder), id: \.self) { k in
                                NavigationLink {
                                    ScrollView { Text(sections[k] ?? "").font(.system(.footnote, design: .monospaced)).textSelection(.enabled).padding() }
                                        .navigationTitle(k.capitalized)
                                } label: { Text(k.capitalized) }
                            }
                        }
                    }
                }
                if let r = v.snap.outputs?.review {
                    Section {
                        if let verdict = r.verdict { HStack { Text(lang.string("review.verdict")).foregroundStyle(.secondary); Spacer(); Pill(text: lang.server(verdict), color: .orange) } }
                        if let mean = r.mean { InfoRow(label: lang.string("review.mean"), value: String(format: "%.1f", mean)) }
                        if let f = r.format?.summary { InfoRow(label: lang.string("review.format"), value: lang.server(f)) }
                        ForEach(r.reviews ?? [], id: \.self) { rv in
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text(lang.server(rv.persona ?? "")).font(.subheadline.weight(.semibold))
                                    Spacer()
                                    if let o = rv.overall { Text(String(format: "%.0f/5", o)).font(.caption.monospacedDigit()) }
                                }
                                if let w = rv.weaknesses, !w.isEmpty { BulletList(items: w.map(lang.server), symbol: "minus.circle", color: .orange) }
                            }
                        }
                    } header: { Text(lang.string("stage.review")) }
                }
                if let ship = v.snap.outputs?.ship, let files = ship.files, !files.isEmpty {
                    Section(lang.string("stage.ship")) {
                        ForEach(files, id: \.self) { Text($0).font(.footnote.monospaced()) }
                    }
                }
            }
            .papertownInsetGroupedList()
            .papertownListAppearance(store.appearance)
        }, reloadKey: "\(reload)")
        .navigationTitle(lang.string("paper.nav"))
        .papertownInlineTitle()
    }

    /// Sections in the order a paper has them; ones it does not know go last, alphabetically.
    static func sectionOrder(_ a: String, _ b: String) -> Bool {
        let order = ["abstract", "introduction", "related", "related_work", "background", "method", "approach", "experiments",
                     "results", "analysis", "discussion", "limitations", "conclusion"]
        let ia = order.firstIndex(of: a.lowercased()) ?? order.count, ib = order.firstIndex(of: b.lowercased()) ?? order.count
        return ia == ib ? a < b : ia < ib
    }

    private func compile() async {
        compiling = true
        do {
            let r = try await store.fetch { try await $0.compilePaper(projectID: projectID) }
            compileNote = r.ok
                ? store.language.format("paper.compiled", r.pages ?? 0)
                : store.language.string("paper.compile_failed")
            reload += 1
        } catch {
            compileNote = store.message(for: error)
        }
        compiling = false
    }
}

struct PDFPage: View {
    let projectID: String
    @EnvironmentObject private var store: TownStore

    var body: some View {
        LoadingList(load: { try await $0.paperPDF(projectID: projectID) }) { data in
            PDFDataView(data: data)
        }
        .navigationTitle(store.language.string("paper.pdf"))
        .papertownInlineTitle()
    }
}

#if canImport(PDFKit) && canImport(UIKit)
struct PDFDataView: UIViewRepresentable {
    let data: Data
    func makeUIView(context: Context) -> PDFView {
        let v = PDFView()
        v.autoScales = true
        v.document = PDFDocument(data: data)
        return v
    }
    func updateUIView(_ v: PDFView, context: Context) {}
}
#else
struct PDFDataView: View {
    let data: Data
    var body: some View { Text("PDF · \(data.count / 1024) KB").foregroundStyle(.secondary) }
}
#endif

// MARK: - Files

struct FilesPage: View {
    let projectID: String
    let root: String
    @EnvironmentObject private var store: TownStore

    var body: some View {
        let lang = store.language
        LoadingList(load: { try await $0.workspaceTree(projectID: projectID, root: root) }) { tree in
            List {
                Section {
                    if tree.files.isEmpty { Text(lang.string("files.empty")).font(.footnote).foregroundStyle(.secondary) }
                    ForEach(tree.files) { f in
                        NavigationLink { FileTextPage(projectID: projectID, root: root, path: f.path) } label: {
                            HStack {
                                Image(systemName: icon(f.path)).foregroundStyle(.secondary)
                                Text(f.path).font(.footnote.monospaced()).lineLimit(1).truncationMode(.middle)
                                Spacer()
                                if let st = f.status { Pill(text: lang.string("files.status.\(st)"), color: .orange) }
                                if let size = f.size { Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)).font(.caption2).foregroundStyle(.secondary) }
                            }
                        }
                    }
                } footer: {
                    if tree.truncated == true { Text(lang.string("files.truncated")) }
                }
            }
            .papertownInsetGroupedList()
            .papertownListAppearance(store.appearance)
        }
        .navigationTitle(lang.string(root == "paper" ? "files.paper" : "files.code"))
        .papertownInlineTitle()
    }

    private func icon(_ path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "tex", "md", "txt", "bib": return "doc.text"
        case "py", "js", "ts", "swift", "sh", "c", "cpp", "rs", "go": return "chevron.left.forwardslash.chevron.right"
        case "json", "yaml", "yml", "toml", "csv": return "tablecells"
        case "pdf": return "doc.richtext"
        case "png", "jpg", "jpeg", "svg": return "photo"
        default: return "doc"
        }
    }
}

struct FileTextPage: View {
    let projectID: String
    let root: String
    let path: String
    @EnvironmentObject private var store: TownStore

    var body: some View {
        let lang = store.language
        LoadingList(load: { try await $0.workspaceFile(projectID: projectID, root: root, path: path) }) { f in
            if let text = f.text {
                ScrollView([.vertical, .horizontal]) {
                    Text(text).font(.system(size: 12, design: .monospaced)).textSelection(.enabled).padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                EmptyStateView(title: lang.string(f.tooBig == true ? "files.too_big" : "files.binary"), systemImage: "doc",
                               description: path)
            }
        }
        .navigationTitle((path as NSString).lastPathComponent)
        .papertownInlineTitle()
    }
}

// MARK: - Usage and the research loop

struct ProjectUsagePage: View {
    let projectID: String
    @EnvironmentObject private var store: TownStore

    var body: some View {
        let lang = store.language
        LoadingList(load: { try await $0.lineUsage(projectID: projectID) }) { u in
            List {
                Section {
                    InfoRow(label: lang.string("usage.spent"), value: u.spent.dollars)
                    InfoRow(label: lang.string("usage.week"), value: (u.week ?? 0).dollars)
                    InfoRow(label: lang.string("usage.budget"), value: u.budget.map(\.dollars) ?? lang.string("usage.no_budget"))
                    if let b = u.budget, b > 0 { Meter(value: u.spent / b, color: Tone.color(u.state)) }
                } footer: {
                    if u.logs == false { Text(lang.string("usage.no_logs")) }
                }
                if let models = u.models, !models.isEmpty {
                    Section(lang.string("usage.models")) {
                        ForEach(models, id: \.self) { m in InfoRow(label: "\(m.provider) · \(m.model)", value: m.cost.dollars) }
                    }
                }
            }
            .papertownInsetGroupedList()
            .papertownListAppearance(store.appearance)
        }
        .navigationTitle(lang.string("usage.nav"))
        .papertownInlineTitle()
    }
}

struct OutlinePage: View {
    let projectID: String
    @EnvironmentObject private var store: TownStore

    var body: some View {
        LoadingList(load: { try await $0.outline(projectID: projectID) }) { text in
            ScrollView {
                Text(store.language.server(text)).font(.footnote).textSelection(.enabled).padding()
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .navigationTitle(store.language.string("outline.nav"))
        .papertownInlineTitle()
    }
}
