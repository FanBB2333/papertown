import PapertownCore
import SwiftUI

// The research loop (研究回路) as lists: its gates and what they block, the tasks sent to the staff, what waits on your
// say-so; with the same actions as the web's canvas, without drawing it. GET /api/lines/{id}/canvas and its routes.

private let loopEvents: Set<String> = ["canvas", "checks", "line", "agent"]

struct LoopPage: View {
    let projectID: String
    @EnvironmentObject private var store: TownStore
    @State private var adding = false
    @State private var copied: String?

    var body: some View {
        let lang = store.language
        LivePage(load: { try await $0.loop(projectID: projectID) }, events: loopEvents, projectID: projectID) { v, act in
            List {
                summary(v, act, lang)
                human(v, act, lang)
                gates(v, lang)
                tasks(v, lang)
                restore(v, act, lang)
            }
            .papertownInsetGroupedList()
            .papertownListAppearance(store.appearance)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button { adding = true } label: { Label(lang.string("loop.add"), systemImage: "plus") }
                        Button { act.run(lang.string("checks.ran")) { try await $0.runChecks(projectID: projectID) } } label: {
                            Label(lang.string("checks.run_all"), systemImage: "checkmark.seal")
                        }
                        Divider()
                        Button { copyReport(lang) } label: { Label(lang.string("loop.report.copy"), systemImage: "doc.on.doc") }
                        Button {
                            act.say { c in
                                let page = try await c.publishLoopReport(projectID: projectID)
                                return lang.format("loop.report.published", lang.server(page.title))
                            }
                        } label: { Label(lang.string("loop.report.publish"), systemImage: "doc.richtext") }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .disabled(act.busy)
                }
            }
            .sheet(isPresented: $adding) {
                NewLoopNodeSheet(projectID: projectID, agents: v.agents ?? [:]) { node in
                    act.run { try await $0.addNode(projectID: projectID, node) }
                }
                .papertownSheetFrame(height: 520)
                .environmentObject(store)
                .tint(store.appearance.tintColor)
            }
        }
        .navigationTitle(lang.string("loop.nav"))
        .papertownInlineTitle()
        .alert(copied ?? "", isPresented: Binding(get: { copied != nil }, set: { if !$0 { copied = nil } })) {
            Button(lang.string("action.ok"), role: .cancel) {}
        }
    }

    @ViewBuilder
    private func summary(_ v: LoopView, _ act: PageActions, _ lang: AppLanguage) -> some View {
        let tasks = v.nodes.filter { $0.kind == "task" }
        Section {
            InfoRow(label: lang.string("loop.round"), value: "\(v.rounds ?? 0)")
            InfoRow(label: lang.string("loop.tasks"), value: lang.format("loop.tasks.count", tasks.filter { $0.status == "done" }.count, tasks.count))
            Toggle(isOn: Binding(get: { v.rules?.exclusive ?? true }, set: { on in act.run { try await $0.loopRules(projectID: projectID, exclusive: on) } })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(lang.string("loop.exclusive"))
                    Text(lang.string("loop.exclusive.sub")).font(.caption).foregroundStyle(.secondary)
                }
            }
            .disabled(act.busy)
        } footer: {
            Text(lang.string("loop.footer"))
        }
        .papertownRowBackground(store.appearance)
    }

    /// What waits on your say-so: a gate that ran out of rounds, a blocked task, a result that may be stale.
    @ViewBuilder
    private func human(_ v: LoopView, _ act: PageActions, _ lang: AppLanguage) -> some View {
        let items = v.nodes.filter { $0.kind == "human" }.flatMap { $0.items ?? [] }
        if !items.isEmpty {
            Section {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(lang.server(item.text)).font(.subheadline)
                        HStack {
                            if item.kind == "escalated", let g = item.gate {
                                Button(lang.string("loop.gate.more")) { act.run(lang.string("loop.gate.more.done")) { try await $0.gate(projectID: projectID, stage: g, "more") } }
                                    .buttonStyle(.borderedProminent)
                                Button(lang.string("loop.gate.waive")) { act.run(lang.string("loop.gate.waive.done")) { try await $0.gate(projectID: projectID, stage: g, "waive") } }
                                    .buttonStyle(.bordered)
                            }
                            if item.kind == "stale", let id = item.id {
                                Button(lang.string("loop.stale.keep")) { act.run { try await $0.editNode(projectID: projectID, nodeID: id, LoopNodeEdit(stale: false)) } }
                                    .buttonStyle(.bordered)
                            }
                        }
                        .controlSize(.small)
                        .disabled(act.busy)
                    }
                    .padding(.vertical, 2)
                }
            } header: {
                Label(lang.format("loop.human", items.count), systemImage: "hand.raised.fill").foregroundStyle(.orange)
            }
            .papertownRowBackground(store.appearance)
        }
    }

    @ViewBuilder
    private func gates(_ v: LoopView, _ lang: AppLanguage) -> some View {
        let gates = v.nodes.filter { $0.kind == "gate" && $0.gate != nil }
        if !gates.isEmpty {
            Section(lang.string("loop.gates")) {
                ForEach(gates) { node in
                    let g = node.gate!
                    NavigationLink {
                        LoopGatePage(projectID: projectID, stage: g.stage)
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: Tone.symbol(gateTone(g.state))).foregroundStyle(Tone.color(gateTone(g.state)))
                            VStack(alignment: .leading, spacing: 2) {
                                Text(lang.server(g.name ?? node.title ?? g.stage)).font(.subheadline.weight(.medium))
                                Text(gateLine(g, lang)).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                            }
                            Spacer()
                            Text(lang.string("loop.gate.\(g.state)")).font(.caption).foregroundStyle(Tone.color(gateTone(g.state)))
                        }
                    }
                }
            }
            .papertownRowBackground(store.appearance)
        }
    }

    @ViewBuilder
    private func tasks(_ v: LoopView, _ lang: AppLanguage) -> some View {
        let order = ["blocked", "sent", "queued", "draft", "done"]
        let tasks = v.nodes.filter { $0.kind == "task" }
            .sorted { (order.firstIndex(of: $0.status ?? "") ?? 9) < (order.firstIndex(of: $1.status ?? "") ?? 9) }
        Section {
            if tasks.isEmpty {
                Text(lang.string("loop.tasks.empty")).font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(tasks) { t in
                NavigationLink {
                    LoopTaskPage(projectID: projectID, nodeID: t.id)
                } label: {
                    HStack(alignment: .top, spacing: 10) {
                        RoleBadgeView(role: t.to ?? "lead", size: 26)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(lang.server(t.title ?? "")).font(.subheadline.weight(.medium)).lineLimit(2)
                            Text([TextFormatters.roleName(t.to ?? "lead", language: lang), t.waitNote.map(lang.server), t.stale.map { _ in lang.string("loop.task.stale") }]
                                .compactMap { $0 }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        }
                        Spacer()
                        Text(lang.string("loop.task.\(t.status ?? "draft")")).font(.caption).foregroundStyle(Tone.color(taskTone(t.status)))
                    }
                }
            }
        } header: {
            Text(lang.string("loop.tasks"))
        }
        .papertownRowBackground(store.appearance)
    }

    @ViewBuilder
    private func restore(_ v: LoopView, _ act: PageActions, _ lang: AppLanguage) -> some View {
        let gone = v.gone ?? [], spare = v.spare ?? []
        if !gone.isEmpty || !spare.isEmpty {
            Section {
                ForEach(gone) { r in restoreRow(r, lang.string("loop.restore.gone"), act, lang) }
                ForEach(spare) { r in restoreRow(r, lang.string("loop.restore.spare"), act, lang) }
            } header: {
                Text(lang.string("loop.restore"))
            }
            .papertownRowBackground(store.appearance)
        }
    }

    private func restoreRow(_ r: LoopRef, _ action: String, _ act: PageActions, _ lang: AppLanguage) -> some View {
        HStack {
            Text(lang.server(r.title)).font(.subheadline)
            Spacer()
            Button(action) { act.run { try await $0.restoreNode(projectID: projectID, nodeID: r.id) } }
                .buttonStyle(.bordered).controlSize(.small).disabled(act.busy)
        }
    }

    private func copyReport(_ lang: AppLanguage) {
        Task {
            do {
                let r = try await store.fetch { try await $0.loopReport(projectID: projectID) }
                Pasteboard.copy(r.markdown)
                copied = lang.string("loop.report.copied")
            } catch {
                copied = store.message(for: error)
            }
        }
    }
}

