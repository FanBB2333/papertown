from pathlib import Path

from papertown.config import REPO_DIR, Settings, example, set_config


def test_the_example_lists_every_setting_at_its_default():
    # after adding or changing a setting: uv run --frozen papertown config example > ../papertown.example.toml
    assert (REPO_DIR / "papertown.example.toml").read_text() == example()


def test_environment_then_file_then_default(tmp_path, monkeypatch):
    conf = tmp_path / "papertown.toml"
    conf.write_text('[server]\nport = 4242\ndata_dir = "data"\n\n[agents]\nlead_tick = 5\nlead_resident = false\n')
    monkeypatch.setenv("PAPERTOWN_CONFIG", str(conf))
    s = Settings()
    assert (s.port, s.lead_tick, s.lead_resident, s.url) == (4242, 5.0, False, "http://127.0.0.1:4242")
    assert s.data_dir == tmp_path / "data"  # relative to the file
    assert s.check_tick == 120.0  # not in the file: the default
    monkeypatch.setenv("PAPERTOWN_PORT", "5151")
    monkeypatch.setenv("PAPERTOWN_LEAD_RESIDENT", "1")
    assert (Settings().port, Settings().lead_resident) == (5151, True)


def test_writing_a_table_keeps_the_rest_of_the_file(tmp_path):
    conf = tmp_path / "papertown.toml"
    conf.write_text('# mine\n[server]\nport = 4242  # by hand\n\n[agents]\nlead_tick = 5\n')
    set_config("server", {"host": "0.0.0.0"}, conf)
    set_config("network", {"sources": ["tailscale"], "days": 7}, conf)
    text = conf.read_text()
    assert text.startswith("# mine\n[server]\nport = 4242  # by hand\nhost = \"0.0.0.0\"\n")
    assert "[agents]\nlead_tick = 5" in text and text.endswith('[network]\nsources = ["tailscale"]\ndays = 7\n')
    assert conf.stat().st_mode & 0o777 == 0o600
