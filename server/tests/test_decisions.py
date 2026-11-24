"""待你决定 on a project's card: every kind of decision its agents wait on, answered from the card by the native path."""

from fastapi.testclient import TestClient

from papertown.prompts import parse
from .test_backends import memory_employee
from .test_canvas_agents import bind, flow, node  # noqa: F401 - flow is a fixture
from .test_cards import CARD
from .test_farm_agents import IDEA
from .test_leads import started
from .test_prompts import CLAUDE


def decisions(c, lid):
    return next(r for r in c.get("/api/cards").json()["cards"] if r["line"]["id"] == lid)["decisions"]


def test_permissions_and_questions_are_answered_from_the_card(flow):
    c, town, link, lid = flow
    a = bind(c, lid, node(c, lid))
    conv = next(x for x in link.convs if x["id"] == a["ext_id"])
    conv["permissions"] = [{"id": "req-1", "name": "Bash", "title": "Run the ablation", "arg": "python ablate.py --gpu 1", "kind": "tool"}]
    town.agents._feed_line({"t": "agent", "agent": dict(conv)})
    ask = town.leads.ask(a["id"], "用哪张卡重跑消融？", ["72G 那张", "32G 那张"])
    town.cards._write(lid, {"card": CARD | {"need_you": ["用哪张卡重跑消融", "要不要加数据集"]}})

    ds = decisions(c, lid)
    assert [d["kind"] for d in ds] == ["permission", "ask", "need"]
    perm, q, need = ds
    assert perm["title"] == "Run the ablation" and perm["detail"] == "python ablate.py --gpu 1" and perm["agent"] == a["id"]
    assert [(o["label"], o["value"]) for o in perm["options"]] == [("允许", True), ("拒绝", False)]
    assert q["id"] == str(ask["id"]) and [o["value"] for o in q["options"]] == ["72G 那张", "32G 那张"] and q["free"]
    # the card's line that the question already asks is not listed twice; the other one waits for a lead to hear it
    assert need["title"] == "要不要加数据集" and need["ready"] is True and need["later"] is True

    assert c.post(f"/api/lines/{lid}/decide", json={"kind": "permission", "id": "req-1", "agent": "lead-x", "value": True}).status_code == 404
    assert c.post(f"/api/lines/{lid}/decide", json={"kind": "permission", "id": "req-1", "agent": a["id"], "value": "yes"}).status_code == 400
    row = c.post(f"/api/lines/{lid}/decide", json={"kind": "permission", "id": "req-1", "agent": a["id"], "value": True}).json()
    assert link.permits == [(a["ext_id"], "req-1", True)]
    assert [d["kind"] for d in row["decisions"]] == ["ask", "need"]  # hidden while Paseo catches up

    row = c.post(f"/api/lines/{lid}/decide", json={"kind": "ask", "id": q["id"], "value": "72G 那张"}).json()
    assert town.db.one("select * from reports where id = ?", ask["id"])["data"]["answer"] == "72G 那张"
    assert [d["kind"] for d in row["decisions"]] == ["need"]
    assert c.post(f"/api/lines/{lid}/decide", json={"kind": "ask", "id": q["id"], "value": "32G 那张"}).status_code == 400

    row = c.post(f"/api/lines/{lid}/decide", json={"kind": "need", "id": "要不要加数据集", "value": "同意"}).json()
    assert row["decisions"] == [] and [(x["item"], x["sent"]) for x in town.cards._read(lid)["decided"]] == [
        ("用哪张卡重跑消融", True), ("要不要加数据集", False)]
    assert c.post(f"/api/lines/{lid}/decide", json={"kind": "other", "id": "x", "value": 1}).status_code == 422


