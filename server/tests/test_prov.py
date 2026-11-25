import hashlib
import importlib.util
import json
import os
import subprocess
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from papertown import prov as module, samples
from papertown.api import create_app
from papertown.prov_git import COMMANDS, POINTER, ProvError, git

from .conftest import make_settings


@pytest.fixture
def project(tmp_path, monkeypatch):
    monkeypatch.setattr(module, "INTERVAL", 0)
    app = create_app(make_settings(tmp_path))
    with TestClient(app) as client:
        town = app.state.town
        lid = town.pipeline.create("Trace a reported experiment")["id"]
        yield client, town, lid, town.agents.ensure(lid, "coder"), town.agents.ensure(lid, "writer")


def test_operation_cursor_includes_tied_timestamps(project):
    _, town, lid, coder, writer = project
    for agent in (coder, writer):
        Path(agent["cwd"]).mkdir(parents=True, exist_ok=True)
    heads = town.prov.snap(lid)
    assert all(heads.values())
    stamp = "2026-01-01T00:00:00+00:00"
    town.db.x("update prov_ops set ts = ? where line_id = ?", stamp, lid)
    first, second = town.prov.ops(lid)
    assert town.prov.ops(lid, before=first["id"], limit=1) == [second]
    assert town.prov.ops(lid, before=second["id"]) == town.prov.ops(lid, before=stamp) == []


def checkout(path, files):
    # The project's own repository is prepared before taking the read-only fingerprint.
    path.mkdir()
    subprocess.run(["git", "init", "-q", "--template=", str(path)], check=True)
    for name, text in files.items():
        (path / name).write_text(text)
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")} | {
        "GIT_AUTHOR_NAME": "Test Author", "GIT_COMMITTER_NAME": "Test Author", "GIT_AUTHOR_EMAIL": "a@local",
        "GIT_COMMITTER_EMAIL": "a@local", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
    def setup(*args, data=None):
        return subprocess.run(["git", "--no-optional-locks", "-C", str(path), *args], capture_output=True, input=data,
                              env=env, check=True).stdout.strip().decode()
    setup("update-index", "--add", "--", *files)
    oid = setup("commit-tree", setup("write-tree"), data=b"original paper\n")
    setup("update-ref", "HEAD", oid)
    return oid


def fingerprint(root):
    return {str(f.relative_to(root)): (f.lstat().st_mtime_ns, f.lstat().st_mode,
             hashlib.sha256(f.read_bytes()).digest() if f.is_file() else None) for f in [root, *root.rglob("*")]}


def wait_for(fn):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if value := fn():
            return value
        time.sleep(.025)
    pytest.fail("timed out waiting for provenance")


