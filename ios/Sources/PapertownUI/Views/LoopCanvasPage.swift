import PapertownCore
import SwiftUI

// The research loop's canvas as a page of its own, its nodes' sheets, and its picture on the project page.

struct LoopCanvasData {
    let view: LoopView
    let outputs: ProjectOutputs?
}

private let canvasEvents: Set<String> = ["canvas", "checks", "line", "agent", "decided", "report"]

/// The whole loop on one canvas, as on the web: pinch, pan, tap a node for its page, long-press one to move it, add
/// a task, check or note where you are looking.
struct LoopCanvasPage: View {
    let projectID: String
    @EnvironmentObject private var store: TownStore
    @State private var camera = LoopCamera()
    @State private var touched = false
    @State private var filter: LoopFilter = .all
    @State private var allLines = false
    @State private var picked: LoopNode?
    @State private var adding = false
    @State private var showList = false
    @State private var showOutline = false
    @State private var size: CGSize = .zero

    var body: some View {
        let lang = store.language
        LivePage(load: { c in
            async let v = c.loop(projectID: projectID)
            async let s = try? c.projectSnapshot(id: projectID)
            return LoopCanvasData(view: try await v, outputs: await s?.outputs)
        }, events: canvasEvents, projectID: projectID) { d, act in
            let ctx = LoopContext(view: d.view, card: store.cards[projectID], outputs: d.outputs, lang: lang)
            GeometryReader { geo in
                LoopBoard(ctx: ctx, size: geo.size, camera: $camera, filter: filter, allLines: allLines, selected: picked?.id,
                          touched: { touched = true },
                          tap: { picked = $0 },
                          moved: { id, p in act.run { try await $0.moveNodes(projectID: projectID, [id: [Double(p.x), Double(p.y)]]) } })
                    .onAppear { size = geo.size; fit(ctx, animated: false) }
                    .onChange(of: geo.size) { s in size = s; if !touched { fit(ctx, animated: false) } }
            }
            .background(LoopInk.ground.ignoresSafeArea())
            .overlay(alignment: .bottom) { controls(ctx, lang) }
            .toolbar { toolbar(ctx, act, lang) }
            .sheet(item: $picked) { n in
                LoopNodeSheet(projectID: projectID, node: n, ctx: ctx, act: act)
                    .environmentObject(store)
            }
            .sheet(isPresented: $adding) {
                NewLoopNodeSheet(projectID: projectID, agents: d.view.agents ?? [:]) { node in
                    var node = node
                    let c = camera.canvas(CGPoint(x: size.width / 2, y: size.height / 2))
                    let s = LoopGeo.size(kind: node.kind)
                    node.x = Double(c.x - s.width / 2).rounded()
                    node.y = Double(c.y - s.height / 2).rounded()
                    act.run { try await $0.addNode(projectID: projectID, node) }
                }
                .environmentObject(store)
            }
        }
        .navigationTitle(lang.string("loop.nav"))
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .papertownHidesTabBar()
        .navigationDestination(isPresented: $showList) { LoopPage(projectID: projectID) }
        .navigationDestination(isPresented: $showOutline) { OutlinePage(projectID: projectID) }
    }

    private func fit(_ ctx: LoopContext, animated: Bool) {
        let next = LoopCamera.fit(LoopGeo.bounds(ctx.view), in: size)
        if animated { withAnimation(.easeInOut(duration: 0.3)) { camera = next } } else { camera = next }
    }

    /// The zoom, and a way back to the whole loop.
    private func controls(_ ctx: LoopContext, _ lang: AppLanguage) -> some View {
        HStack(spacing: 14) {
            Button { step(0.8, ctx) } label: { Image(systemName: "minus") }
            Text("\(Int((camera.zoom * 100).rounded()))%")
                .font(.caption.monospacedDigit())
                .frame(minWidth: 40)
            Button { step(1.25, ctx) } label: { Image(systemName: "plus") }
            Divider().frame(height: 16)
            Button { touched = false; fit(ctx, animated: true) } label: {
                Image(systemName: "arrow.up.left.and.down.right.and.arrow.up.right.and.down.left")
            }
            .accessibilityLabel(lang.string("canvas.fit"))
        }
        .font(.subheadline.weight(.semibold))
        .buttonStyle(.plain)
        .padding(.horizontal, 16)
        .padding(.vertical, 9)
        .background(.regularMaterial, in: Capsule())
        .padding(.bottom, 10)
    }

