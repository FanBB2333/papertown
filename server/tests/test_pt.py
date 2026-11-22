import importlib.util
import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest


@pytest.fixture
def pt(monkeypatch):
    spec = importlib.util.spec_from_file_location("pt_cli", Path(__file__).parents[1] / "papertown/pi/pt.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    calls = []
    def call(path, body=None):
        calls.append((path, body))
        return {"text": "已记录"}
    monkeypatch.setattr(module, "call", call)
    return module, calls


def test_hire_and_stage_arguments(pt):
    cli, calls = pt
    cli.main(["hire", "coder", "--runtime", "tmux", "--cli", "codex", "--model", "test", "--thinking", "high"])
    assert calls.pop() == ("/hire", {"role": "coder", "runtime": "tmux", "provider": "codex", "model": "test", "thinking": "high"})
    cli.main(["stage"])
    assert calls.pop() == ("/stage", None)
    for status in ("run", "done", "todo"):
        cli.main(["stage", status, "method", "说明", "--pct", "42"])
        assert calls.pop() == ("/stage", {"stage": "method", "status": status, "note": "说明", "pct": 42})
    with pytest.raises(SystemExit):
        cli.main(["stage", "run", "exp", "--pct", "bad"])


def test_output_survey_and_library_arguments(pt, tmp_path):
    cli, calls = pt
    body = {"title": "T", "problem": "P"}
    cli.main(["output", "method", json.dumps(body)])
    assert calls.pop() == ("/output", {"stage": "method", "body": body})
    file = tmp_path / "output.json"
    file.write_text(json.dumps(body))
    cli.main(["output", "method", "@" + str(file)])
    assert calls.pop()[1]["body"] == body
    cli.main(["survey"])
    assert calls.pop() == ("/survey", None)
    cli.main(["library", "sparse attention", "--top", "3"])
    path, body = calls.pop()
    assert urlsplit(path).path == "/library" and body is None
    assert parse_qs(urlsplit(path).query) == {"q": ["sparse attention"], "top": ["3"]}
