import PapertownCore
import SwiftUI

/// The town as a whole: the assistant, the numbers in the web's top bar, each department, the library, compute,
/// model quotas, and the MCP servers and skills the agents use.
struct TownView: View {
    @EnvironmentObject private var store: TownStore
    @State private var showServer = false

    var body: some View {
        let lang = store.language
        NavigationStack {
            List {
                Section {
                    NavigationLink {
                        AgentChatView(target: .agent("assistant"), role: "assistant", subtitle: lang.string("staff.town_wide"))
                    } label: {
                        let pending = (store.assistant?.acts ?? []).filter { $0.data.field("status")?.stringValue == "pending" }.count
                        HStack(spacing: 11) {
                            RoleBadgeView(role: "assistant", size: 34)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(lang.string("role.assistant")).font(.body.weight(.medium))
                                Text(lang.string("staff.assistant.sub")).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if pending > 0 {
                                Text("\(pending)").font(.caption).emNum(.warn)
                            } else if let a = store.assistantAgent, a.started != true {
                                Text(lang.string("staff.not_started")).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .emBar(pending > 0 ? .warn : nil)
                    }
                }
                .papertownRowBackground(store.appearance)

                if let hud = store.hud { overview(hud, lang) }

                Section(lang.string("town.section.places")) {
                    NavigationLink { DepartmentsPage() } label: { Label(lang.string("town.departments"), systemImage: "building.2") }
                    NavigationLink { LibraryPage() } label: {
                        HStack {
                            Label(lang.string("town.library"), systemImage: "books.vertical")
                            Spacer()
                            if let n = store.hud?.library { Text(lang.format("town.papers", n)).font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                    NavigationLink { ComputePage() } label: { Label(lang.string("town.compute"), systemImage: "cpu") }
                    NavigationLink { QuotaPage() } label: { Label(lang.string("town.usage"), systemImage: "gauge.with.dots.needle.33percent") }
                    NavigationLink { ToolsPage() } label: { Label(lang.string("town.tools"), systemImage: "puzzlepiece.extension") }
                    NavigationLink { SkimPage() } label: { Label("Skills", systemImage: "sparkles") }
                    NavigationLink { BoundsPage() } label: { Label(lang.string("bounds.nav"), systemImage: "shield.lefthalf.filled") }
                    NavigationLink { TracePage() } label: { Label(lang.string("trace.nav"), systemImage: "clock.arrow.2.circlepath") }
                }
                .papertownRowBackground(store.appearance)
            }
            .papertownInsetGroupedList()
            .papertownListAppearance(store.appearance)
            .navigationTitle(lang.string("tab.town"))
            .papertownSidebarButton()
            .papertownLargeTitle()
            .toolbar { ToolbarItem(placement: .primaryAction) { ConnectionPillButton { showServer = true } } }
            .navigationDestination(isPresented: $showServer) { ServerPage(pushed: true) }
            .refreshable { await store.refreshAll() }
        }
    }

    /// Projects in progress in the brand colour, and leads on duty in the colour of their state, as in the web's top bar.
    private func overview(_ hud: HudInfo, _ lang: AppLanguage) -> some View {
        let tone = LeadTone(hud)
        return Section {
            HStack {
                Label(lang.string("town.running"), systemImage: "folder")
                Spacer()
                Text("\(hud.lines.running)").font(.body).emNum()
                Text("/ \(hud.lines.total)").font(.caption).foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Label(lang.string("town.leads"), systemImage: "cpu")
                    Spacer()
                        .overlay(Circle().stroke(tone.color, lineWidth: 1.5).opacity(tone.state == "off" ? 1 : 0))
                    Text("\(hud.leads.running)/\(hud.leads.on)").font(.body).emNum(EmTone.issue(tone.state) ?? .info)
                }
                Text(tone.tip(lang)).font(.caption).emState(EmTone.issue(tone.state), detail: true)
            }
        } header: {
            Text(lang.string("town.section.now"))
        }
        .papertownRowBackground(store.appearance)
    }
}

/// The state of the town's resident leads: all switched-on leads running, some starting, one blocked, or none on.
struct LeadTone {
    let state: String
    let hud: HudInfo

    init(_ hud: HudInfo) {
        self.hud = hud
        let l = hud.leads
        if l.on == 0 { state = "off" }
        else if (l.blocked ?? 0) > 0 { state = "bad" }
        else if l.running < l.on { state = "warn" }
        else { state = "ok" }
    }

    var color: Color {
        switch state {
        case "ok": return .green
        case "warn": return .orange
        case "bad": return .red
        default: return .secondary
        }
    }

    func tip(_ lang: AppLanguage) -> String {
        switch state {
        case "off": return lang.string(hud.lines.running > 0 ? "town.leads.none_on" : "town.leads.no_projects")
        case "bad": return lang.format("town.leads.blocked", hud.leads.blocked ?? 0)
        case "warn": return lang.format("town.leads.starting", hud.leads.on - hud.leads.running)
        default: return lang.format("town.leads.all", hud.leads.on)
        }
    }
}

// MARK: - Departments

struct DepartmentsPage: View {
    @EnvironmentObject private var store: TownStore

    var body: some View {
        let lang = store.language
        LoadingList(load: { try await $0.departments() }) { list in
            List {
                ForEach(list) { d in
                    Section {
                        HStack {
                            Text(lang.server(d.name)).font(.body.weight(.medium))
                            Spacer()
                            Text(lang.string("dept.state.\(d.state)")).font(.caption).emState(EmTone.issue(d.state))
                        }
                        if let job = d.job, !job.isEmpty { Text(lang.server(job)).font(.caption).foregroundStyle(.secondary) }
                        ForEach(d.lines) { l in
                            NavigationLink { ProjectDetailView(projectID: l.id) } label: {
                                HStack {
                                    Text("#\(l.seq)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                                    Text(lang.server(l.title)).font(.subheadline).lineLimit(1)
                                    Spacer()
                                    if let s = l.stage { Text(lang.server(s)).font(.caption2).foregroundStyle(.secondary) }
                                }
                            }
                        }
                        ForEach(d.jobs ?? []) { j in JobRow(job: j) }
                    } header: {
                        if let district = d.district { Text(lang.server(district)) }
                    }
                }
            }
            .papertownInsetGroupedList()
            .papertownListAppearance(store.appearance)
        }
        .navigationTitle(lang.string("town.departments"))
        .papertownInlineTitle()
    }

}

// MARK: - Library

struct LibraryPage: View {
    @EnvironmentObject private var store: TownStore
    @State private var options = false
    @State private var query = ""
    @State private var result: RagResult?
    @State private var searching = false
    @State private var error: String?

    var body: some View {
        let lang = store.language
        LoadingList(load: { client -> LibraryShelf in try await client.library(limit: 60) }) { shelf in
            List {
                if let error { Section { Text(error).emState(.bad, detail: true).font(.footnote) } }
                if let result {
                    Section {
                        if result.hits.isEmpty { Text(lang.string("library.no_hits")).font(.footnote).foregroundStyle(.secondary) }
                        ForEach(result.hits) { PaperRow(paper: $0) }
                    } header: {
                        Text(lang.format("library.results", result.hits.count))
                    } footer: {
                        if let e = result.expanded, e != result.query { Text(lang.format("library.expanded", e)) }
                    }
                } else {
                    if let topics = shelf.topics, !topics.isEmpty {
                        Section(lang.string("library.topics")) {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack {
                                    ForEach(topics.prefix(20), id: \.self) { t in
                                        Button { query = t.label; Task { await search() } } label: {
                                            Text("\(lang.server(t.label)) \(t.n)").font(.caption)
                                        }
                                        .buttonStyle(.bordered)
                                        .controlSize(.small)
                                    }
                                }
                            }
                        }
                    }
                    Section(lang.format("library.shelf", shelf.total)) {
                        ForEach(shelf.papers) { PaperRow(paper: $0) }
                    }
                }
            }
            .papertownInsetGroupedList()
            .papertownListAppearance(store.appearance)
        }
        .searchable(text: $query, prompt: lang.string("library.search"))
        .onSubmit(of: .search) { Task { await search() } }
        .onChange(of: query) { q in if q.isEmpty { result = nil } }
        .overlay { if searching { ProgressView() } }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { options = true } label: { Image(systemName: "slider.horizontal.3") }.accessibilityLabel(lang.string("rag.title"))
            }
        }
        .sheet(isPresented: $options) {
            RagOptionsSheet().papertownSheetFrame(height: 380).environmentObject(store).tint(store.appearance.tintColor)
        }
        .navigationTitle(lang.string("town.library"))
        .papertownInlineTitle()
    }

    private func search() async {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return }
        searching = true
        do {
            result = try await store.fetch { try await $0.ragSearch(q) }
            error = nil
        } catch {
            self.error = store.message(for: error)
        }
        searching = false
    }
}

// MARK: - Compute

struct ComputePage: View {
    @EnvironmentObject private var store: TownStore

