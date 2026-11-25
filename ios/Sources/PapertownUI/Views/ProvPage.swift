import PapertownCore
import SwiftUI

struct ProvStatsLine: View {
    let stats: ProvStats?
    var projectSummary = false
    @EnvironmentObject private var store: TownStore

    var body: some View {
        let lang = store.language
        RecordStatsLine(items: [
            .init(label: lang.string("prov.floats"), count: stats?.floats?.tagged, total: stats?.floats?.total, attention: stats?.floats?.tagged != stats?.floats?.total, tone: .good),
            .init(label: lang.string("prov.numbers"), count: stats?.numbers?.ok, total: stats?.numbers?.total, attention: stats?.numbers?.ok != stats?.numbers?.total, tone: .good),
            .init(label: lang.string("prov.state.changed"), count: stats?.changed, attention: true),
            .init(label: lang.string("prov.ops.label"), count: stats?.ops)
        ], empty: projectSummary ? lang.string("records.none") : nil)
    }
}

struct ProvPage: View {
    let projectID: String
    var file: String? = nil
    @EnvironmentObject private var store: TownStore
    @State private var operations = false

    var body: some View {
        let lang = store.language
        LivePage(load: { try await $0.prov(projectID: projectID) }, events: ["prov"], projectID: projectID) { tree, _ in
            VStack(alignment: .leading, spacing: 8) {
                ProvStatsLine(stats: tree.stats).padding(.horizontal, 20)
                Picker(lang.string("prov.nav"), selection: $operations) {
                    Text(lang.string("prov.tree")).tag(false)
                    Text(lang.string("prov.ops")).tag(true)
                }
                .pickerStyle(.segmented).padding(.horizontal)
                if operations {
                    ProvOpsList(projectID: projectID)
                } else {
                    ProvOutline(projectID: projectID, tree: tree, file: file)
                }
            }
            .padding(.top, 6)
            .background(store.appearance.groupedBackground ?? .clear)
        }
        .navigationTitle(lang.string("prov.nav"))
        .papertownInlineTitle()
        .papertownHidesTabBar()
    }
}

/// A flat list keeps the expand button independent of the detail link, even for a deeply nested source on iPhone.
private struct ProvOutline: View {
    let projectID: String
    let tree: ProvTree
    let file: String?
    @EnvironmentObject private var store: TownStore
    @State private var toggled: Set<String> = []

    struct Row: Identifiable {
        enum Item {
            case file(String), section(String, Int?), other(Int), rest([ProvTree.Rest]), loose, node(String)
        }
        let id: String
        let depth: Int
        let item: Item
        var expanded: Bool? = nil
    }

    private struct Branch: Identifiable {
        let id: String
        var rows: [Row]
    }

    private func disclosure(_ key: String, hasChildren: Bool, initial: Bool = false) -> Bool? {
        hasChildren ? initial != toggled.contains(key) : nil
    }

    private func appendNodes(_ ids: [String], under parent: String, depth: Int, ancestors: Set<String> = [], to rows: inout [Row]) {
        for id in ids where !ancestors.contains(id) {
            let key = parent + "/" + id
            let path = ancestors.union([id])
            let children = (tree.nodes?[id]?.src ?? []).filter { !path.contains($0) }
            let expanded = disclosure(key, hasChildren: !children.isEmpty)
            rows.append(Row(id: key, depth: depth, item: .node(id), expanded: expanded))
            if expanded == true { appendNodes(children, under: key, depth: depth + 1, ancestors: path, to: &rows) }
        }
    }

