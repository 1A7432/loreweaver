"""Tests for agent.prompt_builder.build_system_prompt: assembling the 6
core.prompt_sections builders (per docs/specs/M1.md §6.4) into the full
AI-KP system prompt for one turn, through the real `build_services` wiring
(FakeLLM/FakeEmbeddings keep everything offline and deterministic).
"""

from __future__ import annotations

import json

from agent.context import AgentCtx
from agent.prompt_builder import build_system_prompt
from agent.services import build_services
from core.prompt_sections import (
    inject_document_context_prompt,
    inject_game_state_prompt,
    inject_interaction_style_prompt,
    inject_session_history_prompt,
    inject_session_recap_prompt,
    inject_system_expertise_prompt,
    inject_trpg_system_prompt,
)
from core.relationships import RelationshipManager
from core.worldbook import inject_world_lore_prompt
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM

SENTINEL_SECRET = "SENTINEL_ONLY_THE_HARBORMASTER_KNOWS"


def _services(locale: str = "en"):
    settings = Settings(locale=locale)
    return build_services(settings, llm=FakeLLM(), embeddings=FakeEmbeddings(64))


async def _seed_ready_keeper_pool(services, chat_key: str) -> None:
    await services.store.set(user_key="", store_key=f"module_init_status.{chat_key}", value="ready")
    await services.store.set(
        user_key="",
        store_key=f"module_keeper_pool.{chat_key}",
        value=json.dumps(
            {
                "summary": "A quiet fishing town hides a cult beneath the lighthouse.",
                "truths": [{"name": "The Truth", "description": SENTINEL_SECRET}],
            },
            ensure_ascii=False,
        ),
    )
    await services.store.set(
        user_key="",
        store_key=f"module_player_pool.{chat_key}",
        value=json.dumps({"summary": "A quiet fishing town."}, ensure_ascii=False),
    )


async def _seed_last_session(services, chat_key: str) -> None:
    await services.battles.start_session(chat_key, session_name="Session Zero")
    await services.battles.add_key_event(chat_key, "The party arrived in town.")
    await services.battles.generate_battle_report(chat_key)


async def test_build_system_prompt_includes_keeper_discipline_and_joins_all_six_sections_in_order():
    services = _services("en")
    chat_key = "chat-prompt-builder"
    ctx = AgentCtx(chat_key=chat_key, user_id="u1", locale="en")

    await _seed_ready_keeper_pool(services, chat_key)
    await _seed_last_session(services, chat_key)

    prompt = await build_system_prompt(ctx, services)
    i18n = services.i18n.with_locale("en")

    # Red-line: the localized keeper-secrecy discipline block must be present
    # (it rides in via inject_document_context_prompt whenever a ready
    # keeper pool exists), and so — for reasoning purposes — must the secret
    # itself (the discipline text is what prevents it leaking into OUTPUT,
    # not its absence from the prompt).
    assert i18n.t("prompt.keeper_discipline") in prompt
    assert SENTINEL_SECRET in prompt

    # All 6 sections contributed non-empty content, in the exact order the
    # M1 spec requires: session_history, game_state, document_context,
    # system_expertise, trpg_system, interaction_style.
    markers = [
        i18n.t("battle.summary.title"),  # session_history
        i18n.t("prompt.game_state.title"),  # game_state
        i18n.t("prompt.document.pool_title"),  # document_context
        i18n.t("prompt.expertise.coc"),  # system_expertise (no character -> defaults to CoC)
        i18n.t("prompt.system.tools_header"),  # trpg_system
        i18n.t("prompt.style.narrative"),  # interaction_style
    ]
    positions = [prompt.index(marker) for marker in markers]
    assert positions == sorted(positions), "sections must appear in the fixed §6.4 order"

    # Consecutive non-empty sections are joined by a blank line.
    assert "\n\n" in prompt


async def test_build_system_prompt_is_localized_per_ctx_locale():
    services = _services("en")  # process-wide default is en; ctx below asks for zh
    chat_key = "chat-prompt-builder-zh"
    ctx = AgentCtx(chat_key=chat_key, user_id="u1", locale="zh")

    await _seed_ready_keeper_pool(services, chat_key)

    prompt = await build_system_prompt(ctx, services)
    zh = services.i18n.with_locale("zh")

    assert zh.t("prompt.keeper_discipline") in prompt
    assert zh.t("prompt.game_state.title") in prompt
    assert SENTINEL_SECRET in prompt


