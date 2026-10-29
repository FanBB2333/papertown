"""Any OpenAI-compatible chat endpoint (DeepSeek, Qwen/DashScope, a local vLLM ...).

    PAPERTOWN_PROVIDER=openai
    PAPERTOWN_OPENAI_BASE_URL=https://api.deepseek.com
    PAPERTOWN_OPENAI_API_KEY=...        # from ~/.secrets.zsh, never from a file in the repo
"""

from __future__ import annotations

import json

import openai

from .base import Provider, ProviderError, Reply, ScriptHint, ToolCall, ToolSpec, Turn, Usage


class OpenAICompatProvider(Provider):
    name = "openai"

    def __init__(self, base_url: str, api_key: str):
        self.client = openai.OpenAI(base_url=base_url, api_key=api_key)

    @staticmethod
    def _messages(system: str, turns: list[Turn]) -> list[dict]:
        out: list[dict] = [{"role": "system", "content": system}]
        for t in turns:
            if t.role == "user":
                out.append({"role": "user", "content": t.text})
            elif t.role == "assistant":
                m: dict = {"role": "assistant", "content": t.text or None}
                if t.calls:
                    m["tool_calls"] = [{"id": c.id, "type": "function",
                                        "function": {"name": c.name, "arguments": json.dumps(c.args, ensure_ascii=False)}}
                                       for c in t.calls]
                out.append(m)
            else:
                out.extend({"role": "tool", "tool_call_id": r.call_id, "content": r.content} for r in t.results)
        return out

    def complete(self, *, model: str, system: str, turns: list[Turn], tools: list[ToolSpec],
                 max_tokens: int = 8000, hint: ScriptHint | None = None) -> Reply:
        try:
            resp = self.client.chat.completions.create(
                model=model,
                max_tokens=max_tokens,
                messages=self._messages(system, turns),
                tools=[{"type": "function", "function": {"name": t.name, "description": t.description,
                                                         "parameters": t.schema}} for t in tools],
            )
        except openai.AuthenticationError as e:
            raise ProviderError("模型 API 凭证无效") from e
        except openai.RateLimitError as e:
            raise ProviderError("模型 API 限流，稍后重试", retryable=True) from e
        except openai.APIStatusError as e:
            raise ProviderError(f"模型 API 错误 {e.status_code}", retryable=e.status_code >= 500) from e
        except openai.APIConnectionError as e:
            raise ProviderError("连不上模型 API，检查网络或代理", retryable=True) from e

        msg = resp.choices[0].message
        calls = []
        for c in msg.tool_calls or []:
            try:
                args = json.loads(c.function.arguments or "{}")
            except json.JSONDecodeError:
                args = {"_invalid_json": c.function.arguments}
            calls.append(ToolCall(c.id, c.function.name, args if isinstance(args, dict) else {"value": args}))
        u = resp.usage
        usage = Usage(getattr(u, "prompt_tokens", 0) or 0, getattr(u, "completion_tokens", 0) or 0)
        return Reply(text=msg.content or "", calls=calls, usage=usage, stop=resp.choices[0].finish_reason or "stop")
