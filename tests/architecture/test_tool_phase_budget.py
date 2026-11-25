"""ORACLE: the play-phase toolset stays small (M20 B).

76 tools, 68 of them always on, 41k characters of generated schema re-sent every round of
every turn and every companion sub-turn. After M20 A most of that is a cache READ on the
primary path, so the motive is no longer headline token cost — it is model attention and
tool-selection quality, plus the uncached first call of every session.

A budget only holds if something counts it. This file is that something: it fails when a
new tool lands in the play phase without anyone deciding it belongs there. The fix when it
fails is usually `prep_only=True`, not a bigger number — raise the ceiling only with a
reason worth writing down.
"""

from __future__ import annotations

import json

from agent.kp_tools import build_kp_toolset
from agent.services import build_services
from agent.tools import PLAY_PHASE, PREP_PHASE
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM

# Measured 2026-08-11: the play phase is 32 tools / ~16.6k characters, cut from 35.7k
# ungated. The ceiling leaves room for a couple of genuinely per-turn additions and no
# more; a bulk tool cannot slip in under it. 2026-09-24: 36 tools / ~19.3k, after
# `create_npc` and `update_character_attribute` joined play — both used in play by the
# 《安土》 Studio run (see `_PLAY_ESSENTIALS`) — and the ceiling did not move.
# 2026-10-21: 20_000 -> 21_000. The 19.3k above was measured while the docstring parser
# dropped every continuation line of an `Args:` entry (14 play parameters cut mid-sentence);
# with the full descriptions the same 36 tools measure 20.4k. No tool grew; the text the
# model should always have received is now counted.
PLAY_PHASE_SCHEMA_BUDGET = 21_000

# What a turn cannot be run without. Losing any of these to a phase reclassification is
# not a budget question — it breaks play.
_PLAY_ESSENTIALS = frozenset(
    {
        "skill_check",
        "roll_dice",
        "speak_as_npc",
        "sketch_npc",
        "companion_act",
        "kp_note",
        "game_clock",
        "record_chronicle",
        # A pack seeds no NPC records, so a module's cast is authored as each one walks
        # on; and a module's own sheet attribute (《安土》's 根值) moves in play, with no
        # other tool that writes one. Owner verdict 2026-09-24.
        "create_npc",
        "update_character_attribute",
    }
)


def _toolset():
    services = build_services(Settings(locale="en"), llm=FakeLLM(), embeddings=FakeEmbeddings(64))
    return build_kp_toolset(services)


def _payload(schemas: list[dict]) -> int:
    return len(json.dumps(schemas, ensure_ascii=False))


def test_the_play_phase_schema_payload_stays_under_budget():
    schemas = _toolset().schemas(phase=PLAY_PHASE)

    size = _payload(schemas)
    assert size <= PLAY_PHASE_SCHEMA_BUDGET, (
        f"the play-phase toolset is {size} characters over {len(schemas)} tools, past the "
        f"{PLAY_PHASE_SCHEMA_BUDGET} budget. Mark the newcomer `prep_only=True` if it is bulk "
        "or low-frequency work; raise the budget only if a per-turn tool genuinely needs the room."
    )


def test_phasing_actually_cut_something():
    toolset = _toolset()

    prep = _payload(toolset.schemas(phase=PREP_PHASE))
    play = _payload(toolset.schemas(phase=PLAY_PHASE))

    # Under half until 2026-09-24; `create_npc` and `update_character_attribute` joining
    # play took it to ~51% (19.3k of 37.5k), and the owner accepted that as the price of a
    # pack room that can author its cast and write its own attribute mid-campaign. 60%
    # still fails the day phasing stops meaning anything.
    assert play < prep * 0.6, f"phasing removed almost nothing: prep {prep}, play {play}"


def test_the_per_turn_essentials_are_never_prep_only():
    toolset = _toolset()

    play = {schema["function"]["name"] for schema in toolset.schemas(phase=PLAY_PHASE)}

    assert _PLAY_ESSENTIALS <= play, f"missing from the play phase: {sorted(_PLAY_ESSENTIALS - play)}"


def test_no_phase_means_no_filtering():
    """Every caller that does not know about phases must see the toolset it always saw."""
    toolset = _toolset()

    assert len(toolset.schemas()) == len(toolset.schemas(phase=PREP_PHASE))


def test_prep_phase_is_a_superset_of_play():
    toolset = _toolset()

    prep = {schema["function"]["name"] for schema in toolset.schemas(phase=PREP_PHASE)}
    play = {schema["function"]["name"] for schema in toolset.schemas(phase=PLAY_PHASE)}

    assert play < prep, "play must be a strict subset — nothing exists only in play"


# The `module_action` tool (hook-defined module actions, `agent.hook_actions`) is NOT part of
# the static toolset above: it exists only in a room whose hook scripts register actions, and
# its size is the pack author's to spend. It is counted here rather than exempted. Measured
# 2026-11-25: a room maxed out on every registration cap (24 actions, 32-char names, 200-char
# descriptions, 400-char params hints) sends 16,885 characters on top of the static play
# phase — about 80% of the budget above — while a typical pack (four short actions) sends ~1k.
# The ceiling pins the caps: raising any of them moves this number, and that is the moment
# to decide whether the room can afford it.
MODULE_ACTION_SCHEMA_WORST_CASE = 17_000


def test_the_module_action_tool_is_bounded_by_its_caps():
    from agent.hook_actions import module_action_schemas
    from core.hooks import (
        MAX_ACTION_DESCRIPTION_CHARS,
        MAX_ACTION_PARAMS_CHARS,
        MAX_ACTIONS,
        ActionSpec,
    )

    class _Engine:
        actions = tuple(
            ActionSpec(
                name=f"a{index:02d}" + "x" * 29,
                description="d" * MAX_ACTION_DESCRIPTION_CHARS,
                params="p" * MAX_ACTION_PARAMS_CHARS,
            )
            for index in range(MAX_ACTIONS)
        )

    size = _payload(module_action_schemas(_Engine()))  # type: ignore[arg-type]
    assert size <= MODULE_ACTION_SCHEMA_WORST_CASE, (
        f"a maxed-out module_action tool is {size} characters, past {MODULE_ACTION_SCHEMA_WORST_CASE}"
    )
    assert module_action_schemas(None) == []
