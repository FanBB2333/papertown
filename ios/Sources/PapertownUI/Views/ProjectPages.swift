import PapertownCore
import SwiftUI
#if canImport(PDFKit)
import PDFKit
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
                        Text(lang.string("health.\(c.health)")).font(.caption).emState(EmTone.issue(c.health))
                        if let m = c.milestone, !m.isEmpty { Text(lang.server(m)).font(.caption).emState(.warn, icon: "flag.checkered", detail: true).lineLimit(1) }
                        Spacer()
                        if let p = c.progress { Text("\(p)%").font(.caption).emNum() }
                    }
                    EmText(lang.server(c.summary)).font(.subheadline)
                }
                .padding(.vertical, 2)
                if !c.needYou.isEmpty {
                    labeled("card.need_you", c.needYou, symbol: "person.fill.questionmark")
                }
                if !c.blockers.isEmpty {
                    labeled("card.blockers", c.blockers, symbol: "exclamationmark.triangle.fill")
                }
                if !c.next.isEmpty {
                    labeled("card.next", c.next, symbol: "arrow.right.circle")
                }
                if !c.metrics.isEmpty {
                    ForEach(c.metrics, id: \.self) { m in
                        InfoRow(label: lang.server(m.name), value: lang.server(m.value), number: .info)
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
                Text((pending.note ?? "").isEmpty ? lang.string("card.pending") : pending.note ?? "").emBar((pending.note ?? "").isEmpty ? nil : .info)
                    .font(.footnote).foregroundStyle(.secondary)
            }
            .papertownRowBackground(store.appearance)
        }
    }

    private func labeled(_ key: String, _ items: [String], symbol: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(store.language.string(key)).font(.caption).emState(key == "card.blockers" ? .bad : nil, icon: symbol)
            BulletList(items: items.map(store.language.server))
                .emBar(key == "card.need_you" ? .warn : nil)

        }
    }
}

// MARK: - Reports and questions

struct ReportsPage: View {
    let projectID: String
    var reportID: Int? = nil
    @EnvironmentObject private var store: TownStore
    @State private var answering: ReportItem?

