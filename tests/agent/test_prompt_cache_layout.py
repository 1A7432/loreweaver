"""P1 ORACLE: the system prompt's stable head really is stable.

The 1.x section order opened with session history and game state — the two things
that change every turn — so every turn invalidated the whole downstream prefix and
the module pool, the rulepack expertise, the style layer and the skill bodies were
re-read at full price. A 2026-08-07 long session burned 40% of a weekly quota partly
this way.

Reordering only helps if the head is stable IN FACT, and "in fact" is not something a
section list can promise — a section that quietly varies per turn (a retrieval, a
timestamp, a shuffled list) silently costs the whole prefix. So the acceptance test is
behavioural, not structural: build the prompt twice for ONE room with only STATE
changed between builds, and assert the common prefix covers everything up to the
volatile boundary.
"""

from __future__ import annotations

import json
import os

from agent.context import AgentCtx
from agent.prompt_builder import build_system_prompt_parts
from agent.services import build_services
from core.modvars import define_modvar, set_modvar
from core.relationships import RelationshipManager
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import CACHE_PREFIX_KEY, FakeLLM, wire_messages

CHAT = "cache-layout-room"
SECRET = "SENTINEL_THE_LIGHTHOUSE_KEEPER"


def _services():
    return build_services(Settings(locale="en"), llm=FakeLLM(), embeddings=FakeEmbeddings(64))


def _ctx() -> AgentCtx:
    return AgentCtx(chat_key=CHAT, user_id="u1", locale="en")


async def _furnished_room(services):
    """A realistic room: an initialized module, a session with history, a character,
    trackers, relationships — every section that can contribute, contributing."""
    await services.store.state_set(CHAT, "module_init_status", "ready")
    await services.documents.put_singleton(
        CHAT,
        "module_pool",
        {
            "keeper": {"summary": "A cult beneath the lighthouse.", "truths": [{"name": "T", "description": SECRET}]},
            "player": {"summary": "A quiet fishing town."},
        },
    )
    await services.battles.start_session(CHAT, session_name="Session Zero")
    await services.battles.add_key_event(CHAT, "The party arrived in town.")
    await services.battles.generate_battle_report(CHAT)
    sheet = services.characters.generate_character("coc7", "Nora Vance")
    await services.characters.save_character("u1", CHAT, sheet)
    await define_modvar(
        services.documents,
        CHAT,
        {"id": "doom", "kind": "number", "labels": {"en": "Doom"}, "default": 0, "minimum": 0, "maximum": 10},
    )
    await RelationshipManager(services.store).adjust(CHAT, "Nora", "Elias", "affection", 20)


def _common_prefix(left: str, right: str) -> int:
    limit = min(len(left), len(right))
    index = 0
    while index < limit and left[index] == right[index]:
        index += 1
    return index


async def test_only_the_volatile_tail_changes_when_only_state_changes():
    """THE acceptance criterion: same room, state moved, common prefix >= the whole
    stable head."""
    services = _services()
    await _furnished_room(services)

    before = await build_system_prompt_parts(_ctx(), services)

    # Move exactly what a turn moves: a tracker, a relationship, the clock, the scene.
    await set_modvar(services.documents, CHAT, "doom", 7)
    await RelationshipManager(services.store).adjust(CHAT, "Nora", "Elias", "affection", 15)
    await services.store.state_set(CHAT, "game_clock", json.dumps({"current_time": "Night 2, 03:00"}))
    await services.battles.add_key_event(CHAT, "They found the cellar door.")

    after = await build_system_prompt_parts(_ctx(), services)

    assert before.stable, "the room is furnished; the stable head cannot be empty"
    assert after.volatile != before.volatile, "state moved — the tail MUST have changed"
    assert after.stable == before.stable, "state moved — the head must NOT have"

    prefix = _common_prefix(before.text, after.text)
    assert prefix >= before.cache_prefix_chars, (
        f"the cacheable prefix broke early: {prefix} < {before.cache_prefix_chars}. "
        "Some section in the stable head varies per turn — find it and move it to the tail."
    )


