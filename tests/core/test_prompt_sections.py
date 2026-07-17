"""Tests for core.prompt_sections.

Covers `summarize_knowledge_item`'s exact data-formatting shapes (ported
byte-for-byte from `nekro_trpg_dice_plugin`'s test_core_fixes.py) and the 6
`inject_*` section builders: each must return a localized, non-empty string
given seeded inline fakes, and must not crash given empty state. The
document-context section must carry the localized keeper-secrecy discipline
block whenever a keeper knowledge pool is present.

Managers/store/vector_db are minimal inline fakes per the M0 spec (§5):
`core.prompt_sections` is intentionally decoupled from
`core.character_manager`/`core.battle_report`, so these fakes only need to
satisfy the async method *shapes* the section builders call.
"""

import json
from dataclasses import dataclass, field
from typing import Any

from core.prompt_sections import (
    inject_document_context_prompt,
    inject_game_state_prompt,
    inject_interaction_style_prompt,
    inject_session_history_prompt,
    inject_system_expertise_prompt,
    inject_trpg_system_prompt,
    summarize_knowledge_item,
)
from infra.i18n import I18n
from infra.store import Store

EN = I18n(locale="en")
ZH = I18n(locale="zh")


@dataclass
class _Ctx:
    """The lightweight ctx object the M0 spec requires: `.chat_key` + `.user_id`."""

    chat_key: str
    user_id: str = "u1"


@dataclass
class _FakeCharacter:
    name: str = "default"
    system: str = "CoC"
    attributes: dict = field(default_factory=dict)
    secondary_attributes: dict = field(default_factory=dict)


class _FakeCharacterManager:
    def __init__(self, roster: list[dict] | None = None, character: _FakeCharacter | None = None):
        self._roster = roster if roster is not None else []
        self._character = character if character is not None else _FakeCharacter()

    async def get_party_roster(self, chat_key: str) -> list[dict]:
        return self._roster

    async def get_character(self, user_id: str, chat_key: str, char_name: str = "") -> _FakeCharacter:
        return self._character


class _RaisingCharacterManager:
    async def get_party_roster(self, chat_key: str):
        raise RuntimeError("boom")

    async def get_character(self, user_id: str, chat_key: str, char_name: str = ""):
        raise RuntimeError("boom")


class _FakeBattleReportManager:
    def __init__(self, summary: str | None = None):
        self._summary = summary

    async def get_last_session_summary(self, chat_key: str, i18n: Any = None) -> str | None:
        return self._summary


class _RaisingBattleReportManager:
    async def get_last_session_summary(self, chat_key: str, i18n: Any = None):
        raise RuntimeError("boom")


class _FakeVectorDB:
    def __init__(self, results: list[dict] | None = None):
        self._results = results if results is not None else []

    async def search_documents(self, query: str, chat_key: str, limit: int = 5) -> list[dict]:
        return self._results


# ---------------------------------------------------------------------------
# summarize_knowledge_item — exact data-formatting shapes (M0 spec §5).
# ---------------------------------------------------------------------------


def test_summarize_knowledge_item_scene_shape():
    scene = {"name": "大厅", "description": "潮湿阴冷", "focus": "探索"}
    assert summarize_knowledge_item(scene) == "- 大厅: 潮湿阴冷 (焦点: 探索)"


def test_summarize_knowledge_item_timeline_shape():
    timeline = {"time": "午夜", "event": "钟声响起"}
    assert summarize_knowledge_item(timeline) == "- 午夜: 钟声响起"


def test_summarize_knowledge_item_truth_shape():
    truth = {"name": "真相", "description": "管家是邪教徒", "revealed_by": "账本"}
    assert summarize_knowledge_item(truth) == "- 真相: 管家是邪教徒"


def test_summarize_knowledge_item_non_dict_falls_back_to_str():
    assert summarize_knowledge_item("a plain string") == "a plain string"
    assert summarize_knowledge_item(42) == "42"


def test_summarize_knowledge_item_truncates_long_detail_and_defaults_title():
    long_desc = "x" * 250
    item = {"description": long_desc}
    result = summarize_knowledge_item(item)
    # No name/title/time/event -> falls back to the literal "条目" title.
    assert result.startswith("- 条目: ")
    assert result.endswith("...")
    assert len(result) < len(f"- 条目: {long_desc}")


