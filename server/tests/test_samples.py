import time

import pytest
from fastapi.testclient import TestClient

from papertown import samples
from papertown.api import create_app
from papertown.pipeline import NAMES
from papertown.town import Town

from .conftest import make_settings, wait_for


def settle(town, ids, timeout=90):
    """Wait until every sample has got where it is going (shipped, parked or waiting)."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        lines = [town.pipeline.line(i) for i in ids]
        if all(ln["status"] in ("done", "paused", "waiting", "failed") and not town.pipeline.running(ln["id"]) for ln in lines):
            if not any(ln["status"] == "waiting" and ln["hold"] for ln in lines):
                return {ln["idea"]: ln for ln in lines}
        time.sleep(0.05)
    raise TimeoutError([town.pipeline.line(i)["status"] for i in ids])


def test_samples_park_along_the_line_and_resume(town):
    out = samples.seed(town)
    assert len(out["added"]) == len(samples.SAMPLES) and "等你决定" in out["note"]
    time.sleep(0.5)  # the driver hatches each sample once the hatchery has reported
    by = settle(town, out["added"])
    until = {x["idea"]: x["until"] for x in samples.SAMPLES}
    for idea, ln in by.items():
        snap = town.pipeline.snapshot(ln["id"])
        stage = {s["key"]: s["status"] for s in snap["stages"]}
        u = until[idea]
        if u is None:
            assert ln["status"] == "done", ln["note"]
        elif u == "hatch":
            assert ln["status"] == "waiting"
        else:
            assert ln["status"] == "paused" and NAMES[u] in ln["note"]
            assert stage[u] != "done" and ln["hold"] is None
    assert samples.seed(town)["added"] == []

    parked = next(ln for idea, ln in by.items() if until[idea] == "review")
    town.pipeline.resume(parked["id"])
    wait_for(town, parked["id"], {"done"})
    assert town.pipeline.line(parked["id"])["status"] == "done"

    got = samples.papers_of(town, parked["id"])
    assert got["survey"] and got["survey"][0].get("closest") and got["survey"][0]["note"]
    assert got["references"] and all("arxiv.org" in r["url"] for r in got["references"])


def test_samples_only_offline(tmp_path):
    t = Town(make_settings(tmp_path, provider="openai", openai_api_key="x"))
    with pytest.raises(samples.SampleError):
        samples.seed(t)


def test_library_shelf_and_first_start(tmp_path):
    app = create_app(make_settings(tmp_path, samples=True))
    with TestClient(app) as c:
        town = app.state.town
        assert town.db.val("select count(*) from lines") == len(samples.SAMPLES)
        shelf = c.get("/api/library").json()
        assert shelf["total"] == town.library.count() and len(shelf["papers"]) == 60
        labels = {t["label"] for t in shelf["topics"]}
        assert {"仓库级代码 Agent", "KV cache 压缩", "大模型审稿"} <= labels and sum(t["n"] for t in shelf["topics"]) == shelf["total"]
        one = c.get("/api/library", params={"topic": "稀疏注意力"}).json()
        assert one["papers"] and all(p["topic"] == "稀疏注意力" for p in one["papers"])
        hits = c.get("/api/library", params={"q": "KV cache compression"}).json()["papers"]
        assert hits and "similarity" in hits[0]
        assert c.post("/api/samples").json()["added"] == []
        assert c.get("/api/lines/line_404/papers").status_code == 404
