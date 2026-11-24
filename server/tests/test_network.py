from fastapi.testclient import TestClient

from papertown.api import create_app

from .conftest import make_settings

TAILNET = {"x-forwarded-for": "100.64.0.7"}  # a phone through tailscale serve
FAR = {"x-forwarded-for": "203.0.113.9"}  # somewhere on the internet, through a proxy here


def test_sources_decide_who_reaches_the_server_at_all(tmp_path):
    with TestClient(create_app(make_settings(tmp_path))) as c:
        conf = c.get("/api/network").json()
        assert conf["sources"] == ["lan", "tailscale"] and conf["host"] == "127.0.0.1" and conf["can_edit"] is True
        assert conf["you"] == {"local": True, "ip": None, "kind": None}

        # outside the sources: refused before signing in, the page and health too
        r = c.get("/api/health", headers=FAR)
        assert r.status_code == 403 and "203.0.113.9" in r.json()["detail"]
        assert c.get("/progress", headers=FAR).status_code == 403
        # inside: the usual sign-in rules
        assert c.get("/api/health", headers=TAILNET).status_code == 200
        assert c.get("/api/cards", headers=TAILNET).status_code == 401

        # a network written by hand, an address, or any source
        conf = c.put("/api/network", json={"sources": ["tailscale", "203.0.113.0/24", "198.51.100.4"]}).json()
        assert conf["sources"] == ["tailscale", "203.0.113.0/24", "198.51.100.4/32"]
        assert c.get("/api/health", headers=FAR).status_code == 200
        assert c.get("/api/health", headers={"x-forwarded-for": "192.168.1.5"}).status_code == 403
        assert c.put("/api/network", json={"sources": ["somewhere"]}).status_code == 400
        assert c.put("/api/network", json={"port": 80}).status_code == 400
        assert c.put("/api/network", json={"host": "10.0.0.1"}).status_code == 400
        assert c.put("/api/network", json={"days": 3}).status_code == 400
        saved = (tmp_path / "papertown.toml").read_text()
        assert '[network]' in saved and '"203.0.113.0/24"' in saved
        assert (tmp_path / "papertown.toml").stat().st_mode & 0o777 == 0o600


def test_other_devices_cannot_shut_themselves_out(tmp_path):
    with TestClient(create_app(make_settings(tmp_path))) as c:
        c.post("/api/auth/password", json={"password": "hunter22"})
        key = c.post("/api/auth/keys", json={"name": "iPhone"}).json()["key"]
        c.post("/api/auth/login", json={"password": "hunter22"}, headers=TAILNET)

        # a key reads but does not change
        as_app = {**TAILNET, "authorization": f"Bearer {key}", "cookie": ""}
        assert c.get("/api/network", headers=as_app).json()["can_edit"] is False
        assert c.put("/api/network", json={"port": 9000}, headers=as_app).status_code == 403

        # a signed-in browser changes what does not lock it out
        assert c.put("/api/network", json={"host": "0.0.0.0", "port": 9000, "days": 7}, headers=TAILNET).status_code == 200
        assert c.put("/api/network", json={"sources": ["lan"]}, headers=TAILNET).status_code == 403
        assert c.put("/api/network", json={"host": "127.0.0.1"}, headers=TAILNET).status_code == 403
        assert c.put("/api/network", json={"password": False}, headers=TAILNET).status_code == 403
        assert c.get("/api/auth/state", headers=TAILNET).json()["days"] == 7

        # this machine may: password sign-in off ends every login, keys off shuts the apps out
        assert c.put("/api/network", json={"password": False}).status_code == 200
        assert c.get("/api/cards", headers=TAILNET).status_code == 401
        assert c.post("/api/auth/login", json={"password": "hunter22"}, headers=TAILNET).status_code == 403
        assert c.get("/api/cards", headers=as_app).status_code == 200
        c.put("/api/network", json={"keys": False})
        assert c.get("/api/cards", headers=as_app).status_code == 401
        assert c.get("/api/cards").status_code == 200  # this machine always