def test_summarize_knowledge_item_spoiler_free_extras_join_with_chinese_semicolon():
    item = {"name": "密室", "description": "藏有尸体", "location": "地下室", "leads_to": "真相"}
    assert summarize_knowledge_item(item) == "- 密室: 藏有尸体 (位置: 地下室；指向: 真相)"


# ---------------------------------------------------------------------------
# inject_trpg_system_prompt / inject_interaction_style_prompt — pure framing.
# ---------------------------------------------------------------------------


async def test_inject_trpg_system_prompt_is_localized_and_nonempty_en():
    ctx = _Ctx(chat_key="chat1")
    result = await inject_trpg_system_prompt(ctx, EN)
    assert result
    assert EN.t("prompt.system.tools_header") in result
    assert EN.t("prompt.system.guidelines_header") in result
    assert EN.t("prompt.system.luck_spend") in result


async def test_inject_trpg_system_prompt_is_localized_and_nonempty_zh():
    ctx = _Ctx(chat_key="chat1")
    result = await inject_trpg_system_prompt(ctx, ZH)
    assert result
    assert ZH.t("prompt.system.tools_header") in result
    assert "投掷骰子" in result
    assert ZH.t("prompt.system.luck_spend") in result


async def test_inject_interaction_style_prompt_is_localized_and_nonempty():
    ctx = _Ctx(chat_key="chat1")
    en_result = await inject_interaction_style_prompt(ctx, EN)
    zh_result = await inject_interaction_style_prompt(ctx, ZH)
    assert en_result and zh_result
    assert en_result != zh_result
    assert EN.t("prompt.style.principles") in en_result
    assert ZH.t("prompt.style.principles") in zh_result
    assert EN.t("prompt.style.actor_attribution") in en_result
    assert ZH.t("prompt.style.actor_attribution") in zh_result


async def test_inject_interaction_style_prompt_includes_freshness_and_ensemble_nudges():
    # Play-quality nudges: vary phrasing across turns + keep an unaddressed
    # companion/party member alive. Part of the interaction-style section, and
    # must never displace the dice-first tool-usage rule that shares it.
    ctx = _Ctx(chat_key="chat1")
    en_result = await inject_interaction_style_prompt(ctx, EN)
    zh_result = await inject_interaction_style_prompt(ctx, ZH)
    assert EN.t("prompt.style.freshness") in en_result
    assert ZH.t("prompt.style.freshness") in zh_result
    # The freshness bullets are additive: the dice-first tool-usage rule stays.
    assert EN.t("prompt.style.tool_usage") in en_result
    # Strengthened wording: it must explicitly warn against reusing the same SCENE-ENDING
    # image/beat across CONSECUTIVE turns (not just avoiding a repeated word).
    en_fresh = EN.t("prompt.style.freshness")
    assert "two turns in a row" in en_fresh and "END a turn" in en_fresh
    zh_fresh = ZH.t("prompt.style.freshness")
    assert "连续两回合" in zh_fresh and "收尾" in zh_fresh


# ---------------------------------------------------------------------------
# inject_system_expertise_prompt
# ---------------------------------------------------------------------------


async def test_inject_system_expertise_prompt_selects_coc_guidance():
    ctx = _Ctx(chat_key="chat1")
    manager = _FakeCharacterManager(character=_FakeCharacter(name="Ada", system="CoC"))
    result = await inject_system_expertise_prompt(ctx, manager, EN)
    assert result == EN.t("prompt.expertise.coc")


async def test_inject_system_expertise_prompt_selects_dnd5e_guidance():
    ctx = _Ctx(chat_key="chat1")
    manager = _FakeCharacterManager(character=_FakeCharacter(name="Rill", system="DnD5e"))
    result = await inject_system_expertise_prompt(ctx, manager, ZH)
    assert result == ZH.t("prompt.expertise.dnd5e")


async def test_inject_system_expertise_prompt_selects_wod_guidance():
    ctx = _Ctx(chat_key="chat1")
    manager = _FakeCharacterManager(character=_FakeCharacter(name="Vex", system="WoD"))
    result = await inject_system_expertise_prompt(ctx, manager, EN)
    assert result == EN.t("prompt.expertise.wod")


async def test_inject_system_expertise_prompt_falls_back_to_generic_guidance():
    ctx = _Ctx(chat_key="chat1")
    manager = _FakeCharacterManager(character=_FakeCharacter(name="?", system="Fate"))
    result = await inject_system_expertise_prompt(ctx, manager, EN)
    assert result == EN.t("prompt.expertise.generic")


