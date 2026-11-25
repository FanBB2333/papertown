"""Accounts through CLIppet: the layers (global -> project -> agent) and a launch wrapped in `clippet -e <env>`."""
import json
import sys
from pathlib import Path

from fastapi.testclient import TestClient

from papertown.accounts import Accounts
from papertown.api import create_app
from papertown.town import Town
from .conftest import make_settings
from .test_backends import employee


def fake_clippet(tmp: Path) -> Path:
    """Answers `env status --json` with two envs, as CLIppet does."""
    envs = {name: {"type": "home", "path": str(tmp / "envs" / name), "exists": True, "codex_text": f"{name}@example.com [plus]",
                   "agy": None, "description": ""} for name in ("acct-a", "acct-b")}
    p = tmp / "clippet"
    p.write_text(f"#!{sys.executable}\nimport sys\nif sys.argv[1:4] == ['env', 'status', '--json']:\n"
                 f"    print({json.dumps(json.dumps(envs))})\nelse:\n    sys.exit(2)\n")
    p.chmod(0o755)
    return p


def test_layers_narrower_wins(tmp_path):
    app = create_app(make_settings(tmp_path, clippet_bin=str(fake_clippet(tmp_path))))
    with TestClient(app) as c:
        line = c.post("/api/ideas", json={"text": "a project on two accounts"}).json()
        a = app.state.town.agents.ensure(line["id"], "coder")
        q = {"line_id": line["id"], "agent_id": a["id"]}
        v = c.get("/api/accounts", params=q).json()
        assert v["ok"] and [e["name"] for e in v["envs"]] == ["acct-a", "acct-b"]
        assert v["envs"][0]["codex"] == "acct-a@example.com [plus]"
        assert v["resolved"] == {"env": "", "scope": "default"}

        def set_(scope, env):
            r = c.post("/api/accounts", json={"scope": scope, "env": env, **q})
            assert r.status_code == 200, r.text
            return r.json()["resolved"]

        assert set_("global", "acct-a") == {"env": "acct-a", "scope": "global"}
        assert set_("project", "") == {"env": "", "scope": "project"}  # this machine's own login, over the global choice
        assert set_("agent", "acct-b") == {"env": "acct-b", "scope": "agent"}
        assert set_("agent", None) == {"env": "", "scope": "project"}
        assert set_("project", None) == {"env": "acct-a", "scope": "global"}
        assert c.post("/api/accounts", json={"scope": "agent", "env": "nobody", **q}).status_code == 400
        assert c.post("/api/accounts", json={"scope": "project", "env": "acct-a"}).status_code == 400
        assert json.loads((app.state.town.s.data_dir / "accounts.json").read_text())["global"] == "acct-a"


def test_missing_clippet_reads_as_not_connected(tmp_path):
    with TestClient(create_app(make_settings(tmp_path))) as c:
        v = c.get("/api/accounts").json()
        assert not v["ok"] and "clippet" in v["note"] and v["resolved"]["env"] == ""


class Recorder:
    def __init__(self):
        self.specs = []
    def open(self, spec): self.specs.append(spec); return {'n': len(self.specs)}
    def alive(self, handle): return False
    def close(self, handle): pass
    def attach(self, handle): return None


def test_launch_runs_the_cli_in_the_env(tmp_path):
    clippet = fake_clippet(tmp_path)
    codex = tmp_path / "codex-bin"
    codex.write_text("#!/bin/sh\n")
    codex.chmod(0o755)
    t = Town(make_settings(tmp_path, clippet_bin=str(clippet), codex_bin=str(codex)))
    h = t.agents.hosted
    h.watch = lambda: None
    rec = Recorder()
    h.backends['tmux'] = rec
    a = employee(t)

    t.agents.start(a['id'], 'tmux', 'codex')
    argv = rec.specs[-1]['argv']
    assert argv[0] == str(codex)  # no account: the CLI itself
    assert t.agents.get(a['id'])['term']['account'] is None

    t.accounts.set("agent", "acct-b", a["line_id"], a["id"])
    t.agents.start(a['id'], 'tmux', 'codex')
    argv = rec.specs[-1]['argv']
    assert argv[:4] == [str(clippet), '-e', 'acct-b', 'codex'] and '--add-dir' in argv
    term = t.agents.get(a['id'])['term']
    assert term['account'] == {'env': 'acct-b', 'path': str(tmp_path / 'envs' / 'acct-b')}
    assert t.agents.public(t.agents.get(a['id']))['term']['account']['env'] == 'acct-b'


def test_sessions_are_read_from_the_env():
    home = Path.home()
    assert Accounts.home("~/.codex", None) == home / ".codex"
    assert Accounts.home("~/.codex", {"env": "x", "path": "/envs/x"}) == Path("/envs/x/.codex")
    assert Accounts.home("~/.gemini/antigravity-cli", {"env": "x", "path": "/envs/x"}) == Path("/envs/x/.gemini/antigravity-cli")
    assert Accounts.home("/elsewhere/.claude", {"env": "x", "path": "/envs/x"}) == Path("/elsewhere/.claude")
