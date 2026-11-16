import json
import re

from fastapi.testclient import TestClient

from papertown.api import create_app

from .conftest import wait_for
from .test_cards import CARD
from .test_farm_agents import IDEA
from .test_leads import started
from .test_linked import git_repo, linked_settings


def jl(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in rows))


def slug(p):
    return re.sub(r"[^A-Za-z0-9]", "-", str(p))


def histories(tmp, code, paper):
    """Claude Code and Codex histories: some in the project's repositories (a subfolder, a Codex worktree), some not (a same-prefix repo, a subagent's, elsewhere)."""
    claude, codex = tmp / "claude" / "projects", tmp / "codex" / "sessions" / "2026" / "11" / "01"
    here = claude / slug(code)
    jl(here / "s1.jsonl", [
        {"type": "user", "cwd": str(code), "timestamp": "2026-11-01T08:00:00Z", "message": {"role": "user", "content": "<command-name>/clear</command-name>"}},
        {"type": "user", "cwd": str(code), "timestamp": "2026-11-01T08:01:00Z",
         "message": {"role": "user", "content": "为什么 warmup 之后 loss 会抖？<system-reminder>ignore me</system-reminder>"}},
        {"type": "assistant", "cwd": str(code), "timestamp": "2026-11-01T08:02:00Z",
         "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "hmm"}, {"type": "tool_use", "name": "Read", "input": {}}]}},
        {"type": "user", "cwd": str(code), "message": {"role": "user", "content": [{"type": "tool_result", "content": "file text"}]}},
        {"type": "assistant", "cwd": str(code), "timestamp": "2026-11-01T08:03:00Z",
         "message": {"role": "assistant", "content": [{"type": "text", "text": "学习率 warmup 太短：把 warmup_steps 从 100 调到 1000 就稳了。key sk-ant-abcdefghijklmnopqrstuvwxyz0123"}]}},
        {"type": "ai-title", "aiTitle": "排查 warmup 后 loss 抖动"},
    ])
    (here / "memory").mkdir()
    (here / "memory" / "MEMORY.md").write_text("- [x](no-multi-seed.md)\n")
    (here / "memory" / "no-multi-seed.md").write_text("---\nname: no-multi-seed\ndescription: 实验只跑一个 seed\n---\n用户不要多 seed 重复实验，省卡。\n")
    jl(claude / (slug(code) + "-sub") / "s2.jsonl", [
        {"type": "user", "cwd": str(code / "sub"), "timestamp": "2026-10-30T00:00:00Z", "message": {"role": "user", "content": "看一下 sub 里的脚本"}},
        {"type": "assistant", "cwd": str(code / "sub"), "message": {"role": "assistant", "content": [{"type": "text", "text": "好的"}]}}])
    jl(claude / (slug(code) + "-old") / "s3.jsonl", [
        {"type": "user", "cwd": str(code) + "-old", "message": {"role": "user", "content": "not this one"}}])
    jl(codex / "rollout-a.jsonl", [
        {"type": "session_meta", "timestamp": "2026-11-01T09:00:00Z", "payload": {"id": "cx-1", "cwd": str(paper), "source": "cli"}},
        {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "<environment_context>cwd</environment_context>"}]}},
        {"type": "response_item", "timestamp": "2026-11-01T09:01:00Z", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "把引言第二段改短"}]}},
        {"type": "response_item", "timestamp": "2026-11-01T09:02:00Z", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "改好了，删掉了重复的动机。"}]}}])
    jl(codex / "rollout-b.jsonl", [
        {"type": "session_meta", "payload": {"id": "cx-2", "cwd": f"/Users/me/.codex/worktrees/w1/{code.name}"}},
        {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "合并分支"}]}}])
    jl(codex / "rollout-c.jsonl", [
        {"type": "session_meta", "payload": {"id": "cx-3", "cwd": str(code), "source": {"subagent": {"other": "guardian"}}}}])
    jl(codex / "rollout-d.jsonl", [{"type": "session_meta", "payload": {"id": "cx-4", "cwd": "/elsewhere"}}])