    private func branch(_ f: ProvTree.File, index: Int, initiallyOpen: Bool) -> Branch {
        let key = "file:" + (f.path ?? String(index))
        let sections = Array((f.sections ?? []).enumerated())
        let registered = sections.filter { $0.element.nodes?.isEmpty == false }
        let other = sections.filter { $0.element.nodes?.isEmpty != false }
        let open = disclosure(key, hasChildren: !sections.isEmpty, initial: initiallyOpen)
        let filename = f.path ?? f.title ?? ""
        var rows = [Row(id: key, depth: 0, item: .file(filename), expanded: open)]
        guard open == true else { return Branch(id: key, rows: rows) }

        func appendSection(_ section: ProvTree.Section, index: Int, depth: Int) {
            let sectionKey = key + "/s\(index)"
            let ids = section.nodes ?? [], rest = section.rest ?? []
            let expanded = disclosure(sectionKey, hasChildren: !ids.isEmpty || !rest.isEmpty, initial: !ids.isEmpty)
            let isOpening = index == 0 && [f.path, f.title, (filename as NSString).lastPathComponent, ""].contains(section.title ?? "")
            let title = isOpening ? store.language.string("prov.opening") : section.title ?? ""
            rows.append(Row(id: sectionKey, depth: depth, item: .section(title, section.line), expanded: expanded))
            if expanded == true {
                appendNodes(ids, under: sectionKey, depth: depth + 1, to: &rows)
                if !rest.isEmpty { rows.append(Row(id: sectionKey + "/rest", depth: depth + 1, item: .rest(rest))) }
            }
        }
        for (index, section) in registered { appendSection(section, index: index, depth: 1) }
        if !other.isEmpty {
            let otherKey = key + "/other"
            let expanded = toggled.contains(otherKey)
            rows.append(Row(id: otherKey, depth: 1, item: .other(other.count), expanded: expanded))
            if expanded {
                for (index, section) in other { appendSection(section, index: index, depth: 2) }
            }
        }
        return Branch(id: key, rows: rows)
    }

    private var branches: [Branch] {
        let files = Array((tree.files ?? []).enumerated())
        let hasRecords: (ProvTree.File) -> Bool = { $0.sections?.contains { $0.nodes?.isEmpty == false } == true }
        let registered = files.filter { hasRecords($0.element) }
        let others = files.filter { !hasRecords($0.element) }
        var result = (registered + others).map { i, f in
            branch(f, index: i, initiallyOpen: file.map { $0 == f.path } ?? (hasRecords(f) || (registered.isEmpty && i == 0)))
        }
        if let ids = tree.loose, !ids.isEmpty {
            let open = disclosure("loose", hasChildren: true, initial: result.isEmpty)
            var rows = [Row(id: "loose", depth: 0, item: .loose, expanded: open)]
            if open == true { appendNodes(ids, under: "loose", depth: 1, to: &rows) }
            result.append(Branch(id: "loose", rows: rows))
        }
        return result
    }

    var body: some View {
        let lang = store.language
        let visible = branches
        ScrollViewReader { proxy in
            List {
                if visible.isEmpty {
                    Text(lang.string("prov.tree.empty")).font(.subheadline).foregroundStyle(.secondary)
                        .listRowBackground(Color.clear)
                }
                ForEach(visible) { branch in
                    Section {
                        ForEach(branch.rows) { row in
                            rowView(row, lang)
                                .alignmentGuide(.listRowSeparatorLeading) { _ in 0 }
                                .listRowInsets(EdgeInsets(top: 4, leading: 12 + CGFloat(min(row.depth, 4)) * 5, bottom: 4, trailing: 12))
                                .id(row.id)
                        }
                    }
                    .papertownRowBackground(store.appearance)
                }
            }
            .recordList(store.appearance)
            .onAppear { if let file { proxy.scrollTo("file:" + file, anchor: .top) } }
        }
    }

