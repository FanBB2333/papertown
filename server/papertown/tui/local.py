"""What the TUI reads with the command-line tools itself rather than through the server: nvidb's GPUs
and jobs, skim's store, the town's skills, and a project's files and `git diff` when they are on this
machine. nvidb is always called with --no-tick and never submits, cancels or acknowledges anything."""

from __future__ import annotations

import asyncio
import json
import subprocess
import threading
from pathlib import Path
from types import SimpleNamespace

from ..config import Settings
from ..nvidb import Nvidb, as_farm_job, mentions
from ..skills import SkillRegistry
from ..skim import Skim
from ..workspace import WsError, list_files, read_file


class Local:
    def __init__(self) -> None:
        self.s = Settings()
        self.nvidb = Nvidb(self.s)
        self.skim = Skim(SimpleNamespace(s=self.s))
        self.skills = SkillRegistry(self.s.skills_dir)
        self._halt = threading.Event()

    def start(self) -> None:
        self.nvidb.start()
        if self.nvidb._usable():
            threading.Thread(target=self._keep_history, daemon=True, name="nvidb-history").start()

    def stop(self) -> None:
        self.nvidb.stop()
        self._halt.set()

    def _keep_history(self) -> None:
        """`nvidb job ls` takes seconds, so it is read ahead in a thread for the jobs page."""
        while not self._halt.is_set():
            self.nvidb.history()
            self._halt.wait(5)

    async def gpus(self, fresh: bool = False) -> dict:
        return await asyncio.to_thread(self.nvidb.status, fresh)

    @staticmethod
    def _match(ln: dict) -> list[str]:
        linked = ln.get("linked")
        return (linked.get("match") or []) if isinstance(linked, dict) else []

    async def nvidb_jobs(self, lines: list[dict], line_id: str | None = None) -> list[dict]:
        """Each linked project's jobs in nvidb's queue, found as the server finds them: by the names it matches."""
        def find() -> list[dict]:
            out: list[dict] = []
            for ln in lines:
                m = self._match(ln)
                if (not line_id or ln["id"] == line_id) and m:
                    out += [as_farm_job(j, ln["id"]) for j in self.nvidb.jobs_matching(m)]
            return out
        return await asyncio.to_thread(find)

    async def nvidb_job(self, nid: int, lines: list[dict], tail: int = 200) -> dict | None:
        """One job in full (`nvidb job show`), with the end of its output (`nvidb job logs`)."""
        j = await asyncio.to_thread(self.nvidb.show, nid)
        if not j:
            return None
        line = next((ln["id"] for ln in lines if mentions(j, self._match(ln))), None)
        return {**as_farm_job(j, line), "log": await self.nvidb_log(nid, tail)}

    async def nvidb_log(self, nid: int, tail: int = 200) -> str:
        if not self.nvidb._usable():
            return ""
        try:
            p = await asyncio.create_subprocess_exec(self.nvidb.bin, "job", "logs", str(nid), "-n", str(tail), "--no-tick", "--json",
                                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            out, _ = await asyncio.wait_for(p.communicate(), 15)
            if p.returncode != 0:
                return ""
            return (json.loads(out) or {}).get("log") or ""
        except (OSError, asyncio.TimeoutError, json.JSONDecodeError, ValueError):
            return ""

    async def town_skills(self) -> list[dict]:
        def read() -> list[dict]:
            self.skills.refresh()
            return [s.summary() for s in self.skills.all()]
        return await asyncio.to_thread(read)

    async def skim_store(self, fresh: bool = False) -> dict:
        return await asyncio.to_thread(self.skim.status, fresh)

    @staticmethod
    def here(path: str | None) -> Path | None:
        """a workspace's directory, when it is on this machine"""
        p = Path(path).expanduser() if path else None
        return p if p and p.is_dir() else None

    async def ws_tree(self, path: str, press: bool = False) -> dict | None:
        root = self.here(path)
        return await asyncio.to_thread(list_files, root, press) if root else None

    async def ws_read(self, path: str, rel: str) -> dict | None:
        root = self.here(path)
        if not root:
            return None
        try:
            return await asyncio.to_thread(read_file, root, rel)
        except WsError as e:
            return {"path": rel, "error": str(e)}

    async def git_diff(self, root: str, rel: str) -> str:
        """`git diff` of one file, read straight from the repository on this machine."""
        base = Path(root).expanduser()
        parts = Path(rel).parts
        if not rel or rel.startswith(("/", "~")) or ".." in parts or not (base / ".git").exists():
            return ""
        try:
            p = await asyncio.create_subprocess_exec("git", "--no-optional-locks", "-C", str(base), "diff", "--no-color", "--", rel,
                                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            out, _ = await asyncio.wait_for(p.communicate(), 15)
        except (OSError, asyncio.TimeoutError):
            return ""
        return out.decode("utf-8", "replace")[:200_000] if p.returncode == 0 else ""
