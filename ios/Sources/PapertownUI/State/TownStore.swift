import Foundation
import PapertownCore
import Combine
import SwiftUI

public enum ConnectionStatus: Equatable, Sendable {
    case disconnected
    case connecting
    case connected
    case reconnecting
    case authRequired(expired: Bool)
}

public enum InboxItemKind: Equatable, Sendable {
    case ask(ReportItem)
    case permission(agentID: String, role: String, prompt: PermissionPrompt)
    case blockedLead(ProjectSnapshot)
}

public struct InboxItem: Identifiable, Equatable, Sendable {
    public let id: String
    public let projectID: String?
    public let projectSeq: Int?
    public let projectTitle: String
    public let agentID: String?
    public let timestamp: String?
    public let kind: InboxItemKind
}

enum TownStoreError: Error { case notPapertown }

@MainActor
public final class TownStore: ObservableObject {
    public enum Tab: Hashable {
        case inbox, projects, staff, town, server
    }

    // Navigation & Preferences
    @Published public var selectedTab: Tab = .inbox
    /// Every event from the server, for the pages that reload on their own events. Not @Published: an event redraws
    /// only the pages that listen.
    public let events = PassthroughSubject<(name: String, payload: [String: JSONValue]), Never>()
    /// What is open in Projects and in the Inbox: kept here so a change of frame (tabs, sidebar) keeps it.
    /// Type-erased on purpose: the pages also push views of their own (NavigationLink with a destination), and in a
    /// split view's detail column SwiftUI compares the stack with the bound path; a typed array there ends in
    /// AnyNavigationPath.Error.comparisonTypeMismatch, a crash.
    @Published var projectsPath = NavigationPath()
    @Published var inboxPath = NavigationPath()
    /// Set by the sidebar's 新建 Idea: Projects opens its sheet when it sees it.
    @Published var newProjectRequested = false
    /// The project whose page is open in Projects, for the sidebar to mark among the recent ones.
    @Published var currentProjectID: String?
    /// Projects opened lately, per server, newest first (Sidebar.swift).
    @Published var recentByServer: [String: [String]] = UserDefaults.standard.dictionary(forKey: TownStore.recentKey) as? [String: [String]] ?? [:]
    static let recentKey = "PTRecentProjects"
    @Published public var language: AppLanguage
    @Published public var appearance: AppAppearance

    // Servers & Auth
    @Published public var profiles: [ServerProfile] = []
    @Published public var selectedProfileID: UUID?
    @Published public var connectionStatus: ConnectionStatus = .disconnected
    @Published public var authState: AuthState?
    @Published public var lastError: String?
    @Published public var showConnectSheet = false
    @Published public var editingProfile: ServerProfile?
    @Published public var showLoginSheet = false
    @Published public var loginExpired = false

    // Domain Data
    @Published public var projects: [ProjectSnapshot] = []
    @Published public var overview: StaffOverview?
    @Published public var openAsks: [ReportItem] = []
    @Published public var assistantAgent: StaffAgent?
    @Published public var assistant: AssistantSnapshot?
    @Published public var hud: HudInfo?
    /// Each project's progress card, by project id.
    @Published public var cards: [String: ProjectCardView] = [:]
    @Published public var isRefreshing = false

    // Conversations keyed by ChatTarget.key
    @Published public var conversations: [String: ConversationState] = [:]

    /// The connected server is the bundled offline demo.
    public var isDemo: Bool { currentProfile?.isDemo == true && client != nil }

    private let profileStore: ProfileStore
    private var client: PapertownClient?
    private var sseTask: Task<Void, Never>?
    private var refreshDebounceTask: Task<Void, Never>?
    private var activeChat: ChatTarget?

    public init(profileStore: ProfileStore = ProfileStore()) {
        self.profileStore = profileStore
        self.language = profileStore.loadLanguage()
        self.appearance = profileStore.loadAppearance()
        self.profiles = profileStore.loadProfiles()
        self.selectedProfileID = profileStore.loadSelectedID() ?? self.profiles.first?.id
    }

