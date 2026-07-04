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
from core.character_manager import CharacterSheet
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


async def test_display_name_prefers_active_character_with_nickname_in_parens_when_they_differ() -> None:
    # FIX 3 (playtest feedback): the room should see who a player IS in the
    # fiction, not just their platform handle -- so once a character exists,
    # the echoed/attributed turn name leads with the character's name and
    # keeps the differing nickname alongside it in parens.
    hub = RoomHub()
    services = _services(_kp_rolls_then_replies)
    toolset = build_kp_toolset(services)
    router = CommandRouter(services)

    ws_member = RecordingWsMember(member_id="term-2", name="Dirac")
    await hub.subscribe("R2", ws_member)
    ws_member.events.clear()

    ctx = AgentCtx(chat_key="R2", user_id=ws_member.id, platform="tui", locale="en")
    await services.characters.save_character(ctx.uid(), ctx.chat_key, CharacterSheet(name="Nora Vance", system="CoC"))

    seed_dice(7)
    await run_turn(
        hub,
        services,
        ctx,
        "I search the room",
        command_router=router,
        toolset=toolset,
        censor=Censor(),
        origin=ws_member,
        echo_exclude=None,
    )

    echo = next(e for e in ws_member.events if e.kind == "player_action")
    assert echo.name == "Nora Vance (Dirac)"


async def test_echoed_name_after_coc_command_creation_matches_what_state_reports() -> None:
    # BUG C (playtest feedback): a character created via the `.coc`/`.dnd` command must make the
    # NEXT turn's `player_action` echo lead with the character's name (matching `net.state`'s
    # `state.character`/`party[].active`), not fall back to the bare platform nickname.
    hub = RoomHub()
    services = _services(_kp_rolls_then_replies)
    toolset = build_kp_toolset(services)
    router = CommandRouter(services)

    ws_member = RecordingWsMember(member_id="term-coc", name="Dirac")
    await hub.subscribe("R-coc", ws_member)

    ctx = AgentCtx(chat_key="R-coc", user_id=ws_member.id, platform="tui", locale="en")

    # 1) Create the character through the real `.coc` command turn (not a direct `save_character`
    #    seed) -- this is `cmd_make_char` under `gateway.commands.CommandRouter`.
    await run_turn(
        hub, services, ctx, ".coc Rust", command_router=router, toolset=toolset, origin=ws_member, echo_exclude=None
    )
    ws_member.events.clear()

    # 2) A SEPARATE, later player turn: the echo must already reflect the active character.
    seed_dice(7)
    await run_turn(
        hub,
        services,
        ctx,
        "I search the room",
        command_router=router,
        toolset=toolset,
        censor=Censor(),
        origin=ws_member,
        echo_exclude=None,
    )

    echo = next(e for e in ws_member.events if e.kind == "player_action")
    state = next(e for e in ws_member.events if e.kind == "state")
    assert state.data["character"]["name"] == "Rust"  # what net.state reports for this caller
    assert echo.name == "Rust (Dirac)"  # the echo must agree with it, not just show "Dirac"


async def test_display_name_omits_parens_when_nickname_matches_character_name() -> None:
    # When the nickname and the character name happen to be the same string,
    # the echoed name is just that one name -- no redundant "X (X)".
    hub = RoomHub()
    services = _services(_kp_rolls_then_replies)
    toolset = build_kp_toolset(services)
    router = CommandRouter(services)

    ws_member = RecordingWsMember(member_id="term-3", name="Nora Vance")
    await hub.subscribe("R3", ws_member)
    ws_member.events.clear()

    ctx = AgentCtx(chat_key="R3", user_id=ws_member.id, platform="tui", locale="en")
    await services.characters.save_character(ctx.uid(), ctx.chat_key, CharacterSheet(name="Nora Vance", system="CoC"))

    seed_dice(7)
    await run_turn(
        hub,
        services,
        ctx,
        "I search the room",
        command_router=router,
        toolset=toolset,
        censor=Censor(),
        origin=ws_member,
        echo_exclude=None,
    )

    echo = next(e for e in ws_member.events if e.kind == "player_action")
    assert echo.name == "Nora Vance"


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


