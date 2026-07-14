"""Headline cross-platform proof (M7 §7).

A chat player (a `FakeAdapter` wrapped as an `AdapterMember`) and a terminal
player (a recording WS-like member) sit in ONE shared `RoomHub` room. A turn
driven from either side fans out to both, each rendered natively — and no
keeper-only sentinel ever leaks onto either transport. The last test drives the
same flow through a real `GatewayRunner` (the chat entry point) to prove the
wiring, including that `.room` control replies stay scoped to the origin.
"""

from __future__ import annotations

import asyncio
import json

from agent.context import AgentCtx
from agent.kp_tools import build_kp_toolset
from agent.services import build_services
from core.character_manager import CharacterSheet
from core.dice_engine import seed_dice
from gateway.chat import ChatAttachment, ChatCapabilities, ChatInteraction, ChatMessage
from gateway.commands import CommandRouter
from gateway.events import InboundMessage
from gateway.hub import Event, RoomHub
from gateway.member import AdapterMember
from gateway.ops import Censor, get_enabled_skills
from gateway.rooms import session_key_for_room, set_binding, set_keeper_binding
from gateway.runner import GatewayRunner
from gateway.session import SessionSource
from gateway.turn import publish_state, run_turn
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
    capabilities = ChatCapabilities(attachments=True)

    def __init__(self) -> None:
        self.sends: list[tuple] = []
        self.events: list[Event] = []
        self.fetches = 0

    def supports_private_reply(self, source) -> bool:
        return True

    async def fetch_attachment(self, attachment):
        self.fetches += 1
        return attachment.data or b""

    async def deliver_event(self, source, session_key, event, *, locale, media_store=None):
        from gateway.render_chat import render_chat_event
        from infra.i18n import get_i18n

        self.events.append(event)
        message = render_chat_event(event, get_i18n(locale))
        if message is not None:
            self.sends.append((source, message, None))
        return None

    @property
    def texts(self) -> list[str]:
        return [message.text for _source, message, _reply in self.sends]


class RecordingWsMember:
    """A fake terminal (`WsMember`-like) hub member that records its deliveries."""

    transport = "tui"

    def __init__(self, member_id: str = "term-1", name: str = "Sam") -> None:
        self.id = member_id
        self.user_key = f"tui:{member_id}"
        self.name = name
        self.events: list[Event] = []

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
    # A turn from another transport is attributed in the chat channel.
    assert any("Sam" in text and "look under the floor" in text for text in adapter.texts)


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


async def test_state_is_personalized_per_connection() -> None:
    hub = RoomHub()
    services = _services(_kp_rolls_then_replies)
    first = RecordingWsMember(member_id="alice", name="Alice")
    second = RecordingWsMember(member_id="bob", name="Bob")
    await hub.subscribe("R-state", first)
    await hub.subscribe("R-state", second)
    await services.characters.save_character("alice", "R-state", CharacterSheet(name="Nora", system="CoC"))
    await services.characters.save_character("bob", "R-state", CharacterSheet(name="Sam", system="CoC"))
    first.events.clear()
    second.events.clear()

    await publish_state(
        hub,
        services,
        AgentCtx(chat_key="R-state", user_id="alice", platform="tui", locale="en"),
    )

    first_state = next(event.data for event in first.events if event.kind == "state")
    second_state = next(event.data for event in second.events if event.kind == "state")
    assert first_state["character"]["name"] == "Nora"
    assert second_state["character"]["name"] == "Sam"
    assert first_state["online"] == second_state["online"] == 2


