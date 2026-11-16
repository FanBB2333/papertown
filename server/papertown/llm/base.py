"""Provider-neutral conversation types that each adapter converts to its own wire format.

Assistant turns keep the provider's native content in `raw`: Claude's thinking blocks must be replayed exactly.
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
    """What the scripted provider needs to act like an agent (real providers ignore it): the skills it
    may load, the plan as (skill, allowed-tools entry) pairs, args(plan key, results so far) giving a
    call's arguments or None to skip it, and the finishing tool with its payload."""
    skills: list[str]
    plan: list[tuple[str, str]]
    args: Callable[[str, dict], dict | None]
    finish: str
    payload: Callable[[dict], dict]


class ProviderError(Exception):
    def __init__(self, message: str, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


class Provider(ABC):
    name: str

    @abstractmethod
    def complete(self, *, model: str, system: str, turns: list[Turn], tools: list[ToolSpec],
                 max_tokens: int = 8000, hint: ScriptHint | None = None) -> Reply: ...
