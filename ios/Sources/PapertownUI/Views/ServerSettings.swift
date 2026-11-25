import PapertownCore
import SwiftUI

// The connected server's own settings, as in the web's Settings: who may sign in and how (the access password, access
// keys), how staff start by default and which models they use, how usage is read and budgeted, and the sample projects.

struct ServerSettingsSection: View {
    @EnvironmentObject private var store: TownStore
    @State private var samplesNote: String?
    @State private var addingSamples = false

    var body: some View {
        let lang = store.language
        Section {
            NavigationLink { AccessSettingsPage() } label: { Label(lang.string("settings.access"), systemImage: "lock.shield") }
            NavigationLink { AgentSettingsPage() } label: { Label(lang.string("settings.agents"), systemImage: "person.2.badge.gearshape") }
            NavigationLink { UsageSettingsPage() } label: { Label(lang.string("settings.usage"), systemImage: "dollarsign.gauge.chart.lefthalf.righthalf") }
            Button {
                addingSamples = true
                Task {
                    do { samplesNote = lang.server(try await store.fetch { try await $0.addSamples() }); await store.refreshAll() }
                    catch { samplesNote = store.message(for: error) }
                    addingSamples = false
                }
            } label: {
                Label(lang.string(addingSamples ? "settings.samples.adding" : "settings.samples"), systemImage: "tray.and.arrow.down")
            }
            .disabled(addingSamples)
        } header: {
            Text(lang.string("settings.section"))
        } footer: {
            Text(lang.string("settings.section.footer"))
        }
        .papertownRowBackground(store.appearance)
        .alert(samplesNote ?? "", isPresented: Binding(get: { samplesNote != nil }, set: { if !$0 { samplesNote = nil } })) {
            Button(lang.string("action.ok"), role: .cancel) {}
        }
    }
}

// MARK: - Access and sign-in

struct AccessSettingsPage: View {
    @EnvironmentObject private var store: TownStore
    @State private var old = ""
    @State private var new = ""
    @State private var again = ""
    @State private var confirmClear = false
    @State private var keyName = ""
    @State private var madeKey: AccessKeyInfo?
    @State private var revoking: AccessKeyInfo?

    private struct Loaded { let auth: AuthState; let keys: [AccessKeyInfo]? }

