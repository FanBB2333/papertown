"""Settings for local agents and the town services.

Each setting comes from, in order: an environment variable (PAPERTOWN_<NAME>), the config file papertown.toml at the
root of the checkout (or wherever PAPERTOWN_CONFIG points), then the default here. papertown.example.toml lists every
setting with its default (`papertown config example` writes it). The web settings write back to the same file
(set_config), keeping whatever else is in it.
"""

from __future__ import annotations

import json
import os
import re
import tomllib
from dataclasses import MISSING, dataclass, field, fields
from pathlib import Path
from typing import Any

SERVER_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = SERVER_DIR.parent

# the one place the server's address has a default; everything else reads it from here or from papertown.toml
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 31640


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def config_path() -> Path:
    """papertown.toml: PAPERTOWN_CONFIG, else at the root of the checkout."""
    return Path(_env("PAPERTOWN_CONFIG") or REPO_DIR / "papertown.toml").expanduser()


_cache: dict[Path, tuple[float, dict]] = {}


def read_config(path: Path | None = None) -> dict:
    """The config file as tables; {} when there is none. Read again when it changes."""
    path = path or config_path()
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return {}
    hit = _cache.get(path)
    if not hit or hit[0] != mtime:
        with path.open("rb") as f:
            hit = (mtime, tomllib.load(f))
        _cache[path] = hit
    return hit[1]