    private func step(_ k: CGFloat, _ ctx: LoopContext) {
        touched = true
        let least = min(1, LoopCamera.fit(LoopGeo.bounds(ctx.view), in: size).zoom) * 0.98
        let z = min(max(camera.zoom * k, least), LoopGeo.maxZoom)
        withAnimation(.easeInOut(duration: 0.2)) {
            camera = camera.zoomed(to: z, at: CGPoint(x: size.width / 2, y: size.height / 2))
        }
    }

    @ToolbarContentBuilder
    private func toolbar(_ ctx: LoopContext, _ act: PageActions, _ lang: AppLanguage) -> some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Menu {
                Picker(lang.string("canvas.filter"), selection: $filter) {
                    ForEach(LoopFilter.allCases) { f in Text(lang.string("canvas.filter.\(f.rawValue)")).tag(f) }
                }
                Toggle(lang.string("canvas.lines.all"), isOn: $allLines)
                Divider()
                Button { touched = false; fit(ctx, animated: true) } label: {
                    Label(lang.string("canvas.fit"), systemImage: "arrow.up.left.and.down.right.and.arrow.up.right.and.down.left")
                }
                Button {
                    act.run(lang.string("canvas.tidy.done")) { try await $0.tidyLoop(projectID: projectID) }
                } label: {
                    Label(lang.string("canvas.tidy"), systemImage: "square.grid.3x3")
                }
                Divider()
                Button { showList = true } label: { Label(lang.string("canvas.list"), systemImage: "list.bullet") }
                Button { showOutline = true } label: { Label(lang.string("outline.nav"), systemImage: "text.alignleft") }
            } label: {
                Image(systemName: filter == .all ? "ellipsis.circle" : "line.3.horizontal.decrease.circle.fill")
            }
        }
        ToolbarItem(placement: .primaryAction) {
            Button { adding = true } label: { Image(systemName: "plus") }
                .disabled(act.busy)
                .accessibilityLabel(lang.string("canvas.add"))
        }
    }
}

// MARK: - A node's sheet

/// What a tapped node opens: its page where it has one (a gate, task or check), its details otherwise; and its lines.
struct LoopNodeSheet: View {
    let projectID: String
    let node: LoopNode
    let ctx: LoopContext
    let act: PageActions
    @EnvironmentObject private var store: TownStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let lang = store.language
        NavigationStack {
            page
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(lang.string("action.done")) { dismiss() }
                    }
                    ToolbarItem(placement: .primaryAction) {
                        NavigationLink {
                            LoopLinksPage(projectID: projectID, nodeID: node.id)
                        } label: {
                            Label(lang.string("canvas.links"), systemImage: "point.topleft.down.to.point.bottomright.curvepath")
                        }
                    }
                }
        }
        .presentationDetents([.medium, .large])
    }

    @ViewBuilder
    private var page: some View {
        switch node.kind {
        case "gate":
            LoopGatePage(projectID: projectID, stage: node.gate?.stage ?? node.ref ?? "")
        case "task":
            LoopTaskPage(projectID: projectID, nodeID: node.id)
        case "hard", "soft":
            CheckDetailPage(projectID: projectID, checkID: node.check?.id ?? node.ref ?? "")
        default:
            LoopNodeDetail(projectID: projectID, node: node, ctx: ctx, act: act)
        }
    }
}

/// A stage, the spec or clamp, the human gate, an info card or a note.
struct LoopNodeDetail: View {
    let projectID: String
    let node: LoopNode
    let ctx: LoopContext
    let act: PageActions
    @EnvironmentObject private var store: TownStore
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var confirmRemove = false

    var body: some View {
        let lang = store.language
        List {
            switch node.kind {
            case "stage": stage(lang)
            case "spec", "clamp": rules(lang)
            case "human": human(lang)
            case "note": note(lang)
            case "info":
                Section { InfoBody(n: node, ctx: ctx, full: true).font(.subheadline) }
                    .papertownRowBackground(store.appearance)
                infoLink(lang)
            default: EmptyView()
            }
            Section {
                Button(lang.string("canvas.remove"), role: .destructive) { confirmRemove = true }
            }
            .papertownRowBackground(store.appearance)
        }
        .papertownInsetGroupedList()
        .papertownListAppearance(store.appearance)
        .navigationTitle(LoopRead.name(node, ctx))
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .onAppear { text = node.text ?? "" }
        .confirmationDialog(lang.format("canvas.remove.confirm", LoopRead.name(node, ctx)), isPresented: $confirmRemove, titleVisibility: .visible) {
            Button(lang.string("canvas.remove"), role: .destructive) {
                act.run { try await $0.removeNode(projectID: projectID, nodeID: node.id) }
                dismiss()
            }
        }
    }