    var body: some View {
        let lang = store.language
        LivePage(load: { c -> Loaded in
            let auth = try await c.authState()
            let keys = auth.local || auth.signedIn ? try? await c.accessKeys() : nil
            return Loaded(auth: auth, keys: keys)
        }) { v, act in
            List {
                Section(lang.string("access.device")) {
                    Text(lang.string(v.auth.local ? "access.device.local" : v.auth.key == true ? "access.device.key" : "access.device.password"))
                        .font(.subheadline)
                }
                Section {
                    Text(lang.string(v.auth.password ? "access.password.set" : "access.password.none")).font(.subheadline)
                    if !v.auth.local && v.auth.password {
                        SecureField(lang.string("access.password.old"), text: $old)
                    }
                    SecureField(lang.string("access.password.new"), text: $new)
                    SecureField(lang.string("access.password.again"), text: $again)
                    if !again.isEmpty && new != again {
                        Text(lang.string("access.password.mismatch")).font(.caption).emState(.bad)
                    }
                    Button(lang.string(v.auth.password ? "access.password.change" : "access.password.save")) {
                        let (pw, previous) = (new, old)
                        act.run(lang.string("access.password.saved")) { try await $0.setPassword(pw, old: previous.isEmpty ? nil : previous) }
                        old = ""; new = ""; again = ""
                    }
                    .disabled(act.busy || new.count < 6 || new != again)
                    if v.auth.local && v.auth.password {
                        Button(lang.string("access.password.clear"), role: .destructive) { confirmClear = true }
                    }
                } header: {
                    Text(lang.string("access.password"))
                } footer: {
                    Text(lang.string("access.password.footer"))
                }
                if v.auth.password {
                    Section {
                        Button(lang.string("access.sessions.end"), role: .destructive) {
                            act.say { c in
                                let n = try await c.signOutEverywhere()
                                return lang.format("access.sessions.ended", n)
                            }
                        }
                        .disabled(act.busy || (v.auth.sessions ?? 0) == 0)
                    } footer: {
                        Text(lang.format("access.sessions", v.auth.sessions ?? 0))
                    }
                }
                keys(v.keys, act, lang)
            }
            .papertownInsetGroupedList()
            .papertownListAppearance(store.appearance)
            .confirmationDialog(lang.string("access.password.clear.confirm"), isPresented: $confirmClear, titleVisibility: .visible) {
                Button(lang.string("access.password.clear"), role: .destructive) {
                    act.run(lang.string("access.password.cleared")) { try await $0.clearPassword() }
                }
            } message: {
                Text(lang.string("access.password.clear.note"))
            }
            .confirmationDialog(lang.format("access.keys.revoke.confirm", revoking?.name ?? ""),
                                isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }), titleVisibility: .visible) {
                Button(lang.string("access.keys.revoke"), role: .destructive) {
                    if let id = revoking?.id { act.run { try await $0.revokeAccessKey(id: id) } }
                }
            }
        }
        .navigationTitle(lang.string("settings.access"))
        .papertownInlineTitle()
    }

    @ViewBuilder
    private func keys(_ keys: [AccessKeyInfo]?, _ act: PageActions, _ lang: AppLanguage) -> some View {
        Section {
            if let keys {
                if let made = madeKey, let key = made.key {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(lang.format("access.keys.made", made.name)).font(.subheadline.weight(.medium))
                        Text(key).font(.caption.monospaced()).textSelection(.enabled)
                        HStack {
                            Button(lang.string("access.keys.copy")) { Pasteboard.copy(key) }.buttonStyle(.borderedProminent)
                            Button(lang.string("action.done")) { madeKey = nil }.buttonStyle(.bordered)
                        }
                        .controlSize(.small)
                    }
                }
                HStack {
                    TextField(lang.string("access.keys.name"), text: $keyName)
                        .onChange(of: keyName) { if $0.count > 60 { keyName = String($0.prefix(60)) } }
                    Button(lang.string("access.keys.create")) {
                        let name = keyName.trimmingCharacters(in: .whitespacesAndNewlines)
                        act.say { c in
                            let made = try await c.createAccessKey(name: name)
                            await MainActor.run { madeKey = made; keyName = "" }
                            return nil
                        }
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(act.busy)
                }
                if keys.isEmpty { Text(lang.string("access.keys.none")).font(.footnote).foregroundStyle(.secondary) }
                ForEach(keys) { k in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(k.name).font(.subheadline)
                            Text(lang.format("access.keys.row", k.hint, Stamp.short(k.at, lang), k.seen.map { Stamp.ago($0, lang) } ?? lang.string("access.keys.unused")))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button(lang.string("access.keys.revoke"), role: .destructive) { revoking = k }
                            .buttonStyle(.bordered).controlSize(.small)
                    }
                }
            } else {
                Text(lang.string("access.keys.not_here")).font(.footnote).foregroundStyle(.secondary)
            }
        } header: {
            Text(lang.string("access.keys"))
        } footer: {
            Text(lang.string("access.keys.footer"))
        }
    }
}

// MARK: - Staff: how they start and which models they use

struct AgentSettingsPage: View {
    @EnvironmentObject private var store: TownStore
    @State private var fresh = false

    private struct Loaded { let paseo: PaseoInfo?; let paseoError: String?; let runtime: String; let herdr: HerdrInfo?; let pi: Roster.Available? }

    var body: some View {
        let lang = store.language
        LivePage(load: { [fresh] c -> Loaded in
            var paseo: PaseoInfo?, problem: String?
            do { paseo = try await c.paseo(fresh: fresh) } catch { problem = error.localizedDescription }
            async let r = c.defaultRuntime()
            async let h = try? c.herdr()
            async let p = try? c.roster(role: "coder")
            return Loaded(paseo: paseo, paseoError: problem, runtime: try await r, herdr: await h, pi: await p?.available)
        }, events: ["paseo_models"]) { v, act in
            List {
                Section {
                    Picker(lang.string("agents.runtime"), selection: Binding(get: { v.runtime }, set: { r in
                        act.run { try await $0.setDefaultRuntime(r) }
                    })) {
                        // Paseo is offered once its chat is debugged ([paseo] paseo_chat)
                        ForEach(["herdr", "tmux", "headless"] + (v.paseo?.chatOn == true ? ["paseo"] : []), id: \.self) {
                            Text(lang.string("runtime.\($0)")).tag($0)
                        }
                    }
                    .disabled(act.busy)
                } footer: {
                    Text(lang.string("agents.runtime.footer"))
                }
                paseo(v.paseo, v.paseoError, act, lang)
                Section("herdr") {
                    InfoRow(label: lang.string("agents.status"), value: v.herdr.map { $0.ok ? lang.string("agents.running") : lang.server($0.note ?? "") } ?? lang.string("agents.down"), status: v.herdr?.ok == true ? nil : .warn)
                    if let s = v.herdr?.socket { InfoRow(label: lang.string("agents.herdr.socket"), value: s) }
                    if let n = v.herdr?.count { InfoRow(label: lang.string("agents.herdr.count"), value: "\(n)") }
                }
                Section(lang.string("agents.pi")) {
                    InfoRow(label: lang.string("agents.status"), value: v.pi.map { $0.ok ? lang.string("agents.available") : lang.server($0.note ?? "") } ?? "—", status: v.pi?.ok == false ? .warn : nil)
                }
            }
            .papertownInsetGroupedList()
            .papertownListAppearance(store.appearance)
        }
        .navigationTitle(lang.string("settings.agents"))
        .papertownInlineTitle()
    }