@pytest.mark.parametrize("split_index", [False, True])
def test_project_git_is_byte_and_mtime_identical_through_every_read(project, tmp_path, monkeypatch, split_index):
    client, town, lid, _, writer = project
    root = tmp_path / "author"
    original = checkout(root, {".gitignore": "ignored/\n", "main.tex": "\\section{Checks}\nA measured 12.3.\n"})
    if split_index:
        subprocess.run(["git", "-C", str(root), "update-index", "--split-index"], check=True)
    (root / "ignored").mkdir()
    (root / "ignored/a.csv").write_text("12.34\n")
    (root / "ignored/private.csv").write_text("unregistered")
    (root / "main.tex").write_text("% unpublished\n" + (root / "main.tex").read_text())
    (root / "notes.txt").write_text("untracked")
    (root / "personal.tmp").write_text("globally ignored")
    ignore = tmp_path / "personal-ignores"
    ignore.write_text("personal.tmp\n")
    config = tmp_path / "global.gitconfig"
    config.write_text(f'[core]\n\texcludesFile = "{ignore}"\n')
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(config))
    (root / ".gitattributes").write_text("*.tex text eol=crlf filter=example\n")
    town.db.update("lines", {"id": lid}, linked={"paper": str(root), "match": []})
    town.db.update("agents", {"id": writer["id"]}, cwd=str(root), session_id="s1")
    writer = town.agents.get(writer["id"])
    old = fingerprint(root)
    # Inherited Git variables must never route objects, locks or the index into this checkout.
    monkeypatch.setenv("GIT_INDEX_FILE", str(root / ".git/index"))
    monkeypatch.setenv("GIT_OBJECT_DIRECTORY", str(root / ".git/objects"))
    p = town.prov
    p.snap(lid)
    before = p.head(lid, "paper")["id"]
    assert p.snap(lid)["paper"] == before
    src = p.add(lid, writer, "ignored/a.csv")
    assert p.head(lid, "paper")["trigger"] == "add"
    row = p.add(lid, writer, "main.tex:3", [src["tag"]], basis=["D1"])
    repo = p.repo(lid, "paper")
    assert set(repo.git("ls-files").decode().splitlines()) == {".gitignore", "main.tex", "notes.txt", ".gitattributes", "ignored/a.csv"}
    assert repo.git("cat-file", "blob", before + ":main.tex") == (root / "main.tex").read_bytes()
    assert p.snap(lid)["paper"] == row["op"]
    assert (repo.store / "index-paper").is_file()
    assert json.loads((repo.store.parent / "prov.json").read_text())["paper"] == ["ignored/a.csv", "main.tex"]
    api = f"/api/lines/{lid}/prov"
    assert client.get(api).json()["stats"]["ops"] == 2
    assert client.get(api + "/nodes/" + row["id"]).json()["numbers"] == [{"text": "12.3", "ok": True, "where": "ignored/a.csv"}]
    blame = client.get(api + "/blame", params={"root": "paper", "path": "main.tex"}).json()
    assert blame[0]["who"] == module.BASE and "commit" not in blame[0]
    assert blame[-1]["commit"] == original and blame[-1]["author"] == "Test Author" and blame[-1]["date"]
    assert blame[-1]["node"] == row["id"] and blame[-1]["op"] == before
    assert client.get(api + "/ops/" + row["op"]).json()["files"][0]["path"] == "ignored/a.csv"
    assert client.post(api + "/snap").json()["paper"] == row["op"]
    assert fingerprint(root) == old
    for command in ("checkout", "commit", "gc", "config", "reset", "worktree"):
        assert command not in COMMANDS
        with pytest.raises(ValueError):
            repo.git(command)
    with pytest.raises(ValueError):
        git(root, "add", "notes.txt")


def test_limits_pins_private_paths_and_stat_cache(project, tmp_path, monkeypatch):
    _, town, lid, coder, _ = project
    town.s.prov_file_bytes, town.s.prov_max_files = 64, 3
    root = Path(coder["cwd"])
    for name in ("checkpoints", ".venv", "__pycache__", "node_modules", "wandb", ".papertown"):
        (root / name).mkdir()
        (root / name / "private").write_text("omitted")
    (root / "a.bin").write_bytes(b"a" * 16384)
    (root / "b").write_text("small")
    (root / "c").write_text("small")
    (root / "d").write_text("chosen explicitly")
    (root / "escape").symlink_to(tmp_path)
    p = town.prov
    repo = p.repo(lid, "code")
    p.snap(lid)
    head = p.head(lid, "code")
    pointer = repo.git("cat-file", "blob", head["id"] + ":a.bin")
    blob = hashlib.sha1(b"blob 16384\0" + b"a" * 16384).hexdigest()
    assert POINTER.fullmatch(pointer)[2].decode() == blob
    assert not repo.git("cat-file", "-t", blob, optional=True)
    called = []
    monkeypatch.setattr("papertown.prov_git.file_hash", lambda *a: called.append(a) or blob)
    assert p.snap(lid)["code"] == head["id"] and not called
    p.add(lid, coder, "d")
    assert set(repo.git("ls-files").decode().splitlines()) == {"a.bin", "b", "d"}
    for name in ("../lead/AGENTS.md", ".git/config", ".papertown/private", "escape", "/etc/passwd"):
        with pytest.raises(ProvError):
            p.add(lid, coder, name)
    assert p.ops(lid, "code")[0]["files"] == 2


