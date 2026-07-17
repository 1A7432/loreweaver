from types import SimpleNamespace

import pytest

import app
from adapters.discord import adapter as discord_adapter
from app import _build_platform_adapters, _platform_config
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


def test_onebot_factory_builds_forward_websocket_transport(tmp_path) -> None:
    store = Store()
    settings = Settings(
        _env_file=None,
        data_dir=str(tmp_path),
        onebot={"mode": "forward", "ws_url": "ws://127.0.0.1:3001", "access_token": "secret"},
    )
    services = SimpleNamespace(settings=settings, store=store)

    adapters = _build_platform_adapters("onebot", get_i18n("en"), services, SimpleNamespace())

    assert len(adapters) == 1
    assert adapters[0]._transport.url == "ws://127.0.0.1:3001"
    assert adapters[0]._transport.access_token == "secret"


def test_onebot_configuration_requires_a_valid_endpoint() -> None:
    missing_forward = Settings(_env_file=None, onebot={"mode": "forward"})
    invalid_reverse = Settings(_env_file=None, onebot={"mode": "reverse", "listen_port": 70000})
    reverse = Settings(_env_file=None, onebot={"mode": "reverse", "listen_port": 6700})

    assert _platform_config("onebot", missing_forward) is None
    assert _platform_config("onebot", invalid_reverse) is None
    assert _platform_config("onebot", reverse) is reverse.onebot


@pytest.mark.parametrize(
    "ws_url",
    [
        "not-a-url",
        "https://example.test/ws",
        "ftp://example.test/ws",
        "ws://",
        "ws://bad host",
        "ws://example.test/path#fragment",
    ],
)
def test_onebot_forward_rejects_invalid_websocket_urls(ws_url: str) -> None:
    settings = Settings(_env_file=None, onebot={"mode": "forward", "ws_url": ws_url})

    assert _platform_config("onebot", settings) is None


@pytest.mark.parametrize(
    "values",
    [
        {"request_timeout": 0},
        {"request_timeout": float("nan")},
        {"request_timeout": float("inf")},
        {"reconnect_delay": -1},
        {"reconnect_delay": float("nan")},
    ],
)
def test_onebot_forward_rejects_invalid_timing_values(values: dict) -> None:
    settings = Settings(
        _env_file=None,
        onebot={"mode": "forward", "ws_url": "ws://127.0.0.1:3001", **values},
    )

    assert _platform_config("onebot", settings) is None


@pytest.mark.parametrize("host", ["0.0.0.0", "::", "192.0.2.10", "example.test"])
def test_onebot_reverse_requires_authentication_off_loopback(host: str) -> None:
    unauthenticated = Settings(
        _env_file=None,
        onebot={"mode": "reverse", "listen_host": host, "listen_port": 6700},
    )
    authenticated = Settings(
        _env_file=None,
        onebot={
            "mode": "reverse",
            "listen_host": host,
            "listen_port": 6700,
            "access_token": "secret",
        },
    )

    assert _platform_config("onebot", unauthenticated) is None
    assert _platform_config("onebot", authenticated) is authenticated.onebot


@pytest.mark.parametrize("host", ["127.0.0.1", "127.1.2.3", "::1", "localhost"])
def test_onebot_reverse_allows_unauthenticated_loopback(host: str) -> None:
    settings = Settings(
        _env_file=None,
        onebot={"mode": "reverse", "listen_host": host, "listen_port": 6700},
    )

    assert _platform_config("onebot", settings) is settings.onebot


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
