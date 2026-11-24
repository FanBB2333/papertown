import PapertownCore
import SwiftUI

// The town's own panels, as in the web console: skills set per scope through skim, the work bounds (what must be done,
// what never, what to ask first) on three levels, the MCP servers the staff use, the library's search settings, and the
// recent model and tool calls.

// MARK: - Skills (skim)

struct SkimPage: View {
    @EnvironmentObject private var store: TownStore
    @State private var line = ""
    @State private var agent = ""

    private var scope: String { line.isEmpty ? "global" : agent.isEmpty ? "project" : "session" }

    var body: some View {
        let lang = store.language
        LivePage(load: { try await $0.skim() }, events: ["skills"]) { st, _ in
            List {
                if !st.ok {
                    Section {
                        Text(lang.string("skim.down")).font(.subheadline.weight(.medium))
                        if let n = st.note { Text(lang.server(n)).font(.caption).foregroundStyle(.secondary) }
                        Text("skim init").font(.caption.monospaced())
                    }
                } else {
                    Section {
                        Picker(lang.string("skim.project"), selection: $line) {
                            Text(lang.string("skim.global")).tag("")
                            ForEach(st.lines ?? []) { l in Text("#\(l.seq) \(lang.server(l.title))").tag(l.id) }
                        }
                        if let l = st.lines?.first(where: { $0.id == line }), let agents = l.agents, !agents.isEmpty {
                            Picker(lang.string("skim.conversation"), selection: $agent) {
                                Text(lang.string("skim.whole_project")).tag("")
                                ForEach(agents, id: \.id) { a in
                                    Text(TextFormatters.roleName(a.role, language: lang) + (a.model.map { " · \($0)" } ?? "")).tag(a.id)
                                }
                            }
                        }
                    } footer: {
                        Text(lang.string("skim.scope.\(scope)"))
                    }
                    SkimScope(envs: st.envs ?? [], active: st.activeEnv, scope: scope, line: line.isEmpty ? nil : line, agent: agent.isEmpty ? nil : agent)
                        .id("\(line)/\(agent)")
                }
            }
            .papertownInsetGroupedList()
            .papertownListAppearance(store.appearance)
        }
        .onChange(of: line) { _ in agent = "" }
        .navigationTitle("Skills")
        .papertownInlineTitle()
    }
}

private struct SkimScope: View {
    let envs: [SkimStatus.Env]
    let active: String?
    let scope: String
    let line: String?
    let agent: String?
    @EnvironmentObject private var store: TownStore
    @State private var r: SkimResolution?
    @State private var error: String?
    @State private var busy = false
    @State private var query = ""

    var body: some View {
        let lang = store.language
        if let r {
            Section {
                Picker(lang.string("skim.env"), selection: Binding(get: { r.envScope == scope ? (r.env ?? "") : "__inherit" }, set: { v in
                    set("core.env", v == "__inherit" ? nil : v)
                })) {
                    Text(lang.string(scope == "global" ? "skim.env.active" : "skim.env.inherit")).tag("__inherit")
                    Text(lang.string("skim.env.empty")).tag("")
                    ForEach(envs, id: \.name) { e in Text(e.name + (e.active == true ? " · " + lang.string("skim.env.on") : "")).tag(e.name) }
                }
                .disabled(busy)
                InfoRow(label: lang.string("skim.env.now"), value: (r.env?.isEmpty == false ? r.env! : lang.string("skim.env.empty"))
                        + (r.envMissing == true ? " · " + lang.string("skim.env.missing") : ""))
            } header: {
                Text(lang.string("skim.env.title"))
            }
            Section {
                TextField(lang.string("skim.search"), text: $query)
                let q = query.lowercased()
                ForEach(r.skills.filter { q.isEmpty || $0.name.lowercased().contains(q) || ($0.description ?? "").lowercased().contains(q) }) { s in
                    HStack(alignment: .top) {
                        Circle().fill(s.enabled == true ? Color.green : Color.secondary.opacity(0.3)).frame(width: 8, height: 8).padding(.top, 6)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(s.name).font(.subheadline.weight(.medium))
                            if let d = s.description { Text(lang.server(d)).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                            Text(source(s, lang)).font(.caption2).foregroundStyle(s.inStore == false ? .orange : .secondary)
                        }
                        Spacer()
                        Picker("", selection: Binding(get: { s.scope == scope ? (s.enabled == true ? "true" : "false") : "" }, set: { v in
                            set("skill.\(s.name).enabled", v.isEmpty ? nil : v)
                        })) {
                            Text(lang.string("skim.inherit")).tag("")
                            Text(lang.string("skim.on")).tag("true")
                            Text(lang.string("skim.off")).tag("false")
                        }
                        .labelsHidden()
                        .fixedSize()
                        .disabled(busy)
                    }
                }
            } header: {
                Text(lang.format("skim.skills", r.skills.filter { $0.enabled == true }.count, r.skills.count))
            }
            if let error { Section { Text(error).foregroundStyle(.red).font(.footnote) } }
        } else {
            Section { if let error { Text(error).foregroundStyle(.red).font(.footnote) } else { ProgressView().frame(maxWidth: .infinity) } }
                .task { await load() }
        }
    }