def test_queue_attribution_turns_before_ticks_and_failure(project, monkeypatch):
    _, town, lid, coder, writer = project
    p = town.prov
    path = Path(coder["cwd"]) / "run.py"
    path.write_text("base")
    p.snap(lid)
    town.agents._set(coder["id"], session_id="turn-session", model="test/model")
    coder = town.agents.get(coder["id"])
    town.agents.record(coder["id"], "user", {"delivered": True, "basis": ["D1"]})
    town.agents.record(coder["id"], "user", {"held": True, "basis": []})
    path.write_text("turn")
    p.employee(coder, "turn")
    wait_for(lambda: p.head(lid, "code")["trigger"] == "turn")
    op = p.ops(lid, "code")[0]
    assert (op["agent"], op["role"], op["session"], op["basis"]) == (coder["id"], "coder", "turn-session", ["D1"])
    message = p.repo(lid, "code").git("show", "-s", "--format=%B", op["id"]).decode()
    assert all("Papertown-" + x in message for x in ("Trigger: turn", "Session: turn-session", "Basis: D1", "Role: coder", "Agent: " + coder["id"]))
    path.write_text("external")
    p.employee(coder, "before")
    wait_for(lambda: p.head(lid, "code")["trigger"] == "before")
    assert p.ops(lid, "code")[0]["who"] == module.EXTERNAL
    town.db.update("agents", {"id": coder["id"]}, status="working")
    for trigger in ("before", "submit", "job", "manual"):
        path.write_text("owned " + trigger)
        oid = p.request(lid, "code", trigger).result()
        row = p.op(lid, oid)
        assert row["trigger"] == trigger and row["agent"] == coder["id"] and row["basis"] == ["D1"]
    other = town.agents.ensure(lid, "coder", "t5")
    town.db.update("agents", {"id": other["id"]}, status="working")
    path.write_text("joint")
    p.tick(lid)
    wait_for(lambda: p.head(lid, "code")["trigger"] == "tick")
    assert all(x["id"] in p.head(lid, "code")["who"] for x in (coder, other))
    town.leads.configure(lid, on=False)
    path.write_text("after off")
    monkeypatch.setattr(p, "request", lambda *a, **kw: pytest.fail("unexpected snapshot"))
    p.tick(lid)
    p.employee(town.agents.ensure(lid, "lead"), "turn")


def test_rate_limit_fifo_and_snapshot_failure_does_not_hold_delivery(project, monkeypatch):
    _, town, lid, coder, _ = project
    p = town.prov
    assert module.INTERVAL == 0  # all other tests use a virtual zero interval
    monkeypatch.setattr(module, "INTERVAL", 5)
    entered, release = threading.Event(), threading.Event()
    times = []
    def broken(*args):
        times.append(time.monotonic())
        entered.set()
        assert release.wait(2)
        raise OSError("isolated snapshot failure")
    monkeypatch.setattr(p, "_snapshot", broken)
    town.db.update("agents", {"id": coder["id"]}, runtime="paseo", ext_id="fake", status="idle")
    sent = []
    monkeypatch.setattr(town.agents.paseo, "send", lambda *a: sent.append(a))
    town.agents.say(coder["id"], "hello", origin="papertown")
    assert sent == [("fake", "hello")] and entered.wait(1)
    next_one = p.request(lid, "code", "manual")
    release.set()
    assert next_one.result(timeout=8) is None
    assert times[1] - times[0] >= 4.99
    assert town.db.val("select count(*) from trace where line_id = ? and kind = 'PROV' and detail = 'isolated snapshot failure'", lid) == 2


