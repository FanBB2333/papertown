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
        assert c.get("/api/auth/state").json() == {"local": True, "password": False, "authed": True, "signed_in": False, "sessions": 0}
        assert c.get("/api/cards").status_code == 200
        # every address of the page is the page; a missing file is still missing
        assert "Papertown" in c.get("/progress/6").text and "Papertown" in c.get("/console/2/code").text
        assert c.get("/progress/6").headers["cache-control"] == "no-cache"  # a new build shows without a hard reload
        assert c.get("/assets/nothing.js").status_code == 404

        # from elsewhere: only the sign-in until there is a password, and the password is set here
        assert c.get("/api/cards", headers=AWAY).status_code == 401
        assert c.get("/api/auth/state", headers=AWAY).json() == {"local": False, "password": False, "authed": False, "signed_in": False}
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
        # changing it from there needs the old one
        assert c.post("/api/auth/password", json={"password": "another1"}, headers=AWAY).status_code == 403
        assert c.post("/api/auth/password", json={"password": "another1", "old": "hunter22"}, headers=AWAY).status_code == 200
        assert c.delete("/api/auth/password", headers=AWAY).status_code == 403

        c.post("/api/auth/logout", headers=AWAY)
        assert c.get("/api/cards", headers=AWAY).status_code == 401
        # too many wrong ones, and it waits
        for _ in range(5):
            c.post("/api/auth/login", json={"password": "nope"}, headers=AWAY)
        assert c.post("/api/auth/login", json={"password": "another1"}, headers=AWAY).status_code == 429

        # here, the password can be taken away; then nothing from elsewhere gets in
        assert c.delete("/api/auth/password").json()["password"] is False
