import Foundation
import PapertownCore
import PhotosUI
import SwiftUI
#if os(iOS)
import UIKit
#endif

/// One conversation: an agent of the town, the assistant, or a terminal the town watches. Messages, tool calls,
/// questions and proposed actions in order, then what you sent from here until the conversation shows it, and what the
/// agent is doing now; what waits for you (a permission, a dialog on the terminal's screen) above the composer. A terminal
/// CLI also has its terminal tab: the same conversation as the CLI draws it, with the keys it takes.
struct AgentChatView: View {
    let target: ChatTarget
    let role: String
    let subtitle: String
    var focusEventID: Int? = nil

    init(target: ChatTarget, role: String, subtitle: String) {
        self.target = target
        self.role = role
        self.subtitle = subtitle
    }

    init(agentID: String, role: String, subtitle: String, focusEventID: Int? = nil) {
        self.init(target: .agent(agentID), role: role, subtitle: subtitle)
        self.focusEventID = focusEventID
    }

    /// Opened from the wall of terminals: on the terminal's screen, not the messages.
    init(target: ChatTarget, role: String, subtitle: String, onTerminal: Bool) {
        self.init(target: target, role: role, subtitle: subtitle)
        _showTerminal = State(initialValue: onTerminal)
    }

    @EnvironmentObject private var store: TownStore
    @State private var draft = ""
    @State private var deliveryMode: DeliveryMode = .steer
    @State private var notice: String?
    @State private var showTerminal = false
    /// Typing straight into the terminal: the keyboard goes to it and the composer steps aside.
    @State private var typingInTerminal = false
    @State private var busy = false
    @State private var showConversations = false
    @State private var quoting: ChatEntry?
    @State private var savedQuotes: [Int: String] = [:]
    @State private var showStart = false
    @State private var modelChoice: ModelChoice?
    @State private var files: [OutgoingFile] = []
    @State private var thumbs: [String: CGImage] = [:]
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var pickingPhotos = false
    @State private var pickingFiles = false
    @State private var takingPhoto = false
    @FocusState private var typing: Bool

    /// One height for the input row: the add button, the text box, hiding the keyboard and sending.
    private static let rowHeight: CGFloat = 36

    private struct ModelChoice: Identifiable {
        let model: String
        let thinking: String
        var id: String { model + "@" + thinking }
    }

    private var state: ConversationState { store.conversation(target) }

    /// Who the conversation is with, for the placeholder.
    private var memberName: String {
        if case .terminal = target { return state.terminal?.name ?? state.terminal?.title ?? store.language.string("chat.terminal") }
        return TextFormatters.roleName(role, language: store.language)
    }

    /// The project line the member works on.
    private var lineID: String? {
        guard case .agent(let id) = target, !target.isAssistant else { return nil }
        return state.agent?.lineID ?? id.split(separator: "-", maxSplits: 1).last.map(String.init)
    }

    private var project: ProjectSnapshot? { lineID.flatMap { line in store.projects.first { $0.id == line } } }

    /// The member's project number, as `#6`.
    private var number: String? {
        if let p = project { return "#\(p.seq)" }
        if let n = lineID?.split(separator: "_").last, Int(n) != nil { return "#\(n)" }
        return nil
    }

    /// The conversation's title as its CLI named it, else what the member works on.
    private var conversationTitle: String {
        if let t = state.title, !t.isEmpty { return t }
        if case .terminal = target { return memberName }
        if target.isAssistant { return memberName }
        return state.agent?.task?.title ?? store.language.string("chat.untitled")
    }

    private var title: String { [number, conversationTitle].compactMap { $0 }.joined(separator: " ") }

