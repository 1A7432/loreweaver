"""Two-layer `.help`: players see play verbs; keepers also see the operator line."""

from agent.context import AgentCtx
from agent.services import build_services
from gateway.commands import CommandRouter
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM


def _services():
    return build_services(Settings(), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))


def _player_ctx() -> AgentCtx:
    return AgentCtx(chat_key="tui:room:help", user_id="p1", platform="tui", locale="en", extra={"role": "player"})


def _keeper_ctx(*, locale: str = "en") -> AgentCtx:
    return AgentCtx(chat_key="cli:dm:help", user_id="k1", platform="cli", locale=locale)


_PLAYER_VERBS = (".roll", ".check", ".pc", ".recap", ".help")
_KEEPER_VERBS = (".dev", ".var", ".model", ".reset")


async def test_player_help_lists_play_verbs_and_hides_operator_surfaces():
    router = CommandRouter(_services())
    reply = await router.dispatch(_player_ctx(), ".help")
    assert reply is not None
    for verb in _PLAYER_VERBS:
        assert verb in reply
    for verb in _KEEPER_VERBS:
        assert verb not in reply
    assert "Keeper:" not in reply
    assert "The keeper has more commands for running the table." in reply


async def test_keeper_help_adds_operator_section():
    router = CommandRouter(_services())
    reply = await router.dispatch(_keeper_ctx(), ".help")
    assert reply is not None
    first, _, rest = reply.partition("\n")
    assert first.startswith("Commands:")
    for verb in _PLAYER_VERBS:
        assert verb in first
    assert "Keeper:" in rest
    for verb in _KEEPER_VERBS:
        assert verb in rest
    assert "The keeper has more commands for running the table." not in reply


async def test_cli_help_is_the_keeper_list():
    """`--cli` is `_AUTO_MASTER`; the operator line must still appear."""
    router = CommandRouter(_services())
    reply = await router.dispatch(_keeper_ctx(), ".help")
    assert reply is not None
    assert "Commands:" in reply
    assert "Keeper:" in reply


async def test_help_zh_uses_locale_labels():
    router = CommandRouter(_services())
    reply = await router.dispatch(_keeper_ctx(locale="zh"), ".help")
    assert reply is not None
    assert "命令：" in reply
    assert "守秘人：" in reply
    assert ".dev" in reply