    private struct Loaded { let jobs: JobBoard; let gpus: GpuStatus? }

    var body: some View {
        let lang = store.language
        LoadingList(load: { client -> Loaded in
            async let j = client.jobs()
            async let g = try? client.gpus()
            return Loaded(jobs: try await j, gpus: await g)
        }) { v in
            List {
                Section(lang.string("compute.backends")) {
                    ForEach(v.jobs.backends ?? []) { b in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Image(systemName: b.ready ? "checkmark.circle" : "minus.circle").foregroundStyle(.secondary)
                                Text(lang.server(b.name)).font(.subheadline).emState(b.ready ? nil : .warn, detail: true)
                                Spacer()
                                if let a = b.active, a > 0 { Text(lang.format("compute.active", a)).font(.caption).foregroundStyle(.secondary) }
                            }
                            if let n = b.note { Text(lang.server(n)).font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                }
                Section(lang.string("compute.jobs")) {
                    if v.jobs.jobs.isEmpty { Text(lang.string("exp.jobs.empty")).font(.footnote).foregroundStyle(.secondary) }
                    ForEach(v.jobs.jobs) { job in NavigationLink { JobPage(jobID: job.id) } label: { JobRow(job: job) } }
                }
                if let g = v.gpus {
                    Section {
                        if !g.ok, let note = g.note { Text(lang.server(note)).font(.footnote).emState(.warn, detail: true) }
                        ForEach(g.nodes) { node in
                            VStack(alignment: .leading, spacing: 6) {
                                HStack {
                                    Text(node.name).font(.subheadline.weight(.semibold))
                                    Spacer()
                                    if let s = node.state { Text(s).font(.caption).emState(EmTone.issue(s)) }
                                }
                                ForEach(node.gpus ?? [], id: \.self) { gpu in
                                    VStack(alignment: .leading, spacing: 2) {
                                        HStack {
                                            Text("GPU \(gpu.index ?? 0) · \(gpu.name ?? "")").font(.caption)
                                            Spacer()
                                            if let u = gpu.utilPercent { Text("\(Int(u))%").font(.caption).emNum() }
                                        }
                                        if let used = gpu.memUsedMB, let total = gpu.memTotalMB, total > 0 {
                                            Meter(value: used / total, color: used / total > 0.9 ? .red : .accentColor)
                                            EmText(String(format: "%.1f / %.0f GB", used / 1024, total / 1024), .numbers(EmTone.usage(used / total))).font(.caption2)
                                        }
                                    }
                                }
                            }
                        }
                    } header: {
                        Text(lang.string("compute.gpus"))
                    }
                }
            }
            .papertownInsetGroupedList()
            .papertownListAppearance(store.appearance)
        }
        .navigationTitle(lang.string("town.compute"))
        .papertownInlineTitle()
    }
}

// MARK: - Quotas

struct QuotaPage: View {
    @EnvironmentObject private var store: TownStore
    @State private var reload = 0