def test_registration_verification_tree_history_and_cache(project, monkeypatch):
    client, town, lid, coder, writer = project
    p = town.prov
    root = Path(coder["cwd"])
    (root / "raw.json").write_text('{"a":0.9535,"b":-1.245,"n":42}')
    (root / "table.csv").write_text("score\n0.9535\n")
    lines = ["Preamble", r"\section{Study}", "Before", r"\subsection{Results}", r"\begin{table*}", "95.4 and -1.25, 7.77.",
             r"\label{tab:main}", r"\end{table*}", "After", r"\begin{figure}", r"\label{fig:open}", r"\end{figure}"]
    tex = Path(writer["cwd"]) / "s.tex"
    tex.write_text("\n".join(lines) + "\n")
    p.snap(lid)
    src = p.add(lid, coder, "raw.json")
    art = p.add(lid, coder, "code/table.csv", [src["tag"]], how="aggregate", basis=["D1"])
    node = p.add(lid, writer, "s.tex#tab:main", [art["tag"], "cite:ref", "arxiv:2401.00001"], basis=["D1"])
    assert node["kind"] == "passage" and node["span"] == {"start":5, "end":8, "text":"\n".join(lines[4:8])}
    assert len(node["tag"]) == 7 and p.add(lid, writer, "s.tex#tab:main", [art["tag"], "cite:ref", "arxiv:2401.00001"], basis=["D1"])["id"] == node["id"]
    for target in ("s.tex:0", "s.tex:3-2", "s.tex:9999", "s.tex#missing"):
        with pytest.raises(ProvError):
            p.add(lid, writer, target)
    with pytest.raises(ProvError):
        p.add(lid, coder, "raw.json:1")
    with pytest.raises(ProvError):
        p.add(lid, coder, "raw.json", job="unknown")
    with pytest.raises(Exception, match="D999"):
        p.add(lid, coder, "raw.json", basis=["D999"])
    stats = p.analysis(lid).view["stats"]
    assert stats["floats"] == {"total":2,"tagged":1} and stats["numbers"] == {"total":3,"ok":2}
    d = p.analysis(lid).detail(node["tag"])
    assert [n["ok"] for n in d["numbers"]] == [True, True, False] and d["numbers"][1]["where"] == "raw.json"
    assert {r["kind"] for r in p.analysis(lid).nodes.values()} == {"passage","artifact","result","source"}
    view = p.analysis(lid)
    assert view is p.analysis(lid)
    sections = view.view["files"][0]["sections"]
    assert [s["title"] for s in sections] == ["s.tex","Study","Results"] and sections[2]["nodes"] == [node["id"]]
    assert sum(n["lines"] for s in sections for n in s["rest"]) == 8
    assert [r["labels"] for r in view.unregistered] == [["fig:open"]]
    assert view.detail(src["id"])["gaps"] and view.detail(art["id"])["used"][0]["id"] == node["id"]
    tex.write_text("New first line\n" + tex.read_text())
    p.snap(lid)
    assert p.analysis(lid).detail(node["tag"])["state"] == "moved"
    (root / "raw.json").write_text('{"a":0.9535}')
    tex.write_text(tex.read_text().replace("95.4", "96.1"))
    p.snap(lid)
    d = p.analysis(lid).detail(node["tag"])
    assert d["state"] == "changed" and "95.4" in d["then"] and "+96.1" in d["diff"] and not d["numbers"][1]["ok"]
    assert p.analysis(lid).detail(src["id"])["state"] == "changed"
    revised = p.add(lid, writer, "s.tex#tab:main", [art["tag"]], title="Revision")
    assert p.analysis(lid).detail(revised["id"])["history"][0]["id"] == node["id"]
    assert node["id"] not in p.analysis(lid).view["files"][0]["sections"][-1]["nodes"]
    (root / "raw.json").rename(root / "removed.json")
    tex.rename(tex.with_suffix(".old"))
    p.snap(lid)
    assert all(p.analysis(lid).detail(ref)["state"] == "missing" for ref in [src["tag"], revised["tag"]])
    assert p.analysis(lid).detail(src["id"])["then"].startswith('{"a":') and p.analysis(lid).view["loose"]


