<img src="web/public/logo.svg" width="72" alt="Papertown">

# Papertown

Papertown draws a research pipeline as a paper town. An idea goes through a novelty check, project setup, method design, experiments, writing and review, and ends as a paper. The agents you connect do the work. Papertown is where you manage, supervise and correct them.

Live demo: [papertown.life](https://papertown.life), a read-only snapshot of an offline run. The full guide (in Chinese) is [`docs/guide.zh-CN.md`](docs/guide.zh-CN.md).

## Features

- **Progress**: one card per project with its state, decisions waiting for you, running and planned experiments, expected outputs and repositories. The project lead writes the card when you ask for an update. Each project has a page with its decisions, research loop, experiments and a conversation with its lead.
- **Research loop**: a graph of each project's controls, laid out in the same four rows for every project (overview and agents, survey, code / experiments / data, paper). Hard gates are checked in code, for example paper style rules, novelty similarity, returned results and PDF freshness. A blocking gate locks the next stage and sends a rework ticket until it passes. Soft sentinels are questions the lead judges on a schedule, such as whether the method fits the idea or the claims are supported. Task order is kept in code, and anything the loop cannot resolve goes to a human gate. Design notes: [`docs/research_loop_design.md`](docs/research_loop_design.md).
- **Agents**: every agent of every project in one list, sorted by what needs you: waiting for your approval or answer, failed, finished and unread, working, idle. Open one to read its conversation and step in while it works: steer the running turn, queue a message for when it ends, or interrupt and replace the task. Design notes: [`docs/agent_watch_design.md`](docs/agent_watch_design.md).
- **Console**: panels for each project's survey, code (an in-browser editor with git diffs), experiments (GPU queue, timelines, results), data, paper (LaTeX source beside the compiled PDF) and agents.
- **Town**: the same projects on an isometric map and in a 3D walk, with buildings driven by live state.
- **Assistant**: a chat box at the bottom of every page that reads what you are looking at and passes instructions to project leads and workers.
- **Work bounds**: what agents must do, must not do and must ask about first, set globally, per project and per agent. Bounds tied to actions are enforced by the server.
- **Pages**: HTML reports that agents publish, shown in a sandbox and presentable full screen.
- **Memory import**: earlier Claude Code and Codex conversations about a project's repositories, with secrets redacted, searchable by its agents.
- Three looks (Cloudflare, macOS, paper) and three languages (English, Simplified and Traditional Chinese).

## How it works

Agents work in three layers:

- **Assistant** (one for the whole town): talks with you and acts for you across projects.
- **Project lead** (one per project): watches the project, assigns work, judges the soft sentinels, reports and asks you questions.
- **Workers** (a code worker and a writing worker per project): write code, run experiments and write the paper.

Agents run in [Paseo](https://paseo.sh) (recommended, it hosts Claude Code, Codex and others), as Claude Code, Codex or Antigravity in a [herdr](https://github.com/herdrdev/herdr) tab or a tmux window, or as local [pi](https://github.com/earendil-works/pi) agents in tmux. They use their own logins and keys, and Papertown does not read them. The Staff page lists every agent with its conversation, starts new ones on any of these runtimes, and brings up a terminal agent's prompts (trusting a folder, reviewing hooks, a permission) as a dialog to answer. Agents talk to Papertown through the `pt` command (`pt status`, `pt submit`, `pt report`, `pt ask`, `pt checks`, `pt task`, `pt publish` and more). Their skills live in `server/skills/` and are picked up while the server runs. External data comes in through MCP servers. The library is a SQLite full-text index seeded with 346 arXiv papers, with optional embeddings.

## Quick start

Backend (Python 3.11 or later, with [uv](https://docs.astral.sh/uv/)):

```bash
cd server
uv sync
uv run papertown serve            # http://127.0.0.1:8000
```

Frontend, in another terminal (`/api` is proxied to port 8000):

```bash
cd web
pnpm install
pnpm dev                          # http://127.0.0.1:5173
```

After `pnpm build`, `papertown serve` serves `web/dist` itself, so the backend alone is enough.

Without any API key the server runs in offline mode: a scripted provider calls the real tools (search, arXiv, a simulated GPU, LaTeX) and fills in templates, and five sample projects are added on first start. To run one idea from the command line:

```bash
cd server
uv run papertown demo "Use structured scene graphs for long-horizon VLA planning"
```

The server listens on `127.0.0.1` only. To open it from another device, make the port reachable (for example `tailscale serve 8000`) and set an access password on this machine under Settings › Access & sign-in.

To connect Paseo, start its daemon with the web UI enabled and install the SDK once:

```bash
paseo daemon start
paseo daemon config set features.webUi.enabled true
paseo daemon restart
cd server/papertown/paseo_link && pnpm install
```

## Configuration

Papertown reads its settings from the environment. Keep keys in your shell profile or keychain, never in the repository.

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Use Claude for the town's own agents |
| `PAPERTOWN_OPENAI_API_KEY`, `PAPERTOWN_OPENAI_BASE_URL` | Use any OpenAI-compatible endpoint instead |
| `PAPERTOWN_PROVIDER` | Force `anthropic`, `openai` or `mock` |
| `PAPERTOWN_WEEKLY_BUDGET`, `PAPERTOWN_LINE_BUDGET` | Spending limits in USD |
| `PAPERTOWN_DATA_DIR` | Where data is kept (default `server/var`) |
| `PAPERTOWN_ASSISTANT_MODEL`, `PAPERTOWN_LEAD_MODEL` | Default Paseo models for the assistant and the leads |
| `PAPERTOWN_PROJECTS` | Your own projects (default `projects.json` in the data directory) |
| `PAPERTOWN_NVIDB` | `0` turns off reading the nvidb GPU queue |
| `PAPERTOWN_SAMPLES` | `0` turns off the sample projects |

The complete list is in [`.env.example`](.env.example) and `server/papertown/config.py`.

## Your own projects and GPUs

Link existing repositories by writing `projects.json` in the data directory (it stays out of git):

```json
{"projects": [{"key": "my-proj", "code": "~/repos/my-code", "paper": "~/repos/overleaf/my-paper", "match": ["my-code", "my-proj"]}]}
```

Papertown reads these repositories without writing to them. Workers you start for such a project work in them directly.

If [nvidb](https://github.com/FanBB2333/nvidb) is installed, Papertown reads its GPU queue to show cards, utilization and each project's jobs. It never submits or cancels jobs, and machine addresses and user names stay off the page. Without nvidb, jobs can run on the built-in local farm:

```bash
uv run papertown job submit --line line_1 --name main -- python run.py --seed 0
uv run papertown job list
```

## Other ways in

- **Terminal UI**: `uv run papertown` in `server/` opens the same projects in the terminal and starts a server if none is running.
- **macOS app**: `macos/build.sh` builds `macos/build/Papertown.app`, and `macos/build.sh --install` copies it to `~/Applications`.
- **MCP server**: other MCP clients can read the library and the pipeline:

  ```json
  {"mcpServers": {"papertown": {"command": "uv", "args": ["--directory", "/path/to/papertown/server", "run", "papertown", "mcp"]}}}
  ```

## Static demo

`cd web && pnpm build:demo` builds a read-only demo into `web/dist-demo` from a snapshot of a fresh offline instance. The steps are at the top of `web/scripts/demo-snapshot.mjs`. The script stops if it finds personal paths, private addresses or email addresses.

## Development

```
assets/   building sprites and their manifest, generated from design/src/sprites.js
design/   design notes and the offline prototype
docs/     the full guide (Chinese) and the design notes
macos/    the macOS app shell
server/   FastAPI backend: agents, pipeline, checks, library, TUI, MCP
web/      React + Vite frontend
```

```bash
cd server && uv run --group dev pytest -q
cd web && pnpm build
cd web && pnpm i18n:missing       # UI strings without an English translation
node design/build.mjs             # regenerate the sprites
```

Interface strings are written in Simplified Chinese in the source and translated through `web/src/i18n/en.json`.

## License

[MIT](LICENSE)
