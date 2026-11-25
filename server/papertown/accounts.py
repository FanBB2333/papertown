"""Which account an agent's CLI runs as, through CLIppet (github.com/FanBB2333/CLIppet). A CLIppet env is a folder
with its own logins and sessions, and `clippet -e <env> <cli> ...` starts that CLI's own terminal interface as the
env's account, so Papertown still only types into a real TUI.

The account is chosen in layers, like the skills: global, then project, then agent, the narrower winning. A layer
holds an env's name, "" for this machine's own login, or nothing to take the wider layer's choice. The layers are
kept in accounts.json in the data directory:

    {"global": "work", "projects": {"line_6": ""}, "agents": {"coder-line_6": "acct-b"}}
"""

from __future__ import annotations

import json
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import TYPE_CHECKING

from .db import read_json, write_json

if TYPE_CHECKING:
    from .town import Town

LAYERS = ("global", "project", "agent")
CLI = {"claude": "claude", "codex": "codex", "antigravity": "agy"}  # Papertown's provider -> CLIppet's agent name
TTL = 10  # seconds the env list is reused


class AccountError(Exception):
    pass


def _who(value) -> str | None:
    if isinstance(value, dict):
        return value.get("email") or value.get("label") or value.get("account_id")
    return value or None


class Accounts:
    def __init__(self, town: "Town"):
        self.town = town
        self.s = town.s
        self.bin = self.s.clippet_bin or shutil.which("clippet")
        self.path = self.s.data_dir / "accounts.json"
        self._lock = threading.Lock()
        self._cache: tuple[float, dict] | None = None

    def _run(self, *args: str) -> str:
        if not self.bin or not Path(self.bin).exists():
            raise AccountError("未找到 clippet。请运行 pip install \"clippet @ git+https://github.com/FanBB2333/CLIppet.git\"，"
                               "或在 papertown.toml 的 [services] 中设置 clippet_bin")
        try:
            r = subprocess.run([self.bin, *args], capture_output=True, text=True, timeout=20, cwd=self.s.data_dir)
        except (OSError, subprocess.TimeoutExpired) as e:
            raise AccountError(f"clippet 未运行完成：{type(e).__name__}") from e
        if r.returncode != 0:
            raise AccountError((r.stderr or r.stdout).strip()[:300] or f"clippet 退出码 {r.returncode}")
        return r.stdout

    def envs(self, fresh: bool = False) -> dict:
        """CLIppet's envs and whose logins they hold; ok False with a note when CLIppet is missing."""
        with self._lock:
            if not fresh and self._cache and time.time() - self._cache[0] < TTL:
                return self._cache[1]
        try:
            data = json.loads(self._run("env", "status", "--json") or "{}")
            envs = [{"name": name, "path": e.get("path"), "exists": bool(e.get("exists")), "type": e.get("type"),
                     "codex": e.get("codex_text") or _who(e.get("codex")), "agy": _who(e.get("agy")),
                     "description": e.get("description") or ""}
                    for name, e in sorted(data.items()) if isinstance(e, dict)]
            out = {"ok": True, "note": "", "bin": self.bin, "envs": envs}
        except (AccountError, ValueError) as e:
            out = {"ok": False, "note": str(e), "bin": self.bin, "envs": []}
        with self._lock:
            self._cache = (time.time(), out)
        return out

    def _read(self) -> dict:
        d = read_json(self.path, {})
        return {"global": d.get("global") if isinstance(d.get("global"), str) else None,
                "projects": d.get("projects") if isinstance(d.get("projects"), dict) else {},
                "agents": d.get("agents") if isinstance(d.get("agents"), dict) else {}}

    def layers(self, line_id: str | None = None, agent_id: str | None = None) -> dict:
        d = self._read()
        return {"global": d["global"], "project": d["projects"].get(line_id) if line_id else None,
                "agent": d["agents"].get(agent_id) if agent_id else None}

    def resolve(self, line_id: str | None = None, agent_id: str | None = None) -> dict:
        """The account a launch uses: {"env": name, or "" for this machine's own login, "scope": the layer that chose}."""
        got = {"env": "", "scope": "default"}
        for scope, value in self.layers(line_id, agent_id).items():
            if value is not None:
                got = {"env": value, "scope": scope}
        return got

    def set(self, scope: str, value: str | None, line_id: str | None = None, agent_id: str | None = None) -> None:
        """Choose an env (or "" for this machine's own login) in one layer, or clear the layer with None."""
        if scope not in LAYERS:
            raise AccountError(f"没有这个层：{scope}")
        if scope == "project" and not line_id or scope == "agent" and not agent_id:
            raise AccountError("项目层需指定项目，员工层需指定员工")
        if value and value not in {e["name"] for e in self.envs(fresh=True)["envs"]}:
            raise AccountError(f"CLIppet 中没有名为 {value} 的 env")
        with self._lock:
            d = self._read()
            if scope == "global":
                d["global"] = value
            else:
                table, key = (d["projects"], line_id) if scope == "project" else (d["agents"], agent_id)
                if value is None:
                    table.pop(key, None)
                else:
                    table[key] = value
            write_json(self.path, d)

    def view(self, line_id: str | None = None, agent_id: str | None = None) -> dict:
        return self.envs() | {"layers": self.layers(line_id, agent_id), "resolved": self.resolve(line_id, agent_id)}

    def launch(self, a: dict, provider: str) -> dict | None:
        """The env an agent's next launch runs in, {"env", "path"}, or None for this machine's own login."""
        env = self.resolve(a.get("line_id"), a["id"])["env"]
        if not env:
            return None
        if provider not in CLI:
            raise AccountError(f"CLIppet 无法切换 {provider} 的账号")
        found = next((e for e in self.envs(fresh=True)["envs"] if e["name"] == env), None)
        if not found:
            raise AccountError(self.envs()["note"] or f"CLIppet 中没有名为 {env} 的 env，请在账号设置中重新选择")
        return {"env": env, "path": found["path"]}

    def wrap(self, argv: list[str], provider: str, account: dict | None) -> list[str]:
        """`clippet -e <env> <cli> <the CLI's own arguments>`; CLIppet finds the CLI on PATH, where Papertown's link to
        the chosen executable comes first."""
        if not account:
            return argv
        return [str(self.bin), "-e", account["env"], CLI[provider], *argv[1:]]

    @staticmethod
    def home(default: str, account: dict | None) -> Path:
        """Where a CLI keeps its sessions inside the env: the same path below the env as below your home."""
        path = Path(default).expanduser()
        if not account or not account.get("path"):
            return path
        try:
            return Path(account["path"]) / path.relative_to(Path.home())
        except ValueError:
            return path
