"""ORACLE: the cacheable prefix really is stable, turn over turn.

The 1.x section order opened with session history and game state — the two things
that change every turn — so every turn invalidated the whole downstream prefix and
the module pool, the rulepack expertise, the style layer and the skill bodies were
re-read at full price. A 2026-08-07 long session burned 40% of a weekly quota partly
this way. P1 (2026-08-07) fixed the ORDER inside the system prompt; M20 A1/A2 fixed
the two things that made the fix stop at the system message:

- the volatile tail sat INSIDE the system message, so everything after it — all of
  the replayed history — was recomputed every turn anyway. It now rides a `state`
  message just before the player's, and the wire layout is
  ``[system: stable] [history] [state: volatile] [user]`` with breakpoints at the end
  of the system message and the end of history.
- the 20-message sliding window dropped its front message once at the cap, so no
  downstream prefix could be stable either. History is now append-only between folds.

Two acceptance tests carry this, and they test different things:

- ``test_the_stable_head_is_stable_in_fact`` — the SECTION ROUTING is honest (nothing
  that varies per turn hides in the head). Structural; needs no model.
- ``test_the_cached_prefix_survives_the_next_turn`` — the LAYOUT delivers, measured on
  what the loop actually put on the wire across two consecutive real turns. This is
  the only test here that can prove the milestone paid for itself; if it fails, the
  stage did not land, whatever the section-order tests say.
"""

from __future__ import annotations

import json
import os
from copy import deepcopy

from agent.chronicle import CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID
from agent.context import AgentCtx
from agent.history import load_chain
from agent.loop import run_kp_turn
from agent.prompt_builder import build_system_prompt_parts
from agent.services import build_services
from agent.tools import Toolset, tool
from core.modvars import define_modvar, set_modvar
from core.relationships import RelationshipManager
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import CACHE_BREAKPOINT_KEY, HISTORY_TURN_KEY, ChatResult, FakeLLM, tool_call, wire_messages
from infra.providers import to_anthropic_messages

CHAT = "cache-layout-room"
SECRET = "SENTINEL_THE_LIGHTHOUSE_KEEPER"


class _ClockProvider:
    """One inert tool, so a turn can run several tool rounds deterministically."""

    @tool
    async def lookup_time(self, ctx: AgentCtx) -> str:
        """Look up the current in-game time."""
        return "1926-03-15 16:40"


def _services(llm=None):
    return build_services(Settings(locale="en"), llm=llm or FakeLLM(), embeddings=FakeEmbeddings(64))


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


def _cached_prefix(messages: list[dict]) -> list[dict]:
    """The messages up to and including the LAST cache breakpoint — the span a provider
    is asked to reuse, and therefore the span that has to stay byte-identical."""
    marked = [index for index, message in enumerate(messages) if message.get(CACHE_BREAKPOINT_KEY)]
    assert marked, "the loop marked no cache breakpoint at all"
    return messages[: marked[-1] + 1]


# ---------------------------------------------------------------------------
# A1/A2 — the acceptance oracle: what the loop actually put on the wire
# ---------------------------------------------------------------------------


