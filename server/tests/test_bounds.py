import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from papertown.bounds import BoundsError

from .test_farm_agents import IDEA, with_paseo


def rule(text, kind="must", inherit="yes", action=None):
    return {"kind": kind, "text": text, "inherit": inherit, "action": action}


def test_rules_pass_down_the_levels_as_their_inheritance_says(town):
    line = town.pipeline.create(IDEA)
    lid = line["id"]
    b = town.bounds
    g = b.save(None, None, [rule("提交和推送前先问我", "ask", "force"), rule("改动要跑测试", "must", "yes"),
                            rule("跨项目调卡前问我", "ask", "no"), rule("不要取消别人的任务", "never", "yes", "job.cancel")])["levels"]["global"]["rules"]
    force, tests, mine, cancel = (r["id"] for r in g)
    p = b.save(lid, None, [rule("每天汇报一次", "must", "no"), rule("实验先跑小规模", "must", "yes"), rule("不碰数据集", "never", "force")],
               off=[tests, force])["levels"]["project"]
    assert p["off"] == [tests]
    daily, small, data = (r["id"] for r in p["rules"])
    b.save(lid, "coder", [rule("只改 src/ 下的文件", "never")], off=[small, cancel, data])

    ids = lambda role: [r["id"] for r in b.effective(role, lid)]  # noqa: E731
    assert ids("assistant") == [force, tests, mine, cancel]
    assert ids("lead") == [force, cancel, daily, small, data]
    coder = b.effective("coder", lid)
    assert [r["id"] for r in coder][:2] == [force, data] and coder[-1]["text"] == "只改 src/ 下的文件" and coder[-1]["from"] == "worker"
    assert all(r["locked"] for r in coder[:2])
    assert ids("writer") == [force, cancel, small, data]

    assert b.policy("assistant", None, "job.cancel") == ("never", g[3] | {"from": "global", "locked": False})
    assert b.policy("lead", lid, "job.cancel")[0] == "never" and b.policy("coder", lid, "job.cancel")[0] == "auto"
    assert b.policy("lead", lid, "tell", "auto") == ("auto", None)
    text = b.text("lead", lid)
    assert "必须完成：\n- 每天汇报一次（项目）" in text and "Papertown 会拦下「取消实验任务」" in text and "pt ask" in text

    with pytest.raises(BoundsError):
        b.save(None, None, [rule("跑完实验", "must", "yes", "job.submit")])
    with pytest.raises(BoundsError):
        b.save(None, None, [rule("x", "maybe")])
    kept = b.save(None, None, [r | {"text": r["text"] + "。"} for r in g])["levels"]["global"]["rules"]
    assert [r["id"] for r in kept] == [force, tests, mine, cancel]


def test_agents_read_their_rules_and_hear_when_they_change(tmp_path):
    app, calls = with_paseo(tmp_path)
    with TestClient(app) as c:
        town = app.state.town
        lid = c.post("/api/ideas", json={"text": IDEA}).json()["id"]

        c.put("/api/bounds", json={"rules": [rule("不要 push 到远端", "never", "force")]})
        a = c.post("/api/agents", json={"line_id": lid, "role": "coder"}).json()
        c.post(f"/api/agents/{a['id']}/start", json={"runtime": "paseo", "provider": "pi"})
        guide = Path(town.agents.get(a["id"])["cwd"]) / "AGENTS.md"
        assert "## 工作边界" in guide.read_text() and "不要 push 到远端（全局）" in guide.read_text()
        sent = calls.read_text().count("send pa-1")

        v = c.put("/api/bounds", json={"line_id": lid, "role": "coder", "rules": [rule("只改 src/ 下的文件", "never")]}).json()
        assert [r["text"] for r in v["effective"]["coder"]] == ["不要 push 到远端", "只改 src/ 下的文件"]
        assert v["effective"]["assistant"][0]["text"] == "不要 push 到远端" and "lead" in v["effective"]
        assert "只改 src/ 下的文件（员工）" in guide.read_text()
        t0 = time.time()
        while calls.read_text().count("send pa-1") == sent and time.time() - t0 < 15:
            time.sleep(0.2)
        assert calls.read_text().count("send pa-1") == sent + 1 and "<bounds>" in town.agents.events(a["id"])[-1]["data"]["text"]
        h = {"x-papertown-token": town.agents.get(a["id"])["token"]}
        assert "只改 src/ 下的文件" in c.get(f"/api/bridge/{a['id']}/rules", headers=h).json()["text"]

        c.put("/api/bounds", json={"line_id": lid, "role": "writer", "rules": [rule("不改模板", "never")]})
        assert calls.read_text().count("send pa-1") == sent + 1
        assert c.put("/api/bounds", json={"line_id": "nope", "rules": []}).status_code == 400