def test_bridge_cli_job_outputs_exp_and_public_contract(project, monkeypatch):
    client, town, lid, coder, writer = project
    p = town.prov
    code, paper = Path(coder["cwd"]), Path(writer["cwd"])
    (code / "train.py").write_text("# version one\n")
    (paper / "paper.tex").write_text("\\section{Results}\nScore 75.0.\n")
    cb = f"/api/bridge/{coder['id']}"
    wb = f"/api/bridge/{writer['id']}"
    hc, hw = {"x-papertown-token": coder["token"]}, {"x-papertown-token": writer["token"]}
    public = f"/api/lines/{lid}"
    events = []
    publish = town.bus.publish
    def record(kind, **data):
        if kind == "prov":
            events.append(data)
        publish(kind, **data)
    monkeypatch.setattr(town.bus, "publish", record)
    command = """mkdir -p outputs
echo '{"accuracy": 0.7502}' > outputs/metrics.json
cp outputs/metrics.json "$PAPERTOWN_JOB_DIR/result.json"
echo '# version two' > train.py"""
    j = client.post(cb + "/jobs", headers=hc, json={"name":"run", "command":command, "basis":["D1"], "outs":["outputs/metrics.json"]}).json()
    assert j["op"] and j["outs"] == ["outputs/metrics.json"]
    assert p.repo(lid, "code").git("cat-file", "blob", j["op"] + ":train.py") == b"# version one\n"
    def finished():
        r = client.get(public + "/data").json()["runs"]
        return r[0]["prov"] if r and len(r[0]["prov"]) == 2 else None
    leaves = wait_for(finished)
    assert {s["path"] for s in leaves} == {"outputs/metrics.json", f"jobs/{j['id']}/result.json"}
    for s in leaves:
        assert set(s) == {"id", "tag", "state", "path", "used"} and not s["used"]
        node = p.analysis(lid).detail(s["id"])
        assert node["kind"] == "result" and not node["gaps"] and node["made"]["job"]["op"] == j["op"]
        assert node["made"]["job"]["status"] == "done" and node["made"]["basis"] == ["D1"]
    table = {"metrics":["accuracy"],"rows":[{"method":"ours","values":[75.0],"from":[j["id"],leaves[0]["tag"]]}],
             "job_id":j["id"],"how":"aggregate the run","basis":["D1"]}
    assert client.post(cb + "/output", headers=hc, json={"stage":"exp","body":table | {"job_id":"not-a-job"}}).status_code == 400
    assert client.post(cb + "/output", headers=hc, json={"stage":"exp","body":table}).status_code == 200
    item = town.db.one("select * from items where line_id = ? and stage = 'exp'", lid)
    artifact = next(r for r in p.analysis(lid).nodes.values() if r["kind"] == "artifact")
    assert item["body"]["rows"][0]["from"] == table["rows"][0]["from"]
    assert artifact["path"] == item["id"] and set(artifact["src"]) == {s["id"] for s in leaves}
    assert "aggregate the run" in p.analysis(lid).detail(artifact["id"])["then"]
    res = client.post(wb + "/prov", headers=hw, json={"target":"paper.tex:2","from":[artifact["tag"]],"basis":["D1"],"note":"verified"})
    assert res.status_code == 200
    n = res.json()
    assert set(n) == {"id","tag","kind","title","root","path","span","blob","op","state","made","src","numbers","gaps","note","created_at"}
    assert set(n["made"]) == {"at","agent","role","who","model","session","how","job","basis"}
    assert n["numbers"][0]["ok"] and n["made"]["agent"] == writer["id"]
    assert client.get(wb + "/prov/" + n["tag"], headers=hw).json() == client.get(public + "/prov/nodes/" + n["id"]).json()
    view = client.get(public + "/prov").json()
    assert set(view) == {"stats","files","nodes","loose"} and set(view["files"][0]) == {"path","title","sections"}
    assert view["files"][0]["sections"][0]["nodes"] == [n["id"]]
    stats = client.get(public + "/card").json()["prov"]
    assert stats == view["stats"] | {"recent": p.ops(lid, limit=3)} and len(stats["recent"]) <= 3
    assert client.get("/api/cards").json()["cards"][0]["prov"] == stats
    assert {r["id"] for r in client.get(public + "/decided/D1").json()["work"]["prov"]} == set(view["nodes"])
    assert all(r["used"] == 1 for r in finished())
    ops = client.get(public + "/prov/ops", params={"root":"code","limit":1}).json()
    assert len(ops) == 1 and ops[0]["root"] == "code"
    assert set(ops[0]) == {"id","short","root","ts","trigger","agent","role","who","session","basis","files","added","removed","summary"}
    previous = client.get(public + "/prov/ops", params={"root":"code","before":ops[0]["id"]}).json()
    assert previous and all(r["ts"] < ops[0]["ts"] for r in previous)
    detail = client.get(public + "/prov/ops/" + ops[0]["id"]).json()
    assert all(set(f) == {"path","added","removed","diff"} for f in detail["files"])
    assert [e for e in events if e.get("node") == n["id"]] and all(e["line_id"] == lid for e in events)
    (town.s.jobs_dir / j["id"] / "result.json").write_text('{"accuracy": 0.6}')
    result = p.analysis(lid).detail(next(s["id"] for s in leaves if s["path"].startswith("jobs/")))
    assert result["state"] == "changed" and "0.7502" in result["then"] and "0.6" in result["diff"]
    assert client.get(cb + "/prov").status_code == 403
    other = town.pipeline.create("Second isolated project")["id"]
    assert client.get(f"/api/lines/{other}/prov/nodes/{n['id']}").status_code == 404
    assert client.get(f"/api/lines/{other}/prov/ops/{j['op']}").status_code == 404
    with pytest.raises(ProvError):
        p.add(lid, writer, "paper.tex:2", sources=["job:unknown"])
    overview = client.get(cb + "/prov", headers=hc).json()
    assert set(overview) == {"stats","unregistered"}
    spec = importlib.util.spec_from_file_location("prov_pt", Path(__file__).parents[1] / "papertown/pi/pt.py")
    cli = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cli)
    calls = []
    def bridge(path, body=None):
        calls.append((path, body))
        if path == "/jobs":
            return {"text":"queued"}
        response = client.get(wb + path, headers=hw) if body is None else client.post(wb + path, headers=hw, json=body)
        response.raise_for_status()
        return response.json()
    monkeypatch.setattr(cli, "call", bridge)
    cli.main(["prov"])
    cli.main(["prov","show", n["tag"]])
    cli.main(["prov","add","paper.tex:2","--from",artifact["tag"],"--by","D1","--how","report mean","--title","Score","--note","test"])
    assert calls[-1][1] == {"target":"paper.tex:2","from":[artifact["tag"]],"basis":["D1"],"how":"report mean","title":"Score","note":"test"}
    cli.main(["submit","paired","--out","a","--out","b","--by","D1","--","run","--out","cli"])
    assert calls[-1][1]["outs"] == ["a","b"] and calls[-1][1]["command"] == "run --out cli"