    public var currentProfile: ServerProfile? {
        guard let selectedProfileID else { return profiles.first }
        return profiles.first(where: { $0.id == selectedProfileID }) ?? profiles.first
    }

    public var inboxItems: [InboxItem] {
        var items: [InboxItem] = []
        let projectByID = Dictionary(uniqueKeysWithValues: projects.map { ($0.id, $0) })

        // 1. Pending permission prompts from overview
        if let overview {
            for group in overview.groups {
                for agent in group.agents {
                    for perm in agent.watch?.permissions ?? [] {
                        let proj = group.line.flatMap { projectByID[$0.id] }
                        items.append(InboxItem(
                            id: "perm:\(agent.id):\(perm.id)",
                            projectID: group.line?.id,
                            projectSeq: group.line?.seq ?? proj?.seq,
                            projectTitle: group.line?.title ?? proj?.title ?? TextFormatters.roleName(agent.role, language: language),
                            agentID: agent.id,
                            timestamp: agent.watch?.since ?? agent.updatedAt,
                            kind: .permission(agentID: agent.id, role: agent.role, prompt: perm)
                        ))
                    }
                }
            }
        }

        // 2. Open asks from reports
        for ask in openAsks where ask.data.open != false {
            let proj = projectByID[ask.lineID]
            items.append(InboxItem(
                id: "ask:\(ask.id)",
                projectID: ask.lineID,
                projectSeq: proj?.seq,
                projectTitle: proj?.title ?? ask.lineID,
                agentID: ask.agentID ?? proj?.leadAgentID,
                timestamp: ask.ts,
                kind: .ask(ask)
            ))
        }

        // 3. Blocked resident leads
        for proj in projects where proj.lead.state == "blocked" {
            items.append(InboxItem(
                id: "blocked:\(proj.id)",
                projectID: proj.id,
                projectSeq: proj.seq,
                projectTitle: proj.title,
                agentID: proj.leadAgentID,
                timestamp: proj.updatedAt,
                kind: .blockedLead(proj)
            ))
        }

        return items
    }

    public var allStaffAgents: [(project: ProjectRefInfo?, agent: StaffAgent)] {
        if let overview {
            return overview.groups.flatMap { group in
                group.agents.map { (group.line, $0) }
            }
        }
        // Fallback synthesized from projects if overview endpoint is unavailable
        return projects.flatMap { proj in
            let ref = ProjectRefInfo(id: proj.id, seq: proj.seq, title: proj.title, status: proj.status, stage: proj.stage)
            return proj.team.map { member in
                (ref, StaffAgent(
                    id: member.id,
                    lineID: proj.id,
                    role: member.role,
                    status: member.status,
                    name: member.name,
                    model: member.model,
                    runtime: member.runtime,
                    updatedAt: proj.updatedAt,
                    down: nil,
                    last: nil,
                    watch: nil,
                    task: nil
                ))
            }
        }
    }

    // MARK: - Preferences

    public func setLanguage(_ newLanguage: AppLanguage) {
        language = newLanguage
        profileStore.saveLanguage(newLanguage)
    }

    public func setAppearance(_ newAppearance: AppAppearance) {
        appearance = newAppearance
        profileStore.saveAppearance(newAppearance)
    }

    // MARK: - Lifecycle

