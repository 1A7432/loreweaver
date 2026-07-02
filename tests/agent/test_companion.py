"""Tests for M10 AI player companions (`docs/specs/M10-companions.md`).

Four pillars, mirroring the spec's §7 test plan:

(a) INFO-ISOLATION red line -- a companion's actor prompt is built from ONLY its own record + its
    own sheet, so a seeded keeper sentinel appears NOWHERE in it (companions play fair).
(b) ACTS-THROUGH-THE-PIPELINE -- a companion's declared action runs through the normal turn pipeline
    AS that companion, so the KP resolves a REAL `skill_check` on the COMPANION's own sheet, and the
    turn fans out to the hub; no keeper leak reaches players.
(c) DIRECTOR pacing -- `request_companion` runs exactly one; `run_combat_round` iterates initiative
    order once, respects the cap, skips a pass, and never recursively spawns another companion turn.
(d) TOOLS -- `add_companion` creates a `player_companion` record (is_pc) + a real sheet; the steering
    tools (`party_auto`/`list`/`remove`/`set_playstyle`/`companion_learns`) persist.

The generalization is additive: `tests/agent/test_npc.py` (keeper NPCs) stays green.
"""

from __future__ import annotations

import json

from agent.companion_actor import companion_action
from agent.context import AgentCtx
from agent.kp_tools import build_kp_toolset
from agent.kp_tools_companion import CompanionTools, witness
from agent.npc import NpcManager
from agent.services import build_services
from core.character_manager import CharacterSheet
from core.dice_engine import seed_dice
from gateway.commands import CommandRouter
from gateway.director import MAX_COMPANION_TURNS, request_companion, run_combat_round, run_companion_turn
from gateway.hub import Event, RoomHub
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, assistant_text, assistant_tools, tool_call
from infra.store import Store
from net.state import build_room_state

SENTINEL = "THE LIGHTHOUSE KEEPER IS THE MURDERER"


class FakeMember:
    """An in-memory `gateway.hub.Member` that records what it was delivered (mirrors test_hub's)."""

    def __init__(self, id: str, *, transport: str = "tui") -> None:
        self.id = id
        self.user_key = f"user:{id}"
        self.transport = transport
        self.name = id
        self.events: list[Event] = []

    def supports_proactive(self) -> bool:
        return True

    async def deliver(self, event: Event) -> None:
        self.events.append(event)


def _tools_called(messages: list[dict]) -> list[str]:
    """Tool names the assistant invoked in this message list (single turn)."""
    called: list[str] = []
    for message in messages:
        if message.get("role") == "assistant" and message.get("tool_calls"):
            called.extend(call["function"]["name"] for call in message["tool_calls"])
    return called


def _ctx(chat_key: str, user_id: str = "kp") -> AgentCtx:
    return AgentCtx(chat_key=chat_key, user_id=user_id, locale="en")


# ---------------------------------------------------------------------------
# (a) info-isolation -- the red line
# ---------------------------------------------------------------------------


async def test_companion_action_never_sees_keeper_pool_or_other_secrets():
    chat_key = "iso-room"
    store = Store(":memory:")
    # The module keeper pool + a keeper NPC both hold the sentinel world-truth.
    await store.set(
        user_key="",
        store_key=f"module_keeper_pool.{chat_key}",
        value=json.dumps({"truths": [{"description": SENTINEL}], "npcs": [{"name": "Villain", "secret": SENTINEL}]}),
    )
    npcs = NpcManager(store)
    await npcs.create_npc(chat_key, "Villain", secret_agenda=SENTINEL, knowledge=[SENTINEL])

    # The companion under test knows nothing of any of that.
    companion = await npcs.create_companion(
        chat_key,
        "Silas",
        persona="A steady gunslinger with a dry wit.",
        playstyle="cover fire and protect the team",
        knowledge=["The party found a torn map in the cellar."],
        stat_char="Silas",
    )
    sheet = CharacterSheet(name="Silas", system="CoC")
    sheet.skills["手枪"] = 60

    recorded: list[list[dict]] = []

    def responder(messages, tools):
        recorded.append(messages)
        return assistant_text(json.dumps({"action": "I cover the cellar door.", "dialogue": "Stay behind me."}))

    services = build_services(Settings(), llm=FakeLLM(responder=responder), embeddings=FakeEmbeddings(8), store=store)

    out = await companion_action(
        services, companion, sheet, "You hear scraping in the dark cellar.", recent=["The party found a torn map."]
    )
    assert out == {"action": "I cover the cellar door.", "dialogue": "Stay behind me."}

    assert len(recorded) == 1
    system_content, user_content = recorded[0][0]["content"], recorded[0][1]["content"]
    blob = f"{system_content}\n{user_content}"

    # RED LINE: neither the keeper truth nor the other character's identity reaches the actor.
    assert SENTINEL not in blob
    assert "Villain" not in blob

    # positive controls: its OWN persona / playstyle / knowledge / sheet + the situation DID make it in.
    assert "steady gunslinger" in system_content
    assert "cover fire and protect the team" in system_content
    assert "The party found a torn map in the cellar." in system_content
    assert "手枪" in system_content  # a skill from its own sheet
    assert "scraping in the dark cellar" in user_content


