"""Headline cross-platform proof (M7 §7).

A chat player (a `FakeAdapter` wrapped as an `AdapterMember`) and a terminal
player (a recording WS-like member) sit in ONE shared `RoomHub` room. A turn
driven from either side fans out to both, each rendered natively — and no
keeper-only sentinel ever leaks onto either transport. The last test drives the
same flow through a real `GatewayRunner` (the chat entry point) to prove the
wiring, including that `.room` control replies stay scoped to the origin.
"""

from __future__ import annotations

import json

from agent.context import AgentCtx
from agent.kp_tools import build_kp_toolset
from agent.services import build_services
from core.dice_engine import seed_dice
from gateway.commands import CommandRouter
from gateway.events import InboundMessage
from gateway.hub import Event, RoomHub
from gateway.member import AdapterMember
from gateway.ops import Censor
from gateway.runner import GatewayRunner
from gateway.session import SessionSource
from gateway.turn import run_turn
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.i18n import get_i18n
from infra.llm import FakeLLM, assistant_text, assistant_tools, tool_call
from net.keystore import Keystore

SENTINEL = "KEEPER_ONLY_SENTINEL_TRUTH"
KP_REPLY = "A brass key glints beneath the floorboards where you searched."


class FakeAdapter:
    """A minimal chat adapter that records every `.send` (stands in for Discord)."""

    platform = "discord"

    def __init__(self) -> None:
        self.sends: list[tuple] = []

    def supports_proactive(self, source) -> bool:
        return True

    async def send(self, source, content, *, reply_to=None):
        self.sends.append((source, content, reply_to))
        return None

    @property
    def texts(self) -> list[str]:
        return [content for _source, content, _reply in self.sends]


class RecordingWsMember:
    """A fake terminal (`WsMember`-like) hub member that records its deliveries."""

    transport = "tui"

    def __init__(self, member_id: str = "term-1", name: str = "Sam") -> None:
        self.id = member_id
        self.user_key = f"tui:{member_id}"
        self.name = name
        self.events: list[Event] = []

    def supports_proactive(self) -> bool:
        return True

    async def deliver(self, event: Event) -> None:
        self.events.append(event)


def _services(responder):
    return build_services(Settings(locale="en"), llm=FakeLLM(responder=responder), embeddings=FakeEmbeddings(64))


def _kp_rolls_then_replies(messages, tools):
    """A KP turn that rolls a die once (producing a `dice` event) then narrates."""
    already_rolled = any(message.get("role") == "tool" for message in messages)
    if not already_rolled:
        return assistant_tools(tool_call("roll_dice", expression="1d20", reason="searching the room"))
    return assistant_text(KP_REPLY)


async def _seed_keeper_sentinel(services, chat_key: str) -> None:
    await services.store.set(
        user_key="",
        store_key=f"module_keeper_pool.{chat_key}",
        value=json.dumps({"truths": [{"description": SENTINEL}]}),
    )


def _no_sentinel(event: Event) -> bool:
    return SENTINEL not in f"{event.text}{event.data}{event.name}"


async def test_chat_origin_turn_reaches_terminal_but_not_its_own_echo() -> None:
    hub = RoomHub()
    services = _services(_kp_rolls_then_replies)
    toolset = build_kp_toolset(services)
    router = CommandRouter(services)

    adapter = FakeAdapter()
    chat_source = SessionSource(
        platform="discord", chat_type="group", chat_id="c-1", user_id="u-1", user_name="Nora", message_id="m-1"
    )
    chat_member = AdapterMember(adapter, chat_source, "R", locale="en")
    ws_member = RecordingWsMember()

    await hub.subscribe("R", chat_member)
    await hub.subscribe("R", ws_member)
    ws_member.events.clear()
    adapter.sends.clear()
    await _seed_keeper_sentinel(services, "R")

    ctx = AgentCtx(chat_key="R", user_id="discord:u-1", platform="discord", locale="en")
    seed_dice(7)
    await run_turn(
        hub,
        services,
        ctx,
        "I search the room",
        command_router=router,
        toolset=toolset,
        censor=Censor(),
        origin=chat_member,
        echo_exclude=chat_member,
    )

    # The terminal SEES the chat player's turn: the player_action echo + the KP
    # narrative + the dice event all reached the WS member.
    kinds = [event.kind for event in ws_member.events]
    assert "player_action" in kinds
    assert "dice" in kinds
    assert any(e.kind == "narrative" and e.speaker == "kp" and e.text == KP_REPLY for e in ws_member.events)
    echo = next(e for e in ws_member.events if e.kind == "player_action")
    assert echo.name == "Nora" and echo.text == "I search the room"

    # The chat channel got the KP narrative + the dice one-liner...
    assert KP_REPLY in adapter.texts
    assert any("🎲" in text for text in adapter.texts)
    # ...but NOT its own player echo (origin excluded; player lines render to None).
    assert all("I search the room" not in text for text in adapter.texts)

    # No keeper sentinel leaked to either transport.
    assert all(_no_sentinel(event) for event in ws_member.events)
    assert all(SENTINEL not in text for text in adapter.texts)


