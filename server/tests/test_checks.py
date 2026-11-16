from fastapi.testclient import TestClient

from papertown.api import create_app

from .conftest import make_settings, wait_for

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
        wait_for(town, lid, {"waiting"})
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


def test_the_canvas_is_a_free_graph_and_its_tasks_go_to_agents(tmp_path):
    from .test_farm_agents import FakeLink

    app = create_app(make_settings(tmp_path))
    with TestClient(app) as c:
        town = app.state.town
        link = FakeLink()
        for name in ("conversations", "status", "create", "send", "interrupt", "list"):
            setattr(town.agents.paseo, name, getattr(link, name))
        lid = c.post("/api/ideas", json={"text": IDEA}).json()["id"]
        wait_for(town, lid, {"waiting"})

        # the first layout: every stage and check a node, checks wired to their stage, and the way back from review
        v = c.get(f"/api/lines/{lid}/canvas").json()
        ids = {n["id"]: n for n in v["nodes"]}
        assert {"stage:idea", "stage:ship", "check:words", "check:design"} <= ids.keys() and ids["check:design"]["kind"] == "soft"
        pairs = {(e["source"], e["target"]) for e in v["edges"]}
        assert {("stage:exp", "check:design"), ("stage:review", "stage:write"), ("stage:hatch", "stage:team")} <= pairs

        # nodes move, connect and come off; a built-in check taken off is turned off and can be put back
        assert c.post(f"/api/lines/{lid}/canvas/move", json={"at": {"check:design": [40, 400]}}).json() == {"ok": True}
        v = c.delete(f"/api/lines/{lid}/canvas/nodes/check:pdf").json()
        assert "check:pdf" not in {n["id"] for n in v["nodes"]} and v["gone"] == [{"id": "check:pdf", "title": "PDF 最新"}]
        assert not next(x for x in c.get(f"/api/lines/{lid}/checks").json()["checks"] if x["id"] == "pdf")["on"]
        v = c.post(f"/api/lines/{lid}/canvas/nodes/check:pdf/restore").json()
        assert next(n for n in v["nodes"] if n["id"] == "check:pdf")["check"]["on"] and not v["gone"]
        v = c.delete(f"/api/lines/{lid}/canvas/nodes/stage:idea").json()
        assert "stage:idea" not in {n["id"] for n in v["nodes"]} and not any("stage:idea" in (e["source"], e["target"]) for e in v["edges"])

        # a soft check of the user's own, drawn from a node: wired to nothing but that node, so due whatever the stage
        v = c.post(f"/api/lines/{lid}/canvas/nodes", json={"kind": "soft", "x": 10, "y": 20, "title": "要有消融", "text": "每个模块都有消融吗？",
                                                           "link": "check:design"}).json()
        new = next(n for n in v["nodes"] if n["id"] == v["added"])
        assert (new["id"], new["x"], new["y"], new["check"]["text"]) == ("check:ask-1", 10, 20, "每个模块都有消融吗？")
        assert ("check:design", "check:ask-1") in {(e["source"], e["target"]) for e in v["edges"]}
        town.db.x("update lines set status = 'running' where id = ?", lid)
        assert {s["id"] for s in town.checks.due(lid)} == {"ask-1"}
        town.db.x("update stages set status = 'run' where line_id = ? and key = 'exp'", lid)
        assert {s["id"] for s in town.checks.due(lid)} == {"ask-1", "direction", "design"}
        edge = next(e["id"] for e in v["edges"] if e["target"] == "check:direction")
        c.delete(f"/api/lines/{lid}/canvas/edges/{edge}")
        c.post(f"/api/lines/{lid}/canvas/edges", json={"source": "check:direction", "target": "stage:ship"})
        assert {s["id"] for s in town.checks.due(lid)} == {"ask-1", "design"}

        # a task: kept as a draft until its agent is there, then sent with what it is wired to, and closed by the agent
        v = c.post(f"/api/lines/{lid}/canvas/nodes", json={"kind": "task", "x": 0, "y": 300, "title": "补消融实验", "text": "三个模块各去掉一次",
                                                           "to": "lead", "link": "check:design", "send": False}).json()
        tid = v["added"]
        assert next(n for n in v["nodes"] if n["id"] == tid)["status"] == "draft" and v["tasks"]["draft"] == 1
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
        assert f'<task id="{tid}">' in sent and "补消融实验" in sent and "软检查 design「实验设计」" in sent and f"pt task {tid} done" in sent
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
        assert town.leads.reports(lid, 5)[-1]["data"]["text"].startswith("画布上的任务「补消融实验」完成")
        assert town.leads._facts(lid)[f"task:{tid}"][0] == "done"

        # sent back with what is wrong: under way again, and the node keeps the whole story
        v = c.post(f"/api/lines/{lid}/canvas/nodes/{tid}/back", json={"text": "还差重排模块的消融"}).json()
        node = next(n for n in v["nodes"] if n["id"] == tid)
        assert node["status"] == "sent" and "还差重排模块的消融" in said[-1][1] and "你上次回的是：三个消融" in said[-1][1]
        assert [x["kind"] for x in node["log"]] == ["made", "sent", "resent", "done", "back"] and node["log"][-1]["text"] == "还差重排模块的消融"

        # tidying puts stages and checks back where they started; the task stays where the user left it
        v = c.post(f"/api/lines/{lid}/canvas/tidy").json()
        at = {n["id"]: (n["x"], n["y"]) for n in v["nodes"]}
        assert at["stage:exp"] == (3 * 480, 600) and at["stage:method"] == (3 * 480, 0) and at[tid] == (0, 300)
        assert at["info:runs"] == (3 * 480 - 290, 600 - 196)