    @ViewBuilder
    private func stage(_ lang: AppLanguage) -> some View {
        let st = node.status ?? "todo"
        Section {
            HStack {
                Text(TextFormatters.stageStatus(st, language: lang)).font(.caption).emState(EmTone.issue(st))
                Spacer()
                Text("\(Int(node.pct ?? 0))%").font(.subheadline).emNum()
            }
            ProgressView(value: node.pct ?? 0, total: 100)
                .tint(LoopInk.tone(st == "done" ? "pass" : st == "run" ? "run" : "none"))
            if let l = node.locked {
                Text(lang.format("canvas.stage.locked", TextFormatters.stageName(l.gate, language: lang))).emState(.bad, icon: "lock.fill", detail: true)
            }
            let line = LoopRead.stationLine(node, ctx)
            if !line.isEmpty, node.locked == nil { Text(line).foregroundStyle(.secondary) }
            if let role = node.role {
                LabeledContent(lang.string("canvas.detail.role"), value: TextFormatters.roleName(role, language: lang))
            }
        }
        .papertownRowBackground(store.appearance)
        BasisSection(projectID: projectID, basis: node.basis)
        let checks = (ctx.view.checks ?? []).filter { $0.stage == node.ref }
        if !checks.isEmpty {
            Section(lang.string("canvas.detail.checks")) {
                ForEach(checks) { c in
                    NavigationLink {
                        CheckDetailPage(projectID: projectID, checkID: c.id)
                    } label: {
                        HStack {
                            Image(systemName: c.kind == "soft" ? "eye" : "diamond").foregroundStyle(.secondary)
                            Text(lang.server(c.title))
                            Spacer()
                            Text(lang.string("canvas.verdict.\(c.status)")).font(.caption).emState(EmTone.issue(c.status))
                        }
                    }
                }
            }
            .papertownRowBackground(store.appearance)
        }
    }

    @ViewBuilder
    private func rules(_ lang: AppLanguage) -> some View {
        let rs = node.rules ?? []
        Section {
            if rs.isEmpty {
                Text(lang.string(node.kind == "spec" ? "canvas.spec.none" : "canvas.clamp.empty")).foregroundStyle(.secondary)
            }
            ForEach(rs) { r in
                VStack(alignment: .leading, spacing: 3) {
                    Text(lang.string("canvas.rule.\(r.kind)")).font(.caption.weight(.semibold))
                        .foregroundStyle(r.kind == "never" ? LoopInk.hard : r.kind == "ask" ? LoopInk.amber : LoopInk.spec)
                    Text(lang.server(r.text))
                }
            }
        } footer: {
            Text(node.kind == "spec" ? lang.format("canvas.spec.count", rs.count) : lang.format("canvas.clamp.count", rs.count))
        }
        .papertownRowBackground(store.appearance)
    }