def _toml(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(_toml(v) for v in value) + "]"
    return json.dumps(str(value), ensure_ascii=False)  # a TOML basic string


def set_config(section: str, values: dict[str, Any], path: Path | None = None) -> None:
    """Write these keys into [section] of the config file, line by line: other tables, keys and comments stay."""
    path = path or config_path()
    lines = path.read_text().splitlines() if path.exists() else []
    head = re.compile(r"^\s*\[\s*([^\]\s]+)\s*\]")
    start = next((i for i, l in enumerate(lines) if (m := head.match(l)) and m.group(1) == section), None)
    if start is None:
        if lines and lines[-1].strip():
            lines.append("")
        lines.append(f"[{section}]")
        start = len(lines) - 1
    end = next((i for i in range(start + 1, len(lines)) if head.match(lines[i])), len(lines))
    for key, value in values.items():
        line = f"{key} = {_toml(value)}"
        at = next((i for i in range(start + 1, end) if re.match(rf"^\s*{re.escape(key)}\s*=", lines[i])), None)
        if at is None:
            last = max((i for i in range(start, end) if lines[i].strip()), default=start)
            lines.insert(last + 1, line)
            end += 1
        else:
            lines[at] = line
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text("\n".join(lines) + "\n")
    os.chmod(tmp, 0o600)
    tmp.replace(path)
    _cache.pop(path, None)


def _cast(raw: Any, default: Any) -> Any:
    if isinstance(default, str) and isinstance(raw, (dict, list)):
        return json.dumps(raw)  # a table in the file, for a setting kept as JSON (prices)
    if isinstance(default, bool):
        return raw if isinstance(raw, bool) else str(raw).strip().lower() not in ("0", "false", "no", "off")
    if isinstance(default, int):
        return int(raw)
    if isinstance(default, float):
        return float(raw)
    if isinstance(default, Path):
        return Path(str(raw)).expanduser()
    return str(raw)


def opt(section: str, key: str, default: Any, doc: str, env: str | None = None) -> Any:
    """A setting: the environment variable (PAPERTOWN_<KEY> unless named), else [section] key in papertown.toml,
    else the default. `doc` is its line in papertown.example.toml."""
    name = env or f"PAPERTOWN_{key.upper()}"

    def get() -> Any:
        raw = os.environ.get(name, "").strip()
        if raw:
            return _cast(raw, default)
        value = read_config().get(section, {}).get(key)
        if value is None:
            return default
        value = _cast(value, default)
        # a relative path in the file is relative to the file
        return config_path().parent / value if isinstance(value, Path) and not value.is_absolute() else value

    return field(default_factory=get, metadata={"section": section, "key": key, "env": name, "default": default, "doc": doc})


@dataclass
class Settings:
    # [server]
    host: str = opt("server", "host", DEFAULT_HOST, "where `papertown serve` listens: 127.0.0.1 (this machine only) or 0.0.0.0 (all networks)")
    port: int = opt("server", "port", DEFAULT_PORT, "its port")
    url: str = opt("server", "url", "", "how agents on this machine reach the server; empty: http://127.0.0.1:<port>")
    data_dir: Path = opt("server", "data_dir", SERVER_DIR / "var", "projects, the library, logins and keys")
    skills_dir: Path = opt("server", "skills_dir", SERVER_DIR / "skills", "the skills agents are given")
    projects: str = opt("server", "projects", "", "your own projects, linked in from local repos (linked.py); empty: projects.json in the data directory")
    samples: bool = opt("server", "samples", True, "put the sample projects in the first time the town starts empty")
    local_jobs: int = opt("server", "local_jobs", 2, "local job runner: how many commands run at once")
    local_job_timeout: float = opt("server", "local_job_timeout", 3600.0, "seconds a local job may run before it is stopped; 0: no limit")

    # [agents]
    agent_runtime: str = opt("agents", "agent_runtime", "paseo", "where new agents and leads run until chosen in settings: paseo, herdr, tmux or headless")
    assistant_model: str = opt("agents", "assistant_model", "codex/gpt-6.1-terra@xhigh", "what the assistant starts with on Paseo until chosen in settings: provider/model@thinking")
    lead_model: str = opt("agents", "lead_model", "codex/gpt-6.1-terra@high", "what project leads start with")
    worker_model: str = opt("agents", "worker_model", "", "what a coder or a writer starts on when its lead hires it; empty: the lead's")
    lead_resident: bool = opt("agents", "lead_resident", True, "each project in progress keeps its lead running (false: leads start only by hand)")
    lead_tick: float = opt("agents", "lead_tick", 20.0, "seconds between the leads' looks at their projects")
    lead_gap: float = opt("agents", "lead_gap", 180.0, "and at least between two check-ins")
    check_tick: float = opt("agents", "check_tick", 120.0, "seconds between looks at what each project's hard checks read")
    claude_bin: str = opt("agents", "claude_bin", "", "the claude CLI; empty: found on PATH")
    codex_bin: str = opt("agents", "codex_bin", "", "the codex CLI; empty: found on PATH")
    pi_bin: str = opt("agents", "pi_bin", "", "pi; pi agents use pi's own model settings and login")
    pi_model: str = opt("agents", "pi_model", "", "the model pi agents start on")
    agy_bin: str = opt("agents", "agy_bin", "", "the Antigravity CLI")

    # [paseo]
    paseo_bin: str = opt("paseo", "paseo_bin", "", "Paseo's CLI; empty: found on PATH")
    paseo_url: str = opt("paseo", "paseo_url", "http://127.0.0.1:6767", "the web app Paseo serves")
    paseo_host: str = opt("paseo", "paseo_host", "", "an explicit daemon endpoint")
    paseo_watch: float = opt("paseo", "paseo_watch", 1800.0, "seconds between readings of Paseo's model list for new models; 0 turns them off")
    node_bin: str = opt("paseo", "node_bin", "", "node, which reads the conversations through Paseo's SDK; empty: found on PATH, else the one in Paseo.app")

    # [terminal]
    tmux_bin: str = opt("terminal", "tmux_bin", "", "tmux; empty: found on PATH")
    tmux_socket: str = opt("terminal", "tmux_socket", "papertown", "the tmux socket agents run on")
    herdr: bool = opt("terminal", "herdr", True, "read existing herdr terminals over its socket (never starts the host)")
    herdr_socket: str = opt("terminal", "herdr_socket", "~/.config/herdr/herdr.sock", "herdr's socket")
    terminal_still: float = opt("terminal", "terminal_still", 15.0, "seconds of a still screen after which a working terminal agent counts as waiting on a dialog")
    terminal_startup: float = opt("terminal", "terminal_startup", 20.0, "how long herdr gets to start a CLI in a new tab, and the window for finding a new Codex session's log")
    terminal_ready: float = opt("terminal", "terminal_ready", 5.0, "seconds of a still screen after which a start counts as held by a dialog")
    terminal_settle: float = opt("terminal", "terminal_settle", 2.0, "after Papertown sends Esc, a screen still this long means the agent has stopped")

    # [history]
    claude_home: str = opt("history", "claude_home", "~/.claude", "where Claude Code keeps its conversations, for importing (history.py)")
    codex_home: str = opt("history", "codex_home", "~/.codex", "where Codex keeps them")
    antigravity_home: str = opt("history", "antigravity_home", "~/.gemini/antigravity-cli", "where Antigravity keeps them")
    transcripts: bool = opt("history", "transcripts", True, "read the agents' transcripts")
    usage_logs: bool = opt("history", "usage_logs", True, "read the CLIs' usage logs")
    usage_poll: float = opt("history", "usage_poll", 300.0, "seconds between readings of usage")
    prices: str = opt("history", "prices", "", 'model prices for the usage figures, added to pricing.py\'s: a table such as { "deepseek-chat" = [0.27, 1.1] } (or the same as JSON), USD per million tokens (input, output[, cache read])')

    # [services]
    arxiv_port: bool = opt("services", "arxiv_port", True, "the arXiv dock (false: no network, as in tests)", env="PAPERTOWN_ARXIV")
    arxiv_api: str = opt("services", "arxiv_api", "https://export.arxiv.org/api/query", "the arXiv API the dock and `papertown ingest` search")
    s2_api: str = opt("services", "s2_api", "https://api.semanticscholar.org/graph/v1/paper/batch", "Semantic Scholar's paper batch endpoint, for the citation edges of `papertown ingest --refs`")
    s2_key: str = opt("services", "s2_key", "", "a Semantic Scholar API key, optional (without one, requests are often turned away); the environment is the better place for it", env="S2_API_KEY")
    compile_tex: bool = opt("services", "compile_tex", True, "compile the papers' LaTeX")
    latexmk_bin: str = opt("services", "latexmk_bin", "", "latexmk, which compiles them; empty: found on PATH")
    mcp_config: str = opt("services", "mcp_config", "", "extra MCP servers: a JSON file in the Claude Desktop format {\"mcpServers\": {...}}")
    nvidb: bool = opt("services", "nvidb", True, "nvidb's GPU queue, read only: the cards on your machines and their jobs")
    nvidb_bin: str = opt("services", "nvidb_bin", "", "nvidb; empty: found on PATH")
    nvidb_poll: float = opt("services", "nvidb_poll", 10.0, "seconds between background readings of nvidb")
    skim_bin: str = opt("services", "skim_bin", "", "skim, the skill manager (skim.py)")

    # the file the settings above came from; Settings › Network & security writes to it
    config_file: Path = field(default_factory=config_path)
    # parts of the checkout
    web_dist: Path = field(default_factory=lambda: REPO_DIR / "web" / "dist")
    manifest: Path = field(default_factory=lambda: REPO_DIR / "assets" / "manifest.json")

    def paseo_default(self, role: str) -> dict:
        """The provider, model and thinking an agent of this role starts with: the assistant, a lead, or a worker
        (a coder or a writer, which follows the lead unless PAPERTOWN_WORKER_MODEL names its own)."""
        spec = self.assistant_model if role == "assistant" else self.lead_model if role == "lead" else self.worker_model or self.lead_model
        provider, _, rest = spec.partition("/")
        model, _, thinking = rest.partition("@")
        return {"provider": provider or None, "model": model or None, "thinking": thinking or None}

    def __post_init__(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        if not self.url:
            self.url = f"http://127.0.0.1:{self.port}"

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


def example() -> str:
    """papertown.example.toml: every setting under its table, commented out at its default, with what it does."""
    out = ["# Papertown's settings. Copy this file to papertown.toml at the root of the checkout (or point",
           "# PAPERTOWN_CONFIG at another), then uncomment and change what you need; the rest keeps its default.",
           "# An environment variable PAPERTOWN_<NAME> overrides a line here. Relative paths are relative to this file.",
           "# Settings › Network & security in the web app writes [server] host and port and the [network] table here."]
    section = None
    for f in fields(Settings):
        meta = f.metadata
        if not meta:
            continue
        if meta["section"] != section:
            section = meta["section"]
            out += ["", f"[{section}]"]
        default = meta["default"]
        if isinstance(default, Path) and default.is_relative_to(REPO_DIR):
            default = str(default.relative_to(REPO_DIR))
        out += [f"# {meta['doc']} ({meta['env']})", f"# {meta['key']} = {_toml(default)}"]
    from .network import NETWORK_DOCS
    out += ["", "[network]"]
    for key, (default, doc) in NETWORK_DOCS.items():
        out += [f"# {doc}", f"# {key} = {_toml(default)}"]
    return "\n".join(out) + "\n"
