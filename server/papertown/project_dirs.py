"""Shared directory ownership for terminal grouping and session accounting."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .town import Town


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
