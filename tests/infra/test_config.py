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


def test_platform_settings_use_nested_environment(monkeypatch):
    monkeypatch.setenv("TRPG_QQ__APP_ID", "qq-app")
    monkeypatch.setenv("TRPG_QQ__SECRET", "qq-secret")
    monkeypatch.setenv("TRPG_DISCORD__TOKEN", "discord-token")
    monkeypatch.setenv("TRPG_DISCORD__GUILD_ID", "123")
    monkeypatch.setenv("TRPG_DISCORD__FFMPEG", "/opt/ffmpeg")
    monkeypatch.setenv("TRPG_TELEGRAM__TOKEN", "telegram-token")
    monkeypatch.setenv("TRPG_FEISHU__APP_ID", "feishu-app")
    monkeypatch.setenv("TRPG_FEISHU__APP_SECRET", "feishu-secret")
    monkeypatch.setenv("TRPG_ONEBOT__MODE", "reverse")
    monkeypatch.setenv("TRPG_ONEBOT__LISTEN_HOST", "127.0.0.2")
    monkeypatch.setenv("TRPG_ONEBOT__LISTEN_PORT", "6700")
    monkeypatch.setenv("TRPG_ONEBOT__ACCESS_TOKEN", "onebot-token")

    settings = Settings(_env_file=None)

    assert settings.qq.app_id == "qq-app"
    assert settings.qq.secret == "qq-secret"
    assert settings.discord.token == "discord-token"
    assert settings.discord.guild_id == 123
    assert settings.discord.ffmpeg == "/opt/ffmpeg"
    assert settings.telegram.token == "telegram-token"
    assert settings.feishu.app_id == "feishu-app"
    assert settings.feishu.app_secret == "feishu-secret"
    assert settings.onebot.mode == "reverse"
    assert settings.onebot.listen_host == "127.0.0.2"
    assert settings.onebot.listen_port == 6700
    assert settings.onebot.access_token == "onebot-token"