    @ViewBuilder
    private func paseo(_ p: PaseoInfo?, _ problem: String?, _ act: PageActions, _ lang: AppLanguage) -> some View {
        Section {
            InfoRow(label: lang.string("agents.status"), value: p?.status.ok == true
                    ? lang.format("agents.paseo.ok", p?.status.version ?? "") : lang.string("agents.down"), status: p?.status.ok == true ? nil : .warn)
            if let note = p?.status.note ?? problem, p?.status.ok != true {
                Text(lang.server(note)).font(.caption).foregroundStyle(.secondary)
            }
            if let p, p.status.ok {
                InfoRow(label: lang.string("agents.paseo.web"), value: p.status.web ?? lang.string("agents.paseo.web.off"))
                ForEach(p.providers) { pr in
                    InfoRow(label: pr.label ?? pr.id, value: pr.error != nil ? lang.string("agents.paseo.models_failed") : lang.format("agents.paseo.models", pr.models?.count ?? 0), status: pr.error == nil ? nil : .warn)
                }
                Button(lang.string("agents.paseo.reload")) { fresh = true; act.run { _ = try await $0.paseo(fresh: true) } }
                    .disabled(act.busy)
            }
        } header: {
            Text("Paseo")
        }
        if let p, p.status.ok {
            Section {
                ForEach(["assistant", "lead", "worker"], id: \.self) { role in
                    let d = p.defaults?[role]
                    NavigationLink { DefaultModelPage(role: role) } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(lang.string("agents.default.\(role)"))
                            Text(d?.set == true ? [d?.provider, d?.model, d?.thinking].compactMap { $0 }.joined(separator: " / ")
                                 : lang.format("agents.default.env", role.uppercased()))
                                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                }
            } header: {
                Text(lang.string("agents.defaults"))
            } footer: {
                Text(lang.string("agents.defaults.footer"))
            }
            if let news = p.news, !news.isEmpty {
                Section {
                    ForEach(news.prefix(4)) { n in
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(n.label ?? n.provider) · \(n.name ?? n.model)").font(.subheadline).emMark()
                            if let t = n.thinking, !t.isEmpty { Text(lang.format("agents.news.thinking", t.joined(separator: " / "))).font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                    if news.count > 4 { Text(lang.format("agents.news.more", news.count - 4)).font(.caption).foregroundStyle(.secondary) }
                    Button(lang.string("agents.news.dismiss")) { act.run { try await $0.dismissModelNews() } }.disabled(act.busy)
                } header: {
                    Text(lang.format("agents.news", news.count))
                } footer: {
                    Text(lang.string("agents.news.footer"))
                }
            }
        }
    }
}

/// The model a role starts with: chosen from what Paseo offers, or back to the environment's setting.
struct DefaultModelPage: View {
    let role: String
    @EnvironmentObject private var store: TownStore
    @State private var provider = ""
    @State private var model = ""
    @State private var thinking = ""
    @State private var filled = false

    var body: some View {
        let lang = store.language
        LivePage(load: { try await $0.paseo() }) { p, act in
            let d = p.defaults?[role]
            let models = p.providers.first { $0.id == provider }?.models ?? []
            let current = models.first { $0.id == model }
            List {
                Section {
                    Picker(lang.string("hire.provider"), selection: $provider) {
                        Text(lang.string("agents.default.none")).tag("")
                        ForEach(p.providers) { Text($0.label ?? $0.id).tag($0.id) }
                    }
                    if !models.isEmpty {
                        Picker(lang.string("hire.model"), selection: $model) {
                            ForEach(models) { Text($0.name ?? $0.id).tag($0.id) }
                        }
                    }
                    if let t = current?.thinking, t.count > 1 {
                        Picker(lang.string("hire.thinking"), selection: $thinking) {
                            ForEach(t, id: \.self) { Text($0).tag($0) }
                        }
                    }
                } footer: {
                    if let d, d.set == true, let dp = d.provider, !p.providers.contains(where: { $0.id == dp && ($0.models ?? []).contains { $0.id == d.model } }) {
                        Text(lang.format("agents.default.gone", [d.provider, d.model].compactMap { $0 }.joined(separator: " / "))).emState(.warn, detail: true)
                    } else {
                        Text(lang.string(d?.set == true ? "agents.default.set" : "agents.default.unset"))
                    }
                }
                Section {
                    Button(lang.string("action.save")) {
                        let (pr, m, t) = (provider, model, thinking)
                        act.run(lang.string("agents.default.saved")) {
                            try await $0.setDefaultModel(role: role, provider: pr, model: m.isEmpty ? nil : m, thinking: t.isEmpty ? nil : t)
                        }
                    }
                    .disabled(act.busy || provider.isEmpty)
                    if d?.set == true {
                        Button(lang.string("agents.default.reset")) {
                            act.run(lang.string("agents.default.saved")) { try await $0.setDefaultModel(role: role, provider: nil, model: nil, thinking: nil) }
                            filled = false
                        }
                        .disabled(act.busy)
                    }
                }
            }
            .papertownInsetGroupedList()
            .papertownListAppearance(store.appearance)
            .onAppear {
                guard !filled else { return }
                filled = true
                provider = d?.provider ?? ""; model = d?.model ?? ""; thinking = d?.thinking ?? ""
            }
            .onChange(of: provider) { pr in
                let list = p.providers.first { $0.id == pr }?.models ?? []
                if !list.contains(where: { $0.id == model }) { model = list.first?.id ?? "" }
            }
            .onChange(of: model) { m in
                let t = (p.providers.first { $0.id == provider }?.models ?? []).first { $0.id == m }
                if !(t?.thinking ?? []).contains(thinking) { thinking = t?.defaultThinking ?? "" }
            }
        }
        .navigationTitle(lang.string("agents.default.\(role)"))
        .papertownInlineTitle()
    }
}

// MARK: - Usage

struct UsageSettingsPage: View {
    @EnvironmentObject private var store: TownStore
    @State private var budget = ""
    @State private var poll = 300.0
    @State private var logs = true
    @State private var filled = false

    var body: some View {
        let lang = store.language
        LivePage(load: { try await $0.usageSettings() }) { s, act in
            List {
                Section {
                    HStack {
                        Text(lang.string("usage.settings.budget"))
                        Spacer()
                        TextField(lang.string("usage.no_budget"), text: $budget)
                            .multilineTextAlignment(.trailing)
                            .frame(maxWidth: 120)
                            #if os(iOS)
                            .keyboardType(.decimalPad)
                            #endif
                    }
                    Stepper(value: $poll, in: 60...86400, step: 60) {
                        HStack { Text(lang.string("usage.settings.poll")); Spacer(); Text(lang.format("usage.settings.poll.n", Int(poll / 60))).foregroundStyle(.secondary) }
                    }
                    Toggle(isOn: $logs) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(lang.string("usage.settings.logs"))
                            Text(lang.string("usage.settings.logs.sub")).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                } footer: {
                    Text(lang.string("usage.budget.footer"))
                }
                Section {
                    Button(lang.string("action.save")) {
                        let value = UsageSettings(defaultBudget: Double(budget.replacingOccurrences(of: ",", with: ".")), poll: poll, logs: logs)
                        act.run(lang.string("usage.settings.saved")) { _ = try await $0.setUsageSettings(value) }
                    }
                    .disabled(act.busy || (!budget.isEmpty && (Double(budget.replacingOccurrences(of: ",", with: ".")) ?? 0) <= 0))
                }
            }
            .papertownInsetGroupedList()
            .papertownListAppearance(store.appearance)
            .onAppear {
                guard !filled else { return }
                filled = true
                budget = s.defaultBudget.map { String(format: "%g", $0) } ?? ""
                poll = s.poll; logs = s.logs
            }
        }
        .navigationTitle(lang.string("settings.usage"))
        .papertownInlineTitle()
    }
}
