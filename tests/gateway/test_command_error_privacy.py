"""F16: a command reply that says NOTHING HAPPENED goes to whoever typed it.

From the 2026-08-07 session: the keeper's `.rule` error broadcast to the whole room,
listing every valid variant. The player read it, learned the console existed, and
started probing (`.dg`, `.rule1`). Not a secret leak — a channel violation that hands
players the operator surface.

The rule is about content, not severity: a reply reporting that the command did not
happen is feedback for its author. It also, unavoidably, advertises that the command
EXISTS, what it takes, and that it is privileged. A reply reporting something that DID
happen is table content and still broadcasts, exactly as before.
"""

from __future__ import annotations

from types import SimpleNamespace

from agent.context import AgentCtx
from agent.kp_tools import build_kp_toolset
from agent.services import build_services
from gateway.commands import CommandCtx, CommandReply, CommandRouter
from gateway.hub import Event, RoomHub
from gateway.turn import run_turn
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.i18n import get_i18n
from infra.llm import FakeLLM

ROOM = "tui:group:f16"


class _Member:
    transport = "tui"

    def __init__(self, member_id: str) -> None:
        self.id = member_id
        self.user_key = member_id
        self.name = member_id
        self.events: list[Event] = []

    async def deliver(self, event: Event) -> None:
        self.events.append(event)


class _ScriptedRouter:
    """A router that answers with one prepared reply, so the test is about ROUTING."""

    def __init__(self, reply: CommandReply) -> None:
        self._reply = reply

    def resolve(self, text: str, locale: str):
        return SimpleNamespace(canonical="rule", private_reply=False), text

    async def dispatch_reply(self, ctx: AgentCtx, text: str) -> CommandReply:
        return self._reply


def _services():
    return build_services(Settings(locale="en"), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))


def _texts(member: _Member) -> list[str]:
    return [event.text for event in member.events if event.kind == "narrative"]


async def _run(reply: CommandReply) -> tuple[_Member, _Member]:
    services = _services()
    hub = RoomHub()
    keeper, player = _Member("keeper"), _Member("player")
    await hub.subscribe(ROOM, keeper)
    await hub.subscribe(ROOM, player)
    ctx = AgentCtx(chat_key=ROOM, user_id="keeper", platform="tui", locale="en")
    await run_turn(
        hub,
        services,
        ctx,
        ".rule xipu_night",
        command_router=_ScriptedRouter(reply),
        toolset=build_kp_toolset(services),
        origin=keeper,
        actor_name="Keeper",
    )
    return keeper, player


async def test_a_failed_command_reply_reaches_only_the_caller():
    keeper, player = await _run(CommandReply("no such variant: xipu_night, dusk_tide", error=True))

    assert any("no such variant" in text for text in _texts(keeper))
    assert not any("no such variant" in text for text in _texts(player)), (
        "a failed command's reply must not tell the room the command exists or what it takes"
    )


async def test_a_successful_command_reply_still_reaches_the_room():
    # The other half of the contract: a house rule that CHANGED is table content.
    keeper, player = await _run(CommandReply("rule ladder is now: xipu_night"))

    assert any("xipu_night" in text for text in _texts(keeper))
    assert any("xipu_night" in text for text in _texts(player))


async def test_events_attached_to_a_failed_command_are_withheld_too():
    # A dice event riding a failed command would leak the same way the text does.
    reply = CommandReply("that roll was rejected", events=(Event.dice(actor="keeper", kind="roll", expr="1d6"),), error=True)
    keeper, player = await _run(reply)

    assert any(event.kind == "dice" for event in keeper.events)
    assert not any(event.kind == "dice" for event in player.events)


# --- the router's own failure paths ----------------------------------------


async def test_a_permission_denial_is_marked_failed_by_the_router():
    """Broadcasting "you may not do that" is the exact probe vector: it confirms the
    command exists AND that it is gated."""
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key=ROOM, user_id="player", platform="tui", locale="en")

    reply = await router.dispatch_reply(ctx, ".rule xipu_night")

    assert reply is not None and reply.error is True


async def test_an_oversized_argument_is_marked_failed():
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key=ROOM, user_id="keeper", platform="tui", locale="en")

    reply = await router.dispatch_reply(ctx, ".r " + "9" * 5000)

    assert reply is not None and reply.error is True


async def test_ctx_fail_marks_the_reply_and_returns_the_text_unchanged():
    """`fail()` is the handler-side marker: it must not alter what the caller reads."""
    ctx = CommandCtx(
        services=_services(),
        router=None,
        raw_ctx=None,
        spec=None,
        command="rule",
        args="",
        locale="en",
        i18n=get_i18n("en"),
    )

    assert ctx.failed is False
    assert ctx.fail("no such variant") == "no such variant"
    assert ctx.failed is True


async def test_a_successful_handler_leaves_the_reply_unmarked():
    services = _services()
    router = CommandRouter(services)
    ctx = AgentCtx(chat_key=ROOM, user_id="keeper", platform="tui", locale="en")

    reply = await router.dispatch_reply(ctx, ".rule")

    assert reply is not None and reply.error is False, "listing the variants is a normal answer"
