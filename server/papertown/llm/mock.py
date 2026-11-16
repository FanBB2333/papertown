"""Scripted provider for offline mode, tests and the demo: it loads each offered skill, calls the
tools the skill declares in `allowed-tools` in order through the real tools, then submits the answer
the stage builds from the results. Only the prose is templated.
"""

from __future__ import annotations

import json
import re
from itertools import count

from .base import Provider, Reply, ScriptHint, ToolCall, ToolSpec, Turn, Usage

ENTRY = re.compile(r"^([A-Za-z0-9_]+)(?:\((.*)\))?$")
_ids = count(1)


def parse_entry(entry: str) -> tuple[str, str | None]:
    m = ENTRY.match(entry.strip())
    return (m.group(1), m.group(2)) if m else (entry, None)


def plan_key(name: str, args: dict) -> str:
    field = {"load_skill": "name", "run_script": "script", "read_reference": "path"}.get(name)
    return f"{name}:{args.get(field, '')}" if field else name


def _load(content: str):
    try:
        return json.loads(content)
    except (TypeError, ValueError):
        return content


def collect(turns: list[Turn]) -> tuple[set[str], dict]:
    """Skills loaded so far, and tool results keyed by plan key."""
    calls: dict[str, ToolCall] = {}
    loaded: set[str] = set()
    results: dict = {}
    for t in turns:
        for c in t.calls:
            calls[c.id] = c
            if c.name == "load_skill":
                loaded.add(c.args.get("name", ""))
        for r in t.results:
            c = calls.get(r.call_id)
            if c and not r.is_error:
                results[plan_key(c.name, c.args)] = _load(r.content)
            elif c:
                results.setdefault(plan_key(c.name, c.args), None)
    return loaded, results


class ScriptedProvider(Provider):
    name = "mock"

    def complete(self, *, model: str, system: str, turns: list[Turn], tools: list[ToolSpec],
                 max_tokens: int = 8000, hint: ScriptHint | None = None) -> Reply:
        if hint is None:
            text = "离线模式下没有模型可以自由回答；接入 Claude 或 DeepSeek 后这里会给出真正的回复。"
            return self._reply(system, turns, text, None)
        available = {t.name for t in tools}
        loaded, results = collect(turns)

        for skill in [*hint.skills, ""]:  # "" holds plan entries that need no skill
            if skill and skill not in loaded and "load_skill" in available:
                return self._reply(system, turns, f"先读 {skill} 的说明。", ToolCall(self._id(), "load_skill", {"name": skill}))
            for sk, entry in hint.plan:
                if sk != skill:
                    continue
                name, inner = parse_entry(entry)
                if name not in available:
                    continue
                if name == "read_reference":
                    args = {"skill": sk, "path": inner or "SKILL.md"}
                elif name == "run_script":
                    a = hint.args(f"run_script:{inner}", results)
                    args = None if a is None else {"skill": sk, "script": inner, "args": a}
                else:
                    args = hint.args(name, results)
                if args is None or plan_key(name, args) in results:
                    continue
                return self._reply(system, turns, f"调用 {name}。", ToolCall(self._id(), name, args))

        payload = hint.payload(results)
        return self._reply(system, turns, "整理结果并提交。", ToolCall(self._id(), hint.finish, payload))

    @staticmethod
    def _id() -> str:
        return f"call_{next(_ids)}"

    @staticmethod
    def _reply(system: str, turns: list[Turn], text: str, call: ToolCall | None) -> Reply:
        seen = len(system) + sum(len(t.text) + sum(len(r.content) for r in t.results) for t in turns)
        out = len(text) + (len(json.dumps(call.args, ensure_ascii=False)) if call else 0)
        return Reply(text=text, calls=[call] if call else [], usage=Usage(seen // 4, out // 4),
                     stop="tool_use" if call else "end_turn")