    var body: some View {
        let lang = store.language
        LoadingList(load: { try await $0.reports(projectID: projectID) }, content: { r in
            ScrollViewReader { proxy in
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
                                    Text(lang.server(rep.data.who ?? "")).font(.caption).foregroundStyle(.secondary)
                                    if rep.data.key == true { Text(lang.string("reports.key")).font(.caption).foregroundStyle(.secondary) }
                                    Spacer()
                                    Text(Stamp.ago(rep.ts, lang)).font(.caption2).foregroundStyle(.secondary)
                                }
                                EmText(lang.server(rep.data.text ?? rep.data.question ?? "")).font(.subheadline).textSelection(.enabled)
                                if let answer = rep.data.answer, !answer.isEmpty { Text(answer).font(.subheadline).emBar(.info) }
                            }
                            .padding(.vertical, 2)
                            .emBar(rep.data.key == true ? .info : nil)
                            .id(rep.id)
                        }
                    }
                }
                .papertownInsetGroupedList()
                .papertownListAppearance(store.appearance)
                .task { if let reportID { proxy.scrollTo(reportID, anchor: .top) } }
            }
        }, reloadKey: "\(store.openAsks.count)")
        .navigationTitle(lang.string("reports.nav"))
        .papertownInlineTitle()
        .sheet(item: $answering) { ask in
            AnswerSheet(ask: ask).environmentObject(store).papertownSheetFrame(height: 460)
        }
    }

    private func askRow(_ ask: ReportItem, _ lang: AppLanguage) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(lang.server(ask.data.question ?? ask.data.text ?? "")).font(.subheadline).emBar(.warn)
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
                if ask.data.matter != nil {
                    DecisionRow(projectID: ask.lineID, d: ask.pendingDecision) { dismiss() }
                } else {
                    Section {
                        Text(lang.server(ask.data.question ?? ask.data.text ?? "")).font(.subheadline).emBar(.warn)
                    }
                    if let choices = ask.data.choices, !choices.isEmpty {
                        Section(lang.string("answer.choices")) {
                            ForEach(choices, id: \.self) { c in
                                Button(lang.server(c)) { Task { await submit(c) } }
                            }
                        }
                    }
                    Section(lang.string("answer.own")) {
                        TextField(lang.string("answer.placeholder"), text: $text, axis: .vertical).lineLimit(3...8).emBar(text.isEmpty ? nil : .info, reserve: true)
                    }
                    if let error { Section { Text(error).emState(.bad, detail: true).font(.footnote) } }
                }
            }
            .navigationTitle(lang.string("answer.title"))
            .papertownInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(lang.string("action.cancel")) { dismiss() } }
                if ask.data.matter == nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(lang.string("action.send")) { Task { await submit(text) } }
                            .disabled(sending || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
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
                                Text(lang.server(verdict)).emKey()
                            }
                        }
                        if let s = h.summary { EmText(lang.server(s)).font(.subheadline) }
                        if let gap = h.gap {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(lang.string("overlap.gap")).font(.caption).foregroundStyle(.secondary)
                                EmText(lang.server(gap)).font(.subheadline)
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
                    EmText(paper.title, .matches(paper.matched ?? [])).font(.subheadline.weight(.medium)).foregroundStyle(.primary).multilineTextAlignment(.leading)
                    Spacer(minLength: 6)
                    if let s = paper.similarity { Text(String(format: "%.2f", s)).font(.caption.monospacedDigit()).emNum(paper.closest == true ? .warn : .info) }
                }
                Text([paper.authors, paper.year].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                if let m = paper.matched, !m.isEmpty {
                    EmText(m.joined(separator: " · "), .matches(m)).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                } else if let note = paper.note {
                    EmText(lang.server(note)).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
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
                    if let p = m.problem { Section(lang.string("method.problem")) { EmText(lang.server(p)).font(.subheadline).textSelection(.enabled) } }
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
            Section(store.language.string(key)) { BulletList(items: items.map(store.language.server))
                .emBar(key == "card.need_you" ? .warn : nil)
                 }
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
        LivePage(load: { client -> Loaded in
            async let d = client.lineData(projectID: projectID)
            async let j = client.jobs(projectID: projectID)
            return Loaded(data: try await d, jobs: try await j)
        }, events: ["prov", "job", "line"], projectID: projectID) { v, _ in
            List {
                if let r = v.data.results, !r.rows.isEmpty {
                    Section {
                        ResultsTableView(table: r)
                        if let a = r.analysis { EmText(lang.server(a)).font(.footnote).foregroundStyle(.secondary) }
                        if let c = r.concerns, !c.isEmpty { BulletList(items: c.map(lang.server), symbol: "exclamationmark.triangle", color: .orange) }
                    } header: {
                        HStack {
                            Text(lang.string("exp.results"))
                            if r.simulated == true || r.sample == true { Text(lang.string("exp.placeholder")).font(.caption).emState(.warn) }
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
                            Image(systemName: Tone.symbol(run.state)).foregroundStyle(.secondary).accessibilityLabel(run.state)
                            if let issue = EmTone.issue(run.state) { Text(lang.string("job.status.\(run.state)")).font(.caption).emState(issue) }
                            VStack(alignment: .leading) {
                                Text(run.name).font(.subheadline)
                                Text([run.where, run.elapsedS.map { "\(Int($0))s" }].compactMap { $0 }.joined(separator: " · "))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        ForEach(Array((run.prov ?? []).enumerated()), id: \.offset) { _, result in
                            if let id = result.id ?? result.tag {
                                NavigationLink { ProvNodePage(projectID: projectID, nodeID: id) } label: {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text([result.tag, result.path].compactMap { $0 }.joined(separator: " · ")).font(.footnote.monospaced())
                                        HStack {
                                            if let state = result.state { ProvState(state: state) }
                                            if let used = result.used { EmText(lang.format("prov.used.count", used), .numbers(.info)).font(.caption).foregroundStyle(.secondary) }
                                        }
                                    }
                                }
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

/// Metric direction varies by column, so comparable values share a neutral tone.
struct ResultsTableView: View {
    let table: ResultsTable
    @EnvironmentObject private var store: TownStore

    var body: some View {
        let lang = store.language
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
                        Text(lang.server(row.method)).font(.footnote).lineLimit(2).frame(maxWidth: 160, alignment: .leading)
                        ForEach(Array(row.values.enumerated()), id: \.offset) { _, val in
                            Group {
                                if let val { Text(String(format: "%.1f", val)).emNum() }
                                else { Text("–").foregroundStyle(.secondary) }
                            }
                                .font(.footnote)
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
            if let issue = EmTone.issue(job.status) {
                Text(lang.string("job.status.\(job.status)")).font(.caption).emState(issue)
            } else { Image(systemName: Tone.symbol(job.status)).foregroundStyle(.secondary) }
            VStack(alignment: .leading, spacing: 2) {
                Text(lang.server(job.name)).font(.subheadline)
                Text([job.backend, Stamp.ago(job.startedAt ?? job.createdAt, lang)].filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if job.status == "running", let p = job.progress { Text("\(Int(p * (p <= 1 ? 100 : 1)))%").font(.caption).emNum() }
        }
    }
}

struct JobPage: View {
    let jobID: String
    var readOnly = false
    @EnvironmentObject private var store: TownStore
    @State private var reload = 0

    var body: some View {
        let lang = store.language
        LoadingList(load: { try await $0.job(id: jobID) }, content: { job in
            List {
                Section {
                    InfoRow(label: lang.string("job.status"), value: lang.string("job.status.\(job.status)"), status: EmTone.issue(job.status))
                    InfoRow(label: lang.string("exp.backend"), value: job.backend)
                    if let c = job.command { MonoBlock(text: c, maxHeight: 120) }
                    if let n = job.note { EmText(lang.server(n)).font(.footnote).foregroundStyle(.secondary) }
                    if !readOnly, !jobID.hasPrefix("nvidb-"), ["queued", "running"].contains(job.status) {
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
    @State private var compileFailed = false
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
                    if let compileNote { Text(compileNote).font(.caption).emState(compileFailed ? .bad : nil, detail: true) }
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
                            EmText(lang.server(a)).font(.subheadline).textSelection(.enabled)
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
                        if let verdict = r.verdict { HStack { Text(lang.string("review.verdict")).foregroundStyle(.secondary); Spacer(); Text(lang.server(verdict)).emKey() } }
                        if let mean = r.mean { InfoRow(label: lang.string("review.mean"), value: String(format: "%.1f", mean), number: .info) }
                        if let f = r.format?.summary { InfoRow(label: lang.string("review.format"), value: lang.server(f)) }
                        ForEach(r.reviews ?? [], id: \.self) { rv in
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text(lang.server(rv.persona ?? "")).font(.subheadline.weight(.semibold))
                                    Spacer()
                                    if let o = rv.overall { Text(String(format: "%.0f/5", o)).font(.caption).emNum() }
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
            compileFailed = !r.ok
            compileNote = r.ok
                ? store.language.format("paper.compiled", r.pages ?? 0)
                : store.language.string("paper.compile_failed")
            reload += 1
        } catch {
            compileFailed = true
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
#elseif canImport(PDFKit) && os(macOS)
struct PDFDataView: NSViewRepresentable {
    let data: Data
    func makeNSView(context: Context) -> PDFView {
        let v = PDFView()
        v.autoScales = true
        v.document = PDFDocument(data: data)
        return v
    }
    func updateNSView(_ v: PDFView, context: Context) {}
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
                                if let st = f.status { Text(lang.string("files.status.\(st)")).font(.caption).emState(.warn, icon: "pencil") }
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
    var line: Int? = nil
    @EnvironmentObject private var store: TownStore

    var body: some View {
        let lang = store.language
        LoadingList(load: { try await $0.workspaceFile(projectID: projectID, root: root, path: path) }) { f in
            if let text = f.text, let line {
                ScrollViewReader { proxy in
                    ScrollView([.vertical, .horizontal]) {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(text.components(separatedBy: "\n").enumerated()), id: \.offset) { i, value in
                                Text(value.isEmpty ? " " : value)
                                    .emMark(active: i + 1 == line)
                                    .id(i + 1)
                            }
                        }
                        .font(.system(size: 12, design: .monospaced)).textSelection(.enabled).padding(12)
                    }
                    .task { proxy.scrollTo(line, anchor: .center) }
                }
            } else if let text = f.text {
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
        .toolbar {
            if root == "paper", store.cards[projectID]?.prov != nil {
                ToolbarItem(placement: .primaryAction) {
                    NavigationLink { ProvPage(projectID: projectID, file: path) } label: {
                        Label(lang.string("prov.open"), systemImage: "point.3.connected.trianglepath.dotted")
                    }
                }
            }
        }
    }
}

// MARK: - Usage and the research loop

struct OutlinePage: View {
    let projectID: String
    @EnvironmentObject private var store: TownStore

    var body: some View {
        LoadingList(load: { try await $0.outline(projectID: projectID) }) { text in
            ScrollView {
                EmText(store.language.server(text)).font(.footnote).textSelection(.enabled).padding()
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .navigationTitle(store.language.string("outline.nav"))
        .papertownInlineTitle()
    }
}
