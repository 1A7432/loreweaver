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


def test_pointing_trpg_env_file_at_an_empty_file_ignores_a_checkouts_dot_env(tmp_path, monkeypatch):
    """The documented offline recipe for `--cli --script` inside a configured checkout
    (`docs/authoring.md` §8): `./.env` is read from the working directory by default, so a
    provider key there makes a "scripted" run call the real model; `TRPG_ENV_FILE=/dev/null`
    (any empty file) keeps it out. An EMPTY variable does not: it falls back to `./.env`."""
    for name in ("TRPG_LLM__API_KEY", "TRPG_LLM__PROVIDER"):
        monkeypatch.delenv(name, raising=False)
    (tmp_path / ".env").write_text("TRPG_LLM__API_KEY=sk-from-the-checkout\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    monkeypatch.setenv("TRPG_ENV_FILE", "")
    assert Settings().llm.api_key == "sk-from-the-checkout"

    monkeypatch.setenv("TRPG_ENV_FILE", "/dev/null")
    assert not Settings().llm.api_key