    @ViewBuilder
    private func rowView(_ row: Row, _ lang: AppLanguage) -> some View {
        switch row.item {
        case .file(let name): heading(name, row: row, symbol: "doc.text")
        case .section(let title, let line): heading(title, row: row, trailing: line.map { lang.format("prov.line", $0) })
        case .other(let count): heading(lang.format("prov.other_sections", count), row: row, secondary: true)
        case .loose: heading(lang.string("prov.loose"), row: row, symbol: "tray")
        case .rest(let rest):
            HStack(alignment: .firstTextBaseline) {
                Text(lang.string("prov.rest"))
                Spacer(minLength: 6)
                Text(rest.map { r in
                    [r.who.map(lang.server), r.lines.map { lang.format("prov.lines", $0) }].compactMap { $0 }.joined(separator: " ")
                }.joined(separator: " · ")).multilineTextAlignment(.trailing)
            }
            .font(.caption).foregroundStyle(.secondary)
        case .node(let id):
            HStack(spacing: 3) {
                if let expanded = row.expanded {
                    Button { toggle(row.id) } label: {
                        Image(systemName: expanded ? "chevron.down" : "chevron.right")
                            .font(.caption2.weight(.semibold)).frame(width: 21, height: 36).contentShape(Rectangle())
                    }
                    .buttonStyle(.borderless).foregroundStyle(.secondary)
                    .accessibilityLabel(lang.string(expanded ? "prov.collapse" : "prov.expand") + " " + (tree.nodes?[id]?.tag ?? id))
                    .accessibilityIdentifier("prov.expand." + id)
                }
                NavigationLink { ProvNodePage(projectID: projectID, nodeID: id, nodes: tree.nodes ?? [:]) } label: {
                    if let n = tree.nodes?[id] { ProvNodeLabel(node: n) } else { Text(id).font(.caption.monospaced()) }
                }
                .accessibilityIdentifier("prov.node." + id)
            }
        }
    }

    private func toggle(_ id: String) {
        if !toggled.insert(id).inserted { toggled.remove(id) }
    }

    private func heading(_ title: String, row: Row, symbol: String? = nil, trailing: String? = nil, secondary: Bool = false) -> some View {
        let label = HStack(spacing: 7) {
            Image(systemName: row.expanded == true ? "chevron.down" : "chevron.right")
                .font(.caption2.weight(.semibold)).foregroundStyle(.secondary).frame(width: 12)
                .opacity(row.expanded == nil ? 0 : 1)
            if let symbol { Image(systemName: symbol).font(.footnote).foregroundStyle(.secondary) }
            Text(title).font(.subheadline.weight(row.depth == 0 ? .semibold : .regular))
                .foregroundStyle(secondary ? .secondary : .primary).lineLimit(1)
            Spacer(minLength: 4)
            if let trailing { Text(trailing).font(.caption).monospacedDigit().foregroundStyle(.secondary) }
        }
        .contentShape(Rectangle())
        return Group {
            if row.expanded != nil { Button { toggle(row.id) } label: { label }.buttonStyle(.plain) }
            else { label }
        }
    }
}

private func kindSymbol(_ kind: String?) -> String {
    switch kind {
    case "passage": return "text.alignleft"
    case "artifact": return "square.stack.3d.up"
    case "result": return "doc.text"
    case "source": return "book"
    default: return "doc"
    }
}

struct ProvState: View {
    let state: String
    @EnvironmentObject private var store: TownStore

    var body: some View {
        if ["changed", "missing", "moved"].contains(state) {
            let icon = state == "missing" ? "exclamationmark.triangle" : state == "moved" ? "arrow.up.and.down" : "pencil"
            Text(store.language.string("prov.state.\(state)")).font(.caption2).emState(EmTone.issue(state), icon: icon)
        }
    }
}

private struct ProvIssues: View {
    let node: ProvNode
    @EnvironmentObject private var store: TownStore

    var body: some View {
        let hasState = ["changed", "missing", "moved"].contains(node.state ?? "")
        let numbers = node.numbers ?? []
        let unmatched = numbers.contains { $0.ok == false }
        if let state = node.state, hasState { ProvState(state: state) }
        if unmatched {
            let ok = numbers.filter { $0.ok == true }.count
            EmText(store.language.format("prov.numbers.count", ok, numbers.count), .numbers(.warn)).font(.caption2).fixedSize()
        }
        if node.gaps?.isEmpty == false {
            Text(store.language.string("prov.gaps")).font(.caption2).emState(.warn).fixedSize()
        }
    }
}

private struct ProvNodeLabel: View {
    let node: ProvNode
    @EnvironmentObject private var store: TownStore

