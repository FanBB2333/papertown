"""Settings, read once from the environment.

Keys never live in files in this repo: export them from ~/.secrets.zsh (or any env
manager) before starting the server. Without a provider key the server runs in
offline mode with the scripted provider, which is also the demo fallback.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = SERVER_DIR.parent


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _detect_provider() -> str:
    explicit = _env("PAPERTOWN_PROVIDER")
    if explicit:
        return explicit
    if _env("ANTHROPIC_API_KEY") or _env("ANTHROPIC_AUTH_TOKEN"):
        return "anthropic"
    if _env("PAPERTOWN_OPENAI_API_KEY"):
        return "openai"
    return "mock"


@dataclass
class Settings:
    # mock | anthropic | openai (any OpenAI-compatible endpoint: DeepSeek, Qwen, ...)
    provider: str = field(default_factory=_detect_provider)
    # strong model for Lv.3+ workers and final answers, cheap model for the rest
    model_strong: str = field(default_factory=lambda: _env("PAPERTOWN_MODEL_STRONG"))
    model_cheap: str = field(default_factory=lambda: _env("PAPERTOWN_MODEL_CHEAP"))
    effort: str = field(default_factory=lambda: _env("PAPERTOWN_EFFORT", "medium"))
    openai_base_url: str = field(default_factory=lambda: _env("PAPERTOWN_OPENAI_BASE_URL", "https://api.deepseek.com"))
    openai_api_key: str = field(default_factory=lambda: _env("PAPERTOWN_OPENAI_API_KEY"))
    # optional embeddings (OpenAI-compatible /embeddings); BM25 + TF-IDF otherwise
    embed_base_url: str = field(default_factory=lambda: _env("PAPERTOWN_EMBED_BASE_URL"))
    embed_api_key: str = field(default_factory=lambda: _env("PAPERTOWN_EMBED_API_KEY"))
    embed_model: str = field(default_factory=lambda: _env("PAPERTOWN_EMBED_MODEL"))

    data_dir: Path = field(default_factory=lambda: Path(_env("PAPERTOWN_DATA_DIR", str(SERVER_DIR / "var"))))
    skills_dir: Path = field(default_factory=lambda: Path(_env("PAPERTOWN_SKILLS_DIR", str(SERVER_DIR / "skills"))))
    web_dist: Path = field(default_factory=lambda: REPO_DIR / "web" / "dist")
    manifest: Path = field(default_factory=lambda: REPO_DIR / "assets" / "manifest.json")

    weekly_budget: float = field(default_factory=lambda: float(_env("PAPERTOWN_WEEKLY_BUDGET", "10")))
    default_line_budget: float = field(default_factory=lambda: float(_env("PAPERTOWN_LINE_BUDGET", "1.0")))
    # "0" turns off the arXiv dock (tests, no network)
    arxiv_port: bool = field(default_factory=lambda: _env("PAPERTOWN_ARXIV", "1") != "0")
    # extra MCP servers, JSON file in the Claude Desktop format {"mcpServers": {...}}
    mcp_config: str = field(default_factory=lambda: _env("PAPERTOWN_MCP_CONFIG"))
    # seconds a simulated GPU job takes; tests set 0
    sim_gpu_seconds: float = field(default_factory=lambda: float(_env("PAPERTOWN_SIM_GPU_SECONDS", "6")))
    compile_tex: bool = field(default_factory=lambda: _env("PAPERTOWN_COMPILE_TEX", "1") != "0")
    # pi agents in the press and the depot; they use pi's own model settings and login
    pi_bin: str = field(default_factory=lambda: _env("PAPERTOWN_PI_BIN"))
    pi_model: str = field(default_factory=lambda: _env("PAPERTOWN_PI_MODEL"))
    tmux_bin: str = field(default_factory=lambda: _env("PAPERTOWN_TMUX_BIN"))
    # where the bridge extension inside each pi reaches this server; `serve` sets it
    url: str = field(default_factory=lambda: _env("PAPERTOWN_URL", "http://127.0.0.1:8000"))
    # local job runner: how many commands run at once
    local_jobs: int = field(default_factory=lambda: int(_env("PAPERTOWN_LOCAL_JOBS", "2")))

    def __post_init__(self) -> None:
        defaults = {
            "anthropic": ("claude-opus-5-5", "claude-haiku-5-5"),
            "openai": ("deepseek-chat", "deepseek-chat"),
            "mock": ("scripted", "scripted"),
        }
        strong, cheap = defaults.get(self.provider, ("scripted", "scripted"))
        self.model_strong = self.model_strong or strong
        self.model_cheap = self.model_cheap or cheap
        self.data_dir.mkdir(parents=True, exist_ok=True)

    @property
    def db_path(self) -> Path:
        return self.data_dir / "papertown.db"

    @property
    def press_dir(self) -> Path:
        return self.data_dir / "press"

    @property
    def projects_dir(self) -> Path:
        return self.data_dir / "projects"

    @property
    def jobs_dir(self) -> Path:
        return self.data_dir / "jobs"

    @property
    def offline(self) -> bool:
        return self.provider == "mock"