def test_nvidb_is_scoped_read_only_and_disabled_history(project, monkeypatch):
    _, town, lid, coder, _ = project
    p = town.prov
    remote = {"id":41, "name":"read-only run", "command":"train.py", "node":"gpu", "workdir":"/remote/run", "state":"completed",
              "started_at":"2025-01-01", "finished_at":"2025-01-02"}
    monkeypatch.setattr(town.linked, "jobs", lambda line: [remote] if line == lid else [])
    (Path(coder["cwd"]) / "metrics").write_text("3.2")
    row = p.add(lid, coder, "metrics", job="nvidb-41")
    job = row["made"]["job"]
    assert job["op"] is None and (job["command"], job["node"], job["cwd"]) == ("train.py","gpu","/remote/run")
    assert not town.db.val("select 1 from jobs where id = 'nvidb-41'")
    assert p.analysis(lid).detail(row["id"])["gaps"] == ["缺少代码版本"]
    town.s.prov = False
    (Path(coder["cwd"]) / "metrics").write_text("4.1")
    assert p.snap(lid) == {"paper":None,"code":None}
    with pytest.raises(ProvError, match="已关闭"):
        p.add(lid, coder, "metrics")
    assert len(p.ops(lid)) == 1


def test_sample_contains_complete_chain_and_attention_states(town):
    lid = samples.seed(town)["added"][1]
    view = town.prov.analysis(lid)
    table = next(n for n in view.nodes.values() if n["title"] == "盲审评测主结果" and n["src"])
    assert table["kind"] == "passage" and sum(not n["ok"] for n in table["numbers"]) == 1
    artifact = view.nodes[table["src"][0]]
    leaf = view.nodes[artifact["src"][0]]
    assert artifact["kind"] == "artifact" and leaf["kind"] == "result" and leaf["made"]["job"]["op"]
    assert any(n["state"] == "moved" for n in view.nodes.values())
    assert {n["state"] for n in view.nodes.values()} == {"ok","moved","changed","missing"}
    assert len(town.prov.ops(lid, "paper")) >= 3 and {op["role"] for op in town.prov.ops(lid)} >= {"writer","coder"}
    assert samples.seed(town)["added"] == []


