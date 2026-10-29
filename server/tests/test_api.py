from fastapi.testclient import TestClient

from papertown.api import create_app
from papertown.llm import ToolCall, ToolResult, Turn
from papertown.llm.anthropic_provider import AnthropicProvider
from papertown.llm.openai_provider import OpenAICompatProvider

from .conftest import make_settings, wait_for


def test_api_flow(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as c:
        w = c.get("/api/world").json()
        ids = {p["id"] for p in w["placements"]}
        assert {"hatchery", "library", "mill", "depot"} <= ids and "depot_a" not in ids
        core = sorted((p["type"], p["id"]) for p in w["placements"] if p["core"])
        assert core == [("depot", "depot"), ("farm", "farm"), ("mill", "mill"), ("press", "press")]
        assert c.get("/api/buildings/mill").json()["job"].startswith("空闲")
        assert w["hud"]["offline"] is True

        r = c.post("/api/ideas", json={"text": "用检索增强做论文的新颖性评估"})
        assert r.status_code == 200
        line_id = r.json()["id"]
        wait_for(app.state.town, line_id, {"waiting"})

        sheet = c.get("/api/buildings/hatchery").json()
        assert sheet["live"] and sheet["skills"] == ["novelty-check"] and len(sheet["stations"]) == 5
        assert c.get("/api/buildings/weather").json()["job"] == "未接入"
        assert c.post(f"/api/lines/{line_id}/resume").status_code == 400

        msgs = c.get("/api/messages").json()
        assert any(m["kind"] == "report" for m in msgs)
        st = c.get("/api/status").json()
        assert st["projects"][0]["id"] == line_id and {x["kind"] for x in st["calls"]} >= {"RAG", "MCP", "SKILL"}
        assert c.get(f"/api/lines/{line_id}/files/../../papertown.db").status_code == 404


def test_message_conversion():
    turns = [Turn("user", text="hi"),
             Turn("assistant", text="look", calls=[ToolCall("c1", "library_search", {"query": "x"})]),
             Turn("tool", results=[ToolResult("c1", "library_search", "{}")])]
    a = AnthropicProvider._messages(turns)
    assert a[1]["content"][1] == {"type": "tool_use", "id": "c1", "name": "library_search", "input": {"query": "x"}}
    assert a[2]["content"][0]["type"] == "tool_result" and a[2]["content"][0]["tool_use_id"] == "c1"
    o = OpenAICompatProvider._messages("sys", turns)
    assert o[0]["role"] == "system" and o[2]["tool_calls"][0]["function"]["name"] == "library_search"
    assert o[3] == {"role": "tool", "tool_call_id": "c1", "content": "{}"}


def test_the_town_model_can_be_switched_for_this_run(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as c:
        info = c.get("/api/llm").json()
        assert info["provider"] == "mock" and {p["id"] for p in info["providers"]} == {"mock", "anthropic", "openai"}
        assert c.post("/api/llm", json={"provider": "nope"}).status_code == 400
        got = c.post("/api/llm", json={"model_strong": "scripted-2"}).json()
        assert got["provider"] == "mock" and got["model_strong"] == "scripted-2" and app.state.town.s.model_strong == "scripted-2"
