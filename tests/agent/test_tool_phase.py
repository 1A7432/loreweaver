"""The play phase must not cost the Keeper its improvisation (M20 B).

The original cut would have moved `create_npc` into prep, which reads fine on paper and
breaks at the table: improvising a shopkeeper mid-scene is ordinary play, and
`speak_as_npc` returns not_found without a record — so a play-phase Keeper could neither
create the NPC nor voice it. Worse, no record means no knowledge-scoped actor, so that
NPC's private knowledge would have no structural home at all (iron rule #3). "Prep is one
command away" is not an answer: a keeper flipping phase to rescue one improvised line IS
the ceremony.

The acceptance test is therefore behavioural, not structural — a play-phase turn that
invents an NPC and gets a line out of it, with no phase switch anywhere.
"""

from __future__ import annotations

import pytest

from agent import npc as npc_records
from agent.context import AgentCtx
from agent.kp_tools import build_kp_toolset
from agent.loop import run_kp_turn
from agent.services import build_services
from agent.tool_phase import PHASE_KEY, is_pinned, room_phase, set_room_phase
from agent.tools import PLAY_PHASE, PREP_PHASE
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, ToolCall, assistant_text, assistant_tools

CHAT = "phase-room"


def _services(llm=None):
    return build_services(Settings(locale="en"), llm=llm or FakeLLM(), embeddings=FakeEmbeddings(64))


def _ctx() -> AgentCtx:
    return AgentCtx(chat_key=CHAT, user_id="u1", locale="en")


def _call(tool_name: str, **arguments) -> ToolCall:
    """`infra.llm.tool_call` takes the tool name positionally, so a tool with its own
    `name` argument cannot go through it."""
    return ToolCall(id=f"call_{tool_name}", name=tool_name, arguments=arguments)


# ---------------------------------------------------------------------------
# Where the phase comes from
# ---------------------------------------------------------------------------


async def test_a_room_still_being_built_reads_as_prep():
    """A fresh room has bulk work ahead of it — importing a module, seeding NPCs — so the
    bulk tools are exactly what it needs. No ceremony on a brand-new room."""
    services = _services()

    assert await room_phase(services.store, CHAT) == PREP_PHASE
    assert not await is_pinned(services.store, CHAT)


async def test_a_ready_room_reads_as_play():
    """Not a guess about intent: `module_init_status` is the room's own record that its
    content is built, and that is when the per-turn set becomes the right one."""
    services = _services()
    await services.store.state_set(CHAT, "module_init_status", "ready")

    assert await room_phase(services.store, CHAT) == PLAY_PHASE


async def test_a_keeper_pin_beats_the_lifecycle_both_ways():
    services = _services()
    await services.store.state_set(CHAT, "module_init_status", "ready")

    await set_room_phase(services.store, CHAT, PREP_PHASE)
    assert await room_phase(services.store, CHAT) == PREP_PHASE
    assert await is_pinned(services.store, CHAT)

    # ...and a freeform room with no module at all can still be pinned to play.
    await services.store.state_set(CHAT, "module_init_status", "")
    await set_room_phase(services.store, CHAT, PLAY_PHASE)
    assert await room_phase(services.store, CHAT) == PLAY_PHASE

    await set_room_phase(services.store, CHAT, None)
    assert not await is_pinned(services.store, CHAT)
    assert await room_phase(services.store, CHAT) == PREP_PHASE


async def test_an_unknown_phase_is_refused_rather_than_stored():
    services = _services()

    with pytest.raises(ValueError):
        await set_room_phase(services.store, CHAT, "rehearsal")
    assert await services.store.state_get(CHAT, PHASE_KEY) in (None, "")


# ---------------------------------------------------------------------------
# The acceptance criterion
# ---------------------------------------------------------------------------


async def test_a_play_phase_keeper_can_invent_an_npc_and_voice_it():
    """THE M20 B acceptance criterion. One play-phase turn, no phase switch: sketch the
    NPC, then speak as them. The record it leaves behind is what gives the improvised
    NPC a knowledge-scoped actor."""
    services = _services(
        FakeLLM(
            script=[
                assistant_tools(_call("sketch_npc", name="Merrow", one_line="A tired dock clerk who wants a nap.")),
                assistant_tools(_call("speak_as_npc", npc="Merrow", situation="The party asks about the manifest.")),
                assistant_text("The clerk sighs and reaches for the ledger."),
            ]
        )
    )
    await services.store.state_set(CHAT, "module_init_status", "ready")
    toolset = build_kp_toolset(services)

    result = await run_kp_turn(_ctx(), services, toolset, "I ask the clerk about the shipment.")

    assert [entry["name"] for entry in result.tool_trace] == ["sketch_npc", "speak_as_npc"]
    assert all("not_found" not in str(entry["result"]) for entry in result.tool_trace)
    record = await npc_records.get_npc(services.documents, CHAT, "Merrow")
    assert record is not None and record.major, "no record means no scoped actor — iron rule #3"


