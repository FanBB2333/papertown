import PapertownCore
import SwiftUI

struct ServerView: View {
    @EnvironmentObject private var store: TownStore
    @State private var showSignOutConfirm = false

    var body: some View {
        let lang = store.language
        NavigationStack {
            List {
                if store.isDemo {
                    Section {
                        Label(lang.string("demo.banner"), systemImage: "sparkles.rectangle.stack")
                            .font(.footnote)
                        Button(lang.string("server.add")) {
                            store.editingProfile = nil
                            store.showConnectSheet = true
                        }
                    }
                    .papertownRowBackground(store.appearance)
                }
                if let profile = store.currentProfile {
                    Section {
                        LabeledContent(lang.string("server.live_feed")) {
                            HStack(spacing: 6) {
                                Circle()
                                    .fill(statusColor)
                                    .frame(width: 8, height: 8)
                                Text(statusText(lang: lang))
                                    .foregroundStyle(statusColor)
                            }
                        }
                        .papertownRowBackground(store.appearance)

                        LabeledContent(lang.string("server.route")) {
                            Text(routeText(for: profile, lang: lang))
                        }
                        .papertownRowBackground(store.appearance)

                        LabeledContent(lang.string("server.session")) {
                            Text(sessionText(lang: lang))
                        }
                        .papertownRowBackground(store.appearance)

                        LabeledContent(lang.string("server.address")) {
                            Text(profile.displayHost)
                                .font(.footnote.monospaced())
                                .lineLimit(1)
                        }
                        .papertownRowBackground(store.appearance)
                    } header: {
                        Text(lang.string("server.section.current"))
                    } footer: {
                        #if os(macOS)
                        Text(lang.string("server.current.footer.mac"))
                        #else
                        Text(lang.string("server.current.footer"))
                        #endif
                    }
                }

                #if os(macOS)
                LocalServerSection()
                    .papertownRowBackground(store.appearance)
                #endif

                Section(lang.string("server.section.saved")) {
                    if store.profiles.isEmpty {
                        Button {
                            store.editingProfile = nil
                            store.showConnectSheet = true
                        } label: {
                            Label(lang.string("server.add"), systemImage: "plus")
                        }
                        .papertownRowBackground(store.appearance)
                    } else {
                        ForEach(store.profiles) { profile in
                            Button {
                                Task { await store.selectProfile(profile) }
                            } label: {
                                HStack(spacing: 11) {
                                    ZStack {
                                        RoundedRectangle(cornerRadius: 7, style: .continuous)
                                            .fill(Color.secondary.opacity(0.12))
                                            .frame(width: 29, height: 29)
                                        Image(systemName: profile.routeSymbol)
                                            .font(.system(size: 14, weight: .medium))
                                            .foregroundStyle(store.appearance.tintColor)
                                    }
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(profile.name)
                                            .font(.body.weight(.medium))
                                            .foregroundStyle(.primary)
                                        Text(profile.addressString)
                                            .font(.caption.monospaced())
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                    }
                                    Spacer(minLength: 6)
                                    if profile.id == store.selectedProfileID {
                                        Image(systemName: "checkmark")
                                            .font(.subheadline.weight(.semibold))
                                            .foregroundStyle(store.appearance.tintColor)
                                    }
                                }
                                .padding(.vertical, 2)
                            }
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button(lang.string("action.delete"), role: .destructive) {
                                    if let idx = store.profiles.firstIndex(of: profile) {
                                        store.deleteProfiles(at: IndexSet(integer: idx))
                                    }
                                }
                                Button(lang.string("action.edit_address")) {
                                    store.editingProfile = profile
                                    store.showConnectSheet = true
                                }
                                .tint(.blue)
                            }
                            .contextMenu {
                                Button(lang.string("action.edit_address")) {
                                    store.editingProfile = profile
                                    store.showConnectSheet = true
                                }
                                Button(lang.string("action.delete"), role: .destructive) {
                                    if let idx = store.profiles.firstIndex(of: profile) {
                                        store.deleteProfiles(at: IndexSet(integer: idx))
                                    }
                                }
                            }
                            .papertownRowBackground(store.appearance)
                        }
                    }
                }

                if store.connectionStatus == .connected && !store.isDemo {
                    ServerSettingsSection()
                }

                Section(lang.string("server.section.preferences")) {
                    Picker(lang.string("server.appearance"), selection: Binding(
                        get: { store.appearance },
                        set: { store.setAppearance($0) }
                    )) {
                        Text(lang.string("server.appearance.system")).tag(AppAppearance.system)
                        Text(lang.string("server.appearance.light")).tag(AppAppearance.light)
                        Text(lang.string("server.appearance.dark")).tag(AppAppearance.dark)
                        Text(lang.string("server.appearance.paper")).tag(AppAppearance.paper)
                    }
                    .papertownRowBackground(store.appearance)

                    Picker(lang.string("server.language"), selection: Binding(
                        get: { store.language },
                        set: { store.setLanguage($0) }
                    )) {
                        Text(lang.string("server.language.en")).tag(AppLanguage.english)
                        Text(lang.string("server.language.zh")).tag(AppLanguage.simplifiedChinese)
                        Text(lang.string("server.language.system")).tag(AppLanguage.system)
                    }
                    .papertownRowBackground(store.appearance)
                }

                Section {
                    Button(lang.string("server.add")) {
                        store.editingProfile = nil
                        store.showConnectSheet = true
                    }
                    .papertownRowBackground(store.appearance)

                    // a password login only: this Mac and access keys have nothing to sign out of
                    if store.authState?.signedIn == true {
                        Button(lang.string("action.sign_out"), role: .destructive) {
                            showSignOutConfirm = true
                        }
                        .papertownRowBackground(store.appearance)
                    }
                }
            }
            .papertownInsetGroupedList()
            .papertownListAppearance(store.appearance)
            .navigationTitle(lang.string("tab.server"))
            .papertownSidebarButton()
            .papertownLargeTitle()
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        store.editingProfile = nil
                        store.showConnectSheet = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel(lang.string("server.add"))
                }
            }
            .confirmationDialog(
                lang.string("server.sign_out.confirm.title"),
                isPresented: $showSignOutConfirm,
                titleVisibility: .visible
            ) {
                Button(lang.string("action.sign_out"), role: .destructive) {
                    Task { await store.signOut() }
                }
                Button(lang.string("action.cancel"), role: .cancel) {}
            } message: {
                Text(lang.string("server.sign_out.confirm.message"))
            }
        }
    }

    private var statusColor: Color {
        switch store.connectionStatus {
        case .connected: return .green
        case .connecting, .reconnecting, .authRequired: return .orange
        case .disconnected: return .red
        }
    }

    private func statusText(lang: AppLanguage) -> String {
        switch store.connectionStatus {
        case .connected: return lang.string("conn.connected")
        case .connecting: return lang.string("conn.connecting")
        case .reconnecting: return lang.string("conn.reconnecting")
        case .authRequired: return lang.string("conn.sign_in_needed")
        case .disconnected: return lang.string("conn.disconnected")
        }
    }

    private func routeText(for profile: ServerProfile, lang: AppLanguage) -> String {
        if profile.isLocalAddress { return lang.string("server.route.local") }
        if profile.url?.scheme?.lowercased() == "https" { return lang.string("server.route.remote") }
        return lang.string("server.route.http")
    }

    private func sessionText(lang: AppLanguage) -> String {
        guard let auth = store.authState else { return lang.string("server.session.signed_out") }
        if auth.key == true { return lang.string("server.session.key") }
        if auth.signedIn { return lang.string("server.session.signed_in") }
        if auth.local && auth.authed { return lang.string("server.session.local") }
        return lang.string("server.session.signed_out")
    }
}
