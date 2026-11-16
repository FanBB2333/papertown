"""USD per million tokens (input, output), which the bank prices every call with. Models not listed
cost 0 until set, e.g. PAPERTOWN_PRICES='{"deepseek-chat": [0.27, 1.1]}'.
"""

from __future__ import annotations

import json
import os

from .base import Usage

PRICES: dict[str, tuple[float, float]] = {
    "claude-fable-5-1": (10.0, 50.0),
    "claude-opus-5-5": (4.0, 20.0),
    "claude-opus-5": (5.0, 25.0),
    "claude-sonnet-5-5": (2.0, 10.0),
    "claude-haiku-5-5": (0.10, 0.50),
}

try:
    PRICES.update({k: tuple(v) for k, v in json.loads(os.environ.get("PAPERTOWN_PRICES", "{}")).items()})
except (ValueError, TypeError):
    pass


def cost(model: str, usage: Usage) -> float:
    p_in, p_out = PRICES.get(model, (0.0, 0.0))
    return (usage.input_tokens * p_in + usage.output_tokens * p_out) / 1_000_000