async def test_the_bulk_half_is_gone_from_play_and_says_how_to_get_it_back():
    """Structural, and then honest about it: the schema is not offered, and a model that
    calls the name anyway gets a refusal naming the switch — the keeper is the one who
    can flip it, so the refusal has to reach them."""
    services = _services(
        FakeLLM(
            script=[
                assistant_tools(_call("create_npc", name="Lady Ashcombe", persona="The mastermind.")),
                assistant_text("Noted."),
            ]
        )
    )
    await services.store.state_set(CHAT, "module_init_status", "ready")
    toolset = build_kp_toolset(services)

    result = await run_kp_turn(_ctx(), services, toolset, "Who runs the estate?")

    offered = {schema["function"]["name"] for schema in services.llm.calls[0][1]}
    assert "create_npc" not in offered and "sketch_npc" in offered
    assert ".phase prep" in result.tool_trace[0]["result"]
    assert await npc_records.get_npc(services.documents, CHAT, "Lady Ashcombe") is None


async def test_the_same_turn_in_prep_carries_the_bulk_tools():
    services = _services(FakeLLM(script=[assistant_text("Ready when you are.")]))
    toolset = build_kp_toolset(services)

    await run_kp_turn(_ctx(), services, toolset, "Set the module up.")

    offered = {schema["function"]["name"] for schema in services.llm.calls[0][1]}
    assert {"create_npc", "add_lore", "define_variable", "import_module_npcs"} <= offered


async def test_a_gated_prep_tool_needs_both_keys():
    """Gating and phasing are independent filters of the same family, and they compose:
    unlocking a gated tool does not smuggle it past the phase."""
    services = _services()
    toolset = build_kp_toolset(services)

    unlocked = {"generate_module"}
    prep = {schema["function"]["name"] for schema in toolset.schemas(unlocked, phase=PREP_PHASE)}
    play = {schema["function"]["name"] for schema in toolset.schemas(unlocked, phase=PLAY_PHASE)}

    assert "generate_module" in prep
    assert "generate_module" not in play
    assert "generate_skill" not in prep, "still gated — the phase does not unlock anything"


def test_the_marker_defaults_to_visible():
    """An unmarked tool is available in every phase. The reverse default would make a
    newly added tool silently unreachable in play; this way the budget test notices."""
    services = _services()
    toolset = build_kp_toolset(services)

    assert not toolset.is_prep_only("skill_check")
    assert toolset.is_prep_only("create_npc")


async def test_scripted_dispatch_refuses_a_prep_tool_in_play_even_unlisted():
    """Defense in depth, exactly as gating does it: a model that remembers a tool name
    from a previous session cannot reach it by calling it blind."""
    services = _services()
    toolset = build_kp_toolset(services)

    refusal = await toolset.dispatch("define_variable", _ctx(), {"var_id": "x"}, phase=PLAY_PHASE)

    assert "define_variable" in refusal and ".phase prep" in refusal


# ---------------------------------------------------------------------------
# The keeper's switch
# ---------------------------------------------------------------------------


async def test_the_phase_command_reports_pins_and_unpins():
    from gateway.commands import CommandRouter

    services = _services()
    router = CommandRouter(services)
    keeper = AgentCtx(chat_key=CHAT, user_id="kp", platform="cli", locale="en")

    assert "prep" in (await router.dispatch(keeper, ".phase")).lower()
    await router.dispatch(keeper, ".phase play")
    assert await room_phase(services.store, CHAT) == PLAY_PHASE
    assert "play" in (await router.dispatch(keeper, ".phase")).lower()

    await router.dispatch(keeper, ".phase auto")
    assert not await is_pinned(services.store, CHAT)


async def test_a_player_may_read_the_phase_but_not_change_it():
    """Same split as `.skill`: seeing which half is loaded costs nothing; reshaping what
    the Keeper can do is the keeper's call."""
    from gateway.commands import CommandRouter

    services = _services()
    router = CommandRouter(services)
    player = AgentCtx(chat_key=CHAT, user_id="p1", platform="tui", locale="en", extra={"role": "player"})

    assert "prep" in (await router.dispatch(player, ".phase")).lower()
    await router.dispatch(player, ".phase play")

    assert not await is_pinned(services.store, CHAT), "a player must not be able to pin the phase"