    private func source(_ s: SkimResolution.Skill, _ lang: AppLanguage) -> String {
        if s.inStore == false { return lang.string("skim.not_in_store") }
        switch s.scope {
        case "env": return lang.format("skim.from_env", s.origin ?? "")
        case "global", "project", "session": return lang.string("skim.from.\(s.scope!)")
        default: return lang.string("skim.unset")
        }
    }

    private func load() async {
        do { r = try await store.fetch { [line, agent] in try await $0.skimResolve(projectID: line, agentID: agent) } } catch { self.error = store.message(for: error) }
    }

    private func set(_ key: String, _ value: String?) {
        busy = true
        Task {
            do {
                r = try await store.fetch { [scope, line, agent] in try await $0.setSkim(scope: scope, key: key, value: value, projectID: line, agentID: agent) }
                error = nil
            } catch {
                self.error = store.message(for: error)
            }
            busy = false
        }
    }
}

// MARK: - Work bounds

struct BoundsPage: View {
    @EnvironmentObject private var store: TownStore
    @State private var line = ""
    @State private var level = "global"

    var body: some View {
        let lang = store.language
        List {
            Section {
                Picker(lang.string("bounds.project"), selection: $line) {
                    Text(lang.string("bounds.no_project")).tag("")
                    ForEach(store.projects) { p in Text("#\(p.seq) \(lang.server(p.title))").tag(p.id) }
                }
                Picker(lang.string("bounds.level"), selection: $level) {
                    Text(lang.string("bounds.level.global")).tag("global")
                    if !line.isEmpty {
                        Text(lang.string("bounds.level.project")).tag("project")
                        Text(TextFormatters.roleName("coder", language: lang)).tag("coder")
                        Text(TextFormatters.roleName("writer", language: lang)).tag("writer")
                    }
                }
                .pickerStyle(.segmented)
            } footer: {
                Text(lang.string("bounds.level.\(level).sub"))
            }
            .papertownRowBackground(store.appearance)
            BoundsLevel(line: line.isEmpty ? nil : line, level: level).id("\(line)/\(level)")
        }
        .papertownInsetGroupedList()
        .papertownListAppearance(store.appearance)
        .onChange(of: line) { l in if l.isEmpty { level = "global" } }
        .navigationTitle(lang.string("bounds.nav"))
        .papertownInlineTitle()
    }
}

private struct BoundsLevel: View {
    let line: String?
    let level: String
    @EnvironmentObject private var store: TownStore
    @State private var view: BoundsView?
    @State private var rules: [Bound] = []
    @State private var off: [String] = []
    @State private var saved: ([Bound], [String]) = ([], [])
    @State private var busy = false
    @State private var error: String?

    private var worker: Bool { level == "coder" || level == "writer" }

