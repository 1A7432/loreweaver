"""Tests for `agent.card_text` + the consumption-time render hooks in the NPC/companion actors
(M12 SillyTavern-card compatibility): card-derived record prose containing EJS templates and
``{{user}}``/``{{char}}`` macros is rendered when the actor prompt is BUILT -- against the
PLAYER view of the room's variables only (iron rule #3), read-only, fail-safe.

This module pins ``enable_full_ejs=False`` wherever a template must go through the
`core.ejs_lite` subset, so the subset path is tested UNCONDITIONALLY (no quickjs required);
the full-engine path lives in `test_card_text_render_ejs_full.py` (quickjs-guarded). The
fail-safe test runs on DEFAULT settings on purpose: whichever renderer picks the text up,
raw ``<% %>`` must never reach the model.
"""

from __future__ import annotations

import json

from agent.companion_actor import companion_action
from agent.context import AgentCtx
from agent.kp_tools_npc import NpcTools
from agent.npc import NpcRecord
from agent.npc_actor import voice_npc
from agent.services import build_services
from core.character_manager import CharacterSheet
from core.modvars import ModvarManager, build_spec
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, assistant_text

CHAT_KEY = "card-render-room"
KEEPER_SENTINEL = "THE HARBORMASTER DID IT"

_NPC_REPLY = {"dialogue": "Aye.", "action_intent": "", "mood": "calm"}
_COMPANION_REPLY = {"action": "I follow.", "dialogue": "Right behind you."}


def _recording_services(recorded: list[list[dict]], reply: dict, **settings_overrides):
    """FakeLLM services whose every `chat()` call lands in `recorded` (messages only)."""

    def responder(messages, tools):
        recorded.append(messages)
        return assistant_text(json.dumps(reply))

    return build_services(
        Settings(**settings_overrides), llm=FakeLLM(responder=responder), embeddings=FakeEmbeddings(8)
    )


def _prompt_text(recorded: list[list[dict]]) -> str:
    """All message content of the LAST recorded LLM call, joined (system + user)."""
    return "\n".join(str(message.get("content") or "") for message in recorded[-1])


async def _define_player_fear(services, value: int = 6) -> None:
    manager = ModvarManager(services.store)
    await manager.define(CHAT_KEY, build_spec("fear", "number", visibility="player", minimum=0, maximum=10))
    await manager.set(CHAT_KEY, "fear", value)


async def _define_keeper_culprit(services) -> None:
    manager = ModvarManager(services.store)
    await manager.define(CHAT_KEY, build_spec("true_culprit", "text", visibility="keeper"))
    await manager.set(CHAT_KEY, "true_culprit", KEEPER_SENTINEL)


# ---------------------------------------------------------------------------
# (a) EJS templates render per the CURRENT variables, at consumption time
# ---------------------------------------------------------------------------


async def test_npc_persona_ejs_conditional_renders_per_current_variables():
    recorded: list[list[dict]] = []
    services = _recording_services(recorded, _NPC_REPLY, enable_full_ejs=False)
    await _define_player_fear(services, 6)

    npc = NpcRecord(
        id="dockhand",
        name="Old Tomas",
        persona=(
            "A dockhand.<% if (getvar('fear') >= 5) { %> He is terrified of the harbor."
            "<% } else { %> He is calm tonight.<% } %>"
        ),
    )

    await voice_npc(services, npc, "A stranger approaches.", chat_key=CHAT_KEY)
    system_content = recorded[-1][0]["content"]
    assert "He is terrified of the harbor." in system_content
    assert "He is calm tonight." not in system_content
    assert "<%" not in system_content and "%>" not in system_content

    # Consumption-time, not import-time: the SAME stored text re-renders against the NEW state.
    await ModvarManager(services.store).set(CHAT_KEY, "fear", 2)
    await voice_npc(services, npc, "The stranger returns the next day.", chat_key=CHAT_KEY)
    system_content = recorded[-1][0]["content"]
    assert "He is calm tonight." in system_content
    assert "He is terrified of the harbor." not in system_content


