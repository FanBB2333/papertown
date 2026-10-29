import time

from fastapi.testclient import TestClient

from papertown.api import create_app

from .conftest import make_settings, wait_for

IDEA = "用检索增强做论文的新颖性评估"


def wait_job(town, job_id, timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        j = town.farm.get(job_id)
        if j["status"] not in ("queued", "running"):
            return j
        time.sleep(0.05)
    raise TimeoutError(job_id)


def test_local_job_reports_progress_and_result(town):
    line = town.pipeline.submit_idea(IDEA)
    cmd = "echo PROGRESS 30; echo PROGRESS 70; echo 'RESULT {\"acc\": 0.91}'"
    j = wait_job(town, town.farm.submit(line["id"], "main", cmd)["id"])
    assert j["status"] == "done" and j["result"] == {"acc": 0.91} and j["progress"] == 100
    assert "PROGRESS 70" in town.farm.log(j["id"])
    notes = [e["data"]["text"] for e in town.agents.events(f"monitor-{line['id']}")]
    assert any("排进" in n for n in notes) and any("过半" in n for n in notes) and "acc 0.91" in notes[-1]

    bad = wait_job(town, town.farm.submit(line["id"], "bad", "echo oops; exit 3")["id"])
    assert bad["status"] == "failed" and "3" in bad["note"]


def test_bridge_mirrors_a_pi_session(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as c:
        town = app.state.town
        line_id = c.post("/api/ideas", json={"text": IDEA}).json()["id"]
        wait_for(town, line_id, {"waiting"})
        a = c.post("/api/agents", json={"line_id": line_id, "role": "coder"}).json()
        assert a["status"] == "stopped" and "token" not in a and a["attach"].startswith("tmux -L papertown")
        assert c.post(f"/api/agents/{a['id']}/say", json={"text": "hi"}).status_code == 400  # no pi on this machine

        token = town.agents.get(a["id"])["token"]
        assert c.post(f"/api/bridge/{a['id']}/events", json={"events": []}).status_code == 403
        h = {"x-papertown-token": token}
        events = [{"t": "hello", "model": "test/model", "idle": True},
                  {"t": "input", "text": "写个测试", "source": "interactive"},
                  {"t": "start"},
                  {"t": "assistant", "text": "好的", "tools": [], "usage": {"input": 10, "output": 2, "cost": 0.001}},
                  {"t": "tool_start", "id": "t1", "name": "bash", "args": {"command": "pytest"}},
                  {"t": "tool_end", "id": "t1", "name": "bash", "error": False, "result": "1 passed"},
                  {"t": "settled", "aborted": False}]
        assert c.post(f"/api/bridge/{a['id']}/events", json={"events": events}, headers=h).status_code == 200
        got = c.get(f"/api/agents/{a['id']}").json()
        assert got["agent"]["status"] == "idle" and got["agent"]["model"] == "test/model"
        kinds = [(e["kind"], e["data"].get("origin")) for e in got["events"]]
        assert ("user", "terminal") in kinds and ("assistant", None) in kinds and ("tool_end", None) in kinds
        assert town.db.val("select cost from agents where id = ?", a["id"]) > 0

        town.agents._inbox[a["id"]] = [{"id": 1, "text": "from web"}]
        assert c.get(f"/api/bridge/{a['id']}/inbox?wait=0", headers=h).json()["messages"][0]["text"] == "from web"
        assert "项目 #1" in c.get(f"/api/bridge/{a['id']}/brief", headers=h).json()["text"]
        j = c.post(f"/api/bridge/{a['id']}/jobs", json={"name": "smoke", "command": "echo PROGRESS 100"}, headers=h).json()
        assert j["line_id"] == line_id and j["submitted_by"] == a["id"]
        assert wait_job(town, j["id"])["status"] == "done"
        assert c.get(f"/api/agents?role=coder").json()["roster"][0]["agent"]["id"] == a["id"]
