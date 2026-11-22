import math
import zipfile

import pytest

from papertown.pipeline import LineError, STAGES
from papertown.samples import SAMPLES

IDEA = "用结构化场景图记录机器人长程规划中的状态变化"


def test_create_is_immediate_and_wakes_lead(town, monkeypatch):
    calls = []
    monkeypatch.setattr(town.leads, "wake", calls.append)
    line = town.pipeline.create(IDEA)
    assert line["status"] == "running" and line["stage"] == "hatch"
    assert [s["status"] for s in line["stages"]] == ["done", "run"] + ["todo"] * 6
    assert calls == [line["id"]] and line["team"] == []
    assert all(s["owner"] and s["agents"] == [] for s in line["stages"])
    assert not {"budget", "spent", "revisions", "reason"} & line.keys()
    with pytest.raises(LineError):
        town.pipeline.create("短")


@pytest.mark.parametrize("stage", ["hatch", "method", "review"])
def test_output_required_before_closing(town, stage):
    lid = town.pipeline.create(IDEA)["id"]
    with pytest.raises(LineError, match="产出"):
        town.pipeline.stage(lid, stage, "done")


def test_gate_blocks_until_waived_and_next_stage_opens(town):
    lid = town.pipeline.create(IDEA)["id"]
    town.pipeline.output(lid, "hatch", {"gap": "差异说明"})
    town.checks.set(lid, "novelty", params={"sim": .01})
    with pytest.raises(LineError, match="硬卡口"):
        town.pipeline.stage(lid, "hatch", "done")
    town.canvas.gate(lid, "hatch", "waive")
    snap = town.pipeline.stage(lid, "hatch", "done")
    assert snap["stages"][1]["status"] == "done" and snap["stages"][2]["status"] == "run"
    snap = town.pipeline.stage(lid, "team", "done")
    assert town.pipeline.item(lid, "team")["team"] == []
    assert snap["stage"] == "method"


def test_ship_packages_and_reopens(town, monkeypatch):
    lid = town.pipeline.create(IDEA)["id"]
    folder = town.press.dir(lid)
    (folder / "main.tex").write_text("paper")
    (folder / "refs.bib").write_text("references")
    snap = town.pipeline.stage(lid, "ship", "done")
    assert snap["status"] == "done" and "paper.zip" in snap["files"]
    with zipfile.ZipFile(folder / "paper.zip") as package:
        assert {"main.tex", "refs.bib"} <= set(package.namelist())
    snap = town.pipeline.stage(lid, "ship", "run")
    assert snap["status"] == "running" and snap["stages"][-1]["pct"] == 0
    snap = town.pipeline.stage(lid, "ship", "todo")
    assert snap["status"] == "running" and snap["stages"][-1]["pct"] == 0
    assert snap["stages"][-1]["ended_at"] is None
    snap = town.pipeline.stage(lid, "ship", "run", "重新整理", 35)
    assert snap["stages"][-1]["pct"] == 35
    assert snap["stages"][-1]["ended_at"] is None


@pytest.mark.parametrize("stage,body", [("idea", {}), ("hatch", []), ("hatch", {}), ("method", {"title": "T"}),
    ("write", {}), ("review", {}), ("exp", {"metrics": ["Acc"], "rows": []}),
    ("exp", {"metrics": ["Acc"], "rows": [{"method": "A", "values": [math.nan]}]}),
    ("exp", {"metrics": ["Acc", "F1"], "rows": [{"method": "A", "values": [1]}]}),
    ("method", {"title": "T", "problem": "P", "baselines": 4})])
def test_output_validation(town, stage, body):
    lid = town.pipeline.create(IDEA)["id"]
    with pytest.raises(LineError):
        town.pipeline.output(lid, stage, body)


def test_outputs_and_code_scored_hatch(town):
    lid = town.pipeline.create(IDEA)["id"]
    survey = town.pipeline.survey(lid)
    out = town.pipeline.output(lid, "hatch", {"gap": "差异", "verdict": "伪造", "similarity": 0,
        "similar": [{"paper_id": h["paper_id"], "similarity": 0, "note": "阅读笔记"} for h in survey["hits"][-1:]]})
    assert out["verdict"] == survey["verdict"]
    assert max(s["similarity"] for s in out["similar"]) == max(s["similarity"] for s in survey["hits"])
    assert town.pipeline.line(lid)["verdict"] == survey["verdict"]
    for stage, body in [("method", {"title": "A method", "problem": "P", "baselines": ["B"]}),
                        ("exp", {"metrics": ["Acc"], "rows": [{"method": "A", "values": [1.2]}]}),
                        ("write", {"title": "A paper", "cite_ids": []}), ("review", {"verdict": "放行"})]:
        town.pipeline.output(lid, stage, body)
        assert town.pipeline.item(lid, stage)


@pytest.mark.parametrize("old", ["hatching", "waiting", "paused", "failed", "running", "done"])
def test_migrate_old_states_and_samples(town, old):
    lid = town.pipeline.create(SAMPLES[0]["idea"])["id"]
    town.db.update("lines", {"id": lid}, status=old, sample=0)
    town.db.update("stages", {"line_id": lid, "key": "hatch"}, status="fail")
    town.db.update("stages", {"line_id": lid, "key": "team"}, status="wait")
    town.pipeline.migrate()
    snap = town.pipeline.snapshot(lid)
    assert snap["status"] == ("done" if old == "done" else "running") and snap["sample"]
    assert snap["stages"][1]["status"] == "run" and snap["stages"][2]["status"] == "todo"
    town.pipeline.migrate()
    assert town.pipeline.snapshot(lid) == snap
