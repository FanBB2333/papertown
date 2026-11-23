import PapertownCore
import SwiftUI

/// One conversation: an agent of the town, the assistant, or a terminal the town watches. Messages, tool calls,
/// questions and proposed actions in order; what waits for you (a permission, a dialog on the terminal's screen) above the
/// composer; and for a terminal CLI its live screen with the keys it takes.
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
    @State private var isSending = false
    @State private var sendError: String?
    @State private var pendingUncertainText: String?
    @State private var showUncertainAlert = false
    @State private var showScreen = false
    @State private var busy = false

    private var state: ConversationState { store.conversation(target) }

    private var title: String {
        if case .terminal = target { return state.terminal?.name ?? state.terminal?.title ?? store.language.string("chat.terminal") }
        return TextFormatters.roleName(role, language: store.language)
    }

    var body: some View {
        let lang = store.language
        VStack(spacing: 0) {
            if state.hasScreen {
                Picker("", selection: $showScreen) {
                    Text(lang.string("chat.view.chat")).tag(false)
                    Text(lang.string("chat.view.screen")).tag(true)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
            }
            if showScreen && state.hasScreen {
                screenPane(lang)
            } else {
                messages(lang)
            }
        }
        .background(store.appearance.groupedBackground ?? Color.clear)
        .safeAreaInset(edge: .bottom) { composer(lang) }
        .navigationTitle(title)
        .papertownInlineTitle()
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(title).font(.headline).lineLimit(1)
                    Text(subtitleLine(lang)).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
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
        }
        .onAppear { store.setActiveChat(target) }
        .onDisappear { store.setActiveChat(nil) }
        .refreshable { await store.refreshChat(target) }
        .alert(lang.string("chat.uncertain.title"), isPresented: $showUncertainAlert) {
            Button(lang.string("chat.uncertain.refresh")) {
                Task { await store.refreshChat(target) }
            }
            Button(lang.string("chat.uncertain.resend")) {
                if let text = pendingUncertainText { Task { await send(text) } }
            }
            Button(lang.string("action.cancel"), role: .cancel) {}
        } message: {
            Text(lang.string("chat.uncertain.message"))
        }
    }

    private func subtitleLine(_ lang: AppLanguage) -> String {
        var parts = [subtitle]
        if let model = state.agent?.displayModel { parts.append(model) }
        if let term = state.agent?.term { parts.append(term.backend) }
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    // MARK: Messages

    @ViewBuilder
    private func messages(_ lang: AppLanguage) -> some View {
        if state.isLoading && state.entries.isEmpty {
            Spacer()
            ProgressView()
            Spacer()
        } else if state.entries.isEmpty {
            Spacer()
            EmptyStateView(title: lang.string("chat.empty.title"), systemImage: "bubble.left.and.bubble.right",
                           description: state.error ?? state.transcriptNote.map(lang.server) ?? lang.string("chat.empty.desc"))
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
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                }
                .onChange(of: state.entries.count) { _ in
                    if let last = state.entries.last?.id {
                        withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(last, anchor: .bottom) }
                    }
                }
                .onAppear {
                    if let last = state.entries.last?.id { proxy.scrollTo(last, anchor: .bottom) }
                }
            }
        }
    }

    @ViewBuilder
    private func row(_ e: ChatEntry, _ lang: AppLanguage) -> some View {
        switch e.kind {
        case .user:
            HStack {
                Spacer(minLength: 48)
                Text(e.text)
                    .textSelection(.enabled)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .foregroundStyle(.white)
                    .background(store.appearance.tintColor, in: RoundedRectangle(cornerRadius: 16))
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
                    if let st = e.status { Image(systemName: Tone.symbol(st)).foregroundStyle(Tone.color(st)).imageScale(.small) }
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
                    Task { await send(e.choices[i]) }
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

    // MARK: Screen

    private static let keyRow: [(label: String, key: String)] = [("Enter", "enter"), ("Esc", "esc"), ("↑", "up"), ("↓", "down"),
                                                                ("Tab", "tab"), ("⌃C", "ctrl+c")]

    private func screenPane(_ lang: AppLanguage) -> some View {
        VStack(spacing: 8) {
            ScrollView([.vertical, .horizontal]) {
                Text(state.screen ?? "")
                    .font(.system(size: 11, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
            }
            .background(Color.black.opacity(store.appearance == .dark ? 0.35 : 0.04))
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(Self.keyRow, id: \.key) { k in
                        Button(k.label) { Task { await pressKeys([k.key]) } }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                    }
                }
                .padding(.horizontal, 14)
            }
        }
    }

    private func pressKeys(_ keys: [String]) async {
        await store.act(on: target) { client in
            switch target {
            case .agent(let id): try await client.keys(agentID: id, keys)
            case .terminal(let id): try await client.terminalKeys(id: id, keys)
            }
        }
    }

    // MARK: Composer

    @ViewBuilder
    private func composer(_ lang: AppLanguage) -> some View {
        VStack(spacing: 8) {
            if let prompt = state.prompt { promptCard(prompt, lang) }
            ForEach(state.permissions) { perm in permissionCard(perm, lang) }
            if !state.queued.isEmpty { queuedBar(lang) }
            if let sendError {
                Text(sendError).font(.caption).foregroundStyle(.red).frame(maxWidth: .infinity, alignment: .leading)
            }
            if state.isOffline && !target.isAssistant, case .agent(let id) = target, state.agent != nil {
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
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 18))
                    Button {
                        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !text.isEmpty else { return }
                        Task { await send(text) }
                    } label: {
                        if isSending { ProgressView() } else { Image(systemName: "arrow.up.circle.fill").font(.system(size: 30)) }
                    }
                    .disabled(isSending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
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

    private func placeholder(_ lang: AppLanguage) -> String {
        if state.isWorking { return TextFormatters.deliveryModePlaceholder(deliveryMode, language: lang) }
        return lang.format("chat.placeholder.idle", title)
    }

    private func offlineBar(agentID: String, _ lang: AppLanguage) -> some View {
        HStack {
            Text(state.agent?.down.map(lang.server) ?? lang.string("chat.placeholder.offline"))
                .font(.footnote).foregroundStyle(.secondary)
            Spacer()
            if role != "lead" {
                Button(lang.string("chat.start")) {
                    Task { await store.act(on: target) { try await $0.startAgent(agentID) } }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
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

    private func send(_ text: String) async {
        isSending = true
        sendError = nil
        let mode: DeliveryMode? = state.isWorking ? deliveryMode : nil
        switch await store.sendMessage(text, to: target, mode: mode) {
        case .sent:
            if draft.trimmingCharacters(in: .whitespacesAndNewlines) == text { draft = "" }
        case .uncertainNetworkDrop:
            pendingUncertainText = text
            showUncertainAlert = true
        case .failed(let message):
            sendError = message
        }
        isSending = false
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
