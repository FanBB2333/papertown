"""Record the iOS demonstration cases in a disposable server that already contains the five built-in samples."""
import json
import sys
from datetime import date, timedelta
from pathlib import Path

from papertown import uploads
from papertown.config import Settings
from papertown.db import now
from papertown.history import _slug
from papertown.town import Town


def record_decisions(town, lid):
    agent = town.agents.ensure(lid, "lead")
    aid = agent["id"]
    matter = town.decided.raise_matter(agent, "主表怎样呈现盲审结果？", "paper", ["主表保存三个指标。"], ["并列展示三个指标。"], [])
    original = town.decided.write(lid, "主表先展示一致率。", "paper")
    town.decided.write(lid, "主表并列展示三个指标，文中说明分歧。", "paper", replaces=original["id"], matter=matter["id"])
    retired = town.decided.write(lid, "另建一份仅含单种子结果的表。", "data")
    town.decided.withdraw(lid, retired["id"])

    words = "保留每位评审的原始评分。"
    file = uploads.save(town.s.data_dir / "uploads", "评分表.csv", b"paper,reviewer,score\nA,R1,3\n")
    message = uploads.mention(words, [Path(file["path"])])
    event = town.agents.record(aid, "user", {"text": message, "user_text": words, "origin": "web"})
    town.decided.quote(lid, "data", event_id=event["id"])
    summary = "已完成三个种子的汇总。**评分一致率为 53.4%。**"
    town.agents.record(aid, "assistant", {"text": summary})
    town.leads.report(aid, summary, key=True)
    town.leads.ask(aid, "是否允许读取脱敏后的评审表？", ["允许", "拒绝"])

    def pending(note):
        doc = town.cards._read(lid)
        doc["pending"] = {"at": now(), "note": note}
        town.cards._write(lid, doc)

    pending("")
    town.cards.write(aid, {"summary": summary, "health": "ok", "progress": 75, "milestone": "核对主表与三个种子的记录",
                          "outputs": [{"name": "逐项评审对照表", "due": (date.today() + timedelta(days=1)).isoformat(), "state": "doing"}],
                          "need_you": ["附录中应展示哪些分歧案例？"], "metrics": [{"name": "评分一致率", "value": "53.4%"}]})
    pending("请在更新中列出意见分歧的论文。")
    town.canvas.add(lid, "task", 80, 380, "复核三个种子的主表", "请逐项核对主表与结果文件。", "coder", mod="exp", basis=["D8"])
    town.canvas.add(lid, "task", 400, 380, "整理待核对的图注", to="writer", mod="paper", created_by="assistant")
    town.canvas.publish(lid)


def record_memory(town, lid):
    code = town.history.roots(lid)[0][1]
    folder = Path(town.s.claude_home) / "projects" / _slug(code)
    folder.mkdir(parents=True, exist_ok=True)
    log = folder / "sample-review.jsonl"

    def entry(role, text):
        return json.dumps({"type": role, "cwd": str(code), "timestamp": now(), "message": {"role": role, "content": text}},
                          ensure_ascii=False) + "\n"

    log.write_text(entry("user", "保留每位评审的原始评分。") + entry("assistant", "已核对结果文件。**主表包含三个指标。**"))
    town.history.do_import(lid, ["claude:sample-review"])
    with log.open("a") as stream:
        stream.write(entry("user", "把分歧案例留到附录。"))


def record_staff_and_check(town, lid):
    # Record the state shown by the roster without starting an agent process.
    for role in ("lead", "coder"):
        agent = town.agents.ensure(lid, role)
        town.db.update("agents", {"id": agent["id"]}, runtime="pi", status="idle")
    words = "请逐项核对主表与结果文件。"
    town.agents.record(f"coder-{lid}", "user", {"text": words, "user_text": words, "origin": "web"})
    town.agents.record("lead-line_1", "sent", {"to": "writer-line_1", "who": "写作员工", "line_id": "line_1",
                                             "text": "汇总人工复核清单。**标出仍有分歧的样本。**", "basis": ["D7"]})
    config = town.mcp._town_config()
    config["mcpServers"]["sample-review"] = {"command": "false", "args": []}
    config["disabled"].append("sample-review")
    town.mcp._save_town(config)
    town.checks.record(lid, "method", "fail", None, {"kind": "soft", "note": "两种方法仍有分歧。**附录缺少逐项对照。**"}, "项目负责人")
    town.canvas.publish(lid)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: prepare-demo.py <isolated-sample-directory>")
    root = Path(sys.argv[1]).resolve()
    s = Settings()
    logs = (s.claude_home, s.codex_home, s.antigravity_home)
    if (s.data_dir.resolve() != root / "data" or not s.samples or s.lead_resident
            or not all(path and Path(path).resolve().is_relative_to(root) for path in logs)):
        raise SystemExit("Expected a sample configuration with data and transcript directories inside the supplied directory.")
    town = Town(s)
    lines = town.db.q("select id, sample from lines")
    if len(lines) != 5 or not all(line["sample"] for line in lines):
        raise SystemExit("Expected the five built-in sample projects.")
    marker = "ios_demo_preparation"
    if town.db.get_meta(marker) == "done":
        raise SystemExit(0)
    if town.db.get_meta(marker):
        raise SystemExit("The sample has already been modified. Use a fresh temporary sample to rebuild.")
    town.db.set_meta(marker, "started")
    record_decisions(town, "line_2")
    record_memory(town, "line_2")
    record_staff_and_check(town, "line_2")
    town.db.set_meta(marker, "done")