async def test_companion_action_falls_back_to_raw_content_when_reply_is_not_json():
    services = build_services(
        Settings(), llm=FakeLLM(script=[assistant_text("I kick the door in.")]), embeddings=FakeEmbeddings(8)
    )
    record = await NpcManager(Store(":memory:")).create_companion("fallback-room", "Silas")
    out = await companion_action(services, record, CharacterSheet(name="Silas"), "The door is locked.")
    assert out == {"action": "I kick the door in.", "dialogue": ""}


# ---------------------------------------------------------------------------
# (b) acts through the pipeline -- real dice on the companion's own sheet
# ---------------------------------------------------------------------------


async def test_companion_acts_through_pipeline_with_real_dice_on_its_own_sheet():
    seed_dice(20240701)
    chat_key = "pipe-room"
    store = Store(":memory:")
    # Seed a keeper sentinel to prove it never reaches players via the companion's turn.
    await store.set(
        user_key="",
        store_key=f"module_keeper_pool.{chat_key}",
        value=json.dumps({"truths": [{"description": SENTINEL}]}),
    )

    actor_calls: list[list[dict]] = []

    def responder(messages, tools):
        if tools is None:  # the companion actor call (no tools attached)
            actor_calls.append(messages)
            return assistant_text(json.dumps({"action": "I fire my revolver at the thing", "dialogue": "Stay back!"}))
        # the KP loop resolving the companion's action
        if "skill_check" not in _tools_called(messages):
            return assistant_tools(tool_call("skill_check", skill_name="手枪"))
        return assistant_text("Silas' shot cracks out and the thing recoils. What next?")

    services = build_services(
        Settings(locale="en"), llm=FakeLLM(responder=responder), embeddings=FakeEmbeddings(8), store=store
    )
    tools = CompanionTools(services)
    await tools.add_companion(_ctx(chat_key), name="Silas", persona="A steady gunslinger.", playstyle="cover fire")

    npcs = NpcManager(store)
    companion = await npcs.get_npc(chat_key, "Silas")
    # Give the companion Firearms(handgun) 60 on its OWN sheet, under the virtual user_key.
    sheet = await services.characters.get_character(f"companion:{companion.id}", chat_key)
    sheet.skills["手枪"] = 60
    await services.characters.save_character(f"companion:{companion.id}", chat_key, sheet)
    await services.battles.start_session(chat_key)

    hub = RoomHub()
    member = FakeMember("m1")
    await hub.subscribe(chat_key, member)
    member.events.clear()

    result = await run_companion_turn(
        hub,
        services,
        companion,
        chat_key=chat_key,
        command_router=CommandRouter(services),
        toolset=build_kp_toolset(services),
    )

    # A REAL dice check happened on the COMPANION's sheet.
    assert result is not None
    checks = [entry for entry in result.tool_trace if entry["name"] == "skill_check"]
    assert checks, "the KP must have resolved a real skill_check for the companion"
    check_text = checks[0]["result"]
    assert "Silas" in check_text  # header names the companion -> the companion's sheet was used
    assert any(char.isdigit() for char in check_text)  # a real rolled number

    # The turn broadcast to the room, attributed to the companion BY NAME.
    kinds = [event.kind for event in member.events]
    assert "player_action" in kinds
    assert "dice" in kinds
    assert any(event.kind == "narrative" and event.speaker == "kp" for event in member.events)
    echo = next(event for event in member.events if event.kind == "player_action")
    assert echo.name == "Silas"

    # The companion declared its action exactly once (no recursion).
    assert len(actor_calls) == 1

    # NO keeper leak: not to players, not into the companion actor's own prompt.
    player_text = "\n".join(event.text for event in member.events if event.kind in {"narrative", "player_action"})
    assert SENTINEL not in player_text
    assert all(SENTINEL not in (call[0]["content"] + call[1]["content"]) for call in actor_calls)


# ---------------------------------------------------------------------------
# (c) director pacing -- one on request; a combat round in initiative order, capped, pass-aware
# ---------------------------------------------------------------------------