async def test_group_channel_tracks_players_without_exposing_last_speakers_sheet() -> None:
    hub = RoomHub()
    services = _services(_kp_rolls_then_replies)
    adapter = FakeAdapter()
    alice = SessionSource(
        platform="discord",
        chat_type="group",
        chat_id="shared-table",
        user_id="alice",
        user_name="Alice",
    )
    bob = SessionSource(
        platform="discord",
        chat_type="group",
        chat_id="shared-table",
        user_id="bob",
        user_name="Bob",
    )
    chat_member = AdapterMember(adapter, alice, "R-group", locale="en")
    chat_member.observe(bob)
    terminal = RecordingWsMember()
    await hub.subscribe("R-group", chat_member)
    await hub.subscribe("R-group", terminal)
    await services.characters.save_character(
        alice.user_key(), "R-group", CharacterSheet(name="Nora", system="CoC")
    )
    await services.characters.save_character(
        bob.user_key(), "R-group", CharacterSheet(name="Sam", system="CoC")
    )
    adapter.events.clear()
    terminal.events.clear()

    await publish_state(
        hub,
        services,
        AgentCtx(chat_key="R-group", user_id="term-1", platform="tui", locale="en"),
    )

    group_state = next(event.data for event in adapter.events if event.kind == "state")
    terminal_state = next(
        event.data for event in terminal.events if event.kind == "state"
    )
    assert "character" not in group_state
    assert group_state["online"] == terminal_state["online"] == 3


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
    await set_keeper_binding(services.store, "discord", "u-9", "keeper-room")
    await set_binding(services.store, source.chat_key(), session_key_for_room("keeper-room"))
    ws_member.events.clear()
    adapter.sends.clear()
    room_reply = await runner.on_inbound(InboundMessage(source=source, text=".room open", at_bot=True))
    assert isinstance(room_reply, ChatMessage)
    assert keystore.entries()[0].key in room_reply.text
    assert not any(event.kind in {"narrative", "system"} for event in ws_member.events)
    assert adapter.sends == []


async def test_quoted_text_is_part_of_the_shared_player_input() -> None:
    hub = RoomHub()
    services = _services(_kp_rolls_then_replies)
    adapter = FakeAdapter()
    runner = GatewayRunner(services, [adapter], hub=hub)
    source = SessionSource(
        platform="discord",
        chat_type="dm",
        chat_id="quoted-turn",
        user_id="player",
        user_name="Nora",
    )
    watcher = RecordingWsMember()
    await hub.subscribe(source.chat_key(), watcher)
    watcher.events.clear()

    await runner.on_inbound(
        InboundMessage(
            source=source,
            text="I inspect it again.",
            at_bot=True,
            quoted_text="The seal is already broken.",
        )
    )

    action = next(event for event in watcher.events if event.kind == "player_action")
    assert action.text == "> The seal is already broken.\n\nI inspect it again."


async def test_runner_resubscribes_a_cached_member_after_delivery_failure() -> None:
    hub = RoomHub()
    services = _services(_kp_rolls_then_replies)
    adapter = FakeAdapter()
    runner = GatewayRunner(services, [adapter], hub=hub)
    source = SessionSource(platform="discord", chat_type="dm", chat_id="dm-resub", user_id="u")
    session_key = source.chat_key()

    member = await runner._ensure_member(adapter, source, session_key, "en")
    hub.rooms[session_key].remove(member)
    reused = await runner._ensure_member(adapter, source, session_key, "en")

    assert reused is member
    assert member in hub.members(session_key)


async def test_explicit_command_works_before_a_group_enables_ambient_narration() -> None:
    hub = RoomHub()
    services = _services(_kp_rolls_then_replies)
    adapter = FakeAdapter()
    runner = GatewayRunner(services, [adapter], hub=hub)
    source = SessionSource(
        platform="discord",
        chat_type="group",
        chat_id="fresh-group",
        user_id="player",
    )

    reply = await runner.on_inbound(InboundMessage(source=source, text=".help", at_bot=True))

    assert reply is None
    assert adapter.texts


async def test_interaction_locale_is_the_initial_room_locale() -> None:
    hub = RoomHub()
    services = _services(_kp_rolls_then_replies)
    adapter = FakeAdapter()
    runner = GatewayRunner(services, [adapter], hub=hub)
    source = SessionSource(
        platform="discord",
        chat_type="group",
        chat_id="localized-group",
        user_id="player",
    )

    await runner.on_inbound(
        InboundMessage(
            source=source,
            text=".help",
            at_bot=True,
            interaction=ChatInteraction(id="interaction-1", locale="zh"),
        )
    )

    assert runner._members[source.chat_key()].locale == "zh"


async def test_saved_room_locale_overrides_interaction_locale() -> None:
    hub = RoomHub()
    services = _services(_kp_rolls_then_replies)
    adapter = FakeAdapter()
    runner = GatewayRunner(services, [adapter], hub=hub)
    source = SessionSource(
        platform="discord",
        chat_type="group",
        chat_id="saved-locale-group",
        user_id="player",
    )
    await services.store.set(
        user_key="",
        store_key=f"chat_locale.{source.chat_key()}",
        value="en",
    )

    await runner.on_inbound(
        InboundMessage(
            source=source,
            text=".help",
            at_bot=True,
            interaction=ChatInteraction(id="interaction-2", locale="zh"),
        )
    )

    assert runner._members[source.chat_key()].locale == "en"


