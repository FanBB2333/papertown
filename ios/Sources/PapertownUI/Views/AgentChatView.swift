import Foundation
import PapertownCore
import SwiftUI

/// One conversation: an agent of the town, the assistant, or a terminal the town watches. Messages, tool calls,
/// questions and proposed actions in order, then what you sent from here until the conversation shows it, and what the
/// agent is doing now; what waits for you (a permission, a dialog on the terminal's screen) above the composer. A terminal
/// CLI also has its terminal tab: the same conversation as the CLI draws it, with the keys it takes.
struct AgentChatView: View {
    let target: ChatTarget
    let role: String
    let subtitle: String

    init(target: ChatTarget, role: String, subtitle: String) {
        self.target = target
        self.role = role
        self.subtitle = subtitle
    }

    init(agentID: String, role: String, subtitle: String) {
        self.init(target: .agent(agentID), role: role, subtitle: subtitle)
    }

    @EnvironmentObject private var store: TownStore
    @State private var draft = ""
    @State private var deliveryMode: DeliveryMode = .steer
    @State private var notice: String?
    @State private var showTerminal = false
    @State private var busy = false
    @State private var showConversations = false
    @State private var showStart = false
    @State private var modelChoice: ModelChoice?
    @FocusState private var typing: Bool

    private struct ModelChoice: Identifiable {
        let model: String
        let thinking: String
        var id: String { model + "@" + thinking }
    }

    private var state: ConversationState { store.conversation(target) }

    private var title: String {
        if case .terminal = target { return state.terminal?.name ?? state.terminal?.title ?? store.language.string("chat.terminal") }
        return TextFormatters.roleName(role, language: store.language)
    }

    var body: some View {
        let lang = store.language
        VStack(spacing: 0) {
            if state.hasScreen {
                Picker("", selection: $showTerminal) {
                    Text(lang.string("chat.view.chat")).tag(false)
                    Text(lang.string("chat.view.screen")).tag(true)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
            }
            if showTerminal && state.hasScreen {
                TerminalPane(target: target)
            } else {
                messages(lang)
            }
        }
        .background(store.appearance.groupedBackground ?? Color.clear)
        .safeAreaInset(edge: .bottom) { composer(lang) }
        .navigationTitle(title)
        .papertownInlineTitle()
        .toolbar {
            ToolbarItem(placement: .principal) { titleMenu(lang) }
            if case .agent(let id) = target {
                ToolbarItem(placement: .automatic) { moreMenu(id, lang) }
            }
            if state.isWorking || target.isAssistant {
                ToolbarItem(placement: .primaryAction) {
                    HStack(spacing: 12) {
                        if state.isWorking, case .agent(let id) = target {
                            Button {
                                Task {
                                    if state.agent?.term != nil {
                                        await store.act(on: target) { try await $0.stopAgent(id) }
                                    } else {
                                        await store.abortAgent(id)
                                    }
                                }
                            } label: {
                                Image(systemName: "stop.circle").foregroundStyle(.red)
                            }
                            .accessibilityLabel(lang.string("chat.stop"))
                        }
                        if target.isAssistant {
                            Button {
                                Task { await store.act(on: target) { try await $0.assistantNew() } }
                            } label: { Image(systemName: "square.and.pencil") }
                            .accessibilityLabel(lang.string("chat.new_conversation"))
                        }
                    }
                }
            }
            #if os(iOS)
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button { typing = false } label: { Image(systemName: "keyboard.chevron.compact.down") }
                    .accessibilityLabel(lang.string("chat.hide_keyboard"))
            }
            #endif
        }
        .onAppear {
            #if DEBUG
            if UserDefaults.standard.string(forKey: "PTChatTab") == "terminal" { showTerminal = true }
            #endif
            store.chatShowsTerminal = showTerminal
            store.setActiveChat(target)
        }
        .onDisappear { store.leaveChat(target) }
        .onChange(of: showTerminal) { on in
            store.chatShowsTerminal = on
            if on { Task { await store.refreshChat(target) } }
        }
        .sheet(isPresented: $showConversations) {
            if case .agent(let id) = target {
                ConversationsSheet(agentID: id) { Task { await store.refreshChat(target) } }
                    .papertownSheetFrame(height: 480)
                    .environmentObject(store)
                    .tint(store.appearance.tintColor)
            }
        }
        .sheet(isPresented: $showStart) {
            let targetID: String? = {
                if case .agent(let id) = target { return id }
                return nil
            }()
            HireSheet(projectID: state.agent?.lineID, role: role, agentID: targetID) { _ in Task { await store.refreshChat(target) } }
                .papertownSheetFrame(height: 540)
                .environmentObject(store)
                .tint(store.appearance.tintColor)
        }
        .refreshable { await store.refreshChat(target) }
        .alert(item: $modelChoice) { choice in
            Alert(title: Text(lang.format("model.confirm.title", modelName(choice, lang))),
                  message: Text(lang.string("model.confirm.message")),
                  primaryButton: .default(Text(lang.string("model.confirm.switch"))) { Task { await switchModel(choice) } },
                  secondaryButton: .cancel(Text(lang.string("action.cancel"))))
        }
    }

