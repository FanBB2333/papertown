import PapertownCore
import SwiftUI

struct ConnectionSheet: View {
    let editing: ServerProfile?

    @EnvironmentObject private var store: TownStore
    @Environment(\.dismiss) private var dismiss

    @State private var name: String
    @State private var urlString: String
    @State private var password: String = ""
    @State private var useBiometrics: Bool
    @State private var isConnecting = false
    @State private var validationError: String?

    private let biometry = KeychainStore.availableBiometry()

    init(editing: ServerProfile?) {
        self.editing = editing
        _name = State(initialValue: editing?.name ?? "")
        _urlString = State(initialValue: editing?.addressString ?? "")
        _useBiometrics = State(initialValue: editing?.useBiometrics ?? false)
    }

    var body: some View {
        let lang = store.language
        NavigationStack {
            Form {
                Section {
                    LabeledContent(lang.string("connect.field.name")) {
                        TextField(lang.string("connect.field.name.placeholder"), text: $name)
                            .multilineTextAlignment(.trailing)
                    }
                    LabeledContent(lang.string("connect.field.url")) {
                        TextField(lang.string("connect.field.url.placeholder"), text: $urlString)
                            .multilineTextAlignment(.trailing)
                            .papertownURLInput()
                            .font(.subheadline.monospaced())
                    }
                } header: {
                    Text(lang.string("connect.section.address"))
                } footer: {
                    Text(lang.string("connect.section.address.footer"))
                }

                Section {
                    LabeledContent(lang.string("connect.field.password")) {
                        SecureField(lang.string("connect.field.password.placeholder"), text: $password)
                            .multilineTextAlignment(.trailing)
                    }
                    Toggle(
                        lang.string(biometry == .touchID ? "connect.touch_id" : "connect.face_id"),
                        isOn: $useBiometrics
                    )
                } header: {
                    Text(lang.string("connect.section.auth"))
                } footer: {
                    Text(lang.string("connect.section.auth.footer"))
                }

                if editing == nil {
                    Section {
                        Button {
                            Task {
                                await store.openDemo()
                                dismiss()
                            }
                        } label: {
                            Label(lang.string("demo.try"), systemImage: "sparkles.rectangle.stack")
                        }
                    } footer: {
                        Text(lang.string("demo.footer"))
                    }
                }

                if let validationError {
                    Section {
                        Label(validationError, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(lang.string(editing == nil ? "connect.title" : "connect.edit_title"))
            .papertownInlineTitle()
            .toolbar {
                if !store.profiles.isEmpty {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(lang.string("action.cancel")) { dismiss() }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isConnecting {
                        ProgressView()
                    } else {
                        Button(lang.string("action.connect")) {
                            saveAndConnect()
                        }
                        .fontWeight(.semibold)
                        .disabled(urlString.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
        }
    }

    private func saveAndConnect() {
        let lang = store.language
        guard let normalized = ServerProfile.normalizeURL(urlString) else {
            validationError = lang.string("error.invalid_address")
            return
        }
        validationError = nil
        isConnecting = true

        let displayName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let profile = ServerProfile(
            id: editing?.id ?? UUID(),
            name: displayName.isEmpty ? (normalized.host ?? normalized.absoluteString) : displayName,
            addressString: normalized.absoluteString,
            useBiometrics: useBiometrics
        )

        Task {
            await store.upsertProfile(profile, password: password.isEmpty ? nil : password, connectNow: true)
            isConnecting = false
            if let error = store.lastError, store.connectionStatus == .disconnected {
                validationError = error
            } else {
                dismiss()
            }
        }
    }
}

struct LoginSheet: View {
    let expired: Bool

    @EnvironmentObject private var store: TownStore
    @Environment(\.dismiss) private var dismiss

    @State private var password = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    var body: some View {
        let lang = store.language
        let serverName = store.currentProfile?.name ?? lang.string("tab.server")
        let host = store.currentProfile?.displayHost ?? ""

        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(expired
                             ? lang.format("login.expired_subtitle", serverName)
                             : lang.format("login.subtitle", serverName, host))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 2)

                    SecureField(lang.string("login.password.placeholder"), text: $password)
                        .onSubmit { submit() }
                }

                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    Button {
                        submit()
                    } label: {
                        HStack {
                            Spacer()
                            if isSubmitting {
                                ProgressView()
                                    .padding(.trailing, 6)
                                Text(lang.string("action.signing_in"))
                            } else {
                                Text(lang.string("action.sign_in"))
                                    .fontWeight(.semibold)
                            }
                            Spacer()
                        }
                    }
                    .disabled(isSubmitting || password.isEmpty)

                    Button(lang.string("action.switch_server")) {
                        dismiss()
                        store.showConnectSheet = true
                    }
                }
            }
            .navigationTitle(lang.string(expired ? "login.expired_title" : "login.title"))
            .papertownInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(lang.string("action.cancel")) { dismiss() }
                }
            }
        }
    }

    private func submit() {
        guard !password.isEmpty, !isSubmitting else { return }
        isSubmitting = true
        errorMessage = nil

        Task {
            do {
                try await store.login(password: password)
                dismiss()
            } catch ClientError.http(let status, _) where status == 401 {
                errorMessage = store.language.string("login.wrong_password")
            } catch {
                errorMessage = TextFormatters.errorMessage(for: error, language: store.language)
            }
            isSubmitting = false
        }
    }
}