func gateTone(_ state: String) -> String {
    switch state {
    case "block": return "fail"
    case "off": return "off"
    default: return state
    }
}

func taskTone(_ status: String?) -> String {
    switch status {
    case "done": return "pass"
    case "blocked": return "fail"
    case "sent": return "running"
    case "queued": return "queued"
    default: return "none"
    }
}

private func gateLine(_ g: LoopGate, _ lang: AppLanguage) -> String {
    var parts: [String] = []
    if let p = g.pass, let t = g.total, t > 0 { parts.append(lang.format("loop.gate.passed", p, t)) }
    if let b = g.blocking, !b.isEmpty { parts.append(b.map { lang.server($0.title) }.joined(separator: "、")) }
    if g.escalated == true { parts.append(lang.string("loop.gate.escalated")) }
    if g.waived == true { parts.append(lang.string("loop.gate.waived")) }
    return parts.joined(separator: " · ")
}

// MARK: - A gate

struct LoopGatePage: View {
    let projectID: String
    let stage: String
    @EnvironmentObject private var store: TownStore

    private static let rounds = [1, 2, 3, 4, 5, 6, 8, 10]

    var body: some View {
        let lang = store.language
        LivePage(load: { try await $0.loop(projectID: projectID) }, events: loopEvents, projectID: projectID) { v, act in
            let node = v.nodes.first { $0.kind == "gate" && $0.gate?.stage == stage }
            List {
                if let g = node?.gate {
                    Section {
                        HStack {
                            Pill(text: lang.string("loop.gate.\(g.state)"), color: Tone.color(gateTone(g.state)), symbol: Tone.symbol(gateTone(g.state)))
                            Spacer()
                            if let p = g.pass, let t = g.total { Text("\(p)/\(t)").font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
                        }
                        if let b = g.blocking, !b.isEmpty {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(lang.string("loop.gate.blocking")).font(.caption.weight(.semibold)).foregroundStyle(.red)
                                BulletList(items: b.map { lang.server($0.title) })
                            }
                        }
                        if let round = g.round, round > 0 { InfoRow(label: lang.string("loop.round"), value: "\(round)") }
                        if let ts = g.ticketStatus { InfoRow(label: lang.string("loop.gate.ticket"), value: lang.string("loop.task.\(ts)")) }
                    }
                    Section {
                        if g.state == "block" {
                            Button(lang.string("loop.gate.rework")) { act.run(lang.string("loop.gate.rework.done")) { try await $0.gate(projectID: projectID, stage: stage, "rework") } }
                        }
                        if g.escalated == true {
                            Button(lang.string("loop.gate.more")) { act.run(lang.string("loop.gate.more.done")) { try await $0.gate(projectID: projectID, stage: stage, "more") } }
                        }
                        if g.state == "block" && g.waived != true {
                            Button(lang.string("loop.gate.waive")) { act.run(lang.string("loop.gate.waive.done")) { try await $0.gate(projectID: projectID, stage: stage, "waive") } }
                        }
                        if (g.checks?.count ?? 0) > 1 {
                            Button(g.open == true ? lang.string("loop.gate.close") : lang.format("loop.gate.open", g.checks?.count ?? 0)) {
                                act.run { try await $0.gate(projectID: projectID, stage: stage, g.open == true ? "close" : "open") }
                            }
                        }
                    }
                    .disabled(act.busy)
                    if let policy = g.policy {
                        Section {
                            Picker(lang.string("loop.policy.ticket"), selection: Binding(get: { policy.auto }, set: { on in
                                act.run { try await $0.loopPolicy(projectID: projectID, stage: stage, auto: on) }
                            })) {
                                Text(lang.string("loop.policy.auto")).tag(true)
                                Text(lang.string("loop.policy.hold")).tag(false)
                            }
                            Picker(lang.string("loop.policy.rounds"), selection: Binding(get: { policy.rounds }, set: { n in
                                act.run { try await $0.loopPolicy(projectID: projectID, stage: stage, rounds: n) }
                            })) {
                                ForEach(Self.rounds + (Self.rounds.contains(policy.rounds) ? [] : [policy.rounds]), id: \.self) { n in
                                    Text(lang.format("loop.policy.rounds.n", n)).tag(n)
                                }
                            }
                        } header: {
                            Text(lang.string("loop.policy"))
                        }
                        .disabled(act.busy)
                    }
                    let checks = v.nodes.compactMap(\.check).filter { (g.checks ?? []).contains($0.id) }
                    if !checks.isEmpty {
                        Section(lang.string("checks.nav")) {
                            ForEach(checks) { c in
                                NavigationLink { CheckDetailPage(projectID: projectID, checkID: c.id) } label: {
                                    Label(lang.server(c.title), systemImage: Tone.symbol(c.status)).foregroundStyle(Tone.color(c.status))
                                }
                            }
                        }
                    }
                } else {
                    Text(lang.string("error.not_found")).foregroundStyle(.secondary)
                }
            }
            .papertownInsetGroupedList()
            .papertownListAppearance(store.appearance)
            .navigationTitle(lang.server(node?.gate?.name ?? node?.title ?? stage))
        }
        .papertownInlineTitle()
    }
}

