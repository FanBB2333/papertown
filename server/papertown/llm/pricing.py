"""USD per million tokens (input, output[, cache read]), which the bank prices every call with. Models
not listed cost 0 until set, e.g. PAPERTOWN_PRICES='{"deepseek-chat": [0.27, 1.1]}'. A cache read costs a
tenth of the input price unless the third value says otherwise.
"""

from __future__ import annotations

import json
import os
import re

from .base import Usage

PRICES: dict[str, tuple[float, ...]] = {
    "claude-fable-5-2": (8.0, 40.0, 0.20),
    "claude-fable-5-1": (10.0, 50.0, 0.25),
    "claude-fable-5": (10.0, 50.0, 1.0),
    "claude-opus-5-5": (4.0, 20.0, 0.20),
    "claude-opus-5": (5.0, 25.0),
    "claude-sonnet-5-5": (2.0, 10.0, 0.10),
    "claude-haiku-5-5": (0.10, 0.50),
    # Standard rates up to 272K input tokens, checked 2026-11-22, used for local session cost estimates.
    # https://developers.openai.com/api/docs/pricing
    "gpt-5": (1.25, 10), "gpt-5-codex": (1.25, 10),
    "gpt-5.1": (1.25, 10), "gpt-5.1-codex": (1.25, 10), "gpt-5.1-codex-max": (1.25, 10),
    "gpt-5.2": (1.75, 14), "gpt-5.2-codex": (1.75, 14), "gpt-5.3-codex": (1.75, 14),
    "gpt-5.6-luna": (0.20, 1.20, 0.02), "gpt-6-luna": (0.10, 0.50, 0.01),
    "gpt-6-astra": (10, 50, 1.0), "gpt-6.1-sol": (2, 10, 0.10), "gpt-6.1-terra": (1, 5, 0.05),
    "gpt-6.2-astra": (8, 40, 0.40), "gpt-6.2-sol": (2, 10, 0.10),
    # Codex's approval reviewer, free when Codex signs in with ChatGPT.
    # https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan
    "codex-auto-review": (0, 0, 0),
    # https://ai.google.dev/gemini-api/docs/pricing, checked 2026-11-22
    "gemini-2.5-pro": (1.25, 10), "gemini-2.5-flash": (0.30, 2.50),
    "gemini-2.5-flash-lite": (0.10, 0.40), "gemini-4-neon": (3, 15, 0.15),
    "gemini-4-hydrogen": (1.5, 7.5, 0.075),
    # Promotional rates: Argon and Carbon until 2026-11-30, then $4 / $20 with $0.20 cache reads,
    # 3.8 Flash until 2026-12-31, then $1.50 / $7.50 with $0.15. PAPERTOWN_PRICES can override them.
    "gemini-4-carbon": (2, 10, 0.10), "gemini-4-argon": (2, 10, 0.10), "gemini-3.8-flash": (.75, 3.75),
}

def token_cost(model: str, tokens: dict[str, int]) -> tuple[float, bool]:
    """Price disjoint categories in USD; unknown models retain tokens, with no invented price."""
    name = model.lower().replace(" ", "-")
    if name.startswith("claude"):
        name = re.sub(r"(\d)\.(\d)", r"\1-\2", name)
    name = re.sub(r"-(?:low|medium|high|xhigh|thinking)$", "", name)
    price = PRICES.get(model, PRICES.get(name))
    if price is None:
        return 0.0, False
    p_in, p_out = price[:2]
    p_read = price[2] if len(price) > 2 else .1 * p_in
    hour = tokens.get("cache_write_1h", 0)
    # Cache writes cost 1.25 times the input price for five minutes, twice it for an hour.
    return ((p_in * (tokens["input"] + 1.25 * (tokens["cache_write"] - hour) + 2 * hour)
             + p_read * tokens["cache_read"] + p_out * tokens["output"]) / 1_000_000, True)


try:
    PRICES.update({k: tuple(v) for k, v in json.loads(os.environ.get("PAPERTOWN_PRICES", "{}")).items()})
except (ValueError, TypeError):
    pass


def cost(model: str, usage: Usage) -> float:
    p_in, p_out = PRICES.get(model, (0.0, 0.0))[:2]
    return (usage.input_tokens * p_in + usage.output_tokens * p_out) / 1_000_000