    var body: some View {
        let lang = store.language
        LoadingList(load: { try await $0.usage() }, content: { u in
            List {
                ForEach(u.providers) { p in
                    Section {
                        if let e = p.error { Text(lang.server(e)).font(.footnote).emState(.warn, detail: true) }
                        ForEach(p.windows) { w in
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text(lang.server(w.label)).font(.subheadline)
                                    Spacer()
                                    Text("\(Int(w.used))%").font(.subheadline).emNum(EmTone.usage(w.used / 100))
                                }
                                Meter(value: w.used / 100, color: w.used >= 90 ? .red : w.used >= 70 ? .orange : store.appearance.tintColor)
                                if let r = w.resetsAt { Text(lang.format("usage.resets", Stamp.short(r, lang))).font(.caption2).emState(.warn, icon: "clock", detail: true) }
                            }
                        }
                        if let week = p.week, let cost = week.cost, cost > 0 {
                            InfoRow(label: lang.string("usage.week_cost"), value: cost.dollars, number: .info)
                        }
                    } header: {
                        HStack {
                            Text(p.label)
                            if let plan = p.plan { Text(plan).foregroundStyle(.secondary) }
                            Spacer()
                            Text(lang.string("usage.status.\(p.status)"))
                        }
                    }
                }
                Section {
                    Button(lang.string("usage.refresh")) {
                        Task {
                            _ = try? await store.fetch { try await $0.refreshUsage() }
                            reload += 1
                        }
                    }
                } footer: {
                    if let at = u.polledAt { Text(lang.format("usage.polled", Stamp.short(at, lang))) }
                }
            }
            .papertownInsetGroupedList()
            .papertownListAppearance(store.appearance)
        }, reloadKey: "\(reload)")
        .navigationTitle(lang.string("town.usage"))
        .papertownInlineTitle()
        // The server reads the subscriptions' quotas only when asked: here as the page opens, and on the button.
        .task {
            _ = try? await store.fetch { try await $0.refreshUsage() }
            reload += 1
        }
    }
}

// MARK: - MCP servers and skills