def test_a_line_of_the_card_goes_to_the_lead_and_stays_decided(tmp_path):
    app, _ = started(tmp_path)
    with TestClient(app) as c:
        town = app.state.town
        lid = c.post("/api/ideas", json={"text": IDEA}).json()["id"]
        # a sample's card, no lead yet: the choice is kept for the lead
        town.cards._write(lid, {"card": CARD | {"need_you": ["批准用 72G 那张卡重跑消融", "换个 batch size"]}})
        first, second = decisions(c, lid)
        assert first["later"] is True and [o["label"] for o in first["options"]] == ["同意", "不同意"]
        assert c.post(f"/api/lines/{lid}/decide", json={"kind": "need", "id": first["id"], "value": "同意"}).json()["decisions"][0]["id"] == second["id"]

        # it reaches the lead with the next request to update the card, once
        lead = c.post("/api/agents", json={"line_id": lid, "role": "lead"}).json()
        c.post(f"/api/agents/{lead['id']}/start", json={"runtime": "paseo", "provider": "codex"})
        h = {"x-papertown-token": town.agents.get(lead["id"])["token"]}
        c.post(f"/api/lines/{lid}/card", json={})
        msg = [e for e in town.agents.events(lead["id"]) if e["kind"] == "user"][-1]["data"]["text"]
        assert "用户已经决定了" in msg and "- 「批准用 72G 那张卡重跑消融」：同意" in msg
        assert all(x["sent"] for x in town.cards._read(lid)["decided"])
        c.post(f"/api/bridge/{lead['id']}/card", json={"card": CARD | {"need_you": ["批准用 72G 那张卡重跑消融", "换个 batch size"]}}, headers=h)
        c.post(f"/api/lines/{lid}/card/cancel")
        c.post(f"/api/lines/{lid}/card", json={})
        assert "用户已经决定了" not in [e for e in town.agents.events(lead["id"]) if e["kind"] == "user"][-1]["data"]["text"]
        c.post(f"/api/bridge/{lead['id']}/card", json={"card": CARD | {"need_you": ["批准用 72G 那张卡重跑消融", "换个 batch size"]}}, headers=h)

        # with the lead running, the choice goes to it at once, after its current turn
        [need] = decisions(c, lid)
        assert need["title"] == "换个 batch size" and need["later"] is False
        row = c.post(f"/api/lines/{lid}/decide", json={"kind": "need", "id": need["id"], "value": "同意", "text": "先试 64"}).json()
        said = [e for e in town.agents.events(lead["id"]) if e["kind"] == "user"][-1]["data"]["text"]
        assert said == "关于卡片上要我决定的「换个 batch size」：先试 64"
        assert row["decisions"] == [] and row["card"]["need_you"] == ["批准用 72G 那张卡重跑消融", "换个 batch size"]
        assert c.post(f"/api/lines/{lid}/decide", json={"kind": "need", "id": "别的事", "value": "同意"}).status_code == 409
        c.post(f"/api/lines/{lid}/card", json={})
        c.post(f"/api/bridge/{lead['id']}/card", json={"card": CARD | {"need_you": []}}, headers=h)
        assert town.cards._read(lid)["decided"] == []


def test_a_terminal_dialog_is_answered_with_its_own_keys(tmp_path, monkeypatch):
    town, hosted, backend, aid = memory_employee(tmp_path)
    backend.text = CLAUDE
    hosted.refresh(aid)
    a = town.agents.get(aid)
    hosted.save(a, a["term"] | {"status": "blocked", "reason": "permission"})
    hosted._prompts[aid] = parse(CLAUDE)
    sent = []
    monkeypatch.setattr(backend, "keys", lambda handle, keys: sent.append(keys))

    [d] = town.cards.one(a["line_id"])["decisions"]
    assert d["kind"] == "prompt" and d["agent"] == aid and d["id"] == parse(CLAUDE)["digest"]
    assert [o["label"] for o in d["options"]] == ["No, exit", "Yes, I trust this folder"] and d["options"][0]["main"]
    assert "Quick safety check" in d["title"]
    row = town.cards.decide(a["line_id"], "prompt", d["id"], aid, 1, None)
    assert sent == [["down", "enter"]] and row["decisions"] == []
    town.agents.shutdown()