async def test_terminal_origin_turn_reaches_the_chat_channel() -> None:
    hub = RoomHub()
    services = _services(_kp_rolls_then_replies)
    toolset = build_kp_toolset(services)
    router = CommandRouter(services)

    adapter = FakeAdapter()
    chat_source = SessionSource(
        platform="discord", chat_type="group", chat_id="c-2", user_id="u-2", user_name="Nora", message_id="m-2"
    )
    chat_member = AdapterMember(adapter, chat_source, "R", locale="en")
    ws_member = RecordingWsMember()
    await hub.subscribe("R", chat_member)
    await hub.subscribe("R", ws_member)
    adapter.sends.clear()

    ctx = AgentCtx(chat_key="R", user_id="tui:term-1", platform="tui", locale="en")
    seed_dice(7)
    # WS side drives the turn: echo_exclude=None (a solo terminal still sees its
    # own echo — the M4 behavior); origin is the terminal member.
    await run_turn(
        hub,
        services,
        ctx,
        "look under the floor",
        command_router=router,
        toolset=toolset,
        censor=Censor(),
        origin=ws_member,
        echo_exclude=None,
    )

    # The chat member's adapter.send received the rendered KP text (+ a dice line).
    assert KP_REPLY in adapter.texts
    assert any("🎲" in text for text in adapter.texts)
    # The raw player line never surfaces as a chat send.
    assert all("look under the floor" not in text for text in adapter.texts)


async def test_runner_hub_path_broadcasts_turn_and_keeps_room_reply_to_origin() -> None:
    hub = RoomHub()
    services = _services(_kp_rolls_then_replies)
    keystore = Keystore()
    router = CommandRouter(services, keystore=keystore, hub=hub)
    toolset = build_kp_toolset(services)
    adapter = FakeAdapter()
    runner = GatewayRunner(
        services, [adapter], command_router=router, toolset=toolset, hub=hub, keystore=keystore
    )

    source = SessionSource(
        platform="discord", chat_type="dm", chat_id="dm-1", user_id="u-9", user_name="Nora", message_id="m-9"
    )
    session_key = source.chat_key()  # unbound -> its own key
    ws_member = RecordingWsMember()
    await hub.subscribe(session_key, ws_member)
    ws_member.events.clear()
    adapter.sends.clear()

    seed_dice(7)
    reply = await runner.on_inbound(InboundMessage(source=source, text="I search the room", at_bot=True))
    assert reply is None  # the hub path delivers via the bus, not a return string

    assert any(e.kind == "narrative" and e.speaker == "kp" and e.text == KP_REPLY for e in ws_member.events)
    assert KP_REPLY in adapter.texts  # the chat channel received the KP text

    # A `.room` control command is intercepted before the turn: it replies to the
    # origin (a returned string) and publishes NOTHING to the room's members.
    ws_member.events.clear()
    adapter.sends.clear()
    room_reply = await runner.on_inbound(InboundMessage(source=source, text=".room open", at_bot=True))
    assert room_reply is not None and keystore.entries()[0].key in room_reply
    assert ws_member.events == []
    assert adapter.sends == []


class _BoomToolset:
    """A toolset whose only tool always raises — stands in for an adversarial turn."""

    def schemas(self) -> list[dict]:
        return [
            {
                "type": "function",
                "function": {"name": "boom", "description": "x", "parameters": {"type": "object", "properties": {}}},
            }
        ]

    def is_keeper_only(self, name: str) -> bool:
        return False

    async def dispatch(self, name, ctx, args) -> str:
        raise RuntimeError("tool blew up on adversarial args")


async def test_runner_inbound_turn_exception_yields_friendly_reply_not_crash() -> None:
    # Regression (#2): a KP turn/tool that raises must degrade to a localized error
    # reply, never propagate out of on_inbound — an unguarded raise would tear down the
    # adapter's listen loop and permanently disconnect the bot.
    def _calls_boom(messages, tools):
        return assistant_tools(tool_call("boom"))

    services = _services(_calls_boom)
    runner = GatewayRunner(services, adapters=[], hub=None, toolset=_BoomToolset())
    source = SessionSource(platform="cli", chat_type="dm", chat_id="local", user_id="p")

    reply = await runner.on_inbound(InboundMessage(source=source, text="do a thing", at_bot=True))

    assert reply == get_i18n("en").t("runner.error")