@pytest.mark.parametrize(("provider", "event"), [
    ("claude", {"hook_event_name": "Stop"}), ("codex", {"type": "agent-turn-complete"}), ("antigravity", {"agent_state": "idle"})])
def test_hosted_turn_and_held_delivery_trigger_once(project, monkeypatch, provider, event):
    _, town, _, coder, _ = project
    aid = coder["id"]
    term = {"backend": "headless", "provider": provider, "handle": {"test": True}, "generation": "gen", "status": "working", "seq": 0, "seen_seq": 0}
    town.db.update("agents", {"id": aid}, runtime="headless", status="working", term=term)
    hosted = town.agents.hosted
    calls = []
    monkeypatch.setattr(town.prov, "employee", lambda a, trigger: calls.append((trigger, a["id"])))
    monkeypatch.setattr(hosted.backends["headless"], "submit", lambda *args: calls.append(("transport", aid)))
    town.agents.say(aid, "queued message", "queue", origin="papertown")
    assert calls == []
    hosted.hook(aid, provider, event)
    assert calls == [("turn", aid), ("before", aid), ("transport", aid)]
    hosted.hook(aid, provider, event)
    hosted.hook(aid, provider, event)
    assert calls.count(("turn", aid)) == 2


def test_paseo_and_pi_turn_boundaries_and_dispatch_basis(project, monkeypatch):
    _, town, lid, coder, _ = project
    aid = coder["id"]
    town.db.update("agents", {"id": aid}, runtime="paseo", status="working", ext_id="local-test")
    agent = town.agents
    lead = agent.ensure(lid, "lead")
    calls = []
    monkeypatch.setattr(town.prov, "employee", lambda a, trigger: calls.append((trigger, a.get("session_id"))))
    monkeypatch.setattr(agent.paseo, "send", lambda *a, **k: calls.append(("transport", a[0])))
    town.leads.deliver(lead, agent.get(aid), "compare metrics", basis=["D1"])
    assert not calls
    snap = {"id":"local-test", "status":"idle", "session_id":"real-session", "provider":"test"}
    agent._apply_snapshot(agent.get(aid), snap)
    assert calls == [("turn","real-session"),("before","real-session"),("transport","local-test")]
    assert town.prov._credit(lid, "code", town.prov.roots(lid), agent.get(aid))["basis"] == ["D1"]
    town.db.update("agents", {"id": aid}, runtime="pi", status="idle")
    calls.clear()
    agent.ingest(aid, [{"t":"state","session":{"id":"pi-session"}},{"t":"before"},{"t":"start"},{"t":"settled"},{"t":"settled"}])
    assert calls == [("before","pi-session"),("turn","pi-session")]


