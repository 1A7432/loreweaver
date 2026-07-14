"""`GatewayRunner`'s anti-bot-loop pre-LLM gate must actually engage.

Regression: `gateway.ops.Botlist.add` had no production caller anywhere in the
codebase, so `GatewayRunner.botlist` was permanently empty and `.is_bot` never
returned True for anything an admin tried to block -- the "known bot ids"
half of the anti-loop guard (`docs/specs/M2.md` §7) never actually engaged.

This proves both halves of the gate that now cover it end-to-end:
1. `SessionSource.is_bot` (a platform's own author-is-a-bot flag, e.g. Discord's
   `author.bot` -- see `adapters/discord/adapter.py`) short-circuits on its own.
2. `gateway.commands.CommandRouter.cmd_botlist` (the `.botlist add` command)
   populates the SAME `Botlist` instance `on_inbound` consults, which now
   catches the platforms whose adapter does not set `is_bot` at all (Telegram,
   Feishu, QQ-OneBot) -- the scenario the M2 spec's "ignore known bot ids"
   design was written for.
"""

from __future__ import annotations

from agent.services import build_services
from gateway.commands import CommandRouter
from gateway.events import InboundMessage
from gateway.runner import GatewayRunner
from gateway.session import SessionSource
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, assistant_text


def _services():
    return build_services(
        Settings(locale="en"),
        llm=FakeLLM(script=[assistant_text("A reply from the Keeper.") for _ in range(3)]),
        embeddings=FakeEmbeddings(64),
    )


async def test_runner_botlist_is_the_same_instance_the_router_mutates() -> None:
    """No divergence: `.botlist add` and the runner's gate must read one Botlist,
    not two independently-mutated copies (see `gateway.runner.GatewayRunner.__init__`)."""
    services = _services()
    router = CommandRouter(services)
    runner = GatewayRunner(services, command_router=router)

    assert runner.botlist is router.botlist


async def test_runner_ignores_sender_with_platform_native_bot_flag() -> None:
    services = _services()
    runner = GatewayRunner(services, command_router=CommandRouter(services))
    source = SessionSource(
        platform="discord", chat_type="dm", chat_id="c-1", user_id="other-bot", is_bot=True
    )

    reply = await runner.on_inbound(InboundMessage(source=source, text="hello"))

    assert reply is None  # never reaches the LLM


async def test_runner_botlist_add_command_makes_gate_ignore_that_sender() -> None:
    services = _services()
    router = CommandRouter(services)
    runner = GatewayRunner(services, command_router=router)
    # telegram's adapter does not set `SessionSource.is_bot` (see
    # `adapters/telegram/adapter.py`), so before `.botlist add` a second bot
    # sharing this room looks like an ordinary player.
    peer_bot = SessionSource(platform="telegram", chat_type="dm", chat_id="c-2", user_id="peer-bot")

    before = await runner.on_inbound(InboundMessage(source=peer_bot, text="hello"))
    assert before is not None  # reached the KP turn -- not yet blocked

    admin = SessionSource(platform="cli", chat_type="dm", chat_id="c-admin", user_id="kp")
    admin_reply = await runner.on_inbound(
        InboundMessage(source=admin, text=f".botlist add {peer_bot.user_key()}")
    )
    assert admin_reply is not None
    assert peer_bot.user_key() in admin_reply.text
    assert runner.botlist.is_bot(peer_bot.user_key())

    after = await runner.on_inbound(InboundMessage(source=peer_bot, text="hello again"))
    assert after is None  # the SAME runtime Botlist now blocks it, pre-LLM
