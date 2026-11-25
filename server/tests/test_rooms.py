"""The three configuration buildings: the skill academy (skim), the MCP exchange and the
library's RAG settings."""

import json
import os
import shutil
import subprocess
import sys
import time

import pytest
from fastapi.testclient import TestClient

from papertown.api import create_app

from .conftest import make_settings

ECHO = '''from mcp.server.mcpserver import MCPServer
server = MCPServer("echo")

@server.tool()
def echo(text: str) -> str:
    """Say it back."""
    return text

if __name__ == "__main__":
    server.run()
'''


def wait_for(c, name, state, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        s = next((x for x in c.get("/api/mcp").json()["servers"] if x["name"] == name), None)
        if s and s["state"] == state:
            return s
        time.sleep(0.2)
    raise AssertionError(f"{name} never got to {state}: {s}")


def test_mcp_servers_are_added_switched_and_removed(tmp_path, monkeypatch):
    script = tmp_path / "echo_server.py"
    script.write_text(ECHO)
    monkeypatch.setenv("ECHO_TOKEN", "from-the-environment")
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as c:
        town = app.state.town
        r = c.post("/api/mcp/servers", json={"name": "echo", "command": sys.executable, "args": [str(script)], "env": {"TOKEN": "${ECHO_TOKEN}"}})
        assert r.status_code == 200
        s = wait_for(c, "echo", "ok")
        assert s["source"] == "town" and s["env"] == ["TOKEN"] and s["tools"] == [{"name": "echo", "description": "Say it back."}]
        assert "from-the-environment" not in r.text
        assert town.mcp.call("echo", "echo", {"text": "hi"}) == "hi"
        saved = json.loads((tmp_path / "var" / "mcp.json").read_text())
        assert saved["mcpServers"]["echo"]["env"] == {"TOKEN": "${ECHO_TOKEN}"}

        c.post("/api/mcp/servers/echo/toggle", json={"enabled": False})
        assert wait_for(c, "echo", "off")["tools"] == [] and "echo" not in town.mcp.clients
        c.post("/api/mcp/servers/echo/toggle", json={"enabled": True})
        wait_for(c, "echo", "ok")

        assert c.post("/api/mcp/servers", json={"name": "1bad", "command": "x"}).status_code == 400
        assert c.delete("/api/mcp/servers/echo").status_code == 200
        assert all(x["name"] != "echo" for x in c.get("/api/mcp").json()["servers"])
        assert "exchange" in [p["type"] for p in c.get("/api/world").json()["placements"]]


def test_rag_settings_bound_and_persist(tmp_path):
    s = make_settings(tmp_path)
    with TestClient(create_app(s)) as c:
        v = c.post("/api/rag", json={"top_k": 99, "candidates": 3}).json()
        assert v["opts"]["top_k"] == 30 and v["opts"]["candidates"] == 5 and "embed" not in v
        hits = c.get("/api/rag/search", params={"q": "sparse attention"}).json()
        assert hits["method"] == "coverage" and len(hits["hits"]) <= 30
        assert c.get("/api/rag/search", params={"q": " "}).status_code == 400
    with TestClient(create_app(s)) as c:
        assert c.get("/api/rag").json()["opts"]["top_k"] == 30


SKIM = os.environ.get("PAPERTOWN_TEST_SKIM") or shutil.which("skim")


@pytest.mark.skipif(not SKIM, reason="needs skim: put it on PATH or set PAPERTOWN_TEST_SKIM")
def test_skills_are_layered_per_project_and_conversation(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    skill = tmp_path / "src" / "note-taking"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: note-taking\ndescription: Keep a lab notebook.\n---\n\n# Notes\n")
    other = tmp_path / "src" / "plotting"
    other.mkdir()
    (other / "SKILL.md").write_text("---\nname: plotting\ndescription: Draw the figures.\n---\n\n# Plots\n")
    for args in (["init"], ["add", str(skill)], ["add", str(other)]):
        subprocess.run([SKIM, *args], check=True, capture_output=True, cwd=tmp_path)

    app = create_app(make_settings(tmp_path, skim_bin=SKIM))
    with TestClient(app) as c:
        town = app.state.town
        line = c.post("/api/ideas", json={"text": "a project to configure"}).json()
        a = town.agents.ensure(line["id"], "coder")
        st = c.get("/api/skim").json()
        town_skills = {s.name for s in town.skills.all()}
        # the town's own skills went into skim's store at start, next to the user's
        assert st["ok"] and {x["name"] for x in st["store"]} == {"note-taking", "plotting"} | town_skills
        assert {s["name"]: s["state"] for s in st["town"]} == {n: "synced" for n in town_skills}

        def set_(scope, key, value, **kw):
            r = c.post("/api/skim/config", json={"scope": scope, "key": key, "value": value, "line_id": line["id"], **kw})
            assert r.status_code == 200, r.text
            return {x["name"]: (x["enabled"], x.get("scope")) for x in r.json()["skills"] if x["name"] not in town_skills}

        assert set_("global", "skill.note-taking.enabled", "true")["note-taking"] == (True, "global")
        assert set_("project", "skill.note-taking.enabled", "false")["note-taking"] == (False, "project")
        got = set_("session", "skill.plotting.enabled", "true", agent_id=a["id"])
        assert got == {"note-taking": (False, "project"), "plotting": (True, "session")}

        assert (town.s.projects_dir / line["id"] / ".skim" / "config").exists()
        assert (home / ".skim" / "sessions" / f"papertown-{a['id']}.config").exists()
        linked = town.skim.skills_dir(a)
        assert (linked / "plotting").is_symlink() and not (linked / "note-taking").exists()
        assert "## 技能" in town.brief(line["id"], "coder") and str(linked / "plotting" / "SKILL.md") in town.brief(line["id"], "coder")

        # a project starts with the town's skills on in its own scope, and the lead is given them too
        res = c.get("/api/skim/resolve", params={"line_id": line["id"]}).json()
        assert {x["name"] for x in res["skills"] if x["enabled"] and x["scope"] == "project"} >= town_skills
        lead = town.agents.ensure(line["id"], "lead")
        assert "novelty-check" in town.brief(line["id"], "lead") and (town.skim.skills_dir(lead) / "novelty-check" / "SKILL.md").exists()
        # switched off there, it stays off: the town does not switch it on again
        set_("project", "skill.novelty-check.enabled", "false")
        town.skim.sync_town()
        res = c.get("/api/skim/resolve", params={"line_id": line["id"]}).json()
        assert next(x for x in res["skills"] if x["name"] == "novelty-check")["enabled"] is False

        assert set_("project", "skill.note-taking.enabled", None)["note-taking"] == (True, "global")
        assert c.post("/api/skim/config", json={"scope": "session", "key": "skill.plotting.enabled", "value": "maybe",
                                                "line_id": line["id"], "agent_id": a["id"]}).status_code == 400


def test_skim_missing(tmp_path):
    with TestClient(create_app(make_settings(tmp_path))) as c:
        st = c.get("/api/skim").json()
        assert not st["ok"] and "skim" in st["note"]
        assert "skim 未接入" in c.get("/api/buildings/academy").json()["job"]