async def test_private_keeper_command_is_rejected_before_mutation_on_qq_group() -> None:
    class QQAdapter(FakeAdapter):
        platform = "qq"

        def supports_private_reply(self, source) -> bool:
            return False

    hub = RoomHub()
    services = _services(_kp_rolls_then_replies)
    adapter = QQAdapter()
    source = SessionSource(platform="qq", chat_type="group", chat_id="table", user_id="keeper")
    await set_binding(services.store, source.chat_key(), session_key_for_room("arkham"))
    await set_keeper_binding(services.store, "qq", "keeper", "arkham")
    runner = GatewayRunner(services, [adapter], hub=hub)
    provider = services.settings.llm.provider

    reply = await runner.on_inbound(
        InboundMessage(source=source, text=".model set anthropic", at_bot=True)
    )

    assert reply is not None
    assert reply.text == get_i18n("en").t("runner.private_reply_unavailable")
    assert services.settings.llm.provider == provider


async def test_unauthorized_module_attachment_is_not_downloaded_or_stored() -> None:
    hub = RoomHub()
    services = _services(_kp_rolls_then_replies)
    adapter = FakeAdapter()
    runner = GatewayRunner(services, [adapter], hub=hub)
    source = SessionSource(
        platform="discord",
        chat_type="group",
        chat_id="public-table",
        user_id="player",
    )

    reply = await runner.on_inbound(
        InboundMessage(
            source=source,
            text=".module",
            at_bot=True,
            attachments=[
                ChatAttachment(
                    id="module-1",
                    name="secret.md",
                    mime="text/markdown",
                    data=b"# module",
                )
            ],
        )
    )

    assert reply is None
    assert adapter.fetches == 0
    assert await runner.media_store.room_total_size(source.chat_key()) == 0


async def test_private_interaction_reply_is_not_broadcast_to_room_members() -> None:
    hub = RoomHub()
    services = _services(_kp_rolls_then_replies)
    adapter = FakeAdapter()
    runner = GatewayRunner(services, [adapter], hub=hub)
    source = SessionSource(
        platform="discord",
        chat_type="group",
        chat_id="private-sheet",
        user_id="alice",
        user_name="Alice",
        message_id="interaction-sheet",
    )
    session_key = session_key_for_room("arkham")
    await set_binding(services.store, source.chat_key(), session_key)
    await services.characters.save_character(
        source.user_key(),
        session_key,
        CharacterSheet(name="Alice's Secret Sheet", system="CoC"),
    )
    bystander = RecordingWsMember()
    await hub.subscribe(session_key, bystander)
    bystander.events.clear()

    reply = await runner.on_inbound(
        InboundMessage(
            source=source,
            text=".sheet",
            at_bot=True,
            interaction=ChatInteraction(
                id="interaction-sheet",
                locale="en",
                private=True,
            ),
        )
    )

    assert reply is None
    assert any("Alice's Secret Sheet" in text for text in adapter.texts)
    assert all("Alice's Secret Sheet" not in event.text for event in bystander.events)
    assert not any(
        event.kind == "narrative" and event.speaker == "system"
        for event in bystander.events
    )


async def test_private_interaction_attachment_is_not_published_or_indexed() -> None:
    hub = RoomHub()
    services = _services(_kp_rolls_then_replies)
    adapter = FakeAdapter()
    runner = GatewayRunner(services, [adapter], hub=hub)
    source = SessionSource(
        platform="discord",
        chat_type="group",
        chat_id="private-attachment",
        user_id="alice",
        user_name="Alice",
        message_id="interaction-attachment",
    )
    session_key = session_key_for_room("arkham")
    await set_binding(services.store, source.chat_key(), session_key)
    bystander = RecordingWsMember()
    await hub.subscribe(session_key, bystander)
    bystander.events.clear()

    await runner.on_inbound(
        InboundMessage(
            source=source,
            text=".sheet",
            at_bot=True,
            interaction=ChatInteraction(
                id="interaction-attachment",
                locale="en",
                private=True,
            ),
            attachments=[
                ChatAttachment(
                    id="secret-image",
                    name="secret.png",
                    mime="image/png",
                    data=b"private-image-bytes",
                )
            ],
        )
    )

    assert adapter.fetches == 1
    assert not any(event.kind in {"media", "audio"} for event in bystander.events)
    assert (
        await services.store.get(
            user_key="", store_key=f"media_history.{session_key}"
        )
        is None
    )


