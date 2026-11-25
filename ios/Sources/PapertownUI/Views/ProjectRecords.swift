import PapertownCore
import SwiftUI
#if canImport(WebKit)
import WebKit
#endif

// A project's records beyond its stages: the pages its lead publishes (汇报与讲解), the earlier agent conversations and
// notes imported as its memory, its budget, and its checks with their settings.

// MARK: - Pages the lead publishes

struct PagesPage: View {
    let projectID: String
    @EnvironmentObject private var store: TownStore
    @State private var kind = ""
    @State private var removing: PageMeta?

    var body: some View {
        let lang = store.language
        let started = store.cards[projectID]?.lead?.started == true
        LivePage(load: { try await $0.pages(projectID: projectID) }, events: ["page"], projectID: projectID) { list, act in
            let kinds = Array(Set(list.pages.map(\.kind))).sorted()
            let shown = list.pages.filter { kind.isEmpty || $0.kind == kind }.reversed()
            List {
                Section {
                    SendField(placeholder: lang.string("pages.request.placeholder"), button: lang.string("pages.request"), limit: 1000,
                              axis: .vertical, disabled: !started || act.busy) { q in
                        act.run(lang.string("pages.request.done")) {
                            try await $0.say("请写成一页给我看，用 `pt publish 页面.html --kind explain` 发布：\n\n\(q)", to: "lead-\(projectID)", mode: nil)
                        }
                    }
                } footer: {
                    Text(lang.string(started ? "pages.request.footer" : "pages.request.no_lead"))
                }
                if kinds.count > 1 {
                    Picker("", selection: $kind) {
                        Text(lang.string("projects.filter.all")).tag("")
                        ForEach(kinds, id: \.self) { k in Text(lang.server(list.kinds?[k] ?? k)).tag(k) }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                }
                Section {
                    if shown.isEmpty {
                        Text(lang.string("pages.empty")).font(.footnote).foregroundStyle(.secondary)
                    }
                    ForEach(Array(shown)) { page in
                        NavigationLink {
                            PageViewer(projectID: projectID, pageID: page.id, title: page.title)
                        } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(lang.server(page.title)).font(.subheadline.weight(.medium)).lineLimit(2)
                                Text([lang.server(list.kinds?[page.kind] ?? page.kind), Stamp.ago(page.at, lang), page.by.map(lang.server)]
                                    .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .swipeActions {
                            Button(lang.string("action.delete"), role: .destructive) { removing = page }
                        }
                        .contextMenu {
                            Button(lang.string("action.delete"), role: .destructive) { removing = page }
                        }
                    }
                }
            }
            .papertownInsetGroupedList()
            .papertownListAppearance(store.appearance)
            .confirmationDialog(lang.format("pages.remove.confirm", lang.server(removing?.title ?? "")),
                                isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
                Button(lang.string("action.delete"), role: .destructive) {
                    if let id = removing?.id { act.run { try await $0.removePage(projectID: projectID, id: id) } }
                }
            }
        }
        .navigationTitle(lang.string("pages.nav"))
        .papertownInlineTitle()
    }
}

/// A published page, in the policy the server serves it under: its scripts run, but it reaches nothing outside itself.
struct PageViewer: View {
    let projectID: String
    let pageID: String
    let title: String
    @EnvironmentObject private var store: TownStore
    @Environment(\.colorScheme) private var scheme
    @State private var html: String?
    @State private var error: String?

    var body: some View {
        let lang = store.language
        let look = store.appearance == .paper ? nil : (scheme == .dark ? "dark" : "light")
        Group {
            if let html {
                HTMLView(html: html).id(html)
            } else if let error {
                EmptyStateView(title: error, systemImage: "exclamationmark.triangle", description: "")
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle(lang.server(title))
        .papertownInlineTitle()
        .task(id: look) {
            do {
                let (body, policy) = try await store.fetch { try await $0.page(projectID: projectID, id: pageID, look: look) }
                try Task.checkCancellation()
                html = PageViewer.contained(body, policy: policy)
            } catch {
                guard !Task.isCancelled else { return }
                html = nil
                self.error = store.message(for: error)
            }
        }
    }

    /// The page with the server's Content-Security-Policy as a meta tag: what a meta tag can carry (not the sandbox or
    /// frame directives, which the viewer does without since the page is the only thing in it).
    static func contained(_ html: String, policy: String?) -> String {
        let fallback = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:"
        let kept = (policy ?? fallback).split(separator: ";").map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.hasPrefix("sandbox") && !$0.hasPrefix("frame-ancestors") && !$0.hasPrefix("report-") && !$0.isEmpty }
            .joined(separator: "; ")
        let meta = "<meta http-equiv=\"Content-Security-Policy\" content=\"\(kept.replacingOccurrences(of: "\"", with: "&quot;"))\">"
        if let r = html.range(of: "<head[^>]*>", options: [.regularExpression, .caseInsensitive]) {
            return html.replacingCharacters(in: r, with: html[r] + meta)
        }
        return meta + html
    }
}

#if canImport(WebKit)
/// HTML in a web view; links open in the browser.
struct HTMLView {
    let html: String
    @Environment(\.self) private var env