    public func onAppLaunch() async {
        #if DEBUG
        // -PTDemo opens the offline demo, -PTTab town|projects|staff|inbox|server picks a tab, -PTLanguage en|zh-Hans
        // picks the language: for screenshots in the simulator.
        let args = UserDefaults.standard
        if let code = args.string(forKey: "PTLanguage"), let lang = AppLanguage(rawValue: code) { language = lang }
        if let tab = args.string(forKey: "PTTab") {
            selectedTab = ["projects": .projects, "staff": .staff, "town": .town, "server": .server][tab] ?? .inbox
        }
        if args.bool(forKey: "PTDemo") {
            await openDemo(persist: false)
            return
        }
        // -PTConnect <address> [-PTKey <access key>]: connects for a test run, saving neither the server nor the key.
        // With -PTSave YES (and -PTName <name>) it is saved like a server added by hand, the key in the Keychain:
        // for setting up a device from the Mac.
        if let address = args.string(forKey: "PTConnect") {
            let key = args.string(forKey: "PTKey")
            let profile = ServerProfile(name: args.string(forKey: "PTName") ?? address, addressString: address, usesAccessKey: key != nil)
            showConnectSheet = false
            if args.bool(forKey: "PTSave") {
                await upsertProfile(profile, password: nil, accessKey: key)
            } else {
                profiles.append(profile)
                await connect(to: profile, accessKey: key)
            }
            return
        }
        #endif
        guard let profile = currentProfile else {
            showConnectSheet = true
            return
        }
        await connect(to: profile, allowBiometricAutoLogin: true)
    }

    public func handleScenePhase(_ phase: ScenePhase) {
        switch phase {
        case .active:
            if client != nil && sseTask == nil && connectionStatus != .authRequired(expired: false) && connectionStatus != .authRequired(expired: true) {
                startEventStream()
            }
        case .background:
            stopEventStream()
        case .inactive:
            // on the Mac a window in the background stays live: the Dock badge and the Inbox keep up
            #if !os(macOS)
            stopEventStream()
            #endif
        @unknown default:
            break
        }
    }

    // MARK: - Server Profiles & Connection

    /// Saves a server. `accessKey`: a new key for it (nil keeps the saved one); with `usesAccessKey` off, a saved key
    /// is deleted.
    public func upsertProfile(_ profile: ServerProfile, password: String?, accessKey: String? = nil, connectNow: Bool = true) async {
        if let idx = profiles.firstIndex(where: { $0.id == profile.id }) {
            profiles[idx] = profile
        } else {
            profiles.append(profile)
        }
        profileStore.saveProfiles(profiles)

        if profile.useBiometrics, let password, !password.isEmpty {
            KeychainStore.save(password: password, for: profile.id)
        } else if !profile.useBiometrics {
            KeychainStore.delete(for: profile.id)
        }
        if !profile.usesAccessKey {
            KeychainStore.deleteAccessKey(for: profile.id)
        } else if let accessKey, !accessKey.isEmpty {
            KeychainStore.save(accessKey: accessKey, for: profile.id)
        }

        if connectNow {
            await connect(to: profile, explicitPassword: password, accessKey: accessKey, allowBiometricAutoLogin: false)
        }
    }

    public func deleteProfiles(at offsets: IndexSet) {
        let removedIDs = offsets.map { profiles[$0].id }
        for id in removedIDs {
            KeychainStore.delete(for: id)
            KeychainStore.deleteAccessKey(for: id)
        }
        profiles.remove(atOffsets: offsets)
        profileStore.saveProfiles(profiles)

        if let selectedProfileID, removedIDs.contains(selectedProfileID) {
            disconnect()
            self.selectedProfileID = profiles.first?.id
            profileStore.saveSelectedID(self.selectedProfileID)
            if let next = currentProfile {
                Task { await connect(to: next, allowBiometricAutoLogin: true) }
            }
        }
    }

    public func selectProfile(_ profile: ServerProfile) async {
        guard profile.id != selectedProfileID || client == nil else { return }
        await connect(to: profile, allowBiometricAutoLogin: true)
    }