def test_import_earlier_conversations_and_ask_the_project(tmp_path):
    code, paper = tmp_path / "proj-code", tmp_path / "proj-paper"
    git_repo(code, {"README.md": "# Proj\n\nMerging layers.\n", "CLAUDE.md": "# 规则\n\n不要改 configs/。\n",
                    "train.py": "def schedule(step, warmup_steps=1000):\n    # linear warmup of the learning rate\n    return min(1, step / warmup_steps)\n",
                    "sub/run.sh": "python train.py\n"})
    git_repo(paper, {"main.tex": "\\documentclass{article}\\begin{document}\\section{Introduction}We merge layers of models.\\end{document}"})
    histories(tmp_path, code, paper)
    app = create_app(linked_settings(tmp_path, code, paper, claude_home=str(tmp_path / "claude"), codex_home=str(tmp_path / "codex")))
    with TestClient(app) as c:
        lid = c.get("/api/lines").json()[0]["id"]
        found = c.get(f"/api/lines/{lid}/memory/scan").json()["found"]
        keys = {x["key"]: x for x in found}
        assert set(keys) == {"claude:s1", "claude:s2", "claude-memory:" + slug(code) + "/no-multi-seed.md", "codex:cx-1", "codex:cx-2",
                             "repo:code/CLAUDE.md"}
        assert keys["claude:s1"]["title"] == "排查 warmup 后 loss 抖动" and keys["claude:s1"]["repo"] == "code"
        assert keys["codex:cx-1"]["repo"] == "paper" and keys["codex:cx-1"]["title"] == "把引言第二段改短"
        assert keys["claude-memory:" + slug(code) + "/no-multi-seed.md"]["title"] == "实验只跑一个 seed"
        assert not any(x["imported"] for x in found)

        r = c.post(f"/api/lines/{lid}/memory/import", json={"keys": [*keys, "claude:gone"]}).json()
        assert len(r["imported"]) == 6 and r["failed"][0]["key"] == "claude:gone"
        assert r["counts"]["sessions"] == 4 and r["counts"]["notes"] == 2
        s1 = next(m for m in r["imported"] if m["key"] == "claude:s1")
        full = c.get(f"/api/lines/{lid}/memory/{s1['id']}").json()
        assert [m["role"] for m in full["messages"]] == ["user", "assistant"]
        assert full["messages"][0]["text"] == "为什么 warmup 之后 loss 会抖？" and "sk-ant" not in full["messages"][1]["text"]
        assert "[已隐去]" in full["messages"][1]["text"]
        assert all(x["imported"] and not x["changed"] for x in c.get(f"/api/lines/{lid}/memory/scan").json()["found"])
        assert c.get(f"/api/lines/{lid}/card").json()["memory"]["sessions"] == 4

        hits = c.get(f"/api/lines/{lid}/search", params={"q": "warmup 的学习率怎么设的"}).json()["hits"]
        kinds = [h["kind"] for h in hits]
        assert "session" in kinds and "code" in kinds
        code_hit = next(h for h in hits if h["kind"] == "code")
        assert code_hit["ref"]["file"] == "code:train.py:1" and "warmup" in code_hit["snippet"]
        assert c.get(f"/api/lines/{lid}/search", params={"q": "seed 重复"}).json()["hits"][0]["kind"] == "note"
        q = c.post(f"/api/lines/{lid}/questions", json={"q": "warmup 设成多少？"}).json()
        assert q["id"] == "q1" and q["by"] == "摘录" and "[1]" in q["answer"] and q["hits"] and "_text" not in q["hits"][0]
        assert c.get(f"/api/lines/{lid}/questions").json()["questions"][0]["q"] == "warmup 设成多少？"
        assert c.post(f"/api/lines/{lid}/questions", json={"q": "谁", "lead": True}).status_code == 400

        assert c.delete(f"/api/lines/{lid}/memory/{s1['id']}").json()["counts"]["sessions"] == 3
        assert (tmp_path / "claude" / "projects" / slug(code) / "s1.jsonl").exists()


