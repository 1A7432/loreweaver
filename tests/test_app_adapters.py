from types import SimpleNamespace

import app
from adapters.discord import adapter as discord_adapter
from app import _build_platform_adapters
from infra.config import Settings
from infra.i18n import get_i18n
from infra.store import Store


def test_qq_factory_uses_the_application_store(tmp_path) -> None:
    store = Store()
    settings = Settings(
        _env_file=None,
        data_dir=str(tmp_path),
        qq={"app_id": "app", "secret": "secret"},
    )
    services = SimpleNamespace(settings=settings, store=store)
    router = SimpleNamespace()

    adapters = _build_platform_adapters("qq", get_i18n("en"), services, router)

    assert len(adapters) == 1
    assert adapters[0]._store is store
    assert adapters[0]._media_store._store is store


def test_discord_factory_receives_the_application_context(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(discord_adapter, "discord", SimpleNamespace())
    store = Store()
    settings = Settings(
        _env_file=None,
        data_dir=str(tmp_path),
        discord={"token": "token"},
    )
    services = SimpleNamespace(settings=settings, store=store)
    router = SimpleNamespace()

    adapters = _build_platform_adapters("discord", get_i18n("en"), services, router)

    assert len(adapters) == 1
    assert adapters[0].context.services is services
    assert adapters[0].context.command_router is router


async def test_combined_mode_uses_iroh_and_stops_adapters(monkeypatch) -> None:
    calls: list[str] = []

    class Runner:
        async def start(self) -> None:
            calls.append("start")

        async def stop(self) -> None:
            calls.append("stop")

    async def serve_iroh(server, i18n, keys_path):
        del server, i18n
        calls.append(f"iroh:{keys_path}")
        return True

    monkeypatch.setattr(app, "_serve_iroh", serve_iroh)

    result = await app._serve_combined(
        SimpleNamespace(),
        Runner(),
        get_i18n("en"),
        "keys.toml",
    )

    assert result is True
    assert calls == ["start", "iroh:keys.toml", "stop"]