async def test_private_reply_command_reaches_only_origin_not_other_room_members() -> None:
    # `.model key` echoes the (masked) API key -- a `private_reply` command
    # (gateway.commands.CommandSpec.private_reply). `run_turn` must deliver its
    # reply ONLY to the invoking connection (unicast via `Member.deliver`), never
    # `hub.publish` it to the rest of the room.
    hub = RoomHub()
    services = _services(_kp_rolls_then_replies)
    toolset = build_kp_toolset(services)
    router = CommandRouter(services)

    adapter = FakeAdapter()
    chat_source = SessionSource(
        platform="discord", chat_type="group", chat_id="c-priv", user_id="u-priv", user_name="Nora", message_id="m-priv"
    )
    chat_member = AdapterMember(adapter, chat_source, "R-priv", locale="en")
    origin_member = RecordingWsMember(member_id="term-priv", name="Keeper")
    bystander_member = RecordingWsMember(member_id="term-bystander", name="Bystander")
    await hub.subscribe("R-priv", chat_member)
    await hub.subscribe("R-priv", origin_member)
    await hub.subscribe("R-priv", bystander_member)
    origin_member.events.clear()
    bystander_member.events.clear()
    adapter.sends.clear()

    # `platform="cli"` is always master (`_AUTO_MASTER_PLATFORMS`) AND a "local"
    # channel (`_ROOM_LOCAL_PLATFORMS`) -- the two gates `.model key` requires.
    ctx = AgentCtx(chat_key="R-priv", user_id="cli:keeper", platform="cli", locale="en")
    await run_turn(
        hub,
        services,
        ctx,
        ".model key sk-supersecret-value-9999",
        command_router=router,
        toolset=toolset,
        censor=Censor(),
        origin=origin_member,
        echo_exclude=None,
    )

    # The masked-key reply reached the origin connection...
    origin_replies = [e for e in origin_member.events if e.kind == "narrative" and e.speaker == "system"]
    assert any("sk-s...9999" in e.text for e in origin_replies)
    # ...and reached NEITHER the other terminal member NOR the chat channel.
    assert all(e.kind != "narrative" or e.speaker != "system" for e in bystander_member.events)
    assert all("sk-s...9999" not in text for text in adapter.texts)
    assert adapter.sends == []


async def test_normal_command_reply_still_broadcasts_to_every_room_member() -> None:
    # Sanity/contrast: a command WITHOUT `private_reply` set (e.g. `.roll`) keeps
    # broadcasting its reply to every member of the room, as before this fix.
    hub = RoomHub()
    services = _services(_kp_rolls_then_replies)
    toolset = build_kp_toolset(services)
    router = CommandRouter(services)

    adapter = FakeAdapter()
    chat_source = SessionSource(
        platform="discord", chat_type="group", chat_id="c-pub", user_id="u-pub", user_name="Nora", message_id="m-pub"
    )
    chat_member = AdapterMember(adapter, chat_source, "R-pub", locale="en")
    origin_member = RecordingWsMember(member_id="term-pub")
    bystander_member = RecordingWsMember(member_id="term-pub-2", name="Bystander")
    await hub.subscribe("R-pub", chat_member)
    await hub.subscribe("R-pub", origin_member)
    await hub.subscribe("R-pub", bystander_member)
    origin_member.events.clear()
    bystander_member.events.clear()
    adapter.sends.clear()

    ctx = AgentCtx(chat_key="R-pub", user_id="cli:keeper", platform="cli", locale="en")
    seed_dice(7)
    await run_turn(
        hub,
        services,
        ctx,
        ".r 1d20",
        command_router=router,
        toolset=toolset,
        censor=Censor(),
        origin=origin_member,
        echo_exclude=None,
    )

    origin_reply = next(e for e in origin_member.events if e.kind == "narrative" and e.speaker == "system")
    bystander_reply = next(e for e in bystander_member.events if e.kind == "narrative" and e.speaker == "system")
    assert origin_reply.text == bystander_reply.text
    assert origin_reply.text in adapter.texts


class _BoomToolset:
    """A toolset whose only tool always raises — stands in for an adversarial turn.

    Mirrors `agent.tools.Toolset`'s duck-typed interface, including the Layer
    B.2 `unlocked` parameter `agent.loop.run_kp_turn` now passes to both
    `schemas()` and `dispatch()` (unused here — this fixture has no gated tools).
    """

    def schemas(self, unlocked: set[str] | None = None) -> list[dict]:
        return [
            {
                "type": "function",
                "function": {"name": "boom", "description": "x", "parameters": {"type": "object", "properties": {}}},
            }
        ]

    def is_keeper_only(self, name: str) -> bool:
        return False

    async def dispatch(self, name, ctx, args, unlocked: set[str] | None = None) -> str:
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