async def test_director_requests_one_and_runs_a_capped_ordered_pass_aware_round():
    chat_key = "combat-room"
    store = Store(":memory:")

    actor_names: list[str] = []

    def responder(messages, tools):
        if tools is None:  # a companion actor call -- branch on which companion it is
            system = messages[0]["content"]
            name = next((candidate for candidate in ("Ada", "Ben", "Cid") if f"You are {candidate}," in system), "?")
            actor_names.append(name)
            if name == "Ben":  # Ben passes (empty action -> skipped, produces no turn)
                return assistant_text(json.dumps({"action": "", "dialogue": ""}))
            return assistant_text(json.dumps({"action": "I move up and ready my weapon.", "dialogue": "On it."}))
        return assistant_text("The KP resolves the move.")  # KP loop for an acting companion

    services = build_services(
        Settings(locale="en"), llm=FakeLLM(responder=responder), embeddings=FakeEmbeddings(8), store=store
    )
    tools = CompanionTools(services)
    for name in ("Ada", "Ben", "Cid"):
        await tools.add_companion(_ctx(chat_key), name=name)

    # Initiative order: Cid (20) > Ada (15) > Ben (10).
    await store.set(
        user_key="",
        store_key=f"initiative.{chat_key}",
        value=json.dumps([{"name": "Cid", "init": 20}, {"name": "Ada", "init": 15}, {"name": "Ben", "init": 10}]),
    )

    hub = RoomHub()
    await hub.subscribe(chat_key, FakeMember("m"))
    router = CommandRouter(services)
    toolset = build_kp_toolset(services)

    # request_companion runs EXACTLY one.
    one = await request_companion(hub, services, "Ada", chat_key=chat_key, command_router=router, toolset=toolset)
    assert one is not None
    assert actor_names == ["Ada"]

    # run_combat_round: initiative order, Ben passes, nobody recurses.
    actor_names.clear()
    results = await run_combat_round(hub, services, chat_key=chat_key, command_router=router, toolset=toolset)
    assert [companion_id for companion_id, _ in results] == ["cid", "ada", "ben"]  # initiative order
    by_id = dict(results)
    assert by_id["ben"] is None  # the pass produced no turn
    assert by_id["ada"] is not None and by_id["cid"] is not None
    # Each companion's actor was consulted exactly once -> a companion turn never spawned another.
    assert actor_names == ["Cid", "Ada", "Ben"]

    # The per-round cap bounds how many companions are processed.
    capped = await run_combat_round(
        hub, services, chat_key=chat_key, command_router=router, toolset=toolset, max_turns=2
    )
    assert [companion_id for companion_id, _ in capped] == ["cid", "ada"]
    assert MAX_COMPANION_TURNS == 6


async def test_request_companion_returns_none_for_a_non_companion_name():
    chat_key = "empty-room"
    services = build_services(Settings(), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(8))
    # a keeper NPC is NOT a companion and must not be driven as one
    await NpcManager(services.store).create_npc(chat_key, "Elias Crane")
    result = await request_companion(
        RoomHub(),
        services,
        "Elias Crane",
        chat_key=chat_key,
        command_router=CommandRouter(services),
        toolset=build_kp_toolset(services),
    )
    assert result is None


# ---------------------------------------------------------------------------
# (d) tools -- add creates record(role=player_companion, is_pc)+sheet; steering tools persist
# ---------------------------------------------------------------------------


async def test_add_companion_creates_player_companion_record_and_real_sheet():
    chat_key = "tools-room"
    services = build_services(Settings(locale="en"), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(8))
    tools = CompanionTools(services)
    ctx = _ctx(chat_key)

    added = await tools.add_companion(ctx, name="Silas", persona="A steady gunslinger.", playstyle="cover fire")
    assert "Silas" in added

    npcs = NpcManager(services.store)
    companion = await npcs.get_npc(chat_key, "Silas")
    assert companion is not None
    assert companion.role == "player_companion"
    assert companion.is_pc is True
    assert companion.playstyle == "cover fire"
    assert companion.stat_char == "Silas"

    # A real, generated character sheet exists under the virtual companion user_key.
    sheet = await services.characters.get_character(f"companion:{companion.id}", chat_key)
    assert sheet.name == "Silas"
    assert sheet.system == "CoC"
    assert sheet.attributes.get("STR")  # auto-generated, not the bare default


