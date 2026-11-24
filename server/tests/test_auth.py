from fastapi.testclient import TestClient

from papertown.api import create_app

from .conftest import make_settings

AWAY = {"x-forwarded-for": "100.64.0.7"}  # a phone, through tailscale serve


def test_this_machine_goes_in_and_other_devices_sign_in(tmp_path):
    web = tmp_path / "dist"
    web.mkdir()
    (web / "index.html").write_text("<!doctype html><title>Papertown</title>")
    app = create_app(make_settings(tmp_path, web_dist=web))
    with TestClient(app) as c:
        assert c.get("/api/auth/state").json() == {"local": True, "password": False, "authed": True, "signed_in": False, "key": False, "via": "local", "sessions": 0, "keys": 0, "methods": {"password": True, "keys": True}, "days": 30}
        assert c.get("/api/cards").status_code == 200
        assert "Papertown" in c.get("/progress/6").text and "Papertown" in c.get("/console/2/code").text
        assert c.get("/progress/6").headers["cache-control"] == "no-cache"
        assert c.get("/assets/nothing.js").status_code == 404

        assert c.get("/api/cards", headers=AWAY).status_code == 401
        assert c.get("/api/auth/state", headers=AWAY).json() == {"local": False, "password": False, "authed": False, "signed_in": False, "key": False, "via": None, "methods": {"password": True, "keys": True}, "days": 30}
        assert c.post("/api/auth/password", json={"password": "hunter22"}, headers=AWAY).status_code == 403
        assert c.post("/api/auth/login", json={"password": "x"}, headers=AWAY).status_code == 403
        assert c.post("/api/auth/password", json={"password": "abc"}).status_code == 400
        assert c.post("/api/auth/password", json={"password": "hunter22"}).json()["password"] is True
        assert "hunter22" not in (tmp_path / "var" / "auth.json").read_text()

        assert c.post("/api/auth/login", json={"password": "wrong"}, headers=AWAY).status_code == 401
        r = c.post("/api/auth/login", json={"password": "hunter22"}, headers=AWAY)
        assert r.status_code == 200 and "httponly" in r.headers["set-cookie"].lower()
        assert c.get("/api/cards", headers=AWAY).status_code == 200
        assert c.get("/api/auth/state", headers=AWAY).json()["signed_in"] is True
        assert c.post("/api/auth/password", json={"password": "another1"}, headers=AWAY).status_code == 403
        assert c.post("/api/auth/password", json={"password": "another1", "old": "hunter22"}, headers=AWAY).status_code == 200
        assert c.delete("/api/auth/password", headers=AWAY).status_code == 403

        c.post("/api/auth/logout", headers=AWAY)
        assert c.get("/api/cards", headers=AWAY).status_code == 401
        for _ in range(5):
            c.post("/api/auth/login", json={"password": "nope"}, headers=AWAY)
        assert c.post("/api/auth/login", json={"password": "another1"}, headers=AWAY).status_code == 429

        assert c.delete("/api/auth/password").json()["password"] is False


def test_access_keys_let_apps_in_without_the_password(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as c:
        # the server says what it is before anyone signs in
        health = c.get("/api/health", headers=AWAY).json()
        assert health["ok"] is True and health["app"] == "papertown" and health["version"]

        # made on this machine, shown once, stored as a hash
        made = c.post("/api/auth/keys", json={"name": "iPhone"}).json()
        key = made["key"]
        assert key.startswith("ptk_") and made["name"] == "iPhone" and made["hint"] == key[:8]
        assert key not in (tmp_path / "var" / "auth.json").read_text()
        assert [k["name"] for k in c.get("/api/auth/keys").json()["keys"]] == ["iPhone"]
        assert "key" not in c.get("/api/auth/keys").json()["keys"][0]

        # another device gets in with it, the event stream included, and no password set
        bearer = {**AWAY, "authorization": f"Bearer {key}"}
        assert c.get("/api/cards", headers=bearer).status_code == 200
        state = c.get("/api/auth/state", headers=bearer).json()
        assert state["authed"] is True and state["key"] is True and state["via"] == "key"
        assert c.get("/api/cards", headers={**AWAY, "authorization": "Bearer ptk_wrong"}).status_code == 401
        assert c.get("/api/cards", headers={**AWAY, "authorization": f"Basic {key}"}).status_code == 401
        assert c.get("/api/auth/keys", headers=AWAY).status_code == 401

        # a key cannot make more keys or revoke them
        assert c.post("/api/auth/keys", json={"name": "more"}, headers=bearer).status_code == 403
        assert c.delete(f"/api/auth/keys/{made['id']}", headers=bearer).status_code == 403

        # a browser signed in with the password can manage them
        c.post("/api/auth/password", json={"password": "hunter22"})
        c.post("/api/auth/login", json={"password": "hunter22"}, headers=AWAY)
        second = c.post("/api/auth/keys", json={"name": "Mac"}, headers=AWAY).json()
        assert {k["name"] for k in c.get("/api/auth/keys", headers=AWAY).json()["keys"]} == {"iPhone", "Mac"}
        c.post("/api/auth/logout", headers=AWAY)

        # clearing the password keeps the keys; revoking one shuts only that device out
        c.delete("/api/auth/password")
        assert c.get("/api/cards", headers=bearer).status_code == 200
        assert [k["name"] for k in c.delete(f"/api/auth/keys/{made['id']}").json()["keys"]] == ["Mac"]
        assert c.get("/api/cards", headers=bearer).status_code == 401
        assert c.get("/api/cards", headers={**AWAY, "authorization": f"Bearer {second['key']}"}).status_code == 200
        assert c.delete("/api/auth/keys/nothing").status_code == 404


def test_key_command_makes_lists_and_revokes(tmp_path, monkeypatch, capsys):
    import sys
    from papertown import cli
    from papertown.auth import Auth
    monkeypatch.setenv("PAPERTOWN_DATA_DIR", str(tmp_path / "var"))
    (tmp_path / "var").mkdir()
    monkeypatch.setattr(sys, "argv", ["papertown", "key", "create", "--name", "iPad"])
    cli.main()
    out = capsys.readouterr().out
    key = next(w for w in out.split() if w.startswith("ptk_"))
    [made] = Auth(tmp_path / "var").keys()
    assert made["name"] == "iPad" and key.startswith(made["hint"])
    monkeypatch.setattr(sys, "argv", ["papertown", "key", "list"])
    cli.main()
    assert made["id"] in capsys.readouterr().out and key not in out.replace(key, "", 1)
    monkeypatch.setattr(sys, "argv", ["papertown", "key", "revoke", made["id"]])
    cli.main()
    assert Auth(tmp_path / "var").keys() == []
