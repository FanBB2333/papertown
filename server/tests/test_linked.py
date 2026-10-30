import json
import subprocess
import sys

from fastapi.testclient import TestClient

from papertown.api import create_app

from .conftest import make_settings

QUEUE = {
    "generated_at": "2026-10-30T00:00:00+00:00", "last_tick_at": "2026-10-30T00:00:00+00:00", "open_alerts": 2,
    "counts": {"running": 1, "pending": 1, "completed": 5},
    "nodes": [{"name": "box", "hostname": "10.0.0.2", "port": 22, "username": "me", "state": "up", "enabled": True, "ignored": False,
               "last_seen": "2026-10-30T00:00:00+00:00", "last_error": None, "gpu_count": 2, "gpus": [
                   {"index": 0, "name": "NVIDIA RTX 4090", "mem_total_mb": 24564, "mem_used_mb": 16, "free_mb": 24000, "util_percent": 0,
                    "temperature_c": 35, "queue_mem_mb": 0, "external_mem_mb": 16, "reserved_mb": 0, "attribution": "measured", "processes": []},
                   {"index": 1, "name": "NVIDIA RTX 4090", "mem_total_mb": 24564, "mem_used_mb": 20000, "free_mb": 3000, "util_percent": 97,
                    "temperature_c": 70, "queue_mem_mb": 20000, "external_mem_mb": 0, "reserved_mb": 20480, "attribution": "measured",
                    "processes": [{"pid": 1, "mem_mb": 20000, "name": "/usr/bin/python", "user": "me", "type": "C", "job_id": 7, "job_name": "train", "managed": True}]}]},
              {"name": "old", "state": "down", "ignored": True, "gpus": []}],
    "jobs": [{"id": 7, "name": "train", "state": "running", "node": "box", "gpu_ids": [1], "workdir": "/home/me/repos/proj-code",
              "submitter": "me", "progress": "epoch 3/10", "vram_mb": 20480, "env": {"SECRET": "x"}},
             {"id": 8, "name": "eval", "state": "pending", "workdir": "/home/me/repos/proj-code", "submitter": "me"},
             {"id": 9, "name": "someone-else", "state": "running", "workdir": "/data/other", "submitter": "x"}],
    "held": [], "recent": [{"id": 6, "name": "proj-smoke", "state": "completed", "workdir": None, "submitter": "codex:proj"}],
}


def fake_nvidb(tmp):
    data = tmp / "queue.json"
    data.write_text(json.dumps(QUEUE))
    exe = tmp / "nvidb"
    exe.write_text(f"#!{sys.executable}\nimport sys\nassert sys.argv[1:] == ['queue', 'status', '--json', '--no-tick'], sys.argv\n"
                   f"print(open({str(data)!r}).read())\n")
    exe.chmod(0o755)
    return exe


