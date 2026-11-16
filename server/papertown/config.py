"""Settings, read once from the environment. Keys never live in files in this repo; without a
provider key the server runs offline with the scripted provider.
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


# providers the town's own workers can use: default (strong, cheap) models and suggestions for the switch
PROVIDERS = {
    "mock": {"name": "离线演示", "default": ("scripted", "scripted"), "models": ["scripted"]},
    "anthropic": {"name": "Anthropic", "default": ("claude-opus-5-5", "claude-haiku-5-5"),
                  "models": ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"]},
    "openai": {"name": "OpenAI 兼容接口", "default": ("deepseek-chat", "deepseek-chat"),
               "models": ["deepseek-chat", "deepseek-reasoner", "qwen-max", "glm-4.6"]},
}


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
    # pi agents use pi's own model settings and login
    pi_bin: str = field(default_factory=lambda: _env("PAPERTOWN_PI_BIN"))
    pi_model: str = field(default_factory=lambda: _env("PAPERTOWN_PI_MODEL"))
    tmux_bin: str = field(default_factory=lambda: _env("PAPERTOWN_TMUX_BIN"))
    # or in Paseo (paseo.sh): its CLI, the web app it serves, and an explicit daemon endpoint
    paseo_bin: str = field(default_factory=lambda: _env("PAPERTOWN_PASEO_BIN"))
    paseo_url: str = field(default_factory=lambda: _env("PAPERTOWN_PASEO_URL", "http://127.0.0.1:6767"))
    paseo_host: str = field(default_factory=lambda: _env("PAPERTOWN_PASEO_HOST"))
    # where the bridge extension inside each pi reaches this server; `serve` sets it
    url: str = field(default_factory=lambda: _env("PAPERTOWN_URL", "http://127.0.0.1:8000"))
    # offline demo: put the sample papers on the lines the first time the town starts empty
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
    # project leads: seconds between looks at their projects, and at least between two check-ins
    lead_tick: float = field(default_factory=lambda: float(_env("PAPERTOWN_LEAD_TICK", "20") or 20))
    lead_gap: float = field(default_factory=lambda: float(_env("PAPERTOWN_LEAD_GAP", "180") or 180))
    # seconds between readings of Paseo's model list for new models; 0 turns them off
    paseo_watch: float = field(default_factory=lambda: float(_env("PAPERTOWN_PASEO_WATCH", "1800") or 0))
    # where Claude Code and Codex keep their conversations, for importing (history.py)
    claude_home: str = field(default_factory=lambda: _env("PAPERTOWN_CLAUDE_HOME", "~/.claude"))
    codex_home: str = field(default_factory=lambda: _env("PAPERTOWN_CODEX_HOME", "~/.codex"))
    # local job runner: how many commands run at once
    local_jobs: int = field(default_factory=lambda: int(_env("PAPERTOWN_LOCAL_JOBS", "2")))

    def paseo_default(self, role: str) -> dict:
        """The provider, model and thinking an assistant or a lead starts with on Paseo."""
        spec = self.assistant_model if role == "assistant" else self.lead_model if role == "lead" else ""
        provider, _, rest = spec.partition("/")
        model, _, thinking = rest.partition("@")
        return {"provider": provider or None, "model": model or None, "thinking": thinking or None}

    def __post_init__(self) -> None:
        strong, cheap = PROVIDERS.get(self.provider, PROVIDERS["mock"])["default"]
        self.model_strong = self.model_strong or strong
        self.model_cheap = self.model_cheap or cheap
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

    @property
    def offline(self) -> bool:
        return self.provider == "mock"
