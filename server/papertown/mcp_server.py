"""Papertown's own tools over MCP, for other agents (Claude Code, Claude Desktop ...):

    uv run papertown mcp

Read-only: library search, genealogy, depot search, and the state of the paper lines.
"""

from __future__ import annotations

from mcp.server.mcpserver import MCPServer

from .config import Settings


def serve() -> None:
    s = Settings()
    s.arxiv_port = False  # this process only reads the shared database
    from .town import Town
    town = Town(s)
    server = MCPServer("papertown", instructions="Papertown: a research town. Search its paper library and inspect paper lines.")

    @server.tool()
    def library_search(query: str, top_k: int = 8) -> dict:
        """Search the paper library (English keywords). Returns titles, snippets and similarity."""
        return town.library.search(query, top_k)

    @server.tool()
    def genealogy_expand(paper_ids: list[str], depth: int = 1) -> dict:
        """Neighbours of papers in the genealogy graph (ids like arxiv:2401.01234)."""
        return town.genealogy.expand(paper_ids, depth)

    @server.tool()
    def depot_search(query: str) -> dict:
        """Search repository docs in the depot district."""
        return town.depots.search(query)

    @server.tool()
    def list_lines() -> list[dict]:
        """All paper lines with their stage and progress."""
        return [{k: x[k] for k in ("id", "title", "status", "stage", "pct", "spent")} for x in town.pipeline.lines()]

    @server.tool()
    def get_line(line_id: str) -> dict:
        """One paper line: stages, team and outputs."""
        snap = town.pipeline.snapshot(line_id) or {}
        snap["outputs"] = {r["stage"]: r["body"] for r in town.db.q("select stage, body from items where line_id = ?", line_id)}
        return snap

    server.run()
