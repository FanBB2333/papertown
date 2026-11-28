# Papertown for iPhone and Mac

Native SwiftUI client for iOS 16+ and macOS 14+, composed of two local Swift Package libraries and a thin app entry point:

- **`PapertownCore`** (`Sources/PapertownCore`): Foundation-only networking, authentication cookie session, project/agent APIs, and auto-reconnecting SSE client.
- **`PapertownUI`** (`Sources/PapertownUI`): Native Apple HIG SwiftUI interface (zero emojis, 100% SF Symbols) built around five sections (**Inbox**, **Projects**, **Staff**, **Town**, **Server**), English primary localization (`en`) with optional Simplified Chinese (`zh-Hans`), and System / Light / Dark / Paper appearances.
- **`PapertownApp`** (`PapertownApp/`): `@main` SwiftUI app shell, `Info.plist` for iOS and `Info-macOS.plist` for the Mac, and the Xcode project (`PapertownApp/Papertown.xcodeproj`) whose one **Papertown** target builds for both.

## Layout

One set of pages for every size, framed by the shape of the window (`Views/AppShell.swift`). Held upright, on iPhone
and iPad alike, the four sections are tabs along the bottom and the server opens from the connection pill at the top
right; the canvas and conversations hide the tabs while they show. Held wide, the sidebar is Papertown's own, in quiet
warm colours: the four sections, New Idea, and the server with its connection along the bottom (`Views/Sidebar.swift`).
Where the width is regular (iPad, a foldable iPhone opened, Plus and Max iPhones) it sits beside the page and folds
away with the button at its head; where it is compact it slides over the page from the button at the top left.
Turning the device keeps the section and the page open in it. The Mac's window has the same sidebar beside the page.

A page is built from a few shared parts (`Views/Panels.swift`), after the web's pages and `docs/ui_emphasis.md`: a card
on the page, a section's title bar (its symbol on a tile of the tint, its name, what belongs to the whole section on
the right), a capsule that names a state at the end of its row, and the one filled orange tag for what waits on you.
Pages of cards (Projects, Background terminals) lay them out in as many columns as fit: one on an iPhone, two or three
on an iPad, more in a wide window. Pages of lists keep their rows in a reading column in the middle of a wide window,
and on the Mac they are grouped forms.

## On the Mac

The same pages in a window with a sidebar (⌘1 to ⌘5), a menu bar (Connect ⌘⇧K, Refresh ⌘R, Open in Browser ⌘⇧O, a Server menu) and a Settings window (⌘,). The Dock icon counts what waits in the Inbox, and live updates continue while the window is in the background.

The Mac app also looks after this Mac's server: with the Papertown checkout it was built from (or the folder chosen in Settings › This Mac's Server) it starts `uv run --frozen papertown serve` when none answers, stops it on quit if it started it, and writes its output to `~/Library/Logs/Papertown/server.log`. A server already running on the port is used as it is.

Build it in Xcode (scheme **Papertown**, destination **My Mac**), or from the command line:

```bash
ios/scripts/build-mac.sh   # ios/build/Papertown.app
```

## What the app covers