def test_cards_with_plans_outputs_runs_and_panes_and_the_lead_answers(tmp_path):
    app, _ = started(tmp_path)
    with TestClient(app) as c:
        town = app.state.town
        assert c.get("/api/cards").json()["layout"]["panes"] == ["summary", "attention", "running", "planned", "outputs", "code", "paper"]
        assert c.post("/api/cards/layout", json={"panes": ["code", "nope"]}).status_code == 400
        assert c.post("/api/cards/layout", json={"panes": ["running", "code", "running"]}).json()["panes"] == ["running", "code"]
        assert c.post("/api/cards/layout", json={}).json()["panes"][0] == "summary"

        lid = c.post("/api/ideas", json={"text": IDEA}).json()["id"]
        wait_for(town, lid, {"waiting"})
        lead = c.post("/api/agents", json={"line_id": lid, "role": "lead"}).json()
        c.post(f"/api/agents/{lead['id']}/start", json={"runtime": "paseo", "provider": "codex"})
        h = {"x-papertown-token": town.agents.get(lead["id"])["token"]}
        c.post(f"/api/lines/{lid}/card", json={})
        card = CARD | {"plans": [{"name": "消融：去掉记忆", "goal": "看贡献"}, "换一个数据集"],
                       "outputs": [{"name": "主表", "due": "周五", "state": "doing"}]}
        assert c.post(f"/api/bridge/{lead['id']}/card", json={"card": card | {"outputs": [{"name": "x", "state": "late"}]}}, headers=h).status_code == 400
        assert c.post(f"/api/bridge/{lead['id']}/card", json={"card": card}, headers=h).status_code == 200
        row = c.get(f"/api/lines/{lid}/card").json()
        assert row["card"]["plans"] == [{"name": "消融：去掉记忆", "goal": "看贡献", "when": ""}, {"name": "换一个数据集", "goal": "", "when": ""}]
        assert row["card"]["outputs"][0] == {"name": "主表", "due": "周五", "state": "doing"}
        assert set(row) >= {"running", "queued", "repos", "memory"} and set(row["repos"]) == {"code", "paper"}

        q = c.post(f"/api/lines/{lid}/questions", json={"q": "主表什么时候能好？", "lead": True}).json()
        assert q["status"] == "waiting" and q["answer"]
        msg = [e for e in town.agents.events(lead["id"]) if e["kind"] == "user"][-1]["data"]["text"]
        assert msg.startswith("<question>") and "pt reply q1" in msg and "主表什么时候能好？" in msg
        assert "进展卡片" in c.get(f"/api/bridge/{lead['id']}/recall", params={"q": "主表"}, headers=h).json()["text"]
        assert c.post(f"/api/bridge/{lead['id']}/reply", json={"id": "q9", "text": "x"}, headers=h).status_code == 400
        assert c.post(f"/api/bridge/{lead['id']}/reply", json={"id": "q1", "text": "周五，等第三个数据集跑完。"}, headers=h).status_code == 200
        q = c.get(f"/api/lines/{lid}/questions").json()["questions"][-1]
        assert q["status"] == "done" and q["lead"]["text"] == "周五，等第三个数据集跑完。"

        c.post(f"/api/lines/{lid}/questions", json={"q": "baseline 比得怎么样？", "lead": True})
        page = "<!doctype html><html><head><title>主表对比</title></head><body><h1>对比</h1><a data-pt-file='src/a.py:3'>a</a></body></html>"
        assert c.post(f"/api/bridge/{lead['id']}/reply", json={"id": "q2", "html": page}, headers=h).status_code == 200
        q = c.get(f"/api/lines/{lid}/questions").json()["questions"][-1]
        assert q["lead"]["page"] == "p1" and q["lead"]["title"] == "主表对比"
        assert c.post(f"/api/bridge/{lead['id']}/publish", json={"html": "<h1>周报</h1><p>…</p>", "kind": "report"}, headers=h).status_code == 200
        assert c.post(f"/api/bridge/{lead['id']}/publish", json={"html": "<p>x</p>", "kind": "nope"}, headers=h).status_code == 400
        ps = c.get(f"/api/lines/{lid}/pages").json()["pages"]
        assert [(p["id"], p["title"], p["kind"], p["question"]) for p in ps] == [("p1", "主表对比", "answer", "q2"), ("p2", "周报", "report", None)]
        v = c.get(f"/api/lines/{lid}/pages/p1/view")
        csp = v.headers["content-security-policy"]
        assert "sandbox allow-scripts" in csp and "default-src 'none'" in csp and "allow-same-origin" not in csp
        assert v.text.index("--pt-ink") < v.text.index("<title>主表对比") and "postMessage" in v.text
        assert c.get(f"/api/lines/{lid}/pages/p2/view").text.startswith("<!doctype html>")
        assert "--pt-bg: #111" in c.get(f"/api/lines/{lid}/pages/p2/view?look=dark").text
        assert "--pt-bg: #111" not in c.get(f"/api/lines/{lid}/pages/p2/view?look=nope").text
        assert c.delete(f"/api/lines/{lid}/pages/p2").json() == {"ok": True}
        assert c.get(f"/api/lines/{lid}/pages/p2/view").status_code == 404
