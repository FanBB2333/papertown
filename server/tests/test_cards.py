from fastapi.testclient import TestClient

from .test_farm_agents import IDEA
from .test_leads import started

CARD = {"summary": "基线复现完了，主实验在跑。", "health": "risk", "progress": 40, "milestone": "周五拿到主表",
        "done": ["baseline 复现"], "next": ["跑主实验"], "blockers": ["显存紧"], "need_you": ["要不要加数据集"],
        "metrics": [{"name": "主指标", "value": "71.2", "note": "baseline 68.9"}]}


def test_a_card_is_written_by_the_lead_only_when_you_ask(tmp_path):
    app, calls = started(tmp_path)
    with TestClient(app) as c:
        town = app.state.town
        lid = c.post("/api/ideas", json={"text": IDEA}).json()["id"]

        row = c.get("/api/cards").json()["cards"][0]
        assert row["line"]["id"] == lid and row["card"] is None and row["lead"] is None and row["pending"] is None
        assert c.post(f"/api/lines/{lid}/card", json={}).status_code == 400

        lead = c.post("/api/agents", json={"line_id": lid, "role": "lead"}).json()
        c.post(f"/api/agents/{lead['id']}/start", json={"runtime": "paseo", "provider": "codex"})
        h = {"x-papertown-token": town.agents.get(lead["id"])["token"]}
        assert "现在没有人让你更新卡片" in c.get(f"/api/bridge/{lead['id']}/card", headers=h).json()["text"]
        r = c.post(f"/api/bridge/{lead['id']}/card", json={"card": CARD}, headers=h)
        assert r.status_code == 400 and "没有人让你更新" in r.json()["detail"]

        row = c.post(f"/api/lines/{lid}/card", json={"note": "重点看实验"}).json()
        assert row["pending"]["note"] == "重点看实验"
        msg = [e for e in town.agents.events(lead["id"]) if e["kind"] == "user"][-1]["data"]["text"]
        assert msg.startswith("<card>") and "pt card set" in msg and "用户附言：重点看实验" in msg and "第一次写" in msg
        assert "正在等你交卡片" in c.get(f"/api/bridge/{lead['id']}/card", headers=h).json()["text"]

        bad = c.post(f"/api/bridge/{lead['id']}/card", json={"card": CARD | {"progress": 140}}, headers=h)
        assert bad.status_code == 400 and "0–100" in bad.json()["detail"]
        assert c.post(f"/api/bridge/{lead['id']}/card", json={"card": CARD | {"mood": 1}}, headers=h).status_code == 400
        assert c.post(f"/api/bridge/{lead['id']}/card", json={"card": CARD}, headers=h).status_code == 200
        row = c.get("/api/cards").json()["cards"][0]
        assert row["pending"] is None and row["card"]["health"] == "risk" and row["card"]["metrics"][0]["value"] == "71.2"
        assert row["card"]["at"] and row["lead"]["id"] == lead["id"] and row["prev"] is None
        assert c.post(f"/api/bridge/{lead['id']}/card", json={"card": CARD}, headers=h).status_code == 400

        assert c.post("/api/cards/update").json()["sent"] == [lid]
        msg = [e for e in town.agents.events(lead["id"]) if e["kind"] == "user"][-1]["data"]["text"]
        assert "没变的可以照抄" in msg and "基线复现完了" in msg
        c.post(f"/api/bridge/{lead['id']}/card", json={"card": CARD | {"progress": 55}}, headers=h)
        row = c.get("/api/cards").json()["cards"][0]
        assert row["card"]["progress"] == 55 and row["prev"] == 40

        c.post(f"/api/lines/{lid}/card", json={})
        assert c.post(f"/api/lines/{lid}/card/cancel").json()["pending"] is None
