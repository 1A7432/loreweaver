"""F20 regressions: the two 2026-08-07 play-test symptoms, settled.

The report was "a failed SAN check produced no visible SAN change" and "the 潮感 hook
meter read 1/40 all game". Both looked like engine bugs. Only one was, and it was not
the one anybody expected — so these tests pin what is actually true, in both
directions, so neither has to be re-diagnosed from a transcript again.

1. The check->apply->panel pipeline is CORRECT: a failed loss check deducts, persists,
   and the deduction reaches `state.character.resources` on the same turn. What the
   session actually hit was a `failure_loss` of `"0"` — the model zeroed the stakes, and
   the engine dutifully applied nothing. So the tool now SAYS that, instead of printing
   a line indistinguishable from a success.
2. A hook's `globalThis` does NOT survive a turn — the interpreter is rebuilt each time.
   The pack counted turns in a JS variable, so its meter reset to 1 forever, silently.
   Durable state belongs to the engine (`incvar`), which is iron rule #1, not a
   workaround.
"""

from __future__ import annotations

import json

import pytest

from agent.context import AgentCtx
from agent.hook_runtime import apply_hook_writes, load_room_hook_engine
from agent.kp_tools import build_kp_toolset
from agent.kp_tools_subsystems import dispatch_subsystem
from agent.services import build_services
from core.dice_engine import seed_dice
from core.modvars import define_modvar
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM
from net.state import build_room_state

CHAT = "f20-room"

# Seeds chosen against the real dice engine: a roll over SAN 50 (a failure) and one
# under it (a success). Pinned so the test states its own setup rather than looping.
FAILING_SEED = 5
PASSING_SEED = 3


async def _room():
    services = build_services(Settings(locale="en"), llm=FakeLLM(), embeddings=FakeEmbeddings(64))
    ctx = AgentCtx(chat_key=CHAT, user_id="u1", locale="en")
    toolset = build_kp_toolset(services)
    await toolset.dispatch("create_character", ctx, {"name": "Nora", "system": "coc7", "auto_generate": False})
    return services, ctx


def _panel(state: dict) -> dict[str, int]:
    return {entry["id"]: entry["value"] for entry in state["character"]["resources"]}


# --- 1. the check -> apply -> panel pipeline --------------------------------


async def test_a_failed_loss_check_deducts_and_the_panel_shows_it_the_same_turn():
    services, ctx = await _room()
    assert _panel(await build_room_state(services, ctx))["san"] == 50

    seed_dice(FAILING_SEED)
    pack = await services.room_rulepack(ctx)
    reply = await dispatch_subsystem(
        services, ctx, pack, "sanity_check", {"success_loss": "0", "failure_loss": "1d6"}
    )

    sheet = await services.characters.get_character("u1", CHAT)
    lost = 50 - int(sheet.attributes["SAN"])
    assert 1 <= lost <= 6, f"a failed check must cost something; sheet says {sheet.attributes['SAN']}"
    # The sidebar is the thing the player actually watched: it must move on the SAME turn.
    assert _panel(await build_room_state(services, ctx))["san"] == 50 - lost
    assert "Failure" in reply

    # ...and the dice frame the client renders agrees with the sheet.
    (frame,) = [payload for payload in ctx.consume_dice() if payload.get("subsystem") == "sanity_check"]
    assert frame["detail"]["loss"] == lost
    assert frame["detail"]["remaining"] == 50 - lost


async def test_a_zero_failure_cost_is_stated_instead_of_looking_like_a_broken_engine():
    """THE actual 2026-08-07 cause. `failure_loss: "0"` is applied faithfully — the
    engine is not wrong — but the old output line was byte-identical to a success's,
    so a player reading it concluded the deduction had been lost."""
    services, ctx = await _room()

    seed_dice(FAILING_SEED)
    pack = await services.room_rulepack(ctx)
    reply = await dispatch_subsystem(
        services, ctx, pack, "sanity_check", {"success_loss": "0", "failure_loss": "0"}
    )

    sheet = await services.characters.get_character("u1", CHAT)
    assert int(sheet.attributes["SAN"]) == 50, "0 means 0 — the engine applies what it was told"
    assert "Failure" in reply
    assert "the declared failure cost was 0" in reply, "a costless failure must say so, not imply a bug"


async def test_a_successful_check_with_a_zero_success_cost_says_nothing_unusual():
    # The new line is scoped to FAILURES; a success costing nothing is ordinary.
    services, ctx = await _room()

    seed_dice(PASSING_SEED)
    pack = await services.room_rulepack(ctx)
    reply = await dispatch_subsystem(
        services, ctx, pack, "sanity_check", {"success_loss": "0", "failure_loss": "1d6"}
    )

    assert "Failure" not in reply
    assert "the declared failure cost was 0" not in reply


# --- 2. hook state lifetime -------------------------------------------------

pytest.importorskip("quickjs")

COUNTER_HOOK = """
on('turn_start', () => {
  globalThis.__turns = (globalThis.__turns || 0) + 1;   // the pack's mistake
  incvar('tide_sense', 1);                              // the sanctioned way
  emitUI([
    {kind: 'meter', label: 'in-sandbox', value: globalThis.__turns, min: 0, max: 40},
    {kind: 'meter', label: 'persisted', value: Number(getvar('tide_sense')) || 0, min: 0, max: 40}
  ]);
});
"""


async def _fire_turns(services, ctx, count: int) -> list[dict[str, int]]:
    readings = []
    for _ in range(count):
        engine = await load_room_hook_engine(services, ctx)
        assert engine is not None, "hooks must be live for this test to mean anything"
        outcome = engine.fire("turn_start", {"user_message": "x", "actor": ctx.user_id})
        await apply_hook_writes(services, ctx.chat_key, outcome.writes)
        readings.append(
            {block["label"]: block["value"] for frame in outcome.ui_blocks for block in frame["blocks"]}
        )
    return readings


async def test_a_hooks_globalThis_does_not_survive_a_turn_but_a_variable_does():
    services, ctx = await _room()
    await define_modvar(
        services.documents,
        CHAT,
        {"id": "tide_sense", "kind": "number", "labels": {"en": "Tide sense"}, "default": 0, "minimum": 0, "maximum": 40},
    )
    await services.store.state_set(CHAT, "room_hooks", json.dumps([{"source_id": "f20", "code": COUNTER_HOOK}]))

    readings = await _fire_turns(services, ctx, 3)

    # The documented contract, pinned in both directions: one interpreter PER TURN means
    # the interpreter is rebuilt, so in-sandbox state resets and never advances...
    assert [reading["in-sandbox"] for reading in readings] == [1, 1, 1]
    # ...while a variable write goes out through the effect buffer, gets validated and
    # persisted, and reads back as real progress on the next turn.
    assert [reading["persisted"] for reading in readings] == [1, 2, 3]


async def test_the_persisted_counter_is_the_one_the_player_panel_can_see():
    """The whole point of routing durable hook state through variables: it is real
    state, so it reaches the player's own panel — not just the hook's own meter."""
    services, ctx = await _room()
    await define_modvar(
        services.documents,
        CHAT,
        {"id": "tide_sense", "kind": "number", "labels": {"en": "Tide sense"}, "default": 0, "minimum": 0, "maximum": 40},
    )
    await services.store.state_set(CHAT, "room_hooks", json.dumps([{"source_id": "f20", "code": COUNTER_HOOK}]))

    await _fire_turns(services, ctx, 2)

    state = await build_room_state(services, ctx)
    tide = next(entry for entry in state["variables"] if entry["id"] == "tide_sense")
    assert tide["value"] == 2