    public func connect(
        to profile: ServerProfile,
        explicitPassword: String? = nil,
        accessKey explicitKey: String? = nil,
        allowBiometricAutoLogin: Bool = false
    ) async {
        stopEventStream()
        selectedProfileID = profile.id
        profileStore.saveSelectedID(profile.id)
        lastError = nil
        connectionStatus = .connecting

        guard let url = profile.url else {
            connectionStatus = .disconnected
            lastError = TextFormatters.errorMessage(for: ClientError.invalidAddress, language: language)
            return
        }

        let key = profile.usesAccessKey ? (explicitKey?.isEmpty == false ? explicitKey : KeychainStore.loadAccessKey(for: profile.id)) : nil
        do {
            let newClient = profile.isDemo
                ? try PapertownClient(address: url, protocolClasses: [DemoServer.self])
                : try PapertownClient(address: url, accessKey: key)
            client = newClient
            clearTownData()

            if !profile.isDemo {
                // a clear message for an address that is not a Papertown server, before any sign-in
                let health: ServerHealth
                do { health = try await newClient.health() } catch ClientError.http, DecodingError.dataCorrupted, DecodingError.keyNotFound, DecodingError.typeMismatch {
                    throw TownStoreError.notPapertown
                }
                if !health.ok || (health.app != nil && health.app != "papertown") { throw TownStoreError.notPapertown }
            }

            let state = try await newClient.authState()
            authState = state

            if !state.authed {
                if let explicitPassword, !explicitPassword.isEmpty {
                    try await newClient.login(password: explicitPassword)
                    authState = try await newClient.authState()
                } else if allowBiometricAutoLogin, profile.useBiometrics, let saved = KeychainStore.load(for: profile.id) {
                    let ok = await KeychainStore.authenticateWithBiometrics(
                        reason: language.string("connect.face_id")
                    )
                    if ok {
                        try await newClient.login(password: saved)
                        authState = try await newClient.authState()
                    }
                }
            }

            if authState?.authed == true {
                showLoginSheet = false
                loginExpired = false
                await refreshAll()
                startEventStream()
            } else if key != nil {
                keyRejected()
            } else {
                connectionStatus = .authRequired(expired: false)
                loginExpired = false
                showLoginSheet = true
            }
        } catch TownStoreError.notPapertown {
            connectionStatus = .disconnected
            lastError = language.string("error.not_papertown")
        } catch {
            if isUnauthorized(error), key != nil {
                keyRejected()
            } else if isUnauthorized(error) {
                connectionStatus = .authRequired(expired: false)
                loginExpired = false
                showLoginSheet = true
            } else {
                connectionStatus = .disconnected
                lastError = TextFormatters.errorMessage(for: error, language: language)
            }
        }
    }

    public func login(password: String) async throws {
        guard let client else { throw ClientError.invalidAddress }
        try await client.login(password: password)
        if let profile = currentProfile, profile.useBiometrics {
            KeychainStore.save(password: password, for: profile.id)
        }
        authState = try await client.authState()
        showLoginSheet = false
        loginExpired = false
        lastError = nil
        await refreshAll()
        startEventStream()
    }

    public func signOut() async {
        stopEventStream()
        if let client {
            try? await client.logout()
        }
        authState = try? await client?.authState()
        clearTownData()
        connectionStatus = .authRequired(expired: false)
        loginExpired = false
        showLoginSheet = true
    }

    public func disconnect() {
        stopEventStream()
        client = nil
        authState = nil
        clearTownData()
        connectionStatus = .disconnected
    }

    private func clearTownData() {
        projects = []
        overview = nil
        openAsks = []
        assistant = nil
        assistantAgent = nil
        hud = nil
        cards = [:]
        conversations = [:]
    }

    /// Adds the offline demo to the saved servers and connects to it.
    public func openDemo(persist: Bool = true) async {
        let profile = profiles.first(where: \.isDemo) ?? ServerProfile.demo(name: language.string("demo.name"))
        if !profiles.contains(where: { $0.id == profile.id }) {
            guard persist else {
                // shown without being saved: previews and screenshot runs
                profiles.append(profile)
                showConnectSheet = false
                await connect(to: profile)
                return
            }
            profiles.append(profile)
            profileStore.saveProfiles(profiles)
        }
        showConnectSheet = false
        await connect(to: profile)
    }