async def test_voice_npc_does_not_mutate_the_caller_supplied_record():
    recorded: list[list[dict]] = []
    services = _recording_services(recorded, _NPC_REPLY, enable_full_ejs=False)
    raw_persona = "<% if (getvar('fear') >= 5) { %>terrified<% } else { %>calm<% } %>"
    npc = NpcRecord(id="dockhand", name="Old Tomas", persona=raw_persona, knowledge=["{{char}} owes rent."])

    await voice_npc(services, npc, "...", chat_key=CHAT_KEY)

    # The record keeps the RAW authored text -- rendering happened on a copy.
    assert npc.persona == raw_persona
    assert npc.knowledge == ["{{char}} owes rent."]


# ---------------------------------------------------------------------------
# (b) {{char}} / {{user}} macros
# ---------------------------------------------------------------------------


async def test_char_and_user_macros_resolve_to_actor_and_active_pc_names():
    recorded: list[list[dict]] = []
    services = _recording_services(recorded, _NPC_REPLY, enable_full_ejs=False)
    await services.characters.save_character("u1", CHAT_KEY, CharacterSheet(name="Harvey Walters", system="CoC"))

    npc = NpcRecord(id="martha", name="Martha", persona="{{char}} watches {{user}} closely.")
    await voice_npc(services, npc, "...", chat_key=CHAT_KEY, user_uid="u1")

    assert "Martha watches Harvey Walters closely." in recorded[-1][0]["content"]


async def test_user_macro_left_untouched_without_a_meaningful_uid():
    recorded: list[list[dict]] = []
    services = _recording_services(recorded, _NPC_REPLY, enable_full_ejs=False)
    npc = NpcRecord(id="martha", name="Martha", persona="{{char}} watches {{user}} closely.")

    # No uid at all.
    await voice_npc(services, npc, "...", chat_key=CHAT_KEY)
    assert "Martha watches {{user}} closely." in recorded[-1][0]["content"]

    # A uid with NO bound character (get_character resolves to the "default" sentinel sheet):
    # the sentinel slot name must not leak in as the user's name.
    await voice_npc(services, npc, "...", chat_key=CHAT_KEY, user_uid="nobody-here")
    assert "Martha watches {{user}} closely." in recorded[-1][0]["content"]
    assert "Martha watches default closely." not in recorded[-1][0]["content"]


# ---------------------------------------------------------------------------
# (c) RED LINE -- keeper-only modvars are structurally invisible to actor prompts
# ---------------------------------------------------------------------------


async def test_keeper_only_modvar_value_appears_nowhere_in_the_actor_prompt():
    recorded: list[list[dict]] = []
    services = _recording_services(recorded, _NPC_REPLY, enable_full_ejs=False)
    await _define_keeper_culprit(services)
    await _define_player_fear(services, 6)  # positive control: player-visible values DO render

    npc = NpcRecord(
        id="martha",
        name="Martha",
        persona=(
            "<% if (getvar('true_culprit')) { %>She whispers: <%= getvar('true_culprit') %>."
            "<% } else { %>She knows nothing of culprits.<% } %>"
            " Note: {{getvar::true_culprit}}(end). Fear stands at <%= getvar('fear') %>."
        ),
    )
    await voice_npc(services, npc, "A stranger asks who did it.", chat_key=CHAT_KEY, user_uid="u1")

    everything = _prompt_text(recorded)
    # The red line: the keeper-only VALUE appears nowhere in anything the actor was handed.
    assert KEEPER_SENTINEL not in everything
    # The branch reading it behaves as if the variable were UNSET (fail-closed else branch).
    assert "She knows nothing of culprits." in everything
    assert "Note: (end)." in everything  # {{getvar::...}} of a keeper var renders as ""
    # Positive control: the player-visible variable rendered normally.
    assert "Fear stands at 6." in everything
    assert "<%" not in everything and "%>" not in everything


async def test_template_setvar_writes_are_discarded_on_the_actor_path():
    recorded: list[list[dict]] = []
    services = _recording_services(recorded, _NPC_REPLY, enable_full_ejs=False)
    await _define_player_fear(services, 6)

    npc = NpcRecord(id="martha", name="Martha", persona="<% setvar('fear', 0) %>She breathes.")
    await voice_npc(services, npc, "...", chat_key=CHAT_KEY)

    assert "She breathes." in recorded[-1][0]["content"]
    state = await ModvarManager(services.store).load(CHAT_KEY)
    assert state["values"]["fear"] == 6  # actor-side rendering is read-only