async def test_build_system_prompt_survives_a_brand_new_chat_with_no_seeded_state():
    services = _services("en")
    ctx = AgentCtx(chat_key="chat-prompt-builder-empty", user_id="u1", locale="en")

    prompt = await build_system_prompt(ctx, services)

    # No prior session, no module pool: the always-on framing sections still
    # render, and there is no keeper-discipline block to leak in.
    i18n = services.i18n.with_locale("en")
    assert prompt
    assert i18n.t("prompt.game_state.title") in prompt
    assert i18n.t("prompt.style.narrative") in prompt
    assert i18n.t("prompt.keeper_discipline") not in prompt


# ---------------------------------------------------------------------------
# Deterministic relationship tracks (好感/情欲, core.relationships) fold-in --
# the last section, read straight off the store like the skills block above.
# ---------------------------------------------------------------------------


async def test_build_system_prompt_with_no_relationship_state_is_byte_identical_to_before():
    """CRITICAL INVARIANT: a chat with no relationship tracks ever set must assemble EXACTLY the
    same prompt as the pre-relationships assembly logic (the 6 sections + skills fold-in, joined
    the same way) -- the fold-in contributes nothing at all, not even an empty header, when the
    room's relationship state is empty."""
    services = _services("en")
    chat_key = "chat-prompt-builder-no-relationships"
    ctx = AgentCtx(chat_key=chat_key, user_id="u1", locale="en")

    await _seed_ready_keeper_pool(services, chat_key)
    await _seed_last_session(services, chat_key)

    i18n = services.i18n.with_locale("en")
    session_history = await inject_session_history_prompt(ctx, services.battles, i18n)
    session_recap = await inject_session_recap_prompt(ctx, services.store, i18n)
    document_context = await inject_document_context_prompt(
        ctx, services.vector_db, services.store, i18n, services.settings.enable_vector_db
    )
    extra = getattr(ctx, "extra", {}) or {}
    recent_context = "\n".join(part for part in (session_history, str(extra.get("user_message", "") or "")) if part)
    world_lore = await inject_world_lore_prompt(ctx, services.worldbook, i18n, role="keeper", recent_context=recent_context)
    legacy_sections = [
        session_history,
        session_recap,
        await inject_game_state_prompt(ctx, services.characters, services.store, i18n),
        document_context,
        world_lore,
        await inject_system_expertise_prompt(ctx, services.characters, i18n),
        await inject_trpg_system_prompt(ctx, i18n),
        await inject_interaction_style_prompt(ctx, i18n),
    ]
    expected = "\n\n".join(section for section in legacy_sections if section)  # no skills enabled here

    actual = await build_system_prompt(ctx, services)

    assert actual == expected
    assert i18n.t("prompt.relationships_header") not in actual


async def test_build_system_prompt_folds_in_a_set_relationship_track_as_the_last_section():
    services = _services("en")
    chat_key = "chat-prompt-builder-with-relationships"
    ctx = AgentCtx(chat_key=chat_key, user_id="u1", locale="en")

    manager = RelationshipManager(services.store)
    await manager.adjust(chat_key, "Alice", "Bob", "affection", 30)

    prompt = await build_system_prompt(ctx, services)
    i18n = services.i18n.with_locale("en")

    assert i18n.t("prompt.relationships_header") in prompt
    assert "Alice" in prompt and "Bob" in prompt
    # It's the LAST section: nothing else appears after it.
    header_pos = prompt.index(i18n.t("prompt.relationships_header"))
    assert header_pos == max(
        prompt.index(marker) for marker in (i18n.t("prompt.relationships_header"), i18n.t("prompt.game_state.title"))
    )
    assert prompt.rstrip().endswith(prompt[header_pos:].rstrip())


async def test_build_system_prompt_relationship_fold_in_is_localized_per_ctx_locale():
    services = _services("en")
    chat_key = "chat-prompt-builder-relationships-zh"
    ctx = AgentCtx(chat_key=chat_key, user_id="u1", locale="zh")

    manager = RelationshipManager(services.store)
    await manager.adjust(chat_key, "Alice", "Bob", "affection", 30)

    prompt = await build_system_prompt(ctx, services)
    zh = services.i18n.with_locale("zh")

    assert zh.t("prompt.relationships_header") in prompt
    assert zh.t("relationships.track.affection") in prompt
