import os
import shutil
import tempfile
import time
from pathlib import Path

import pytest

from papertown.config import SERVER_DIR, Settings
from papertown.town import Town

# tests never read your papertown.toml: the settings come from defaults, and each test's network settings are
# written to its own file under tmp (make_settings)
os.environ["PAPERTOWN_CONFIG"] = str(Path(tempfile.mkdtemp()) / "papertown.toml")


def make_settings(tmp: Path, **kw) -> Settings:
    """Isolated settings under tmp: tests never start a real pi or touch Paseo, nor read your agents' conversations."""
    skills = tmp / "skills"
    if not skills.exists():
        shutil.copytree(SERVER_DIR / "skills", skills)
    base = dict(config_file=tmp / "papertown.toml", lead_resident=False, data_dir=tmp / "var", skills_dir=skills, arxiv_port=False,
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