def git_repo(path, files):
    path.mkdir(parents=True)
    for name, text in files.items():
        (path / name).parent.mkdir(parents=True, exist_ok=True)
        (path / name).write_text(text)
    for cmd in (["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "feat: first"]):
        subprocess.run(["git", "-C", str(path), *cmd], check=True)


def test_gpus_and_a_linked_project(tmp_path):
    code, paper = tmp_path / "proj-code", tmp_path / "proj-paper"
    git_repo(code, {"README.md": "# Proj\n\nA project that merges layers of several models, searched by co-evolution over layer bags.\n",
                    "src/run.py": "print(1)\n", "AGENTS.md": "the repo's own rules\n"})
    git_repo(paper, {"main.tex": "\\documentclass{article}\\title{Proj: \\textsc{Merging} Models}\\begin{document}\\input{sections/abs}"
                                 "\\section{Introduction}x\\section{Method}y\\bibliography{refs}\\end{document}",
                     "sections/abs.tex": "\\begin{abstract}We merge models~\\cite{a}.\\end{abstract}",
                     "refs.bib": "@article{a,\n title={{Merging} Things},\n author={A and B},\n year={2025},\n eprint={2501.01234}\n}\n"
                                 "@inproceedings{b, title = \"Other\", author = {C}, booktitle = {ICML}, year = 2024}\n"})
    s = make_settings(tmp_path, nvidb_bin=str(fake_nvidb(tmp_path)), projects=str(tmp_path / "projects.json"))
    (tmp_path / "projects.json").write_text(json.dumps({"projects": [{"key": "proj", "code": str(code), "paper": str(paper)}]}))
    app = create_app(s)
    with TestClient(app) as c:
        town = app.state.town
        g = c.get("/api/gpus").json()
        assert g["ok"] and g["summary"] == {"nodes": 1, "up": 1, "gpus": 2, "idle": 1, "room": 1, "free_mb": 27000, "total_mb": 49128}
        assert [x["state"] for x in g["nodes"][0]["gpus"]] == ["idle", "full"] and g["nodes"][0]["gpus"][0]["name"] == "RTX 4090"
        assert "hostname" not in g["nodes"][0] and all("env" not in j for j in g["jobs"])
        nv = next(b for b in c.get("/api/jobs").json()["backends"] if b["id"] == "nvidb")
        assert nv["ready"] and "2 张卡" in nv["note"]
        assert "1 张空闲" in c.get("/api/buildings/power").json()["job"]

        line = next(ln for ln in c.get("/api/lines").json() if ln["linked"])
        assert line["status"] == "linked" and line["title"] == "Proj: Merging Models"
        info = line["linked"]
        assert info["code"]["branch"] == "main" and info["code"]["commits"][0]["subject"] == "feat: first"
        assert info["paper"]["sections"] == ["Introduction", "Method"] and info["paper"]["abstract"] == "We merge models ."
        assert info["paper"]["bib"] == 2 and info["paper"]["pdf"] is False
        exp = next(x for x in line["stages"] if x["key"] == "exp")
        assert exp["status"] == "run" and "1 个在跑" in exp["note"]  # train and eval by workdir, proj-smoke by submitter
        board = c.get("/api/jobs", params={"line_id": line["id"]}).json()["jobs"]
        assert {j["name"]: (j["status"], j["progress"]) for j in board} == {"train": ("running", 30), "eval": ("queued", 0), "proj-smoke": ("done", 100)}
        assert c.get("/api/jobs/nvidb-7").json()["cwd"] == "/home/me/repos/proj-code"

        refs = c.get(f"/api/lines/{line['id']}/papers").json()["references"]
        assert [(r["title"], r["url"]) for r in refs] == [("Merging Things", "https://arxiv.org/abs/2501.01234"),
                                                          ("Other", "https://scholar.google.com/scholar?q=Other")]
        assert c.get(f"/api/lines/{line['id']}/linked/pdf").status_code == 404
        # the pipeline leaves it alone, and nvidb is not submitted to from here
        assert c.post(f"/api/lines/{line['id']}/resume").status_code == 400
        assert c.post("/api/jobs", json={"name": "x", "command": "true", "backend": "nvidb", "line_id": line["id"]}).status_code == 400

        # an agent works in the repo itself, but its guide and tools stay in Papertown's directory
        a = town.agents.ensure(line["id"], "coder")
        assert a["cwd"] == str(code)
        town.agents._guide(a, "paseo")
        pt = town.agents._tools(a)
        assert (code / "AGENTS.md").read_text() == "the repo's own rules\n" and not (code / "CLAUDE.md").exists()
        assert not (code / ".papertown").exists() and pt.is_relative_to(s.projects_dir)
        intro = town.agents.brief(a["id"])  # the linked guide, not the pipeline's: no draft method, nvidb for the GPUs
        assert "工作目录就是仓库本身" in intro and "nvidb job submit" in intro and "方法草案" not in intro
        assert subprocess.run(["git", "-C", str(code), "status", "--porcelain"], capture_output=True, text=True).stdout == ""
        assert town.linked.sync() == []  # a second start adds nothing


def test_nvidb_missing(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as c:
        g = c.get("/api/gpus").json()
        assert not g["ok"] and "nvidb" in g["note"] and g["nodes"] == []
        assert not next(b for b in c.get("/api/jobs").json()["backends"] if b["id"] == "nvidb")["ready"]
