from papertown import samples
from papertown.pipeline import MODULES


def test_prebuilt_samples_and_idempotence(town, monkeypatch):
    monkeypatch.setattr(town.agents, "start", lambda *a, **k: (_ for _ in ()).throw(AssertionError("sample started an agent")))
    result = samples.seed(town)
    assert len(result["added"]) == len(samples.SAMPLES) == 5
    assert "预制" in result["note"] and "开关" in result["note"]
    for lid, fixture in zip(result["added"], samples.SAMPLES):
        snap = town.pipeline.snapshot(lid)
        assert snap["sample"] and not snap["lead"]["on"] and snap["team"] == []
        assert {s["key"]: {k: s[k] for k in ("status", "pct", "note")} for s in snap["stages"]} == fixture["stages"]
        events = town.agents.events(f"lead-{lid}")
        assert [e["data"]["text"] for e in events] == [e["text"] for e in fixture["chat"]]
        for event in events:
            if event["kind"] == "user":
                assert event["data"]["origin"] == "web" and event["data"]["user_text"] == event["data"]["text"]
            if event["kind"] == "sent":
                [ref] = event["data"]["basis"]
                assert any(row["id"] == str(event["id"]) for row in town.decided.detail(lid, ref)["work"]["tells"])
        assert town.agents.get(f"lead-{lid}")["runtime"] is None
        summary = town.cards._read(lid)["card"]["summary"]
        assert summary == fixture["card"]["summary"] and summary.count("**") == 2
        assert all(r["text"].count("**") == 2 for r in fixture["reports"] if r["kind"] == "report")
        v = town.decided.view(lid)
        assert set(d["mod"] for d in v["decisions"] if d["state"] == "active") == {m for m, _ in MODULES}
        assert len(v["matters"]) == 1 and any(d["state"] == "replaced" for d in v["decisions"])
        assert len(v["decisions"]) == 1 + len(fixture["decided"])
        items = town.db.q("select created_at from items where line_id = ? order by created_at", lid)
        assert len({i["created_at"] for i in items}) == len(items)
        for name, text in fixture["press"].items():
            assert (town.press.dir(lid) / name).read_text() == text
        samples.papers_of(town, lid)
    assert town.leads.asks() and all(q["data"]["who"] == "项目负责人" for q in town.leads.asks())
    assert samples.seed(town)["added"] == []
    assert samples.shelf(town)["total"] > 0


def test_maybe_seed_first_empty_start(town):
    samples.maybe_seed(town)
    assert not town.pipeline.lines()
    town.s.samples = True
    samples.maybe_seed(town)
    assert len(town.pipeline.lines()) == 5
    samples.maybe_seed(town)
    assert len(town.pipeline.lines()) == 5


def test_maybe_seed_preserves_populated_town(town):
    town.s.samples = True
    town.pipeline.create("An existing project")
    samples.maybe_seed(town)
    assert len(town.pipeline.lines()) == 1