async def test_the_cached_prefix_survives_the_next_turn():
    """THE M20 A1/A2 acceptance criterion.

    Two consecutive turns inside one fold interval: turn 2's request must still open
    with turn 1's ENTIRE cached prefix, byte for byte. That is exactly what a provider
    checks, and it is what neither half of the milestone delivers alone — leaving the
    volatile tail in the system message breaks it at message 0, and a sliding window
    breaks it at the front of history.
    """
    sent: list[list[dict]] = []

    def responder(messages, tools):
        sent.append(deepcopy(messages))  # the loop mutates its list in place
        return ChatResult(content="The night passes quietly.", tool_calls=[])

    services = _services(FakeLLM(responder=responder))
    await _furnished_room(services)

    # `sent` is cleared between turns because one TURN can make several calls (a
    # corrective round); what this test compares is each turn's FIRST request.
    await run_kp_turn(_ctx(), services, Toolset(), "I wait by the window.")
    first = _cached_prefix(sent[0])
    sent.clear()
    # Move exactly what a turn moves. None of it may disturb the cached prefix.
    await set_modvar(services.documents, CHAT, "doom", 7)
    await services.battles.add_key_event(CHAT, "They found the cellar door.")
    await run_kp_turn(_ctx(), services, Toolset(), "I keep waiting.")
    second = _cached_prefix(sent[0])

    assert first == second[: len(first)], (
        "the cached prefix did not survive the turn. Whatever changed inside it costs the "
        "whole downstream context at full price every turn — that is the bug M20 A1/A2 fixed."
    )
    # ...and turn 2 really did extend it (the previous exchange was appended, not dropped).
    assert len(second) > len(first), "turn 2 replayed no more history than turn 1 — is the window back?"


async def test_the_wire_layout_is_stable_head_history_state_player():
    """The message order the breakpoints depend on, asserted as a shape."""
    sent: list[list[dict]] = []

    def responder(messages, tools):
        sent.append(deepcopy(messages))
        return ChatResult(content="The door swings inward.", tool_calls=[])

    services = _services(FakeLLM(responder=responder))
    await _furnished_room(services)
    i18n = services.i18n.with_locale("en")

    await run_kp_turn(_ctx(), services, Toolset(), "I knock.")
    await run_kp_turn(_ctx(), services, Toolset(), "I wait.")

    messages = sent[-1]
    assert messages[0]["role"] == "system"
    assert messages[0][CACHE_BREAKPOINT_KEY] is True, "breakpoint 1 sits at the end of the stable head"
    assert i18n.t("prompt.game_state.title") not in messages[0]["content"], "volatile state left the system message"

    state, player = messages[-2], messages[-1]
    assert player == {"role": "user", "content": "I wait."}, "the player's own words stay last, and verbatim"
    assert state["role"] == "user" and state["content"].startswith(i18n.t("prompt.state_header"))
    assert i18n.t("prompt.game_state.title") in state["content"], "the volatile tail rides the state message"

    history = messages[1:-2]
    assert [message["role"] for message in history] == ["user", "assistant"], "one prior exchange replayed"
    assert history[-1][CACHE_BREAKPOINT_KEY] is True, "breakpoint 2 sits at the end of history"
    assert sum(1 for message in messages if message.get(CACHE_BREAKPOINT_KEY)) == 2, "two breakpoints, no more"


async def test_the_in_turn_breakpoint_follows_the_tool_loop():
    """A(3): the third breakpoint rides the newest tool result.

    Within one turn the tail is rebuilt on every round, so without this each of up to 12
    rounds recomputes the whole accumulating tool transcript. The mark MOVES rather than
    accumulating: four breakpoints is the ceiling and the head and history already hold
    two, and a stale in-turn mark would be a write nothing reads.
    """
    sent: list[list[dict]] = []

    def responder(messages, tools):
        sent.append(deepcopy(messages))
        return (
            ChatResult(content=None, tool_calls=[tool_call("lookup_time")])
            if len(sent) < 3
            else ChatResult(content="It is late afternoon.", tool_calls=[])
        )

    services = _services(FakeLLM(responder=responder))
    await _furnished_room(services)

    await run_kp_turn(_ctx(), services, Toolset(_ClockProvider()), "What time is it?")

    def marks(messages: list[dict]) -> list[int]:
        return [index for index, message in enumerate(messages) if message.get(CACHE_BREAKPOINT_KEY)]

    assert marks(sent[0]) == [0], "round 1 has no tool results yet — head only, this room's first turn"
    round_two, round_three = sent[1], sent[2]
    assert len(marks(round_two)) == 2 and round_two[marks(round_two)[-1]]["role"] == "tool"
    assert len(marks(round_three)) == 2, "at most one in-turn mark survives; the old one is cleared"
    assert round_three[marks(round_three)[-1]]["role"] == "tool"
    assert marks(round_three)[-1] > marks(round_two)[-1], "the mark moved forward with the loop"
    assert len(marks(round_three)) <= 4, "the API allows four breakpoints, no more"