| Tab | Pages |
|---|---|
| **Inbox** | Matters with facts, possible approaches and materials, card lines waiting for your decision, permissions, blocked leads and active projects |
| **Projects** | Project cards (state, health, stages, the lead's summary, what waits on you), search and filters, new idea, Update All and new papers. Each project has its progress card, resident lead, research loop, gates and checks, decisions, provenance, reports, published pages, imported memory, overlap report, method, experiments, paper, workspace files, usage, budget and team. |
| **Staff** | Background terminals (every open terminal's screen side by side, read again every few seconds; a tile opens that terminal), agents by urgency or project, herdr / tmux terminal sessions, new staff (Paseo, herdr, tmux, background terminal or pi, with provider, model and thinking) or a Paseo conversation imported; each opens a conversation: messages, tool calls, permission prompts, dialogs on a terminal's screen, queued messages, the live screen with Enter / Esc / arrow / Ctrl-C keys, Steer / Queue / Interrupt while an agent works, earlier conversations, a new one, the project brief, closing a terminal |
| **Town** | The assistant (started in the background only; its page is the conversation and its terminal is with the others under Background terminals; actions waiting for approval), projects in progress, leads on duty and background terminals, departments, library search and its settings, compute (executors, jobs, GPUs), model quotas, MCP servers (add, edit, reconnect, turn off) and skills, Skills per scope (skim), work bounds, the call trace |
| **Server** | Current connection, saved servers, this server's settings (access password and access keys, default runtime and models, usage and budgets, sample projects), appearance and language |

The town's map and 3D walk are the web's alone.

### Decisions

In the Inbox or on a project, open **View Facts** to see the evidence, possible approaches and materials. Selecting an approach copies its wording into the reply field. Edit it and choose **Record Decision** to answer the matter. Card lines also take a written decision. Permission requests keep their own controls. The two summary rows under the resident lead open the project's decisions and provenance.

Open **Decisions** below the resident lead to see active decisions by research area. The last filter shows work without a basis when present. Expand the history at the bottom to see replaced and withdrawn decisions. A decision opens its original wording, supporting materials, related work and replacement history. **Write a Decision** creates a record. **Rewrite** creates a replacement, and **Withdraw** retains the original in the history. **Save as Decision** on your own chat message records its full text. The research loop links matters to their reply fields and shows the basis of tasks and stages.

### Provenance

Open **Provenance** below the resident lead. Sections with registered passages open first. Expand a passage to trace its sources down to the result files, or expand the remaining sections to see their lines grouped by author. Results outside the paper appear at the end. Changed records open on the diff, with a switch for the registered and current text. Record details also show the responsible operation, method, code version, basis and verification. **Operations** lists changed files and their diffs. A run's result tags in **Experiments** and **View Provenance** on a paper file open the corresponding records or tree. Both pages use the existing navigation stack in portrait, landscape and on the Mac.

Text the server writes in Chinese (stage names, notes, reports, check titles) is shown in English when the app is in English, with the web's dictionary (`Resources/server-en.json`); run `ios/scripts/sync-server-text.sh` after `web/src/i18n/en.json` changes.

## Offline demo

**Connect Server › Try the Offline Demo** opens a read-only town with the five sample projects, answered from `Sources/PapertownUI/Resources/Demo`. Project #2 (peer review) includes a worked example from a written decision through a task, a run and a results table to the paper. To export the demo again, use an isolated samples server with its own data directory and `PAPERTOWN_LEAD_RESIDENT=0`, and point the sample configuration’s history directories at that same temporary root. With the server’s environment active, record the sample actions and export the responses from the checkout:

```bash
uv run --frozen --project server ios/scripts/prepare-demo.py "$sample_root"
uv run --frozen --project server ios/scripts/make-demo.py "http://127.0.0.1:$sample_port"
```

Local paths in the answers are replaced by `~/papertown/...`. Never point it at a server with your own projects: everything it reads goes into the app bundle.

## Connecting to your server

A server is a base URL and an access key:

1. Make the server reachable from the device. On a network you trust, set `host = "0.0.0.0"` under `[server]` in `papertown.toml` (or choose all networks under Settings › Network & Security in the web app) and restart the server. Or keep it on `127.0.0.1` and put `tailscale serve 31640` or another HTTPS proxy in front of it. The device has to come from a source allowed under `[network]`, the LAN and Tailscale by default.
2. Make a key for the device on the server, `uv run papertown key create --name iPhone` in `server/`, or under Settings › Access & sign-in in the web app. It is shown once.
3. In the app, **Add Server**: the address (`http://<Tailscale or LAN IP>:31640`, `https://mac.tailnet.ts.net`, or a relay with a path prefix; `/api` is appended) and the key.

Before signing in the app checks `GET /api/health` for `"app": "papertown"`, so a wrong address says so. A key the server no longer accepts (revoked, or copied wrong) stops the connection with that message, and `papertown key revoke <id>` shuts out one device without touching the others. The access password still works for servers set up that way: choose **Access Password** in the same form.

## Connection & Session

- `PapertownClient` sends the key as `Authorization: Bearer <key>` on every request, the live event stream included. The key is kept in the Keychain (this device only), apart from the server list.
- With the access password instead, the client keeps the server's cookie in an ephemeral `URLSession`. **Auto Sign-In with Face ID** stores only the password in the Keychain so the app can sign in again after relaunch.
- On iPhone, live SSE updates pause when the app moves to the background (`scenePhase`) and snapshots refresh on reconnect.

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