    /// Runs one request against the connected server. A 401 brings up sign-in; other errors are thrown for the page to show.
    public func fetch<T>(_ op: (PapertownClient) async throws -> T) async throws -> T {
        guard let client else { throw ClientError.invalidAddress }
        do {
            return try await op(client)
        } catch {
            if isUnauthorized(error) { handleError(error) }
            throw error
        }
    }

    /// The message to show for an error, in the app's language.
    public func message(for error: Error) -> String {
        if case ClientError.http(_, let detail?) = error, !detail.isEmpty { return language.server(detail) }
        return TextFormatters.errorMessage(for: error, language: language)
    }

    // MARK: - Data Refresh & SSE

    public func refreshAll() async {
        guard let client else { return }
        isRefreshing = true
        defer { isRefreshing = false }

        do {
            let loadedProjects = try await client.projectSnapshots()
            projects = loadedProjects
            lastError = nil

            async let ovTask: StaffOverview? = try? await client.staffOverview()
            async let repTask: ReportsResponse? = try? await client.reports()
            async let asstTask: AssistantSnapshot? = try? await client.assistantSnapshot()
            async let worldTask: WorldSnapshot? = try? await client.world()
            async let cardsTask: CardsResponse? = try? await client.cards()

            overview = await ovTask
            openAsks = (await repTask)?.asks ?? []
            assistant = await asstTask
            assistantAgent = assistant?.agent
            hud = (await worldTask)?.hud
            if let list = (await cardsTask)?.cards {
                cards = Dictionary(list.map { ($0.line.id, $0) }, uniquingKeysWith: { a, _ in a })
            }

            if let activeChat {
                await refreshChat(activeChat)
            }
        } catch {
            handleError(error)
        }
    }

    public func refreshProject(id: String) async {
        guard let client else { return }
        do {
            let updated = try await client.projectSnapshot(id: id)
            if let idx = projects.firstIndex(where: { $0.id == id }) {
                projects[idx] = updated
            } else {
                projects.insert(updated, at: 0)
            }
        } catch {
            handleError(error)
        }
    }

    private func startEventStream() {
        stopEventStream()
        guard let client else { return }
        let onUpdate: @Sendable (FeedUpdate) async -> Void = { [weak self] update in
            await self?.handleFeedUpdate(update)
        }
        sseTask = Task { @MainActor [weak self] in
            do {
                try await client.followEvents(onUpdate)
            } catch is CancellationError {
                // Normal lifecycle cancellation.
            } catch {
                self?.handleStreamTermination(error)
            }
        }
    }

    private func stopEventStream() {
        sseTask?.cancel()
        sseTask = nil
        refreshDebounceTask?.cancel()
        refreshDebounceTask = nil
    }

    private var chatDebounceTask: Task<Void, Never>?