def test_registration_collisions_and_rollback(project):
    _, town, lid, coder, _ = project
    p, root = town.prov, Path(coder["cwd"])
    for name in ("one", "two", "three"):
        (root / name).write_text("same content")
    a = p.add(lid, coder, "one")
    b = p.add(lid, coder, "two")
    assert len(a["tag"]) == 7 and len(b["tag"]) == 8 and b["tag"].startswith(a["tag"])
    with pytest.raises(ProvError):
        p.add(lid, coder, "three", ["two", "paper/no.tex:1"])
    assert town.db.val("select count(*) from prov where line_id = ?", lid) == 2


def test_no_duplicate_job_outputs_on_recovery_and_job_without_file(project, monkeypatch):
    _, town, lid, coder, _ = project
    p = town.prov
    j = town.farm.submit(lid, "stdout", """echo 'RESULT {"score": 3.5}'""", submitted_by=coder["id"])
    wait_for(lambda: town.farm.get(j["id"])["status"] == "done")
    (Path(coder["cwd"]) / "table.csv").write_text("score\n")
    table = p.add(lid, coder, "table.csv", ["job:" + j["id"]], how="mean")
    result = p.analysis(lid).detail(table["src"][0])
    assert result["then"] == result["now"] and '"score": 3.5' in result["then"]
    assert result["made"]["job"]["op"] == j["op"] and not result["gaps"]
    p.finish_job(town.farm.get(j["id"])).result()
    assert len(p.analysis(lid).nodes) == 2


def test_bulk_snapshot_and_literal_pointer_are_lossless(project):
    _, town, lid, coder, _ = project
    p = town.prov
    root = Path(coder["cwd"])
    town.s.prov_file_bytes = 120
    for n in range(600):
        (root / f"file-{n}.txt").write_text(f"file number {n}\n")
    data = b"x" * 256
    digest = hashlib.sha1(b"blob 256\0" + data).hexdigest()
    pointer = f"Papertown large file\nsize 256\nblob {digest}\n".encode()
    (root / "large").write_bytes(data)
    (root / "literal").write_bytes(pointer)
    p.snap(lid)
    large = p.add(lid, coder, "large")
    literal = p.add(lid, coder, "literal")
    assert large["blob"] == digest and literal["blob"] == hashlib.sha1(f"blob {len(pointer)}\0".encode() + pointer).hexdigest()
    assert p.analysis(lid).detail(literal["tag"])["then"] == pointer.decode()
    assert p.analysis(lid).detail(large["tag"])["then"] == f"256 bytes · {digest}"
    assert p.analysis(lid).blame("code", "large") == []
    assert p.analysis(lid).blame("code", "literal")[0]["end"] == 3
    assert p.repo(lid, "code").git("cat-file", "blob", large["op"] + ":file-599.txt") == b"file number 599\n"
    (root / "large").write_bytes(pointer)
    p.snap(lid)
    assert p.analysis(lid).detail(large["tag"])["state"] == "changed"


def test_external_git_directory_and_renamed_baseline_file(project, tmp_path):
    _, town, lid, _, _ = project
    root = tmp_path / "work"
    original = checkout(root, {"旧稿.tex": "unchanged line\n"})
    separate = tmp_path / "separate-git-dir"
    (root / ".git").rename(separate)
    (root / ".git").write_text(f"gitdir: {separate}\n")
    town.db.update("lines", {"id": lid}, linked={"paper": str(root)})
    git_before = fingerprint(separate)
    town.prov.snap(lid)
    (root / "旧稿.tex").rename(root / "新稿.tex")
    town.prov.snap(lid)
    group, = town.prov.analysis(lid).blame("paper", "新稿.tex")
    assert group["commit"] == original and group["author"] == "Test Author"
    assert fingerprint(separate) == git_before