async def test_inject_system_expertise_prompt_empty_state_does_not_crash():
    ctx = _Ctx(chat_key="chat1")
    manager = _FakeCharacterManager()  # default character, system="CoC"
    result = await inject_system_expertise_prompt(ctx, manager, EN)
    assert result == EN.t("prompt.expertise.coc")


async def test_inject_system_expertise_prompt_swallows_manager_errors():
    ctx = _Ctx(chat_key="chat1")
    result = await inject_system_expertise_prompt(ctx, _RaisingCharacterManager(), EN)
    assert result == ""


# ---------------------------------------------------------------------------
# inject_game_state_prompt
# ---------------------------------------------------------------------------


async def _seed_game_state_store(store: Store, chat_key: str, user_id: str) -> None:
    await store.set(
        user_key="",
        store_key=f"game_clock.{chat_key}",
        value=json.dumps({"current_time": "1926-03-15 14:00"}),
    )
    await store.set(
        user_key="",
        store_key=f"kp_notes.{chat_key}",
        value=json.dumps(
            {
                "current_scene": "Innsmouth docks",
                "current_focus": "Investigation",
                "npc_status": [{"content": "Zadok watches from the shadows"}],
                "confirmed_facts": [
                    {"time": "开局", "content": "You were hired to investigate a disappearance."},
                    {"time": "day1", "content": "The ship never left port."},
                ],
                "world_changes": [{"content": "The tavern door is now locked."}],
            }
        ),
    )
    await store.set(
        user_key="",
        store_key=f"module_player_pool.{chat_key}",
        value=json.dumps({"clues": [{"name": "Torn Letter", "description": "Mentions a hidden cellar."}]}),
    )
    await store.set(
        user_key=user_id,
        store_key=f"initiative.{chat_key}",
        value=json.dumps([{"name": "Alice", "init": 18}, {"name": "Cultist", "init": 12}]),
    )


async def test_inject_game_state_prompt_seeded_state_is_localized_and_nonempty():
    store = Store(":memory:")
    ctx = _Ctx(chat_key="chat1", user_id="u1")
    await _seed_game_state_store(store, ctx.chat_key, ctx.user_id)

    roster = [
        {"name": "Alice", "system": "CoC", "HP": "10/12", "SAN": "40/60", "MP": "8/8", "status_effects": ["poisoned"]},
        {"name": "Bob", "system": "DnD5e", "HP": 15, "AC": 16, "status_effects": []},
    ]
    manager = _FakeCharacterManager(roster=roster)

    result = await inject_game_state_prompt(ctx, manager, store, EN)

    assert result
    assert EN.t("prompt.game_state.title") in result
    assert "Innsmouth docks" in result
    assert "Investigation" in result
    assert "1926-03-15 14:00" in result
    assert EN.t("prompt.game_state.roster_header") in result
    assert "Alice" in result and "Bob" in result
    assert EN.t("common.none") in result  # Bob has no status effects
    assert "Zadok watches from the shadows" in result
    assert "You were hired to investigate a disappearance." in result
    assert "The ship never left port." in result
    assert "Torn Letter" in result
    assert "The tavern door is now locked." in result
    assert EN.t("prompt.game_state.initiative_header") in result
    assert "Cultist" in result


async def test_inject_game_state_prompt_seeded_state_zh_localized():
    store = Store(":memory:")
    ctx = _Ctx(chat_key="chat-zh", user_id="u1")
    await _seed_game_state_store(store, ctx.chat_key, ctx.user_id)
    manager = _FakeCharacterManager(roster=[{"name": "爱丽丝", "system": "CoC", "status_effects": []}])

    result = await inject_game_state_prompt(ctx, manager, store, ZH)

    assert "【战情面板】" in result
    assert "爱丽丝" in result
    assert ZH.t("common.none") in result


async def test_inject_game_state_prompt_empty_state_does_not_crash():
    store = Store(":memory:")
    ctx = _Ctx(chat_key="empty-chat", user_id="u1")
    manager = _FakeCharacterManager()  # empty roster, default placeholder character

    result = await inject_game_state_prompt(ctx, manager, store, EN)

    assert result  # still renders the fixed header/footer + defaults
    assert EN.t("common.unknown") in result
    assert EN.t("prompt.game_state.default_focus") in result
    assert EN.t("prompt.game_state.clock_not_set") in result


async def test_inject_game_state_prompt_swallows_manager_errors():
    store = Store(":memory:")
    ctx = _Ctx(chat_key="chat1", user_id="u1")
    result = await inject_game_state_prompt(ctx, _RaisingCharacterManager(), store, EN)
    # The roster/character lookup is individually guarded, so the panel still renders.
    assert result
    assert EN.t("prompt.game_state.title") in result