    private func scheduleChatRefresh(_ target: ChatTarget) {
        chatDebounceTask?.cancel()
        chatDebounceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled else { return }
            await self?.refreshChat(target)
        }
    }

    private func handleFeedUpdate(_ update: FeedUpdate) {
        switch update {
        case .connected:
            connectionStatus = .connected
            lastError = nil
            scheduleSnapshotRefresh(delayNanoseconds: 0)
        case .reconnecting:
            connectionStatus = .reconnecting
        case .event(let name, let payload):
            events.send((name, payload))
            if ["line", "agent", "report", "card", "checks", "job", "terminal", "usage"].contains(name) {
                scheduleSnapshotRefresh(delayNanoseconds: 400_000_000)
            }
            guard let activeChat else { return }
            let about = payload["agent_id"]?.stringValue
                ?? payload["event"]?.field("agent_id")?.stringValue
                ?? payload["agent"]?.field("id")?.stringValue
                ?? payload["terminal"]?.field("id")?.stringValue
            switch (name, activeChat) {
            case ("agent_event", .agent(let id)), ("agent", .agent(let id)), ("agent_live", .agent(let id)):
                if about == nil || about == id { scheduleChatRefresh(activeChat) }
            case ("terminal", .terminal(let id)):
                if about == nil || about == id { scheduleChatRefresh(activeChat) }
            default: break
            }
        }
    }

    private func scheduleSnapshotRefresh(delayNanoseconds: UInt64) {
        refreshDebounceTask?.cancel()
        refreshDebounceTask = Task { [weak self] in
            if delayNanoseconds > 0 {
                try? await Task.sleep(nanoseconds: delayNanoseconds)
            }
            guard !Task.isCancelled else { return }
            await self?.refreshAll()
        }
    }

    /// A key the server does not know (revoked, or copied wrong): the password sheet would not help, so the connection
    /// stops with a message, and the live feed stays off until the key is changed.
    private func keyRejected() {
        stopEventStream()
        client = nil
        connectionStatus = .disconnected
        lastError = language.string("error.key_rejected")
    }

    private func handleStreamTermination(_ error: Error) {
        if isUnauthorized(error), client?.accessKey != nil {
            keyRejected()
        } else if isUnauthorized(error) {
            stopEventStream()
            connectionStatus = .authRequired(expired: true)
            loginExpired = true
            showLoginSheet = true
        } else {
            connectionStatus = .disconnected
            lastError = TextFormatters.errorMessage(for: error, language: language)
        }
    }

    // MARK: - Domain Mutations

    public func toggleLead(projectID: String, on: Bool) async {
        guard let client else { return }
        do {
            try await client.setLead(projectID: projectID, on: on)
            await refreshProject(id: projectID)
        } catch {
            handleError(error)
        }
    }

    public func createIdea(_ text: String) async throws -> ProjectSnapshot {
        guard let client else { throw ClientError.invalidAddress }
        let created = try await client.createIdea(text)
        await refreshAll()
        return created
    }

    public func respondPermission(agentID: String, requestID: String, allow: Bool) async {
        guard let client else { return }
        do {
            try await client.respondPermission(agentID: agentID, requestID: requestID, allow: allow)
            await refreshAll()
        } catch {
            handleError(error)
        }
    }

    public func answerAsk(reportID: Int, text: String) async {
        guard let client else { return }
        do {
            try await client.answerReport(id: reportID, text: text)
            await refreshAll()
        } catch {
            handleError(error)
        }
    }

    // MARK: - Chat Operations

    public func setActiveChat(_ target: ChatTarget?) {
        activeChat = target
        guard let target else { return }
        Task {
            await refreshChat(target)
            await markSeen(target)
        }
    }

    private func markSeen(_ target: ChatTarget) async {
        guard let client, !isDemo else { return }
        switch target {
        case .agent(let id): try? await client.markSeen(agentID: id)
        case .terminal(let id): try? await client.terminalSeen(id: id)
        }
    }

    public func conversation(_ target: ChatTarget) -> ConversationState {
        conversations[target.key] ?? ConversationState()
    }

    /// Reads a conversation again: pi agents incrementally from their events, Paseo and terminal agents from their
    /// timeline (and screen), watched terminals from theirs.
    public func refreshChat(_ target: ChatTarget) async {
        guard let client else { return }
        var state = conversations[target.key] ?? ConversationState()
        if state.entries.isEmpty && state.agent == nil && state.terminal == nil {
            state.isLoading = true
            conversations[target.key] = state
        }
        do {
            switch target {
            case .agent(let id):
                if state.agent?.usesTimeline != true {
                    let read = try await client.agentEvents(agentID: id, after: state.lastEventID)
                    state.agent = read.agent
                    if !read.agent.usesTimeline { state.merge(read.events) }
                }
                if state.agent?.usesTimeline == true {
                    let tl = try await client.timeline(agentID: id)
                    state.agent = tl.agent
                    var entries = ConversationState.entries(from: tl.items)
                    // an agent's asks and acts live in its events even when its words are in a transcript
                    if target.isAssistant {
                        let extra = ((assistant?.asks ?? []) + (assistant?.acts ?? [])).sorted { $0.id < $1.id }
                        entries += ConversationState.entries(from: extra)
                    }
                    state.entries = entries
                    state.queued = (tl.queued ?? []).map { QueuedMessage(id: $0.id, text: $0.data.field("text")?.stringValue ?? "") }
                    state.permissions = tl.agent.watch?.permissions ?? tl.paseo?.permissions ?? []
                    state.transcriptNote = tl.transcript?.ok == false ? tl.transcript?.note : nil
                    if tl.agent.term != nil {
                        let screen = try? await client.screen(agentID: id)
                        state.screen = screen?.text
                        state.prompt = screen?.prompt
                    }
                } else {
                    state.permissions = state.agent?.watch?.permissions ?? []
                }
            case .terminal(let id):
                async let detail = client.terminal(id: id)
                async let tl = try? client.terminalTimeline(id: id)
                let d = try await detail
                state.terminal = d.terminal
                state.screen = d.text
                state.prompt = d.prompt
                state.queued = (d.queued ?? []).filter { $0.state == "queued" }.map { QueuedMessage(id: $0.id, text: $0.text) }
                state.permissions = d.terminal.watch?.permissions ?? []
                if let t = await tl {
                    state.entries = ConversationState.entries(from: t.items)
                    state.transcriptNote = t.transcript?.ok == false ? t.transcript?.note : nil
                }
            }
            state.isLoading = false
            state.error = nil
        } catch {
            state.isLoading = false
            state.error = message(for: error)
            if isUnauthorized(error) { handleError(error) }
        }
        conversations[target.key] = state
    }

    public enum SendOutcome {
        case sent
        case uncertainNetworkDrop
        case failed(String)
    }

    public func sendMessage(_ text: String, to target: ChatTarget, mode: DeliveryMode?) async -> SendOutcome {
        guard let client else { return .failed(message(for: ClientError.invalidAddress)) }
        do {
            switch target {
            case .agent(let id) where target.isAssistant && mode == nil:
                try await client.assistantSay(text)
                _ = id
            case .agent(let id):
                try await client.say(text, to: id, mode: mode)
            case .terminal(let id):
                try await client.terminalSay(text, to: id, mode: mode)
            }
            await refreshChat(target)
            await markSeen(target)
            return .sent
        } catch let urlError as URLError where [.networkConnectionLost, .timedOut].contains(urlError.code) {
            return .uncertainNetworkDrop
        } catch {
            if isUnauthorized(error) { handleError(error) }
            return .failed(message(for: error))
        }
    }

    /// Runs an action on a conversation (stop, queue, keys, prompt answers) and reads it again.
    public func act(on target: ChatTarget, _ op: (PapertownClient) async throws -> Void) async {
        do {
            try await fetch(op)
            if target.isAssistant { assistant = try? await client?.assistantSnapshot() }
            await refreshChat(target)
        } catch {
            lastError = message(for: error)
        }
    }

    public func abortAgent(_ agentID: String) async {
        await act(on: .agent(agentID)) { try await $0.abortAgent(agentID) }
    }

    public func actQueued(target: ChatTarget, eventID: Int, action: String) async {
        await act(on: target) { client in
            switch target {
            case .agent(let id): try await client.actQueuedMessage(agentID: id, eventID: eventID, action: action)
            case .terminal(let id): try await client.terminalQueue(id: id, queueID: eventID, action: action)
            }
        }
    }

    // MARK: - Helpers

    private func isUnauthorized(_ error: Error) -> Bool {
        if case ClientError.http(let status, _) = error, status == 401 {
            return true
        }
        return false
    }

    private func handleError(_ error: Error) {
        if isUnauthorized(error), client?.accessKey != nil {
            keyRejected()
        } else if isUnauthorized(error) {
            stopEventStream()
            connectionStatus = .authRequired(expired: true)
            loginExpired = true
            showLoginSheet = true
        } else {
            lastError = message(for: error)
        }
    }
}