async def test_same_channel_interactions_cannot_replace_an_active_turn_source(monkeypatch) -> None:
    hub = RoomHub()
    services = _services(_kp_rolls_then_replies)
    adapter = FakeAdapter()
    runner = GatewayRunner(services, [adapter], hub=hub)
    source_a = SessionSource(
        platform="discord",
        chat_type="dm",
        chat_id="same-channel",
        user_id="alice",
        message_id="interaction-a",
    )
    source_b = SessionSource(
        platform="discord",
        chat_type="dm",
        chat_id="same-channel",
        user_id="bob",
        message_id="interaction-b",
    )
    started = asyncio.Event()
    release = asyncio.Event()
    observed: list[tuple[str | None, str | None]] = []

    async def fake_run_turn(_hub, _services, _ctx, text, *, origin, **_kwargs):
        before = origin.source.message_id
        if text == "first":
            started.set()
            await release.wait()
        observed.append((before, origin.source.message_id))

    monkeypatch.setattr("gateway.runner.run_turn", fake_run_turn)
    first = asyncio.create_task(
        runner.on_inbound(InboundMessage(source=source_a, text="first", at_bot=True))
    )
    await started.wait()
    second = asyncio.create_task(
        runner.on_inbound(InboundMessage(source=source_b, text="second", at_bot=True))
    )
    await asyncio.sleep(0)
    member = runner._members[source_a.chat_key()]
    assert member.source.message_id == "interaction-a"
    release.set()
    await asyncio.gather(first, second)

    assert observed == [
        ("interaction-a", "interaction-a"),
        ("interaction-b", "interaction-b"),
    ]


async def test_runner_keeper_identity_only_elevates_inside_its_bound_room() -> None:
    hub = RoomHub()
    services = _services(_kp_rolls_then_replies)
    keystore = Keystore()
    router = CommandRouter(services, keystore=keystore, hub=hub)
    adapter = FakeAdapter()
    runner = GatewayRunner(services, [adapter], command_router=router, hub=hub, keystore=keystore)
    own = SessionSource(
        platform="discord", chat_type="group", chat_id="own-table", user_id="keeper-1"
    )
    foreign = SessionSource(
        platform="discord", chat_type="group", chat_id="foreign-table", user_id="keeper-1"
    )
    own_session = session_key_for_room("arkham")
    foreign_session = session_key_for_room("dunwich")
    await set_binding(services.store, own.chat_key(), own_session)
    await set_binding(services.store, foreign.chat_key(), foreign_session)
    await set_keeper_binding(services.store, "discord", "keeper-1", "arkham")
    await services.store.set(store_key=f"bot_enabled.{own_session}", value="1")
    await services.store.set(store_key=f"bot_enabled.{foreign_session}", value="1")

    await runner.on_inbound(
        InboundMessage(source=foreign, text="/skill enable mature-mode", at_bot=True)
    )
    assert await get_enabled_skills(services.store, foreign_session) == []

    await runner.on_inbound(
        InboundMessage(source=own, text="/skill enable mature-mode", at_bot=True)
    )
    assert await get_enabled_skills(services.store, own_session) == ["mature-mode"]


async def test_runner_bind_token_and_reply_stay_private_to_the_invoker() -> None:
    hub = RoomHub()
    services = _services(_kp_rolls_then_replies)
    keystore = Keystore()
    token = keystore.add(room="arkham", role="keeper", purpose="chat_bind")
    router = CommandRouter(services, keystore=keystore, hub=hub)
    adapter = FakeAdapter()
    runner = GatewayRunner(services, [adapter], command_router=router, hub=hub, keystore=keystore)
    source = SessionSource(
        platform="discord", chat_type="dm", chat_id="keeper-1", user_id="keeper-1"
    )
    bystander = RecordingWsMember()
    await hub.subscribe(source.chat_key(), bystander)
    bystander.events.clear()

    reply = await runner.on_inbound(
        InboundMessage(source=source, text=f"/bind {token}", at_bot=True)
    )

    assert isinstance(reply, ChatMessage) and reply.private is True
    assert token not in reply.text
    assert all(event.kind == "presence" for event in bystander.events)