# ---------------------------------------------------------------------------
# inject_document_context_prompt
# ---------------------------------------------------------------------------


async def test_inject_document_context_prompt_ready_pool_includes_keeper_discipline():
    store = Store(":memory:")
    chat_key = "chat-ready"
    await store.set(user_key="", store_key=f"module_init_status.{chat_key}", value="ready")
    await store.set(
        user_key="",
        store_key=f"module_keeper_pool.{chat_key}",
        value=json.dumps(
            {
                "summary": "A cult worships an ancient horror beneath the lighthouse.",
                "scenes": [{"name": "大厅", "description": "潮湿阴冷", "focus": "探索"}],
                "npcs": [
                    {
                        "name": "Zadok Allen",
                        "description": "A drunk old sailor.",
                        "spoiler_tags": ["murderer_reveal"],
                    }
                ],
                "truths": [{"name": "真相", "description": "管家是邪教徒", "revealed_by": "账本"}],
            }
        ),
    )
    await store.set(
        user_key="",
        store_key=f"module_player_pool.{chat_key}",
        value=json.dumps({"scenes": [{"name": "大厅", "description": "潮湿阴冷", "focus": "探索"}]}),
    )
    ctx = _Ctx(chat_key=chat_key)

    result = await inject_document_context_prompt(ctx, _FakeVectorDB(), store, EN)

    assert result
    # Red-line: the keeper-secrecy discipline block must be present verbatim.
    assert EN.t("prompt.keeper_discipline") in result
    assert EN.t("prompt.document.keeper_pool_label") in result
    assert EN.t("prompt.document.player_pool_label") in result
    assert "- Zadok Allen: A drunk old sailor." in result
    assert EN.t("prompt.document.spoiler_line", tags="murderer_reveal") in result
    assert summarize_knowledge_item({"name": "大厅", "description": "潮湿阴冷", "focus": "探索"}) in result
    assert EN.t("prompt.document.catalog_hint") in result


async def test_inject_document_context_prompt_ready_pool_includes_module_fidelity():
    # When a keeper pool is initialized the KP must be told to RUN THE ACTUAL MODULE (drive its
    # scenes/hooks, name its NPCs, use its clues; never freelance a parallel plot) -- alongside,
    # not replacing, the keeper-secrecy discipline block.
    store = Store(":memory:")
    chat_key = "chat-fidelity"
    await store.set(user_key="", store_key=f"module_init_status.{chat_key}", value="ready")
    await store.set(
        user_key="",
        store_key=f"module_keeper_pool.{chat_key}",
        value=json.dumps(
            {"summary": "A village sacrifices to a dragon king.", "npcs": [{"name": "老严", "role": "村民向导"}]}
        ),
    )
    ctx = _Ctx(chat_key=chat_key)

    en = await inject_document_context_prompt(ctx, _FakeVectorDB(), store, EN)
    zh = await inject_document_context_prompt(ctx, _FakeVectorDB(), store, ZH)

    # The run-the-module fidelity block rides along with a ready pool, in the caller's locale...
    assert EN.t("prompt.module_fidelity") in en
    assert ZH.t("prompt.module_fidelity") in zh
    # ...and sits WITH (does not displace) the keeper-secrecy discipline red line.
    assert EN.t("prompt.keeper_discipline") in en


async def test_inject_document_context_prompt_ready_fallback_still_uses_keeper_pool():
    store = Store(":memory:")
    chat_key = "chat-ready-fallback"
    await store.set(user_key="", store_key=f"module_init_status.{chat_key}", value="ready_fallback")
    await store.set(
        user_key="",
        store_key=f"module_keeper_pool.{chat_key}",
        value=json.dumps({"summary": "Fallback analysis remains runnable.", "npcs": [{"name": "Mara"}]}),
    )
    ctx = _Ctx(chat_key=chat_key)

    result = await inject_document_context_prompt(ctx, _FakeVectorDB(), store, EN)

    assert EN.t("prompt.keeper_discipline") in result
    assert EN.t("prompt.module_fidelity") in result
    assert "Fallback analysis remains runnable." in result