async def test_a_deviating_one_shot_call_carries_no_breakpoints():
    """The max-rounds finalizer sends `tools=[]`. On Anthropic the tool list sits ahead
    of system and messages, so nothing below it can hit — a mark there buys a 1.25x write
    that is never read back, and it runs at the moment the prefix is largest."""
    sent: list[tuple[list[dict], list[dict] | None]] = []

    def responder(messages, tools):
        sent.append((deepcopy(messages), tools))
        return ChatResult(content=None, tool_calls=[tool_call("lookup_time")])

    services = _services(FakeLLM(responder=responder))
    await _furnished_room(services)

    await run_kp_turn(_ctx(), services, Toolset(_ClockProvider()), "What time is it?", max_rounds=2)

    finalizer_messages, finalizer_tools = sent[-1]
    assert finalizer_tools == [], "this is the tools-disabled finalizer"
    assert not any(message.get(CACHE_BREAKPOINT_KEY) for message in finalizer_messages)


async def test_a_first_turn_marks_only_the_system_breakpoint():
    """No history yet: there is one boundary, and marking a second would put a
    breakpoint on content that changes every turn."""
    sent: list[list[dict]] = []

    def responder(messages, tools):
        sent.append(deepcopy(messages))
        return ChatResult(content="You are alone on the pier.", tool_calls=[])

    services = _services(FakeLLM(responder=responder))
    await _furnished_room(services)

    await run_kp_turn(_ctx(), services, Toolset(), "I look around.")

    assert [message.get(CACHE_BREAKPOINT_KEY) for message in sent[0]] == [True, None, None]


# ---------------------------------------------------------------------------
# A2 — history is append-only between folds
# ---------------------------------------------------------------------------


async def test_history_grows_without_a_cap_and_is_stamped_with_its_turn():
    """The sliding window is gone: 30 exchanges replay 60 messages, not 20. Each is
    stamped with the turn that wrote it — the handle the fold cuts on."""
    services = _services(FakeLLM(responder=lambda messages, tools: ChatResult(content="Noted.", tool_calls=[])))
    await _furnished_room(services)

    for index in range(30):
        await run_kp_turn(_ctx(), services, Toolset(), f"turn {index}")

    stored = await load_chain(services, CHAT, "chat_history")
    assert len(stored) == 60, f"history was truncated somewhere other than a fold: {len(stored)} messages"
    assert [message[HISTORY_TURN_KEY] for message in stored[:4]] == [1, 1, 2, 2]
    assert stored[-1][HISTORY_TURN_KEY] == 30


async def test_a_fold_trims_history_to_what_the_summary_does_not_cover():
    """The one truncation point. Everything the rolling summary absorbed stops being
    REPLAYED; everything past its watermark still is.

    "Stops being replayed" is now the whole of it: since M20 D the tree is append-only, so
    a fold deletes nothing — it moves a watermark, and the folded records simply are not
    on the replayed slice. That is also what makes them still reachable by an undo whose
    depth is capped inside the lag window."""
    services = _services(FakeLLM(responder=lambda messages, tools: ChatResult(content="Noted.", tool_calls=[])))
    await _furnished_room(services)

    for index in range(6):
        await run_kp_turn(_ctx(), services, Toolset(), f"turn {index}")

    # The summary now covers everything through turn 3 (what a fold writes).
    await services.documents.put(
        CHAT, CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID, {"text": "The party reached the lighthouse.", "through_turn": 3, "fold_count": 1}
    )
    sent: list[list[dict]] = []

    def responder(messages, tools):
        sent.append(deepcopy(messages))
        return ChatResult(content="Noted.", tool_calls=[])

    services.llm = FakeLLM(responder=responder)
    await run_kp_turn(_ctx(), services, Toolset(), "turn 6")

    replayed = [message for message in sent[0] if message.get(HISTORY_TURN_KEY)]
    assert {message[HISTORY_TURN_KEY] for message in replayed} == {4, 5, 6}
    kept = await load_chain(services, CHAT, "chat_history")
    assert min(message[HISTORY_TURN_KEY] for message in kept) == 1, "append-only: the folded turns are still there"
    assert max(message[HISTORY_TURN_KEY] for message in kept) == 7


