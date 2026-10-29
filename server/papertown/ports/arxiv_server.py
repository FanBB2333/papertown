"""The arXiv dock as an MCP server (stdio). The backend connects to it as an MCP client,
and any other MCP host (Claude Code, Claude Desktop ...) can use it too:

    uv run python -m papertown.ports.arxiv_server
"""

from __future__ import annotations

from datetime import date, timedelta

from mcp.server.mcpserver import MCPServer

from . import arxiv_api

server = MCPServer("papertown-arxiv", instructions="arXiv dock: search arXiv and fetch paper metadata.")


@server.tool()
def search(query: str, max_results: int = 8, recent_days: int = 0) -> dict:
    """Search arXiv. `query` is free text (English keywords work best) or an arXiv field
    query such as 'abs:"scene graph" AND cat:cs.RO'. With recent_days > 0, return only
    papers submitted in that window, newest first."""
    papers = arxiv_api.search(query, max_results=max_results, sort="submittedDate" if recent_days else "relevance")
    if recent_days:
        since = (date.today() - timedelta(days=recent_days)).isoformat()
        papers = [p for p in papers if p["published"] >= since]
    return {"query": query, "papers": papers}


@server.tool()
def get_papers(ids: list[str]) -> dict:
    """Fetch metadata for arXiv ids such as 2401.01234."""
    return {"papers": arxiv_api.get(ids)}


if __name__ == "__main__":
    server.run()