async def test_inject_document_context_prompt_processing_state():
    store = Store(":memory:")
    chat_key = "chat-processing"
    await store.set(user_key="", store_key=f"module_init_status.{chat_key}", value="processing")
    ctx = _Ctx(chat_key=chat_key)

    result = await inject_document_context_prompt(ctx, _FakeVectorDB(), store, ZH)

    assert ZH.t("prompt.document.processing_title") in result
    assert ZH.t("prompt.document.processing_body") in result


async def test_inject_document_context_prompt_vector_fallback_when_no_pool():
    store = Store(":memory:")
    ctx = _Ctx(chat_key="chat-fallback")
    vector_db = _FakeVectorDB(
        results=[
            {
                "filename": "module.txt",
                "chunk_index": 0,
                "document_type": "module",
                "text": "The keeper walks the beach at midnight.",
            }
        ]
    )

    result = await inject_document_context_prompt(ctx, vector_db, store, EN)

    assert EN.t("prompt.document.fallback_title") in result
    assert EN.t("prompt.document.fallback_intro") in result
    assert "module.txt" in result
    assert "The keeper walks the beach at midnight." in result
    assert EN.t("prompt.document.digest_title") in result
    assert EN.t("prompt.document.search_hint") in result


async def test_inject_document_context_prompt_deduplicates_results_across_queries():
    store = Store(":memory:")
    ctx = _Ctx(chat_key="chat-dedup")
    # Same fixed result returned for every query -> the 3 internal queries
    # must collapse to a single fragment via the (filename, chunk_index) id.
    vector_db = _FakeVectorDB(
        results=[{"filename": "rules.txt", "chunk_index": 2, "document_type": "rule", "text": "Roll a d100."}]
    )

    result = await inject_document_context_prompt(ctx, vector_db, store, EN)

    assert result.count("rules.txt") == 1


async def test_inject_document_context_prompt_disabled_returns_empty():
    store = Store(":memory:")
    ctx = _Ctx(chat_key="chat-disabled")
    result = await inject_document_context_prompt(ctx, _FakeVectorDB(), store, EN, enable_vector_db=False)
    assert result == ""


async def test_inject_document_context_prompt_empty_state_returns_empty_without_crash():
    store = Store(":memory:")
    ctx = _Ctx(chat_key="chat-empty")
    result = await inject_document_context_prompt(ctx, _FakeVectorDB(results=[]), store, EN)
    assert result == ""


# ---------------------------------------------------------------------------
# inject_session_history_prompt
# ---------------------------------------------------------------------------


async def test_inject_session_history_prompt_seeded_state_is_nonempty():
    ctx = _Ctx(chat_key="chat1")
    manager = _FakeBattleReportManager(summary="Last time: the party found a strange brass key.")
    result = await inject_session_history_prompt(ctx, manager, EN)
    assert result == "Last time: the party found a strange brass key."


async def test_inject_session_history_prompt_empty_state_returns_empty_without_crash():
    ctx = _Ctx(chat_key="chat1")
    manager = _FakeBattleReportManager(summary=None)
    result = await inject_session_history_prompt(ctx, manager, EN)
    assert result == ""


async def test_inject_session_history_prompt_swallows_manager_errors():
    ctx = _Ctx(chat_key="chat1")
    result = await inject_session_history_prompt(ctx, _RaisingBattleReportManager(), EN)
    assert result == ""


# ---------------------------------------------------------------------------
# Full-set smoke test: every section survives a completely empty world.
# ---------------------------------------------------------------------------


async def test_all_six_sections_survive_fully_empty_state():
    store = Store(":memory:")
    ctx = _Ctx(chat_key="brand-new-chat", user_id="u1")
    character_manager = _FakeCharacterManager()
    battle_report_manager = _FakeBattleReportManager()
    vector_db = _FakeVectorDB()

    results = [
        await inject_trpg_system_prompt(ctx, EN),
        await inject_game_state_prompt(ctx, character_manager, store, EN),
        await inject_system_expertise_prompt(ctx, character_manager, EN),
        await inject_document_context_prompt(ctx, vector_db, store, EN),
        await inject_session_history_prompt(ctx, battle_report_manager, EN),
        await inject_interaction_style_prompt(ctx, EN),
    ]

    # None of the six may raise (already implied by reaching this point);
    # the pure-framing + always-on sections must still be non-empty.
    assert all(isinstance(r, str) for r in results)
    assert results[0]  # trpg_system
    assert results[1]  # game_state (always renders the fixed header)
    assert results[2]  # system_expertise (defaults to CoC guidance)
    assert results[4] == ""  # session_history: legitimately empty, no prior session
    assert results[5]  # interaction_style