    init(html: String) { self.html = html }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if action.navigationType == .linkActivated, let url = action.request.url, ["http", "https", "mailto"].contains(url.scheme ?? "") {
                open(url)
                decisionHandler(.cancel)
            } else {
                decisionHandler(.allow)
            }
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction,
                     windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url, ["http", "https"].contains(url.scheme ?? "") { open(url) }
            return nil
        }

        private func open(_ url: URL) {
            #if os(iOS)
            UIApplication.shared.open(url)
            #elseif os(macOS)
            NSWorkspace.shared.open(url)
            #endif
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    fileprivate func make(_ coordinator: Coordinator) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.addUserScript(WKUserScript(source: env.emPageScript, injectionTime: .atDocumentEnd,
                                                                 forMainFrameOnly: true, in: .defaultClient))
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = coordinator
        view.uiDelegate = coordinator
        view.loadHTMLString(html, baseURL: nil)
        return view
    }
}

#if os(iOS)
extension HTMLView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView { make(context.coordinator) }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
#elseif os(macOS)
extension HTMLView: NSViewRepresentable {
    func makeNSView(context: Context) -> WKWebView { make(context.coordinator) }
    func updateNSView(_ view: WKWebView, context: Context) {}
}
#endif
#endif

// MARK: - Memory

struct MemoryPage: View {
    let projectID: String
    @EnvironmentObject private var store: TownStore
    @State private var importing = false
    @State private var removing: MemoryItem?

    var body: some View {
        let lang = store.language
        LivePage(load: { try await $0.memory(projectID: projectID) }, events: ["memory"], projectID: projectID) { m, act in
            List {
                if m.items.isEmpty {
                    Section { Text(lang.string("memory.empty")).font(.footnote).foregroundStyle(.secondary) }
                }
                ForEach(["session", "note"], id: \.self) { kind in
                    let items = m.items.filter { $0.kind == kind }
                    if !items.isEmpty {
                        Section {
                            ForEach(items) { item in
                                NavigationLink { MemoryViewer(projectID: projectID, item: item) } label: { row(item, lang) }
                                    .swipeActions { Button(lang.string("memory.remove"), role: .destructive) { removing = item } }
                                    .contextMenu { Button(lang.string("memory.remove"), role: .destructive) { removing = item } }
                            }
                        } header: {
                            HStack { Text(lang.string("memory.\(kind)s")); Spacer(); Text("\(items.count)") }
                        }
                    }
                }
            }
            .papertownInsetGroupedList()
            .papertownListAppearance(store.appearance)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { importing = true } label: { Label(lang.string("memory.import"), systemImage: "square.and.arrow.down") }
                }
            }
            .sheet(isPresented: $importing) {
                MemoryImportSheet(projectID: projectID) { keys in
                    act.run(lang.format("memory.imported", keys.count)) { try await $0.importMemory(projectID: projectID, keys: keys) }
                }
                .papertownSheetFrame(height: 560)
                .environmentObject(store)
                .tint(store.appearance.tintColor)
            }
            .confirmationDialog(lang.format("memory.remove.confirm", lang.server(removing?.title ?? "")),
                                isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
                Button(lang.string("memory.remove"), role: .destructive) {
                    if let id = removing?.id { act.run { try await $0.removeMemory(projectID: projectID, id: id) } }
                }
            } message: {
                Text(lang.string("memory.remove.note"))
            }
        }
        .navigationTitle(lang.string("memory.nav"))
        .papertownInlineTitle()
    }

    private func row(_ item: MemoryItem, _ lang: AppLanguage) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(lang.server(item.title)).font(.subheadline.weight(.medium)).lineLimit(2)
            Text(MemoryPage.where_(item.source, item.repo, lang) + (item.kind == "session" ? MemoryPage.span(item.n, item.started, item.ended, lang) : ""))
                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
    }

    static func where_(_ source: String, _ repo: String?, _ lang: AppLanguage) -> String {
        [lang.string("memory.source.\(source)"), repo.map { lang.string("memory.repo.\($0)") }].compactMap { $0 }.joined(separator: " · ")
    }

    static func span(_ n: Int?, _ started: String?, _ ended: String?, _ lang: AppLanguage) -> String {
        let day = { (s: String?) in s.map { String($0.prefix(10)) } }
        let a = day(started), b = day(ended)
        let dates = a == nil ? (b ?? "") : (b == nil || a == b ? a! : "\(a!) – \(b!)")
        return [n.map { lang.format("memory.messages", $0) }, dates.isEmpty ? nil : dates].compactMap { $0 }.map { " · " + $0 }.joined()
    }
}