    @ViewBuilder
    private func human(_ lang: AppLanguage) -> some View {
        let items = node.items ?? []
        Section {
            if items.isEmpty { Text(lang.string("canvas.human.hint")).foregroundStyle(.secondary) }
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                if item.kind == "matter", let ask = item.ask {
                    NavigationLink { ProjectDetailView(projectID: projectID, matterID: ask) } label: { humanRow(item, lang) }
                } else if let gate = item.gate {
                    NavigationLink { LoopGatePage(projectID: projectID, stage: gate) } label: { humanRow(item, lang) }
                } else if let id = item.id, item.kind == "blocked" || item.kind == "stale" {
                    NavigationLink { LoopTaskPage(projectID: projectID, nodeID: id) } label: { humanRow(item, lang) }
                } else {
                    humanRow(item, lang)
                }
            }
        } header: {
            Text(items.isEmpty ? lang.string("canvas.human.empty") : lang.format("loop.human", items.count))
        }
        .papertownRowBackground(store.appearance)
    }

    private func humanRow(_ item: LoopHumanItem, _ lang: AppLanguage) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            EmText(lang.server(item.text)).emBar(.warn)
            if let basis = item.basis, !basis.isEmpty {
                Text(lang.format("decided.basis.refs", basis.joined(separator: " · "))).font(.caption.monospaced())
            }
        }
    }

    @ViewBuilder
    private func note(_ lang: AppLanguage) -> some View {
        Section {
            TextField(lang.string("loop.new.text.note"), text: $text, axis: .vertical)
                .lineLimit(3...12)
            Button(lang.string("action.save")) {
                let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
                act.run(lang.string("canvas.note.saved")) { try await $0.editNode(projectID: projectID, nodeID: node.id, LoopNodeEdit(text: t)) }
            }
            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || text == node.text)
        }
        .papertownRowBackground(store.appearance)
    }

    /// The page with the rest of what an info card shows.
    @ViewBuilder
    private func infoLink(_ lang: AppLanguage) -> some View {
        switch InfoCard.kind(node) {
        case "survey": open(lang) { OverlapPage(projectID: projectID) }
        case "method", "datasets": open(lang) { MethodPage(projectID: projectID) }
        case "runs", "results": open(lang) { ExperimentsPage(projectID: projectID) }
        case "paper": open(lang) { PaperPage(projectID: projectID) }
        case "code": open(lang) { FilesPage(projectID: projectID, root: "code") }
        default: EmptyView()
        }
    }

    private func open<D: View>(_ lang: AppLanguage, @ViewBuilder _ dest: @escaping () -> D) -> some View {
        Section {
            NavigationLink(destination: dest) { Label(lang.string("canvas.open.page"), systemImage: "arrow.up.right.square") }
        }
        .papertownRowBackground(store.appearance)
    }
}

// MARK: - Lines

/// A node's lines: unlink one, or link it to another node.
struct LoopLinksPage: View {
    let projectID: String
    let nodeID: String
    @EnvironmentObject private var store: TownStore

    var body: some View {
        let lang = store.language
        LivePage(load: { try await $0.loop(projectID: projectID) }, events: canvasEvents, projectID: projectID) { v, act in
            let ctx = LoopContext(view: v, card: store.cards[projectID], outputs: nil, lang: lang)
            let mine = (v.edges ?? []).filter { $0.source == nodeID || $0.target == nodeID }
            List {
                Section {
                    if mine.isEmpty { Text(lang.string("canvas.links.none")).foregroundStyle(.secondary) }
                    ForEach(mine) { e in
                        let out = e.source == nodeID
                        let other = ctx.nodes[out ? e.target : e.source]
                        HStack(spacing: 10) {
                            Image(systemName: out ? "arrow.right" : "arrow.left").foregroundStyle(.secondary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(other.map { LoopRead.name($0, ctx) } ?? e.target)
                                Text(lang.string("canvas.edge.kind.\(e.kind ?? "plain")") + (e.label.map { " · " + $0 } ?? ""))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button(lang.string("canvas.links.cut"), role: .destructive) {
                                act.run { try await $0.disconnect(projectID: projectID, edgeID: e.id) }
                            }
                            .buttonStyle(.borderless)
                            .disabled(act.busy)
                        }
                    }
                }
                .papertownRowBackground(store.appearance)
                Section {
                    NavigationLink {
                        LoopLinkPicker(projectID: projectID, nodeID: nodeID, ctx: ctx, linked: Set(mine.flatMap { [$0.source, $0.target] }), act: act)
                    } label: {
                        Label(lang.string("canvas.links.to"), systemImage: "plus")
                    }
                }
                .papertownRowBackground(store.appearance)
            }
            .papertownInsetGroupedList()
            .papertownListAppearance(store.appearance)
        }
        .navigationTitle(lang.string("canvas.links"))
    }
}

/// Every other node by its part of the flow; picking one draws a line to it.
private struct LoopLinkPicker: View {
    let projectID: String
    let nodeID: String
    let ctx: LoopContext
    let linked: Set<String>
    let act: PageActions
    @EnvironmentObject private var store: TownStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let lang = store.language
        List {
            ForEach(ctx.view.blocks ?? []) { b in
                let ns = ctx.view.nodes.filter { $0.mod == b.key && $0.id != nodeID && !linked.contains($0.id) }
                if !ns.isEmpty {
                    Section(lang.server(b.title)) {
                        ForEach(ns) { n in
                            Button {
                                act.run(lang.string("canvas.links.done")) { try await $0.connect(projectID: projectID, source: nodeID, target: n.id) }
                                dismiss()
                            } label: {
                                Text(LoopRead.name(n, ctx)).foregroundStyle(.primary)
                            }
                        }
                    }
                    .papertownRowBackground(store.appearance)
                }
            }
        }
        .papertownInsetGroupedList()
        .papertownListAppearance(store.appearance)
        .navigationTitle(lang.string("canvas.links.to"))
    }
}

