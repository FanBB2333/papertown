import PapertownUI
import SwiftUI

// One app for iPhone, iPad and Mac: the pages are PapertownUI's; the Mac adds a sidebar, menus, a Settings
// window and the local server (PapertownUI/Mac).
@main
struct PapertownApp: App {
    @StateObject private var store = TownStore()
    #if os(macOS)
    @NSApplicationDelegateAdaptor(MacAppDelegate.self) private var delegate
    #endif

    var body: some Scene {
        #if os(macOS)
        Window("Papertown", id: "main") {
            PapertownRootView(store: store)
        }
        .defaultSize(width: 1180, height: 780)
        .commands { PapertownCommands(store: store) }

        Settings {
            MacSettingsView(store: store)
        }
        #else
        WindowGroup {
            PapertownRootView(store: store)
        }
        #endif
    }
}