struct MemoryViewer: View {
    let projectID: String
    let item: MemoryItem
    @EnvironmentObject private var store: TownStore

    var body: some View {
        let lang = store.language
        LoadingList(load: { try await $0.memoryItem(projectID: projectID, id: item.id) }) { m in
            List {
                Section {
                    Text(MemoryPage.where_(m.source, m.repo, lang) + (m.kind == "session" ? MemoryPage.span(m.n, m.started, m.ended, lang) : ""))
                        .font(.caption).foregroundStyle(.secondary)
                    if let cwd = m.cwd, !cwd.isEmpty { Text(cwd).font(.caption.monospaced()).foregroundStyle(.secondary) }
                    if let at = m.importedAt { InfoRow(label: lang.string("memory.imported_at"), value: Stamp.short(at, lang)) }
                }
                if let text = m.text {
                    Section { Text(text).font(.footnote).textSelection(.enabled) }
                }
                if let messages = m.messages {
                    Section {
                        ForEach(Array(messages.enumerated()), id: \.offset) { _, msg in
                            VStack(alignment: .leading, spacing: 3) {
                                Text([msg.role == "user" ? lang.string("memory.you") : lang.string("memory.source.\(m.source)"),
                                      msg.at.map { String($0.prefix(16)).replacingOccurrences(of: "T", with: " ") }].compactMap { $0 }.joined(separator: " · "))
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                Group {
                                    if msg.role == "user" { Text(verbatim: msg.text).emBar(.info) }
                                    else { EmText(msg.text) }
                                }.font(.footnote).textSelection(.enabled)
                            }
                            .padding(.vertical, 2)
                        }
                    }
                }
            }
            .papertownInsetGroupedList()
            .papertownListAppearance(store.appearance)
        }
        .navigationTitle(lang.server(item.title))
        .papertownInlineTitle()
    }
}

/// What the server's machine has for this project: Claude Code and Codex conversations, Claude Code's memory, and the
/// repositories' CLAUDE.md and AGENTS.md.
struct MemoryImportSheet: View {
    let projectID: String
    let done: ([String]) -> Void
    @EnvironmentObject private var store: TownStore
    @Environment(\.dismiss) private var dismiss
    @State private var picked: Set<String> = []

