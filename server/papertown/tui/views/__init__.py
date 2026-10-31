"""The places of the TUI, in the order of the index on the left (1 … 7)."""

from __future__ import annotations


def make_places() -> list:
    from .chat import Chat
    from .daily import Daily
    from .jobs import Jobs
    from .plant import Plant
    from .projects import Projects
    from .setup import Setup
    from .staff import Staff

    return [Projects(), Jobs(), Plant(), Staff(), Chat(), Daily(), Setup()]
