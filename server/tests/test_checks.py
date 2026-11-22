import json

from fastapi.testclient import TestClient

from papertown.api import create_app

from .conftest import make_settings

IDEA = "用检索增强的方式做仓库级代码补全，比较不同检索粒度对补全质量的影响"

PAPER = r"""\documentclass{article}
\usepackage{amsmath}
\begin{document}
\section{Intro}
We use a gate rather than a router; it is fast.
The model is not slow but fast (see Section~\ref{sec:m}).
Our context-aware module helps \cite{a,b,c,d}.
Let $\alpha \in [0, 1]$ be a weight.
Accuracy is 85.1 [84.0, 86.2] in total.
% we use legs here, in a comment
\begin{equation}
  x \in [0, 1]
\end{equation}
\begin{table}
\caption{Results over seeds 0, 1 and 2.}
\begin{tabular}{lc}
Method & Acc \\
A very long method name with all of its parts & 85.1 \\
\end{tabular}
\end{table}
\input{extra}
\end{document}
"""


def test_hard_checks_read_the_paper_and_soft_ones_go_to_the_lead(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as c:
        town = app.state.town
        lid = c.post("/api/ideas", json={"text": IDEA}).json()["id"]

        paper = town.s.press_dir / lid
        paper.mkdir(parents=True, exist_ok=True)
        (paper / "main.tex").write_text(PAPER, encoding="utf-8")
        (paper / "extra.tex").write_text("An extra arm here.\n", encoding="utf-8")

        v = c.post(f"/api/lines/{lid}/checks/run").json()
        got = {x["id"]: x for x in v["checks"]}
        found = lambda cid: [(f["file"], f["line"], f["hit"]) for f in got[cid]["last"]["findings"]]  # noqa: E731
        state = lambda cid: (got[cid]["last"]["status"], got[cid]["last"]["value"])  # noqa: E731

        # lastcheck 1.1, through \input and not in comments or the preamble
        assert state("words") == ("fail", 4)
        assert {h for *_, h in found("words")} == {"gate", "rather than", "not slow but", "arm"}
        assert ("extra.tex", 1, "arm") in found("words")
        assert state("coined") == ("warn", 1) and found("coined")[0][2] == "context-aware"
        assert state("hyphens") == ("pass", 1)
        assert state("semicolons") == ("pass", 1)
        assert state("parens")[0] == "warn" and "see Section" in got["parens"]["last"]["findings"][0]["hit"]
        assert state("cites") == ("warn", 1)
        # a range in brackets is caught, an interval in math is not
        assert state("ranges") == ("fail", 1) and found("ranges")[0][1] == 9
        assert state("captions")[0] == "fail" and got["captions"]["last"]["findings"][0]["hit"] == "seeds"
        assert state("tablenames") == ("warn", 1) and found("tablenames")[0][1] == 18
        assert state("pdf") == ("warn", 1)
        assert v["summary"]["soft"]["wait"] == 5 and v["rounds"] == 1
        assert [s["key"] for s in v["stages"]][:2] == ["idea", "hatch"]

        # the same paper again changes nothing; a fixed one starts a new round
        c.post(f"/api/lines/{lid}/checks/run")
        assert c.get(f"/api/lines/{lid}/checks").json()["rounds"] == 1
        (paper / "extra.tex").write_text("An extra part here.\n", encoding="utf-8")
        v = c.post(f"/api/lines/{lid}/checks/run").json()
        words = next(x for x in v["checks"] if x["id"] == "words")
        assert words["last"]["value"] == 3 and [h["value"] for h in words["history"]] == [4, 3] and v["rounds"] == 2

        # thresholds, turning off, and the user's own checks
        v = c.put(f"/api/lines/{lid}/checks/cites", json={"params": {"keys": 4}}).json()
        assert next(x for x in v["checks"] if x["id"] == "cites")["last"]["status"] == "pass"
        v = c.put(f"/api/lines/{lid}/checks/pdf", json={"on": False}).json()
        assert not next(x for x in v["checks"] if x["id"] == "pdf")["on"]
        v = c.post(f"/api/lines/{lid}/checks", json={"kind": "hard", "stage": "write", "title": "不写 router", "text": r"\brouters?\b"}).json()
        assert next(x for x in v["checks"] if x["id"] == "rule-1")["last"]["value"] == 1
        v = c.post(f"/api/lines/{lid}/checks", json={"kind": "soft", "stage": "exp", "title": "要有消融", "text": "每个模块都有消融吗？"}).json()
        assert any(x["id"] == "ask-1" and x["kind"] == "soft" for x in v["checks"])
        assert c.post(f"/api/lines/{lid}/checks", json={"kind": "hard", "stage": "write", "title": "坏", "text": "("}).status_code == 400
        assert c.delete(f"/api/lines/{lid}/checks/words").status_code == 400
        assert c.delete(f"/api/lines/{lid}/checks/ask-1").status_code == 200
        assert c.post(f"/api/lines/{lid}/checks/design/ask").status_code == 400  # no lead yet

        # soft checks: due on the stages the project has reached; the lead's verdict, and a report when it is not a pass
        town.db.x("update lines set status = 'running' where id = ?", lid)
        town.db.x("update stages set status = 'run' where line_id = ? and key in ('method', 'exp')", lid)
        assert {s["id"] for s in town.checks.due(lid)} == {"method", "direction", "design"}
        lead = c.post("/api/agents", json={"line_id": lid, "role": "lead"}).json()["id"]
        r = town.checks.verdict(lead, "design", "warn", "没有消融实验")
        assert "汇报" in r["text"]
        assert town.leads.reports(lid, 5)[-1]["data"]["text"] == "软检查「实验设计」有问题：没有消融实验"
        town.checks.asked(lid, ["direction"])
        assert {s["id"] for s in town.checks.due(lid)} == {"method"}
        design = next(x for x in c.get(f"/api/lines/{lid}/checks").json()["checks"] if x["id"] == "design")
        assert design["last"]["status"] == "warn" and design["last"]["note"] == "没有消融实验"
        assert "检查：硬检查" in town.leads.status(lid)
        assert c.get("/api/cards").json()["cards"][0]["checks"]["soft"]["warn"] == 1


def test_the_research_loop_gates_its_stages_and_sends_rework_back(tmp_path):
    from .test_farm_agents import FakeLink

    app = create_app(make_settings(tmp_path))
    with TestClient(app) as c:
        town = app.state.town
        link = FakeLink()
        for name in ("conversations", "status", "create", "send", "interrupt", "list", "project", "workspace"):
            setattr(town.agents.paseo, name, getattr(link, name))
        lid = c.post("/api/ideas", json={"text": IDEA}).json()["id"]


        # the first layout: the stages and their gates, the sentinels watching stages above them, the spec, the clamp and
        # the human gate, each in its block; a gate stands for its stage's hard checks, which have no nodes of their own
        v = c.get(f"/api/lines/{lid}/canvas").json()
        ids = {n["id"]: n for n in v["nodes"]}
        assert {"stage:idea", "stage:ship", "gate:hatch", "gate:exp", "gate:write", "gate:review", "gate:ship", "check:design",
                "spec", "clamp", "human"} <= ids.keys() and "check:words" not in ids and "gate:method" not in ids
        assert ids["check:design"]["kind"] == "soft" and [x["key"] for x in v["blocks"]] == ["overview", "survey", "code", "exp", "data", "paper", "agents"]
        assert [ids[k]["mod"] for k in ("gate:write", "check:design", "stage:team", "human")] == ["paper", "exp", "agents", "overview"]
        g = ids["gate:write"]["gate"]
        assert g["name"] == "写作排版" and {"words", "hyphens", "semicolons"} <= set(g["checks"]) and g["locks"] == "质检"
        kinds = {(e["source"], e["target"]): e.get("kind") for e in v["edges"]}
        assert kinds[("stage:write", "gate:write")] == kinds[("gate:write", "stage:review")] == kinds[("gate:exp", "stage:write")] == "flow"
        assert kinds[("check:design", "stage:exp")] == "watch" and kinds[("spec", "stage:method")] == "spec"
        assert kinds[("clamp", "stage:exp")] == "clamp" and kinds[("stage:review", "human")] == "escalate"
        assert ids["stage:write"]["role"] == "writer" and ids["stage:review"]["locked"] is None

        # a gate opens into a node per check and closes again; a check taken off is turned off and can be put back
        v = c.post(f"/api/lines/{lid}/canvas/gates/ship", json={"what": "open"}).json()
        assert ("gate:ship", "check:pdf", "member") in {(e["source"], e["target"], e.get("kind")) for e in v["edges"]}
        v = c.delete(f"/api/lines/{lid}/canvas/nodes/check:pdf").json()
        assert "check:pdf" not in {n["id"] for n in v["nodes"]} and v["gone"] == [{"id": "check:pdf", "title": "PDF 最新"}]
        assert not next(x for x in c.get(f"/api/lines/{lid}/checks").json()["checks"] if x["id"] == "pdf")["on"]
        v = c.post(f"/api/lines/{lid}/canvas/nodes/check:pdf/restore").json()
        assert next(n for n in v["nodes"] if n["id"] == "check:pdf")["check"]["on"] and not v["gone"]
        v = c.post(f"/api/lines/{lid}/canvas/gates/ship", json={"what": "close"}).json()
        assert "check:pdf" not in {n["id"] for n in v["nodes"]} and "gate:ship" in {n["id"] for n in v["nodes"]}
        v = c.delete(f"/api/lines/{lid}/canvas/nodes/stage:idea").json()
        assert "stage:idea" not in {n["id"] for n in v["nodes"]} and not any("stage:idea" in (e["source"], e["target"]) for e in v["edges"])
        # a card comes off and goes back on, in its block
        v = c.delete(f"/api/lines/{lid}/canvas/nodes/info:runs").json()
        assert [x["id"] for x in v["spare"]] == ["info:runs"]
        v = c.post(f"/api/lines/{lid}/canvas/nodes/info:runs/restore").json()
        assert v["added"] == "info:runs" and not v["spare"] and next(n for n in v["nodes"] if n["id"] == "info:runs")["mod"] == "exp"

        # a soft check of the user's own, drawn from a sentinel: wired to nothing but that node, so due whatever the stage
        v = c.post(f"/api/lines/{lid}/canvas/nodes", json={"kind": "soft", "x": 10, "y": 20, "title": "要有消融", "text": "每个模块都有消融吗？",
                                                           "link": "check:design"}).json()
        new = next(n for n in v["nodes"] if n["id"] == v["added"])
        assert (new["id"], new["x"], new["y"], new["check"]["text"]) == ("check:ask-1", 10, 20, "每个模块都有消融吗？")
        assert ("check:design", "check:ask-1") in {(e["source"], e["target"]) for e in v["edges"]}
        town.db.x("update lines set status = 'running' where id = ?", lid)
        assert {s["id"] for s in town.checks.due(lid)} == {"ask-1"}
        town.db.x("update stages set status = 'run' where line_id = ? and key = 'exp'", lid)
        assert {s["id"] for s in town.checks.due(lid)} == {"ask-1", "direction", "design"}
        edge = next(e["id"] for e in v["edges"] if "check:direction" in (e["source"], e["target"]))
        c.delete(f"/api/lines/{lid}/canvas/edges/{edge}")
        c.post(f"/api/lines/{lid}/canvas/edges", json={"source": "check:direction", "target": "stage:ship"})
        assert {s["id"] for s in town.checks.due(lid)} == {"ask-1", "design"}

        # a correction drawn from a sentinel: kept as a draft until its agent is there, then sent with what it is wired
        # to, closed by the agent
        v = c.post(f"/api/lines/{lid}/canvas/nodes", json={"kind": "task", "x": 0, "y": 300, "title": "补消融实验", "text": "三个模块各去掉一次",
                                                           "to": "lead", "link": "check:design", "send": False}).json()
        tid = v["added"]
        node = next(n for n in v["nodes"] if n["id"] == tid)
        assert (node["status"], node["loop"], node["from"]) == ("draft", "soft", "design")
        assert [n["id"] for n in v["nodes"] if n["kind"] == "task" and n["loop"] != "hard"] == [tid], [(n["id"], n["loop"], n["stage"]) for n in v["nodes"] if n["kind"] == "task"]
        kinds = {(e["source"], e["target"]): e.get("kind") for e in v["edges"]}
        assert kinds[("check:design", tid)] == kinds[(tid, "stage:exp")] == "soft_loop"
        assert c.post(f"/api/lines/{lid}/canvas/nodes/{tid}/send").status_code == 400  # no lead yet
        lead = c.post("/api/agents", json={"line_id": lid, "role": "lead"}).json()["id"]
        c.post(f"/api/agents/{lead}/start", json={"runtime": "paseo", "provider": "claude", "model": "claude-opus-5-5", "thinking": "high"})
        said = []
        town.agents.say = lambda agent_id, text, *a, **k: said.append((agent_id, text))
        v = c.put(f"/api/lines/{lid}/canvas/nodes/{tid}", json={"text": "三个模块各去掉一次，报 Mean-5"}).json()
        v = c.post(f"/api/lines/{lid}/canvas/nodes/{tid}/send").json()
        assert next(n for n in v["nodes"] if n["id"] == tid)["status"] == "sent"
        assert said[-1][0] == lead
        sent = said[-1][1]
        assert f'<task id="{tid}">' in sent and "软巡检发现了偏差" in sent and "软检查 design「实验设计」" in sent and f"pt task {tid} done" in sent
        assert v["agents"]["lead"]["there"] and not v["agents"]["coder"]["there"]

        # a line can say what it means, and the agent reads that too
        edge = next(e["id"] for e in v["edges"] if {e["source"], e["target"]} == {tid, "check:design"})
        v = c.put(f"/api/lines/{lid}/canvas/edges/{edge}", json={"label": "做完要通过"}).json()
        assert next(e for e in v["edges"] if e["id"] == edge)["label"] == "做完要通过"
        c.post(f"/api/lines/{lid}/canvas/nodes/{tid}/send")
        assert "［线上写着：做完要通过］" in said[-1][1] and "按新的来" in said[-1][1]
        assert c.post(f"/api/lines/{lid}/canvas/nodes/{tid}/back", json={"text": "不行"}).status_code == 400  # nothing returned yet
        assert tid in town.canvas.tasks_text(lead)
        r = town.canvas.close(lead, tid, "done", "三个消融都跑了，Mean-5 各降 1.2 到 2.0")
        assert "完成" in r["text"]
        node = next(n for n in c.get(f"/api/lines/{lid}/canvas").json()["nodes"] if n["id"] == tid)
        assert node["status"] == "done" and node["result"].startswith("三个消融")
        assert town.leads.reports(lid, 5)[-1]["data"]["text"].startswith("研究回路上的任务「补消融实验」完成")
        assert town.leads._facts(lid)[f"task:{tid}"][0] == "done"
        v = c.post(f"/api/lines/{lid}/canvas/nodes/{tid}/back", json={"text": "还差重排模块的消融"}).json()
        node = next(n for n in v["nodes"] if n["id"] == tid)
        assert node["status"] == "sent" and "还差重排模块的消融" in said[-1][1] and "你上次回的是：三个消融" in said[-1][1]
        assert [x["kind"] for x in node["log"]] == ["made", "sent", "resent", "done", "back"] and node["log"][-1]["text"] == "还差重排模块的消融"

        # a blocking rule that fails once writing has started: the gate locks review and writes a rework ticket for
        # the writer; done while it still fails, the next round; past the rounds, the human gate
        paper = town.s.press_dir / lid
        paper.mkdir(parents=True, exist_ok=True)
        (paper / "main.tex").write_text("\\begin{document}\nThe zebra runs.\n\\end{document}\n", encoding="utf-8")
        assert c.post(f"/api/lines/{lid}/checks", json={"kind": "hard", "stage": "write", "title": "不写斑马", "text": "zebra", "prio": "P0"}).status_code == 200
        v = c.get(f"/api/lines/{lid}/canvas").json()
        g = next(n for n in v["nodes"] if n["id"] == "gate:write")["gate"]
        assert g["state"] == "block" and not g["ticket"] and not g["reached"]  # writing has not started: nothing sent back yet
        town.db.x("update stages set status = 'run' where line_id = ? and key = 'write'", lid)
        assert town.canvas.loop(lid)
        v = c.get(f"/api/lines/{lid}/canvas").json()
        ids = {n["id"]: n for n in v["nodes"]}
        g = ids["gate:write"]["gate"]
        t = ids[g["ticket"]]
        assert (t["loop"], t["stage"], t["round"], t["status"], t["to"]) == ("hard", "write", 1, "draft", "writer") and "rule-1「不写斑马」" in t["text"] and "main.tex:2" in t["text"]
        assert ids["stage:review"]["locked"] == {"gate": "write", "title": "写作排版"} and town.canvas.locks(lid)
        assert "「写作排版」的硬卡口阻断，「质检」要等它放行（不写斑马）" in town.leads.status(lid)
        kinds = {(e["source"], e["target"]): e.get("kind") for e in v["edges"]}
        assert kinds[("gate:write", t["id"])] == kinds[(t["id"], "stage:write")] == "hard_loop"
        assert c.post(f"/api/lines/{lid}/canvas/gates/write", json={"what": "rework"}).status_code == 400  # no writer yet
        writer = c.post("/api/agents", json={"line_id": lid, "role": "writer"}).json()["id"]
        c.post(f"/api/agents/{writer}/start", json={"runtime": "paseo", "provider": "claude", "model": "claude-opus-5-5", "thinking": "high"})
        c.post(f"/api/lines/{lid}/canvas/gates/write", json={"what": "rework"})
        assert said[-1][0] == writer and "第 1 轮修补单" in said[-1][1] and "pt checks run" in said[-1][1]
        town.canvas.close(writer, t["id"], "done", "改好了")
        t = next(n for n in c.get(f"/api/lines/{lid}/canvas").json()["nodes"] if n["id"] == t["id"])
        assert (t["round"], t["status"]) == (2, "draft") and len(t["trail"]) == 2  # still failing: round two, waiting for you
        c.put(f"/api/lines/{lid}/loops/write", json={"auto": True, "rounds": 2})
        t = next(n for n in c.get(f"/api/lines/{lid}/canvas").json()["nodes"] if n["id"] == t["id"])
        assert t["status"] == "sent" and "第 2 轮修补单" in said[-1][1]  # sent at once now
        town.canvas.close(writer, t["id"], "done", "又改了")
        v = c.get(f"/api/lines/{lid}/canvas").json()
        t = next(n for n in v["nodes"] if n["id"] == t["id"])
        human = next(n for n in v["nodes"] if n["id"] == "human")
        assert t["escalated"] and t["status"] == "blocked" and any(x["kind"] == "escalated" and x["id"] == t["id"] for x in human["items"])
        c.post(f"/api/lines/{lid}/canvas/gates/write", json={"what": "more"})
        t = next(n for n in c.get(f"/api/lines/{lid}/canvas").json()["nodes"] if n["id"] == t["id"])
        assert (t["round"], t["status"], t["escalated"]) == (3, "sent", False)
        v = c.post(f"/api/lines/{lid}/canvas/gates/write", json={"what": "waive"}).json()
        ids = {n["id"]: n for n in v["nodes"]}
        assert ids["gate:write"]["gate"]["waived"] and ids["stage:review"]["locked"] is None and ids[t["id"]]["status"] == "done"
        c.delete(f"/api/lines/{lid}/checks/rule-1")
        v = c.get(f"/api/lines/{lid}/canvas").json()
        ids = {n["id"]: n for n in v["nodes"]}
        assert ids[t["id"]]["converged"] and not ids["gate:write"]["gate"]["waived"]

        # the report: each gate's rules from the first round to now, and the sentinels' word
        r = c.get(f"/api/lines/{lid}/canvas/report").json()
        assert "## 硬限制质控" in r["markdown"] and "| 写作排版 | 禁用词（lastcheck 1.1） |" in r["markdown"] and "<table>" in r["html"]
        page = c.post(f"/api/lines/{lid}/canvas/report").json()
        assert page["kind"] == "report" and page["title"].startswith("研究回路汇报")
        assert "- gate:write · 硬卡口 · 写作排版 · " in c.get(f"/api/lines/{lid}/canvas/outline").json()["text"]

        # 按分块规整 puts each block back: the stages in their row, the correction in the grid under them, in its block
        c.post(f"/api/lines/{lid}/canvas/move", json={"at": {"stage:exp": [5, 5], tid: [40, 1300]}})
        v = c.post(f"/api/lines/{lid}/canvas/tidy").json()
        at = {n["id"]: (n["x"], n["y"]) for n in v["nodes"]}
        assert at["stage:method"][1] < at["stage:exp"][1] == at["gate:exp"][1] and at["info:results"][0] < at["stage:exp"][0] < at["gate:exp"][0]
        assert at[tid][0] == at["info:runs"][0] and at["stage:exp"][1] + 96 < at[tid][1] < at["gate:write"][1]

        # a canvas from before the loop: the loop's layout with each block's cards, the task in the block of what it is
        # wired to, a line to a hard check now to the gate; the file as it was is kept
        (town.s.projects_dir / lid / "canvas.json").write_text(json.dumps({
            "nodes": [{"id": "stage:exp", "kind": "stage", "ref": "exp", "x": 0, "y": 0}, {"id": "check:words", "kind": "hard", "ref": "words", "x": 0, "y": 0},
                      {"id": "info:card", "kind": "info", "ref": "card", "x": 0, "y": 0},
                      {"id": "t9", "kind": "task", "title": "旧任务", "text": "", "to": "lead", "status": "draft", "x": 7, "y": 7}],
            "edges": [{"id": "e1", "source": "t9", "target": "check:words", "label": "改这个"}], "gone": ["info:card"], "next": 10}))
        v = c.get(f"/api/lines/{lid}/canvas").json()
        ids = {n["id"]: n for n in v["nodes"]}
        assert "gate:write" in ids and ids["info:card"]["mod"] == "overview" and not v["gone"] and not v["spare"]
        assert ids["t9"]["mod"] == "paper" and ids["t9"]["x"] == ids["info:paper"]["x"] and ids["t9"]["y"] > ids["gate:write"]["y"] + 96
        assert json.loads((town.s.projects_dir / lid / "canvas.before-blocks.json").read_text())["nodes"][3]["title"] == "旧任务"
        assert next(e for e in v["edges"] if {e["source"], e["target"]} == {"t9", "gate:write"})["label"] == "改这个"