async def test_companion_steering_tools_persist():
    chat_key = "steer-room"
    services = build_services(Settings(locale="en"), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(8))
    tools = CompanionTools(services)
    ctx = _ctx(chat_key)
    npcs = NpcManager(services.store)

    await tools.add_companion(ctx, name="Silas")

    # party_auto toggles and persists to the store.
    await tools.party_auto(ctx, "on")
    assert await services.store.get(user_key="", store_key=f"party_auto.{chat_key}") == "1"
    await tools.party_auto(ctx, "off")
    assert await services.store.get(user_key="", store_key=f"party_auto.{chat_key}") == "0"

    # list surfaces the companion.
    assert "Silas" in await tools.list_companions(ctx)

    # set_companion_playstyle persists.
    set_result = await tools.set_companion_playstyle(ctx, "Silas", "reckless brawler")
    assert "reckless brawler" in set_result
    assert (await npcs.get_npc(chat_key, "Silas")).playstyle == "reckless brawler"

    # companion_learns grows player-scoped knowledge.
    learn_result = await tools.companion_learns(ctx, "Silas", "The cellar door is unlocked.")
    assert "The cellar door is unlocked." in learn_result
    assert "The cellar door is unlocked." in (await npcs.get_npc(chat_key, "Silas")).knowledge

    # remove deletes the record.
    assert "Silas" in await tools.remove_companion(ctx, "Silas")
    assert await npcs.get_npc(chat_key, "Silas") is None
    assert await npcs.list_companions(chat_key) == []


async def test_witness_grows_companion_knowledge_but_not_keeper_npcs():
    chat_key = "witness-room"
    services = build_services(Settings(), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(8))
    npcs = NpcManager(services.store)
    await npcs.create_companion(chat_key, "Ada")
    await npcs.create_companion(chat_key, "Ben")
    await npcs.create_npc(chat_key, "Villain")  # a keeper NPC -- must NOT receive party discoveries

    await witness(services, chat_key, "The vault code is 1926.")

    assert "The vault code is 1926." in (await npcs.get_npc(chat_key, "Ada")).knowledge
    assert "The vault code is 1926." in (await npcs.get_npc(chat_key, "Ben")).knowledge
    assert "The vault code is 1926." not in (await npcs.get_npc(chat_key, "Villain")).knowledge


def test_companion_tools_registered_and_player_safe_in_build_kp_toolset():
    services = build_services(Settings(), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(8))
    toolset = build_kp_toolset(services)
    for name in (
        "add_companion",
        "companion_act",
        "party_auto",
        "list_companions",
        "remove_companion",
        "set_companion_playstyle",
        "companion_learns",
    ):
        assert name in toolset.names()
        assert toolset.is_keeper_only(name) is False, name


async def test_build_room_state_tags_ai_companions_in_the_party():
    chat_key = "state-room"
    services = build_services(Settings(locale="en"), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(8))
    ctx = _ctx(chat_key, user_id="human")

    human = services.characters.generate_character("coc7", "Nora")
    await services.characters.save_character("human", chat_key, human)
    await CompanionTools(services).add_companion(ctx, name="Silas")

    state = await build_room_state(services, ctx)
    party = {member["name"]: member for member in state["party"]}
    assert party["Silas"]["ai"] is True
    assert isinstance(party["Silas"]["hp"], int)
    assert isinstance(party["Silas"]["hpMax"], int)
    assert isinstance(party["Silas"]["san"], int)
    assert isinstance(party["Silas"]["sanMax"], int)
    assert isinstance(party["Silas"]["mp"], int)
    assert isinstance(party["Silas"]["mpMax"], int)
    assert party["Nora"]["ai"] is False


# ---------------------------------------------------------------------------
# (a') info-isolation red line, F11: the director must never feed room-wide
#      session key-events into the isolated companion actor's prompt.
# ---------------------------------------------------------------------------

ROOM_EVENT_SENTINEL = "THE ALTAR ROOM CONCEALS A HIDDEN LEVER"


async def test_companion_turn_never_feeds_room_wide_session_events_to_the_actor():
    chat_key = "iso-events-room"
    store = Store(":memory:")

    actor_calls: list[list[dict]] = []

    def responder(messages, tools):
        if tools is None:  # the companion actor call (no tools attached)
            actor_calls.append(messages)
            return assistant_text(json.dumps({"action": "I hold position and watch the door.", "dialogue": ""}))
        return assistant_text("The KP resolves the hold.")  # KP loop resolving the action

    services = build_services(
        Settings(locale="en"), llm=FakeLLM(responder=responder), embeddings=FakeEmbeddings(8), store=store
    )
    companion = await NpcManager(store).create_companion(chat_key, "Silas")

    # A room-wide session key-event the companion has NOT personally witnessed.
    await services.battles.start_session(chat_key)
    await services.battles.add_key_event(chat_key, ROOM_EVENT_SENTINEL)

    hub = RoomHub()
    await hub.subscribe(chat_key, FakeMember("m"))

    await run_companion_turn(
        hub,
        services,
        companion,
        chat_key=chat_key,
        command_router=CommandRouter(services),
        toolset=build_kp_toolset(services),
    )

    assert actor_calls, "the companion actor must have been consulted"
    blob = "\n".join(message["content"] for message in actor_calls[0])
    # RED LINE: room-wide state (the shared session log) never reaches the isolated actor.
    assert ROOM_EVENT_SENTINEL not in blob
