"""What the TUI reads with the command-line tools themselves, the way the server does, rather than
asking the server for it: nvidb's GPUs, lanes, jobs and logs (always --no-tick: nothing here ever
submits, cancels, acknowledges or contacts a node), skim's skill store, the town's own skills as
`papertown skills` lists them, and `git diff` in a workspace. What only the town knows (its projects,
staff, messages, the farm's own jobs) still comes from the server."""

from __future__ import annotations

import asyncio
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

from ..config import Settings
from ..nvidb import Nvidb, as_farm_job
from ..skills import SkillRegistry
from ..skim import Skim


class Local:
    def __init__(self) -> None:
        self.s = Settings()
        self.nvidb = Nvidb(self.s)  # keeps its own trend of each card, from its own readings
        self.skim = Skim(SimpleNamespace(s=self.s))
        self.skills = SkillRegistry(self.s.skills_dir)

    def start(self) -> None:
        self.nvidb.start()  # `nvidb queue status --json --no-tick` every few seconds, as long as the TUI runs

    def stop(self) -> None:
        self.nvidb.stop()

    # ---------- nvidb ----------

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
                if (not line_id or ln["id"] == line_id) and self._match(ln):
                    out += [as_farm_job(j, ln["id"]) for j in self.nvidb.jobs_matching(self._match(ln))]
            return out
        return await asyncio.to_thread(find)

    async def nvidb_job(self, nid: int, lines: list[dict], tail: int = 200) -> dict | None:
        """One job in full (`nvidb job show`), with the end of its output (`nvidb job logs`)."""
        j = await asyncio.to_thread(self.nvidb.show, nid)
        if not j:
            return None
        hay = " ".join(str(j.get(k) or "") for k in ("workdir", "name", "submitter", "notes", "command")).lower()
        line = next((ln["id"] for ln in lines if any(p.lower() in hay for p in self._match(ln) if p)), None)
        return {**as_farm_job(j, line), "log": await self.nvidb_log(nid, tail)}

    async def nvidb_log(self, nid: int, tail: int = 200) -> str:
        if not self.nvidb._usable():
            return ""
        try:
            p = await asyncio.create_subprocess_exec(self.nvidb.bin, "job", "logs", str(int(nid)), "-n", str(tail), "--no-tick", "--json",
                                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            out, _ = await asyncio.wait_for(p.communicate(), 15)
            if p.returncode != 0:
                return ""
            return (json.loads(out) or {}).get("log") or ""
        except (OSError, asyncio.TimeoutError, json.JSONDecodeError, ValueError):
            return ""

    # ---------- skills ----------

    async def town_skills(self) -> list[dict]:
        def read() -> list[dict]:
            self.skills.refresh()
            return [s.summary() for s in self.skills.all()]
        return await asyncio.to_thread(read)

    async def skim_store(self, fresh: bool = False) -> dict:
        return await asyncio.to_thread(self.skim.status, fresh)

    # ---------- git ----------

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