    private func subtitleLine(_ lang: AppLanguage) -> String {
        var parts = [subtitle]
        if let model = state.agent?.displayModel { parts.append(model) }
        if let thinking = models?.current?.thinking, !thinking.isEmpty { parts.append(thinking) }
        if let term = state.agent?.term { parts.append(term.backend) }
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    // MARK: Model

    private var agentID: String? {
        if case .agent(let id) = target { return id }
        return nil
    }

    private var models: AgentModels? { agentID.flatMap { store.agentModels[$0] } }

    /// A terminal CLI that has started can be resumed on another model of the same CLI.
    private var canSwitchModel: Bool {
        models?.how == "resume" && state.agent?.started == true && !store.isDemo
    }

    @ViewBuilder
    private func titleMenu(_ lang: AppLanguage) -> some View {
        let label = VStack(spacing: 1) {
            Text(title).font(.headline).foregroundStyle(.primary).lineLimit(1)
            HStack(spacing: 3) {
                Text(subtitleLine(lang)).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                if canSwitchModel {
                    Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold)).foregroundStyle(.secondary)
                }
            }
        }
        if canSwitchModel, let m = models {
            Menu { modelMenu(m, lang) } label: { label }
                .accessibilityLabel(lang.string("model.menu"))
        } else {
            label
        }
    }

    @ViewBuilder
    private func modelMenu(_ m: AgentModels, _ lang: AppLanguage) -> some View {
        let cur = m.current
        let working = state.isWorking || state.termStatus == "starting"
        Section(lang.string(working ? "model.busy" : "model.header")) {
            ForEach(m.models) { model in
                let name = model.name ?? model.id
                let levels = model.thinking ?? []
                let on = cur?.model == model.id
                if levels.count > 1 {
                    Menu {
                        ForEach(levels, id: \.self) { t in
                            Button { modelChoice = ModelChoice(model: model.id, thinking: t) } label: {
                                if on && cur?.thinking == t { Label(t, systemImage: "checkmark") } else { Text(t) }
                            }
                        }
                    } label: {
                        if on { Label(name, systemImage: "checkmark") } else { Text(name) }
                    }
                } else {
                    Button { modelChoice = ModelChoice(model: model.id, thinking: "") } label: {
                        if on { Label(name, systemImage: "checkmark") } else { Text(name) }
                    }
                }
            }
            Button { modelChoice = ModelChoice(model: "", thinking: "") } label: {
                if cur?.model.isEmpty == true { Label(lang.string("model.cli_default"), systemImage: "checkmark") } else { Text(lang.string("model.cli_default")) }
            }
        }
        .disabled(working)
        if m.models.isEmpty {
            Text(lang.string("model.no_list"))
        }
    }

    private func modelName(_ c: ModelChoice, _ lang: AppLanguage) -> String {
        let name = c.model.isEmpty ? lang.string("model.cli_default") : (models?.models.first { $0.id == c.model }?.name ?? c.model)
        return c.thinking.isEmpty ? name : "\(name) · \(c.thinking)"
    }

    private func switchModel(_ c: ModelChoice) async {
        guard let agentID else { return }
        notice = nil
        if let why = await store.switchModel(agentID: agentID, model: c.model, thinking: c.thinking) {
            notice = why
        }
    }

    // MARK: Messages

    /// What changes the end of the conversation, to keep it in view.
    private var tailKey: String {
        "\(state.entries.count)·\(state.pending.count)·\(state.entries.last?.text.count ?? 0)·\(state.isWorking)·\(state.screenTail.joined().count)"
    }

    @ViewBuilder
    private func messages(_ lang: AppLanguage) -> some View {
        let working = state.isWorking || state.termStatus == "starting"
        if state.isLoading && state.entries.isEmpty && state.pending.isEmpty {
            Spacer()
            ProgressView()
            Spacer()
        } else if state.entries.isEmpty && state.pending.isEmpty && !working {
            Spacer()
            EmptyStateView(title: lang.string("chat.empty.title"), systemImage: "bubble.left.and.bubble.right",
                           description: state.error ?? state.transcriptNote.map(lang.server) ?? lang.string("chat.empty.desc"))
                .onTapGesture { typing = false }
            Spacer()
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if let note = state.transcriptNote {
                            Label(lang.server(note), systemImage: "info.circle")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        ForEach(state.entries) { entry in
                            row(entry, lang).id(entry.id)
                        }
                        ForEach(state.pending) { p in
                            pendingRow(p, lang).id(p.id)
                        }
                        if working { activityRow(lang) }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                }
                .scrollDismissesKeyboard(.interactively)
                .simultaneousGesture(TapGesture().onEnded { typing = false })
                .onChange(of: tailKey) { _ in
                    withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("end", anchor: .bottom) }
                }
                .onAppear { proxy.scrollTo("end", anchor: .bottom) }
            }
        }
    }

    @ViewBuilder
    private func row(_ e: ChatEntry, _ lang: AppLanguage) -> some View {
        switch e.kind {
        case .user:
            HStack {
                Spacer(minLength: 48)
                userBubble(e.text)
            }
        case .assistant:
            HStack(alignment: .top, spacing: 8) {
                RoleBadgeView(role: role, size: 24)
                Text(markdown(lang.server(e.text)))
                    .textSelection(.enabled)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 16))
                Spacer(minLength: 24)
            }
        case .tool:
            DisclosureGroup {
                if let arg = e.arg, !arg.isEmpty { MonoBlock(text: arg, maxHeight: 160) }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "wrench.and.screwdriver").foregroundStyle(.secondary)
                    Text(e.tool ?? e.text).font(.caption.weight(.medium))
                    if let arg = e.arg { Text(arg).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1) }
                    Spacer()
                    if e.status == "running" {
                        ProgressView().controlSize(.mini)
                    } else if let st = e.status {
                        Image(systemName: Tone.symbol(st)).foregroundStyle(Tone.color(st)).imageScale(.small)
                    }
                }
            }
            .padding(.leading, 32)
        case .error:
            Label(lang.server(e.text), systemImage: "exclamationmark.triangle.fill")
                .font(.footnote).foregroundStyle(.red)
                .padding(.leading, 32)
        case .note:
            Text(lang.server(e.text))
                .font(.caption).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .center)
                .multilineTextAlignment(.center)
        case .ask:
            askCard(e, lang)
        case .act:
            actCard(e, lang)
        }
    }

    private func userBubble(_ text: String, dim: Bool = false) -> some View {
        Text(text)
            .textSelection(.enabled)
            .padding(.horizontal, 12).padding(.vertical, 8)
            .foregroundStyle(.white)
            .background(store.appearance.tintColor.opacity(dim ? 0.55 : 1), in: RoundedRectangle(cornerRadius: 16))
    }

    /// A message sent from here: shown at once, with how far it got and what can be done when it did not get through.
    private func pendingRow(_ p: PendingMessage, _ lang: AppLanguage) -> some View {
        VStack(alignment: .trailing, spacing: 4) {
            HStack {
                Spacer(minLength: 48)
                userBubble(p.text, dim: p.phase != .sent)
            }
            HStack(spacing: 6) {
                switch p.phase {
                case .sending:
                    ProgressView().controlSize(.mini)
                    Text(lang.string("chat.pending.sending"))
                case .sent:
                    Image(systemName: "checkmark")
                    Text(lang.string(state.hasScreen ? "chat.pending.typed" : "chat.pending.sent"))
                case .uncertain:
                    Image(systemName: "questionmark.circle").foregroundStyle(.orange)
                    Text(lang.string("chat.pending.uncertain"))
                    Button(lang.string("chat.uncertain.refresh")) { Task { await store.refreshChat(target) } }
                    Button(lang.string("chat.uncertain.resend")) { Task { await store.resendPending(p.id, in: target) } }
                    Button(lang.string("action.delete"), role: .destructive) { store.dropPending(p.id, in: target) }
                case .failed(let why):
                    Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.red)
                    Text(why).foregroundStyle(.red).lineLimit(3)
                    Button(lang.string("chat.uncertain.resend")) { Task { await store.resendPending(p.id, in: target) } }
                    Button(lang.string("chat.pending.edit")) {
                        draft = p.text
                        store.dropPending(p.id, in: target)
                        typing = true
                    }
                    Button(lang.string("action.delete"), role: .destructive) { store.dropPending(p.id, in: target) }
                }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
            .buttonStyle(.borderless)
            .multilineTextAlignment(.trailing)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    // MARK: Activity

    /// While it works: what it is doing as its watch or its last tool says, for how long, and the CLI's own working line.
    private func activityRow(_ lang: AppLanguage) -> some View {
        HStack(alignment: .top, spacing: 8) {
            RoleBadgeView(role: role, size: 24)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    TypingDots()
                    Text(activityTitle(lang)).font(.footnote.weight(.medium)).lineLimit(2)
                    if let since = turnStart {
                        TimelineView(.periodic(from: .now, by: 1)) { ctx in
                            Text(Self.elapsed(since, ctx.date)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        }
                    }
                }
                let tail = state.screenTail
                if !tail.isEmpty {
                    Text(tail.joined(separator: "\n"))
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(4)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
            Spacer(minLength: 24)
        }
    }

    private func activityTitle(_ lang: AppLanguage) -> String {
        if state.termStatus == "starting" { return lang.string("chat.activity.starting") }
        if let doing = state.agent?.watch?.doing?.text, !doing.isEmpty { return lang.format("chat.activity.doing", lang.server(doing)) }
        if let tool = state.entries.last(where: { $0.kind == .tool }), tool.status == "running" {
            return lang.format("chat.activity.doing", [tool.tool ?? tool.text, tool.arg ?? ""].filter { !$0.isEmpty }.joined(separator: " "))
        }
        return lang.string("chat.activity.thinking")
    }

    private var turnStart: Date? {
        guard let s = state.agent?.watch?.turn ?? state.agent?.term?.since else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }

    static func elapsed(_ since: Date, _ now: Date) -> String {
        let s = max(0, Int(now.timeIntervalSince(since)))
        return s < 60 ? "\(s)s" : s < 3600 ? String(format: "%dm %02ds", s / 60, s % 60) : String(format: "%dh %02dm", s / 3600, s % 3600 / 60)
    }

    private func markdown(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }

    private func askCard(_ e: ChatEntry, _ lang: AppLanguage) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(lang.string("chat.ask"), systemImage: "questionmark.bubble.fill")
                .font(.caption.weight(.semibold)).foregroundStyle(.orange)
            Text(lang.server(e.text)).font(.subheadline)
            if e.open && !e.choices.isEmpty {
                FlowButtons(labels: e.choices.map(lang.server)) { i in
                    Task { await store.sendMessage(e.choices[i], to: target, mode: nil) }
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
    }

    private func actCard(_ e: ChatEntry, _ lang: AppLanguage) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label(lang.string("chat.act"), systemImage: "hand.raised.fill")
                    .font(.caption.weight(.semibold)).foregroundStyle(.purple)
                Spacer()
                Pill(text: lang.string("act.status.\(e.status ?? "pending")"), color: Tone.color(e.status == "pending" ? "wait" : e.status))
            }
            Text(lang.server(e.text)).font(.subheadline.weight(.medium))
            if let why = e.arg, !why.isEmpty { Text(lang.server(why)).font(.footnote).foregroundStyle(.secondary) }
            if e.open, let id = e.eventID {
                HStack {
                    Button(lang.string("action.allow")) {
                        Task { await store.act(on: target) { try await $0.decideAct(eventID: id, allow: true) } }
                    }
                    .buttonStyle(.borderedProminent)
                    Button(lang.string("action.deny"), role: .destructive) {
                        Task { await store.act(on: target) { try await $0.decideAct(eventID: id, allow: false) } }
                    }
                    .buttonStyle(.bordered)
                }
                .controlSize(.small)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.purple.opacity(0.07), in: RoundedRectangle(cornerRadius: 12))
    }

    // MARK: Composer

    @ViewBuilder
    private func composer(_ lang: AppLanguage) -> some View {
        VStack(spacing: 8) {
            if let prompt = state.prompt { promptCard(prompt, lang) }
            if state.heldByScreen && !showTerminal { heldCard(lang) }
            ForEach(state.permissions) { perm in permissionCard(perm, lang) }
            if !state.queued.isEmpty { queuedBar(lang) }
            if let notice {
                HStack(alignment: .top) {
                    Text(notice).font(.caption).foregroundStyle(.red)
                    Spacer()
                    Button { self.notice = nil } label: { Image(systemName: "xmark") }
                        .buttonStyle(.borderless).font(.caption)
                }
            }
            if state.isOffline, case .agent(let id) = target, state.agent != nil {
                offlineBar(agentID: id, lang)
            } else {
                if state.isWorking {
                    Picker("", selection: $deliveryMode) {
                        ForEach([DeliveryMode.steer, .queue, .interrupt], id: \.self) { m in
                            Text(TextFormatters.deliveryModeLabel(m, language: lang)).tag(m)
                        }
                    }
                    .pickerStyle(.segmented)
                    if deliveryMode == .steer && !state.permissions.isEmpty {
                        Text(lang.string("chat.permission.warning")).font(.caption2).foregroundStyle(.orange)
                    }
                }
                HStack(alignment: .bottom, spacing: 8) {
                    TextField(placeholder(lang), text: $draft, axis: .vertical)
                        .lineLimit(1...6)
                        .textFieldStyle(.plain)
                        .focused($typing)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 18))
                    Button(action: send) {
                        Image(systemName: "arrow.up.circle.fill").font(.system(size: 30))
                    }
                    .disabled(!canSend)
                    .accessibilityLabel(lang.string("action.send"))
                }
                if state.isWorking {
                    Text(TextFormatters.deliveryModeHint(deliveryMode, language: lang))
                        .font(.caption2).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.bar)
    }

    /// A screen on the terminal Papertown cannot answer for you: typed text would go into it, so sending waits.
    private func heldCard(_ lang: AppLanguage) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(lang.string("chat.held.title"), systemImage: "exclamationmark.bubble.fill")
                .font(.caption.weight(.semibold)).foregroundStyle(.orange)
            Text(lang.string("chat.held.desc")).font(.footnote).foregroundStyle(.secondary)
            let peek = (state.screen ?? "").split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.suffix(5)
            if !peek.isEmpty { MonoBlock(text: peek.joined(separator: "\n"), maxHeight: 90) }
            Button(lang.string("chat.held.open")) { showTerminal = true }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !(state.heldByScreen && !(state.isWorking && deliveryMode == .queue))
    }

    /// What else there is to do with this member: its conversations, the brief, its terminal, how it starts.
    private func moreMenu(_ id: String, _ lang: AppLanguage) -> some View {
        let agent = state.agent
        let hosted = agent?.term != nil
        return Menu {
            if agent?.runtime == "paseo" || target.isAssistant {
                Button { showConversations = true } label: { Label(lang.string("convs.title"), systemImage: "clock.arrow.circlepath") }
            }
            if !target.isAssistant && !hosted && agent?.started == true && (agent?.runtime == "paseo" || agent?.runtime == "pi") {
                Button { Task { await store.act(on: target) { try await $0.newConversation(agentID: id) } } } label: {
                    Label(lang.string("chat.new_conversation"), systemImage: "square.and.pencil")
                }
            }
            if !target.isAssistant && agent?.started == true {
                Button { Task { await store.act(on: target) { try await $0.brief(agentID: id) } } } label: {
                    Label(lang.string("chat.brief"), systemImage: "doc.text")
                }
            }
            if hosted && agent?.term?.status != "exited" {
                Button(role: .destructive) { Task { await store.act(on: target) { try await $0.closeTerminal(agentID: id) } } } label: {
                    Label(lang.string("chat.close_terminal"), systemImage: "xmark.rectangle")
                }
            }
            #if os(macOS)
            if agent?.extID != nil {
                Button { Task { await store.act(on: target) { try await $0.openInPaseo(agentID: id) } } } label: {
                    Label(lang.string("chat.open_paseo"), systemImage: "arrow.up.forward.app")
                }
            }
            #endif
            if store.connectionStatus == .connected && !store.isDemo && (agent?.started != true || state.isOffline) {
                Divider()
                Button { showStart = true } label: { Label(lang.string("chat.start_with"), systemImage: "play.circle") }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel(lang.string("chat.more"))
    }

    private func placeholder(_ lang: AppLanguage) -> String {
        if state.heldByScreen { return lang.string("chat.placeholder.held") }
        if state.isWorking { return TextFormatters.deliveryModePlaceholder(deliveryMode, language: lang) }
        return lang.format("chat.placeholder.idle", title)
    }

    private func offlineBar(agentID: String, _ lang: AppLanguage) -> some View {
        let exited = state.agent?.term?.status == "exited"
        let note = state.agent?.down.map(lang.server) ?? lang.string(exited ? "chat.term_exited" : (target.isAssistant ? "chat.assistant_offline" : "chat.placeholder.offline"))
        return HStack(spacing: 8) {
            Text(note)
                .font(.footnote).foregroundStyle(.secondary)
            Spacer()
            if store.connectionStatus == .connected && !store.isDemo {
                if exited {
                    Button(lang.string("chat.start_with")) { showStart = true }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    Button(lang.string("chat.resume_session")) {
                        Task { await store.act(on: target) { try await $0.startAgent(agentID) } }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                } else {
                    Button(lang.string("chat.start_with")) { showStart = true }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                }
            }
        }
    }

    private func permissionCard(_ perm: PermissionPrompt, _ lang: AppLanguage) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(perm.name == "Bash" ? lang.string("chat.permission.command") : lang.format("chat.permission.tool", perm.name),
                  systemImage: "terminal.fill")
                .font(.caption.weight(.semibold)).foregroundStyle(.orange)
            if let t = perm.title, t != perm.name { Text(lang.server(t)).font(.footnote) }
            if !perm.arg.isEmpty { MonoBlock(text: perm.arg, maxHeight: 90) }
            HStack {
                Button(lang.string("action.allow")) { Task { await permit(perm, true) } }.buttonStyle(.borderedProminent)
                Button(lang.string("action.deny"), role: .destructive) { Task { await permit(perm, false) } }.buttonStyle(.bordered)
            }
            .controlSize(.small)
            .disabled(busy)
        }
        .padding(10)
        .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
    }

    private func permit(_ perm: PermissionPrompt, _ allow: Bool) async {
        guard case .agent(let id) = target else { return }
        busy = true
        await store.act(on: target) { try await $0.respondPermission(agentID: id, requestID: perm.id, allow: allow) }
        busy = false
    }

    private func promptCard(_ prompt: TermPrompt, _ lang: AppLanguage) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(lang.server(prompt.title), systemImage: "rectangle.and.text.magnifyingglass")
                .font(.caption.weight(.semibold)).foregroundStyle(.orange)
            ForEach(Array((prompt.body ?? []).enumerated()), id: \.offset) { _, line in
                Text(lang.server(line)).font(.footnote)
            }
            ForEach(prompt.options) { opt in
                Button {
                    Task {
                        busy = true
                        await store.act(on: target) { client in
                            switch target {
                            case .agent(let id): try await client.answerPrompt(agentID: id, digest: prompt.digest, option: opt.index)
                            case .terminal(let id): try await client.terminalPrompt(id: id, digest: prompt.digest, option: opt.index)
                            }
                        }
                        busy = false
                    }
                } label: {
                    HStack {
                        Text(lang.server(opt.label)).multilineTextAlignment(.leading)
                        Spacer()
                        if opt.current == true { Image(systemName: "chevron.left") }
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
            .disabled(busy)
        }
        .padding(10)
        .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
    }

    private func queuedBar(_ lang: AppLanguage) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(state.queued) { q in
                HStack(spacing: 8) {
                    Pill(text: lang.string("chat.queued"), color: .orange, symbol: "clock")
                    Text(q.text).font(.footnote).lineLimit(2)
                    Spacer()
                    Menu {
                        Button(lang.string("chat.queue.send_now")) {
                            Task { await store.actQueued(target: target, eventID: q.id, action: "now") }
                        }
                        Button(lang.string("chat.queue.withdraw"), role: .destructive) {
                            Task { await store.actQueued(target: target, eventID: q.id, action: "drop") }
                        }
                    } label: { Image(systemName: "ellipsis.circle") }
                }
            }
        }
    }

    /// The draft leaves the box at once and shows as yours while it is on its way; the box stays free for the next one.
    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let mode: DeliveryMode? = state.isWorking ? deliveryMode : nil
        draft = ""
        notice = nil
        Task { await store.sendMessage(text, to: target, mode: mode) }
    }
}

/// Three dots that pulse while an agent works.
private struct TypingDots: View {
    @State private var on = false

    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<3) { i in
                Circle()
                    .frame(width: 5, height: 5)
                    .opacity(on ? 1 : 0.25)
                    .animation(.easeInOut(duration: 0.6).repeatForever().delay(Double(i) * 0.2), value: on)
            }
        }
        .foregroundStyle(.secondary)
        .onAppear { on = true }
    }
}

/// Buttons that wrap onto as many lines as they need: the choices of a question.
struct FlowButtons: View {
    let labels: [String]
    let pick: (Int) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(labels.enumerated()), id: \.offset) { i, label in
                Button(label) { pick(i) }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
        }
    }
}