    var body: some View {
        let lang = store.language
        NavigationStack {
            LoadingList(load: { try await $0.memoryScan(projectID: projectID) }) { scan in
                List {
                    if let roots = scan.roots, !roots.isEmpty {
                        Section {
                            ForEach(roots, id: \.repo) { r in InfoRow(label: lang.string("memory.repo.\(r.repo)"), value: r.path) }
                        } footer: {
                            Text(lang.string("memory.import.footer"))
                        }
                    }
                    Section {
                        if scan.found.isEmpty { Text(lang.string("memory.import.none")).font(.footnote).foregroundStyle(.secondary) }
                        ForEach(scan.found) { f in
                            Button {
                                if picked.contains(f.key) { picked.remove(f.key) } else { picked.insert(f.key) }
                            } label: {
                                HStack(alignment: .top, spacing: 10) {
                                    Image(systemName: picked.contains(f.key) ? "checkmark.circle.fill" : "circle")
                                        .foregroundStyle(picked.contains(f.key) ? store.appearance.tintColor : .secondary)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(f.title).font(.subheadline).foregroundStyle(.primary).lineLimit(2)
                                        Text(MemoryPage.where_(f.source, f.repo, lang) + MemoryPage.span(nil, f.started, f.ended, lang))
                                            .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                    }
                                    Spacer()
                                    if f.changed == true {
                                        Text(lang.string("memory.import.changed")).font(.caption).emMark(.warn)
                                    } else if f.imported == true {
                                        Text(lang.string("memory.import.have")).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .papertownInsetGroupedList()
            }
            .navigationTitle(lang.string("memory.import"))
            .papertownInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(lang.string("action.cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(lang.format("memory.import.n", picked.count)) { done(Array(picked)); dismiss() }.disabled(picked.isEmpty)
                }
            }
        }
    }
}

// MARK: - Budget

struct ProjectUsagePage: View {
    let projectID: String
    @EnvironmentObject private var store: TownStore
    @State private var budget = ""

    var body: some View {
        let lang = store.language
        LivePage(load: { try await $0.lineUsage(projectID: projectID) }, events: ["usage"]) { u, act in
            List {
                Section {
                    InfoRow(label: lang.string("usage.spent"), value: u.spent.dollars, number: .info)
                    InfoRow(label: lang.string("usage.week"), value: (u.week ?? 0).dollars, number: .info)
                    InfoRow(label: lang.string("usage.budget"), value: u.budget.map(\.dollars) ?? lang.string("usage.no_budget"), number: u.budget == nil ? nil : .info)
                    if let b = u.budget, b > 0 {
                        Meter(value: u.spent / b, color: Tone.color(u.state))
                        EmText(lang.format("usage.used", Int((u.spent / b * 100).rounded()), lang.string("usage.state.\(u.state)")), .numbers(EmTone.issue(u.state) ?? .info))
                            .font(.caption).emState(EmTone.issue(u.state))
                    }
                } footer: {
                    Text(lang.string(u.logs == false ? "usage.no_logs" : "usage.api_prices"))
                }
                Section {
                    HStack {
                        Text("$").foregroundStyle(.secondary)
                        TextField(lang.string("usage.no_budget"), text: $budget)
                            #if os(iOS)
                            .keyboardType(.decimalPad)
                            #endif
                        Button(lang.string("action.save")) {
                            let usd = Double(budget.replacingOccurrences(of: ",", with: "."))
                            act.run(lang.string("usage.budget.saved")) { _ = try await $0.setBudget(projectID: projectID, usd: usd) }
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .disabled(act.busy || (!budget.isEmpty && (Double(budget.replacingOccurrences(of: ",", with: ".")) ?? 0) <= 0))
                    }
                } header: {
                    Text(lang.string("usage.budget.edit"))
                } footer: {
                    Text(lang.string("usage.budget.footer"))
                }
                .onAppear { budget = u.budget.map { String(format: "%g", $0) } ?? "" }
                if let models = u.models, !models.isEmpty {
                    Section(lang.string("usage.models")) {
                        ForEach(models, id: \.self) { m in
                            InfoRow(label: "\(m.provider) · \(m.model)", value: m.priced == false ? lang.string("usage.unpriced") : m.cost.dollars, number: m.priced == false ? nil : .info)
                        }
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

// MARK: - Checks

struct ChecksPage: View {
    let projectID: String
    @EnvironmentObject private var store: TownStore

    var body: some View {
        let lang = store.language
        LivePage(load: { try await $0.checks(projectID: projectID) }, events: ["checks", "canvas"], projectID: projectID) { v, act in
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
                                NavigationLink { CheckDetailPage(projectID: projectID, checkID: check.id) } label: { checkRow(check, lang) }
                            }
                        }
                    }
                }
            }
            .papertownInsetGroupedList()
            .papertownListAppearance(store.appearance)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button { act.run(lang.string("checks.ran")) { try await $0.runChecks(projectID: projectID) } } label: {
                            Label(lang.string("checks.run_all"), systemImage: "checkmark.seal")
                        }
                        Button {
                            act.say { c in
                                let n = try await c.askAllChecks(projectID: projectID)
                                return lang.format("checks.asked_all", n)
                            }
                        } label: {
                            Label(lang.string("checks.ask_all"), systemImage: "person.crop.circle.badge.questionmark")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .disabled(act.busy)
                }
            }
        }
        .navigationTitle(lang.string("checks.nav"))
        .papertownInlineTitle()
    }

    private func countsRow(_ title: String, _ c: CheckCounts) -> some View {
        HStack(spacing: 10) {
            Text(title).font(.subheadline.weight(.medium))
            Spacer()
            if c.pass > 0 { Label("\(c.pass)", systemImage: "checkmark").font(.caption).emNum(.good) }
            if c.warn > 0 { Label("\(c.warn)", systemImage: "exclamationmark").font(.caption).emNum(.warn) }
            if c.fail > 0 { Label("\(c.fail)", systemImage: "xmark").font(.caption).emNum(.bad) }
            Text("\(c.total)").font(.caption).foregroundStyle(.secondary)
        }
    }

    private func checkRow(_ check: ResearchCheck, _ lang: AppLanguage) -> some View {
        HStack(alignment: .top, spacing: 10) {
            if let issue = EmTone.issue(check.status) {
                Text(lang.string("check.status.\(check.status)")).font(.caption).emState(issue)
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(lang.server(check.title)).font(.subheadline.weight(.medium))
                    if check.kind == "hard", check.gate == "block" { Text(lang.string("checks.gate")).font(.caption2).foregroundStyle(.secondary) }
                }
                if let note = check.last?.note, !note.isEmpty {
                    EmText(lang.server(note)).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                } else if let text = check.text {
                    EmText(lang.server(text)).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
        }
    }
}

struct CheckDetailPage: View {
    let projectID: String
    let checkID: String
    @EnvironmentObject private var store: TownStore

    var body: some View {
        let lang = store.language
        LivePage(load: { try await $0.checks(projectID: projectID) }, events: ["checks", "canvas"], projectID: projectID) { v, act in
            if let check = v.checks.first(where: { $0.id == checkID }) {
                CheckDetailList(projectID: projectID, check: check, act: act)
                    .navigationTitle(lang.server(check.title))
            } else {
                EmptyStateView(title: lang.string("error.not_found"), systemImage: "checklist", description: "")
            }
        }
        .papertownInlineTitle()
    }
}

private struct CheckDetailList: View {
    let projectID: String
    let check: ResearchCheck
    let act: PageActions
    @EnvironmentObject private var store: TownStore
    @State private var limits: [String: String] = [:]
    @State private var prompt = ""

    private static let hours: [Double] = [6, 12, 24, 48, 72, 168]

    var body: some View {
        let lang = store.language
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(lang.string("check.status.\(check.status)")).font(.caption).emState(EmTone.issue(check.status))
                        Text(lang.string(check.kind == "hard" ? "checks.hard" : "checks.soft")).font(.caption).foregroundStyle(.secondary)
                        if let p = check.prio, !p.isEmpty { Text(p).font(.caption).foregroundStyle(.secondary) }
                    }
                    if let text = check.text { EmText(lang.server(text)).font(.subheadline) }
                }
                if let note = check.last?.note, !note.isEmpty { InfoRow(label: lang.string("check.last"), value: lang.server(note), modelText: true) }
                if let v = check.last?.value { InfoRow(label: lang.string("check.value"), value: v.formatted() + (check.unit.map { " " + lang.server($0) } ?? ""), number: EmTone.issue(check.status) ?? .info) }
                if let ts = check.last?.ts { InfoRow(label: lang.string("check.ran"), value: Stamp.short(ts, lang)) }
                if check.kind == "soft", let asked = check.asked { InfoRow(label: lang.string("check.asked"), value: Stamp.ago(asked, lang)) }
            }
            Section {
                if check.kind == "hard" {
                    Button(lang.string("check.run")) { act.run(lang.string("checks.ran")) { try await $0.runChecks(projectID: projectID) } }
                } else {
                    Button(lang.string("check.ask")) { act.run(lang.string("check.asked.done")) { try await $0.askCheck(projectID: projectID, checkID: check.id) } }
                }
            }
            .disabled(act.busy)
            settings(lang)
            if let findings = check.last?.findings, !findings.isEmpty {
                Section(lang.string("check.findings")) {
                    ForEach(findings, id: \.self) { f in
                        VStack(alignment: .leading, spacing: 3) {
                            if let file = f.file { Text(file + (f.line.map { ":\($0)" } ?? "")).font(.caption.monospaced()).foregroundStyle(.secondary) }
                            if let t = f.text { EmText(lang.server(t)).font(.footnote) }
                            if let h = f.hint, !h.isEmpty { EmText(lang.server(h)).font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                }
            }
            if let hist = check.history, hist.count > 1 {
                Section(lang.string("check.history")) {
                    ForEach(hist.indices.reversed(), id: \.self) { i in
                        let h = hist[i]
                        HStack {
                            Text(lang.string("check.status.\(h.status)")).font(.caption).emState(EmTone.issue(h.status))
                            Text(Stamp.short(h.ts, lang)).font(.footnote)
                            Spacer()
                            if let value = h.value {
                                let changed = i > 0 && hist[i - 1].value != nil && hist[i - 1].value != value
                                Text(value.formatted()).font(.footnote).emNum(EmTone.issue(h.status) ?? .info)
                                    .emMark(EmTone.issue(h.status) ?? .info, active: changed)
                            }
                        }
                    }
                }
            }
        }
        .papertownInsetGroupedList()
        .papertownListAppearance(store.appearance)
        .onAppear(perform: fill)
        .onChange(of: check) { _ in fill() }
    }

    private func fill() {
        var l: [String: String] = [:]
        if let m = check.max { l["max"] = m.formatted() }
        for p in check.params ?? [] { l[p.key] = p.value.formatted() }
        limits = l
        prompt = check.text ?? ""
    }

    @ViewBuilder
    private func settings(_ lang: AppLanguage) -> some View {
        Section {
            Toggle(lang.string("check.on"), isOn: Binding(get: { check.on }, set: { on in
                act.run { _ = try await $0.editCheck(projectID: projectID, checkID: check.id, CheckEdit(on: on)) }
            }))
            if check.kind == "hard" {
                Picker(lang.string("check.gate"), selection: Binding(get: { check.gate ?? "warn" }, set: { g in
                    act.run { _ = try await $0.editCheck(projectID: projectID, checkID: check.id, CheckEdit(gate: g)) }
                })) {
                    Text(lang.string("check.gate.block")).tag("block")
                    Text(lang.string("check.gate.warn")).tag("warn")
                }
                let keys = (check.max != nil ? ["max"] : []) + (check.params ?? []).map(\.key)
                ForEach(keys, id: \.self) { key in
                    HStack {
                        Text(key == "max" ? lang.string("check.max") : lang.server(check.params?.first { $0.key == key }?.label ?? key))
                        Spacer()
                        TextField("", text: Binding(get: { limits[key] ?? "" }, set: { limits[key] = $0 }))
                            .multilineTextAlignment(.trailing)
                            .frame(maxWidth: 100)
                            #if os(iOS)
                            .keyboardType(.decimalPad)
                            #endif
                    }
                }
                if !keys.isEmpty {
                    Button(lang.string("action.save")) {
                        let params = limits.compactMapValues { Double($0.replacingOccurrences(of: ",", with: ".")) }
                        act.run(lang.string("check.saved")) { _ = try await $0.editCheck(projectID: projectID, checkID: check.id, CheckEdit(params: params)) }
                    }
                }
            } else {
                Picker(lang.string("check.every"), selection: Binding(get: { check.every ?? 24 }, set: { h in
                    act.run { _ = try await $0.editCheck(projectID: projectID, checkID: check.id, CheckEdit(every: h)) }
                })) {
                    ForEach(Self.hours + (Self.hours.contains(check.every ?? 24) ? [] : [check.every ?? 24]), id: \.self) { h in
                        Text(h < 24 || h.truncatingRemainder(dividingBy: 24) != 0 ? lang.format("check.every.hours", Int(h)) : lang.format("check.every.days", Int(h / 24))).tag(h)
                    }
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text(lang.string("check.prompt")).font(.caption).foregroundStyle(.secondary)
                    TextField("", text: $prompt, axis: .vertical).lineLimit(3...10)
                        .onChange(of: prompt) { if $0.count > 2000 { prompt = String($0.prefix(2000)) } }
                    if prompt != (check.text ?? "") {
                        Button(lang.string("action.save")) {
                            let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
                            act.run(lang.string("check.saved")) { _ = try await $0.editCheck(projectID: projectID, checkID: check.id, CheckEdit(prompt: text)) }
                        }
                        .disabled(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
        } header: {
            Text(lang.string("check.settings"))
        }
        .disabled(act.busy)
    }
}
