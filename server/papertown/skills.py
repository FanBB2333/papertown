"""Skill registry: each worker skill is a folder with a SKILL.md (Agent Skills format; frontmatter name, description,
allowed-tools, metadata.roles), references/*.md and scripts/*.py (JSON on stdin and stdout). Rescanned before every run.
"""

from __future__ import annotations

import json
import subprocess
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path

import yaml


@dataclass
class Skill:
    name: str
    description: str
    roles: list[str]
    allowed: list[str]  # allowed-tools entries, in order
    path: Path
    mtime: float
    body: str = field(repr=False, default="")

    @property
    def dir(self) -> Path:
        return self.path.parent

    def files(self, sub: str) -> list[str]:
        d = self.dir / sub
        return sorted(str(p.relative_to(self.dir)) for p in d.rglob("*") if p.is_file()) if d.is_dir() else []

    def summary(self) -> dict:
        return {"name": self.name, "description": self.description, "roles": self.roles,
                "allowed_tools": self.allowed, "references": self.files("references"), "scripts": self.files("scripts")}


def parse(path: Path) -> Skill:
    text = path.read_text(encoding="utf-8")
    meta, body = {}, text
    if text.startswith("---"):
        _, fm, body = text.split("---", 2)
        meta = yaml.safe_load(fm) or {}
    roles = str((meta.get("metadata") or {}).get("roles", "")).replace(",", " ").split()
    return Skill(name=str(meta.get("name") or path.parent.name), description=str(meta.get("description", "")).strip(),
                 roles=roles, allowed=str(meta.get("allowed-tools", "")).split(), path=path,
                 mtime=path.stat().st_mtime, body=body.strip())


class SkillError(Exception):
    pass


class SkillRegistry:
    def __init__(self, root: Path):
        self.root = root
        self._skills: dict[str, Skill] = {}
        self._lock = threading.Lock()
        self.refresh()

    def refresh(self) -> tuple[list[str], list[str]]:
        """Rescan the folder. Returns (added, removed) skill names."""
        with self._lock:
            found: dict[str, Skill] = {}
            for p in sorted(self.root.glob("*/SKILL.md")):
                old = next((s for s in self._skills.values() if s.path == p), None)
                try:
                    s = old if old and old.mtime == p.stat().st_mtime else parse(p)
                except (OSError, ValueError, yaml.YAMLError):
                    continue  # a half-written SKILL.md is picked up on the next scan
                found[s.name] = s
            added = sorted(found.keys() - self._skills.keys())
            removed = sorted(self._skills.keys() - found.keys())
            self._skills = found
            return added, removed

    def all(self) -> list[Skill]:
        return list(self._skills.values())

    def get(self, name: str) -> Skill:
        s = self._skills.get(name)
        if not s:
            raise SkillError(f"没有叫 {name} 的 skill；可用的有：{', '.join(self._skills) or '无'}")
        return s

    def for_role(self, role: str) -> list[Skill]:
        return [s for s in self._skills.values() if role in s.roles]

    def _inside(self, s: Skill, rel: str, sub: str) -> Path:
        p = (s.dir / rel).resolve()
        base = (s.dir / sub).resolve()
        if base not in p.parents or not p.is_file():
            raise SkillError(f"{s.name} 里没有 {rel}；可读的文件：{', '.join(s.files(sub)) or '无'}")
        return p

    def reference(self, name: str, rel: str) -> str:
        s = self.get(name)
        if rel in ("SKILL.md", ""):
            return s.body
        return self._inside(s, rel if "/" in rel else f"references/{rel}", "references").read_text(encoding="utf-8")

    def run_script(self, name: str, script: str, args: dict, timeout: float = 60) -> object:
        """Scripts are a whitelist by construction: only .py files under the skill's scripts/."""
        s = self.get(name)
        p = self._inside(s, script if "/" in script else f"scripts/{script}", "scripts")
        if p.suffix != ".py":
            raise SkillError("只能运行 .py 脚本")
        r = subprocess.run([sys.executable, "-I", str(p)], input=json.dumps(args, ensure_ascii=False),
                           capture_output=True, text=True, timeout=timeout, cwd=s.dir)
        if r.returncode != 0:
            raise SkillError(f"{script} 运行失败：{r.stderr.strip()[-600:]}")
        try:
            return json.loads(r.stdout)
        except ValueError:
            return r.stdout.strip()