// MARK: - A task

struct LoopTaskPage: View {
    let projectID: String
    let nodeID: String
    @EnvironmentObject private var store: TownStore
    @Environment(\.dismiss) private var dismiss
    @State private var confirmRemove = false

    var body: some View {
        let lang = store.language
        LivePage(load: { try await $0.loop(projectID: projectID) }, events: loopEvents, projectID: projectID) { v, act in
            let t = v.nodes.first { $0.id == nodeID }
            let there = v.agents?[t?.to ?? "lead"]?.there ?? false
            let after = draftsAfter(v)
            List {
                if let t {
                    Section {
                        HStack {
                            Pill(text: lang.string("loop.task.\(t.status ?? "draft")"), color: Tone.color(taskTone(t.status)))
                            Pill(text: TextFormatters.roleName(t.to ?? "lead", language: lang), color: TextFormatters.roleTint(t.to ?? "lead"))
                            if let r = t.round, r > 0 { Pill(text: lang.format("loop.round.n", r), color: .secondary) }
                        }
                        if let text = t.text, !text.isEmpty { Text(lang.server(text)).font(.subheadline).textSelection(.enabled) }
                        if let w = t.waitNote { Label(lang.server(w), systemImage: "hourglass").font(.caption).foregroundStyle(.orange) }
                        if let s = t.stale { Label(lang.server(s), systemImage: "exclamationmark.arrow.triangle.2.circlepath").font(.caption).foregroundStyle(.orange) }
                        if let at = t.sentAt { InfoRow(label: lang.string("loop.task.sent_at"), value: Stamp.short(at, lang)) }
                        if let at = t.doneAt { InfoRow(label: lang.string("loop.task.done_at"), value: Stamp.short(at, lang)) }
                    }
                    if let r = t.result?.displayText, !r.isEmpty {
                        Section(lang.string("loop.task.result")) { Text(lang.server(r)).font(.footnote).textSelection(.enabled) }
                    }
                    actions(t, there: there, after: after, act, lang)
                    if let log = t.log, !log.isEmpty {
                        Section(lang.string("loop.task.log")) {
                            ForEach(log.reversed(), id: \.self) { e in
                                VStack(alignment: .leading, spacing: 2) {
                                    Text([e.by.map(lang.server), e.ts.map { Stamp.short($0, lang) }].compactMap { $0 }.joined(separator: " · "))
                                        .font(.caption2).foregroundStyle(.secondary)
                                    if let text = e.text { Text(lang.server(text)).font(.caption).lineLimit(6) }
                                }
                            }
                        }
                    }
                    if t.agentID == nil {
                        Section {
                            Button(lang.string("loop.task.remove"), role: .destructive) { confirmRemove = true }
                        }
                        .confirmationDialog(lang.format("loop.task.remove.confirm", lang.server(t.title ?? "")), isPresented: $confirmRemove, titleVisibility: .visible) {
                            Button(lang.string("loop.task.remove"), role: .destructive) {
                                act.run { try await $0.removeNode(projectID: projectID, nodeID: nodeID) }
                                dismiss()
                            }
                        }
                    }
                } else {
                    Text(lang.string("error.not_found")).foregroundStyle(.secondary)
                }
            }
            .papertownInsetGroupedList()
            .papertownListAppearance(store.appearance)
            .navigationTitle(lang.server(t?.title ?? ""))
        }
        .papertownInlineTitle()
    }

