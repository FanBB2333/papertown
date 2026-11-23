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
        assert w["hud"]["leads"] == {"on": 0, "running": 0, "blocked": 0}

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



def test_resident_staff_and_bridge(tmp_path, monkeypatch):
    from .test_resident_leads import fake_start
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as c:
        town = app.state.town
        assert c.get("/api/health").status_code == 200
        assert c.get("/api/buildings/library/staff").json()["who"] == "assistant"
        lid = c.post("/api/ideas", json={"text": "Repository retrieval research"}).json()["id"]
        assert c.get("/api/buildings/hatchery/staff").json()["who"] == "lead"
        assert c.post(f"/api/lines/{lid}/lead", json={"on": False}).json()["on"] is False
        assert c.get(f"/api/lines/{lid}/lead").json()["resident"]["state"] == "off"
        calls = fake_start(town, monkeypatch)
        lead = town.agents.ensure(lid, "lead")
        coder = town.agents.ensure(lid, "coder")
        hl = {"x-papertown-token": lead["token"]}
        hc = {"x-papertown-token": coder["token"]}
        base = f"/api/bridge/{lead['id']}"
        cb = f"/api/bridge/{coder['id']}"
        assert c.get(base + "/stage", headers=hl).status_code == 200
        assert c.get(base + "/survey", headers=hl).status_code == 200
        assert c.get(cb + "/library?q=repository&top=2", headers=hc).status_code == 200
        assert c.get(base + "/survey").status_code == 403
        assert c.post(cb + "/stage", headers=hc, json={"stage": "exp", "status": "run"}).status_code == 400
        assert c.post(cb + "/hire", headers=hc, json={"role": "writer"}).status_code == 400
        assert c.post(base + "/hire", headers=hl, json={"role": "coder"}).status_code == 200
        assert len(calls) == 1
        assert c.get("/api/buildings/depot/staff").json()["who"] == "coder"
        for stage, body in [("method", {"title": "T", "problem": "P"}), ("write", {"title": "T"}), ("review", {"verdict": "放行"})]:
            assert c.post(cb + "/output", headers=hc, json={"stage": stage, "body": body}).status_code == 403
        assert c.post(cb + "/output", headers=hc, json={"stage": "exp", "body": {
            "metrics": ["Acc"], "rows": [{"method": "A", "values": [1]}]}}).status_code == 200
        assert c.post(base + "/output", headers=hl, json={"stage": "method", "body": {"title": "T", "problem": "P"}}).status_code == 200
        assert c.post(base + "/stage", headers=hl, json={"stage": "method", "status": "run", "pct": 20}).status_code == 200
        assert c.get("/api/buildings/mill/staff").json()["who"] == "lead"
        assert "代码员工 1" in c.get("/api/buildings/market").json()["job"]
        assert "订阅额度" in c.get("/api/buildings/bank").json()["job"]
        assert "plant" not in c.get("/api/jobs").json()
        town.db.update("lines", {"id": lid}, idea="zzzxqv")
        assert c.post(base + "/output", headers=hl, json={"stage": "hatch", "body": {"gap": "空库检索"}}).status_code == 200
        assert not town.db.val("select count(*) from ledger")


def test_hud_counts_only_live_residents(tmp_path, monkeypatch):
    from .test_resident_leads import fake_start
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as c:
        town = app.state.town
        fake_start(town, monkeypatch)
        first = town.pipeline.create("A live project")["id"]
        town.leads.ensure(first, force=True)
        second = town.pipeline.create("A sample project")["id"]
        town.db.update("lines", {"id": second}, sample=1)
        third = town.pipeline.create("A completed project")["id"]
        town.db.update("lines", {"id": third}, status="done")
        hud = c.get("/api/status").json()["hud"]
        assert set(hud) == {"day", "lines", "leads", "library", "ports"}
        assert hud["lines"] == {"running": 2, "total": 3} and hud["leads"] == {"on": 1, "running": 1, "blocked": 0}
