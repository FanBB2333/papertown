from fastapi.testclient import TestClient

from papertown.api import create_app

from .conftest import make_settings


def test_api_flow(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as c:
        w = c.get("/api/world").json()
        ids = {p["id"] for p in w["placements"]}
        assert {"hatchery", "library", "mill", "depot"} <= ids and "depot_a" not in ids
        core = sorted((p["type"], p["id"]) for p in w["placements"] if p["core"])
        assert core == [("depot", "depot"), ("farm", "farm"), ("mill", "mill"), ("press", "press")]
        assert c.get("/api/buildings/mill").json()["job"].startswith("空闲")
        assert w["hud"]["leads"] == {"on": 0, "running": 0}

        r = c.post("/api/ideas", json={"text": "用检索增强做论文的新颖性评估"})
        assert r.status_code == 200
        line_id = r.json()["id"]


        sheet = c.get("/api/buildings/hatchery").json()
        assert sheet["live"] and sheet["skills"] == ["novelty-check"] and len(sheet["stations"]) == 5
        assert c.get("/api/buildings/weather").json()["job"] == "未接入"
        assert c.post(f"/api/lines/{line_id}/resume").status_code in (404, 405)

        deps = c.get("/api/departments").json()
        assert [d["id"] for d in deps][:3] == ["hatchery", "market", "mill"]
        here = next(d for d in deps if any(x["id"] == line_id for x in d["lines"]))
        assert here["state"] == "busy" and "worker" not in here
        assert next(d for d in deps if d["id"] == "power")["state"] == "off"

        msgs = c.get("/api/messages").json()
        assert isinstance(msgs, list)
        st = c.get("/api/status").json()
        assert st["projects"][0]["id"] == line_id and {x["kind"] for x in st["calls"]} >= {"RAG", "MCP", "SKILL"}
        assert c.get(f"/api/lines/{line_id}/files/../../papertown.db").status_code == 404