async def test_the_trim_is_idempotent_so_a_manual_fold_is_honoured_too():
    """Keying off the summary's cumulative watermark (not this turn's fold outcome) is
    what makes `.chronicle fold` — which runs outside the loop — take effect."""
    services = _services(FakeLLM(responder=lambda messages, tools: ChatResult(content="Noted.", tool_calls=[])))
    await _furnished_room(services)
    for index in range(4):
        await run_kp_turn(_ctx(), services, Toolset(), f"turn {index}")

    await services.documents.put(CHAT, CAMPAIGN_SUMMARY_DOC_TYPE, CAMPAIGN_SUMMARY_ID, {"text": "So far…", "through_turn": 2, "fold_count": 1})
    sent: list[list[dict]] = []

    def responder(messages, tools):
        sent.append(deepcopy(messages))
        return ChatResult(content="Noted.", tool_calls=[])

    services.llm = FakeLLM(responder=responder)
    await run_kp_turn(_ctx(), services, Toolset(), "turn 4")
    await run_kp_turn(_ctx(), services, Toolset(), "turn 5")

    def oldest_replayed(messages: list[dict]) -> int:
        return min(message[HISTORY_TURN_KEY] for message in messages if message.get(HISTORY_TURN_KEY))

    assert oldest_replayed(sent[0]) == 3
    assert oldest_replayed(sent[1]) == 3, "a settled watermark must not keep cutting"


# ---------------------------------------------------------------------------
# P1 — the section routing that makes the head cacheable in the first place
# ---------------------------------------------------------------------------


