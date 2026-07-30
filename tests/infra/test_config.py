from infra.config import Settings


def test_settings_can_load_env_file_from_trpg_env_file(tmp_path, monkeypatch):
    monkeypatch.delenv("TRPG_LOCALE", raising=False)
    monkeypatch.delenv("TRPG_DATA_DIR", raising=False)
    env_file = tmp_path / "server.env"
    env_file.write_text("TRPG_LOCALE=zh\nTRPG_DATA_DIR=/srv/loreweaver-data\n", encoding="utf-8")
    monkeypatch.setenv("TRPG_ENV_FILE", str(env_file))

    settings = Settings()

    assert settings.locale == "zh"
    assert settings.data_dir == "/srv/loreweaver-data"


def test_explicit_env_file_overrides_trpg_env_file(tmp_path, monkeypatch):
    monkeypatch.delenv("TRPG_LOCALE", raising=False)
    env_file = tmp_path / "server.env"
    explicit = tmp_path / "explicit.env"
    env_file.write_text("TRPG_LOCALE=zh\n", encoding="utf-8")
    explicit.write_text("TRPG_LOCALE=en\n", encoding="utf-8")
    monkeypatch.setenv("TRPG_ENV_FILE", str(env_file))

    settings = Settings(_env_file=str(explicit))

    assert settings.locale == "en"
