import shutil

from papertown.config import SERVER_DIR
from papertown.tools import ToolCtx


def test_catalog_is_name_and_description_only(town):
    hatcher = [s.name for s in town.skills.for_role("hatcher")]
    assert hatcher == ["novelty-check"]
    sk = town.skills.get("novelty-check")
    assert "library_search" in sk.allowed and "run_script(verdict.py)" in sk.allowed
    assert sk.files("references") == ["references/novelty-rubric.md"]


def test_references_need_the_skill_loaded_first(town):
    ctx = ToolCtx(town)
    _, _, err = town.tools.call(ctx, "read_reference", {"skill": "novelty-check", "path": "references/novelty-rubric.md"})
    assert err
    content, _, err = town.tools.call(ctx, "load_skill", {"name": "novelty-check"})
    assert not err and "verdict.py" in content
    content, _, err = town.tools.call(ctx, "read_reference", {"skill": "novelty-check", "path": "references/novelty-rubric.md"})
    assert not err and "已被做过" in content
    _, _, err = town.tools.call(ctx, "read_reference", {"skill": "novelty-check", "path": "../../pyproject.toml"})
    assert err


def test_verdict_script_is_deterministic(town):
    out = town.skills.run_script("novelty-check", "verdict.py", {"candidates": [
        {"id": "a", "title": "A", "similarity": 0.9}, {"id": "b", "title": "B", "similarity": 0.2}], "method": "coverage"})
    assert out["verdict"] == "已被做过" and out["ranked"][0]["id"] == "a"
    out = town.skills.run_script("novelty-check", "verdict.py", {"candidates": [], "method": "coverage"})
    assert out["verdict"] == "可孵化"


def test_hot_plug(town):
    before = {s.name for s in town.skills.for_role("reviewer")}
    shutil.copytree(SERVER_DIR / "skills-extra" / "reproducibility-check", town.s.skills_dir / "reproducibility-check")
    added, removed = town.skills.refresh()
    assert added == ["reproducibility-check"] and not removed
    assert {s.name for s in town.skills.for_role("reviewer")} == before | {"reproducibility-check"}
