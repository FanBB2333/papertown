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
        assert "关卡：硬检查" in town.leads.status(lid)
        assert c.get("/api/cards").json()["cards"][0]["checks"]["soft"]["warn"] == 1
