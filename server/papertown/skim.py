"""Skills per project and per conversation, configured with skim (github.com/FanBB2333/skim): global, project
(projects/<line>/.skim/config) and session (papertown-<agent id>) scopes, the narrower winning, applied into each
agent's .papertown/skills.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .town import Town

TTL = 5  # seconds the store and environments are reused
SCOPES = ("global", "project", "session")


class SkimError(Exception):
    pass


class Skim:
    def __init__(self, town: "Town"):
        self.town = town
        self.s = town.s
        self.bin = self.s.skim_bin or shutil.which("skim")
        self._lock = threading.Lock()
        self._cache: tuple[float, dict] | None = None

    def _run(self, *args: str) -> str:
        if not self.bin or not Path(self.bin).exists():
            raise SkimError("没找到 skim：装好后放进 PATH，或者设 PAPERTOWN_SKIM_BIN")
        try:
            # from the data directory, so skim does not pick up a project above the server's own
            r = subprocess.run([self.bin, *args], capture_output=True, text=True, timeout=30, cwd=self.s.data_dir)
        except (OSError, subprocess.TimeoutExpired) as e:
            raise SkimError(f"skim 没有跑完：{type(e).__name__}") from e
        if r.returncode != 0:
            raise SkimError((r.stderr or r.stdout).strip().removeprefix("Error: ")[:300] or f"skim 退出码 {r.returncode}")
        return r.stdout

    def _json(self, *args: str):
        return json.loads(self._run(*args, "--json"))

    def _where(self, line_id: str | None, agent_id: str | None) -> list[str]:
        out = []
        if line_id:
            out += ["--project-dir", str(self.project_dir(line_id))]
        if agent_id:
            out += ["--session-id", self.session_id(agent_id)]
        return out

    def project_dir(self, line_id: str) -> Path:
        d = self.s.projects_dir / line_id
        d.mkdir(parents=True, exist_ok=True)
        return d

    @staticmethod
    def session_id(agent_id: str) -> str:
        return f"papertown-{agent_id}"

    def status(self, fresh: bool = False) -> dict:
        """The store, the environments and the global scope; ok False with a note when skim is missing or not initialised."""
        with self._lock:
            if not fresh and self._cache and time.time() - self._cache[0] < TTL:
                return self._cache[1]
        try:
            if self.bin and Path(self.bin).exists() and not (Path.home() / ".skim").exists():
                raise SkimError("skim 还没初始化：在终端里运行 skim init")
            store = self._json("skill", "list")
            envs = self._json("env", "list")
            glob = self._json("config", "--list", "--global")
            out = {"ok": True, "note": "", "bin": self.bin, "store": store, "envs": envs,
                   "active_env": next((e["name"] for e in envs if e["active"]), None), "global": glob[0] if glob else None}
        except (SkimError, json.JSONDecodeError) as e:
            out = {"ok": False, "note": str(e), "bin": self.bin, "store": [], "envs": [], "active_env": None, "global": None}
        with self._lock:
            self._cache = (time.time(), out)
        return out

    def resolve(self, line_id: str | None = None, agent_id: str | None = None) -> dict:
        """Every skill in the store for this project or conversation, enabled or not and by which scope."""
        return self._json("resolve", "--all", *self._where(line_id, agent_id))

    def enabled(self, line_id: str, agent_id: str) -> list[dict]:
        try:
            return [s for s in self.resolve(line_id, agent_id)["skills"] if s["enabled"] and s["in_store"]]
        except (SkimError, json.JSONDecodeError):
            return []

    def set(self, scope: str, key: str, value: str | None, line_id: str | None = None, agent_id: str | None = None) -> None:
        """Set a key in one scope, or unset it with value None."""
        if scope not in SCOPES:
            raise SkimError(f"没有这个层：{scope}")
        if scope == "project" and not line_id or scope == "session" and not agent_id:
            raise SkimError("项目层要指定项目，对话层要指定对话")
        where = self._where(line_id if scope != "global" else None, agent_id if scope == "session" else None)
        if value is None:
            try:
                self._run("config", f"--{scope}", *where, "--unset", key)
            except SkimError as e:
                if "is not set" not in str(e):
                    raise
        else:
            self._run("config", f"--{scope}", *where, key, value)
        with self._lock:
            self._cache = None

    def skills_dir(self, agent: dict) -> Path:
        return self.town.agents._home(agent["line_id"], agent["role"]) / ".papertown" / "skills"

    def apply(self, agent: dict) -> dict:
        """Link the skills this conversation ends up with into its .papertown/skills."""
        return self._json("apply", "--target", str(self.skills_dir(agent)), *self._where(agent["line_id"], agent["id"]))

    def apply_all(self, line_id: str | None = None) -> None:
        """After a change: every agent the scope covers (all of them for the global one)."""
        if not self.status()["ok"]:
            return
        rows = self.town.db.q("select * from agents where role in ('coder', 'writer')" + (" and line_id = ?" if line_id else ""),
                              *([line_id] if line_id else []))
        for a in rows:
            try:
                self.apply(a)
            except (SkimError, json.JSONDecodeError):
                pass

    def brief(self, agent: dict) -> list[str]:
        """The skills section of an agent's brief, after applying them."""
        if not self.status()["ok"]:
            return []
        try:
            self.apply(agent)
        except (SkimError, json.JSONDecodeError):
            return []
        skills = self.enabled(agent["line_id"], agent["id"])
        if not skills:
            return []
        d = self.skills_dir(agent)
        out = ["", "## 技能", f"这个项目给你配了 {len(skills)} 个 skill（用 skim 分层配置：全局 → 项目 → 这段对话）。"
               "用到哪个就先读它的 SKILL.md，按里面写的做："]
        out += [f"- {s['name']}：{(s.get('description') or '').strip()[:160]}（{d / s['name'] / 'SKILL.md'}）" for s in skills]
        return out
