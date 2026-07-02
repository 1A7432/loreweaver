"""The two production `Censor` instantiations must actually honor deployer
config (`infra.config.CensorSettings`), not silently ignore it.

Regression: `gateway.runner.GatewayRunner` and `net.tui_server.TuiServer`
both used to build a no-arg `Censor()`, which fell back to a hardcoded
placeholder wordlist -- so a deployer's `TRPG_CENSOR__*` config had no effect
at all. This proves both constructors wire `services.settings.censor`
through `gateway.ops.censor_from_settings`: a configured wordlist actually
masks/blocks, and the untouched default (empty) stays an explicit no-op.
"""

from __future__ import annotations

from agent.services import build_services
from gateway.commands import CommandRouter
from gateway.ops import Censor
from gateway.runner import GatewayRunner
from infra.config import CensorSettings, Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM
from net.keystore import Keystore
from net.tui_server import TuiServer


def _services(*, censor: CensorSettings | None = None):
    settings = Settings(locale="en", censor=censor or CensorSettings())
    return build_services(settings, llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))


def test_gateway_runner_default_censor_is_an_explicit_noop() -> None:
    services = _services()
    runner = GatewayRunner(services, command_router=CommandRouter(services))

    result = runner.censor.review("this mentions badword and nothing is configured")

    assert result.allowed
    assert result.hits == []
    assert result.cleaned == "this mentions badword and nothing is configured"


def test_gateway_runner_wires_configured_wordlist_from_settings() -> None:
    services = _services(censor=CensorSettings(wordlist="badword:5"))
    runner = GatewayRunner(services, command_router=CommandRouter(services))

    result = runner.censor.review("keep badword away")

    assert not result.allowed
    assert result.hits == ["badword"]


def test_gateway_runner_still_accepts_an_injected_censor_override() -> None:
    services = _services(censor=CensorSettings(wordlist="badword:5"))
    injected = Censor({"other": 5})
    runner = GatewayRunner(services, command_router=CommandRouter(services), censor=injected)

    assert runner.censor is injected
    assert runner.censor.review("badword is not in the injected list").allowed


def test_tui_server_default_censor_is_an_explicit_noop() -> None:
    services = _services()
    server = TuiServer(services, Keystore(), port=0)

    result = server.censor.review("this mentions badword and nothing is configured")

    assert result.allowed
    assert result.hits == []
    assert result.cleaned == "this mentions badword and nothing is configured"


def test_tui_server_wires_configured_wordlist_from_settings() -> None:
    services = _services(censor=CensorSettings(wordlist="badword:5"))
    server = TuiServer(services, Keystore(), port=0)

    result = server.censor.review("keep badword away")

    assert not result.allowed
    assert result.hits == ["badword"]


def test_tui_server_still_accepts_an_injected_censor_override() -> None:
    services = _services(censor=CensorSettings(wordlist="badword:5"))
    injected = Censor({"other": 5})
    server = TuiServer(services, Keystore(), port=0, censor=injected)

    assert server.censor is injected
    assert server.censor.review("badword is not in the injected list").allowed
