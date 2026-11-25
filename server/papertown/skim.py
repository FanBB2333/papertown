"""Every skill an agent gets comes from skim (github.com/FanBB2333/skim): the user's skills and the town's own
(server/skills, copied into skim's store), configured in global, project (projects/<line>/.skim/config) and session
(papertown-<agent id>) scopes, the narrower winning, applied into each agent's .papertown/skills.

A project starts with the town's skills switched on in its own scope, each one once: what the user changes there
later stays as it is.
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

TTL = 5  # seconds the store and environments are reused
SCOPES = ("global", "project", "session")
ROLES = ("lead", "coder", "writer")  # the project's agents that get skills; the assistant gets the global scope
OWNED = "skim-town.json"  # in the data directory: the town skills Papertown put into the store
OFFERED = "papertown-town.json"  # in a project's .skim: the town skills already switched on there once


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
            raise SkimError("没找到 skim：装好后放进 PATH，或者在 papertown.toml 的 [services] 里设 skim_bin")
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

    @staticmethod
    def _tree(d: Path) -> dict[str, bytes]:
        if not d.is_dir():
            return {}
        return {str(p.relative_to(d)): p.read_bytes() for p in sorted(d.rglob("*"))
                if p.is_file() and "__pycache__" not in p.parts and p.name != ".DS_Store"}

    def owned(self) -> set[str]:
        return set(read_json(self.s.data_dir / OWNED, []))

    def sync_town(self) -> list[dict]:
        """Put the town's skills into skim's store: one missing is added, one Papertown put there before is updated
        when it changed, and one of the user's with the same name is left alone (state "conflict")."""
        st = self.status(fresh=True)
        if not st["ok"]:
            return []
        store = {x["name"]: Path(x["path"]) for x in st["store"]}
        mine, out = self.owned(), []
        for sk in self.town.skills.all():
            name = sk.name
            if name in store and self._tree(sk.dir) == self._tree(store[name]):
                state = "synced"
            elif name in store and name not in mine:
                out.append({"name": name, "state": "conflict"})
                continue
            else:
                self._run("add", str(sk.dir))
                state = "updated" if name in store else "added"
            mine.add(name)
            out.append({"name": name, "state": state})
        write_json(self.s.data_dir / OWNED, sorted(mine))
        with self._lock:
            self._cache = None
        for ln in self.town.db.q("select id from lines where status != 'dropped'"):
            self.seed(ln["id"])
        return out

    def town_skills(self) -> list[dict]:
        """The town's skills and whether skim has them (for the academy)."""
        st = self.status()
        store, mine = {x["name"] for x in st["store"]}, self.owned()
        return [{"name": s.name, "description": s.description, "roles": s.roles,
                 "state": "synced" if s.name in mine else "conflict" if s.name in store else "missing"}
                for s in self.town.skills.all()]

    def seed(self, line_id: str) -> None:
        """Switch the town's skills on in the project's scope, each one once."""
        if not self.status()["ok"]:
            return
        record = self.project_dir(line_id) / ".skim" / OFFERED
        offered = set(read_json(record, []))
        todo = [n for n in sorted(self.owned()) if n not in offered and any(s.name == n for s in self.town.skills.all())]
        if not todo:
            return
        for name in todo:
            try:
                self._run("config", "--project", "--project-dir", str(self.project_dir(line_id)), f"skill.{name}.enabled", "true")
            except SkimError:
                return
            offered.add(name)
        record.parent.mkdir(parents=True, exist_ok=True)
        write_json(record, sorted(offered))

    def resolve(self, line_id: str | None = None, agent_id: str | None = None) -> dict:
        """Every skill in the store for this project or conversation, enabled or not and by which scope."""
        if line_id:
            self.seed(line_id)
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
        return self.town.agents.home(agent) / ".papertown" / "skills"

    def apply(self, agent: dict) -> dict:
        """Link the skills this conversation ends up with into its .papertown/skills."""
        return self._json("apply", "--target", str(self.skills_dir(agent)), *self._where(agent["line_id"], agent["id"]))

    def apply_all(self, line_id: str | None = None) -> None:
        """After a change: every agent the scope covers (all of them for the global one)."""
        if not self.status()["ok"]:
            return
        roles = ", ".join(f"'{r}'" for r in (*ROLES, *(() if line_id else ("assistant",))))
        rows = self.town.db.q(f"select * from agents where role in ({roles})" + (" and line_id = ?" if line_id else ""),
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
        where = "这个项目给你" if agent["line_id"] else "Papertown 给你"
        out = ["", "## 技能", f"{where}配了 {len(skills)} 个 skill（用 skim 分层配置：全局 → 项目 → 这段对话）。"
               "用到哪个就先读它的 SKILL.md，按里面写的做："]
        out += [f"- {s['name']}：{(s.get('description') or '').strip()[:160]}（{d / s['name'] / 'SKILL.md'}）" for s in skills]
        return out