    var body: some View {
        let lang = store.language
        VStack(spacing: 0) {
            // the assistant's page is its conversation: its terminal is under 后台终端, and the switch shows only
            // once that terminal is on screen, to get back
            if state.hasScreen && (!target.isAssistant || showTerminal) {
                Picker("", selection: $showTerminal) {
                    Text(lang.string("chat.view.chat")).tag(false)
                    Text(lang.string("chat.view.screen")).tag(true)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
            }
            if showTerminal && state.hasScreen {
                TerminalPane(target: target, typing: $typingInTerminal)
            } else {
                messages(lang)
            }
        }
        .background(store.appearance.groupedBackground ?? Color.clear)
        .safeAreaInset(edge: .bottom) {
            if !(showTerminal && typingInTerminal) { composer(lang) }
        }
        .navigationTitle(title)
        .papertownInlineTitle()
        .toolbar {
            ToolbarItem(placement: .principal) { titleView }
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
        }
        .onAppear {
            #if DEBUG
            if UserDefaults.standard.string(forKey: "PTChatTab") == "terminal" { showTerminal = true }
            #endif
            store.chatShowsTerminal = showTerminal
            store.setActiveChat(target)
        }
        .onDisappear { store.leaveChat(target) }
        .papertownHidesTabBar()
        .onChange(of: showTerminal) { on in
            store.chatShowsTerminal = on
            if !on { typingInTerminal = false }
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
        .sheet(item: $quoting) { entry in
            if let lineID {
                WriteDecisionSheet(projectID: lineID, quote: entry) { savedQuotes[$0] = $1 }.papertownSheetFrame(height: 400)
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
        .photosPicker(isPresented: $pickingPhotos, selection: $photoItems, maxSelectionCount: ChatFiles.maxFiles, matching: .images)
        .onChange(of: photoItems) { items in
            guard !items.isEmpty else { return }
            photoItems = []
            Task { await addPhotos(items) }
        }
        .fileImporter(isPresented: $pickingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): addFiles(urls)
            case .failure(let error): notice = error.localizedDescription
            }
        }
        #if os(iOS)
        .fullScreenCover(isPresented: $takingPhoto) {
            CameraPicker { image in
                takingPhoto = false
                if let data = image?.jpegData(compressionQuality: 0.95),
                   let f = ChatFiles.photo(data, name: "photo-\(ChatFiles.stamp())") { add([f]) }
            }
            .ignoresSafeArea()
        }
        #endif
        .alert(item: $modelChoice) { choice in
            Alert(title: Text(lang.format("model.confirm.title", modelName(choice, lang))),
                  message: Text(lang.string("model.confirm.message")),
                  primaryButton: .default(Text(lang.string("model.confirm.switch"))) { Task { await switchModel(choice) } },
                  secondaryButton: .cancel(Text(lang.string("action.cancel"))))
        }
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

    /// Two lines: the conversation's title, and under it the project (number and name), the member's role in its own
    /// colour and the project's stage. The project's name gives way first when the line is short of room. A terminal
    /// shows the folder it works in.
    private var titleView: some View {
        VStack(spacing: 1) {
            Text(conversationTitle).font(.headline).foregroundStyle(.primary).lineLimit(1)
            contextLine
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var contextLine: some View {
        let lang = store.language
        if case .terminal = target {
            if let cwd = state.terminal?.cwd, !cwd.isEmpty {
                Text((cwd as NSString).abbreviatingWithTildeInPath)
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
            }
        } else if !target.isAssistant {
            HStack(spacing: 4) {
                if let number { Text(number).monospacedDigit().fontWeight(.semibold).layoutPriority(2) }
                if let p = project { Text(p.title).lineLimit(1).truncationMode(.tail) }
                Text("·").layoutPriority(2)
                Text(memberName).foregroundStyle(.secondary).lineLimit(1).layoutPriority(2)
                if let p = project, !p.stage.isEmpty {
                    Text("·").layoutPriority(2)
                    Text(TextFormatters.stageName(p.stage, language: lang)).lineLimit(1).layoutPriority(2)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    /// The model the CLI runs and its thinking level.
    private var modelParts: (name: String, thinking: String?)? {
        guard !target.isAssistant else { return nil }
        let cur = models?.current
        let name = cur.flatMap { c in c.model.isEmpty ? nil : (models?.models.first { $0.id == c.model }?.name ?? c.model) }
            ?? state.agent?.displayModel
        guard let name, !name.isEmpty else { return nil }
        let short = name.split(separator: "/").last.map(String.init) ?? name
        let thinking = cur?.thinking.isEmpty == false ? cur?.thinking : nil
        return (short, thinking)
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
                    if focusEventID == nil {
                        withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("end", anchor: .bottom) }
                    }
                }
                .task(id: focusedRow) {
                    if let focusedRow { proxy.scrollTo(focusedRow, anchor: .center) }
                    else { proxy.scrollTo("end", anchor: .bottom) }
                }
            }
        }
    }

    private var focusedRow: String? {
        guard let focusEventID else { return nil }
        return state.entries.first { $0.eventID == focusEventID || $0.id == "e\(focusEventID)" }?.id
    }

    @ViewBuilder
    private func row(_ e: ChatEntry, _ lang: AppLanguage) -> some View {
        switch e.kind {
        case .user:
            let number = e.decided ?? e.deliveredDecision?.number ?? e.eventID.flatMap { savedQuotes[$0] }
            HStack {
                Spacer(minLength: 48)
                VStack(alignment: .trailing, spacing: 3) {
                    AuthoredMessage(entry: e)
                    if let number, let lineID {
                        NavigationLink { DecidedDetailPage(projectID: lineID, recordID: number) } label: {
                            Label(number, systemImage: "square.and.pencil").font(.caption.monospaced())
                        }
                    }
                }
                .contextMenu {
                    if let number { Label(number, systemImage: "checkmark.circle") }
                    else if e.canQuote, let lineID, store.cards[lineID]?.decided != nil {
                        Button { quoting = e } label: { Label(lang.string("decided.quote"), systemImage: "square.and.pencil") }
                    }
                }
            }
        case .assistant:
            HStack(alignment: .top, spacing: 8) {
                RoleBadgeView(role: role, size: 24)
                ChatMarkdown(text: lang.server(e.text))
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
                        if let issue = EmTone.issue(st) { Text(lang.string("job.status.\(st)")).font(.caption2).emState(issue) }
                    }
                }
            }
            .padding(.leading, 32)
        case .error:
            Text(lang.server(e.text)).font(.footnote).emState(.bad, detail: true)
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

    private func userBubble(_ text: String, files: [(image: Bool, name: String)]? = nil, dim: Bool = false) -> some View {
        let split = files == nil ? ChatFiles.split(text) : (text: text, files: files ?? [])
        return VStack(alignment: .trailing, spacing: 6) {
            if !split.text.isEmpty { Text(verbatim: split.text).textSelection(.enabled) }
            if !split.files.isEmpty { AttachmentTags(files: split.files) }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .emBar(.info)
        .foregroundStyle(dim ? .secondary : .primary)
    }

    /// A message sent from here: shown at once, with how far it got and what can be done when it did not get through.
    private func pendingRow(_ p: PendingMessage, _ lang: AppLanguage) -> some View {
        VStack(alignment: .trailing, spacing: 4) {
            HStack {
                Spacer(minLength: 48)
                userBubble(p.text, files: p.files.map { (image: $0.isImage, name: $0.name) }, dim: p.phase != .sent)
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
                    Text(lang.string("chat.pending.uncertain")).emState(.warn, icon: "questionmark.circle", detail: true)
                    Button(lang.string("chat.uncertain.refresh")) { Task { await store.refreshChat(target) } }
                    Button(lang.string("chat.uncertain.resend")) { Task { await store.resendPending(p.id, in: target) } }
                    Button(lang.string("action.delete"), role: .destructive) { store.dropPending(p.id, in: target) }
                case .failed(let why):
                    Text(why).lineLimit(3).emState(.bad, detail: true)
                    Button(lang.string("chat.uncertain.resend")) { Task { await store.resendPending(p.id, in: target) } }
                    Button(lang.string("chat.pending.edit")) {
                        draft = p.text
                        files = []
                        thumbs = [:]
                        add(p.files)
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


    private func askCard(_ e: ChatEntry, _ lang: AppLanguage) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(lang.string("chat.ask"), systemImage: "questionmark.bubble.fill")
                .font(.caption).foregroundStyle(.secondary)
            EmText(lang.server(e.text)).font(.subheadline)
            if e.open && !e.choices.isEmpty {
                FlowButtons(labels: e.choices.map(lang.server)) { i in
                    Task { await store.sendMessage(e.choices[i], to: target, mode: nil) }
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .emBar(e.open ? .warn : nil)
    }

    private func actCard(_ e: ChatEntry, _ lang: AppLanguage) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label(lang.string("chat.act"), systemImage: "hand.raised.fill")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                Text(lang.string("act.status.\(e.status ?? "pending")")).font(.caption).emState(EmTone.issue(e.status))
            }
            Text(lang.server(e.text)).font(.subheadline.weight(.medium))
            if let why = e.arg, !why.isEmpty { EmText(lang.server(why)).font(.footnote).foregroundStyle(.secondary) }
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
        .emBar(e.open ? .warn : nil)
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
                    Text(notice).font(.caption).emState(.bad, detail: true)
                    Spacer()
                    Button { self.notice = nil } label: { Image(systemName: "xmark") }
                        .buttonStyle(.borderless).font(.caption)
                }
            }
            if state.isOffline, case .agent(let id) = target, state.agent != nil {
                offlineBar(agentID: id, lang)
            } else {
                if state.isWorking && deliveryMode == .steer && !state.permissions.isEmpty {
                    Text(lang.string("chat.permission.warning")).font(.caption2).emState(.warn, detail: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                chipsRow(lang)
                if !files.isEmpty {
                    AttachmentStrip(files: files, thumbs: thumbs, remove: { id in
                        files.removeAll { $0.id == id }
                        thumbs[id] = nil
                    }, removeLabel: lang.string("attach.remove"))
                }
                inputRow(lang)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.bar)
    }

    /// The status line above the input, as a terminal's status line shows it: the model and its thinking level (a menu
    /// when it can switch), how a message reaches the agent while it works, how full the context is, what the session
    /// has used, the branch with its changes, and the subscription's windows. One line where it fits, two where it does
    /// not; each part opens its details.
    @ViewBuilder
    private func chipsRow(_ lang: AppLanguage) -> some View {
        let model = modelParts
        if model != nil || state.isWorking || state.context != nil || state.usage != nil || state.git != nil || !state.limits.isEmpty {
            ChipFlow(spacing: 12, lineSpacing: 5) {
                if let model { modelSegment(model, lang) }
                if state.isWorking { deliverySegment(lang) }
                if let c = state.context { contextSegment(c, lang) }
                if let u = state.usage { usageSegment(u, lang) }
                if let g = state.git { gitSegment(g, lang) }
                ForEach(state.limits, id: \.window) { limitSegment($0, lang) }
            }
            .font(.system(size: 11.5, weight: .medium, design: .monospaced))
            .menuStyle(.borderlessButton)
            .padding(.horizontal, 4)
        }
    }

    @ViewBuilder
    private func modelSegment(_ m: (name: String, thinking: String?), _ lang: AppLanguage) -> some View {
        let label = HStack(spacing: 5) {
            Text(m.name).foregroundStyle(.secondary)
            if let t = m.thinking { Text(t).foregroundStyle(.secondary) }
            if canSwitchModel, models != nil {
                Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold)).foregroundStyle(Self.muted)
            }
        }
        .lineLimit(1)
        if canSwitchModel, let ms = models {
            Menu { modelMenu(ms, lang) } label: { label }
                .accessibilityLabel(lang.string("model.menu"))
        } else {
            label
        }
    }

    private func deliverySegment(_ lang: AppLanguage) -> some View {
        Menu {
            ForEach([DeliveryMode.steer, .queue, .interrupt], id: \.self) { m in
                Button { deliveryMode = m } label: {
                    if m == deliveryMode { Image(systemName: "checkmark") }
                    Text(TextFormatters.deliveryModeLabel(m, language: lang))
                    Text(TextFormatters.deliveryModeHint(m, language: lang))
                }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: Self.deliverySymbol(deliveryMode)).font(.system(size: 9, weight: .bold))
                Text(TextFormatters.deliveryModeLabel(deliveryMode, language: lang))
                Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold))
            }
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        .accessibilityLabel(lang.string("chat.delivery"))
    }

    /// ctx, a bar and the percentage where the window is known, then the tokens over the window.
    private func contextSegment(_ c: TranscriptContext, _ lang: AppLanguage) -> some View {
        Menu {
            if let window = c.window {
                Text(lang.format("chat.context.of", Self.tokens(c.used), Self.tokens(window)))
            } else {
                Text(lang.format("chat.context.used", Self.tokens(c.used)))
            }
            Text(lang.string("chat.context.hint"))
        } label: {
            HStack(spacing: 5) {
                Text("ctx").foregroundStyle(Self.muted)
                if let f = c.fraction {
                    CellBar(fraction: f, cells: 8, tint: Self.level(f))
                    Text("\(Int((f * 100).rounded()))%").emNum(EmTone.usage(f))
                }
                Text(c.window.map { "\(Self.tokens(c.used))/\(Self.tokens($0))" } ?? Self.tokens(c.used)).foregroundStyle(Self.muted)
            }
            .lineLimit(1)
        }
        .accessibilityLabel(lang.string("chat.context"))
    }

    /// What the session has used, at API prices where its model has one.
    private func usageSegment(_ u: SessionUsage, _ lang: AppLanguage) -> some View {
        let cost = u.cost < 0.01 ? "<$0.01" : String(format: "$%.2f", u.cost)
        return Menu {
            Text(lang.format("chat.usage.tokens", Self.tokens(u.tokens)))
            if u.priced { Text(lang.format("chat.usage.cost", cost)) }
            Text(lang.string("chat.usage.hint"))
        } label: {
            Text(u.priced ? cost : Self.tokens(u.tokens) + " tok")
                .emNum()
                .lineLimit(1)
        }
        .accessibilityLabel(lang.string("chat.usage"))
    }

    /// The branch, its changed files (*13) and how far it is ahead of (↑) and behind (↓) its upstream.
    private func gitSegment(_ g: GitState, _ lang: AppLanguage) -> some View {
        let folder = state.agent?.cwd ?? state.terminal?.cwd
        return Menu {
            if let folder { Text(folder) }
            if let n = g.changed, n > 0 { Text(lang.format("chat.git.changed", n)) }
            if let n = g.ahead, n > 0 { Text(lang.format("chat.git.ahead", n)) }
            if let n = g.behind, n > 0 { Text(lang.format("chat.git.behind", n)) }
            if let folder {
                Button { Pasteboard.copy(folder) } label: { Label(lang.string("chat.folder.copy"), systemImage: "doc.on.doc") }
            }
            Button { Pasteboard.copy(g.branch) } label: { Label(lang.string("chat.branch.copy"), systemImage: "arrow.triangle.branch") }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "arrow.triangle.branch").font(.system(size: 9, weight: .bold))
                Text(g.branch).truncationMode(.middle)
                if let n = g.changed, n > 0 { Text("*\(n)").emMark(.warn) }
                if let n = g.ahead, n > 0 { Text("↑\(n)").foregroundStyle(Self.muted) }
                if let n = g.behind, n > 0 { Text("↓\(n)").foregroundStyle(Self.muted) }
            }
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        .accessibilityLabel(lang.string("chat.branch"))
    }

    /// A subscription window: its length, a bar, the percentage used and the time until it resets.
    private func limitSegment(_ l: UsageLimit, _ lang: AppLanguage) -> some View {
        let f = l.used / 100
        let left = Self.remaining(l.resetsAt)
        return Menu {
            Text(lang.format("chat.limit", l.window, Int(l.used.rounded())))
            if let left { Text(lang.format("chat.limit.reset", left)) }
        } label: {
            HStack(spacing: 5) {
                Text(l.window).foregroundStyle(Self.muted)
                CellBar(fraction: f, cells: 6, tint: Self.level(f))
                Text("\(Int(l.used.rounded()))%").emNum(EmTone.usage(f))
                if let left { Text(left).emState(.warn, icon: "clock", detail: true) }
            }
            .lineLimit(1)
        }
        .accessibilityLabel(lang.string("chat.limits"))
    }

    /// The status line's quiet parts: plain gray, since a menu's label would tint `.secondary` with the accent.
    private static let muted = Color.gray

    /// Green while there is room, orange past half, red from four fifths.
    private static func level(_ f: Double) -> Color {
        f >= 0.8 ? .red : f >= 0.5 ? .orange : .green
    }

    /// 87772 as 88k, 1297424 as 1.3M.
    private static func tokens(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000 { return "\(Int((Double(n) / 1_000).rounded()))k" }
        return "\(n)"
    }

    /// The time until a reset: 6d19h, 4h32m, 12m.
    private static func remaining(_ iso: String?) -> String? {
        guard let iso, let at = TextFormatters.parseISO8601(iso) else { return nil }
        let s = Int(at.timeIntervalSinceNow)
        guard s > 0 else { return nil }
        let d = s / 86_400, h = s % 86_400 / 3_600, m = s % 3_600 / 60
        if d > 0 { return "\(d)d\(h)h" }
        if h > 0 { return "\(h)h\(m)m" }
        return "\(max(m, 1))m"
    }

    private static func deliverySymbol(_ m: DeliveryMode) -> String {
        switch m {
        case .steer: return "arrow.turn.down.right"
        case .queue: return "clock"
        case .interrupt: return "bolt"
        }
    }

    /// The add button, the text box, hiding the keyboard and sending, all one height.
    private func inputRow(_ lang: AppLanguage) -> some View {
        HStack(alignment: .bottom, spacing: 8) {
            if canAttach { addMenu(lang) }
            TextField(placeholder(lang), text: $draft, axis: .vertical)
                .lineLimit(1...6)
                .textFieldStyle(.plain)
                .focused($typing)
                .padding(.horizontal, 14).padding(.vertical, 7)
                .frame(minHeight: Self.rowHeight)
                .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: Self.rowHeight / 2))
            #if os(iOS)
            if typing {
                Button { typing = false } label: {
                    Image(systemName: "keyboard.chevron.compact.down")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(.secondary)
                        .frame(width: Self.rowHeight, height: Self.rowHeight)
                        .background(Color.secondary.opacity(0.1), in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(lang.string("chat.hide_keyboard"))
            }
            #endif
            Button(action: send) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: Self.rowHeight, height: Self.rowHeight)
                    .background(canSend ? store.appearance.tintColor : Color.secondary.opacity(0.35), in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .accessibilityLabel(lang.string("action.send"))
        }
    }

    /// Photos, the camera, files and a copied image, to go with the message.
    private func addMenu(_ lang: AppLanguage) -> some View {
        Menu {
            Section(lang.string("attach.header")) {
                Button { pickingPhotos = true } label: { Label(lang.string("attach.photos"), systemImage: "photo.on.rectangle") }
                #if os(iOS)
                if UIImagePickerController.isSourceTypeAvailable(.camera) {
                    Button { takingPhoto = true } label: { Label(lang.string("attach.camera"), systemImage: "camera") }
                }
                #endif
                Button { pickingFiles = true } label: { Label(lang.string("attach.files"), systemImage: "folder") }
                #if os(iOS)
                Button { pasteImages() } label: { Label(lang.string("attach.paste"), systemImage: "doc.on.clipboard") }
                    .disabled(!UIPasteboard.general.hasImages)
                #endif
            }
            if state.hasScreen {
                Section {
                    Button { showTerminal.toggle() } label: {
                        Label(lang.string(showTerminal ? "attach.show_chat" : "attach.show_terminal"),
                              systemImage: showTerminal ? "bubble.left.and.bubble.right" : "terminal")
                    }
                }
            }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: Self.rowHeight, height: Self.rowHeight)
                .background(Color.secondary.opacity(0.1), in: Circle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .disabled(files.count >= ChatFiles.maxFiles)
        .accessibilityLabel(lang.string("attach.menu"))
    }

    /// Files go to a member or a terminal of a project; the town's assistant takes text.
    private var canAttach: Bool { !target.isAssistant && !store.isDemo }

    private func add(_ new: [OutgoingFile]) {
        var room = ChatFiles.maxFiles - files.count
        for f in new {
            if f.data.count > ChatFiles.maxBytes {
                notice = store.language.format("attach.too_big", f.name)
                continue
            }
            guard room > 0 else {
                notice = store.language.string("attach.too_many")
                break
            }
            files.append(f)
            room -= 1
            if f.isImage, let t = ChatFiles.thumbnail(f.data) { thumbs[f.id] = t }
        }
    }

    private func addPhotos(_ items: [PhotosPickerItem]) async {
        var out: [OutgoingFile] = []
        for (i, item) in items.enumerated() {
            if let data = try? await item.loadTransferable(type: Data.self),
               let f = ChatFiles.photo(data, name: "photo-\(ChatFiles.stamp())-\(i + 1)") {
                out.append(f)
            } else {
                notice = store.language.string("attach.failed")
            }
        }
        add(out)
    }

    private func addFiles(_ urls: [URL]) {
        var out: [OutgoingFile] = []
        for url in urls {
            do { out.append(try ChatFiles.file(at: url)) } catch { notice = error.localizedDescription }
        }
        add(out)
    }

    #if os(iOS)
    private func pasteImages() {
        let images = UIPasteboard.general.images ?? []
        let out = images.enumerated().compactMap { i, image in
            image.jpegData(compressionQuality: 0.95).flatMap { ChatFiles.photo($0, name: "pasted-\(ChatFiles.stamp())-\(i + 1)") }
        }
        if out.isEmpty { notice = store.language.string("attach.failed") }
        add(out)
    }
    #endif

    /// A screen on the terminal Papertown cannot answer for you: typed text would go into it, so sending waits.
    private func heldCard(_ lang: AppLanguage) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(lang.string("chat.held.title"), systemImage: "exclamationmark.bubble.fill")
                .font(.caption).foregroundStyle(.secondary)
            Text(lang.string("chat.held.desc")).font(.footnote).foregroundStyle(.secondary)
            let peek = (state.screen ?? "").split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.suffix(5)
            if !peek.isEmpty { MonoBlock(text: peek.joined(separator: "\n"), maxHeight: 90) }
            Button(lang.string("chat.held.open")) { showTerminal = true }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .emBar(.warn)
    }

    private var canSend: Bool {
        (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !files.isEmpty)
            && !(state.heldByScreen && !(state.isWorking && deliveryMode == .queue))
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
        return lang.format("chat.placeholder.idle", memberName)
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
                .font(.caption).foregroundStyle(.secondary)
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
        .emBar(.warn)
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
                .font(.caption).foregroundStyle(.secondary)
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
        .emBar(.warn)
    }

    private func queuedBar(_ lang: AppLanguage) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(state.queued) { q in
                HStack(spacing: 8) {
                    Text(lang.string("chat.queued")).font(.caption).foregroundStyle(.secondary)
                    Text(q.text).font(.footnote).lineLimit(2).emBar(q.authored ? .info : nil)
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
        guard canSend else { return }
        let mode: DeliveryMode? = state.isWorking ? deliveryMode : nil
        let sending = files
        draft = ""
        files = []
        thumbs = [:]
        notice = nil
        Task { await store.sendMessage(text, files: sending, to: target, mode: mode) }
    }
}

/// Keep delivery context and attachment names outside the user's own words.
struct AuthoredMessage: View {
    let entry: ChatEntry

    var body: some View {
        let split = ChatFiles.split(entry.text)
        let words = ChatEntry.authoredWords(split.text, userText: entry.userText, origin: entry.origin)
        let original = words ?? split.text
        VStack(alignment: .leading, spacing: 4) {
            if !original.isEmpty { Text(verbatim: original).emBar(words == nil ? nil : .info) }
            if entry.userText != nil && split.text != original {
                let context = original.isEmpty ? split.text : split.text.range(of: original).map { split.text.replacingCharacters(in: $0, with: "") } ?? split.text
                let rest = context.trimmingCharacters(in: .whitespacesAndNewlines)
                if !rest.isEmpty { Text(verbatim: rest).font(.caption).foregroundStyle(.secondary) }
            }
            if !split.files.isEmpty { AttachmentTags(files: split.files) }
        }
        .textSelection(.enabled)
        .padding(.horizontal, 12).padding(.vertical, 8)
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

/// A bar of small cells that fill as a share does, like a terminal status line's.
private struct CellBar: View {
    let fraction: Double
    let cells: Int
    let tint: Color

    var body: some View {
        let on = fraction <= 0 ? 0 : min(cells, max(1, Int((fraction * Double(cells)).rounded())))
        HStack(spacing: 1.5) {
            ForEach(0..<cells, id: \.self) { i in
                RoundedRectangle(cornerRadius: 1)
                    .fill(i < on ? tint : Color.secondary.opacity(0.25))
                    .frame(width: 3.5, height: 8)
            }
        }
        .accessibilityHidden(true)
    }
}

/// Chips laid out left to right, wrapping to a new line when the next one does not fit.
struct ChipFlow: Layout {
    var spacing: CGFloat = 6
    var lineSpacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width {
                y += line + lineSpacing
                x = 0
                line = 0
            }
            x += size.width + spacing
            line = max(line, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: proposal.width ?? widest, height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX {
                y += line + lineSpacing
                x = bounds.minX
                line = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(width: min(size.width, bounds.width), height: size.height))
            x += size.width + spacing
            line = max(line, size.height)
        }
    }
}
