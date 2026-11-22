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
    "lanes": [{"name": "box:1", "node": "box", "gpu_ids": [1], "paused": False, "concurrency": 1, "runner_up": True, "blocked": None,
               "running": [{"id": 7, "name": "train", "state": "running"}],
               "queued": [{"id": 10, "name": "sweep", "state": "pending", "lane": "box:1", "lane_seq": 2000, "vram_mb": 8192}]},
              {"name": "old:0", "node": "old", "gpu_ids": [0], "running": [], "queued": []}],
}


# nvidb's history: a live job again (the live reading wins), an old run found by its command, someone else's
HISTORY = [
    {"id": 7, "name": "train", "state": "pending", "workdir": "/home/me/repos/proj-code"},
    {"id": 3, "name": "ablation", "state": "completed", "node": "box", "gpu_ids": [0], "workdir": None, "submitter": "codex:x",
     "command": "cd /home/me/repos/proj-code && python ablate.py", "result": {"acc": 0.91}, "env": {"SECRET": "x"},
     "notes": "drop the local search", "elapsed_s": 120.0, "exit_code": 0,
     "events": [{"id": 1, "ts": "2026-10-29T00:00:00+00:00", "kind": "job_started", "node": "box", "message": "pid 1 on GPU 0", "data": {}}]},
    {"id": 2, "name": "other", "state": "failed", "workdir": "/data/other", "command": "python x.py"},
]


def fake_nvidb(tmp):
    data, hist = tmp / "queue.json", tmp / "history.json"
    data.write_text(json.dumps(QUEUE))
    hist.write_text(json.dumps(HISTORY))
    exe = tmp / "nvidb"
    exe.write_text(f"""#!{sys.executable}
import json, sys
a = sys.argv[1:]
hist = json.load(open({str(hist)!r}))
if a == ['queue', 'status', '--json', '--no-tick']:
    print(open({str(data)!r}).read())
elif a[:4] == ['job', 'ls', '--json', '--no-tick'] and a[4] == '-n':
    print(json.dumps({{'jobs': hist}}))
elif a[:2] == ['job', 'show'] and a[3:] == ['--json', '--no-tick']:
    j = next((x for x in hist if x['id'] == int(a[2])), None)
    print(json.dumps(j or {{'error': 'no such job'}}))
    sys.exit(0 if j else 1)
else:
    sys.exit('not a read: ' + ' '.join(a))
""")
    exe.chmod(0o755)
    return exe


