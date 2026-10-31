import json

from fastapi.testclient import TestClient

from papertown.api import create_app

from .conftest import make_settings
from .test_linked import git_repo


def test_a_linked_projects_files(tmp_path):
    code, paper = tmp_path / "proj-code", tmp_path / "proj-paper"
    git_repo(code, {"README.md": "# Proj\n", "src/run.py": "print(1)\n", "results/scores.csv": "method,acc\nours,0.9\n"})
    git_repo(paper, {"main.tex": "\\documentclass{article}\\begin{document}x\\end{document}\n", "refs.bib": ""})
    (tmp_path / "projects.json").write_text(json.dumps({"projects": [{"key": "proj", "code": str(code), "paper": str(paper)}]}))
    app = create_app(make_settings(tmp_path, projects=str(tmp_path / "projects.json")))
    with TestClient(app) as c:
        lid = next(ln["id"] for ln in c.get("/api/lines").json() if ln["linked"])
        info = c.get(f"/api/lines/{lid}/ws").json()
        assert info["linked"] and info["code"]["git"] and info["code"]["branch"] == "main" and info["paper"]["main"] == "main.tex"

        tree = c.get(f"/api/lines/{lid}/ws/code/tree").json()
        assert [f["path"] for f in tree["files"]] == ["README.md", "results/scores.csv", "src/run.py"]
        assert c.get(f"/api/lines/{lid}/ws/code/file", params={"path": "src/run.py"}).json()["text"] == "print(1)\n"

        # never out of the repository, never into .git
        for bad in ("../proj-paper/main.tex", "/etc/hosts", ".git/config", "~/x"):
            assert c.get(f"/api/lines/{lid}/ws/code/file", params={"path": bad}).status_code == 400
            assert c.put(f"/api/lines/{lid}/ws/code/file", json={"path": bad, "text": "x"}).status_code == 400

        # saving is real: git sees the change, a new file is untracked
        r = c.put(f"/api/lines/{lid}/ws/code/file", json={"path": "src/run.py", "text": "print(2)\n"}).json()
        assert r["status"] == "modified" and (code / "src/run.py").read_text() == "print(2)\n"
        assert c.put(f"/api/lines/{lid}/ws/code/file", json={"path": "src/new/util.py", "text": "x = 1\n"}).json()["status"] == "untracked"
        st = {f["path"]: f.get("status") for f in c.get(f"/api/lines/{lid}/ws/code/tree").json()["files"]}
        assert st["src/run.py"] == "modified" and st["src/new/util.py"] == "untracked" and st["README.md"] is None
        assert "+print(2)" in c.get(f"/api/lines/{lid}/ws/code/diff", params={"path": "src/run.py"}).json()["diff"]
        (code / "blob.bin").write_bytes(b"\0\1\2")
        assert c.get(f"/api/lines/{lid}/ws/code/file", params={"path": "blob.bin"}).json()["binary"]
        assert c.put(f"/api/lines/{lid}/ws/code/file", json={"path": "blob.bin", "text": "x"}).status_code == 400

        # the data in the code, and no PDF until one is compiled
        data = c.get(f"/api/lines/{lid}/data").json()
        assert [f["path"] for f in data["files"]] == ["results/scores.csv"] and data["files"][0]["kind"] == "processed"
        assert c.get(f"/api/lines/{lid}/ws/paper/pdf").status_code == 404


def test_a_pipeline_project_without_code(tmp_path):
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as c:
        line = c.post("/api/ideas", json={"text": "retrieval for long documents with a learned index", "budget": 1}).json()
        info = c.get(f"/api/lines/{line['id']}/ws").json()
        assert info["code"] is None and not info["linked"]
        assert c.get(f"/api/lines/{line['id']}/ws/code/tree").status_code == 404
        assert c.get(f"/api/lines/{line['id']}/ws/elsewhere/tree").status_code == 404
        assert c.get("/api/lines/nope/ws").status_code == 404
        assert c.get(f"/api/lines/{line['id']}/data").json()["files"] == []