    var body: some View {
        ViewThatFits(in: .horizontal) {
            line(compact: false, timeOnly: false)
            line(compact: false, timeOnly: true)
            line(compact: true, timeOnly: true)
            line(compact: true, timeOnly: true, scrollTitle: true)
        }
        .accessibilityRepresentation {
            line(compact: false, timeOnly: false).fixedSize().accessibilityElement(children: .combine)
        }
    }

    @ViewBuilder
    private func title(compact: Bool) -> some View {
        Image(systemName: kindSymbol(node.kind)).font(.caption).foregroundStyle(.secondary)
            .accessibilityLabel(node.kind.map { store.language.string("prov.kind.\($0)") } ?? "")
        if let tag = node.tag { Text(tag).font(.caption2.monospaced()).foregroundStyle(.secondary).fixedSize() }
        Text(node.title ?? node.path ?? "").font(.footnote).lineLimit(1)
            .fixedSize(horizontal: !compact, vertical: false)
            .frame(minWidth: compact ? 28 : nil, idealWidth: compact ? 30 : nil, alignment: .leading)
        ProvIssues(node: node)
    }

    private func line(compact: Bool, timeOnly: Bool, scrollTitle: Bool = false) -> some View {
        let lang = store.language
        let author = node.made?.who ?? node.made?.agent
        let who = author.map { raw in
            if compact {
                switch raw {
                case "开始记录前已有": return lang.string("prov.author.base")
                case "写作员工": return lang.string("prov.author.writer")
                case "代码员工": return lang.string("prov.author.coder")
                default: break
                }
            }
            return lang.server(raw)
        }
        let stamp = node.made?.at ?? node.createdAt
        let at = stamp.map { Stamp.compact($0, timeOnly: timeOnly) }
        return HStack(alignment: .firstTextBaseline, spacing: compact ? 2 : 4) {
            if scrollTitle {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .firstTextBaseline, spacing: 2) { title(compact: true) }
                }
            } else {
                title(compact: compact)
                Spacer(minLength: 1)
            }
            Text([who, at].compactMap { $0 }.joined(separator: " · "))
                .font(.caption2).monospacedDigit().foregroundStyle(.secondary).lineLimit(1)
                .fixedSize()
                .accessibilityLabel([author.map(lang.server), stamp.map { Stamp.compact($0) }].compactMap { $0 }.joined(separator: " · "))
        }
    }
}

struct ProvNodePage: View {
    let projectID: String
    let nodeID: String
    var nodes: [String: ProvNode] = [:]
    @Environment(\.colorScheme) private var scheme
    @EnvironmentObject private var store: TownStore

