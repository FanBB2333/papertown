import json
import stat

import pytest

from papertown.db import read_json, write_json


@pytest.mark.parametrize("payload", [None, b"{broken", b"null", b"42", b'"text"', b"\xff"])
def test_invalid_persisted_json_uses_the_callers_default(tmp_path, payload):
    path = tmp_path / "state.json"
    if payload is not None:
        path.write_bytes(payload)
    assert read_json(path, {}) == {}
    assert read_json(path, []) == []


def test_json_container_shape_and_on_disk_format_are_preserved(tmp_path):
    path = tmp_path / "state.json"
    for value in ({"text": "中文", "rows": [1, 2]}, [{"text": "中文"}]):
        write_json(path, value)
        assert path.read_text() == json.dumps(value, ensure_ascii=False, indent=1) + "\n"
        assert read_json(path, type(value)()) == value
        assert read_json(path, [] if isinstance(value, dict) else {}) == ([] if isinstance(value, dict) else {})
        assert not path.with_suffix(".tmp").exists()


def test_private_json_replacement_and_failed_write(tmp_path):
    path = tmp_path / "auth.json"
    path.write_text('{"previous": true}')
    path.chmod(0o644)
    write_json(path, {"sessions": []}, mode=0o600)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    before = path.read_bytes()
    with pytest.raises(TypeError):
        write_json(path, {"invalid": object()}, mode=0o600)
    assert path.read_bytes() == before
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
