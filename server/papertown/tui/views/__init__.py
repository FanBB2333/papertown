"""The places of the TUI, in the order of the index on the left (1 … 7), and the tab strip they share."""

from __future__ import annotations

from rich.text import Text


def make_places() -> list:
    from .chat import Chat
    from .daily import Daily
    from .jobs import Jobs
    from .plant import Plant
    from .projects import Projects
    from .setup import Setup
    from .staff import Staff

    return [Projects(), Jobs(), Plant(), Staff(), Chat(), Daily(), Setup()]


def tabs(items: list[tuple[str, str]], current: str, p: dict[str, str]) -> Text:
    out = Text()
    for k, label in items:
        out.append(f" {label} ", style=f"bold {p['brand']} underline" if k == current else p["muted"])
        out.append(" ")
    return out


def cycle(items: list[tuple[str, str]], current: str, step: int) -> str:
    """the key `step` places on from current, wrapping around"""
    keys = [k for k, _ in items]
    return keys[(keys.index(current) + step) % len(keys)]
