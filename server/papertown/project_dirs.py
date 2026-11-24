"""Shared directory ownership for terminal grouping and session accounting."""

from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .town import Town


def branch(cwd: str | Path | None) -> str | None:
    """The branch checked out where a CLI works, read from the repository's HEAD (a worktree's .git file points at its
    own); a detached HEAD gives its short commit."""
    if not cwd:
        return None
    try:
        here = Path(cwd).expanduser()
        for folder in (here, *list(here.parents)[:8]):
            git = folder / ".git"
            if git.is_file():
                line = git.read_text(encoding="utf-8").strip()
                if not line.startswith("gitdir:"):
                    return None
                git = folder / line[7:].strip()
            if git.is_dir():
                head = (git / "HEAD").read_text(encoding="utf-8").strip()
                if head.startswith("ref: refs/heads/"):
                    return head[16:] or None
                return head[:7] or None
    except (OSError, ValueError):
        return None
    return None


_repos: dict[str, tuple[float, dict | None]] = {}


def repo(cwd: str | Path | None) -> dict | None:
    """Where a CLI works, as a status line shows it: the branch, how many files have changed (untracked ones too) and
    how far it is ahead of and behind its upstream. Read with `git status` at most every ten seconds a folder, without
    git's optional locks so it never holds up the agent's own git; the branch alone when git cannot answer."""
    name = branch(cwd)
    if not name:
        return None
    key, at = str(cwd), time.monotonic()
    hit = _repos.get(key)
    if hit and at - hit[0] < 10 and hit[1] and hit[1]["branch"] == name:
        return hit[1]
    out = {"branch": name, "changed": None, "ahead": None, "behind": None}
    try:
        run = subprocess.run(["git", "-C", key, "status", "--porcelain=v2", "--branch"], capture_output=True, text=True,
                             timeout=3, env=os.environ | {"GIT_OPTIONAL_LOCKS": "0"})
        if run.returncode == 0:
            changed = 0
            for line in run.stdout.splitlines():
                if line.startswith("# branch.ab "):
                    ahead, behind = line.split()[2:4]
                    out["ahead"], out["behind"] = int(ahead), abs(int(behind))
                elif line and not line.startswith("#"):
                    changed += 1
            out["changed"] = changed
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    if len(_repos) >= 256:
        _repos.clear()
    _repos[key] = (at, out)
    return out


def project_roots(town: Town, lines: list[dict] | None = None, agents: list[dict] | None = None) -> list[tuple[Path, str]]:
    lines = lines if lines is not None else town.db.q("select id from lines order by seq desc")
    agents = agents if agents is not None else town.db.q("select line_id, cwd from agents")
    registered = {p["key"]: p for p in town.linked.config()}
    roots = []
    for line in lines:
        lid = line["id"]
        linked = town.linked.of(lid) or {}
        dirs = [town.s.projects_dir / lid / "code", town.s.press_dir / lid]
        for config in (linked, registered.get(linked.get("key"), {})):
            dirs += [config[k] for k in ("code", "paper") if config.get(k)]
        dirs += [a["cwd"] for a in agents if a.get("line_id") == lid and a.get("cwd")]
        roots.extend((Path(d).expanduser().resolve(), lid) for d in dirs)
    # The most specific directory wins, with stable project order for ties.
    return sorted(roots, key=lambda pair: len(pair[0].parts), reverse=True)


def owner(cwd: str | None, roots: list[tuple[Path, str]]) -> str | None:
    path = Path(cwd).expanduser().resolve() if cwd else None
    return next((lid for root, lid in roots if path and path.is_relative_to(root)), None)