    @ViewBuilder
    private func actions(_ t: LoopNode, there: Bool, after: Int, _ act: PageActions, _ lang: AppLanguage) -> some View {
        let who = TextFormatters.roleName(t.to ?? "lead", language: lang)
        Section {
            switch t.status ?? "draft" {
            case "draft":
                Button(lang.format("loop.task.send", who)) { act.run(lang.format("loop.task.sent", who)) { try await $0.sendTask(projectID: projectID, nodeID: nodeID, chain: false) } }
                    .disabled(!there)
                if after > 0 {
                    Button(lang.format("loop.task.send_chain", after)) { act.run(lang.format("loop.task.sent", who)) { try await $0.sendTask(projectID: projectID, nodeID: nodeID, chain: true) } }
                        .disabled(!there)
                }
            case "queued":
                Button(lang.string("loop.task.unqueue")) { act.run { try await $0.editNode(projectID: projectID, nodeID: nodeID, LoopNodeEdit(status: "draft")) } }
                if t.waitNote != nil {
                    Button(lang.string("action.retry")) { act.run { try await $0.sendTask(projectID: projectID, nodeID: nodeID, chain: false) } }
                }
            case "sent":
                Button(lang.string("loop.task.mark_done")) { act.run { try await $0.editNode(projectID: projectID, nodeID: nodeID, LoopNodeEdit(status: "done")) } }
            case "blocked", "done":
                SendField(placeholder: lang.string(t.status == "done" ? "loop.task.back.placeholder" : "loop.task.reply.placeholder"),
                          button: lang.string(t.status == "done" ? "loop.task.back" : "loop.task.reply"), limit: 4000, axis: .vertical,
                          disabled: act.busy || !there) { text in
                    act.run(lang.format("loop.task.sent", who)) { try await $0.backTask(projectID: projectID, nodeID: nodeID, text: text) }
                }
                if t.status == "blocked" {
                    Button(lang.string("loop.task.mark_done")) { act.run { try await $0.editNode(projectID: projectID, nodeID: nodeID, LoopNodeEdit(status: "done")) } }
                } else {
                    Button(lang.string("loop.task.reopen")) { act.run { try await $0.editNode(projectID: projectID, nodeID: nodeID, LoopNodeEdit(status: "draft")) } }
                }
            default:
                EmptyView()
            }
        } footer: {
            if !there { Text(lang.format("loop.task.no_agent", who)) }
        }
        .disabled(act.busy)
    }

