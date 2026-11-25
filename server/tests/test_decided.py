"""The user authors research decisions. Project work and the method gate cite those decisions."""

import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from xml.etree import ElementTree

import pytest
from fastapi.testclient import TestClient

from papertown.api import create_app
from papertown.db import DB
from papertown.decided import METHOD
from papertown.pipeline import LineError, MODULES
from papertown.town import Town
from .conftest import make_settings

IDEA = "按证据的位置评测长文档问答"
METHOD_BODY = {"title": "Evidence Position", "problem": "长文档中部的证据", "mechanism": ["保存注意力位置"],
               "baselines": ["完整缓存"], "datasets": ["分层问答集"], "metrics": ["精确匹配率"]}


@pytest.fixture
def project(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as c:
        town = app.state.town
        lid = c.post("/api/ideas", json={"text": IDEA}).json()["id"]
        yield c, town, lid


def bridge(town, lid, role):
    a = town.assistant.row() if role == "assistant" else town.agents.ensure(lid, role)
    return "/api/bridge/" + a["id"], {"x-papertown-token": a["token"]}


def matter(c, path, headers, **kw):
    body = {"mod": "exp", "question": "如何分组？", "facts": ["评测集有三个长度区间。"],
            "options": ["按输入长度分组", "按证据位置分组"], "materials": [{"kind": "file", "ref": "code/groups.csv", "title": "长度统计"}]}
    r = c.post(path + "/raise", headers=headers, json=body | kw)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_startup_backfills_original_idea_once(tmp_path):
    s = make_settings(tmp_path)
    db = DB(s.db_path)
    at = "2024-03-04T00:00:00+00:00"
    db.insert("lines", {"id": "line_1", "seq": 1, "title": "旧题", "idea": "原文\n  第二段", "status": "done", "created_at": at})
    for _ in range(2):
        t = Town(s)
        t.start()
        try:
            [d] = t.decided.view("line_1")["decisions"]
            assert (d["n"], d["mod"], d["text"], d["source"], d["created_at"]) == (1, "overview", "原文\n  第二段", "idea", at)
            cutoff = t.db.get_meta("decided_since")
            if not _:
                first, since = d["id"], cutoff
            assert d["id"] == first and cutoff == since
        finally:
            t.stop()


def test_user_routes_history_and_card(project, monkeypatch):
    c, town, lid = project
    url = f"/api/lines/{lid}/decided"
    view = c.get(url).json()
    d1, = view["decisions"]
    assert re.fullmatch(r"dc_[0-9a-f]{10}", d1["id"])
    assert (d1["n"], d1["text"], d1["source"], d1["state"]) == (1, IDEA, "idea", "active")
    assert view["mods"] == [{"id": m, "name": n} for m, n in MODULES]
    assert view["stats"] == {"total": 1, "active": 1, "anchored": 0, "loose": 0}
    events = []
    monkeypatch.setattr(town.bus, "publish", lambda name, **data: events.append((name, data)))
    p, h = bridge(town, lid, "lead")
    assert "D1 " + IDEA in c.get(p + "/decided", headers=h).json()["text"]
    body = {"text": "主表按位置分组。", "mod": "paper", "materials": [{"kind": "paper", "ref": "x", "title": "材料"}]}
    assert c.post(p + "/decided", headers=h, json=body).status_code in (404, 405)
    assert c.post(url, headers=h, json=body).status_code == 403
    assert c.post(url + "/D1/withdraw", headers=h).status_code == 403
    assert c.post(url, json=body | {"mod": "other"}).status_code == 400
    assert c.post(url, json=body | {"text": "  "}).status_code == 400
    d2 = c.post(url, json=body).json()
    assert d2["source"] == "written" and d2["materials"] == body["materials"]
    d3 = c.post(url, json=body | {"text": "将首尾合组。", "replaces": d2["id"]}).json()
    assert d3["replaces"] == d2["id"]
    old = c.get(url + "/D2").json()
    assert old["state"] == "replaced" and old["replaced_by"] == d3["id"] and old["ended_at"] and old["text"] == body["text"]
    assert c.post(url, json=body | {"replaces": "D2"}).status_code == 409
    card = c.get(f"/api/lines/{lid}/card").json()
    assert card["decided"]["latest"] == [{"id": d["id"], "n": d["n"], "mod": d["mod"], "text": d["text"]} for d in (d1, d3)]
    assert card["prov"] == {"floats": {"total": 0, "tagged": 0}, "numbers": {"total": 0, "ok": 0}, "changed": 0, "ops": 0, "recent": []}
    assert c.post(url + "/D3/withdraw").json()["state"] == "withdrawn"
    assert c.post(url + "/D3/withdraw").status_code == 409
    assert c.get(url).json()["stats"] == {"total": 3, "active": 1, "anchored": 0, "loose": 0}
    assert ("decided", {"line_id": lid, "id": d3["id"]}) in events
    assert any(name == "card" and data["card"]["decided"]["total"] == 3 for name, data in events)


def test_exact_quote_and_human_answers(project):
    c, town, lid = project
    p, h = bridge(town, lid, "coder")
    aid = f"coder-{lid}"
    def said(text):
        return c.post(p + "/said", headers=h, json={"text": text, "mod": "data"})

    for kind, origin in [("user", "web"), ("user", "terminal"), ("assistant", "web"), ("user", "papertown"), ("user", "assistant"), ("user", aid)]:
        original = f"{kind} {origin}\n  保留原文。"
        ev = town.agents.record(aid, kind, {"text": original, "origin": origin})
        quote = f"/api/lines/{lid}/decided/quote"
        allowed = origin in ("web", "terminal") and kind == "user"
        if not allowed:
            assert said(original).status_code == c.post(quote, json={"event_id": ev["id"], "mod": "data"}).status_code == 404
            continue
        d = said(original[:original.index("\n")]).json()
        copy = c.post(quote, json={"event_id": ev["id"], "mod": "data"}).json()
        assert d["id"] == copy["id"] and copy["text"] == original and copy["source"] == "chat"
        assert town.db.one("select data from agent_events where id = ?", ev["id"])["data"]["decided"] == f"D{copy['n']}"
    other = town.pipeline.create("另一个项目的原话")["id"]
    town.agents.record(town.agents.ensure(other, "lead")["id"], "user", {"origin": "web", "text": "跨项目引用"})
    assert said("跨项目引用").status_code == said("模型编的原话").status_code == 404
    q = town.leads.ask(aid, "评测设备是哪一台？")
    c.post(f"/api/reports/{q['id']}/answer", json={"text": "评测只用 A 机。"})
    d = said("只用 A 机").json()
    assert c.get(f"/api/lines/{lid}/decided/{d['id']}").json()["text"] == "评测只用 A 机。"
    town.agents.record(aid, "user", {"origin": "web", "text": "核对词表\n\n附件：\n- 文件 /tmp/table.csv", "user_text": "核对词表"})
    d = said("核对词表").json()
    assert town.decided.detail(lid, d["id"])["text"] == "核对词表"
    assert said("/tmp/table.csv").status_code == 404
    q = town.leads.ask(aid, "下一个任务在哪台机器？")
    town.leads.answer(q["id"], "转述 B 机", by="assistant")
    assert said("转述 B 机").status_code == 404


def test_raise_rejects_leaning_and_allows_attribution(project):
    c, town, lid = project
    p, h = bridge(town, lid, "lead")
    for i, phrase in enumerate(["我建议", "建议你", "建议选", "推荐选", "我倾向", "我认为应该", "最好选", "I recommend",
                                "I suggest", "I'd go with", "I’d go with", "原论文建议用 A。我建议用 B", "读完论文我建议"]):
        key = ["question", "facts", "options"][i % 3]
        bad = phrase + " X"
        r = c.post(p + "/raise", headers=h, json={"mod": "survey", "question": "怎么评测？", "facts": ["论文报告了均值。"],
                                                 key: bad if key == "question" else [bad]})
        assert r.status_code == 400 and r.json()["detail"] == "只写事实和可能的做法，倾向留给用户"
    assert not town.leads.asks(lid)
    mid = matter(c, p, h, facts=["原论文建议用 X。", "作者建议选择 Y。", 'The authors wrote: “I suggest Z”.',
                                "审稿人写道：“我建议先核对划分，我倾向按位置分组。”"])
    [q] = town.leads.asks(lid)
    assert q["id"] == mid and q["data"]["choices"] == [] and q["data"]["act"] is None
    assert q["data"]["matter"]["mod"] == "exp"


def test_all_matter_answer_routes_and_delivery(project, monkeypatch):
    c, town, lid = project
    p, h = bridge(town, lid, "coder")
    for role in ("coder", "lead"):
        a = town.agents.ensure(lid, role)
        town.db.update("agents", {"id": a["id"]}, runtime="pi", status="idle")
    sent = []
    monkeypatch.setattr(town.agents, "say", lambda aid, msg, mode, origin: sent.append((aid, msg, mode, origin)))
    root = f"/api/lines/{lid}"
    text = "  保留 A & B。\n比较 <10 的一组。\n" + "同时记录交接次数。" * 240 + "\n"
    for path in ("decide", "report", "decided"):
        mid = matter(c, p, h)
        m, = c.get(root + "/decided").json()["matters"]
        card_m, = c.get(root + "/card").json()["decisions"]
        assert m["id"] == mid and card_m["kind"] == "matter" and card_m["write"] and not card_m["options"]
        assert m["facts"] == card_m["facts"] and m["options"] == card_m["options_text"] and m["materials"] == card_m["materials"]
        human = next(n for n in town.canvas.view(lid)["nodes"] if n["kind"] == "human")
        assert any(i["kind"] == "matter" and i["ask"] == mid for i in human["items"])
        answer = f"/api/reports/{mid}/answer"
        for k in ("matter", "ask"):
            assert c.post(root + "/decide", json={"kind": k, "id": str(mid), "value": "可以"}).status_code == 400
        assert c.post(answer, json={"value": "可以"}).status_code == 422
        assert c.post(answer, json={"text": "  "}).status_code == 400
        helper, header = bridge(town, None, "assistant")
        assert c.post(helper + "/answer", json={"id": str(mid), "text": "代写"}, headers=header).status_code == 400
        assert c.post(answer, json={"text": "代写"}, headers=h).status_code == 403
        assert c.post(root + "/decide", json={"kind": "need", "id": "不存在", "text": "代写"}, headers=h).status_code == 403
        if path == "report":
            assert c.post(answer, json={"text": text}).json()["data"]["answer"] == text
        elif path == "decide":
            assert c.post(root + "/decide", json={"kind": "matter", "id": str(mid), "text": text}).status_code == 200
        else:
            assert c.post(root + "/decided", json={"matter": mid, "text": text}).status_code == 200
        v = c.get(root + "/decided").json()
        d = v["decisions"][0]
        assert not v["matters"] and d["text"] == text and d["mod"] == "exp" and d["source"] == "answer"
        assert d["matter"]["question"] == m["question"] and d["matter"]["options"] == m["options"] and d["materials"] == m["materials"]
        assert c.post(answer, json={"text": text}).status_code == 409
        assert {a for a, *_ in sent} == {f"coder-{lid}", f"lead-{lid}"} and len(sent) == 2
        for _, xml, mode, origin in sent:
            el = ElementTree.fromstring(xml)
            assert el.tag == "decision" and el.attrib == {"mod": "exp", "id": f"D{d['n']}"} and el.text == text
            assert mode == "queue" and origin == "papertown"
        sent.clear()


def test_need_only_text_and_legacy_records(project):
    c, town, lid = project
    root = f"/api/lines/{lid}"
    town.cards._write(lid, {"card": {"need_you": ["旧问题", "如何分组？", "如何抽样？", "保留哪些列？"]},
                            "decided": [{"item": "旧问题", "choice": "同意", "at": 10, "sent": True}]})
    first, second, third = c.get(root + "/card").json()["decisions"]
    assert first["mod"] == "survey" and first["write"] and first["options"] == []
    assert c.post(root + "/decide", json={"kind": "need", "id": first["id"], "value": "同意"}).status_code == 400
    assert c.post(root + "/decided", json={"need": first["id"], "text": "   "}).status_code == 400
    assert c.post(root + "/decide", json={"kind": "need", "id": first["id"], "text": "按位置分组"}).status_code == 200
    d = c.post(root + "/decided", json={"need": second["id"], "text": "各组抽十篇", "mod": "data"}).json()
    assert (d["source"], d["ref"], d["mod"]) == ("answer", second["id"], "data")
    assert c.post(root + "/decided", json={"need": first["id"], "text": "重复"}).status_code == 409
    # Only one concurrent answer can claim the same line.
    with ThreadPoolExecutor(2) as pool:
        codes = list(pool.map(lambda s: c.post(root + "/decided", json={"need": third["id"], "text": s}).status_code, ["甲", "乙"]))
    assert sorted(codes) == [200, 409]
    assert c.get(root + "/card").json()["decisions"] == []
    assert c.get(root + "/decided").json()["stats"]["total"] == 4


def test_permission_rechecks_basis_and_never_writes_a_decision(project, monkeypatch):
    c, town, lid = project
    p, h = bridge(town, lid, "lead")
    monkeypatch.setattr(town.bounds, "policy", lambda *args: ("ask", {"text": "提交实验前询问"}))
    assert c.post(p + "/jobs", headers=h, json={"name": "长度分组", "command": "true", "basis": ["D1"]}).json()["status"] == "asking"
    root = f"/api/lines/{lid}"
    ask, = c.get(root + "/card").json()["decisions"]
    assert ask["kind"] == "ask" and ask["act"]["basis"] == ["D1"] and not ask.get("write")
    assert [o["value"] for o in ask["options"]] == ["可以", "不可以"]
    c.post(root + "/decided/D1/withdraw")
    answer = c.post(f"/api/reports/{ask['id']}/answer", json={"text": "可以"}).json()
    assert "依据无效：D1" in answer["data"]["result"]
    assert town.farm.list(lid) == [] and town.decided.view(lid)["stats"]["total"] == 1


def test_linked_job_cutoff_compares_instants(project, monkeypatch):
    _, town, lid = project
    since = datetime.fromisoformat(town.db.get_meta("decided_since"))
    local = timezone(timedelta(hours=8))
    rows = [{"id": i, "name": "数据清洗", "created_at": (since + timedelta(seconds=i)).astimezone(local).isoformat()}
            for i in (-1, 1)]
    monkeypatch.setattr(town.linked, "jobs", lambda line_id: rows)
    view = town.decided.view(lid)
    assert view["stats"]["loose"] == 1 and view["loose"][0]["id"] == "nvidb-1"


def test_work_basis_validation_counts_and_permissions(project, monkeypatch):
    c, town, lid = project
    root = f"/api/lines/{lid}"
    p, h = bridge(town, lid, "lead")
    coder = town.agents.ensure(lid, "coder")
    town.db.update("agents", {"id": coder["id"]}, runtime="pi", status="idle")
    monkeypatch.setattr(town.agents, "alive", lambda a: True)
    monkeypatch.setattr(town.farm, "_run_local", lambda jid: None)
    messages = []
    monkeypatch.setattr(town.agents, "say", lambda aid, msg, mode, origin: messages.append(msg))
    task = c.post(root + "/canvas/nodes", json={"kind": "task", "to": "coder", "title": "核对样本划分", "basis": ["D1"]}).json()["added"]
    helper, header = bridge(town, None, "assistant")
    act = c.post(helper + "/act", headers=header, json={"action": "canvas.add", "args": {"line": lid, "kind": "task", "title": "汇总计数"}}).json()
    tid = act["text"].split("编号 ")[-1]
    nodes = {n["id"]: n for n in town.canvas.view(lid)["nodes"]}
    assert nodes[task]["created_by"] == "you" and nodes[tid]["created_by"] == "assistant"
    written = c.post(root + "/decided", json={"mod": "exp", "text": "按位置比较缓存预算。"}).json()
    c.post(root + "/decided/D2/withdraw")
    other = town.pipeline.create("另一个任务的项目")["id"]
    for _ in range(2):
        town.decided.write(other, "另一项目的决定", "code")
    invalid = ["D2", "D3", "#" + tid, "#missing"]
    for endpoint, body in [("/output", {"stage": "method", "body": METHOD_BODY | {"basis": {"problem": invalid}}}),
                           ("/jobs", {"name": "job", "command": "true", "basis": invalid}),
                           ("/tell", {"to": "coder", "text": "核对", "basis": invalid})]:
        r = c.post(p + endpoint, headers=h, json=body)
        assert r.status_code == 400 and all(ref in r.json()["detail"] for ref in invalid)
    assert town.decided.detail(lid, written["id"])["state"] == "withdrawn"
    refs = ["D1", "#" + task]
    j = c.post(p + "/jobs", headers=h, json={"name":"job", "command":"true", "basis": refs}).json()
    assert j["basis"] == refs and j["submitted_by"] == f"lead-{lid}"
    assert c.post(p + "/output", headers=h, json={"stage": "method", "body": METHOD_BODY | {"basis": {"problem": refs}}}).status_code == 200
    item = town.db.one("select * from items where line_id = ? and stage = 'method'", lid)
    assert item["agent_id"] == f"lead-{lid}" and item["body"]["basis"] == {"problem": refs}
    assert c.post(p + "/tell", headers=h, json={"to": "coder", "text": "核对样本", "basis": refs}).status_code == 200
    assert messages[-1].endswith(f"依据：D1「{IDEA}」、#{task}「核对样本划分」")
    # The migration cutoff applies to every kind of unreferenced work.
    old = town.save_item(lid, "table", "exp", "farm", "旧结果", {})
    town.db.update("items", {"id": old["id"]}, created_at="2000-01-01T00:00:00+00:00")
    town.pipeline.output(lid, "review", {"verdict": "待复核"})
    job2 = c.post(p + "/jobs", headers=h, json={"name":"无据任务", "command":"true"}).json()
    assert c.post(p + "/tell", headers=h, json={"to": "coder", "text": "核对划分数量"}).status_code == 200
    v = c.get(root + "/decided").json()
    d = c.get(root + "/decided/D1").json()
    assert v["stats"] == {"total": 2, "active": 1, "anchored": 4, "loose": 4}
    assert {w["kind"] for w in v["loose"]} == {"job", "output", "tell", "task"} and job2["id"] in {w["id"] for w in v["loose"]}
    assert d["counts"] == {"jobs":1, "outputs":1, "tasks":1, "tells":1, "prov":0} and d["work"]["prov"] == []
    assert d["work"]["tells"][0]["basis"] == refs
    cv = town.canvas.view(lid)
    assert cv["decided"] == {m: int(m == "overview") for m, _ in MODULES}
    assert next(n for n in cv["nodes"] if n["id"] == "stage:method")["basis"] == refs
    town.db.update("jobs", {"id": j["id"]}, status="done")
    assert c.get(root + "/data").json()["runs"][0]["prov"] == []


def test_method_gate_and_old_draft(project):
    c, town, lid = project
    pipe = town.pipeline
    def check():
        town.checks.run(lid)
        return town.checks.latest(lid)["basis"]

    pipe.stage(lid, "method", "run")
    town.canvas.view(lid)
    pipe.output(lid, "method", METHOD_BODY)
    assert check()["value"] == 5
    with pytest.raises(LineError, match="方法有据"):
        pipe.stage(lid, "method", "done")
    ticket = next(n for n in town.canvas.task_nodes(lid) if n.get("gate") == "method")
    assert ticket["created_by"] == "papertown"
    user_task = town.canvas.add(lid, "task", 0, 0, "核对指标")["added"]
    basis = {k: ["D1"] for k in METHOD}
    pipe.output(lid, "method", METHOD_BODY | {"basis": basis | {"metrics":["#" + user_task]}})
    assert check()["value"] == 1
    pipe.output(lid, "method", METHOD_BODY | {"basis": basis})
    assert check()["status"] == "pass" and pipe.line(lid)["title"] == IDEA and pipe.item(lid, "method")["title"] == METHOD_BODY["title"]
    pipe.stage(lid, "method", "done")
    town.decided.write(lid, "调整研究范围", "overview", replaces="D1")
    assert check()["status"] == "fail" and check()["value"] == 5
    town.save_item(lid, "draft", "method", "mill", "旧草案", METHOD_BODY)
    assert check()["status"] == "none" and check()["value"] is None
