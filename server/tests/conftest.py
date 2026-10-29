import shutil
import time
from pathlib import Path

import pytest

from papertown.config import SERVER_DIR, Settings
from papertown.town import Town


def make_settings(tmp: Path, **kw) -> Settings:
    skills = tmp / "skills"
    if not skills.exists():
        shutil.copytree(SERVER_DIR / "skills", skills)
    base = dict(provider="mock", data_dir=tmp / "var", skills_dir=skills, arxiv_port=False, sim_gpu_seconds=0.05,
                compile_tex=False, pi_bin=str(tmp / "no-pi"))  # tests never start a real pi
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