    /// Drafts waiting behind this one, which a chained send also queues.
    private func draftsAfter(_ v: LoopView) -> Int {
        guard let i = v.nodes.firstIndex(where: { $0.id == nodeID }) else { return 0 }
        return v.nodes[(i + 1)...].filter { $0.kind == "task" && $0.status == "draft" }.count
    }
}

// MARK: - Adding a node

struct NewLoopNodeSheet: View {
    let projectID: String
    let agents: [String: LoopView.There]
    let add: (NewLoopNode) -> Void
    @EnvironmentObject private var store: TownStore
    @Environment(\.dismiss) private var dismiss
    @State private var kind = "task"
    @State private var to = "lead"
    @State private var title = ""
    @State private var text = ""
    @State private var prio = "P0"

    var body: some View {
        let lang = store.language
        let there = agents[to]?.there ?? false
        let need = kind == "note" ? !text.isEmpty : !title.isEmpty && !text.isEmpty
        NavigationStack {
            Form {
                Picker("", selection: $kind) {
                    Text(lang.string("loop.new.task")).tag("task")
                    Text(lang.string("loop.new.soft")).tag("soft")
                    Text(lang.string("loop.new.hard")).tag("hard")
                    Text(lang.string("loop.new.note")).tag("note")
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                if kind == "task" {
                    Picker(lang.string("loop.new.to"), selection: $to) {
                        ForEach(["lead", "coder", "writer"], id: \.self) { Text(TextFormatters.roleName($0, language: lang)).tag($0) }
                    }
                }
                if kind == "hard" {
                    Picker(lang.string("loop.new.prio"), selection: $prio) {
                        Text(lang.string("loop.new.p0")).tag("P0")
                        Text(lang.string("loop.new.p1")).tag("P1")
                    }
                }
                if kind != "note" {
                    TextField(lang.string("loop.new.title"), text: $title)
                        .onChange(of: title) { if $0.count > (kind == "task" ? 60 : 20) { title = String($0.prefix(kind == "task" ? 60 : 20)) } }
                }
                TextField(lang.string("loop.new.text.\(kind)"), text: $text, axis: .vertical)
                    .lineLimit(4...10)
                    .onChange(of: text) { if $0.count > 4000 { text = String($0.prefix(4000)) } }
            }
            .formStyle(.grouped)
            .navigationTitle(lang.string("loop.add"))
            .papertownInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(lang.string("action.cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Menu {
                        if kind == "task" && there {
                            Button(lang.format("loop.new.add_send", TextFormatters.roleName(to, language: lang))) { done(send: true) }
                        }
                        Button(lang.string(kind == "task" && there ? "loop.new.hold" : "loop.new.add")) { done(send: false) }
                    } label: {
                        Text(lang.string("loop.new.add"))
                    } primaryAction: {
                        done(send: kind == "task" && there)
                    }
                    .disabled(!need)
                }
            }
        }
    }

    private func done(send: Bool) {
        add(NewLoopNode(kind: kind, title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                        text: text.trimmingCharacters(in: .whitespacesAndNewlines), to: to, prio: prio, send: send))
        dismiss()
    }
}

// MARK: - Copying

enum Pasteboard {
    static func copy(_ text: String) {
        #if os(iOS)
        UIPasteboard.general.string = text
        #elseif os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #endif
    }
}