async def test_the_stable_head_carries_the_room_configuration_and_the_tail_the_story():
    """Naming what belongs where, so a future section lands on the right side."""
    services = _services()
    await _furnished_room(services)
    i18n = services.i18n.with_locale("en")

    prompt = await build_system_prompt_parts(_ctx(), services)

    for marker in (
        i18n.t("prompt.system.intro"),  # who the KP is
        i18n.t("prompt.style.narrative"),  # how it writes
        i18n.t("prompt.document.pool_title"),  # what module it is running
    ):
        assert marker in prompt.stable, f"{marker!r} is room configuration; it belongs in the head"
    assert SECRET in prompt.stable, "the module's own content is stable, and stays keeper-visible"

    for marker in (
        i18n.t("battle.summary.title"),  # what happened
        i18n.t("prompt.game_state.title"),  # where things stand
        i18n.t("prompt.modvars_header"),  # the trackers
        i18n.t("prompt.relationships_header"),  # the tracks
    ):
        assert marker in prompt.volatile, f"{marker!r} moves with the story; it belongs in the tail"


async def test_a_room_without_a_module_pool_keeps_its_retrieval_out_of_the_head():
    """A room with no initialized module falls back to per-turn vector search. Routing
    that to the tail is what keeps the head honestly stable rather than nominally so."""
    services = _services()
    await services.battles.start_session(CHAT, session_name="Freeform")

    prompt = await build_system_prompt_parts(_ctx(), services)
    i18n = services.i18n.with_locale("en")

    assert prompt.stable, "identity/expertise/style still lead"
    assert i18n.t("prompt.document.pool_title") not in prompt.stable


async def test_the_assembled_text_is_still_one_prompt_split_at_the_boundary():
    """Iron rule #5 is untouched: the split is metadata about ONE string, not two
    injections. `text[:cache_prefix_chars]` must be exactly the head plus its joiner."""
    services = _services()
    await _furnished_room(services)

    prompt = await build_system_prompt_parts(_ctx(), services)

    assert prompt.text == prompt.stable + "\n\n" + prompt.volatile
    assert prompt.text[: prompt.cache_prefix_chars] == prompt.stable + "\n\n"
    assert prompt.text[prompt.cache_prefix_chars :] == prompt.volatile


async def test_a_prompt_with_only_one_half_has_no_interior_boundary():
    services = _services()
    prompt = await build_system_prompt_parts(_ctx(), services)

    # A bare room still renders identity/expertise/style, and nothing volatile beyond
    # the always-on game-state block — whichever half is empty, the boundary is the
    # whole text and the loop marks nothing.
    if not prompt.volatile or not prompt.stable:
        assert prompt.cache_prefix_chars == len(prompt.text)


def test_the_boundary_marker_never_reaches_a_vendor_wire():
    """`_lw_cache_prefix` is agent->adapter metadata. A vendor rejects unknown message
    properties, so leaking it would be an HTTP 400 on every turn, not a cosmetic bug."""
    messages = [
        {"role": "system", "content": "head\n\ntail", CACHE_PREFIX_KEY: 6},
        {"role": "assistant", "content": "hi", "provider_blocks": [{"type": "thinking"}]},
        {"role": "user", "content": "I open the door"},
    ]

    wired = wire_messages(messages)

    assert all(CACHE_PREFIX_KEY not in message for message in wired)
    assert all("provider_blocks" not in message for message in wired)
    assert [message["role"] for message in wired] == ["system", "assistant", "user"]
    assert wired[0]["content"] == "head\n\ntail", "only the private keys go"
    # Untouched input is returned as-is: a turn with no metadata pays nothing.
    plain = [{"role": "user", "content": "x"}]
    assert wire_messages(plain) is plain


def test_the_anthropic_path_turns_the_marker_into_a_cache_breakpoint():
    from infra.providers import to_anthropic_messages

    system, turns = to_anthropic_messages(
        [
            {"role": "system", "content": "STABLE HEAD\n\nvolatile tail", CACHE_PREFIX_KEY: len("STABLE HEAD\n\n")},
            {"role": "user", "content": "hello"},
        ]
    )

    assert system == [
        {"type": "text", "text": "STABLE HEAD\n\n", "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": "volatile tail"},
    ]
    assert turns == [{"role": "user", "content": "hello"}]

    # Without the marker the system value stays a plain string — an unmarked prompt
    # must not silently acquire a breakpoint in the wrong place.
    plain, _ = to_anthropic_messages([{"role": "system", "content": "just a prompt"}])
    assert plain == "just a prompt"

    # A nonsense boundary (past the text, or zero) is ignored rather than trusted.
    for bad in (0, -1, 999_999, "12", None):
        value, _ = to_anthropic_messages([{"role": "system", "content": "abc", CACHE_PREFIX_KEY: bad}])
        assert value == "abc"


def test_the_scribe_stays_off_for_this_module():
    # Guards the suite-wide conftest contract these tests rely on for determinism.
    assert os.environ.get("TRPG_SCRIBE__ENABLED") == "0"
