from __future__ import annotations

from ..config import Settings
from .base import Provider, ProviderError, Reply, ScriptHint, ToolCall, ToolResult, ToolSpec, Turn, Usage
from .pricing import cost

__all__ = ["Provider", "ProviderError", "Reply", "ScriptHint", "ToolCall", "ToolResult", "ToolSpec", "Turn",
           "Usage", "cost", "make_provider"]


def make_provider(s: Settings) -> Provider:
    if s.provider == "anthropic":
        from .anthropic_provider import AnthropicProvider
        return AnthropicProvider(effort=s.effort)
    if s.provider == "openai":
        from .openai_provider import OpenAICompatProvider
        return OpenAICompatProvider(s.openai_base_url, s.openai_api_key)
    from .mock import ScriptedProvider
    return ScriptedProvider()
