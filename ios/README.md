# Papertown for iOS

Native SwiftUI client for iOS 16+ composed of two local Swift Package libraries and a thin iOS app entry point:

- **`PapertownCore`** (`Sources/PapertownCore`): Foundation-only networking, authentication cookie session, project/agent APIs, and auto-reconnecting SSE client.
- **`PapertownUI`** (`Sources/PapertownUI`): Native Apple HIG SwiftUI interface (zero emojis, 100% SF Symbols) built around five tabs (**Inbox**, **Projects**, **Staff**, **Town**, **Server**), English primary localization (`en`) with optional Simplified Chinese (`zh-Hans`), and System / Light / Dark / Paper appearances.
- **`PapertownApp`** (`PapertownApp/`): `@main` SwiftUI app shell + `Info.plist` (`NSLocalNetworkUsageDescription`, `NSFaceIDUsageDescription`, `NSAllowsLocalNetworking`) and Xcode project (`PapertownApp/Papertown.xcodeproj`).

## What the app covers

| Tab | Pages |
|---|---|
| **Inbox** | Questions from project leads (answered with their choices or your own words), permission requests, blocked leads, active projects |
| **Projects** | Search and filters, new idea; per project: resident lead switch, 8-stage progress, progress card, reports and questions, gates and checks, research loop, overlap report, method, experiments (results table, jobs and runs), paper (abstract, review, compile, PDF), workspace files, usage, team |
| **Staff** | Agents by urgency or project, herdr / tmux terminal sessions; each opens a conversation: messages, tool calls, permission prompts, dialogs on a terminal's screen, queued messages, the live screen with Enter / Esc / arrow / Ctrl-C keys, and Steer / Queue / Interrupt while an agent works |
| **Town** | The assistant (with actions waiting for approval), projects in progress and leads on duty, departments, library search, compute (executors, jobs, GPUs), model quotas, MCP servers and skills |
| **Server** | Current connection, saved servers, appearance and language |

Text the server writes in Chinese (stage names, notes, reports, check titles) is shown in English when the app is in English, with the web's dictionary (`Resources/server-en.json`); run `ios/scripts/sync-server-text.sh` after `web/src/i18n/en.json` changes.

## Offline demo

**Connect Server › Try the Offline Demo** opens a read-only town with the five sample projects, answered from `Sources/PapertownUI/Resources/Demo` without any server. To export it again, start a server that holds only the samples (its own data dir, no leads) and run:

```bash
python3 ios/scripts/make-demo.py http://127.0.0.1:<port>
```

Local paths in the answers are replaced by `~/papertown/...`. Never point it at a server with your own projects: everything it reads goes into the app bundle.

## Connecting to your server

The server listens on 127.0.0.1 by default. For the phone to reach it, either serve it on the network with an access password set (Settings › Access & Sign-In on the desktop) and `papertown serve --host 0.0.0.0`, or put it behind `tailscale serve` or another HTTPS proxy and enter that address.

## Connection & Session

- Supports **direct LAN IP** (`http://192.168.x.x:8000`), **Tailscale HTTPS**, and **self-hosted reverse-proxy relays** (including path prefixes; `/api` is appended automatically).
- `PapertownClient` keeps server cookies in an ephemeral `URLSession`. Enabling **Auto Sign-In with Face ID** stores only the access password in the iOS Keychain so the app can sign in again after relaunch.
- Live SSE updates pause automatically when the app moves to the background (`scenePhase`) and refresh snapshots on reconnect.

## Documentation

- UI architecture & native SwiftUI specification: [docs/ios_swiftui_design.md](../docs/ios_swiftui_design.md)
- Page-by-page English-first copy & localization specification: [docs/ios_swiftui_copy_spec.md](../docs/ios_swiftui_copy_spec.md)

## Build & Test

Run package unit tests (both `PapertownCoreTests` and `PapertownUITests`; `ServerAPITests` decodes every exported demo answer, so it fails when the app's models fall behind the server):

```bash
cd ios
swift test
```

Open the iOS app in Xcode to run on Simulator or a physical iPhone:

```bash
open ios/PapertownApp/Papertown.xcodeproj
```
