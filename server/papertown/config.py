"""Settings for local agents and the town services."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = SERVER_DIR.parent


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


@dataclass
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(_env("PAPERTOWN_DATA_DIR", str(SERVER_DIR / "var"))))
    skills_dir: Path = field(default_factory=lambda: Path(_env("PAPERTOWN_SKILLS_DIR", str(SERVER_DIR / "skills"))))
    web_dist: Path = field(default_factory=lambda: REPO_DIR / "web" / "dist")
    manifest: Path = field(default_factory=lambda: REPO_DIR / "assets" / "manifest.json")

    # "0" turns off the arXiv dock (tests, no network)
    arxiv_port: bool = field(default_factory=lambda: _env("PAPERTOWN_ARXIV", "1") != "0")
    # extra MCP servers, JSON file in the Claude Desktop format {"mcpServers": {...}}
    mcp_config: str = field(default_factory=lambda: _env("PAPERTOWN_MCP_CONFIG"))
    compile_tex: bool = field(default_factory=lambda: _env("PAPERTOWN_COMPILE_TEX", "1") != "0")
    # pi agents use pi's own model settings and login
    pi_bin: str = field(default_factory=lambda: _env("PAPERTOWN_PI_BIN"))
    pi_model: str = field(default_factory=lambda: _env("PAPERTOWN_PI_MODEL"))
    tmux_bin: str = field(default_factory=lambda: _env("PAPERTOWN_TMUX_BIN"))
    tmux_socket: str = field(default_factory=lambda: _env("PAPERTOWN_TMUX_SOCKET", "papertown"))
    claude_bin: str = field(default_factory=lambda: _env("PAPERTOWN_CLAUDE_BIN"))
    codex_bin: str = field(default_factory=lambda: _env("PAPERTOWN_CODEX_BIN"))
    agent_runtime: str = field(default_factory=lambda: _env("PAPERTOWN_AGENT_RUNTIME", "paseo"))
    # Seconds of a still screen after which a working terminal agent counts as waiting on a dialog.
    terminal_still: float = field(default_factory=lambda: float(_env("PAPERTOWN_TERMINAL_STILL", "15")))
    # How long herdr gets to start a CLI in a new tab, and the window for finding a new Codex session's log.
    terminal_startup: float = field(default_factory=lambda: float(_env("PAPERTOWN_TERMINAL_STARTUP", "20")))
    # Seconds of a still screen after which a start counts as held by a dialog (trust, sign-in, hooks review).
    terminal_ready: float = field(default_factory=lambda: float(_env("PAPERTOWN_TERMINAL_READY", "5")))
    # After Papertown sends Esc, a screen that stays still this long means the agent has stopped.
    terminal_settle: float = field(default_factory=lambda: float(_env("PAPERTOWN_TERMINAL_SETTLE", "2")))
    # or in Paseo (paseo.sh): its CLI, the web app it serves, and an explicit daemon endpoint
    paseo_bin: str = field(default_factory=lambda: _env("PAPERTOWN_PASEO_BIN"))
    paseo_url: str = field(default_factory=lambda: _env("PAPERTOWN_PASEO_URL", "http://127.0.0.1:6767"))
    paseo_host: str = field(default_factory=lambda: _env("PAPERTOWN_PASEO_HOST"))
    # Read existing herdr terminals over its socket; never start the host.
    herdr: bool = field(default_factory=lambda: _env("PAPERTOWN_HERDR", "1") != "0")
    herdr_socket: str = field(default_factory=lambda: _env("PAPERTOWN_HERDR_SOCKET", "~/.config/herdr/herdr.sock"))
    # where the bridge extension inside each pi reaches this server; `serve` sets it
    url: str = field(default_factory=lambda: _env("PAPERTOWN_URL", "http://127.0.0.1:8000"))
    # Prebuilt samples: put the sample papers on the lines the first time the town starts empty
    samples: bool = field(default_factory=lambda: _env("PAPERTOWN_SAMPLES", "1") != "0")
    # nvidb's GPU queue, read only: the cards on your machines and their jobs ("0" turns it off)
    nvidb: bool = field(default_factory=lambda: _env("PAPERTOWN_NVIDB", "1") != "0")
    nvidb_bin: str = field(default_factory=lambda: _env("PAPERTOWN_NVIDB_BIN"))
    # seconds between background readings of nvidb
    nvidb_poll: float = field(default_factory=lambda: float(_env("PAPERTOWN_NVIDB_POLL", "10") or 10))
    # skim, the skill manager (see skim.py)
    skim_bin: str = field(default_factory=lambda: _env("PAPERTOWN_SKIM_BIN"))
    # your own projects, linked in from local repos (see linked.py); default: projects.json in the data dir
    projects: str = field(default_factory=lambda: _env("PAPERTOWN_PROJECTS"))
    # what the assistant and the leads start with on Paseo until chosen in settings: provider/model@thinking
    assistant_model: str = field(default_factory=lambda: _env("PAPERTOWN_ASSISTANT_MODEL", "codex/gpt-6.1-terra@xhigh"))
    lead_model: str = field(default_factory=lambda: _env("PAPERTOWN_LEAD_MODEL", "codex/gpt-6.1-terra@high"))
    # what a coder or a writer starts on when its lead hires it; empty: the lead's default
    worker_model: str = field(default_factory=lambda: _env("PAPERTOWN_WORKER_MODEL"))
    # each project in progress keeps its lead running ("0": leads start only by hand)
    lead_resident: bool = field(default_factory=lambda: _env("PAPERTOWN_LEAD_RESIDENT", "1") != "0")
    # project leads: seconds between looks at their projects, and at least between two check-ins
    lead_tick: float = field(default_factory=lambda: float(_env("PAPERTOWN_LEAD_TICK", "20") or 20))
    lead_gap: float = field(default_factory=lambda: float(_env("PAPERTOWN_LEAD_GAP", "180") or 180))
    # seconds between looks at what each project's hard checks read; they run again when it changed
    check_tick: float = field(default_factory=lambda: float(_env("PAPERTOWN_CHECK_TICK", "120") or 120))
    # seconds between readings of Paseo's model list for new models; 0 turns them off
    paseo_watch: float = field(default_factory=lambda: float(_env("PAPERTOWN_PASEO_WATCH", "1800") or 0))
    # where Claude Code and Codex keep their conversations, for importing (history.py)
    claude_home: str = field(default_factory=lambda: _env("PAPERTOWN_CLAUDE_HOME", "~/.claude"))
    codex_home: str = field(default_factory=lambda: _env("PAPERTOWN_CODEX_HOME", "~/.codex"))
    antigravity_home: str = field(default_factory=lambda: _env("PAPERTOWN_ANTIGRAVITY_HOME", "~/.gemini/antigravity-cli"))
    agy_bin: str = field(default_factory=lambda: _env("PAPERTOWN_AGY_BIN"))
    usage_poll: float = field(default_factory=lambda: float(_env("PAPERTOWN_USAGE_POLL", "300") or 300))
    transcripts: bool = field(default_factory=lambda: _env("PAPERTOWN_TRANSCRIPTS", "1") != "0")
    usage_logs: bool = field(default_factory=lambda: _env("PAPERTOWN_USAGE_LOGS", "1") != "0")
    # local job runner: how many commands run at once
    local_jobs: int = field(default_factory=lambda: int(_env("PAPERTOWN_LOCAL_JOBS", "2")))

    def paseo_default(self, role: str) -> dict:
        """The provider, model and thinking an agent of this role starts with: the assistant, a lead, or a worker
        (a coder or a writer, which follows the lead unless PAPERTOWN_WORKER_MODEL names its own)."""
        spec = self.assistant_model if role == "assistant" else self.lead_model if role == "lead" else self.worker_model or self.lead_model
        provider, _, rest = spec.partition("/")
        model, _, thinking = rest.partition("@")
        return {"provider": provider or None, "model": model or None, "thinking": thinking or None}

    def __post_init__(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)

    @property
    def db_path(self) -> Path:
        return self.data_dir / "papertown.db"

    @property
    def projects_file(self) -> Path:
        return Path(self.projects).expanduser() if self.projects else self.data_dir / "projects.json"

    @property
    def press_dir(self) -> Path:
        return self.data_dir / "press"

    @property
    def projects_dir(self) -> Path:
        return self.data_dir / "projects"

    @property
    def jobs_dir(self) -> Path:
        return self.data_dir / "jobs"
