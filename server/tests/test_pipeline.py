import pytest

from papertown.pipeline import LineError

from .conftest import wait_for

IDEA = "让 VLA 模型用结构化的场景图做长程规划，减少多步任务里的误差累积"


def test_idea_to_paper_offline(town):
    line = town.pipeline.submit_idea(IDEA, budget=1.0)
    ln = wait_for(town, line["id"], {"waiting", "failed"})
    assert ln["status"] == "waiting" and ln["verdict"] in {"可孵化", "需调整", "已被做过"}
    report = town.pipeline.item(line["id"], "hatch")
    assert report["similar"] and report["sources"]["library"] > 0
    assert all(0 <= s["similarity"] <= 1 for s in report["similar"])

    snap = town.pipeline.hatch(line["id"])
    assert snap["mill_id"] == "mill"
    assert [b["id"] for b in town.db.q("select id from buildings where type = 'mill'")] == ["mill"]
    ln = wait_for(town, line["id"], {"done", "failed"})
    assert ln["status"] == "done", ln["note"]

    snap = town.pipeline.snapshot(line["id"])
    assert [s["status"] for s in snap["stages"]] == ["done"] * 8
    outputs = {r["stage"] for r in town.db.q("select stage from items where line_id = ?", line["id"])}
    assert {"idea", "hatch", "team", "method", "exp", "write", "review", "ship"} <= outputs
    table = town.pipeline.item(line["id"], "exp")
    assert table["simulated"] is True and table["rows"][-1]["method"] == "Ours"
    jobs = town.farm.list(line["id"])
    assert [(j["backend"], j["status"]) for j in jobs] == [("sim", "done")]
    notes = town.agents.events(f"monitor-{line['id']}")
    assert notes and "跑完了" in notes[-1]["data"]["text"]
    assert "main.tex" in snap["files"] and "refs.bib" in snap["files"]
    assert "Anonymous Authors" in town.press.read(line["id"])

    kinds = {r["kind"] for r in town.db.q("select distinct kind from trace where line_id = ?", line["id"])}
    assert {"SKILL", "RAG", "GRAPH", "SCRIPT", "LLM", "TOOL"} <= kinds
    assert town.db.val("select count(*) from ledger where line_id = ?", line["id"]) > 0
    assert town.db.val("select sum(runs) from workers") > 0


def test_cannot_hatch_twice_or_too_short(town):
    with pytest.raises(LineError):
        town.pipeline.submit_idea("短")
    line = town.pipeline.submit_idea(IDEA)
    with pytest.raises(LineError):
        town.pipeline.hatch(line["id"])
    wait_for(town, line["id"], {"waiting"})
    town.pipeline.adjust(line["id"], IDEA + "，只在真实机器人上验证")
    wait_for(town, line["id"], {"waiting"})
    assert "真实机器人" in town.pipeline.line(line["id"])["idea"]


def test_restart_parks_running_lines(town):
    line = town.pipeline.submit_idea(IDEA)
    wait_for(town, line["id"], {"waiting"})
    town.db.update("lines", {"id": line["id"]}, status="running")
    town.pipeline.recover()
    assert town.pipeline.line(line["id"])["status"] == "paused"


@pytest.mark.parametrize('mode', ['provider_error', 'missing_result'])
def test_failed_model_stops_the_stage_without_fabricating_a_template(town, mode):
    from papertown.llm import ProviderError, Reply, Usage

    class BrokenProvider:
        name = 'broken'

        def complete(self, **kwargs):
            if mode == 'provider_error':
                raise ProviderError('authentication failed')
            return Reply(text='I have no result', calls=[], usage=Usage())

    town.provider = BrokenProvider()
    lid = town.pipeline.submit_idea(IDEA)['id']
    line = wait_for(town, lid, {'failed'})
    assert 'authentication failed' in line['note'] if mode == 'provider_error' else '模型没有提交结果' in line['note']
    assert town.pipeline.item(lid, 'hatch') is None
    assert not town.db.val("select 1 from stages where line_id = ? and status = 'run'", lid)
    runs = town.db.q('select status, error from runs where line_id = ?', lid)
    assert runs and all(r['status'] == 'failed' and r['error'] for r in runs)
    assert not town.db.val("select 1 from trace where label = '离线模板' and line_id = ?", lid)
