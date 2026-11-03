import pytest

from papertown.paseo_models import ModelError


def model(mid, thinking=("low", "high", "xhigh")):
    return {"id": mid, "name": mid.upper(), "thinking": list(thinking), "default_thinking": thinking[-1]}


def test_defaults_are_chosen_from_paseo_and_new_models_are_news(town, monkeypatch):
    rows = [{"id": "codex", "label": "Codex", "models": [model("gpt-6.1-terra"), model("gpt-6.1-sol")]},
            {"id": "claude", "label": "Claude", "models": []}]  # still loading: nothing listed
    monkeypatch.setattr(town.agents.paseo, "providers", lambda fresh=False: rows)
    m = town.paseo_models

    # until one is chosen, the environment's setting
    assert m.default("lead") == town.s.paseo_default("lead") and not m.defaults()["lead"]["set"]

    assert m.learn(rows) == [] and m.news() == []  # the first reading only learns
    rows[0]["models"].append(model("gpt-6.2-terra"))
    rows[1]["models"] = [model("claude-opus-5-5", ("high",))]  # a provider's first models are learned quietly
    added = m.learn(rows)
    assert [n["key"] for n in added] == ["codex/gpt-6.2-terra"] and added[0]["label"] == "Codex"
    assert m.learn(rows) == [] and [n["key"] for n in m.news()] == ["codex/gpt-6.2-terra"]  # news once
    rows[1]["models"].append(model("claude-opus-5-6", ("high",)))
    assert [n["key"] for n in m.learn(rows)] == ["claude/claude-opus-5-6"]

    d = m.set_default("lead", "codex", "gpt-6.2-terra", "xhigh")
    assert d["lead"] == {"provider": "codex", "model": "gpt-6.2-terra", "thinking": "xhigh", "set": True}
    assert m.default("lead")["model"] == "gpt-6.2-terra" and m.default("assistant") == town.s.paseo_default("assistant")
    for bad in [("lead", "nope"), ("lead", "codex", "gpt-9"), ("lead", "codex", "gpt-6.1-sol", "ultra"), ("coder", "codex")]:
        with pytest.raises(ModelError):
            m.set_default(*bad)
    assert m.set_default("lead", None)["lead"]["set"] is False  # back to the environment's

    assert [n["key"] for n in m.dismiss(["codex/gpt-6.2-terra"])] == ["claude/claude-opus-5-6"]
    assert m.dismiss() == [] and m.news() == []