    var body: some View {
        let lang = store.language
        LivePage(load: { client in
            let node = try await client.provNode(projectID: projectID, id: nodeID)
            var related = nodes
            if related.isEmpty, node.src?.isEmpty == false || node.used?.isEmpty == false || node.history?.isEmpty == false {
                related = (try? await client.prov(projectID: projectID))?.nodes ?? [:]
            }
            return (node, related)
        }, events: ["prov"], projectID: projectID) { value, _ in
            let (n, related) = value
            List {
                Section {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(n.title ?? n.path ?? n.tag ?? nodeID).font(.headline)
                        HStack(spacing: 7) {
                            Label(n.kind.map { lang.string("prov.kind.\($0)") } ?? "", systemImage: kindSymbol(n.kind))
                            ProvIssues(node: n)
                        }
                        .font(.caption).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 2)
                    if let path = n.path {
                        let location = [n.root, path].compactMap { $0 }.joined(separator: "/")
                        if let root = n.root, ["code", "paper"].contains(root) {
                            NavigationLink { FileTextPage(projectID: projectID, root: root, path: path, line: n.span?.start) } label: {
                                Text(location).font(.footnote.monospaced())
                            }
                        } else { Text(location).font(.footnote.monospaced()).textSelection(.enabled) }
                    }
                    if let span = n.span, let start = span.start {
                        let end = span.end ?? start
                        InfoRow(label: lang.string("prov.span"), value: end == start ? String(start) : "\(start)–\(end)", mono: true)
                    }
                    if let note = n.note?.nonEmpty { EmText(note).font(.footnote).textSelection(.enabled) }
                }
                .papertownRowBackground(store.appearance)
                ProvContent(node: n)
                references("prov.sources", (n.src ?? []).map { ($0, nil, nil) }, related, lang)
                references("prov.used", (n.used ?? []).map { ($0.id ?? $0.tag, $0.tag, $0.title) }, related, lang)
                checks(n, lang)
                Section {
                    DisclosureGroup(lang.string("prov.operation")) {
                        if let op = n.op?.nonEmpty {
                            NavigationLink(String(op.prefix(7))) { ProvOpPage(projectID: projectID, opID: op) }
                        }
                        AttributionRows(agent: n.made?.agent, who: n.made?.who, role: n.made?.role, model: n.made?.model,
                                        session: n.made?.session, at: n.made?.at ?? n.createdAt)
                        if let blob = n.blob?.nonEmpty { InfoRow(label: lang.string("prov.blob"), value: blob, mono: true) }
                    }
                    .font(.subheadline).tint(.secondary)
                }
                .papertownRowBackground(store.appearance)
                if let made = n.made, made.how?.nonEmpty != nil || made.job != nil {
                    Section(lang.string("prov.method")) {
                        if let how = made.how?.nonEmpty { ProvText(how) }
                        if let job = made.job {
                            if let id = job.id { NavigationLink(job.name ?? id) { JobPage(jobID: id, readOnly: true) } }
                            if let command = job.command?.nonEmpty, command != made.how { ProvText(command) }
                            if let cwd = job.cwd?.nonEmpty { InfoRow(label: lang.string("prov.cwd"), value: cwd, mono: true) }
                            if let node = job.node { InfoRow(label: lang.string("prov.machine"), value: node) }
                            if let st = job.status { InfoRow(label: lang.string("prov.job_status"), value: lang.string("job.status.\(st)"), status: EmTone.issue(st)) }
                            if let at = job.startedAt { InfoRow(label: lang.string("prov.started"), value: Stamp.short(at, lang)) }
                            if let at = job.endedAt { InfoRow(label: lang.string("prov.ended"), value: Stamp.short(at, lang)) }
                            if let op = job.op?.nonEmpty {
                                NavigationLink { ProvOpPage(projectID: projectID, opID: op) } label: { InfoRow(label: lang.string("prov.code_version"), value: op, mono: true) }
                            }
                        }
                    }
                    .papertownRowBackground(store.appearance)
                }
                if n.made?.basis?.isEmpty == false { BasisSection(projectID: projectID, basis: n.made?.basis) }
                references("prov.history", (n.history ?? []).map { ($0.id ?? $0.tag, $0.tag, $0.title) }, related, lang)
            }
            .recordList(store.appearance)
            .navigationTitle(n.tag ?? nodeID)
        }
        .papertownInlineTitle()
        .papertownHidesTabBar()
    }

    @ViewBuilder
    private func checks(_ n: ProvNode, _ lang: AppLanguage) -> some View {
        let numbers = n.numbers ?? [], gaps = n.gaps ?? []
        if !numbers.isEmpty || !gaps.isEmpty {
            Section {
                DisclosureGroup(lang.string("prov.verification")) {
                    ForEach(Array(numbers.enumerated()), id: \.offset) { _, number in
                        let value = [number.text, number.ok.map { lang.string($0 ? "prov.number.ok" : "prov.number.unmatched") },
                                     number.locations?.joined(separator: " · ").nonEmpty].compactMap { $0 }.joined(separator: " · ")
                        if number.ok == false {
                            Text(value).font(.footnote).emState(.warn, icon: "exclamationmark.circle", detail: true)
                        } else { Text(value).font(.footnote).foregroundStyle(.secondary) }
                    }
                    ForEach(gaps, id: \.self) { Text(lang.server($0)).font(.footnote).emState(.warn, detail: true) }
                }
                .font(.subheadline).tint(.secondary)
            }
            .papertownRowBackground(store.appearance)
        }
    }

    @ViewBuilder
    private func references(_ key: String, _ refs: [(id: String?, tag: String?, title: String?)], _ related: [String: ProvNode], _ lang: AppLanguage) -> some View {
        if !refs.isEmpty {
            Section(lang.string(key)) {
                ForEach(Array(refs.enumerated()), id: \.offset) { _, ref in
                    if let id = ref.id {
                        let node = related[id] ?? related.values.first { $0.tag == id }
                        NavigationLink {
                            ProvNodePage(projectID: projectID, nodeID: node?.id ?? id, nodes: related)
                        } label: {
                            ProvReferenceLabel(projectID: projectID, id: id, node: node, tag: ref.tag, title: ref.title)
                                .id(id)
                        }
                        .disabled(id == nodeID)
                    }
                }
            }
            .papertownRowBackground(store.appearance)
        }
    }
}