async def test_unbind_immediately_unsubscribes_the_chat_channel_from_the_old_room() -> None:
    hub = RoomHub()
    services = _services(_kp_rolls_then_replies)
    adapter = FakeAdapter()
    source = SessionSource(
        platform="discord",
        chat_type="dm",
        chat_id="keeper-dm",
        user_id="keeper",
        message_id="unbind-1",
    )
    room = session_key_for_room("arkham")
    await set_keeper_binding(services.store, "discord", "keeper", "arkham")
    runner = GatewayRunner(services, [adapter], hub=hub)

    reply = await runner.on_inbound(InboundMessage(source=source, text="/unbind", at_bot=True))

    assert isinstance(reply, ChatMessage) and reply.private
    adapter.sends.clear()
    await hub.publish(room, Event.narrative(speaker="kp", text="must not leak"))
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


async def test_hidden_roll_result_reaches_only_the_invoking_keeper() -> None:
    hub = RoomHub()
    services = _services(_kp_rolls_then_replies)
    router = CommandRouter(services)
    adapter = FakeAdapter()
    chat_member = AdapterMember(
        adapter,
        SessionSource(platform="discord", chat_type="group", chat_id="hidden", user_id="p"),
        "R-hidden",
    )
    origin = RecordingWsMember(member_id="keeper", name="Keeper")
    bystander = RecordingWsMember(member_id="player", name="Player")
    for member in (chat_member, origin, bystander):
        await hub.subscribe("R-hidden", member)
    origin.events.clear()
    bystander.events.clear()
    adapter.sends.clear()

    seed_dice(9)
    await run_turn(
        hub,
        services,
        AgentCtx(chat_key="R-hidden", user_id="keeper", platform="cli", locale="en"),
        ".rh 1d20",
        command_router=router,
        toolset=build_kp_toolset(services),
        censor=Censor(),
        origin=origin,
    )

    assert any(event.speaker == "system" for event in origin.events)
    assert not any(event.speaker == "system" for event in bystander.events)
    assert adapter.sends == []


async def test_room_open_join_key_is_unicast_on_the_tui_path() -> None:
    hub = RoomHub()
    services = _services(_kp_rolls_then_replies)
    keystore = Keystore()
    router = CommandRouter(services, keystore=keystore, hub=hub)
    origin = RecordingWsMember(member_id="keeper", name="Keeper")
    bystander = RecordingWsMember(member_id="player", name="Player")
    await hub.subscribe("R-room", origin)
    await hub.subscribe("R-room", bystander)
    origin.events.clear()
    bystander.events.clear()

    await run_turn(
        hub,
        services,
        AgentCtx(
            chat_key="R-room",
            user_id="keeper",
            platform="tui",
            locale="en",
            extra={"role": "keeper"},
        ),
        ".room open",
        command_router=router,
        toolset=build_kp_toolset(services),
        censor=Censor(),
        origin=origin,
    )

    join_key = keystore.entries()[0].key
    assert any(join_key in event.text for event in origin.events)
    assert all(join_key not in event.text for event in bystander.events)


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
    assert any(event.kind == "player_action" for event in origin_member.events)
    assert not any(event.kind == "player_action" for event in bystander_member.events)


async def test_attachment_only_turn_rejects_an_unsupported_file_before_the_llm() -> None:
    hub = RoomHub()
    services = _services(_kp_rolls_then_replies)
    adapter = FakeAdapter()
    runner = GatewayRunner(services, [adapter], hub=hub)
    source = SessionSource(
        platform="discord",
        chat_type="dm",
        chat_id="unsupported-file",
        user_id="player",
    )

    reply = await runner.on_inbound(
        InboundMessage(
            source=source,
            text="",
            at_bot=True,
            attachments=[
                ChatAttachment(
                    id="program",
                    name="program.exe",
                    mime="application/octet-stream",
                    data=b"binary",
                )
            ],
        )
    )

    assert reply is not None
    assert reply.text == get_i18n("en").t("runner.attachment_unsupported")
    assert adapter.fetches == 0


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

    assert isinstance(reply, ChatMessage)
    assert reply.text == get_i18n("en").t("runner.error")
    assert not reply.private