def git_repo(path, files):
    path.mkdir(parents=True)
    for name, text in files.items():
        (path / name).parent.mkdir(parents=True, exist_ok=True)
        (path / name).write_text(text)
    for cmd in (["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "feat: first"]):
        subprocess.run(["git", "-C", str(path), *cmd], check=True)


def linked_settings(tmp, code, paper, **kw):
    """Settings whose projects.json links the project "proj" to these code and paper repos."""
    (tmp / "projects.json").write_text(json.dumps({"projects": [{"key": "proj", "code": str(code), "paper": str(paper)}]}))
    return make_settings(tmp, projects=str(tmp / "projects.json"), **kw)


def test_gpus_and_a_linked_project(tmp_path):
    code, paper = tmp_path / "proj-code", tmp_path / "proj-paper"
    git_repo(code, {"README.md": "# Proj\n\nA project that merges layers of several models, searched by co-evolution over layer bags.\n",
                    "src/run.py": "print(1)\n", "AGENTS.md": "the repo's own rules\n"})
    git_repo(paper, {"main.tex": "\\documentclass{article}\\title{Proj: \\textsc{Merging} Models}\\begin{document}\\input{sections/abs}"
                                 "\\section{Introduction}x\\section{Method}y\\bibliography{refs}\\end{document}",
                     "sections/abs.tex": "\\begin{abstract}We merge models~\\cite{a}.\\end{abstract}",
                     "refs.bib": "@article{a,\n title={{Merging} Things},\n author={A and B},\n year={2025},\n eprint={2501.01234}\n}\n"
                                 "@inproceedings{b, title = \"Other\", author = {C}, booktitle = {ICML}, year = 2024}\n"})
    s = linked_settings(tmp_path, code, paper, nvidb_bin=str(fake_nvidb(tmp_path)))
    app = create_app(s)
    with TestClient(app) as c:
        town = app.state.town
        g = c.get("/api/gpus").json()
        assert g["ok"] and g["summary"] == {"nodes": 1, "up": 1, "gpus": 2, "idle": 1, "room": 1, "free_mb": 27000, "total_mb": 49128}
        assert [x["state"] for x in g["nodes"][0]["gpus"]] == ["idle", "full"] and g["nodes"][0]["gpus"][0]["name"] == "RTX 4090"
        assert "hostname" not in g["nodes"][0] and all("env" not in j for j in g["jobs"])
        busy = g["nodes"][0]["gpus"][1]
        assert g["poll_s"] == 10 and g["polled_at"] and busy["trend"][-1][1:] == [97, 20000]
        assert busy["procs"] == [{"pid": 1, "user": "me", "name": "python", "mem_mb": 20000, "managed": True, "job_id": 7,
                                  "job_name": "train", "seen_since": busy["procs"][0]["seen_since"], "earlier": True}]
        assert [(ln["name"], ln["running"], ln["queued"]) for ln in g["lanes"]] == [("box:1", [7], [10])]
        assert next(j for j in g["jobs"] if j["id"] == 10)["lane"] == "box:1" and g["pools"] == []
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
        assert exp["status"] == "run" and "1 个在跑" in exp["note"]
        board = c.get("/api/jobs", params={"line_id": line["id"]}).json()["jobs"]
        assert {j["name"]: (j["status"], j["progress"]) for j in board} == {
            "train": ("running", 30), "eval": ("queued", 0), "proj-smoke": ("done", 100), "ablation": ("done", 100)}
        assert c.get("/api/jobs/nvidb-7").json()["cwd"] == "/home/me/repos/proj-code"
        j = c.get("/api/nvidb/jobs/3").json()
        assert j["result"] == {"acc": 0.91} and j["events"][0]["kind"] == "job_started" and "ablate.py" in j["command"]
        assert "env" not in j and "SECRET" not in json.dumps(j)
        assert c.get("/api/nvidb/jobs/99").status_code == 404
        runs = c.get(f"/api/lines/{line['id']}/data").json()["runs"]
        assert [(r["name"], r["result"]) for r in runs if r["result"]] == [("ablation", {"acc": 0.91})]

        refs = c.get(f"/api/lines/{line['id']}/papers").json()["references"]
        assert [(r["title"], r["url"]) for r in refs] == [("Merging Things", "https://arxiv.org/abs/2501.01234"),
                                                          ("Other", "https://scholar.google.com/scholar?q=Other")]
        assert c.get(f"/api/lines/{line['id']}/linked/pdf").status_code == 404
        assert c.post(f"/api/lines/{line['id']}/resume").status_code in (404, 405)
        assert c.post("/api/jobs", json={"name": "x", "command": "true", "backend": "nvidb", "line_id": line["id"]}).status_code == 400

        a = town.agents.ensure(line["id"], "coder")
        assert a["cwd"] == str(code)
        town.agents._guide(a, "paseo")
        pt = town.agents._tools(a)
        assert (code / "AGENTS.md").read_text() == "the repo's own rules\n" and not (code / "CLAUDE.md").exists()
        assert not (code / ".papertown").exists() and pt.is_relative_to(s.projects_dir)
        intro = town.agents.brief(a["id"])
        assert "工作目录就是仓库本身" in intro and "nvidb job submit" in intro and "方法草案" not in intro
        assert subprocess.run(["git", "-C", str(code), "status", "--porcelain"], capture_output=True, text=True).stdout == ""
        assert town.linked.sync() == []


def test_nvidb_missing(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as c:
        g = c.get("/api/gpus").json()
        assert not g["ok"] and "nvidb" in g["note"] and g["nodes"] == []
        assert not next(b for b in c.get("/api/jobs").json()["backends"] if b["id"] == "nvidb")["ready"]