async def test_the_stable_head_is_stable_in_fact():
    """Reordering only helps if the head is stable IN FACT, and "in fact" is not something
    a section list can promise — a section that quietly varies per turn (a retrieval, a
    timestamp, a shuffled list) silently costs the whole prefix. So: build the prompt twice
    for ONE room with only STATE changed between builds."""
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
    assert _common_prefix(before.stable, after.stable) == len(before.stable), (
        "the cacheable head broke early. Some section in it varies per turn — find it and "
        "move it to the tail."
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


async def test_the_assembler_still_returns_one_object():
    """Iron rule #5 after its 2026-08-10 rewrite: the invariant is ONE assembler
    returning ONE object. Where the halves land on the wire is the loop's business —
    but nothing outside `prompt_builder` may build a segment."""
    services = _services()
    await _furnished_room(services)

    prompt = await build_system_prompt_parts(_ctx(), services)

    assert prompt.text == prompt.stable + "\n\n" + prompt.volatile


# ---------------------------------------------------------------------------
# The marker is agent->adapter metadata, on every provider path
# ---------------------------------------------------------------------------


def test_the_private_keys_never_reach_a_vendor_wire():
    """A vendor rejects unknown message properties, so leaking either key would be an
    HTTP 400 on every turn, not a cosmetic bug."""
    messages = [
        {"role": "system", "content": "stable head", CACHE_BREAKPOINT_KEY: True},
        {"role": "assistant", "content": "hi", "provider_blocks": [{"type": "thinking"}], HISTORY_TURN_KEY: 4},
        {"role": "user", "content": "I open the door"},
    ]

    wired = wire_messages(messages)

    assert all(CACHE_BREAKPOINT_KEY not in message for message in wired)
    assert all(HISTORY_TURN_KEY not in message for message in wired)
    assert all("provider_blocks" not in message for message in wired)
    assert [message["role"] for message in wired] == ["system", "assistant", "user"]
    assert wired[0]["content"] == "stable head", "only the private keys go"
    # Untouched input is returned as-is: a turn with no metadata pays nothing.
    plain = [{"role": "user", "content": "x"}]
    assert wire_messages(plain) is plain


def test_the_anthropic_path_turns_the_marks_into_cache_breakpoints():
    """Message-level now: breakpoint 1 is the whole system value, breakpoint 2 lands on
    the last content block of the last replayed history message.

    Lifetimes differ by ROLE, not by position: the stable head survives the gap between
    two turns at a live table (1 hour), the end of history does not need to (5-minute
    default), and "longer TTL first" holds automatically because system always leads."""
    system, turns = to_anthropic_messages(
        [
            {"role": "system", "content": "STABLE HEAD", CACHE_BREAKPOINT_KEY: True},
            {"role": "user", "content": "I knock", HISTORY_TURN_KEY: 1},
            {"role": "assistant", "content": "Nobody answers.", HISTORY_TURN_KEY: 1, CACHE_BREAKPOINT_KEY: True},
            {"role": "user", "content": "STATE\n\nDoom: 7"},
            {"role": "user", "content": "I wait"},
        ]
    )

    assert system == [{"type": "text", "text": "STABLE HEAD", "cache_control": {"type": "ephemeral", "ttl": "1h"}}]
    assert turns == [
        {"role": "user", "content": "I knock"},
        {"role": "assistant", "content": [{"type": "text", "text": "Nobody answers.", "cache_control": {"type": "ephemeral"}}]},
        {"role": "user", "content": "STATE\n\nDoom: 7"},
        {"role": "user", "content": "I wait"},
    ]


def test_the_marker_itself_never_learns_about_ttl():
    """TTL is one vendor's pricing model, so it lives inside that vendor's adapter. The
    agent->adapter marker stays a boolean: every other provider path merely strips it,
    and "TTL" does not even name the same quantity elsewhere (a write multiplier here,
    rented idle minutes at Moonshot, nothing at all at DeepSeek)."""
    marked = {"role": "system", "content": "HEAD", CACHE_BREAKPOINT_KEY: True}

    assert marked[CACHE_BREAKPOINT_KEY] is True
    assert not any("ttl" in str(key).lower() for key in marked)
    assert all(CACHE_BREAKPOINT_KEY not in message for message in wire_messages([marked]))

    # Unmarked stays plain — an unmarked prompt must not silently acquire a breakpoint.
    plain, plain_turns = to_anthropic_messages(
        [{"role": "system", "content": "just a prompt"}, {"role": "user", "content": "hello"}]
    )
    assert plain == "just a prompt"
    assert plain_turns == [{"role": "user", "content": "hello"}]


def test_a_breakpoint_on_a_tool_result_lands_on_its_block():
    """The tool loop's own messages can carry a mark too; the block, not the turn, is
    what `cache_control` attaches to."""
    _, turns = to_anthropic_messages(
        [
            {"role": "tool", "tool_call_id": "call_1", "content": "42", CACHE_BREAKPOINT_KEY: True},
        ]
    )

    assert turns == [
        {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "call_1",
                    "content": "42",
                    "cache_control": {"type": "ephemeral"},
                }
            ],
        }
    ]


def test_an_empty_message_never_acquires_a_breakpoint():
    """`cache_control` on an empty text block is rejected by the API, and there is
    nothing there worth caching anyway."""
    system, turns = to_anthropic_messages(
        [{"role": "system", "content": "", CACHE_BREAKPOINT_KEY: True}, {"role": "user", "content": "", CACHE_BREAKPOINT_KEY: True}]
    )

    assert system is None
    assert turns == [{"role": "user", "content": ""}]


def test_the_scribe_stays_off_for_this_module():
    # Guards the suite-wide conftest contract these tests rely on for determinism.
    assert os.environ.get("TRPG_SCRIBE__ENABLED") == "0"
