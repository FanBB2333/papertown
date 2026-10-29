"""Provider-neutral conversation types. Each adapter converts them to its own wire format.

Assistant turns keep the provider's native content in `raw` so it can be replayed
unchanged (Claude's thinking blocks must come back exactly as they were sent).
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Callable, Literal


@dataclass
class ToolSpec:
    name: str
    description: str
    schema: dict


@dataclass
class ToolCall:
    id: str
    name: str
    args: dict


@dataclass
class ToolResult:
    call_id: str
    name: str
    content: str
    is_error: bool = False


@dataclass
class Turn:
    role: Literal["user", "assistant", "tool"]
    text: str = ""
    calls: list[ToolCall] = field(default_factory=list)
    results: list[ToolResult] = field(default_factory=list)
    raw: Any = None


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0


@dataclass
class Reply:
    text: str
    calls: list[ToolCall]
    usage: Usage
    stop: str = "end_turn"
    raw: Any = None


@dataclass
class ScriptHint:
    """What the scripted provider needs to act like an agent: the skills it may load,
    the tool plan those skills declare, how to fill arguments and the final answer.
    Real providers ignore it."""
    skills: list[str]
    plan: list[tuple[str, str]]  # (skill, allowed-tools entry), e.g. ("novelty-check", "run_script(verdict.py)")
    args: Callable[[str, dict], dict | None]  # (plan key, results so far) -> arguments, None to skip
    finish: str
    payload: Callable[[dict], dict]


class ProviderError(Exception):
    def __init__(self, message: str, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


class Provider(ABC):
    name: str = "base"

    @abstractmethod
    def complete(self, *, model: str, system: str, turns: list[Turn], tools: list[ToolSpec],
                 max_tokens: int = 8000, hint: ScriptHint | None = None) -> Reply: ...
