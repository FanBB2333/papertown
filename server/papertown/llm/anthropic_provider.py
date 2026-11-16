"""Claude through the official anthropic SDK; credentials come from ANTHROPIC_API_KEY or an `ant auth login` profile."""

from __future__ import annotations

import anthropic

from .base import Provider, ProviderError, Reply, ScriptHint, ToolCall, ToolSpec, Turn, Usage

# models that accept output_config.effort
EFFORT_MODELS = {"claude-fable-5-1", "claude-fable-5", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5",
                 "claude-sonnet-5", "claude-haiku-5-5", "claude-opus-4-8", "claude-opus-4-7"}
# models with server-side refusal fallback (`fallbacks: "default"`)
FALLBACK_MODELS = {"claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"}
FALLBACK_BETA = "server-side-fallback-2026-07-01"


class AnthropicProvider(Provider):
    name = "anthropic"

    def __init__(self, effort: str = "medium"):
        self.client = anthropic.Anthropic()
        self.effort = effort

    @staticmethod
    def _messages(turns: list[Turn]) -> list[dict]:
        out: list[dict] = []
        for t in turns:
            if t.role == "user":
                out.append({"role": "user", "content": t.text})
            elif t.role == "assistant":
                content = t.raw
                if content is None:
                    content = ([{"type": "text", "text": t.text}] if t.text else []) + [
                        {"type": "tool_use", "id": c.id, "name": c.name, "input": c.args} for c in t.calls]
                out.append({"role": "assistant", "content": content})
            else:
                out.append({"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": r.call_id, "content": r.content, "is_error": r.is_error}
                    for r in t.results]})
        return out

    def complete(self, *, model: str, system: str, turns: list[Turn], tools: list[ToolSpec],
                 max_tokens: int = 8000, hint: ScriptHint | None = None) -> Reply:
        kwargs: dict = {
            "model": model,
            "max_tokens": max_tokens,
            "system": system,
            "messages": self._messages(turns),
            "tools": [{"name": t.name, "description": t.description, "input_schema": t.schema} for t in tools],
        }
        if model in EFFORT_MODELS:
            kwargs["output_config"] = {"effort": self.effort}
        try:
            if model in FALLBACK_MODELS:
                resp = self.client.beta.messages.create(**kwargs, betas=[FALLBACK_BETA], fallbacks="default")
            else:
                resp = self.client.messages.create(**kwargs)
        except anthropic.BadRequestError as e:
            raise ProviderError(f"请求无效：{e.message}") from e
        except (anthropic.AuthenticationError, anthropic.PermissionDeniedError) as e:
            raise ProviderError("Claude API 凭证无效或权限不足") from e
        except anthropic.NotFoundError as e:
            raise ProviderError(f"模型不存在：{model}") from e
        except anthropic.RateLimitError as e:
            raise ProviderError("Claude API 限流，稍后重试", retryable=True) from e
        except anthropic.APIStatusError as e:
            raise ProviderError(f"Claude API 错误 {e.status_code}", retryable=e.status_code >= 500) from e
        except anthropic.APIConnectionError as e:
            raise ProviderError("连不上 Claude API，检查网络或代理", retryable=True) from e

        if resp.stop_reason == "refusal":
            raise ProviderError("模型拒绝了这个请求")
        text = "".join(b.text for b in resp.content if b.type == "text")
        calls = [ToolCall(b.id, b.name, dict(b.input or {})) for b in resp.content if b.type == "tool_use"]
        usage = Usage(resp.usage.input_tokens or 0, resp.usage.output_tokens or 0)
        return Reply(text=text, calls=calls, usage=usage, stop=resp.stop_reason or "end_turn", raw=resp.content)
