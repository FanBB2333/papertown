import shutil
import time
from pathlib import Path

import pytest

from papertown.config import SERVER_DIR, Settings
from papertown.town import Town


def make_settings(tmp: Path, **kw) -> Settings:
    """Mock settings under tmp: tests never start a real pi or touch Paseo, nor read your agents' conversations."""
    skills = tmp / "skills"
    if not skills.exists():
        shutil.copytree(SERVER_DIR / "skills", skills)
    base = dict(provider="mock", data_dir=tmp / "var", skills_dir=skills, arxiv_port=False, sim_gpu_seconds=0.05,
                compile_tex=False, samples=False, pi_bin=str(tmp / "no-pi"), nvidb_bin=str(tmp / "no-nvidb"), skim_bin=str(tmp / "no-skim"),
                tmux_bin=str(tmp / "no-tmux"),
                claude_bin=str(tmp / "no-claude-bin"), codex_bin=str(tmp / "no-codex-bin"),
                paseo_bin=str(tmp / "no-paseo"), paseo_url="http://127.0.0.1:9",
                claude_home=str(tmp / "no-claude"), codex_home=str(tmp / "no-codex"),
                antigravity_home=str(tmp / "no-antigravity"), agy_bin=str(tmp / "no-agy"), usage_poll=0,
                herdr_socket=str(tmp / "no-herdr.sock"))
    return Settings(**(base | kw))


@pytest.fixture
def town(tmp_path):
    t = Town(make_settings(tmp_path))
    t.start()
    yield t
    t.stop()


def wait_for(town: Town, line_id: str, until: set[str], timeout: float = 60) -> dict:
    t0 = time.time()
    while time.time() - t0 < timeout:
        ln = town.pipeline.line(line_id)
        if ln["status"] in until and not town.pipeline.running(line_id):
            return ln
        time.sleep(0.05)
    raise TimeoutError(f"{line_id} stuck at {town.pipeline.line(line_id)['status']}")
