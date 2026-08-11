"""Sentinel tests for the AI-NPC sub-actor's PRIVATE `action_intent` channel (audit S05).

`gateway.turn._npc_event` publishes the string `speak_as_npc` RETURNS, verbatim, as an
`npc` narrative frame to every member of the room -- that return value is therefore a
player-grade surface, not a keeper-side one. The sub-actor's `action_intent` (what the
NPC privately means to DO next, e.g. slip out the back door to warn the cult) must never
ride it, in any locale.

The session report is NOT a keeper-side surface either: `.report` is a
`required_level=0`, room-broadcast command (`gateway.commands.cmd_report`), so parking
the intent anywhere it renders would only delay the same leak.

Sentinel shape: the intent text is the secret that must not cross the boundary, and every
assertion is paired with a POSITIVE CONTROL (the dialogue/mood that SHOULD cross, and the
keeper surface that SHOULD receive the intent) so no test can pass vacuously on an empty
or failed line.
"""

from __future__ import annotations

import json

from agent.context import AgentCtx
from agent.kp_tools_npc import NpcTools
from agent.services import build_services
from core.documents import KEEPER_VIEWER, PLAYER_VIEWER
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, assistant_text

# The sub-actor's private staging information -- the sentinel for every assertion below.
INTENT_EN = "slip out the back door and warn the cult"
INTENT_ZH = "趁乱溜出后门去通知教团"


def _ctx(chat_key: str, locale: str = "en") -> AgentCtx:
    return AgentCtx(chat_key=chat_key, user_id="u1", locale=locale)


def _voiced(dialogue: str, mood: str, action_intent: str) -> FakeLLM:
    """A FakeLLM whose single reply is one NPC sub-actor JSON performance."""
    return FakeLLM(
        script=[assistant_text(json.dumps({"dialogue": dialogue, "action_intent": action_intent, "mood": mood}))]
    )


async def _room(chat_key: str, llm: FakeLLM):
    services = build_services(Settings(), llm=llm, embeddings=FakeEmbeddings(8))
    await services.battles.start_session(chat_key)
    return services


async def test_speak_as_npc_return_value_carries_no_private_action_intent():
    """The relayable line = name + mood + dialogue. Never the intent."""
    chat_key = "intent-en"
    services = await _room(chat_key, _voiced("I saw nothing that night.", "evasive", INTENT_EN))
    tools = NpcTools(services)
    ctx = _ctx(chat_key)
    await tools.create_npc(ctx, name="Mo Shen", persona="A dock-side lamplighter.")

    line = await tools.speak_as_npc(ctx, npc="Mo Shen", situation="A stranger asks what she saw.")

    # SENTINEL: the NPC's concealed plan never reaches the broadcast line.
    assert INTENT_EN not in line
    assert "back door" not in line
    # POSITIVE CONTROLS: the performed, player-visible material still does.
    assert "I saw nothing that night." in line
    assert "evasive" in line
    assert "Mo Shen" in line


async def test_speak_as_npc_return_value_carries_no_intent_in_zh_either():
    """Locale is not a boundary: the zh line dropped the 【意图：…】 block too."""
    chat_key = "intent-zh"
    services = await _room(chat_key, _voiced("……我什么都没看见。", "紧张", INTENT_ZH))
    tools = NpcTools(services)
    ctx = _ctx(chat_key, locale="zh")
    await tools.create_npc(ctx, name="沈茉", persona="码头上的点灯人。")

    line = await tools.speak_as_npc(ctx, npc="沈茉", situation="有人问她那晚看见了什么。")

    # SENTINEL: neither the intent text nor the label that framed it.
    assert INTENT_ZH not in line
    assert "意图" not in line
    # POSITIVE CONTROLS.
    assert "……我什么都没看见。" in line
    assert "紧张" in line
    assert "沈茉" in line


async def test_speak_as_npc_intent_never_enters_the_player_facing_report():
    """`.report` is broadcast to the whole room, so the intent cannot reach it."""
    chat_key = "intent-log"
    services = await _room(chat_key, _voiced("I saw nothing that night.", "evasive", INTENT_EN))
    tools = NpcTools(services)
    ctx = _ctx(chat_key)
    await tools.create_npc(ctx, name="Mo Shen", persona="A dock-side lamplighter.")

    await tools.speak_as_npc(ctx, npc="Mo Shen", situation="A stranger asks what she saw.")

    record = await services.battles.generator.get_current_session(chat_key)
    assert record is not None
    report = services.battles.generator.generate_markdown_report(
        record, "Intent", i18n=services.i18n.with_locale("en"), transcript=[]
    )
    # SENTINEL: nothing the report renders carries the private intent.
    assert INTENT_EN not in report
    assert "back door" not in report
    # POSITIVE CONTROL: the report itself really did render.
    assert "Intent" in report


async def test_speak_as_npc_parks_the_intent_on_the_keeper_only_note_surface():
    """Staging information is not lost -- it moves to a surface players cannot project."""
    chat_key = "intent-note"
    services = await _room(chat_key, _voiced("I saw nothing that night.", "evasive", INTENT_EN))
    tools = NpcTools(services)
    ctx = _ctx(chat_key)
    await tools.create_npc(ctx, name="Mo Shen", persona="A dock-side lamplighter.")

    await tools.speak_as_npc(ctx, npc="Mo Shen", situation="A stranger asks what she saw.")

    keeper_view = await services.documents.get_view(chat_key, "note", "npc_intents", KEEPER_VIEWER)
    assert keeper_view is not None
    entries = keeper_view.get("content") or []
    # POSITIVE CONTROL for the routing: the keeper side really did receive it.
    assert any(INTENT_EN in str(entry.get("content", "")) for entry in entries)
    assert any("Mo Shen" in str(entry.get("content", "")) for entry in entries)

    # SENTINEL: that surface has no player projection at all (core.documents._project_note).
    player_view = await services.documents.get_view(chat_key, "note", "npc_intents", PLAYER_VIEWER)
    assert player_view is None


async def test_speak_as_npc_writes_no_intent_note_when_the_actor_declared_none():
    """An empty intent leaves no keeper note behind (no empty-annotation churn)."""
    chat_key = "intent-none"
    services = await _room(chat_key, _voiced("I saw nothing that night.", "evasive", ""))
    tools = NpcTools(services)
    ctx = _ctx(chat_key)
    await tools.create_npc(ctx, name="Mo Shen", persona="A dock-side lamplighter.")

    line = await tools.speak_as_npc(ctx, npc="Mo Shen", situation="A stranger asks what she saw.")

    # POSITIVE CONTROL: the line itself is unaffected.
    assert "I saw nothing that night." in line
    assert await services.documents.get_view(chat_key, "note", "npc_intents", KEEPER_VIEWER) is None