/// Historical records can be absent from the current tree.
private struct ProvReferenceLabel: View {
    let projectID: String
    let id: String
    let node: ProvNode?
    let tag: String?, title: String?
    @EnvironmentObject private var store: TownStore
    @State private var detail: ProvNode?

    var body: some View {
        Group {
            if let n = node ?? detail { ProvNodeLabel(node: n) }
            else {
                HStack(spacing: 5) {
                    Image(systemName: "doc").foregroundStyle(.secondary)
                    Text(tag ?? id).font(.caption2.monospaced()).foregroundStyle(.secondary)
                    if let title { Text(title).font(.footnote).lineLimit(1) }
                }
            }
        }
        .task(id: id) {
            if node == nil { detail = try? await store.fetch { try await $0.provNode(projectID: projectID, id: id) } }
        }
    }
}

private struct ProvContent: View {
    let node: ProvNode
    @EnvironmentObject private var store: TownStore
    @State private var selection = "diff"

    var body: some View {
        let lang = store.language
        let comparison = node.state == "changed" || node.state == "missing"
        let registered = node.then ?? node.span?.text
        let value = comparison ? (selection == "diff" ? node.diff?.nonEmpty : selection == "then" ? registered : node.now)
                               : node.now ?? registered
        Section(lang.string("prov.content")) {
            if comparison {
                Picker(lang.string("prov.content"), selection: $selection) {
                    ForEach(["diff", "then", "now"], id: \.self) { Text(lang.string("prov.\($0)")).tag($0) }
                }
                .pickerStyle(.segmented)
            }
            if let value, !value.isEmpty { ProvText(value, preformatted: true, diff: comparison && selection == "diff") }
            else {
                Text(lang.string(comparison && selection == "diff" ? "prov.diff.empty" : value == nil ? "prov.content.unavailable" : "prov.content.empty"))
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .papertownRowBackground(store.appearance)
    }
}

private struct ProvText: View {
    let value: String
    let preformatted: Bool
    let diff: Bool
    init(_ value: String, preformatted: Bool = false, diff: Bool = false) {
        self.diff = diff
        self.value = value
        self.preformatted = preformatted
    }

    var body: some View {
        let text = Group {
            if diff { EmText(value, .diff) } else { Text(verbatim: value) }
        }
            .font(.footnote.monospaced()).textSelection(.enabled)
            .fixedSize(horizontal: preformatted, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
        let long = value.utf8.lazy.filter { $0 == 10 }.prefix(17).count > 16 || (!preformatted && value.count > 1600)
        if preformatted && long {
            ScrollView([.horizontal, .vertical]) { text }.frame(height: 220)
        } else if preformatted {
            ScrollView(.horizontal) { text }
        } else if long {
            ScrollView { text }.frame(height: 220)
        } else { text }
    }
}

private struct ProvOpsList: View {
    let projectID: String
    @EnvironmentObject private var store: TownStore
    @State private var older: [ProvOp] = []
    @State private var atEnd = false
    private static let limit = 50

    var body: some View {
        let lang = store.language
        LivePage(load: { try await $0.provOps(projectID: projectID, limit: Self.limit) }, events: ["prov"], projectID: projectID) { first, act in
            let ids = Set(first.compactMap(\.id))
            let ops = first + older.filter { !ids.contains($0.id ?? "") }
            List {
                if ops.isEmpty {
                    Text(lang.string("prov.ops.empty")).font(.subheadline).foregroundStyle(.secondary)
                        .listRowBackground(Color.clear)
                }
                ForEach(ops) { op in ProvOpLink(projectID: projectID, op: op).papertownRowBackground(store.appearance) }
                if !atEnd, first.count == Self.limit, let before = ops.last?.id ?? ops.last?.ts {
                    Button(lang.string("prov.load_more")) {
                        act.run { client in
                            let page = try await client.provOps(projectID: projectID, before: before, limit: Self.limit)
                            let seen = Set(ops.compactMap(\.id))
                            let next = page.filter { !seen.contains($0.id ?? "") }
                            older += next
                            atEnd = next.isEmpty || page.count < Self.limit
                        }
                    }
                    .disabled(act.busy)
                }
            }
            .onChange(of: first.first?.id) { _ in older = []; atEnd = false }
            .recordList(store.appearance)
        }
    }
}

private struct ProvOpLink: View {
    let projectID: String
    let op: ProvOp
    @EnvironmentObject private var store: TownStore

    var body: some View {
        let lang = store.language
        if let id = op.id {
            NavigationLink { ProvOpPage(projectID: projectID, opID: id) } label: {
                VStack(alignment: .leading, spacing: 4) {
                    Text(op.summary.map(lang.server) ?? op.short ?? id).font(.subheadline.weight(.medium)).lineLimit(2)
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text([(op.who ?? op.agent).map(lang.server), op.ts.map { Stamp.compact($0) },
                              op.fileCount.flatMap { $0 > 0 ? lang.format("prov.files.count", $0) : nil }].compactMap { $0 }.joined(separator: " · "))
                            .monospacedDigit()
                        Spacer(minLength: 2)
                        LineChanges(added: op.added, removed: op.removed)
                    }
                    .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
}

private struct LineChanges: View {
    let added: Int?
    let removed: Int?
    var body: some View {
        HStack(spacing: 6) {
            if let added, added > 0 { Text("+\(added)").emNum(.good) }
            if let removed, removed > 0 { Text("−\(removed)").emNum(.bad) }
        }
        .font(.caption.monospaced()).foregroundStyle(.secondary)
    }
}

struct ProvOpPage: View {
    let projectID: String
    let opID: String
    @EnvironmentObject private var store: TownStore
    var body: some View {
        let lang = store.language
        LoadingList(load: { try await $0.provOp(projectID: projectID, id: opID) }) { op in
            List {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        if let summary = op.summary { Text(lang.server(summary)).font(.headline) }
                        HStack {
                            Text([(op.who ?? op.agent).map(lang.server), op.ts.map { Stamp.compact($0) },
                                  op.fileCount.map { lang.format("prov.files.count", $0) }].compactMap { $0 }.joined(separator: " · "))
                            Spacer(minLength: 4)
                            LineChanges(added: op.added, removed: op.removed)
                        }
                        .font(.caption).monospacedDigit().foregroundStyle(.secondary)
                    }
                }
                .papertownRowBackground(store.appearance)
                Section(lang.string("prov.files")) {
                    ForEach(Array((op.files ?? []).enumerated()), id: \.offset) { _, file in
                        DisclosureGroup {
                            if let diff = file.diff?.nonEmpty { ProvText(diff, preformatted: true, diff: true) }
                            else { Text(lang.string("prov.diff.empty")).font(.footnote).foregroundStyle(.secondary) }
                        } label: {
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text(file.path ?? "").font(.footnote.monospaced())
                                Spacer(minLength: 4)
                                LineChanges(added: file.added, removed: file.removed)
                            }
                        }
                        .tint(.secondary)
                    }
                }
                .papertownRowBackground(store.appearance)
                if op.basis?.isEmpty == false { BasisSection(projectID: projectID, basis: op.basis) }
                Section {
                    DisclosureGroup(lang.string("prov.operation")) {
                        InfoRow(label: lang.string("prov.operation"), value: op.id ?? opID, mono: true)
                        if let root = op.root { InfoRow(label: lang.string("prov.root"), value: root) }
                        if let trigger = op.trigger { InfoRow(label: lang.string("prov.trigger"), value: lang.string("prov.trigger.\(trigger)")) }
                        AttributionRows(agent: op.agent, who: op.who, role: op.role, model: nil, session: op.session, at: op.ts)
                    }
                    .font(.subheadline).tint(.secondary)
                }
                .papertownRowBackground(store.appearance)
            }
            .recordList(store.appearance)
            .navigationTitle(op.short ?? String(opID.prefix(7)))
        }
        .papertownInlineTitle()
        .papertownHidesTabBar()
    }
}

private struct AttributionRows: View {
    let agent: String?, who: String?, role: String?, model: String?, session: String?, at: String?
    @EnvironmentObject private var store: TownStore
    var body: some View {
        let lang = store.language
        if let name = who?.nonEmpty ?? agent { InfoRow(label: lang.string("prov.who"), value: lang.server(name)) }
        if let role = role?.nonEmpty { InfoRow(label: lang.string("canvas.detail.role"), value: TextFormatters.roleName(role, language: lang)) }
        if let model = model?.nonEmpty { InfoRow(label: lang.string("prov.model"), value: model) }
        if let at { InfoRow(label: lang.string("prov.time"), value: Stamp.short(at, lang)) }
        if let session = session?.nonEmpty { InfoRow(label: lang.string("prov.session"), value: session, mono: true) }
        if let agent = agent?.nonEmpty, let at {
            NavigationLink { ProvConversation(agent: agent, session: session, at: at) } label: {
                Label(lang.string("action.view_chat"), systemImage: "bubble.left.and.bubble.right")
            }
        }
    }
}

/// A read-only excerpt around the operation. Opening it never resumes or switches the agent's session.
private struct ProvConversation: View {
    let agent: String
    let session: String?
    let at: String
    @EnvironmentObject private var store: TownStore

    var body: some View {
        let lang = store.language
        LoadingList(load: { client -> [ChatEntry] in
            let read = try await client.agentEvents(agentID: agent)
            let events = read.events.filter { e in
                guard let session else { return true }
                return (e.data.field("session_id")?.stringValue ?? e.data.field("session")?.stringValue) == session
            }
            var entries = ConversationState.entries(from: events)
            if entries.isEmpty, let session, read.agent.usesTimeline, read.agent.sessionID == session || read.agent.extID == session {
                let tl = try await client.timeline(agentID: agent)
                entries = ConversationState.entries(from: tl.items)
            }
            guard let time = Stamp.date(at), let nearest = entries.indices.min(by: {
                abs(Stamp.date(entries[$0].ts)?.timeIntervalSince(time) ?? .infinity) <
                    abs(Stamp.date(entries[$1].ts)?.timeIntervalSince(time) ?? .infinity)
            }) else { return entries }
            return Array(entries[max(0, nearest - 3)...min(entries.count - 1, nearest + 3)])
        }) { entries in
            List {
                if entries.isEmpty { Text(lang.string("prov.session.empty")).foregroundStyle(.secondary) }
                ForEach(entries) { e in
                    VStack(alignment: .leading, spacing: 4) {
                        Text([e.kind == .user ? lang.string("decided.author.you") : agent, Stamp.short(e.ts, lang)].joined(separator: " · "))
                            .font(.caption).foregroundStyle(.secondary)
                        if e.kind == .user { AuthoredMessage(entry: e) }
                        else { EmText(e.text).textSelection(.enabled) }
                    }
                }
            }
            .papertownInsetGroupedList()
            .papertownListAppearance(store.appearance)
        }
        .navigationTitle(lang.string("prov.session"))
        .papertownInlineTitle()
    }
}