# ---------------------------------------------------------------------------
# (d) raw <% %> never reaches an actor prompt -- DEFAULT settings, any renderer
# ---------------------------------------------------------------------------


async def test_raw_template_syntax_never_reaches_the_actor_prompt_even_when_unbalanced():
    recorded: list[list[dict]] = []
    services = _recording_services(recorded, _NPC_REPLY)  # DEFAULT settings (full EJS on if present)
    await _define_player_fear(services, 6)

    npc = NpcRecord(
        id="martha",
        name="Martha",
        persona="Broken:<% if (getvar('fear') >= 5) { %> half-open with no close",
        style="also broken <%= ",
    )
    await voice_npc(services, npc, "...", chat_key=CHAT_KEY)

    everything = _prompt_text(recorded)
    assert "<%" not in everything and "%>" not in everything
    assert "half-open with no close" in everything  # plain text survives the fail-safe strip


async def test_templates_are_stripped_fail_safe_even_without_a_room_context():
    recorded: list[list[dict]] = []
    services = _recording_services(recorded, _NPC_REPLY, enable_full_ejs=False)

    npc = NpcRecord(id="martha", name="Martha", persona="<% if (getvar('fear') >= 5) { %>afraid<% } %>ready.")
    await voice_npc(services, npc, "...")  # no chat_key: empty variable space, still no raw tags

    everything = _prompt_text(recorded)
    assert "<%" not in everything and "%>" not in everything
    assert "ready." in everything


# ---------------------------------------------------------------------------
# Companion actor -- same hook, same red line
# ---------------------------------------------------------------------------


async def test_companion_persona_and_playstyle_render_templates_and_macros():
    recorded: list[list[dict]] = []
    services = _recording_services(recorded, _COMPANION_REPLY, enable_full_ejs=False)
    await _define_player_fear(services, 6)
    await _define_keeper_culprit(services)
    await services.characters.save_character("u1", CHAT_KEY, CharacterSheet(name="Harvey Walters", system="CoC"))

    companion = NpcRecord(
        id="ash",
        name="Ash",
        role="player_companion",
        is_pc=True,
        persona=(
            "{{char}} guards {{user}}.<% if (getvar('fear') >= 5) { %> Nerves frayed.<% } %>"
            " Secret check: {{getvar::true_culprit}}(none)."
        ),
        playstyle="cautious, {{char}} scouts ahead",
    )
    sheet = CharacterSheet(name="Ash", system="CoC")

    await companion_action(services, companion, sheet, "The door creaks.", chat_key=CHAT_KEY, user_uid="u1")

    everything = _prompt_text(recorded)
    assert "Ash guards Harvey Walters." in everything
    assert "Nerves frayed." in everything
    assert "cautious, Ash scouts ahead" in everything
    assert "Secret check: (none)." in everything
    assert KEEPER_SENTINEL not in everything
    assert "<%" not in everything and "%>" not in everything


# ---------------------------------------------------------------------------
# Call-site threading -- speak_as_npc passes the room/user context down
# ---------------------------------------------------------------------------


async def test_speak_as_npc_threads_room_variables_and_active_pc_into_the_actor_prompt():
    recorded: list[list[dict]] = []
    services = _recording_services(recorded, _NPC_REPLY, enable_full_ejs=False)
    await _define_player_fear(services, 6)
    await services.characters.save_character("u1", CHAT_KEY, CharacterSheet(name="Harvey Walters", system="CoC"))

    tools = NpcTools(services)
    ctx = AgentCtx(chat_key=CHAT_KEY, user_id="u1", locale="en")
    await tools.create_npc(
        ctx,
        name="Martha",
        persona="{{char}} eyes {{user}}.<% if (getvar('fear') >= 5) { %> The room is tense.<% } %>",
    )

    await tools.speak_as_npc(ctx, npc="Martha", situation="A question hangs in the air.")

    system_content = recorded[-1][0]["content"]
    assert "Martha eyes Harvey Walters." in system_content
    assert "The room is tense." in system_content
    assert "<%" not in system_content and "%>" not in system_content
