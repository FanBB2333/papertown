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


def test_decided_raise_said_and_basis_arguments(pt):
    cli, calls = pt
    cli.main(["decided"])
    assert calls.pop() == ("/decided", None)
    cli.main(["raise", "按什么分组？", "--mod", "exp", "--fact", "甲", "--fact", "乙", "--option", "按时间",
              "--material", "paper:arxiv:1234", "--material", "file:code/a.csv"])
    assert calls.pop() == ("/raise", {"question": "按什么分组？", "mod": "exp", "facts": ["甲", "乙"], "options": ["按时间"],
                                     "materials": [{"kind": "paper", "ref": "arxiv:1234"}, {"kind": "file", "ref": "code/a.csv"}]})
    cli.main(["said", "保留原文", "--mod", "data"])
    assert calls.pop() == ("/said", {"text": "保留原文", "mod": "data"})
    cli.main(["submit", "实验", "--by", "D5", "--by", "#t4", "--", "run", "--by", "cli"])
    assert calls.pop() == ("/jobs", {"name": "实验", "command": "run --by cli", "backend": "local", "basis": ["D5", "#t4"]})
    cli.main(["tell", "coder", "运行评测", "--by", "D5", "--now"])
    assert calls.pop() == ("/tell", {"to": "coder", "text": "运行评测", "now": True, "basis": ["D5"]})
