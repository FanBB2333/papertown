"""The skill academy: skills layered per project and conversation with skim."""

import os
import shutil
import subprocess

import pytest
from fastapi.testclient import TestClient

from papertown.api import create_app

from .conftest import make_settings

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
        assert st["ok"] and {x["name"] for x in st["store"]} == {"note-taking", "plotting"}

        def set_(scope, key, value, **kw):
            r = c.post("/api/skim/config", json={"scope": scope, "key": key, "value": value, "line_id": line["id"], **kw})
            assert r.status_code == 200, r.text
            return {x["name"]: (x["enabled"], x.get("scope")) for x in r.json()["skills"]}

        assert set_("global", "skill.note-taking.enabled", "true")["note-taking"] == (True, "global")
        assert set_("project", "skill.note-taking.enabled", "false")["note-taking"] == (False, "project")
        got = set_("session", "skill.plotting.enabled", "true", agent_id=a["id"])
        assert got == {"note-taking": (False, "project"), "plotting": (True, "session")}

        # the project's scope is in Papertown's directory for it, the conversation's in skim's sessions
        assert (town.s.projects_dir / line["id"] / ".skim" / "config").exists()
        assert (home / ".skim" / "sessions" / f"papertown-{a['id']}.config").exists()
        # applied: linked into the agent's own skills directory, and listed in its brief
        linked = town.skim.skills_dir(a)
        assert (linked / "plotting").is_symlink() and not (linked / "note-taking").exists()
        assert "## 技能" in town.brief(line["id"], "coder") and str(linked / "plotting" / "SKILL.md") in town.brief(line["id"], "coder")

        assert set_("project", "skill.note-taking.enabled", None)["note-taking"] == (True, "global")  # unset falls back
        assert c.post("/api/skim/config", json={"scope": "session", "key": "skill.plotting.enabled", "value": "maybe",
                                                "line_id": line["id"], "agent_id": a["id"]}).status_code == 400


def test_skim_missing(tmp_path):
    with TestClient(create_app(make_settings(tmp_path))) as c:
        st = c.get("/api/skim").json()
        assert not st["ok"] and "skim" in st["note"]
        assert "skim 未接入" in c.get("/api/buildings/academy").json()["job"]