    var body: some View {
        let lang = store.language
        if let view {
            let inherited = inheritedRules(view)
            if !inherited.isEmpty {
                Section(lang.string("bounds.inherited")) {
                    ForEach(inherited) { b in
                        Toggle(isOn: Binding(get: { !off.contains(b.id) }, set: { on in
                            if on { off.removeAll { $0 == b.id } } else if !off.contains(b.id) { off.append(b.id) }
                        })) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(lang.server(b.text)).font(.subheadline)
                                Text([lang.server(view.kinds[b.kind] ?? b.kind), b.action.map { lang.server(view.actions[$0] ?? $0) },
                                      lang.string("bounds.from.\(b.from ?? "global")"), b.inherit == "force" ? lang.string("bounds.locked") : nil]
                                    .compactMap { $0 }.joined(separator: " · "))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .disabled(b.inherit == "force")
                    }
                }
            }
            Section {
                if rules.isEmpty { Text(lang.string("bounds.none")).font(.footnote).foregroundStyle(.secondary) }
                ForEach($rules) { $b in
                    VStack(alignment: .leading, spacing: 6) {
                        TextField(lang.string("bounds.text.\(b.kind)"), text: $b.text, axis: .vertical)
                            .onChange(of: b.text) { if $0.count > 300 { b.text = String($0.prefix(300)) } }
                        HStack {
                            Picker("", selection: $b.kind) {
                                ForEach(["must", "never", "ask"], id: \.self) { Text(lang.server(view.kinds[$0] ?? $0)).tag($0) }
                            }
                            .labelsHidden().fixedSize()
                            if !worker {
                                Picker("", selection: $b.inherit) {
                                    ForEach(["yes", "no", "force"], id: \.self) { Text(lang.server(view.inherit[$0] ?? $0)).tag($0) }
                                }
                                .labelsHidden().fixedSize()
                            }
                            if b.kind != "must" {
                                Picker("", selection: Binding(get: { b.action ?? "" }, set: { b.action = $0.isEmpty ? nil : $0 })) {
                                    Text(lang.string("bounds.no_action")).tag("")
                                    ForEach(view.actions.keys.sorted(), id: \.self) { k in Text(lang.server(view.actions[k] ?? k)).tag(k) }
                                }
                                .labelsHidden().fixedSize()
                            }
                            Spacer()
                            Button(role: .destructive) { rules.removeAll { $0.id == b.id } } label: { Image(systemName: "trash") }
                                .buttonStyle(.borderless)
                        }
                        .font(.caption)
                        .controlSize(.small)
                    }
                    .padding(.vertical, 2)
                }
                HStack {
                    ForEach(["must", "never", "ask"], id: \.self) { k in
                        Button { rules.append(Bound(kind: k, inherit: worker ? "no" : "yes")) } label: {
                            Label(lang.server(view.kinds[k] ?? k), systemImage: "plus")
                        }
                        .buttonStyle(.bordered).controlSize(.small)
                    }
                }
                .disabled(rules.count >= 60)
            } header: {
                Text(lang.string("bounds.own"))
            }
            Section {
                Button(lang.string("action.save")) { save() }.disabled(busy || !dirty)
                if dirty { Button(lang.string("bounds.revert")) { (rules, off) = saved } }
                if let error { Text(error).foregroundStyle(.red).font(.footnote) }
            } footer: {
                Text(lang.string("bounds.save.footer"))
            }
            let effective = view.effective?[role] ?? []
            if !effective.isEmpty {
                Section(lang.format("bounds.effective", role == "assistant" ? lang.string("role.assistant") : TextFormatters.roleName(role, language: lang))) {
                    ForEach(effective) { b in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(lang.server(b.text)).font(.footnote)
                            Text([lang.server(view.kinds[b.kind] ?? b.kind), lang.string("bounds.from.\(b.from ?? "global")")].joined(separator: " · "))
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        } else {
            Section { if let error { Text(error).foregroundStyle(.red).font(.footnote) } else { ProgressView().frame(maxWidth: .infinity) } }
                .task { await load() }
        }
    }

    private var role: String { level == "global" ? "assistant" : level == "project" ? "lead" : level }
    private var dirty: Bool { rules != saved.0 || Set(off) != Set(saved.1) }

    /// The rules this level takes from the ones above it, with the ones it may switch off.
    private func inheritedRules(_ v: BoundsView) -> [Bound] {
        switch level {
        case "project":
            return v.levels.global.rules.filter { $0.inherit != "no" }.map { var b = $0; b.from = "global"; return b }
        case "coder", "writer":
            let global = v.levels.global.rules.filter { $0.inherit != "no" && !(v.levels.project?.off ?? []).contains($0.id) }
                .map { var b = $0; b.from = "global"; return b }
            let project = (v.levels.project?.rules ?? []).filter { $0.inherit != "no" }.map { var b = $0; b.from = "project"; return b }
            return global + project
        default:
            return []
        }
    }

    private func current(_ v: BoundsView) -> BoundsView.Level {
        switch level {
        case "project": return v.levels.project ?? BoundsView.Level()
        case "coder", "writer": return v.levels.workers?[level] ?? BoundsView.Level()
        default: return v.levels.global
        }
    }

    private func load() async {
        do {
            let v = try await store.fetch { [line] in try await $0.bounds(projectID: line) }
            view = v
            let own = current(v)
            rules = own.rules
            off = own.off ?? []
            saved = (rules, off)
            error = nil
        } catch {
            self.error = store.message(for: error)
        }
    }

    private func save() {
        busy = true
        let kept = rules.filter { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        Task {
            do {
                try await store.fetch { [line, level, off] in
                    try await $0.setBounds(projectID: level == "global" ? nil : line, role: level == "coder" || level == "writer" ? level : nil, rules: kept, off: off)
                }
                await load()
            } catch {
                self.error = store.message(for: error)
            }
            busy = false
        }
    }
}

// MARK: - Calls

struct TracePage: View {
    @EnvironmentObject private var store: TownStore

    var body: some View {
        let lang = store.language
        LivePage(load: { try await $0.trace() }, events: ["trace"]) { rows, _ in
            List {
                if rows.isEmpty { Text(lang.string("trace.none")).foregroundStyle(.secondary) }
                ForEach(rows.reversed()) { r in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            if let k = r.kind { Pill(text: k, color: .secondary) }
                            Text(r.label ?? "").font(.caption.monospaced()).lineLimit(1)
                            Spacer()
                            if let ms = r.ms { Text("\(Int(ms)) ms").font(.caption2.monospacedDigit()).foregroundStyle(.secondary) }
                        }
                        if let d = r.detail, !d.isEmpty { Text(lang.server(d)).font(.caption).italic().foregroundStyle(.secondary).lineLimit(4) }
                        Text(Stamp.short(r.ts, lang)).font(.caption2).foregroundStyle(.tertiary)
                    }
                    .papertownRowBackground(store.appearance)
                }
            }
            .papertownInsetGroupedList()
            .papertownListAppearance(store.appearance)
        }
        .navigationTitle(lang.string("trace.nav"))
        .papertownInlineTitle()
    }
}

// MARK: - MCP servers and skills

struct ToolsPage: View {
    @EnvironmentObject private var store: TownStore
    @State private var adding = false

    private struct Loaded { let mcp: McpView?; let skills: [TownSkill] }

    var body: some View {
        let lang = store.language
        LivePage(load: { client -> Loaded in
            async let m = try? client.mcp()
            async let s = (try? client.skills()) ?? []
            return Loaded(mcp: await m, skills: await s)
        }, events: ["skills", "mcp"]) { v, act in
            List {
                Section {
                    if (v.mcp?.servers ?? []).isEmpty { Text(lang.string("tools.mcp.empty")).font(.footnote).foregroundStyle(.secondary) }
                    ForEach(v.mcp?.servers ?? []) { srv in
                        NavigationLink { McpServerPage(name: srv.name) } label: {
                            HStack {
                                Image(systemName: Tone.symbol(mcpTone(srv))).foregroundStyle(Tone.color(mcpTone(srv)))
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(srv.name).font(.subheadline.weight(.medium))
                                    Text([lang.string("mcp.state.\(srv.state)"), lang.string("mcp.source.\(srv.source ?? "town")")].joined(separator: " · "))
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text(lang.format("tools.count", srv.tools?.count ?? 0)).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    Button { adding = true } label: { Label(lang.string("mcp.add"), systemImage: "plus") }
                } header: {
                    Text(lang.string("tools.mcp"))
                }
                Section(lang.string("tools.skills")) {
                    ForEach(v.skills) { sk in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(sk.name).font(.subheadline.weight(.medium))
                            if let d = sk.description { Text(lang.server(d)).font(.caption).foregroundStyle(.secondary).lineLimit(3) }
                            if let roles = sk.roles, !roles.isEmpty {
                                Text(roles.map { TextFormatters.roleName($0, language: lang) }.joined(separator: " · "))
                                    .font(.caption2).foregroundStyle(store.appearance.tintColor)
                            }
                        }
                    }
                }
            }
            .papertownInsetGroupedList()
            .papertownListAppearance(store.appearance)
            .sheet(isPresented: $adding) {
                McpEditSheet(server: nil) { name, command, args, env in
                    act.run(lang.string("mcp.saved")) { try await $0.saveMcpServer(name: name, command: command, args: args, env: env) }
                }
                .papertownSheetFrame(height: 520)
                .environmentObject(store)
                .tint(store.appearance.tintColor)
            }
        }
        .navigationTitle(lang.string("town.tools"))
        .papertownInlineTitle()
    }
}

private func mcpTone(_ s: McpServer) -> String {
    switch s.state {
    case "ok": return "pass"
    case "connecting": return "wait"
    default: return s.state
    }
}

struct McpServerPage: View {
    let name: String
    @EnvironmentObject private var store: TownStore
    @Environment(\.dismiss) private var dismiss
    @State private var editing = false
    @State private var confirmRemove = false

    var body: some View {
        let lang = store.language
        LivePage(load: { try await $0.mcp() }, events: ["mcp"]) { v, act in
            if let s = v.servers.first(where: { $0.name == name }) {
                List {
                    Section {
                        HStack {
                            Pill(text: lang.string("mcp.state.\(s.state)"), color: Tone.color(mcpTone(s)), symbol: Tone.symbol(mcpTone(s)))
                            Pill(text: lang.string("mcp.source.\(s.source ?? "town")"), color: .secondary)
                        }
                        if let c = s.command {
                            Text(([c] + (s.args ?? [])).joined(separator: " ")).font(.caption.monospaced()).textSelection(.enabled)
                        }
                        if let env = s.env, !env.isEmpty { InfoRow(label: lang.string("mcp.env"), value: env.joined(separator: ", ")) }
                        if let e = s.error { Text(lang.server(e)).font(.caption).foregroundStyle(.red) }
                    }
                    Section {
                        if s.enabled {
                            Button(lang.string("mcp.restart")) { act.run { try await $0.restartMcpServer(name) } }
                        }
                        Button(lang.string(s.enabled ? "mcp.disable" : "mcp.enable")) { act.run { try await $0.toggleMcpServer(name, enabled: !s.enabled) } }
                        if s.source == "town" {
                            Button(lang.string("mcp.edit")) { editing = true }
                            Button(lang.string("action.delete"), role: .destructive) { confirmRemove = true }
                        }
                    }
                    .disabled(act.busy)
                    Section(lang.format("tools.count", s.tools?.count ?? 0)) {
                        if (s.tools ?? []).isEmpty { Text(lang.string(s.enabled ? "mcp.tools.none" : "mcp.tools.off")).font(.footnote).foregroundStyle(.secondary) }
                        ForEach(s.tools ?? [], id: \.self) { t in
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(name).\(t.name)").font(.caption.monospaced())
                                if let d = t.description { Text(lang.server(d)).font(.caption2).foregroundStyle(.secondary).lineLimit(4) }
                            }
                        }
                    }
                }
                .papertownInsetGroupedList()
                .papertownListAppearance(store.appearance)
                .sheet(isPresented: $editing) {
                    McpEditSheet(server: s) { n, command, args, env in
                        act.run(lang.string("mcp.saved")) { try await $0.saveMcpServer(name: n, command: command, args: args, env: env) }
                    }
                    .papertownSheetFrame(height: 520)
                    .environmentObject(store)
                    .tint(store.appearance.tintColor)
                }
                .confirmationDialog(lang.format("mcp.remove.confirm", name), isPresented: $confirmRemove, titleVisibility: .visible) {
                    Button(lang.string("action.delete"), role: .destructive) {
                        act.run { try await $0.removeMcpServer(name) }
                        dismiss()
                    }
                }
            } else {
                EmptyStateView(title: lang.string("error.not_found"), systemImage: "puzzlepiece.extension", description: "")
            }
        }
        .navigationTitle(name)
        .papertownInlineTitle()
    }
}

struct McpEditSheet: View {
    let server: McpServer?
    let save: (String, String, [String], [String: String]) -> Void
    @EnvironmentObject private var store: TownStore
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var command = ""
    @State private var args = ""
    @State private var env = ""

    var body: some View {
        let lang = store.language
        let valid = name.range(of: "^[A-Za-z][A-Za-z0-9_-]{0,31}$", options: .regularExpression) != nil && !command.trimmingCharacters(in: .whitespaces).isEmpty
        NavigationStack {
            Form {
                Section {
                    TextField(lang.string("mcp.name"), text: $name).disabled(server != nil).papertownURLInput()
                    TextField(lang.string("mcp.command"), text: $command).papertownURLInput()
                }
                Section {
                    TextField(lang.string("mcp.args"), text: $args, axis: .vertical).lineLimit(2...8).papertownURLInput()
                } header: {
                    Text(lang.string("mcp.args.title"))
                }
                Section {
                    TextField("KEY=VALUE", text: $env, axis: .vertical).lineLimit(2...8).papertownURLInput()
                } header: {
                    Text(lang.string("mcp.env"))
                } footer: {
                    Text(lang.string("mcp.env.footer"))
                }
            }
            .formStyle(.grouped)
            .navigationTitle(lang.string(server == nil ? "mcp.add" : "mcp.edit"))
            .papertownInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(lang.string("action.cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(lang.string("mcp.save")) {
                        let lines = { (s: String) in s.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
                        var vars: [String: String] = [:]
                        for l in lines(env) {
                            guard let eq = l.firstIndex(of: "="), eq != l.startIndex else { continue }
                            vars[String(l[..<eq])] = String(l[l.index(after: eq)...])
                        }
                        save(name, command.trimmingCharacters(in: .whitespaces), lines(args), vars)
                        dismiss()
                    }
                    .disabled(!valid)
                }
            }
        }
        .onAppear {
            guard let s = server else { return }
            name = s.name; command = s.command ?? ""; args = (s.args ?? []).joined(separator: "\n")
            env = (s.env ?? []).map { "\($0)=" }.joined(separator: "\n")
        }
    }
}

// MARK: - The library's search settings

struct RagOptionsSheet: View {
    @EnvironmentObject private var store: TownStore
    @Environment(\.dismiss) private var dismiss
    @State private var topK = 8.0
    @State private var candidates = 40.0
    @State private var filled = false

    var body: some View {
        let lang = store.language
        NavigationStack {
            LivePage(load: { try await $0.ragOptions() }) { o, act in
                Form {
                    Section {
                        VStack(alignment: .leading) {
                            Text(lang.format("rag.top_k", Int(topK)))
                            Slider(value: $topK, in: Double(o.limits.topK.first ?? 1)...Double(o.limits.topK.last ?? 30), step: 1)
                        }
                        VStack(alignment: .leading) {
                            Text(lang.format("rag.candidates", Int(candidates)))
                            Slider(value: $candidates, in: Double(o.limits.candidates.first ?? 5)...Double(o.limits.candidates.last ?? 200), step: 5)
                        }
                    } footer: {
                        Text(lang.string("rag.footer"))
                    }
                    Section {
                        Button(lang.string("action.save")) {
                            let (k, c) = (Int(topK), Int(candidates))
                            act.run(lang.string("rag.saved")) { _ = try await $0.setRagOptions(topK: k, candidates: c) }
                        }
                        .disabled(act.busy || (Int(topK) == o.opts.topK && Int(candidates) == o.opts.candidates))
                    }
                }
                .formStyle(.grouped)
                .onAppear {
                    guard !filled else { return }
                    filled = true
                    topK = Double(o.opts.topK); candidates = Double(o.opts.candidates)
                }
            }
            .navigationTitle(lang.string("rag.title"))
            .papertownInlineTitle()
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(lang.string("action.done")) { dismiss() } } }
        }
    }
}