// MARK: - On the project page

/// The loop in miniature at the top of a project's page, with a line of how it stands; it opens the canvas.
struct LoopPreviewSection: View {
    let projectID: String
    @EnvironmentObject private var store: TownStore
    @State private var view: LoopView?
    @State private var pending: Task<Void, Never>?

    var body: some View {
        let lang = store.language
        Section {
            NavigationLink {
                LoopCanvasPage(projectID: projectID)
            } label: {
                VStack(alignment: .leading, spacing: 8) {
                    if let view {
                        let ctx = LoopContext(view: view, card: store.cards[projectID], outputs: nil, lang: lang)
                        GeometryReader { geo in
                            LoopBoard(ctx: ctx, size: geo.size,
                                      camera: .constant(LoopCamera.fit(LoopGeo.bounds(view), in: geo.size, pad: 0.01)), live: false)
                        }
                        .frame(height: 180)
                        .background(LoopInk.ground)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        ChipFlow(spacing: 6, lineSpacing: 4) {
                            ForEach(Array(summary(ctx).enumerated()), id: \.offset) { _, p in
                                EmText(p.0, .numbers(p.1)).font(.caption2)
                            }
                        }
                    } else {
                        ProgressView().frame(maxWidth: .infinity, minHeight: 180)
                    }
                }
                .padding(.vertical, 4)
            }
            .papertownRowBackground(store.appearance)
        } header: {
            Text(lang.string("loop.nav"))
        } footer: {
            Text(lang.string("canvas.hint"))
        }
        .task { await load() }
        .onReceive(store.events) { e in
            guard canvasEvents.contains(e.name), concerns(e.payload) else { return }
            pending?.cancel()
            pending = Task {
                try? await Task.sleep(nanoseconds: 800_000_000)
                if !Task.isCancelled { await load() }
            }
        }
    }

    private func load() async {
        if let v = try? await store.fetch({ try await $0.loop(projectID: projectID) }) { view = v }
    }

    /// The whole loop in a few words: its stages, its gates, its sentinels, its tasks, what waits for you.
    private func summary(_ ctx: LoopContext) -> [(String, EmTone)] {
        let lang = ctx.lang, ns = ctx.view.nodes
        var out: [(String, EmTone)] = []
        let stages = ns.filter { $0.kind == "stage" }
        if !stages.isEmpty {
            let done = stages.filter { $0.status == "done" }.count
            out.append((lang.format("canvas.pill.stages", done, stages.count), done == stages.count ? .good : .info))
        }
        let looks = ns.compactMap { $0.kind == "gate" ? $0.gate.map(LoopRead.gateLook) : nil }
        let blocking = looks.filter { $0 == "block" }.count, warning = looks.filter { $0 == "warn" }.count
        if blocking > 0 { out.append((lang.format("canvas.sum.block", blocking), .bad)) }
        if warning > 0 { out.append((lang.format("canvas.sum.warn", warning), .warn)) }
        let off = ns.filter { $0.kind == "soft" && ($0.check.map { $0.on && ["warn", "fail"].contains($0.status) } ?? false) }.count
        if off > 0 { out.append((lang.format("canvas.pill.soft", off), .warn)) }
        let tasks = ns.filter { $0.kind == "task" }
        if !tasks.isEmpty {
            out.append((lang.format("canvas.pill.tasks.open", tasks.count, tasks.filter { $0.status != "done" }.count), .info))
        }
        if let n = ns.first(where: { $0.kind == "human" })?.items?.count, n > 0 {
            out.append((lang.format("loop.human", n), .warn))
        }
        return out
    }

    private func concerns(_ p: [String: JSONValue]) -> Bool {
        let line = p["line_id"]?.stringValue ?? p["line"]?.field("id")?.stringValue ?? p["agent"]?.field("line_id")?.stringValue
        return line == nil || line == projectID
    }
}
